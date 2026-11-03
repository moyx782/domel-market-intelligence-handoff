// Event library store (M3c): one JSON file of MarketEvent records.
//
// The store is the boundary between "what discovery guessed" and "what the
// operator can trust". Upsert merges candidates by normalised name + start date
// + venue and only ever moves confidence/status upwards, so re-running a
// discovery task can never downgrade an event that enrichment already verified.
// Patch is the manual-correction path and validates every field so a broken
// frontend request cannot corrupt the library.

import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const EVENT_STATUSES = ['discovered', 'enriched', 'verified', 'archived'];
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
export const EVENT_REGIONS = ['cn', 'eu', 'global'];
export const AVAILABILITIES = ['linked', 'downloadable', 'restricted', 'unknown'];

// CSV column order is part of the contract: the spreadsheet import must not
// shift when an event is missing a field. local-api.mjs uses the same list.
export const EVENT_EXPORT_COLUMNS = [
 'name', 'edition', 'startDate', 'endDate', 'city', 'country', 'venue', 'organizer', 'website',
 'frequency', 'industries', 'scope', 'exhibitorCount', 'visitorCount', 'area', 'exhibitorListUrl',
 'exhibitorListStatus', 'applicationDeadline', 'boothPrice', 'ticketPrice', 'region', 'confidence',
 'status', 'sources', 'notes',
];

const STRING_FIELDS = ['name', 'city', 'country', 'venue', 'organizer', 'website', 'frequency', 'scope', 'area', 'exhibitorListUrl', 'boothPrice', 'ticketPrice'];
const DATE_FIELDS = ['startDate', 'endDate', 'applicationDeadline'];
const NUMBER_FIELDS = ['edition', 'exhibitorCount', 'visitorCount'];
const ENUM_FIELDS = {
 status: EVENT_STATUSES,
 confidence: CONFIDENCE_LEVELS,
 region: EVENT_REGIONS,
 exhibitorListStatus: AVAILABILITIES,
};
const LIST_FIELDS = ['industries', 'notes'];
const OBJECT_LIST_FIELDS = ['documents', 'competitors', 'sources'];
const PATCHABLE_FIELDS = new Set([...STRING_FIELDS, ...DATE_FIELDS, ...NUMBER_FIELDS, ...LIST_FIELDS, ...OBJECT_LIST_FIELDS, ...Object.keys(ENUM_FIELDS)]);

const STATUS_RANK = {discovered: 0, enriched: 1, verified: 2, archived: 3};
const CONFIDENCE_RANK = {low: 0, medium: 1, high: 2};
const FILE_TYPE_RE = /\.([a-z0-9]{2,5})(?:$|[?#])/i;

function invalid(message, code = 'INVALID_EVENT', status = 400) {
 const error = Error(message);
 error.code = code;
 error.status = status;
 return error;
}

function text(value) {
 if (value === null || value === undefined) return '';
 if (typeof value === 'string') return value.trim();
 if (typeof value === 'number' || typeof value === 'boolean') return String(value);
 return '';
}

function toMs(value) {
 if (typeof value === 'number' && Number.isFinite(value)) return value;
 if (value instanceof Date) return value.getTime();
 if (typeof value === 'string' && value.trim()) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
 }
 return null;
}

function isRealDate(year, month, day) {
 if (month < 1 || month > 12 || day < 1 || day > 31) return false;
 const date = new Date(Date.UTC(year, month - 1, day));
 return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Strict format used by patch/manual correction: exactly YYYY-MM-DD and a real
// calendar day (no 2026-02-30).
function isDateOnly(value) {
 if (typeof value !== 'string') return false;
 const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
 if (!match) return false;
 return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

// Lenient conversion for search candidates: accepts ISO datetimes and
// YYYY/MM/DD then normalises to YYYY-MM-DD; anything else becomes null.
export function toDateOnly(value) {
 if (value === null || value === undefined || value === '') return null;
 if (typeof value === 'number' || value instanceof Date) {
  const ms = toMs(value);
  if (ms === null) return null;
  return new Date(ms).toISOString().slice(0, 10);
 }
 if (typeof value !== 'string') return null;
 if (isDateOnly(value)) return value.trim();
 // Accept the Chinese formats used on exhibition sites (2026年11月5日) as well
 // as 2026/11/5 and ISO datetimes.
 const normalized = value.trim().replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, ' ');
 const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(normalized);
 if (!match) return null;
 const candidate = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
 return isDateOnly(candidate) ? candidate : null;
}

// Search results and HTML attributes often carry entity-encoded URLs
// ("...aspx?id=2026&amp;zhid=21"). Decode in one pass so a decoded "&amp;lt;"
// cannot be decoded twice, then let URL parsing normalise the rest.
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

function normalizeHttpUrl(value) {
 const raw = decodeHtmlEntities(text(value)).trim();
 if (!raw) return null;
 let parsed;
 try {
  parsed = new URL(raw);
 } catch {
  return null;
 }
 if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
 parsed.hash = '';
 return parsed.href;
}

// Website host identity for cross-name dedupe: protocol and "www." do not make
// two events different, so "https://www.cr-expo.com/" and "http://cr-expo.com"
// share a host key.
function websiteHost(url) {
 const normalized = normalizeHttpUrl(url);
 if (!normalized) return '';
 try {
  return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
 } catch {
  return '';
 }
}

function stringList(value) {
 if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
 if (typeof value === 'string') return value.split(/[,，;；、]/).map(item => item.trim()).filter(Boolean);
 return [];
}

function uniqueStrings(values) {
 const seen = new Set();
 const result = [];
 for (const value of values) {
  if (!value || seen.has(value)) continue;
  seen.add(value);
  result.push(value);
 }
 return result;
}

function normalizeName(value) {
 return text(value)
  .toLowerCase()
  .replace(/[\s\u3000]+/g, '')
  .replace(/[·•\-–—_/\\()（）\[\]【】:：,，.。!！?？'"“”‘’|]/g, '');
}

function normalizeVenue(value) {
 return text(value).toLowerCase().replace(/[\s\u3000]+/g, '');
}

// Dedupe key from the contract: normalised name + startDate + venue.
function dedupeKey(event) {
 return `${normalizeName(event.name)}|${event.startDate ?? ''}|${normalizeVenue(event.venue)}`;
}

function emptyEvent() {
 return {
  id: '',
  name: '',
  edition: null,
  startDate: null,
  endDate: null,
  city: '',
  country: '',
  venue: '',
  organizer: '',
  website: '',
  frequency: '',
  industries: [],
  scope: '',
  exhibitorCount: null,
  visitorCount: null,
  area: '',
  exhibitorListUrl: '',
  exhibitorListStatus: 'unknown',
  documents: [],
  competitors: [],
  applicationDeadline: null,
  boothPrice: '',
  ticketPrice: '',
  region: 'cn',
  sources: [],
  confidence: 'low',
  status: 'discovered',
  notes: [],
  createdAt: '',
  updatedAt: '',
 };
}

function extensionOf(url) {
 try {
  const match = FILE_TYPE_RE.exec(new URL(url).pathname);
  return match ? match[1].toLowerCase() : 'link';
 } catch {
  return 'link';
 }
}

function isoOr(value, fallback) {
 const ms = toMs(value);
 return ms === null ? fallback : new Date(ms).toISOString();
}

// ---- candidate sanitising (upsert path, lenient by design) -----------------

function sanitizeSources(value, stamp) {
 if (!Array.isArray(value)) return [];
 const result = [];
 const seen = new Set();
 for (const item of value) {
  const url = normalizeHttpUrl(item && typeof item === 'object' ? item.url : item);
  if (!url || seen.has(url)) continue;
  seen.add(url);
  result.push({url, title: text(item.title), verifiedAt: isoOr(item.verifiedAt, stamp)});
 }
 return result;
}

function sanitizeDocuments(value, stamp) {
 if (!Array.isArray(value)) return [];
 const result = [];
 const seen = new Set();
 for (const item of value) {
  if (!item || typeof item !== 'object') continue;
  const url = normalizeHttpUrl(item.url);
  if (!url || seen.has(url)) continue;
  seen.add(url);
  const document = {
   url,
   title: text(item.title),
   type: text(item.type) || extensionOf(url),
   status: AVAILABILITIES.includes(item.status) ? item.status : 'unknown',
  };
  if (item.parseProvider) document.parseProvider = text(item.parseProvider);
  if (item.parsedAt) document.parsedAt = isoOr(item.parsedAt, stamp);
  result.push(document);
 }
 return result;
}

function sanitizeCompetitors(value) {
 if (!Array.isArray(value)) return [];
 const result = [];
 const seen = new Set();
 for (const item of value) {
  if (!item || typeof item !== 'object') continue;
  const name = text(item.name);
  if (!name || seen.has(name)) continue;
  seen.add(name);
  const competitor = {name, participating: typeof item.participating === 'boolean' ? item.participating : null};
  if (text(item.booth)) competitor.booth = text(item.booth);
  if (normalizeHttpUrl(item.sourceUrl)) competitor.sourceUrl = normalizeHttpUrl(item.sourceUrl);
  result.push(competitor);
 }
 return result;
}

// Keep only fields that carry a value: merge treats "key present and non-empty"
// as an override, so empty strings must never erase a verified value.
function sanitizeCandidate(input, stamp) {
 const result = {};
 for (const field of STRING_FIELDS) {
  // URL-like strings may arrive entity-encoded from HTML/search results.
  const value = field === 'website' || field === 'exhibitorListUrl'
   ? (normalizeHttpUrl(input[field]) ?? text(input[field]))
   : text(input[field]);
  if (value) result[field] = value;
 }
 for (const field of DATE_FIELDS) {
  const value = toDateOnly(input[field]);
  if (value) result[field] = value;
 }
 for (const field of NUMBER_FIELDS) {
  if (input[field] === null || input[field] === undefined || input[field] === '') continue;
  const value = Number(input[field]);
  if (Number.isInteger(value) && value >= 0) result[field] = value;
 }
 if (input.industries !== undefined) {
  const industries = uniqueStrings(stringList(input.industries));
  if (industries.length) result.industries = industries;
 }
 if (input.notes !== undefined) {
  const notes = uniqueStrings(stringList(input.notes));
  if (notes.length) result.notes = notes;
 }
 if (input.sources !== undefined) {
  const sources = sanitizeSources(input.sources, stamp);
  if (sources.length) result.sources = sources;
 }
 if (input.documents !== undefined) {
  const documents = sanitizeDocuments(input.documents, stamp);
  if (documents.length) result.documents = documents;
 }
 if (input.competitors !== undefined) {
  const competitors = sanitizeCompetitors(input.competitors);
  if (competitors.length) result.competitors = competitors;
 }
 for (const field of Object.keys(ENUM_FIELDS)) {
  if (ENUM_FIELDS[field].includes(input[field])) result[field] = input[field];
 }
 return result;
}

// ---- merge helpers ---------------------------------------------------------

function mergeSources(existing, incoming, stamp) {
 const result = (existing ?? []).map(source => ({...source}));
 const byUrl = new Map(result.map(source => [source.url, source]));
 for (const source of incoming) {
  const current = byUrl.get(source.url);
  if (!current) {
   result.push({url: source.url, title: source.title ?? '', verifiedAt: source.verifiedAt ?? stamp});
   continue;
  }
  if (!current.title && source.title) current.title = source.title;
 }
 return result;
}

function mergeDocuments(existing, incoming, stamp) {
 const result = (existing ?? []).map(document => ({...document}));
 const byUrl = new Map(result.map(document => [document.url, document]));
 for (const document of incoming) {
  const current = byUrl.get(document.url);
  if (!current) {
   result.push({...document});
   continue;
  }
  if (!current.title && document.title) current.title = document.title;
  if ((current.status === 'unknown' || !current.status) && document.status) current.status = document.status;
  if (!current.type && document.type) current.type = document.type;
  if (document.parseProvider && !current.parseProvider) current.parseProvider = document.parseProvider;
  if (document.parsedAt && !current.parsedAt) current.parsedAt = document.parsedAt;
 }
 return result;
}

function mergeCompetitors(existing, incoming) {
 const result = (existing ?? []).map(competitor => ({...competitor}));
 const byName = new Map(result.map(competitor => [competitor.name, competitor]));
 for (const competitor of incoming) {
  const current = byName.get(competitor.name);
  if (!current) {
   result.push({...competitor});
   continue;
  }
  if (typeof competitor.participating === 'boolean') current.participating = competitor.participating;
  if (competitor.booth) current.booth = competitor.booth;
  if (competitor.sourceUrl) current.sourceUrl = competitor.sourceUrl;
 }
 return result;
}

// Merge label policy: the first seen name wins unless the incoming name is the
// same name with an alias suffix stripped ("China Refrigeration" inside
// "China Refrigeration (中国制冷展)"), in which case the shorter core name is the
// cleaner label. The other variant is preserved as a note so information is
// never silently lost.
function chooseMergedName(existingName, incomingName) {
 if (!incomingName) return existingName;
 if (!existingName) return incomingName;
 if (normalizeName(existingName) === normalizeName(incomingName)) return existingName;
 const existingLower = String(existingName).toLowerCase();
 const incomingLower = String(incomingName).toLowerCase();
 if (existingLower.includes(incomingLower)) return incomingName;
 return existingName;
}

// Cross-name duplicate detection: the same official website plus compatible
// start dates is the same event even when the model renames it. A null date on
// either side is compatible (name variants often omit it), but two known,
// different editions must never be merged.
function findWebsiteMatch(events, incoming) {
 const host = websiteHost(incoming.website);
 if (!host) return -1;
 let bestIndex = -1;
 let bestScore = -1;
 for (let index = 0; index < events.length; index += 1) {
  const event = events[index];
  if (websiteHost(event.website) !== host) continue;
  const eventDate = event.startDate ?? null;
  const incomingDate = incoming.startDate ?? null;
  if (eventDate && incomingDate && eventDate !== incomingDate) continue;
  const score = eventDate && incomingDate ? 2 : 1;
  if (score > bestScore) {
   bestScore = score;
   bestIndex = index;
  }
 }
 return bestIndex;
}

function mergeEvent(existing, incoming, stamp) {
 const merged = structuredClone(existing);
 for (const field of STRING_FIELDS) {
  if (field === 'name') continue;
  if (incoming[field]) merged[field] = incoming[field];
 }
 if (incoming.name) {
  merged.name = chooseMergedName(existing.name, incoming.name);
  // Keep every dropped display variant as an alias note so information is not
  // lost when names from different search results are merged.
  const variants = [existing.name, incoming.name]
   .filter(name => name && normalizeName(name) !== normalizeName(merged.name))
   .map(name => `别名：${name}`);
  if (variants.length) merged.notes = uniqueStrings([...(merged.notes ?? []), ...variants]);
 }
 for (const field of DATE_FIELDS) {
  if (incoming[field]) merged[field] = incoming[field];
 }
 for (const field of NUMBER_FIELDS) {
  if (incoming[field] !== undefined) merged[field] = incoming[field];
 }
 if (incoming.industries?.length) merged.industries = [...incoming.industries];
 if (incoming.notes?.length) merged.notes = uniqueStrings([...(merged.notes ?? []), ...incoming.notes]);
 if (incoming.sources?.length) merged.sources = mergeSources(merged.sources, incoming.sources, stamp);
 if (incoming.documents?.length) merged.documents = mergeDocuments(merged.documents, incoming.documents, stamp);
 if (incoming.competitors?.length) merged.competitors = mergeCompetitors(merged.competitors, incoming.competitors);
 if (incoming.exhibitorListStatus && incoming.exhibitorListStatus !== 'unknown') merged.exhibitorListStatus = incoming.exhibitorListStatus;
 if (incoming.region) merged.region = incoming.region;
 // Status and confidence only move forward during merge: a re-run of discovery
 // must not downgrade an event that enrichment already verified.
 if (incoming.status && STATUS_RANK[incoming.status] > (STATUS_RANK[merged.status] ?? 0)) merged.status = incoming.status;
 if (incoming.confidence && CONFIDENCE_RANK[incoming.confidence] > (CONFIDENCE_RANK[merged.confidence] ?? 0)) merged.confidence = incoming.confidence;
 merged.updatedAt = stamp;
 return merged;
}

// ---- strict patch validators ----------------------------------------------

function patchString(field, value) {
 if (value === null || value === undefined) return '';
 if (typeof value !== 'string') throw invalid(`Field ${field} must be a string`, 'INVALID_FIELD');
 const trimmed = value.trim();
 if (field === 'name' && !trimmed) throw invalid('Event name cannot be empty', 'INVALID_FIELD');
 if (field === 'website' || field === 'exhibitorListUrl') return normalizeHttpUrl(trimmed) ?? decodeHtmlEntities(trimmed);
 return trimmed;
}

function patchDate(field, value) {
 if (value === null || value === undefined || value === '') return null;
 if (!isDateOnly(value)) throw invalid(`Field ${field} must be YYYY-MM-DD or null`, 'INVALID_FIELD');
 return value.trim();
}

function patchNumber(field, value) {
 if (value === null || value === undefined || value === '') return null;
 const number = Number(value);
 if (!Number.isInteger(number) || number < 0) throw invalid(`Field ${field} must be a non-negative integer or null`, 'INVALID_FIELD');
 return number;
}

function patchList(field, value) {
 if (!Array.isArray(value)) throw invalid(`Field ${field} must be an array of strings`, 'INVALID_FIELD');
 for (const item of value) {
  if (typeof item !== 'string') throw invalid(`Field ${field} must be an array of strings`, 'INVALID_FIELD');
 }
 return uniqueStrings(value.map(item => item.trim()).filter(Boolean));
}

function patchSources(value, stamp) {
 if (!Array.isArray(value)) throw invalid('Field sources must be an array', 'INVALID_FIELD');
 const result = [];
 const seen = new Set();
 for (const item of value) {
  if (!item || typeof item !== 'object') throw invalid('Every source must be an object with a URL', 'INVALID_FIELD');
  const url = normalizeHttpUrl(item.url);
  if (!url) throw invalid(`Invalid source URL: ${text(item.url) || '(empty)'}`, 'INVALID_FIELD');
  if (seen.has(url)) continue;
  seen.add(url);
  // Manual source edits always carry a verification timestamp: without one the
  // UI cannot tell an old claim from a fresh check.
  result.push({url, title: text(item.title), verifiedAt: isoOr(item.verifiedAt, stamp)});
 }
 return result;
}

function patchDocuments(value, stamp) {
 if (!Array.isArray(value)) throw invalid('Field documents must be an array', 'INVALID_FIELD');
 const result = [];
 const seen = new Set();
 for (const item of value) {
  if (!item || typeof item !== 'object') throw invalid('Every document must be an object with a URL', 'INVALID_FIELD');
  const url = normalizeHttpUrl(item.url);
  if (!url) throw invalid(`Invalid document URL: ${text(item.url) || '(empty)'}`, 'INVALID_FIELD');
  if (seen.has(url)) continue;
  seen.add(url);
  if (item.status !== undefined && !AVAILABILITIES.includes(item.status)) throw invalid(`Unknown document status: ${text(item.status)}`, 'INVALID_FIELD');
  if (item.parsedAt !== undefined && item.parsedAt !== null && toMs(item.parsedAt) === null) throw invalid('Field documents.parsedAt must be an ISO timestamp or null', 'INVALID_FIELD');
  const document = {
   url,
   title: text(item.title),
   type: text(item.type) || extensionOf(url),
   status: AVAILABILITIES.includes(item.status) ? item.status : 'unknown',
  };
  if (item.parseProvider) document.parseProvider = text(item.parseProvider);
  if (item.parsedAt) document.parsedAt = isoOr(item.parsedAt, stamp);
  result.push(document);
 }
 return result;
}

function patchCompetitors(value) {
 if (!Array.isArray(value)) throw invalid('Field competitors must be an array', 'INVALID_FIELD');
 const result = [];
 const seen = new Set();
 for (const item of value) {
  if (!item || typeof item !== 'object') throw invalid('Every competitor must be an object with a name', 'INVALID_FIELD');
  const name = text(item.name);
  if (!name) throw invalid('Competitor name is required', 'INVALID_FIELD');
  if (seen.has(name)) continue;
  seen.add(name);
  if (item.participating !== undefined && item.participating !== null && typeof item.participating !== 'boolean') throw invalid('Competitor participating must be a boolean or null', 'INVALID_FIELD');
  if (item.booth !== undefined && item.booth !== null && typeof item.booth !== 'string') throw invalid('Competitor booth must be a string', 'INVALID_FIELD');
  const competitor = {name, participating: typeof item.participating === 'boolean' ? item.participating : null};
  if (text(item.booth)) competitor.booth = text(item.booth);
  if (normalizeHttpUrl(item.sourceUrl)) competitor.sourceUrl = normalizeHttpUrl(item.sourceUrl);
  result.push(competitor);
 }
 return result;
}

// ---- store -----------------------------------------------------------------

export function openEventStore({file, now = () => Date.now()} = {}) {
 if (!file) throw Error('Event store requires a file path');

 let state = {version: 1, events: []};
 try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed && Array.isArray(parsed.events)) state = {version: 1, events: parsed.events};
 } catch (error) {
  if (error?.code !== 'ENOENT') console.warn(`[event-store] Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
 }

 function persist() {
  state.version = 1;
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
 }

 function compareEvents(a, b) {
  if (a.startDate && b.startDate) return a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name, 'zh-Hans-CN');
  if (a.startDate) return -1;
  if (b.startDate) return 1;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
 }

 function list({from, to, region, status, q, limit = 500} = {}) {
  const fromDate = toDateOnly(from);
  const toDate = toDateOnly(to);
  const range = Boolean(fromDate || toDate);
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : 500;
  return state.events
   .filter(event => (region ? event.region === region : true))
   .filter(event => (status ? event.status === status : true))
   .filter(event => {
    // Events without a start date can only be shown when the user is not
    // filtering by time; otherwise they have no position on the timeline.
    if (!range) return true;
    if (!event.startDate) return false;
    if (fromDate && event.startDate < fromDate) return false;
    if (toDate && event.startDate > toDate) return false;
    return true;
   })
   .filter(event => {
    if (!needle) return true;
    const haystack = [event.name, event.city, event.venue, ...(event.industries ?? [])].join(' ').toLowerCase();
    return haystack.includes(needle);
   })
   .sort(compareEvents)
   .slice(0, max)
   .map(event => structuredClone(event));
 }

 function get(id) {
  const event = state.events.find(item => item.id === id);
  return event ? structuredClone(event) : null;
 }

 function upsert(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw invalid('Event candidate must be an object', 'INVALID_CANDIDATE');
  const name = text(candidate.name);
  if (!name) throw invalid('Event name is required', 'INVALID_NAME');
  const startDate = toDateOnly(candidate.startDate);
  const venue = text(candidate.venue);
  const stamp = new Date(now()).toISOString();
  const incoming = sanitizeCandidate({...candidate, name, startDate, venue}, stamp);
  const key = dedupeKey({name, startDate, venue});
  let index = state.events.findIndex(event => dedupeKey(event) === key);
  // Fallback: same official website + compatible dates = same event under a
  // different display name (the model returns several aliases for one show).
  if (index < 0) index = findWebsiteMatch(state.events, incoming);
  if (index < 0) {
   const event = {...emptyEvent(), ...incoming, id: randomUUID(), createdAt: stamp, updatedAt: stamp};
   state.events.push(event);
   persist();
   return {event: structuredClone(event), created: true};
  }
  const merged = mergeEvent(state.events[index], incoming, stamp);
  state.events[index] = merged;
  persist();
  return {event: structuredClone(merged), created: false};
 }

 function patch(id, changes) {
  const event = state.events.find(item => item.id === id);
  if (!event) throw invalid(`Event not found: ${id}`, 'NOT_FOUND', 404);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('Event update must be an object', 'INVALID_UPDATE');
  const stamp = new Date(now()).toISOString();
  const next = {...event};
  for (const [field, value] of Object.entries(changes)) {
   if (field === 'id' || field === 'createdAt' || field === 'updatedAt') throw invalid(`Field ${field} is read-only`, 'READ_ONLY_FIELD');
   if (!PATCHABLE_FIELDS.has(field)) throw invalid(`Unknown event field: ${field}`, 'UNKNOWN_FIELD');
   if (STRING_FIELDS.includes(field)) {
    next[field] = patchString(field, value);
   } else if (DATE_FIELDS.includes(field)) {
    next[field] = patchDate(field, value);
   } else if (NUMBER_FIELDS.includes(field)) {
    next[field] = patchNumber(field, value);
   } else if (LIST_FIELDS.includes(field)) {
    next[field] = patchList(field, value);
   } else if (field === 'sources') {
    next[field] = patchSources(value, stamp);
   } else if (field === 'documents') {
    next[field] = patchDocuments(value, stamp);
   } else if (field === 'competitors') {
    next[field] = patchCompetitors(value);
   } else if (ENUM_FIELDS[field]) {
    if (!ENUM_FIELDS[field].includes(value)) throw invalid(`Unknown ${field}: ${text(value)}`, 'INVALID_FIELD');
    next[field] = value;
   }
  }
  next.updatedAt = stamp;
  Object.assign(event, next);
  persist();
  return structuredClone(event);
 }

 function stats() {
  const counts = {
   total: state.events.length,
   discovered: 0, enriched: 0, verified: 0, archived: 0,
   cn: 0, eu: 0, global: 0,
   high: 0, medium: 0, low: 0,
   withDates: 0, withoutDates: 0,
  };
  for (const event of state.events) {
   counts[event.status] = (counts[event.status] ?? 0) + 1;
   counts[event.region] = (counts[event.region] ?? 0) + 1;
   counts[event.confidence] = (counts[event.confidence] ?? 0) + 1;
   if (event.startDate) counts.withDates += 1;
  }
  counts.withoutDates = counts.total - counts.withDates;
  return counts;
 }

 // Flat rows in the fixed contract column order; local-api serialises them to
 // CSV. List-valued columns stay arrays so the CSV writer can join them.
 function exportRows() {
  return [...state.events].sort(compareEvents).map(event => {
   const row = {};
   for (const column of EVENT_EXPORT_COLUMNS) {
    const value = event[column];
    if (column === 'industries' || column === 'notes') row[column] = [...(value ?? [])];
    else if (column === 'sources') row[column] = (value ?? []).map(source => ({url: source.url, title: source.title, verifiedAt: source.verifiedAt}));
    else row[column] = value ?? '';
   }
   return row;
  });
 }

 return {
  file,
  list,
  get,
  upsert,
  patch,
  stats,
  exportRows,
 };
}
