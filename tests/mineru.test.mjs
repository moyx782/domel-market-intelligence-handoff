// MinerU Standard API integration: token from Settings (frontend) is reused,
// files are uploaded, the batch result zip is downloaded and Markdown extracted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {openAgentStore} from '../server/agent-config.mjs';
import {createOcr} from '../server/ocr.mjs';
import {localApiServer} from '../server/local-api.mjs';
import {openLocalStore} from '../server/local-store.mjs';

function makeZip() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-mineru-zip-'));
 const md = join(dir, 'full.md');
 writeFileSync(md, '# 展商名单\n\n中国国际制冷展 2026\n上海新国际博览中心\nAWE Hotelex CRH\n');
 const zip = join(dir, 'result.zip');
 execFileSync('zip', ['-j', '-q', zip, md]);
 const buffer = readFileSync(zip);
 rmSync(dir, {recursive: true, force: true});
 return buffer;
}

async function fakeMineru() {
 const zip = makeZip();
 const state = {batch: null, uploaded: false, auth: null, body: null};
 const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const json = (data, status = 200) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
  if (req.method === 'POST' && req.url === '/api/v4/file-urls/batch') {
   state.auth = req.headers.authorization;
   state.body = JSON.parse(body.toString('utf8'));
   return json({code: 0, data: {batch_id: 'batch-1', file_urls: ['http://127.0.0.1:' + server.address().port + '/upload']}});
  }
  if (req.method === 'PUT' && req.url === '/upload') {
   state.uploaded = body.length > 0;
   return json({ok: true});
  }
  if (req.method === 'GET' && req.url === '/api/v4/extract-results/batch/batch-1') {
   return json({code: 0, data: {batch_id: 'batch-1', extract_result: [{file_name: state.body.files[0].name, state: 'done', full_zip_url: 'http://127.0.0.1:' + server.address().port + '/result.zip'}]}});
  }
  if (req.method === 'GET' && req.url === '/result.zip') {
   res.writeHead(200, {'Content-Type': 'application/zip'});
   return res.end(zip);
  }
  json({code: -1, msg: 'not found'}, 404);
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return {server, state, url: 'http://127.0.0.1:' + server.address().port + '/api/v4'};
}

test('MinerU Standard API uses the frontend-saved token and extracts Markdown', async () => {
 const fake = await fakeMineru();
 const root = mkdtempSync(join(tmpdir(), 'domel-mineru-agent-'));
 try {
  const agentStore = openAgentStore(root);
  agentStore.setSettings({ocr: {provider: 'official', officialBase: fake.url, token: 'ui-token'}});
  const ocr = createOcr({
   env: {MINERU_PROVIDER: 'official', MINERU_API_TOKEN: 'env-token'},
   getLlm: () => ({provider: 'deepseek', key: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'}),
   getMineru: () => agentStore.ocr(),
  });
  const status = ocr.status();
  assert.equal(status.mineru.configured, true);
  assert.equal(status.mineru.tokenSet, true);
  assert.ok(!JSON.stringify(status).includes('ui-token'));
  const result = await ocr.extract(Buffer.from('%PDF-1.4\nfake scanned pdf\n%%EOF'), {mime: 'application/pdf', url: 'https://expo.example/list.pdf'});
  assert.equal(result.provider, 'mineru-vlm');
  assert.match(result.text, /中国国际制冷展/);
  assert.equal(fake.state.auth, 'Bearer ui-token', 'frontend token must take priority over env token');
  assert.equal(fake.state.body.model_version, 'vlm');
  assert.equal(fake.state.uploaded, true);
 } finally {
  await new Promise(resolve => fake.server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});


test('the OCR status API reports the frontend-saved MinerU token without exposing it', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-mineru-status-'));
 const agentStore = openAgentStore(root);
 agentStore.setSettings({ocr: {provider: 'official', officialBase: 'https://mineru.corp.example/api/v4', token: 'ui-secret-token'}});
 const store = openLocalStore(join(root, 'data.json'));
 const ocr = createOcr({env: {}, getMineru: () => agentStore.ocr()});
 const server = localApiServer({store, agentStore, env: {}, ocr});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  const status = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/ocr/status')).json();
  assert.equal(status.provider, 'mineru');
  assert.equal(status.configured, true);
  assert.equal(status.mineru.configured, true);
  assert.equal(status.mineru.modelVersion, 'vlm');
  assert.equal(status.mineru.tokenSet, true);
  assert.ok(!JSON.stringify(status).includes('ui-secret-token'));
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});
