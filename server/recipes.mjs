// Extraction recipes: deterministic fallbacks for pages that readable text
// extraction cannot serve (JS shells, structured listing pages).
//
// Two responsibilities live here:
//  1. openRecipeStore(): a tiny JSON-backed registry of proposed/approved
//     recipes per domain+kind, so an approved recipe is reused without asking
//     the model again.
//  2. applyRecipe(): run a recipe in a deliberately small sandbox. A script
//     recipe only sees `input` (html/url/text/jsonLd) and a silent console;
//     code generation inside the vm is disabled and the run is limited to 1s.
//
// No network access, no require/process and no new dependencies.

import vm from 'node:vm';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const KINDS = new Set(['script', 'regex', 'selectors']);
const STATUSES = new Set(['proposed', 'approved', 'disabled']);
const STORE_VERSION = 1;
const SCRIPT_TIMEOUT_MS = 1000;

// ---- tiny HTML tokenizer (selector engine only) ----------------------------
// This is intentionally not a browser-grade parser: recipes need document order,
// attributes and text content, and no entity round-tripping.

const VOID_TAGS = new Set([
 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'template', 'textarea', 'title']);
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

// Implicit end tags that matter for real-world listing pages.
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

export function decodeEntities(value) {
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
   // Recipe selectors read visible text; raw script/style content is skipped and
   // only needs to be jumped over.
   const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
   const match = closeRe.exec(source.slice(cursor));
   index = match ? cursor + match.index + match[0].length : source.length;
   continue;
  }
  if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
 }
 return root;
}

function elementText(element) {
 let out = '';
 const visit = node => {
  for (const child of node.children ?? []) {
   if (child.type === 'text') { out += child.value; continue; }
   if (SKIP_TEXT_TAGS.has(child.tag)) continue;
   visit(child);
  }
 };
 visit(element);
 return out.replace(/\s+/g, ' ').trim();
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

// ---- minimal CSS selector: tag, .class, #id, [attr], [attr=value], @attr ----

function parseSimpleSelector(source, selector) {
 let rest = source;
 let attrName = null;
 const atMatch = /@([A-Za-z_:][-A-Za-z0-9_:.]*)$/.exec(rest);
 if (atMatch) {
  attrName = atMatch[1].toLowerCase();
  rest = rest.slice(0, atMatch.index);
 }
 if (!rest) throw Error('Selector "' + selector + '" has no element part');
 let index = 0;
 let tag = null;
 const classes = [];
 let id = null;
 const attrs = [];
 // Tag names stop at ':' so unsupported pseudo-classes such as `a:hover` are
 // rejected explicitly instead of matching nothing.
 const tagMatch = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
 if (tagMatch) {
  tag = tagMatch[1].toLowerCase();
  index = tagMatch[0].length;
 }
 while (index < rest.length) {
  const char = rest[index];
  if (char === '.') {
   const match = /^\.([\w-]+)/.exec(rest.slice(index));
   if (!match) throw Error('Invalid class token in selector "' + selector + '"');
   classes.push(match[1]);
   index += match[0].length;
  } else if (char === '#') {
   const match = /^#([\w-]+)/.exec(rest.slice(index));
   if (!match) throw Error('Invalid id token in selector "' + selector + '"');
   id = match[1];
   index += match[0].length;
  } else if (char === '[') {
   const end = rest.indexOf(']', index);
   if (end < 0) throw Error('Unterminated attribute selector in "' + selector + '"');
   const inner = rest.slice(index + 1, end).trim();
   const attrMatch = /^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?$/.exec(inner);
   if (!attrMatch) throw Error('Invalid attribute selector "[' + inner + ']" in "' + selector + '"');
   const hasValue = inner.includes('=');
   attrs.push({
    name: attrMatch[1].toLowerCase(),
    value: attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '',
    hasValue,
   });
   index = end + 1;
  } else {
   throw Error('Unsupported selector token "' + char + '" in "' + selector + '"');
  }
 }
 if (!tag && !classes.length && !id && !attrs.length) throw Error('Selector "' + selector + '" is empty');
 return {tag, classes, id, attrs, attrName};
}

function parseSelector(selector) {
 const source = String(selector ?? '').trim();
 if (!source) throw Error('Selector is empty');
 const parts = [];
 let current = '';
 let inBracket = false;
 let quote = null;
 for (const char of source) {
  if (quote) {
   current += char;
   if (char === quote) quote = null;
   continue;
  }
  if (char === '[') inBracket = true;
  if (char === ']') inBracket = false;
  if (char === '"' || char === "'") { if (inBracket) quote = char; current += char; continue; }
  if (/\s/.test(char) && !inBracket) {
   if (current) { parts.push(current); current = ''; }
   continue;
  }
  current += char;
 }
 if (current) parts.push(current);
 if (!parts.length) throw Error('Selector is empty');
 return parts.map(part => parseSimpleSelector(part, source));
}

function matchesSimple(element, simple) {
 if (simple.tag && simple.tag !== '*' && element.tag !== simple.tag) return false;
 if (simple.id && element.attrs.id !== simple.id) return false;
 if (simple.classes.length) {
  const classList = String(element.attrs.class ?? '').split(/\s+/).filter(Boolean);
  for (const className of simple.classes) if (!classList.includes(className)) return false;
 }
 for (const attr of simple.attrs) {
  const actual = element.attrs[attr.name];
  if (actual === undefined) return false;
  if (attr.hasValue && actual !== attr.value) return false;
 }
 return true;
}

function selectFirst(root, selector) {
 const parts = parseSelector(selector);
 let candidates = descendantsOf(root).filter(element => matchesSimple(element, parts[0]));
 for (let depth = 1; depth < parts.length && candidates.length; depth += 1) {
  const next = [];
  for (const parent of candidates) {
   for (const child of descendantsOf(parent)) {
    if (matchesSimple(child, parts[depth])) next.push(child);
   }
  }
  candidates = next;
 }
 if (!candidates.length) return null;
 return {element: candidates[0], attrName: parts[parts.length - 1].attrName};
}

// ---- body helpers ----------------------------------------------------------

function normalizeBody(body) {
 if (body === undefined || body === null) throw Error('Recipe body is required');
 const text = typeof body === 'string' ? body.trim() : JSON.stringify(body, null, 2);
 if (!text) throw Error('Recipe body is required');
 return text;
}

function parseObjectBody(body, what) {
 if (body && typeof body === 'object') {
  if (Array.isArray(body)) throw Error(what + ' recipe body must be a JSON object');
  return body;
 }
 if (typeof body !== 'string') throw Error(what + ' recipe body must be a JSON object');
 let parsed;
 try { parsed = JSON.parse(body); } catch (error) { throw Error('Recipe body is not valid JSON: ' + error.message); }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(what + ' recipe body must be a JSON object');
 return parsed;
}

function stableStringify(value) {
 if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
 if (value && typeof value === 'object') {
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
 }
 return JSON.stringify(value);
}

function hashBody(body) {
 const text = typeof body === 'string' ? body.trim() : JSON.stringify(body);
 let canonical = text;
 try { canonical = stableStringify(JSON.parse(text)); } catch { /* not JSON: hash the raw text */ }
 return createHash('sha256').update(canonical).digest('hex');
}

function clone(value) {
 return JSON.parse(JSON.stringify(value));
}

function fail(code, message) {
 // `error` is a human-readable string so the API/UI can render it directly
 // (`/api/v1/recipes/:id/test` declares error?: string); `code` stays available
 // for callers that branch on failure reasons.
 return {ok: false, values: null, error: message, code};
}

function timedRun(promise, ms) {
 return new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
   const error = Error('Recipe script timed out after ' + ms + 'ms');
   error.code = 'TIMEOUT';
   reject(error);
  }, ms);
  Promise.resolve(promise).then(
   value => { clearTimeout(timer); resolve(value); },
   error => { clearTimeout(timer); reject(error); },
  );
 });
}

// ---- recipe kinds ----------------------------------------------------------

async function runScriptRecipe(recipe, input) {
 const source = typeof recipe.body === 'string' ? recipe.body.trim() : String(recipe.body ?? '');
 if (!source) return fail('SCRIPT_ERROR', 'Recipe script is empty');
 // Data is embedded as a JSON literal so no host object ever enters the vm
 // context: a host object would expose host Function constructors and allow a
 // `constructor.constructor('return process')()` escape. `codeGeneration` is
 // also disabled so the sandbox cannot build new code from strings.
 const payload = JSON.stringify({
  html: input.html ?? '',
  url: input.url ?? '',
  text: input.text ?? '',
  jsonLd: input.jsonLd ?? [],
 });
 const code = "(function(){'use strict';" +
  'const input=' + payload + ';' +
  'const console=Object.freeze({log:function(){},info:function(){},warn:function(){},' +
  'error:function(){},debug:function(){},trace:function(){}});' +
  'const value=(\n' + source + '\n);' +
  "return typeof value==='function'?value(input):value;})()";
 const context = vm.createContext(Object.create(null), {
  name: 'domel-recipe',
  codeGeneration: {strings: false, wasm: false},
 });
 let result;
 try {
  result = vm.runInContext(code, context, {timeout: SCRIPT_TIMEOUT_MS, filename: 'domel-recipe.js'});
 } catch (error) {
  if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
   return fail('TIMEOUT', 'Recipe script timed out after ' + SCRIPT_TIMEOUT_MS + 'ms');
  }
  return fail('SCRIPT_ERROR', error instanceof Error ? error.message : String(error));
 }
 if (result && typeof result.then === 'function') {
  try {
   result = await timedRun(result, SCRIPT_TIMEOUT_MS);
  } catch (error) {
   return fail(error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'SCRIPT_ERROR', error instanceof Error ? error.message : String(error));
  }
 }
 if (!result || typeof result !== 'object' || Array.isArray(result)) {
  return fail('SCRIPT_ERROR', 'Recipe script must return an object');
 }
 let values;
 try {
  values = JSON.parse(JSON.stringify(result));
 } catch {
  return fail('SCRIPT_ERROR', 'Recipe script returned a value that cannot be serialised');
 }
 return {ok: true, values};
}

function runRegexRecipe(recipe, input) {
 let body;
 try { body = parseObjectBody(recipe.body, 'Regex'); } catch (error) { return fail('INVALID_BODY', error.message); }
 const text = String(input.text ?? '');
 const values = {};
 for (const [field, spec] of Object.entries(body)) {
  if (typeof spec === 'string') {
   // Tolerate the shorthand {"field": "pattern"}.
   try {
    const match = new RegExp(spec).exec(text);
    values[field] = match ? (match[1] ?? match[0]) : null;
   } catch (error) { return fail('REGEX_ERROR', 'Invalid regex for "' + field + '": ' + error.message); }
   continue;
  }
  if (!spec || typeof spec !== 'object' || typeof spec.pattern !== 'string') {
   return fail('INVALID_BODY', 'Regex spec for "' + field + '" must be {pattern, group?}');
  }
  let regex;
  try { regex = new RegExp(spec.pattern, spec.flags ?? spec.options ?? ''); } catch (error) {
   return fail('REGEX_ERROR', 'Invalid regex for "' + field + '": ' + error.message);
  }
  const match = regex.exec(text);
  if (!match) { values[field] = null; continue; }
  const requested = spec.group === undefined || spec.group === null ? NaN : Number(spec.group);
  const group = Number.isInteger(requested) && requested >= 0
   ? requested
   : (match.length > 1 ? 1 : 0);
  values[field] = group < match.length && match[group] !== undefined ? match[group] : null;
 }
 return {ok: true, values};
}

function runSelectorRecipe(recipe, input) {
 let body;
 try { body = parseObjectBody(recipe.body, 'Selector'); } catch (error) { return fail('INVALID_BODY', error.message); }
 let root;
 try { root = parseHtml(input.html ?? ''); } catch (error) { return fail('SELECTOR_ERROR', error.message); }
 const values = {};
 for (const [field, selector] of Object.entries(body)) {
  if (typeof selector !== 'string' || !selector.trim()) {
   return fail('INVALID_BODY', 'Selector for "' + field + '" must be a non-empty string');
  }
  let found;
  try { found = selectFirst(root, selector); } catch (error) {
   return fail('SELECTOR_ERROR', 'Invalid selector for "' + field + '": ' + error.message);
  }
  if (!found) { values[field] = null; continue; }
  values[field] = found.attrName ? found.element.attrs[found.attrName] ?? null : elementText(found.element);
 }
 return {ok: true, values};
}

// Execute one recipe against a page snapshot. Never throws: callers get
// {ok,values,error} so a bad recipe cannot fail a collection task by itself.
export async function applyRecipe(recipe, {html = '', url = '', text = '', jsonLd} = {}) {
 if (!recipe || typeof recipe !== 'object') return fail('INVALID_RECIPE', 'Recipe is required');
 const kind = recipe.kind;
 if (!KINDS.has(kind)) return fail('UNKNOWN_KIND', 'Unsupported recipe kind: ' + String(kind));
 const input = {
  html: String(html ?? ''),
  url: String(url ?? ''),
  text: String(text ?? ''),
  jsonLd: Array.isArray(jsonLd) ? jsonLd : [],
 };
 try {
  if (kind === 'script') return await runScriptRecipe(recipe, input);
  if (kind === 'regex') return runRegexRecipe(recipe, input);
  return runSelectorRecipe(recipe, input);
 } catch (error) {
  return fail('RECIPE_ERROR', error instanceof Error ? error.message : String(error));
 }
}

// ---- JSON-backed recipe store ---------------------------------------------

function loadStore(file) {
 if (!existsSync(file)) return {version: STORE_VERSION, recipes: []};
 let parsed;
 try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
  throw Error('Recipe store is not valid JSON: ' + error.message);
 }
 if (!parsed || typeof parsed !== 'object') throw Error('Recipe store has an unexpected shape');
 if (parsed.version !== undefined && parsed.version !== STORE_VERSION) {
  throw Error('Unsupported recipe store version: ' + String(parsed.version));
 }
 return {
  version: STORE_VERSION,
  recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
 };
}

function normalizeDomain(value) {
 const raw = String(value ?? '').trim().toLowerCase();
 if (!raw) throw Error('Recipe domain is required');
 if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { throw Error('Invalid recipe domain: ' + value); }
 }
 const hostPart = raw.split(/[/?#]/)[0];
 try { return new URL('http://' + hostPart).hostname.toLowerCase(); } catch { throw Error('Invalid recipe domain: ' + value); }
}

export function openRecipeStore({file, now = () => Date.now()} = {}) {
 if (!file) throw Error('openRecipeStore requires a file path');
 const data = loadStore(file);

 const nowIso = () => new Date(now()).toISOString();

 function persist() {
  mkdirSync(dirname(file), {recursive: true});
  const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
   writeFileSync(tmp, JSON.stringify(data, null, 2));
   renameSync(tmp, file);
  } catch (error) {
   try { rmSync(tmp, {force: true}); } catch { /* best effort */ }
   throw error;
  }
 }

 function findIndex(id) {
  return data.recipes.findIndex(recipe => recipe && recipe.id === id);
 }

 function requireIndex(id) {
  const index = findIndex(id);
  if (index < 0) throw Error('Recipe not found: ' + String(id));
  return index;
 }

 function list({domain, status} = {}) {
  let wantedDomain = null;
  if (domain !== undefined && domain !== null && domain !== '') {
   try { wantedDomain = normalizeDomain(domain); } catch { return []; }
  }
  return data.recipes
   .filter(recipe => (wantedDomain ? recipe.domain === wantedDomain : true))
   .filter(recipe => (status === undefined || status === null || status === '' ? true : recipe.status === status))
   .slice()
   .sort((left, right) => {
    const byUpdated = String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
    return byUpdated || String(left.id).localeCompare(String(right.id));
   })
   .map(clone);
 }

 function get(id) {
  const index = findIndex(id);
  return index < 0 ? null : clone(data.recipes[index]);
 }

 // Propose is idempotent: same domain+kind+body hash reuses the stored recipe;
 // changed content bumps the version on the existing domain+kind slot so
 // approvals stay attached to one record per slot.
 function propose({domain, kind, body, proposedBy = 'agent', notes = ''} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (!KINDS.has(kind)) throw Error('Unsupported recipe kind: ' + String(kind));
  const bodyText = normalizeBody(body);
  const hash = hashBody(bodyText);
  const sameContent = data.recipes.find(recipe => recipe.domain === normalizedDomain && recipe.kind === kind && hashBody(recipe.body) === hash);
  if (sameContent) return clone(sameContent);

  const sameSlot = data.recipes.find(recipe => recipe.domain === normalizedDomain && recipe.kind === kind);
  if (sameSlot) {
   sameSlot.body = bodyText;
   sameSlot.version = Number(sameSlot.version ?? 1) + 1;
   sameSlot.status = 'proposed';
   sameSlot.proposedBy = String(proposedBy ?? 'agent');
   sameSlot.notes = String(notes ?? '');
   sameSlot.updatedAt = nowIso();
   persist();
   return clone(sameSlot);
  }

  const timestamp = nowIso();
  const recipe = {
   id: randomUUID(),
   domain: normalizedDomain,
   version: 1,
   kind,
   body: bodyText,
   status: 'proposed',
   proposedBy: String(proposedBy ?? 'agent'),
   notes: String(notes ?? ''),
   createdAt: timestamp,
   updatedAt: timestamp,
  };
  data.recipes.push(recipe);
  persist();
  return clone(recipe);
 }

 function update(id, patch = {}) {
  const index = requireIndex(id);
  const recipe = data.recipes[index];
  if (patch.status !== undefined && !STATUSES.has(patch.status)) {
   throw Error('Unsupported recipe status: ' + String(patch.status));
  }
  let bodyChanged = false;
  if (patch.body !== undefined) {
   const bodyText = normalizeBody(patch.body);
   if (hashBody(bodyText) !== hashBody(recipe.body)) {
    recipe.body = bodyText;
    recipe.version = Number(recipe.version ?? 1) + 1;
    bodyChanged = true;
   }
  }
  if (patch.status !== undefined) recipe.status = patch.status;
  // A changed body must be re-approved before it is used automatically.
  if (bodyChanged && patch.status === undefined) recipe.status = 'proposed';
  if (patch.notes !== undefined) recipe.notes = String(patch.notes ?? '');
  recipe.updatedAt = nowIso();
  persist();
  return clone(recipe);
 }

 function remove(id) {
  const index = requireIndex(id);
  data.recipes.splice(index, 1);
  persist();
  return {ok: true};
 }

 return {list, get, propose, update, remove};
}
