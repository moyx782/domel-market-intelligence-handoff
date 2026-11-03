import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {fakeQueue, fakeRegistry, fakeTasks} from './fixtures/api-fakes.mjs';

const scope = {title: 'HVAC motors', question: 'Who ships?', segment: 'HVAC', market: 'China', quarter: '2026-Q3', competitors: ['Nidec'], focus: ['EC motors'], source_urls: []};
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

async function listen({role = 'admin', env = {}, parts = {}} = {}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-task-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-data'));
 if (role !== 'admin') agentStore.setSettings({role});
 const tasks = fakeTasks(parts);
 const server = localApiServer({store, agentStore, tasks, env});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {
  root, store, agentStore, tasks, server, url,
  async close() {
   await new Promise(resolve => server.close(resolve));
   rmSync(root, {recursive: true, force: true});
  },
 };
}

const json = (url, init) => fetch(url, {...init, headers: {'Content-Type': 'application/json', ...(init?.headers ?? {})}});

test('running research schedules a durable task instead of the inline drain', async () => {
 const ctx = await listen({env: {DEEPSEEK_API_KEY: 'test-key'}});
 try {
  const created = await (await json(ctx.url + '/api/v1/research-tasks', {method: 'POST', body: JSON.stringify(scope)})).json();
  const response = await json(ctx.url + '/api/v1/research-tasks/' + created.id + '/run', {method: 'POST', body: JSON.stringify({mode: 'collect'})});
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.ok(job.taskId, 'the API reports the queue task id');
  assert.equal(job.taskState, 'queued');
  assert.equal(ctx.tasks.queue.created.length, 1);
  assert.equal(ctx.tasks.queue.created[0].kind, 'project.research');
  assert.equal(ctx.tasks.queue.created[0].projectId, created.id);
  assert.equal(ctx.tasks.queue.created[0].payload.mode, 'collect');
  const jobs = await (await fetch(ctx.url + '/api/v1/research-jobs')).json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, 'queued');
 } finally {
  await ctx.close();
 }
});

test('without a queue the legacy inline research path stays available', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-task-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const server = localApiServer({store, env: {DEEPSEEK_API_KEY: 'test-key'}});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 try {
  const created = await (await json(url + '/api/v1/research-tasks', {method: 'POST', body: JSON.stringify(scope)})).json();
  const response = await json(url + '/api/v1/research-tasks/' + created.id + '/run', {method: 'POST', body: JSON.stringify({mode: 'collect'})});
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.taskId, undefined);
  assert.equal(job.state, 'queued');
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('task endpoints list, inspect, cancel, retry and report missing tasks', async () => {
 const registry = fakeRegistry([{id: SOURCE_ID, url: 'https://expo.example/calendar', title: 'Expo calendar', type: 'organizer', region: 'cn'}]);
 const ctx = await listen({parts: {registry, queue: fakeQueue()}});
 try {
  const run = await json(ctx.url + '/api/v1/sources/' + SOURCE_ID + '/run', {method: 'POST', body: '{}'});
  assert.equal(run.status, 202);
  const {task} = await run.json();
  assert.equal(task.kind, 'source.collect');

  const list = await (await fetch(ctx.url + '/api/v1/tasks')).json();
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].id, task.id);
  assert.equal(list.stats.queued, 1);

  const filtered = await (await fetch(ctx.url + '/api/v1/tasks?state=cancelled')).json();
  assert.equal(filtered.tasks.length, 0);

  const single = await (await fetch(ctx.url + '/api/v1/tasks/' + task.id)).json();
  assert.equal(single.id, task.id);

  const missing = await fetch(ctx.url + '/api/v1/tasks/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);

  const cancel = await json(ctx.url + '/api/v1/tasks/' + task.id + '/cancel', {method: 'POST', body: '{}'});
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).state, 'cancelled');

  const retry = await json(ctx.url + '/api/v1/tasks/' + task.id + '/retry', {method: 'POST', body: '{}'});
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).state, 'queued');

  const unknownAction = await json(ctx.url + '/api/v1/tasks/00000000-0000-4000-8000-000000000000/cancel', {method: 'POST', body: '{}'});
  assert.equal(unknownAction.status, 404);
 } finally {
  await ctx.close();
 }
});

test('task stream sends a snapshot then task events', async () => {
 const ctx = await listen();
 const controller = new AbortController();
 try {
  const response = await fetch(ctx.url + '/api/v1/tasks/stream', {signal: controller.signal});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^data: /);
  const snapshot = JSON.parse(first.replace(/^data: /, '').trim());
  assert.equal(snapshot.type, 'snapshot');
  assert.ok(Array.isArray(snapshot.tasks));
  controller.abort();
  await reader.cancel().catch(() => {});
 } finally {
  controller.abort();
  await ctx.close();
 }
});

test('viewers can read tasks but only user+ can mutate them', async () => {
 const registry = fakeRegistry([{id: SOURCE_ID, url: 'https://expo.example/calendar', title: 'Expo calendar', type: 'organizer', region: 'cn'}]);
 const viewer = await listen({role: 'viewer', parts: {registry}});
 try {
  const list = await fetch(viewer.url + '/api/v1/tasks');
  assert.equal(list.status, 200);
  const created = await viewer.tasks.queue.create({kind: 'source.collect', sourceId: SOURCE_ID, payload: {}});
  const denied = await json(viewer.url + '/api/v1/tasks/' + created.id + '/cancel', {method: 'POST', body: '{}'});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).requiredRole, 'user');
  const run = await json(viewer.url + '/api/v1/sources/' + SOURCE_ID + '/run', {method: 'POST', body: '{}'});
  assert.equal(run.status, 403);
 } finally {
  await viewer.close();
 }

 const user = await listen({role: 'user', parts: {registry}});
 try {
  const created = await user.tasks.queue.create({kind: 'source.collect', sourceId: SOURCE_ID, payload: {}});
  const cancel = await json(user.url + '/api/v1/tasks/' + created.id + '/cancel', {method: 'POST', body: '{}'});
  assert.equal(cancel.status, 200);
  const denied = await json(user.url + '/api/v1/tasks/00000000-0000-4000-8000-000000000000/retry', {method: 'POST', body: '{}'});
  assert.equal(denied.status, 404);
 } finally {
  await user.close();
 }
});
