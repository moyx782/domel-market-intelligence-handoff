// Typed client for the local demo API's new surfaces (tasks, events, sources,
// recipes, agent configuration and agent chat). Pages import from here only, so
// the fetch layer and error handling stay in one place.
import {backendBase} from './data';
import type {
 AgentConfig, AgentSessionSummary, AgentStreamEvent, AgentTranscript,
 Availability, Capabilities, EventExportFormat, EventListResponse, MarketEvent,
 McpTestResult, Recipe, Role, SourceEntry, SourceStats, Task, TaskKind, TaskStats,
 TaskStreamEvent,
} from './types';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
 let response: Response;
 try {
  response = await fetch(backendBase + path, {
   method,
   signal: AbortSignal.timeout(30000),
   headers: {'Content-Type': 'application/json'},
   ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
 } catch {
  throw Error('Cannot connect to the local demo API. Start it with npm run demo:api.');
 }
 const payload = await response.json().catch(() => ({}));
 if (!response.ok) throw Error((payload as {error?: string}).error || ('Request failed (' + response.status + ')'));
 return payload as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
 const search = new URLSearchParams();
 for (const [key, value] of Object.entries(params)) {
  if (value === undefined || value === '' || value === false) continue;
  search.set(key, String(value));
 }
 const text = search.toString();
 return text ? '?' + text : '';
}

// ---- Capabilities ----------------------------------------------------------

export function getCapabilities(): Promise<Capabilities> {
 return request<Capabilities>('/api/v1/capabilities');
}

// ---- Tasks (M1/M2) ---------------------------------------------------------

export type TaskFilter = {state?: string; kind?: TaskKind | ''; projectId?: string; eventId?: string; sourceId?: string; limit?: number};

export function getTasks(filter: TaskFilter = {}): Promise<{tasks: Task[]; stats: TaskStats}> {
 return request('/api/v1/tasks' + query(filter));
}

export function getTask(id: string): Promise<Task> {
 return request('/api/v1/tasks/' + encodeURIComponent(id));
}

export function cancelTask(id: string): Promise<Task> {
 return request('/api/v1/tasks/' + encodeURIComponent(id) + '/cancel', 'POST', {});
}

export function retryTask(id: string): Promise<Task> {
 return request('/api/v1/tasks/' + encodeURIComponent(id) + '/retry', 'POST', {});
}

// EventSource cannot send headers, which is fine for the unauthenticated local
// demo; it reconnects on its own, and callers can fall back to polling.
export function streamTasks(onEvent: (event: TaskStreamEvent) => void, onError?: () => void): () => void {
 const source = new EventSource(backendBase + '/api/v1/tasks/stream');
 source.onmessage = message => {
  try { onEvent(JSON.parse(message.data) as TaskStreamEvent); } catch {}
 };
 if (onError) source.onerror = () => onError();
 return () => source.close();
}

// ---- Events (M3c) ----------------------------------------------------------

export type EventFilter = {from?: string; to?: string; region?: string; status?: string; q?: string; limit?: number};

export function listEvents(filter: EventFilter = {}): Promise<EventListResponse> {
 return request('/api/v1/events' + query(filter));
}

export function getEvent(id: string): Promise<MarketEvent> {
 return request('/api/v1/events/' + encodeURIComponent(id));
}

export function discoverEvents(body: {region?: string; query?: string; limit?: number} = {}): Promise<{task: Task}> {
 return request('/api/v1/events/discover', 'POST', body);
}

export function enrichEvent(id: string): Promise<{task: Task}> {
 return request('/api/v1/events/' + encodeURIComponent(id) + '/enrich', 'POST', {});
}

export function patchEvent(id: string, changes: Partial<MarketEvent>): Promise<MarketEvent> {
 return request('/api/v1/events/' + encodeURIComponent(id), 'PATCH', changes);
}

export function parseEventDocument(id: string, url: string): Promise<{taskId: string; task: unknown}> {
 return request('/api/v1/events/' + encodeURIComponent(id) + '/parse', 'POST', {url});
}

export function requestAgentReport(id: string): Promise<{taskId: string; task: unknown}> {
 return request('/api/v1/events/' + encodeURIComponent(id) + '/agent-report', 'POST', {});
}

export function getOcrStatus(): Promise<{configured: boolean; provider: string; vision?: {configured: boolean; model?: string | null}; tools?: Record<string, boolean>}> {
 return request('/api/v1/ocr/status');
}

export function getMaterialText(eventId: string, materialId: string): Promise<{material: {id: string; title: string}; text: string}> {
 return request('/api/v1/events/' + encodeURIComponent(eventId) + '/materials/' + encodeURIComponent(materialId) + '/text');
}

export async function exportEvents(format: EventExportFormat): Promise<void> {
 const response = await fetch(backendBase + '/api/v1/events/export?format=' + format);
 if (!response.ok) {
  const payload = await response.json().catch(() => ({}));
  throw Error((payload as {error?: string}).error || ('Export failed (' + response.status + ')'));
 }
 const blob = await response.blob();
 const disposition = response.headers.get('Content-Disposition') || '';
 const match = /filename="?([^";]+)"?/.exec(disposition);
 const filename = match?.[1] || ('domel-events.' + format);
 const href = URL.createObjectURL(blob);
 const anchor = document.createElement('a');
 anchor.href = href;
 anchor.download = filename;
 anchor.click();
 setTimeout(() => URL.revokeObjectURL(href), 1000);
}

// ---- Source registry (M3b) -------------------------------------------------

export type SourceFilter = {region?: string; enabled?: boolean; type?: string};

export function listSources(filter: SourceFilter = {}): Promise<{sources: SourceEntry[]; stats: SourceStats}> {
 return request('/api/v1/sources' + query(filter));
}

export function createSource(body: {url: string; title?: string; type?: string; region?: string; priority?: number; intervalSec?: number}): Promise<SourceEntry> {
 return request('/api/v1/sources', 'POST', body);
}

export function updateSource(id: string, patch: Partial<SourceEntry>): Promise<SourceEntry> {
 return request('/api/v1/sources/' + encodeURIComponent(id), 'PATCH', patch);
}

export function deleteSource(id: string): Promise<{ok: boolean}> {
 return request('/api/v1/sources/' + encodeURIComponent(id), 'DELETE');
}

export function runSource(id: string): Promise<{task: Task}> {
 return request('/api/v1/sources/' + encodeURIComponent(id) + '/run', 'POST', {});
}

// ---- Recipes (M3a/M4) ------------------------------------------------------

export function listRecipes(filter: {domain?: string; status?: string} = {}): Promise<{recipes: Recipe[]}> {
 return request('/api/v1/recipes' + query(filter));
}

export function createRecipe(body: {domain: string; kind: string; body: string; notes?: string}): Promise<Recipe> {
 return request('/api/v1/recipes', 'POST', body);
}

export function updateRecipe(id: string, patch: {status?: string; body?: string; notes?: string}): Promise<Recipe> {
 return request('/api/v1/recipes/' + encodeURIComponent(id), 'PATCH', patch);
}

export function deleteRecipe(id: string): Promise<{ok: boolean}> {
 return request('/api/v1/recipes/' + encodeURIComponent(id), 'DELETE');
}

export function testRecipe(id: string, url: string): Promise<{ok: boolean; values?: Record<string, unknown>; error?: string}> {
 return request('/api/v1/recipes/' + encodeURIComponent(id) + '/test', 'POST', {url});
}

// ---- Agent config, MCP, skills, plugins (M4) -------------------------------

export function getAgentConfig(): Promise<AgentConfig> {
 return request<AgentConfig>('/api/v1/agent/config');
}

export function updateAgentSettings(patch: Record<string, unknown>): Promise<unknown> {
 return request('/api/v1/agent/settings', 'PATCH', patch);
}

export function addMcp(body: Record<string, unknown>): Promise<unknown> {
 return request('/api/v1/agent/mcp', 'POST', body);
}

export function updateMcp(name: string, patch: Record<string, unknown>): Promise<unknown> {
 return request('/api/v1/agent/mcp/' + encodeURIComponent(name), 'PATCH', patch);
}

export function deleteMcp(name: string): Promise<{ok: boolean}> {
 return request('/api/v1/agent/mcp/' + encodeURIComponent(name), 'DELETE');
}

export function testMcp(name: string): Promise<McpTestResult> {
 return request('/api/v1/agent/mcp/test', 'POST', {name});
}

export function getRawMcp(): Promise<{mcpServers: Record<string, unknown>}> {
 return request('/api/v1/agent/mcp/raw');
}

export function replaceMcp(body: string | Record<string, unknown>): Promise<{mcpServers: Record<string, unknown>}> {
 return request('/api/v1/agent/mcp', 'PUT', body);
}

export function addSkill(body: {name: string; description?: string; content?: string}): Promise<unknown> {
 return request('/api/v1/agent/skills', 'POST', body);
}

export function updateSkill(id: string, patch: {name?: string; description?: string; content?: string; enabled?: boolean}): Promise<unknown> {
 return request('/api/v1/agent/skills/' + encodeURIComponent(id), 'PATCH', patch);
}

export function deleteSkill(id: string): Promise<{ok: boolean}> {
 return request('/api/v1/agent/skills/' + encodeURIComponent(id), 'DELETE');
}

export function addPlugin(body: {name: string; content?: string; file?: string}): Promise<unknown> {
 return request('/api/v1/agent/plugins', 'POST', body);
}

export function updatePlugin(id: string, patch: {name?: string; content?: string; enabled?: boolean}): Promise<unknown> {
 return request('/api/v1/agent/plugins/' + encodeURIComponent(id), 'PATCH', patch);
}

export function deletePlugin(id: string): Promise<{ok: boolean}> {
 return request('/api/v1/agent/plugins/' + encodeURIComponent(id), 'DELETE');
}

// ---- Agent sessions and chat (M5) ------------------------------------------

export function getAgentSessions(projectId: string): Promise<{sessions: AgentSessionSummary[]}> {
 return request('/api/v1/agent/sessions' + query({projectId}));
}

export function getAgentTranscript(id: string): Promise<AgentTranscript> {
 return request('/api/v1/agent/sessions/' + encodeURIComponent(id));
}

// POST + stream SSE manually: the browser EventSource API cannot POST a message.
export function streamAgentChat({projectId, message, onEvent, signal}: {
 projectId: string;
 message: string;
 onEvent: (event: AgentStreamEvent) => void;
 signal?: AbortSignal;
}): {abort: () => void} {
 const controller = new AbortController();
 if (signal) signal.addEventListener('abort', () => controller.abort(), {once: true});
 void (async () => {
  try {
   const response = await fetch(backendBase + '/api/v1/agent/chat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({projectId, message}),
    signal: controller.signal,
   });
   if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    onEvent({type: 'error', error: (payload as {error?: string}).error || ('Request failed (' + response.status + ')')});
    return;
   }
   const body = response.body;
   if (!body) { onEvent({type: 'error', error: 'Agent stream is unavailable'}); return; }
   const reader = body.getReader();
   const decoder = new TextDecoder();
   let buffer = '';
   for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
     const chunk = buffer.slice(0, index);
     buffer = buffer.slice(index + 2);
     const line = chunk.split('\n').find(item => item.startsWith('data: '));
     if (line) {
      try { onEvent(JSON.parse(line.slice(6)) as AgentStreamEvent); } catch {}
     }
     index = buffer.indexOf('\n\n');
    }
   }
  } catch (error) {
   if (!controller.signal.aborted) {
    onEvent({type: 'error', error: error instanceof Error ? error.message : 'Agent run failed'});
   }
  }
 })();
 return {abort: () => controller.abort()};
}

export type {Role};
