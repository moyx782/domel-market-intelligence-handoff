import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC, SOURCE_TYPES, openSourceRegistry} from '../server/source-registry.mjs';

function tempScope() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-sources-'));
 return {
  dir,
  file: join(dir, 'source-registry.json'),
  cleanup() {
   rmSync(dir, {recursive: true, force: true});
  },
 };
}

function writeSeed(dir, sources) {
 const file = join(dir, 'seed-sources.json');
 writeFileSync(file, JSON.stringify({sources}));
 return file;
}

function sourceInput(overrides = {}) {
 return {
  url: 'https://www.example.com/exhibitions',
  title: '示例展会官网',
  type: 'organizer',
  region: 'cn',
  priority: 2,
  intervalSec: 3600,
  ...overrides,
 };
}

function readRegistryFile(file) {
 return JSON.parse(readFileSync(file, 'utf8'));
}

test('imports the curated seed once when the registry is empty', () => {
 const scope = tempScope();
 try {
  const seedFile = writeSeed(scope.dir, [
   {url: 'https://www.cr-expo.com/', title: '中国制冷展', type: 'organizer', region: 'cn', priority: 3, intervalSec: 43200},
   {url: 'https://www.neccsh.com/', title: '国家会展中心（上海）', type: 'venue', region: 'cn', priority: 2, intervalSec: 86400},
  ]);
  const registry = openSourceRegistry({file: scope.file, seedFile});
  const sources = registry.list();
  assert.equal(sources.length, 2);
  assert.equal(registry.seedImported, 2);
  for (const source of sources) {
   assert.match(source.id, /^[0-9a-f-]{36}$/);
   assert.equal(source.enabled, true);
   assert.equal(source.status, 'idle');
   assert.equal(source.discoveredBy, 'human');
   assert.equal(source.lastRunAt, null);
   assert.equal(source.nextRunAt, null);
   assert.equal(source.lastError, null);
   assert.ok(source.domain);
   assert.match(source.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(sources.map(source => source.priority).sort((a, b) => b - a), [3, 2]);
  const stored = readRegistryFile(scope.file);
  assert.equal(stored.version, 1);
  assert.equal(stored.sources.length, 2);
  assert.equal(typeof stored.domains['www.cr-expo.com'], 'object');

  // Re-opening must not import the seed a second time.
  const reopened = openSourceRegistry({file: scope.file, seedFile});
  assert.equal(reopened.list().length, 2);
 }
 finally {
  scope.cleanup();
 }
});

test('skips invalid seed entries instead of failing to start', () => {
 const scope = tempScope();
 try {
  const seedFile = writeSeed(scope.dir, [
   {url: 'ftp://example.com/file', title: 'bad protocol', type: 'site', region: 'cn', priority: 1, intervalSec: 3600},
   {url: 'https://example.com/no-interval', title: 'too short', type: 'site', region: 'cn', priority: 1, intervalSec: 29},
   {url: 'https://example.com/unknown-type', title: 'bad type', type: 'billboard', region: 'cn', priority: 1, intervalSec: 3600},
   {url: 'https://example.com/good', title: 'good', type: 'site', region: 'cn', priority: 1, intervalSec: 3600},
  ]);
  const registry = openSourceRegistry({file: scope.file, seedFile});
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].url, 'https://example.com/good');
 }
 finally {
  scope.cleanup();
 }
});

test('create validates url, uniqueness, enum, priority and interval', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  const source = registry.create(sourceInput());
  assert.equal(source.url, 'https://www.example.com/exhibitions');
  assert.equal(source.domain, 'www.example.com');
  assert.equal(source.intervalSec, 3600);
  assert.equal(source.type, 'organizer');

  assert.throws(() => registry.create(sourceInput({url: 'not-a-url'})), /Invalid source URL/);
  assert.throws(() => registry.create(sourceInput({url: 'ftp://example.com/x'})), /http\(s\)/);
  assert.throws(() => registry.create(sourceInput({url: 'https://www.example.com/exhibitions#section'})), /already registered/);
  assert.throws(() => registry.create(sourceInput({url: 'https://example.com/other', intervalSec: MIN_INTERVAL_SEC - 1})), /at least 30/);
  assert.throws(() => registry.create(sourceInput({url: 'https://example.com/other', type: 'billboard'})), /Unknown source type/);
  assert.throws(() => registry.create(sourceInput({url: 'https://example.com/other', region: 'mars'})), /Unknown source region/);
  assert.throws(() => registry.create(sourceInput({url: 'https://example.com/other', priority: 4})), /0-3/);

  const defaults = registry.create({url: 'https://example.com/defaults'});
  assert.equal(defaults.intervalSec, DEFAULT_INTERVAL_SEC);
  assert.equal(defaults.type, 'site');
  assert.equal(defaults.region, 'cn');
  assert.equal(defaults.priority, 1);
  assert.equal(defaults.title, 'example.com');
  assert.ok(SOURCE_TYPES.includes(defaults.type));
 }
 finally {
  scope.cleanup();
 }
});

test('normalises URLs by removing the fragment before storing', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  const created = registry.create(sourceInput({url: 'https://example.com/list#top'}));
  assert.equal(created.url, 'https://example.com/list');
  assert.throws(() => registry.create(sourceInput({url: 'https://example.com/list#other'})), /already registered/);
 }
 finally {
  scope.cleanup();
 }
});

test('lists and filters by region, type and enabled', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  registry.create(sourceInput({url: 'https://a.example.cn/one', region: 'cn', type: 'venue', priority: 3}));
  registry.create(sourceInput({url: 'https://b.example.com/two', region: 'eu', type: 'media', priority: 1}));
  const created = registry.create(sourceInput({url: 'https://c.example.com/three', region: 'cn', type: 'media', priority: 2}));
  registry.update(created.id, {enabled: false});

  assert.equal(registry.list({region: 'cn'}).length, 2);
  assert.equal(registry.list({region: 'eu'}).length, 1);
  assert.equal(registry.list({type: 'media'}).length, 2);
  assert.equal(registry.list({type: 'venue'}).length, 1);
  assert.equal(registry.list({enabled: false}).length, 1);
  assert.equal(registry.list({enabled: true}).length, 2);
  // Higher numeric priority first, matching the task queue (3 = highest).
  assert.equal(registry.list({region: 'cn'})[0].priority, 3);
 }
 finally {
  scope.cleanup();
 }
});

test('update validates fields and re-enables a paused source', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  const created = registry.create(sourceInput());
  registry.markResult(created.id, {ok: false, error: {code: 'BLOCKED', message: 'WAF blocked'}});
  assert.equal(registry.get(created.id).status, 'paused');

  const enabled = registry.update(created.id, {enabled: true});
  assert.equal(enabled.status, 'idle');

  assert.equal(registry.update(created.id, {title: '新标题'}).title, '新标题');
  assert.throws(() => registry.update(created.id, {intervalSec: 5}), /at least 30/);
  assert.throws(() => registry.update(created.id, {priority: 9}), /0-3/);
  assert.throws(() => registry.update(created.id, {status: 'sleeping'}), /Unknown source status/);
  assert.throws(() => registry.update(created.id, {unknownField: 1}), /Unknown source field/);
  assert.throws(() => registry.update(created.id, {enabled: 'yes'}), /boolean/);

  registry.create(sourceInput({url: 'https://example.com/second'}));
  assert.throws(() => registry.update(created.id, {url: 'https://example.com/second'}), /already registered/);
  assert.throws(() => registry.update('00000000-0000-4000-8000-000000000000', {title: 'x'}), /not found/i);
 }
 finally {
  scope.cleanup();
 }
});

test('due walks enabled, non-paused sources whose nextRunAt has passed', () => {
 const scope = tempScope();
 const fixed = 1_800_000_000_000;
 try {
  const registry = openSourceRegistry({file: scope.file, now: () => fixed});
  const dueNow = registry.create(sourceInput({url: 'https://example.com/due'}));
  const disabled = registry.create(sourceInput({url: 'https://example.com/disabled'}));
  registry.update(disabled.id, {enabled: false});
  const paused = registry.create(sourceInput({url: 'https://example.com/paused'}));
  registry.markResult(paused.id, {ok: false, blocked: true, nowMs: fixed});
  const future = registry.create(sourceInput({url: 'https://example.com/future', intervalSec: 600}));
  registry.markResult(future.id, {ok: true, nowMs: fixed});
  assert.equal(registry.get(future.id).nextRunAt, new Date(fixed + 600_000).toISOString());

  const due = registry.due(fixed);
  assert.deepEqual(due.map(source => source.id), [dueNow.id]);
  assert.deepEqual(registry.due(fixed + 600_000).map(source => source.id).sort(), [dueNow.id, future.id].sort());
  assert.deepEqual(registry.due(fixed + 600_000 - 1).map(source => source.id), [dueNow.id]);
 }
 finally {
  scope.cleanup();
 }
});

test('markRunning then markResult records success, error and BLOCKED pause', () => {
 const scope = tempScope();
 const fixed = 1_800_000_000_000;
 try {
  const registry = openSourceRegistry({file: scope.file, now: () => fixed});
  const created = registry.create(sourceInput({intervalSec: 120}));

  const running = registry.markRunning(created.id);
  assert.equal(running.status, 'running');
  assert.equal(running.nextRunAt, new Date(fixed + 120_000).toISOString());

  const succeeded = registry.markResult(created.id, {ok: true, nowMs: fixed + 1000, crawlDelayMs: 5000});
  assert.equal(succeeded.status, 'idle');
  assert.equal(succeeded.lastRunAt, new Date(fixed + 1000).toISOString());
  assert.equal(succeeded.nextRunAt, new Date(fixed + 1000 + 120_000).toISOString());
  assert.equal(succeeded.lastError, null);
  assert.equal(registry.domain(created.domain).lastStatus, 'idle');

  const failed = registry.markResult(created.id, {ok: false, error: {code: 'TIMEOUT', message: 'timed out'}, nowMs: fixed});
  assert.equal(failed.status, 'error');
  assert.match(failed.lastError, /TIMEOUT/);
  assert.match(failed.lastError, /timed out/);
  assert.equal(failed.lastRunAt, new Date(fixed).toISOString());

  const blocked = registry.markResult(created.id, {ok: false, error: 'WAF blocked', blocked: true, nowMs: fixed});
  assert.equal(blocked.status, 'paused');
  assert.equal(registry.domain(created.domain).paused, true);

  registry.update(created.id, {enabled: true});
  assert.equal(registry.get(created.id).status, 'idle');
  const blockedByCode = registry.markResult(created.id, {ok: false, error: {code: 'BLOCKED', message: 'Forbidden'}, nowMs: fixed});
  assert.equal(blockedByCode.status, 'paused');
 }
 finally {
  scope.cleanup();
 }
});

test('remove and stats keep counts consistent', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  const a = registry.create(sourceInput({url: 'https://a.example.com/a'}));
  registry.create(sourceInput({url: 'https://b.example.com/b'}));
  registry.create(sourceInput({url: 'https://c.example.com/c'}));
  registry.markResult(a.id, {ok: false, error: 'boom'});
  const removed = registry.remove(a.id);
  assert.equal(removed.id, a.id);
  assert.equal(registry.list().length, 2);
  assert.throws(() => registry.remove(a.id), /not found/i);

  const stats = registry.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.enabled, 2);
  assert.equal(stats.error, 0);
  assert.equal(stats.paused, 0);
  assert.ok(stats.idle >= 2);
  assert.ok(stats.domains >= 2);
 }
 finally {
  scope.cleanup();
 }
});

test('the curated China source seed matches the SourceEntry contract', () => {
 const seedUrl = new URL('../seed/sources-cn.json', import.meta.url);
 const seed = JSON.parse(readFileSync(seedUrl, 'utf8'));
 assert.ok(Array.isArray(seed.sources));
 assert.ok(seed.sources.length >= 20, `expected at least 20 seed sources, got ${seed.sources.length}`);
 const urls = new Set();
 const types = new Set();
 for (const source of seed.sources) {
  assert.equal(typeof source.url, 'string', 'every seed source needs a URL');
  assert.match(source.url, /^https:\/\//, `seed URL must be https: ${source.url}`);
  const parsed = new URL(source.url);
  parsed.hash = '';
  assert.equal(urls.has(parsed.href), false, `duplicate seed URL: ${source.url}`);
  urls.add(parsed.href);
  assert.ok(typeof source.title === 'string' && source.title.trim().length > 0, `missing title for ${source.url}`);
  assert.ok(SOURCE_TYPES.includes(source.type), `unknown seed type ${source.type} for ${source.url}`);
  assert.equal(source.region, 'cn');
  assert.ok(Number.isInteger(source.priority) && source.priority >= 0 && source.priority <= 3, `bad priority for ${source.url}`);
  assert.ok(Number.isInteger(source.intervalSec) && source.intervalSec >= MIN_INTERVAL_SEC, `bad interval for ${source.url}`);
  assert.ok(source.intervalSec <= 86400, `seed interval should stay <= 1 day for ${source.url}`);
  types.add(source.type);
 }
 for (const type of ['venue', 'association', 'organizer', 'media', 'site', 'sitemap']) {
  assert.ok(types.has(type), `seed must cover source type ${type}`);
 }
});

test('the curated seed imports into a fresh registry', () => {
 const scope = tempScope();
 try {
  const seedUrl = new URL('../seed/sources-cn.json', import.meta.url);
  const expected = JSON.parse(readFileSync(seedUrl, 'utf8')).sources.length;
  const registry = openSourceRegistry({file: scope.file, seedFile: seedUrl});
  const sources = registry.list();
  assert.equal(sources.length, expected);
  assert.ok(registry.stats().total >= 20);
  assert.ok(registry.stats().domains >= 10);
  assert.deepEqual(registry.list({region: 'cn'}).length, expected);
  assert.equal(registry.list({region: 'eu'}).length, 0);
  assert.ok(registry.get(sources[0].id));
 }
 finally {
  scope.cleanup();
 }
});

test('every write is persisted atomically to the JSON file', () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file});
  const created = registry.create(sourceInput());
  const raw = readRegistryFile(scope.file);
  assert.equal(raw.version, 1);
  assert.equal(raw.sources.length, 1);
  assert.equal(raw.sources[0].id, created.id);

  registry.update(created.id, {priority: 3});
  assert.equal(readRegistryFile(scope.file).sources[0].priority, 3);

  const reopened = openSourceRegistry({file: scope.file});
  assert.equal(reopened.get(created.id).priority, 3);
  assert.equal(reopened.stats().total, 1);
 }
 finally {
  scope.cleanup();
 }
});
