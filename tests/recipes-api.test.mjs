import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {fakeRecipes, fakeTasks} from './fixtures/api-fakes.mjs';

const RECIPE_A = '33333333-3333-4333-8333-333333333333';

async function listen({role = 'admin', parts = {}} = {}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-recipes-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-data'));
 if (role !== 'admin') agentStore.setSettings({role});
 const tasks = fakeTasks({
  recipes: fakeRecipes([{id: RECIPE_A, domain: 'expocentral.cn', kind: 'script', body: '(input) => ({startDate: "2026-04-08"})', status: 'proposed'}]),
  ...parts,
 });
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

test('recipes list supports filters and admin approval flow', async () => {
 const ctx = await listen();
 try {
  const list = await (await fetch(ctx.url + '/api/v1/recipes')).json();
  assert.equal(list.recipes.length, 1);
  assert.equal(list.recipes[0].status, 'proposed');
  const filtered = await (await fetch(ctx.url + '/api/v1/recipes?status=approved')).json();
  assert.equal(filtered.recipes.length, 0);

  const approve = await json(ctx.url + '/api/v1/recipes/' + RECIPE_A, {method: 'PATCH', body: JSON.stringify({status: 'approved'})});
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).status, 'approved');

  const invalid = await json(ctx.url + '/api/v1/recipes/' + RECIPE_A, {method: 'PATCH', body: JSON.stringify({status: 'bogus'})});
  assert.equal(invalid.status, 400);

  const create = await json(ctx.url + '/api/v1/recipes', {method: 'POST', body: JSON.stringify({domain: 'expo.example', kind: 'regex', body: '{"startDate":{"pattern":"(\\\\d{4}-\\\\d{2}-\\\\d{2})"}}'})});
  assert.equal(create.status, 201);
  assert.equal((await create.json()).status, 'proposed');

  const remove = await fetch(ctx.url + '/api/v1/recipes/' + RECIPE_A, {method: 'DELETE'});
  assert.equal(remove.status, 200);
  assert.equal((await (await fetch(ctx.url + '/api/v1/recipes')).json()).recipes.length, 1);
 } finally {
  await ctx.close();
 }
});

test('users and viewers cannot manage recipes', async () => {
 const user = await listen({role: 'user'});
 try {
  assert.equal((await fetch(user.url + '/api/v1/recipes')).status, 200);
  const create = await json(user.url + '/api/v1/recipes', {method: 'POST', body: JSON.stringify({domain: 'x.example', kind: 'regex', body: '{}'})});
  assert.equal(create.status, 403);
  const approve = await json(user.url + '/api/v1/recipes/' + RECIPE_A, {method: 'PATCH', body: JSON.stringify({status: 'approved'})});
  assert.equal(approve.status, 403);
 } finally {
  await user.close();
 }
});

test('recipe testing applies a recipe to a fetched page', async () => {
 const ctx = await listen({
  parts: {
   collector: {collect: async url => {
    assert.equal(url, 'https://expocentral.cn/calendar');
    return {ok: true, html: '<html><body>2026-04-08</body></html>', text: '2026-04-08', title: 'Calendar', engine: 'http', bytes: 10, fetchedAt: new Date().toISOString()};
   }},
   applyRecipe: async () => ({ok: true, values: {startDate: '2026-04-08'}}),
  },
 });
 try {
  const test = await json(ctx.url + '/api/v1/recipes/' + RECIPE_A + '/test', {method: 'POST', body: JSON.stringify({url: 'https://expocentral.cn/calendar'})});
  assert.equal(test.status, 200);
  const payload = await test.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.values.startDate, '2026-04-08');

  const invalid = await json(ctx.url + '/api/v1/recipes/' + RECIPE_A + '/test', {method: 'POST', body: JSON.stringify({url: 'not-a-url'})});
  assert.equal(invalid.status, 400);

  const missing = await json(ctx.url + '/api/v1/recipes/' + '00000000-0000-4000-8000-000000000000/test', {method: 'POST', body: JSON.stringify({url: 'https://expocentral.cn/calendar'})});
  assert.equal(missing.status, 404);
 } finally {
  await ctx.close();
 }
});
