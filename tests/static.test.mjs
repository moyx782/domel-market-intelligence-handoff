import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from '../server/local-store.mjs';
import {localApiServer} from '../server/local-api.mjs';

test('the API process serves the built frontend and falls back to index.html', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-static-'));
 const dist = join(root, 'dist');
 mkdirSync(join(dist, 'assets'), {recursive: true});
 writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
 writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")');
 const server = localApiServer({
  store: openLocalStore(join(root, 'data.json')),
  env: {SERVE_STATIC: '1', STATIC_DIR: dist},
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const base = 'http://127.0.0.1:' + server.address().port;
 try {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /id="root"/);

  const asset = await fetch(base + '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);

  const spa = await fetch(base + '/projects/anything');
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /id="root"/);

  const api = await fetch(base + '/api/v1/not-a-route');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /json/);

  const escape = await fetch(base + '/%2e%2e/package.json');
  const escapedBody = await escape.text();
  assert.ok(!escapedBody.includes('"name": "domel-market-intelligence"'));
 } finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, {recursive: true, force: true});
 }
});
