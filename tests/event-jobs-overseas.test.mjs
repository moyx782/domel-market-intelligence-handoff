// "China (UAE) Trade Expo" style names: the "China" is the organiser/commodity
// origin, the parenthetical is the venue country. Discovery and enrichment must
// file these as overseas events instead of China-region records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventStore} from '../server/event-store.mjs';
import {openGeoIndex} from '../server/geo.mjs';
import {createEventJobs} from '../server/event-jobs.mjs';

const GEO = openGeoIndex({file: join(process.cwd(), 'seed', 'geo-cn.json')});

function setup() {
 const root = mkdtempSync(join(tmpdir(), 'domel-event-overseas-'));
 const eventStore = openEventStore({file: join(root, 'events.json')});
 return {root, eventStore, close: () => rmSync(root, {recursive: true, force: true})};
}

function ctx(task) {
 const updates = [];
 return {
  task,
  signal: new AbortController().signal,
  update: async changes => updates.push(changes),
  log: async () => {},
  updates,
 };
}

test('discovery files a "China (UAE)" candidate under the venue country', async () => {
 const {eventStore, close} = setup();
 const jobs = createEventJobs({
  eventStore,
  geo: GEO,
  search: async () => [{name: '中国（阿联酋）贸易博览会', city: '迪拜', startDate: null}],
  now: () => Date.parse('2026-11-03T12:00:00Z'),
 });
 try {
  await jobs['event.discover'](ctx({kind: 'event.discover', payload: {region: 'cn', limit: 5}}));
  const events = eventStore.list({});
  assert.equal(events.length, 1);
  assert.equal(events[0].name, '中国（阿联酋）贸易博览会');
  assert.equal(events[0].country, '阿联酋');
  assert.equal(events[0].city, '迪拜');
  assert.equal(events[0].region, 'global');
 } finally {
  close();
 }
});

test('enrichment moves an old mis-filed overseas record to the correct market', async () => {
 const {eventStore, close} = setup();
 const {event} = eventStore.upsert({name: '中国（阿联酋）贸易博览会', region: 'cn', country: '中国', city: ''});
 const jobs = createEventJobs({eventStore, geo: GEO, search: null, webSearch: null, now: () => Date.parse('2026-11-03T12:00:00Z')});
 try {
  const result = await jobs['event.enrich'](ctx({kind: 'event.enrich', eventId: event.id, payload: {eventId: event.id}}));
  const updated = eventStore.get(event.id);
  assert.equal(updated.country, '阿联酋');
  assert.equal(updated.region, 'global');
  assert.ok(updated.notes.join('\n').includes('举办地在境外'));
  assert.equal(result.collected, 0);
 } finally {
  close();
 }
});
