import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableProviderFailure, retryPlan } from '../src/retryPolicy.js';
import { assertProviderAvailable, providerCooldownStatus, recordProviderCooldown, waitForProviderCooldown } from '../src/providerCooldown.js';

test('retry policy honors Retry-After seconds and caps exponential fallback', () => {
  assert.deepEqual(retryPlan('2', 0), { delayMs: 2000, source: 'retry-after', retry: true });
  assert.deepEqual(retryPlan(null, 0), { delayMs: 500, source: 'exponential-backoff', retry: true });
  assert.deepEqual(retryPlan('invalid', 9), { delayMs: 5000, source: 'exponential-backoff', retry: true });
});

test('HTTP-date Retry-After is measured from provider Date and long waits are deferred', () => {
  const providerNow = Date.parse('2026-09-30T02:00:00Z');
  const serverDate = new Date(providerNow).toUTCString();
  const after = new Date(providerNow + 3000).toUTCString();
  assert.deepEqual(retryPlan(after, 0, { now: providerNow + 60_000, serverDateHeader: serverDate }),
    { delayMs: 3000, source: 'retry-after', retry: true });
  assert.deepEqual(retryPlan(new Date(providerNow + 30_000).toUTCString(), 0,
    { now: providerNow, serverDateHeader: serverDate, maxRetryDelayMs: 5000 }),
  { delayMs: 30_000, source: 'retry-after', retry: false });
});

test('past HTTP dates retry immediately and invalid policy values are rejected', () => {
  const now = Date.parse('2026-09-30T02:00:00Z');
  assert.equal(retryPlan(new Date(now - 1000).toUTCString(), 0, { now }).delayMs, 0);
  assert.throws(() => retryPlan('1', -1), /inputs are invalid/);
  assert.throws(() => retryPlan('1', 0, { maxRetryDelayMs: -1 }), /inputs are invalid/);
});

test('provider retry classifier includes transient fetch failures but excludes permanent response/data errors', () => {
  for (const error of [Object.assign(new Error('too many requests'), { status: 429 }),
    Object.assign(new Error('server failure'), { status: 503 }),
    Object.assign(new Error('socket reset'), { name: 'TypeError' }),
    Object.assign(new Error('request aborted'), { name: 'AbortError' }),
    Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
    assert.equal(isRetryableProviderFailure(error), true, error.message);
  }
  for (const error of [Object.assign(new Error('forbidden'), { status: 403 }),
    Object.assign(new SyntaxError('invalid JSON'), { status: 200 }), new Error('strategy validation failure')]) {
    assert.equal(isRetryableProviderFailure(error), false, error.message);
  }
});

test('Retry-After establishes a host-wide cooldown and new requests fail fast until it expires', async () => {
  const url = 'https://cooldown-fixture.invalid/first';
  const now = Date.parse('2026-09-30T02:00:00Z');
  const cooldown = recordProviderCooldown(url, '30', 0, { now });
  assert.equal(cooldown.until, now + 30_000);
  assert.deepEqual(providerCooldownStatus('https://cooldown-fixture.invalid/another-endpoint', now), {
    origin: 'https://cooldown-fixture.invalid', coolingDown: true, until: now + 30_000, remainingMs: 30_000,
  });
  assert.throws(() => assertProviderAvailable(url, now), (error) => error.code === 'PROVIDER_COOLDOWN_ACTIVE' && error.remainingMs === 30_000);
  assert.equal(providerCooldownStatus('https://other-provider.invalid/', now).coolingDown, false);
  await assert.rejects(waitForProviderCooldown(url, { now: () => now, sleep: async () => {}, maxWaitMs: 5_000 }),
    (error) => error.code === 'PROVIDER_COOLDOWN_ACTIVE' && error.remainingMs === 30_000);

  let clock = now;
  const shortUrl = 'https://short-cooldown-fixture.invalid/first';
  recordProviderCooldown(shortUrl, '3', 0, { now });
  await waitForProviderCooldown(shortUrl, { now: () => clock, sleep: async (delay) => { clock += delay; } });
  assert.equal(providerCooldownStatus(shortUrl, clock).coolingDown, false);
});
