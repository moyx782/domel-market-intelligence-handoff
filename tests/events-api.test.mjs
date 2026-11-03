import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openAgentStore} from '../server/agent-config.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {fakeEventStore, fakeTasks} from './fixtures/api-fakes.mjs';

const EVENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function events() {
 return fakeEventStore([
  {
   id: EVENT_A, name: '中国制冷展 2026', startDate: '2026-04-08', endDate: '2026-04-10',
   city: '上海', venue: '上海新国际博览中心', region: 'cn', status: 'enriched', confidence: 'high',
   industries: ['HVAC'], documents: [{url: 'https://expo.example/list.pdf', type: 'pdf', status: 'downloadable'}],
   sources: [{url: 'https://www.cr-expo.com', title: 'Official', verifiedAt: '2026-01-02T00:00:00.000Z'}],
  },
  {
   id: EVENT_B, name: 'Messe, Frankfurt 2027', startDate: '2027-03-01', city: 'Frankfurt',
   region: 'eu', status: 'discovered', confidence: 'low',
  },
 ]);
}

async function listen({role = 'admin', env = {}, parts = {}} = {}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-events-api-'));
 const store = openLocalStore(join(root, 'data.json'));
 const agentStore = openAgentStore(join(root, 'agent-data'));
 if (role !== 'admin') agentStore.setSettings({role});
 const tasks = fakeTasks({eventStore: events(), ...parts});
 const server = localApiServer({store, agentStore, tasks, env});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = 'http://127.0.0.1:' + server.address().port;
 return {
  tasks, server, url, agentStore,
  async close() {
   await new Promise(resolve => server.close(resolve));
   rmSync(root, {recursive: true, force: true});
  },
 };
}

const json = (url, init) => fetch(url, {...init, headers: {'Content-Type': 'application/json', ...(init?.headers ?? {})}});

test('event list, filters, detail and manual correction', async () => {
 const ctx = await listen();
 try {
  const all = await (await fetch(ctx.url + '/api/v1/events')).json();
  assert.equal(all.count, 2);
  const china = await (await fetch(ctx.url + '/api/v1/events?region=cn')).json();
  assert.equal(china.count, 1);
  assert.equal(china.events[0].name, '中国制冷展 2026');
  const searched = await (await fetch(ctx.url + '/api/v1/events?q=Frankfurt')).json();
  assert.equal(searched.count, 1);
  const missing = await fetch(ctx.url + '/api/v1/events/' + '00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  const detail = await (await fetch(ctx.url + '/api/v1/events/' + EVENT_A)).json();
  assert.equal(detail.venue, '上海新国际博览中心');

  const patched = await json(ctx.url + '/api/v1/events/' + EVENT_A, {method: 'PATCH', body: JSON.stringify({boothPrice: '¥1200/m²', notes: ['手动补充']})});
  assert.equal(patched.status, 200);
  const updated = await patched.json();
  assert.equal(updated.boothPrice, '¥1200/m²');
  assert.deepEqual(updated.notes, ['手动补充']);
 } finally {
  await ctx.close();
 }
});

test('event discovery, enrichment and document parsing interfaces', async () => {
 const ctx = await listen({env: {}});
 try {
  const discover = await json(ctx.url + '/api/v1/events/discover', {method: 'POST', body: JSON.stringify({region: 'cn'})});
  assert.equal(discover.status, 202);
  const {task} = await discover.json();
  assert.equal(task.kind, 'event.discover');
  assert.equal(task.payload.region, 'cn');
  assert.equal(task.payload.limit, 30);

  const enrichMissing = await json(ctx.url + '/api/v1/events/' + '00000000-0000-4000-8000-000000000000/enrich', {method: 'POST', body: '{}'});
  assert.equal(enrichMissing.status, 404);
  const enrich = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/enrich', {method: 'POST', body: '{}'});
  assert.equal(enrich.status, 202);
  const enrichBody = await enrich.json();
  assert.equal(enrichBody.task.kind, 'event.enrich');
  assert.equal(enrichBody.task.eventId, EVENT_A);

  const unknownDocument = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/parse', {method: 'POST', body: JSON.stringify({url: 'https://expo.example/other.pdf'})});
  assert.equal(unknownDocument.status, 404);
  const notConfigured = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/parse', {method: 'POST', body: JSON.stringify({url: 'https://expo.example/list.pdf'})});
  assert.equal(notConfigured.status, 409);
  assert.match((await notConfigured.json()).error, /not configured/i);

  // The OCR provider is stored in the agent settings, which override env; the
  // admin API is the place where the token is written.
  ctx.agentStore.setSettings({ocr: {provider: 'official', officialBase: 'https://mineru.net/api/v4', token: 'secret-token'}});
  const parse = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/parse', {method: 'POST', body: JSON.stringify({url: 'https://expo.example/list.pdf'})});
  assert.equal(parse.status, 501);
  const payload = await parse.json();
  assert.match(payload.error, /not enabled in this demo phase/);
  assert.equal(payload.ocr.provider, 'official');
  assert.ok(!JSON.stringify(payload).includes('secret-token'));
 } finally {
  await ctx.close();
 }
});

test('event export produces JSON and CSV downloads with escaped cells', async () => {
 const ctx = await listen();
 try {
  const jsonResponse = await fetch(ctx.url + '/api/v1/events/export?format=json');
  assert.equal(jsonResponse.status, 200);
  assert.match(jsonResponse.headers.get('content-type'), /application\/json/);
  assert.match(jsonResponse.headers.get('content-disposition'), /attachment; filename="domel-events\.json"/);
  const payload = await jsonResponse.json();
  assert.equal(payload.events.length, 2);

  const csvResponse = await fetch(ctx.url + '/api/v1/events/export?format=csv');
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /domel-events\.csv/);
  const csv = await csvResponse.text();
  const lines = csv.split('\n');
  assert.equal(lines[0], 'name,edition,startDate,endDate,city,province,district,country,venue,organizer,website,frequency,industries,scope,exhibitorCount,visitorCount,area,exhibitorListUrl,exhibitorListStatus,applicationDeadline,boothPrice,ticketPrice,region,confidence,status,sources,notes');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('中国制冷展 2026,'));
  assert.ok(lines.some(line => line.startsWith('"Messe, Frankfurt 2027"')));
 } finally {
  await ctx.close();
 }
});

test('viewers can read events but not create or correct them', async () => {
 const ctx = await listen({role: 'viewer'});
 try {
  assert.equal((await fetch(ctx.url + '/api/v1/events')).status, 200);
  assert.equal((await fetch(ctx.url + '/api/v1/events/export?format=csv')).status, 200);
  const discover = await json(ctx.url + '/api/v1/events/discover', {method: 'POST', body: '{}'});
  assert.equal(discover.status, 403);
  const patch = await json(ctx.url + '/api/v1/events/' + EVENT_A, {method: 'PATCH', body: JSON.stringify({city: '北京'})});
  assert.equal(patch.status, 403);
  const enrich = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/enrich', {method: 'POST', body: '{}'});
  assert.equal(enrich.status, 403);
  const parse = await json(ctx.url + '/api/v1/events/' + EVENT_A + '/parse', {method: 'POST', body: JSON.stringify({url: 'https://expo.example/list.pdf'})});
  assert.equal(parse.status, 403);

  const user = await listen({role: 'user'});
  try {
   const allowed = await json(user.url + '/api/v1/events/' + EVENT_A, {method: 'PATCH', body: JSON.stringify({city: '上海'})});
   assert.equal(allowed.status, 200);
  } finally {
   await user.close();
  }
 } finally {
  await ctx.close();
 }
});
