// Durable task execution for the local demo.
//
// One process hosts the task queue, the source scheduler and every job handler:
// research runs, source collection and event discovery/enrichment all go through
// the same single-worker queue so a demo host never hammers a source provider.
// The API layer only creates/cancels tasks; execution lives here.

import {dirname, join} from 'node:path';
import {openTaskQueue} from './task-queue.mjs';
import {createResearchRunner} from './research-runner.mjs';
import {createCollector} from './collector.mjs';
import {createRateLimiter} from './rate-limit.mjs';
import {applyRecipe, openRecipeStore} from './recipes.mjs';
import {openSourceRegistry} from './source-registry.mjs';
import {hash as hashText, openDocumentStore} from './documents.mjs';
import {openEventStore} from './event-store.mjs';
import {createEventJobs} from './event-jobs.mjs';
import {createScheduler} from './scheduler.mjs';
import {buildDiscoveryQueries, createDeepSeekEventSearch, createRegistryScanSearch, loadCompanyProfile} from './event-search.mjs';

const SOURCE_MIN_INTERVAL_MS = 30_000;

function errorOf(error) {
 return error instanceof Error ? error : Error(typeof error === 'string' ? error : 'Task failed');
}

function permanent(message) {
 const error = Error(message);
 error.permanent = true;
 return error;
}

function pageError(error) {
 const failure = Error(error?.message || 'Source collection failed');
 if (error?.permanent) failure.permanent = true;
 failure.code = error?.code;
 if (error?.retryAfterMs) failure.retryAfterMs = error.retryAfterMs;
 return failure;
}

export function createTaskRunner({
 store,
 env = process.env,
 dataDir = env.LOCAL_DATA_DIR || '.local',
 queueFile = env.TASKS_FILE || join(dataDir, 'tasks.json'),
 concurrency = Number(env.TASK_CONCURRENCY || 1) || 1,
 collector: injectedCollector,
 registry: injectedRegistry,
 documents: injectedDocuments,
 recipes: injectedRecipes,
 eventStore: injectedEventStore,
 eventSearch: injectedSearch,
 eventJobs: injectedEventJobs,
 researchRunner: injectedResearch,
 now = () => Date.now(),
}) {
 const registry = injectedRegistry ?? openSourceRegistry({
  file: env.SOURCES_FILE || join(dataDir, 'source-registry.json'),
  seedFile: env.SOURCE_SEED_FILE || 'seed/sources-cn.json',
 });
 const recipes = injectedRecipes ?? openRecipeStore({file: env.RECIPES_FILE || join(dataDir, 'recipes.json')});
 const limiter = createRateLimiter({now, defaultIntervalMs: Number(env.DOMAIN_INTERVAL_MS || 5000) || 5000});
 const collector = injectedCollector ?? createCollector({limiter, now});
 const documents = injectedDocuments ?? openDocumentStore({file: env.DOCUMENTS_FILE || join(dataDir, 'documents.json')});
 const eventStore = injectedEventStore ?? openEventStore({file: env.EVENTS_FILE || join(dataDir, 'events.json')});
 const researchRunner = injectedResearch ?? createResearchRunner({store, env});
 const company = loadCompanyProfile(env.COMPANY_SEED_FILE || 'seed/company-domel.json');

 function approvedRecipe(domain) {
  try {
   return recipes.list({domain, status: 'approved'})[0] ?? null;
  } catch {
   return null;
  }
 }

 // Search is injected into the event jobs: the model adapter is preferred, and
 // without a model we scan the human-curated registry pages. The registry scan
 // is memoised because discovery asks once per generated query but the scan
 // itself is the same few pages; tests can still replace the adapter.
 const registryScan = env.DEEPSEEK_API_KEY ? null : createRegistryScanSearch({registry, collector, company});
 let registryScanOnce = null;
 // Event jobs expect a plain function; adapters expose {search}. The registry
 // scan is memoised because discovery asks once per generated query but the
 // scan itself is the same few pages.
 const searchAdapter = injectedSearch ?? (env.DEEPSEEK_API_KEY
  ? createDeepSeekEventSearch({
   apiKey: env.DEEPSEEK_API_KEY,
   model: env.DEEPSEEK_MODEL || 'deepseek-flash',
   baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  })
  : {
   search(args) {
    if (!registryScanOnce) registryScanOnce = registryScan.search({region: args?.region, limit: args?.limit});
    return registryScanOnce;
   },
  });
 const search = typeof searchAdapter === 'function' ? searchAdapter : args => searchAdapter.search(args);

 const eventJobs = injectedEventJobs ?? createEventJobs({
  eventStore,
  registry,
  collector,
  getRecipe: approvedRecipe,
  search,
  now,
  company,
  queries: (payload = {}) => buildDiscoveryQueries(company, {region: payload.region ?? 'cn', years: payload.years, limit: payload.queryLimit}),
 });

 async function runQueuedResearch(ctx) {
  const jobId = String(ctx.task.payload?.jobId ?? '');
  if (!jobId) throw permanent('Research task is missing its job id');
  if (ctx.signal.aborted) throw Error('Cancelled by user');
  let job;
  try {
   job = await store.startJob(jobId);
  } catch (error) {
   throw permanent(errorOf(error).message);
  }
  ctx.update({progress: 'Research ' + job.mode});
  try {
   const outcome = await researchRunner(job);
   if (ctx.signal.aborted) {
    await store.failJob(jobId, 'Cancelled by user', {force: true}).catch(() => {});
    throw Error('Cancelled by user');
   }
   ctx.update({progress: 'Research finished', result: {status: outcome?.status ?? 'completed'}});
   return outcome;
  } catch (error) {
   const failure = errorOf(error);
   await store.failJob(jobId, failure.message).catch(() => {});
   throw failure;
  }
 }

 async function collectSource(ctx) {
  const sourceId = String(ctx.task.sourceId ?? ctx.task.payload?.sourceId ?? '');
  const source = registry.get(sourceId);
  if (!source) throw permanent('Source not found: ' + sourceId);
  if (ctx.signal.aborted) throw Error('Cancelled by user');
  registry.markRunning(sourceId);
  ctx.update({progress: 'Fetching ' + source.url});
  try {
   const page = await collector.collect(source.url, {signal: ctx.signal, recipe: approvedRecipe(source.domain)});
   if (!page.ok) throw pageError(page.error);
   const hash = hashText(page.text ?? '');
   const saved = await documents.save({
    sourceId,
    url: page.finalUrl || source.url,
    title: page.title || source.title,
    text: page.text ?? '',
    htmlBytes: page.bytes ?? 0,
    engine: page.engine,
    fetchedAt: page.fetchedAt || new Date().toISOString(),
    hash,
   });
   registry.markResult(sourceId, {ok: true, nowMs: now(), crawlDelayMs: page.robots?.crawlDelayMs ?? 0});
   ctx.update({progress: 'Collected', result: {title: page.title, bytes: page.bytes, engine: page.engine, documentId: saved.id}});
   return {sourceId, url: source.url, title: page.title, bytes: page.bytes, engine: page.engine};
  } catch (error) {
   const failure = errorOf(error);
   const aborted = ctx.signal.aborted;
   registry.markResult(sourceId, {
    ok: false,
    error: aborted ? 'Cancelled by user' : failure.message,
    nowMs: now(),
    blocked: failure.code === 'BLOCKED',
   });
   if (aborted) throw Error('Cancelled by user');
   throw failure;
  }
 }

 const handlers = {
  'project.research': runQueuedResearch,
  'project.extract': runQueuedResearch,
  'source.collect': collectSource,
  ...eventJobs,
 };

 const queue = openTaskQueue({
  file: queueFile,
  concurrency,
  handlers,
  now,
 });

 const scheduler = createScheduler({
  registry,
  queue,
  now,
  intervalMs: Number(env.SOURCE_SCHEDULER_MS || 30_000) || 30_000,
 });

 let started = false;
 return {
  queue,
  scheduler,
  registry,
  collector,
  recipes,
  documents,
  eventStore,
  researchRunner,
  handlers,
  applyRecipe,
  start() {
   if (started) return;
   started = true;
   queue.start();
   scheduler.start();
  },
  async stop() {
   started = false;
   scheduler.stop();
   queue.stop();
   // Release the shared headless browser so a restart does not leave Chrome
   // behind; collection in flight is aborted by queue.stop().
   try { await collector.close?.(); } catch { /* the browser is best effort */ }
  },
  stats() {
   return {tasks: queue.stats(), sources: registry.stats(), events: eventStore.stats(), documents: documents.stats()};
  },
  dataDir: dirname(queueFile),
  sourceMinIntervalMs: SOURCE_MIN_INTERVAL_MS,
 };
}
