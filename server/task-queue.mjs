// Durable single-host task queue for the demo.
//
// Every task runs through this one queue (research, source collection, event
// discovery) so a process restart never loses work, and the scheduler can back
// off a failing website instead of hammering it. State lives in one JSON file
// written atomically after every change; the in-memory copy is the source of
// truth while the process is alive. Handlers get an AbortSignal so cancelling a
// running task is real, not just a flag the UI shows.
//
// Why a hand-written queue instead of a library: this is a single-user local
// demo, the contract is small (docs/TEAM_CONTRACTS.md §3) and swapping in
// Postgres/Redis later only requires replacing this module.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export const TASK_KINDS = ['event.discover', 'event.enrich', 'source.collect', 'project.research', 'project.extract'];

// The queue is polled, not event-driven: 50ms keeps the UI/SSE and tests snappy
// while never busy-waiting. Retry delays (seconds to minutes) are coarse enough
// that this resolution is plenty.
const TICK_MS = 50;
const IDLE_POLL_MS = 10;
const MAX_LOG_ENTRIES = 60;
const STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const LOG_LEVELS = ['info', 'warn', 'error'];
const DEFAULT_RETRY_DELAYS_MS = [5000, 30000, 120000];

const clampPriority = value => {
 const number = Math.trunc(Number(value));
 if (!Number.isFinite(number)) return 1;
 return Math.max(0, Math.min(3, number));
};

const isActive = task => task.state === 'queued' || task.state === 'running';

const errorMessage = error => {
 if (error instanceof Error) return error.message;
 if (error && typeof error.message === 'string') return error.message;
 return String(error ?? 'Task failed');
};

const isPermanent = error => !!error && error.permanent === true;

/**
 * Open (or create) the persistent task queue stored at `file`.
 *
 * All read methods return plain cloned objects; mutating methods return
 * promises because state changes are serialised and persisted before resolving.
 */
export function openTaskQueue({
 file,
 concurrency = 1,
 handlers = {},
 retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
 starvationMs = 300000,
 now = () => Date.now(),
}) {
 if (!file) throw Error('Task queue requires a file path');

 const limit = Math.max(1, Math.trunc(Number(concurrency)) || 1);
 const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length
  ? retryDelaysMs.map(value => Math.max(0, Math.trunc(Number(value)) || 0))
  : [...DEFAULT_RETRY_DELAYS_MS];
 const registeredHandlers = {...handlers};

 let state = {version: 1, tasks: []};
 try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed && Array.isArray(parsed.tasks)) state = {version: 1, tasks: parsed.tasks};
 } catch (error) {
  // ENOENT is the normal first-run case; anything else means a damaged file and
  // starting empty is safer than crashing the whole demo on boot.
  if (error?.code !== 'ENOENT') console.warn(`[task-queue] Could not read ${file}: ${errorMessage(error)}`);
 }

 const listeners = new Set();
 const controllers = new Map();
 let chain = Promise.resolve();
 let started = false;
 let timer = null;
 let executing = 0;
 let dispatching = false;

 const find = id => state.tasks.find(task => task.id === id);

 // Effective priority grows while a task waits so low-priority work cannot be
 // starved forever by an endless stream of P0 jobs (plan §7.2).
 const effectivePriorityOf = (task, timestamp) =>
  Math.min(3, (task.priority ?? 0) + Math.floor((timestamp - Math.max(task.createdAt ?? 0, 0)) / starvationMs));

 const appendLog = (task, message, level = 'info') => {
  const safeLevel = LOG_LEVELS.includes(level) ? level : 'info';
  const entry = {at: new Date(now()).toISOString(), message: String(message), level: safeLevel};
  task.log = [...(task.log ?? []), entry].slice(-MAX_LOG_ENTRIES);
 };

 const publicTask = task => {
  const copy = structuredClone(task);
  copy.effectivePriority = effectivePriorityOf(task, now());
  copy.log = copy.log ?? [];
  return copy;
 };

 const countStats = () => {
  const stats = {queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0};
  for (const task of state.tasks) stats[task.state] = (stats[task.state] ?? 0) + 1;
  return stats;
 };

 // Persist the whole queue. temp file + rename is atomic on POSIX, so a crash
 // never leaves a half-written tasks.json for the next boot to choke on.
 const persist = () => {
  mkdirSync(dirname(file), {recursive: true});
  const timestamp = now();
  const payload = {
   version: 1,
   tasks: state.tasks.map(task => ({...task, effectivePriority: effectivePriorityOf(task, timestamp)})),
  };
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(payload, null, 2));
  renameSync(temp, file);
 };

 const emit = event => {
  for (const listener of [...listeners]) {
   try { listener(event); } catch { /* a broken SSE subscriber must not break the queue */ }
  }
 };

 // All writes (dispatch, handler updates, cancel, retry) go through one promise
 // chain so two handlers calling update() concurrently cannot interleave.
 const serialise = work => {
  const run = chain.then(() => work());
  chain = run.then(() => undefined, () => undefined);
  return run;
 };

 const taskEvent = task => ({type: 'task', task: publicTask(task)});
 const snapshot = () => ({type: 'snapshot', tasks: sortedTasks().map(publicTask), stats: countStats()});

 const sortedTasks = () => [...state.tasks].sort((a, b) =>
  (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

 const dueTask = timestamp => state.tasks
  .filter(task => task.state === 'queued' && (task.notBefore ?? 0) <= timestamp)
  .map(task => ({task, effective: effectivePriorityOf(task, timestamp)}))
  .sort((a, b) =>
   b.effective - a.effective ||
   (a.task.createdAt ?? 0) - (b.task.createdAt ?? 0) ||
   (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0))[0]?.task ?? null;

 const retryDelayFor = attempt => delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)];

 // ---- init: normalise old/corrupt records, recover interrupted runs ---------

 for (const task of state.tasks) {
  task.state = STATES.includes(task.state) ? task.state : 'queued';
  task.priority = clampPriority(task.priority);
  task.maxAttempts = Math.max(1, Math.trunc(Number(task.maxAttempts)) || 3);
  task.attempts = Math.max(0, Math.trunc(Number(task.attempts)) || 0);
  task.notBefore = Math.abs(Number(task.notBefore)) || 0;
  task.projectId = task.projectId ?? null;
  task.eventId = task.eventId ?? null;
  task.sourceId = task.sourceId ?? null;
  task.payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
  task.progress = typeof task.progress === 'string' ? task.progress : '';
  task.result = task.result ?? null;
  task.error = task.error ?? null;
  task.log = Array.isArray(task.log) ? task.log.slice(-MAX_LOG_ENTRIES) : [];
  task.createdAt = Number(task.createdAt) || now();
  task.updatedAt = Number(task.updatedAt) || task.createdAt;
  task.startedAt = Number.isFinite(task.startedAt) ? task.startedAt : null;
  task.finishedAt = Number.isFinite(task.finishedAt) ? task.finishedAt : null;
  if (task.state === 'running') {
   // A process that died mid-run leaves the task "running" forever; make it
   // runnable again but keep attempts so crash loops still hit maxAttempts.
   task.state = 'queued';
   task.cancelRequested = false;
   task.progress = 'Queued';
   task.updatedAt = now();
   appendLog(task, 'Recovered after restart', 'warn');
  }
 }

 persist();

 // ---- scheduling ------------------------------------------------------------

 async function claim() {
  if (!started) return null;
  const claimed = await serialise(() => {
   if (!started) return null;
   const timestamp = now();
   const task = dueTask(timestamp);
   if (!task) return null;
   task.state = 'running';
   task.attempts = (task.attempts ?? 0) + 1;
   task.startedAt = timestamp;
   task.updatedAt = timestamp;
   task.progress = 'Running';
   task.error = null;
   appendLog(task, `Attempt ${task.attempts} started`);
   persist();
   return publicTask(task);
  });
  if (claimed) emit(taskEvent(find(claimed.id) ?? claimed));
  return claimed;
 }

 async function updateTask(id, changes = {}) {
  const updated = await serialise(() => {
   const task = find(id);
   // Late updates from a handler that already settled are harmless to drop.
   if (!task || task.state !== 'running') return null;
   if (changes.progress !== undefined) task.progress = changes.progress;
   if (changes.result !== undefined) task.result = changes.result;
   const messages = Array.isArray(changes.log) ? changes.log : changes.log === undefined ? [] : [changes.log];
   for (const message of messages) appendLog(task, message, changes.level ?? 'info');
   task.updatedAt = now();
   persist();
   return publicTask(task);
  });
  if (updated) emit({type: 'task', task: updated});
  return updated;
 }

 async function finalizeTask(id, {outcome, error}) {
  const updated = await serialise(() => {
   const task = find(id);
   if (!task || task.state !== 'running') return null;
   const timestamp = now();
   task.updatedAt = timestamp;

   if (task.cancelRequested) {
    // Cancel wins even when the handler resolves normally: the user asked for
    // this run to stop, so a late success must not be reported as succeeded.
    task.state = 'cancelled';
    task.finishedAt = timestamp;
    task.progress = 'Cancelled';
    appendLog(task, 'Cancelled', 'warn');
   } else if (error) {
    const message = errorMessage(error);
    task.error = message;
    if (isPermanent(error)) {
     task.state = 'failed';
     task.finishedAt = timestamp;
     task.progress = 'Failed';
     appendLog(task, message, 'error');
    } else if (task.attempts < task.maxAttempts) {
     const delay = retryDelayFor(task.attempts);
     task.state = 'queued';
     task.notBefore = timestamp + delay;
     task.progress = `Retry ${task.attempts}/${task.maxAttempts} scheduled`;
     appendLog(task, message, 'error');
     appendLog(task, `Retry scheduled in ${delay}ms`, 'warn');
    } else {
     task.state = 'failed';
     task.finishedAt = timestamp;
     task.progress = 'Failed';
     appendLog(task, message, 'error');
    }
   } else {
    task.state = 'succeeded';
    // Handlers may `return` their result instead of calling update({result}).
    if (outcome !== undefined) task.result = outcome;
    task.finishedAt = timestamp;
    task.progress = 'Finished';
    appendLog(task, 'Finished');
   }
   persist();
   return publicTask(task);
  });
  if (updated) emit({type: 'task', task: updated});
 }

 async function execute(task) {
  const controller = new AbortController();
  controllers.set(task.id, controller);
  try {
   const handler = registeredHandlers[task.kind];
   if (typeof handler !== 'function') {
    // No handler means the task can never progress: fail permanently instead of
    // leaving it queued forever behind a handler that will never be registered.
    const error = Error(`No handler for ${task.kind}`);
    error.permanent = true;
    throw error;
   }
   const current = find(task.id) ?? task;
   const outcome = await handler({
    task: publicTask(current),
    signal: controller.signal,
    update: changes => updateTask(task.id, changes),
    log: (message, level = 'info') => updateTask(task.id, {log: message, level}),
   });
   await finalizeTask(task.id, {outcome});
  } catch (error) {
   await finalizeTask(task.id, {error});
  } finally {
   controllers.delete(task.id);
   executing = Math.max(0, executing - 1);
   if (started) void tick();
  }
 }

 async function tick() {
  if (!started || dispatching) return;
  dispatching = true;
  try {
   while (started && executing < limit) {
    const task = await claim();
    if (!task) break;
    executing += 1;
    void execute(task);
   }
  } catch { /* keep the scheduler loop alive; individual failures are persisted */ } finally {
   dispatching = false;
  }
 }

 // ---- public methods --------------------------------------------------------

 async function createTask({
  kind,
  priority = 1,
  projectId = null,
  eventId = null,
  sourceId = null,
  payload = {},
  maxAttempts = 3,
 } = {}) {
  if (typeof kind !== 'string' || !kind.trim()) throw Error('Task kind is required');
  const request = {
   kind: kind.trim(),
   priority: clampPriority(priority),
   projectId: projectId ?? null,
   eventId: eventId ?? null,
   sourceId: sourceId ?? null,
   payload: payload && typeof payload === 'object' ? structuredClone(payload) : {},
   maxAttempts: Math.max(1, Math.trunc(Number(maxAttempts)) || 3),
  };

  const result = await serialise(() => {
   const duplicate = state.tasks.find(task =>
    isActive(task) &&
    task.kind === request.kind &&
    (task.projectId ?? null) === request.projectId &&
    (task.eventId ?? null) === request.eventId &&
    (task.sourceId ?? null) === request.sourceId);
   if (duplicate) return {task: duplicate, created: false};

   const timestamp = now();
   const task = {
    id: randomUUID(),
    kind: request.kind,
    state: 'queued',
    priority: request.priority,
    effectivePriority: request.priority,
    attempts: 0,
    maxAttempts: request.maxAttempts,
    notBefore: 0,
    projectId: request.projectId,
    eventId: request.eventId,
    sourceId: request.sourceId,
    payload: request.payload,
    progress: 'Queued',
    result: null,
    error: null,
    log: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
   };
   appendLog(task, 'Queued');
   state.tasks.push(task);
   persist();
   return {task, created: true};
  });

  if (result.created) {
   emit(taskEvent(result.task));
   if (started) void tick();
  }
  return publicTask(result.task);
 }

 function list({state: wantedState, kind, projectId, eventId, sourceId, limit: max = 200} = {}) {
  const filtered = state.tasks.filter(task => {
   if (wantedState && task.state !== wantedState) return false;
   if (kind && task.kind !== kind) return false;
   if (projectId !== undefined && (task.projectId ?? null) !== (projectId ?? null)) return false;
   if (eventId !== undefined && (task.eventId ?? null) !== (eventId ?? null)) return false;
   if (sourceId !== undefined && (task.sourceId ?? null) !== (sourceId ?? null)) return false;
   return true;
  });
  filtered.sort((a, b) =>
   (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const numericLimit = Math.trunc(Number(max));
  const size = Number.isFinite(numericLimit) ? Math.max(0, numericLimit) : 200;
  return filtered.slice(0, size).map(publicTask);
 }

 function get(id) {
  const task = find(id);
  return task ? publicTask(task) : null;
 }

 async function cancelTask(id) {
  let controller = null;
  const updated = await serialise(() => {
   const task = find(id);
   if (!task) throw Error('Task not found');
   const timestamp = now();
   if (task.state === 'queued') {
    task.state = 'cancelled';
    task.finishedAt = timestamp;
    task.updatedAt = timestamp;
    task.progress = 'Cancelled';
    appendLog(task, 'Cancelled', 'warn');
   } else if (task.state === 'running') {
    // Keep state=running until the handler actually settles so the worker slot
    // is not released under a handler that is still using it.
    task.cancelRequested = true;
    task.updatedAt = timestamp;
    appendLog(task, 'Cancellation requested', 'warn');
    controller = controllers.get(id) ?? null;
   } else {
    throw Error(`Task is ${task.state}`);
   }
   persist();
   return publicTask(task);
  });
  emit({type: 'task', task: updated});
  controller?.abort();
  return updated;
 }

 async function retryTask(id) {
  const updated = await serialise(() => {
   const task = find(id);
   if (!task) throw Error('Task not found');
   if (task.state === 'running') throw Error('Task is running');
   if (task.state !== 'failed' && task.state !== 'cancelled') throw Error(`Task is ${task.state}`);
   const timestamp = now();
   task.state = 'queued';
   task.attempts = 0;
   task.error = null;
   task.notBefore = 0;
   task.result = null;
   task.progress = 'Queued';
   task.cancelRequested = false;
   task.startedAt = null;
   task.finishedAt = null;
   task.updatedAt = timestamp;
   appendLog(task, 'Requeued by operator');
   persist();
   return publicTask(task);
  });
  emit({type: 'task', task: updated});
  if (started) void tick();
  return updated;
 }

 function subscribe(listener) {
  if (typeof listener !== 'function') throw Error('Task queue listener must be a function');
  listeners.add(listener);
  // New SSE clients and the Tasks page need a full picture before incremental
  // updates (plan §7.7 "断线补快照").
  try { listener(snapshot()); } catch { /* ignore a subscriber that throws on snapshot */ }
  return () => listeners.delete(listener);
 }

 function start() {
  if (started) return;
  started = true;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();
 }

 function stop() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
 }

 function idle({timeoutMs = 10000} = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  return new Promise((resolve, reject) => {
   const check = () => {
    if (!state.tasks.some(isActive)) return resolve();
    if (Date.now() >= deadline) return reject(Error('Timed out waiting for the task queue to become idle'));
    setTimeout(check, IDLE_POLL_MS);
   };
   check();
  });
 }

 return {
  file,
  start,
  stop,
  create: createTask,
  list,
  get,
  stats: countStats,
  cancel: cancelTask,
  retry: retryTask,
  subscribe,
  idle,
 };
}
