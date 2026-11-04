// OCR materials: file-backed text store, event schema, and agent report storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMaterialStore} from '../server/materials.mjs';
import {openEventStore} from '../server/event-store.mjs';

test('material store saves readable OCR text and reports with provenance', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-materials-'));
 try {
  const store = openMaterialStore({root});
  const saved = store.save({eventId: 'e1', url: 'https://example.com/list.pdf', title: '展商名单', kind: 'document', provider: 'vision-ocr', engine: 'scanned-pdf', pages: 2, text: '第1页 中国国际制冷展\n第2页 上海新国际博览中心'});
  assert.equal(saved.material.kind, 'document');
  assert.equal(saved.material.provider, 'vision-ocr');
  assert.equal(saved.material.pages, 2);
  assert.ok(saved.material.textPath.startsWith(root));
  assert.match(store.read(saved.material.textPath), /source_url: "https:\/\/example.com\/list.pdf"/);
  assert.match(store.read(saved.material.textPath), /中国国际制冷展/);
  const report = store.saveReport('e1', '# 材料报告\n内容');
  assert.ok(report.startsWith(root));
  assert.match(store.readReport('e1'), /材料报告/);
  assert.throws(() => store.read('/etc/passwd'), /outside the material store/);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});

test('events persist a materials list and the agent report safely', () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-materials-event-'));
 try {
  const store = openEventStore({file: join(root, 'events.json')});
  const {event} = store.upsert({name: 'China Refrigeration 2026', region: 'cn'});
  const patched = store.patch(event.id, {
   materials: [
    {id: 'm1', url: 'https://example.com/list.pdf', title: '展商名单', kind: 'document', provider: 'vision-ocr', pages: 2, chars: 100, textPath: '.local/documents/materials/e1/doc-x.md', summary: 'OCR 文本'},
    {id: 'm2', url: 'https://example.com/page', title: '图片网页', kind: 'webpage', provider: 'vision', engine: 'ocr-browser', chars: 80, textPath: '.local/documents/materials/e1/page-y.md'},
   ],
   materialsReport: '# 材料报告\n\n整理结果',
  });
  assert.equal(patched.materials.length, 2);
  assert.equal(patched.materials[0].kind, 'document');
  assert.equal(patched.materials[1].kind, 'webpage');
  assert.equal(patched.materialsReport, '# 材料报告\n\n整理结果');
  assert.throws(() => store.patch(event.id, {materials: [{title: 'no source'}]}), /source URL or a parsed text path/);
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
