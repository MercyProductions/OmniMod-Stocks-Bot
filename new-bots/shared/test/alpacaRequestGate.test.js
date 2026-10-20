import test from 'node:test';
import assert from 'node:assert/strict';
import { alpacaThrottleDelayMs, createAlpacaRequestGate } from '../alpacaRequestGate.js';

test('optional research rejects bounded waits and preserves the cooldown for later calls', async () => {
  let now = 10000;
  const gate = createAlpacaRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } });
  gate.defer('a', 60000);
  await assert.rejects(gate('a', { maxWaitMs: 2000 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(now, 10000);
  assert.equal((await gate('a')).cooldownDelayMs, 60000);
  await assert.rejects(gate('a', { maxWaitMs: NaN }), RangeError);
});

test('optional research cannot queue behind a pending production cooldown', async () => {
  let release, now = 0;
  const gate = createAlpacaRequestGate({ now: () => now, sleep: (ms) => new Promise((done) => { release = () => { now += ms; done(); }; }) });
  gate.defer('a', 10000);
  const production = gate('a');
  await assert.rejects(gate('a', { maxWaitMs: 2000 }), { code: 'ALPACA_PACING_DEFERRED' });
  await gate('b', { maxWaitMs: 0 });
  release(); await production;
});

test('Alpaca 429 gate defers queued work for the same credential only', async () => {
  let now = 10_000;
  const gate = createAlpacaRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } });
  await gate('credential-a');
  gate.defer('credential-a', 4_000);
  const [same, other] = await Promise.all([gate('credential-a'), gate('credential-b')]);
  assert.equal(same.cooldownDelayMs, 4_000);
  assert.equal(other.cooldownDelayMs, 0);
  assert.equal(now, 14_000);
});

test('Alpaca reset and Retry-After headers become bounded-policy input in milliseconds', () => {
  const now = 1_800_000_000_000;
  assert.equal(alpacaThrottleDelayMs(new Headers({ 'Retry-After': '2' }), now), 2_000);
  assert.equal(alpacaThrottleDelayMs(new Headers({ 'X-RateLimit-Reset': String((now + 5_000) / 1_000) }), now), 5_000);
  assert.equal(alpacaThrottleDelayMs(new Headers(), now, 750), 750);
});
