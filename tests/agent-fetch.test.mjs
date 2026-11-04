// Agent adaptive fetch validation + file contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_FETCH_FILE, runAgentFetch, validateAgentFetch} from '../server/agent-fetch.mjs';

const target = 'https://expo.example/page';
const payload = {
 ok: true,
 url: target,
 finalUrl: target,
 title: 'Expo page',
 text: '中国国际制冷展 2026\n上海新国际博览中心\nChina Refrigeration Expo\n观众登记与展商名单信息。',
 engine: 'agent-browser',
 strategies: ['collector:http', 'browser'],
 chars: 60,
};

test('agent fetch validates same-site public text', () => {
 const result = validateAgentFetch(payload, {url: target});
 assert.equal(result.ok, true);
 assert.equal(result.url, target);
 assert.equal(result.engine, 'agent-browser');
 assert.match(result.text, /中国国际制冷展/);
});

test('agent fetch rejects different sites and too little text', () => {
 assert.throws(() => validateAgentFetch({...payload, finalUrl: 'https://evil.example/x'}, {url: target}), /different site/);
 assert.throws(() => validateAgentFetch({...payload, text: 'too short'}, {url: target}), /too little text/);
 assert.throws(() => validateAgentFetch({...payload, ok: false, error: 'robots'}, {url: target}), /failed: robots/);
});

test('runAgentFetch reads fetch-result.json from the agent workspace', async () => {
 const workspace = mkdtempSync(join(tmpdir(), 'domel-agent-fetch-'));
 let called = null;
 const runtime = async ({projectId, message}) => {
  called = {projectId, message};
  writeFileSync(join(workspace, AGENT_FETCH_FILE), JSON.stringify(payload));
  return {text: 'done', workspace};
 };
 const result = await runAgentFetch({agentRuntime: runtime, url: target, eventName: 'China Refrigeration', workspace, projectId: 'agent-fetch-1', helperPath: '/repo/scripts/adaptive-fetch.mjs'});
 assert.equal(result.ok, true);
 assert.equal(called.projectId, 'agent-fetch-1');
 assert.match(called.message, /adaptive-fetch\.mjs/);
});
