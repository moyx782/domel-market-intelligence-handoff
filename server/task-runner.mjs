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
import {createWebSearch} from './web-search.mjs';
import {openGeoIndex} from './geo.mjs';
import {runAgentResearch} from './agent-research.mjs';
import {createOcr} from './ocr.mjs';
import {openMaterialStore} from './materials.mjs';
import {runAgentReport} from './agent-report.mjs';
import {runAgentFetch} from './agent-fetch.mjs';
import {selectDocumentsForOcr} from './document-autoparse.mjs';

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
 eventWebSearch: injectedWebSearch,
 geo: injectedGeo,
 eventJobs: injectedEventJobs,
 researchRunner: injectedResearch,
 getLlm,
 getAgentRuntime,
 injectedOcr,
 injectedMaterialStore,
 now = () => Date.now(),
}) {
 const registry = injectedRegistry ?? openSourceRegistry({
  file: env.SOURCES_FILE || join(dataDir, 'source-registry.json'),
  seedFile: env.SOURCE_SEED_FILE || 'seed/sources-cn.json',
 });
 const recipes = injectedRecipes ?? openRecipeStore({file: env.RECIPES_FILE || join(dataDir, 'recipes.json')});
 const limiter = createRateLimiter({now, defaultIntervalMs: Number(env.DOMAIN_INTERVAL_MS || 5000) || 5000});
 const ocr = injectedOcr ?? createOcr({env, getLlm});
 const materials = injectedMaterialStore ?? openMaterialStore({root: env.MATERIALS_ROOT || join(dataDir, 'documents')});
 const collector = injectedCollector ?? createCollector({limiter, now, ocr});
 const documents = injectedDocuments ?? openDocumentStore({file: env.DOCUMENTS_FILE || join(dataDir, 'documents.json')});
 const eventStore = injectedEventStore ?? openEventStore({file: env.EVENTS_FILE || join(dataDir, 'events.json')});
 const researchRunner = injectedResearch ?? createResearchRunner({store, env});
 const company = loadCompanyProfile(env.COMPANY_SEED_FILE || 'seed/company-domel.json');
 const llmState = () => {
  if (typeof getLlm === 'function') return getLlm();
  const baseUrl = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let official = true;
  try { official = new URL(baseUrl).hostname === 'api.deepseek.com' || new URL(baseUrl).hostname.endsWith('.deepseek.com'); } catch {}
  return {
   key: env.DEEPSEEK_API_KEY || '',
   model: env.DEEPSEEK_MODEL || 'deepseek-flash',
   baseUrl,
   provider: official ? 'deepseek' : 'custom',
  };
 };
 // Stored geography (country/province/city/district) for event inference.
 const geo = injectedGeo ?? openGeoIndex({file: env.GEO_FILE || 'seed/geo-cn.json'});

 function approvedRecipe(domain) {
  try {
   return recipes.list({domain, status: 'approved'})[0] ?? null;
  } catch {
   return null;
  }
 }

 // Search is injected into the event jobs: the model adapter is preferred, and
 // without a model (or with a self-hosted model that has no DeepSeek search
 // tool) we scan the human-curated registry pages. The registry scan is
 // memoised because discovery asks once per generated query but the scan itself
 // is the same few pages. Keys/models are resolved per call so a key entered in
 // Settings takes effect without restarting the process.
 const registryScan = createRegistryScanSearch({registry, collector, company, geo});
 let registryScanOnce = null;
 const deepseekSearch = createDeepSeekEventSearch({
  getApiKey: () => {
   const llm = llmState();
   return llm.provider === 'deepseek' ? llm.key : '';
  },
  getModel: () => llmState().model,
  baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
 });
 const externalSearch = typeof injectedSearch === 'function'
  ? injectedSearch
  : (injectedSearch && typeof injectedSearch.search === 'function' ? args => injectedSearch.search(args) : null);
 const search = externalSearch ?? (async args => {
  const llm = llmState();
  if (llm.provider === 'deepseek' && llm.key) return deepseekSearch.search(args);
  if (!registryScanOnce) registryScanOnce = registryScan.search({region: args?.region, limit: args?.limit});
  return registryScanOnce;
 });

 // Enrichment uses a web search only to find candidate official pages; the
 // fetched page still has to match the event name AND look like an event site
 // before it is accepted. Search provider: DeepSeek's search tool, a locally
 // deployed SearXNG, or an internal JSON gateway (see docs/SEARCH_ENGINES.md).
 const configuredWebSearch = createWebSearch({env, getLlm});
 const externalWebSearch = typeof injectedWebSearch === 'function'
  ? injectedWebSearch
  : (injectedWebSearch && typeof injectedWebSearch.search === 'function' ? args => injectedWebSearch.search(args) : null);
 const webSearch = externalWebSearch ?? (configuredWebSearch
  ? args => configuredWebSearch.search(args)
  : async () => []);

 const eventJobs = injectedEventJobs ?? createEventJobs({
  eventStore,
  registry,
  collector,
  getRecipe: approvedRecipe,
  search,
  webSearch,
  geo,
  now,
  company,
  queries: (payload = {}) => buildDiscoveryQueries(company, {region: payload.region ?? 'cn', years: payload.years, limit: payload.queryLimit}),
  materialStore: materials,
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

 // Agent-driven research: the Pi agent uses the shipped skills + the local API
 // to collect pages, then writes research-result.json for validation/import.
 async function runAgentResearchTask(ctx) {
  const jobId = String(ctx.task.payload?.jobId ?? '');
  const projectId = String(ctx.task.projectId ?? ctx.task.payload?.projectId ?? '');
  if (!jobId || !projectId) throw permanent('Agent research task is missing its job or project id');
  const project = await store.project(projectId);
  if (!project) throw permanent('Project not accessible');
  if (typeof getAgentRuntime !== 'function') throw permanent('Agent research requires the agent runtime');
  const agentRuntime = await getAgentRuntime();
  if (typeof agentRuntime !== 'function') throw permanent('Agent model is not configured');
  let job;
  try {
   job = await store.startJob(jobId);
  } catch (error) {
   throw permanent(error instanceof Error ? error.message : 'Research job not found');
  }
  const workspaceRoot = env.AGENT_WORKSPACE_ROOT || '.local/workspaces';
  const workspace = join(workspaceRoot, projectId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const apiBase = env.LOCAL_API_URL || 'http://127.0.0.1:' + (env.LOCAL_API_PORT || 8788);
  ctx.update({progress: 'Agent is researching with skills'});
  try {
   const result = await runAgentResearch({
    agentRuntime,
    project,
    apiBase,
    workspace,
    signal: ctx.signal,
    env,
    onEvent: event => {
     if (event?.type === 'tool_start') void ctx.update({progress: 'Agent: ' + event.tool});
    },
   });
   if (ctx.signal.aborted) {
    await store.failJob(jobId, 'Cancelled by user', {force: true}).catch(() => {});
    throw Error('Cancelled by user');
   }
   await store.completeJob(jobId, {
    status: 'partial',
    stage: result.findings > 0 ? 'Agent research ready for review' : 'Agent research finished without findings',
    errors: result.errors,
    sources: result.sources,
    findings: result.findings,
   }, result.savedSources);
   ctx.update({progress: 'Agent research finished', result: {sources: result.sources, findings: result.findings, dropped: result.dropped}});
   return result;
  } catch (error) {
   await store.failJob(jobId, error instanceof Error ? error.message : 'Agent research failed').catch(() => {});
   throw error;
  }
 }

 function mimeOfDownload(headers, url) {
  const raw = String(headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (raw) return raw;
  const path = String(url || '').toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(path)) return 'application/pdf';
  if (/\.(png|jpe?g|webp|tiff?)(?:$|[?#])/.test(path)) return 'image/' + (path.includes('png') ? 'png' : 'jpeg');
  return 'application/octet-stream';
 }

 // Parse a downloadable event document with OCR and save it as a material.
 async function parseDocumentTask(ctx) {
  const eventId = String(ctx.task.eventId ?? ctx.task.payload?.eventId ?? '');
  const url = String(ctx.task.payload?.url ?? '');
  if (!eventId || !url) throw permanent('Document parse task is missing eventId/url');
  const event = eventStore.get(eventId);
  if (!event) throw permanent('Event not found');
  const document = (event.documents ?? []).find(item => item.url === url);
  if (!document) throw permanent('Document not found on this event');
  if (document.status !== 'downloadable') throw permanent('Document is not downloadable');
  if (!ocr?.configured) throw permanent('OCR is not configured');
  ctx.update({progress: '下载文档：' + url});
  let response;
  try {
   response = await fetch(url, {headers: {'user-agent': 'DomelMarketIntelligence/0.1 (+intranet demo)'}, signal: ctx.signal, redirect: 'follow'});
  } catch (error) {
   if (ctx.signal?.aborted) throw Error('Cancelled by user');
   throw Error('Document download failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!response.ok) throw permanent('Document download failed (HTTP ' + response.status + ')');
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = Number(env.OCR_DOWNLOAD_MAX_BYTES || 15 * 1024 * 1024);
  if (buffer.length > maxBytes) throw permanent('Document is too large for OCR (' + buffer.length + ' bytes)');
  ctx.update({progress: 'OCR 解析中：' + (document.title || url)});
  const extracted = await ocr.extract(buffer, {mime: mimeOfDownload(response.headers, url), url});
  if (!extracted.text || extracted.text.length < 20) throw Error('OCR found no usable text');
  const saved = materials.save({
   eventId,
   url,
   title: document.title || url,
   kind: 'document',
   provider: extracted.provider,
   engine: extracted.method,
   pages: extracted.pages,
   text: extracted.text,
   summary: 'OCR 解析的文档文本（待人工核验）',
  });
  const existingMaterials = Array.isArray(event.materials) ? event.materials : [];
  const nextMaterials = [...existingMaterials.filter(material => !(material.url === url && material.kind === 'document')), saved.material];
  const nextDocuments = (event.documents ?? []).map(item => item.url === url
   ? {...item, parseProvider: extracted.provider, parsedAt: new Date().toISOString(), pages: extracted.pages ?? null, chars: extracted.text.length, textPath: saved.path}
   : item);
  const note = 'OCR 材料已生成：' + (document.title || url) + '（' + extracted.provider + '，' + extracted.text.length + ' 字符）';
  eventStore.patch(eventId, {
   materials: nextMaterials,
   documents: nextDocuments,
   notes: [...(event.notes ?? []).filter(item => !String(item).startsWith('OCR 材料已生成：' + (document.title || url))), note],
  });
  let agentTaskId = '';
  try {
   const task = await queue.create({kind: 'event.agent-report', eventId, priority: 2, payload: {eventId, trigger: 'document.parse'}});
   agentTaskId = task?.id ?? '';
  } catch { /* an active report task already exists; not a parse failure */ }
  return {eventId, url, chars: extracted.text.length, pages: extracted.pages ?? null, provider: extracted.provider, materialId: saved.material.id, agentTaskId};
 }

 // Let the agent turn OCR/parsed materials into a reviewable Markdown report.
 async function runAgentReportTask(ctx) {
  const eventId = String(ctx.task.eventId ?? ctx.task.payload?.eventId ?? '');
  if (!eventId) throw permanent('Agent report task is missing eventId');
  const event = eventStore.get(eventId);
  if (!event) throw permanent('Event not found');
  const list = (event.materials ?? []).filter(material => material.textPath);
  if (!list.length) throw permanent('No OCR materials to organise');
  if (typeof getAgentRuntime !== 'function') throw permanent('Agent report requires the agent runtime');
  const agentRuntime = await getAgentRuntime();
  if (typeof agentRuntime !== 'function') throw permanent('Agent model is not configured');
  const workspaceKey = ('agent-report-' + eventId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const workspace = join(env.AGENT_WORKSPACE_ROOT || '.local/workspaces', workspaceKey);
  const reportMaterials = list.map(material => {
   let excerpt = '';
   try { excerpt = materials.read(material.textPath); } catch { excerpt = ''; }
   return {...material, excerpt};
  });
  ctx.update({progress: 'Agent 整理 OCR 材料（' + reportMaterials.length + ' 份）'});
  const result = await runAgentReport({
   agentRuntime,
   event,
   materials: reportMaterials,
   workspace,
   projectId: workspaceKey,
   readText: textPath => materials.read(textPath),
   signal: ctx.signal,
   onEvent: event => { if (event?.type === 'tool_start') void ctx.update({progress: 'Agent: ' + event.tool}); },
  });
  materials.saveReport(eventId, result.reportMarkdown);
  const summaries = new Map(result.materials.map(item => [item.url, item.summary]));
  const nextMaterials = (event.materials ?? []).map(material => summaries.has(material.url) ? {...material, agentSummary: summaries.get(material.url)} : material);
  const note = 'Agent 已整理 OCR 材料：' + reportMaterials.length + ' 份';
  eventStore.patch(eventId, {
   materials: nextMaterials,
   materialsReport: result.reportMarkdown,
   notes: [...(event.notes ?? []).filter(item => !String(item).startsWith('Agent 已整理 OCR 材料：')), note],
  });
  ctx.update({progress: '材料报告已生成'});
  return {eventId, materials: reportMaterials.length, reportChars: result.reportMarkdown.length, reportPath: materials.reportPath(eventId), warnings: result.warnings};
 }

 async function runAgentFetchTask(ctx) {
  const url = String(ctx.task.payload?.url ?? '');
  const eventId = String(ctx.task.eventId ?? ctx.task.payload?.eventId ?? '');
  if (!/^https?:\/\//i.test(url)) throw permanent('Agent fetch task has no public URL');
  if (typeof getAgentRuntime !== 'function') throw permanent('Agent fetch requires the agent runtime');
  const agentRuntime = await getAgentRuntime();
  if (typeof agentRuntime !== 'function') throw permanent('Agent model is not configured');
  const event = eventId ? eventStore.get(eventId) : null;
  const workspaceKey = ('agent-fetch-' + String(ctx.task.id || eventId || Date.now())).replace(/[^a-zA-Z0-9_-]/g, '_');
  const workspace = join(env.AGENT_WORKSPACE_ROOT || '.local/workspaces', workspaceKey);
  const helperPath = join(env.REPO_ROOT || process.cwd(), 'scripts', 'adaptive-fetch.mjs');
  ctx.update({progress: 'Agent 自适应抓取：' + url});
  const result = await runAgentFetch({
   agentRuntime,
   url,
   eventName: event?.name ?? '',
   workspace,
   projectId: workspaceKey,
   helperPath,
   signal: ctx.signal,
   onEvent: event => { if (event?.type === 'tool_start') void ctx.update({progress: 'Agent: ' + event.tool}); },
  });
  const saved = materials.save({
   eventId: eventId || 'agent-fetch',
   url,
   title: result.title || url,
   kind: 'webpage',
   provider: 'agent-adaptive',
   engine: result.engine,
   text: result.text,
   summary: 'Agent 自适应抓取（未人工核验）',
  });
  if (event) {
   const existing = Array.isArray(event.materials) ? event.materials : [];
   const next = [...existing.filter(material => !(material.url === url && material.kind === 'webpage')), saved.material];
   const source = {url, title: result.title || url, verifiedAt: new Date().toISOString()};
   const sources = [...(event.sources ?? []).filter(item => item.url !== url), source];
   const note = 'Agent 自适应抓取完成：' + url + '（' + result.engine + '，' + result.text.length + ' 字符）';
   eventStore.patch(eventId, {materials: next, sources, notes: [...(event.notes ?? []).filter(item => !String(item).startsWith('Agent 自适应抓取完成：' + url)), note]});
   // A fetched material can immediately go through the same report step.
   try { await queue.create({kind: 'event.agent-report', eventId, priority: 2, payload: {eventId, trigger: 'agent.fetch'}}); } catch { /* report already active */ }
  }
  return {url, eventId, chars: result.text.length, engine: result.engine, materialId: saved.material.id, strategies: result.strategies};
 }

 // "Provided PDF → direct OCR": after enrichment records downloadable documents,
// queue document.parse for the first few OCR-able ones automatically. This is
// still bounded (AUTO_OCR_MAX_DOCS) and can be disabled.
 async function autoQueueDocumentOcr(eventId, ctx) {
  if (env.AUTO_OCR_DOCUMENTS === '0') return [];
  if (!ocr?.configured) return [];
  const event = eventStore.get(eventId);
  if (!event) return [];
  const documents = selectDocumentsForOcr(event, {max: Number(env.AUTO_OCR_MAX_DOCS) || 3});
  const queued = [];
  for (const document of documents) {
   try {
    const task = await queue.create({
     kind: 'document.parse',
     eventId,
     priority: 3,
     payload: {eventId, url: document.url, title: document.title, auto: true},
    });
    queued.push(task.id);
   } catch { /* an active parse for this document already exists */ }
  }
  if (queued.length && typeof ctx.log === 'function') {
   await ctx.log('info', '自动 OCR：已排队 ' + queued.length + ' 份可下载文档');
  }
  return queued;
 }

 const eventEnrichHandler = eventJobs['event.enrich'];
 async function runEnrichWithAgentFallback(ctx) {
  const result = await eventEnrichHandler(ctx);
  try {
   const eventId = String(result?.eventId ?? ctx.task.eventId ?? '');
   if (eventId) {
    try {
     const autoOcrTaskIds = await autoQueueDocumentOcr(eventId, ctx);
     if (autoOcrTaskIds.length) result.autoOcrTaskIds = autoOcrTaskIds;
    } catch { /* auto OCR is best-effort and must not fail enrichment */ }
   }
   if ((result?.collected ?? 0) === 0 && eventId && env.AGENT_FETCH_FALLBACK !== '0' && typeof getAgentRuntime === 'function') {
    const event = eventStore.get(eventId);
    const url = event?.website || event?.sources?.[0]?.url;
    if (url && /^https?:\/\//i.test(url)) {
     const runtime = await getAgentRuntime();
     if (typeof runtime === 'function') {
      const task = await queue.create({kind: 'agent.fetch', eventId, priority: 2, payload: {eventId, url, reason: 'enrich-incomplete'}});
      result.agentFetchTaskId = task.id;
      if (typeof ctx.log === 'function') await ctx.log('info', '普通采集不完整，已转 Agent 自适应抓取：' + url);
     }
    }
   }
  } catch { /* the automatic fallback is best effort */ }
  return result;
 }

 const handlers = {
  'project.research': runQueuedResearch,
  'project.extract': runQueuedResearch,
  'project.agent-research': runAgentResearchTask,
  'source.collect': collectSource,
  'document.parse': parseDocumentTask,
  'event.agent-report': runAgentReportTask,
  'agent.fetch': runAgentFetchTask,
  ...eventJobs,
  'event.enrich': runEnrichWithAgentFallback,
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
  ocr,
  materials,
  recipes,
  documents,
  eventStore,
  researchRunner,
  handlers,
  applyRecipe,
  geo,
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
