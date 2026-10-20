import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
test('full Futures runner persists dataset directory and unavailable context when discovery consumes cost cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-directory-runner-'));
  try {
    const preload = join(dir, 'provider.mjs');
    await writeFile(preload, `
const now = Date.now(), end = new Date(now - 1000).toISOString();
globalThis.fetch = async (url, options = {}) => {
  if (url.includes('metadata.get_dataset_range')) return new Response(JSON.stringify({schema:{definition:{start:'2010-01-01T00:00:00Z',end}}}));
  if (url.includes('metadata.get_cost')) { if(new URL(url).searchParams.get('symbols') !== 'ALL_SYMBOLS') throw Error('Unexpected extra context cost request'); return new Response('0.10'); }
  if (url.includes('timeseries.get_range') && new URLSearchParams(options.body).get('symbols') === 'ALL_SYMBOLS') return new Response(JSON.stringify({
    publisher_id:1,instrument_id:123,asset:'NEWROOT',raw_symbol:'NEWZ6',instrument_class:'F',ts_recv:new Date(now - 2000).toISOString(),expiration:new Date(now + 86400000).toISOString()
  }) + '\\n');
  throw Error('Unexpected network request');
};
`);
    const riskPath = join(dir, 'risk.json');
    const risk = JSON.stringify({ schemaVersion: 1, events: [], orders: [] });
    await writeFile(riskPath, risk);
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'futures/src/index.js')], {
      cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...process.env,
        FUTURES_SOURCE: 'databento', FUTURES_DAY_DATA_SOURCE: 'manual', FUTURES_POSITION_MARK_SOURCE: 'manual', FUTURES_TREND_DATA_SOURCE: 'manual',
        FUTURES_CATALYST_SOURCE: 'manual', FUTURES_CONTRACT_DISCOVERY_ENABLED: 'true', FUTURES_CONTRACT_DISCOVERY_SCOPE: 'dataset',
        FUTURES_CONTRACT_DISCOVERY_CACHE: join(dir, 'directory.json'), FUTURES_CONTRACT_DISCOVERY_CACHE_MINUTES: '360',
        DATABENTO_API_KEY: 'fixture-key', DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_MAX_SCAN_COST_USD: '0.1',
        FUTURES_FILE: join(root, 'futures/examples/futures.json'), FUTURES_DAY_SESSION_FILE: join(root, 'futures/examples/day-session.json'),
        TRADING_RISK_STATE_PATH: riskPath, OMNIMOD_SIGNAL_RESEARCH_PATH: join(dir, 'signals.jsonl'), OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(dir, 'shadow'),
        OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false', DISCORD_DELIVERY_MODE: 'webhook', DISCORD_WEBHOOK_URL: '', DISCORD_TOKEN: '' } });
    assert.equal(run.status, 0, run.stderr.slice(-2000));
    const report = JSON.parse(run.stdout);
    assert.equal(report.funnel.contractDiscovery.directory.discoveredRoots, 1);
    assert.equal(report.funnel.contractDiscovery.directory.outsideConfiguredPriorities, 1);
    assert.equal(report.funnel.provider.requests, 3);
    assert.equal(report.funnel.provider.estimatedTotalCostUsd, 0.1);
    assert.equal(report.funnel.contextDataDiagnostics.status, 'cost_budget_exhausted');
    assert.equal(report.funnel.contextUniverse.observed, 0);
    assert.equal(report.funnel.dayTrade.inputs, 0);
    assert.equal(report.funnel.dayTrade.reservationsCreated, 0);
    assert.equal(report.discordDelivery.posted, false);
    assert.ok(report.observations.every((r) => r.price === null && r.stale));
    assert.equal(await readFile(riskPath, 'utf8'), risk);
    const journal = (await readFile(join(dir, 'data/futures-scan-diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.at(-1).diagnostics.contractDiscovery.directory.streamComplete, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
