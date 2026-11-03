// Page collector for the local demo.
//
// One collect() run follows the contract chain:
//   1. robots.txt (cached in memory for an hour) gates the URL,
//   2. the per-domain rate limiter acquires a slot (when injected),
//   3. plain HTTP fetch: 20s timeout, 2MB streaming cap, HTML content-type
//      check, manual redirect following (max 5 hops),
//   4. readable text extraction,
//   5. optional Playwright render when the text looks like a JS shell,
//   6. optional approved recipe when even the rendered text is thin.
//
// fetchImpl and launchBrowser are injectable so unit tests never touch the
// network. Errors are returned as data ({ok:false,error:{code,message,...}}) so
// a task runner can decide between retry (NETWORK/TIMEOUT/RATE_LIMITED) and a
// permanent failure (BLOCKED/ROBOTS_DENIED/TOO_LARGE/BAD_CONTENT_TYPE).

import {existsSync} from 'node:fs';
import {applyRecipe} from './recipes.mjs';

const DEFAULT_USER_AGENT = 'DomelMarketIntelligence/0.1 (+intranet demo)';
const DEFAULT_CHROME_PATH = '/usr/bin/google-chrome';
const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MIN_TEXT_LENGTH = 300;
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const BROWSER_RENDER_LIMIT_MS = 20000;

// ---- tiny HTML tree --------------------------------------------------------
// Readability-style extraction needs structure (article/main, tag text,
// attributes) but not browser-grade error recovery. This tolerant tokenizer
// keeps a stack of open elements, applies the handful of implicit end tags that
// matter for real pages, and skips comments/doctype. No dependencies.

const VOID_TAGS = new Set([
 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'template', 'textarea', 'title']);
const AUTO_CLOSE = {
 p: new Set(['p']),
 li: new Set(['li']),
 tr: new Set(['tr']),
 td: new Set(['td', 'th']),
 th: new Set(['td', 'th']),
 option: new Set(['option']),
 dt: new Set(['dt', 'dd']),
 dd: new Set(['dt', 'dd']),
};

const ENTITIES = {
 amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
 copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
 mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', times: '\u00d7',
 divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0', euro: '\u20ac',
 pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7',
 para: '\u00b6', laquo: '\u00ab', raquo: '\u00bb', lsquo: '\u2018',
 rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022',
 frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
};

function decodeEntities(value) {
 const text = String(value ?? '');
 if (!text.includes('&')) return text;
 return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
  if (body[0] === '#') {
   const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
   if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
   try { return String.fromCodePoint(code); } catch { return match; }
  }
  const named = ENTITIES[body.toLowerCase()];
  return named === undefined ? match : named;
 });
}

function parseHtml(html) {
 const root = {type: 'element', tag: '#document', attrs: {}, children: []};
 const stack = [root];
 const source = String(html ?? '');
 let index = 0;

 const addText = text => {
  if (text) stack[stack.length - 1].children.push({type: 'text', value: decodeEntities(text)});
 };

 while (index < source.length) {
  const lt = source.indexOf('<', index);
  if (lt < 0) { addText(source.slice(index)); break; }
  if (lt > index) addText(source.slice(index, lt));
  if (source.startsWith('<!--', lt)) {
   const end = source.indexOf('-->', lt + 4);
   index = end < 0 ? source.length : end + 3;
   continue;
  }
  if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
   const end = source.indexOf('>', lt);
   index = end < 0 ? source.length : end + 1;
   continue;
  }
  const closing = /^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(source.slice(lt));
  if (closing) {
   const tag = closing[1].toLowerCase();
   for (let depth = stack.length - 1; depth > 0; depth -= 1) {
    if (stack[depth].tag === tag) { stack.length = depth; break; }
   }
   index = lt + closing[0].length;
   continue;
  }
  const opening = /^<([a-zA-Z][\w:-]*)/.exec(source.slice(lt));
  if (!opening) { addText('<'); index = lt + 1; continue; }
  const tag = opening[1].toLowerCase();
  let cursor = lt + opening[0].length;
  const attrs = {};
  let selfClosing = false;
  while (cursor < source.length) {
   while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
   if (source[cursor] === '>') { cursor += 1; break; }
   if (source[cursor] === '/' && source[cursor + 1] === '>') { selfClosing = true; cursor += 2; break; }
   if (source[cursor] === '/') { cursor += 1; continue; }
   const nameMatch = /^[^\s=/>]+/.exec(source.slice(cursor));
   if (!nameMatch) { cursor += 1; continue; }
   const name = nameMatch[0].toLowerCase();
   cursor += nameMatch[0].length;
   while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
   let value = '';
   if (source[cursor] === '=') {
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] === '"' || source[cursor] === "'") {
     const quote = source[cursor];
     cursor += 1;
     const end = source.indexOf(quote, cursor);
     if (end < 0) { value = source.slice(cursor); cursor = source.length; }
     else { value = source.slice(cursor, end); cursor = end + 1; }
    } else {
     const valueMatch = /^[^\s>]+/.exec(source.slice(cursor));
     if (valueMatch) { value = valueMatch[0]; cursor += valueMatch[0].length; }
    }
   }
   if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  const element = {type: 'element', tag, attrs, children: []};
  const closers = AUTO_CLOSE[tag];
  if (closers) {
   while (stack.length > 1 && closers.has(stack[stack.length - 1].tag)) stack.pop();
  }
  stack[stack.length - 1].children.push(element);
  index = cursor;
  if (RAW_TEXT_TAGS.has(tag)) {
   const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
   const remaining = source.slice(cursor);
   const match = closeRe.exec(remaining);
   const rawText = match ? remaining.slice(0, match.index) : remaining;
   if (rawText) element.children.push({type: 'text', value: decodeEntities(rawText)});
   index = match ? cursor + match.index + match[0].length : source.length;
   continue;
  }
  if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
 }
 return root;
}

function findFirstElement(node, predicate) {
 if (node.type === 'element' && predicate(node)) return node;
 for (const child of node.children ?? []) {
  if (child.type !== 'element') continue;
  const found = findFirstElement(child, predicate);
  if (found) return found;
 }
 return null;
}

function descendantsOf(element) {
 const out = [];
 const visit = node => {
  for (const child of node.children ?? []) {
   if (child.type !== 'element') continue;
   out.push(child);
   visit(child);
  }
 };
 visit(element);
 return out;
}

const BLOCK_TAGS = new Set([
 'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div',
 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const NOISE_TAGS = new Set([
 'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas',
 'object', 'embed', 'form', 'select', 'button', 'input', 'textarea', 'nav',
 'footer', 'header', 'aside', 'dialog',
]);

const NOISE_ATTR = /(?:^|[-_\s])(?:nav|navbar|navigation|menu|footer|header|breadcrumb|sidebar|cookie|consent|share|social|comment|comments|advert|advertisement|ads?|banner|popup|modal|subscribe|newsletter)(?:[-_\s]|$)/i;
const CONTENT_ATTR = /(?:^|[-_\s])(?:article|content|main|post|entry|detail)(?:[-_\s]|$)/i;

function cleanTree(node) {
 if (!node.children) return node;
 node.children = node.children.filter(child => {
  if (child.type !== 'element') return true;
  if (NOISE_TAGS.has(child.tag)) return false;
  if (child.attrs.hidden !== undefined) return false;
  if (String(child.attrs['aria-hidden'] ?? '').toLowerCase() === 'true') return false;
  const marker = (String(child.attrs.id ?? '') + ' ' + String(child.attrs.class ?? '')).trim();
  if (marker && NOISE_ATTR.test(marker)) return false;
  return true;
 });
 for (const child of node.children) if (child.type === 'element') cleanTree(child);
 return node;
}

function elementText(element) {
 let out = '';
 const visit = node => {
  for (const child of node.children ?? []) {
   if (child.type === 'text') { out += child.value; continue; }
   visit(child);
  }
 };
 visit(element);
 return out;
}

function textContent(element) {
 return elementText(element).replace(/\s+/g, ' ').trim();
}

function blockText(node) {
 let out = '';
 const visit = element => {
  for (const child of element.children ?? []) {
   if (child.type === 'text') { out += child.value; continue; }
   const isBlock = BLOCK_TAGS.has(child.tag);
   if (isBlock) out += '\n';
   visit(child);
   if (isBlock) out += '\n';
  }
 };
 visit(node);
 return out;
}

function normalizeText(raw) {
 return String(raw ?? '')
  .split(/\n+/)
  .map(line => line.replace(/[\t\f\v\u00a0 ]+/g, ' ').trim())
  .filter(Boolean)
  .join('\n');
}

function escapeHtml(value) {
 return String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
 return escapeHtml(value).replace(/"/g, '&quot;');
}

function serializeNode(node, {baseUrl} = {}) {
 if (node.type === 'text') return escapeHtml(node.value);
 const attrs = Object.entries(node.attrs ?? {}).map(([name, value]) => {
  let resolved = value;
  if (baseUrl && (name === 'href' || name === 'src') && value) {
   try { resolved = new URL(value, baseUrl).href; } catch { /* keep raw */ }
  }
  return resolved === '' ? ' ' + name : ' ' + name + '="' + escapeAttr(resolved) + '"';
 }).join('');
 const children = (node.children ?? []).map(child => serializeNode(child, {baseUrl})).join('');
 return '<' + node.tag + attrs + '>' + children + '</' + node.tag + '>';
}

function extractTitle(root) {
 const titleElement = findFirstElement(root, element => element.tag === 'title');
 if (titleElement) {
  const text = textContent(titleElement);
  if (text) return text;
 }
 const meta = findFirstElement(root, element => element.tag === 'meta' && ['og:title', 'twitter:title'].includes(String(element.attrs.property ?? element.attrs.name ?? '').toLowerCase()));
 if (meta && meta.attrs.content) {
  const text = textContent({type: 'element', tag: 'meta-text', attrs: {}, children: [{type: 'text', value: meta.attrs.content}]});
  if (text) return text;
 }
 const heading = findFirstElement(root, element => element.tag === 'h1');
 if (heading) {
  const text = textContent(heading);
  if (text) return text;
 }
 return '';
}

function pickContentNode(root) {
 const body = findFirstElement(root, element => element.tag === 'body') ?? root;
 const candidates = [];
 const semantic = findFirstElement(body, element => element.tag === 'article' || element.tag === 'main' || String(element.attrs.role ?? '').toLowerCase() === 'main');
 if (semantic) candidates.push(semantic);
 for (const element of descendantsOf(body)) {
  const marker = (String(element.attrs.id ?? '') + ' ' + String(element.attrs.class ?? '')).trim();
  if (marker && CONTENT_ATTR.test(marker)) candidates.push(element);
 }
 const bodyLength = textContent(body).length;
 let best = null;
 for (const candidate of candidates) {
  const score = textContent(candidate).length;
  if (!best || score > best.score) best = {element: candidate, score};
 }
 // Trust an explicit content container only when it holds a real share of the page.
 if (best && (best.score >= 200 || best.score >= bodyLength * 0.5)) return best.element;
 return body;
}

// Exported for tests and for the event pipeline: title + paragraph text with
// scripts/styles/navigation/footer boilerplate removed and entities decoded.
export function extractReadable(html, {url} = {}) {
 const root = parseHtml(html);
 const title = extractTitle(root);
 // The head only matters for the title; dropping it stops meta/title text from
 // leaking into the body fallback for malformed pages without a <body>.
 const head = findFirstElement(root, element => element.tag === 'head');
 if (head) head.children = [];
 cleanTree(root);
 const content = pickContentNode(root);
 let text = normalizeText(blockText(content));
 if (!text) {
  const body = findFirstElement(root, element => element.tag === 'body') ?? root;
  text = normalizeText(blockText(body));
 }
 return {title, text, html: serializeNode(content, {baseUrl: url})};
}

function tryParseJson(raw) {
 try { return JSON.parse(raw); } catch { return undefined; }
}

function stripJsonComments(raw) {
 return raw
  .replace(/^\s*<!--/, '')
  .replace(/-->\s*$/, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .trim();
}

// Tolerant JSON-LD reader: malformed blocks are skipped, arrays and @graph are
// flattened, and the wrapper object is kept so callers can inspect @context.
export function extractJsonLd(html) {
 const source = String(html ?? '');
 const out = [];
 const collect = value => {
  if (Array.isArray(value)) { for (const item of value) collect(item); return; }
  if (!value || typeof value !== 'object') return;
  if (out.includes(value)) return;
  out.push(value);
  if (Array.isArray(value['@graph'])) for (const item of value['@graph']) collect(item);
 };
 const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
 let match;
 while ((match = scriptRe.exec(source))) {
  const attrs = match[1] ?? '';
  if (!/\btype\s*=\s*["']?application\/ld\+json["']?/i.test(attrs)) continue;
  const raw = match[2].trim();
  if (!raw) continue;
  let value = tryParseJson(raw);
  if (value === undefined) value = tryParseJson(stripJsonComments(raw));
  if (value === undefined) continue;
  collect(value);
 }
 return out;
}

// ---- collector -------------------------------------------------------------

function collectorError(code, message, extra = {}) {
 const error = new Error(message);
 error.code = code;
 error.collector = true;
 Object.assign(error, extra);
 return error;
}

function messageOf(error) {
 return error instanceof Error ? error.message : String(error);
}

function mimeOf(contentType) {
 return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

function headerValue(headers, name) {
 if (!headers) return null;
 const target = String(name).toLowerCase();
 if (typeof headers.get === 'function') {
  const value = headers.get(name);
  return value === undefined || value === null ? null : String(value);
 }
 if (Array.isArray(headers)) {
  const pair = headers.find(entry => Array.isArray(entry) && String(entry[0]).toLowerCase() === target);
  return pair ? String(pair[1]) : null;
 }
 for (const key of Object.keys(headers)) {
  if (key.toLowerCase() !== target) continue;
  const value = headers[key];
  return value === undefined || value === null ? null : String(value);
 }
 return null;
}

function parseRetryAfter(value, nowMs) {
 const text = String(value ?? '').trim();
 if (!text) return undefined;
 const seconds = Number(text);
 if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
 const date = Date.parse(text);
 if (Number.isFinite(date)) return Math.max(0, date - nowMs);
 return undefined;
}

function escapeRegExp(value) {
 return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function robotsPathMatches(rulePath, requestPath) {
 if (!rulePath.includes('*') && !rulePath.endsWith('$')) return requestPath.startsWith(rulePath);
 const anchored = rulePath.endsWith('$');
 const core = anchored ? rulePath.slice(0, -1) : rulePath;
 const pattern = '^' + core.split('*').map(escapeRegExp).join('.*') + (anchored ? '$' : '');
 try { return new RegExp(pattern).test(requestPath); } catch { return false; }
}

// Longest match wins; on an equal-length tie Allow wins. Only `User-agent: *`
// groups are considered, as the contract specifies.
function robotsAllows(rules, requestPath) {
 let best = null;
 for (const rule of rules) {
  if (!rule.path) continue;
  if (!robotsPathMatches(rule.path, requestPath)) continue;
  const score = rule.path.length;
  if (!best || score > best.score || (score === best.score && rule.type === 'allow')) {
   best = {score, type: rule.type};
  }
 }
 return best ? best.type === 'allow' : true;
}

function parseRobots(text) {
 const groups = [];
 let current = null;
 let inAgentBlock = false;
 for (const rawLine of String(text ?? '').split(/\r?\n/)) {
  const line = rawLine.replace(/#.*$/, '').trim();
  if (!line) { inAgentBlock = false; current = null; continue; }
  const colon = line.indexOf(':');
  if (colon < 0) continue;
  const field = line.slice(0, colon).trim().toLowerCase();
  const value = line.slice(colon + 1).trim();
  if (field === 'user-agent') {
   if (!inAgentBlock) {
    current = {agents: [], rules: [], crawlDelayMs: null};
    groups.push(current);
    inAgentBlock = true;
   }
   current.agents.push(value.toLowerCase());
   continue;
  }
  if (!current) {
   current = {agents: ['*'], rules: [], crawlDelayMs: null};
   groups.push(current);
   inAgentBlock = true;
  }
  if (field === 'allow' || field === 'disallow') {
   current.rules.push({type: field, path: value});
  } else if (field === 'crawl-delay') {
   const seconds = Number(value);
   if (Number.isFinite(seconds) && seconds >= 0) {
    current.crawlDelayMs = Math.max(current.crawlDelayMs ?? 0, seconds * 1000);
   }
  }
 }
 const starGroups = groups.filter(group => group.agents.includes('*'));
 if (!starGroups.length) return {rules: [], crawlDelayMs: 0};
 const rules = [];
 let crawlDelayMs = 0;
 for (const group of starGroups) {
  rules.push(...group.rules);
  if (group.crawlDelayMs !== null) crawlDelayMs = Math.max(crawlDelayMs, group.crawlDelayMs);
 }
 return {rules, crawlDelayMs};
}

function normalizeCharset(name) {
 const value = String(name ?? '').trim().toLowerCase();
 if (!value) return 'utf-8';
 // All Chinese legacy encodings are supersets of GB2312 in practice.
 if (value === 'gb2312' || value === 'gbk' || value === 'gb_2312-80' || value === 'x-gbk') return 'gb18030';
 return value;
}

function detectCharset(buffer, contentType) {
 const headerCharset = /charset\s*=\s*"?([a-zA-Z0-9._:-]+)"?/i.exec(String(contentType ?? ''));
 if (headerCharset) return normalizeCharset(headerCharset[1]);
 if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
 const head = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('latin1');
 const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9._:-]+)/i.exec(head);
 if (meta) return normalizeCharset(meta[1]);
 return 'utf-8';
}

function decodeHtml(buffer, contentType) {
 const charset = detectCharset(buffer, contentType);
 try { return new TextDecoder(charset, {fatal: false}).decode(buffer); } catch { return buffer.toString('utf8'); }
}

export function createCollector({
 fetchImpl = globalThis.fetch,
 launchBrowser,
 timeoutMs = 20000,
 maxBytes = 2_000_000,
 userAgent = DEFAULT_USER_AGENT,
 limiter,
 now = () => Date.now(),
} = {}) {
 if (typeof fetchImpl !== 'function') throw Error('createCollector requires a fetch implementation');
 const robotsCache = new Map();
 const robotsInflight = new Map();
 const collectInflight = new Map();
 let browserPromise = null;
 let browserClosed = false;

 const isoNow = () => new Date(now()).toISOString();

 function failure({url, finalUrl = url, status = 0, engine = 'http', contentType = null, bytes = 0, robots = {allowed: true, crawlDelayMs: 0}, error}) {
  return {
   ok: false,
   url,
   finalUrl: finalUrl ?? url,
   status: status ?? 0,
   engine,
   title: '',
   text: '',
   html: '',
   contentType,
   bytes,
   fetchedAt: isoNow(),
   robots: {allowed: robots.allowed !== false, crawlDelayMs: robots.crawlDelayMs ?? 0},
   error,
  };
 }

 function abortedError(contextUrl) {
  return collectorError('ABORTED', 'Collection aborted for ' + contextUrl, {permanent: true});
 }

 // One AbortController covers the request and its body read, so a stalled body
 // still hits the 20s deadline. Caller abort and internal timeout are tracked
 // separately to map to ABORTED vs TIMEOUT.
 function startAbortedRequest(callerSignal) {
  const controller = new AbortController();
  const info = {timedOut: false, callerAborted: false};
  const abort = () => { try { controller.abort(); } catch { /* already aborted */ } };
  const onCallerAbort = () => { info.callerAborted = true; abort(); };
  if (callerSignal) {
   if (callerSignal.aborted) { info.callerAborted = true; abort(); }
   else callerSignal.addEventListener('abort', onCallerAbort, {once: true});
  }
  const timer = setTimeout(() => { info.timedOut = true; abort(); }, timeoutMs);
  return {
   controller,
   info,
   finish() {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.('abort', onCallerAbort);
   },
  };
 }

 function abortReason(info) {
  const error = Error(info?.timedOut ? 'timeout' : 'aborted');
  error.name = 'AbortError';
  error.aborted = true;
  error.timedOut = Boolean(info?.timedOut);
  error.callerAborted = Boolean(info?.callerAborted);
  return error;
 }

 function raceAbort(promise, controller, info) {
  if (controller.signal.aborted) return Promise.reject(abortReason(info));
  return new Promise((resolve, reject) => {
   const onAbort = () => reject(abortReason(info));
   controller.signal.addEventListener('abort', onAbort, {once: true});
   Promise.resolve(promise).then(
    value => { controller.signal.removeEventListener('abort', onAbort); resolve(value); },
    error => { controller.signal.removeEventListener('abort', onAbort); reject(error); },
   );
  });
 }

 function mapFetchError(error, request, contextUrl) {
  if (error?.collector) return error;
  if (request.info.timedOut || error?.timedOut) {
   return collectorError('TIMEOUT', 'Request timed out after ' + timeoutMs + 'ms for ' + contextUrl);
  }
  if (request.info.callerAborted || error?.callerAborted || error?.name === 'AbortError') {
   return abortedError(contextUrl);
  }
  return collectorError('NETWORK', 'Network error for ' + contextUrl + ': ' + messageOf(error), {permanent: false});
 }

 function tooLargeError(contextUrl) {
  return collectorError('TOO_LARGE', 'Response exceeded ' + maxBytes + ' bytes for ' + contextUrl, {permanent: true});
 }

 async function discardBody(response) {
  try {
   const body = response?.body;
   if (body && typeof body.cancel === 'function') await body.cancel();
   else if (body && typeof body.destroy === 'function') body.destroy();
  } catch { /* best effort */ }
 }

 async function readBody(response, request, bytesLimit = maxBytes) {
  const body = response?.body;
  if (body === undefined || body === null) {
   if (typeof response?.text === 'function') {
    const text = await raceAbort(response.text(), request.controller, request.info);
    const buffer = Buffer.from(String(text ?? ''), 'utf8');
    if (buffer.length > bytesLimit) throw tooLargeError('response');
    return buffer;
   }
   if (typeof response?.arrayBuffer === 'function') {
    const arrayBuffer = await raceAbort(response.arrayBuffer(), request.controller, request.info);
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > bytesLimit) throw tooLargeError('response');
    return buffer;
   }
   return Buffer.alloc(0);
  }
  if (typeof body === 'string') {
   const buffer = Buffer.from(body, 'utf8');
   if (buffer.length > bytesLimit) throw tooLargeError('response');
   return buffer;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
   const buffer = Buffer.from(body);
   if (buffer.length > bytesLimit) throw tooLargeError('response');
   return buffer;
  }
  const chunks = [];
  let total = 0;
  if (typeof body.getReader === 'function') {
   const reader = body.getReader();
   try {
    for (;;) {
     const {done, value} = await raceAbort(reader.read(), request.controller, request.info);
     if (done) break;
     if (value === undefined) continue;
     const buffer = Buffer.from(value);
     total += buffer.length;
     if (total > bytesLimit) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw tooLargeError('response');
     }
     chunks.push(buffer);
    }
   } finally {
    try { reader.releaseLock?.(); } catch { /* already released */ }
   }
   return Buffer.concat(chunks, total);
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
   let tooLarge = false;
   for await (const chunk of body) {
    if (request.controller.signal.aborted) throw abortReason(request.info);
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > bytesLimit) { tooLarge = true; break; }
    chunks.push(buffer);
   }
   if (tooLarge) throw tooLargeError('response');
   return Buffer.concat(chunks, total);
  }
  throw collectorError('NETWORK', 'Unsupported response body type');
 }

 function httpStatusError(status, headers, contextUrl) {
  let host = null;
  try { host = new URL(contextUrl).hostname; } catch { /* ignore */ }
  if (status === 401 || status === 403) {
   if (limiter?.blockDomain && host) {
    try { limiter.blockDomain(host, {reason: 'HTTP ' + status}); } catch { /* limiter is advisory */ }
   }
   return collectorError('BLOCKED', 'HTTP ' + status + ' for ' + contextUrl + ' (domain blocked)', {permanent: true, status});
  }
  if (status === 429 || status === 503) {
   const retryAfterMs = parseRetryAfter(headerValue(headers, 'retry-after'), now());
   if (limiter?.backoff && host) {
    try { limiter.backoff(host, retryAfterMs ?? defaultBackoffMs()); } catch { /* limiter is advisory */ }
   }
   const extra = {status, permanent: false};
   if (retryAfterMs !== undefined) extra.retryAfterMs = retryAfterMs;
   return collectorError('RATE_LIMITED', 'HTTP ' + status + ' for ' + contextUrl + (retryAfterMs === undefined ? '' : '; retry after ' + retryAfterMs + 'ms'), extra);
  }
  if (status >= 500) {
   return collectorError('NETWORK', 'HTTP ' + status + ' for ' + contextUrl, {status, permanent: false});
  }
  return collectorError('HTTP_ERROR', 'HTTP ' + status + ' for ' + contextUrl, {status, permanent: true});
 }

 function defaultBackoffMs() {
  return Math.max(timeoutMs, 1000);
 }

 // Fetch robots.txt once per origin per hour. Any failure other than a caller
 // abort is treated as "no restrictions" (same as a 404), so collection keeps
 // working on hosts with a broken robots.txt.
 async function fetchRobots(targetUrl, {signal} = {}) {
  const origin = new URL(targetUrl).origin;
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > now()) return cached;
  const inflight = robotsInflight.get(origin);
  if (inflight) return inflight;
  const promise = (async () => {
   let parsed = {rules: [], crawlDelayMs: 0};
   const request = startAbortedRequest(signal);
   try {
    let response;
    try {
     response = await raceAbort(fetchImpl(origin + '/robots.txt', {
      method: 'GET',
      headers: {'user-agent': userAgent},
      redirect: 'follow',
      signal: request.controller.signal,
     }), request.controller, request.info);
    } catch (error) {
     if (request.info.callerAborted) throw abortedError(origin + '/robots.txt');
     // Timeout/network: behave like a missing robots.txt.
     response = null;
    }
    if (response) {
     const status = Number(response.status ?? 0);
     if (status >= 200 && status < 300) {
      try {
       const buffer = await raceAbort(readBody(response, request, Math.min(maxBytes, ROBOTS_MAX_BYTES)), request.controller, request.info);
       parsed = parseRobots(buffer.toString('utf8'));
      } catch (error) {
       if (request.info.callerAborted) throw abortedError(origin + '/robots.txt');
       if (request.info.timedOut) { /* allow all */ }
      }
     } else {
      await discardBody(response);
     }
    }
   } catch (error) {
    if (error?.code === 'ABORTED') throw error;
   } finally {
    request.finish();
   }
   const entry = {
    rules: parsed.rules,
    crawlDelayMs: parsed.crawlDelayMs,
    fetchedAt: isoNow(),
    expiresAt: now() + ROBOTS_CACHE_TTL_MS,
   };
   robotsCache.set(origin, entry);
   return entry;
  })();
  robotsInflight.set(origin, promise);
  try {
   return await promise;
  } finally {
   robotsInflight.delete(origin);
  }
 }

 async function requestPage(targetUrl, {signal} = {}) {
  const request = startAbortedRequest(signal);
  try {
   let response;
   try {
    response = await raceAbort(fetchImpl(targetUrl, {
     method: 'GET',
     redirect: 'manual',
     headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
     },
     signal: request.controller.signal,
    }), request.controller, request.info);
   } catch (error) {
    throw mapFetchError(error, request, targetUrl);
   }
   const status = Number(response?.status ?? 0);
   const headers = response?.headers;
   const location = headerValue(headers, 'location');
   if (REDIRECT_STATUSES.has(status) && location) {
    await discardBody(response);
    try { return {redirectTo: new URL(location, targetUrl).href, status}; } catch {
     throw collectorError('BAD_REDIRECT', 'Invalid redirect location "' + location + '" from ' + targetUrl, {permanent: true, status});
    }
   }
   if (status >= 400) {
    await discardBody(response);
    throw httpStatusError(status, headers, targetUrl);
   }
   if (status < 200 || status >= 300) {
    await discardBody(response);
    throw collectorError('HTTP_ERROR', 'Unexpected HTTP ' + status + ' for ' + targetUrl, {permanent: true, status});
   }
   const contentType = headerValue(headers, 'content-type');
   const mime = mimeOf(contentType);
   if (!HTML_MIME_TYPES.has(mime)) {
    await discardBody(response);
    throw collectorError('BAD_CONTENT_TYPE', 'Expected HTML but received "' + String(contentType ?? 'no content-type') + '" from ' + targetUrl, {
     permanent: true,
     status,
     contentType,
    });
   }
   const declaredLength = Number(headerValue(headers, 'content-length'));
   if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw tooLargeError(targetUrl);
   let buffer;
   try {
    buffer = await raceAbort(readBody(response, request), request.controller, request.info);
   } catch (error) {
    throw mapFetchError(error, request, targetUrl);
   }
   return {status, contentType, buffer, bytes: buffer.length};
  } finally {
   request.finish();
  }
 }

 async function fetchPage(startUrl, {signal} = {}) {
  let currentUrl = startUrl;
  for (let redirects = 0; ; redirects += 1) {
   const step = await requestPage(currentUrl, {signal});
   if (!step.redirectTo) return {...step, finalUrl: currentUrl};
   if (redirects >= MAX_REDIRECTS) {
    throw collectorError('TOO_MANY_REDIRECTS', 'More than ' + MAX_REDIRECTS + ' redirects while fetching ' + startUrl, {permanent: true});
   }
   currentUrl = step.redirectTo;
  }
 }

 async function getBrowser() {
  if (browserClosed) throw collectorError('BROWSER_UNAVAILABLE', 'Collector browser was closed');
  if (!browserPromise) {
   browserPromise = (async () => {
    if (typeof launchBrowser === 'function') return await launchBrowser();
    const executablePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
    if (!existsSync(executablePath)) {
     throw collectorError('BROWSER_UNAVAILABLE', 'Chrome executable not found at ' + executablePath);
    }
    let playwright;
    try { playwright = await import('playwright-core'); } catch (error) {
     throw collectorError('BROWSER_UNAVAILABLE', 'playwright-core is not available: ' + messageOf(error));
    }
    const chromium = playwright.chromium ?? playwright.default?.chromium;
    if (!chromium?.launch) throw collectorError('BROWSER_UNAVAILABLE', 'playwright-core chromium launcher is missing');
    return chromium.launch({
     executablePath,
     headless: true,
     args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions'],
    });
   })();
   browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
 }

 function abortableCall(promise, signal) {
  if (!signal) return promise;
  // Arguments are evaluated before this call, so the underlying Playwright
  // promise may have started already. Always attach a handler: otherwise an
  // already-aborted signal leaves the in-flight page call unhandled and its
  // later rejection (page closed by the finally block) kills the API process.
  const underlying = Promise.resolve(promise);
  if (signal.aborted) {
   underlying.catch(() => {});
   return Promise.reject(abortedError('browser render'));
  }
  return new Promise((resolve, reject) => {
   const onAbort = () => reject(abortedError('browser render'));
   signal.addEventListener('abort', onAbort, {once: true});
   underlying.then(
    value => { signal.removeEventListener('abort', onAbort); resolve(value); },
    error => { signal.removeEventListener('abort', onAbort); reject(error); },
   );
  });
 }

 async function renderWithBrowser(targetUrl, {signal} = {}) {
  const browser = await abortableCall(getBrowser(), signal);
  const page = await abortableCall(browser.newPage({userAgent}), signal);
  try {
   if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(Math.min(timeoutMs, BROWSER_RENDER_LIMIT_MS));
   try {
    await abortableCall(page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, BROWSER_RENDER_LIMIT_MS)}), signal);
   } catch (error) {
    if (signal?.aborted || error?.code === 'ABORTED') throw error;
    // Navigation errors are non-fatal: use whatever the page rendered so far.
   }
   // Give a client-rendered shell one tick to fill its container.
   if (typeof page.waitForTimeout === 'function') {
    await abortableCall(page.waitForTimeout(300), signal).catch(() => {});
   }
   const html = await abortableCall(page.content(), signal);
   const finalUrl = typeof page.url === 'function' ? page.url() : targetUrl;
   return {html, finalUrl};
  } finally {
   try { await page.close?.(); } catch { /* page may already be closed */ }
  }
 }

 async function collectOnce(inputUrl, {signal, allowPlaywright = true, recipe} = {}) {
  let robots = {allowed: true, crawlDelayMs: 0};
  let parsed;
  try {
   parsed = new URL(String(inputUrl));
  } catch {
   return failure({url: String(inputUrl), error: collectorError('INVALID_URL', 'Invalid URL: ' + String(inputUrl), {permanent: true})});
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
   return failure({url: String(inputUrl), error: collectorError('INVALID_URL', 'Only http(s) URLs can be collected: ' + String(inputUrl), {permanent: true})});
  }
  parsed.hash = '';
  const requestUrl = parsed.href;
  if (signal?.aborted) return failure({url: requestUrl, robots, error: abortedError(requestUrl)});
  try {
   const robotsInfo = await fetchRobots(requestUrl, {signal});
   robots = {allowed: robotsAllows(robotsInfo.rules, parsed.pathname + parsed.search), crawlDelayMs: robotsInfo.crawlDelayMs};
   if (signal?.aborted) return failure({url: requestUrl, robots, error: abortedError(requestUrl)});
   if (!robots.allowed) {
    return failure({url: requestUrl, robots, error: collectorError('ROBOTS_DENIED', 'robots.txt disallows ' + requestUrl, {permanent: true})});
   }
   if (limiter?.acquire) {
    try {
     await limiter.acquire(requestUrl, {crawlDelayMs: robots.crawlDelayMs});
    } catch (error) {
     const code = error?.code;
     if (code === 'DOMAIN_BLOCKED') {
      return failure({url: requestUrl, robots, error: collectorError('BLOCKED', messageOf(error), {permanent: true})});
     }
     if (code === 'ABORTED' || code === 'RESET') {
      return failure({url: requestUrl, robots, error: abortedError(requestUrl)});
     }
     if (code === 'INVALID_URL') {
      return failure({url: requestUrl, robots, error: collectorError('INVALID_URL', messageOf(error), {permanent: true})});
     }
     return failure({url: requestUrl, robots, error: collectorError('NETWORK', 'Rate limiter error: ' + messageOf(error), {permanent: false})});
    }
   }
   if (signal?.aborted) return failure({url: requestUrl, robots, error: abortedError(requestUrl)});

   const page = await fetchPage(requestUrl, {signal});
   const decodedHtml = decodeHtml(page.buffer, page.contentType);
   const readable = extractReadable(decodedHtml, {url: page.finalUrl});
   let title = readable.title;
   let text = readable.text;
   let html = decodedHtml;
   let finalUrl = page.finalUrl;
   let engine = 'http';
   let renderError = null;
   let recipeError = null;
   let values = null;

   if (allowPlaywright && text.length < MIN_TEXT_LENGTH) {
    try {
     const rendered = await renderWithBrowser(finalUrl, {signal});
     if (rendered?.html) {
      const renderedReadable = extractReadable(rendered.html, {url: rendered.finalUrl ?? finalUrl});
      if (renderedReadable.text.length > text.length) {
       title = renderedReadable.title || title;
       text = renderedReadable.text;
       html = rendered.html;
       finalUrl = rendered.finalUrl || finalUrl;
       engine = 'browser';
      }
     }
    } catch (error) {
     if (error?.code === 'ABORTED' || signal?.aborted) return failure({url: requestUrl, finalUrl, status: page.status, contentType: page.contentType, bytes: page.bytes, robots, error: abortedError(requestUrl)});
     renderError = {code: error?.code ?? 'BROWSER_ERROR', message: messageOf(error)};
    }
   }

   if (text.length < MIN_TEXT_LENGTH && recipe) {
    try {
     const applied = await applyRecipe(recipe, {
      html,
      url: finalUrl,
      text,
      jsonLd: extractJsonLd(html),
     });
     if (applied.ok) {
      engine = 'recipe';
      values = applied.values;
     } else {
      recipeError = {code: applied.code ?? 'RECIPE_ERROR', message: applied.error ?? 'Recipe did not produce values'};
     }
    } catch (error) {
     recipeError = {code: 'RECIPE_ERROR', message: messageOf(error)};
    }
   }

   const result = {
    ok: true,
    url: requestUrl,
    finalUrl,
    status: page.status,
    engine,
    title,
    text,
    html,
    contentType: page.contentType,
    bytes: page.bytes,
    fetchedAt: isoNow(),
    robots,
   };
   if (values) result.values = values;
   if (renderError) result.renderError = renderError;
   if (recipeError) result.recipeError = recipeError;
   return result;
  } catch (error) {
   if (signal?.aborted) return failure({url: requestUrl, robots, error: abortedError(requestUrl)});
   if (error?.collector) {
    const mapped = {code: error.code, message: error.message};
    if (error.retryAfterMs !== undefined) mapped.retryAfterMs = error.retryAfterMs;
    if (error.permanent !== undefined) mapped.permanent = error.permanent;
    return failure({
     url: requestUrl,
     finalUrl: error.finalUrl,
     status: error.status,
     contentType: error.contentType,
     robots,
     error: mapped,
    });
   }
   return failure({url: requestUrl, robots, error: collectorError('NETWORK', messageOf(error), {permanent: false})});
  }
 }

 function canonicalKey(url) {
  try {
   const parsed = new URL(String(url));
   parsed.hash = '';
   return parsed.href;
  } catch {
   return String(url);
  }
 }

 // In-flight de-duplication: two tasks asking for the same page share one fetch
 // (and one robots.txt lookup) instead of doubling load on the source.
 function collect(url, options = {}) {
  const key = canonicalKey(url);
  const active = collectInflight.get(key);
  if (active) return active;
  const promise = collectOnce(String(url), options).catch(error => failure({
   url: String(url),
   error: collectorError('INTERNAL', 'Unexpected collector error: ' + messageOf(error), {permanent: false}),
  }));
  collectInflight.set(key, promise);
  promise.finally(() => {
   if (collectInflight.get(key) === promise) collectInflight.delete(key);
  }).catch(() => {});
  return promise;
 }

 // Document availability probe for M3d: HEAD first, GET Range:0-0 fallback.
 async function probe(url, {signal} = {}) {
  let parsed;
  try { parsed = new URL(String(url)); } catch {
   return {ok: false, status: null, contentType: null, contentLength: null, availability: 'unknown', error: {code: 'INVALID_URL', message: 'Invalid URL: ' + String(url)}};
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
   return {ok: false, status: null, contentType: null, contentLength: null, availability: 'unknown', error: {code: 'INVALID_URL', message: 'Only http(s) URLs can be probed: ' + String(url)}};
  }
  parsed.hash = '';
  const classify = status => {
   if (status >= 200 && status < 300) return 'downloadable';
   if (status === 401 || status === 403) return 'restricted';
   return 'unknown';
  };
  const request = async method => {
   const attempt = startAbortedRequest(signal);
   try {
    const response = await raceAbort(fetchImpl(parsed.href, {
     method,
     redirect: 'follow',
     headers: method === 'HEAD'
      ? {'user-agent': userAgent}
      : {'user-agent': userAgent, range: 'bytes=0-0'},
     signal: attempt.controller.signal,
    }), attempt.controller, attempt.info);
    const status = Number(response?.status ?? 0);
    const contentType = headerValue(response?.headers, 'content-type');
    const rawLength = headerValue(response?.headers, 'content-length');
    const length = Number(rawLength);
    await discardBody(response);
    return {
     ok: true,
     status,
     contentType,
     contentLength: rawLength !== null && Number.isFinite(length) ? length : null,
     availability: classify(status),
    };
   } catch (error) {
    if (signal?.aborted) throw abortedError(parsed.href);
    throw mapFetchError(error, attempt, parsed.href);
   } finally {
    attempt.finish();
   }
  };
  try {
   const head = await request('HEAD');
   // HEAD is optional in HTTP: a 405/501 means the server refuses the method,
   // so fall back to the ranged GET just like a network failure.
   if (head.status !== 405 && head.status !== 501) return head;
  } catch (headError) {
   if (headError?.code === 'ABORTED') {
    return {ok: false, status: null, contentType: null, contentLength: null, availability: 'unknown', error: {code: 'ABORTED', message: headError.message, permanent: true}};
   }
   // HEAD may be unsupported or blocked; retry as a ranged GET.
  }
  try {
   return await request('GET');
  } catch (error) {
   return {
    ok: false,
    status: null,
    contentType: null,
    contentLength: null,
    availability: 'unknown',
    error: {
     code: error?.code ?? 'NETWORK',
     message: messageOf(error),
     ...(error?.permanent !== undefined ? {permanent: error.permanent} : {}),
    },
   };
  }
 }

 async function close() {
  browserClosed = true;
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
   const browser = await pending;
   await browser?.close?.();
  } catch { /* browser failed to launch or is already gone */ }
 }

 return {collect, probe, close};
}
