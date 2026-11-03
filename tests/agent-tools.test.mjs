import test from 'node:test';
import assert from 'node:assert/strict';
import {agentTools} from '../server/agent-runtime.mjs';

test('file tools are all-or-nothing and bash is independent', () => {
 const off = agentTools({enabled: false, allowBash: true});
 assert.deepEqual(off, ['mcp__*']);

 const filesOnly = agentTools({enabled: true, allowBash: false});
 for (const tool of ['read', 'write', 'edit', 'grep', 'find', 'ls', 'mcp__*']) assert.ok(filesOnly.includes(tool));
 assert.ok(!filesOnly.includes('bash'));

 const full = agentTools({enabled: true, allowBash: true});
 assert.ok(full.includes('bash'));
});
