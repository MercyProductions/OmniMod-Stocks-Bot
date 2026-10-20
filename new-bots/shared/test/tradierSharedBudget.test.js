import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createSharedTradierRequestGate, inspectTradierSharedBudget, tradierBudgetConfiguration, readTradierRateLimit } from '../tradierSharedBudget.js';
import { createTradierMarketFetch, requestTradierWithRetry } from '../tradierHttp.js';
import { collectOperatorReport } from '../operatorReport.js';
import { fetchTradierChains } from '../../multi-asset/src/tradierOptions.js';
import { fetchTradierMarketClock } from '../../options/src/tradierMarketData.js';

const NOW = Date.parse('2026-10-03T17:00:00Z');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tradier-budget-')); let at = NOW;
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const config = { directory, productionRequestsPerMinute: 120, sandboxRequestsPerMinute: 60, now: () => at, sleep: async ms => { at += ms; } };
  return { directory, config, gate: createSharedTradierRequestGate(config), other: createSharedTradierRequestGate(config), get at() { return at; }, set at(value) { at = value; } };
}
const quota = (allowed, used, available, expiresAt) => new Headers({ 'X-Ratelimit-Allowed': String(allowed), 'X-Ratelimit-Used': String(used),
  'X-Ratelimit-Available': String(available), 'X-Ratelimit-Expiry': String(expiresAt) });

test('Tradier production and sandbox have separate per-token rolling budgets', async t => {
  const f = await fixture(t);
  assert.equal((await f.gate('one', 'production')).scheduledStartAt, NOW);
  assert.equal((await f.other('one', 'production')).scheduledStartAt, NOW + 500);
  assert.equal((await f.other('one', 'sandbox')).scheduledStartAt, NOW + 500);
  assert.equal((await f.gate('one', 'sandbox')).scheduledStartAt, NOW + 1500);
  assert.equal((await f.gate('two', 'production')).localQueueDelayMs, 0);
  const report = await inspectTradierSharedBudget({ directory: f.directory, now: f.at });
  assert.equal(report.environments.production.buckets.length, 2); assert.equal(report.environments.sandbox.buckets.length, 1);
});

test('native millisecond expiry and conservative Used/Available headers constrain later requests', async t => {
  const f = await fixture(t), grant = await f.gate('one');
  await f.gate.observe('one', 'production', quota(120, 120, 2, NOW + 60001), { status: 200, reservationId: grant.reservationId });
  await assert.rejects(f.other('one', 'production', { maxWaitMs: 0 }), { code: 'TRADIER_PACING_DEFERRED' });
  const report = await inspectTradierSharedBudget({ directory: f.directory, now: f.at });
  assert.equal(report.environments.production.buckets[0].providerQuota.remaining, 0);
  assert.equal(report.environments.production.buckets[0].providerQuota.resetAt, NOW + 60001);
  f.at += 60002; assert.equal((await f.other('one')).localQueueDelayMs, 0);
});

test('out-of-order replies cannot restore native Tradier quota consumed by later grants', async t => {
  const f = await fixture(t), first = await f.gate('one'), second = await f.other('one');
  await f.other.observe('one', 'production', quota(120, 118, 2, NOW + 60000), { status: 200, reservationId: second.reservationId });
  await f.gate.observe('one', 'production', quota(120, 1, 119, NOW + 60000), { status: 200, reservationId: first.reservationId });
  assert.equal((await inspectTradierSharedBudget({ directory: f.directory, now: f.at })).environments.production.buckets[0].providerQuota.remaining, 2);
});

test('429 and exhausted partial headers persist conservative cooldowns without invented quota', async t => {
  const f = await fixture(t);
  await f.gate.observe('one', 'production', new Headers({ 'Retry-After': '61' }), { status: 429 });
  await assert.rejects(f.other('one', 'production', { maxWaitMs: 10000 }), { code: 'TRADIER_PACING_DEFERRED' });
  await f.gate.observe('two', 'sandbox', { 'x-ratelimit-available': '0' }, { status: 200 });
  await assert.rejects(f.other('two', 'sandbox', { maxWaitMs: 0 }), { code: 'TRADIER_PACING_DEFERRED' });
  const report = await inspectTradierSharedBudget({ directory: f.directory, now: f.at });
  assert.equal(report.environments.production.buckets[0].providerQuota, null);
  assert.equal(report.environments.sandbox.buckets[0].providerQuota, null);
  assert.equal(readTradierRateLimit({ 'X-Ratelimit-Allowed': '', 'X-Ratelimit-Used': 'bad' }), null);
});

test('runtime limits stay within provider ceilings and invalid policies fail closed', async t => {
  const f = await fixture(t), config = tradierBudgetConfiguration({}, f.directory);
  assert.equal(config.productionRequestsPerMinute, 108); assert.equal(config.sandboxRequestsPerMinute, 54);
  for (const env of [{ TRADIER_PRODUCTION_REQUESTS_PER_MINUTE: '121' }, { TRADIER_SANDBOX_REQUESTS_PER_MINUTE: '61' }])
    assert.throws(() => tradierBudgetConfiguration(env, f.directory), { code: 'TRADIER_BUDGET_CONFIG_INVALID' });
  await assert.rejects(f.gate('one', 'unknown'), { code: 'TRADIER_BUDGET_ENVIRONMENT_INVALID' });
  await assert.rejects(f.gate('one', 'production', { maxWaitMs: '5' }), { code: 'TRADIER_BUDGET_WAIT_INVALID' });
});

test('corrupt persisted budget prevents requests and does not disclose the token', async t => {
  const f = await fixture(t); await f.gate('fixture-secret-token');
  const dir = join(f.directory, 'production/market-data'), names = await readdir(dir), file = join(dir, names.find(name => name.endsWith('.json')));
  assert.doesNotMatch(await readFile(file, 'utf8'), /fixture-secret-token/);
  await writeFile(file, '{bad');
  await assert.rejects(f.other('fixture-secret-token'), { code: 'TRADIER_BUDGET_STATE_INVALID' });
});

test('real separate process grants are serialized against one market-data bucket', async t => {
  const f = await fixture(t);
  const code = `import { createSharedTradierRequestGate } from ${JSON.stringify(new URL('../tradierSharedBudget.js', import.meta.url).href)};
    const gate = createSharedTradierRequestGate({ directory: process.argv[1], productionRequestsPerMinute: 120 });
    console.log(JSON.stringify(await gate('synthetic-child', 'production')));`;
  const child = () => new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ['--input-type=module', '-e', code, f.directory]); let output = '', errors = '';
    processChild.stdout.on('data', data => { output += data; }); processChild.stderr.on('data', data => { errors += data; });
    processChild.on('error', reject); processChild.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  const grants = (await Promise.all([child(), child(), child()])).sort((a,b) => a.scheduledStartAt - b.scheduledStartAt);
  assert.ok(grants[1].scheduledStartAt - grants[0].scheduledStartAt >= 500);
  assert.ok(grants[2].scheduledStartAt - grants[1].scheduledStartAt >= 500);
  assert.deepEqual(grants.map(row => row.reservationId), [1,2,3]);
});

test('managed nested transport accounts once per HTTP attempt, including retries', async () => {
  let grants = 0, observed = 0, requests = 0; const metrics = [];
  const gate = async () => ({ reservationId: ++grants, localQueueDelayMs: 0 }); gate.observe = async () => { observed++; };
  const managed = createTradierMarketFetch({ token: 'fixture', environment: 'production', providerMetrics: metrics, startPacer: gate,
    retrySleep: async () => {}, random: () => 0, fetchImpl: async () => ({ ok: ++requests > 1, status: requests > 1 ? 200 : 503, headers: new Headers() }) });
  const nested = createTradierMarketFetch({ fetchImpl: managed, token: 'fixture', environment: 'production' });
  assert.equal(nested, managed);
  await nested('https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer fixture' } });
  assert.equal(grants, 2); assert.equal(requests, 2); assert.equal(observed, 2); assert.equal(metrics.length, 2);
  assert.throws(() => createTradierMarketFetch({ fetchImpl: managed, token: 'different', environment: 'production' }), /mismatch/);
});

test('market-data transport cannot send to order routes, other origins or the wrong token bucket', async () => {
  let requests = 0;
  const options = { token: 'fixture', environment: 'production', fetchImpl: async () => { requests++; } };
  for (const [url, init] of [ ['https://api.tradier.com/v1/accounts/1/orders', {}], ['https://sandbox.tradier.com/v1/markets/quotes', {}],
    ['https://api.tradier.com/v1/markets/quotes', { method: 'POST' }], ['https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer wrong' } }] ])
    await assert.rejects(requestTradierWithRetry([url, { headers: { Authorization: 'Bearer fixture' }, ...init }], options), { code: 'TRADIER_MARKET_REQUEST_INVALID' });
  assert.equal(requests, 0);
});

test('operator report exposes separate Tradier budgets without credentials or directory paths', async t => {
  const f = await fixture(t), old = process.env.TRADIER_SHARED_RATE_DIR; process.env.TRADIER_SHARED_RATE_DIR = f.directory;
  try {
    await f.gate('fixture-private-token');
    const report = await collectOperatorReport({ rootDir: f.directory, ledgerPath: join(f.directory, 'missing.json'), now: f.at });
    assert.equal(report.tradierRequestBudget.environments.production.buckets[0].grantsTotal, 1);
    assert.equal(report.tradierRequestBudget.configuredRequestsPerMinute.production, 108);
    assert.doesNotMatch(JSON.stringify(report.tradierRequestBudget), /fixture-private-token/);
    assert.equal(JSON.stringify(report.tradierRequestBudget).includes(f.directory), false);
  } finally { if (old === undefined) delete process.env.TRADIER_SHARED_RATE_DIR; else process.env.TRADIER_SHARED_RATE_DIR = old; }
});

test('a headerless 429 blocks other callers for a local minute', async t => {
  const f = await fixture(t);
  await f.gate.observe('one', 'production', new Headers(), { status: 429 });
  await assert.rejects(f.other('one', 'production', { maxWaitMs: 10000 }), { code: 'TRADIER_PACING_DEFERRED' });
  f.at += 60000; assert.equal((await f.other('one')).localQueueDelayMs, 0);
});

test('response-persistence failure reports the actual HTTP attempt and never retries silently', async () => {
  let requests = 0; const metrics = [], startPacer = async () => ({ reservationId: 1, localQueueDelayMs: 0 });
  startPacer.observe = async () => { throw Object.assign(new Error('storage unavailable'), { code: 'TRADIER_BUDGET_STORAGE_UNAVAILABLE' }); };
  await assert.rejects(requestTradierWithRetry(['https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer fixture' } }], {
    token: 'fixture', startPacer, providerMetrics: metrics, fetchImpl: async () => { requests++; return { ok: true, status: 200, headers: new Headers() }; } }),
    { code: 'TRADIER_BUDGET_STORAGE_UNAVAILABLE' });
  assert.equal(requests, 1); assert.equal(metrics.length, 1); assert.equal(metrics[0].status, 200); assert.notEqual(metrics[0].requestAttempted, false);
});

test('a deadline reached while waiting for a grant makes no HTTP request', async () => {
  let at = NOW, requests = 0; const metrics = [];
  await assert.rejects(requestTradierWithRetry(['https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer fixture' } }], {
    token: 'fixture', deadline: NOW + 100, clockNow: () => at, providerMetrics: metrics,
    startPacer: async () => { at += 101; return { localQueueDelayMs: 101 }; }, fetchImpl: async () => { requests++; } }), { code: 'TRADIER_RESEARCH_DEADLINE' });
  assert.equal(requests, 0); assert.equal(metrics[0].requestAttempted, false);
});

test('interrupted retry waits cannot count the same HTTP response twice', async () => {
  const providerMetrics = [];
  await assert.rejects(requestTradierWithRetry(['https://api.tradier.com/v1/markets/quotes', { headers: { Authorization: 'Bearer fixture' } }], {
    token: 'fixture', providerMetrics, startPacer: async () => ({ localQueueDelayMs: 0 }),
    fetchImpl: async () => ({ ok: false, status: 503, headers: new Headers() }), retrySleep: async () => { throw new Error('wait interrupted'); } }), /wait interrupted/);
  assert.equal(providerMetrics.length, 1); assert.equal(providerMetrics[0].status, 503); assert.equal(providerMetrics[0].retryInterrupted, true);
});

test('direct legacy chain and clock readers use the shared runtime budget', async t => {
  const f = await fixture(t), old = process.env.TRADIER_SHARED_RATE_DIR; process.env.TRADIER_SHARED_RATE_DIR = f.directory;
  try {
    const metrics = [], paths = [];
    const fetchImpl = async url => {
      const path = new URL(url).pathname; paths.push(path);
      const value = path.endsWith('/clock') ? { clock: { state: 'closed', timestamp: new Date().toISOString(), next_change: new Date(Date.now() + 60000).toISOString() } }
        : path.endsWith('/expirations') ? { expirations: { date: ['2026-10-16'] } } : { options: { option: null } };
      return { ok: true, status: 200, headers: new Headers(), json: async () => value };
    };
    await fetchTradierMarketClock({ token: 'direct-reader', fetchImpl, providerMetrics: metrics });
    await fetchTradierChains([{ symbol: 'SPY', expiry: 'auto' }], { token: 'direct-reader', environment: 'production', now: NOW, fetchImpl, providerMetrics: metrics });
    assert.deepEqual(paths, ['/v1/markets/clock', '/v1/markets/options/expirations', '/v1/markets/options/chains']);
    assert.equal(metrics.length, 3);
    const report = await inspectTradierSharedBudget({ directory: f.directory });
    assert.equal(report.environments.production.buckets[0].grantsTotal, 3);
  } finally { if (old === undefined) delete process.env.TRADIER_SHARED_RATE_DIR; else process.env.TRADIER_SHARED_RATE_DIR = old; }
});
