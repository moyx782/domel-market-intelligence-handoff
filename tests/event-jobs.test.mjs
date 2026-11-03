import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventStore} from '../server/event-store.mjs';
import {createEventJobs} from '../server/event-jobs.mjs';

const fixed = Date.parse('2026-06-01T00:00:00.000Z');

function fixture(name) {
 return readFileSync(new URL(`./fixtures/events/${name}`, import.meta.url), 'utf8');
}

function tempEventScope() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-event-jobs-'));
 return {
  dir,
  file: join(dir, 'events.json'),
  cleanup() {
   rmSync(dir, {recursive: true, force: true});
  },
 };
}

function makeCtx(payload = {}, extra = {}) {
 const updates = [];
 const logs = [];
 const controller = new AbortController();
 const task = {id: 'task-1', kind: extra.kind ?? 'event.discover', eventId: payload.eventId ?? null, payload};
 return {
  ctx: {
   task,
   signal: controller.signal,
   update: async changes => { updates.push(structuredClone(changes)); },
   log: async (message, level = 'info') => { logs.push({message, level}); },
  },
  updates,
  logs,
  controller,
 };
}

function fakeSearch(handler) {
 const calls = [];
 const search = async input => {
  calls.push({...input});
  return handler(input);
 };
 search.calls = calls;
 return search;
}

// Fake collector: pages is a URL -> {title, html, text, finalUrl} map. Unknown
// URLs fail like an offline network so tests can cover partial failure.
function pageCollector(pages) {
 const collectCalls = [];
 const probeCalls = [];
 return {
  collectCalls,
  probeCalls,
  async collect(url, options = {}) {
   collectCalls.push({url, options});
   const page = pages[url];
   if (typeof page === 'function') return page(url, options);
   if (!page) return {ok: false, url, error: {code: 'NETWORK', message: 'offline in test'}};
   return {
    ok: true,
    url,
    finalUrl: page.finalUrl ?? url,
    title: page.title ?? '',
    html: page.html ?? '',
    text: page.text ?? '',
    status: 200,
    engine: 'http',
    contentType: 'text/html',
    bytes: (page.html ?? '').length,
    fetchedAt: new Date(fixed).toISOString(),
    robots: {allowed: true, crawlDelayMs: 0},
   };
  },
  async probe(url, options = {}) {
   probeCalls.push({url, options});
   if (/restricted|forbidden/i.test(url)) {
    return {ok: false, status: 403, contentType: 'application/pdf', contentLength: 0, availability: 'restricted'};
   }
   if (/\.pdf($|[?#])/i.test(url)) {
    return {ok: true, status: 200, contentType: 'application/pdf', contentLength: 2048, availability: 'downloadable'};
   }
   return {ok: true, status: 200, contentType: 'text/html', contentLength: 512, availability: 'unknown'};
  },
 };
}

test('event.discover upserts candidates, merges duplicates and reports progress', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const candidates = [
   {name: '2026中国制冷展', city: '上海', venue: '上海新国际博览中心', startDate: '2026-11-05', endDate: '2026-11-07', website: 'https://www.cr-expo.com/', sourceUrl: 'https://www.cr-expo.com/news', industries: ['制冷', '暖通'], confidence: 'medium'},
   {name: ' 2026 中国制冷展 ', startDate: '2026-11-05', venue: '上海新国际博览中心 ', city: '上海'},
   {name: '2027中国国际电机博览会', city: '上海', website: 'https://www.motor-expo.com/', confidence: 'low'},
  ];
  const search = fakeSearch(async ({limit}) => candidates.slice(0, limit));
  const jobs = createEventJobs({eventStore, search, now: () => fixed});
  const {ctx, updates, logs} = makeCtx({region: 'cn', query: '中国制冷展 2026', limit: 10});
  const result = await jobs['event.discover'](ctx);

  assert.equal(result.region, 'cn');
  assert.equal(result.candidates, 3);
  assert.equal(result.created, 2);
  assert.equal(result.merged, 1);
  assert.ok(Array.isArray(result.queries) && result.queries.length > 0);
  assert.equal(search.calls.length, 1);
  assert.equal(search.calls[0].region, 'cn');
  assert.ok(updates.length >= 2);
  assert.ok(updates.every(update => typeof update.progress === 'string'));
  assert.ok(logs.some(entry => /Discovered/.test(entry.message)));

  const events = eventStore.list();
  assert.equal(events.length, 2);
  const expo = events.find(event => event.name.includes('制冷展'));
  assert.equal(expo.city, '上海');
  assert.equal(expo.status, 'discovered');
  assert.equal(expo.confidence, 'medium');
  assert.deepEqual(expo.sources.map(source => source.url), ['https://www.cr-expo.com/news']);
  const motor = events.find(event => event.name.includes('电机'));
  assert.equal(motor.website, 'https://www.motor-expo.com/');
 }
 finally {
  scope.cleanup();
 }
});

test('event.discover honours an explicit payload query and logs no-result as a warning', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const search = fakeSearch(async () => []);
  const jobs = createEventJobs({eventStore, search, now: () => fixed});
  const {ctx, logs} = makeCtx({region: 'cn', query: '中国制冷展 2026', limit: 5});
  const result = await jobs['event.discover'](ctx);

  assert.deepEqual(result.queries, ['中国制冷展 2026']);
  assert.equal(result.candidates, 0);
  assert.equal(result.created, 0);
  assert.equal(result.merged, 0);
  assert.deepEqual(result.region, 'cn');
  assert.deepEqual(search.calls, [{query: '中国制冷展 2026', region: 'cn', limit: 5, signal: search.calls[0].signal}]);
  assert.ok(logs.some(entry => entry.level === 'warn' && /No event candidates/.test(entry.message)));
  assert.equal(eventStore.list().length, 0);
 }
 finally {
  scope.cleanup();
 }
});

test('event.discover uses the injected query builder when no query is given', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const search = fakeSearch(async () => []);
  const jobs = createEventJobs({eventStore, search, now: () => fixed, queries: () => ['q-one', 'q-two']});
  const {ctx} = makeCtx({region: 'cn'});
  const result = await jobs['event.discover'](ctx);
  assert.deepEqual(search.calls.map(call => call.query), ['q-one', 'q-two']);
  assert.deepEqual(result.queries, ['q-one', 'q-two']);
 }
 finally {
  scope.cleanup();
 }
});

test('event.discover keeps transient search failures retryable and permanent ones permanent', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const transient = fakeSearch(async () => { throw Error('provider 503 unavailable'); });
  const retryableJobs = createEventJobs({eventStore, search: transient, now: () => fixed});
  const retryCtx = makeCtx({region: 'cn', query: 'x'});
  await assert.rejects(retryableJobs['event.discover'](retryCtx.ctx), error => {
   assert.match(error.message, /provider 503/);
   assert.notEqual(error.permanent, true);
   return true;
  });

  const permanentError = Error('bad api key');
  permanentError.permanent = true;
  const permanent = fakeSearch(async () => { throw permanentError; });
  const permanentJobs = createEventJobs({eventStore, search: permanent, now: () => fixed});
  const permanentCtx = makeCtx({region: 'cn', query: 'x'});
  await assert.rejects(permanentJobs['event.discover'](permanentCtx.ctx), error => {
   assert.match(error.message, /bad api key/);
   assert.equal(error.permanent, true);
   return true;
  });
 }
 finally {
  scope.cleanup();
 }
});

test('event.discover stops on an aborted signal without retrying', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const search = fakeSearch(async () => []);
  const jobs = createEventJobs({eventStore, search, now: () => fixed});
  const {ctx, controller} = makeCtx({region: 'cn', query: 'x'});
  controller.abort();
  await assert.rejects(jobs['event.discover'](ctx), error => {
   assert.equal(error.permanent, true);
   assert.match(error.message, /Cancelled/);
   return true;
  });
  assert.equal(search.calls.length, 0);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich extracts JSON-LD fields, documents and exhibitor list', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '2026中国制冷展', website: 'https://www.cr-expo.com/'});
  const collector = pageCollector({
   'https://www.cr-expo.com/': {
    title: '2026中国制冷展 - 官方网站',
    html: fixture('event-jsonld-complete.html'),
   },
  });
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx, updates} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);

  assert.equal(result.eventId, created.event.id);
  assert.equal(result.collected, 1);
  for (const field of ['startDate', 'endDate', 'city', 'country', 'venue', 'organizer', 'applicationDeadline', 'boothPrice', 'industries', 'documents', 'exhibitorListUrl']) {
   assert.ok(result.fields.includes(field), `expected fields to include ${field}`);
  }
  assert.ok(updates.some(update => typeof update.progress === 'string'));

  const saved = eventStore.get(created.event.id);
  assert.equal(saved.startDate, '2026-11-05');
  assert.equal(saved.endDate, '2026-11-07');
  assert.equal(saved.city, '上海');
  assert.equal(saved.country, 'China');
  assert.equal(saved.venue, '上海新国际博览中心');
  assert.equal(saved.organizer, '中国制冷学会');
  assert.equal(saved.applicationDeadline, '2026-10-15');
  assert.match(saved.boothPrice, /12,000/);
  assert.ok(saved.industries.includes('制冷'));
  assert.equal(saved.status, 'verified');
  assert.equal(saved.confidence, 'high');
  assert.equal(saved.documents.length, 2);
  assert.deepEqual(saved.documents.map(document => document.status), ['downloadable', 'downloadable']);
  // HTML entities in href attributes must be decoded into usable URLs.
  assert.equal(saved.exhibitorListUrl, 'https://www.cr-expo.com/visitor/exhibitor-list?year=2026&lang=zh');
  assert.ok(saved.documents.some(document => document.url === 'https://www.cr-expo.com/files/2026-brochure.pdf?year=2026&dl=1'));
  assert.equal(saved.exhibitorListStatus, 'linked');
  assert.deepEqual(saved.sources.map(source => source.url), ['https://www.cr-expo.com/']);
  assert.match(saved.sources[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.notes.includes('未找到报名截止日期'), false);
  assert.deepEqual(result.notes, []);
  // Two document PDFs plus the exhibitor list page were probed.
  assert.equal(collector.probeCalls.length, 3);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich passes approved recipes to the collector by domain', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '2026中国制冷展', website: 'https://www.cr-expo.com/'});
  const collector = pageCollector({
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  });
  const recipe = {id: 'recipe-1', domain: 'www.cr-expo.com', kind: 'regex', body: '{}', status: 'approved'};
  const domains = [];
  const jobs = createEventJobs({
   eventStore,
   collector,
   now: () => fixed,
   getRecipe: domain => {
    domains.push(domain);
    return recipe;
   },
  });
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);
  assert.equal(result.collected, 1);
  assert.deepEqual(domains, ['www.cr-expo.com']);
  assert.deepEqual(collector.collectCalls[0].options.recipe, recipe);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich writes Chinese notes for missing dates and venue', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '2027中国国际电机博览会', website: 'https://www.motor-expo.com/'});
  const collector = pageCollector({
   'https://www.motor-expo.com/': {title: '2027中国国际电机博览会', html: fixture('event-missing-date.html')},
  });
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);

  assert.equal(result.collected, 1);
  assert.ok(result.notes.includes('未找到展会开始日期'));
  assert.ok(result.notes.includes('未找到展会结束日期'));
  assert.ok(result.notes.includes('未找到报名截止日期'));
  assert.ok(result.notes.includes('展馆待确认'));

  const saved = eventStore.get(created.event.id);
  assert.equal(saved.startDate, null);
  assert.equal(saved.endDate, null);
  assert.equal(saved.city, '上海');
  assert.equal(saved.status, 'enriched');
  assert.equal(saved.confidence, 'medium');
  assert.ok(saved.notes.includes('未找到报名截止日期'));
  assert.ok(saved.notes.includes('展馆待确认'));
  // Website was already known, so no "missing official site" note.
  assert.equal(saved.notes.includes('未找到官网链接'), false);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich classifies document links and the exhibitor list with probe', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '2026中国国际工业博览会', website: 'https://www.ciif-expo.com/'});
  const collector = pageCollector({
   'https://www.ciif-expo.com/': {title: '2026中国国际工业博览会 - 下载中心', html: fixture('event-docs.html')},
  });
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);

  assert.equal(result.collected, 1);
  const saved = eventStore.get(created.event.id);
  assert.equal(saved.startDate, '2026-09-15');
  assert.equal(saved.endDate, '2026-09-19');
  assert.equal(saved.venue, '国家会展中心（上海）');
  assert.equal(saved.city, '上海');
  assert.equal(saved.organizer, '中国工业经济联合会');
  assert.equal(saved.documents.length, 2);
  const byUrl = Object.fromEntries(saved.documents.map(document => [document.url, document]));
  assert.equal(byUrl['https://www.ciif-expo.com/files/2026-ciif-brochure.pdf'].status, 'downloadable');
  assert.equal(byUrl['https://www.ciif-expo.com/files/restricted-price.pdf'].status, 'restricted');
  assert.equal(saved.exhibitorListUrl, 'https://www.ciif-expo.com/files/exhibitor-list.pdf');
  assert.equal(saved.exhibitorListStatus, 'downloadable');
  assert.equal(saved.status, 'enriched');
  assert.equal(saved.confidence, 'medium');
  assert.ok(result.notes.includes('未找到报名截止日期'));
  assert.ok(result.fields.includes('documents'));
  assert.ok(result.fields.includes('exhibitorListUrl'));
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich keeps going when one candidate page fails', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({
   name: '2026中国制冷展',
   website: 'https://www.cr-expo.com/',
   sources: [{url: 'https://broken.example.com/news', title: '失效来源'}],
  });
  const collector = pageCollector({
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  });
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx, logs} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);
  assert.equal(result.collected, 1);
  assert.equal(collector.collectCalls.length, 2);
  assert.ok(logs.some(entry => entry.level === 'warn' && /broken\.example\.com/.test(entry.message)));
  assert.equal(eventStore.get(created.event.id).startDate, '2026-11-05');
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich reports collection failure with a note instead of failing the task', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '无法访问的展会', website: 'https://blocked.example.com/'});
  const collector = pageCollector({});
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx, logs} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);

  assert.equal(result.collected, 0);
  assert.deepEqual(result.fields, []);
  assert.ok(result.notes.includes('未能采集官网或来源页面，待人工补充'));
  assert.ok(logs.some(entry => entry.level === 'warn'));
  const saved = eventStore.get(created.event.id);
  assert.equal(saved.status, 'discovered');
  assert.ok(saved.notes.includes('未能采集官网或来源页面，待人工补充'));
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich without candidate URLs records a note', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '没有链接的展会'});
  const jobs = createEventJobs({eventStore, collector: pageCollector({}), now: () => fixed});
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);
  assert.equal(result.collected, 0);
  assert.deepEqual(result.fields, []);
  assert.deepEqual(result.notes, ['缺少可核验的官网或来源链接']);
  assert.deepEqual(eventStore.get(created.event.id).notes, ['缺少可核验的官网或来源链接']);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich is idempotent for sources, documents and notes', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const created = eventStore.upsert({name: '2026中国制冷展', website: 'https://www.cr-expo.com/'});
  const collector = pageCollector({
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  });
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const first = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  await jobs['event.enrich'](first.ctx);
  const afterFirst = eventStore.get(created.event.id);

  const second = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](second.ctx);
  const afterSecond = eventStore.get(created.event.id);

  assert.equal(result.collected, 1);
  assert.deepEqual(result.notes, []);
  assert.equal(afterSecond.sources.length, afterFirst.sources.length);
  assert.equal(afterSecond.documents.length, afterFirst.documents.length);
  assert.deepEqual(afterSecond.notes, afterFirst.notes);
  assert.equal(afterSecond.status, 'verified');
  assert.equal(afterSecond.startDate, '2026-11-05');
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich rejects missing and unknown events with a permanent error', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const jobs = createEventJobs({eventStore, collector: pageCollector({}), now: () => fixed});

  const missingPayload = makeCtx({}, {kind: 'event.enrich'});
  await assert.rejects(jobs['event.enrich'](missingPayload.ctx), error => {
   assert.equal(error.permanent, true);
   assert.match(error.message, /eventId/);
   return true;
  });

  const unknown = makeCtx({eventId: '00000000-0000-4000-8000-000000000000'}, {kind: 'event.enrich'});
  await assert.rejects(jobs['event.enrich'](unknown.ctx), error => {
   assert.equal(error.permanent, true);
   assert.match(error.message, /Event not found/);
   return true;
  });
 }
 finally {
  scope.cleanup();
 }
});

test('discover then enrich completes the M3c event flow', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const collector = pageCollector({
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  });
  const search = fakeSearch(async () => [
   {name: '2026中国制冷展', city: '上海', startDate: '2026-11-05', website: 'https://www.cr-expo.com/', confidence: 'medium'},
  ]);
  const jobs = createEventJobs({eventStore, collector, search, now: () => fixed});

  const discoverCtx = makeCtx({region: 'cn', query: '中国制冷展'});
  const discovered = await jobs['event.discover'](discoverCtx.ctx);
  assert.equal(discovered.created, 1);
  const [event] = eventStore.list();
  assert.equal(event.status, 'discovered');

  const enrichCtx = makeCtx({eventId: event.id}, {kind: 'event.enrich'});
  const enriched = await jobs['event.enrich'](enrichCtx.ctx);
  assert.equal(enriched.collected, 1);
  const saved = eventStore.get(event.id);
  assert.equal(saved.status, 'verified');
  assert.equal(saved.applicationDeadline, '2026-10-15');
  assert.equal(eventStore.stats().verified, 1);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich flags a past edition instead of treating it as upcoming', async () => {
 const scope = tempEventScope();
 // The page still shows the 2026 edition although "today" is already 2027.
 const pastNow = Date.parse('2027-01-15T00:00:00.000Z');
 try {
  const eventStore = openEventStore({file: scope.file, now: () => pastNow});
  const created = eventStore.upsert({name: '2026中国制冷展', website: 'https://www.cr-expo.com/'});
  const collector = pageCollector({
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  });
  const jobs = createEventJobs({eventStore, collector, now: () => pastNow});
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  const result = await jobs['event.enrich'](ctx);

  assert.equal(result.collected, 1);
  const pastNote = result.notes.find(note => /上一届/.test(note));
  assert.ok(pastNote, 'expected a past-edition note');
  assert.match(pastNote, /2026-11-05 至 2026-11-07/);

  const saved = eventStore.get(created.event.id);
  // The verifiable date is kept, but the event is not presented as upcoming.
  assert.equal(saved.startDate, '2026-11-05');
  assert.equal(saved.endDate, '2026-11-07');
  assert.equal(saved.status, 'enriched');
  assert.notEqual(saved.confidence, 'high');
  assert.ok(saved.notes.some(note => /上一届/.test(note)));

  // Re-running enrich must not duplicate the note.
  const second = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  await jobs['event.enrich'](second.ctx);
  const after = eventStore.get(created.event.id);
  assert.equal(after.notes.filter(note => /上一届/.test(note)).length, 1);
 }
 finally {
  scope.cleanup();
 }
});

test('event.enrich bounds how many candidate pages one run collects', async () => {
 const scope = tempEventScope();
 try {
  const eventStore = openEventStore({file: scope.file, now: () => fixed});
  const sources = Array.from({length: 8}, (_, index) => ({
   url: `https://www.cr-expo.com/list-${index}.html`,
   title: `列表页 ${index}`,
  }));
  const created = eventStore.upsert({name: '2026中国制冷展', website: 'https://www.cr-expo.com/', sources});
  const pages = {
   'https://www.cr-expo.com/': {title: '2026中国制冷展 - 官方网站', html: fixture('event-jsonld-complete.html')},
  };
  for (const source of sources) pages[source.url] = {title: '列表页', html: '<html><body><p>暂无展会信息</p></body></html>'};
  const collector = pageCollector(pages);
  const jobs = createEventJobs({eventStore, collector, now: () => fixed});
  const {ctx} = makeCtx({eventId: created.event.id}, {kind: 'event.enrich'});
  await jobs['event.enrich'](ctx);
  // MAX_COLLECT_URLS caps one enrich run at six pages (website + up to five sources).
  assert.ok(collector.collectCalls.length <= 6, `collected ${collector.collectCalls.length} pages`);
  assert.equal(collector.collectCalls[0].url, 'https://www.cr-expo.com/');
 }
 finally {
  scope.cleanup();
 }
});
