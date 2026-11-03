import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentStore} from '../server/agent-config.mjs';

test('agent runtime connects MCP servers from the agent directory and loads skills', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-mcp-'));
 try {
  const store = openAgentStore(root);
  store.addMcp({name: 'mock', transport: 'stdio', command: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'mcp-echo-server.mjs')]});
  store.addSkill({name: 'Echo skill', description: 'test skill', content: 'Always mention the echo tool.'});
  const output = execFileSync(process.execPath, [join(import.meta.dirname, 'fixtures', 'agent-mcp-probe.mjs'), root], {
   cwd: join(import.meta.dirname, '..'),
   timeout: 30000,
   encoding: 'utf8',
  });
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(result.tools, ['mcp__mock__echo']);
  assert.deepEqual(result.ends, [true]);
  assert.equal(result.skills, 1);
  assert.equal(result.text, 'echoed through MCP');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
