import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTranscriptStore} from '../server/transcripts.mjs';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';

function temp() {
 return mkdtempSync(join(tmpdir(), 'domel-transcripts-'));
}

test('transcript store records runs, filters by project and persists atomically', async () => {
 const root = temp();
 const file = join(root, 'transcripts.json');
 try {
  const store = openTranscriptStore({file});
  const first = await store.recordRun({
   projectId: 'general',
   userText: 'What can you do?',
   assistantText: 'Collect evidence.',
   toolCalls: [{tool: 'ls', ok: true, args: '{}'}],
  });
  const second = await store.recordRun({projectId: 'project-1', userText: 'Check HVAC shows', assistantText: 'Found two candidates.'});
  assert.equal(first.projectId, 'general');
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[1].toolCalls[0].tool, 'ls');
  assert.equal(second.projectId, 'project-1');

  const general = await store.list({projectId: 'general'});
  assert.equal(general.length, 1);
  assert.equal(general[0].id, first.id);
  assert.equal(general[0].messageCount, 2);
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.get(second.id)).messages[0].text, 'Check HVAC shows');
  assert.equal(await store.get('missing'), null);

  // Reopening reads the same data from disk.
  const reopened = openTranscriptStore({file});
  assert.equal((await reopened.list()).length, 2);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.sessions.length, 2);

  await store.clear('project-1');
  assert.equal((await store.list()).length, 1);
  await store.clear();
  assert.equal((await store.list()).length, 0);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('error runs are recorded with an explicit error line', async () => {
 const root = temp();
 try {
  const store = openTranscriptStore({file: join(root, 'transcripts.json')});
  const session = await store.recordRun({projectId: 'general', userText: 'Run', assistantText: '', error: 'Model unavailable'});
  assert.equal(session.messages[1].text, 'Error: Model unavailable');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

async function listen({role = 'admin', transcripts}) {
 const root = temp();
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-data'));
 if (role !== 'admin') agentStore.setSettings({role});
 const server = localApiServer({store, agentStore, transcripts, env: {SERVE_STATIC: '0'}});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {
  server, url,
  async close() {
   await new Promise(resolve => server.close(resolve));
   rmSync(root, {recursive: true, force: true});
  },
 };
}

test('every role can read agent history, only user+ can chat', async () => {
 const transcripts = openTranscriptStore({file: join(temp(), 'transcripts.json')});
 const session = await transcripts.recordRun({projectId: 'general', userText: 'History question', assistantText: 'History answer'});

 const viewer = await listen({role: 'viewer', transcripts});
 try {
  const list = await (await fetch(viewer.url + '/api/v1/agent/sessions')).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].id, session.id);
  const detail = await (await fetch(viewer.url + '/api/v1/agent/sessions/' + session.id)).json();
  assert.equal(detail.messages[0].text, 'History question');
  assert.equal(detail.messages[1].text, 'History answer');
  const missing = await fetch(viewer.url + '/api/v1/agent/sessions/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);

  // No agent runtime is configured here; a viewer is refused by role before that.
  const chat = await fetch(viewer.url + '/api/v1/agent/chat', {
   method: 'POST',
   headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({projectId: 'general', message: 'hello'}),
  });
  assert.equal(chat.status, 403);
  assert.equal((await chat.json()).requiredRole, 'user');
 } finally {
  await viewer.close();
 }
});

test('sessions endpoints report an empty list when the store is absent', async () => {
 const ctx = await listen({role: 'admin', transcripts: null});
 try {
  const list = await (await fetch(ctx.url + '/api/v1/agent/sessions')).json();
  assert.deepEqual(list.sessions, []);
  const detail = await fetch(ctx.url + '/api/v1/agent/sessions/00000000-0000-4000-8000-000000000000');
  assert.equal(detail.status, 404);
 } finally {
  await ctx.close();
 }
});
