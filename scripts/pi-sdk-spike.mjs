// Pi SDK spike: embed the coding-agent SDK as a research assistant, with no
// host resource discovery and no built-in coding tools.
//
// Runs offline against pi-ai's faux provider so the wiring can be verified
// without provider credentials:
//   node scripts/pi-sdk-spike.mjs
//
// The same builder accepts a real model + ModelRuntime for the host API.

import {mkdirSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
 createAgentSession,
 createExtensionRuntime,
 ModelRuntime,
 SessionManager,
 SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {obj, str} from '@earendil-works/pi-schema';

// Explicit, empty resource loader: the server must never inherit the host's
// AGENTS.md, skills, extensions or settings.
function emptyResourceLoader(systemPrompt) {
 return {
  getExtensions: () => ({extensions: [], errors: [], runtime: createExtensionRuntime()}),
  getSkills: () => ({skills: [], diagnostics: []}),
  getPrompts: () => ({prompts: [], diagnostics: []}),
  getThemes: () => ({themes: [], diagnostics: []}),
  getAgentsFiles: () => ({agentsFiles: []}),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
 };
}

// Tools the assistant gets. In the real host these call the existing API
// services; here they return fixtures so the spike stays offline.
function researchTools(workspace) {
 const brief = {
  name: 'get_project_brief',
  label: 'Project brief',
  description: 'Return the saved scope and current review state of one project.',
  parameters: obj({projectId: str()}),
  execute: async (_toolCallId, params) => ({
   content: [{type: 'text', text: JSON.stringify(workspace[params.projectId] ?? {error: 'unknown project'})}],
   details: {},
  }),
 };
 const search = {
  name: 'search_sources',
  label: 'Search sources',
  description: 'Search the saved sources of a project. Read-only.',
  parameters: obj({projectId: str(), query: str()}),
  execute: async (_toolCallId, params) => {
   const project = workspace[params.projectId];
   const hits = (project?.sources ?? []).filter(source => source.text.toLowerCase().includes(params.query.toLowerCase()));
   return {
    content: [{type: 'text', text: JSON.stringify(hits.map(({id, title, url}) => ({id, title, url})))}],
    details: {},
   };
  },
 };
 return [brief, search];
}

export async function createResearchAssistant({model, modelRuntime, workspace, cwd, systemPrompt}) {
 const agentDir = mkdtempSync(join(tmpdir(), 'domel-pi-'));
 mkdirSync(agentDir, {recursive: true});
 const {session} = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime,
  thinkingLevel: 'off',
  noTools: 'builtin', // no read/write/edit/bash; custom tools stay
  customTools: researchTools(workspace),
  resourceLoader: emptyResourceLoader(systemPrompt ?? 'You are a market research assistant. Use the project tools.'),
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({compaction: {enabled: false}}),
 });
 return session;
}

async function main() {
 const workspace = {
  'p-1': {
   id: 'p-1',
   title: 'Edge AI accelerators, Q3',
   segment: 'Automotive',
   market: 'Japan',
   sources: [{id: 's-1', title: 'Vendor roadmap', url: 'https://example.com/roadmap', text: 'Mass production starts in Q3 2026.'}],
  },
 };
 const faux = fauxProvider();
 const runtime = await ModelRuntime.create({authPath: join(tmpdir(), 'domel-pi-auth.json'), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 await runtime.setRuntimeApiKey(faux.provider.id, 'spike').catch(() => {});
 const model = faux.getModel();

 faux.setResponses([
  fauxAssistantMessage([fauxToolCall('get_project_brief', {projectId: 'p-1'})], {stopReason: 'toolUse'}),
  fauxAssistantMessage([fauxToolCall('search_sources', {projectId: 'p-1', query: 'Q3'})], {stopReason: 'toolUse'}),
  fauxAssistantMessage([fauxText('Project p-1 has one source noting mass production in Q3 2026.')]),
 ]);

 const session = await createResearchAssistant({model, modelRuntime: runtime, workspace, cwd: process.cwd()});
 session.subscribe(event => {
  if (event.type === 'tool_execution_start') console.log('[tool]', event.toolName, JSON.stringify(event.args));
  if (event.type === 'tool_execution_end') console.log('[tool done]', event.toolName, event.isError ? JSON.stringify(event.result) : 'ok');
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') process.stdout.write(event.assistantMessageEvent.delta);
 });
 try {
  await session.prompt('Summarize project p-1 from its brief and sources.');
  console.log('\n[answer]', session.getLastAssistantText());
 } finally {
  session.dispose();
 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 await main();
}
