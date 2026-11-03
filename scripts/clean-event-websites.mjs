#!/usr/bin/env node
// One-off/upgrade utility: clear "official websites" that are actually forum
// threads, news articles or directory pages (for example eechina / eeworld
// threads stored by an earlier build), and recover a better URL from the
// event's stored sources when one looks like an event site.
//
// Run while the demo process is stopped (single-process JSON store):
//
//   node scripts/clean-event-websites.mjs
//   EVENTS_FILE=.local/events.json node scripts/clean-event-websites.mjs

import {openEventStore} from '../server/event-store.mjs';
import {isLikelyOfficialUrl} from '../server/event-search.mjs';

const eventsFile = process.env.EVENTS_FILE || '.local/events.json';
const store = openEventStore({file: eventsFile});

function preference(url) {
 try {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  return (segments.length === 0 ? 100 : segments.length === 1 ? 50 : 0) - segments.length;
 } catch {
  return -1;
 }
}

const noteFor = url => '原官网链接是论坛/媒体页面，未作为官网：' + url;

const events = store.list({});
let updated = 0;
for (const event of events) {
 const website = String(event.website ?? '').trim();
 if (!website || isLikelyOfficialUrl(website)) continue;

 const candidates = (Array.isArray(event.sources) ? event.sources : [])
  .map(source => (typeof source === 'string' ? source : source?.url))
  .filter(url => typeof url === 'string' && isLikelyOfficialUrl(url))
  .sort((left, right) => preference(right) - preference(left));
 const replacement = candidates[0] ?? '';
 const notes = (Array.isArray(event.notes) ? event.notes : []).filter(note => !String(note).startsWith('原官网链接是论坛/媒体页面'));
 notes.push(noteFor(website));
 if (replacement) notes.push('官网链接已从已存来源恢复：' + replacement);
 store.patch(event.id, {website: replacement, notes});
 updated += 1;
 console.log(`cleaned ${event.id.slice(0, 8)} ${event.name || ''}: ${website} -> ${replacement || '(empty)'}`);
}
console.log(`clean-event-websites: ${updated}/${events.length} events updated from ${eventsFile}`);
