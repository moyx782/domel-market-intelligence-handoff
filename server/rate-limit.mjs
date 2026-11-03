// Per-domain rate limiting for source collection.
//
// A crawler must not hammer a single host: every domain has one token (capacity
// 1), and the next request waits for max(configured interval, robots
// Crawl-delay, caller minimum) plus a random 0-5s jitter. 429/503 responses
// call backoff() so the whole domain pauses for Retry-After, and a 403/WAF
// response blocks the domain until a human confirms it.
//
// The clock is injectable so tests can verify scheduling without real sleeps;
// jitter can be switched off for deterministic assertions.

const DEFAULT_JITTER_MS = 5000;

function nonNegative(value, fallback = 0) {
 const number = Number(value);
 return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// Strict parse: acquire() only accepts http(s) URLs.
function urlDomain(value) {
 let parsed;
 try {
  parsed = value instanceof URL ? value : new URL(String(value));
 } catch {
  return null;
 }
 if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
 if (!parsed.hostname) return null;
 return parsed.hostname.toLowerCase();
}

// Lenient parse for management calls (blockDomain/backoff/intervalMs): accept a
// bare domain, host:port or full URL so callers do not have to normalise first.
function domainKey(value) {
 if (value instanceof URL) return value.hostname.toLowerCase();
 const raw = String(value ?? '').trim().toLowerCase();
 if (!raw) return '';
 if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return raw; }
 }
 const hostPart = raw.split(/[/?#]/)[0];
 try { return new URL('http://' + hostPart).hostname.toLowerCase(); } catch { return hostPart; }
}

function limiterError(code, message, extra = {}) {
 const error = new Error(message);
 error.code = code;
 Object.assign(error, extra);
 return error;
}

function domainBlockedError(domain, state) {
 const reason = state?.blockReason ? ': ' + state.blockReason : '';
 return limiterError('DOMAIN_BLOCKED', 'Domain is blocked' + reason + ' (' + domain + ')', {
  domain,
  permanent: true,
 });
}

export function createRateLimiter({
 now = () => Date.now(),
 defaultIntervalMs = 5000,
 defaultCrawlDelayMs = 0,
 jitter = true,
 jitterMs = DEFAULT_JITTER_MS,
 random = Math.random,
} = {}) {
 const configuredDefault = nonNegative(defaultIntervalMs, 5000);
 const configuredCrawlDelay = nonNegative(defaultCrawlDelayMs, 0);
 const jitterDisabled = jitter === false || Number(jitterMs) === 0;
 const configuredJitter = jitterDisabled ? 0 : nonNegative(jitterMs, DEFAULT_JITTER_MS);
 const domains = new Map();

 function stateFor(domain) {
  let state = domains.get(domain);
  if (!state) {
   state = {
    domain,
    nextAt: 0,
    backoffUntil: 0,
    intervalMs: null,
    blockedAt: null,
    blockReason: null,
    requests: 0,
    lastAcquiredAt: null,
    waiters: new Set(),
    tail: Promise.resolve(),
   };
   domains.set(domain, state);
  }
  return state;
 }

 function snapshot(state) {
  const current = now();
  return {
   domain: state.domain,
   intervalMs: state.intervalMs ?? configuredDefault,
   nextAt: state.nextAt,
   nextInMs: Math.max(0, state.nextAt - current),
   backoffUntil: state.backoffUntil,
   backoffInMs: Math.max(0, state.backoffUntil - current),
   blocked: Boolean(state.blockedAt),
   blockedAt: state.blockedAt,
   blockReason: state.blockReason,
   requests: state.requests,
   lastAcquiredAt: state.lastAcquiredAt,
   pending: state.waiters.size,
  };
 }

 // Waiting is interruptible: blockDomain() rejects live waiters immediately
 // instead of letting them fire one more request after the domain is banned.
 function waitTurn(state, waitMs) {
  return new Promise((resolve, reject) => {
   const waiter = {timer: null, reject};
   waiter.timer = setTimeout(() => {
    state.waiters.delete(waiter);
    resolve();
   }, Math.max(0, Math.ceil(waitMs)));
   state.waiters.add(waiter);
  });
 }

 async function runTurn(state, url, {crawlDelayMs, minIntervalMs}) {
  if (state.blockedAt) throw domainBlockedError(state.domain, state);
  const interval = Math.max(
   state.intervalMs ?? configuredDefault,
   Math.max(nonNegative(crawlDelayMs, 0), configuredCrawlDelay),
   nonNegative(minIntervalMs, 0),
  );
  const startedAt = now();
  for (;;) {
   if (state.blockedAt) throw domainBlockedError(state.domain, state);
   const target = Math.max(state.nextAt, state.backoffUntil);
   const remaining = target - now();
   if (remaining <= 0) break;
   const before = now();
   await waitTurn(state, remaining);
   // An injected clock that does not advance with wall time cannot tell us the
   // sleep finished; trust the timer instead of spinning forever.
   if (now() <= before && remaining > 0) break;
  }
  if (state.blockedAt) throw domainBlockedError(state.domain, state);
  const jitterWait = configuredJitter > 0 ? Math.floor(random() * configuredJitter) : 0;
  state.nextAt = now() + interval + jitterWait;
  state.requests += 1;
  state.lastAcquiredAt = now();
  return {domain: state.domain, url, intervalMs: interval, jitterMs: jitterWait, waitedMs: Math.max(0, now() - startedAt)};
 }

 function acquire(url, {crawlDelayMs = 0, minIntervalMs = 0} = {}) {
  const domain = urlDomain(url);
  if (!domain) {
   return Promise.reject(limiterError('INVALID_URL', 'Only http(s) URLs can be rate limited', {permanent: true}));
  }
  const state = stateFor(domain);
  if (state.blockedAt) return Promise.reject(domainBlockedError(domain, state));
  const run = () => runTurn(state, String(url), {crawlDelayMs, minIntervalMs});
  // Chain per-domain turns so capacity stays at one even under concurrent calls.
  const turn = state.tail.then(run, run);
  state.tail = turn.catch(() => {});
  return turn;
 }

 function setIntervalMs(domain, ms) {
  const key = domainKey(domain);
  if (!key) throw limiterError('INVALID_DOMAIN', 'A domain is required');
  const interval = Number(ms);
  if (!Number.isFinite(interval) || interval < 0) throw limiterError('INVALID_INTERVAL', 'Interval must be a non-negative number of milliseconds');
  const state = stateFor(key);
  state.intervalMs = interval;
  return snapshot(state);
 }

 function intervalMs(domain) {
  const key = domainKey(domain);
  const state = domains.get(key);
  return state?.intervalMs ?? configuredDefault;
 }

 function blockDomain(domain, {reason = ''} = {}) {
  const key = domainKey(domain);
  if (!key) throw limiterError('INVALID_DOMAIN', 'A domain is required');
  const state = stateFor(key);
  if (state.blockedAt) return snapshot(state);
  state.blockedAt = now();
  state.blockReason = String(reason ?? '');
  for (const waiter of [...state.waiters]) {
   clearTimeout(waiter.timer);
   waiter.reject(domainBlockedError(key, state));
  }
  state.waiters.clear();
  return snapshot(state);
 }

 function isBlocked(domain) {
  const key = domainKey(domain);
  return Boolean(domains.get(key)?.blockedAt);
 }

 // 429/503: full-domain pause. A larger existing pause is never shortened.
 function backoff(domain, retryAfterMs) {
  const key = domainKey(domain);
  if (!key) throw limiterError('INVALID_DOMAIN', 'A domain is required');
  const requested = Number(retryAfterMs);
  const delay = Number.isFinite(requested) && requested > 0 ? requested : configuredDefault;
  const state = stateFor(key);
  state.backoffUntil = Math.max(state.backoffUntil, now() + delay);
  return state.backoffUntil;
 }

 function state() {
  return {
   defaultIntervalMs: configuredDefault,
   defaultCrawlDelayMs: configuredCrawlDelay,
   jitterMs: configuredJitter,
   domains: [...domains.values()].map(snapshot),
  };
 }

 function reset() {
  for (const state of domains.values()) {
   for (const waiter of [...state.waiters]) {
    clearTimeout(waiter.timer);
    waiter.reject(limiterError('RESET', 'Rate limiter was reset while waiting', {permanent: true}));
   }
   state.waiters.clear();
  }
  domains.clear();
 }

 return {
  acquire,
  setIntervalMs,
  intervalMs,
  blockDomain,
  isBlocked,
  backoff,
  state,
  reset,
 };
}
