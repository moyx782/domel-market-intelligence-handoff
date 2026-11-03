#!/usr/bin/env node
// Fill event country / province / city / district from the stored geography
// table (seed/geo-cn.json) and normalise legacy country spellings (e.g. the old
// "China" heuristic value) to the stored names.
//
// Run it while the demo process is stopped (the JSON stores are single-process):
//
//   node scripts/backfill-event-geo.mjs
//   EVENTS_FILE=.local/events.json GEO_FILE=seed/geo-cn.json node scripts/backfill-event-geo.mjs

import {openEventStore} from '../server/event-store.mjs';
import {openGeoIndex} from '../server/geo.mjs';

const eventsFile = process.env.EVENTS_FILE || '.local/events.json';
const geoFile = process.env.GEO_FILE || 'seed/geo-cn.json';
const STORED_SUFFIXES = ['特别行政区', '自治区', '省', '市'];

const store = openEventStore({file: eventsFile});
const geo = openGeoIndex({file: geoFile});

// Be liberal about legacy spellings ("China", "上海市", "Shanghai") when
// normalising the country value; only stored names are ever written.
function normalizeCountry(value) {
 const text = String(value ?? '').trim();
 if (!text) return '';
 const direct = geo.country(text);
 if (direct) return direct.country;
 let stripped = text;
 for (const suffix of STORED_SUFFIXES) {
  if (stripped.endsWith(suffix) && stripped.length > suffix.length) stripped = stripped.slice(0, -suffix.length);
 }
 return geo.country(stripped)?.country ?? text;
}

const events = store.list({});
let updated = 0;
for (const event of events) {
 const inferred = geo.infer({
  region: event.region,
  country: event.country,
  province: event.province,
  city: event.city,
  district: event.district,
  venue: event.venue,
  name: event.name,
 });
 const changes = {};
 // Once a website exists, old "no website" notes are stale. Keep the note
 // cleanup here so an offline upgrade does not require re-fetching every site.
 const WEBSITE_NOTE_PREFIXES = ['缺少可核验的官网或来源链接', '未找到官网链接', '官网候选（待人工确认）', '官网链接来自搜索候选'];
 if (String(event.website ?? '').trim()) {
  const notes = (Array.isArray(event.notes) ? event.notes : [])
   .filter(note => !WEBSITE_NOTE_PREFIXES.some(prefix => String(note).startsWith(prefix)));
  if (notes.length !== (event.notes ?? []).length) changes.notes = notes;
 }
 const existingCountry = String(event.country ?? '').trim();
 const nextCountry = existingCountry ? normalizeCountry(existingCountry) : inferred.country;
 if (nextCountry && nextCountry !== existingCountry) changes.country = nextCountry;
 for (const field of ['province', 'city', 'district']) {
  const existing = String(event[field] ?? '').trim();
  if (!existing && inferred[field]) changes[field] = inferred[field];
 }
 if (Object.keys(changes).length) {
  store.patch(event.id, changes);
  updated += 1;
  console.log('updated ' + event.id.slice(0, 8) + ' ' + (event.name || '').slice(0, 50) + ' :: ' + JSON.stringify(changes));
 }
}
console.log('geo backfill: ' + updated + '/' + events.length + ' events updated from ' + geoFile);
