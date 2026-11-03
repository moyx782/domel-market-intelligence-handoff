// Durable single-host task queue for the demo.
//
// Tasks are stored in one JSON file, claimed in priority order, retried with a
// short backoff and reported to subscribers. One worker runs at a time so the
// demo never hammers a provider or a website; the loop is the same for research
// runs today and for crawler / agent jobs later.

import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const now = () => Date.now();
const BACKOFF_MS = 5000;

const log = (task, message, level = 'info') => {
 task.log = [...(task.log ?? []), {at: new Date().toISOString(), message, level}].slice(-60);
};

export function openTaskQueue({file, handler, concurrency = 1}) {
 let state = {tasks: []};
 try {
  state = JSON.parse(readFileSync(file, 'utf8'));
 } catch {}
 if (!Array.isArray(state.tasks)) state.tasks = [];
 // A process that died mid-run leaves running tasks behind; make them runnable.
 for (const task of state.tasks) {
  if (task.state === 'running') {
   task.state = 'queued';
   task.progress = 'Restarted after an interrupted run';
   task.updatedAt = now();
  }
 }

 const listeners = new Set();
 const controllers = new Map();
 let timer = null;
 let running = 0;
 let closed = false;
 let chain = Promise.resolve();

 const emit = event => {
  for (const listener of listeners) {
   try { listener(event); } catch {}
  }
 };

 const persist = () => {
  mkdirSync(dirname(file), {recursive: true});
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
 };

 const mutate = work => {
  const run = chain.then(() => {
   const result = work(state);
   persist();
   emit({type: 'tasks', tasks: publicTasks()});
   return result ? structuredClone(result) : undefined;
  });
  chain = run.catch(() => {});
  return run;
 };

 const find = id => state.tasks.find(task => task.id === id);

 const publicTask = task => ({
  ...structuredClone(task),
  log: task.log ?? [],
 });

 function publicTasks() {
  return state.tasks.map(publicTask);
 }

 function dueTask() {
  const stamp = now();
  return state.tasks
   .filter(task => task.state === 'queued' && (!task.notBefore || task.notBefore <= stamp))
   .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))[0];
 }

 async function tick() {
  if (closed || running >= concurrency) return;
  const task = dueTask();
  if (!task) return;
  running += 1;
  controllers.set(task.id, new AbortController());
  try {
   await mutate(state => {
    const current = find(task.id);
    current.state = 'running';
    current.attempts = (current.attempts ?? 0) + 1;
    current.startedAt = now();
    current.updatedAt = now();
    current.progress = 'Running';
    current.error = null;
    log(current, `Attempt ${current.attempts} started`);
   });
   emit({type: 'task', task: publicTask(find(task.id))});

   const controller = controllers.get(task.id);
   const update = changes => mutate(state => {
    const current = find(task.id);
    if (!current) return;
    if (changes.progress !== undefined) current.progress = changes.progress;
    if (changes.result !== undefined) current.result = changes.result;
    if (changes.log) log(current, changes.log, changes.level ?? 'info');
    current.updatedAt = now();
   }).then(() => emit({type: 'task', task: publicTask(find(task.id))}));

   await handler({
    task: publicTask(task),
    signal: controller.signal,
    update,
   });

   await mutate(state => {
    const current = find(task.id);
    if (!current) return;
    if (current.cancelRequested) {
     current.state = 'cancelled';
     current.finishedAt = now();
     log(current, 'Cancelled', 'warn');
    } else {
     current.state = 'succeeded';
     current.progress = 'Finished';
     current.finishedAt = now();
     log(current, 'Finished');
    }
    current.updatedAt = now();
   });
  } catch (error) {
   const message = error instanceof Error ? error.message : 'Task failed';
   await mutate(state => {
    const current = find(task.id);
    if (!current) return;
    current.error = message;
    current.updatedAt = now();
    if (current.cancelRequested) {
     current.state = 'cancelled';
     current.finishedAt = now();
     log(current, 'Cancelled', 'warn');
    } else if (current.attempts < (current.maxAttempts ?? 2)) {
     current.state = 'queued';
     current.notBefore = now() + BACKOFF_MS * current.attempts;
     current.progress = `Retry ${current.attempts} scheduled`;
     log(current, message, 'error');
    } else {
     current.state = 'failed';
     current.finishedAt = now();
     current.progress = 'Failed';
     log(current, message, 'error');
    }
   });
  } finally {
   controllers.delete(task.id);
   running -= 1;
   emit({type: 'task', task: publicTask(find(task.id))});
   if (!closed) setTimeout(() => void tick(), 50).unref?.();
  }
 }

 function schedule() {
  if (closed || timer) return;
  timer = setInterval(() => void tick(), 500);
  timer.unref?.();
  void tick();
 }

 return {
  file,

  start() {
   closed = false;
   schedule();
  },

  stop() {
   closed = true;
   if (timer) clearInterval(timer);
   timer = null;
   for (const controller of controllers.values()) controller.abort();
  },

  list({projectId, state: wanted} = {}) {
   return state.tasks
    .filter(task => (!projectId || task.projectId === projectId) && (!wanted || task.state === wanted))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicTask);
  },

  get(id) {
   const task = find(id);
   return task ? publicTask(task) : null;
  },

  stats() {
   const counts = {queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0};
   for (const task of state.tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
   return counts;
  },

  create({kind, projectId, projectTitle = '', mode = null, priority = 1, payload = {}, maxAttempts = 2}) {
   return mutate(state => {
    const active = state.tasks.find(task =>
     task.kind === kind && task.projectId === projectId && task.mode === mode &&
     (task.state === 'queued' || task.state === 'running'));
    if (active) return active;
    const stamp = now();
    const task = {
     id: randomUUID(),
     kind,
     projectId,
     projectTitle,
     mode,
     priority: Math.max(0, Math.min(3, Number(priority) || 0)),
     payload,
     state: 'queued',
     attempts: 0,
     maxAttempts,
     progress: 'Queued',
     error: null,
     log: [],
     createdAt: stamp,
     updatedAt: stamp,
     notBefore: 0,
    };
    log(task, 'Queued');
    state.tasks.push(task);
    return task;
   }).then(task => {
    emit({type: 'task', task: publicTask(task)});
    void tick();
    return task;
   });
  },

  cancel(id) {
   const run = mutate(state => {
    const task = find(id);
    if (!task) throw Error('Task not found');
    if (task.state === 'queued') {
     task.state = 'cancelled';
     task.finishedAt = now();
     task.updatedAt = now();
     log(task, 'Cancelled', 'warn');
    } else if (task.state === 'running') {
     task.cancelRequested = true;
     task.updatedAt = now();
     controllers.get(id)?.abort();
     log(task, 'Cancellation requested', 'warn');
    }
    return task;
   });
   return run.then(task => {
    emit({type: 'task', task: publicTask(task)});
    return task;
   });
  },

  retry(id) {
   return mutate(state => {
    const task = find(id);
    if (!task) throw Error('Task not found');
    if (task.state === 'running') throw Error('Task is running');
    task.state = 'queued';
    task.attempts = 0;
    task.error = null;
    task.progress = 'Queued';
    task.notBefore = 0;
    task.cancelRequested = false;
    task.finishedAt = null;
    task.updatedAt = now();
    log(task, 'Requeued');
    return task;
   }).then(task => {
    emit({type: 'task', task: publicTask(task)});
    void tick();
    return task;
   });
  },

  subscribe(listener) {
   listeners.add(listener);
   listener({type: 'snapshot', tasks: publicTasks(), stats: this.stats()});
   return () => listeners.delete(listener);
  },
 };
}
