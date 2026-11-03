import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 AVAILABILITIES,
 CONFIDENCE_LEVELS,
 EVENT_EXPORT_COLUMNS,
 EVENT_REGIONS,
 EVENT_STATUSES,
 openEventStore,
} from '../server/event-store.mjs';

const MARKET_EVENT_FIELDS = [
 'id', 'name', 'edition', 'startDate', 'endDate', 'city', 'province', 'district', 'country', 'venue', 'organizer', 'website',
 'frequency', 'industries', 'scope', 'exhibitorCount', 'visitorCount', 'area', 'exhibitorListUrl',
 'exhibitorListStatus', 'documents', 'competitors', 'applicationDeadline', 'boothPrice', 'ticketPrice',
 'region', 'sources', 'confidence', 'status', 'notes', 'createdAt', 'updatedAt',
];

const fixed = 1_800_000_000_000;

function tempScope() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-events-'));
 return {
  dir,
  file: join(dir, 'events.json'),
  cleanup() {
   rmSync(dir, {recursive: true, force: true});
  },
 };
}

test('upsert creates a complete MarketEvent with discovered defaults', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const {event, created} = store.upsert({name: ' 2026 中国制冷展 ', city: ' 上海 ', region: 'cn'});
  assert.equal(created, true);
  assert.deepEqual(Object.keys(event).sort(), MARKET_EVENT_FIELDS.slice().sort());
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  assert.equal(event.name, '2026 中国制冷展');
  assert.equal(event.city, '上海');
  assert.equal(event.region, 'cn');
  assert.equal(event.status, 'discovered');
  assert.equal(event.confidence, 'low');
  assert.equal(event.edition, null);
  assert.equal(event.startDate, null);
  assert.equal(event.endDate, null);
  assert.equal(event.applicationDeadline, null);
  assert.equal(event.exhibitorListStatus, 'unknown');
  assert.deepEqual(event.industries, []);
  assert.deepEqual(event.documents, []);
  assert.deepEqual(event.competitors, []);
  assert.deepEqual(event.sources, []);
  assert.deepEqual(event.notes, []);
  assert.equal(event.createdAt, new Date(fixed).toISOString());
  assert.equal(event.updatedAt, new Date(fixed).toISOString());
  assert.ok(EVENT_STATUSES.includes(event.status));
  assert.ok(CONFIDENCE_LEVELS.includes(event.confidence));
  assert.ok(EVENT_REGIONS.includes(event.region));
 }
 finally {
  scope.cleanup();
 }
});

test('upsert merges by normalised name + startDate + venue without downgrading', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const first = store.upsert({
   name: '2026中国制冷展',
   startDate: '2026-11-05',
   venue: '上海新国际博览中心',
   city: '上海',
   website: 'https://www.cr-expo.com/',
   sources: [{url: 'https://www.cr-expo.com/', title: '官网'}],
   documents: [{url: 'https://www.cr-expo.com/a.pdf', type: 'pdf', status: 'downloadable'}],
   notes: ['待确认展位价格'],
   confidence: 'low',
   status: 'discovered',
  });
  assert.equal(first.created, true);
  assert.equal(first.event.sources.length, 1);
  assert.match(first.event.sources[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);

  const second = store.upsert({
   name: ' 2026 中国制冷展 ',
   startDate: '2026-11-05',
   venue: '上海新国际博览中心 ',
   endDate: '2026-11-07',
   city: '上海',
   organizer: '中国制冷学会',
   sources: [
    {url: 'https://www.cr-expo.com/', title: '官网更新'},
    {url: 'https://www.cr-expo.com/news', title: '新闻'},
   ],
   documents: [
    {url: 'https://www.cr-expo.com/a.pdf', type: 'pdf', status: 'downloadable'},
    {url: 'https://www.cr-expo.com/b.pdf', type: 'pdf', status: 'downloadable'},
   ],
   notes: ['待确认展位价格', '日期来自主办方'],
   confidence: 'medium',
   status: 'enriched',
  });
  assert.equal(second.created, false);
  assert.equal(store.list().length, 1);
  assert.equal(second.event.id, first.event.id);
  assert.equal(second.event.endDate, '2026-11-07');
  assert.equal(second.event.organizer, '中国制冷学会');
  assert.equal(second.event.confidence, 'medium');
  assert.equal(second.event.status, 'enriched');
  assert.equal(second.event.sources.length, 2);
  assert.equal(second.event.sources[0].title, '官网');
  assert.equal(second.event.documents.length, 2);
  assert.deepEqual(second.event.notes, ['待确认展位价格', '日期来自主办方']);
  assert.ok(second.event.createdAt <= second.event.updatedAt);

  // Re-running discovery must not downgrade an enriched/verified event.
  const third = store.upsert({name: '2026中国制冷展', startDate: '2026-11-05', venue: '上海新国际博览中心', status: 'discovered', confidence: 'low'});
  assert.equal(third.event.status, 'enriched');
  assert.equal(third.event.confidence, 'medium');
 }
 finally {
  scope.cleanup();
 }
});

test('upsert keeps different dates and venues as separate events', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  store.upsert({name: '中国制冷展', startDate: '2026-11-05', venue: '上海新国际博览中心'});
  store.upsert({name: '中国制冷展', startDate: '2027-11-05', venue: '上海新国际博览中心'});
  store.upsert({name: '中国制冷展', startDate: '2026-11-05', venue: '国家会展中心（上海）'});
  assert.equal(store.list().length, 3);
 }
 finally {
  scope.cleanup();
 }
});

test('list filters by date range, region, status, keyword and limit', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  store.upsert({
   name: '中国制冷展', startDate: '2026-11-05', endDate: '2026-11-07', city: '上海',
   venue: '上海新国际博览中心', region: 'cn', status: 'verified', industries: ['制冷', '暖通空调'],
  });
  store.upsert({
   name: 'ISH Frankfurt', startDate: '2027-03-10', city: 'Frankfurt', venue: 'Messe Frankfurt',
   region: 'eu', status: 'discovered',
  });
  store.upsert({name: '待定展会', startDate: null, city: '深圳', region: 'cn'});

  assert.deepEqual(store.list({region: 'cn'}).map(event => event.name).sort(), ['中国制冷展', '待定展会']);
  assert.deepEqual(store.list({status: 'discovered'}).map(event => event.name).sort(), ['ISH Frankfurt', '待定展会']);
  assert.deepEqual(store.list({from: '2026-01-01', to: '2026-12-31'}).map(event => event.name), ['中国制冷展']);
  assert.deepEqual(store.list({to: '2026-12-31'}).map(event => event.name), ['中国制冷展']);
  assert.deepEqual(store.list({from: '2027-01-01'}).map(event => event.name), ['ISH Frankfurt']);
  // Events without a start date only appear when no time filter is given.
  assert.equal(store.list({q: '深圳'}).length, 1);
  assert.deepEqual(store.list({q: '制冷'}).map(event => event.name), ['中国制冷展']);
  assert.deepEqual(store.list({q: 'ish'}).map(event => event.name), ['ISH Frankfurt']);
  assert.deepEqual(store.list({q: '暖通'}).map(event => event.name), ['中国制冷展']);
  assert.equal(store.list({limit: 1}).length, 1);
  // Timeline order: earliest start date first.
  assert.equal(store.list()[0].name, '中国制冷展');
 }
 finally {
  scope.cleanup();
 }
});

test('patch validates every field group and timestamps source changes', () => {
 const scope = tempScope();
 try {
  let clock = fixed;
  const store = openEventStore({file: scope.file, now: () => clock});
  const {event} = store.upsert({name: '2026中国制冷展', startDate: '2026-11-05'});
  const createdAt = event.createdAt;

  clock += 60_000;
  const patched = store.patch(event.id, {
   city: '上海',
   endDate: '2026-11-07',
   industries: ['制冷', '暖通空调'],
   notes: ['待确认展位价格'],
   sources: [{url: 'https://www.cr-expo.com/', title: '官网'}],
  });
  assert.equal(patched.city, '上海');
  assert.equal(patched.endDate, '2026-11-07');
  assert.deepEqual(patched.industries, ['制冷', '暖通空调']);
  assert.deepEqual(patched.notes, ['待确认展位价格']);
  assert.equal(patched.sources[0].verifiedAt, new Date(clock).toISOString());
  assert.equal(patched.createdAt, createdAt);
  assert.equal(patched.updatedAt, new Date(clock).toISOString());

  const explicit = store.patch(event.id, {
   sources: [
    {url: 'https://www.cr-expo.com/', title: '官网', verifiedAt: '2026-01-02T03:04:05.000Z'},
    {url: 'https://www.cr-expo.com/', title: '重复项'},
    {url: 'https://www.cr-expo.com/news', title: '新闻'},
   ],
  });
  assert.equal(explicit.sources.length, 2);
  assert.equal(explicit.sources[0].verifiedAt, '2026-01-02T03:04:05.000Z');
  assert.match(explicit.sources[1].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.throws(() => store.patch(event.id, {startDate: '2026-13-01'}), /YYYY-MM-DD/);
  assert.throws(() => store.patch(event.id, {startDate: '2026-02-30'}), /YYYY-MM-DD/);
  assert.throws(() => store.patch(event.id, {status: 'sleeping'}), /Unknown status/);
  assert.throws(() => store.patch(event.id, {confidence: 'certain'}), /Unknown confidence/);
  assert.throws(() => store.patch(event.id, {region: 'mars'}), /Unknown region/);
  assert.throws(() => store.patch(event.id, {exhibitorListStatus: 'maybe'}), /Unknown exhibitorListStatus/);
  assert.throws(() => store.patch(event.id, {unknownField: 'x'}), /Unknown event field/);
  assert.throws(() => store.patch(event.id, {edition: 'abc'}), /non-negative integer/);
  assert.throws(() => store.patch(event.id, {industries: 'not-an-array'}), /array of strings/);
  assert.throws(() => store.patch(event.id, {sources: [{url: 'ftp://example.com/x'}]}), /Invalid source URL/);
  assert.throws(() => store.patch(event.id, {name: ''}), /cannot be empty/);
  assert.throws(() => store.patch(event.id, {id: 'x'}), /read-only/);
  assert.throws(() => store.patch(event.id, {createdAt: 'x'}), /read-only/);
  assert.throws(() => store.patch('00000000-0000-4000-8000-000000000000', {city: '上海'}), /not found/i);

  // Clearing a date with null is allowed.
  const cleared = store.patch(event.id, {endDate: null});
  assert.equal(cleared.endDate, null);
  assert.equal(cleared.edition, null);
 }
 finally {
  scope.cleanup();
 }
});

test('exportRows keeps the contract column order and list values', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  store.upsert({
   name: '2026中国制冷展', startDate: '2026-11-05', city: '上海', venue: '上海新国际博览中心',
   industries: ['制冷', '暖通空调'], notes: ['待确认展位价格'],
   sources: [{url: 'https://www.cr-expo.com/', title: '官网'}],
  });
  store.upsert({name: '2027中国国际电机博览会', startDate: '2027-05-01'});

  const rows = store.exportRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), EVENT_EXPORT_COLUMNS);
  assert.deepEqual(Object.keys(rows[1]), EVENT_EXPORT_COLUMNS);
  assert.equal(rows[0].name, '2026中国制冷展');
  assert.equal(rows[0].startDate, '2026-11-05');
  assert.equal(rows[0].city, '上海');
  assert.deepEqual(rows[0].industries, ['制冷', '暖通空调']);
  assert.deepEqual(rows[0].notes, ['待确认展位价格']);
  assert.deepEqual(rows[0].sources.map(source => source.url), ['https://www.cr-expo.com/']);
  assert.equal(rows[0].venue, '上海新国际博览中心');
  assert.equal(rows[0].edition, '');
  assert.ok(AVAILABILITIES.includes(rows[0].exhibitorListStatus));
  assert.equal(rows[1].name, '2027中国国际电机博览会');
 }
 finally {
  scope.cleanup();
 }
});

test('stats counts statuses, regions, confidence and dated events', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const a = store.upsert({name: 'A 展', startDate: '2026-11-05', region: 'cn', country: 'China'});
  store.upsert({name: 'B 展', startDate: '2027-01-01', region: 'eu'});
  store.upsert({name: 'C 展', startDate: null, region: 'global'});
  store.patch(a.event.id, {status: 'verified', confidence: 'high'});

  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.verified, 1);
  assert.equal(stats.discovered, 2);
  assert.equal(stats.cn, 1);
  assert.equal(stats.eu, 1);
  assert.equal(stats.global, 1);
  assert.equal(stats.high, 1);
  assert.equal(stats.low, 2);
  assert.equal(stats.withDates, 2);
  assert.equal(stats.withoutDates, 1);
 }
 finally {
  scope.cleanup();
 }
});

test('persists events across reopen and keeps the merge identity', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const created = store.upsert({name: '2026中国制冷展', startDate: '2026-11-05', venue: '上海新国际博览中心'});
  const raw = JSON.parse(readFileSync(scope.file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.events.length, 1);

  const reopened = openEventStore({file: scope.file, now: () => fixed + 1000});
  assert.equal(reopened.list().length, 1);
  const merged = reopened.upsert({name: '2026中国制冷展', startDate: '2026-11-05', venue: '上海新国际博览中心', city: '上海'});
  assert.equal(merged.created, false);
  assert.equal(merged.event.id, created.event.id);
  assert.equal(merged.event.city, '上海');
  assert.equal(reopened.list().length, 1);
 }
 finally {
  scope.cleanup();
 }
});

test('upsert merges name variants that share the official website host', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const first = store.upsert({
   name: 'China Refrigeration (中国制冷展)',
   website: 'https://www.cr-expo.com/',
   startDate: '2026-11-05',
   city: 'Shanghai',
  });
  assert.equal(first.created, true);

  // Protocol and "www." are not event identity: same host + same date merges.
  const second = store.upsert({name: 'China Refrigeration (CRH)', website: 'http://cr-expo.com/news', startDate: '2026-11-05'});
  assert.equal(second.created, false);
  assert.equal(second.event.id, first.event.id);
  assert.equal(store.list().length, 1);
  assert.equal(second.event.name, 'China Refrigeration (中国制冷展)');
  assert.ok(second.event.notes.includes('别名：China Refrigeration (CRH)'));

  // A third alias without a date also merges (one side null is compatible).
  const third = store.upsert({name: 'CRH 2026', website: 'https://www.cr-expo.com/exhibitions'});
  assert.equal(third.created, false);
  assert.equal(store.list().length, 1);
  assert.equal(third.event.startDate, '2026-11-05');
  assert.ok(third.event.notes.includes('别名：CRH 2026'));
 }
 finally {
  scope.cleanup();
 }
});

test('upsert keeps two known different editions on the same website separate', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  store.upsert({name: 'China Refrigeration 2025', website: 'https://www.cr-expo.com/', startDate: '2025-04-08'});
  store.upsert({name: 'China Refrigeration 2026', website: 'https://www.cr-expo.com/', startDate: '2026-04-08'});
  assert.equal(store.list().length, 2);
 }
 finally {
  scope.cleanup();
 }
});

test('upsert decodes HTML entities in websites and source URLs', () => {
 const scope = tempScope();
 try {
  const store = openEventStore({file: scope.file, now: () => fixed});
  const {event} = store.upsert({
   name: '实体编码展会',
   website: 'https://example.com/expo?year=2026&amp;lang=zh',
   sources: [{url: 'https://example.com/list.aspx?id=2026&amp;zhid=21', title: '名单'}],
  });
  assert.equal(event.website, 'https://example.com/expo?year=2026&lang=zh');
  assert.equal(event.sources[0].url, 'https://example.com/list.aspx?id=2026&zhid=21');

  const patched = store.patch(event.id, {
   sources: [{url: 'https://example.com/list.aspx?id=2026&#38;zhid=21', title: '名单'}],
  });
  assert.equal(patched.sources[0].url, 'https://example.com/list.aspx?id=2026&zhid=21');
 }
 finally {
  scope.cleanup();
 }
});
