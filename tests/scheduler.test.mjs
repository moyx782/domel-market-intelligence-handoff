import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSourceRegistry} from '../server/source-registry.mjs';
import {createScheduler} from '../server/scheduler.mjs';

const fixed = 1_800_000_000_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempScope() {
 const dir = mkdtempSync(join(tmpdir(), 'domel-scheduler-'));
 return {
  dir,
  file: join(dir, 'source-registry.json'),
  cleanup() {
   rmSync(dir, {recursive: true, force: true});
  },
 };
}

function fakeQueue() {
 const calls = [];
 const failures = new Set();
 return {
  calls,
  failFor(sourceId) {
   failures.add(sourceId);
  },
  async create(input) {
   calls.push(structuredClone(input));
   if (failures.has(input.sourceId)) throw Error(`queue rejected ${input.sourceId}`);
   return {id: `task-${calls.length}`, state: 'queued', ...structuredClone(input)};
  },
 };
}

function sourceInput(overrides = {}) {
 return {
  url: 'https://www.example.com/exhibitions',
  title: '示例来源',
  type: 'organizer',
  region: 'cn',
  priority: 2,
  intervalSec: 3600,
  ...overrides,
 };
}

test('tick enqueues source.collect tasks for due sources without touching registry state', async () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file, now: () => fixed});
  const due = registry.create(sourceInput({url: 'https://www.example.com/due', priority: 3}));
  const disabled = registry.create(sourceInput({url: 'https://www.example.com/off'}));
  registry.update(disabled.id, {enabled: false});
  const paused = registry.create(sourceInput({url: 'https://www.example.com/paused'}));
  registry.markResult(paused.id, {ok: false, blocked: true, nowMs: fixed});
  const future = registry.create(sourceInput({url: 'https://www.example.com/future', intervalSec: 600}));
  registry.markResult(future.id, {ok: true, nowMs: fixed});

  const queue = fakeQueue();
  const scheduler = createScheduler({registry, queue, now: () => fixed});
  const created = await scheduler.tick();

  assert.equal(created.length, 1);
  assert.equal(queue.calls.length, 1);
  assert.equal(queue.calls[0].kind, 'source.collect');
  assert.equal(queue.calls[0].sourceId, due.id);
  assert.equal(queue.calls[0].priority, 3);
  assert.deepEqual(queue.calls[0].payload, {sourceId: due.id, url: due.url});

  // The task handler owns markRunning/markResult, so the scheduler must not
  // change the source state it just enqueued.
  const after = registry.get(due.id);
  assert.equal(after.status, 'idle');
  assert.equal(after.nextRunAt, null);
  assert.equal(after.lastRunAt, null);
  assert.equal(registry.get(paused.id).status, 'paused');
 }
 finally {
  scope.cleanup();
 }
});

test('tick passes registry.due() the injected clock', async () => {
 const dueCalls = [];
 const registry = {
  due(nowMs) {
   dueCalls.push(nowMs);
   return [];
  },
 };
 const queue = fakeQueue();
 const scheduler = createScheduler({registry, queue, now: () => fixed});
 await scheduler.tick();
 assert.deepEqual(dueCalls, [fixed]);
 assert.equal(queue.calls.length, 0);
});

test('one failing queue.create does not block other due sources', async () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file, now: () => fixed});
  const first = registry.create(sourceInput({url: 'https://a.example.com/one'}));
  const second = registry.create(sourceInput({url: 'https://b.example.com/two'}));
  const queue = fakeQueue();
  queue.failFor(first.id);
  const errors = [];
  const scheduler = createScheduler({registry, queue, now: () => fixed, onError: (error, source) => errors.push({error, source})});
  const created = await scheduler.tick();

  assert.equal(queue.calls.length, 2);
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceId, second.id);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source.id, first.id);
  assert.match(errors[0].error.message, /queue rejected/);
 }
 finally {
  scope.cleanup();
 }
});

test('a failing registry.due is reported instead of crashing the tick', async () => {
 const queue = fakeQueue();
 const errors = [];
 const scheduler = createScheduler({
  registry: {due() { throw Error('registry offline'); }},
  queue,
  onError: error => errors.push(error),
 });
 const created = await scheduler.tick();
 assert.deepEqual(created, []);
 assert.equal(errors.length, 1);
 assert.match(errors[0].message, /registry offline/);
});

test('start() ticks immediately and stop() stops the timer', async () => {
 const scope = tempScope();
 try {
  const registry = openSourceRegistry({file: scope.file, now: () => fixed});
  const source = registry.create(sourceInput({url: 'https://www.example.com/looping', intervalSec: 3600}));
  const queue = fakeQueue();
  const scheduler = createScheduler({registry, queue, now: () => fixed, intervalMs: 10});
  assert.equal(scheduler.running, false);

  scheduler.start();
  assert.equal(scheduler.running, true);
  assert.equal(scheduler.intervalMs, 100); // clamped to the 100ms safety floor
  for (let attempt = 0; attempt < 50 && queue.calls.length === 0; attempt += 1) await sleep(5);
  assert.ok(queue.calls.length >= 1);
  assert.equal(queue.calls[0].sourceId, source.id);

  scheduler.stop();
  assert.equal(scheduler.running, false);
  const settled = queue.calls.length;
  await sleep(60);
  assert.equal(queue.calls.length, settled);
 }
 finally {
  scope.cleanup();
 }
});

test('requires a registry and a queue', () => {
 assert.throws(() => createScheduler({queue: fakeQueue()}), /registry/);
 assert.throws(() => createScheduler({registry: {due: () => []}}), /queue/);
});
