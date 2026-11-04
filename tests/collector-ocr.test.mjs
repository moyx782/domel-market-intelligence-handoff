// Collector OCR fallbacks: PDF/image documents and image-only HTML pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollector} from '../server/collector.mjs';

const PDF = Buffer.from('%PDF-1.4\nfake scanned pdf bytes\n%%EOF\n');

function fakeFetch(routes) {
 return async (url) => {
  const key = new URL(url).href;
  if (key.endsWith('/robots.txt')) return new Response('', {status: 404});
  const handler = routes[key] ?? routes[url];
  if (!handler) return new Response('not found', {status: 404});
  return handler();
 };
}

const pdfOcr = {
 configured: true,
 async extract(buffer, {mime}) {
  assert.equal(mime, 'application/pdf');
  assert.ok(buffer.length > 0);
  return {text: '中国国际制冷展 2026\n上海新国际博览中心\nChina Refrigeration Expo', provider: 'vision-ocr', pages: 1, method: 'scanned-pdf'};
 },
};

test('PDF documents are collected through OCR instead of BAD_CONTENT_TYPE', async () => {
 const collector = createCollector({
  fetchImpl: fakeFetch({
   'https://example.test/list.pdf': () => new Response(PDF, {status: 200, headers: {'content-type': 'application/pdf', 'content-length': String(PDF.length)}}),
  }),
  ocr: pdfOcr,
  launchBrowser: async () => { throw Error('browser should not be needed for a PDF'); },
 });
 const result = await collector.collect('https://example.test/list.pdf');
 assert.equal(result.ok, true);
 assert.equal(result.engine, 'ocr-document');
 assert.equal(result.ocr.provider, 'vision-ocr');
 assert.match(result.text, /中国国际制冷展/);
 assert.equal(result.html, '');
 await collector.close?.();
});

test('a PDF without OCR stays a fail-closed BAD_CONTENT_TYPE', async () => {
 const collector = createCollector({
  fetchImpl: fakeFetch({
   'https://example.test/list.pdf': () => new Response(PDF, {status: 200, headers: {'content-type': 'application/pdf'}}),
  }),
  launchBrowser: async () => { throw Error('browser should not be needed for a PDF'); },
 });
 const result = await collector.collect('https://example.test/list.pdf');
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'BAD_CONTENT_TYPE');
 await collector.close?.();
});

test('an image-only HTML page falls back to screenshot OCR', async () => {
 const html = '<!doctype html><html><head><title>Image-only page</title></head><body><div id="app"></div></body></html>';
 const fakePage = {
  setDefaultTimeout() {},
  async goto() {},
  async waitForTimeout() {},
  async content() { return html; },
  url() { return 'https://example.test/page'; },
  async screenshot() { return Buffer.from('fake screenshot'); },
  async close() {},
 };
 const fakeBrowser = {async newPage() { return fakePage; }, async close() {}};
 const ocr = {
  configured: true,
  async recognizeImage(buffer, {mime}) {
   assert.equal(mime, 'image/png');
   assert.ok(buffer.length > 0);
   return '中国国际制冷展 2026\n上海新国际博览中心\nChina Refrigeration Expo\n扫码关注观众登记'.repeat(12);
  },
 };
 const collector = createCollector({
  fetchImpl: fakeFetch({
   'https://example.test/page': () => new Response(html, {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}}),
  }),
  launchBrowser: async () => fakeBrowser,
  ocr,
 });
 const result = await collector.collect('https://example.test/page');
 assert.equal(result.ok, true);
 assert.equal(result.engine, 'ocr-browser');
 assert.equal(result.ocr.method, 'screenshot');
 assert.match(result.text, /上海新国际博览中心/);
 await collector.close?.();
});
