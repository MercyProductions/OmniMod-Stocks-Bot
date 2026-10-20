import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { collectOperatorReport } from '../operatorReport.js';
import { createRunnerHeartbeat } from '../runnerHeartbeat.js';
import { resolveOperatorDataLocations } from '../operatorDataPaths.js';

test('operator discovers primary scan journals and heartbeats through bot-local data overrides', async t => {
  const base = await mkdtemp(join(tmpdir(), 'operator-primary-paths-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootDir = join(base, 'new-bots');
  const now = Date.now();
  for (const bot of ['stocks', 'crypto']) {
    const project = join(base, `${bot}-bot`);
    const directory = join(project, 'private research # data');
    await mkdir(directory, { recursive: true });
    await writeFile(join(project, '.env'), `export OMNIMOD_${bot.toUpperCase()}_DATA_DIR="private research # data" # path\nDISCORD_TOKEN=fixture-not-a-token\n`);
    if (bot === 'stocks') {
      const journal = join(directory, 'research', 'diagnostics');
      await mkdir(journal, { recursive: true });
      await writeFile(join(journal, '2026-10-03.jsonl'), JSON.stringify({ recordType: 'scan_diagnostic',
        startedAt: new Date(now).toISOString(), successfullyScanned: 41, setups: 0 }) + '\n');
    } else {
      await writeFile(join(directory, 'scan-diagnostic-fixture.json'), JSON.stringify({
        generatedAt: new Date(now).toISOString(), funnel: { universe: 321, setupsPosted: 0 } }));
    }
    const heartbeat = createRunnerHeartbeat({ bot, directory });
    await heartbeat.update({ discordReady: true, schedulerRunning: true });
    await writeFile(join(directory, 'paper-position-monitor.json'), JSON.stringify({ schemaVersion: 1, bot,
      completedAt: new Date(now).toISOString(), status: 'idle', monitored: 0 }));
  }
  const report = await collectOperatorReport({ rootDir, ledgerPath: join(base, 'absent-ledger.json'), now: Date.now() });
  assert.equal(report.bots.stocks.scanStatus, 'fresh');
  assert.equal(report.bots.crypto.scanStatus, 'fresh');
  assert.equal(report.bots.stocks.funnel.successfullyScanned, 41);
  assert.equal(report.bots.crypto.funnel.universe, 321);
  for (const bot of ['stocks', 'crypto']) {
    assert.equal(report.bots[bot].runtime.activeProcesses, 1);
    assert.equal(report.bots[bot].dataLocation.source, 'bot-env-file');
    assert.equal(report.bots[bot].dataLocation.directoryExists, true);
    assert.equal(report.bots[bot].positionMonitor.status, 'idle');
  }
  assert.doesNotMatch(JSON.stringify(report), /private research|fixture-not-a-token/);
});

async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'operator-data-location-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootDir = join(base, 'new-bots');
  for (const bot of ['stocks', 'crypto']) await mkdir(join(base, `${bot}-bot`));
  return { base, rootDir, processEnv: {}, homeDir: join(base, 'home') };
}

test('data locations use each project on Windows and the runtime home default on Linux', async t => {
  const opts = await workspace(t);
  for (const platform of ['win32', 'linux']) {
    const locations = await resolveOperatorDataLocations({ ...opts, platform });
    for (const bot of ['stocks', 'crypto']) {
      assert.equal(locations[bot].directory, platform === 'win32'
        ? join(opts.base, `${bot}-bot`, 'data') : join(opts.homeDir, `.omnimod-${bot}-data`));
      assert.equal(locations[bot].diagnostic.source, platform === 'win32' ? 'project-default' : 'home-default');
      assert.equal(locations[bot].diagnostic.directoryExists, false);
    }
  }
});

test('report arguments override process and local paths, including relative argument compatibility', async t => {
  const opts = await workspace(t);
  const processEnv = {};
  for (const bot of ['stocks', 'crypto']) {
    const key = `OMNIMOD_${bot.toUpperCase()}_DATA_DIR`;
    processEnv[key] = 'process-data';
    await writeFile(join(opts.base, `${bot}-bot`, '.env'), `${key}=local-data\n`);
  }
  const fromProcess = await resolveOperatorDataLocations({ ...opts, processEnv });
  for (const bot of ['stocks', 'crypto']) {
    assert.equal(fromProcess[bot].directory, join(opts.base, `${bot}-bot`, 'process-data'));
    assert.equal(fromProcess[bot].diagnostic.source, 'process-environment');
  }
  const overrides = { stocks: join(opts.base, 'absolute-override'), crypto: 'relative-override' };
  const fromArgument = await resolveOperatorDataLocations({ ...opts, processEnv, overrides });
  assert.equal(fromArgument.stocks.directory, overrides.stocks);
  assert.equal(fromArgument.crypto.directory, resolve('relative-override'));
  for (const bot of ['stocks', 'crypto']) assert.equal(fromArgument[bot].diagnostic.source, 'report-argument');
});

test('empty process values follow each primary bot configuration precedence', async t => {
  const opts = await workspace(t);
  const processEnv = { OMNIMOD_STOCKS_DATA_DIR: '', OMNIMOD_CRYPTO_DATA_DIR: '' };
  for (const bot of ['stocks', 'crypto']) await writeFile(join(opts.base, `${bot}-bot`, '.env'),
    `OMNIMOD_${bot.toUpperCase()}_DATA_DIR=local-data\n`);
  const locations = await resolveOperatorDataLocations({ ...opts, processEnv, platform: 'linux' });
  assert.equal(locations.stocks.directory, join(opts.base, 'stocks-bot', 'local-data'));
  assert.equal(locations.stocks.diagnostic.source, 'bot-env-file');
  assert.equal(locations.crypto.directory, join(opts.homeDir, '.omnimod-crypto-data'));
  assert.equal(locations.crypto.diagnostic.source, 'home-default');
});

test('missing configured locations do not silently fall back to stale project data', async t => {
  const opts = await workspace(t);
  const processEnv = {};
  for (const bot of ['stocks', 'crypto']) {
    await mkdir(join(opts.base, `${bot}-bot`, 'data'));
    processEnv[`OMNIMOD_${bot.toUpperCase()}_DATA_DIR`] = join(opts.base, `missing-${bot}`);
  }
  const locations = await resolveOperatorDataLocations({ ...opts, processEnv });
  for (const bot of ['stocks', 'crypto']) {
    assert.equal(locations[bot].directory, join(opts.base, `missing-${bot}`));
    assert.equal(locations[bot].diagnostic.directoryExists, false);
  }
});

test('data locations are resolved at report time and do not mutate the process environment', async t => {
  const opts = await workspace(t);
  const processEnv = {};
  const before = { ...process.env };
  await writeFile(join(opts.base, 'stocks-bot', '.env'), 'OMNIMOD_STOCKS_DATA_DIR=first\nDISCORD_TOKEN=fixture-secret\n');
  const first = await resolveOperatorDataLocations({ ...opts, processEnv });
  processEnv.OMNIMOD_STOCKS_DATA_DIR = 'second';
  const second = await resolveOperatorDataLocations({ ...opts, processEnv });
  assert.equal(first.stocks.directory, join(opts.base, 'stocks-bot', 'first'));
  assert.equal(second.stocks.directory, join(opts.base, 'stocks-bot', 'second'));
  assert.deepEqual({ ...process.env }, before);
  assert.doesNotMatch(JSON.stringify(second.stocks.diagnostic), /second|fixture-secret/);
});

test('malformed filesystem locations fail visibly instead of reporting an empty scan', async t => {
  const opts = await workspace(t);
  const file = join(opts.base, 'not-a-directory');
  await writeFile(file, 'fixture');
  await assert.rejects(resolveOperatorDataLocations({ ...opts, overrides: { stocks: file } }),
    /Expected stocks diagnostics location to be a directory/);
  // A read failure is not equivalent to an absent .env.
  await mkdir(join(opts.base, 'stocks-bot', '.env'));
  await assert.rejects(resolveOperatorDataLocations(opts), { code: 'EISDIR' });
});
