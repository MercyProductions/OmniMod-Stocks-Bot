import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { waitForTradierStartSlot } from '../src/tradierRateLimit.js';
import { requestTradierWithRetry } from '../src/tradierMarketData.js';

test('default Tradier cooldown survives a fresh process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tradier-shared-baseline-'));
  const before = process.env.TRADIER_SHARED_RATE_DIR; process.env.TRADIER_SHARED_RATE_DIR = directory;
  t.after(async () => {
    if (before === undefined) delete process.env.TRADIER_SHARED_RATE_DIR; else process.env.TRADIER_SHARED_RATE_DIR = before;
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  });
  await waitForTradierStartSlot.deferStarts('synthetic-persist', 'production', 60000);
  const code = `import { waitForTradierStartSlot as gate } from ${JSON.stringify(new URL('../src/tradierRateLimit.js', import.meta.url).href)};
    try { await gate('synthetic-persist', 'production', { maxWaitMs: 0 }); console.log('granted'); }
    catch (error) { console.log(error.code); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000, env: process.env });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'TRADIER_PACING_DEFERRED');
});

const options = extra => ({ token: 'synthetic', environment: 'production', operation: 'test-quotes', providerMetrics: [],
  clockNow: Date.now, retrySleep: async () => {}, random: () => 0, maxAttempts: 1, maxRetryWaitMs: 0, onRequest: () => {}, ...extra });
const args = ['https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer synthetic' } }];

test('pacing deferrals record zero HTTP attempts in diagnostics', async () => {
  const providerMetrics = []; let requests = 0;
  await assert.rejects(requestTradierWithRetry(args, options({ providerMetrics, fetchImpl: async () => { requests++; },
    startPacer: async () => { throw Object.assign(new Error('deferred'), { code: 'TRADIER_PACING_DEFERRED' }); } })), { code: 'TRADIER_PACING_DEFERRED' });
  assert.equal(requests, 0); assert.equal(providerMetrics.length, 1); assert.equal(providerMetrics[0].requestAttempted, false);
});

test('successful quota headers are observed with their grant identity', async () => {
  let observed;
  const startPacer = async () => ({ localQueueDelayMs: 0, reservationId: 7 });
  startPacer.observe = async (...args) => { observed = args; };
  await requestTradierWithRetry(args, options({ startPacer, fetchImpl: async () => ({ ok: true, status: 200,
    headers: new Headers({ 'X-Ratelimit-Allowed': '120', 'X-Ratelimit-Available': '0', 'X-Ratelimit-Expiry': String(Date.now() + 60000) }) }) }));
  assert.ok(observed); assert.equal(observed[3].reservationId, 7);
});

test('final throttled response awaits persistent cooldown before returning', async () => {
  let saved = false;
  const startPacer = async () => ({ localQueueDelayMs: 0 });
  startPacer.deferStarts = async () => { await new Promise(done => setImmediate(done)); saved = true; };
  await requestTradierWithRetry(args, options({ startPacer,
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }) }) }));
  assert.equal(saved, true);
});
