import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyRecipe, openRecipeStore} from '../server/recipes.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collector');
const fixture = name => readFileSync(join(FIXTURES, name), 'utf8');

function withTempStore(run) {
 const dir = mkdtempSync(join(tmpdir(), 'domel-recipes-'));
 try {
  return run({dir, file: join(dir, 'nested', 'recipes.json')});
 } finally {
  rmSync(dir, {recursive: true, force: true});
 }
}

test('recipe store reuses content, bumps versions and persists atomically', () => {
 withTempStore(({dir, file}) => {
  const store = openRecipeStore({file});
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('missing'), null);

  const first = store.propose({
   domain: 'https://expo.example.cn/path/page',
   kind: 'script',
   body: '(input) => ({startDate: input.text})',
   notes: 'llm proposal',
  });
  assert.equal(typeof first.id, 'string');
  assert.equal(first.domain, 'expo.example.cn');
  assert.equal(first.version, 1);
  assert.equal(first.kind, 'script');
  assert.equal(first.status, 'proposed');
  assert.equal(first.proposedBy, 'agent');
  assert.equal(first.notes, 'llm proposal');
  assert.match(first.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  // Same domain+kind+content is reused instead of creating a duplicate.
  const again = store.propose({domain: 'expo.example.cn', kind: 'script', body: '(input) => ({startDate: input.text})'});
  assert.equal(again.id, first.id);
  assert.equal(again.version, 1);
  assert.equal(store.list().length, 1);

  // Same slot, different content: same id, version incremented, re-proposed.
  const revised = store.propose({domain: 'expo.example.cn', kind: 'script', body: '(input) => ({startDate: input.text.slice(0, 10)})'});
  assert.equal(revised.id, first.id);
  assert.equal(revised.version, 2);
  assert.equal(revised.status, 'proposed');

  // Regex bodies are compared on canonical JSON, not source formatting.
  const bodyA = '{"date": {"pattern": "(\\\\d{4})"}, "city": {"pattern": "上海"}}';
  const bodyB = '{"city": {"pattern": "上海"}, "date": {"pattern": "(\\\\d{4})"}}';
  const regexFirst = store.propose({domain: 'expo.example.cn', kind: 'regex', body: bodyA});
  const regexAgain = store.propose({domain: 'expo.example.cn', kind: 'regex', body: bodyB});
  assert.equal(regexFirst.id, regexAgain.id);
  assert.equal(regexAgain.version, 1);

  // Object bodies are persisted as JSON strings (API/type contract stores a string).
  const objectBody = store.propose({domain: 'expo.example.cn', kind: 'regex', body: {city: {pattern: '(北京|上海)'}}});
  assert.equal(typeof objectBody.body, 'string');
  assert.deepEqual(JSON.parse(objectBody.body), {city: {pattern: '(北京|上海)'}});

  // Status flow: proposed -> approved -> disabled; a body change needs re-approval.
  const approved = store.update(first.id, {status: 'approved'});
  assert.equal(approved.status, 'approved');
  assert.equal(approved.version, 2);
  assert.throws(() => store.update(first.id, {status: 'bogus'}), /Unsupported recipe status/);
  const changed = store.update(first.id, {body: '(input) => ({changed: true})'});
  assert.equal(changed.version, 3);
  assert.equal(changed.status, 'proposed');
  assert.equal(store.update(first.id, {status: 'disabled', notes: 'off'}).status, 'disabled');

  // Filters and clone semantics.
  assert.equal(store.list({domain: 'expo.example.cn'}).length, 2);
  assert.equal(store.list({domain: 'expo.example.cn', status: 'disabled'}).length, 1);
  assert.equal(store.list({domain: 'other.example'}).length, 0);
  const fetched = store.get(first.id);
  fetched.status = 'hacked';
  assert.equal(store.get(first.id).status, 'disabled');

  // Persistence is a single JSON file with no temp leftovers.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.recipes.length, 2);
  assert.deepEqual(readdirSync(dirname(file)).filter(name => name.endsWith('.tmp')), []);
  const reopened = openRecipeStore({file});
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.get(first.id).version, 3);

  // Remove and missing-id behaviour.
  assert.deepEqual(store.remove(regexFirst.id), {ok: true});
  assert.equal(store.get(regexFirst.id), null);
  assert.throws(() => store.remove(regexFirst.id), /not found/);

  // Input validation is explicit.
  assert.throws(() => store.propose({domain: 'expo.example.cn', kind: 'python', body: 'x'}), /Unsupported recipe kind/);
  assert.throws(() => store.propose({domain: '', kind: 'script', body: 'x'}), /domain is required/);
  assert.throws(() => store.propose({domain: 'expo.example.cn', kind: 'script', body: '  '}), /body is required/);
  assert.throws(() => store.update('missing', {status: 'approved'}), /not found/);
 });
});

test('script recipes run with input/console only and return plain values', async () => {
 const result = await applyRecipe(
  {kind: 'script', body: '(input) => ({title: input.text.slice(0, 5), url: input.url, jsonLdCount: input.jsonLd.length, hasHtml: input.html.length > 0, logger: typeof console.log})'},
  {html: '<p>你好世界</p>', url: 'https://expo.example.cn/2026', text: '你好世界 2026', jsonLd: [{'@type': 'Event'}]},
 );
 assert.equal(result.ok, true);
 assert.equal(result.values.title, '你好世界 ');
 assert.equal(result.values.url, 'https://expo.example.cn/2026');
 assert.equal(result.values.jsonLdCount, 1);
 assert.equal(result.values.hasHtml, true);
 assert.equal(result.values.logger, 'function');

 const declaration = await applyRecipe({kind: 'script', body: 'function (input) { return {n: input.text.length}; }'}, {text: 'abcd'});
 assert.deepEqual(declaration.values, {n: 4});

 const expression = await applyRecipe({kind: 'script', body: '({fixed: 42})'}, {});
 assert.deepEqual(expression.values, {fixed: 42});

 const asyncScript = await applyRecipe({kind: 'script', body: 'async (input) => ({urlLength: input.url.length})'}, {url: 'https://x.test/'});
 assert.deepEqual(asyncScript.values, {urlLength: 15});

 const silentConsole = await applyRecipe({kind: 'script', body: '(input) => { console.log("SHOULD_NOT_LEAK"); console.error("SHOULD_NOT_LEAK"); return {quiet: true}; }'}, {});
 assert.deepEqual(silentConsole.values, {quiet: true});
});

test('script recipes cannot escape the sandbox', async () => {
 const probe = [
  '(input) => ({',
  ' processType: typeof process,',
  ' requireType: typeof require,',
  ' fetchType: typeof fetch,',
  ' moduleType: typeof module,',
  ' globalProcessType: typeof globalThis.process,',
  " escape: (function () { try { return typeof this.constructor.constructor('return process')(); } catch (error) { return 'blocked'; } })()",
  '})',
 ].join('');
 const result = await applyRecipe({kind: 'script', body: probe}, {});
 assert.equal(result.ok, true);
 assert.equal(result.values.processType, 'undefined');
 assert.equal(result.values.requireType, 'undefined');
 assert.equal(result.values.fetchType, 'undefined');
 assert.equal(result.values.moduleType, 'undefined');
 assert.equal(result.values.globalProcessType, 'undefined');
 assert.match(result.values.escape, /blocked|undefined/);
});

test('script recipes time out after one second', async () => {
 const startedAt = Date.now();
 const result = await applyRecipe({kind: 'script', body: '(input) => { while (true) {} }'}, {});
 assert.equal(result.ok, false);
 assert.equal(result.code, 'TIMEOUT');
 assert.ok(Date.now() - startedAt < 3000);
});

test('script failures are returned as data, not thrown', async () => {
 const thrown = await applyRecipe({kind: 'script', body: '(input) => { throw new Error("boom"); }'}, {});
 assert.equal(thrown.ok, false);
 assert.equal(thrown.code, 'SCRIPT_ERROR');
 assert.match(thrown.error, /boom/);

 const malformed = await applyRecipe({kind: 'script', body: 'function ('}, {});
 assert.equal(malformed.ok, false);
 assert.equal(malformed.code, 'SCRIPT_ERROR');

 const nonObject = await applyRecipe({kind: 'script', body: '(input) => 42'}, {});
 assert.equal(nonObject.ok, false);
 assert.equal(nonObject.code, 'SCRIPT_ERROR');

 const invalidRecipe = await applyRecipe(null, {});
 assert.equal(invalidRecipe.ok, false);
 assert.equal(invalidRecipe.code, 'INVALID_RECIPE');

 const unknownKind = await applyRecipe({kind: 'python', body: 'print(1)'}, {});
 assert.equal(unknownKind.ok, false);
 assert.equal(unknownKind.code, 'UNKNOWN_KIND');
});

test('regex recipes extract fields from page text', async () => {
 const body = JSON.stringify({
  startDate: {pattern: '开始日期[:：]\\s*(\\d{4}-\\d{2}-\\d{2})'},
  deadline: {pattern: '报名截止[:：]\\s*(\\d{4}-\\d{2}-\\d{2})', group: 1},
  organizer: {pattern: '主办=([^；;]+)', group: 1},
  missing: {pattern: '不存在的字段[:：](\\S+)'},
 });
 const result = await applyRecipe({kind: 'regex', body}, {text: '展会开始日期：2026-04-08；报名截止：2026-03-01；主办=中国制冷学会'});
 assert.equal(result.ok, true);
 assert.deepEqual(result.values, {
  startDate: '2026-04-08',
  deadline: '2026-03-01',
  organizer: '中国制冷学会',
  missing: null,
 });

 const objectBody = await applyRecipe({kind: 'regex', body: {code: {pattern: '(A+)-(\\d+)', group: 2}}}, {text: 'AA-77'});
 assert.deepEqual(objectBody.values, {code: '77'});

 const noMatch = await applyRecipe({kind: 'regex', body: {nothing: {pattern: '(x)'}}}, {text: 'abc'});
 assert.deepEqual(noMatch.values, {nothing: null});

 const invalidPattern = await applyRecipe({kind: 'regex', body: {broken: {pattern: '('}}}, {text: 'abc'});
 assert.equal(invalidPattern.ok, false);
 assert.equal(invalidPattern.code, 'REGEX_ERROR');

 const invalidJson = await applyRecipe({kind: 'regex', body: '{not json'}, {text: 'abc'});
 assert.equal(invalidJson.ok, false);
 assert.equal(invalidJson.code, 'INVALID_BODY');
});

test('selector recipes read text and attributes with a minimal CSS engine', async () => {
 const html = fixture('selector-page.html');
 const body = JSON.stringify({
  name: 'div.event a.title',
  href: 'div.event a.title@href',
  date: '.date',
  city: '.event .city',
  id: 'div.event[data-id="e2"]@data-id',
  featured: '.event.featured .title',
  missing: '.does-not-exist',
 });
 const result = await applyRecipe({kind: 'selectors', body}, {html});
 assert.equal(result.ok, true);
 assert.deepEqual(result.values, {
  name: '中国制冷展 2026',
  href: '/events/1',
  date: '2026-04-08',
  city: '上海',
  id: 'e2',
  featured: '暖通展 & 通风展',
  missing: null,
 });

 const inlineBody = await applyRecipe({kind: 'selectors', body: {title: 'h1', link: 'a@href'}}, {html: '<h1>Hello &amp; Hi</h1><a href="/x">L</a>'});
 assert.deepEqual(inlineBody.values, {title: 'Hello & Hi', link: '/x'});

 const malformed = await applyRecipe({kind: 'selectors', body: {broken: 'div['}}, {html});
 assert.equal(malformed.ok, false);
 assert.equal(malformed.code, 'SELECTOR_ERROR');

 const unsupported = await applyRecipe({kind: 'selectors', body: {hover: 'a:hover'}}, {html});
 assert.equal(unsupported.ok, false);
 assert.equal(unsupported.code, 'SELECTOR_ERROR');

 const invalidBody = await applyRecipe({kind: 'selectors', body: [1, 2]}, {html});
 assert.equal(invalidBody.ok, false);
 assert.equal(invalidBody.code, 'INVALID_BODY');
});
