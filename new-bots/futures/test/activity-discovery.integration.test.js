import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('full runner screens a discovered unconfigured Futures root without granting strategy/risk approval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-activity-runner-'));
  try {
    const preload = join(dir, 'provider.mjs'), riskPath = join(dir, 'risk.json');
    await writeFile(preload, `
Date.now = () => Date.parse('2026-10-02T16:00:30Z');
let definitionsDone = false, delivered = false;
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  if (new URL(url).hostname === 'discord.com') {
    if (!Array.isArray(JSON.parse(options.body).embeds)) throw Error('Expected existing scan embed');
    delivered = true; return new Response(null, {status:process.env.OMNIMOD_TEST_DELIVERY_FAIL === 'true' ? 503 : 204});
  }
  if (new URL(url).hostname !== 'hist.databento.com') throw Error('Unexpected network host');
  if (definitionsDone && !delivered) throw Error('Research attempted before existing delivery');
  if (url.includes('metadata.get_dataset_range')) return new Response(JSON.stringify({schema:{
    definition:{start:'2010-01-01T00:00:00Z',end:'2026-10-02T16:00:00Z'},
    'ohlcv-1m':{start:'2010-01-01T00:00:00Z',end:'2026-10-02T16:00:00Z'}}}));
  const query = url.includes('metadata.get_cost') ? new URL(url).searchParams : new URLSearchParams(options.body);
  if (query.get('symbols') !== 'ALL_SYMBOLS') throw Error('Unexpected curated/deep provider request');
  const schema = query.get('schema');
  if (url.includes('metadata.get_cost')) return new Response(schema === 'definition' ? '0.1' : '0.2');
  if (schema === 'definition') { definitionsDone = true; return new Response(JSON.stringify({publisher_id:1,instrument_id:123,asset:'NEWROOT',raw_symbol:'NEWZ6',
    instrument_class:'F',ts_recv:'2026-10-02T15:00:00Z',expiration:'2026-12-20T00:00:00Z'})+'\\n'); }
  if (schema !== 'ohlcv-1m' || query.get('map_symbols') !== 'true') throw Error('Unexpected data schema');
  return new Response([56,57,58,59].map(m=>JSON.stringify({hd:{rtype:33,publisher_id:1,instrument_id:123,
    ts_event:'2026-10-02T15:'+m+':00Z'},symbol:'NEWZ6',open:100,high:m===59?104:101,low:99,close:m===59?103:100,volume:m===59?1000:100})).join('\\n')+'\\n');
};
`);
    const risk = JSON.stringify({ schemaVersion: 1, events: [], orders: [] });
    await writeFile(riskPath, risk);
    const spawnOptions = {
      cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...process.env,
        FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'manual', FUTURES_POSITION_MARK_SOURCE: 'manual', FUTURES_TREND_DATA_SOURCE: 'manual',
        FUTURES_CATALYST_SOURCE: 'manual', FUTURES_CONTRACT_DISCOVERY_ENABLED: 'true', FUTURES_CONTRACT_DISCOVERY_SCOPE: 'dataset',
        FUTURES_CONTRACT_DISCOVERY_CACHE: join(dir, 'directory.json'), FUTURES_CONTRACT_DISCOVERY_CACHE_MINUTES: '360',
        FUTURES_ACTIVITY_DISCOVERY_ENABLED: 'true', FUTURES_ACTIVITY_DISCOVERY_CACHE: join(dir, 'activity.json'),
        DATABENTO_API_KEY: 'fixture-key', DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_MAX_SCAN_COST_USD: '0.3',
        FUTURES_FILE: join(root, 'futures/examples/futures.json'), FUTURES_DAY_SESSION_FILE: join(root, 'futures/examples/day-session.json'),
        TRADING_RISK_STATE_PATH: riskPath, OMNIMOD_SIGNAL_RESEARCH_PATH: join(dir, 'signals.jsonl'), OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(dir, 'shadow'),
        OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false', DISCORD_DELIVERY_MODE: 'webhook',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/12345/test-only-fully-intercepted', DISCORD_ALERT_COOLDOWN_MINUTES: '0',
        DISCORD_TOKEN: '', DISCORD_WEBHOOK_AVATAR_URL: '' } };
    const args = ['--import', pathToFileURL(preload).href, join(root, 'futures/src/index.js')];
    const run = spawnSync(process.execPath, args, spawnOptions);
    assert.equal(run.status, 0, run.stderr.slice(-2000));
    const report = JSON.parse(run.stdout), activity = report.funnel.activityDiscovery;
    assert.equal(activity.status, 'screen_complete'); assert.equal(activity.universe, 1); assert.equal(activity.observed, 1);
    assert.equal(activity.dataQualified, 1); assert.equal(activity.candidates, 1);
    assert.equal(report.activityDiscovery.candidates[0].providerRoot, 'NEWROOT');
    assert.equal(report.activityDiscovery.candidates[0].configuredPriority, false);
    assert.equal(report.activityDiscovery.candidates[0].recentVolumeRatio, 10);
    assert.equal(report.activityDiscovery.candidates[0].tradeEligible, false);
    assert.equal(report.funnel.dayTrade.inputs, 0); assert.equal(report.funnel.dayTrade.reservationsCreated, 0);
    assert.equal(report.funnel.provider.requests, 6); assert.equal(report.funnel.provider.estimatedTotalCostUsd, 0.3);
    assert.equal(report.funnel.contextDataDiagnostics.status, 'manual_context');
    assert.equal(report.discordDelivery.posted, true, 'mock embed delivery completes before research requests; no real Discord request is allowed');
    assert.equal(await readFile(riskPath, 'utf8'), risk);
    const journal = (await readFile(join(dir, 'data/futures-scan-diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.at(-1).diagnostics.activityDiscovery.candidates, 1);
    assert.equal(typeof journal.at(-1).diagnostics.activityDiscovery.archive.sha256, 'string');
    assert.ok(Number.isFinite(report.funnel.performance.stageDurationsMs.broadActivityDiscovery));
    const failedDelivery = spawnSync(process.execPath, args, { ...spawnOptions, env: { ...spawnOptions.env, OMNIMOD_TEST_DELIVERY_FAIL: 'true' } });
    assert.equal(failedDelivery.status, 0, failedDelivery.stderr.slice(-1000));
    const failedReport = JSON.parse(failedDelivery.stdout);
    assert.equal(failedReport.discordDelivery.posted, false);
    assert.match(failedReport.funnel.discordDelivery.error, /Discord delivery failed/);
    assert.equal(failedReport.funnel.activityDiscovery.status, 'screen_complete');
    assert.equal(failedReport.funnel.activityDiscovery.cached, true);
    assert.equal(await readFile(riskPath, 'utf8'), risk);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
