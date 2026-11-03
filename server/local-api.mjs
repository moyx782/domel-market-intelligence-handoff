// Single-user demo API: no authentication, no Supabase, one local JSON store.
//
// It exposes the same routes the frontend already uses, runs research inline
// (one job at a time) with the existing DeepSeek adapter, and streams the
// read-only assistant over SSE. Multi-user accounts and RLS remain in the
// separate host API and are intentionally out of scope here.

import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openLocalStore} from './local-store.mjs';
import {join} from 'node:path';
import {createAssistantRunner, localReader, openDeepSeekModel} from './assistant.mjs';
import {openAgentStore} from './agent-config.mjs';
import {createAgentRuntime} from './agent-runtime.mjs';
import {testMcpServer} from './mcp-test.mjs';
import {mineruStatus} from './mineru.mjs';
import {serveStatic} from './static.mjs';
import {can, canSwitchTo, requiredRole} from './permissions.mjs';
import {publicSourceUrl, sourcePolicy} from '../supabase/functions/_shared/source-policy.mjs';
import {createDeepSeekSources} from '../supabase/functions/_shared/deepseek-search.mjs';
import {extractionConfig, extractCandidates} from '../supabase/functions/_shared/ai-extraction.mjs';
import {validateScope, validateFindings} from '../supabase/functions/_shared/research-validation.mjs';
import {collectResearch, extractSavedResearch} from '../supabase/functions/_shared/research-workflow.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:5174', 'http://127.0.0.1:5175', 'http://localhost:5174', 'http://localhost:5175'];

function configureResearch(store, job, env) {
 return async () => {
  const project = await store.project(job.project_id);
  if (!project) throw Error('Project not accessible');
  const policy = sourcePolicy(name => env[name]);
  const allowUrl = raw => publicSourceUrl(raw, policy.restrictedDomains);
  const adapter = createDeepSeekSources({
   apiKey: env.DEEPSEEK_API_KEY,
   allowedDomains: policy.restrictedDomains,
   allowUrl,
   requestTimeoutMs: 30000,
  });
  const config = extractionConfig(name => env[name]);
  const saved = [];
  let outcome;
  const io = {
   now: () => Date.now(),
   aiReady: !!config,
   maxSources: 5,
   defaultSourceUrls: policy.defaultSourceUrls,
   normalizeUrl: allowUrl,
   notices: adapter.notices,
   stage: async () => {},
   discover: () => adapter.discover(project),
   fetchSource: adapter.fetchSource,
   saveSource: async source => {
    const id = randomUUID();
    saved.push({...source, id, retrieved_at: new Date().toISOString(), findings: []});
    return id;
   },
   extract: async (project, source) => extractCandidates(project, source, config, validateFindings),
   saveFindings: async (id, findings) => {
    const source = saved.find(item => item.id === id);
    if (!source) throw Error('Saved source unavailable');
    source.findings.push(...findings);
   },
   finish: async result => { outcome = result; },
  };
  if (job.mode === 'extract') await extractSavedResearch(project, await store.sources(project.id), io);
  else await collectResearch(project, io, job.mode === 'research');
  if (!outcome) throw Error('Research produced no result');
  await store.completeJob(job.id, outcome, saved);
 };
}

export function localApiServer({store, assistant, agentStore, agentRuntime, env = process.env, environment = 'local', origins = DEFAULT_ORIGINS}) {
 const role = () => agentStore?.config().role ?? 'admin';
 const allowed = action => can(role(), action);
 const queue = [];
 let running = false;

 async function drain() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  try {
   const started = await store.startJob(next.id);
   await configureResearch(store, started, env)();
  } catch (error) {
   await store.failJob(next.id, error instanceof Error ? error.message : 'Research failed').catch(() => {});
  } finally {
   running = false;
   void drain();
  }
 }

 return createServer(async (req, res) => {
  const origin = req.headers.origin;
  const originAllowed = !origin || origins.includes(origin);
  const cors = originAllowed && origin ? {'Access-Control-Allow-Origin': origin, Vary: 'Origin'} : {};
  const send = (status, data) => {
   res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors});
   res.end(JSON.stringify(data));
  };
  const deny = action => send(403, {error: 'Requires ' + requiredRole(action) + ' role', requiredRole: requiredRole(action)});
  if (!originAllowed) return send(403, {error: 'Frontend origin is not allowed'});
  if (req.method === 'OPTIONS') {
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
   res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
   return send(200, {});
  }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health' && req.method === 'GET') return send(200, {status: 'ok', architecture: 'local-single-user'});
  let body = {};
  if (['POST', 'PATCH'].includes(req.method)) {
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
    const config = extractionConfig(name => env[name]);
    const policy = sourcePolicy(name => env[name]);
    return send(200, {
     version: 'local-v1',
     execution: 'local-single-user',
     environment,
     ai: !!config,
     search: !!env.DEEPSEEK_API_KEY,
     assistant: !!assistant,
     agent: !!agentRuntime,
     agent_role: agentStore?.config().role ?? null,
     ocr: mineruStatus(env, agentStore?.ocr()),
     max_sources: 5,
     allowed_domains: policy.restrictedDomains,
     default_source_urls: policy.defaultSourceUrls,
     discovery_mode: 'additive',
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
    if (!['collect', 'research', 'extract'].includes(body.mode)) return send(400, {error: 'Invalid research mode'});
    if (!env.DEEPSEEK_API_KEY) return send(409, {error: 'DEEPSEEK_API_KEY is not configured on this demo host. Research and extraction cannot run.'});
    const config = extractionConfig(name => env[name]);
    if (body.mode !== 'collect' && !config) return send(409, {error: 'AI extraction is not configured on this demo host'});
    const job = await store.enqueue(run[1], body.mode);
    if (job.state === 'queued') queue.push(job);
    void drain();
    return send(202, job);
   }
   if (path === '/api/v1/research-jobs' && req.method === 'GET') {
    const jobs = await store.jobs();
    return send(200, jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100));
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
    if (!assistant) return send(503, {error: 'Research assistant is not configured on this demo host'});
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
     await assistant({
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
   if (path === '/api/v1/agent/config' && req.method === 'GET') {
    if (!agentStore) return send(503, {error: 'Agent configuration is not available'});
    return send(200, agentStore.publicConfig());
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
    return send(200, agentStore.setSettings(body, {allowCli: allowed('cli:manage')}));
   }
   if (path === '/api/v1/agent/chat' && req.method === 'POST') {
    if (!allowed('agent:chat')) return deny('agent:chat');
    if (!agentRuntime) return send(503, {error: 'Agent model is not configured on this demo host'});
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
     await agentRuntime({projectId, message, onEvent: emit, abortSignal: controller.signal});
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
 const agentStore = openAgentStore(env.AGENT_DATA_DIR || '.local');
 let deepseek;
 if (env.DEEPSEEK_API_KEY) {
  try {
   deepseek = await openDeepSeekModel({
    apiKey: env.DEEPSEEK_API_KEY,
    modelId: env.DEEPSEEK_MODEL || 'deepseek-flash',
    authDir: agentStore.dir,
   });
  } catch (error) {
   console.error('Agent model unavailable: ' + error.message);
  }
 }
 const assistant = deepseek
  ? createAssistantRunner({...deepseek, sessionRoot: env.ASSISTANT_SESSION_DIR || '.local/assistant'})
  : undefined;
 const agentRuntime = deepseek
  ? createAgentRuntime({
   store: agentStore,
   ...deepseek,
   workspaceRoot: env.AGENT_WORKSPACE_ROOT || '.local/workspaces',
   agentDir: agentStore.dir,
  })
  : undefined;
 const server = localApiServer({
  store,
  assistant,
  agentStore,
  agentRuntime,
  env,
  environment: env.DEMO_ENV || 'local',
  origins: (env.APP_ORIGINS || DEFAULT_ORIGINS.join(',')).split(',').map(value => value.trim()).filter(Boolean),
 });
 server.requestTimeout = 15000;
 server.headersTimeout = 10000;
 server.listen(Number(env.LOCAL_API_PORT || 8788), env.LOCAL_API_BIND || '127.0.0.1', () => {
  console.log('Local demo API ready on http://' + (env.LOCAL_API_BIND || '127.0.0.1') + ':' + (env.LOCAL_API_PORT || 8788));
  console.log('Data: ' + (env.LOCAL_DATA_FILE || '.local/domel.json') + ' · AI: ' + (deepseek ? 'configured' : 'not configured') + ' · Agent dir: ' + agentStore.dir);
 });
}
