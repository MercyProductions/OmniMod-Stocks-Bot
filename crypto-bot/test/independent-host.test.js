import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, createLog, isolatedEnvironment, matchesProcess, publicWorker, readJson, redact, stopOwned } from '../hosting/common.js';
import { createSupervisor, launchSpecification } from '../hosting/supervisorCore.js';

const now = Date.now();
const definitions = ['crypto', 'stocks'].map((market) => ({ market, entry: join(tmpdir(), 'worker.js'), cwd: tmpdir(), revision: 'new' }));
const snapshot = (market, pid) => ({ market, processId: pid, startTicks: '123', deploymentId: 'new', state: 'running', discordReady: true,
  heartbeatAt: new Date(now).toISOString(), startedAt: new Date(now - 120000).toISOString() });
const identity = (saved, market = saved.market) => ({ pid: saved.processId, startTicks: saved.startTicks, cwd: tmpdir(), args: ['node', definitions[0].entry, market] });
function harness(overrides = {}) {
  const saved = { crypto: snapshot('crypto', 100), stocks: snapshot('stocks', 101) };
  const living = { 100: identity(saved.crypto), 101: identity(saved.stocks) };
  const launches = [], stops = [];
  const options = { definitions, readStatus: async (market) => saved[market], inspect: async (pid) => living[pid], clock: () => now,
    launch: async (definition) => launches.push(definition.market), log() {},
    stop: async (worker) => { stops.push(worker.market); delete living[worker.processId]; return true; }, ...overrides };
  return { saved, living, launches, stops, supervisor: createSupervisor(options) };
}
test('running independent workers are adopted without restart or duplicate launch', async () => {
  const h = harness(); assert.deepEqual((await h.supervisor.reconcile()).map((item) => item.state), ['running', 'running']);
  assert.deepEqual(h.launches, []); assert.deepEqual(h.stops, []);
});
test('a dead Stocks worker is restarted without interrupting Crypto', async () => {
  const h = harness(); delete h.living[101]; await h.supervisor.reconcile();
  assert.deepEqual(h.launches, ['stocks']); assert.deepEqual(h.stops, []);
});
test('a failed Stocks launch does not prevent Crypto startup', async () => {
  const launched = []; const h = harness({ launch: async ({ market }) => { launched.push(market); if (market === 'stocks') throw new Error('fixture'); } });
  delete h.living[100]; delete h.living[101]; const results = await h.supervisor.reconcile();
  assert.deepEqual(launched.sort(), ['crypto', 'stocks']); assert.equal(results.find((row) => row.market === 'stocks').state, 'error');
});
test('only the worker with a changed strategy revision is stopped and then replaced', async () => {
  const h = harness(); h.saved.stocks.deploymentId = 'old';
  await h.supervisor.reconcile(); assert.deepEqual(h.stops, ['stocks']); assert.deepEqual(h.launches, []);
  await h.supervisor.reconcile(); assert.deepEqual(h.launches, ['stocks']);
});
test('rollback drains both workers and never launches a replacement', async () => {
  const h = harness(); const result = await h.supervisor.reconcile(['crypto', 'stocks']);
  assert.ok(result.every((row) => row.stopped)); assert.deepEqual(h.stops.sort(), ['crypto', 'stocks']); assert.deepEqual(h.launches, []);
});
test('market-specific pause stops Stocks alone', async () => {
  const h = harness(); await h.supervisor.reconcile(['stocks']); assert.deepEqual(h.stops, ['stocks']); assert.deepEqual(h.launches, []);
});
test('PID reuse or a different entry cannot authorize termination or duplicate launch', async () => {
  const h = harness(); h.living[101].startTicks = '999';
  const result = await h.supervisor.reconcile(['stocks']); assert.equal(result[1].state, 'identity_conflict'); assert.equal(result[1].stopped, false);
  assert.deepEqual(h.stops, []); assert.deepEqual(h.launches, []);
});
test('stale heartbeat with a live owner fails closed instead of duplicating scanner', async () => {
  const h = harness(); h.saved.stocks.heartbeatAt = new Date(now - 60000).toISOString();
  assert.equal((await h.supervisor.reconcile())[1].state, 'stale_owner'); assert.deepEqual(h.launches, []);
});
test('repeated failed starts use per-market exponential backoff', async () => {
  let clock = now; const h = harness({ clock: () => clock }); delete h.living[101];
  await h.supervisor.reconcile(); await h.supervisor.reconcile(); assert.equal(h.launches.length, 1);
  clock += 15001; await h.supervisor.reconcile(); assert.equal(h.launches.length, 2);
  clock += 15001; assert.equal((await h.supervisor.reconcile())[1].state, 'restart_backoff');
});
test('concurrent supervisor calls share a reconciliation pass', async () => {
  const h = harness(); delete h.living[101];
  await Promise.all([h.supervisor.reconcile(), h.supervisor.reconcile(), h.supervisor.reconcile()]); assert.deepEqual(h.launches, ['stocks']);
});
test('an unconfirmed worker exit never leads to launch in that pass', async () => {
  const h = harness({ stop: async () => { throw new Error('still alive'); } }); h.saved.stocks.deploymentId = 'old';
  assert.equal((await h.supervisor.reconcile())[1].state, 'error'); assert.deepEqual(h.launches, []);
});
test('process identity includes PID birth, exact entry, market, and cwd', () => {
  const saved = snapshot('stocks', 101); const current = identity(saved);
  assert.equal(matchesProcess(saved, current, definitions[1].entry, tmpdir(), 'stocks'), true);
  for (const replacement of [{ ...current, startTicks: 'new' }, { ...current, args: ['node', 'unrelated.js', 'stocks'] },
    { ...current, args: ['node', definitions[1].entry, 'crypto'] }, { ...current, cwd: join(tmpdir(), 'different') }]) {
    assert.equal(matchesProcess(saved, replacement, definitions[1].entry, tmpdir(), 'stocks'), false);
  }
});
test('stopOwned refuses an unrelated process and waits for verified owner exit', async () => {
  const saved = snapshot('stocks', 101); let current = identity(saved), signals = [];
  assert.equal(await stopOwned(saved, definitions[1].entry, tmpdir(), 'stocks', {
    inspect: async () => ({ ...current, startTicks: 'wrong' }), kill: () => assert.fail('must not signal'), sleep: async () => {} }), false);
  assert.equal(await stopOwned(saved, definitions[1].entry, tmpdir(), 'stocks', {
    inspect: async () => current, kill: (pid, signal) => { signals.push([pid, signal]); current = null; }, sleep: async () => {} }), true);
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
});
test('stopOwned refuses replacement while the old process survives SIGTERM', async () => {
  const saved = snapshot('stocks', 101);
  await assert.rejects(stopOwned(saved, definitions[1].entry, tmpdir(), 'stocks', {
    inspect: async () => identity(saved), kill() {}, sleep: async () => {}, attempts: 2 }), /did not exit/);
});
test('launch uses kernel flock with argument boundaries, per-market lock and detached child', () => {
  const spec = launchSpecification(definitions[1], { node: '/bin/node', stateDirectory: '/private state', env: {} });
  assert.equal(spec.command, '/usr/bin/flock'); assert.equal(spec.args[1], join('/private state', 'stocks.lock'));
  assert.equal(spec.args.at(-1), 'stocks'); assert.equal(spec.options.detached, true); assert.equal(spec.options.shell, undefined);
});
test('Stocks cannot inherit Crypto token as fallback and Crypto does not receive Stocks token', () => {
  const env = { DISCORD_TOKEN: 'crypto-secret', DISCORD_CLIENT_ID: 'crypto-id', STOCKS_DISCORD_TOKEN: 'stock-secret', STOCKS_DISCORD_CLIENT_ID: 'stock-id' };
  assert.equal(isolatedEnvironment('stocks', env).DISCORD_TOKEN, 'stock-secret');
  assert.equal(isolatedEnvironment('stocks', { DISCORD_TOKEN: 'crypto-secret' }).DISCORD_TOKEN, undefined);
  assert.equal(isolatedEnvironment('crypto', env).STOCKS_DISCORD_TOKEN, undefined);
  assert.equal(env.DISCORD_TOKEN, 'crypto-secret');
});
test('public health excludes secrets, paths and kernel identifiers; stale cannot appear ready', () => {
  const saved = { ...snapshot('stocks', 101), discordToken: 'private', dataDir: '/private', lastError: 'Bearer hidden' };
  const safe = publicWorker(saved, now + 60000);
  assert.equal(safe.state, 'stale'); assert.equal(safe.discordReady, false); assert.equal(safe.discordToken, undefined);
  assert.equal(safe.dataDir, undefined); assert.equal(safe.startTicks, undefined); assert.doesNotMatch(JSON.stringify(safe), /hidden/);
});
test('private atomic status and bounded redacted logs survive writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-host-test-'));
  try {
    const file = join(directory, 'state.json'); await atomicJson(file, { state: 'ready' }); assert.equal((await readJson(file)).state, 'ready');
    assert.equal(await readJson(join(directory, 'missing.json')), null);
    const log = createLog('test', directory, { DISCORD_TOKEN: 'secret-token-value' });
    log('event', 'secret-token-value'); const logFile = join(directory, 'test.log');
    assert.doesNotMatch(await readFile(logFile, 'utf8'), /secret-token-value/);
    await writeFile(logFile, 'x'.repeat(2 * 1024 * 1024 + 1)); log('rotated', 'ok');
    assert.ok((await readFile(logFile, 'utf8')).length < 1000); assert.ok((await readFile(logFile + '.previous')).length > 2 * 1024 * 1024);
    assert.equal(redact('secret-token-value', { API_KEY: 'secret-token-value' }), '[REDACTED]');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
