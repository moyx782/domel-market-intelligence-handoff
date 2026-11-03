import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {fakeRegistry, fakeTasks} from './fixtures/api-fakes.mjs';

const SOURCE_A = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = '22222222-2222-4222-8222-222222222222';

function registry() {
 return fakeRegistry([
  {id: SOURCE_A, url: 'https://www.cr-expo.com', title: '中国制冷展', type: 'organizer', region: 'cn', priority: 2, intervalSec: 86400},
  {id: SOURCE_B, url: 'https://www.chinahvacr.com', title: '产业在线', type: 'media', region: 'cn', enabled: false},
 ]);
}

async function listen({role = 'admin', parts = {}} = {}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-sources-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-data'));
 if (role !== 'admin') agentStore.setSettings({role});
 const tasks = fakeTasks({registry: registry(), ...parts});
 const server = localApiServer({store, agentStore, tasks, env: {}});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {
  tasks, server, url,
  async close() {
   await new Promise(resolve => server.close(resolve));
   rmSync(root, {recursive: true, force: true});
  },
 };
}

const json = (url, init) => fetch(url, {...init, headers: {'Content-Type': 'application/json', ...(init?.headers ?? {})}});

test('source registry lists and filters sources with stats', async () => {
 const ctx = await listen();
 try {
  const payload = await (await fetch(ctx.url + '/api/v1/sources')).json();
  assert.equal(payload.sources.length, 2);
  assert.equal(payload.stats.total, 2);
  const enabled = await (await fetch(ctx.url + '/api/v1/sources?enabled=true')).json();
  assert.equal(enabled.sources.length, 1);
  assert.equal(enabled.sources[0].id, SOURCE_A);
  const media = await (await fetch(ctx.url + '/api/v1/sources?type=media')).json();
  assert.equal(media.sources.length, 1);
 } finally {
  await ctx.close();
 }
});

test('admins create, edit and delete sources; invalid input is rejected', async () => {
 const ctx = await listen();
 try {
  const created = await json(ctx.url + '/api/v1/sources', {method: 'POST', body: JSON.stringify({url: 'https://www.expocentral.cn/calendar', title: 'Expo Central', type: 'media', region: 'cn', priority: 1, intervalSec: 600})});
  assert.equal(created.status, 201);
  const source = await created.json();
  assert.equal(source.title, 'Expo Central');
  assert.equal(source.domain, 'www.expocentral.cn');

  const invalid = await json(ctx.url + '/api/v1/sources', {method: 'POST', body: JSON.stringify({url: 'ftp://broken.example'})});
  assert.equal(invalid.status, 400);

  const patched = await json(ctx.url + '/api/v1/sources/' + SOURCE_A, {method: 'PATCH', body: JSON.stringify({priority: 3, intervalSec: 43200})});
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).priority, 3);

  const missing = await json(ctx.url + '/api/v1/sources/' + '00000000-0000-4000-8000-000000000000', {method: 'PATCH', body: JSON.stringify({priority: 1})});
  assert.equal(missing.status, 404);

  const removed = await fetch(ctx.url + '/api/v1/sources/' + SOURCE_B, {method: 'DELETE'});
  assert.equal(removed.status, 200);
  assert.equal((await (await fetch(ctx.url + '/api/v1/sources')).json()).sources.length, 2);
 } finally {
  await ctx.close();
 }
});

test('users can only toggle sources; viewers are read-only', async () => {
 const user = await listen({role: 'user'});
 try {
  const toggle = await json(user.url + '/api/v1/sources/' + SOURCE_B, {method: 'PATCH', body: JSON.stringify({enabled: true})});
  assert.equal(toggle.status, 200);
  assert.equal((await toggle.json()).enabled, true);
  const fullPatch = await json(user.url + '/api/v1/sources/' + SOURCE_A, {method: 'PATCH', body: JSON.stringify({priority: 3})});
  assert.equal(fullPatch.status, 403);
  const create = await json(user.url + '/api/v1/sources', {method: 'POST', body: JSON.stringify({url: 'https://blocked.example'})});
  assert.equal(create.status, 403);
  const remove = await fetch(user.url + '/api/v1/sources/' + SOURCE_A, {method: 'DELETE'});
  assert.equal(remove.status, 403);
 } finally {
  await user.close();
 }

 const viewer = await listen({role: 'viewer'});
 try {
  assert.equal((await fetch(viewer.url + '/api/v1/sources')).status, 200);
  const toggle = await json(viewer.url + '/api/v1/sources/' + SOURCE_B, {method: 'PATCH', body: JSON.stringify({enabled: true})});
  assert.equal(toggle.status, 403);
  assert.equal((await toggle.json()).requiredRole, 'user');
  const run = await json(viewer.url + '/api/v1/sources/' + SOURCE_A + '/run', {method: 'POST', body: '{}'});
  assert.equal(run.status, 403);
 } finally {
  await viewer.close();
 }
});

test('running a source creates a collection task and blocks unknown sources', async () => {
 const ctx = await listen();
 try {
  const run = await json(ctx.url + '/api/v1/sources/' + SOURCE_A + '/run', {method: 'POST', body: '{}'});
  assert.equal(run.status, 202);
  const {task} = await run.json();
  assert.equal(task.kind, 'source.collect');
  assert.equal(task.sourceId, SOURCE_A);
  assert.equal(ctx.tasks.queue.created.length, 1);

  const missing = await json(ctx.url + '/api/v1/sources/' + '00000000-0000-4000-8000-000000000000/run', {method: 'POST', body: '{}'});
  assert.equal(missing.status, 404);
 } finally {
  await ctx.close();
 }
});
