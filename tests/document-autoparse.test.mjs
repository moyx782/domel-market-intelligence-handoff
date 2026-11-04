// "Provided PDF → direct OCR" selection policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {selectDocumentsForOcr} from '../server/document-autoparse.mjs';

const event = {
 documents: [
  {url: 'https://expo.example/list.pdf', title: '名单', status: 'downloadable'},
  {url: 'https://expo.example/parsed.pdf', title: '已解析', status: 'downloadable', parseProvider: 'mineru-vlm'},
  {url: 'https://expo.example/restricted.pdf', title: '受限', status: 'restricted'},
  {url: 'https://expo.example/logo.png', title: '图片', status: 'downloadable'},
  {url: 'https://expo.example/brief.docx', title: 'Word', status: 'downloadable'},
  {url: 'https://expo.example/material.pdf', title: '已有材料', status: 'downloadable'},
 ],
 materials: [{url: 'https://expo.example/material.pdf', kind: 'document'}],
};

test('automatic OCR selects unparsed downloadable PDFs/images and skips the rest', () => {
 const selected = selectDocumentsForOcr(event, {max: 5});
 assert.deepEqual(selected.map(document => document.url), [
  'https://expo.example/list.pdf',
  'https://expo.example/logo.png',
 ]);
});

test('automatic OCR respects the per-event limit and can be disabled by callers', () => {
 assert.equal(selectDocumentsForOcr(event, {max: 1}).length, 1);
 assert.equal(selectDocumentsForOcr(event, {max: 0}).length, 0);
 assert.equal(selectDocumentsForOcr({documents: []}).length, 0);
 assert.equal(selectDocumentsForOcr({}).length, 0);
});
