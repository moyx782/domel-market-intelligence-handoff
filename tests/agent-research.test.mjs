import {agentBriefProject} from '../src/agent-brief.mjs';
// Agent-driven research: skills are seeded into the agent workspace, and the
// research mode hands the agent a task that must produce verified evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentStore} from '../server/agent-config.mjs';
import {
 AGENT_RESEARCH_FILE, buildAgentResearchPrompt, parseResearchResult,
 runAgentResearch, validateAgentResult,
} from '../server/agent-research.mjs';
import {openLocalStore} from '../server/local-store.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {fakeTasks} from './fixtures/api-fakes.mjs';

const project = {
 id: '11111111-1111-4111-8111-111111111111',
 title: 'EC motors research',
 question: 'Who ships EC motors for ventilation?',
 segment: 'HVAC',
 market: 'China',
 quarter: '2026-Q4',
 competitors: ['Nidec', 'ebm-papst'],
 focus: ['EC motors', 'Trade shows'],
 source_urls: [],
};

const quote = 'Nidec will show its new EC fan motor platform at the Beijing HVAC exhibition in March 2027.';
const pageText = 'Company news. ' + quote + ' The booth is in hall 3.';

test('agent research prompt contains the scope, API base and output contract', () => {
 const prompt = buildAgentResearchPrompt({project, apiBase: 'http://127.0.0.1:8788', workspace: '/tmp/ws'});
 assert.match(prompt, /Nidec/);
 assert.match(prompt, /http:\/\/127\.0\.0\.1:8788/);
 assert.match(prompt, /research-result\.json/);
 assert.match(prompt, /exact quote/i);
 assert.match(prompt, /domel-api/);
});

test('agent research result validation enforces quotes, scope and public sources', () => {
 const parsed = {
  sources: [
   {url: 'https://www.example.com/news', title: 'HVAC news', text: pageText},
   {url: 'http://127.0.0.1/internal', title: 'internal', text: pageText},
   {url: 'https://www.example.com/empty', title: 'empty', text: 'short'},
  ],
  findings: [
   {competitor: 'Nidec', field: 'EC motors', text: 'Nidec plans an EC fan platform.', quote, source_url: 'https://www.example.com/news', source_title: 'HVAC news'},
   {competitor: 'Unknown Corp', field: 'EC motors', text: 'bad competitor', quote, source_url: 'https://www.example.com/news'},
   {competitor: 'Nidec', field: 'Not a focus', text: 'bad field', quote, source_url: 'https://www.example.com/news'},
   {competitor: 'Nidec', field: 'EC motors', text: 'wrong quote', quote: 'This sentence is not in the page at all, really it is not.', source_url: 'https://www.example.com/news'},
   {competitor: 'ebm-papst', field: 'Trade shows', text: 'missing source', quote, source_url: 'https://missing.example/page'},
  ],
 };
 const result = validateAgentResult(parsed, project, {});
 assert.equal(result.sources, 1);
 assert.equal(result.findings, 1);
 assert.equal(result.dropped, 4);
 assert.equal(result.savedSources[0].url, 'https://www.example.com/news');
 assert.equal(result.savedSources[0].findings[0].competitor, 'Nidec');
 assert.match(result.errors.join(' '), /public HTTPS policy|readable text/);
 assert.throws(() => validateAgentResult({sources: [], findings: []}, project, {}), /no usable public sources/);
});

test('parseResearchResult accepts plain JSON, fenced JSON and prose with a JSON block', () => {
 assert.equal(parseResearchResult('{"sources":[],"findings":[]}').sources.length, 0);
 assert.deepEqual(parseResearchResult('Result:\n```json\n{"sources":[]}\n```').sources, []);
 assert.equal(parseResearchResult('noise {"sources":[{"url":"x"}]} tail').sources[0].url, 'x');
 assert.equal(parseResearchResult('not json'), null);
});

test('runAgentResearch reads the result file written by the agent', async () => {
 const workspace = mkdtempSync(join(tmpdir(), 'domel-agent-research-file-'));
 const payload = {sources: [{url: 'https://www.example.com/news', title: 'HVAC news', text: pageText}], findings: [
  {competitor: 'Nidec', field: 'EC motors', text: 'Nidec plans an EC fan platform.', quote, source_url: 'https://www.example.com/news'},
 ]};
 const agentRuntime = async ({message, onEvent}) => {
  assert.match(message, /Who ships EC motors/);
  onEvent({type: 'tool_start', tool: 'bash'});
  writeFileSync(join(workspace, AGENT_RESEARCH_FILE), JSON.stringify(payload));
  return {text: 'done', workspace};
 };
 const result = await runAgentResearch({agentRuntime, project, apiBase: 'http://127.0.0.1:8788', workspace});
 assert.equal(result.findings, 1);
 assert.equal(result.savedSources.length, 1);
});

test('runAgentResearch falls back to JSON in the final answer and reports missing output', async () => {
 const workspace = mkdtempSync(join(tmpdir(), 'domel-agent-research-text-'));
 const payload = {sources: [{url: 'https://www.example.com/news', title: 'HVAC news', text: pageText}], findings: []};
 const agentRuntime = async () => ({text: 'Result:\n' + JSON.stringify(payload)});
 const result = await runAgentResearch({agentRuntime, project, apiBase: 'http://127.0.0.1:8788', workspace});
 assert.equal(result.sources, 1);
 await assert.rejects(
  runAgentResearch({agentRuntime: async () => ({text: 'no result'}), project, apiBase: 'x', workspace}),
  /did not produce research-result\.json/,
 );
});

test('shipped skills are seeded once into a fresh agent data directory', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-skills-'));
 const store = openAgentStore(root, {seedSkillsDir: 'seed/skills'});
 const slugs = store.publicConfig().skills.map(skill => skill.slug).sort();
 assert.deepEqual(slugs, ['agent-research', 'domel-api', 'event-intelligence', 'evidence-quality', 'source-collection']);
 const reopened = openAgentStore(root, {seedSkillsDir: 'seed/skills'});
 assert.equal(reopened.publicConfig().skills.length, 5);
});

async function listen() {
 const root = mkdtempSync(join(tmpdir(), 'domel-agent-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const queue = fakeTasks().queue;
 let agentCalls = 0;
 const server = localApiServer({
  store,
  tasks: {queue, eventStore: null, registry: null, recipes: null},
  resolveAgent: async () => (async () => { agentCalls += 1; }),
  env: {DEEPSEEK_API_KEY: 'test-key'},
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {root, store, queue, server, url, agentCalls: () => agentCalls};
}

test('running a project with mode=agent schedules project.agent-research', async () => {
 const ctx = await listen();
 try {
  const created = await (await fetch(ctx.url + '/api/v1/research-tasks', {
   method: 'POST', headers: {'Content-Type': 'application/json'},
   body: JSON.stringify(agentBriefProject('HVAC exhibitions in China','Find 2027 dates and official evidence.')),
  })).json();
  const response = await fetch(ctx.url + '/api/v1/research-tasks/' + created.id + '/run', {
   method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'agent'}),
  });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.ok(payload.taskId);
  assert.equal(ctx.queue.created.length, 1);
  assert.equal(ctx.queue.created[0].kind, 'project.agent-research');
  const job = await ctx.store.jobs();
  assert.equal(job[0].mode, 'agent');
 } finally {
  await new Promise(resolve => ctx.server.close(resolve));
 }
});
