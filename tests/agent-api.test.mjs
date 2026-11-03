import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';

async function listen(options) {
 const server = localApiServer(options);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return {server, url: 'http://127.0.0.1:' + server.address().port};
}

test('agent settings honour admin and viewer permissions', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 const {server, url} = await listen({store, agentStore, env: {}});
 const json = (path, method = 'GET', body) => fetch(url + path, {
  method,
  headers: {'Content-Type': 'application/json'},
  ...(body ? {body: JSON.stringify(body)} : {}),
 });
 try {
  const config = await json('/api/v1/agent/config');
  assert.equal((await config.json()).role, 'admin');

  const mcp = await json('/api/v1/agent/mcp', 'POST', {name: 'qichacha', transport: 'stdio', command: 'npx', args: ['-y', 'qcc']});
  assert.equal(mcp.status, 201);
  const serverName = (await mcp.json()).name;
  const skill = await json('/api/v1/agent/skills', 'POST', {name: '展会检索', description: 'shows', content: 'List upcoming shows.'});
  assert.equal(skill.status, 201);
  const skillId = (await skill.json()).id;

  assert.equal((await json('/api/v1/agent/settings', 'PATCH', {role: 'viewer'})).status, 200);
  assert.equal((await json('/api/v1/agent/mcp', 'POST', {name: 'blocked', transport: 'stdio', command: 'x'})).status, 403);
  assert.equal((await json('/api/v1/agent/skills', 'POST', {name: 'blocked', content: 'x'})).status, 403);
  assert.equal((await json('/api/v1/agent/mcp/' + encodeURIComponent(serverName), 'PATCH', {enabled: false})).status, 403);
  assert.equal((await json('/api/v1/agent/mcp/' + encodeURIComponent(serverName), 'PATCH', {name: 'renamed'})).status, 403);
  assert.equal((await json('/api/v1/agent/skills/' + skillId, 'DELETE')).status, 403);
  assert.equal((await json('/api/v1/agent/settings', 'PATCH', {ocr: {provider: 'official', token: 'api-secret'}})).status, 403);

  agentStore.setSettings({role: 'user'});
  assert.equal((await json('/api/v1/agent/mcp/' + encodeURIComponent(serverName), 'PATCH', {enabled: false})).status, 200);
  assert.equal((await json('/api/v1/agent/mcp', 'POST', {name: 'blocked', transport: 'stdio', command: 'x'})).status, 403);
  assert.equal((await json('/api/v1/agent/settings', 'PATCH', {ocr: {provider: 'official', token: 'api-secret'}})).status, 403);
  assert.equal((await json('/api/v1/agent/settings', 'PATCH', {role: 'admin'})).status, 403);
  const viewer = await (await json('/api/v1/agent/config')).json();
  assert.equal(viewer.role, 'user');
  assert.equal(viewer.mcpServers[0].enabled, false);

  agentStore.setSettings({role: 'admin'});
  assert.equal((await json('/api/v1/agent/settings', 'PATCH', {ocr: {provider: 'official', token: 'api-secret'}})).status, 200);
  const withToken = await (await json('/api/v1/agent/config')).json();
  assert.equal(withToken.ocr.tokenSet, true);
  assert.ok(!JSON.stringify(withToken).includes('api-secret'));
  assert.equal((await json('/api/v1/agent/skills/' + skillId, 'PATCH', {content: 'Updated.'})).status, 200);
  const admin = await (await json('/api/v1/agent/config')).json();
  assert.match(admin.skills[0].content, /Updated/);
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('agent chat streams events and refuses to run without a model', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 const agentRuntime = async ({onEvent}) => {
  onEvent({type: 'tool_start', tool: 'mcp__mock__echo', args: '{"text":"hi"}'});
  onEvent({type: 'tool_end', tool: 'mcp__mock__echo', ok: true});
  onEvent({type: 'delta', text: 'hello'});
  onEvent({type: 'done', text: 'hello', workspace: '/tmp/workspace'});
 };
 const configured = await listen({store, agentStore, agentRuntime, env: {}});
 const missing = await listen({store, agentStore, env: {}});
 try {
  const response = await fetch(configured.url + '/api/v1/agent/chat', {
   method: 'POST', headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({projectId: 'general', message: 'Check MCP'}),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n\n').map(chunk => JSON.parse(chunk.replace(/^data: /, '')));
  assert.deepEqual(events.map(event => event.type), ['tool_start', 'tool_end', 'delta', 'done']);

  const refused = await fetch(missing.url + '/api/v1/agent/chat', {
   method: 'POST', headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({projectId: 'general', message: 'hi'}),
  });
  assert.equal(refused.status, 503);
 } finally {
  await new Promise(resolve => configured.server.close(resolve));
  await new Promise(resolve => missing.server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('admin can probe an MCP server and list its tools', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 agentStore.replaceMcpConfig({
  mcpServers: {
   mock: {
    command: process.execPath,
    args: [join(import.meta.dirname, 'fixtures', 'mcp-echo-server.mjs')],
    exposure: 'direct',
   },
  },
 });
 const {server, url} = await listen({store, agentStore, env: {}});
 try {
  const response = await fetch(url + '/api/v1/agent/mcp/test', {
   method: 'POST',
   headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({name: 'mock'}),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(result.tools.some(tool => tool.name === 'echo'));
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('admin can switch between web roles but cannot grant system', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 const {server, url} = await listen({store, agentStore, env: {}});
 const settings = (body) => fetch(url + '/api/v1/agent/settings', {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
 try {
  assert.equal((await settings({role: 'system'})).status, 403);
  assert.equal((await settings({role: 'user'})).status, 200);
  assert.equal(agentStore.config().role, 'user');
  assert.equal((await settings({role: 'admin'})).status, 403);
  agentStore.setSettings({role: 'admin'});
  assert.equal((await settings({role: 'viewer'})).status, 200);
  assert.equal(agentStore.config().role, 'viewer');
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});

test('replacing the raw MCP config needs a parsed PUT body and the admin role', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-root'));
 const {server, url} = await listen({store, agentStore, env: {}});
 const json = (path, method = 'GET', body) => fetch(url + path, {
  method,
  headers: {'Content-Type': 'application/json'},
  ...(body ? {body: JSON.stringify(body)} : {}),
 });
 try {
  const replaced = await json('/api/v1/agent/mcp', 'PUT', {mcpServers: {mock: {command: '/usr/bin/node', args: ['server.js']}}});
  assert.equal(replaced.status, 200);
  const payload = await replaced.json();
  assert.ok(payload.mcpServers.mock);
  assert.equal(payload.mcpServers.mock.command, '/usr/bin/node');

  const invalidJson = await fetch(url + '/api/v1/agent/mcp', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{oops'});
  assert.equal(invalidJson.status, 400);

  const invalidShape = await json('/api/v1/agent/mcp', 'PUT', {});
  assert.equal(invalidShape.status, 409);
  assert.match((await invalidShape.json()).error, /Operation failed/);

  agentStore.setSettings({role: 'viewer'});
  assert.equal((await json('/api/v1/agent/mcp', 'PUT', {mcpServers: {}})).status, 403);
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});
