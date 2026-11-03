// Task handlers for the event library: discover then enrich.
//
// Discovery is deliberately cheap and trust-free: it only turns search
// candidates into low-confidence rows. Enrichment is the evidence step: it
// fetches the official page, prefers JSON-LD Event data over regex/title
// heuristics, records document links with their availability (probed, never
// downloaded) and writes Chinese notes for whatever is still missing. Both
// handlers are pure functions of injected dependencies so tests never touch the
// network.

import {toDateOnly} from './event-store.mjs';
import {pageMatchesEvent, rankEventWebsiteResults} from './event-search.mjs';

const EVENT_STATUS_RANK = {discovered: 0, enriched: 1, verified: 2, archived: 3};
const CONFIDENCE_RANK = {low: 0, medium: 1, high: 2};
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
const DATE_FIELDS = ['startDate', 'endDate', 'applicationDeadline'];
const DATE_LABELS = {startDate: '开始日期', endDate: '结束日期', applicationDeadline: '报名截止日期'};
const MAX_COLLECT_URLS = 6;
const MAX_DOCUMENTS = 10;
const MAX_CANDIDATES = 200;

const DOCUMENT_EXTENSION_RE = /\.(pdf|docx?|pptx?|xlsx?|csv|ofd|rtf|zip|rar|7z|txt|md)$/i;
const EXHIBITOR_RE = /(参展商|展商名单|参展企业|exhibitor)/i;
const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const LINK_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;

const CITY_NAMES = [
 '上海', '北京', '广州', '深圳', '天津', '重庆', '成都', '杭州', '南京', '武汉', '西安',
 '苏州', '青岛', '厦门', '郑州', '长沙', '合肥', '济南', '沈阳', '大连', '东莞', '佛山',
 '宁波', '无锡', '常州', '温州', '嘉兴', '绍兴', '台州', '泉州', '南通', '扬州', '徐州',
 '烟台', '潍坊', '临沂', '洛阳', '唐山', '保定', '廊坊', '包头', '呼和浩特', '银川', '西宁',
 '昆明', '南宁', '福州', '石家庄', '太原', '贵阳', '海口', '珠海', '中山', '长春', '哈尔滨',
 '香港', '澳门', '台北',
];
const KNOWN_VENUES = [
 '国家会展中心（上海）', '国家会展中心(上海)', '上海新国际博览中心', '深圳国际会展中心',
 '广交会展馆', '中国进出口商品交易会展馆', '中国国际展览中心', '上海世博展览馆',
 '杭州国际博览中心', '成都世纪城新国际会展中心', '武汉国际博览中心', '天津国家会展中心',
 '南京国际博览中心', '苏州国际博览中心', '厦门国际会展中心', '青岛国际会展中心',
];
const VENUE_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,40}?(?:国际会展中心|国际博览中心|会展中心|博览中心|展览中心|国际会议中心|展馆))/;
const INDUSTRY_HINTS = [
 ['制冷', '制冷'], ['空调', '暖通空调'], ['暖通', '暖通空调'], ['供热', '暖通空调'], ['通风', '通风'],
 ['hvac', '暖通空调'], ['电机', '电机'], ['motor', '电机'], ['风机', '风机'], ['家电', '家电'],
 ['电动工具', '电动工具'], ['泵', '泵阀'], ['阀门', '泵阀'], ['驱动', '驱动'], ['自动化', '工业自动化'],
 ['智能制造', '智能制造'], ['储能', '储能'], ['新能源', '新能源'], ['环保', '环保'], ['包装', '包装'],
 ['印刷', '印刷'], ['医疗', '医疗'], ['实验室', '实验室'],
];
const DEFAULT_QUERIES = {
 cn: ['中国 暖通 制冷 电机 展会 2026 2027', '多麦机电 Domel 参展 展会 2026', 'HVAC EC 电机 展会 中国 2026'],
 eu: ['HVAC EC motor trade fair 2026 2027', 'Domel trade show Europe 2026', 'ventilation motor exhibition 2026'],
 global: ['HVAC EC motor trade fair 2026 2027', 'Domel trade show 2026', 'ventilation motor exhibition 2026'],
};

// ---- small helpers ---------------------------------------------------------

function text(value) {
 if (value === null || value === undefined) return '';
 if (typeof value === 'string') return value.trim();
 if (typeof value === 'number' || typeof value === 'boolean') return String(value);
 return '';
}

function stringList(value) {
 if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
 if (typeof value === 'string') {
  return value.split(/[,，;；、|]/).map(item => item.trim()).filter(Boolean);
 }
 return [];
}

function uniqueValues(values) {
 const seen = new Set();
 const result = [];
 for (const value of values) {
  if (!value || seen.has(value)) continue;
  seen.add(value);
  result.push(value);
 }
 return result;
}

function isoNow(nowMs) {
 return new Date(nowMs).toISOString();
}

// HTML attributes and search snippets carry entity-encoded URLs
// ("...aspx?id=2026&amp;zhid=21"). Decode before URL parsing so the stored
// links are usable verbatim; a single pass avoids decoding "&amp;lt;" twice.
function decodeHtmlEntities(value) {
 const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
 return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
  const lower = entity.toLowerCase();
  let code = null;
  if (lower.startsWith('#x')) code = parseInt(lower.slice(2), 16);
  else if (lower.startsWith('#')) code = parseInt(lower.slice(1), 10);
  if (code !== null) {
   if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
   return String.fromCodePoint(code);
  }
  return named[lower] ?? match;
 });
}

function httpUrl(value) {
 const raw = decodeHtmlEntities(text(value)).trim();
 if (!raw) return null;
 try {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  return url.href;
 } catch {
  return null;
 }
}

function resolveHttpUrl(href, baseUrl) {
 const raw = decodeHtmlEntities(text(href)).trim();
 if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return null;
 try {
  const url = new URL(raw, baseUrl || undefined);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  return url.href;
 } catch {
  return null;
 }
}

function domainOf(url) {
 try {
  return new URL(url).hostname.toLowerCase();
 } catch {
  return '';
 }
}

function isAborted(signal) {
 return Boolean(signal?.aborted);
}

function abortError() {
 const error = Error('Cancelled by user');
 // Cancellation must not be retried by the queue.
 error.permanent = true;
 return error;
}

function throwIfAborted(signal) {
 if (isAborted(signal)) throw abortError();
}

function needsValue(value) {
 return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function maxConfidence(a, b) {
 return (CONFIDENCE_RANK[b] ?? 0) > (CONFIDENCE_RANK[a] ?? 0) ? b : a;
}

function minConfidence(a, b) {
 return (CONFIDENCE_RANK[b] ?? 0) < (CONFIDENCE_RANK[a] ?? 0) ? b : a;
}

function maxStatus(a, b) {
 return (EVENT_STATUS_RANK[b] ?? 0) > (EVENT_STATUS_RANK[a] ?? 0) ? b : a;
}

function stripHtml(html) {
 return String(html ?? '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|td|th)\s*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/g, "'")
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n')
  .trim();
}

function cleanTitle(title) {
 const value = text(title);
 if (!value) return '';
 return value.replace(/\s*[-_|–—]\s*[^-_|–—]{1,30}$/, '').slice(0, 160).trim();
}

// ---- JSON-LD Event extraction ---------------------------------------------

function jsonLdEvents(html) {
 const events = [];
 const visit = value => {
  if (Array.isArray(value)) {
   for (const item of value) visit(item);
   return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value['@graph'])) visit(value['@graph']);
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some(type => /event/i.test(text(type)))) events.push(value);
 };
 const source = String(html ?? '');
 let match;
 JSON_LD_RE.lastIndex = 0;
 while ((match = JSON_LD_RE.exec(source))) {
  const raw = match[1].trim();
  if (!raw) continue;
  try {
   visit(JSON.parse(raw));
  } catch {
   try {
    visit(JSON.parse(raw.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')));
   } catch { /* malformed JSON-LD is not evidence */ }
  }
 }
 return events;
}

function jsonLdEventValues(raw, geo = null) {
 const values = {};
 const name = text(raw.name);
 if (name) values.name = name;
 const startDate = toDateOnly(raw.startDate);
 if (startDate) values.startDate = startDate;
 const endDate = toDateOnly(raw.endDate);
 if (endDate) values.endDate = endDate;
 const location = Array.isArray(raw.location) ? raw.location[0] : raw.location;
 if (location && typeof location === 'object') {
  if (text(location.name)) values.venue = text(location.name);
  const address = Array.isArray(location.address) ? location.address[0] : location.address;
  if (address && typeof address === 'object') {
   if (text(address.addressLocality)) values.city = text(address.addressLocality);
   if (text(address.addressCountry)) {
    const countryCode = text(address.addressCountry);
    const stored = geo ? geo.country(countryCode) : null;
    const resolved = stored ? stored.country : countryName(countryCode);
    if (resolved) values.country = resolved;
   }
  } else if (typeof address === 'string' && address.trim()) {
   const city = CITY_NAMES.find(item => address.includes(item));
   if (city) values.city = city;
  }
 } else if (typeof location === 'string' && location.trim()) {
  values.venue = location.trim();
 }
 const organizer = Array.isArray(raw.organizer) ? raw.organizer[0] : raw.organizer;
 if (organizer && typeof organizer === 'object' && text(organizer.name)) values.organizer = text(organizer.name);
 else if (typeof organizer === 'string' && organizer.trim()) values.organizer = organizer.trim();
 const website = httpUrl(raw.url);
 if (website) values.website = website;
 const industries = uniqueValues(stringList(raw.keywords ?? raw.industry)).slice(0, 8);
 if (industries.length) values.industries = industries;
 return values;
}

function countryName(value) {
 const raw = text(value).toLowerCase();
 if (['cn', 'chn', 'china', '中国', '中华人民共和国'].includes(raw)) return 'China';
 return text(value);
}

// ---- heuristics (fill gaps JSON-LD did not cover) --------------------------

function isoFromParts(year, month, day) {
 const y = Number(year);
 const m = Number(month);
 const d = Number(day);
 if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
 if (m < 1 || m > 12 || d < 1 || d > 31) return null;
 const date = new Date(Date.UTC(y, m - 1, d));
 if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
 return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Chinese/ISO date ranges commonly found on exhibition pages:
// "2026年11月5日-7日", "2026年11月5日至2026年11月7日", "2026-11-05 ~ 2026-11-07",
// "2026.11.05-11.07". Returns the first plausible range or single start date.
function extractDateRange(body) {
 const source = String(body ?? '');
 const sameMonth = /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:[-–—~～至到])\s*(\d{1,2})\s*日/.exec(source);
 if (sameMonth) {
  const startDate = isoFromParts(sameMonth[1], sameMonth[2], sameMonth[3]);
  const endDate = isoFromParts(sameMonth[1], sameMonth[2], sameMonth[4]);
  if (startDate) return {startDate, endDate};
 }
 const fullRange = /(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?\s*(?:[-–—~～至到])\s*(?:(20\d{2})\s*[年./-]\s*)?(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/.exec(source);
 if (fullRange) {
  const startDate = isoFromParts(fullRange[1], fullRange[2], fullRange[3]);
  const endDate = isoFromParts(fullRange[4] ?? fullRange[1], fullRange[5], fullRange[6]);
  if (startDate) return {startDate, endDate};
 }
 const sameYear = /(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[-–—~～至到]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/.exec(source);
 if (sameYear) {
  const startDate = isoFromParts(sameYear[1], sameYear[2], sameYear[3]);
  const endDate = isoFromParts(sameYear[1], sameYear[4], sameYear[5]);
  if (startDate) return {startDate, endDate};
 }
 const single = /(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/.exec(source);
 if (single) {
  const startDate = isoFromParts(single[1], single[2], single[3]);
  if (startDate) return {startDate, endDate: null};
 }
 return {startDate: null, endDate: null};
}

function inferCity(body) {
 return CITY_NAMES.find(city => body.includes(city)) ?? '';
}

function inferVenue(body) {
 const known = KNOWN_VENUES.find(venue => body.includes(venue));
 if (known) return known;
 const match = VENUE_RE.exec(body);
 return match ? match[1].trim() : '';
}

function inferOrganizer(body) {
 const match = /(?:主办单位|主办方|主办机构|承办单位|organizer)\s*[:：]?\s*([^\n，,。；;|]{2,40})/i.exec(body);
 return match ? match[1].trim().replace(/[等\s]+$/, '') : '';
}

function inferDeadline(body) {
 const labelled = /(?:报名截止(?:日期|时间)?|参展报名截止(?:日期)?|截止报名|截止日期|deadline)\s*[:：]?\s*(20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/i.exec(body);
 if (labelled) return toDateOnly(labelled[1]);
 const reversed = /(20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)\s*(?:前|之前)?\s*(?:报名\s*)?截止/.exec(body);
 if (reversed) return toDateOnly(reversed[1]);
 return null;
}

function inferBoothPrice(body) {
 const match = /(?:展位(?:费|价格|费用)|booth\s*price)\s*[:：]?\s*([^\n。；;]{2,60})/i.exec(body);
 if (!match) return '';
 return match[1].trim().replace(/^[:：\s]+/, '').slice(0, 80);
}

function inferIndustries(body) {
 const lower = body.toLowerCase();
 const labels = [];
 for (const [needle, label] of INDUSTRY_HINTS) {
  if (lower.includes(needle.toLowerCase())) labels.push(label);
 }
 return uniqueValues(labels).slice(0, 6);
}

function inferWebsite(html, baseUrl) {
 const source = String(html ?? '');
 const canonical = /<link[^>]+rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(source)
  ?? /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*rel\s*=\s*["']canonical["']/i.exec(source);
 if (canonical) {
  const url = resolveHttpUrl(canonical[1], baseUrl);
  if (url) return url;
 }
 const og = /<meta[^>]+property\s*=\s*["']og:url["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(source)
  ?? /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:url["']/i.exec(source);
 if (og) {
  const url = resolveHttpUrl(og[1], baseUrl);
  if (url) return url;
 }
 return null;
}

// ---- page analysis ---------------------------------------------------------

function findLinks(html, baseUrl) {
 const links = [];
 const source = String(html ?? '');
 let match;
 LINK_RE.lastIndex = 0;
 while ((match = LINK_RE.exec(source))) {
  const url = resolveHttpUrl(match[1] ?? match[2], baseUrl);
  if (!url) continue;
  links.push({url, title: stripHtml(match[3]).slice(0, 120)});
 }
 return links;
}

function documentType(url) {
 try {
  const match = DOCUMENT_EXTENSION_RE.exec(new URL(url).pathname);
  return match ? match[1].toLowerCase() : 'link';
 } catch {
  return 'link';
 }
}

function isDocumentUrl(url) {
 return DOCUMENT_EXTENSION_RE.test(new URL(url).pathname);
}

// A probed link keeps its URL-level nature: a direct file is downloadable unless
// the server says it is restricted, and an HTML page stays `linked` even though
// HEAD succeeded (the page itself is not the document).
async function probeAvailability(probe, url, fallback, {signal} = {}) {
 if (typeof probe !== 'function') return fallback;
 try {
  const result = await probe(url, {signal});
  if (!result) return fallback;
  if (result.availability === 'restricted') return 'restricted';
  if (result.status === 401 || result.status === 403) return 'restricted';
  if (result.ok === false) return fallback === 'downloadable' ? 'unknown' : fallback;
  if (result.availability === 'downloadable' && fallback === 'downloadable') return 'downloadable';
  return fallback;
 } catch (error) {
  if (isAborted(signal)) throw abortError();
  return fallback;
 }
}

function analyzePage(page, geo = null) {
 const html = typeof page.html === 'string' ? page.html : '';
 const pageUrl = httpUrl(page.finalUrl) ?? httpUrl(page.url) ?? null;
 const title = text(page.title);
 const extractedText = text(page.text);
 const bodyText = [title, extractedText || stripHtml(html)].filter(Boolean).join('\n');
 const values = {};
 let structured = false;
 for (const raw of jsonLdEvents(html)) {
  const parsed = jsonLdEventValues(raw, geo);
  if (Object.keys(parsed).length) structured = true;
  for (const [field, value] of Object.entries(parsed)) {
   if (needsValue(values[field])) values[field] = value;
  }
 }
 const heuristicName = cleanTitle(title);
 if (needsValue(values.name) && heuristicName) values.name = heuristicName;
 if (needsValue(values.website)) {
  const website = inferWebsite(html, pageUrl);
  if (website) values.website = website;
 }
 if (needsValue(values.startDate) || needsValue(values.endDate)) {
  const range = extractDateRange(bodyText);
  if (needsValue(values.startDate) && range.startDate) values.startDate = range.startDate;
  if (needsValue(values.endDate) && range.endDate) values.endDate = range.endDate;
 }
 // City / venue / hierarchy come from the stored geography table when one is
 // configured; the built-in lists remain only as a no-geo fallback for tests.
 if (needsValue(values.city)) {
  const stored = geo ? geo.city(bodyText) : null;
  if (stored) {
   values.city = stored.name ?? stored.city;
   if (needsValue(values.country) && stored.country) values.country = stored.country;
   if (needsValue(values.province) && stored.province) values.province = stored.province;
  } else {
   const city = inferCity(bodyText);
   if (city) values.city = city;
  }
 }
 if (needsValue(values.venue)) {
  const storedVenue = geo ? geo.venue(bodyText) : null;
  if (storedVenue) {
   values.venue = storedVenue.venue;
   if (needsValue(values.country) && storedVenue.country) values.country = storedVenue.country;
   if (needsValue(values.province) && storedVenue.province) values.province = storedVenue.province;
   if (needsValue(values.city) && storedVenue.city) values.city = storedVenue.city;
   if (needsValue(values.district) && storedVenue.district) values.district = storedVenue.district;
  } else {
   const venue = inferVenue(bodyText);
   if (venue) values.venue = venue;
  }
 }
 if (geo) {
  const inferred = geo.infer({
   country: values.country,
   province: values.province,
   city: values.city,
   district: values.district,
   venue: values.venue,
   name: values.name,
   address: bodyText,
  });
  for (const field of ['country', 'province', 'city', 'district']) {
   if (needsValue(values[field]) && inferred[field]) values[field] = inferred[field];
  }
 }
 if (needsValue(values.organizer)) {
  const organizer = inferOrganizer(bodyText);
  if (organizer) values.organizer = organizer;
 }
 if (needsValue(values.industries)) {
  const industries = inferIndustries(bodyText);
  if (industries.length) values.industries = industries;
 }
 if (needsValue(values.applicationDeadline)) {
  const deadline = inferDeadline(bodyText);
  if (deadline) values.applicationDeadline = deadline;
 }
 if (needsValue(values.boothPrice)) {
  const price = inferBoothPrice(bodyText);
  if (price) values.boothPrice = price;
 }
 return {values, structured, title, pageUrl};
}

// ---- handlers --------------------------------------------------------------

export function createEventJobs({
 eventStore,
 registry = null,
 collector = null,
 search = null,
 webSearch = null,
 geo = null,
 region = 'cn',
 now = () => Date.now(),
 onTaskProgress = null,
 getRecipe = null,
 queries = null,
 company = null,
} = {}) {
 if (!eventStore) throw Error('createEventJobs requires an event store');

 function contextOf(ctx) {
  const task = ctx?.task ?? {};
  const signal = ctx?.signal;
  const update = typeof ctx?.update === 'function' ? ctx.update : null;
  const log = typeof ctx?.log === 'function' ? ctx.log : null;
  const progress = async message => {
   if (update) {
    try { await update({progress: message}); } catch { /* progress is best effort */ }
   }
   if (typeof onTaskProgress === 'function') {
    try { onTaskProgress(message, task); } catch { /* observability only */ }
   }
  };
  const note = async (message, level = 'info') => {
   if (!log) return;
   try { await log(message, level); } catch { /* logging must not fail the task */ }
  };
  return {task, signal, progress, note};
 }

 // Discovery queries: explicit payload wins, then the injected builder (Lead
 // wires company keywords there), then registry titles, then defaults.
 function resolveQueries(payload) {
  const explicitQueries = Array.isArray(payload.queries) ? payload.queries.map(item => text(item)).filter(Boolean) : [];
  if (explicitQueries.length) return uniqueValues(explicitQueries).slice(0, 5);
  const explicitQuery = text(payload.query);
  if (explicitQuery) return [explicitQuery];
  if (typeof queries === 'function') {
   try {
    const generated = queries(payload);
    if (Array.isArray(generated)) {
     const list = uniqueValues(generated.map(item => text(item)).filter(Boolean)).slice(0, 5);
     if (list.length) return list;
    }
   } catch { /* fall through to built-in defaults */ }
  }
  if (company && typeof company === 'object') {
   const focus = [
    ...stringList(company.industries).slice(0, 2),
    ...stringList(company.keywords?.zh ?? company.keywords).slice(0, 1),
   ].filter(Boolean);
   const name = text(company.chinaEntity?.name || company.name);
   const parts = [name, ...focus, '展会 2026'].filter(Boolean);
   if (parts.length) return [parts.join(' ')];
  }
  if (registry && typeof registry.list === 'function') {
   try {
    const titles = registry.list({region, enabled: true})
     .slice(0, 3)
     .map(source => text(source.title))
     .filter(Boolean)
     .map(title => `${title} 展会 2026`);
    if (titles.length) return uniqueValues(titles);
   } catch { /* registry is optional */ }
  }
  return [...(DEFAULT_QUERIES[region] ?? DEFAULT_QUERIES.cn)];
 }

 function candidateToInput(candidate, requestedRegion) {
  if (!candidate || typeof candidate !== 'object') return null;
  const name = text(candidate.name);
  if (!name) return null;
  const input = {name, status: 'discovered'};
  const candidateRegion = text(candidate.region);
  input.region = ['cn', 'eu', 'global'].includes(candidateRegion) ? candidateRegion : requestedRegion;
  const city = text(candidate.city);
  if (city) input.city = city;
  const country = text(candidate.country);
  if (country) input.country = country;
  const venue = text(candidate.venue);
  if (venue) input.venue = venue;
  const province = text(candidate.province);
  if (province) input.province = province;
  const district = text(candidate.district);
  if (district) input.district = district;
  const startDate = toDateOnly(candidate.startDate);
  if (startDate) input.startDate = startDate;
  const endDate = toDateOnly(candidate.endDate);
  if (endDate) input.endDate = endDate;
  const website = httpUrl(candidate.website);
  if (website) input.website = website;
  const organizer = text(candidate.organizer);
  if (organizer) input.organizer = organizer;
  const industries = uniqueValues(stringList(candidate.industries)).slice(0, 8);
  if (industries.length) input.industries = industries;
  input.confidence = CONFIDENCE_LEVELS.includes(candidate.confidence) ? candidate.confidence : 'low';
  // "China (UAE) Trade Expo" / "中国（阿联酋）贸易博览会" are held abroad: the
  // name's "China" is the organiser/commodity origin. The stored geo table knows
  // the parenthetical country/city, so the candidate is filed under that market
  // instead of the requested region.
  if (geo) {
   const inferred = geo.infer({region: input.region, country: input.country ?? '', province: input.province ?? '', city: input.city ?? '', district: input.district ?? '', venue: input.venue ?? '', name});
   // The name alone can state the venue country ("China (UAE) Trade Expo"):
   // that beats a requested region or a discovery-model country field.
   const named = geo.infer({name});
   const namedAbroad = ['name-parenthetical', 'name-country'].includes(named.matchedBy) && named.country && named.country !== '中国';
   if (namedAbroad) {
    input.country = named.country;
    input.region = named.region || 'global';
    if (!input.city && named.city) input.city = named.city;
    if (!input.province && named.province) input.province = named.province;
   } else {
    if (!input.country && inferred.country) input.country = inferred.country;
    if (!input.city && inferred.city) input.city = inferred.city;
    if (!input.province && inferred.province) input.province = inferred.province;
    if (!input.district && inferred.district) input.district = inferred.district;
    if (inferred.region && inferred.region !== input.region && inferred.matchedBy !== 'region') input.region = inferred.region;
   }
  }
  const sourceUrl = httpUrl(candidate.sourceUrl) ?? httpUrl(candidate.url) ?? website;
  if (sourceUrl) input.sources = [{url: sourceUrl, title: text(candidate.sourceTitle) || '搜索结果', verifiedAt: isoNow(now())}];
  return input;
 }

 async function discover(ctx) {
  const {task, signal, progress, note} = contextOf(ctx);
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  const requestedRegion = ['cn', 'eu', 'global'].includes(text(payload.region)) ? text(payload.region) : region;
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Number(payload.limit) || 30));
  const queryList = resolveQueries(payload);
  if (typeof search !== 'function') {
   const error = Error('Event discovery requires a search adapter');
   error.permanent = true;
   throw error;
  }
  await progress(`发现展会：${requestedRegion}（${queryList.length} 个查询）`);
  await note(`Event discovery: ${queryList.length} queries, limit ${limit}`);

  const candidates = [];
  for (let index = 0; index < queryList.length; index += 1) {
   throwIfAborted(signal);
   const query = queryList[index];
   const perQueryLimit = Math.max(5, Math.ceil(limit / queryList.length));
   await progress(`搜索 ${index + 1}/${queryList.length}：${query}`);
   let found;
   try {
    found = await search({query, region: requestedRegion, limit: perQueryLimit, signal});
   } catch (error) {
    if (isAborted(signal)) throw abortError();
    const failure = Error(`Event search failed: ${error instanceof Error ? error.message : String(error)}`);
    // Permanent flags are preserved so an auth/configuration failure is not
    // retried three times; transient provider errors surface to the queue as
    // retryable, which is what the contract asks for.
    if (error?.permanent === true) failure.permanent = true;
    failure.cause = error;
    throw failure;
   }
   if (!Array.isArray(found)) continue;
   for (const candidate of found) {
    if (!candidate || typeof candidate !== 'object') continue;
    // Duplicates are intentionally kept here: the event store owns the merge
    // policy, and the created/merged counters must reflect real merges.
    candidates.push(candidate);
    if (candidates.length >= limit) break;
   }
   if (candidates.length >= limit) break;
  }

  const touched = [];
  let created = 0;
  let merged = 0;
  let skipped = 0;
  for (const candidate of candidates) {
   throwIfAborted(signal);
   const input = candidateToInput(candidate, requestedRegion);
   if (!input) {
    skipped += 1;
    continue;
   }
   try {
    const result = eventStore.upsert(input);
    touched.push(result.event.id);
    if (result.created) created += 1;
    else merged += 1;
   } catch (error) {
    skipped += 1;
    await note(`Skipped candidate "${text(candidate?.name)}": ${error instanceof Error ? error.message : String(error)}`, 'warn');
   }
  }

  if (!candidates.length) {
   // No result is a valid discovery outcome, not a failed task.
   await note(`No event candidates found for ${requestedRegion}`, 'warn');
  } else {
   await note(`Discovered ${candidates.length} candidates: ${created} new, ${merged} merged`);
  }
  await progress('展会候选已入库');
  return {
   region: requestedRegion,
   candidates: candidates.length,
   created,
   merged,
   skipped,
   queries: queryList,
   events: touched,
  };
 }

 // The official website should point at the site root or a landing page rather
// than a deep contact/about path (search results often surface the latter).
function websitePreference(url) {
 try {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  let score = parsed.protocol === 'https:' ? 1 : 0;
  if (segments.length === 0) score += 10;
  else if (segments.length === 1) score += 5;
  return score - segments.length;
 } catch {
  return -100;
 }
}

const SECOND_LEVEL_SUFFIXES = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'com.mo', 'com.tw', 'co.uk', 'co.jp'];

function siteKey(hostname) {
 const labels = hostname.replace(/^www\./i, '').split('.');
 const lastTwo = labels.slice(-2).join('.');
 const lastThree = labels.slice(-3).join('.');
 return labels.length >= 3 && SECOND_LEVEL_SUFFIXES.includes(lastTwo) ? lastThree : lastTwo;
}

// Same site (including subdomains such as en.example.com vs www.example.com) so
// a deep contact page can be upgraded to the official home page.
function sameHost(left, right) {
 try {
  return siteKey(new URL(left).hostname) === siteKey(new URL(right).hostname);
 } catch {
  return false;
 }
}

function candidateUrls(event) {
  const urls = [];
  const website = httpUrl(event.website);
  if (website) urls.push(website);
  for (const source of Array.isArray(event.sources) ? event.sources : []) {
   const url = httpUrl(source?.url);
   if (url) urls.push(url);
  }
  return uniqueValues(urls).slice(0, MAX_COLLECT_URLS);
 }

 async function enrich(ctx) {
  const {task, signal, progress, note} = contextOf(ctx);
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  const eventId = text(payload.eventId) || text(task.eventId);
  if (!eventId) {
   const error = Error('Event enrichment requires an eventId');
   error.permanent = true;
   throw error;
  }
  const event = eventStore.get(eventId);
  if (!event) {
   const error = Error(`Event not found: ${eventId}`);
   error.permanent = true;
   throw error;
  }
  // Older/discovered records may be filed under the requested region ("cn") even
  // when the name says the fair is held abroad. Correct that before collecting
  // so the UI filter, country and sources agree.
  if (geo) {
   const inferred = geo.infer({
    region: event.region,
    country: event.country,
    province: event.province,
    city: event.city,
    district: event.district,
    venue: event.venue,
    name: event.name,
   });
   const named = geo.infer({name: event.name});
   const nameSaysAbroad = ['name-parenthetical', 'name-country'].includes(named.matchedBy)
    && named.country && named.country !== '中国';
   const early = {};
   if (nameSaysAbroad) {
    early.country = named.country;
    early.region = named.region || 'global';
    if (!event.city && named.city) early.city = named.city;
    const where = named.city ? `${named.city}（${named.country}）` : named.country;
    const noteText = `展会名称含“中国”，但举办地在境外：${where}，已按境外展会归类`;
    const notes = Array.isArray(event.notes) ? [...event.notes] : [];
    if (!notes.includes(noteText)) {
     notes.push(noteText);
     early.notes = notes;
    }
   } else {
    for (const field of ['country', 'province', 'city', 'district']) {
     if (needsValue(event[field]) && inferred[field]) early[field] = inferred[field];
    }
   }
   if (Object.keys(early).length) {
    eventStore.patch(eventId, early);
    Object.assign(event, early);
   }
  }
  let urls = candidateUrls(event);
  let discoveredWebsite = '';
  let discoveredCandidates = [];
  // Discovered events often have no website yet (the search result may only
  // carry a name). Enrichment then asks the web-search adapter for candidate
  // official pages before giving up; a candidate only becomes the event's
  // website after its page was fetched and matched.
  if (!urls.length && typeof webSearch === 'function') {
   await progress(`搜索官网：${event.name || eventId}`);
   try {
    const results = await webSearch({query: `${event.name} 官网 官方网站 official website`, count: 8});
    const ranked = rankEventWebsiteResults(event, results, {limit: 3});
    if (ranked.length) {
     discoveredCandidates = ranked;
     urls = ranked.map(item => item.url);
     discoveredWebsite = ranked[0].url;
     await note(`官网搜索：${ranked.length} 个候选，优先核验 ${discoveredWebsite}`, 'info');
    }
   } catch (error) {
    if (isAborted(signal)) throw abortError();
    await note(`官网搜索失败：${error instanceof Error ? error.message : String(error)}`, 'warn');
   }
  }
  if (!urls.length) {
   const missingNote = '缺少可核验的官网或来源链接';
   const appended = needsValue(event.notes) || !event.notes.includes(missingNote) ? [missingNote] : [];
   if (appended.length) eventStore.patch(eventId, {notes: [...(event.notes ?? []), ...appended]});
   await note(missingNote, 'warn');
   return {eventId, collected: 0, fields: [], notes: appended};
  }
  if (!collector || typeof collector.collect !== 'function') {
   const error = Error('Event enrichment requires a collector');
   error.permanent = true;
   throw error;
  }
  // Bind through a wrapper so an injected collector object keeps its own `this`
  // and a collector without probe() still works (documents fall back to URL
  // extension classification).
  const probe = typeof collector.probe === 'function' ? (url, options) => collector.probe(url, options) : null;
  await progress(`补全展会：${event.name || eventId}（${urls.length} 个候选页面）`);

  const aggregate = {};
  const conflicts = [];
  const documents = new Map();
  const collectedSources = [];
  let exhibitorListUrl = '';
  let exhibitorListStatus = 'unknown';
  let structured = false;
  let collected = 0;
  const matchedPages = [];

  for (let index = 0; index < urls.length; index += 1) {
   throwIfAborted(signal);
   const url = urls[index];
   await progress(`采集 ${index + 1}/${urls.length}：${url}`);
   let result;
   try {
    const recipe = typeof getRecipe === 'function'
     ? (() => {
      try { return getRecipe(domainOf(url)); } catch { return null; }
     })()
     : null;
    result = await collector.collect(url, recipe ? {signal, recipe} : {signal});
   } catch (error) {
    if (isAborted(signal)) throw abortError();
    await note(`采集失败 ${url}: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    continue;
   }
   if (!result || result.ok === false) {
    const reason = result?.error?.message || result?.error?.code || 'unavailable';
    await note(`采集失败 ${url}: ${reason}`, 'warn');
    continue;
   }
   collected += 1;
   const page = analyzePage({...result, url}, geo);
   if (page.structured) structured = true;
   const pageUrl = page.pageUrl ?? url;
   if (pageMatchesEvent(event, page)) matchedPages.push(pageUrl);
   collectedSources.push({
    url: pageUrl,
    title: page.title || text(event.name),
    verifiedAt: isoNow(now()),
   });
   for (const [field, value] of Object.entries(page.values)) {
    if (needsValue(value)) continue;
    if (needsValue(aggregate[field])) {
     aggregate[field] = value;
     continue;
    }
    if (DATE_FIELDS.includes(field) && String(aggregate[field]) !== String(value)) {
     conflicts.push(`多来源${DATE_LABELS[field]}不一致：${aggregate[field]} / ${value}，待人工确认`);
    }
   }
   const links = findLinks(typeof result.html === 'string' ? result.html : '', pageUrl);
   for (const link of links) {
    const looksLikeExhibitorList = EXHIBITOR_RE.test(link.title || '') || EXHIBITOR_RE.test(link.url);
    if (!exhibitorListUrl && looksLikeExhibitorList) {
     const fallback = isDocumentUrl(link.url) ? 'downloadable' : 'linked';
     exhibitorListUrl = link.url;
     exhibitorListStatus = await probeAvailability(probe, link.url, fallback, {signal});
     continue;
    }
    if (!isDocumentUrl(link.url)) continue;
    if (documents.has(link.url) || documents.size >= MAX_DOCUMENTS) continue;
    const status = await probeAvailability(probe, link.url, 'downloadable', {signal});
    documents.set(link.url, {
     url: link.url,
     title: link.title || documentType(link.url).toUpperCase() + ' 文档',
     type: documentType(link.url),
     status,
    });
   }
  }

  throwIfAborted(signal);
  const changes = {};
  const fields = [];
  const resolved = field => (Object.prototype.hasOwnProperty.call(changes, field) ? changes[field] : event[field]);
  for (const [field, value] of Object.entries(aggregate)) {
   if (needsValue(value)) continue;
   const current = event[field];
   if (needsValue(current)) {
    changes[field] = value;
    fields.push(field);
    continue;
   }
   if ((DATE_FIELDS.includes(field) || field === 'venue' || field === 'city') && String(current) !== String(value)) {
    const label = field === 'venue' ? '展馆' : field === 'city' ? '城市' : DATE_LABELS[field];
    conflicts.push(`多来源${label}不一致：${current} / ${value}，待人工确认`);
   }
  }
  const newSources = uniqueValues(collectedSources.map(source => source.url))
   .map(url => collectedSources.find(source => source.url === url))
   .filter(source => source && !(event.sources ?? []).some(existing => existing.url === source.url));
  if (newSources.length) {
   changes.sources = [...(event.sources ?? []), ...newSources];
  }
  const existingDocuments = Array.isArray(event.documents) ? event.documents : [];
  const freshDocuments = [...documents.values()].filter(document => !existingDocuments.some(existing => existing.url === document.url));
  if (freshDocuments.length) {
   changes.documents = [...existingDocuments, ...freshDocuments];
   fields.push('documents');
  }
  if (exhibitorListUrl && !event.exhibitorListUrl) {
   changes.exhibitorListUrl = exhibitorListUrl;
   changes.exhibitorListStatus = exhibitorListStatus;
   fields.push('exhibitorListUrl');
  }
  // Search-result candidates only become the official website after a fetched
  // page matched the event name. When the official site cannot be fetched at
  // all, a strong search result is still shown as the website but flagged as
  // unverified, so the operator can open it and correct it by hand.
  let websiteFromSearch = '';
  const existingWebsite = httpUrl(event.website) ?? '';
  const matchedBest = matchedPages.slice().sort((left, right) => websitePreference(right) - websitePreference(left))[0] ?? '';
  let chosenWebsite = matchedBest;
  if (!chosenWebsite && discoveredCandidates.length && discoveredCandidates[0].score >= 3) {
   chosenWebsite = discoveredCandidates[0].url;
   websiteFromSearch = chosenWebsite;
  }
  if (chosenWebsite && (!existingWebsite
   || (sameHost(existingWebsite, chosenWebsite) && websitePreference(chosenWebsite) > websitePreference(existingWebsite)))) {
   changes.website = chosenWebsite;
   fields.push('website');
  }
  // Country / province / city / district are inferred from the stored city
  // table (seed/geo-cn.json), never from the event name or a regex heuristic.
  if (geo) {
   const current = field => (Object.prototype.hasOwnProperty.call(changes, field) ? changes[field] : event[field]);
   const inferred = geo.infer({
    region: event.region,
    country: current('country'),
    province: current('province'),
    city: current('city'),
    district: current('district'),
    venue: current('venue'),
    name: event.name,
   });
   for (const field of ['country', 'province', 'city', 'district']) {
    if (needsValue(current(field)) && inferred[field]) {
     changes[field] = inferred[field];
     fields.push(field);
    }
   }
   const nameSaysAbroad = ['name-parenthetical', 'name-country'].includes(inferred.matchedBy)
    && inferred.country && inferred.country !== '中国';
   if (inferred.region && inferred.region !== current('region') && (nameSaysAbroad || inferred.matchedBy !== 'region')) {
    changes.region = inferred.region;
    fields.push('region');
   }
  }

  // A page often still shows last edition's dates (the next edition is not
  // announced yet). Keeping the verified date is useful, but it must not look
  // like an upcoming event: flag it in notes, cap confidence and never mark the
  // event verified on a past edition.
  const resolvedStart = resolved('startDate');
  const resolvedEnd = resolved('endDate');
  const today = new Date(now()).toISOString().slice(0, 10);
  const pastEdition = !needsValue(resolvedStart) && String(resolvedStart) < today;

  const missing = [];
  if (pastEdition) {
   const span = needsValue(resolvedEnd) ? String(resolvedStart) : `${resolvedStart} 至 ${resolvedEnd}`;
   missing.push(`官网当前显示上一届 ${span}，下一届日期待确认`);
  }
  if (needsValue(resolvedStart)) missing.push('未找到展会开始日期');
  if (needsValue(resolvedEnd)) missing.push('未找到展会结束日期');
  if (needsValue(resolved('applicationDeadline'))) missing.push('未找到报名截止日期');
  if (needsValue(resolved('venue'))) missing.push('展馆待确认');
  if (needsValue(resolved('city'))) missing.push('城市待确认');
  if (websiteFromSearch) {
   missing.push('官网链接来自搜索候选，待人工核验：' + websiteFromSearch);
  }
  if (needsValue(resolved('website'))) {
   missing.push('未找到官网链接');
   if (discoveredCandidates.length) {
    missing.push('官网候选（待人工确认）：' + discoveredCandidates.slice(0, 2).map(item => item.url).join('、'));
   }
  }
  if (collected === 0) missing.push('未能采集官网或来源页面，待人工补充');

  const hasStartDate = !needsValue(resolvedStart);
  let derivedConfidence;
  if (pastEdition) {
   // Structured official data is still medium evidence; loose heuristics are low.
   derivedConfidence = structured ? 'medium' : 'low';
  } else {
   derivedConfidence = structured && hasStartDate
    ? 'high'
    : (hasStartDate || !needsValue(resolved('venue')) || !needsValue(resolved('city')) || !needsValue(resolved('organizer')))
     ? 'medium'
     : 'low';
  }
  const confidence = pastEdition
   ? minConfidence(event.confidence, derivedConfidence)
   : maxConfidence(event.confidence, derivedConfidence);
  if (confidence !== event.confidence) changes.confidence = confidence;
  let derivedStatus;
  if (pastEdition) {
   derivedStatus = collected > 0 ? 'enriched' : event.status;
  } else {
   derivedStatus = structured && hasStartDate && !needsValue(resolved('venue'))
    ? 'verified'
    : (collected > 0 && fields.length > 0 ? 'enriched' : event.status);
  }
  const status = maxStatus(event.status, derivedStatus);
  if (status !== event.status) changes.status = status;

  const existingNotes = Array.isArray(event.notes) ? event.notes : [];
  // Once a website is known, drop the stale "no website" / unverified-candidate
  // notes from earlier runs so the detail panel reflects the current record.
  const resolvedWebsite = Object.prototype.hasOwnProperty.call(changes, 'website') ? changes.website : event.website;
  const WEBSITE_NOTE_PREFIXES = ['缺少可核验的官网或来源链接', '未找到官网链接', '官网候选（待人工确认）', '官网链接来自搜索候选'];
  const baseNotes = resolvedWebsite
   ? existingNotes.filter(note => !WEBSITE_NOTE_PREFIXES.some(prefix => String(note).startsWith(prefix)))
   : existingNotes;
  const appendedNotes = [...conflicts, ...missing].filter(value => value && !baseNotes.includes(value));
  if (appendedNotes.length || baseNotes.length !== existingNotes.length) {
   changes.notes = [...baseNotes, ...appendedNotes];
  }

  if (Object.keys(changes).length) eventStore.patch(eventId, changes);
  await progress(`补全完成：采集 ${collected} 页，更新 ${fields.length} 个字段`);
  if (collected === 0) await note('Enrichment collected no pages', 'warn');
  return {
   eventId,
   collected,
   fields: uniqueValues(fields),
   notes: appendedNotes,
   structured,
   website: Object.prototype.hasOwnProperty.call(changes, 'website') ? changes.website : (event.website ?? ''),
  };
 }

 return {
  'event.discover': discover,
  'event.enrich': enrich,
 };
}
