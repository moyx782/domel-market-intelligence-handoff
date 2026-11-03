// Official-website lookup must go through a search engine, and forum/news pages
// must never be stored as an event's official website. A locally deployed
// SearXNG (or an internal JSON gateway) is supported as the search provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventStore} from '../server/event-store.mjs';
import {createEventJobs} from '../server/event-jobs.mjs';
import {isLikelyOfficialUrl} from '../server/event-search.mjs';
import {
 createCustomJsonSearch, createSearxngSearch, createWebSearch, searchProviderConfig,
} from '../server/web-search.mjs';

test('official-website quality gate rejects forum/news/directory pages', () => {
 for (const url of [
  'https://www.eechina.com/thread-902770-1-20.html',
  'https://en.eeworld.com.cn/bbs/thread-1172287-1-1.html',
  'https://www.showsbee.com/',
  'https://zh-tw.cantonfair.net/',
  'https://news.example.com/expo/123',
  'https://www.zhihu.com/question/1',
  'https://www.cr-expo.com/cn/news/2026.html',
  'https://en.cgmiaifme.com/Web/About/Contact/8',
 ]) assert.equal(isLikelyOfficialUrl(url), false, url);
 for (const url of [
  'https://www.cr-expo.com/',
  'https://www.cr-expo.com/cn/index.aspx',
  'https://www.isec-expo.com/en',
  'https://www.awe.com.cn/',
 ]) assert.equal(isLikelyOfficialUrl(url), true, url);
});

test('search provider configuration resolves auto/searxng/custom/none', () => {
 assert.equal(searchProviderConfig({}).provider, 'auto');
 assert.equal(searchProviderConfig({SEARXNG_URL: 'http://127.0.0.1:8080'}).provider, 'searxng');
 assert.equal(searchProviderConfig({WEB_SEARCH_URL: 'https://search.corp.example/'}).url, 'https://search.corp.example');
 assert.equal(searchProviderConfig({WEB_SEARCH_PROVIDER: 'none', WEB_SEARCH_URL: 'http://x'}).provider, 'none');
 assert.equal(searchProviderConfig({WEB_SEARCH_PROVIDER: 'custom'}).provider, 'custom');
});

test('the SearXNG adapter queries the JSON API and normalizes results', async () => {
 const calls = [];
 const fetchImpl = async (url, init) => {
  calls.push({url, headers: init.headers});
  return new Response(JSON.stringify({results: [
   {url: 'https://www.cr-expo.com/', title: 'China Refrigeration'},
   {url: 'not-a-url', title: 'Broken'},
  ]}), {status: 200, headers: {'Content-Type': 'application/json'}});
 };
 const provider = createSearxngSearch({url: 'http://127.0.0.1:8080/', fetchImpl, language: 'zh-CN', timeoutMs: 1000});
 const results = await provider.search({query: '中国制冷展 官网', count: 5});
 const parsed = new URL(calls[0].url);
 assert.equal(parsed.origin, 'http://127.0.0.1:8080');
 assert.equal(parsed.pathname, '/search');
 assert.equal(parsed.searchParams.get('format'), 'json');
 assert.equal(parsed.searchParams.get('q'), '中国制冷展 官网');
 assert.equal(parsed.searchParams.get('language'), 'zh-CN');
 assert.equal(results.length, 1);
 assert.equal(results[0].url, 'https://www.cr-expo.com/');
 const broken = createSearxngSearch({url: 'http://127.0.0.1:8080', fetchImpl: async () => new Response('{}', {status: 500})});
 await assert.rejects(broken.search({query: 'x'}), /Local search failed/);
});

test('the custom JSON gateway supports a query template and bearer token', async () => {
 let captured;
 const fetchImpl = async (url, init) => {
  captured = {url, headers: init.headers};
  return new Response(JSON.stringify({data: [{url: 'https://www.ishc-cihe.com/', title: 'ISH'}]}), {status: 200});
 };
 const provider = createCustomJsonSearch({url: 'https://search.corp.example/api?q={query}&limit=3', apiKey: 'gw-token', fetchImpl, timeoutMs: 1000});
 const results = await provider.search({query: 'ISH China 官网', count: 3});
 assert.equal(captured.headers.Authorization, 'Bearer gw-token');
 assert.match(captured.url, /q=ISH%20China%20%E5%AE%98%E7%BD%91/);
 assert.equal(results[0].url, 'https://www.ishc-cihe.com/');
});

test('createWebSearch picks DeepSeek when the model is DeepSeek, otherwise local search', () => {
 const deepseek = createWebSearch({env: {DEEPSEEK_API_KEY: 'sk-test'}, getLlm: () => ({provider: 'deepseek', key: 'sk-test'}), fetchImpl: async () => new Response('{}')});
 assert.equal(deepseek.provider, 'deepseek');
 const local = createWebSearch({env: {SEARXNG_URL: 'http://127.0.0.1:8080'}, getLlm: () => ({provider: 'custom', key: ''}), fetchImpl: async () => new Response('{}')});
 assert.equal(local.provider, 'searxng');
 assert.equal(createWebSearch({env: {WEB_SEARCH_PROVIDER: 'none'}, getLlm: () => ({provider: 'deepseek', key: 'sk-test'})}), null);
 const custom = createWebSearch({env: {WEB_SEARCH_PROVIDER: 'custom', WEB_SEARCH_URL: 'http://gw/search'}, getLlm: () => ({provider: 'custom'})});
 assert.equal(custom.provider, 'custom');
 assert.equal(createWebSearch({env: {}, getLlm: () => ({provider: 'custom'})}), null);
});

function fakeCollector(html, title) {
 const calls = [];
 return {
  calls,
  async collect(url) {
   calls.push(url);
   return {
    ok: true, url, finalUrl: url, status: 200, engine: 'http', title,
    text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), html,
    contentType: 'text/html', bytes: html.length, fetchedAt: new Date().toISOString(),
    robots: {allowed: true, crawlDelayMs: 0},
   };
  },
  async probe() { return {ok: true, status: 200, availability: 'unknown'}; },
 };
}

function makeJobs({eventStore, webSearch, collector, now = Date.parse('2026-11-03T12:00:00Z')}) {
 return createEventJobs({eventStore, collector, search: null, webSearch, now: () => now});
}

function ctx(event) {
 return {
  task: {kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
  signal: new AbortController().signal,
  update: async () => {},
  log: async () => {},
 };
}

test('forum-only search results never become the official website', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-websearch-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const {event} = eventStore.upsert({name: 'Shenzhen International Motor and Drive Technology Exhibition', region: 'cn', city: '深圳'});
 try {
  const jobs = makeJobs({
   eventStore,
   collector: fakeCollector('<html></html>', 'Engineering forum'),
   webSearch: async () => [{url: 'https://www.eechina.com/thread-902770-1-20.html', title: '展会官网？'}],
  });
  const result = await jobs['event.enrich'](ctx(event));
  const updated = eventStore.get(event.id);
  assert.equal(updated.website, '');
  assert.equal(result.collected, 0);
  assert.ok(updated.notes.join('\n').includes('缺少可核验的官网或来源链接'));
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('a legacy forum website is cleared, or upgraded from a stored official source', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-websearch-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 const html = '<html><head><title>Shenzhen International Motor and Drive Technology Exhibition</title></head><body>expo</body></html>';
 try {
  // No official source -> clear the forum URL.
  const {event: first} = eventStore.upsert({
   name: 'Shenzhen International Motor and Drive Technology Exhibition',
   region: 'cn', city: '深圳', website: 'https://www.eechina.com/thread-902770-1-20.html',
  });
  const jobs = makeJobs({eventStore, collector: fakeCollector(html, 'Shenzhen International Motor and Drive Technology Exhibition'), webSearch: null});
  await jobs['event.enrich'](ctx(first));
  const cleared = eventStore.get(first.id);
  assert.equal(cleared.website, '');
  assert.ok(cleared.notes.join('\n').includes('原官网链接是论坛/媒体页面'));

  // With a stored official source -> recover the official homepage.
  const {event: second} = eventStore.upsert({
   name: 'Shenzhen International Motor and Drive Technology Exhibition',
   region: 'cn', city: '深圳', website: 'https://www.eechina.com/thread-902770-1-20.html',
   sources: [{url: 'https://www.motorexpo.com/', title: 'Official', verifiedAt: '2026-11-03T00:00:00Z'}],
  });
  await jobs['event.enrich'](ctx(second));
  const upgraded = eventStore.get(second.id);
  assert.equal(upgraded.website, 'https://www.motorexpo.com/');
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
