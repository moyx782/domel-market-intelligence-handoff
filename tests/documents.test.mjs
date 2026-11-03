import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash, openDocumentStore} from '../server/documents.mjs';

function tempScope() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-documents-'));
 return {
  dir,
  file: join(dir, 'documents.json'),
  cleanup() {
   rmSync(dir, {recursive: true, force: true});
  },
 };
}

const fixed = 1_800_000_000_000;

test('hash is the first 16 hex chars of the SHA-256 of the text', () => {
 const text = '正文内容：2026 中国制冷展';
 const expected = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
 assert.equal(hash(text), expected);
 assert.match(hash(text), /^[0-9a-f]{16}$/);
 assert.equal(hash(''), createHash('sha256').update('', 'utf8').digest('hex').slice(0, 16));
});

test('saves a page and exposes it through get/list/stats', () => {
 const scope = tempScope();
 try {
  const store = openDocumentStore({file: scope.file, now: () => fixed});
  const saved = store.save({
   sourceId: 'source-1',
   url: 'https://www.cr-expo.com/',
   title: '中国制冷展官网',
   text: '中国制冷展 2026 年 11 月在上海举办。',
   htmlBytes: 4096,
   engine: 'http',
   fetchedAt: '2026-11-03T10:00:00.000Z',
  });
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.url, 'https://www.cr-expo.com/');
  assert.equal(saved.sourceId, 'source-1');
  assert.equal(saved.title, '中国制冷展官网');
  assert.equal(saved.htmlBytes, 4096);
  assert.equal(saved.engine, 'http');
  assert.equal(saved.runs, 1);
  assert.equal(saved.hash, hash('中国制冷展 2026 年 11 月在上海举办。'));
  assert.equal(saved.firstFetchedAt, '2026-11-03T10:00:00.000Z');
  assert.equal(saved.fetchedAt, '2026-11-03T10:00:00.000Z');

  assert.deepEqual(store.get(saved.id), saved);
  assert.equal(store.get(saved.id).text.length > 0, true);
  assert.equal(store.get('missing'), null);
  assert.equal(store.list().length, 1);
  assert.equal(store.list({sourceId: 'source-1'}).length, 1);
  assert.equal(store.list({sourceId: 'other'}).length, 0);

  const stats = store.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.sources, 1);
  assert.equal(stats.htmlBytes, 4096);
  assert.equal(stats.lastFetchedAt, '2026-11-03T10:00:00.000Z');

  const stored = JSON.parse(readFileSync(scope.file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.documents.length, 1);
 }
 finally {
  scope.cleanup();
 }
});

test('saving the same URL updates in place, keeps firstFetchedAt and counts runs', () => {
 const scope = tempScope();
 try {
  const store = openDocumentStore({file: scope.file, now: () => fixed});
  const first = store.save({sourceId: 'a', url: 'https://example.com/page', title: 'v1', text: 'first text', htmlBytes: 100, engine: 'http', fetchedAt: '2026-11-01T00:00:00.000Z'});
  const second = store.save({sourceId: 'b', url: 'https://example.com/page#body', title: 'v2', text: 'second text', htmlBytes: 240, engine: 'browser', fetchedAt: '2026-11-02T00:00:00.000Z'});

  assert.equal(second.id, first.id);
  assert.equal(store.list().length, 1);
  assert.equal(second.runs, 2);
  assert.equal(second.firstFetchedAt, '2026-11-01T00:00:00.000Z');
  assert.equal(second.fetchedAt, '2026-11-02T00:00:00.000Z');
  assert.equal(second.title, 'v2');
  assert.equal(second.text, 'second text');
  assert.equal(second.engine, 'browser');
  assert.equal(second.htmlBytes, 240);
  assert.equal(second.sourceId, 'b');
  assert.equal(second.hash, hash('second text'));

  const third = store.save({url: 'https://example.com/page', text: 'third', hash: 'customhash123456'});
  assert.equal(third.runs, 3);
  assert.equal(third.hash, 'customhash123456');
  assert.equal(third.firstFetchedAt, '2026-11-01T00:00:00.000Z');
 }
 finally {
  scope.cleanup();
 }
});

test('list filters by source and since, newest first', () => {
 const scope = tempScope();
 try {
  const store = openDocumentStore({file: scope.file, now: () => fixed});
  store.save({sourceId: 'a', url: 'https://a.example.com/old', fetchedAt: '2026-11-01T00:00:00.000Z'});
  store.save({sourceId: 'b', url: 'https://b.example.com/new', fetchedAt: '2026-11-03T00:00:00.000Z'});
  store.save({sourceId: 'a', url: 'https://a.example.com/mid', fetchedAt: '2026-11-02T00:00:00.000Z'});

  assert.deepEqual(store.list().map(document => document.url), [
   'https://b.example.com/new',
   'https://a.example.com/mid',
   'https://a.example.com/old',
  ]);
  assert.deepEqual(store.list({sourceId: 'a'}).map(document => document.url), [
   'https://a.example.com/mid',
   'https://a.example.com/old',
  ]);
  assert.deepEqual(store.list({since: '2026-11-02T00:00:00.000Z'}).map(document => document.url), [
   'https://b.example.com/new',
   'https://a.example.com/mid',
  ]);
  assert.equal(store.list({since: '2027-01-01T00:00:00.000Z'}).length, 0);
 }
 finally {
  scope.cleanup();
 }
});

test('rejects non http(s) URLs and persists across reopen', () => {
 const scope = tempScope();
 try {
  const store = openDocumentStore({file: scope.file, now: () => fixed});
  assert.throws(() => store.save({url: 'ftp://example.com/file'}), /http\(s\)/);
  assert.throws(() => store.save({url: 'not-a-url'}), /Invalid document URL/);
  assert.throws(() => store.save({}), /required/);

  store.save({sourceId: 'a', url: 'https://example.com/one', text: 'one', htmlBytes: 10});
  store.save({sourceId: 'a', url: 'https://example.com/one', text: 'one again', htmlBytes: 11});

  const reopened = openDocumentStore({file: scope.file});
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].runs, 2);
  assert.equal(reopened.list()[0].text, 'one again');
  assert.equal(reopened.stats().total, 1);
 }
 finally {
  scope.cleanup();
 }
});
