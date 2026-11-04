// MinerU Standard API client (token required).
//
// Docs: https://mineru.net/apiManage/docs
//   POST /api/v4/file-urls/batch    -> signed upload URLs + batch_id
//   PUT  <signed url>               -> upload file bytes
//   GET  /api/v4/extract-results/batch/{batch_id} -> state/full_zip_url
// The zip contains Markdown/JSON; we extract the Markdown and return it as the
// OCR text. The token comes from Settings (agent-config ocr.token) or env and is
// never logged or returned.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const run = promisify(execFile);

function baseOf(config) {
 return String(config?.baseUrl || 'https://mineru.net/api/v4').replace(/\/+$/, '');
}

function filenameFor({filename, mime, url}) {
 const clean = String(filename || '').split(/[\\/]/).pop().replace(/[^\w.-]+/g, '_').slice(-120);
 if (clean && /\.(pdf|png|jpe?g|webp|gif|bmp|tiff?|docx?|pptx?|xlsx?)$/i.test(clean)) return clean;
 const path = String(url || '').split('?')[0];
 const ext = (path.match(/\.([a-z0-9]{2,5})$/i)?.[1] || (String(mime).includes('pdf') ? 'pdf' : 'png')).toLowerCase();
 return 'document.' + ext;
}

async function apiJson(response, action) {
 const raw = await response.text();
 let parsed = null;
 try { parsed = JSON.parse(raw); } catch { /* gateway may return HTML */ }
 if (!response.ok) throw Error('MinerU ' + action + ' failed (HTTP ' + response.status + ')');
 if (!parsed) throw Error('MinerU ' + action + ' returned invalid JSON');
 if (parsed.success === false) throw Error('MinerU ' + action + ' failed: ' + String(parsed.msgCode || '') + ' ' + String(parsed.msg || '').trim());
 if (parsed.code !== undefined && parsed.code !== 0) throw Error('MinerU ' + action + ' failed: ' + String(parsed.msg || ('code ' + parsed.code)));
 return parsed;
}

async function extractZipMarkdown(zipBuffer) {
 const dir = mkdtempSync(join(tmpdir(), 'domel-mineru-'));
 const zipPath = join(dir, 'result.zip');
 try {
  writeFileSync(zipPath, zipBuffer);
  const {stdout: listing} = await run('unzip', ['-Z1', zipPath], {timeout: 30000, maxBuffer: 2 * 1024 * 1024});
  const names = String(listing).split('\n').map(name => name.trim()).filter(Boolean);
  const markdown = names.find(name => /(^|\/)full\.md$/i.test(name))
   ?? names.find(name => /\.md$/i.test(name))
   ?? null;
  if (!markdown) throw Error('MinerU zip contains no Markdown');
  const {stdout} = await run('unzip', ['-p', zipPath, markdown], {timeout: 60000, maxBuffer: 16 * 1024 * 1024});
  return String(stdout).trim();
 } finally {
  rmSync(dir, {recursive: true, force: true});
 }
}

export async function parseMineru({buffer, mime = 'application/pdf', url = '', filename, config, fetchImpl = fetch, pollIntervalMs = 2000, timeoutMs = 180000}) {
 if (!config?.configured || !config?.token) throw Error('MinerU token is not configured');
 const base = baseOf(config);
 const name = filenameFor({filename, mime, url});
 const headers = {Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json'};
 const model = String(config.modelVersion || 'vlm');

 // 1) Ask for a signed upload URL and batch id.
 const batchResponse = await fetchImpl(base + '/file-urls/batch', {
  method: 'POST',
  headers,
  body: JSON.stringify({
   files: [{name, data_id: name.replace(/[^\w.-]+/g, '_').slice(0, 100)}],
   model_version: model,
   is_ocr: true,
   enable_formula: true,
   enable_table: true,
   language: String(config.language || 'ch'),
  }),
  signal: AbortSignal.timeout(60000),
 });
 const batch = await apiJson(batchResponse, 'file-urls/batch');
 const batchId = batch?.data?.batch_id;
 const uploadUrl = batch?.data?.file_urls?.[0];
 if (!batchId || !uploadUrl) throw Error('MinerU did not return an upload URL');

 // 2) Upload bytes to the signed URL (no Content-Type per API contract).
 const upload = await fetchImpl(uploadUrl, {method: 'PUT', body: buffer, signal: AbortSignal.timeout(120000)});
 if (!upload.ok) throw Error('MinerU upload failed (HTTP ' + upload.status + ')');

 // 3) Poll batch result.
 const deadline = Date.now() + Math.max(5000, timeoutMs);
 let result = null;
 while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, Math.max(500, pollIntervalMs)));
  const response = await fetchImpl(base + '/extract-results/batch/' + encodeURIComponent(batchId), {headers, signal: AbortSignal.timeout(30000)});
  const payload = await apiJson(response, 'batch result');
  const items = Array.isArray(payload?.data?.extract_result) ? payload.data.extract_result : [];
  result = items.find(item => item.file_name === name) ?? items[0] ?? null;
  if (result?.state === 'failed') throw Error('MinerU parsing failed: ' + String(result.err_msg || 'unknown error'));
  if (result?.state === 'done') break;
  result = null;
 }
 if (!result?.full_zip_url) throw Error('MinerU parsing timed out');

 // 4) Download + extract Markdown.
 const zipResponse = await fetchImpl(result.full_zip_url, {signal: AbortSignal.timeout(120000)});
 if (!zipResponse.ok) throw Error('MinerU result download failed (HTTP ' + zipResponse.status + ')');
 const zip = Buffer.from(await zipResponse.arrayBuffer());
 const text = await extractZipMarkdown(zip);
 if (!text) throw Error('MinerU returned an empty Markdown result');
 return {
  text: text.slice(0, 300000),
  provider: 'mineru-' + model,
  model,
  method: 'mineru-batch',
  batchId,
  pages: null,
  chars: text.length,
 };
}
