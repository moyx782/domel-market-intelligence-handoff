// Agent run history. The agent page needs a read-only transcript that survives
// page reloads and is visible to viewers, while the Pi session files stay an
// implementation detail of the runtime. One record per completed agent run.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_SESSIONS = 100;
const MAX_MESSAGE_CHARS = 20000;

function normalize(data) {
 if (!data || !Array.isArray(data.sessions)) return {version: 1, sessions: []};
 return {version: 1, sessions: data.sessions.slice(0, MAX_SESSIONS)};
}

function clip(text) {
 return String(text ?? '').slice(0, MAX_MESSAGE_CHARS);
}

export function openTranscriptStore({file}) {
 let data;
 try {
  data = normalize(JSON.parse(readFileSync(file, 'utf8')));
 } catch {
  data = {version: 1, sessions: []};
 }
 let chain = Promise.resolve();

 function persist() {
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, file);
 }

 const read = work => chain.then(() => work(structuredClone(data)));
 const mutate = work => {
  const run = chain.then(() => {
   const result = work(data);
   data.sessions = data.sessions.slice(0, MAX_SESSIONS);
   persist();
   return structuredClone(result);
  });
  chain = run.catch(() => {});
  return run;
 };

 return {
  file,

  // One run: user prompt + assistant answer + tools the runtime reported.
  recordRun({projectId = 'general', userText, assistantText, toolCalls = [], error = null, startedAt, finishedAt}) {
   const stamp = startedAt || new Date().toISOString();
   const end = finishedAt || new Date().toISOString();
   const session = {
    id: randomUUID(),
    projectId: String(projectId || 'general'),
    title: (String(userText || '').trim().replace(/\s+/g, ' ').slice(0, 80)) || 'Agent run',
    createdAt: stamp,
    updatedAt: end,
    messages: [
     {role: 'user', text: clip(userText), at: stamp},
     {
      role: 'assistant',
      text: clip(error ? 'Error: ' + error : assistantText),
      at: end,
      ...(toolCalls.length ? {toolCalls} : {}),
     },
    ],
   };
   return mutate(state => {
    state.sessions.unshift(session);
    return session;
   });
  },

  list({projectId} = {}) {
   return read(state => state.sessions
    .filter(session => !projectId || session.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({id, projectId: pid, title, createdAt, updatedAt, messages}) => ({
     id,
     projectId: pid,
     title,
     createdAt,
     updatedAt,
     messageCount: messages.length,
    })));
  },

  get(id) {
   return read(state => state.sessions.find(session => session.id === id) ?? null);
  },

  clear(projectId) {
   return mutate(state => {
    state.sessions = projectId
     ? state.sessions.filter(session => session.projectId !== projectId)
     : [];
    return {ok: true};
   });
  },
 };
}
