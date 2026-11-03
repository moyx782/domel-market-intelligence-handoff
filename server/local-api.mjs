// Single-user demo API: no authentication, no Supabase, one local JSON store.
//
// It exposes the same routes the frontend already uses, runs research inline
// (one job at a time) with the existing DeepSeek adapter, and streams the
// read-only assistant over SSE. Multi-user accounts and RLS remain in the
// separate host API and are intentionally out of scope here.

import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {openLocalStore} from './local-store.mjs';
import {join} from 'node:path';
import {createAssistantRunner, isDeepSeekBaseUrl, localReader, openDeepSeekModel} from './assistant.mjs';
import {openAgentStore} from './agent-config.mjs';
import {createAgentRuntime} from './agent-runtime.mjs';
import {testMcpServer} from './mcp-test.mjs';
import {mineruStatus} from './mineru.mjs';
import {serveStatic} from './static.mjs';
import {can, canSwitchTo, requiredRole} from './permissions.mjs';
import {sourcePolicy} from '../supabase/functions/_shared/source-policy.mjs';
import {extractionConfig} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateScope} from '../supabase/functions/_shared/research-validation.mjs';
import {createResearchRunner, extractionReady} from './research-runner.mjs';
import {openTranscriptStore} from './transcripts.mjs';
import {createTaskRunner} from './task-runner.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:5174', 'http://127.0.0.1:5175', 'http://localhost:5174', 'http://localhost:5175'];

// CSV export keeps a stable column order regardless of which event fields are
// present, so a spreadsheet import does not shift columns between exports.
const EVENT_EXPORT_COLUMNS = [
 'name', 'edition', 'startDate', 'endDate', 'city', 'province', 'district', 'country', 'venue', 'organizer', 'website',
 'frequency', 'industries', 'scope', 'exhibitorCount', 'visitorCount', 'area', 'exhibitorListUrl',
 'exhibitorListStatus', 'applicationDeadline', 'boothPrice', 'ticketPrice', 'region', 'confidence',
 'status', 'sources', 'notes',
];

function csvCell(value) {
 if (value === null || value === undefined) return '';
 const text = Array.isArray(value)
  ? value.map(item => (item && typeof item === 'object' ? (item.url ?? item.name ?? JSON.stringify(item)) : String(item))).join('; ')
  : String(value);
 return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function localApiServer({
 store, assistant, agentStore, agentRuntime, transcripts, researchRunner, tasks,
 env = process.env, environment = 'local', origins = DEFAULT_ORIGINS,
 resolveAssistant, resolveAgent, getLlm, syncLlm,
}) {
 const role = () => agentStore?.config().role ?? 'admin';
 const allowed = action => can(role(), action);
 const runResearch = researchRunner ?? createResearchRunner({store, env});
 const queue = [];
 let running = false;
 const params = req => new URL(req.url, 'http://localhost').searchParams;
 const taskQueue = () => tasks?.queue;

 // Effective AI configuration: Settings overrides .env.host, and a non-DeepSeek
 // base URL means a locally deployed OpenAI-compatible model.
 const llmState = () => {
  if (typeof getLlm === 'function') return getLlm();
  // Settings values override the process environment; the process-level
  // resolver in the main entry uses the same precedence.
  const stored = agentStore?.llm?.() ?? {};
  const key = stored.apiKey || env.DEEPSEEK_API_KEY || '';
  const model = stored.model || env.DEEPSEEK_MODEL || 'deepseek-flash';
  const baseUrl = stored.baseUrl || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  return {key, model, baseUrl, provider: isDeepSeekBaseUrl(baseUrl) ? 'deepseek' : 'custom'};
 };
 const resolveAssistantNow = typeof resolveAssistant === 'function' ? resolveAssistant : async () => assistant;
 const resolveAgentNow = typeof resolveAgent === 'function' ? resolveAgent : async () => agentRuntime;
 const agentConfigPayload = () => {
  const publicConfig = agentStore.publicConfig();
  const llm = llmState();
  return {
   ...publicConfig,
   llm: {
    ...publicConfig.llm,
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    keySet: Boolean(llm.key),
    envKeySet: Boolean(env.DEEPSEEK_API_KEY),
    effectiveConfigured: Boolean(llm.key) || llm.provider === 'custom',
   },
  };
 };

 async function drain() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
   const started = await store.startJob(next.id);
   await runResearch(started);
  } catch (error) {
   await store.failJob(next.id, error instanceof Error ? error.message : 'Research failed').catch(() => {});
  } finally {
   running = false;
   void drain();
  }
 }

 return createServer(async (req, res) => {
  const origin = req.headers.origin;
  // Same-origin requests also carry Origin when the page requests an asset with
  // crossorigin (Vite emits such tags), so compare hosts before applying the
  // cross-origin allowlist. This keeps the allowlist for real cross-origin UI
  // calls without breaking the single-process production build.
  const sameOrigin = (() => {
   if (!origin) return false;
   try { return new URL(origin).host === req.headers.host; } catch { return false; }
  })();
  const originAllowed = !origin || sameOrigin || origins.includes(origin);
  const cors = origin && origins.includes(origin) ? {'Access-Control-Allow-Origin': origin, Vary: 'Origin'} : {};
  const send = (status, data) => {
   res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors});
   res.end(JSON.stringify(data));
  };
  const deny = action => send(403, {error: 'Requires ' + requiredRole(action) + ' role', requiredRole: requiredRole(action)});
  const path = new URL(req.url, 'http://localhost').pathname;
  // CORS applies to the API only. Static assets carry Vite's `crossorigin`
  // attribute, so a browser sends an Origin header even same-origin; rejecting
  // those would break the production UI served from this same process.
  if (!originAllowed && path.startsWith('/api/')) return send(403, {error: 'Frontend origin is not allowed'});
  if (req.method === 'OPTIONS') {
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
   // The dev setup runs the page and API on different ports, so deletions
   // (sources, MCP servers, skills, plugins, recipes) and raw MCP replacement
   // need their real methods in the preflight response.
   res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
   return send(200, {});
  }
  if (path === '/health' && req.method === 'GET') return send(200, {status: 'ok', architecture: 'local-single-user'});
  let body = {};
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
   let size = 0;
   const chunks = [];
   for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) return send(413, {error: 'Request too large'});
    chunks.push(chunk);
   }
   try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, {error: 'Invalid JSON'}); }
  }
  try {
   if (path === '/api/v1/capabilities' && req.method === 'GET') {
    const policy = sourcePolicy(name => env[name]);
    const llm = llmState();
    return send(200, {
     version: 'local-v1',
     execution: 'local-single-user',
     environment,
     ai: Boolean(llm.key) || llm.provider === 'custom',
     search: llm.provider === 'deepseek' && Boolean(llm.key),
     assistant: Boolean(await resolveAssistantNow()),
     agent: Boolean(await resolveAgentNow()),
     llm: {provider: llm.provider, model: llm.model, baseUrl: llm.baseUrl, keySet: Boolean(llm.key)},
     agent_role: agentStore?.config().role ?? null,
     ocr: mineruStatus(env, agentStore?.ocr()),
     max_sources: 5,
     allowed_domains: policy.restrictedDomains,
     default_source_urls: policy.defaultSourceUrls,
     discovery_mode: 'additive',
     ...(tasks ? {
      queue: {file: tasks.queue?.file ?? '', concurrency: Number(env.TASK_CONCURRENCY || 1) || 1},
      collector: {playwright: true},
      events: {count: tasks.eventStore ? tasks.eventStore.stats().total : 0},
      sources: {total: tasks.registry ? tasks.registry.stats().total : 0},
     } : {}),
    });
   }
   if (path === '/api/v1/ocr/status' && req.method === 'GET') return send(200, mineruStatus(env, agentStore?.ocr()));
   if (path === '/api/v1/workspace' && req.method === 'GET') return send(200, await store.bundle());
   if (path === '/api/v1/research-tasks' && req.method === 'POST') {
    if (!allowed('business:write')) return deny('business:write');
    const scope = Object.fromEntries(['title', 'question', 'segment', 'market', 'quarter', 'competitors', 'focus', 'source_urls'].map(key => [key, body[key]]));
    try { validateScope(scope); } catch { return send(400, {error: 'Invalid research scope'}); }
    return send(201, await store.createProject(scope));
   }
   const run = path.match(/^\/api\/v1\/research-tasks\/([0-9a-f-]{36})\/run$/i);
   if (run && req.method === 'POST') {
    if (!allowed('business:write')) return deny('business:write');
    if (!['collect', 'research', 'extract', 'agent'].includes(body.mode)) return send(400, {error: 'Invalid research mode'});
    const activeLlm = llmState();
    if (!activeLlm.key) return send(409, {error: 'No AI API key is configured. Add DEEPSEEK_API_KEY to .env.host or fill it in Settings → AI model.'});
    if (body.mode !== 'collect' && !extractionReady(env)) return send(409, {error: 'AI extraction is not configured on this demo host'});
    if (body.mode === 'agent') {
     if (!taskQueue()) return send(503, {error: 'Agent research requires the durable task queue'});
     const runtime = await resolveAgentNow();
     if (!runtime) return send(409, {error: 'Agent research requires a configured agent model (Settings → AI model)'});
    }
    const job = await store.enqueue(run[1], body.mode);
    // With the durable queue the API only schedules the job: one worker runs
    // research, collection and event tasks in order. Without it (unit tests and
    // the old inline path) the demo keeps its in-process drain.
    if (taskQueue()) {
     const kind = body.mode === 'extract' ? 'project.extract' : body.mode === 'agent' ? 'project.agent-research' : 'project.research';
     const task = await taskQueue().create({kind, projectId: run[1], priority: 1, payload: {mode: body.mode, jobId: job.id}});
     return send(202, {...job, taskId: task.id, taskState: task.state});
    }
    if (job.state === 'queued') queue.push(job);
    void drain();
    return send(202, job);
   }
   if (path === '/api/v1/research-jobs' && req.method === 'GET') {
    const jobs = await store.jobs();
    return send(200, jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100));
   }

   // ---- Durable task queue (M1/M2) ---------------------------------------
   if (path === '/api/v1/tasks/stream' && req.method === 'GET') {
    if (!taskQueue()) return send(503, {error: 'Task queue is not available'});
    res.writeHead(200, {
     'Content-Type': 'text/event-stream; charset=utf-8',
     'Cache-Control': 'no-store, no-transform',
     Connection: 'keep-alive',
     'X-Accel-Buffering': 'no',
     ...cors,
    });
    res.setTimeout(0);
    res.flushHeaders();
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    const write = event => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n'); };
    const unsubscribe = taskQueue().subscribe(write);
    req.on('close', () => { clearInterval(beat); unsubscribe(); });
    return;
   }
   if (path === '/api/v1/tasks' && req.method === 'GET') {
    if (!taskQueue()) return send(503, {error: 'Task queue is not available'});
    const query = params(req);
    const limit = Math.max(1, Math.min(500, Number(query.get('limit')) || 200));
    return send(200, {
     tasks: taskQueue().list({
      state: query.get('state') || undefined,
      kind: query.get('kind') || undefined,
      projectId: query.get('projectId') || undefined,
      eventId: query.get('eventId') || undefined,
      sourceId: query.get('sourceId') || undefined,
      limit,
     }),
     stats: taskQueue().stats(),
    });
   }
   const taskItem = path.match(/^\/api\/v1\/tasks\/([0-9a-f-]{36})$/i);
   if (taskItem && req.method === 'GET') {
    if (!taskQueue()) return send(503, {error: 'Task queue is not available'});
    const task = taskQueue().get(taskItem[1]);
    if (!task) return send(404, {error: 'Task not found'});
    return send(200, task);
   }
   const taskAction = path.match(/^\/api\/v1\/tasks\/([0-9a-f-]{36})\/(cancel|retry)$/i);
   if (taskAction && req.method === 'POST') {
    if (!allowed('tasks:write')) return deny('tasks:write');
    if (!taskQueue()) return send(503, {error: 'Task queue is not available'});
    try {
     const task = taskAction[2] === 'cancel'
      ? await taskQueue().cancel(taskAction[1])
      : await taskQueue().retry(taskAction[1]);
     // Cancelling a queued research task never reaches its handler, so release
     // the project job record here to keep the research UI consistent.
     if (taskAction[2] === 'cancel' && task.kind.startsWith('project.') && task.state === 'cancelled' && task.payload?.jobId) {
      await store.failJob(task.payload.jobId, 'Cancelled by user').catch(() => {});
     }
     return send(200, task);
    } catch (error) {
     const message = error instanceof Error ? error.message : 'Task action failed';
     return send(/not found/i.test(message) ? 404 : 409, {error: message});
    }
   }

   // ---- Event library (M3c/M3d) ------------------------------------------
   const hasEvents = () => Boolean(tasks?.eventStore);
   if (path === '/api/v1/events/export' && req.method === 'GET') {
    if (!hasEvents()) return send(503, {error: 'Event library is not available'});
    const format = params(req).get('format') === 'json' ? 'json' : 'csv';
    if (format === 'json') {
     res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="domel-events.json"',
      'Cache-Control': 'no-store',
      ...cors,
     });
     return res.end(JSON.stringify({exportedAt: new Date().toISOString(), events: tasks.eventStore.list({})}, null, 2));
    }
    const rows = tasks.eventStore.exportRows();
    const lines = [EVENT_EXPORT_COLUMNS.join(',')];
    for (const row of rows) lines.push(EVENT_EXPORT_COLUMNS.map(column => csvCell(row[column])).join(','));
    res.writeHead(200, {
     'Content-Type': 'text/csv; charset=utf-8',
     'Content-Disposition': 'attachment; filename="domel-events.csv"',
     'Cache-Control': 'no-store',
     ...cors,
    });
    return res.end(lines.join('\n'));
   }
   if (path === '/api/v1/events' && req.method === 'GET') {
    if (!hasEvents()) return send(503, {error: 'Event library is not available'});
    const query = params(req);
    const events = tasks.eventStore.list({
     from: query.get('from') || undefined,
     to: query.get('to') || undefined,
     region: query.get('region') || undefined,
     status: query.get('status') || undefined,
     q: query.get('q') || undefined,
     limit: Math.max(1, Math.min(500, Number(query.get('limit')) || 500)),
    });
    return send(200, {events, count: events.length});
   }
   if (path === '/api/v1/events/discover' && req.method === 'POST') {
    if (!allowed('events:write')) return deny('events:write');
    if (!taskQueue() || !hasEvents()) return send(503, {error: 'Event discovery is not available'});
    const task = await taskQueue().create({
     kind: 'event.discover',
     priority: 2,
     payload: {
      region: body.region ?? 'cn',
      query: typeof body.query === 'string' ? body.query : undefined,
      limit: Math.max(1, Math.min(100, Number(body.limit) || 30)),
     },
    });
    return send(202, {task});
   }
   const eventItem = path.match(/^\/api\/v1\/events\/([0-9a-f-]{36})$/i);
   if (eventItem && req.method === 'GET') {
    if (!hasEvents()) return send(503, {error: 'Event library is not available'});
    const event = tasks.eventStore.get(eventItem[1]);
    if (!event) return send(404, {error: 'Event not found'});
    return send(200, event);
   }
   if (eventItem && req.method === 'PATCH') {
    if (!allowed('events:write')) return deny('events:write');
    if (!hasEvents()) return send(503, {error: 'Event library is not available'});
    try {
     return send(200, tasks.eventStore.patch(eventItem[1], body));
    } catch (error) {
     const message = error instanceof Error ? error.message : 'Event update failed';
     return send(/not found/i.test(message) ? 404 : 400, {error: message});
    }
   }
   const eventEnrich = path.match(/^\/api\/v1\/events\/([0-9a-f-]{36})\/enrich$/i);
   if (eventEnrich && req.method === 'POST') {
    if (!allowed('events:write')) return deny('events:write');
    if (!taskQueue() || !hasEvents()) return send(503, {error: 'Event enrichment is not available'});
    if (!tasks.eventStore.get(eventEnrich[1])) return send(404, {error: 'Event not found'});
    const task = await taskQueue().create({
     kind: 'event.enrich',
     eventId: eventEnrich[1],
     priority: 2,
     payload: {eventId: eventEnrich[1]},
    });
    return send(202, {task});
   }
   const eventParse = path.match(/^\/api\/v1\/events\/([0-9a-f-]{36})\/parse$/i);
   if (eventParse && req.method === 'POST') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    if (!hasEvents()) return send(503, {error: 'Event library is not available'});
    const event = tasks.eventStore.get(eventParse[1]);
    if (!event) return send(404, {error: 'Event not found'});
    const document = (event.documents ?? []).find(item => item.url === body.url);
    if (!document) return send(404, {error: 'Document not found on this event'});
    const ocr = mineruStatus(env, agentStore?.ocr());
    if (!ocr.configured) return send(409, {error: 'Document parsing is not configured. Set an OCR provider in Settings.', ocr});
    if (document.status !== 'downloadable') {
     return send(409, {error: 'Document is not downloadable; only its link and availability are recorded.', availability: document.status});
    }
    return send(501, {
     error: 'Document parsing is defined but not enabled in this demo phase. The link and availability are already recorded.',
     ocr,
    });
   }

   // ---- Source registry (M3b) --------------------------------------------
   const hasSources = () => Boolean(tasks?.registry);
   if (path === '/api/v1/sources' && req.method === 'GET') {
    if (!hasSources()) return send(503, {error: 'Source registry is not available'});
    const query = params(req);
    const enabled = query.has('enabled') ? query.get('enabled') === 'true' : undefined;
    return send(200, {
     sources: tasks.registry.list({
      region: query.get('region') || undefined,
      type: query.get('type') || undefined,
      enabled,
     }),
     stats: tasks.registry.stats(),
    });
   }
   if (path === '/api/v1/sources' && req.method === 'POST') {
    if (!allowed('sources:manage')) return deny('sources:manage');
    if (!hasSources()) return send(503, {error: 'Source registry is not available'});
    try {
     return send(201, tasks.registry.create(body));
    } catch (error) {
     return send(400, {error: error instanceof Error ? error.message : 'Invalid source'});
    }
   }
   const sourceItem = path.match(/^\/api\/v1\/sources\/([0-9a-f-]{36})$/i);
   if (sourceItem && req.method === 'PATCH') {
    if (!hasSources()) return send(503, {error: 'Source registry is not available'});
    if (!allowed('sources:manage')) {
     const onlyEnabled = Object.keys(body).length === 1 && typeof body.enabled === 'boolean';
     if (!allowed('sources:toggle') || !onlyEnabled) return deny('sources:toggle');
    }
    try {
     const patch = allowed('sources:manage') ? body : {enabled: body.enabled};
     return send(200, tasks.registry.update(sourceItem[1], patch));
    } catch (error) {
     const message = error instanceof Error ? error.message : 'Source update failed';
     return send(/not found/i.test(message) ? 404 : 400, {error: message});
    }
   }
   if (sourceItem && req.method === 'DELETE') {
    if (!allowed('sources:manage')) return deny('sources:manage');
    if (!hasSources()) return send(503, {error: 'Source registry is not available'});
    try {
     tasks.registry.remove(sourceItem[1]);
     return send(200, {ok: true});
    } catch (error) {
     return send(404, {error: error instanceof Error ? error.message : 'Source not found'});
    }
   }
   const sourceRun = path.match(/^\/api\/v1\/sources\/([0-9a-f-]{36})\/run$/i);
   if (sourceRun && req.method === 'POST') {
    if (!allowed('tasks:write')) return deny('tasks:write');
    if (!hasSources() || !taskQueue()) return send(503, {error: 'Source collection is not available'});
    const source = tasks.registry.get(sourceRun[1]);
    if (!source) return send(404, {error: 'Source not found'});
    const task = await taskQueue().create({
     kind: 'source.collect',
     sourceId: source.id,
     priority: Number(source.priority) || 1,
     payload: {sourceId: source.id, url: source.url},
    });
    return send(202, {task});
   }

   // ---- Recipes (M3a approval surface) -----------------------------------
   const hasRecipes = () => Boolean(tasks?.recipes);
   if (path === '/api/v1/recipes' && req.method === 'GET') {
    if (!hasRecipes()) return send(503, {error: 'Recipes are not available'});
    const query = params(req);
    return send(200, {recipes: tasks.recipes.list({domain: query.get('domain') || undefined, status: query.get('status') || undefined})});
   }
   if (path === '/api/v1/recipes' && req.method === 'POST') {
    if (!allowed('recipes:manage')) return deny('recipes:manage');
    if (!hasRecipes()) return send(503, {error: 'Recipes are not available'});
    try {
     return send(201, tasks.recipes.propose({
      domain: body.domain,
      kind: body.kind,
      body: body.body,
      proposedBy: 'human',
      notes: body.notes,
     }));
    } catch (error) {
     return send(400, {error: error instanceof Error ? error.message : 'Invalid recipe'});
    }
   }
   const recipeItem = path.match(/^\/api\/v1\/recipes\/([0-9a-f-]{36})$/i);
   if (recipeItem && req.method === 'PATCH') {
    if (!allowed('recipes:manage')) return deny('recipes:manage');
    if (!hasRecipes()) return send(503, {error: 'Recipes are not available'});
    try {
     return send(200, tasks.recipes.update(recipeItem[1], body));
    } catch (error) {
     const message = error instanceof Error ? error.message : 'Recipe update failed';
     return send(/not found/i.test(message) ? 404 : 400, {error: message});
    }
   }
   if (recipeItem && req.method === 'DELETE') {
    if (!allowed('recipes:manage')) return deny('recipes:manage');
    if (!hasRecipes()) return send(503, {error: 'Recipes are not available'});
    try {
     tasks.recipes.remove(recipeItem[1]);
     return send(200, {ok: true});
    } catch (error) {
     return send(404, {error: error instanceof Error ? error.message : 'Recipe not found'});
    }
   }
   const recipeTest = path.match(/^\/api\/v1\/recipes\/([0-9a-f-]{36})\/test$/i);
   if (recipeTest && req.method === 'POST') {
    if (!allowed('recipes:manage')) return deny('recipes:manage');
    if (!hasRecipes() || !tasks.collector || !tasks.applyRecipe) return send(503, {error: 'Recipe testing is not available'});
    const recipe = tasks.recipes.get(recipeTest[1]);
    if (!recipe) return send(404, {error: 'Recipe not found'});
    let url;
    try {
     url = new URL(String(body.url ?? ''));
    } catch {
     return send(400, {error: 'Invalid URL'});
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return send(400, {error: 'Invalid URL'});
    try {
     const page = await tasks.collector.collect(url.href, {allowPlaywright: false});
     if (!page.ok) return send(200, {ok: false, error: page.error?.message ?? 'Page is not available'});
     const applied = await tasks.applyRecipe(recipe, {html: page.html, url: page.finalUrl || url.href, text: page.text});
     return send(200, applied);
    } catch (error) {
     return send(200, {ok: false, error: error instanceof Error ? error.message : 'Recipe test failed'});
    }
   }

   const review = path.match(/^\/api\/v1\/insights\/([0-9a-f-]{36})\/review$/i);
   if (review && req.method === 'PATCH') {
    if (!allowed('business:write')) return deny('business:write');
    return send(200, await store.review(review[1], body.text, body.decision, body.revision));
   }
   if (path === '/api/v1/reports' && req.method === 'POST') {
    if (!allowed('business:write')) return deny('business:write');
    return send(201, await store.generateReport(body.project_id));
   }
   const chat = path.match(/^\/api\/v1\/research-tasks\/([0-9a-f-]{36})\/assistant$/i);
   if (chat && req.method === 'POST') {
    const assistantRunner = await resolveAssistantNow();
    if (!assistantRunner) return send(503, {error: 'Research assistant is not configured on this demo host'});
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 8000) return send(400, {error: 'Invalid assistant message'});
    res.writeHead(200, {
     'Content-Type': 'text/event-stream; charset=utf-8',
     'Cache-Control': 'no-store, no-transform',
     Connection: 'keep-alive',
     'X-Accel-Buffering': 'no',
     ...cors,
    });
    res.setTimeout(0);
    res.flushHeaders();
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const emit = event => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n'); };
    try {
     await assistantRunner({
      reader: localReader(store),
      userId: 'local-user',
      projectId: chat[1],
      message,
      onEvent: emit,
      abortSignal: controller.signal,
     });
    } catch {
     emit({type: 'error', error: 'Assistant run failed'});
    } finally {
     clearInterval(beat);
     res.end();
    }
    return;
   }
   if (path === '/api/v1/agent/sessions' && req.method === 'GET') {
    const projectId = new URL(req.url, 'http://localhost').searchParams.get('projectId') || undefined;
    return send(200, {sessions: transcripts ? await transcripts.list({projectId}) : []});
   }
   const transcriptRoute = path.match(/^\/api\/v1\/agent\/sessions\/([0-9a-f-]{36})$/i);
   if (transcriptRoute && req.method === 'GET') {
    if (!transcripts) return send(404, {error: 'Agent sessions are not available'});
    const transcript = await transcripts.get(transcriptRoute[1]);
    if (!transcript) return send(404, {error: 'Agent session not found'});
    return send(200, transcript);
   }
   if (path === '/api/v1/agent/config' && req.method === 'GET') {
    if (!agentStore) return send(503, {error: 'Agent configuration is not available'});
    return send(200, agentConfigPayload());
   }
   if (path === '/api/v1/agent/mcp/raw' && req.method === 'GET') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    return send(200, agentStore.rawMcp());
   }
   if (path === '/api/v1/agent/mcp' && req.method === 'PUT') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    return send(200, agentStore.replaceMcpConfig(body));
   }
   if (path === '/api/v1/agent/mcp' && req.method === 'POST') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    return send(201, agentStore.addMcp(body));
   }
   if (path === '/api/v1/agent/mcp/test' && req.method === 'POST') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    const name = String(body.name ?? '');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return send(400, {error: 'Invalid MCP server name'});
    const server = agentStore.rawMcp().mcpServers[name];
    if (!server) return send(404, {error: 'MCP server not found'});
    try {
     return send(200, await testMcpServer(server));
    } catch (error) {
     return send(200, {ok: false, error: error instanceof Error ? error.message : 'MCP test failed'});
    }
   }
   const mcpRoute = path.match(/^\/api\/v1\/agent\/mcp\/([A-Za-z0-9_-]{1,40})$/);
   if (mcpRoute && req.method === 'PATCH') {
    const name = decodeURIComponent(mcpRoute[1]);
    if (!allowed('settings:manage')) {
     const onlyEnabled = Object.keys(body).length === 1 && typeof body.enabled === 'boolean';
     if (!allowed('settings:toggle') || !onlyEnabled) return deny('settings:toggle');
     return send(200, agentStore.updateMcp(name, body, {enabledOnly: true}));
    }
    return send(200, agentStore.updateMcp(name, body));
   }
   if (mcpRoute && req.method === 'DELETE') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    agentStore.removeMcp(decodeURIComponent(mcpRoute[1]));
    return send(200, {ok: true});
   }
   if (path === '/api/v1/agent/skills' && req.method === 'POST') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    return send(201, agentStore.addSkill(body));
   }
   const skillRoute = path.match(/^\/api\/v1\/agent\/skills\/([0-9a-f-]{36})$/i);
   if (skillRoute && req.method === 'PATCH') {
    if (!allowed('settings:manage')) {
     const onlyEnabled = Object.keys(body).length === 1 && typeof body.enabled === 'boolean';
     if (!allowed('settings:toggle') || !onlyEnabled) return deny('settings:toggle');
     return send(200, agentStore.updateSkill(skillRoute[1], body, {enabledOnly: true}));
    }
    return send(200, agentStore.updateSkill(skillRoute[1], body));
   }
   if (skillRoute && req.method === 'DELETE') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    agentStore.removeSkill(skillRoute[1]);
    return send(200, {ok: true});
   }
   if (path === '/api/v1/agent/plugins' && req.method === 'POST') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    return send(201, agentStore.addPlugin(body));
   }
   const pluginRoute = path.match(/^\/api\/v1\/agent\/plugins\/([0-9a-f-]{36})$/i);
   if (pluginRoute && req.method === 'PATCH') {
    if (!allowed('settings:manage')) {
     const onlyEnabled = Object.keys(body).length === 1 && typeof body.enabled === 'boolean';
     if (!allowed('settings:toggle') || !onlyEnabled) return deny('settings:toggle');
     return send(200, agentStore.updatePlugin(pluginRoute[1], body, {enabledOnly: true}));
    }
    return send(200, agentStore.updatePlugin(pluginRoute[1], body));
   }
   if (pluginRoute && req.method === 'DELETE') {
    if (!allowed('settings:manage')) return deny('settings:manage');
    agentStore.removePlugin(pluginRoute[1]);
    return send(200, {ok: true});
   }
   if (path === '/api/v1/agent/settings' && req.method === 'PATCH') {
    if (body.role !== undefined) {
     if (!allowed('roles:manage')) return deny('roles:manage');
     if (!canSwitchTo(role(), body.role)) return send(403, {error: 'Cannot assign that role', requiredRole: 'admin'});
    }
    if (body.cli !== undefined && !allowed('cli:manage')) return deny('cli:manage');
    if (body.ocr !== undefined && !allowed('settings:manage')) return deny('settings:manage');
    if (body.llm !== undefined && !allowed('settings:manage')) return deny('settings:manage');
    const updated = agentStore.setSettings(body, {allowCli: allowed('cli:manage')});
    if (body.llm !== undefined && typeof syncLlm === 'function') syncLlm();
    return send(200, {...updated, llm: agentConfigPayload().llm});
   }
   if (path === '/api/v1/agent/chat' && req.method === 'POST') {
    if (!allowed('agent:chat')) return deny('agent:chat');
    const chatRuntime = await resolveAgentNow();
    if (!chatRuntime) return send(503, {error: 'Agent model is not configured on this demo host'});
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return send(400, {error: 'Invalid agent message'});
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : 'general';
    if (projectId !== 'general' && !(await store.project(projectId))) return send(404, {error: 'Project not accessible'});
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...cors});
    res.setTimeout(0);
    res.flushHeaders();
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const emit = event => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n'); };
    try {
     await chatRuntime({projectId, message, onEvent: emit, abortSignal: controller.signal});
    } catch {
     emit({type: 'error', error: 'Agent run failed'});
    } finally {
     clearInterval(beat);
     res.end();
    }
    return;
   }
   if (env.SERVE_STATIC !== '0' && serveStatic(req, res, {root: env.STATIC_DIR || 'dist'})) return;
   return send(404, {error: 'Route not found'});
  } catch (error) {
   const message = error instanceof Error ? error.message : '';
   const permitted = /Project not accessible|already queued|Saved extraction is unavailable|new research run|finding changed|Finding not accessible|Accept at least one|Supporting source|Invalid decision|Invalid finding wording|Saved source not accessible/;
   return send(409, {error: permitted.test(message) ? message : 'Operation failed. Check the local demo log.'});
  }
 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const env = process.env;
 const store = openLocalStore(env.LOCAL_DATA_FILE || '.local/domel.json');
 const agentStore = openAgentStore(env.AGENT_DATA_DIR || '.local', {seedSkillsDir: env.AGENT_SKILLS_SEED || 'seed/skills'});
 const transcripts = openTranscriptStore({file: env.AGENT_TRANSCRIPT_FILE || '.local/agent/transcripts.json'});

 // AI configuration: Settings overrides .env.host; a custom base URL means a
 // locally deployed OpenAI-compatible server. The model runtime is rebuilt
 // lazily when the effective key/model/base URL changes, so a key saved in the
 // UI works without restarting the process.
 const baseEnv = {
  key: env.DEEPSEEK_API_KEY || '',
  model: env.DEEPSEEK_MODEL || '',
  baseUrl: env.DEEPSEEK_BASE_URL || '',
 };
 function resolveLlm() {
  const ui = agentStore.llm();
  const key = ui.apiKey || baseEnv.key;
  const model = ui.model || baseEnv.model || 'deepseek-flash';
  const baseUrl = ui.baseUrl || baseEnv.baseUrl || 'https://api.deepseek.com';
  const provider = isDeepSeekBaseUrl(baseUrl) ? 'deepseek' : 'custom';
  return {key, model, baseUrl, provider};
 }
 // Keep process.env in sync for the research/collector code paths that read it.
 function syncLlmEnv() {
  const llm = resolveLlm();
  if (llm.provider === 'custom') {
   process.env.AI_BASE_URL = llm.baseUrl;
   process.env.AI_API_KEY = llm.key || 'local';
   process.env.AI_MODEL = llm.model;
  } else {
   delete process.env.AI_BASE_URL;
   delete process.env.AI_API_KEY;
   delete process.env.AI_MODEL;
   process.env.DEEPSEEK_MODEL = llm.model;
   if (llm.key) process.env.DEEPSEEK_API_KEY = llm.key;
   else delete process.env.DEEPSEEK_API_KEY;
  }
 }
 syncLlmEnv();

 let modelCache = {signature: '', assistant: undefined, agentRuntime: undefined};
 async function resolveModels() {
  const llm = resolveLlm();
  if (!llm.key && llm.provider !== 'custom') return {assistant: undefined, agentRuntime: undefined};
  const signature = [llm.provider, llm.key, llm.model, llm.baseUrl].join('|');
  if (modelCache.signature === signature) return modelCache;
  try {
   const deepseek = await openDeepSeekModel({
    apiKey: llm.key,
    modelId: llm.model,
    authDir: agentStore.dir,
    baseUrl: llm.provider === 'custom' ? llm.baseUrl : undefined,
   });
   const assistant = createAssistantRunner({...deepseek, sessionRoot: env.ASSISTANT_SESSION_DIR || '.local/assistant'});
   const agentRuntime = createAgentRuntime({
    store: agentStore,
    ...deepseek,
    workspaceRoot: env.AGENT_WORKSPACE_ROOT || '.local/workspaces',
    agentDir: agentStore.dir,
    transcripts,
   });
   modelCache = {signature, assistant, agentRuntime};
  } catch (error) {
   console.error('Agent model unavailable: ' + error.message);
   modelCache = {signature, assistant: undefined, agentRuntime: undefined};
  }
  return modelCache;
 }

 // One queue for research, source collection and event jobs. The scheduler is
 // started together with the queue so due sources are picked up without a
 // separate worker process.
 const tasks = createTaskRunner({
  store,
  env,
  getLlm: resolveLlm,
  getAgentRuntime: async () => (await resolveModels()).agentRuntime,
 });
 const server = localApiServer({
  store,
  agentStore,
  transcripts,
  tasks,
  env,
  resolveAssistant: async () => (await resolveModels()).assistant,
  resolveAgent: async () => (await resolveModels()).agentRuntime,
  getLlm: resolveLlm,
  syncLlm: () => {
   syncLlmEnv();
   modelCache = {signature: '', assistant: undefined, agentRuntime: undefined};
  },
  environment: env.DEMO_ENV || 'local',
  origins: (env.APP_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(value => value.trim()).filter(Boolean),
 });
 server.requestTimeout = 15000;
 server.headersTimeout = 10000;
 tasks.start();
 // Ctrl-C should stop the handlers and persist the queue before the process dies.
 const shutdown = () => {
  void tasks.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
 };
 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
 server.listen(Number(env.LOCAL_API_PORT || 8788), env.LOCAL_API_BIND || '127.0.0.1', () => {
  console.log('Local demo API ready on http://' + (env.LOCAL_API_BIND || '127.0.0.1') + ':' + (env.LOCAL_API_PORT || 8788));
  const startupLlm = resolveLlm();
  console.log('Data: ' + (env.LOCAL_DATA_FILE || '.local/domel.json') + ' · AI: ' + (startupLlm.key || startupLlm.provider === 'custom' ? 'configured (' + startupLlm.provider + ' · ' + startupLlm.model + ')' : 'not configured') + ' · Agent dir: ' + agentStore.dir);
  console.log('Tasks: ' + (env.TASKS_FILE || '.local/tasks.json') + ' · Events: ' + (env.EVENTS_FILE || '.local/events.json') + ' · Sources: ' + (env.SOURCES_FILE || '.local/source-registry.json'));
 });
}
