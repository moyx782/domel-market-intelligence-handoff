import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {openAgentStore} from '../server/agent-config.mjs';

async function listen(env) {
 const root = mkdtempSync(join(tmpdir(), 'domel-ocr-'));
 const server = localApiServer({store: openLocalStore(join(root, 'data.json')), env});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return {root, server, url: 'http://127.0.0.1:' + server.address().port};
}

test('OCR status exposes provider configuration without the token', async () => {
 const off = await listen({});
 const on = await listen({MINERU_PROVIDER: 'official', MINERU_API_TOKEN: 'very-secret'});
 try {
  const disabled = await (await fetch(off.url + '/api/v1/ocr/status')).json();
  assert.equal(disabled.provider, 'none');
  assert.equal(disabled.configured, false);
  assert.equal(disabled.policy, 'ocr-then-agent');

  const response = await fetch(on.url + '/api/v1/ocr/status');
  const enabled = await response.json();
  assert.equal(enabled.provider, 'official');
  assert.equal(enabled.configured, true);
  assert.equal(enabled.baseUrl, 'https://mineru.net/api/v4');
  assert.ok(!JSON.stringify(enabled).includes('very-secret'));

  const capabilities = await (await fetch(on.url + '/api/v1/capabilities')).json();
  assert.equal(capabilities.ocr.provider, 'official');
 } finally {
  await new Promise(resolve => off.server.close(resolve));
  await new Promise(resolve => on.server.close(resolve));
  rmSync(off.root, {recursive: true, force: true});
  rmSync(on.root, {recursive: true, force: true});
 }
});

test('OCR status follows the admin-configured base URL', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-ocr-'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 agentStore.setSettings({ocr: {provider: 'local', localUrl: 'http://10.0.0.5:9000/mineru'}});
 const server = localApiServer({store: openLocalStore(join(root, 'data.json')), agentStore, env: {}});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const status = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/ocr/status')).json();
  assert.equal(status.provider, 'local');
  assert.equal(status.baseUrl, 'http://10.0.0.5:9000/mineru');
  assert.equal(status.configured, true);
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('admin sets the MinerU token through settings and it is never returned', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-ocr-'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 agentStore.setSettings({ocr: {provider: 'official', token: 'mineru-secret-token'}});
 const server = localApiServer({store: openLocalStore(join(root, 'data.json')), agentStore, env: {}});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const url = 'http://127.0.0.1:' + server.address().port;
  const status = await (await fetch(url + '/api/v1/ocr/status')).json();
  assert.equal(status.provider, 'official');
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes('mineru-secret-token'));
  const config = await (await fetch(url + '/api/v1/agent/config')).json();
  assert.equal(config.ocr.tokenSet, true);
  assert.ok(!JSON.stringify(config).includes('mineru-secret-token'));
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});
