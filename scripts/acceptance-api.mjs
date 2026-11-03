#!/usr/bin/env node
// Independent API acceptance for M1–M5. Pure Node: no browser, no test runner.
//
//   node scripts/acceptance-api.mjs --prepare [--fixtures]
//   API_BASE=http://127.0.0.1:8791 ACCEPTANCE_DATA_DIR=/tmp/domel-acceptance \
//     node scripts/acceptance-api.mjs
//
// `--prepare` builds an isolated data directory (never the repository .local/):
// the demo project is copied, a read-only agent transcript fixture is written,
// and the source registry is seeded with future nextRunAt values so the
// scheduler does not flood the queue. `--fixtures` additionally writes fallback
// event records before the API starts; the preferred path is one real
// POST /api/v1/events/discover against the running API.
//
// The checks switch the workspace role through PATCH /api/v1/agent/settings and
// restore admin afterwards (the file fallback is needed because a demoted role
// cannot promote itself back through the API, by design). The script never
// writes the repository .local/ directory.
//
// Exit code 0 = every check passed, 1 = at least one FAIL.

import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const API = (process.env.API_BASE || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const DATA_DIR = process.env.ACCEPTANCE_DATA_DIR || '/tmp/domel-acceptance';
const CONFIG_FILE = join(DATA_DIR, 'agent-config.json');
const TRANSCRIPT_FILE = join(DATA_DIR, 'agent', 'transcripts.json');
const REGISTRY_FILE = join(DATA_DIR, 'source-registry.json');
const EVENTS_FILE = join(DATA_DIR, 'events.json');
const ROLE_NAMES = ['viewer', 'user', 'admin', 'system'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
const failures = [];

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

async function request(path, {method = 'GET', body, headers = {}} = {}) {
 const init = {method, headers: {...headers}};
 if (body !== undefined) {
  init.headers['Content-Type'] = 'application/json';
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
 }
 try {
  const response = await fetch(API + path, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (CSV, SSE) */ }
  return {status: response.status, headers: response.headers, text, json};
 } catch (error) {
  return {status: 0, headers: new Headers(), text: '', json: null, error: String(error)};
 }
}

// Reads the first SSE frame. The server writes a snapshot immediately on
// subscribe, so one read is enough to prove the stream works.
async function firstSSE(path, timeoutMs = 5000) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), timeoutMs);
 try {
  const response = await fetch(API + path, {signal: controller.signal, headers: {Accept: 'text/event-stream'}});
  const reader = response.body?.getReader();
  if (!reader) return {status: response.status, text: ''};
  const {value} = await reader.read();
  reader.cancel().catch(() => {});
  return {status: response.status, text: value ? new TextDecoder().decode(value) : ''};
 } catch (error) {
  return {status: 0, text: '', error: String(error)};
 } finally {
  clearTimeout(timer);
  controller.abort();
 }
}

async function currentRole() {
 const response = await request('/api/v1/capabilities');
 return response.json?.agent_role ?? null;
}

// Rewriting agent-config.json is the documented recovery path after a demotion
// (the web API intentionally cannot promote a viewer/user back to admin). The
// running API reloads the role from the file, so no restart is needed.
async function forceRole(role) {
 for (let attempt = 0; attempt < 30; attempt += 1) {
  let config = {};
  try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first write */ }
  config.role = role;
  try {
   mkdirSync(DATA_DIR, {recursive: true});
   writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {mode: 0o600});
  } catch (error) {
   return {ok: false, error: String(error)};
  }
  // mtime based reload: a same-millisecond write may be missed, so retry.
  await sleep(120);
  if (await currentRole() === role) return {ok: true};
  await sleep(120);
 }
 return {ok: false, error: 'role did not reload from ' + CONFIG_FILE};
}

async function patchRole(role) {
 return request('/api/v1/agent/settings', {method: 'PATCH', body: {role}});
}

async function pollTask(id, predicate, timeoutMs = 12000) {
 const deadline = Date.now() + timeoutMs;
 let last = null;
 while (Date.now() < deadline) {
  const response = await request('/api/v1/tasks/' + id);
  last = response.json;
  if (response.status === 200 && predicate(response.json)) return response.json;
  await sleep(200);
 }
 return last;
}

function fixtureEvents() {
 const verifiedAt = new Date().toISOString();
 return [
  {
   name: 'Acceptance Fixture Expo 2027', edition: 7, startDate: '2027-03-11', endDate: '2027-03-13',
   city: 'Shanghai', country: 'China', venue: 'SNIEC', organizer: 'Fixture Org',
   website: 'https://example.com/afe', frequency: 'annual', industries: ['HVAC', 'electric motors'],
   region: 'cn', confidence: 'high', status: 'verified',
   sources: [{url: 'https://example.com/afe/about', title: 'Official page', verifiedAt}],
   notes: ['Acceptance fixture record'],
  },
  {
   name: 'Acceptance Fixture Expo Europe 2027', startDate: '2027-05-04', endDate: '2027-05-06',
   city: 'Munich', country: 'Germany', venue: 'Messe München', website: 'https://example.com/afe-eu',
   industries: ['drives'], region: 'eu', confidence: 'medium', status: 'enriched',
   sources: [{url: 'https://example.com/afe-eu/about', title: 'Official page', verifiedAt}],
  },
  {
   name: 'Acceptance Fixture Expo 2028', startDate: '2028-01-20', endDate: '2028-01-22',
   city: 'Beijing', country: 'China', venue: 'New CIEC', website: 'https://example.com/afe-2028',
   industries: ['HVAC'], region: 'cn', confidence: 'low', status: 'discovered',
   notes: ['Dates to be confirmed'],
  },
  {
   name: 'Acceptance Fixture Global Trade Fair', city: 'Singapore', venue: 'Marina Bay Sands',
   website: 'https://example.com/global', industries: ['general trade'], region: 'global',
   confidence: 'medium', status: 'discovered',
  },
 ];
}

async function prepare({fixtures = false} = {}) {
 mkdirSync(DATA_DIR, {recursive: true});
 mkdirSync(join(DATA_DIR, 'agent'), {recursive: true});
 console.log('data dir: ' + DATA_DIR);

 const demoSource = join(REPO, '.local', 'domel.json');
 const demoTarget = join(DATA_DIR, 'domel.json');
 if (!existsSync(demoTarget)) {
  if (!existsSync(demoSource)) throw Error('missing demo data: ' + demoSource);
  copyFileSync(demoSource, demoTarget);
  console.log('copied demo project data -> ' + demoTarget);
 } else {
  console.log('demo project data already present');
 }

 if (!existsSync(TRANSCRIPT_FILE)) {
  const now = Date.now();
  const sessions = [
   {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'general',
    title: 'Summarize the latest trade show data in the workspace.',
    createdAt: new Date(now - 3600_000).toISOString(),
    updatedAt: new Date(now - 3500_000).toISOString(),
    messages: [
     {role: 'user', text: 'Summarize the latest trade show data in the workspace.', at: new Date(now - 3600_000).toISOString()},
     {
      role: 'assistant',
      text: 'Acceptance transcript fixture: China trade show records are available on the Events page.',
      at: new Date(now - 3500_000).toISOString(),
      toolCalls: [{tool: 'list_events', args: '{"region":"cn"}', ok: true}],
     },
    ],
   },
   {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: 'general',
    title: 'Which events are missing dates or venues?',
    createdAt: new Date(now - 7200_000).toISOString(),
    updatedAt: new Date(now - 7100_000).toISOString(),
    messages: [
     {role: 'user', text: 'Which events are missing dates or venues?', at: new Date(now - 7200_000).toISOString()},
     {role: 'assistant', text: 'Acceptance transcript fixture: the event detail panel lists missing data notes.', at: new Date(now - 7100_000).toISOString()},
    ],
   },
  ];
  writeFileSync(TRANSCRIPT_FILE, JSON.stringify({version: 1, sessions}, null, 2));
  console.log('wrote agent transcript fixture: ' + TRANSCRIPT_FILE);
 } else {
  console.log('agent transcript fixture already present');
 }

 if (!existsSync(REGISTRY_FILE)) {
  const moduleUrl = pathToFileURL(join(REPO, 'server', 'source-registry.mjs')).href;
  const {openSourceRegistry} = await import(moduleUrl);
  const registry = openSourceRegistry({file: REGISTRY_FILE, seedFile: join(REPO, 'seed', 'sources-cn.json')});
  const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  const stamp = Date.now();
  for (const source of data.sources) source.nextRunAt = new Date(stamp + 24 * 3600 * 1000).toISOString();
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
  console.log('seeded source registry: ' + data.sources.length + ' sources (next run +24h; scheduler parked)');
 } else {
  console.log('source registry already present');
 }

 if (fixtures) {
  if (!existsSync(EVENTS_FILE)) {
   const moduleUrl = pathToFileURL(join(REPO, 'server', 'event-store.mjs')).href;
   const {openEventStore} = await import(moduleUrl);
   const store = openEventStore({file: EVENTS_FILE});
   for (const event of fixtureEvents()) store.upsert(event);
   console.log('wrote fallback event fixtures: ' + store.list({}).length);
  } else {
   console.log('events file already present: ' + JSON.parse(readFileSync(EVENTS_FILE, 'utf8')).events.length + ' records');
  }
 } else {
  console.log('events come from one real POST /api/v1/events/discover after the API starts');
  console.log('(or re-run --prepare --fixtures BEFORE starting the API to use fixtures instead)');
 }
 return 0;
}

async function cleanupCreated(refs) {
 // Best effort: restore admin, cancel leftovers, remove records created by this run.
 await forceRole('admin');
 for (const id of refs.queueIds) {
  // Cancel only queued leftovers: cancelling a running Playwright render is a
  // separate known defect (BUG-3) that crashes the API process.
  const current = await request('/api/v1/tasks/' + id);
  if (current.json?.state === 'queued') await request('/api/v1/tasks/' + id + '/cancel', {method: 'POST', body: {}});
 }
 if (refs.sourceId) {
  const removed = await request('/api/v1/sources/' + refs.sourceId, {method: 'DELETE'});
  check('cleanup: delete source created by acceptance', removed.status === 200 || removed.status === 404, 'HTTP ' + removed.status);
 }
 if (refs.recipeId) {
  const removed = await request('/api/v1/recipes/' + refs.recipeId, {method: 'DELETE'});
  check('cleanup: delete recipe created by acceptance', removed.status === 200 || removed.status === 404, 'HTTP ' + removed.status);
 }
 if (refs.mcpName) {
  const removed = await request('/api/v1/agent/mcp/' + encodeURIComponent(refs.mcpName), {method: 'DELETE'});
  check('cleanup: delete MCP server created by acceptance', removed.status === 200 || removed.status === 404, 'HTTP ' + removed.status);
 }
 if (refs.skillId) {
  const removed = await request('/api/v1/agent/skills/' + refs.skillId, {method: 'DELETE'});
  check('cleanup: delete skill created by acceptance', removed.status === 200 || removed.status === 404, 'HTTP ' + removed.status);
 }
 if (refs.pluginId) {
  const removed = await request('/api/v1/agent/plugins/' + refs.pluginId, {method: 'DELETE'});
  check('cleanup: delete plugin created by acceptance', removed.status === 200 || removed.status === 404, 'HTTP ' + removed.status);
 }
 await forceRole('admin');
}

async function run() {
 const startedAt = new Date().toISOString();
 console.log('API acceptance — ' + startedAt);
 console.log('API: ' + API + ' · data dir: ' + DATA_DIR);

 if (!(await forceRole('admin')).ok) {
  console.log('Cannot set the workspace role to admin before the run. Start the API with AGENT_DATA_DIR=' + DATA_DIR + ' first.');
  return 1;
 }

 const refs = {sourceId: null, recipeId: null, mcpName: null, skillId: null, pluginId: null, queueIds: []};
 let createdSource = null;
 let createdRecipe = null;
 let createdSkill = null;
 let createdPlugin = null;
 let firstEvent = null;
 let firstEventOriginal = {};
 let sourceList = [];

 try {
  // ------------------------------------------------------------------ service
  section('Service health and wiring');
  const health = await request('/health');
  equal('GET /health returns 200', health.status, 200);
  equal('health.status is ok', health.json?.status, 'ok');
  equal('health.architecture is local-single-user', health.json?.architecture, 'local-single-user');
  const capabilities = await request('/api/v1/capabilities');
  equal('GET /api/v1/capabilities returns 200', capabilities.status, 200);
  check('capabilities.version is a string', typeof capabilities.json?.version === 'string', String(capabilities.json?.version));
  equal('capabilities.execution is local-single-user', capabilities.json?.execution, 'local-single-user');
  check('capabilities.agent_role is a valid role', ROLE_NAMES.includes(capabilities.json?.agent_role), String(capabilities.json?.agent_role));
  check('task file is the isolated acceptance data dir', String(capabilities.json?.queue?.file || '').endsWith(join('domel-acceptance', 'tasks.json')) || String(capabilities.json?.queue?.file || '').includes(DATA_DIR), String(capabilities.json?.queue?.file));
  const workspace = await request('/api/v1/workspace');
  equal('GET /api/v1/workspace returns 200', workspace.status, 200);
  check('workspace has at least one project', (workspace.json?.projects ?? []).length >= 1, String((workspace.json?.projects ?? []).length));
  check('workspace exposes sources/findings/audits/reports arrays',
   Array.isArray(workspace.json?.sources) && Array.isArray(workspace.json?.findings) && Array.isArray(workspace.json?.audits) && Array.isArray(workspace.json?.reports));
  // The dev UI runs on a different origin than the API, so management
  // DELETE/PUT calls need these methods advertised in the preflight response.
  const preflight = await fetch(API + '/api/v1/sources/00000000-0000-4000-8000-000000000000', {
   method: 'OPTIONS',
   headers: {
    Origin: 'http://127.0.0.1:5176',
    'Access-Control-Request-Method': 'DELETE',
    'Access-Control-Request-Headers': 'content-type',
   },
  }).catch(() => null);
  const allowedMethods = String(preflight?.headers.get('access-control-allow-methods') || '');
  check('CORS preflight advertises DELETE for the management UI', allowedMethods.includes('DELETE'), allowedMethods);
  check('CORS preflight advertises PUT for the raw MCP editor', allowedMethods.includes('PUT'), allowedMethods);
  equal('unknown API route returns 404', (await request('/api/v1/acceptance-no-route')).status, 404);
  equal('invalid JSON body returns 400', (await request('/api/v1/events/discover', {method: 'POST', body: '{not json'})).status, 400);

  // -------------------------------------------------------------------- tasks
  section('Task queue API');
  const tasksResponse = await request('/api/v1/tasks');
  equal('GET /api/v1/tasks returns 200', tasksResponse.status, 200);
  const stats = tasksResponse.json?.stats ?? {};
  check('task stats exposes all five states',
   ['queued', 'running', 'succeeded', 'failed', 'cancelled'].every(key => typeof stats[key] === 'number'),
   JSON.stringify(stats));
  check('task list contains records', (tasksResponse.json?.tasks ?? []).length >= 1, String((tasksResponse.json?.tasks ?? []).length));
  equal('tasks limit=1 is honoured', ((await request('/api/v1/tasks?limit=1')).json?.tasks ?? []).length, 1);
  const succeeded = await request('/api/v1/tasks?state=succeeded');
  check('state filter returns only succeeded tasks',
   (succeeded.json?.tasks ?? []).length > 0 && succeeded.json.tasks.every(task => task.state === 'succeeded'),
   String((succeeded.json?.tasks ?? []).length) + ' tasks');
  const discoverTasks = await request('/api/v1/tasks?kind=event.discover');
  check('kind filter returns only event.discover tasks',
   (discoverTasks.json?.tasks ?? []).length > 0 && discoverTasks.json.tasks.every(task => task.kind === 'event.discover'),
   String((discoverTasks.json?.tasks ?? []).length) + ' tasks');
  const finishedDiscover = (discoverTasks.json?.tasks ?? []).find(task => task.state === 'succeeded');
  check('prepared discover task succeeded', Boolean(finishedDiscover), finishedDiscover ? 'id ' + finishedDiscover.id.slice(0, 8) : 'run a real discover first');
  check('discover task result reports created/merged counts', Boolean(finishedDiscover?.result) && Number.isFinite(finishedDiscover.result?.created), JSON.stringify(finishedDiscover?.result ?? null).slice(0, 120));
  const taskDetail = await request('/api/v1/tasks/' + finishedDiscover?.id);
  equal('GET /api/v1/tasks/:id returns 200', taskDetail.status, 200);
  check('task detail has payload, log and attempt fields',
   taskDetail.json?.id === finishedDiscover?.id && Array.isArray(taskDetail.json?.log) && typeof taskDetail.json?.payload === 'object' && Number.isFinite(taskDetail.json?.maxAttempts));
  equal('GET missing task returns 404', (await request('/api/v1/tasks/00000000-0000-4000-8000-000000000000')).status, 404);
  equal('GET malformed task id returns 404', (await request('/api/v1/tasks/not-a-uuid')).status, 404);

  const sse = await firstSSE('/api/v1/tasks/stream');
  equal('task SSE returns 200', sse.status, 200);
  check('task SSE first frame is a snapshot', sse.text.includes('"type":"snapshot"'), sse.text.slice(0, 120));
  check('task SSE snapshot carries tasks and stats', sse.text.includes('"tasks"') && sse.text.includes('"stats"'), sse.text.slice(0, 160));

  // Cancel/retry lifecycle using two real source-run tasks (concurrency 1 keeps
  // the second one queued).
  const sourcesForTasks = (await request('/api/v1/sources')).json?.sources ?? [];
  sourceList = sourcesForTasks;
  const sourceA = sourcesForTasks[0];
  const sourceB = sourcesForTasks[1];
  const sourceC = sourcesForTasks[2];
  const runA = await request('/api/v1/sources/' + sourceA?.id + '/run', {method: 'POST', body: {}});
  const runB = await request('/api/v1/sources/' + sourceB?.id + '/run', {method: 'POST', body: {}});
  check('POST source run creates a source.collect task (A)', runA.status === 202 && runA.json?.task?.kind === 'source.collect', 'HTTP ' + runA.status);
  check('POST source run creates a second task (B)', runB.status === 202 && runB.json?.task?.kind === 'source.collect', 'HTTP ' + runB.status);
  const taskB = runB.json?.task;
  if (taskB) refs.queueIds.push(taskB.id);
  const queuedB = taskB ? await pollTask(taskB.id, task => task.state === 'queued' || task.state === 'running', 5000) : null;
  check('second task starts queued/running behind the first', Boolean(queuedB) && (queuedB.state === 'queued' || queuedB.state === 'running'), queuedB?.state ?? 'no task');
  const cancelB = taskB ? await request('/api/v1/tasks/' + taskB.id + '/cancel', {method: 'POST', body: {}}) : {status: 0};
  check('cancel queued/running task returns 200', cancelB.status === 200, 'HTTP ' + cancelB.status);
  const cancelledB = taskB ? await pollTask(taskB.id, task => task.state === 'cancelled', 12000) : null;
  check('cancelled task reaches final cancelled state', cancelledB?.state === 'cancelled', cancelledB?.state ?? 'no task');
  const retryB = taskB ? await request('/api/v1/tasks/' + taskB.id + '/retry', {method: 'POST', body: {}}) : {status: 0};
  check('retry cancelled task returns 200', retryB.status === 200, 'HTTP ' + retryB.status);
  check('retried task returns to queued', retryB.json?.state === 'queued' || retryB.json?.state === 'running', String(retryB.json?.state));
  if (taskB) await request('/api/v1/tasks/' + taskB.id + '/cancel', {method: 'POST', body: {}});
  const cancelMissing = await request('/api/v1/tasks/00000000-0000-4000-8000-000000000000/cancel', {method: 'POST', body: {}});
  equal('cancel unknown task returns 404', cancelMissing.status, 404);
  const retryMissing = await request('/api/v1/tasks/00000000-0000-4000-8000-000000000000/retry', {method: 'POST', body: {}});
  equal('retry unknown task returns 404', retryMissing.status, 404);
  const runC = sourceC ? await request('/api/v1/sources/' + sourceC.id + '/run', {method: 'POST', body: {}}) : {status: 0};
  if (runC.json?.task?.id) {
   refs.queueIds.push(runC.json.task.id);
   const retryQueued = await request('/api/v1/tasks/' + runC.json.task.id + '/retry', {method: 'POST', body: {}});
   equal('retry on a non-failed task returns 409', retryQueued.status, 409);
   const cState = (await request('/api/v1/tasks/' + runC.json.task.id)).json?.state;
   if (cState === 'queued') await request('/api/v1/tasks/' + runC.json.task.id + '/cancel', {method: 'POST', body: {}});
  } else {
   check('retry on a non-failed task returns 409', false, 'could not create task C');
  }

  // ------------------- collector abort regression (BUG-3) -----------------
  section('Collector abort regression (BUG-3: cancellation must not kill the API)');
  // The single worker may still be collecting for the lifecycle tasks above;
  // wait for the queue to drain so the JS-shell task really reaches running.
  let drained = false;
  const drainDeadline = Date.now() + 90000;
  while (Date.now() < drainDeadline) {
   const active = ((await request('/api/v1/tasks?limit=200')).json?.tasks ?? [])
    .filter(task => task.state === 'queued' || task.state === 'running');
   if (!active.length) { drained = true; break; }
   await sleep(500);
  }
  check('task queue is idle before the abort regression', drained);
  // The synchronous <script src="/slow.js"> keeps DOMContentLoaded pending for
  // 2 s, so cancelling ~1 s after the task starts reliably happens while the
  // Playwright fallback is running (and the HTTP response is already consumed).
  const shellServer = createServer((req, res) => {
   if (req.url === '/robots.txt') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('User-agent: *\nAllow: /\n');
    return;
   }
   if (req.url === '/slow.js') {
    setTimeout(() => {
     if (!res.writableEnded) { res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end('window.__ready = true;'); }
    }, 2000);
    return;
   }
   res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
   res.end('<!doctype html><html><head><title>JS shell</title><script src="/slow.js"></script></head><body><div id="app">loading</div>'
    + '<script>setTimeout(function(){document.getElementById("app").textContent="Rendered acceptance content ".repeat(40);}, 250);</script></body></html>');
  });
  await new Promise(resolve => shellServer.listen(0, '127.0.0.1', resolve));
  const shellPort = shellServer.address().port;
  try {
   const shellSource = await request('/api/v1/sources', {
    method: 'POST',
    body: {url: 'http://127.0.0.1:' + shellPort + '/shell', title: 'QA JS shell page', type: 'site', region: 'cn', priority: 1, intervalSec: 3600},
   });
   check('create a local JS-shell source for the abort regression', shellSource.status === 201, 'HTTP ' + shellSource.status);
   const shellId = shellSource.json?.id;
   const shellRun = await request('/api/v1/sources/' + shellId + '/run', {method: 'POST', body: {}});
   const shellTaskId = shellRun.json?.task?.id;
   check('JS-shell source collection queues a task', shellRun.status === 202 && Boolean(shellTaskId), 'HTTP ' + shellRun.status);
   let shellState = null;
   for (let attempt = 0; attempt < 200; attempt += 1) {
    shellState = (await request('/api/v1/tasks/' + shellTaskId)).json;
    if (shellState && shellState.state === 'running') break;
    if (shellState && ['succeeded', 'failed', 'cancelled'].includes(shellState.state)) break;
    await sleep(50);
   }
   check('JS-shell collection reaches the running state', shellState?.state === 'running', shellState?.state ?? 'none');
   if (shellState?.state === 'running') {
    // Cancel while the Playwright fallback is executing: before BUG-3 this
    // could crash the whole API process with an unhandled page.content rejection.
    await sleep(1000);
    const beforeCancel = (await request('/api/v1/tasks/' + shellTaskId)).json?.state;
    const cancelRunning = await request('/api/v1/tasks/' + shellTaskId + '/cancel', {method: 'POST', body: {}});
    check('cancel a running collection returns 200', cancelRunning.status === 200, 'HTTP ' + cancelRunning.status + ' · state before=' + beforeCancel);
    check('running collection accepts the cancellation request',
     beforeCancel === 'running' && (cancelRunning.json?.state === 'cancelled' || cancelRunning.json?.cancelRequested === true || ['cancelled', 'running'].includes(cancelRunning.json?.state)),
     'state=' + String(cancelRunning.json?.state) + ' cancelRequested=' + String(cancelRunning.json?.cancelRequested));
   } else {
    check('cancel a running collection returns 200', false, 'task reached ' + String(shellState?.state) + ' before cancellation');
    check('running collection accepts the cancellation request', false, 'task reached ' + String(shellState?.state) + ' before cancellation');
   }
   const terminal = await pollTask(shellTaskId, task => ['cancelled', 'succeeded', 'failed'].includes(task.state), 20000);
   check('cancelled collection reaches a terminal state', ['cancelled', 'succeeded', 'failed'].includes(terminal?.state), terminal?.state ?? 'none');
   await sleep(1000);
   const healthA = await request('/health');
   const healthB = await request('/health');
   check('API stays alive after cancelling a running collection (health #1)', healthA.status === 200, 'HTTP ' + healthA.status);
   check('API stays alive after cancelling a running collection (health #2)', healthB.status === 200, 'HTTP ' + healthB.status);
   const leftover = (await request('/api/v1/tasks/' + shellTaskId)).json?.state;
   if (leftover === 'queued') await request('/api/v1/tasks/' + shellTaskId + '/cancel', {method: 'POST', body: {}});
   await request('/api/v1/sources/' + shellId, {method: 'DELETE'});
  } finally {
   shellServer.close();
  }

  // ------------------------------------------------------------------- events
  section('Event library API');
  const eventsResponse = await request('/api/v1/events?limit=500');
  equal('GET /api/v1/events returns 200', eventsResponse.status, 200);
  const events = eventsResponse.json?.events ?? [];
  check('event library has records (run discover first)', events.length >= 1, String(events.length) + ' events');
  firstEvent = events[0] ?? null;
  check('event records expose id, name, region, confidence and sources',
   Boolean(firstEvent) && typeof firstEvent.id === 'string' && typeof firstEvent.name === 'string'
   && ['cn', 'eu', 'global'].includes(firstEvent.region)
   && ['low', 'medium', 'high'].includes(firstEvent.confidence)
   && Array.isArray(firstEvent.sources),
   firstEvent?.name ?? 'no event');
  const cnEvents = await request('/api/v1/events?region=cn&limit=500');
  check('region filter returns only cn events',
   (cnEvents.json?.events ?? []).length > 0 && cnEvents.json.events.every(event => event.region === 'cn'),
   String((cnEvents.json?.events ?? []).length) + ' events');
  const statusFilter = await request('/api/v1/events?status=discovered&limit=500');
  check('status filter returns only discovered events',
   (statusFilter.json?.events ?? []).every(event => event.status === 'discovered'),
   String((statusFilter.json?.events ?? []).length) + ' events');
  const firstTerm = String(firstEvent?.city || firstEvent?.name || 'china').split(/\s+/)[0];
  const queryEvents = await request('/api/v1/events?q=' + encodeURIComponent(firstTerm) + '&limit=500');
  check('q filter matches city/name/venue text', (queryEvents.json?.events ?? []).length >= 1, 'q=' + firstTerm + ' → ' + (queryEvents.json?.events ?? []).length);
  const eventDetail = firstEvent ? await request('/api/v1/events/' + firstEvent.id) : {status: 0};
  check('GET /api/v1/events/:id returns the record', eventDetail.status === 200 && eventDetail.json?.id === firstEvent?.id);
  equal('GET missing event returns 404', (await request('/api/v1/events/00000000-0000-4000-8000-000000000000')).status, 404);
  firstEventOriginal = {
   boothPrice: firstEvent?.boothPrice,
   applicationDeadline: firstEvent?.applicationDeadline,
   ticketPrice: firstEvent?.ticketPrice,
  };
  const patched = await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {boothPrice: 'RMB 1,200 / 9 m² (acceptance)'}});
  equal('admin PATCH event returns 200', patched.status, 200);
  check('admin PATCH event changes booth price', patched.json?.boothPrice === 'RMB 1,200 / 9 m² (acceptance)', String(patched.json?.boothPrice));
  const patchedRead = await request('/api/v1/events/' + firstEvent?.id);
  check('event PATCH is persisted', patchedRead.json?.boothPrice === 'RMB 1,200 / 9 m² (acceptance)', String(patchedRead.json?.boothPrice));
  const restored = await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {boothPrice: firstEventOriginal.boothPrice ?? null}});
  equal('event PATCH restore returns 200', restored.status, 200);
  equal('PATCH unknown event field returns 400', (await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {notAField: 1}})).status, 400);
  equal('PATCH invalid event status returns 400', (await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {status: 'bogus'}})).status, 400);
  const csv = await request('/api/v1/events/export?format=csv');
  equal('GET event CSV export returns 200', csv.status, 200);
  check('CSV export has text/csv content type', String(csv.headers.get('content-type') || '').includes('text/csv'), String(csv.headers.get('content-type')));
  const csvLines = csv.text.split('\n').filter(Boolean);
  equal('CSV header keeps the fixed 27-column contract', csvLines[0]?.split(',').length, 27);
  check('CSV header includes the stored geo columns', /(^|,)(province|district)(,|$)/.test(csvLines[0] || ''), String(csvLines[0] || '').slice(0, 200));
  equal('CSV row count equals events + header', csvLines.length, events.length + 1);
  check('CSV export carries attachment filename', String(csv.headers.get('content-disposition') || '').includes('domel-events.csv'), String(csv.headers.get('content-disposition')));
  const jsonExport = await request('/api/v1/events/export?format=json');
  equal('GET event JSON export returns 200', jsonExport.status, 200);
  check('JSON export has application/json content type', String(jsonExport.headers.get('content-type') || '').includes('application/json'), String(jsonExport.headers.get('content-type')));
  check('JSON export includes events and exportedAt', Array.isArray(jsonExport.json?.events) && typeof jsonExport.json?.exportedAt === 'string', String((jsonExport.json?.events ?? []).length) + ' events');

  // ------------------------------------------------------------------ sources
  section('Source registry API (admin)');
  const sourcesResponse = await request('/api/v1/sources');
  equal('GET /api/v1/sources returns 200', sourcesResponse.status, 200);
  sourceList = sourcesResponse.json?.sources ?? [];
  check('source registry is seeded (>= 20 sources)', sourceList.length >= 20, String(sourceList.length));
  check('source stats total matches list', sourcesResponse.json?.stats?.total === sourceList.length, JSON.stringify(sourcesResponse.json?.stats));
  const cnSources = await request('/api/v1/sources?region=cn');
  check('source region filter returns only cn', (cnSources.json?.sources ?? []).length > 0 && cnSources.json.sources.every(source => source.region === 'cn'), String((cnSources.json?.sources ?? []).length));
  const enabledSources = await request('/api/v1/sources?enabled=true');
  check('source enabled filter returns only enabled', (enabledSources.json?.sources ?? []).every(source => source.enabled === true), String((enabledSources.json?.sources ?? []).length));
  const uniqueUrl = 'https://acceptance-' + Date.now() + '.example.com/events';
  createdSource = await request('/api/v1/sources', {
   method: 'POST',
   body: {url: uniqueUrl, title: 'QA acceptance source', type: 'media', region: 'cn', priority: 1, intervalSec: 3600},
  });
  equal('admin POST source returns 201', createdSource.status, 201);
  check('created source has id/domain/url',
   typeof createdSource.json?.id === 'string' && String(createdSource.json?.url) === uniqueUrl && String(createdSource.json?.domain).startsWith('acceptance-') && String(createdSource.json?.domain).endsWith('.example.com'),
   String(createdSource.json?.domain));
  refs.sourceId = createdSource.json?.id;
  const createdId = createdSource.json?.id;
  equal('POST source with interval < 30 returns 400', (await request('/api/v1/sources', {method: 'POST', body: {url: 'https://interval.example.com/', intervalSec: 10}})).status, 400);
  equal('POST source with malformed URL returns 400', (await request('/api/v1/sources', {method: 'POST', body: {url: 'not a url'}})).status, 400);
  equal('POST duplicate source URL returns 400', (await request('/api/v1/sources', {method: 'POST', body: {url: uniqueUrl}})).status, 400);
  const sourceTitlePatch = await request('/api/v1/sources/' + createdId, {method: 'PATCH', body: {title: 'QA acceptance source (renamed)'}});
  equal('admin PATCH source title returns 200', sourceTitlePatch.status, 200);
  equal('source title patch applied', sourceTitlePatch.json?.title, 'QA acceptance source (renamed)');
  const sourceDisable = await request('/api/v1/sources/' + createdId, {method: 'PATCH', body: {enabled: false}});
  equal('admin PATCH source enabled returns 200', sourceDisable.status, 200);
  equal('source enabled patch applied', sourceDisable.json?.enabled, false);
  const sourceRead = await request('/api/v1/sources');
  equal('GET source list reflects the disabled state',
   (sourceRead.json?.sources ?? []).find(source => source.id === createdId)?.enabled, false);
  equal('GET missing source returns 404', (await request('/api/v1/sources/00000000-0000-4000-8000-000000000000')).status, 404);

  // ------------------------------------------------------------------ recipes
  section('Recipe API (admin)');
  const recipesResponse = await request('/api/v1/recipes');
  equal('GET /api/v1/recipes returns 200', recipesResponse.status, 200);
  check('recipe list is an array', Array.isArray(recipesResponse.json?.recipes), String((recipesResponse.json?.recipes ?? []).length) + ' recipes');
  createdRecipe = await request('/api/v1/recipes', {
   method: 'POST',
   body: {
    domain: 'acceptance-recipes.example.com', kind: 'regex',
    body: JSON.stringify({startDate: {pattern: '([0-9]{4}-[0-9]{2}-[0-9]{2})'}}),
    notes: 'QA acceptance recipe',
   },
  });
  equal('admin POST recipe returns 201', createdRecipe.status, 201);
  check('recipe starts as proposed', createdRecipe.json?.status === 'proposed', String(createdRecipe.json?.status));
  refs.recipeId = createdRecipe.json?.id;
  equal('POST recipe with invalid kind returns 400', (await request('/api/v1/recipes', {method: 'POST', body: {domain: 'x.example.com', kind: 'nonsense', body: '{}'}})).status, 400);
  const approve = await request('/api/v1/recipes/' + createdRecipe.json?.id, {method: 'PATCH', body: {status: 'approved'}});
  equal('admin PATCH recipe approved returns 200', approve.status, 200);
  equal('recipe status approved', approve.json?.status, 'approved');
  const approvedList = await request('/api/v1/recipes?status=approved');
  check('recipe status filter lists approved recipe', (approvedList.json?.recipes ?? []).some(recipe => recipe.id === createdRecipe.json?.id));
  const disable = await request('/api/v1/recipes/' + createdRecipe.json?.id, {method: 'PATCH', body: {status: 'disabled'}});
  equal('admin PATCH recipe disabled returns 200', disable.status, 200);
  equal('recipe status disabled', disable.json?.status, 'disabled');
  equal('POST recipe test with invalid URL returns 400', (await request('/api/v1/recipes/' + createdRecipe.json?.id + '/test', {method: 'POST', body: {url: 'not-a-url'}})).status, 400);
  equal('GET missing recipe test target returns 404', (await request('/api/v1/recipes/00000000-0000-4000-8000-000000000000/test', {method: 'POST', body: {url: 'https://example.com/'}})).status, 404);

  // -------------------------------------------------------------- agent config
  section('Agent configuration, MCP, skills, plugins, sessions (admin)');
  const agentConfig = await request('/api/v1/agent/config');
  equal('GET /api/v1/agent/config returns 200', agentConfig.status, 200);
  equal('agent config role is admin', agentConfig.json?.role, 'admin');
  check('agent config exposes cli, mcpServers, ocr, skills, plugins',
   typeof agentConfig.json?.cli === 'object' && Array.isArray(agentConfig.json?.mcpServers) && typeof agentConfig.json?.ocr === 'object' && Array.isArray(agentConfig.json?.skills) && Array.isArray(agentConfig.json?.plugins));
  refs.mcpName = 'qa-acceptance-mcp';
  await request('/api/v1/agent/mcp/' + refs.mcpName, {method: 'DELETE'});
  const addMcp = await request('/api/v1/agent/mcp', {method: 'POST', body: {name: refs.mcpName, transport: 'stdio', command: '/bin/true', args: []}});
  equal('admin POST MCP server returns 201', addMcp.status, 201);
  const rawMcp = await request('/api/v1/agent/mcp/raw');
  check('raw MCP config contains the new server', Boolean(rawMcp.json?.mcpServers?.[refs.mcpName]), JSON.stringify(Object.keys(rawMcp.json?.mcpServers ?? {})));
  const mcpToggle = await request('/api/v1/agent/mcp/' + refs.mcpName, {method: 'PATCH', body: {enabled: false}});
  equal('admin PATCH MCP enabled returns 200', mcpToggle.status, 200);
  equal('MCP enabled patch applied', mcpToggle.json?.enabled, false);
  // The settings UI replaces the whole agent/mcp.json with PUT; the API must
  // parse the PUT body (BUG-4 regression).
  const rawPut = await request('/api/v1/agent/mcp', {method: 'PUT', body: {mcpServers: rawMcp.json?.mcpServers ?? {}}});
  equal('admin PUT raw MCP JSON returns 200', rawPut.status, 200);
  check('raw MCP PUT keeps the server list', Boolean(rawPut.json?.mcpServers?.[refs.mcpName]), JSON.stringify(Object.keys(rawPut.json?.mcpServers ?? {})));
  equal('PUT raw MCP with invalid JSON returns 400', (await request('/api/v1/agent/mcp', {method: 'PUT', body: '{not json'})).status, 400);
  // CLI and system role are T0-only: the web API must refuse them even for admin.
  equal('admin PATCH agent CLI settings returns 403', (await request('/api/v1/agent/settings', {method: 'PATCH', body: {cli: {enabled: false}}})).status, 403);
  equal('admin cannot promote itself to system (403)', (await patchRole('system')).status, 403);
  equal('PATCH invalid role returns 403', (await patchRole('root')).status, 403);
  createdSkill = await request('/api/v1/agent/skills', {method: 'POST', body: {name: 'QA acceptance skill', description: 'Created by the acceptance run', content: 'Answer with evidence.'}});
  equal('admin POST skill returns 201', createdSkill.status, 201);
  refs.skillId = createdSkill.json?.id;
  const configAfterSkill = await request('/api/v1/agent/config');
  check('agent config lists the new skill', (configAfterSkill.json?.skills ?? []).some(skill => skill.id === createdSkill.json?.id));
  const renameSkill = await request('/api/v1/agent/skills/' + createdSkill.json?.id, {method: 'PATCH', body: {name: 'QA acceptance skill (renamed)'}});
  equal('admin PATCH skill name returns 200', renameSkill.status, 200);
  equal('skill rename applied', renameSkill.json?.name, 'QA acceptance skill (renamed)');
  createdPlugin = await request('/api/v1/agent/plugins', {method: 'POST', body: {name: 'QA acceptance plugin', content: 'export default function(){};\n'}});
  equal('admin POST plugin returns 201', createdPlugin.status, 201);
  refs.pluginId = createdPlugin.json?.id;
  const pluginToggle = await request('/api/v1/agent/plugins/' + createdPlugin.json?.id, {method: 'PATCH', body: {enabled: false}});
  equal('admin PATCH plugin enabled returns 200', pluginToggle.status, 200);
  equal('plugin enabled patch applied', pluginToggle.json?.enabled, false);
  const sessions = await request('/api/v1/agent/sessions?projectId=general');
  equal('GET agent sessions returns 200', sessions.status, 200);
  check('seeded agent transcript sessions are listed', (sessions.json?.sessions ?? []).length >= 1, String((sessions.json?.sessions ?? []).length));
  const transcriptId = sessions.json?.sessions?.[0]?.id;
  const transcript = await request('/api/v1/agent/sessions/' + transcriptId);
  equal('GET agent transcript returns 200', transcript.status, 200);
  check('agent transcript has messages', Array.isArray(transcript.json?.messages) && transcript.json.messages.length >= 1, String(transcript.json?.messages?.length));
  equal('GET missing agent transcript returns 404', (await request('/api/v1/agent/sessions/00000000-0000-4000-8000-000000000000')).status, 404);
  equal('POST agent chat with empty message returns 400', (await request('/api/v1/agent/chat', {method: 'POST', body: {message: ''}})).status, 400);

  // -------------------------------------------------------------- role: user
  section('Role matrix — user');
  const toUser = await patchRole('user');
  equal('admin PATCH role user returns 200', toUser.status, 200);
  equal('capabilities report user role', await currentRole(), 'user');
  equal('user can read sources', (await request('/api/v1/sources')).status, 200);
  const userToggleSource = await request('/api/v1/sources/' + sourceList[0]?.id, {method: 'PATCH', body: {enabled: !sourceList[0]?.enabled}});
  equal('user can toggle a source enabled flag', userToggleSource.status, 200);
  await request('/api/v1/sources/' + sourceList[0]?.id, {method: 'PATCH', body: {enabled: sourceList[0]?.enabled}});
  equal('user cannot rename a source (403)', (await request('/api/v1/sources/' + sourceList[0]?.id, {method: 'PATCH', body: {title: 'user rename'}})).status, 403);
  equal('user cannot create a source (403)', (await request('/api/v1/sources', {method: 'POST', body: {url: 'https://user-create.example.com/'}})).status, 403);
  equal('user cannot delete a source (403)', (await request('/api/v1/sources/' + sourceList[0]?.id, {method: 'DELETE'})).status, 403);
  equal('user can read events', (await request('/api/v1/events')).status, 200);
  const userPatchEvent = await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {boothPrice: 'RMB 9,999 (user acceptance)'}});
  equal('user can manually correct an event', userPatchEvent.status, 200);
  await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {boothPrice: firstEventOriginal.boothPrice ?? null}});
  equal('user cannot create a recipe (403)', (await request('/api/v1/recipes', {method: 'POST', body: {domain: 'user.example.com', kind: 'regex', body: '{}'}})).status, 403);
  equal('user cannot change recipe status (403)', (await request('/api/v1/recipes/' + createdRecipe.json?.id, {method: 'PATCH', body: {status: 'approved'}})).status, 403);
  equal('user can toggle a skill (enabled only)', (await request('/api/v1/agent/skills/' + createdSkill.json?.id, {method: 'PATCH', body: {enabled: true}})).status, 200);
  equal('user cannot rename a skill (403)', (await request('/api/v1/agent/skills/' + createdSkill.json?.id, {method: 'PATCH', body: {name: 'user rename'}})).status, 403);
  equal('user can toggle a plugin (enabled only)', (await request('/api/v1/agent/plugins/' + createdPlugin.json?.id, {method: 'PATCH', body: {enabled: true}})).status, 200);
  equal('user cannot read raw MCP JSON (403)', (await request('/api/v1/agent/mcp/raw')).status, 403);
  equal('user cannot assign roles (403)', (await patchRole('viewer')).status, 403);
  equal('user POST agent chat with empty message returns 400', (await request('/api/v1/agent/chat', {method: 'POST', body: {message: ''}})).status, 400);
  const userRun = await request('/api/v1/sources/' + sourceList[1]?.id + '/run', {method: 'POST', body: {}});
  equal('user can run a source (202)', userRun.status, 202);
  if (userRun.json?.task?.id) {
   refs.queueIds.push(userRun.json.task.id);
   const state = (await request('/api/v1/tasks/' + userRun.json.task.id)).json?.state;
   if (state === 'queued') await request('/api/v1/tasks/' + userRun.json.task.id + '/cancel', {method: 'POST', body: {}});
  }

  // ------------------------------------------------------------- role: viewer
  section('Role matrix — viewer');
  if (!(await forceRole('admin')).ok) check('restore admin before viewer phase', false);
  const toViewer = await patchRole('viewer');
  equal('admin PATCH role viewer returns 200', toViewer.status, 200);
  equal('capabilities report viewer role', await currentRole(), 'viewer');
  equal('viewer can read workspace', (await request('/api/v1/workspace')).status, 200);
  equal('viewer can read events', (await request('/api/v1/events')).status, 200);
  equal('viewer can read one event', (await request('/api/v1/events/' + firstEvent?.id)).status, 200);
  equal('viewer cannot PATCH an event (403)', (await request('/api/v1/events/' + firstEvent?.id, {method: 'PATCH', body: {boothPrice: 'viewer'}})).status, 403);
  equal('viewer cannot trigger event discovery (403)', (await request('/api/v1/events/discover', {method: 'POST', body: {region: 'cn'}})).status, 403);
  equal('viewer can read sources', (await request('/api/v1/sources')).status, 200);
  equal('viewer cannot toggle a source (403)', (await request('/api/v1/sources/' + sourceList[0]?.id, {method: 'PATCH', body: {enabled: false}})).status, 403);
  equal('viewer cannot run a source (403)', (await request('/api/v1/sources/' + sourceList[0]?.id + '/run', {method: 'POST', body: {}})).status, 403);
  equal('viewer can read recipes', (await request('/api/v1/recipes')).status, 200);
  equal('viewer cannot change a recipe (403)', (await request('/api/v1/recipes/' + createdRecipe.json?.id, {method: 'PATCH', body: {status: 'disabled'}})).status, 403);
  const viewerConfig = await request('/api/v1/agent/config');
  equal('viewer can read agent config', viewerConfig.status, 200);
  check('viewer agent config omits skill bodies', (viewerConfig.json?.skills ?? []).every(skill => skill.content === undefined), JSON.stringify((viewerConfig.json?.skills ?? []).map(skill => skill.name)));
  equal('viewer cannot read raw MCP JSON (403)', (await request('/api/v1/agent/mcp/raw')).status, 403);
  equal('viewer cannot replace raw MCP JSON (403)', (await request('/api/v1/agent/mcp', {method: 'PUT', body: {mcpServers: {}}})).status, 403);
  equal('viewer can read agent sessions', (await request('/api/v1/agent/sessions?projectId=general')).status, 200);
  equal('viewer cannot start agent chat (403)', (await request('/api/v1/agent/chat', {method: 'POST', body: {message: 'hello'}})).status, 403);
  const viewerCancel = await request('/api/v1/tasks/' + taskB?.id + '/cancel', {method: 'POST', body: {}});
  equal('viewer cannot cancel a task (403)', viewerCancel.status, 403);
  equal('viewer cannot retry a task (403)', (await request('/api/v1/tasks/' + taskB?.id + '/retry', {method: 'POST', body: {}})).status, 403);
  equal('viewer cannot create research (403)', (await request('/api/v1/research-tasks', {method: 'POST', body: {title: 'viewer'}})).status, 403);
  equal('viewer cannot review findings (403)', (await request('/api/v1/insights/00000000-0000-4000-8000-000000000000/review', {method: 'PATCH', body: {text: 'x', decision: 'accepted', revision: 1}})).status, 403);
  equal('viewer cannot generate reports (403)', (await request('/api/v1/reports', {method: 'POST', body: {project_id: '00000000-0000-4000-8000-000000000000'}})).status, 403);
  equal('viewer can download the event CSV', (await request('/api/v1/events/export?format=csv')).status, 200);

  // ------------------------------------------------------------------ restore
  section('Restore admin and clean up');
  check('admin role restored at the end of the run', (await forceRole('admin')).ok);
  equal('capabilities report admin after restore', await currentRole(), 'admin');
 } catch (error) {
  check('acceptance run completed without an unexpected error', false, error instanceof Error ? error.message : String(error));
 } finally {
  try {
   await cleanupCreated(refs);
  } catch (error) {
   check('cleanup phase completed', false, error instanceof Error ? error.message : String(error));
  }
 }

 console.log('\nResult: ' + pass + ' passed, ' + fail + ' failed');
 if (fail) {
  console.log('\nFailures:');
  for (const failure of failures) console.log('- ' + failure);
 }
 return fail ? 1 : 0;
}

const args = process.argv.slice(2);
if (args.includes('--prepare')) {
 process.exitCode = await prepare({fixtures: args.includes('--fixtures')});
} else {
 process.exitCode = await run();
}
