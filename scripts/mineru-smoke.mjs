#!/usr/bin/env node
// Test the CURRENT MinerU configuration, including the token saved from the
// frontend Settings page (write-only, never printed).
//
//   npm run test:mineru
//   npm run test:mineru -- /path/to/scanned.pdf
//
// Uses evidence/ocr/fixtures/ocr-smoke-scan.pdf by default (a real scanned PDF
// without a text layer, so the MinerU token channel is exercised). Writes
// evidence/ocr/MINERU_SMOKE_<date>.log and exits non-zero on failure.

import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openAgentStore} from '../server/agent-config.mjs';
import {createOcr} from '../server/ocr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const OUT = join(REPO, 'evidence', 'ocr');
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const pdfPath = args[0] || join(REPO, 'evidence', 'ocr', 'fixtures', 'ocr-smoke-scan.pdf');

function loadEnv() {
 const env = {...process.env};
 for (const file of ['.env', '.env.host']) {
  try {
   for (const line of readFileSync(join(REPO, file), 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && !env[match[1]]) env[match[1]] = match[2];
   }
  } catch { /* optional */ }
 }
 return env;
}

async function main() {
 const env = loadEnv();
 const dataDir = env.AGENT_DATA_DIR || join(REPO, '.local');
 const store = openAgentStore(dataDir);
 const ocrConfig = store.ocr();
 const lines = [];
 const log = line => { console.log(line); lines.push(line); };
 log('MinerU smoke · ' + new Date().toISOString());
 log('config file: ' + join(dataDir, 'agent-config.json'));
 log('frontend OCR config: provider=' + ocrConfig.provider
  + ' tokenSet=' + Boolean(ocrConfig.token)
  + ' base=' + (ocrConfig.officialBase || ocrConfig.localUrl || '-'));

 const getLlm = () => ({
  provider: env.AI_BASE_URL ? 'custom' : 'deepseek',
  key: env.AI_API_KEY || env.DEEPSEEK_API_KEY || '',
  baseUrl: env.AI_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash',
 });
 const ocr = createOcr({env, getLlm, getMineru: () => store.ocr()});
 const status = ocr.status();
 log('effective OCR: provider=' + status.provider + ' mode=' + status.mode
  + ' mineruConfigured=' + Boolean(status.mineru?.configured)
  + ' model=' + (status.mineru?.modelVersion || status.model || '-')
  + ' tokenSet=' + Boolean(status.mineru?.tokenSet));
 if (!status.mineru?.configured) {
  log('FAIL  MinerU token is not configured. Fill it in Settings → Document parsing (provider=MinerU official) or set MINERU_API_TOKEN.');
  writeFileSync(join(OUT, 'MINERU_SMOKE_' + new Date().toISOString().slice(0, 10) + '.log'), lines.join('\n') + '\nresult: FAIL\n', {mode: 0o600});
  process.exitCode = 1;
  return;
 }
 let pdf;
 try { pdf = readFileSync(pdfPath); } catch { throw Error('PDF not found: ' + pdfPath); }
 log('document: ' + pdfPath + ' (' + pdf.length + ' bytes)');
 try {
  const result = await ocr.extract(pdf, {mime: 'application/pdf', url: 'https://example.com/' + encodeURIComponent(pdfPath.split('/').pop() || 'test.pdf')});
  log('PASS  provider=' + result.provider + ' method=' + result.method + ' chars=' + result.text.length);
  log('text preview: ' + result.text.slice(0, 300).replace(/\n/g, ' | '));
  if (!/中国国际制冷展|上海新国际博览中心/.test(result.text)) {
   log('WARN  expected fixture text was not found; inspect the preview');
  }
 } catch (error) {
  log('FAIL  ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
 } finally {
  mkdirSync(OUT, {recursive: true});
  const file = join(OUT, 'MINERU_SMOKE_' + new Date().toISOString().slice(0, 10) + '.log');
  writeFileSync(file, lines.join('\n') + '\nresult: ' + (process.exitCode ? 'FAIL' : 'PASS') + '\n', {mode: 0o600});
  log('evidence: ' + file);
 }
}

main().catch(error => {
 console.error('MinerU smoke failed: ' + (error instanceof Error ? error.message : error));
 process.exitCode = 1;
});
