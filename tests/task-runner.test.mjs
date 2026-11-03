import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {openEventStore} from '../server/event-store.mjs';
import {openSourceRegistry} from '../server/source-registry.mjs';
import {createTaskRunner} from '../server/task-runner.mjs';

const scope = {title: 'Integration', question: 'Who ships?', segment: 'HVAC', market: 'China', quarter: '2026-Q3', competitors: ['Nidec'], focus: ['EC motors'], source_urls: []};

function fakeCollector({html = '<html><body>EC 电机 news</body></html>', text = 'EC 电机 news', ok = true} = {}) {
 const calls = [];
 return {
  calls,
  async collect(url, options = {}) {
   calls.push({url, options});
   return {
    ok,
    url,
    finalUrl: url,
    status: ok ? 200 : 403,
    engine: 'http',
    title: 'Expo page',
    text,
    html,
    contentType: 'text/html',
    bytes: html.length,
    fetchedAt: new Date().toISOString(),
    robots: {allowed: true, crawlDelayMs: 0},
    ...(ok ? {} : {error: {code: 'BLOCKED', message: 'Blocked by WAF', permanent: true}}),
   };
  },
  async probe(url) {
   return {ok: true, status: 200, contentType: 'application/pdf', contentLength: 1000, availability: 'downloadable', url};
  },
 };
}

const jsonLdHtml = `<html><head><title>中国制冷展 2026</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"中国制冷展 2026","startDate":"2026-04-08","endDate":"2026-04-10","url":"https://expo.example/cr","location":{"@type":"Place","name":"上海新国际博览中心","address":{"@type":"PostalAddress","addressLocality":"上海","addressCountry":"CN"}},"organizer":{"@type":"Organization","name":"中国制冷学会"}}</script>
</head><body><h1>中国制冷展 2026</h1><p>2026-04-08 至 2026-04-10 上海新国际博览中心</p><a href="/files/exhibitors.pdf">展商名单 PDF</a> <a href="/files/fee.pdf">展位价格 PDF</a></body></html>`;

function setup({research} = {}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-task-runner-'));
 const store = openLocalStore(join(root, 'data.json'));
 const registry = openSourceRegistry({file: join(root, 'source-registry.json'), seedFile: null});
 const runner = createTaskRunner({
  store,
  dataDir: root,
  env: {COMPANY_SEED_FILE: 'seed/company-domel.json'},
  registry,
  collector: fakeCollector(),
  researchRunner: research ?? (async job => {
   await store.completeJob(job.id, {status: 'completed', stage: 'Done', errors: []}, []);
   return {status: 'completed'};
  }),
  eventSearch: {search: async () => [
   {name: '中国制冷展 2026', city: '上海', venue: '上海新国际博览中心', startDate: '2026-04-08', endDate: '2026-04-10', website: 'https://expo.example/cr', sourceUrl: 'https://expo.example/cr', confidence: 'low'},
  ]},
 });
 return {root, store, registry, runner, eventStore: runner.eventStore, documents: runner.documents};
}

test('queued research tasks drive the existing project job lifecycle', async () => {
 const ctx = setup();
 try {
  const project = await ctx.store.createProject(scope);
  const job = await ctx.store.enqueue(project.id, 'collect');
  const task = await ctx.runner.queue.create({kind: 'project.research', projectId: project.id, priority: 2, payload: {mode: 'collect', jobId: job.id}});
  ctx.runner.start();
  await ctx.runner.queue.idle({timeoutMs: 5000});
  const finished = ctx.runner.queue.get(task.id);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.result.status, 'completed');
  const jobs = await ctx.store.jobs();
  assert.equal(jobs[0].state, 'succeeded');
  const updated = await ctx.store.project(project.id);
  assert.equal(updated.status, 'completed');
 } finally {
  await ctx.runner.stop();
  rmSync(ctx.root, {recursive: true, force: true});
 }
});

test('a cancelled research task is marked cancelled and its job fails', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-task-runner-'));
 const store = openLocalStore(join(root, 'data.json'));
 const release = {resolve: null};
 const research = async job => {
  await new Promise(resolve => { release.resolve = resolve; });
  await store.completeJob(job.id, {status: 'completed', stage: 'Done', errors: []}, []);
  return {status: 'completed'};
 };
 const runner = createTaskRunner({store, dataDir: root, env: {}, researchRunner: research, registry: openSourceRegistry({file: join(root, 'sources.json'), seedFile: null}), collector: fakeCollector()});
 try {
  const project = await store.createProject(scope);
  const job = await store.enqueue(project.id, 'collect');
  const task = await runner.queue.create({kind: 'project.research', projectId: project.id, payload: {mode: 'collect', jobId: job.id}});
  runner.start();
  for (let attempt = 0; attempt < 100 && runner.queue.get(task.id).state !== 'running'; attempt += 1) {
   await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(runner.queue.get(task.id).state, 'running');
  const cancelled = await runner.queue.cancel(task.id);
  assert.equal(cancelled.state, 'running');
  assert.equal(cancelled.cancelRequested, true);
  release.resolve();
  await runner.queue.idle({timeoutMs: 5000});
  assert.equal(runner.queue.get(task.id).state, 'cancelled');
  const jobs = await store.jobs();
  assert.equal(jobs[0].state, 'failed');
  const projectAfter = await store.project(project.id);
  assert.equal(projectAfter.status, 'failed');
 } finally {
  await runner.stop();
  rmSync(root, {recursive: true, force: true});
 }
});

test('source.collect stores the page, updates the registry and blocks paused domains', async () => {
 const ctx = setup();
 try {
  const source = ctx.registry.create({url: 'https://expo.example/calendar', title: 'Expo calendar', type: 'organizer', region: 'cn', intervalSec: 3600});
  const task = await ctx.runner.queue.create({kind: 'source.collect', sourceId: source.id, payload: {sourceId: source.id, url: source.url}});
  ctx.runner.start();
  await ctx.runner.queue.idle({timeoutMs: 5000});
  assert.equal(ctx.runner.queue.get(task.id).state, 'succeeded');
  const stored = ctx.registry.get(source.id);
  assert.equal(stored.status, 'idle');
  assert.ok(stored.lastRunAt);
  const documents = ctx.documents.list({sourceId: source.id});
  assert.equal(documents.length, 1);
  assert.equal(documents[0].url, 'https://expo.example/calendar');
  assert.equal(documents[0].engine, 'http');

  // A WAF-blocked source is paused instead of retried forever.
  const blocked = ctx.registry.create({url: 'https://blocked.example/list', title: 'Blocked', type: 'media', region: 'cn', intervalSec: 3600});
  ctx.runner.collector.collect = async () => ({ok: false, url: blocked.url, error: {code: 'BLOCKED', message: 'Blocked by WAF', permanent: true}});
  const blockedTask = await ctx.runner.queue.create({kind: 'source.collect', sourceId: blocked.id, payload: {sourceId: blocked.id, url: blocked.url}});
  await ctx.runner.queue.idle({timeoutMs: 5000});
  assert.equal(ctx.runner.queue.get(blockedTask.id).state, 'failed');
  assert.equal(ctx.registry.get(blocked.id).status, 'paused');
 } finally {
  await ctx.runner.stop();
  rmSync(ctx.root, {recursive: true, force: true});
 }
});

test('event.discover and event.enrich run through the queue and persist enriched events', async () => {
 const ctx = setup();
 ctx.runner.collector.collect = async url => ({
  ok: true,
  url,
  finalUrl: url,
  status: 200,
  engine: 'http',
  title: '中国制冷展 2026',
  text: '中国制冷展 2026 2026-04-08 至 2026-04-10 上海新国际博览中心 展商名单',
  html: jsonLdHtml,
  contentType: 'text/html',
  bytes: jsonLdHtml.length,
  fetchedAt: new Date().toISOString(),
  robots: {allowed: true, crawlDelayMs: 0},
 });
 try {
  const discover = await ctx.runner.queue.create({kind: 'event.discover', priority: 2, payload: {region: 'cn', limit: 10}});
  ctx.runner.start();
  await ctx.runner.queue.idle({timeoutMs: 10000});
  const discovered = ctx.runner.queue.get(discover.id);
  assert.equal(discovered.state, 'succeeded');
  assert.ok(discovered.result.created >= 1);
  const events = ctx.eventStore.list({});
  assert.equal(events.length, 1);
  assert.equal(events[0].name, '中国制冷展 2026');

  const enrich = await ctx.runner.queue.create({kind: 'event.enrich', eventId: events[0].id, priority: 2, payload: {eventId: events[0].id}});
  await ctx.runner.queue.idle({timeoutMs: 10000});
  const enriched = ctx.runner.queue.get(enrich.id);
  assert.equal(enriched.state, 'succeeded');
  const event = ctx.eventStore.get(events[0].id);
  assert.match(event.venue, /上海新国际博览中心/);
  assert.match(event.city, /上海/);
  assert.equal(event.startDate, '2026-04-08');
  assert.match(event.organizer, /中国制冷学会/);
  assert.ok(event.documents.length >= 1);
  assert.equal(event.documents[0].status, 'downloadable');
  assert.ok(['enriched', 'verified'].includes(event.status));
 } finally {
  await ctx.runner.stop();
  rmSync(ctx.root, {recursive: true, force: true});
 }
});

test('the scheduler enqueues due sources exactly through the queue', async () => {
 const ctx = setup();
 try {
  const first = ctx.registry.create({url: 'https://expo.example/calendar', title: 'First source', type: 'organizer', region: 'cn', intervalSec: 60});
  const created = await ctx.runner.scheduler.tick();
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, 'source.collect');
  assert.equal(created[0].sourceId, first.id);

  const second = ctx.registry.create({url: 'https://expo.example/media', title: 'Second source', type: 'media', region: 'cn', intervalSec: 86400});
  const secondTick = await ctx.runner.scheduler.tick();
  assert.equal(secondTick.length, 2, 'dedupe returns the queued task plus the new one');
  assert.deepEqual(ctx.runner.queue.list({kind: 'source.collect'}).map(task => task.sourceId).sort(), [first.id, second.id].sort());

  // Further ticks must not create duplicates while both are queued.
  await ctx.runner.scheduler.tick();
  assert.equal(ctx.runner.queue.list({kind: 'source.collect'}).length, 2);
 } finally {
  await ctx.runner.stop();
  rmSync(ctx.root, {recursive: true, force: true});
 }
});
