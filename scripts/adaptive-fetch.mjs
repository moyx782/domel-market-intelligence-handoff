#!/usr/bin/env node
// Adaptive public-page fetch used by the Domel agent when a normal collection
// is incomplete. Strategies: HTTP/readability -> browser render -> scroll ->
// frames text -> screenshot OCR. Never bypasses robots/login/paywalls.
//
//   node scripts/adaptive-fetch.mjs <url> [--out fetch-result.json]
//
// Output JSON: {ok,url,finalUrl,title,text,engine,strategies,chars}

import {chromium} from 'playwright-core';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCollector} from '../server/collector.mjs';
import {createOcr} from '../server/ocr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const MIN_TEXT = 300;
const MIN_OUTPUT_TEXT = 40;

function loadEnv() {
 const env = {...process.env};
 for (const file of ['.env', '.env.host']) {
  const path = join(REPO, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
   const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
   if (match && !env[match[1]]) env[match[1]] = match[2];
  }
 }
 return env;
}

function arg(name, fallback = '') {
 const index = process.argv.indexOf(name);
 return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function browserAttempt(url, ocr) {
 const browser = await chromium.launch({channel: 'chrome', headless: true});
 try {
  const page = await browser.newPage({
   viewport: {width: 1440, height: 1000},
   userAgent: 'DomelMarketIntelligence/0.1 (+intranet demo)',
  });
  const strategies = [];
  let title = '';
  let text = '';
  try {
   await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});
   strategies.push('browser');
  } catch { strategies.push('browser-partial'); }
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
   const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
   for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 12000); y += step) {
    window.scrollTo(0, y);
    await new Promise(resolve => setTimeout(resolve, 120));
   }
   window.scrollTo(0, 0);
  }).catch(() => {});
  title = await page.title().catch(() => '');
  text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const frames = page.frames().slice(1);
  for (const frame of frames) {
   try {
    const frameText = await frame.evaluate(() => document.body?.innerText ?? '');
    if (frameText && frameText.length > 40) { text += '\n' + frameText; strategies.push('iframe'); }
   } catch { /* cross-origin frame */ }
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < MIN_TEXT && ocr.configured) {
   try {
    const image = await page.screenshot({fullPage: true, type: 'png'});
    const recognized = await ocr.recognizeImage(image, {mime: 'image/png'});
    if (recognized && recognized.length > text.length) { text = recognized; strategies.push('ocr-screenshot'); }
   } catch { strategies.push('ocr-failed'); }
  }
  return {title, text, finalUrl: page.url(), strategies};
 } finally {
  await browser.close().catch(() => {});
 }
}

async function main() {
 const url = String(process.argv[2] || '').trim();
 if (!/^https?:\/\//i.test(url)) throw Error('Usage: node scripts/adaptive-fetch.mjs <public-http(s)-url> [--out file]');
 const env = loadEnv();
 const getLlm = () => ({
  provider: env.AI_BASE_URL ? 'custom' : 'deepseek',
  key: env.AI_API_KEY || env.DEEPSEEK_API_KEY || '',
  baseUrl: env.AI_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: env.AI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash',
 });
 const ocr = createOcr({env, getLlm});
 const collector = createCollector({ocr});
 const strategies = [];
 let result;
 try {
  const collected = await collector.collect(url);
  if (collected?.ok) {
   strategies.push(collected.engine || 'http');
   result = {title: collected.title, text: collected.text, finalUrl: collected.finalUrl, strategies};
  } else {
   strategies.push('collector:' + (collected?.error?.code || 'failed'));
   if (['ROBOTS_DENIED'].includes(collected?.error?.code)) {
    throw Error('robots.txt disallows ' + url + '; agent fallback will not bypass it');
   }
  }
 } catch (error) {
  if (/robots\.txt disallows/i.test(String(error?.message))) throw error;
  strategies.push('collector:error');
 }
 if (!result || String(result.text ?? '').length < MIN_TEXT) {
  const browser = await browserAttempt(url, ocr);
  if (!result || (browser.text?.length ?? 0) > String(result.text ?? '').length) {
   result = {title: browser.title || result?.title || '', text: browser.text, finalUrl: browser.finalUrl, strategies: [...strategies, ...browser.strategies]};
  } else {
   result.strategies = [...strategies, ...browser.strategies];
  }
 }
 await collector.close?.();
 const text = String(result?.text ?? '').trim();
 const payload = {
  ok: text.length >= MIN_OUTPUT_TEXT,
  url,
  finalUrl: result?.finalUrl ?? url,
  title: result?.title ?? '',
  text,
  engine: result?.strategies?.includes('ocr-screenshot') ? 'agent-ocr' : 'agent-browser',
  strategies: [...new Set(result?.strategies ?? strategies)],
  chars: text.length,
 };
 const out = arg('--out');
 if (out) writeFileSync(out, JSON.stringify(payload, null, 2), {mode: 0o600});
 console.log(JSON.stringify(payload));
 if (!payload.ok) process.exitCode = 2;
}

main().catch(error => {
 console.error(JSON.stringify({ok: false, error: error instanceof Error ? error.message : String(error)}));
 process.exitCode = 1;
});
