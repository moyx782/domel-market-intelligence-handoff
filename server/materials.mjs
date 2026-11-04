// Storage for OCR/parsed material text + agent reports.
//
// Event JSON only keeps lightweight material metadata (source URL, provider,
// pages, chars, textPath, summaries). Full text lives under .local/documents and
// is read by the agent report task and the event detail view.

import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

function safeId(value) {
 return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function openMaterialStore({root = '.local/documents'} = {}) {
 const base = resolve(root);
 const materialsRoot = join(base, 'materials');
 const reportsRoot = join(base, 'reports');

 function fileFor({eventId, url, kind = 'document', text}) {
  const dir = join(materialsRoot, safeId(eventId));
  mkdirSync(dir, {recursive: true});
  const key = String(url || text || '').slice(0, 500);
  const hash = createHash('sha1').update(kind + '\n' + key).digest('hex').slice(0, 16);
  return join(dir, (kind === 'webpage' ? 'page-' : 'doc-') + hash + '.md');
 }

 function save({eventId, url = '', title = '', kind = 'document', provider = 'vision-ocr', engine = '', pages = null, text = '', summary = ''}) {
  const body = String(text ?? '').trim();
  const path = fileFor({eventId, url, kind, text: body});
  const header = [
   '---',
   'source_url: ' + JSON.stringify(String(url || '')),
   'provider: ' + JSON.stringify(String(provider || '')),
   'engine: ' + JSON.stringify(String(engine || '')),
   'pages: ' + String(pages ?? 'null'),
   'chars: ' + String(body.length),
   'saved_at: ' + JSON.stringify(new Date().toISOString()),
   '---',
   '',
  ].join('\n');
  writeFileSync(path, header + body + '\n', {mode: 0o600});
  const material = {
   id: randomUUID(),
   url: String(url || ''),
   title: String(title || url || path),
   kind: kind === 'webpage' ? 'webpage' : 'document',
   provider: String(provider || 'vision-ocr'),
   engine: String(engine || ''),
   pages: Number.isInteger(Number(pages)) && Number(pages) > 0 ? Number(pages) : null,
   chars: body.length,
   textPath: path,
   summary: String(summary || ''),
   agentSummary: '',
   createdAt: new Date().toISOString(),
  };
  return {material, path};
 }

 function read(textPath) {
  const path = resolve(String(textPath || ''));
  if (!path.startsWith(base)) throw Error('Material path is outside the material store');
  if (!existsSync(path)) throw Error('Material text file is missing: ' + textPath);
  return readFileSync(path, 'utf8');
 }

 function reportPath(eventId) {
  return join(reportsRoot, safeId(eventId) + '.md');
 }

 function saveReport(eventId, markdown) {
  mkdirSync(reportsRoot, {recursive: true});
  const path = reportPath(eventId);
  writeFileSync(path, String(markdown ?? '').trim() + '\n', {mode: 0o600});
  return path;
 }

 function readReport(eventId) {
  const path = reportPath(eventId);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
 }

 return {root: base, materialsRoot, reportsRoot, save, read, saveReport, readReport, reportPath};
}
