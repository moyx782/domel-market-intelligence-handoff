// OCR-derived webpage text becomes an event material with provenance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventStore} from '../server/event-store.mjs';
import {createEventJobs} from '../server/event-jobs.mjs';

function ctx(event) {
 return {
  task: {kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}},
  signal: new AbortController().signal,
  update: async () => {},
  log: async () => {},
 };
}

test('an OCR-fetched webpage is stored as a material and notes ask for review', async () => {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-ocr-'));
 try {
  const eventStore = openEventStore({file: join(root, 'events.json')});
  const {event} = eventStore.upsert({name: 'China Refrigeration 2026', region: 'cn', city: '上海', website: 'https://example.test/image-page'});
  const collector = {
   async collect() {
    return {
     ok: true, url: 'https://example.test/image-page', finalUrl: 'https://example.test/image-page', status: 200,
     engine: 'ocr-browser', title: 'China Refrigeration 2026', text: '中国国际制冷展 2026 上海新国际博览中心 China Refrigeration Expo',
     html: '', contentType: 'text/html', bytes: 100, fetchedAt: new Date().toISOString(),
     robots: {allowed: true, crawlDelayMs: 0}, ocr: {provider: 'vision', method: 'screenshot'},
    };
   },
   async probe() { return {ok: true, status: 200, availability: 'unknown'}; },
  };
  const materials = {
   save(input) {
    assert.equal(input.kind, 'webpage');
    assert.equal(input.engine, 'ocr-browser');
    return {material: {id: 'm-ocr', url: input.url, title: input.title, kind: 'webpage', provider: 'vision', engine: 'ocr-browser', chars: input.text.length, textPath: '/tmp/m.md', summary: '', agentSummary: '', createdAt: new Date().toISOString()}, path: '/tmp/m.md'};
   },
  };
  const jobs = createEventJobs({eventStore, collector, search: null, webSearch: null, materialStore: materials, now: () => Date.parse('2026-11-03T12:00:00Z')});
  const result = await jobs['event.enrich'](ctx(event));
  assert.equal(result.collected, 1);
  const updated = eventStore.get(event.id);
  assert.equal(updated.materials.length, 1);
  assert.equal(updated.materials[0].id, 'm-ocr');
  assert.equal(updated.materials[0].kind, 'webpage');
  assert.ok(updated.notes.some(note => /OCR 材料 1 份/.test(note)));
 } finally {
  rmSync(root, {recursive: true, force: true});
 }
});
