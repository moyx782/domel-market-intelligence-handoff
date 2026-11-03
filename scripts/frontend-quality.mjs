#!/usr/bin/env node
// Automated frontend content + human-experience quality matrix.
//
//   BASE=http://127.0.0.1:5178 API_BASE=http://127.0.0.1:8793 \
//     ACCEPTANCE_DATA_DIR=/tmp/domel-quality node scripts/frontend-quality.mjs
//
// Or run everything (prepare data, start API + Vite, run, clean up):
//   npm run test:frontend
//
// Coverage: every page × locale (zh/en) × viewport (desktop/mobile), plus the
// admin/user/viewer role states, empty/error backend states, keyboard and modal
// behaviour, accessible names/landmarks/heading order, document title/lang,
// mobile horizontal overflow, console/page errors, and screenshots + report.

import {chromium} from 'playwright-core';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const BASE = (process.env.BASE || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const API = (process.env.API_BASE || 'http://127.0.0.1:8793').replace(/\/+$/, '');
const DATA_DIR = process.env.ACCEPTANCE_DATA_DIR || '/tmp/domel-quality';
const CONFIG_FILE = join(DATA_DIR, 'agent-config.json');
const OUT = process.env.QUALITY_EVIDENCE_DIR || join(REPO, 'evidence', 'frontend-quality');
const CHROME = process.env.CHROME_PATH || '';
const SHOT = process.env.QUALITY_SHOTS !== '0';
const timer = {start: Date.now()};

mkdirSync(OUT, {recursive: true});

const PAGES = [
 {key: 'events', nav: {en: 'Events', zh: '展会'}, heading: {en: 'Event calendar', zh: '展会日历'}},
 {key: 'tasks', nav: {en: 'Tasks', zh: '任务'}, heading: {en: 'Task queue', zh: '任务队列'}},
 {key: 'sources', nav: {en: 'Sources', zh: '来源'}, heading: {en: 'Sources', zh: '来源'}},
 {key: 'dashboard', nav: {en: 'Projects', zh: '项目'}, heading: {en: 'Research dashboard', zh: '研究工作台'}},
 {key: 'agent', nav: {en: 'Agent', zh: 'Agent'}, heading: {en: 'Agent', zh: 'Agent'}},
 {key: 'settings', nav: {en: 'Settings', zh: '设置'}, heading: {en: 'Settings', zh: '设置'}},
];
const LOCALES = [
 {lang: 'en', htmlLang: 'en-GB', label: 'EN'},
 {lang: 'zh', htmlLang: 'zh-CN', label: '中文'},
];
const VIEWPORTS = [
 {name: 'desktop', width: 1440, height: 900},
 {name: 'mobile', width: 390, height: 844},
];

let pass = 0;
let fail = 0;
const failures = [];
const warnings = [];

function check(name, ok, detail = '') {
 if (ok) {
  pass += 1;
  console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
 } else {
  fail += 1;
  failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''));
 }
}
function warn(name, detail) {
 warnings.push(name + (detail ? ' — ' + detail : ''));
 console.log('WARN  ' + name + (detail ? ' — ' + detail : ''));
}
function section(title) {
 console.log('\n## ' + title);
}
const label = locale => locale === 'zh' ? '中文' : 'EN';

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
 return (await api('/api/v1/capabilities')).json?.agent_role ?? null;
}

async function setRole(role) {
 if (await roleNow() === role) return true;
 if (role !== 'admin') {
  await api('/api/v1/agent/settings', {method: 'PATCH', body: {role}});
 } else {
  // Demoted roles cannot promote themselves through the API: use the local
  // config file, which the running API reloads through its mtime check.
  let config = {};
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first write */ }
  config.role = 'admin';
  mkdirSync(DATA_DIR, {recursive: true});
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {mode: 0o600});
 }
 for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 100));
  if (await roleNow() === role) return true;
 }
 return false;
}

async function launchBrowser() {
 const options = {headless: true};
 if (CHROME && existsSync(CHROME)) options.executablePath = CHROME;
 else options.channel = 'chrome';
 return chromium.launch(options);
}

function collectIssues() {
 // Runs inside the page. Kept dependency-free so it works without axe-core.
 const visible = element => {
  if (!element || !(element instanceof HTMLElement)) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
 };
 const nameOf = element => {
  const aria = element.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelled = element.getAttribute('aria-labelledby');
  if (labelled) {
   const text = labelled.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
   if (text) return text;
  }
  if (element.id) {
   const explicit = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
   if (explicit && explicit.textContent.trim()) return explicit.textContent.trim();
  }
  const wrapping = element.closest('label');
  if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
  const placeholder = element.getAttribute('placeholder');
  if (placeholder && placeholder.trim()) return placeholder.trim();
  const title = element.getAttribute('title');
  if (title && title.trim()) return title.trim();
  return (element.textContent ?? '').trim();
 };
 const issues = [];
 const interactive = [...document.querySelectorAll('button,a[href],input,select,textarea')].filter(visible);
 for (const element of interactive) {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image'].includes(element.type)) continue;
  if (!nameOf(element)) issues.push('interactive element without accessible name: <' + tag + '> ' + element.outerHTML.slice(0, 120));
 }
 for (const image of [...document.querySelectorAll('img')].filter(visible)) {
  if (!image.hasAttribute('alt')) issues.push('image without alt: ' + image.src.slice(0, 120));
 }
 const ids = new Map();
 for (const element of document.querySelectorAll('[id]')) ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
 for (const [id, count] of ids) if (count > 1) issues.push('duplicate id: ' + id);
 const headings = [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')].filter(visible);
 const h1 = headings.filter(heading => heading.tagName === 'H1').length;
 if (h1 !== 1) issues.push('main should have exactly one h1, found ' + h1);
 let previous = 0;
 for (const heading of headings) {
  const level = Number(heading.tagName.slice(1));
  if (previous && level > previous + 1) issues.push('heading level jumps from h' + previous + ' to h' + level + ': ' + heading.textContent.trim().slice(0, 80));
  previous = level;
 }
 for (const selector of ['header', 'nav', 'main']) {
  if (!document.querySelector(selector)) issues.push('missing landmark: <' + selector + '>');
 }
 if (document.querySelectorAll('main').length !== 1) issues.push('should have exactly one <main>');
 const skip = document.querySelector('a.skip-link');
 if (!skip) issues.push('missing skip link');
 else if (skip.getAttribute('href') !== '#main-content' || !document.getElementById('main-content')) issues.push('skip link does not target #main-content');
 if (document.documentElement.lang !== 'en-GB' && document.documentElement.lang !== 'zh-CN' && document.documentElement.lang !== 'en' && document.documentElement.lang !== 'zh') {
  issues.push('html lang is not a supported locale: ' + document.documentElement.lang);
 }
 if (document.documentElement.scrollWidth > window.innerWidth + 2) {
  issues.push('horizontal overflow: ' + document.documentElement.scrollWidth + 'px > ' + window.innerWidth + 'px');
 }
 return {issues, counts: {interactive: interactive.length, headings: headings.length}};
}

async function newPage(browser, {locale, viewport}) {
 const context = await browser.newContext({
  viewport: {width: viewport.width, height: viewport.height},
  deviceScaleFactor: 1,
  locale: locale === 'zh' ? 'zh-CN' : 'en-GB',
 });
 await context.addInitScript(saved => {
  try { localStorage.setItem('domel.lang', saved); } catch { /* storage blocked */ }
 }, locale);
 const page = await context.newPage();
 const errors = {console: [], page: [], http: []};
 page.on('console', message => { if (message.type() === 'error') errors.console.push(message.text()); });
 page.on('pageerror', error => errors.page.push(String(error)));
 page.on('response', response => {
  const status = response.status();
  if (status >= 400 && !/favicon/.test(response.url())) errors.http.push(status + ' ' + response.url());
 });
 return {context, page, errors};
}

async function gotoPage(page, navLabel, mobile) {
 if (mobile) {
  if (!(await page.locator('.sidebar.open').count())) await page.locator('.mobile-toggle').click();
  await page.waitForTimeout(150);
  await page.locator('nav button').filter({hasText: navLabel}).first().click();
  await page.waitForTimeout(200);
 } else {
  await page.locator('nav button').filter({hasText: navLabel}).first().click();
 }
 await page.waitForTimeout(350);
}

async function main() {
 const browser = await launchBrowser();
 const started = await roleNow();
 if (started !== 'admin') throw Error('quality run needs admin role, got ' + started);
 const results = [];

 section('Content matrix: pages × locale × viewport');
 for (const viewport of VIEWPORTS) {
  for (const locale of LOCALES) {
   for (const target of PAGES) {
    const {context, page, errors} = await newPage(browser, {locale: locale.lang, viewport});
    const name = '[' + viewport.name + ' / ' + locale.lang + '] ' + target.key;
    await page.goto(BASE, {waitUntil: 'domcontentloaded'});
    await page.waitForSelector('main', {timeout: 15000});
    await gotoPage(page, target.nav[locale.lang], viewport.name === 'mobile');
    await page.waitForTimeout(250);
    const title = await page.title();
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    const headingText = (await page.locator('main h1').first().innerText().catch(() => '')).trim();
    const structure = await page.evaluate(collectIssues);
    check(name + ' heading', headingText === target.heading[locale.lang], 'got ' + JSON.stringify(headingText));
    check(name + ' document title', title.includes(target.heading[locale.lang]) && title.includes('Domel'), 'got ' + JSON.stringify(title));
    check(name + ' html lang', htmlLang === locale.htmlLang, 'got ' + htmlLang);
    check(name + ' accessible structure', structure.issues.filter(issue => !/horizontal overflow/.test(issue)).length === 0, structure.issues.filter(issue => !/horizontal overflow/.test(issue)).slice(0, 4).join(' | '));
    check(name + ' no horizontal overflow', !structure.issues.some(issue => /horizontal overflow/.test(issue)), structure.issues.filter(issue => /horizontal overflow/.test(issue)).join(' | '));
    check(name + ' no console/page errors', errors.console.length === 0 && errors.page.length === 0, [...errors.console, ...errors.page].slice(0, 3).join(' | '));
    if (errors.http.length) warn(name + ' HTTP errors', [...new Set(errors.http)].slice(0, 4).join(' | '));
    if (SHOT) await page.screenshot({path: join(OUT, viewport.name + '-' + locale.lang + '-' + target.key + '.png'), fullPage: false});
    results.push({viewport: viewport.name, locale: locale.lang, page: target.key, heading: headingText, title, localStorage: 'domel.lang=' + locale.lang, issues: structure.issues.length});
    await context.close();
   }
  }
 }

 section('Role states: admin / user / viewer');
 for (const role of ['admin', 'user', 'viewer']) {
  await setRole(role);
  const {context, page, errors} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('main', {timeout: 15000});
  await page.waitForTimeout(250);
  const navName = role === 'viewer' ? 'Events' : 'Projects';
  await gotoPage(page, navName, false);
  await page.waitForTimeout(200);
  const structure = await page.evaluate(collectIssues);
  check('[role ' + role + '] accessible structure', structure.issues.length === 0, structure.issues.slice(0, 4).join(' | '));
  check('[role ' + role + '] no console/page errors', errors.console.length === 0 && errors.page.length === 0, [...errors.console, ...errors.page].slice(0, 3).join(' | '));
  if (role === 'viewer') {
   check('viewer sees no New research action', await page.getByRole('button', {name: 'New research'}).count() === 0);
   await gotoPage(page, 'Settings', false);
   await page.waitForTimeout(250);
   check('viewer Settings shows the read-only banner', /read-only|Only admins/i.test(await page.locator('.alert').first().innerText().catch(() => '')));
   check('viewer Settings AI model controls are disabled', await page.getByLabel('Model name').isDisabled());
   await page.screenshot({path: join(OUT, 'role-viewer-settings.png'), fullPage: false});
  }
  if (role === 'user') {
   await gotoPage(page, 'Settings', false);
   await page.waitForTimeout(250);
   check('user Settings allows toggles but not full management', /enable or disable|Only admins/i.test(await page.locator('main').innerText()));
  }
  await context.close();
 }
 if (!(await setRole('admin'))) throw Error('failed to restore admin role');

 section('Backend states: empty and error');
 {
  const {context, page, errors} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.route('**/api/v1/workspace', route => route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: 'mock workspace failure'})}));
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('[role="alert"]', {timeout: 15000});
  check('workspace error shows an alert', /failed to load/i.test(await page.locator('[role="alert"]').first().innerText()));
  check('workspace error offers Retry', await page.getByRole('button', {name: 'Retry'}).count() >= 1);
  await page.screenshot({path: join(OUT, 'state-workspace-error.png'), fullPage: false});
  check('workspace error page has no runtime errors', errors.page.length === 0, errors.page.join(' | '));
  await context.close();
 }
 {
  const empty = JSON.stringify({projects: [], sources: [], findings: [], audits: [], reports: []});
  const {context, page} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.route('**/api/v1/workspace', route => route.fulfill({status: 200, contentType: 'application/json', body: empty}));
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('main', {timeout: 15000});
  await gotoPage(page, 'Projects', false);
  await page.waitForTimeout(400);
  check('empty workspace shows the empty state', /No matching research projects|No research projects/i.test(await page.locator('main').innerText()));
  await page.screenshot({path: join(OUT, 'state-empty-dashboard.png'), fullPage: false});
  await context.close();
 }
 {
  const {context, page} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.route('**/api/v1/events**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({events: [], count: 0})}));
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('main', {timeout: 15000});
  await page.waitForTimeout(500);
  check('empty event library shows an empty state', /No events in the library yet/i.test(await page.locator('main').innerText()));
  await page.screenshot({path: join(OUT, 'state-empty-events.png'), fullPage: false});
  await context.close();
 }

 section('Keyboard, skip link and modal behaviour');
 {
  const {context, page} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('main', {timeout: 15000});
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => ({tag: document.activeElement?.tagName, text: (document.activeElement?.textContent ?? '').trim(), href: document.activeElement?.getAttribute?.('href')}));
  check('first Tab focuses the skip link', firstFocus.tag === 'A' && /Skip to main content/.test(firstFocus.text) && firstFocus.href === '#main-content', JSON.stringify(firstFocus));
  await page.keyboard.press('Enter');
  const focusedMain = await page.evaluate(() => document.activeElement?.id === 'main-content');
  check('skip link moves focus to main', focusedMain);
  const trigger = page.getByRole('button', {name: 'Workflow guide'}).first();
  await trigger.click();
  await page.waitForSelector('[role="dialog"]', {timeout: 5000});
  const focusInside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  check('dialog receives keyboard focus', focusInside);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes the workflow guide', await page.locator('[role="dialog"]').count() === 0);
  const focusReturned = await page.evaluate(() => /Workflow guide/.test(document.activeElement?.textContent ?? ''));
  check('dialog closes and returns focus to its trigger', focusReturned);
  await page.screenshot({path: join(OUT, 'keyboard-skip-link.png'), fullPage: false});
  await context.close();
 }

 section('Language switching updates lang + title');
 {
  const {context, page} = await newPage(browser, {locale: 'en', viewport: VIEWPORTS[0]});
  await page.goto(BASE, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('main', {timeout: 15000});
  await page.getByRole('button', {name: '中文', exact: true}).click();
  await page.waitForTimeout(300);
  check('language switch updates html lang', await page.evaluate(() => document.documentElement.lang) === 'zh-CN');
  check('language switch updates the document title', /Domel/.test(await page.title()) && /展会日历|Event calendar/.test(await page.title()), await page.title());
  check('language switch updates nav labels', /展会/.test(await page.locator('nav').innerText()));
  await page.getByRole('button', {name: 'EN', exact: true}).click();
  await page.waitForTimeout(250);
  check('language switch back to English', await page.evaluate(() => document.documentElement.lang) === 'en-GB');
  await context.close();
 }

 await browser.close();

 const report = [
  '# Frontend quality report',
  '',
  'Generated: ' + new Date().toISOString(),
  'Base: ' + BASE + ' · API: ' + API,
  'Duration: ' + Math.round((Date.now() - timer.start) / 1000) + 's',
  '',
  '## Result',
  '',
  '**' + pass + ' passed / ' + fail + ' failed**' + (warnings.length ? ' · ' + warnings.length + ' warnings' : ''),
  '',
  '## Content matrix',
  '',
  '| viewport | locale | page | heading | title |',
  '|---|---|---|---|---|',
  ...results.map(row => '| ' + row.viewport + ' | ' + row.locale + ' | ' + row.page + ' | ' + row.heading + ' | ' + row.title.replace(/\|/g, '\\|') + ' |'),
  '',
  failures.length ? '## Failures\n\n' + failures.map(item => '- ' + item).join('\n') : '## Failures\n\nNone.',
  warnings.length ? '\n## Warnings\n\n' + warnings.map(item => '- ' + item).join('\n') : '',
  '',
  '## Coverage',
  '',
  '- Pages: ' + PAGES.map(page => page.key).join(', '),
  '- Locales: en, zh; roles: admin, user, viewer; viewports: 1440×900, 390×844.',
  '- Backend states: workspace 500, empty workspace, empty event library.',
  '- Accessibility: landmark structure, one h1, heading order, accessible names, image alt, duplicate ids, skip link, supported html lang.',
  '- UX: per-page document title, locale switch, skip link focus, dialog focus/escape/return, mobile horizontal overflow, Retry on load failure.',
  '- Screenshots: ' + (SHOT ? OUT : 'disabled (QUALITY_SHOTS=0)'),
  '',
 ].join('\n');
 writeFileSync(join(OUT, 'REPORT.md'), report);
 console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + warnings.length + ' warnings');
 console.log('Report: ' + join(OUT, 'REPORT.md'));
 process.exitCode = fail ? 1 : 0;
}

main().catch(error => {
 console.error('Frontend quality run failed: ' + (error instanceof Error ? error.message : error));
 process.exitCode = 1;
});
