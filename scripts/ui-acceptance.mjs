#!/usr/bin/env node
// Browser acceptance for the M1–M5 local demo.
//
//   VITE_BACKEND_URL=http://127.0.0.1:8791 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176
//   BASE=http://127.0.0.1:5176 API_BASE=http://127.0.0.1:8791 \
//     ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance node scripts/ui-acceptance.mjs
//
// The script drives the real UI through a running Vite dev server and a running
// local API, switches the workspace role through the API, and writes new
// screenshots to evidence/ui-acceptance/ without touching the older ones.
//
// Test data lives in ACCEPTANCE_DATA_DIR (default /tmp/domel-acceptance). The
// role is restored to admin in the finally block; if the process is killed
// mid-run, restore with:
//   AGENT_DATA_DIR=/tmp/domel-acceptance node scripts/agent-admin.mjs role admin
//
// Exit code 0 = every check passed, 1 = at least one FAIL.

import {chromium} from 'playwright-core';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BASE = (process.env.BASE || 'http://127.0.0.1:5176').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const SHOTS = process.env.SHOTS || join(REPO, 'evidence', 'ui-acceptance');
const DATA_DIR = process.env.ACCEPTANCE_DATA_DIR || '/tmp/domel-acceptance';
const CONFIG_FILE = join(DATA_DIR, 'agent-config.json');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

mkdirSync(SHOTS, {recursive: true});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
const failures = [];
const consoleErrors = [];
const pageErrors = [];
const httpErrors = [];

function check(name, ok, detail = '') {
 if (ok) {
  pass += 1;
  console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
 } else {
  fail += 1;
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''));
 }
 return ok;
}

function equal(name, actual, expected) {
 return check(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function section(title) {
 console.log('\n## ' + title);
}

async function api(path, {method = 'GET', body} = {}) {
 const init = {method, headers: {}};
 if (body !== undefined) {
  init.headers['Content-Type'] = 'application/json';
  init.body = JSON.stringify(body);
 }
 try {
  const response = await fetch(API + path, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return {status: response.status, json, text};
 } catch (error) {
  return {status: 0, json: null, text: '', error: String(error)};
 }
}

async function roleNow() {
 const response = await api('/api/v1/capabilities');
 return response.json?.agent_role ?? null;
}

// The API intentionally cannot promote a demoted role back to admin; the
// documented recovery path is the local file/CLI. The running API reloads the
// role from agent-config.json because of its mtime check.
async function forceRole(role) {
 for (let attempt = 0; attempt < 40; attempt += 1) {
  let config = {};
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first write */ }
  config.role = role;
  mkdirSync(DATA_DIR, {recursive: true});
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {mode: 0o600});
  await sleep(120);
  if (await roleNow() === role) return true;
  await sleep(120);
 }
 return false;
}

async function patchRole(role) {
 const response = await api('/api/v1/agent/settings', {method: 'PATCH', body: {role}});
 for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await roleNow() === role) return response;
  await sleep(100);
 }
 return response;
}

// ---------------------------------------------------------------------------
// Data preparation. Everything is written to the isolated acceptance data dir
// through the product API, never to the repository .local/ directory.
// ---------------------------------------------------------------------------
async function prepareData() {
 console.log('\n## Preparation');
 if (await roleNow() !== 'admin') {
  if (!(await forceRole('admin'))) throw Error('cannot restore admin role before preparation');
 }
 // Let tasks from a previous round finish first: a late discover/enrich write
 // would shift the expected event counts halfway through the run.
 if (!(await drainQueue())) console.log('SETUP  warning: task queue did not drain before preparation');
 // Remove leftovers from an interrupted run so the checks stay repeatable.
 const staleSources = (await api('/api/v1/sources')).json?.sources ?? [];
 for (const source of staleSources.filter(item => /qa-acceptance-ui\.example\.com/.test(item.url))) {
  await api('/api/v1/sources/' + source.id, {method: 'DELETE'});
 }
 await api('/api/v1/agent/mcp/qa-ui-mcp', {method: 'DELETE'});
 const staleConfig = (await api('/api/v1/agent/config')).json ?? {};
 for (const skill of (staleConfig.skills ?? []).filter(item => /QA UI skill/i.test(String(item.name)))) {
  await api('/api/v1/agent/skills/' + skill.id, {method: 'DELETE'});
 }
 const eventsResponse = await api('/api/v1/events?limit=500');
 let events = eventsResponse.json?.events ?? [];
 if (!events.length) throw Error('event library is empty: start the API, run one POST /api/v1/events/discover (or --prepare --fixtures), then rerun');
 if (!(eventsResponse.json?.count >= 1)) throw Error('event library is empty');

 const pick = patterns => events.find(event => patterns.some(pattern => pattern.test(event.name || ''))) ?? null;
 const patchEvent = async (event, changes) => {
  if (!event) return null;
  const response = await api('/api/v1/events/' + event.id, {method: 'PATCH', body: changes});
  if (response.status !== 200) console.log('SETUP  event patch failed: ' + response.status + ' ' + response.text.slice(0, 120));
  return response.json ?? null;
 };

 // Every China event without a start date gets a future date inside the next
 // 12 months. This uses the product's manual-correction PATCH: it makes the
 // acceptance dataset deterministic, and the report lists these constructed
 // dates separately from the real discovery/enrichment data.
 const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
 const addMonths = (date, months) => {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
 };
 const today = new Date();
 const from = isoDay(today);
 const to6 = isoDay(addMonths(today, 6));
 const to12 = isoDay(addMonths(today, 12));
 const futureWindows = [
  ['2027-02-10', '2027-02-12'], ['2027-04-14', '2027-04-16'], ['2027-06-09', '2027-06-11'],
  ['2027-08-18', '2027-08-20'], ['2027-10-13', '2027-10-15'], ['2027-03-24', '2027-03-26'],
 ];
 // Only three China records are dated; the remaining undated ones stay
 // "Date to be confirmed" so the default 12-month view is checked against the
 // real discovery data shape (the f2 fix keeps undated events visible).
 const undatedChina = events.filter(event => event.region === 'cn' && !event.startDate);
 const constructedDates = [];
 for (let index = 0; index < Math.min(3, undatedChina.length); index += 1) {
  const [startDate, endDate] = futureWindows[index % futureWindows.length];
  const updated = await patchEvent(undatedChina[index], {
   startDate, endDate,
   city: undatedChina[index].city || 'Shanghai',
   country: undatedChina[index].country || 'China',
  });
  if (updated) constructedDates.push({name: updated.name, startDate, endDate});
 }
 // One verified event so the status filter has a deterministic non-empty target.
 if (undatedChina[0]) await patchEvent(undatedChina[0], {status: 'verified', confidence: 'medium'});

 // The event detail panel needs at least one document with an availability
 // badge; record the known exhibitor-list link through PATCH (same call as the
 // edit form) plus one explicit missing-data note.
 const detailEvent = pick([/appliance.*electronics/i, /awe/i]) ?? events.find(event => (event.sources ?? []).length > 0) ?? events[0] ?? null;
 const documentsEvent = await patchEvent(detailEvent, {
  documents: [{url: 'https://www.awe.com.cn/exhibitor-list.pdf', title: 'AWE exhibitor list (PDF)', type: 'pdf', status: 'downloadable'}],
  notes: ['Acceptance data note: the exhibitor list link is recorded for UI verification.'],
 });
 if (documentsEvent) console.log('SETUP  detail event: ' + documentsEvent.name);

 events = (await api('/api/v1/events?limit=500')).json?.events ?? events;
 // Expected default view: China records, date range applied on the client, and
 // undated records always visible (the shipped product behaviour).
 const inWindow = event => !event.startDate || (event.startDate >= from && event.startDate <= to12);
 const cnVisible = events.filter(event => event.region === 'cn' && inWindow(event));
 const cnSixMonths = events.filter(event => event.region === 'cn'
  && (!event.startDate || (event.startDate >= from && event.startDate <= to6)));
 const euVisible = events.filter(event => event.region === 'eu'
  && (!event.startDate || (event.startDate >= from && event.startDate <= to12)));
 const statusCounts = {};
 for (const event of cnVisible) statusCounts[event.status] = (statusCounts[event.status] ?? 0) + 1;
 const statusCheck = Object.keys(statusCounts).find(status => statusCounts[status] > 0) ?? 'discovered';
 const datedMonths = new Set(cnVisible.filter(event => event.startDate).map(event => event.startDate.slice(0, 7)));
 const undatedVisible = cnVisible.filter(event => !event.startDate).length;
 const monthCount = datedMonths.size + (undatedVisible > 0 ? 1 : 0);
 const queryTerm = cnVisible.some(event => /motor/i.test(event.name))
  ? 'motor'
  : (String(cnVisible[0]?.name || 'china').split(/[^A-Za-z]+/).filter(word => word.length >= 5)[0] ?? 'china');
 const queryCount = cnVisible.filter(event => [event.name, event.city, event.venue, ...(event.industries ?? [])].join(' ').toLowerCase().includes(queryTerm.toLowerCase())).length;
 const defaultCount = cnVisible.length;
 if (!defaultCount) throw Error('preparation left no visible China event');
 console.log('SETUP  defaultCount=' + defaultCount + ' (undated=' + undatedVisible + ') sixMonth=' + cnSixMonths.length + ' eu=' + euVisible.length + ' months=' + monthCount + ' status=' + JSON.stringify(statusCounts) + ' query=' + queryTerm + ':' + queryCount);
 if (constructedDates.length) console.log('SETUP  constructed dates: ' + JSON.stringify(constructedDates));

 // Settings sections need rows in the three role states.
 const config = (await api('/api/v1/agent/config')).json ?? {};
 if (!(config.mcpServers ?? []).some(server => server.name === 'qa-acceptance-mcp')) {
  await api('/api/v1/agent/mcp', {method: 'POST', body: {name: 'qa-acceptance-mcp', transport: 'stdio', command: '/bin/true', args: []}});
 }
 if (!(config.skills ?? []).some(skill => String(skill.name).startsWith('QA acceptance skill'))) {
  await api('/api/v1/agent/skills', {method: 'POST', body: {name: 'QA acceptance skill', description: 'Visible in the role matrix', content: 'Prefer public sources.'}});
 }
 if (!(config.plugins ?? []).some(plugin => String(plugin.name).startsWith('QA acceptance plugin'))) {
  await api('/api/v1/agent/plugins', {method: 'POST', body: {name: 'QA acceptance plugin', content: 'export default function(){};\n'}});
 }
 const recipes = (await api('/api/v1/recipes')).json?.recipes ?? [];
 if (!recipes.some(recipe => recipe.domain === 'qa-acceptance.example.com')) {
  await api('/api/v1/recipes', {
   method: 'POST',
   body: {
    domain: 'qa-acceptance.example.com', kind: 'regex',
    body: JSON.stringify({startDate: {pattern: '([0-9]{4}-[0-9]{2}-[0-9]{2})'}}),
    notes: 'Acceptance recipe row',
   },
  });
 }
 const sources = (await api('/api/v1/sources')).json?.sources ?? [];
 const sessions = (await api('/api/v1/agent/sessions?projectId=general')).json?.sessions ?? [];
 console.log('SETUP  events=' + events.length + ' sources=' + sources.length + ' sessions=' + sessions.length + ' detailEvent=' + (detailEvent?.name ?? 'none'));
 if (sessions.length < 1) throw Error('no seeded agent sessions: run `node scripts/acceptance-api.mjs --prepare` before starting the API');
 return {
  events, sources, sessions,
  detailEventId: documentsEvent?.id ?? detailEvent?.id ?? null,
  detailEventName: documentsEvent?.name ?? detailEvent?.name ?? null,
  constructedDates,
  expect: {
   defaultCount,
   sixMonthCount: cnSixMonths.length,
   euCount: euVisible.length,
   undatedVisible,
   statusKey: statusCheck,
   statusCount: statusCounts[statusCheck] ?? 0,
   monthCount,
   queryTerm,
   queryCount,
  },
 };
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
let page;

async function shot(name) {
 await page.screenshot({path: join(SHOTS, name + '.png')});
}

async function waitForText(selector, text, timeout = 12000) {
 await page.waitForFunction(([sel, expected]) => {
  const nodes = Array.from(document.querySelectorAll(sel));
  return nodes.some(node => (node.textContent || '').includes(expected));
 }, [selector, text], {timeout});
}

async function waitCount(selector, expected, timeout = 12000) {
 await page.waitForFunction(([sel, count]) => document.querySelectorAll(sel).length === count, [selector, expected], {timeout});
}

async function waitMinCount(selector, minimum, timeout = 12000) {
 await page.waitForFunction(([sel, count]) => document.querySelectorAll(sel).length >= count, [selector, minimum], {timeout});
}

async function drainQueue(timeout = 90000) {
 const deadline = Date.now() + timeout;
 while (Date.now() < deadline) {
  const tasks = (await api('/api/v1/tasks?limit=200')).json?.tasks ?? [];
  const active = tasks.filter(task => task.state === 'queued' || task.state === 'running');
  if (!active.length) return true;
  await sleep(500);
 }
 return false;
}

// Expected number of records in the default China + next-12-months view, with
// the current client policy that keeps undated events visible.
async function currentDefaultCount() {
 const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
 const now = new Date();
 const to12 = new Date(now);
 to12.setMonth(to12.getMonth() + 12);
 const from = isoDay(now);
 const until = isoDay(to12);
 const events = (await api('/api/v1/events?limit=500')).json?.events ?? [];
 return events.filter(event => event.region === 'cn'
  && (!event.startDate || (event.startDate >= from && event.startDate <= until))).length;
}

async function waitTaskState(id, state, timeout = 12000) {
 const deadline = Date.now() + timeout;
 let last = null;
 while (Date.now() < deadline) {
  const response = await api('/api/v1/tasks/' + id);
  last = response.json;
  if (last?.state === state) return last;
  await sleep(200);
 }
 return last;
}

async function gotoPage(label, heading) {
 await page.locator('nav button').filter({hasText: label}).first().click();
 await page.getByRole('heading', {name: heading}).first().waitFor({timeout: 15000});
}

async function evCount() {
 const text = await page.locator('.ev-count').innerText();
 const match = /(\d+)\s+events?/i.exec(text);
 return match ? Number(match[1]) : NaN;
}

async function waitEvCount(expected, timeout = 12000) {
 await page.waitForFunction(count => {
  const node = document.querySelector('.ev-count');
  const match = node && /(\d+)\s+events?/i.exec(node.textContent || '');
  return Boolean(match) && Number(match[1]) === count;
 }, expected, {timeout});
}

function escapeRegExp(value) {
 return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Success notices are rendered as role=status alerts; the events count line is
// also role=status, so never use .last()/generic [role=status] selectors.
async function successNotice(expected = null, timeout = 10000) {
 try {
  if (expected) {
   await page.waitForFunction(needle => Array.from(document.querySelectorAll('.alert.success'))
    .some(node => (node.textContent || '').includes(needle)), expected, {timeout});
  } else {
   await page.locator('.alert.success').first().waitFor({timeout});
  }
  return (await page.locator('.alert.success').allInnerTexts()).join(' | ');
 } catch {
  return '';
 }
}

async function errorNotice() {
 const texts = await page.locator('.alert.error').allInnerTexts().catch(() => []);
 return texts.join(' | ');
}

// ---------------------------------------------------------------------------
// Main acceptance flow
// ---------------------------------------------------------------------------
const runStartedAt = new Date().toISOString();
let prepared;

try {
 console.log('UI acceptance — ' + runStartedAt);
 console.log('BASE: ' + BASE + ' · API: ' + API + ' · data dir: ' + DATA_DIR);
 prepared = await prepareData();
} catch (error) {
 console.log('FAIL  preparation — ' + (error instanceof Error ? error.message : String(error)));
 process.exitCode = 1;
}

const browser = await chromium.launch({
 executablePath: CHROME,
 headless: true,
 args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'en-GB', acceptDownloads: true});
page = await context.newPage();

page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', error => pageErrors.push(error instanceof Error ? error.message : String(error)));
page.on('response', response => {
 if (response.status() >= 400 && !/favicon/i.test(response.url())) httpErrors.push(response.status() + ' ' + response.url());
});
page.on('dialog', dialog => { void dialog.accept(); });

async function closeDetails() {
 const close = page.locator('button[aria-label="Close event details"]');
 if (await close.count()) await close.first().click();
}

async function setRegion(region) {
 await page.getByLabel('Filter region').selectOption(region);
}

async function setRange(range) {
 await page.getByLabel('Filter date range').selectOption(range);
}

async function setStatus(status) {
 await page.getByLabel('Filter event status').selectOption(status);
}

async function openFirstEventCard() {
 await page.locator('.ev-card').first().click();
 await page.locator('aside.ev-detail').waitFor({timeout: 10000});
}

try {
 // ========================================================== navigation
 section('Six-page navigation and Events landing page');
 await page.goto(BASE, {waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 check('app loads and Events is the landing page', true);
 check('document title is the Domel workspace', /Domel/.test(await page.title()), await page.title());
 const navButtons = page.locator('nav button');
 equal('sidebar lists six workspace pages', await navButtons.count(), 6);
 for (const label of ['Events', 'Tasks', 'Sources', 'Projects', 'Agent', 'Settings']) {
  check('navigation contains ' + label, await page.locator('nav button').filter({hasText: label}).count() >= 1);
 }
 check('Events navigation item is active on load', await page.locator('nav button').filter({hasText: 'Events'}).first().evaluate(node => node.classList.contains('active')));
 equal('default region filter is China (cn)', await page.getByLabel('Filter region').inputValue(), 'cn');
 equal('default date range is next 12 months', await page.getByLabel('Filter date range').inputValue(), '12m');
 check('default view is the card list', await page.locator('.ev-cards').isVisible());
 await shot('20-events-list');

 // ============================================================== events
 section('Events: filters, cards, timeline, detail, export');
 const expect = prepared.expect;
 await waitEvCount(expect.defaultCount);
 equal('default China / next 12 months shows the in-window events', await evCount(), expect.defaultCount);
 check('event cards render', await page.locator('.ev-card').count() === expect.defaultCount);
 const firstCardText = await page.locator('.ev-card').first().innerText();
 check('card shows a date', /\d{4}/.test(firstCardText), firstCardText.split('\n')[0]);
 check('card shows completeness progress', await page.locator('.ev-card [role="progressbar"]').first().isVisible());
 check('card shows a status badge', await page.locator('.ev-card .badge').first().isVisible());
 check('card shows the confirm/venue/city meta', /Shanghai|China|SNIEC|Expo|Exhibition|Fair/i.test(firstCardText), firstCardText.slice(0, 120));
 if (expect.undatedVisible > 0) {
  check('default view keeps undated events visible (Date to be confirmed)',
   await page.locator('.ev-card .ev-date-pending').count() >= 1,
   'undated=' + expect.undatedVisible);
 } else {
  check('default view keeps undated events visible (Date to be confirmed)', true, 'no undated China event in this dataset');
 }

 await setStatus(expect.statusKey);
 await waitEvCount(expect.statusCount);
 const statusLabels = {discovered: 'Discovered', enriched: 'Enriched', verified: 'Verified', archived: 'Archived'};
 check('status filter narrows the list to ' + expect.statusKey + ' events',
  expect.statusCount > 0 && new RegExp(statusLabels[expect.statusKey], 'i').test(await page.locator('.ev-card').first().innerText()),
  'count=' + expect.statusCount);
 await setStatus('all');
 await waitEvCount(expect.defaultCount);

 const search = page.getByLabel('Search events');
 await search.fill(expect.queryTerm);
 await waitEvCount(expect.queryCount);
 check('keyword search filters by name/city/venue', expect.queryCount > 0 && await evCount() === expect.queryCount, 'q=' + expect.queryTerm + ' count=' + expect.queryCount);
 check('keyword search keeps the matching cards', (await page.locator('.ev-card').allInnerTexts()).every(text => new RegExp(expect.queryTerm, 'i').test(text)));
 await search.fill('');
 await waitEvCount(expect.defaultCount);

 await setRegion('eu');
 await waitEvCount(expect.euCount);
 if (expect.euCount === 0) {
  check('region filter eu yields an empty result state', await page.locator('.ev-empty').isVisible());
 } else {
  check('region filter eu shows only Europe events', await evCount() === expect.euCount, 'count=' + expect.euCount);
 }
 await setRegion('cn');
 await waitEvCount(expect.defaultCount);

 await setRange('6m');
 await waitEvCount(expect.sixMonthCount);
 check('next-6-months range narrows the set', await evCount() === expect.sixMonthCount && expect.sixMonthCount <= expect.defaultCount, 'count=' + expect.sixMonthCount);
 await setRange('12m');
 await waitEvCount(expect.defaultCount);

 await page.getByRole('button', {name: 'Timeline'}).click();
 await page.locator('.ev-timeline').waitFor({timeout: 10000});
 await waitCount('.ev-timeline-group', expect.monthCount);
 check('timeline view groups events by month', await page.locator('.ev-timeline-group').count() === expect.monthCount, 'groups=' + expect.monthCount);
 check('timeline still renders every card', await page.locator('.ev-card').count() === expect.defaultCount);
 if (expect.undatedVisible > 0) {
  check('timeline groups undated events under Date to be confirmed',
   /Date to be confirmed/.test(await page.locator('.ev-timeline').innerText()));
 }
 await shot('21-events-timeline');
 await page.getByRole('button', {name: 'List'}).click();
 await page.locator('.ev-cards').waitFor({timeout: 10000});

 // Detail panel: use the event prepared with documents/sources and the "All
 // time" range so enriched (past-dated) records are reachable too.
 await setRange('all');
 await waitMinCount('.ev-card', 1);
 const detailName = prepared?.detailEventName;
 if (detailName) {
  const card = page.locator('.ev-card').filter({hasText: detailName.slice(0, 24)}).first();
  await card.click();
 } else {
  await page.locator('.ev-card').first().click();
 }
 await page.locator('aside.ev-detail').waitFor({timeout: 10000});
 check('event detail panel opens', await page.locator('aside.ev-detail').isVisible());
 check('detail shows the event name heading', (await page.locator('aside.ev-detail h2').innerText()).length > 2, await page.locator('aside.ev-detail h2').innerText());
 check('detail lists the full field table (>= 15 fields)', await page.locator('aside.ev-detail dt').count() >= 15, String(await page.locator('aside.ev-detail dt').count()));
 check('detail shows the official website link', await page.locator('aside.ev-detail a[href^="https://"]').count() >= 1);
 await page.getByRole('heading', {name: 'Verified sources'}).waitFor({timeout: 10000});
 check('detail shows verified sources with timestamps', await page.locator('aside.ev-detail .ev-sources li').count() >= 1);
 check('detail shows a data completeness badge', /complete/.test(await page.locator('aside.ev-detail .ev-detail-badges').innerText()));
 check('detail shows documents with availability', await page.locator('aside.ev-detail .ev-documents li').count() >= 1 && /Downloadable/.test(await page.locator('aside.ev-detail .ev-documents').innerText()));
 check('detail shows missing-data notes', await page.locator('aside.ev-detail h3', {hasText: 'Missing data notes'}).count() >= 1);
 await shot('22-events-detail');
 await closeDetails();

 // Exports download real files.
 let csvDownload = null;
 try {
  const event = page.waitForEvent('download', {timeout: 10000});
  await page.getByRole('button', {name: 'Export CSV'}).click();
  csvDownload = await event;
 } catch { /* checked below */ }
 check('Export CSV downloads a .csv file', Boolean(csvDownload) && /\.csv$/i.test(csvDownload.suggestedFilename() || ''), csvDownload ? csvDownload.suggestedFilename() : 'no download event');
 let jsonDownload = null;
 try {
  const event = page.waitForEvent('download', {timeout: 10000});
  await page.getByRole('button', {name: 'Export JSON'}).click();
  jsonDownload = await event;
 } catch { /* checked below */ }
 check('Export JSON downloads a .json file', Boolean(jsonDownload) && /\.json$/i.test(jsonDownload.suggestedFilename() || ''), jsonDownload ? jsonDownload.suggestedFilename() : 'no download event');
 check('export shows a success notice', /downloaded/i.test(await successNotice('export downloaded')));

 // Write actions for admin queue real tasks; cancel them immediately so the
 // acceptance run stays within its real-network budget.
 check('admin sees the Discover events action', await page.getByRole('button', {name: 'Discover events'}).count() >= 1);
 await page.getByRole('button', {name: 'Discover events'}).first().click();
 check('Discover events queues a task and shows a notice', /Discovery task queued/.test(await successNotice('Discovery task queued')));
 const discoverQueue = (await api('/api/v1/tasks?kind=event.discover&state=queued')).json?.tasks ?? [];
 for (const task of discoverQueue) await api('/api/v1/tasks/' + task.id + '/cancel', {method: 'POST', body: {}});
 const runningDiscover = (await api('/api/v1/tasks?kind=event.discover&state=running')).json?.tasks ?? [];
 for (const task of runningDiscover) await api('/api/v1/tasks/' + task.id + '/cancel', {method: 'POST', body: {}});

 if (detailName) {
  const card = page.locator('.ev-card').filter({hasText: detailName.slice(0, 24)}).first();
  if (await card.count()) {
   await card.click();
   await page.locator('aside.ev-detail').waitFor({timeout: 10000});
   const enrich = page.getByRole('button', {name: 'Enrich details'});
   check('admin sees the Enrich details action in the detail panel', await enrich.count() >= 1);
   await enrich.click();
   check('Enrich details queues a task and shows a notice', /Enrichment task queued/.test(await successNotice('Enrichment task queued')));
   const enrichTasks = (await api('/api/v1/tasks?kind=event.enrich&limit=50')).json?.tasks ?? [];
   for (const task of enrichTasks.filter(item => item.state === 'queued')) {
    await api('/api/v1/tasks/' + task.id + '/cancel', {method: 'POST', body: {}});
   }
   await closeDetails();
  }
 }
 await setRange('12m');
 await waitEvCount(expect.defaultCount);


 // ================================================================ tasks
 section('Tasks: statistics, filters, detail log, cancel/retry, SSE');
 await gotoPage('Tasks', 'Task queue');
 await waitMinCount('.task-table tbody tr', 1);
 equal('task page shows five state statistics', await page.locator('.task-stats .stat').count(), 5);
 const taskStatsText = await page.locator('.task-stats').innerText();
 check('task stats include queued/running/succeeded/failed/cancelled labels', ['Queued', 'Running', 'Succeeded', 'Failed', 'Cancelled'].every(label => taskStatsText.includes(label)));
 check('task table lists tasks', await page.locator('.task-table tbody tr').count() >= 1);
 check('admin task table has an ACTIONS column', await page.locator('.task-table thead th').count() === 8, String(await page.locator('.task-table thead th').count()));
 check('task page shows live/polling indicator', /Live updates|Polling every/.test(await page.locator('.live-pill').innerText()));
 await shot('23-tasks-list');

 // SSE: create a task from outside the browser and wait for it to appear
 // without any navigation or reload.
 const rowCountBefore = await page.locator('.task-table tbody tr').count();
 const sseSources = (await api('/api/v1/sources')).json?.sources ?? [];
 const sseRun = await api('/api/v1/sources/' + (sseSources[3] ?? sseSources[0])?.id + '/run', {method: 'POST', body: {}});
 await page.waitForFunction(count => document.querySelectorAll('.task-table tbody tr').length > count, rowCountBefore, {timeout: 15000});
 check('new task appears in the open Tasks page over SSE (no reload)', true);
 if (sseRun.json?.task?.id) { const current = await waitTaskState(sseRun.json.task.id, 'queued', 2000); if (current?.state === 'queued') await api('/api/v1/tasks/' + sseRun.json.task.id + '/cancel', {method: 'POST', body: {}}); }

 // Filters.
 const stateGroup = page.getByRole('group', {name: 'Filter task status'});
 await stateGroup.getByRole('button', {name: /^Succeeded/}).click();
 await page.waitForFunction(() => {
  const badges = Array.from(document.querySelectorAll('.task-table tbody .badge'));
  return badges.length > 0 && badges.every(badge => badge.textContent.trim() === 'Succeeded');
 }, null, {timeout: 10000});
 check('state filter shows only succeeded tasks', await page.locator('.task-table tbody tr').count() >= 1);
 await stateGroup.getByRole('button', {name: /^All/}).click();
 await page.getByLabel('Filter task kind').selectOption('event.discover');
 await page.waitForFunction(() => {
  const rows = Array.from(document.querySelectorAll('.task-table tbody tr'));
  return rows.length > 0 && rows.every(row => row.textContent.includes('Event discovery'));
 }, null, {timeout: 10000});
 check('kind filter shows only event discovery tasks', await page.locator('.task-table tbody tr').count() >= 1);
 await page.locator('.task-table tbody tr.task-row').first().click();
 await page.locator('.task-detail-row .task-detail').waitFor({timeout: 10000});
 check('task detail panel opens', await page.locator('.task-detail').isVisible());
 const inlineExpansion = await page.evaluate(() => {
  const selected = document.querySelector('.task-table tbody tr.task-row.selected');
  return Boolean(selected && selected.nextElementSibling?.classList.contains('task-detail-row')
   && selected.nextElementSibling.querySelector('.task-detail'));
 });
 check('task details expand inline beneath the selected task row', inlineExpansion);
 check('task list exposes an explicit View details action', await page.locator('.task-actions button').filter({hasText: /View details|Hide details/}).count() >= 1);
 await page.locator('.task-table tbody tr.task-row.selected').first().click();
 check('clicking the selected row again collapses its details', await page.locator('.task-detail').count() === 0);
 await page.locator('.task-actions button').filter({hasText: 'View details'}).first().click();
 await page.locator('.task-detail-row .task-detail').waitFor({timeout: 10000});
 check('the View details button reopens the inline details', await page.locator('.task-detail').isVisible());
 check('task detail shows a log timeline', await page.locator('.task-detail .task-log li').count() >= 1 && (await page.locator('.task-detail').innerText()).includes('Log timeline'));
 check('task detail shows payload and result sections', (await page.locator('.task-detail').innerText()).includes('Payload') && (await page.locator('.task-detail').innerText()).includes('Result'));
 check('task detail shows the full task id', /[0-9a-f]{8}-[0-9a-f]{4}/.test(await page.locator('.task-detail .task-id-full').innerText()));
 await page.locator('button[aria-label="Close details"]').click();
 await page.getByLabel('Filter task kind').selectOption('all');

 // Cancel + retry through the UI: hold one task running, cancel the queued
 // second one, retry it, then clean up through the API.
 const lifecycleSources = (await api('/api/v1/sources')).json?.sources ?? [];
 const runOne = await api('/api/v1/sources/' + lifecycleSources[4]?.id + '/run', {method: 'POST', body: {}});
 const runTwo = await api('/api/v1/sources/' + lifecycleSources[5]?.id + '/run', {method: 'POST', body: {}});
 const secondTask = runTwo.json?.task;
 if (secondTask) {
  await page.waitForFunction(id => Array.from(document.querySelectorAll('.task-table tbody tr')).some(row => row.textContent.includes(id.slice(0, 8))), secondTask.id, {timeout: 12000});
  await stateGroup.getByRole('button', {name: /^Queued/}).click();
  const row = page.locator('.task-table tbody tr').filter({hasText: secondTask.id.slice(0, 8)}).first();
  await row.waitFor({timeout: 10000});
  await row.locator('button', {hasText: 'Cancel'}).click();
  check('Cancel action on a queued task succeeds', /Task cancelled/.test(await successNotice('Task cancelled')));
  await waitTaskState(secondTask.id, 'cancelled', 15000);
  await stateGroup.getByRole('button', {name: /^Cancelled/}).click();
  await page.waitForFunction(id => Array.from(document.querySelectorAll('.task-table tbody tr')).some(row => row.textContent.includes(id.slice(0, 8))), secondTask.id, {timeout: 15000});
  const retryRow = page.locator('.task-table tbody tr').filter({hasText: secondTask.id.slice(0, 8)}).first();
  await retryRow.locator('button', {hasText: 'Retry'}).click();
  const retryNotice = await successNotice('another attempt');
  check('Retry action on a cancelled task succeeds', /another attempt/.test(retryNotice), retryNotice || await errorNotice());
  await api('/api/v1/tasks/' + secondTask.id + '/cancel', {method: 'POST', body: {}});
  if (runOne.json?.task?.id) await api('/api/v1/tasks/' + runOne.json.task.id + '/cancel', {method: 'POST', body: {}});
 } else {
  check('Cancel action on a queued task succeeds', false, 'could not create a queued task');
  check('Retry action on a cancelled task succeeds', false, 'could not create a queued task');
 }
 await shot('24-tasks-detail');

 // ============================================================== sources
 section('Sources: registry, filters, toggle, run now, CRUD, role states');
 await gotoPage('Sources', 'Sources');
 await waitMinCount('.sources-table tbody tr', 20);
 check('source registry table renders the seeded sources', await page.locator('.sources-table tbody tr').count() >= 20);
 equal('source page shows four statistics', await page.locator('.source-stats .stat').count(), 4);
 const firstSourceRow = page.locator('.sources-table tbody tr').first();
 check('source row links the source URL', await firstSourceRow.locator('a[href^="http"]').count() >= 1);
 check('source row shows priority badge', /P[0-3]/.test(await firstSourceRow.innerText()));
 check('source row shows interval and next run', /h|min|s/.test(await firstSourceRow.innerText()));
 await shot('25-sources-admin');

 await page.getByLabel('Filter source region').selectOption('cn');
 await page.waitForFunction(() => {
  const rows = Array.from(document.querySelectorAll('.sources-table tbody tr'));
  return rows.length > 0 && rows.every(row => row.textContent.includes('China'));
 }, null, {timeout: 10000});
 check('source region filter narrows to China rows', await page.locator('.sources-table tbody tr').count() > 0);
 await page.getByLabel('Filter source region').selectOption('all');
 await page.getByLabel('Filter source type').selectOption('site');
 await page.waitForFunction(() => {
  const rows = Array.from(document.querySelectorAll('.sources-table tbody tr'));
  return rows.length > 0 && rows.every(row => row.textContent.includes('Site'));
 }, null, {timeout: 10000});
 check('source type filter narrows to site rows', await page.locator('.sources-table tbody tr').count() > 0);
 await page.getByLabel('Filter source type').selectOption('all');

 const firstToggle = page.locator('input[aria-label^="Toggle source"]').first();
 const toggleWasChecked = await firstToggle.isChecked();
 await firstToggle.click();
 await successNotice(toggleWasChecked ? 'Source disabled' : 'Source enabled');
 check('admin can toggle a source enabled flag', await firstToggle.isChecked() === !toggleWasChecked);
 await firstToggle.click();
 await page.waitForFunction(expected => {
  const input = document.querySelector('input[aria-label^="Toggle source"]');
  return input && input.checked === expected;
 }, toggleWasChecked, {timeout: 10000});

 const firstRun = page.locator('button[aria-label^="Run now"]').first();
 await firstRun.click();
 check('Run now queues a source collection task', /Source run queued/.test(await successNotice('Source run queued')));
 const activeRuns = (await api('/api/v1/tasks?kind=source.collect&limit=50')).json?.tasks ?? [];
 // Only cancel queued tasks: cancelling a running Playwright render is BUG-3
 // (API process crash), reported separately, so the run must not trigger it.
 for (const task of activeRuns.filter(item => item.state === 'queued')) {
  await api('/api/v1/tasks/' + task.id + '/cancel', {method: 'POST', body: {}});
 }

 // Add-source form: client-side validation, then a real create + delete cycle.
 await page.getByRole('button', {name: 'Add source'}).click();
 await page.getByLabel('Source URL').fill('http://insecure.example.com/feed');
 await page.getByRole('button', {name: 'Create source'}).click();
 await waitForText('.validation', 'HTTPS');
 check('add-source form rejects a non-HTTPS URL', /HTTPS/.test(await page.locator('.validation').last().innerText()));
 await page.getByLabel('Source URL').fill('https://qa-acceptance-ui.example.com/feed');
 await page.getByLabel('Title (optional)').fill('QA UI source');
 await page.getByLabel('Interval (seconds)').fill('10');
 await page.getByRole('button', {name: 'Create source'}).click();
 await waitForText('.validation', '30 seconds');
 check('add-source form rejects an interval below 30 seconds', /30 seconds/.test(await page.locator('.validation').last().innerText()));
 await page.getByLabel('Interval (seconds)').fill('3600');
 await page.getByRole('button', {name: 'Create source'}).click();
 const createNotice = await successNotice('Source created');
 check('admin can create a source', /Source created/.test(createNotice), createNotice || await errorNotice());
 await waitForText('.sources-table', 'qa-acceptance-ui.example.com');
 check('new source appears in the registry table', await page.locator('.sources-table tbody tr').filter({hasText: 'qa-acceptance-ui.example.com'}).count() === 1);
 const uiRow = page.locator('.sources-table tbody tr').filter({hasText: 'qa-acceptance-ui.example.com'}).first();
 await uiRow.locator('button[aria-label^="Delete source"]').click();
 const deleteNotice = await successNotice('Source deleted');
 check('admin can delete a source', /Source deleted/.test(deleteNotice), deleteNotice || await errorNotice());
 let deletedFromTable = false;
 try {
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('.sources-table tbody tr')).some(row => row.textContent.includes('qa-acceptance-ui.example.com')), null, {timeout: 8000});
  deletedFromTable = true;
 } catch { /* the FAIL above carries the cause */ }
 check('deleted source disappears from the table', deletedFromTable);
 const staleSources = (await api('/api/v1/sources')).json?.sources ?? [];
 for (const source of staleSources.filter(item => item.url.includes('qa-acceptance-ui.example.com'))) await api('/api/v1/sources/' + source.id, {method: 'DELETE'});

 // Edit interval/priority modal.
 const editRow = page.locator('.sources-table tbody tr').first();
 const priorityBefore = (/P([0-3])/.exec(await editRow.innerText()) || [])[1];
 const priorityInput = page.getByLabel('Priority', {exact: true});
 await editRow.locator('button[aria-label^="Edit source"]').click();
 await page.getByRole('dialog', {name: 'Edit interval and priority'}).waitFor({timeout: 10000});
 await priorityInput.fill(priorityBefore === '2' ? '3' : '2');
 await page.getByRole('button', {name: 'Save changes'}).click();
 const editNotice = await successNotice('Source updated');
 check('admin can edit source priority/interval', /Source updated/.test(editNotice), editNotice || await errorNotice());
 await page.locator('.sources-table tbody tr').first().locator('button[aria-label^="Edit source"]').click();
 await page.getByRole('dialog', {name: 'Edit interval and priority'}).waitFor({timeout: 10000});
 await page.getByLabel('Priority', {exact: true}).fill(priorityBefore ?? '1');
 await page.getByRole('button', {name: 'Save changes'}).click();
 await successNotice('Source updated');

 // ============================================================= settings
 section('Settings: eight sections, AI model, OCR, MCP/skills/plugins/recipes three states');
 await gotoPage('Settings', 'Settings');
 for (const heading of ['Role & access', 'Agent tools', 'AI model', 'Document parsing', 'MCP servers', 'Skills', 'Plugins', 'Recipes']) {
  check('settings section present: ' + heading, await page.getByRole('heading', {name: heading, exact: true}).count() === 1);
 }
 equal('workspace role selector shows admin', await page.getByLabel('Workspace role').inputValue(), 'admin');
 check('role selector is enabled for admin', await page.getByLabel('Workspace role').isEnabled());
 check('agent tools controls stay system-only (disabled for admin)', await page.getByLabel('File read/write').isDisabled());
 await page.getByLabel('OCR provider').selectOption('official');
 equal('OCR official provider fills the MinerU endpoint', await page.getByLabel('API endpoint').inputValue(), 'https://mineru.net/api/v4');
 await page.getByLabel('OCR provider').selectOption('local');
 equal('OCR local provider fills the local endpoint', await page.getByLabel('API endpoint').inputValue(), 'http://127.0.0.1:8000');
 await page.getByLabel('OCR provider').selectOption('none');
 check('OCR endpoint is disabled when the provider is none', await page.getByLabel('API endpoint').isDisabled());

 // AI model settings: the acceptance environment uses the .env.host key, so the
 // panel must report it as configured without exposing the key. The key input
 // is write-only and never prefilled.
 equal('AI model shows the active model name', await page.getByLabel('Model name').inputValue(), 'deepseek-flash');
 check('AI model reports an environment-configured key', String(await page.getByLabel('API key').getAttribute('placeholder')).includes('Configured'));
 check('AI model status names the provider', /DeepSeek official/.test(await page.locator('.settings-page section.panel.padded').filter({has: page.getByRole('heading', {name: 'AI model', exact: true})}).innerText()));
 check('AI key input is never prefilled with the real key', (await page.getByLabel('API key').inputValue()) === '');
 await shot('26-settings-admin');

 const mcpRow = page.locator('.settings-row').filter({hasText: 'qa-acceptance-mcp'}).first();
 await mcpRow.waitFor({timeout: 10000});
 check('MCP section lists the configured server', await mcpRow.locator('strong', {hasText: 'qa-acceptance-mcp'}).count() === 1);
 check('admin sees MCP test/remove actions', await mcpRow.getByRole('button', {name: 'Test connection'}).count() === 1 && await mcpRow.locator('button[aria-label^="Remove MCP server"]').count() === 1);
 const mcpToggle = page.locator('input[aria-label="Enable MCP server qa-acceptance-mcp"]');
 const mcpWas = await mcpToggle.isChecked();
 await mcpToggle.click();
 await successNotice(mcpWas ? 'MCP server disabled' : 'MCP server enabled');
 check('admin can toggle an MCP server', await mcpToggle.isChecked() === !mcpWas);
 await mcpToggle.click();
 await successNotice(mcpWas ? 'MCP server enabled' : 'MCP server disabled');

 const skillRow = page.locator('.settings-row').filter({hasText: 'QA acceptance skill'}).first();
 await skillRow.waitFor({timeout: 10000});
 check('skills section lists the configured skill', await skillRow.locator('strong', {hasText: 'QA acceptance skill'}).count() === 1);
 check('admin sees skill edit/remove actions', await skillRow.getByRole('button', {name: 'Edit', exact: true}).count() === 1 && await skillRow.locator('button[aria-label^="Remove skill"]').count() === 1);
 const skillToggle = page.locator('input[aria-label^="Enable skill QA acceptance skill"]').first();
 const skillWas = await skillToggle.isChecked();
 await skillToggle.click();
 await successNotice(skillWas ? 'Skill disabled' : 'Skill enabled');
 check('admin can toggle a skill', await skillToggle.isChecked() === !skillWas);
 await skillToggle.click();
 await successNotice(skillWas ? 'Skill enabled' : 'Skill disabled');

 const pluginRow = page.locator('.settings-row').filter({hasText: 'QA acceptance plugin'}).first();
 await pluginRow.waitFor({timeout: 10000});
 check('plugins section lists the configured plugin', await pluginRow.locator('strong', {hasText: 'QA acceptance plugin'}).count() === 1);
 check('admin sees plugin remove action', await pluginRow.locator('button[aria-label^="Remove plugin"]').count() === 1);

 const recipeRow = page.locator('.settings-table tbody tr').filter({hasText: 'qa-acceptance.example.com'}).first();
 await recipeRow.waitFor({timeout: 10000});
 check('recipes section lists the proposed recipe', await recipeRow.locator('strong', {hasText: 'qa-acceptance.example.com'}).count() === 1);
 await recipeRow.getByRole('button', {name: 'Approve'}).click();
 const approveNotice = await successNotice('Recipe approved');
 check('admin can approve a recipe', /Recipe approved/.test(approveNotice), approveNotice || await errorNotice());
 await page.locator('.settings-table tbody tr').filter({hasText: 'qa-acceptance.example.com'}).first().getByRole('button', {name: 'Disable'}).click();
 const disableNotice = await successNotice('Recipe disabled');
 check('admin can disable a recipe', /Recipe disabled/.test(disableNotice), disableNotice || await errorNotice());

 // Add/remove MCP and skill through the UI forms.
 await page.getByRole('button', {name: 'Add MCP server'}).click();
 await page.getByLabel('Server name').fill('qa-ui-mcp');
 await page.getByLabel('Command', {exact: true}).fill('/bin/true');
 await page.getByRole('button', {name: 'Add server'}).click();
 let mcpAdded = true;
 try { await waitForText('.settings-list', 'qa-ui-mcp', 8000); } catch { mcpAdded = false; }
 check('admin can add an MCP server from the UI', mcpAdded && await page.locator('.settings-row').filter({hasText: 'qa-ui-mcp'}).count() === 1);
 await page.locator('button[aria-label="Remove MCP server qa-ui-mcp"]').click();
 let mcpRemoved = true;
 try { await page.waitForFunction(() => !Array.from(document.querySelectorAll('.settings-row')).some(row => row.textContent.includes('qa-ui-mcp')), null, {timeout: 8000}); } catch { mcpRemoved = false; }
 check('admin can remove the MCP server again', mcpRemoved, mcpRemoved ? '' : 'UI remove did not complete');
 await api('/api/v1/agent/mcp/qa-ui-mcp', {method: 'DELETE'});

 await page.getByRole('button', {name: 'Add skill'}).click();
 await page.getByLabel('Name', {exact: true}).fill('QA UI skill');
 await page.getByLabel('Description', {exact: true}).fill('Temporary UI skill');
 await page.getByLabel('Skill content').fill('Check the trade show dates against the official website.');
 await page.locator('form.settings-editor').getByRole('button', {name: 'Add skill'}).click();
 let skillAdded = true;
 try { await waitForText('.settings-list', 'QA UI skill', 8000); } catch { skillAdded = false; }
 check('admin can add a skill from the UI', skillAdded && await page.locator('.settings-row').filter({hasText: 'QA UI skill'}).count() === 1);
 await page.locator('button[aria-label="Remove skill QA UI skill"]').click();
 let skillRemoved = true;
 try { await page.waitForFunction(() => !Array.from(document.querySelectorAll('.settings-row')).some(row => row.textContent.includes('QA UI skill')), null, {timeout: 8000}); } catch { skillRemoved = false; }
 check('admin can remove the skill again', skillRemoved, skillRemoved ? '' : 'UI remove did not complete');
 const uiSkills = ((await api('/api/v1/agent/config')).json?.skills ?? []).filter(skill => String(skill.name).startsWith('QA UI skill'));
 for (const skill of uiSkills) await api('/api/v1/agent/skills/' + skill.id, {method: 'DELETE'});

 await page.getByRole('button', {name: 'Reload raw JSON'}).click();
 await page.getByLabel('Raw MCP configuration JSON').waitFor({timeout: 10000});
 check('raw MCP JSON is readable by admin', /qa-acceptance-mcp/.test(await page.getByLabel('Raw MCP configuration JSON').inputValue()));
 await page.getByRole('button', {name: 'Save raw JSON'}).click();
 const rawNotice = await successNotice('MCP configuration saved');
 check('admin can replace the raw MCP JSON (PUT)', /MCP configuration saved/.test(rawNotice), rawNotice || await errorNotice());

 // ================================================================ agent
 section('Agent: run history, transcript, admin composer');
 await gotoPage('Agent', 'Agent');
 try {
  await page.waitForFunction(() => {
   const node = document.querySelector('.agent-history .count');
   return Boolean(node) && node.textContent.trim() === '2';
  }, null, {timeout: 12000});
 } catch { /* checked below */ }
 equal('agent page shows the seeded history count', (await page.locator('.agent-history .count').innerText()).trim(), '2');
 check('admin sees the agent composer', await page.getByLabel('Message the agent').count() === 1 && await page.getByLabel('Message the agent').isEditable());
 check('admin sees the send control', await page.getByRole('button', {name: 'Send'}).count() === 1);
 check('agent empty state and suggestions are shown', await page.getByText('Start a conversation').count() >= 1 && await page.locator('.agent-suggestions button').count() >= 1);
 await page.locator('.agent-session-list button').first().click();
 await page.locator('.agent-transcript').waitFor({timeout: 10000});
 check('agent history transcript opens read-only', await page.locator('.agent-transcript').isVisible());
 check('transcript renders the recorded messages', await page.locator('.agent-transcript').innerText().then(text => /Acceptance transcript fixture|Summarize|Which events/.test(text)));
 await page.locator('button[aria-label="Close transcript"]').click();
 await shot('27-agent-admin');

 // ============================================================= projects
 section('Projects: original research flow pages');
 await gotoPage('Projects', 'Research dashboard');
 check('research dashboard lists the demo projects', await page.locator('.projects-table tbody tr').count() >= 1, String(await page.locator('.projects-table tbody tr').count()));
 equal('research dashboard shows four statistics', await page.locator('.stats .stat').count(), 4);
 // The demo data can hold several projects; pick one that actually has accepted
 // evidence and a saved report so the review/report pages are exercised.
 const workspaceBundle = (await api('/api/v1/workspace')).json ?? {};
 const projectList = workspaceBundle.projects ?? [];
 const findingList = workspaceBundle.findings ?? [];
 const reportList = workspaceBundle.reports ?? [];
 const targetProject = projectList.find(project =>
  reportList.some(report => report.project_id === project.id) &&
  findingList.some(finding => finding.project_id === project.id && finding.decision === 'accepted'))
  ?? projectList.find(project => findingList.some(finding => finding.project_id === project.id))
  ?? projectList[0];
 check('demo data contains a project with review evidence', Boolean(targetProject), targetProject?.title ?? 'none');
 await page.locator('.projects-table tbody tr').filter({hasText: String(targetProject?.title ?? '').slice(0, 30)}).first().locator('.project-link').click();
 await page.waitForFunction(() => {
  const heading = document.querySelector('h1');
  return Boolean(heading) && ['Insights & evidence', 'Research progress'].includes(heading.textContent.trim());
 }, null, {timeout: 15000});
 if ((await page.locator('h1').first().innerText()).trim() !== 'Insights & evidence') {
  await page.locator('.flow-tabs button').filter({hasText: 'Insights & review'}).click();
  await page.getByRole('heading', {name: 'Insights & evidence'}).waitFor({timeout: 15000});
 }
 check('completed project opens the insights page', true);
 check('insights page shows the accepted/total counter', /\d+\s*\/\s*\d+\s*accepted/.test(await page.locator('.review-total').innerText()), await page.locator('.review-total').innerText());
 check('finding cards are rendered', await page.locator('.finding-card').count() >= 1);
 check('accepted badge is rendered', await page.locator('.finding-card .badge.accepted').count() >= 1);
 check('project flow tabs are present', await page.locator('.flow-tabs button').count() === 3);
 await page.locator('.flow-tabs button').filter({hasText: 'Research progress'}).click();
 await page.getByRole('heading', {name: 'Research progress'}).waitFor({timeout: 15000});
 check('research progress page still works', await page.locator('.progress-stats').isVisible());
 await page.locator('.flow-tabs button').filter({hasText: 'Comparison & report'}).click();
 await page.getByRole('heading', {name: 'Comparison & report'}).waitFor({timeout: 15000});
 check('comparison and report page still works', true);
 const reportSelector = page.getByLabel('Select saved report version');
 const reportOptions = await reportSelector.locator('option').count();
 check('saved report version option is listed', reportOptions > 1, String(reportOptions) + ' options');
 if (reportOptions > 1) {
  await reportSelector.selectOption({index: 1});
  await page.locator('.report-document').waitFor({timeout: 15000});
  check('saved report version renders a document', await page.locator('.report-document h1').isVisible());
  check('report lists limitations', await page.locator('.report-document').innerText().then(text => /Only human-approved|limitation/i.test(text)));
 } else {
  check('saved report version renders a document', false, 'no saved report for the selected project');
  check('report lists limitations', false, 'no saved report for the selected project');
 }
 await shot('28-projects-report');

 // ================================================================ i18n
 section('Bilingual switch (English ⇄ Simplified Chinese)');
 await gotoPage('Events', 'Event calendar');
 await page.getByRole('button', {name: '中文', exact: true}).click();
 await waitForText('nav', '任务');
 const zhNav = (await page.locator('nav button').allInnerTexts()).join('|');
 check('language switch updates navigation labels', ['展会', '任务', '来源', '项目', '设置'].every(label => zhNav.includes(label)), zhNav.replace(/\n/g, ' '));
 check('document language switches to Chinese', (await page.evaluate(() => document.documentElement.lang)).startsWith('zh'), await page.evaluate(() => document.documentElement.lang));
 check('Chinese document title is set', /展会日历|市场情报/.test(await page.title()), await page.title());
 await page.getByRole('heading', {name: '展会日历'}).waitFor({timeout: 10000});
 check('Events page heading is localized', true);
 await page.locator('nav button').filter({hasText: '任务'}).first().click();
 await page.getByRole('heading', {name: '任务队列'}).waitFor({timeout: 15000});
 check('Tasks page heading is localized', true);
 await shot('29-zh-tasks');
 await page.reload({waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: '展会日历'}).waitFor({timeout: 20000});
 check('Chinese choice persists after a reload', (await page.locator('nav button').allInnerTexts()).join('|').includes('任务'));
 await page.getByRole('button', {name: 'EN', exact: true}).click();
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 15000});
 check('switch back to English restores the English UI', (await page.locator('nav button').allInnerTexts()).join('|').includes('Tasks'));
 check('document language returns to English', (await page.evaluate(() => document.documentElement.lang)).startsWith('en'), await page.evaluate(() => document.documentElement.lang));

 // ============================================================= viewer
 section('Role viewer: read-only across all pages');
 const toViewer = await patchRole('viewer');
 check('switch workspace role to viewer through the API', toViewer.status === 200, 'HTTP ' + toViewer.status + ' · role=' + await roleNow());
 await page.reload({waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => (button.textContent || '').includes('Discover events')), null, {timeout: 15000});
 check('task queue drains before the viewer checks', await drainQueue());
 const viewerCount = await currentDefaultCount();
 await waitEvCount(viewerCount);
 check('viewer default view matches the API event count', await evCount() === viewerCount, 'count=' + viewerCount);
 check('viewer does not see the Discover events action', await page.getByRole('button', {name: 'Discover events'}).count() === 0);
 check('viewer does not see the Add/queue write actions', await page.locator('.ev-heading-actions .primary').count() === 0);
 await openFirstEventCard();
 await page.locator('aside.ev-detail .ev-fields').waitFor({timeout: 10000});
 check('viewer can open event details', await page.locator('aside.ev-detail').isVisible());
 check('viewer does not see enrich/edit actions in the detail panel', await page.getByRole('button', {name: 'Enrich details'}).count() === 0 && await page.getByRole('button', {name: 'Edit details'}).count() === 0);
 await closeDetails();
 await shot('30-viewer-events');

 await gotoPage('Tasks', 'Task queue');
 await waitMinCount('.task-table tbody tr', 1);
 await page.waitForFunction(() => document.querySelectorAll('.task-table thead th').length === 8, null, {timeout: 15000});
 check('viewer task table exposes a read-only details column', await page.locator('.task-table thead th').count() === 8 && await page.locator('.task-actions button').filter({hasText: 'View details'}).count() >= 1, String(await page.locator('.task-table thead th').count()));
 check('viewer sees no cancel/retry buttons in task rows',
  await page.locator('.task-table tbody button').filter({hasText: /^(Cancel|Retry)$/}).count() === 0);
 await page.locator('.task-actions button').filter({hasText: 'View details'}).first().click();
 await page.locator('.task-detail-row .task-detail').waitFor({timeout: 10000});
 check('viewer can expand task details inline (read-only)', await page.locator('.task-detail-row .task-detail').isVisible());
 await page.locator('button[aria-label="Close details"]').click();

 await gotoPage('Sources', 'Sources');
 await waitMinCount('.sources-table tbody tr', 20);
 await waitForText('.alert', 'Read-only role');
 check('viewer sees the read-only role banner', /Read-only role/.test(await page.locator('.alert').first().innerText()));
 check('viewer has no Add source action', await page.getByRole('button', {name: 'Add source'}).count() === 0);
 check('viewer has no source action column', await page.locator('.sources-table tbody button').count() === 0);
 check('viewer source toggles are disabled', await page.locator('input[aria-label^="Toggle source"]').first().isDisabled());
 await shot('31-viewer-sources');

 await gotoPage('Settings', 'Settings');
 await waitForText('.alert', 'Only admins can change');
 check('viewer settings page keeps all eight sections', await page.locator('section.panel.padded').count() === 8, String(await page.locator('section.panel.padded').count()));
 check('viewer sees the admin-only settings banner', /Only admins can change/.test(await page.locator('.alert').first().innerText()));
 check('viewer role selector is disabled', await page.getByLabel('Workspace role').isDisabled());
 check('viewer OCR provider is disabled', await page.getByLabel('OCR provider').isDisabled());
 check('viewer AI model controls are disabled', await page.getByLabel('Model name').isDisabled() && await page.getByLabel('Base URL').isDisabled() && await page.getByLabel('API key').isDisabled());
 check('viewer sees no MCP add/remove/test actions', await page.getByRole('button', {name: 'Add MCP server'}).count() === 0 && await page.locator('button[aria-label^="Remove MCP server"]').count() === 0 && await page.getByRole('button', {name: 'Test connection'}).count() === 0);
 check('viewer MCP enable toggle is disabled', await page.locator('input[aria-label="Enable MCP server qa-acceptance-mcp"]').isDisabled());
 check('viewer sees no skill add/edit/remove actions', await page.getByRole('button', {name: 'Add skill'}).count() === 0 && await page.locator('button[aria-label^="Remove skill"]').count() === 0);
 check('viewer sees no plugin add/remove actions', await page.getByRole('button', {name: 'Add plugin'}).count() === 0 && await page.locator('button[aria-label^="Remove plugin"]').count() === 0);
 check('viewer recipes table has no ACTIONS column', (await page.locator('.settings-table thead').innerText()).includes('ACTIONS') === false);
 await shot('32-viewer-settings');

 await gotoPage('Agent', 'Agent');
 await waitForText('.agent-viewer-note', 'Viewers can read agent history only');
 check('viewer does not see the agent composer', await page.getByLabel('Message the agent').count() === 0);
 check('viewer sees the read-only agent note', /Viewers can read agent history only/.test(await page.locator('.agent-viewer-note').innerText()));
 try {
  await page.waitForFunction(() => {
   const node = document.querySelector('.agent-history .count');
   return Boolean(node) && node.textContent.trim() === '2';
  }, null, {timeout: 12000});
 } catch { /* checked below */ }
 equal('viewer still sees the seeded agent history', (await page.locator('.agent-history .count').innerText()).trim(), '2');
 await page.locator('.agent-session-list button').first().click();
 await page.locator('.agent-transcript').waitFor({timeout: 10000});
 check('viewer can open a read-only transcript', await page.locator('.agent-transcript').isVisible());
 await page.locator('button[aria-label="Close transcript"]').click();
 await shot('33-viewer-agent');

 // =============================================================== user
 section('Role user: toggles and run allowed, management blocked');
 if (!(await forceRole('admin'))) check('restore admin before the user phase', false);
 check('task queue drains before the user checks', await drainQueue());
 const toUser = await patchRole('user');
 check('switch workspace role to user through the API', toUser.status === 200, 'HTTP ' + toUser.status + ' · role=' + await roleNow());
 await page.reload({waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 await page.locator('nav button').filter({hasText: 'Sources'}).first().click();
 await page.getByRole('heading', {name: 'Sources', exact: true}).waitFor({timeout: 15000});
 await waitForText('.alert', 'You can enable, disable and run sources');
 check('user sees the limited-operations banner', /You can enable, disable and run sources/.test(await page.locator('.alert').first().innerText()));
 check('user cannot add sources', await page.getByRole('button', {name: 'Add source'}).count() === 0);
 check('user sees the Run now action', await page.locator('button[aria-label^="Run now"]').count() >= 1);
 check('user sees no edit/delete source actions', await page.locator('button[aria-label^="Edit source"]').count() === 0 && await page.locator('button[aria-label^="Delete source"]').count() === 0);
 const userToggle = page.locator('input[aria-label^="Toggle source"]').first();
 check('user can toggle a source', await userToggle.isEnabled());
 const userWas = await userToggle.isChecked();
 await userToggle.click();
 await successNotice(userWas ? 'Source disabled' : 'Source enabled');
 check('user source toggle succeeds', await userToggle.isChecked() === !userWas);
 await userToggle.click();
 await page.waitForFunction(expected => {
  const input = document.querySelector('input[aria-label^="Toggle source"]');
  return input && input.checked === expected;
 }, userWas, {timeout: 10000});
 await shot('34-user-sources');

 await gotoPage('Settings', 'Settings');
 await waitForText('.alert', 'Only admins can change');
 check('user settings banner explains the limit', /Only admins can change/.test(await page.locator('.alert').first().innerText()));
 check('user role selector is disabled', await page.getByLabel('Workspace role').isDisabled());
 check('user MCP toggle is enabled', await page.locator('input[aria-label="Enable MCP server qa-acceptance-mcp"]').isEnabled());
 check('user sees no MCP add/test/remove actions', await page.getByRole('button', {name: 'Add MCP server'}).count() === 0 && await page.getByRole('button', {name: 'Test connection'}).count() === 0 && await page.locator('button[aria-label^="Remove MCP server"]').count() === 0);
 check('user sees no skill add/remove actions', await page.getByRole('button', {name: 'Add skill'}).count() === 0 && await page.locator('button[aria-label^="Remove skill"]').count() === 0);
 check('user recipes table has no ACTIONS column', (await page.locator('.settings-table thead').innerText()).includes('ACTIONS') === false);
 await shot('35-user-settings');

 await gotoPage('Agent', 'Agent');
 check('user sees the agent composer', await page.getByLabel('Message the agent').count() === 1);

 await gotoPage('Tasks', 'Task queue');
 await waitMinCount('.task-table tbody tr', 1);
 check('user task table keeps the ACTIONS column', await page.locator('.task-table thead th').count() === 8, String(await page.locator('.task-table thead th').count()));

 // ============================================================== restore
 section('Restore admin role');
 check('admin role restored after the role matrix', await forceRole('admin'));
 await page.reload({waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 await page.locator('nav button').filter({hasText: 'Settings'}).first().click();
 await page.getByRole('heading', {name: 'Settings'}).waitFor({timeout: 15000});
 equal('settings role selector shows admin again', await page.getByLabel('Workspace role').inputValue(), 'admin');

 // ============================================================= mobile
 section('Mobile 390×844: six pages, no horizontal overflow, drawer navigation');
 await page.setViewportSize({width: 390, height: 844});
 await page.goto(BASE, {waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 const mobilePages = [
  {label: 'Events', heading: 'Event calendar', shot: '36-mobile-events'},
  {label: 'Tasks', heading: 'Task queue', shot: '37-mobile-tasks'},
  {label: 'Sources', heading: 'Sources', shot: '38-mobile-sources'},
  {label: 'Projects', heading: 'Research dashboard', shot: '39-mobile-projects'},
  {label: 'Agent', heading: 'Agent', shot: '40-mobile-agent'},
  {label: 'Settings', heading: 'Settings', shot: '41-mobile-settings'},
 ];
 for (const item of mobilePages) {
  await page.getByRole('button', {name: 'Open navigation'}).click();
  await page.locator('aside.sidebar.open').waitFor({timeout: 10000});
  if (item.label === 'Events') await shot('42-mobile-nav');
  await page.locator('aside.sidebar nav button').filter({hasText: item.label}).first().click();
  await page.getByRole('heading', {name: item.heading, exact: true}).waitFor({timeout: 15000});
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => ({
   document: document.documentElement.scrollWidth - window.innerWidth,
   main: document.querySelector('.main') ? document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth : 0,
  }));
  check('mobile ' + item.label + ' page renders without horizontal overflow', overflow.document <= 2 && overflow.main <= 2, JSON.stringify(overflow));
  await shot(item.shot);
 }
 check('mobile drawer opens with navigation', await page.getByRole('button', {name: 'Open navigation'}).count() === 1);
 await page.getByRole('button', {name: 'Open navigation'}).click();
 await page.locator('aside.sidebar.open').waitFor({timeout: 10000});
 check('mobile backdrop dismisses the drawer', await page.locator('.nav-backdrop').count() === 1);
 await page.locator('.nav-backdrop').click({position: {x: 385, y: 420}});
 await page.waitForFunction(() => !document.querySelector('aside.sidebar.open'), null, {timeout: 10000});
 check('mobile drawer closes on backdrop tap', true);

 // Mobile event detail stays usable.
 await page.goto(BASE, {waitUntil: 'domcontentloaded'});
 await page.getByRole('heading', {name: 'Event calendar'}).waitFor({timeout: 20000});
 await waitMinCount('.ev-card', 1);
 await page.locator('.ev-card').first().click();
 await page.locator('aside.ev-detail').waitFor({timeout: 10000});
 check('mobile event detail panel opens', await page.locator('aside.ev-detail').isVisible());
 const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
 check('mobile event detail does not overflow horizontally', detailOverflow <= 2, 'overflow=' + detailOverflow);
 await shot('43-mobile-event-detail');
 await closeDetails();

 // ================================================================ errors
 await page.setViewportSize({width: 1440, height: 1000});
 section('Browser error budget');
 check('no uncaught page errors during the run', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ') || 'none');
 check('no console errors during the run (favicon 404s excluded from HTTP list)', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | ') || 'none');
 console.log('INFO  HTTP responses >= 400 observed (excluding favicon): ' + (httpErrors.length ? httpErrors.slice(0, 8).join(' | ') : 'none'));
} catch (error) {
 check('browser acceptance flow ran to completion', false, error instanceof Error ? error.message : String(error));
 console.log(error);
} finally {
 try {
  await forceRole('admin');
 } catch {
  // best effort; the summary below reports the failure count
 }
 await context.close().catch(() => {});
 await browser.close().catch(() => {});
}

console.log('\nconsole errors: ' + consoleErrors.length + ' · page errors: ' + pageErrors.length);
console.log('Result: ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
 console.log('\nFailures:');
 for (const failure of failures) console.log('- ' + failure);
}
if (fail || fail === 0 && pass < 60) {
 if (pass < 60) console.log('\nFAIL  fewer than 60 browser checks were executed (' + pass + ')');
 process.exitCode = 1;
}
