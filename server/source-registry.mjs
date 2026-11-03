// Source registry: the list of URLs worth visiting, not the pages already
// collected. The scheduler asks `due()` for work and task handlers report back
// with markRunning / markResult, so the registry stays the single source of
// truth for "what to crawl next" even after a restart.
//
// One JSON file, atomic rename on every write: a crash can never leave a
// half-written registry that would make the demo re-crawl or forget sources.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export const SOURCE_TYPES = ['venue', 'association', 'organizer', 'media', 'site', 'rss', 'sitemap'];
export const SOURCE_REGIONS = ['cn', 'eu', 'global'];
export const SOURCE_STATUSES = ['idle', 'running', 'error', 'paused', 'manual'];
export const SOURCE_DISCOVERED_BY = ['human', 'agent'];
// The product requirement sets a hard lower bound of 30s per source; larger
// intervals are fine (most seed sources use 1h-24h).
export const MIN_INTERVAL_SEC = 30;
export const DEFAULT_INTERVAL_SEC = 3600;
export const DEFAULT_PRIORITY = 1;

function invalid(message, code = 'INVALID_SOURCE', status = 400) {
 const error = Error(message);
 error.code = code;
 error.status = status;
 return error;
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

function isoAt(ms) {
 return new Date(ms).toISOString();
}

// URLs are compared and stored without the fragment: "#section" never changes
// which page a source means, so it must not create a duplicate registry row.
function normalizeUrl(value) {
 const raw = String(value ?? '').trim();
 if (!raw) throw invalid('Source URL is required', 'INVALID_URL');
 let parsed;
 try {
  parsed = new URL(raw);
 } catch {
  throw invalid(`Invalid source URL: ${raw}`, 'INVALID_URL');
 }
 if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid('Source URL must be http(s)', 'INVALID_URL');
 parsed.hash = '';
 return parsed.href;
}

function domainOf(url) {
 return new URL(url).hostname.toLowerCase();
}

function toPriority(value) {
 if (value === undefined || value === null || value === '') return DEFAULT_PRIORITY;
 const number = Number(value);
 if (!Number.isInteger(number) || number < 0 || number > 3) throw invalid('priority must be an integer 0-3', 'INVALID_PRIORITY');
 return number;
}

function toIntervalSec(value) {
 if (value === undefined || value === null || value === '') return DEFAULT_INTERVAL_SEC;
 const number = Number(value);
 if (!Number.isFinite(number) || !Number.isInteger(number)) throw invalid('intervalSec must be an integer number of seconds', 'INVALID_INTERVAL');
 if (number < MIN_INTERVAL_SEC) throw invalid(`intervalSec must be at least ${MIN_INTERVAL_SEC}`, 'INVALID_INTERVAL');
 return number;
}

function toSourceType(value) {
 if (value === undefined || value === null || value === '') return 'site';
 const type = String(value).trim();
 if (!SOURCE_TYPES.includes(type)) throw invalid(`Unknown source type: ${type}`, 'INVALID_TYPE');
 return type;
}

function toRegion(value) {
 if (value === undefined || value === null || value === '') return 'cn';
 const region = String(value).trim();
 if (!SOURCE_REGIONS.includes(region)) throw invalid(`Unknown source region: ${region}`, 'INVALID_REGION');
 return region;
}

function toStatus(value) {
 const status = String(value ?? '').trim();
 if (!SOURCE_STATUSES.includes(status)) throw invalid(`Unknown source status: ${status}`, 'INVALID_STATUS');
 return status;
}

// Human-readable error text for lastError. Accepts the collector error object
// shape ({code, message}) as well as plain strings/Errors.
function errorText(error) {
 if (!error) return 'Unknown collection error';
 if (typeof error === 'string') return error;
 const code = error.code ? String(error.code) : '';
 const message = error.message ? String(error.message) : '';
 if (code && message) return `${code}: ${message}`;
 return message || code || 'Unknown collection error';
}

export function openSourceRegistry({file, seedFile = null, now = () => Date.now()} = {}) {
 if (!file) throw Error('Source registry requires a file path');

 let state = {version: 1, sources: [], domains: {}};
 try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed && typeof parsed === 'object') {
   if (Array.isArray(parsed.sources)) state.sources = parsed.sources;
   if (parsed.domains && typeof parsed.domains === 'object' && !Array.isArray(parsed.domains)) state.domains = parsed.domains;
  }
 } catch (error) {
  // ENOENT is the normal first run; a damaged file starting empty is safer than
  // crashing the demo on boot (the seed file will repopulate it).
  if (error?.code !== 'ENOENT') console.warn(`[source-registry] Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
 }

 function ensureDomain(domain) {
  if (!state.domains[domain] || typeof state.domains[domain] !== 'object') state.domains[domain] = {};
 }

 function persist() {
  state.version = 1;
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
 }

 function buildSource(input = {}, stampMs = now()) {
  const url = normalizeUrl(input.url);
  const domain = domainOf(url);
  const discoveredBy = input.discoveredBy === undefined ? 'human' : String(input.discoveredBy).trim();
  if (!SOURCE_DISCOVERED_BY.includes(discoveredBy)) throw invalid(`Unknown discoveredBy: ${discoveredBy}`, 'INVALID_DISCOVERED_BY');
  const title = String(input.title ?? '').trim();
  return {
   id: randomUUID(),
   url,
   domain,
   title: title || domain,
   type: toSourceType(input.type),
   region: toRegion(input.region),
   enabled: input.enabled === undefined ? true : Boolean(input.enabled),
   priority: toPriority(input.priority),
   intervalSec: toIntervalSec(input.intervalSec),
   lastRunAt: null,
   nextRunAt: null,
   status: 'idle',
   lastError: null,
   discoveredBy,
   createdAt: isoAt(stampMs),
   updatedAt: isoAt(stampMs),
  };
 }

 // First open of an empty registry imports the curated seed so a fresh demo has
 // sources to schedule without hand-editing JSON. Bad entries are skipped: one
 // typo in the seed must not prevent the app from starting.
 let seedImported = 0;
 if (!state.sources.length && seedFile) {
  let seed = null;
  try {
   seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  } catch (error) {
   if (error?.code !== 'ENOENT') console.warn(`[source-registry] Could not read seed ${seedFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Array.isArray(seed) ? seed : Array.isArray(seed?.sources) ? seed.sources : [];
  for (const entry of entries) {
   try {
    const source = buildSource(entry, now());
    if (state.sources.some(item => item.url === source.url)) continue;
    state.sources.push(source);
    ensureDomain(source.domain);
    seedImported += 1;
   } catch (error) {
    console.warn(`[source-registry] Skipped seed source: ${error instanceof Error ? error.message : String(error)}`);
   }
  }
  if (seedImported) persist();
 }
 // Existing files may predate the domain map; index them without a write.
 for (const source of state.sources) ensureDomain(source.domain);

 const find = id => state.sources.find(source => source.id === id);
 const requireSource = id => {
  const source = find(id);
  if (!source) throw invalid(`Source not found: ${id}`, 'NOT_FOUND', 404);
  return source;
 };
 const urlInUse = (url, exceptId = null) => state.sources.some(source => source.url === url && source.id !== exceptId);

 function list({region, enabled, type} = {}) {
  return state.sources
   .filter(source => (region ? source.region === region : true))
   .filter(source => (type ? source.type === type : true))
   .filter(source => (enabled === undefined || enabled === null ? true : source.enabled === enabled))
   // The task queue treats 3 as the highest priority (P0), so mirror that here:
   // high-value sources are listed and scheduled first.
   .sort((a, b) => (b.priority - a.priority) || (toMs(a.createdAt) ?? 0) - (toMs(b.createdAt) ?? 0) || a.id.localeCompare(b.id))
   .map(source => structuredClone(source));
 }

 function get(id) {
  const source = find(id);
  return source ? structuredClone(source) : null;
 }

 function create(input = {}) {
  const source = buildSource(input, now());
  if (urlInUse(source.url)) throw invalid(`Source URL already registered: ${source.url}`, 'DUPLICATE_URL', 409);
  state.sources.push(source);
  ensureDomain(source.domain);
  persist();
  return structuredClone(source);
 }

 function update(id, patch) {
  const source = requireSource(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Source update must be an object', 'INVALID_UPDATE');
  const allowed = ['url', 'title', 'type', 'region', 'priority', 'intervalSec', 'enabled', 'status'];
  for (const key of Object.keys(patch)) {
   if (!allowed.includes(key)) throw invalid(`Unknown source field: ${key}`, 'UNKNOWN_FIELD');
  }
  const next = {...source};
  if (patch.url !== undefined) {
   next.url = normalizeUrl(patch.url);
   if (urlInUse(next.url, id)) throw invalid(`Source URL already registered: ${next.url}`, 'DUPLICATE_URL', 409);
   next.domain = domainOf(next.url);
  }
  if (patch.title !== undefined) next.title = String(patch.title ?? '').trim();
  if (patch.type !== undefined) next.type = toSourceType(patch.type);
  if (patch.region !== undefined) next.region = toRegion(patch.region);
  if (patch.priority !== undefined) next.priority = toPriority(patch.priority);
  if (patch.intervalSec !== undefined) next.intervalSec = toIntervalSec(patch.intervalSec);
  if (patch.enabled !== undefined) {
   if (typeof patch.enabled !== 'boolean') throw invalid('enabled must be a boolean', 'INVALID_ENABLED');
   next.enabled = patch.enabled;
   // Re-enabling a paused source puts it back in the schedule; otherwise the
   // toggle would look on while the scheduler keeps ignoring it.
   if (next.enabled && next.status === 'paused') next.status = 'idle';
  }
  if (patch.status !== undefined) next.status = toStatus(patch.status);
  next.updatedAt = isoAt(now());
  Object.assign(source, next);
  ensureDomain(source.domain);
  persist();
  return structuredClone(source);
 }

 function remove(id) {
  const index = state.sources.findIndex(source => source.id === id);
  if (index < 0) throw invalid(`Source not found: ${id}`, 'NOT_FOUND', 404);
  const [removed] = state.sources.splice(index, 1);
  persist();
  return structuredClone(removed);
 }

 // Sources ready to run: enabled, not paused, and either never run or due.
 // `nextRunAt` is an ISO string, so parse before comparing numbers.
 function due(nowMs) {
  const at = nowMs === undefined ? now() : (toMs(nowMs) ?? now());
  return state.sources
   .filter(source => source.enabled && source.status !== 'paused')
   .filter(source => {
    const next = source.nextRunAt ? toMs(source.nextRunAt) : 0;
    return (next ?? 0) <= at;
   })
   .sort((a, b) => (b.priority - a.priority)
    || ((a.nextRunAt ? toMs(a.nextRunAt) : 0) - (b.nextRunAt ? toMs(b.nextRunAt) : 0))
    || a.id.localeCompare(b.id))
   .map(source => structuredClone(source));
 }

 // Called by the source.collect task handler at start. Advancing nextRunAt here
 // keeps a long-running collection from being picked up again while it runs.
 function markRunning(id) {
  const source = requireSource(id);
  const stamp = now();
  source.status = 'running';
  source.nextRunAt = isoAt(stamp + source.intervalSec * 1000);
  source.updatedAt = isoAt(stamp);
  persist();
  return structuredClone(source);
 }

 // Called by the task handler when a collection finishes or fails. `blocked`
 // mirrors the collector's BLOCKED permanent error and pauses the source for a
 // human decision instead of retrying a WAF-blocked site forever.
 function markResult(id, {ok = true, error = null, nowMs, crawlDelayMs = 0, blocked = false} = {}) {
  const source = requireSource(id);
  const stamp = nowMs === undefined ? now() : (toMs(nowMs) ?? now());
  const effectiveIntervalMs = Math.max(source.intervalSec * 1000, Math.max(0, Number(crawlDelayMs) || 0));
  const stampIso = isoAt(stamp);
  source.lastRunAt = stampIso;
  source.nextRunAt = isoAt(stamp + effectiveIntervalMs);
  source.updatedAt = stampIso;
  if (ok) {
   source.status = 'idle';
   source.lastError = null;
  } else {
   const message = errorText(error);
   const code = String(error?.code ?? '').toUpperCase();
   const pause = blocked === true || code === 'BLOCKED';
   source.status = pause ? 'paused' : 'error';
   source.lastError = message;
  }
  ensureDomain(source.domain);
  state.domains[source.domain] = {
   lastRunAt: source.lastRunAt,
   lastStatus: source.status,
   lastError: source.lastError,
   paused: source.status === 'paused',
  };
  persist();
  return structuredClone(source);
 }

 function stats() {
  const counts = {total: state.sources.length, enabled: 0, idle: 0, running: 0, error: 0, paused: 0, manual: 0};
  for (const source of state.sources) {
   if (source.enabled) counts.enabled += 1;
   counts[source.status] = (counts[source.status] ?? 0) + 1;
  }
  counts.domains = Object.keys(state.domains).length;
  return counts;
 }

 return {
  file,
  seedImported,
  list,
  get,
  create,
  update,
  remove,
  due,
  markRunning,
  markResult,
  stats,
  domains: () => structuredClone(state.domains),
  domain: name => (state.domains[name] ? structuredClone(state.domains[name]) : null),
 };
}
