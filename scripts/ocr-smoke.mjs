#!/usr/bin/env node
// Real OCR smoke test (uses the configured AI vision model, costs a few tokens):
//   npm run test:ocr
// Generates a Chinese+English image and a scanned (image-only) PDF, runs OCR,
// asserts the expected text, and writes evidence/ocr/OCR_SMOKE_<date>.log.

import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {createOcr} from '../server/ocr.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const REPO = join(HERE, '..');
const OUT = join(REPO, 'evidence', 'ocr');

function loadEnv() {
 const env = {...process.env};
 for (const file of ['.env', '.env.host']) {
  const path = join(REPO, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
   const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
   if (match) env[match[1]] = match[2];
  }
 }
 return env;
}

function font() {
 try {
  return execFileSync('fc-match', ['-f', '%{file}', 'Noto Sans CJK SC'], {encoding: 'utf8'}).trim();
 } catch {
  return '/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc';
 }
}

function magick(args) {
 try { execFileSync('magick', args, {stdio: 'pipe'}); } catch { execFileSync('convert', args, {stdio: 'pipe'}); }
}

async function main() {
 mkdirSync(OUT, {recursive: true});
 const env = loadEnv();
 const getLlm = () => ({
  provider: env.AI_BASE_URL ? 'custom' : 'deepseek',
  key: env.AI_API_KEY || env.DEEPSEEK_API_KEY || '',
  baseUrl: env.AI_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash',
 });
 const ocr = createOcr({env, getLlm});
 const lines = [];
 const log = (line) => { console.log(line); lines.push(line); };
 log('OCR smoke · ' + new Date().toISOString());
 log('status: ' + JSON.stringify(ocr.status()));
 let failures = 0;
 const check = (name, ok, detail = '') => {
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures += 1;
 };

 const dir = join(OUT, 'fixtures');
 mkdirSync(dir, {recursive: true});
 const png = join(dir, 'ocr-smoke.png');
 const pdf = join(dir, 'ocr-smoke-scan.pdf');
 const f = font();
 magick(['-size', '1200x340', 'xc:white', '-font', f, '-pointsize', '48', '-fill', 'black',
  '-annotate', '+60+110', '中国国际制冷展 2026', '-annotate', '+60+210', '上海新国际博览中心',
  '-annotate', '+60+290', 'China Refrigeration Expo', png]);
 magick([png, pdf]);
 log('fixtures: ' + png + ' · ' + pdf);

 const image = await ocr.recognizeImage(readFileSync(png), {mime: 'image/png'});
 check('vision OCR reads Chinese + English image', image.includes('中国国际制冷展') && /China Refrigeration/i.test(image), image.replace(/\n/g, ' | '));

 const scanned = await ocr.extractPdf(readFileSync(pdf));
 check('scanned PDF is OCRed (no text layer) ', scanned.text.includes('上海新国际博览中心') && scanned.pages >= 1, scanned.provider + ' pages=' + scanned.pages + ' text=' + scanned.text.slice(0, 80).replace(/\n/g, ' | '));

 const logFile = join(OUT, 'OCR_SMOKE_' + new Date().toISOString().slice(0, 10) + '.log');
 writeFileSync(logFile, lines.join('\n') + '\n' + 'result: ' + (failures ? 'FAIL' : 'PASS') + '\n', {mode: 0o600});
 log('evidence: ' + logFile);
 if (failures) process.exitCode = 1;
}

main().catch(error => {
 console.error('OCR smoke failed: ' + (error instanceof Error ? error.message : error));
 process.exitCode = 1;
});
