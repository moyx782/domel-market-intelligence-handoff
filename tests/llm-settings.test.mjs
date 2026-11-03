// AI model settings: the DeepSeek key/model/base URL can be configured from the
// settings UI (write-only, server-side) and a custom base URL switches the
// assistant/agent/extraction to a locally deployed OpenAI-compatible model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentStore} from '../server/agent-config.mjs';
import {openLocalStore} from '../server/local-store.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {createDeepSeekEventSearch} from '../server/event-search.mjs';
import {openDeepSeekModel, isDeepSeekBaseUrl} from '../server/assistant.mjs';

function temp() {
 return mkdtempSync(join(tmpdir(), 'domel-llm-'));
}

test('agent config stores the AI model settings and never exposes the key', () => {
 const root = temp();
 try {
  const store = openAgentStore(join(root, 'agent'));
  assert.deepEqual(store.publicConfig().llm, {model: '', baseUrl: '', tokenSet: false});
  store.setSettings({llm: {apiKey: 'sk-ui-secret', model: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1/'}});
  const publicConfig = store.publicConfig();
  assert.equal(publicConfig.llm.model, 'qwen2.5');
  assert.equal(publicConfig.llm.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(publicConfig.llm.tokenSet, true);
  assert.ok(!JSON.stringify(publicConfig).includes('sk-ui-secret'));
  // Persisted masked state survives reopening.
  const reopened = openAgentStore(join(root, 'agent'));
  assert.equal(reopened.llm().apiKey, 'sk-ui-secret');
  assert.equal(reopened.publicConfig().llm.tokenSet, true);
  const raw = JSON.parse(readFileSync(reopened.configFile, 'utf8'));
  assert.equal(raw.llm.apiKey, 'sk-ui-secret');
  assert.throws(() => store.setSettings({llm: {baseUrl: 'ftp://example.com'}}), /http or https/);
  assert.throws(() => store.setSettings({llm: {model: 'x'.repeat(200)}}), /too long/);
  assert.throws(() => store.setSettings({llm: {apiKey: 'x'.repeat(3000)}}), /too long/);
  store.setSettings({llm: {apiKey: ''}});
  assert.equal(store.publicConfig().llm.tokenSet, false);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

async function listen({env = {}, role = 'admin'} = {}) {
 const root = temp();
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent'));
 if (role !== 'admin') agentStore.setSettings({role});
 const server = localApiServer({store, agentStore, env});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {
  root, agentStore, server, url,
  async close() {
   await new Promise(resolve => server.close(resolve));
   rmSync(root, {recursive: true, force: true});
  },
 };
}

const json = (url, init) => fetch(url, {...init, headers: {'Content-Type': 'application/json', ...(init?.headers ?? {})}});

test('admins can set the AI model from the settings API; viewers cannot', async () => {
 const ctx = await listen({env: {}});
 try {
  const initial = await (await fetch(ctx.url + '/api/v1/agent/config')).json();
  assert.equal(initial.llm.envKeySet, false);
  assert.equal(initial.llm.keySet, false);

  const saved = await json(ctx.url + '/api/v1/agent/settings', {
   method: 'PATCH',
   body: JSON.stringify({llm: {apiKey: 'sk-ui-secret', model: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1'}}),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.llm.keySet, true);
  assert.equal(savedBody.llm.provider, 'custom');
  assert.ok(!JSON.stringify(savedBody).includes('sk-ui-secret'));

  const config = await (await fetch(ctx.url + '/api/v1/agent/config')).json();
  assert.equal(config.llm.model, 'qwen2.5');
  assert.equal(config.llm.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(config.llm.provider, 'custom');
  assert.equal(config.llm.effectiveConfigured, true);
  assert.ok(!JSON.stringify(config).includes('sk-ui-secret'));

  const capabilities = await (await fetch(ctx.url + '/api/v1/capabilities')).json();
  assert.equal(capabilities.ai, true);
  assert.equal(capabilities.search, false, 'DeepSeek search tools are not available for a custom model');
  assert.deepEqual(capabilities.llm, {provider: 'custom', model: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1', keySet: true});

  assert.equal((await json(ctx.url + '/api/v1/agent/settings', {method: 'PATCH', body: JSON.stringify({llm: {baseUrl: 'not a url'}})})).status, 409);
 } finally {
  await ctx.close();
 }

 const viewer = await listen({role: 'viewer'});
 try {
  const denied = await json(viewer.url + '/api/v1/agent/settings', {method: 'PATCH', body: JSON.stringify({llm: {apiKey: 'sk-blocked'}})});
  assert.equal(denied.status, 403);
  const config = await (await fetch(viewer.url + '/api/v1/agent/config')).json();
  assert.equal(config.llm.tokenSet, false);
 } finally {
  await viewer.close();
 }
});

test('the environment key still works and is reported as configured', async () => {
 const ctx = await listen({env: {DEEPSEEK_API_KEY: 'sk-env-key', DEEPSEEK_MODEL: 'deepseek-flash'}});
 try {
  const config = await (await fetch(ctx.url + '/api/v1/agent/config')).json();
  assert.equal(config.llm.tokenSet, false, 'no key stored through the UI');
  assert.equal(config.llm.envKeySet, true);
  assert.equal(config.llm.effectiveConfigured, true);
  assert.equal(config.llm.provider, 'deepseek');
  const capabilities = await (await fetch(ctx.url + '/api/v1/capabilities')).json();
  assert.equal(capabilities.ai, true);
  assert.equal(capabilities.search, true);
  assert.equal(capabilities.llm.provider, 'deepseek');
 } finally {
  await ctx.close();
 }
});

test('search adapters resolve the key at call time so a UI-saved key takes effect', async () => {
 let currentKey = '';
 const calls = [];
 const fetchImpl = async (url, init) => {
  calls.push({url, auth: init.headers.Authorization, body: JSON.parse(init.body)});
  return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({events: [{name: 'Test Expo'}]})}}]}), {status: 200, headers: {'Content-Type': 'application/json'}});
 };
 const search = createDeepSeekEventSearch({getApiKey: () => currentKey, getModel: () => 'qwen2.5', fetchImpl});
 await assert.rejects(search.search({query: 'x'}), /DEEPSEEK_API_KEY/);
 currentKey = 'sk-new-ui-key';
 const events = await search.search({query: '中国 展会', limit: 5});
 assert.equal(events.length, 1);
 assert.equal(calls[0].auth, 'Bearer sk-new-ui-key');
 assert.equal(calls[0].body.model, 'qwen2.5');
});

test('a custom base URL builds an OpenAI-compatible model; DeepSeek URLs stay native', async () => {
 assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com'), true);
 assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com/v1'), true);
 assert.equal(isDeepSeekBaseUrl('http://127.0.0.1:11434/v1'), false);
 assert.equal(isDeepSeekBaseUrl('https://ai.corp.example/v1'), false);

 const root = temp();
 try {
  const custom = await openDeepSeekModel({
   apiKey: 'local-key', modelId: 'qwen2.5', authDir: join(root, 'custom'),
   baseUrl: 'http://127.0.0.1:11434/v1',
  });
  assert.equal(custom.custom, true);
  assert.equal(custom.model.provider, 'custom');
  assert.equal(custom.model.id, 'qwen2.5');
  assert.equal(custom.model.baseUrl, 'http://127.0.0.1:11434/v1');

  const native = await openDeepSeekModel({
   apiKey: 'sk-env', modelId: 'deepseek-flash', authDir: join(root, 'native'),
   baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(native.custom, false);
  assert.equal(native.model.provider, 'deepseek');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
