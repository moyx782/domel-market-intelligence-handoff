import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCollector, extractJsonLd, extractReadable} from '../server/collector.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collector');
const fixture = name => readFileSync(join(FIXTURES, name), 'utf8');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const hasChrome = existsSync(CHROME);

const HTML_HEADERS = {'content-type': 'text/html; charset=utf-8'};

function response(body, {status = 200, headers = {}} = {}) {
 return new Response(body, {status, headers});
}

function htmlResponse(body, options = {}) {
 return response(body, {status: options.status ?? 200, headers: {...HTML_HEADERS, ...(options.headers ?? {})}});
}

function robotsResponse(text) {
 return response(text, {headers: {'content-type': 'text/plain; charset=utf-8'}});
}

function robotsNotFound() {
 return response('not found', {status: 404, headers: {'content-type': 'text/plain'}});
}

// Text long enough (>=300 chars) that the browser fallback is not triggered.
function longHtml(marker = 'page body') {
 return '<!doctype html><html><head><title>长页面</title></head><body><p>' +
  String(marker + ' 这是用于测试的正文内容。').repeat(30) +
  '</p></body></html>';
}

function fakeFetch(handler) {
 const calls = [];
 const impl = (url, init = {}) => {
  const href = String(url);
  const call = {url: href, method: String(init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {}, signal: init.signal};
  calls.push(call);
  try {
   return Promise.resolve(handler(href, call, init));
  } catch (error) {
   return Promise.reject(error);
  }
 };
 impl.calls = calls;
 impl.pageCalls = () => calls.filter(call => !call.url.endsWith('/robots.txt'));
 impl.robotsCalls = () => calls.filter(call => call.url.endsWith('/robots.txt'));
 return impl;
}

function htmlPageHandler(name = 'readable-page.html') {
 return fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : htmlResponse(fixture(name))));
}

function fakeLimiter() {
 const record = {acquired: [], blocked: [], backoffs: []};
 return {
  record,
  acquire: async (url, options) => { record.acquired.push({url, options}); },
  blockDomain: (domain, options) => { record.blocked.push({domain, options}); },
  backoff: (domain, ms) => { record.backoffs.push({domain, ms}); },
 };
}

test('extractReadable extracts the title and body text, stripping chrome and decoding entities', () => {
 const {title, text, html} = extractReadable(fixture('readable-page.html'), {url: 'https://expo.example.cn/2026'});
 assert.equal(title, '2026 中国制冷展 & 暖通展');
 assert.match(text, /展会时间：2026-04-08 至 2026-04-10/);
 assert.match(text, /上海新国际博览中心/);
 assert.match(text, /中国制冷学会 & 中国制冷空调工业协会/);
 assert.match(text, /<2026-03-01>/);
 assert.ok(text.length >= 300, 'fixture should exercise the no-browser path');
 assert.doesNotMatch(text, /导航链接|热门推荐|其他展会列表|版权所有|tracking script|window\.dataLayer/);
 assert.doesNotMatch(text, /这个标题不应该覆盖 title/);
 assert.match(html, /<h1>/);
});

test('extractReadable handles fragments, headings and empty pages', () => {
 const fragment = extractReadable('<div><p>Hello &amp; world</p><script>bad()</script></div>');
 assert.equal(fragment.title, '');
 assert.equal(fragment.text, 'Hello & world');

 const heading = extractReadable('<html><body><h1>只有标题</h1><p>正文 &#x4e2d;&#20013;</p></body></html>');
 assert.equal(heading.title, '只有标题');
 assert.match(heading.text, /正文 中中/);

 const empty = extractReadable('');
 assert.equal(empty.title, '');
 assert.equal(empty.text, '');
});

test('extractJsonLd parses event objects, arrays and @graph while skipping malformed blocks', () => {
 const entries = extractJsonLd(fixture('jsonld-page.html'));
 assert.equal(entries.length, 6);
 const events = entries.filter(entry => entry['@type'] === 'Event');
 assert.equal(events.length, 4);
 assert.deepEqual(events.map(event => event.name).sort(), ['ISH China & CIHE 2026', '图形展会', '注释包装的展会', '第二场展会'].sort());
 assert.ok(entries.some(entry => entry['@type'] === 'Organization'));
 assert.ok(!entries.some(entry => entry['@type'] === 'NotJsonLd'));
});

test('collect fetches HTML, applies robots and returns readable text', async () => {
 const fetchImpl = htmlPageHandler();
 const fixedNow = Date.UTC(2026, 0, 2, 3, 4, 5);
 const collector = createCollector({fetchImpl, now: () => fixedNow});
 const result = await collector.collect('https://expo.example.test/2026#schedule');

 assert.equal(result.ok, true);
 assert.equal(result.url, 'https://expo.example.test/2026');
 assert.equal(result.finalUrl, 'https://expo.example.test/2026');
 assert.equal(result.status, 200);
 assert.equal(result.engine, 'http');
 assert.equal(result.title, '2026 中国制冷展 & 暖通展');
 assert.match(result.text, /上海新国际博览中心/);
 assert.doesNotMatch(result.text, /导航链接|热门推荐|版权所有/);
 assert.match(result.html, /<h1>/);
 assert.match(result.contentType, /text\/html/);
 assert.ok(result.bytes > 500);
 assert.equal(result.fetchedAt, new Date(fixedNow).toISOString());
 assert.deepEqual(result.robots, {allowed: true, crawlDelayMs: 0});
 assert.equal(result.error, undefined);
 assert.equal(fetchImpl.robotsCalls().length, 1);
 assert.equal(fetchImpl.pageCalls().length, 1);
 assert.equal(fetchImpl.pageCalls()[0].method, 'GET');
});

test('collect rejects non-http URLs without touching the network', async () => {
 const fetchImpl = fakeFetch(() => htmlResponse('x'));
 const collector = createCollector({fetchImpl});
 const ftp = await collector.collect('ftp://files.example.test/report.html');
 assert.equal(ftp.ok, false);
 assert.equal(ftp.error.code, 'INVALID_URL');
 assert.equal(ftp.error.permanent, true);

 const garbage = await collector.collect('definitely not a url');
 assert.equal(garbage.ok, false);
 assert.equal(garbage.error.code, 'INVALID_URL');
 assert.equal(fetchImpl.calls.length, 0);
});

test('collect rejects non-HTML content types permanently', async () => {
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt')
  ? robotsNotFound()
  : response('{"data": true}', {headers: {'content-type': 'application/json'}})));
 const collector = createCollector({fetchImpl});
 const result = await collector.collect('https://api.example.test/data.json');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'BAD_CONTENT_TYPE');
 assert.equal(result.error.permanent, true);
 assert.equal(result.status, 200);
 assert.match(result.error.message, /application\/json/);
 assert.match(result.contentType, /application\/json/);
});

test('collect aborts oversized bodies (streaming cap) and maps TOO_LARGE permanently', async () => {
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt')
  ? robotsNotFound()
  : htmlResponse('x'.repeat(5000))));
 const collector = createCollector({fetchImpl, maxBytes: 1000});
 const result = await collector.collect('https://huge.example.test/page');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'TOO_LARGE');
 assert.equal(result.error.permanent, true);
});

test('collect times out stalled requests', async () => {
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : new Promise(() => {})));
 const collector = createCollector({fetchImpl, timeoutMs: 60});
 const startedAt = Date.now();
 const result = await collector.collect('https://slow.example.test/page');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'TIMEOUT');
 assert.ok(!result.error.permanent, 'timeouts are retryable');
 assert.ok(Date.now() - startedAt < 2000);
});

test('collect maps 403 to BLOCKED and blocks the domain through the limiter', async () => {
 const limiter = fakeLimiter();
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt')
  ? robotsNotFound()
  : response('forbidden', {status: 403, headers: {'content-type': 'text/html'}})));
 const collector = createCollector({fetchImpl, limiter});
 const result = await collector.collect('https://blocked.example.test/page');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'BLOCKED');
 assert.equal(result.error.permanent, true);
 assert.equal(limiter.record.acquired.length, 1);
 assert.equal(limiter.record.blocked.length, 1);
 assert.equal(limiter.record.blocked[0].domain, 'blocked.example.test');
});

test('collect maps 429 to RATE_LIMITED with Retry-After and backs the domain off', async () => {
 const limiter = fakeLimiter();
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt')
  ? robotsNotFound()
  : response('slow down', {status: 429, headers: {'content-type': 'text/html', 'retry-after': '2'}})));
 const collector = createCollector({fetchImpl, limiter});
 const result = await collector.collect('https://busy.example.test/page');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'RATE_LIMITED');
 assert.equal(result.error.retryAfterMs, 2000);
 assert.equal(result.error.permanent, false);
 assert.equal(limiter.record.backoffs.length, 1);
 assert.equal(limiter.record.backoffs[0].domain, 'busy.example.test');
 assert.equal(limiter.record.backoffs[0].ms, 2000);
});

test('HTTP status mapping separates retryable 5xx, permanent 4xx and blocked auth pages', async () => {
 const run = async (status, url = 'https://status.example.test/page') => {
  const fetchImpl = fakeFetch(requestUrl => (requestUrl.endsWith('/robots.txt')
   ? robotsNotFound()
   : response('error page', {status, headers: {'content-type': 'text/html'}})));
  const collector = createCollector({fetchImpl});
  return collector.collect(url);
 };
 const serverError = await run(500);
 assert.equal(serverError.error.code, 'NETWORK');
 assert.equal(serverError.error.permanent, false);
 const notFound = await run(404);
 assert.equal(notFound.error.code, 'HTTP_ERROR');
 assert.equal(notFound.error.permanent, true);
 const unauthorized = await run(401);
 assert.equal(unauthorized.error.code, 'BLOCKED');
 assert.equal(unauthorized.error.permanent, true);
});

test('robots.txt disallows, allows and crawl-delay are enforced', async () => {
 const robots = fixture('robots.txt');
 const fetchImpl = fakeFetch(url => {
  if (url.endsWith('/robots.txt')) return robotsResponse(robots);
  return htmlResponse(longHtml());
 });
 const limiter = fakeLimiter();
 const collector = createCollector({fetchImpl, limiter});

 const denied = await collector.collect('https://robots.example.test/private/secret');
 assert.equal(denied.ok, false);
 assert.equal(denied.error.code, 'ROBOTS_DENIED');
 assert.equal(denied.error.permanent, true);
 assert.equal(denied.robots.allowed, false);
 assert.equal(fetchImpl.pageCalls().length, 0, 'denied URLs must not be fetched');
 assert.equal(limiter.record.acquired.length, 0);

 const searchDenied = await collector.collect('https://robots.example.test/search?q=1');
 assert.equal(searchDenied.error.code, 'ROBOTS_DENIED');

 const allowed = await collector.collect('https://robots.example.test/public/list');
 assert.equal(allowed.ok, true);
 assert.deepEqual(allowed.robots, {allowed: true, crawlDelayMs: 1500});
 assert.equal(limiter.record.acquired.length, 1);
 assert.equal(limiter.record.acquired[0].options.crawlDelayMs, 1500);

 const allowOverride = await collector.collect('https://robots.example.test/private/public/ok');
 assert.equal(allowOverride.ok, true);
});

test('robots.txt results are cached per origin for one hour', async () => {
 let clock = Date.UTC(2026, 5, 1, 8, 0, 0);
 const fetchImpl = fakeFetch(url => {
  if (url.endsWith('/robots.txt')) return robotsResponse('User-agent: *\nDisallow: /hidden\n');
  return htmlResponse(longHtml());
 });
 const collector = createCollector({fetchImpl, now: () => clock});
 await collector.collect('https://cache.example.test/a');
 await collector.collect('https://cache.example.test/b');
 assert.equal(fetchImpl.robotsCalls().length, 1);
 assert.equal(fetchImpl.pageCalls().length, 2);

 clock += 2 * 60 * 60 * 1000;
 await collector.collect('https://cache.example.test/c');
 assert.equal(fetchImpl.robotsCalls().length, 2);

 const hidden = await collector.collect('https://cache.example.test/hidden/x');
 assert.equal(hidden.error.code, 'ROBOTS_DENIED');
 assert.equal(fetchImpl.pageCalls().length, 3);
});

test('collect follows relative and absolute redirects and keeps the final URL', async () => {
 const fetchImpl = fakeFetch(url => {
  if (url.endsWith('/robots.txt')) return robotsNotFound();
  if (url === 'https://redirect.example.test/start') return response(null, {status: 302, headers: {location: '/middle'}});
  if (url === 'https://redirect.example.test/middle') return response(null, {status: 301, headers: {location: 'https://redirect.example.test/final'}});
  if (url === 'https://redirect.example.test/final') return htmlResponse(longHtml('final page'));
  throw Error('unexpected URL ' + url);
 });
 const collector = createCollector({fetchImpl});
 const result = await collector.collect('https://redirect.example.test/start');
 assert.equal(result.ok, true);
 assert.equal(result.url, 'https://redirect.example.test/start');
 assert.equal(result.finalUrl, 'https://redirect.example.test/final');
 assert.equal(result.status, 200);
 assert.equal(fetchImpl.pageCalls().length, 3);
});

test('collect stops after five redirects', async () => {
 const fetchImpl = fakeFetch(url => {
  if (url.endsWith('/robots.txt')) return robotsNotFound();
  const match = /\/r(\d+)$/.exec(url);
  const index = match ? Number(match[1]) : 0;
  return response(null, {status: 302, headers: {location: '/r' + (index + 1)}});
 });
 const collector = createCollector({fetchImpl});
 const result = await collector.collect('https://loop.example.test/r0');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'TOO_MANY_REDIRECTS');
 assert.equal(result.error.permanent, true);
 assert.equal(fetchImpl.pageCalls().length, 6);
});

test('concurrent collects of the same URL share one fetch', async () => {
 let pageRequests = 0;
 const fetchImpl = fakeFetch(async url => {
  if (url.endsWith('/robots.txt')) return robotsNotFound();
  pageRequests += 1;
  await new Promise(resolve => setTimeout(resolve, 20));
  return htmlResponse(longHtml());
 });
 const collector = createCollector({fetchImpl});
 const [first, second] = await Promise.all([
  collector.collect('https://same.example.test/page#one'),
  collector.collect('https://same.example.test/page#two'),
 ]);
 assert.equal(pageRequests, 1);
 assert.equal(fetchImpl.robotsCalls().length, 1);
 assert.equal(first.ok, true);
 assert.equal(second.ok, true);
 assert.equal(first.finalUrl, second.finalUrl);
});

test('Playwright fallback uses the injected launcher and reuses the browser', async () => {
 const shortHtml = '<!doctype html><html><head><title>Shell</title></head><body><div id="root">loading</div></body></html>';
 const renderedHtml = '<!doctype html><html><head><title>Shell</title></head><body><div id="root"><h1>渲染结果</h1><p>' +
  '浏览器渲染后的正文内容。'.repeat(40) + '</p><p>MARKER_INJECTED</p></div></body></html>';
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : htmlResponse(shortHtml)));
 const browsers = [];
 const launchBrowser = async () => {
  const browser = {
   closed: false,
   lastPageOptions: null,
   gotoUrl: null,
   async newPage(options) {
    browser.lastPageOptions = options;
    return {
     async goto(url) { browser.gotoUrl = url; },
     async waitForTimeout() {},
     async content() { return renderedHtml; },
     url: () => 'https://shell.example.test/rendered',
     async close() {},
    };
   },
   async close() { browser.closed = true; },
  };
  browsers.push(browser);
  return browser;
 };
 const collector = createCollector({fetchImpl, launchBrowser});
 const result = await collector.collect('https://shell.example.test/page');
 assert.equal(result.ok, true);
 assert.equal(result.engine, 'browser');
 assert.match(result.text, /MARKER_INJECTED/);
 assert.match(result.text, /渲染后的正文/);
 assert.equal(result.finalUrl, 'https://shell.example.test/rendered');
 assert.equal(browsers.length, 1);
 assert.equal(browsers[0].gotoUrl, 'https://shell.example.test/page');
 assert.equal(browsers[0].lastPageOptions.userAgent, 'DomelMarketIntelligence/0.1 (+intranet demo)');

 await collector.close();
 assert.equal(browsers[0].closed, true);
});

test('browser failures are non-fatal and keep the HTTP result', async () => {
 const shortHtml = '<!doctype html><html><head><title>Shell</title></head><body><div id="root">loading</div></body></html>';
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : htmlResponse(shortHtml)));
 const collector = createCollector({fetchImpl, launchBrowser: async () => { throw Error('chrome is not installed'); }});
 const result = await collector.collect('https://shell.example.test/page');
 assert.equal(result.ok, true);
 assert.equal(result.engine, 'http');
 assert.equal(result.title, 'Shell');
 assert.ok(result.renderError);
 assert.match(result.renderError.message, /chrome is not installed/);
});

test('recipe fallback runs when text is still thin and marks the engine', async () => {
 const shortHtml = '<!doctype html><html><head><title>Tiny</title></head><body><p>tiny</p></body></html>';
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : htmlResponse(shortHtml)));
 const collector = createCollector({fetchImpl});
 const recipe = {
  kind: 'script',
  body: '(input) => ({marker: "recipe-ok", url: input.url, textLength: input.text.length, jsonLd: input.jsonLd.length})',
 };
 const result = await collector.collect('https://tiny.example.test/page', {allowPlaywright: false, recipe});
 assert.equal(result.ok, true);
 assert.equal(result.engine, 'recipe');
 assert.equal(result.values.marker, 'recipe-ok');
 assert.equal(result.values.url, 'https://tiny.example.test/page');
 assert.ok(result.values.textLength > 0);
 assert.equal(result.values.jsonLd, 0);
 assert.equal(result.recipeError, undefined);

 const brokenRecipe = {kind: 'script', body: '(input) => { throw new Error("bad recipe"); }'};
 const broken = await collector.collect('https://tiny.example.test/page', {allowPlaywright: false, recipe: brokenRecipe});
 assert.equal(broken.ok, true);
 assert.equal(broken.engine, 'http');
 assert.equal(broken.recipeError.code, 'SCRIPT_ERROR');
});

test('probe classifies document availability and falls back from HEAD to ranged GET', async () => {
 const fetchImpl = fakeFetch((url, call) => {
  if (call.method === 'HEAD') {
   if (url === 'https://docs.example.test/list.pdf') return response(null, {status: 200, headers: {'content-type': 'application/pdf', 'content-length': '4096'}});
   if (url === 'https://docs.example.test/secret.pdf') return response(null, {status: 403, headers: {'content-type': 'application/pdf'}});
   if (url === 'https://docs.example.test/no-head.pdf') throw Error('HEAD not supported');
   if (url === 'https://docs.example.test/only-range.pdf') return response(null, {status: 405});
   if (url === 'https://docs.example.test/missing.pdf') return response(null, {status: 404});
   if (url === 'https://docs.example.test/down.pdf') throw Error('network down');
  }
  if (call.method === 'GET') {
   if (url === 'https://docs.example.test/no-head.pdf') return response('\0', {status: 200, headers: {'content-type': 'application/pdf', 'content-length': '1'}});
   if (url === 'https://docs.example.test/only-range.pdf') return response('\0', {status: 206, headers: {'content-type': 'application/pdf', 'content-length': '1'}});
  }
  throw Error('unexpected ' + call.method + ' ' + url);
 });
 const collector = createCollector({fetchImpl, timeoutMs: 500});

 const pdf = await collector.probe('https://docs.example.test/list.pdf');
 assert.equal(pdf.ok, true);
 assert.equal(pdf.status, 200);
 assert.equal(pdf.contentType, 'application/pdf');
 assert.equal(pdf.contentLength, 4096);
 assert.equal(pdf.availability, 'downloadable');

 const secret = await collector.probe('https://docs.example.test/secret.pdf');
 assert.equal(secret.ok, true);
 assert.equal(secret.status, 403);
 assert.equal(secret.availability, 'restricted');

 const missing = await collector.probe('https://docs.example.test/missing.pdf');
 assert.equal(missing.ok, true);
 assert.equal(missing.status, 404);
 assert.equal(missing.availability, 'unknown');

 const noHead = await collector.probe('https://docs.example.test/no-head.pdf');
 assert.equal(noHead.ok, true);
 assert.equal(noHead.availability, 'downloadable');
 const rangedGet = fetchImpl.calls.find(call => call.method === 'GET' && call.url === 'https://docs.example.test/no-head.pdf');
 assert.equal(rangedGet.headers.range, 'bytes=0-0');

 const onlyRange = await collector.probe('https://docs.example.test/only-range.pdf');
 assert.equal(onlyRange.ok, true);
 assert.equal(onlyRange.status, 206);
 assert.equal(onlyRange.availability, 'downloadable');

 const down = await collector.probe('https://docs.example.test/down.pdf');
 assert.equal(down.ok, false);
 assert.equal(down.availability, 'unknown');
 assert.equal(down.error.code, 'NETWORK');

 const invalid = await collector.probe('ftp://docs.example.test/list.pdf');
 assert.equal(invalid.ok, false);
 assert.equal(invalid.availability, 'unknown');
 assert.equal(invalid.error.code, 'INVALID_URL');
});

test('collect honours caller aborts before and during the request', async () => {
 const preAbortFetch = fakeFetch(() => htmlResponse(longHtml()));
 const collector = createCollector({fetchImpl: preAbortFetch});
 const controller = new AbortController();
 controller.abort();
 const preAborted = await collector.collect('https://abort.example.test/page', {signal: controller.signal});
 assert.equal(preAborted.ok, false);
 assert.equal(preAborted.error.code, 'ABORTED');
 assert.equal(preAborted.error.permanent, true);
 assert.equal(preAbortFetch.calls.length, 0);

 const pendingFetch = fakeFetch((url, call) => {
  if (url.endsWith('/robots.txt')) return robotsNotFound();
  return new Promise((resolve, reject) => {
   call.signal?.addEventListener('abort', () => {
    const error = Error('aborted');
    error.name = 'AbortError';
    reject(error);
   }, {once: true});
  });
 });
 const pendingCollector = createCollector({fetchImpl: pendingFetch, timeoutMs: 5000});
 const pendingController = new AbortController();
 const pending = pendingCollector.collect('https://abort.example.test/slow', {signal: pendingController.signal});
 setTimeout(() => pendingController.abort(), 30);
 const aborted = await pending;
 assert.equal(aborted.ok, false);
 assert.equal(aborted.error.code, 'ABORTED');
});

test('limiter DOMAIN_BLOCKED rejects without fetching', async () => {
 const limiter = {
  acquire: async () => {
   const error = Error('domain is blocked');
   error.code = 'DOMAIN_BLOCKED';
   error.permanent = true;
   throw error;
  },
  blockDomain: () => {},
  backoff: () => {},
 };
 const fetchImpl = fakeFetch(url => (url.endsWith('/robots.txt') ? robotsNotFound() : htmlResponse(longHtml())));
 const collector = createCollector({fetchImpl, limiter});
 const result = await collector.collect('https://blocked.example.test/page');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'BLOCKED');
 assert.equal(result.error.permanent, true);
 assert.equal(fetchImpl.pageCalls().length, 0);
});

test('Playwright fallback renders a JavaScript shell page with the system Chrome', {skip: hasChrome ? false : 'Chrome is not installed'}, async () => {
 const shell = fixture('js-shell.html');
 const server = createServer((request, reply) => {
  if (request.url === '/robots.txt') {
   reply.writeHead(404, {'content-type': 'text/plain'});
   return reply.end('not found');
  }
  if (request.url === '/shell') {
   reply.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
   return reply.end(shell);
  }
  reply.writeHead(404, {'content-type': 'text/plain'});
  return reply.end('not found');
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const {port} = server.address();
 const collector = createCollector({timeoutMs: 20000});
 try {
  const result = await collector.collect('http://127.0.0.1:' + port + '/shell');
  assert.equal(result.ok, true);
  assert.equal(result.engine, 'browser');
  assert.ok(result.text.length >= 300, 'rendered text should pass the threshold');
  assert.match(result.text, /RENDERED_OK/);
  assert.match(result.text, /渲染后的展会日历/);
 } finally {
  await collector.close();
  await new Promise(resolve => {
   server.closeAllConnections?.();
   server.close(resolve);
  });
 }
});
