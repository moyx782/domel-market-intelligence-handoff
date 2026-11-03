import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentStore} from '../server/agent-config.mjs';

test('agent store writes mcp.json and skill directories', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-config-'));
 try {
  const store = openAgentStore(root);
  assert.equal(store.config().role, 'admin');
  const server = store.addMcp({
   name: 'qichacha', transport: 'http', url: 'https://mcp.example.com/qcc',
   headers: 'Authorization=Bearer test-token',
  });
  const mcp = JSON.parse(readFileSync(join(root, 'agent', 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.qichacha.url, 'https://mcp.example.com/qcc');
  assert.equal(mcp.mcpServers.qichacha.exposure, 'direct');
  assert.equal(mcp.mcpServers.qichacha.headers.Authorization, 'Bearer test-token');

  store.updateMcp(server.name, {enabled: false});
  const disabled = JSON.parse(readFileSync(join(root, 'agent', 'mcp.json'), 'utf8'));
  assert.equal(disabled.mcpServers.qichacha.enabled, false);

  const skill = store.addSkill({name: '展会检索', description: 'Find upcoming trade shows', content: 'Search the web and list shows.'});
  const skillFile = join(root, 'agent', 'skills', skill.slug, 'SKILL.md');
  assert.ok(existsSync(skillFile));
  assert.match(readFileSync(skillFile, 'utf8'), /name: 展会检索/);
  assert.deepEqual(store.enabledSkillPaths(), [join(root, 'agent', 'skills', skill.slug)]);

  store.updateSkill(skill.id, {enabled: false});
  assert.deepEqual(store.enabledSkillPaths(), []);
  store.updateSkill(skill.id, {enabled: true, content: 'Updated instructions.'});
  assert.match(readFileSync(skillFile, 'utf8'), /Updated instructions/);

  store.setSettings({ocr: {provider: 'local', localUrl: 'http://10.0.0.5:9000/mineru/'}});
  assert.deepEqual(store.ocr(), {provider: 'local', localUrl: 'http://10.0.0.5:9000/mineru', officialBase: '', token: ''});
  store.setSettings({ocr: {provider: 'official', token: 'mineru-secret'}});
  assert.equal(store.ocr().token, 'mineru-secret');
  assert.equal(store.publicConfig().ocr.tokenSet, true);
  assert.ok(!JSON.stringify(store.publicConfig()).includes('mineru-secret'));
  assert.throws(() => store.setSettings({ocr: {provider: 'bogus'}}), /Invalid OCR provider/);
  assert.throws(() => store.setSettings({ocr: {localUrl: 'ftp://bad'}}), /http or https/);

  store.setSettings({role: 'viewer'});
  assert.equal(store.publicConfig().mcpServers[0].headers.Authorization, '••••••');
  store.setSettings({role: 'admin'});

  store.replaceMcpConfig({mcpServers: {manual: {command: 'node', args: ['server.js'], enabled: false, exposure: 'direct'}}});
  const manual = JSON.parse(readFileSync(join(root, 'agent', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(manual.mcpServers), ['manual']);
  assert.equal(store.publicConfig().mcpServers[0].name, 'manual');
  assert.equal(store.mcpRuntimeConfig().servers[0].config.enabled, false);

  store.setSettings({role: 'viewer'});
  const viewer = store.publicConfig();
  assert.equal(viewer.role, 'viewer');
  assert.equal(viewer.mcpServers[0].name, 'manual');

  store.removeSkill(skill.id);
  assert.ok(!existsSync(join(root, 'agent', 'skills', skill.slug)));
  store.removeMcp('manual');
  assert.equal(store.config().mcpServers.length, 0);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('agent store discovers hand-copied skill directories as disabled', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-config-'));
 try {
  const first = openAgentStore(root);
  first.addSkill({name: 'Copy me', description: 'x', content: 'body'});
  const slug = first.config().skills[0].slug;
  const second = openAgentStore(root);
  const found = second.config().skills.find(skill => skill.slug === slug);
  assert.ok(found);
  assert.equal(found.enabled, true);
  assert.equal(second.config().skills.filter(skill => skill.slug === slug).length, 1);
  assert.deepEqual(second.config().cli, {enabled: true, allowBash: true});
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('hand-written mcp.json is the source of truth', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-config-'));
 try {
  const first = openAgentStore(root);
  first.replaceMcpConfig({mcpServers: {qcc: {command: 'npx', args: ['-y', 'qcc-mcp'], env: {QCC_KEY: 'secret'}, exposure: 'direct'}}});
  // Simulate an admin editing the file by hand.
  const file = join(root, 'agent', 'mcp.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  parsed.mcpServers.qcc.args = ['-y', 'qcc-mcp@1.2.3'];
  parsed.mcpServers.qcc.enabled = false;
  writeFileSync(file, JSON.stringify(parsed, null, 2));
  const reopened = openAgentStore(root);
  const runtime = reopened.mcpRuntimeConfig().servers[0];
  assert.equal(runtime.name, 'qcc');
  assert.deepEqual(runtime.config.args, ['-y', 'qcc-mcp@1.2.3']);
  assert.equal(runtime.config.enabled, false);
  assert.equal(reopened.publicConfig().mcpServers[0].env.QCC_KEY, 'secret');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('T0 CLI edits to role and CLI are visible without restarting the service', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-config-'));
 try {
  const store = openAgentStore(root);
  assert.equal(store.config().role, 'admin');
  const file = join(root, 'agent-config.json');
  const next = JSON.parse(readFileSync(file, 'utf8'));
  next.role = 'viewer';
  next.cli = {enabled: false, allowBash: false};
  next.ocr = {provider: 'local', localUrl: 'http://10.0.0.9:8000', officialBase: '', token: ''};
  writeFileSync(file, JSON.stringify(next, null, 2));
  assert.equal(store.config().role, 'viewer');
  assert.deepEqual(store.cli(), {enabled: false, allowBash: false});
  assert.equal(store.ocr().localUrl, 'http://10.0.0.9:8000');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
