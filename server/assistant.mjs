// Interactive research assistant built on the Pi coding-agent SDK.
//
// Scope of this slice: read-only questions about one project, streamed over SSE
// by the host API. The assistant gets no built-in coding tools and no host
// resource discovery; its only tools are the read-only reads supplied by the
// caller, executed with the signed-in user's token (Supabase) or the local
// single-user store.

import {mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {
 createAgentSession,
 createExtensionRuntime,
 ModelRuntime,
 SessionManager,
 SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {deepseekProvider} from '@earendil-works/pi-ai/providers/deepseek';
import {obj, str} from '@earendil-works/pi-schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE = 8000;

export const ASSISTANT_SYSTEM_PROMPT = [
 'You are the Domel research assistant.',
 'Answer only from the project data returned by your tools; never invent sources, quotes, numbers or review decisions.',
 'Cite source ids and titles when you use them, and say clearly when the workspace does not contain an answer.',
 'You can read this project, its sources and its findings, but you cannot run research, edit findings or generate reports. Tell the user which screen performs those actions when needed.',
 'Reply in the language of the user message. Be concise.',
].join(' ');

// The server must never inherit the host's AGENTS.md, skills, extensions or
// settings, so every discovery hook is replaced with an explicit empty value.
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

const toolText = value => ({content: [{type: 'text', text: JSON.stringify(value)}], details: {}});

// Reader contract: project(id), sources(id), findings(id). Both the Supabase
// client and the local store adapt to it, so the tools stay identical.
export function supabaseReader(db) {
 const read = async query => {
  const {data, error} = await query;
  if (error) throw Error('Database read failed');
  return data;
 };
 return {
  project: id => read(db.from('projects')
   .select('id,title,question,segment,market,quarter,competitors,focus,status,stage,errors')
   .eq('id', id).maybeSingle()),
  sources: id => read(db.from('sources')
   .select('id,title,url,published_at,retrieved_at,text')
   .eq('project_id', id).limit(50)),
  findings: id => read(db.from('findings')
   .select('competitor,field,original_text,quote,decision')
   .eq('project_id', id).limit(20)),
 };
}

export function localReader(store) {
 return {
  project: id => store.project(id),
  sources: id => store.sources(id),
  findings: id => store.findings(id),
 };
}

export function readOnlyTools(reader, projectId) {
 const scoped = work => UUID.test(String(projectId)) ? work(projectId) : {error: 'Project not accessible'};
 return [
  {
   name: 'get_project',
   label: 'Project brief',
   description: 'Read the scope, status, coverage errors and competitors of the current project.',
   parameters: obj({}),
   execute: async () => toolText(await scoped(async id =>
    (await reader.project(id)) ?? {error: 'Project not accessible'})),
  },
  {
   name: 'list_sources',
   label: 'List sources',
   description: 'List the stored public sources of the current project, without full text.',
   parameters: obj({}),
   execute: async () => toolText(await scoped(async id =>
    (await reader.sources(id)).map(({id: sourceId, title, url, published_at, retrieved_at}) =>
     ({id: sourceId, title, url, published_at, retrieved_at})))),
  },
  {
   name: 'search_sources',
   label: 'Search sources',
   description: 'Search stored source text of the current project and return matching excerpts.',
   parameters: obj({query: str()}),
   execute: async (_toolCallId, params) => toolText(await scoped(async id => {
    const needle = String(params.query).slice(0, 200).toLowerCase();
    return (await reader.sources(id))
     .filter(source => String(source.text ?? '').toLowerCase().includes(needle))
     .slice(0, 5)
     .map(source => ({id: source.id, title: source.title, url: source.url, text: String(source.text ?? '').slice(0, 1200)}));
   })),
  },
  {
   name: 'list_findings',
   label: 'List findings',
   description: 'List candidate findings of the current project with review decisions and quotes.',
   parameters: obj({}),
   execute: async () => toolText(await scoped(async id =>
    (await reader.findings(id)).map(({competitor, field, original_text, quote, decision}) =>
     ({competitor, field, original_text, quote, decision})))),
  },
 ];
}

async function openSessionFile({dir, cwd, model, modelRuntime, tools, systemPrompt, agentDir}) {
 const sessions = await SessionManager.listAll(dir);
 const latest = sessions.sort((a, b) => b.modified - a.modified)[0];
 const sessionManager = latest
  ? SessionManager.open(latest.path, dir, cwd)
  : SessionManager.create(cwd, dir);
 const {session} = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime,
  thinkingLevel: 'off',
  noTools: 'builtin',
  customTools: tools,
  resourceLoader: emptyResourceLoader(systemPrompt),
  sessionManager,
  settingsManager: SettingsManager.inMemory({compaction: {enabled: false}}),
 });
 return session;
}

export function createAssistantRunner({model, modelRuntime, sessionRoot, cwd, systemPrompt = ASSISTANT_SYSTEM_PROMPT}) {
 const root = resolve(sessionRoot);
 const agentDir = join(root, '.agent');
 mkdirSync(agentDir, {recursive: true});
 const locks = new Map();

 async function withLock(key, work) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const next = previous.then(() => current);
  locks.set(key, next);
  await previous.catch(() => {});
  try {
   return await work();
  } finally {
   release();
   if (locks.get(key) === next) locks.delete(key);
  }
 }

 return async function run({reader, userId, projectId, message, onEvent = () => {}, abortSignal}) {
  if (!UUID.test(String(projectId))) throw Error('Project not accessible');
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE) throw Error('Invalid assistant message');
  const owned = await reader.project(projectId);
  if (!owned || owned.error) throw Error('Project not accessible');
  const dir = join(root, String(userId), projectId);
  mkdirSync(dir, {recursive: true});
  return withLock(dir, async () => {
   const session = await openSessionFile({
    dir, cwd, model, modelRuntime, agentDir,
    tools: readOnlyTools(reader, projectId),
    systemPrompt,
   });
   const onAbort = () => { session.abort().catch(() => {}); };
   abortSignal?.addEventListener('abort', onAbort, {once: true});
   const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
     onEvent({type: 'delta', text: event.assistantMessageEvent.delta});
    } else if (event.type === 'tool_execution_start') {
     onEvent({type: 'tool_start', tool: event.toolName});
    } else if (event.type === 'tool_execution_end') {
     onEvent({type: 'tool_end', tool: event.toolName, ok: !event.isError});
    }
   });
   try {
    await session.prompt(message.trim());
    const text = session.getLastAssistantText() ?? '';
    onEvent({type: 'done', text});
    return text;
   } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    unsubscribe();
    session.dispose();
   }
  });
 };
}

export async function openDeepSeekModel({apiKey, modelId = 'deepseek-flash', authDir = '.pi-sessions/.agent'}) {
 mkdirSync(authDir, {recursive: true});
 // The provider reads DEEPSEEK_API_KEY from the environment; do not persist the
 // key into the runtime's credential file.
 if (apiKey && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = apiKey;
 const modelRuntime = await ModelRuntime.create({
  authPath: join(authDir, 'auth.json'),
  modelsPath: null,
  refreshOnCreate: false,
 });
 modelRuntime.registerNativeProvider(deepseekProvider());
 const model = modelRuntime.getModel('deepseek', modelId);
 if (!model) throw Error('DeepSeek model is not available: ' + modelId);
 return {model, modelRuntime};
}

export async function openAssistant({apiKey, modelId = 'deepseek-flash', sessionRoot = '.pi-sessions', cwd = process.cwd()}) {
 const root = resolve(sessionRoot);
 const {model, modelRuntime} = await openDeepSeekModel({apiKey, modelId, authDir: join(root, '.agent')});
 return createAssistantRunner({model, modelRuntime, sessionRoot: root, cwd});
}
