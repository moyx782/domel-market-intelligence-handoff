// In-memory doubles for the local API route tests. They implement only the
// contract surface the API uses; the real stores are covered by their own tests.
import {randomUUID} from 'node:crypto';

export function fakeQueue(seed = []) {
 const tasks = [...seed];
 const listeners = new Set();
 const clone = task => structuredClone(task);
 const stats = () => {
  const counts = {queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0};
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
 };
 const emit = event => { for (const listener of listeners) { try { listener(event); } catch {} } };
 const api = {
  file: '/tmp/fake-tasks.json',
  created: [],
  async create(input) {
   const task = {
    id: randomUUID(),
    state: 'queued',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    priority: input.priority ?? 1,
    effectivePriority: input.priority ?? 1,
    projectId: input.projectId ?? null,
    eventId: input.eventId ?? null,
    sourceId: input.sourceId ?? null,
    payload: input.payload ?? {},
    progress: 'Queued',
    result: null,
    error: null,
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notBefore: 0,
    startedAt: null,
    finishedAt: null,
    ...input,
   };
   tasks.unshift(task);
   api.created.push(task);
   emit({type: 'task', task: clone(task)});
   return clone(task);
  },
  list({state, kind, projectId, eventId, sourceId, limit = 200} = {}) {
   return tasks.filter(task =>
    (!state || task.state === state) &&
    (!kind || task.kind === kind) &&
    (!projectId || task.projectId === projectId) &&
    (!eventId || task.eventId === eventId) &&
    (!sourceId || task.sourceId === sourceId)).slice(0, limit).map(clone);
  },
  get(id) { return tasks.find(task => task.id === id) ?? null; },
  stats,
  async cancel(id) {
   const task = tasks.find(item => item.id === id);
   if (!task) throw Error('Task not found');
   task.state = 'cancelled';
   emit({type: 'task', task: clone(task)});
   return clone(task);
  },
  async retry(id) {
   const task = tasks.find(item => item.id === id);
   if (!task) throw Error('Task not found');
   if (task.state === 'running') throw Error('Task is running');
   task.state = 'queued';
   task.attempts = 0;
   task.error = null;
   emit({type: 'task', task: clone(task)});
   return clone(task);
  },
  subscribe(listener) {
   listeners.add(listener);
   listener({type: 'snapshot', tasks: api.list(), stats: stats()});
   return () => listeners.delete(listener);
  },
 };
 return api;
}

export function fakeEventStore(events = []) {
 const state = events.map(event => ({
  edition: null, startDate: null, endDate: null, city: '', country: 'China', venue: '', organizer: '',
  website: '', frequency: '', industries: [], scope: '', exhibitorCount: null, visitorCount: null,
  area: '', exhibitorListUrl: '', exhibitorListStatus: 'unknown', documents: [], competitors: [],
  applicationDeadline: null, boothPrice: '', ticketPrice: '', region: 'cn', sources: [],
  confidence: 'low', status: 'discovered', notes: [], createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), ...event,
 }));
 return {
  list({from, to, region, status, q, limit = 500} = {}) {
   return state.filter(event => {
    if (region && event.region !== region) return false;
    if (status && event.status !== status) return false;
    if (q && !((event.name ?? '') + ' ' + (event.city ?? '')).toLowerCase().includes(String(q).toLowerCase())) return false;
    if (from && (!event.startDate || event.startDate < from)) return false;
    if (to && (!event.startDate || event.startDate > to)) return false;
    return true;
   }).slice(0, limit).map(event => structuredClone(event));
  },
  get(id) { return state.find(event => event.id === id) ? structuredClone(state.find(event => event.id === id)) : null; },
  patch(id, changes) {
   const event = state.find(item => item.id === id);
   if (!event) throw Error('Event not found');
   Object.assign(event, changes, {updatedAt: new Date().toISOString()});
   return structuredClone(event);
  },
  stats() { return {total: state.length, byStatus: {}}; },
  exportRows() {
   return state.map(event => ({
    name: event.name, edition: event.edition, startDate: event.startDate, endDate: event.endDate,
    city: event.city, country: event.country, venue: event.venue, organizer: event.organizer,
    website: event.website, frequency: event.frequency, industries: event.industries, scope: event.scope,
    exhibitorCount: event.exhibitorCount, visitorCount: event.visitorCount, area: event.area,
    exhibitorListUrl: event.exhibitorListUrl, exhibitorListStatus: event.exhibitorListStatus,
    applicationDeadline: event.applicationDeadline, boothPrice: event.boothPrice, ticketPrice: event.ticketPrice,
    region: event.region, confidence: event.confidence, status: event.status,
    sources: (event.sources ?? []).map(source => source.url),
    notes: event.notes,
   }));
  },
 };
}

export function fakeRegistry(sources = []) {
 const state = sources.map(source => ({
  region: 'cn', enabled: true, priority: 1, intervalSec: 3600, lastRunAt: null, nextRunAt: null,
  status: 'idle', lastError: null, discoveredBy: 'human', domain: new URL(source.url).hostname,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...source,
 }));
 return {
  list({region, enabled, type} = {}) {
   return state.filter(source =>
    (!region || source.region === region) &&
    (enabled === undefined || source.enabled === enabled) &&
    (!type || source.type === type)).map(source => structuredClone(source));
  },
  get(id) {
   const source = state.find(item => item.id === id);
   return source ? structuredClone(source) : null;
  },
  create(input) {
   if (!/^https:\/\//.test(String(input.url ?? ''))) throw Error('Source URL must use https');
   const source = {id: randomUUID(), enabled: true, priority: 1, intervalSec: 3600, type: 'site', region: 'cn', title: '', status: 'idle', ...input};
   source.domain = new URL(source.url).hostname;
   state.push(source);
   return structuredClone(source);
  },
  update(id, patch) {
   const source = state.find(item => item.id === id);
   if (!source) throw Error('Source not found');
   if (patch.intervalSec !== undefined && patch.intervalSec < 30) throw Error('Source interval must be at least 30 seconds');
   Object.assign(source, patch, {updatedAt: new Date().toISOString()});
   return structuredClone(source);
  },
  remove(id) {
   const index = state.findIndex(item => item.id === id);
   if (index < 0) throw Error('Source not found');
   state.splice(index, 1);
  },
  stats() { return {total: state.length, enabled: state.filter(item => item.enabled).length, error: 0, paused: 0}; },
  due() { return []; },
  markRunning() {},
  markResult() {},
 };
}

export function fakeRecipes(recipes = []) {
 const state = recipes.map(recipe => ({version: 1, proposedBy: 'agent', notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...recipe}));
 return {
  list({domain, status} = {}) {
   return state.filter(recipe => (!domain || recipe.domain === domain) && (!status || recipe.status === status)).map(recipe => structuredClone(recipe));
  },
  get(id) { return state.find(recipe => recipe.id === id) ?? null; },
  propose(input) {
   if (!input.domain || !input.kind || !input.body) throw Error('Recipe domain, kind and body are required');
   const recipe = {id: randomUUID(), version: 1, status: 'proposed', proposedBy: input.proposedBy ?? 'agent', notes: input.notes ?? '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...input};
   state.push(recipe);
   return structuredClone(recipe);
  },
  update(id, patch) {
   const recipe = state.find(item => item.id === id);
   if (!recipe) throw Error('Recipe not found');
   if (patch.status !== undefined && !['proposed', 'approved', 'disabled'].includes(patch.status)) throw Error('Invalid recipe status');
   Object.assign(recipe, patch, {updatedAt: new Date().toISOString()});
   return structuredClone(recipe);
  },
  remove(id) {
   const index = state.findIndex(item => item.id === id);
   if (index < 0) throw Error('Recipe not found');
   state.splice(index, 1);
  },
 };
}

export function fakeTasks(parts = {}) {
 return {
  queue: parts.queue ?? fakeQueue(),
  eventStore: parts.eventStore ?? fakeEventStore(),
  registry: parts.registry ?? fakeRegistry(),
  recipes: parts.recipes ?? fakeRecipes(),
  collector: parts.collector ?? {collect: async () => ({ok: true, html: '<html></html>', text: 'page', title: 'Page', engine: 'http', bytes: 4, fetchedAt: new Date().toISOString()})},
  applyRecipe: parts.applyRecipe ?? (async () => ({ok: true, values: {startDate: '2026-04-08'}})),
 };
}
