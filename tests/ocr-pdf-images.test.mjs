// A text-layer PDF that also contains a large embedded screenshot must not lose
// the image's text: OCR the embedded image and append it to the text layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createOcr} from '../server/ocr.mjs';

const FIXTURE = join('evidence', 'ocr', 'fixtures', 'pdf-text-with-image.pdf');

test('text-layer PDF with a significant embedded image also OCRs the image', async () => {
 let visionCalls = 0;
 const fetchImpl = async (url, init) => {
  if (!String(url).includes('/chat/completions')) throw Error('unexpected fetch ' + url);
  const body = JSON.parse(init.body);
  assert.equal(body.messages[0].content[1].type, 'image_url');
  visionCalls += 1;
  return new Response(JSON.stringify({choices: [{message: {content: '图片中的展商名单：A 公司、B 公司'}}]}), {status: 200});
 };
 const ocr = createOcr({
  env: {},
  getLlm: () => ({provider: 'deepseek', key: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'}),
  fetchImpl,
 });
 const result = await ocr.extract(readFileSync(FIXTURE), {mime: 'application/pdf', url: 'https://example.com/text-with-image.pdf'});
 assert.match(result.provider, /pdftotext\+vision-images/);
 assert.match(result.text, /中国国际制冷展 2026/);
 assert.match(result.text, /PDF 内嵌图片 OCR/);
 assert.match(result.text, /A 公司/);
 assert.ok(visionCalls >= 1);
 assert.ok(result.images >= 1);
});
