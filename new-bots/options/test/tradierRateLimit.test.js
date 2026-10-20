import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradierStartPacer } from '../src/tradierRateLimit.js';

test('Tradier pacer serializes starts below production and sandbox minute ceilings per token', async () => {
  let clock = 10_000;
  const pacer = createTradierStartPacer({
    productionIntervalMs: 550, sandboxIntervalMs: 1_100,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  const production = await Promise.all(Array.from({ length: 4 }, async () => pacer('same-token', 'production')));
  assert.deepEqual(production.map((row) => row.scheduledStartAt), [10_000, 10_550, 11_100, 11_650]);
  assert.deepEqual(production.map((row) => row.localQueueDelayMs), [0, 550, 550, 550]);

  const independent = await Promise.all([
    pacer('token-a', 'production'), pacer('token-b', 'production')
  ]);
  assert.deepEqual(independent.map((row) => row.localQueueDelayMs), [0, 0]);

  const sandbox = await Promise.all(Array.from({ length: 3 }, async () => pacer('sandbox-token', 'sandbox')));
  assert.deepEqual(sandbox.map((row) => row.scheduledStartAt), [11_650, 12_750, 13_850]);
  assert.deepEqual(sandbox.map((row) => row.localQueueDelayMs), [0, 1_100, 1_100]);
});

test('Tradier pacer validates environment, interval, and credential presence', async () => {
  assert.throws(() => createTradierStartPacer({ productionIntervalMs: 0 }), /interval must be positive/);
  const pacer = createTradierStartPacer();
  await assert.rejects(pacer('', 'production'), /requires an access token/);
  await assert.rejects(pacer('token', 'paper'), /environment is unsupported/);
});

test('Tradier 429 cooldown defers every queued request for the same token', async () => {
  let clock = 20_000;
  const pacer = createTradierStartPacer({ productionIntervalMs: 550, now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; } });
  const first = await pacer('throttled-token', 'production');
  assert.equal(first.scheduledStartAt, 20_000);
  pacer.deferStarts('throttled-token', 'production', 5_000);
  const later = await pacer('throttled-token', 'production');
  assert.equal(later.scheduledStartAt, 25_000);
  assert.equal(later.localQueueDelayMs, 5_000);
  const independent = await pacer('different-token', 'production');
  assert.equal(independent.localQueueDelayMs, 0);
});

test('bounded research refuses a long cooldown without clearing it for other callers', async () => {
  let clock = 10000;
  const pacer = createTradierStartPacer({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  pacer.deferStarts('token', 'sandbox', 600000);
  await assert.rejects(pacer('token', 'sandbox', { maxWaitMs: 45000 }), { code: 'TRADIER_PACING_DEFERRED' });
  assert.equal(clock, 10000);
  const normal = await pacer('token', 'sandbox');
  assert.equal(normal.scheduledStartAt, 610000);
  await assert.rejects(pacer('token', 'sandbox', { maxWaitMs: '1000' }), /invalid/);
});

test('bounded research refuses an occupied queue without disturbing serialized callers', async () => {
  let clock = 10000, release;
  const pacer = createTradierStartPacer({ now: () => clock, sleep: (ms) => new Promise((done) => { release = () => { clock += ms; done(); }; }) });
  await pacer('token', 'production');
  const waiting = pacer('token', 'production');
  await Promise.resolve();
  await assert.rejects(pacer('token', 'production', { maxWaitMs: 1000 }), { code: 'TRADIER_PACING_DEFERRED' });
  release();
  assert.equal((await waiting).scheduledStartAt, 10550);
});
