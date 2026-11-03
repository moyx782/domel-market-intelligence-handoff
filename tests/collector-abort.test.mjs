// Regression tests for aborting a Playwright fallback collection.
//
// The browser fallback runs several page calls behind an AbortController. When a
// task is cancelled mid-render the in-flight Playwright promises must never be
// left without a rejection handler: an unhandled rejection here killed the whole
// local API process (reported by QA as BUG-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollector} from '../server/collector.mjs';

const SHELL_HTML = '<html><body><div id="root">loading</div></body></html>';

function fakeFetch(url) {
 if (String(url).includes('robots.txt')) {
  return Promise.resolve(new Response('User-agent: *\nAllow: /\n', {status: 200, headers: {'Content-Type': 'text/plain'}}));
 }
 return Promise.resolve(new Response(SHELL_HTML, {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}}));
}

function collectWithFakeBrowser(pageFactory) {
 const controller = new AbortController();
 const unhandled = [];
 const onUnhandled = reason => unhandled.push(reason);
 process.on('unhandledRejection', onUnhandled);
 const collector = createCollector({
  fetchImpl: fakeFetch,
  launchBrowser: async () => ({
   newPage: async () => pageFactory(controller),
   close: async () => {},
  }),
 });
 return {
  controller,
  unhandled,
  async run() {
   try {
    return await collector.collect('https://expo.example/calendar', {signal: controller.signal});
   } finally {
    await collector.close?.();
   }
  },
  async finish() {
   await new Promise(resolve => setTimeout(resolve, 300));
   process.removeListener('unhandledRejection', onUnhandled);
   return unhandled;
  },
 };
}

test('abort before page.content starts does not leave the page promise unhandled', async () => {
 const ctx = collectWithFakeBrowser(controller => ({
  setDefaultTimeout() {},
  async goto() {},
  // Abort while the render is still in its settling tick, so the following
  // page.content() call receives an already-aborted signal.
  async waitForTimeout() { controller.abort(); },
  content: () => new Promise((_resolve, reject) => setTimeout(() => reject(Error('page.content: Target page, context or browser has been closed')), 40)),
  url: () => 'https://expo.example/calendar',
  async close() {},
 }));
 const result = await ctx.run();
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'ABORTED');
 const unhandled = await ctx.finish();
 assert.equal(unhandled.length, 0, 'no unhandled rejection: ' + unhandled.map(String).join('; '));
});

test('abort while page.content is pending is reported as ABORTED without an unhandled rejection', async () => {
 const ctx = collectWithFakeBrowser(controller => ({
  setDefaultTimeout() {},
  async goto() {},
  async waitForTimeout() {},
  content: () => new Promise((_resolve, reject) => {
   setTimeout(() => controller.abort(), 10);
   setTimeout(() => reject(Error('page.content: Target page, context or browser has been closed')), 60);
  }),
  url: () => 'https://expo.example/calendar',
  async close() {},
 }));
 const result = await ctx.run();
 assert.equal(result.ok, false);
 assert.equal(result.error.code, 'ABORTED');
 const unhandled = await ctx.finish();
 assert.equal(unhandled.length, 0, 'no unhandled rejection: ' + unhandled.map(String).join('; '));
});
