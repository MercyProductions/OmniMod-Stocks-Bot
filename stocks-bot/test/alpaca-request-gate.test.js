import test from 'node:test';
import assert from 'node:assert/strict';
import { alpacaThrottleDelayMs, createAlpacaRequestGate } from '../src/alpacaRequestGate.js';

test('Stocks Alpaca gate defers same-key requests only after a throttle response', async () => {
  let now = 10_000;
  const gate = createAlpacaRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } });
  await gate('key-a');
  gate.defer('key-a', 3_000);
  const [same, independent] = await Promise.all([gate('key-a'), gate('key-b')]);
  assert.equal(same.cooldownDelayMs, 3_000);
  assert.equal(independent.cooldownDelayMs, 0);
});

test('Stocks Alpaca throttle delay recognizes Retry-After and reset epochs', () => {
  const now = 1_800_000_000_000;
  assert.equal(alpacaThrottleDelayMs(new Headers({ 'Retry-After': '3' }), now), 3_000);
  assert.equal(alpacaThrottleDelayMs(new Headers({ 'X-RateLimit-Reset': String((now + 4_000) / 1_000) }), now), 4_000);
});

test('bounded Stocks discovery defers long cooldowns without erasing the provider throttle', async () => {
  let now = 0;
  const gate = createAlpacaRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } });
  gate.defer('fixture', 60000);
  await assert.rejects(gate('fixture', { maxWaitMs: 2000 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(now, 0);
  assert.equal((await gate('fixture')).cooldownDelayMs, 60000);
});
