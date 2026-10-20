import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { alpacaBudgetConfiguration, createSharedAlpacaRequestGate, inspectAlpacaSharedBudget } from '../alpacaSharedBudget.js';

async function fixture(t, limit = 180) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-alpaca-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let at = 180000;
  const options = { directory, requestsPerMinute: limit, now: () => at, sleep: async ms => { at += ms; } };
  return { directory, gate: createSharedAlpacaRequestGate(options), other: createSharedAlpacaRequestGate(options),
    get at() { return at; }, set at(n) { at = n; }, options };
}

test('separate coordinator instances share pacing, cooldowns and immutable credential isolation', async t => {
  const f = await fixture(t);
  const first = await f.gate('secret-a');
  await assert.rejects(f.other('secret-a', { maxWaitMs: 0 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal((await f.other('secret-b')).cooldownDelayMs, 0);
  const second = await f.other('secret-a');
  assert.ok(second.sharedBudget.grantedAt - first.sharedBudget.grantedAt >= 334);
  await f.gate.defer('secret-a', 5000);
  await assert.rejects(f.other('secret-a', { maxWaitMs: 2000 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.ok((await f.other('secret-a')).cooldownDelayMs >= 5000);
  const files = await readdir(f.directory);
  for (const name of files) {
    assert.match(name, /^[a-f0-9]{64}\.json$/);
    assert.doesNotMatch(await readFile(join(f.directory, name), 'utf8'), /secret-a|secret-b/);
  }
});

test('explicit account group coordinates different keys; distinct groups remain separate', async t => {
  const f = await fixture(t);
  const a = createSharedAlpacaRequestGate({ ...f.options, group: 'account-one' });
  const b = createSharedAlpacaRequestGate({ ...f.options, group: 'account-one' });
  const c = createSharedAlpacaRequestGate({ ...f.options, group: 'account-two' });
  await a('key-a'); await a.defer('key-a', 1000);
  await assert.rejects(b('key-b', { maxWaitMs: 0 }), { code: 'ALPACA_PACING_DEFERRED' });
  await c('key-a', { maxWaitMs: 0 });
});

test('provider quota consumption and late replies cannot replenish an active window', async t => {
  const f = await fixture(t);
  const one = await f.gate('key');
  const headers = n => new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': String(n), 'X-RateLimit-Reset': '240' });
  await f.gate.observe('key', headers(2), { reservationId: one.reservationId, status: 200 });
  await f.other('key'); const three = await f.other('key');
  await f.gate.observe('key', headers(199), { reservationId: one.reservationId, status: 200 });
  await assert.rejects(f.gate('key', { maxWaitMs: 0 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(three.sharedBudget.providerRemaining, 0);
  await f.gate.observe('key', new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '200' }), { status: 200 });
  f.at = 240000;
  await f.gate('key');
  const status = await inspectAlpacaSharedBudget({ directory: f.directory, now: f.at });
  assert.equal(status.buckets[0].providerQuotaCurrent, false);
});

test('in-flight requests after the response reservation are deducted from observed quota', async t => {
  const f = await fixture(t); const first = await f.gate('key'); await f.other('key');
  await f.gate.observe('key', new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset': '240' }), { reservationId: first.reservationId, status: 200 });
  await assert.rejects(f.other('key', { maxWaitMs: 0 }), { code: 'ALPACA_PACING_DEFERRED' });
});

test('429 Retry-After survives a new instance and missing quota stays unknown', async t => {
  const f = await fixture(t); await f.gate('key');
  await f.gate.observe('key', new Headers({ 'Retry-After': '2' }), { status: 429 });
  await assert.rejects(f.other('key', { maxWaitMs: 1000 }), { code: 'ALPACA_PACING_DEFERRED' });
  const report = await inspectAlpacaSharedBudget({ directory: f.directory, now: f.at });
  assert.equal(report.buckets[0].providerQuota, null);
  assert.equal(report.buckets[0].localCooldownUntil, new Date(f.at + 2000).toISOString());
  await f.other('key');
});

test('missing reset with exhausted quota uses a disclosed local cooldown', async t => {
  const f = await fixture(t); await f.gate.observe('key', new Headers({ 'X-RateLimit-Remaining': '0' }), { status: 200 });
  await assert.rejects(f.other('key'), { code: 'ALPACA_PACING_DEFERRED' });
  f.at += 60000; await f.other('key');
});

test('a slower active worker constrains a faster paid configuration until its window expires', async t => {
  const f = await fixture(t, 2), fast = createSharedAlpacaRequestGate({ ...f.options, requestsPerMinute: 10000 });
  await f.gate('key');
  await assert.rejects(fast('key', { maxWaitMs: 1000 }), { code: 'ALPACA_PACING_DEFERRED' });
  f.at += 30000; assert.equal((await fast('key')).sharedBudget.effectiveLimit, 2);
  f.at += 30000; assert.equal((await fast('key')).sharedBudget.effectiveLimit, 10000);
});

test('corrupt state, clock rollback and abandoned locks fail without resetting budget', async t => {
  const f = await fixture(t); await f.gate('key');
  const name = (await readdir(f.directory)).find(name => name.endsWith('.json')), path = join(f.directory, name);
  const original = await readFile(path, 'utf8');
  await writeFile(path, 'corrupt');
  await assert.rejects(f.other('key'), { code: 'ALPACA_BUDGET_STATE_INVALID' });
  assert.equal(await readFile(path, 'utf8'), 'corrupt');
  await writeFile(path, original); f.at -= 6000;
  await assert.rejects(f.other('key'), { code: 'ALPACA_BUDGET_CLOCK_SKEW' });
  f.at += 6000;
  const lock = path.replace(/\.json$/, '.lock'); await writeFile(lock, '{"pid":9999999}');
  await assert.rejects(f.other('key', { maxWaitMs: 25 }), { code: 'ALPACA_BUDGET_LOCK_TIMEOUT' });
  assert.equal(await readFile(lock, 'utf8'), '{"pid":9999999}');
  assert.equal((await inspectAlpacaSharedBudget({ directory: f.directory, now: f.at })).pendingLocks, 1);
});

test('invalid config and wait budgets create no unbounded or permissive gate', async t => {
  const f = await fixture(t);
  for (const value of ['0', '-1', 'NaN', '10001', '1.5']) assert.throws(() => alpacaBudgetConfiguration({ ALPACA_REQUESTS_PER_MINUTE: value }));
  assert.throws(() => alpacaBudgetConfiguration({ ALPACA_RATE_LIMIT_GROUP: '../bad' }));
  for (const value of [-1, NaN, Infinity, 60001]) await assert.rejects(f.gate('key', { maxWaitMs: value }), { code: 'ALPACA_BUDGET_WAIT_INVALID' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('zero queued-wait budget permits immediately available grants on a real filesystem', async t => {
  const f = await fixture(t);
  const gate = createSharedAlpacaRequestGate({ directory: f.directory, requestsPerMinute: 1 });
  assert.equal((await gate('zero-wait', { maxWaitMs: 0 })).reservationId, 1);
  await assert.rejects(gate('zero-wait', { maxWaitMs: 0 }), { code: 'ALPACA_PACING_DEFERRED' });
});

test('real Stocks and ETF child processes serialize shared request grants', async t => {
  const f = await fixture(t);
  const worker = fileURLToPath(new URL('../fixtures/alpacaBudgetWorker.js', import.meta.url));
  const launch = owner => new Promise((done, reject) => {
    const child = spawn(process.execPath, [worker], { env: { ...process.env, ALPACA_SHARED_RATE_DIR: f.directory,
      ALPACA_REQUESTS_PER_MINUTE: '6000', ALPACA_RATE_LIMIT_GROUP: '', BUDGET_FIXTURE_OWNER: owner }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(err)); else { try { done(JSON.parse(out)); } catch(error) { reject(error); } } });
  });
  const results = (await Promise.all(['stocks','etfs','stocks','etfs'].map(launch))).flat().sort((a,b) => a.reservationId - b.reservationId);
  assert.deepEqual(results.map(row => row.reservationId), Array.from({ length: 16 }, (_,i) => i + 1));
  for (let i = 1; i < results.length; i++) assert.ok(results[i].sharedBudget.grantedAt - results[i-1].sharedBudget.grantedAt >= 10);
});
