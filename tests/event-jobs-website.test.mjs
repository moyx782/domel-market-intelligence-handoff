// Enrichment test: discovered events often have no website. Enrichment asks a
// web-search adapter for candidate official pages, fetches them and only accepts
// a page as the event website when the page itself matches the event name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventStore} from '../server/event-store.mjs';
import {createEventJobs} from '../server/event-jobs.mjs';
import {openGeoIndex} from '../server/geo.mjs';

const GEO = openGeoIndex({file: join(process.cwd(), 'seed', 'geo-cn.json')});

const NAME = '中国国际流体机械展览会 (China International Fluid Machinery Exhibition)';

const OFFICIAL_HTML = `<html><head><title>中国国际流体机械展览会 China International Fluid Machinery Exhibition</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Event","name":"中国国际流体机械展览会","startDate":"2027-05-10","endDate":"2027-05-12","url":"https://www.fluidmachineryexpo.com/","location":{"@type":"Place","name":"国家会展中心（上海）","address":{"@type":"PostalAddress","addressLocality":"上海","addressCountry":"CN"}},"organizer":{"@type":"Organization","name":"中国通用机械工业协会"}}</script>
</head><body><h1>中国国际流体机械展览会</h1><p>2027-05-10 至 2027-05-12 国家会展中心（上海）</p></body></html>`;

function collectorFor(html, title = '中国国际流体机械展览会') {
 return {
  calls: [],
  async collect(url) {
   this.calls.push(url);
   return {
    ok: true, url, finalUrl: url, status: 200, engine: 'http',
    title, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), html,
    contentType: 'text/html', bytes: html.length, fetchedAt: new Date().toISOString(),
    robots: {allowed: true, crawlDelayMs: 0},
   };
  },
  async probe() { return {ok: true, status: 200, availability: 'unknown'}; },
 };
}

function makeJobs({webSearch}) {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-website-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const jobs = createEventJobs({eventStore, collector: collectorFor(OFFICIAL_HTML), search: null, webSearch, geo: GEO, now: () => Date.parse('2026-11-03T12:00:00Z')});
 const {event} = eventStore.upsert({name: NAME, region: 'cn', city: '上海'});
 return {
  eventStore,
  event,
  async enrich() {
   const updates = [];
   const result = await jobs['event.enrich']({
    task: {id: 't1', kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
    signal: new AbortController().signal,
    update: async changes => updates.push(changes),
    log: async () => {},
   });
   return {result, updates};
  },
  close() { rmSync(root, {recursive: true, force: true}); },
 };
}

test('enrichment searches for the official website and fills obvious fields', async () => {
 const ctx = makeJobs({
  webSearch: async () => [
   {url: 'https://www.baidu.com/s?wd=fluid', title: '百度搜索结果'},
   {url: 'https://portal.example/list', title: '行业门户'},
   {url: 'https://www.fluidmachineryexpo.com/', title: '中国国际流体机械展览会 官网'},
  ],
 });
 try {
  const {result} = await ctx.enrich();
  const event = ctx.eventStore.get(ctx.event.id);
  assert.equal(result.collected, 1);
  assert.equal(event.website, 'https://www.fluidmachineryexpo.com/');
  assert.equal(event.country, '中国');
  assert.equal(event.province, '上海市');
  assert.equal(event.startDate, '2027-05-10');
  assert.equal(event.endDate, '2027-05-12');
  assert.match(event.venue, /国家会展中心/);
  assert.match(event.organizer, /中国通用机械工业协会/);
  assert.ok(event.sources.some(source => source.url === 'https://www.fluidmachineryexpo.com/'));
  assert.ok(!event.notes.join('\n').includes('未找到官网链接'));
  // The collector only fetched official candidates, never the aggregator.
  assert.ok(!JSON.stringify(ctx).includes('fetch'));
 } finally {
  ctx.close();
 }
});

test('a fetched page that does not match the event is not claimed as its website', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-website-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const collector = collectorFor('<html><head><title>Unrelated portal</title></head><body><p>welcome</p></body></html>', 'Unrelated portal');
 const jobs = createEventJobs({
  eventStore,
  collector,
  search: null,
  webSearch: async () => [{url: 'https://portal.example/listing', title: '展会网站'}],
  geo: GEO,
  now: () => Date.parse('2026-11-03T12:00:00Z'),
 });
 const {event} = eventStore.upsert({name: NAME, region: 'cn', city: '上海'});
 try {
  const result = await jobs['event.enrich']({
   task: {id: 't2', kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
   signal: new AbortController().signal,
   update: async () => {},
   log: async () => {},
  });
  const updated = eventStore.get(event.id);
  assert.equal(updated.website, '');
  assert.ok(updated.notes.join('\n').includes('官网候选（待人工确认）：https://portal.example/listing'));
  assert.equal(result.collected, 1);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('a failing web search falls back to the explicit missing-source note', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-website-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const jobs = createEventJobs({
  eventStore,
  collector: collectorFor(OFFICIAL_HTML),
  search: null,
  webSearch: async () => { throw Error('search provider unavailable'); },
  geo: GEO,
  now: () => Date.parse('2026-11-03T12:00:00Z'),
 });
 const {event} = eventStore.upsert({name: NAME, region: 'cn', city: '上海'});
 try {
  const result = await jobs['event.enrich']({
   task: {id: 't3', kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
   signal: new AbortController().signal,
   update: async () => {},
   log: async () => {},
  });
  const updated = eventStore.get(event.id);
  assert.equal(result.collected, 0);
  assert.ok(updated.notes.includes('缺少可核验的官网或来源链接'));
  assert.equal(updated.website, '');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('a strong search candidate is shown as the website when the site cannot be fetched', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-website-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const jobs = createEventJobs({
  eventStore,
  collector: {
   async collect(url) {
    return {ok: false, url, error: {code: 'NETWORK', message: 'Network error', permanent: false}};
   },
   async probe() { return {ok: false, availability: 'unknown'}; },
  },
  search: null,
  webSearch: async () => [{url: 'https://www.fluidmachineryexpo.com/', title: '中国国际流体机械展览会 官网'}],
  geo: GEO,
  now: () => Date.parse('2026-11-03T12:00:00Z'),
 });
 const {event} = eventStore.upsert({name: '中国国际流体机械展览会', region: 'cn', city: '上海'});
 try {
  await jobs['event.enrich']({
   task: {id: 't4', kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
   signal: new AbortController().signal,
   update: async () => {},
   log: async () => {},
  });
  const updated = eventStore.get(event.id);
  assert.equal(updated.website, 'https://www.fluidmachineryexpo.com/');
  assert.ok(updated.notes.join('\n').includes('官网链接来自搜索候选，待人工核验'));
  assert.equal(updated.country, '中国');
  assert.equal(updated.province, '上海市');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
