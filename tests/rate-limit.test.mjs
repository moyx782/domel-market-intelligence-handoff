import test from 'node:test';
import assert from 'node:assert/strict';
import {createRateLimiter} from '../server/rate-limit.mjs';

test('same-domain requests are serialised by the configured interval', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 50, jitter: false});
 const startedAt = Date.now();
 await limiter.acquire('https://slow.example/page-1');
 const firstAt = Date.now() - startedAt;
 await limiter.acquire('https://slow.example/page-2');
 const secondAt = Date.now() - startedAt;

 assert.ok(firstAt < 40, 'first request should not wait, took ' + firstAt + 'ms');
 assert.ok(secondAt - firstAt >= 40, 'second request should respect the interval, waited ' + (secondAt - firstAt) + 'ms');

 const snapshot = limiter.state();
 assert.equal(snapshot.domains.length, 1);
 assert.equal(snapshot.domains[0].domain, 'slow.example');
 assert.equal(snapshot.domains[0].requests, 2);
 assert.equal(snapshot.domains[0].blocked, false);
 assert.equal(snapshot.domains[0].intervalMs, 50);
});

test('different domains are scheduled independently', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 300, jitter: false});
 const startedAt = Date.now();
 await Promise.all([
  limiter.acquire('https://alpha.example/'),
  limiter.acquire('https://beta.example/'),
 ]);
 assert.ok(Date.now() - startedAt < 250, 'two domains should not wait for each other');
 assert.equal(limiter.state().domains.length, 2);
 assert.deepEqual(limiter.state().domains.map(domain => domain.domain).sort(), ['alpha.example', 'beta.example']);
});

test('robots crawl-delay and caller minimum interval take the larger value', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 20, jitter: false});
 await limiter.acquire('https://robots.example/one');
 await limiter.acquire('https://robots.example/two', {crawlDelayMs: 80});
 let startedAt = Date.now();
 await limiter.acquire('https://robots.example/three');
 assert.ok(Date.now() - startedAt >= 70, 'crawl-delay should delay the next request');

 await limiter.acquire('https://robots.example/four', {minIntervalMs: 120});
 startedAt = Date.now();
 await limiter.acquire('https://robots.example/five');
 assert.ok(Date.now() - startedAt >= 105, 'minIntervalMs should delay the next request');
});

test('backoff after 429 pushes the next request on that domain', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 10, jitter: false});
 await limiter.acquire('https://busy.example/one');
 const until = limiter.backoff('busy.example', 130);
 assert.ok(until > Date.now(), 'backoff should be in the future');
 const startedAt = Date.now();
 await limiter.acquire('https://busy.example/two');
 assert.ok(Date.now() - startedAt >= 115, 'request should wait for Retry-After');
 const snapshot = limiter.state();
 assert.equal(snapshot.domains[0].requests, 2);
});

test('blocked domains reject with DOMAIN_BLOCKED and stay blocked', async () => {
 const limiter = createRateLimiter({jitter: false});
 limiter.blockDomain('https://blocked.example/watch', {reason: 'HTTP 403 from WAF'});
 assert.equal(limiter.isBlocked('blocked.example'), true);
 assert.equal(limiter.isBlocked('other.example'), false);

 await assert.rejects(limiter.acquire('https://blocked.example/page'), error => {
  assert.equal(error.code, 'DOMAIN_BLOCKED');
  assert.equal(error.permanent, true);
  assert.match(error.message, /blocked/i);
  return true;
 });

 const state = limiter.state();
 const blocked = state.domains.find(entry => entry.domain === 'blocked.example');
 assert.equal(blocked.blocked, true);
 assert.match(blocked.blockReason, /403/);
});

test('blocking interrupts a wait already in progress', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 5000, jitter: false});
 await limiter.acquire('https://long.example/one');
 const pending = limiter.acquire('https://long.example/two');
 const startedAt = Date.now();
 setTimeout(() => limiter.blockDomain('long.example', {reason: 'manual block'}), 40);
 await assert.rejects(pending, error => error.code === 'DOMAIN_BLOCKED');
 assert.ok(Date.now() - startedAt < 1000, 'block must not wait for the interval to elapse');
});

test('setIntervalMs/intervalMs adjust the per-domain interval', async () => {
 const limiter = createRateLimiter({defaultIntervalMs: 10, jitter: false});
 assert.equal(limiter.intervalMs('x.example'), 10);
 const updated = limiter.setIntervalMs('https://x.example/page', 90);
 assert.equal(updated.intervalMs, 90);
 assert.equal(limiter.intervalMs('x.example'), 90);

 await limiter.acquire('https://x.example/one');
 const startedAt = Date.now();
 await limiter.acquire('https://x.example/two');
 assert.ok(Date.now() - startedAt >= 75, 'custom interval should be applied');

 assert.throws(() => limiter.setIntervalMs('x.example', -1), /non-negative/);
 assert.equal(limiter.setIntervalMs('y.example', 0).intervalMs, 0);
});

test('jitter is configurable and can be disabled', async () => {
 const jittered = createRateLimiter({defaultIntervalMs: 10, jitterMs: 40, random: () => 0.5});
 await jittered.acquire('https://jitter.example/one');
 let startedAt = Date.now();
 await jittered.acquire('https://jitter.example/two');
 const jitteredWait = Date.now() - startedAt;
 assert.ok(jitteredWait >= 25, 'jitter should add to the interval, waited ' + jitteredWait + 'ms');

 const fixed = createRateLimiter({defaultIntervalMs: 10, jitterMs: 0});
 await fixed.acquire('https://fixed.example/one');
 startedAt = Date.now();
 await fixed.acquire('https://fixed.example/two');
 assert.ok(Date.now() - startedAt < 100, 'jitterMs:0 must disable jitter');
});

test('invalid URLs reject and reset clears observable state', async () => {
 const limiter = createRateLimiter({jitter: false});
 await assert.rejects(limiter.acquire('ftp://files.example/report.html'), error => {
  assert.equal(error.code, 'INVALID_URL');
  assert.equal(error.permanent, true);
  return true;
 });
 await assert.rejects(limiter.acquire('not a url'), error => error.code === 'INVALID_URL');

 await limiter.acquire('https://state.example/one');
 limiter.blockDomain('blocked.example', {reason: 'test'});
 assert.equal(limiter.state().domains.length, 2);
 limiter.reset();
 assert.equal(limiter.state().domains.length, 0);
 assert.equal(limiter.isBlocked('blocked.example'), false);
});
