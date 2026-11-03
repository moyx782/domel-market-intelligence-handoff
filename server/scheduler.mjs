// Source scheduler: turns "due sources" into queued source.collect tasks.
//
// The scheduler is deliberately dumb: it never mutates registry state. The task
// handler owns markRunning/markResult, so a task that fails or is cancelled is
// always reported back and a source can never get stuck in `running` just
// because its task never executed. Dedupe is the task queue's job as well, so a
// source that is already queued is naturally not enqueued twice.

export function createScheduler({registry, queue, intervalMs = 30_000, now = () => Date.now(), onError, onSchedule} = {}) {
 if (!registry || typeof registry.due !== 'function') throw Error('Scheduler requires a source registry');
 if (!queue || typeof queue.create !== 'function') throw Error('Scheduler requires a task queue');

 const period = Math.max(100, Math.trunc(Number(intervalMs)) || 30_000);
 let timer = null;
 let ticking = null;

 function report(error, source = null) {
  if (typeof onError !== 'function') return;
  try {
   onError(error, source);
  } catch {
   // An observability callback must never break scheduling.
  }
 }

 async function runTick() {
  let sources = [];
  try {
   sources = registry.due(now()) ?? [];
  } catch (error) {
   report(error);
   return [];
  }
  const created = [];
  for (const source of sources) {
   try {
    const task = await queue.create({
     kind: 'source.collect',
     sourceId: source.id,
     priority: source.priority ?? 1,
     payload: {sourceId: source.id, url: source.url},
    });
    created.push(task);
    if (typeof onSchedule === 'function') {
     try { onSchedule(source, task); } catch { /* observability only */ }
    }
   } catch (error) {
    // One unreachable/bad source must not stop the rest of the tick.
    report(error, source);
   }
  }
  return created;
 }

 function tick() {
  // Coalesce overlapping ticks: a slow queue.create must not let two timers
  // enqueue the same due source population twice.
  if (ticking) return ticking;
  ticking = runTick().finally(() => { ticking = null; });
  return ticking;
 }

 return {
  intervalMs: period,
  tick,
  start() {
   if (timer) return;
   timer = setInterval(() => { void tick(); }, period);
   timer.unref?.();
   void tick();
  },
  stop() {
   if (timer) clearInterval(timer);
   timer = null;
  },
  get running() {
   return Boolean(timer);
  },
 };
}
