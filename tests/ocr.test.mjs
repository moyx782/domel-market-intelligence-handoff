// OCR core: vision provider request shape, PDF text-layer shortcut, status
// masking, and parsed-text persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOcr, saveParsedText} from '../server/ocr.mjs';

test('vision OCR sends an image_url request and returns clean text', async () => {
 let captured;
 const fetchImpl = async (url, init) => {
  captured = {url, body: JSON.parse(init.body), headers: init.headers};
  return new Response(JSON.stringify({choices: [{message: {content: '```text\n中国国际制冷展 2026\n上海新国际博览中心\n```'}}]}), {status: 200});
 };
 const ocr = createOcr({
  env: {},
  getLlm: () => ({provider: 'deepseek', key: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'}),
  fetchImpl,
 });
 const text = await ocr.recognizeImage(Buffer.from('fake-image'), {mime: 'image/png'});
 assert.equal(text, '中国国际制冷展 2026\n上海新国际博览中心');
 assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
 assert.equal(captured.headers.Authorization, 'Bearer sk-test');
 assert.equal(captured.body.model, 'deepseek-flash');
 assert.equal(captured.body.messages[0].content[1].type, 'image_url');
 assert.match(captured.body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('OCR status reports configuration without returning the key', () => {
 const on = createOcr({env: {DEEPSEEK_API_KEY: 'sk-secret', DEEPSEEK_MODEL: 'deepseek-flash'}});
 const status = on.status();
 assert.equal(status.configured, true);
 assert.equal(status.provider, 'vision');
 assert.equal(status.model, 'deepseek-flash');
 assert.ok(!JSON.stringify(status).includes('sk-secret'));
 const off = createOcr({env: {}}).status();
 assert.equal(off.configured, false);
 assert.equal(off.tools.pdftotext, true);
 assert.equal(off.tools.pdftoppm, true);
});

test('parsed OCR text is written under the material root', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-ocr-save-'));
 try {
  const saved = saveParsedText({root, eventId: 'event-1', url: 'https://example.com/list.pdf', text: '中国国际制冷展 2026\n上海新国际博览中心', meta: {provider: 'vision-ocr', pages: 2}});
  assert.match(saved.textPath, /event-1/);
  const text = readFileSync(saved.textPath, 'utf8');
  assert.match(text, /source_url: "https:\/\/example.com\/list.pdf"/);
  assert.match(text, /provider: "vision-ocr"/);
  assert.match(text, /中国国际制冷展/);
  assert.ok(saved.chars > 10);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('unsupported document types fail closed', async () => {
 const ocr = createOcr({env: {}, getLlm: () => ({provider: 'deepseek', key: 'k', baseUrl: 'https://api.deepseek.com', model: 'm'}), fetchImpl: async () => new Response('{}')});
 await assert.rejects(ocr.extract(Buffer.from('x'), {mime: 'text/html', url: 'https://example.com/'}), /Unsupported document type/);
});
