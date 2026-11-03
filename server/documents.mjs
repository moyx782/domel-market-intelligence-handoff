// Collected-page document store (M3b/M3d).
//
// One record per URL, not per fetch: re-crawling a page refreshes its text and
// bumps `runs` while keeping `firstFetchedAt`, so the demo can show "how often
// did we look" without growing duplicate documents forever. Per-document files
// (PDF etc.) are never downloaded here; event.enrich records their link and
// availability through the collector's probe instead.

import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const DOCUMENT_ENGINES = ['http', 'browser', 'recipe'];

// Stable short fingerprint for page content: the first 16 hex chars of SHA-256
// are enough to spot an unchanged page in the demo while staying grep-able.
export function hash(text) {
 return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

function invalid(message, code = 'INVALID_DOCUMENT') {
 const error = Error(message);
 error.code = code;
 error.status = 400;
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

function normalizeUrl(value) {
 const raw = String(value ?? '').trim();
 if (!raw) throw invalid('Document URL is required', 'INVALID_URL');
 let parsed;
 try {
  parsed = new URL(raw);
 } catch {
  throw invalid(`Invalid document URL: ${raw}`, 'INVALID_URL');
 }
 if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid('Document URL must be http(s)', 'INVALID_URL');
 parsed.hash = '';
 return parsed.href;
}

function toIso(value, fallbackMs) {
 const ms = toMs(value);
 return new Date(ms ?? fallbackMs).toISOString();
}

function toBytes(value) {
 const number = Number(value);
 if (!Number.isFinite(number) || number < 0) return 0;
 return Math.trunc(number);
}

export function openDocumentStore({file, now = () => Date.now()} = {}) {
 if (!file) throw Error('Document store requires a file path');

 let state = {version: 1, documents: []};
 try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed && Array.isArray(parsed.documents)) state = {version: 1, documents: parsed.documents};
 } catch (error) {
  if (error?.code !== 'ENOENT') console.warn(`[documents] Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
 }

 function persist() {
  state.version = 1;
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
 }

 function save(input = {}) {
  const url = normalizeUrl(input.url);
  const stampMs = now();
  const stampIso = new Date(stampMs).toISOString();
  const fetchedAt = toIso(input.fetchedAt, stampMs);
  const text = String(input.text ?? '');
  const hashValue = typeof input.hash === 'string' && input.hash.trim() ? input.hash.trim() : hash(text);
  const sourceId = input.sourceId === undefined || input.sourceId === null ? null : String(input.sourceId);
  const existing = state.documents.find(document => document.url === url);
  if (existing) {
   // Keep the first-seen timestamp and the accumulation counter; everything
   // else reflects the most recent fetch.
   existing.sourceId = sourceId ?? existing.sourceId ?? null;
   existing.title = input.title === undefined ? existing.title ?? '' : String(input.title ?? '');
   existing.text = input.text === undefined ? existing.text ?? '' : text;
   existing.htmlBytes = input.htmlBytes === undefined ? existing.htmlBytes ?? 0 : toBytes(input.htmlBytes);
   existing.engine = input.engine === undefined ? existing.engine ?? 'http' : String(input.engine);
   existing.hash = hashValue;
   existing.fetchedAt = fetchedAt;
   existing.runs = (Number(existing.runs) || 0) + 1;
   existing.updatedAt = stampIso;
   persist();
   return structuredClone(existing);
  }
  const document = {
   id: randomUUID(),
   sourceId,
   url,
   title: String(input.title ?? ''),
   text,
   htmlBytes: toBytes(input.htmlBytes),
   engine: String(input.engine ?? 'http'),
   hash: hashValue,
   firstFetchedAt: fetchedAt,
   fetchedAt,
   runs: 1,
   createdAt: stampIso,
   updatedAt: stampIso,
  };
  state.documents.push(document);
  persist();
  return structuredClone(document);
 }

 function list({sourceId, since} = {}) {
  const sinceMs = toMs(since);
  return state.documents
   .filter(document => (sourceId ? document.sourceId === sourceId : true))
   .filter(document => (sinceMs === null ? true : (toMs(document.fetchedAt) ?? 0) >= sinceMs))
   .sort((a, b) => (toMs(b.fetchedAt) ?? 0) - (toMs(a.fetchedAt) ?? 0) || a.id.localeCompare(b.id))
   .map(document => structuredClone(document));
 }

 function get(id) {
  const document = state.documents.find(item => item.id === id);
  return document ? structuredClone(document) : null;
 }

 function stats() {
  const sourceIds = new Set(state.documents.map(document => document.sourceId).filter(Boolean));
  const latest = state.documents.reduce((max, document) => Math.max(max, toMs(document.fetchedAt) ?? 0), 0);
  return {
   total: state.documents.length,
   sources: sourceIds.size,
   htmlBytes: state.documents.reduce((sum, document) => sum + (Number(document.htmlBytes) || 0), 0),
   lastFetchedAt: latest ? new Date(latest).toISOString() : null,
  };
 }

 return {
  file,
  hash,
  save,
  list,
  get,
  stats,
 };
}
