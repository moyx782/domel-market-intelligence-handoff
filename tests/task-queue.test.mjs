import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTaskQueue, TASK_KINDS} from '../server/task-queue.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, {timeoutMs = 3000, stepMs = 5} = {}) {
 const deadline = Date.now() + timeoutMs;
 for (;;) {
  const value = await check();
  if (value) return value;
  if (Date.now() > deadline) throw Error('Condition was not met in time');
  await delay(stepMs);
 }
}

function makeQueue(t, options = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'domel-queue-'));
 const file = join(dir, 'tasks.json');
 const queue = openTaskQueue({file, ...options});
 t.after(() => {
  queue.stop();
  rmSync(dir, {recursive: true, force: true});
 });
 return {dir, file, queue};
}

test('creates, lists, reads and persists queued tasks in the documented shape', async t => {
 assert.deepEqual(TASK_KINDS, ['event.discover', 'event.enrich', 'source.collect', 'project.research', 'project.extract']);
 const {file, queue} = makeQueue(t);
 const task = await queue.create({kind: 'project.research', projectId: 'p1', priority: 2, payload: {mode: 'research'}});

 assert.equal(task.state, 'queued');
 assert.equal(task.priority, 2);
 assert.equal(task.effectivePriority, 2);
 assert.equal(task.attempts, 0);
 assert.equal(task.maxAttempts, 3);
 assert.equal(task.notBefore, 0);
 assert.equal(task.projectId, 'p1');
 assert.equal(task.eventId, null);
 assert.equal(task.sourceId, null);
 assert.deepEqual(task.payload, {mode: 'research'});
 assert.equal(task.progress, 'Queued');
 assert.equal(task.result, null);
 assert.equal(task.error, null);
 assert.equal(task.startedAt, null);
 assert.equal(task.finishedAt, null);
 assert.equal(task.log.length, 1);
 assert.equal(task.log[0].message, 'Queued');
 assert.ok(Number.isFinite(task.createdAt));
 assert.ok(Number.isFinite(task.updatedAt));

 assert.equal(queue.get(task.id).id, task.id);
 assert.equal(queue.get('missing'), null);
 assert.deepEqual(queue.stats(), {queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0});
 assert.equal(queue.list().length, 1);
 assert.equal(queue.list({kind: 'event.discover'}).length, 0);
 assert.equal(queue.list({kind: 'project.research', projectId: 'p1'}).length, 1);
 assert.equal(queue.list({projectId: 'other'}).length, 0);

 const raw = JSON.parse(readFileSync(file, 'utf8'));
 assert.equal(raw.version, 1);
 assert.ok(Array.isArray(raw.tasks));
 const stored = raw.tasks.find(item => item.id === task.id);
 assert.ok(stored);
 for (const key of ['id', 'kind', 'state', 'priority', 'effectivePriority', 'attempts', 'maxAttempts', 'notBefore',
  'projectId', 'eventId', 'sourceId', 'payload', 'progress', 'result', 'error', 'log', 'createdAt', 'updatedAt']) {
  assert.ok(key in stored, `persisted task is missing ${key}`);
 }
 assert.equal(stored.log[0].level, 'info');
});

test('runs higher priority first, then older tasks, with priority 3 highest', async t => {
 let clock = 1_000_000;
 const order = [];
 const {queue} = makeQueue(t, {
  now: () => clock,
  handlers: {'project.research': async ({task}) => {
   order.push(task.projectId);
   return {ran: task.projectId};
  }},
 });

 const first = await queue.create({kind: 'project.research', projectId: 'a', priority: 1});
 clock += 1;
 await queue.create({kind: 'project.research', projectId: 'b', priority: 1});
 clock += 1;
 await queue.create({kind: 'project.research', projectId: 'c', priority: 3});
 clock += 1;
 await queue.create({kind: 'project.research', projectId: 'd', priority: 0});

 queue.start();
 await queue.idle();

 assert.deepEqual(order, ['c', 'a', 'b', 'd']);
 const done = queue.get(first.id);
 assert.equal(done.state, 'succeeded');
 assert.deepEqual(done.result, {ran: 'a'});
 assert.equal(queue.stats().succeeded, 4);
});

test('anti-starvation raises effectivePriority while waiting and caps it at 3', async t => {
 let clock = 1_000_000;
 const starvationMs = 300000;
 const order = [];
 const {queue} = makeQueue(t, {
  now: () => clock,
  starvationMs,
  handlers: {'event.discover': async ({task}) => { order.push(task.eventId); }},
 });

 const low = await queue.create({kind: 'event.discover', eventId: 'low', priority: 0});
 clock += 2 * starvationMs;
 assert.equal(queue.get(low.id).effectivePriority, 2);
 await queue.create({kind: 'event.discover', eventId: 'high', priority: 1});
 assert.equal(queue.get(low.id).effectivePriority, 2);
 assert.equal(queue.list({eventId: 'high'})[0].effectivePriority, 1);

 queue.start();
 await queue.idle();
 // The P0 task waited long enough to outrank the freshly created P1 task.
 assert.deepEqual(order, ['low', 'high']);

 const starving = await queue.create({kind: 'event.discover', eventId: 'cap', priority: 0});
 clock += 100 * starvationMs;
 assert.equal(queue.get(starving.id).effectivePriority, 3);
});

test('retries with injected short delays and eventually succeeds', async t => {
 const starts = [];
 let calls = 0;
 const {queue} = makeQueue(t, {
  retryDelaysMs: [20, 30, 40],
  handlers: {'source.collect': async () => {
   calls += 1;
   starts.push(Date.now());
   if (calls < 3) throw Error('transient network error ' + calls);
   return {collected: 2};
  }},
 });

 queue.start();
 const task = await queue.create({kind: 'source.collect', sourceId: 'source-1', priority: 2});
 await queue.idle();

 const done = queue.get(task.id);
 assert.equal(done.state, 'succeeded');
 assert.equal(done.attempts, 3);
 assert.equal(done.error, null);
 assert.deepEqual(done.result, {collected: 2});
 assert.equal(starts.length, 3);
 assert.ok(starts[1] - starts[0] >= 10, 'second attempt waited for the retry delay');
 assert.ok(starts[2] - starts[1] >= 10, 'third attempt waited for the retry delay');
 assert.ok(done.log.some(entry => /transient network error 1/.test(entry.message) && entry.level === 'error'));
 assert.ok(done.log.some(entry => /Retry scheduled/.test(entry.message)));
});

test('default retry backoff follows 5s/30s/120s before the final attempt fails', async t => {
 let clock = 5_000_000;
 const attemptTimes = [];
 const {queue} = makeQueue(t, {
  now: () => clock,
  handlers: {'source.collect': async () => {
   attemptTimes.push(clock);
   throw Error('site unavailable');
  }},
 });

 queue.start();
 // maxAttempts=4 so all three documented delays are consumed before failing.
 const created = await queue.create({kind: 'source.collect', sourceId: 'src', maxAttempts: 4});

 await waitFor(() => {
  const current = queue.get(created.id);
  return current.state === 'queued' && current.attempts === 1;
 });
 assert.equal(queue.get(created.id).notBefore, 5_000_000 + 5000);

 clock += 5000;
 await waitFor(() => {
  const current = queue.get(created.id);
  return current.state === 'queued' && current.attempts === 2;
 });
 assert.equal(queue.get(created.id).notBefore, 5_000_000 + 5000 + 30000);

 clock += 30000;
 await waitFor(() => {
  const current = queue.get(created.id);
  return current.state === 'queued' && current.attempts === 3;
 });
 assert.equal(queue.get(created.id).notBefore, 5_000_000 + 5000 + 30000 + 120000);

 clock += 120000;
 await waitFor(() => queue.get(created.id).state === 'failed');
 const failed = queue.get(created.id);
 assert.equal(failed.attempts, 4);
 assert.equal(failed.error, 'site unavailable');
 assert.ok(Number.isFinite(failed.finishedAt));
 assert.deepEqual(attemptTimes, [5_000_000, 5_005_000, 5_035_000, 5_155_000]);
 assert.deepEqual(queue.stats(), {queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0});
});

test('gives up after maxAttempts starts (default 3)', async t => {
 let calls = 0;
 const {queue} = makeQueue(t, {
  retryDelaysMs: [0, 0, 0],
  handlers: {'project.research': async () => {
   calls += 1;
   throw Error('still failing ' + calls);
  }},
 });

 queue.start();
 const task = await queue.create({kind: 'project.research', projectId: 'p1'});
 await queue.idle();
 const failed = queue.get(task.id);
 assert.equal(failed.state, 'failed');
 assert.equal(failed.attempts, 3);
 assert.equal(failed.maxAttempts, 3);
 assert.equal(failed.error, 'still failing 3');
 assert.equal(calls, 3);
});

test('deduplicates queued tasks by kind and relation ids, and re-creates after cancel', async t => {
 const {queue} = makeQueue(t);

 const first = await queue.create({kind: 'event.discover', projectId: 'p1', eventId: 'e1', sourceId: 's1', priority: 2});
 const duplicate = await queue.create({kind: 'event.discover', projectId: 'p1', eventId: 'e1', sourceId: 's1', priority: 0});
 assert.equal(duplicate.id, first.id);
 assert.equal(duplicate.priority, 2);
 assert.equal(queue.list().length, 1);

 const otherEvent = await queue.create({kind: 'event.discover', projectId: 'p1', eventId: 'e2', sourceId: 's1'});
 assert.notEqual(otherEvent.id, first.id);

 await queue.cancel(first.id);
 const recreated = await queue.create({kind: 'event.discover', projectId: 'p1', eventId: 'e1', sourceId: 's1'});
 assert.notEqual(recreated.id, first.id);
 assert.equal(queue.list().length, 3);
});

test('cancels queued tasks immediately and rejects state conflicts', async t => {
 const {queue} = makeQueue(t, {handlers: {'source.collect': async () => {}}});
 const task = await queue.create({kind: 'source.collect', sourceId: 's1'});

 const cancelled = await queue.cancel(task.id);
 assert.equal(cancelled.state, 'cancelled');
 assert.ok(Number.isFinite(cancelled.finishedAt));
 assert.equal(cancelled.progress, 'Cancelled');
 assert.equal(cancelled.log.at(-1).message, 'Cancelled');
 assert.equal(cancelled.log.at(-1).level, 'warn');
 assert.deepEqual(queue.stats(), {queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 1});

 await assert.rejects(queue.cancel(task.id), /Task is cancelled/);
 await assert.rejects(queue.cancel('missing'), /Task not found/);
 assert.equal(queue.list({state: 'cancelled'}).length, 1);
 assert.equal(queue.list({state: 'queued'}).length, 0);
});

test('cancelling a running task aborts the handler signal and ends cancelled', async t => {
 let aborted = false;
 const {queue} = makeQueue(t, {
  handlers: {'project.research': ({signal}) => new Promise((resolve, reject) => {
   signal.addEventListener('abort', () => {
    aborted = true;
    reject(Error('aborted by test'));
   }, {once: true});
  })},
 });

 queue.start();
 const task = await queue.create({kind: 'project.research', projectId: 'p1'});
 await waitFor(() => queue.get(task.id).state === 'running');

 // A running task is reused by dedupe and cannot be retried.
 const duplicate = await queue.create({kind: 'project.research', projectId: 'p1'});
 assert.equal(duplicate.id, task.id);
 await assert.rejects(queue.retry(task.id), /Task is running/);

 const requested = await queue.cancel(task.id);
 assert.equal(requested.state, 'running');
 assert.equal(requested.cancelRequested, true);

 await waitFor(() => queue.get(task.id).state === 'cancelled');
 assert.equal(aborted, true);
 const done = queue.get(task.id);
 assert.ok(Number.isFinite(done.finishedAt));
 assert.equal(done.log.at(-1).message, 'Cancelled');
});

test('a run cancelled while the handler ignores abort still ends cancelled, not succeeded', async t => {
 const {queue} = makeQueue(t, {
  handlers: {'project.research': () => new Promise(resolve => {
   // Deliberately ignores `signal`: cancellation has to win once the handler settles.
   setTimeout(() => resolve('finished anyway'), 40);
  })},
 });

 queue.start();
 const task = await queue.create({kind: 'project.research', projectId: 'p1'});
 await waitFor(() => queue.get(task.id).state === 'running');
 await queue.cancel(task.id);

 await waitFor(() => queue.get(task.id).state === 'cancelled');
 const done = queue.get(task.id);
 assert.equal(done.state, 'cancelled');
 assert.equal(done.result, null);
 assert.ok(Number.isFinite(done.finishedAt));
});

test('retry requeues failed tasks and resets their counters', async t => {
 let calls = 0;
 const {queue} = makeQueue(t, {
  handlers: {'project.research': async () => {
   calls += 1;
   if (calls === 1) throw Error('first attempt failed');
   return {ok: true};
  }},
 });

 queue.start();
 const task = await queue.create({kind: 'project.research', projectId: 'p1', maxAttempts: 1});
 await waitFor(() => queue.get(task.id).state === 'failed');
 assert.equal(queue.get(task.id).attempts, 1);

 const requeued = await queue.retry(task.id);
 assert.equal(requeued.state, 'queued');
 assert.equal(requeued.attempts, 0);
 assert.equal(requeued.error, null);
 assert.equal(requeued.notBefore, 0);
 assert.equal(requeued.finishedAt, null);

 await queue.idle();
 const done = queue.get(task.id);
 assert.equal(done.state, 'succeeded');
 assert.equal(done.attempts, 1);
 assert.deepEqual(done.result, {ok: true});

 await assert.rejects(queue.retry(task.id), /Task is succeeded/);
 await assert.rejects(queue.retry('missing'), /Task not found/);
});

test('recovers running tasks as queued after restarting on the same file', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'domel-queue-'));
 const file = join(dir, 'tasks.json');
 const before = openTaskQueue({file, handlers: {'project.research': () => new Promise(() => {})}});
 let after = null;
 t.after(() => {
  before.stop();
  after?.stop();
  rmSync(dir, {recursive: true, force: true});
 });

 before.start();
 const created = await before.create({kind: 'project.research', projectId: 'p1'});
 await waitFor(() => before.get(created.id).state === 'running');
 before.stop();

 after = openTaskQueue({file, handlers: {'project.research': async () => ({recovered: true})}});
 const recovered = after.get(created.id);
 assert.equal(recovered.state, 'queued');
 assert.equal(recovered.attempts, 1, 'attempts must survive the restart');
 assert.equal(recovered.cancelRequested, false);
 assert.equal(recovered.log.at(-1).message, 'Recovered after restart');
 assert.equal(recovered.log.at(-1).level, 'warn');

 after.start();
 await after.idle();
 const done = after.get(created.id);
 assert.equal(done.state, 'succeeded');
 assert.equal(done.attempts, 2);
 assert.deepEqual(done.result, {recovered: true});
});

test('permanent handler errors fail immediately without retrying', async t => {
 let calls = 0;
 const {queue} = makeQueue(t, {
  retryDelaysMs: [10, 10, 10],
  handlers: {'event.enrich': async () => {
   calls += 1;
   const error = Error('blocked by site');
   error.permanent = true;
   throw error;
  }},
 });

 queue.start();
 const task = await queue.create({kind: 'event.enrich', eventId: 'e1'});
 await waitFor(() => queue.get(task.id).state === 'failed');
 assert.equal(queue.get(task.id).attempts, 1);
 assert.equal(queue.get(task.id).error, 'blocked by site');

 // With retryDelaysMs at 10ms a retry would already have happened by now.
 await delay(80);
 assert.equal(calls, 1);
 assert.equal(queue.get(task.id).state, 'failed');
});

test('a task kind without a handler fails permanently with a clear message', async t => {
 const {queue} = makeQueue(t, {handlers: {}});
 queue.start();
 const task = await queue.create({kind: 'event.discover', projectId: 'p1'});

 await queue.idle();
 const failed = queue.get(task.id);
 assert.equal(failed.state, 'failed');
 assert.equal(failed.error, 'No handler for event.discover');
 assert.equal(failed.attempts, 1);
});

test('subscribe emits a snapshot first, then task events until unsubscribed', async t => {
 const events = [];
 const {queue} = makeQueue(t, {
  handlers: {'project.research': async ({update, log}) => {
   await update({progress: 'halfway'});
   await log('found three candidates', 'warn');
   return {count: 3};
  }},
 });

 const unsubscribe = queue.subscribe(event => events.push(event));
 assert.equal(events.length, 1);
 assert.equal(events[0].type, 'snapshot');
 assert.deepEqual(events[0].tasks, []);
 assert.deepEqual(events[0].stats, {queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0});

 queue.start();
 const task = await queue.create({kind: 'project.research', projectId: 'p1'});
 await queue.idle();

 const taskEvents = events.filter(event => event.type === 'task');
 assert.ok(taskEvents.length >= 4);
 assert.ok(taskEvents.some(event => event.task.state === 'running'));
 assert.ok(taskEvents.some(event => event.task.progress === 'halfway'), 'update({progress}) must be published');
 const logged = taskEvents.find(event => event.task.log.some(entry => entry.message === 'found three candidates'));
 assert.ok(logged, 'update({log, level}) must be published');
 assert.equal(logged.task.log.find(entry => entry.message === 'found three candidates').level, 'warn');
 assert.equal(taskEvents.at(-1).task.state, 'succeeded');
 assert.equal(taskEvents.at(-1).task.log.at(-1).message, 'Finished');

 const seen = events.length;
 unsubscribe();
 await queue.create({kind: 'project.research', projectId: 'p2'});
 await delay(40);
 assert.equal(events.length, seen, 'unsubscribed listeners must not receive events');
});

test('persists the final state atomically with at most 60 log entries', async t => {
 const {file, queue} = makeQueue(t, {
  handlers: {'event.discover': async ({log, update}) => {
   for (let index = 0; index < 100; index += 1) await log('step ' + index);
   await update({progress: 'assembled'});
   return {found: 3};
  }},
 });

 queue.start();
 const task = await queue.create({
  kind: 'event.discover',
  projectId: 'p1',
  priority: 2,
  payload: {query: 'motors', limit: 30},
 });
 await queue.idle();
 queue.stop();

 const raw = JSON.parse(readFileSync(file, 'utf8'));
 assert.equal(raw.version, 1);
 assert.ok(Array.isArray(raw.tasks));
 assert.equal(raw.tasks.length, 1);
 const stored = raw.tasks[0];
 assert.equal(stored.id, task.id);
 assert.equal(stored.state, 'succeeded');
 assert.equal(stored.kind, 'event.discover');
 assert.equal(stored.priority, 2);
 assert.equal(stored.effectivePriority, 2);
 assert.equal(stored.attempts, 1);
 assert.equal(stored.maxAttempts, 3);
 assert.equal(stored.notBefore, 0);
 assert.deepEqual(stored.payload, {query: 'motors', limit: 30});
 assert.equal(stored.progress, 'Finished');
 assert.deepEqual(stored.result, {found: 3});
 assert.equal(stored.error, null);
 assert.ok(Number.isFinite(stored.finishedAt));
 assert.equal(stored.log.length, 60, 'log must be capped at 60 entries');
 assert.equal(stored.log.at(-1).message, 'Finished');
 for (const entry of stored.log) {
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof entry.message, 'string');
  assert.ok(['info', 'warn', 'error'].includes(entry.level));
 }
 assert.equal(existsSync(file + '.tmp'), false, 'atomic write must not leave a temp file behind');
 assert.equal(queue.get(task.id).log.length, 60);
});
