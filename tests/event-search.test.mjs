import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {
 buildDiscoveryQueries, createDeepSeekEventSearch, createDeepSeekWebSearch, createRegistryScanSearch,
 eventNameTokens, extractEventCandidates, loadCompanyProfile, normalizeCandidates,
 pageMatchesEvent, rankEventWebsiteResults,
} from '../server/event-search.mjs';

const company = {
 name: 'Domel',
 aliases: ['多麦机电（苏州）有限公司'],
 industries: ['Electric motors and drives', 'HVAC and ventilation'],
 solutions: ['Industrial ventilation and fume extraction'],
 keywords: ['EC motor', 'EC 电机'],
 chinaEntity: {name: '多麦机电（苏州）有限公司', city: 'Suzhou'},
};

test('normalizeCandidates validates dates, dedupes names and drops invalid entries', () => {
 const candidates = normalizeCandidates([
  {name: '中国制冷展 2026', startDate: '2026-04-08', endDate: '2026-04-10', website: 'https://www.cr-expo.com', confidence: 'high'},
  {name: '中国制冷展 2026', startDate: '2026-04-08', website: 'https://duplicate.example'},
  {name: '   ', startDate: '2026-01-01'},
  {name: 'Bad date show', startDate: 'April 2026'},
  {name: 'No website expo', city: '上海'},
  {name: 'FTP expo', website: 'ftp://example.com'},
 ], {limit: 10});
 assert.equal(candidates.length, 4);
 assert.equal(candidates[0].name, '中国制冷展 2026');
 assert.equal(candidates[0].website, 'https://www.cr-expo.com/');
 assert.equal(candidates[0].confidence, 'high');
 assert.equal(candidates[1].startDate, null);
 assert.equal(candidates[1].website, null);
 assert.equal(candidates[3].confidence, 'low');
 assert.equal(candidates[0].source, 'search');
});

test('normalizeCandidates enforces the limit', () => {
 const raw = Array.from({length: 5}, (_, index) => ({name: 'Expo ' + index}));
 assert.equal(normalizeCandidates(raw, {limit: 2}).length, 2);
 assert.equal(normalizeCandidates(null).length, 0);
});

test('buildDiscoveryQueries uses the Chinese entity and the requested years', () => {
 const queries = buildDiscoveryQueries(company, {region: 'cn', years: [2026, 2027], limit: 3});
 assert.ok(queries.length >= 1 && queries.length <= 3);
 assert.match(queries[0], /多麦机电（苏州）/);
 assert.match(queries[0], /2026/);
 assert.match(queries[0], /中国/);
 assert.ok(queries.every(query => query.length > 10));
});

test('createDeepSeekEventSearch posts a JSON request and normalizes the answer', async () => {
 let captured;
 const fetchImpl = async (url, init) => {
  captured = {url, init, body: JSON.parse(init.body)};
  return new Response(JSON.stringify({
   choices: [{message: {content: JSON.stringify({events: [
    {name: '中国国际工业博览会 2026', city: '上海', venue: '国家会展中心（上海）', startDate: '2026-09-15', endDate: '2026-09-19', website: 'https://www.ciif-expo.com', confidence: 'medium'},
    {name: 'ISH China & CIHE 2027', city: '北京', startDate: '2027-05-12', website: 'https://www.ishc-cihe.com'},
   ]})}}],
  }), {status: 200, headers: {'Content-Type': 'application/json'}});
 };
 const search = createDeepSeekEventSearch({apiKey: 'test-key', fetchImpl, timeoutMs: 1000});
 const events = await search.search({query: 'HVAC 展会 2026', region: 'cn', limit: 10});
 assert.equal(events.length, 2);
 assert.equal(events[0].name, '中国国际工业博览会 2026');
 assert.equal(events[0].confidence, 'medium');
 assert.equal(events[1].startDate, '2027-05-12');
 assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
 assert.equal(captured.body.model, 'deepseek-flash');
 assert.equal(captured.body.response_format.type, 'json_object');
 assert.match(captured.body.messages[0].content, /Return JSON only/);
});

test('createDeepSeekEventSearch surfaces provider errors and invalid JSON', async () => {
 const unauthorized = createDeepSeekEventSearch({
  apiKey: 'bad',
  fetchImpl: async () => new Response('{}', {status: 401}),
 });
 await assert.rejects(unauthorized.search({query: 'x'}), /HTTP 401.*DEEPSEEK_API_KEY/);
 const invalid = createDeepSeekEventSearch({
  apiKey: 'x',
  fetchImpl: async () => new Response(JSON.stringify({choices: [{message: {content: 'not json'}}]}), {status: 200}),
 });
 await assert.rejects(invalid.search({query: 'x'}), /invalid JSON/i);
 assert.throws(() => createDeepSeekEventSearch({apiKey: ''}), /DEEPSEEK_API_KEY/);
});

test('extractEventCandidates reads dated exhibition lines from page text', () => {
 const text = [
  '2026中国制冷展 2026-04-08 至 2026-04-10 上海新国际博览中心 展位申请中',
  '公司新闻：我们参加了上一届展会，收获很大。',
  'ISH China & CIHE 2026 2026/05/12 - 2026/05/14 中国国际展览中心（北京）',
  'Product catalogue and motor specifications are available on request.',
  '2025中国国际工业博览会 2025-09-23 至 2025-09-27 国家会展中心（上海）',
 ].join('\n');
 const candidates = extractEventCandidates(text, {url: 'https://www.cr-expo.com/calendar', years: [2026, 2027]});
 assert.equal(candidates.length, 2);
 assert.equal(candidates[0].startDate, '2026-04-08');
 assert.equal(candidates[0].endDate, '2026-04-10');
 assert.equal(candidates[0].venue, '上海新国际博览中心');
 assert.equal(candidates[1].startDate, '2026-05-12');
 assert.equal(candidates[0].confidence, 'low');
 assert.equal(candidates[0].sourceUrl, 'https://www.cr-expo.com/calendar');
});

test('createRegistryScanSearch scans enabled registry pages and merges sources', async () => {
 const collected = [];
 const registry = {
  list: ({region, enabled}) => {
   assert.equal(region, 'cn');
   assert.equal(enabled, true);
   return [{id: 's1', url: 'https://expo.example/calendar'}, {id: 's2', url: 'https://media.example/shows'}];
  },
 };
 const collector = {
  collect: async url => {
   collected.push(url);
   return {ok: true, text: '2026 中国国际电机博览会 2026-06-03 至 2026-06-05 上海新国际博览中心'};
  },
 };
 const search = createRegistryScanSearch({registry, collector});
 const events = await search.search({region: 'cn', limit: 10});
 assert.equal(collected.length, 2);
 assert.equal(events.length, 1, 'duplicate show name + date should be deduped across sources');
 assert.equal(events[0].name, '中国国际电机博览会');
 assert.equal(events[0].startDate, '2026-06-03');
});

test('createRegistryScanSearch fails clearly when nothing is configured or reachable', async () => {
 const empty = createRegistryScanSearch({registry: {list: () => []}, collector: {collect: async () => ({ok: true})}});
 await assert.rejects(empty.search({region: 'cn'}), /No enabled cn sources/);
 const broken = createRegistryScanSearch({
  registry: {list: () => [{id: 's1', url: 'https://expo.example/calendar'}]},
  collector: {collect: async () => ({ok: false, error: {message: 'TIMEOUT'}})},
 });
 await assert.rejects(broken.search({region: 'cn'}), /found no event candidates.*TIMEOUT/);
});

test('the committed company seed can be loaded for discovery prompts', () => {
 const profile = loadCompanyProfile(join(process.cwd(), 'seed', 'company-domel.json'));
 assert.equal(profile.name, 'Domel');
 assert.ok(profile.industries.length >= 3);
 assert.ok(profile.chinaEntity.name.includes('多麦机电'));
 const keywords = Array.isArray(profile.keywords) ? profile.keywords : Object.values(profile.keywords).flat();
 assert.ok(keywords.length > 0);
});

test('eventNameTokens keeps significant words and pageMatchesEvent checks title/values', () => {
 const tokens = eventNameTokens('China International Fluid Machinery Exhibition 中国国际流体机械展览会');
 assert.ok(tokens.includes('fluid'));
 assert.ok(tokens.includes('machinery'));
 assert.ok(!tokens.includes('china'));
 assert.ok(!tokens.includes('international'));
 assert.ok(tokens.some(token => token.includes('流体')));
 assert.equal(pageMatchesEvent({name: 'China International Fluid Machinery Exhibition'}, {title: 'Fluid Machinery Expo 2027'}), true);
 assert.equal(pageMatchesEvent({name: 'China International Fluid Machinery Exhibition'}, {title: 'Unrelated portal'}), false);
});

test('rankEventWebsiteResults drops aggregators and ranks official titles', () => {
 const event = {name: 'China International Fluid Machinery Exhibition'};
 const ranked = rankEventWebsiteResults(event, [
  {url: 'https://www.baidu.com/s?wd=fluid', title: '百度搜索结果'},
  {url: 'https://www.zhihu.com/question/1', title: '流体机械展怎么样'},
  {url: 'https://www.fluidmachineryexpo.com/en/news/2026', title: '行业新闻'},
  {url: 'https://www.fluidmachineryexpo.com/', title: 'China International Fluid Machinery Exhibition 官网'},
 ], {limit: 3});
 assert.equal(ranked.length, 2);
 assert.equal(ranked[0].url, 'https://www.fluidmachineryexpo.com/');
 assert.ok(!ranked.some(item => item.url.includes('baidu') || item.url.includes('zhihu')));
});

test('createDeepSeekWebSearch calls the provider search tool and normalizes results', async () => {
 let captured;
 const fetchImpl = async (url, init) => {
  captured = {url, body: JSON.parse(init.body), auth: init.headers.Authorization};
  return new Response(JSON.stringify({results: [
   {url: 'https://www.fluidmachineryexpo.com/', title: 'Official'},
   {url: 'not-a-url', title: 'Broken'},
  ]}), {status: 200, headers: {'Content-Type': 'application/json'}});
 };
 const webSearch = createDeepSeekWebSearch({apiKey: 'test-key', fetchImpl, timeoutMs: 1000});
 const results = await webSearch.search({query: '中国国际流体机械展览会 官网', count: 8});
 assert.equal(captured.url, 'https://api.deepseek.com/v1/tools/search');
 assert.equal(captured.body.query, '中国国际流体机械展览会 官网');
 assert.equal(captured.body.count, 8);
 assert.equal(captured.auth, 'Bearer test-key');
 assert.equal(results.length, 1);
 assert.equal(results[0].url, 'https://www.fluidmachineryexpo.com/');
 const failed = createDeepSeekWebSearch({apiKey: 'x', fetchImpl: async () => new Response('{}', {status: 429})});
 await assert.rejects(failed.search({query: 'q'}), /HTTP 429/);
 assert.throws(() => createDeepSeekWebSearch({apiKey: ''}), /DEEPSEEK_API_KEY/);
});
