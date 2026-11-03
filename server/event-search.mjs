// Event discovery search.
//
// `event.discover` needs candidate trade shows before the enricher can verify
// them. The primary adapter asks the configured model for JSON candidates; when
// no model is configured we fall back to scanning the human-curated source
// registry pages. Neither adapter treats model output as verified evidence: the
// event store keeps every candidate at low confidence until enrichment reads an
// official page.

import {readFileSync} from 'node:fs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_CONFIDENCE = new Set(['high', 'medium', 'low']);
const CURRENT_YEARS = () => {
 const year = new Date().getFullYear();
 return [year, year + 1];
};

export function loadCompanyProfile(file) {
 try {
  return JSON.parse(readFileSync(file, 'utf8'));
 } catch {
  return {
   name: 'Domel',
   aliases: [],
   industries: ['Electric motors and drives', 'HVAC and ventilation'],
   products: [],
   solutions: [],
   chinaEntity: {name: '多麦机电（苏州）有限公司', city: 'Suzhou', country: 'China'},
   keywords: [],
  };
 }
}

// Deterministic queries keep discovery reproducible and keep the model focused
// on the company's actual applications instead of generic motor shows.
export function buildDiscoveryQueries(company, {region = 'cn', years = CURRENT_YEARS(), limit = 3} = {}) {
 const entity = company.chinaEntity?.name || company.name || 'Domel';
 // The committed seed keeps localized keyword lists under an object; accept
 // both a flat array and that shape.
 const keywordList = Array.isArray(company.keywords)
  ? company.keywords
  : Object.values(company.keywords ?? {}).flatMap(value => Array.isArray(value) ? value : []);
 const focus = [
  ...(company.industries ?? []).slice(0, 4),
  ...(company.solutions ?? []).slice(0, 4),
  ...keywordList.slice(0, 4),
 ].filter(Boolean);
 const regionText = region === 'cn' ? '中国 展会 博览' : 'trade show exhibition';
 const queries = [];
 for (const year of years.slice(0, 2)) {
  queries.push([entity, ...focus.slice(0, 3), regionText, String(year), '展位 报名 展馆'].join(' '));
 }
 if (focus.length) queries.push([focus.slice(0, 2).join(' '), regionText, years[0], 'exhibitor list booth price'].join(' '));
 return [...new Set(queries)].slice(0, Math.max(1, limit));
}

export function normalizeCandidates(raw, {limit = 30} = {}) {
 if (!Array.isArray(raw)) return [];
 const cleaned = [];
 const seen = new Set();
 for (const item of raw) {
  if (!item || typeof item !== 'object') continue;
  const name = String(item.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!name) continue;
  const startDate = DATE.test(String(item.startDate ?? '')) ? String(item.startDate) : null;
  const endDate = DATE.test(String(item.endDate ?? '')) ? String(item.endDate) : null;
  const website = httpUrl(item.website);
  const sourceUrl = httpUrl(item.sourceUrl);
  const key = name.toLowerCase().replace(/[\s·\-—_()（）]/g, '') + '|' + (startDate ?? '');
  if (seen.has(key)) continue;
  seen.add(key);
  cleaned.push({
   name,
   city: String(item.city ?? '').trim().slice(0, 100),
   venue: String(item.venue ?? '').trim().slice(0, 200),
   startDate,
   endDate,
   website,
   sourceUrl,
   industries: Array.isArray(item.industries) ? item.industries.map(value => String(value).slice(0, 80)).slice(0, 8) : [],
   confidence: ALLOWED_CONFIDENCE.has(item.confidence) ? item.confidence : 'low',
   source: 'search',
  });
  if (cleaned.length >= limit) break;
 }
 return cleaned;
}

function httpUrl(value) {
 const text = String(value ?? '').trim();
 if (!text) return null;
 try {
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href;
 } catch {
  return null;
 }
}

const GENERIC_NAME_TOKENS = new Set([
 'china', 'chinese', 'international', 'exhibition', 'expo', 'show', 'fair', 'trade', 'the', 'and', 'for', 'of',
 '中国', '国际', '展览会', '博览会', '展会', '展览', '大会', '第', '届',
]);

// Event names come back in mixed Chinese/English. Token matching is a cheap way
// to check whether a search result / fetched page is really about this event
// before the collector claims a page as the official website.
export function eventNameTokens(name) {
 const text = String(name ?? '').toLowerCase();
 const latin = (text.match(/[a-z0-9]{3,}/g) ?? []).filter(token => !GENERIC_NAME_TOKENS.has(token));
 const cjk = (text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []).filter(token => !GENERIC_NAME_TOKENS.has(token));
 return [...new Set([...latin, ...cjk])].slice(0, 12);
}

export function pageMatchesEvent(event, page = {}) {
 const tokens = eventNameTokens(event?.name);
 if (!tokens.length) return false;
 const haystack = [
  page.title,
  ...Object.values(page.values ?? {}),
 ].filter(value => typeof value === 'string').join(' ').toLowerCase();
 return tokens.some(token => haystack.includes(token));
}

const JUNK_HOSTS = [
 'baidu.com', 'zhihu.com', 'sohu.com', '163.com', 'sina.com.cn', 'weibo.com', 'weixin.qq.com',
 'bilibili.com', 'douyin.com', 'xiaohongshu.com', 'google.com', 'bing.com', 'wikipedia.org',
 'hc360.com', 'chinaiol.com', 'rhvcmag.com', 'ehvacr.com', 'alibaba.com', 'made-in-china.com',
];

// Rank web results for "this event's official website" and drop obvious
// aggregators/document files. Search relevance is not evidence on its own: the
// caller only accepts the URL after the page was fetched and matched.
export function rankEventWebsiteResults(event, results, {limit = 3} = {}) {
 const tokens = eventNameTokens(event?.name);
 const ranked = [];
 for (const item of Array.isArray(results) ? results : []) {
  const url = httpUrl(item?.url);
  if (!url) continue;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
  if (JUNK_HOSTS.some(junk => host === junk || host.endsWith('.' + junk))) continue;
  if (/\.(pdf|docx?|pptx?|xlsx?|zip|rar)$/i.test(url)) continue;
  const title = String(item.title ?? '');
  const haystack = (host + ' ' + title + ' ' + url).toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += token.length >= 5 ? 2 : 1;
  if (/(官网|官方网站|official|homepage)/i.test(title)) score += 3;
  if (/\/(news|article|blog|press|detail|contact|about|privacy)\//i.test(url)) score -= 2;
  // The official website should be the site root (or a landing page), not a
  // deep contact/about page. Only reward the root for results that already
  // matched the event name: otherwise an unrelated one-segment URL would float
  // to the top and waste fetch budget.
  if (score > 0) {
   let path = '';
   try { path = new URL(url).pathname; } catch { /* invalid URLs were filtered above */ }
   const segments = path.split('/').filter(Boolean);
   if (segments.length === 0) score += 4;
   else if (segments.length === 1) score += 2;
  }
  ranked.push({url, title, score});
 }
 ranked.sort((left, right) => right.score - left.score || left.url.length - right.url.length);
 // When at least one result looks like the official event site, do not spend
 // rate-limited fetch budget on zero-relevance results.
 const best = ranked[0]?.score ?? 0;
 return (best > 0 ? ranked.filter(item => item.score > 0) : ranked).slice(0, limit);
}

// `webSearch` adapter for event enrichment: search results are candidate URLs
// only, never evidence by themselves. DeepSeek exposes its search tool next to
// the chat endpoint already used for research.
export function createDeepSeekWebSearch({apiKey, baseUrl = 'https://api.deepseek.com', fetchImpl = fetch, timeoutMs = 20000}) {
 if (!apiKey) throw Error('DEEPSEEK_API_KEY is not configured');
 const endpoint = String(baseUrl).replace(/\/$/, '') + '/v1/tools/search';
 return {
  async search({query, count = 8} = {}) {
   const response = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
    headers: {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: String(query ?? ''), count, need_content: false, ori_question: String(query ?? '').slice(0, 128)}),
   });
   if (!response.ok) throw Error('Web search failed (HTTP ' + response.status + ')');
   const payload = await response.json().catch(() => { throw Error('Web search returned invalid JSON'); });
   const results = Array.isArray(payload?.results) ? payload.results : [];
   return results.map(item => ({url: httpUrl(item.url), title: String(item.title ?? item.name ?? '')})).filter(item => item.url);
  },
 };
}

const SYSTEM_PROMPT = [
 'You are a trade-show researcher for a European electric-motor manufacturer (Domel) entering China.',
 'Find real, publicly verifiable trade shows and exhibitions that match the company applications.',
 'Return JSON only: {"events":[{"name":"...","city":"...","venue":"...","startDate":"YYYY-MM-DD" or null,',
 '"endDate":"YYYY-MM-DD" or null,"website":"https://..." or null,"sourceUrl":"https://..." or null,',
 '"industries":["..."],"confidence":"high|medium|low"}]}.',
 'Rules: only real events you are confident about; never invent dates, venues or prices; use null for unknown fields;',
 'website/sourceUrl must be http(s) official pages; do not include commentary; at most the requested number of events.',
].join(' ');

// Models occasionally wrap JSON in markdown fences even in JSON mode. Pull the
// outermost object out instead of failing the whole discovery run.
export function parseJsonContent(content) {
 if (typeof content !== 'string') return null;
 const text = content.trim();
 if (!text) return null;
 const unfenced = text.startsWith('```') ? text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim() : text;
 try {
  return JSON.parse(unfenced);
 } catch {
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
   return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
   return null;
  }
 }
}

export function createDeepSeekEventSearch({apiKey, model = 'deepseek-flash', baseUrl = 'https://api.deepseek.com', fetchImpl = fetch, timeoutMs = 45000}) {
 if (!apiKey) throw Error('DEEPSEEK_API_KEY is not configured');
 const endpoint = String(baseUrl).replace(/\/$/, '') + '/chat/completions';
 return {
  async search({query, region = 'cn', limit = 30, signal} = {}) {
   const body = {
    model,
    temperature: 0,
    // The flash model spends output budget on reasoning; a larger budget plus
    // disabled thinking keeps the JSON answer itself complete.
    max_tokens: 8000,
    stream: false,
    response_format: {type: 'json_object'},
    thinking: {type: 'disabled'},
    messages: [
     {role: 'system', content: SYSTEM_PROMPT},
     {role: 'user', content: JSON.stringify({query, region, limit})},
    ],
   };
   const timeout = AbortSignal.timeout(Math.max(5000, timeoutMs));
   const response = await fetchImpl(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
   });
   if (!response.ok) {
    const hint = {401: 'Check DEEPSEEK_API_KEY.', 402: 'DeepSeek balance is insufficient.', 429: 'Provider rate limit reached; retry later.'}[response.status] || 'Provider unavailable.';
    throw Error('Event discovery search failed (HTTP ' + response.status + '). ' + hint);
   }
   const payload = await response.json().catch(() => { throw Error('Event discovery returned invalid JSON.'); });
   const choice = payload?.choices?.[0];
   if (choice?.finish_reason === 'length') throw Error('Event discovery answer was truncated; try a smaller limit.');
   const content = choice?.message?.content;
   const parsed = parseJsonContent(content);
   if (!parsed) throw Error('Event discovery returned invalid JSON.');
   return normalizeCandidates(parsed.events, {limit});
  },
 };
}

// Heuristic extraction for registry pages: enough to propose candidates from
// exhibition calendars without a model. Enrichment is what verifies them.
export function extractEventCandidates(text, {url, limit = 20, years = CURRENT_YEARS(), geo = null} = {}) {
 const yearSet = new Set(years.map(String));
 const lines = String(text ?? '').split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
 const found = [];
 const seen = new Set();
 const datePattern = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g;
 const dateToken = /^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|20\d{2}[-/.年]\d{1,2})$/;
 const separatorToken = /^(?:至|到|-|–|—|~|～)$/;
 for (const line of lines) {
  if (!/(展|博览会|Expo|Fair|Trade Show|Exhibition|Messe)/i.test(line)) continue;
  const dates = [...line.matchAll(datePattern)];
  if (!dates.length) continue;
  if (!dates.some(match => yearSet.has(match[1]))) continue;
  // The event name is usually the text before the first date/date-range marker.
  const tokens = line.split(/\s+/);
  const stop = tokens.findIndex(token => dateToken.test(token) || separatorToken.test(token));
  let name = (stop > 0 ? tokens.slice(0, stop) : tokens).join(' ');
  name = name.replace(/^20\d{2}\s+/, '').replace(/[\s|｜,，;；:：-]+$/, '').trim().slice(0, 160);
  if (!name || name.length < 4) continue;
  const startDate = isoDate(dates[0]);
  const endDate = dates[1] ? isoDate(dates[1]) : null;
  const key = name.toLowerCase() + '|' + startDate;
  if (seen.has(key)) continue;
  seen.add(key);
  // Prefer the stored geography table; the built-in lists are only the
  // no-geo fallback used by isolated tests.
  const storedCity = geo ? geo.city(line) : null;
  const storedVenue = geo ? geo.venue(line) : null;
  const city = storedCity ? (storedCity.name ?? storedCity.city ?? '') : inferCity(line);
  const venue = storedVenue ? (storedVenue.venue ?? '') : inferVenue(line);
  found.push({
   name,
   city,
   venue,
   startDate,
   endDate,
   website: null,
   sourceUrl: url ?? null,
   industries: [],
   confidence: 'low',
   source: 'registry-scan',
  });
  if (found.length >= limit) break;
 }
 return found;
}

function isoDate(match) {
 const month = String(match[2]).padStart(2, '0');
 const day = String(match[3]).padStart(2, '0');
 return match[1] + '-' + month + '-' + day;
}

const CITIES = ['上海', '北京', '广州', '深圳', '天津', '重庆', '成都', '杭州', '南京', '武汉', '西安', '苏州', '青岛', '厦门', '郑州', '长沙', '合肥', '济南', '沈阳', '大连', '东莞', '佛山'];
const VENUES = [
 '国家会展中心（上海）', '国家会展中心(上海)', '上海新国际博览中心', '深圳国际会展中心', '广交会展馆',
 '中国国际展览中心', '上海世博展览馆', '杭州国际博览中心', '成都世纪城新国际会展中心', '武汉国际博览中心',
 '天津国家会展中心', '南京国际博览中心', '苏州国际博览中心', '中国进出口商品交易会展馆',
];

function inferCity(line) {
 return CITIES.find(city => line.includes(city)) ?? '';
}

function inferVenue(line) {
 return VENUES.find(venue => line.includes(venue)) ?? '';
}

// Fallback discovery without a model: read a few enabled registry pages and
// extract date + exhibition lines. Network use is bounded by maxSources and a
// short per-page timeout; the caller decides whether the result is acceptable.
export function createRegistryScanSearch({registry, collector, company, maxSources = 6, years = CURRENT_YEARS(), geo = null}) {
 return {
  async search({region = 'cn', limit = 20} = {}) {
   const sources = registry ? registry.list({region, enabled: true}).slice(0, maxSources) : [];
   if (!sources.length) {
    throw Error('No enabled ' + region + ' sources are registered for discovery; configure sources or a search provider.');
   }
   const candidates = [];
   const notices = [];
   for (const source of sources) {
    try {
     const page = await collector.collect(source.url, {allowPlaywright: false});
     if (page.ok) candidates.push(...extractEventCandidates(page.text, {url: source.url, years, limit, geo}));
     else notices.push(source.url + ': ' + (page.error?.message ?? 'unavailable'));
    } catch (error) {
     notices.push(source.url + ': ' + (error instanceof Error ? error.message : 'failed'));
    }
    if (candidates.length >= limit) break;
   }
   const unique = normalizeCandidates(candidates.map(({source: _source, ...candidate}) => ({...candidate, confidence: 'low'})), {limit});
   for (const item of unique) item.sourceUrl = item.sourceUrl || sources[0]?.url || null;
   if (!unique.length && notices.length) {
    const error = Error('Registry scanning found no event candidates. ' + notices.slice(0, 3).join('; '));
    error.notices = notices;
    throw error;
   }
   return unique;
  },
 };
}
