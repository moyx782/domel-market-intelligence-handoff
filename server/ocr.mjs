// OCR for documents and image-only pages.
//
// Providers:
//   - vision: the active AI model (DeepSeek chat completions supports image_url,
//     verified locally with Chinese + English images). Also works for an
//     OpenAI-compatible multimodal endpoint configured in Settings.
//   - pdftotext: PDFs that already have a text layer (cheap, no tokens).
//   - pdftoppm + vision: scanned PDFs, rendered page by page.
//
// The token is never logged or returned. OCR output is untrusted web/document
// text: callers must treat it as data, quote it, and let a human/agent verify it.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mineruConfig} from './mineru.mjs';
import {parseMineru} from './mineru-client.mjs';

const run = promisify(execFile);
const DEFAULT_PROMPT = `请提取图片中的全部文字，保持原有阅读顺序。
表格用 Markdown 表格；只输出提取到的文字，不要解释、不要总结、不要补充图片里没有的内容。
如果图片中没有可辨认文字，只输出空字符串。`;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function binaryExists(name) {
 const dirs = String(process.env.PATH ?? '').split(':').filter(Boolean);
 for (const dir of dirs) {
  if (existsSync(join(dir, name))) return true;
 }
 return false;
}

function completionUrl(baseUrl) {
 const base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
 if (/\/chat\/completions$/i.test(base)) return base;
 return base + '/chat/completions';
}

function cleanText(value) {
 return String(value ?? '')
  .replace(/```(?:markdown|text)?\s*([\s\S]*?)```/gi, '$1')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
}

function resolveVision({env, getLlm}) {
 let llm = {};
 if (typeof getLlm === 'function') {
  try { llm = getLlm() ?? {}; } catch { llm = {}; }
 }
 const key = String(llm.key || env.DEEPSEEK_API_KEY || env.AI_API_KEY || '').trim();
 const baseUrl = String(llm.baseUrl || env.DEEPSEEK_BASE_URL || env.AI_BASE_URL || 'https://api.deepseek.com').trim();
 const model = String(llm.model || env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash').trim();
 const provider = llm.provider === 'custom' ? 'custom' : 'deepseek';
 return {key, baseUrl, model, provider, configured: provider === 'custom' ? Boolean(baseUrl) : Boolean(key && baseUrl)};
}

export function createOcr({env = process.env, getLlm, getMineru, fetchImpl = fetch, maxPages = Number(env.OCR_MAX_PAGES) || 5, timeoutMs = Number(env.OCR_TIMEOUT_MS) || 90000} = {}) {
 const mineruState = () => mineruConfig(env, typeof getMineru === 'function' ? (getMineru() ?? {}) : {});
 const mineruConfigured = () => { try { return mineruState().configured; } catch { return false; } };
 const vision = resolveVision({env, getLlm});
 const tools = {
  pdftotext: binaryExists('pdftotext'),
  pdftoppm: binaryExists('pdftoppm'),
  pdfimages: binaryExists('pdfimages'),
 };
 const maxDocumentPages = Math.max(1, Math.min(20, Number(maxPages) || 5));

 async function recognizeImage(buffer, {mime = 'image/png', prompt = DEFAULT_PROMPT} = {}) {
  if (!vision.configured) throw Error('Vision OCR is not configured. Set an AI model with image input in Settings → AI model.');
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!data.length) throw Error('Cannot OCR an empty image');
  if (data.length > MAX_IMAGE_BYTES) throw Error('Image is too large for OCR (' + data.length + ' bytes)');
  const response = await fetchImpl(completionUrl(vision.baseUrl), {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    ...(vision.key ? {Authorization: 'Bearer ' + vision.key} : {}),
   },
   body: JSON.stringify({
    model: vision.model,
    temperature: 0,
    messages: [{
     role: 'user',
     content: [
      {type: 'text', text: prompt},
      {type: 'image_url', image_url: {url: 'data:' + mime + ';base64,' + data.toString('base64')}},
     ],
    }],
   }),
   signal: AbortSignal.timeout(Math.max(5000, timeoutMs)),
  });
  const raw = await response.text();
  if (!response.ok) throw Error('OCR model returned HTTP ' + response.status + (raw ? ': ' + raw.slice(0, 200) : ''));
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Error('OCR model returned invalid JSON'); }
  const content = parsed?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
   ? content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('\n')
   : String(content ?? '');
  return cleanText(text);
 }

 // A text-layer PDF can still contain screenshots of exhibitor lists or hall
// maps. Inspect embedded image dimensions before deciding whether the token
// (MinerU vlm) or vision OCR should also read the images.
 async function pdfImageInfo(pdfPath) {
  if (!tools.pdfimages) return {count: 0, significant: 0};
  try {
   const {stdout} = await run('pdfimages', ['-list', pdfPath], {maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs});
   let count = 0;
   let significant = 0;
   for (const line of String(stdout).split('\n')) {
    const match = /^\s*(\d+)\s+\d+\s+\w+\s+(\d+)\s+(\d+)\s/.exec(line);
    if (!match) continue;
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (!width || !height) continue;
    count += 1;
    // logos/bullets are small; content screenshots/maps/lists are large
    if (width * height >= 200_000 || (width >= 400 && height >= 250)) significant += 1;
   }
   return {count, significant};
  } catch {
   return {count: 0, significant: 0};
  }
 }

 function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
 }

 async function ocrPdfEmbeddedImages(pdfPath, dir, {maxImages = Math.max(1, Number(env.OCR_MAX_PDF_IMAGES) || 3)} = {}) {
  if (!tools.pdfimages || !vision.configured) return [];
  const prefix = join(dir, 'img');
  try {
   await run('pdfimages', ['-png', '-p', '-f', '1', '-l', String(maxDocumentPages), pdfPath, prefix], {maxBuffer: 1024 * 1024, timeout: Math.max(timeoutMs, 60000)});
  } catch {
   return [];
  }
  const files = readdirSync(dir).filter(name => /^img-\d+-\d+\.png$/i.test(name)).sort();
  const selected = [];
  for (const name of files) {
   const buffer = readFileSync(join(dir, name));
   const size = pngSize(buffer);
   if (!size) continue;
   if (!(size.width * size.height >= 200_000 || (size.width >= 400 && size.height >= 250))) continue;
   selected.push({name, buffer, size});
   if (selected.length >= maxImages) break;
  }
  const results = [];
  for (const image of selected) {
   try {
    const text = await recognizeImage(image.buffer, {mime: 'image/png'});
    if (text) {
     const page = /^img-(\d+)-/.exec(image.name)?.[1] || '?';
     results.push({page, width: image.size.width, height: image.size.height, text});
    }
   } catch { /* one bad image should not fail the text layer */ }
  }
  return results;
 }

 async function extractPdf(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!tools.pdftotext) throw Error('pdftotext is not installed; cannot read PDF documents');
  const dir = mkdtempSync(join(tmpdir(), 'domel-ocr-'));
  const pdfPath = join(dir, 'input.pdf');
  try {
   writeFileSync(pdfPath, data);
   let text = '';
   try {
    const {stdout} = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs});
    text = cleanText(stdout);
   } catch { /* a scanned PDF can fail or return no text */ }
   const imageInfo = await pdfImageInfo(pdfPath);
   const mineru = mineruState();
   if (text.length >= 20) {
    // Text layer exists, but large embedded images may contain exhibitor lists
    // or hall maps. Prefer the token/vlm route for those documents; otherwise
    // append vision OCR of the significant images to the text-layer result.
    if (imageInfo.significant > 0 && mineru.configured) {
     try {
      const parsed = await parseMineru({buffer: data, mime: 'application/pdf', config: mineru, fetchImpl, timeoutMs: Math.max(timeoutMs, 180000)});
      return {text: parsed.text, provider: parsed.provider, pages: parsed.pages, method: parsed.method + '+images'};
     } catch { /* fall back to text layer + image OCR */ }
    }
    if (imageInfo.significant > 0 && vision.configured) {
     const images = await ocrPdfEmbeddedImages(pdfPath, dir);
     if (images.length) {
      const combined = cleanText([text, '--- PDF 内嵌图片 OCR ---', ...images.map(image => '第 ' + image.page + ' 页图片（' + image.width + '×' + image.height + '）：\n' + image.text)].join('\n\n'));
      return {text: combined, provider: 'pdftotext+vision-images', pages: null, method: 'text-layer+images', images: images.length};
     }
    }
    return {text, provider: 'pdftotext', pages: null, method: 'text-layer', images: imageInfo.significant};
   }
   if (mineru.configured) {
    try {
     const parsed = await parseMineru({buffer: data, mime: 'application/pdf', config: mineru, fetchImpl, timeoutMs: Math.max(timeoutMs, 180000)});
     return {text: parsed.text, provider: parsed.provider, pages: parsed.pages, method: parsed.method};
    } catch (error) {
     if (!vision.configured) throw Error('MinerU parsing failed and vision OCR is not configured: ' + (error instanceof Error ? error.message : String(error)));
     // fall through to the vision OCR fallback
    }
   }
   if (!vision.configured) throw Error('PDF has no text layer and vision OCR is not configured');
   if (!tools.pdftoppm) throw Error('pdftoppm is not installed; cannot render scanned PDF pages');
   const prefix = join(dir, 'page');
   try {
    await run('pdftoppm', ['-png', '-r', '180', '-f', '1', '-l', String(maxDocumentPages), pdfPath, prefix], {maxBuffer: 1024 * 1024, timeout: Math.max(timeoutMs, 60000)});
   } catch (error) {
    throw Error('Could not render PDF pages: ' + (error instanceof Error ? error.message : String(error)));
   }
   const pages = readdirSync(dir).filter(name => /^page-\d+\.png$/i.test(name)).sort((left, right) => left.localeCompare(right, 'en', {numeric: true}));
   if (!pages.length) throw Error('PDF rendered no pages');
   const parts = [];
   for (let index = 0; index < pages.length; index += 1) {
    const recognized = await recognizeImage(readFileSync(join(dir, pages[index])), {mime: 'image/png'});
    if (recognized) parts.push('--- 第 ' + (index + 1) + ' 页 ---\n' + recognized);
   }
   const combined = cleanText(parts.join('\n\n'));
   if (!combined) throw Error('OCR found no text in the scanned PDF');
   return {text: combined, provider: 'vision-ocr', pages: pages.length, method: 'scanned-pdf'};
  } finally {
   rmSync(dir, {recursive: true, force: true});
  }
 }

 async function extract(buffer, {mime = '', url = ''} = {}) {
  const type = String(mime || '').toLowerCase();
  const path = String(url || '').toLowerCase();
  if (type.includes('pdf') || /\.pdf(?:$|[?#])/.test(path)) return extractPdf(buffer);
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|tiff?)(?:$|[?#])/.test(path)) {
   const mineru = mineruState();
   if (mineru.configured) {
    try {
     const parsed = await parseMineru({buffer, mime: mime || 'image/png', url, config: mineru, fetchImpl, timeoutMs: Math.max(timeoutMs, 180000)});
     return {text: parsed.text, provider: parsed.provider, pages: parsed.pages ?? 1, method: parsed.method};
    } catch (error) {
     if (!vision.configured) throw Error('MinerU parsing failed and vision OCR is not configured: ' + (error instanceof Error ? error.message : String(error)));
    }
   }
   return {text: await recognizeImage(buffer, {mime: mime || 'image/png'}), provider: 'vision-ocr', pages: 1, method: 'image'};
  }
  throw Error('Unsupported document type for OCR: ' + (mime || url || 'unknown'));
 }

 function status() {
  const mineru = mineruState();
  const configured = vision.configured || mineru.configured;
  return {
   configured,
   provider: mineru.configured ? 'mineru' : (vision.configured ? 'vision' : 'none'),
   mode: mineru.configured ? 'mineru-' + mineru.modelVersion : (vision.configured ? 'vision-ocr' : 'unavailable'),
   model: mineru.configured ? mineru.modelVersion : (vision.configured ? vision.model : null),
   baseUrl: mineru.configured ? mineru.baseUrl : (vision.configured ? vision.baseUrl : null),
   vision: {
    configured: vision.configured,
    provider: vision.configured ? 'vision' : 'none',
    model: vision.configured ? vision.model : null,
    baseUrl: vision.configured ? vision.baseUrl : null,
   },
   mineru: {
    provider: mineru.provider,
    configured: mineru.configured,
    baseUrl: mineru.provider === 'none' ? null : mineru.baseUrl,
    modelVersion: mineru.provider === 'none' ? null : mineru.modelVersion,
    tokenSet: Boolean(mineru.token),
   },
   tools,
   limits: {maxPages: maxDocumentPages, maxImageBytes: MAX_IMAGE_BYTES},
  };
 }

 return {
  provider: 'vision',
  get configured() { return vision.configured || mineruConfigured(); },
  recognizeImage,
  extractPdf,
  extract,
  status,
 };
}

// Persist OCR/parsed text under a data directory so materials can be reviewed
// and re-used by the agent report step.
export function saveParsedText({root = '.local/documents/parsed', eventId, url = '', text, meta = {}}) {
 const safeId = String(eventId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
 const dir = join(root, safeId);
 mkdirSync(dir, {recursive: true});
 let hash = 0;
 for (const char of String(url || text).slice(0, 500)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
 const file = join(dir, 'doc-' + hash.toString(36) + '.md');
 const header = [
  '---',
  'source_url: ' + JSON.stringify(String(url || '')),
  'provider: ' + JSON.stringify(String(meta.provider || 'vision-ocr')),
  'pages: ' + String(meta.pages ?? 'null'),
  'chars: ' + String(String(text).length),
  'parsed_at: ' + JSON.stringify(new Date().toISOString()),
  '---',
  '',
 ].join('\n');
 writeFileSync(file, header + String(text ?? '').trim() + '\n', {mode: 0o600});
 return {textPath: file, chars: String(text ?? '').trim().length};
}
