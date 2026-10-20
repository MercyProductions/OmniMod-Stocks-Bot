import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, iso } from './fixtures/activityRouting.mjs';
import { now } from './fixtures/activity.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
test('unconfigured root passes broad discovery, H1/live adapters and unchanged ORB; emergency stop and failed data still block it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-activity-deep-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = fixture(2), review = input.reviews.dayTrades[0], raw = review.contract.providerRawSymbol;
  const riskPath = join(dir, 'risk.json'), risk = JSON.stringify({ schemaVersion: 1, orders: [], events: [] });
  const shadowPath = join(dir, 'shadow'), requestsPath = join(dir, 'requests.jsonl');
  const open = Date.parse(review.session.openTime), hour = 3600000;
  const bars = Array.from({ length: 24 }, (_, i) => ({ time: iso(open + i * 300000),
    open: 5999.95 + i * .02, high: 6000.1 + i * .02, low: 5999.9 + i * .02, close: 6000 + i * .02, volume: 100 }));
  Object.assign(bars[0], { high: 6001, low: 5999 }); Object.assign(bars[1], { high: 6001.25, low: 5999.25 });
  Object.assign(bars[2], { high: 6000.75, low: 5999.5 });
  Object.assign(bars.at(-1), { open: 6000.4, close: 6010, high: 6010.25, low: 6000.3, volume: 250 });
  const minutes = bars.flatMap(b => Array.from({ length: 5 }, (_, i) => ({
    hd: { rtype: 33, publisher_id: 1, instrument_id: 1, ts_event: iso(Date.parse(b.time) + i * 60000) },
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume / 5 })));
  const h1 = Array.from({ length: 60 }, (_, i) => ({ hd: { rtype: 34, publisher_id: 1, instrument_id: 1,
    ts_event: iso(Math.floor(now / hour) * hour - (60 - i) * hour) }, symbol: raw,
    open: 5999.95 + i * .02, high: 6000.1 + i * .02, low: 5999.9 + i * .02, close: 6000 + i * .02, volume: 100 }));
  const definitions = input.directory.contracts.map(c => ({ publisher_id: Number(c.providerPublisherId), instrument_id: Number(c.providerInstrumentId),
    asset: c.providerRoot, raw_symbol: c.providerRawSymbol, exchange: 'XCME', currency: 'USD', instrument_class: 'F',
    ts_recv: c.definitionTimestamp, expiration: c.expiry, min_price_increment: '250000000', contract_multiplier: '50' }));
  const activity = input.directory.contracts.flatMap(c => [56,57,58,59].map(m => ({
    hd: { rtype: 33, publisher_id: 1, instrument_id: Number(c.providerInstrumentId), ts_event: `2026-10-02T15:${m}:00Z` },
    symbol: c.providerRawSymbol, open: 6000, high: m === 59 ? 6011 : 6001, low: 5999, close: m === 59 ? 6010 : 6000, volume: m === 59 ? 1000 : 100 })));
  const stream = records => records.map(JSON.stringify).join('\n') + '\n';
  await writeFile(riskPath, risk);
  await writeFile(join(dir, 'session.json'), JSON.stringify({ dayTrades: [], marks: [] }));
  await writeFile(join(dir, 'reviews.json'), JSON.stringify({ schemaVersion: 1, sessionDate: '2026-10-02', dayTrades: [review] }));
  const preload = join(dir, 'provider.mjs');
  await writeFile(preload, `
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Date.now = () => ${now};
const note = x => appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(x)+'\\n');
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url);
  if (target.hostname !== 'hist.databento.com') throw Error('Unmocked network blocked');
  const q = target.pathname.includes('metadata.get_cost') ? target.searchParams : new URLSearchParams(init.body);
  note({operation:target.pathname,schema:q.get('schema'),symbols:q.get('symbols')});
  if (target.pathname.includes('metadata.get_dataset_range')) return new Response(JSON.stringify({schema:{
    definition:{start:'2010-01-01T00:00:00Z',end:'2026-10-02T16:00:00Z'},
    'ohlcv-1m':{start:'2010-01-01T00:00:00Z',end:'2026-10-02T16:00:00Z'}}}));
  if (target.pathname.includes('metadata.get_cost')) return new Response('0.01');
  const schema = q.get('schema');
  if (schema === 'definition' && q.get('symbols') === 'ALL_SYMBOLS') return new Response(${JSON.stringify(stream(definitions))});
  if (schema === 'ohlcv-1m' && q.get('symbols') === 'ALL_SYMBOLS') return new Response(${JSON.stringify(stream(activity))});
  if (schema === 'ohlcv-1h' && q.get('symbols') === ${JSON.stringify(raw)}) return new Response(${JSON.stringify(stream(h1))});
  throw Error('Unexpected schema/symbol request');
};
net.connect = ({host,port}) => {
  if (host !== 'glbx-mdp3.lsg.databento.com' || port !== 13000) throw Error('Unmocked socket blocked');
  note({operation:'live-session'});
  const socket = new EventEmitter(); socket.setTimeout = () => {}; socket.destroy = () => {};
  socket.write = value => {
    if (value.startsWith('auth=')) queueMicrotask(() => socket.emit('data',Buffer.from('success=1|session_id=test\\n')));
    if (value.startsWith('schema=') && !value.includes('symbols=${raw}')) throw Error('Non-selected symbol requested');
    if (value === 'start_session=0\\n') queueMicrotask(() => {
      const records = [{hd:{rtype:22,publisher_id:0,instrument_id:1},stype_in_symbol:${JSON.stringify(raw)},stype_out_symbol:${JSON.stringify(raw)},start_ts:null,end_ts:null},
        ...${JSON.stringify(minutes)}, {hd:{rtype:23},code:3,msg:'Replay completed for ohlcv-1m'},
        {hd:{rtype:1,publisher_id:1,instrument_id:1,ts_event:${JSON.stringify(iso(now - 300))}},flags:128,
          ts_recv:${JSON.stringify(iso(now - 300))},ts_out:${JSON.stringify(iso(now - 100))},levels:[{bid_px:6009.75,ask_px:6010,bid_sz:100,ask_sz:100}]}];
      if (process.env.ROUTING_FIXTURE_FAIL_LIVE === 'true') records.push({hd:{rtype:21},code:3,err:'fixture provider failure'});
      socket.emit('data',Buffer.from(records.map(JSON.stringify).join('\\n')+'\\n'));
    }); return true;
  };
  queueMicrotask(() => socket.emit('data',Buffer.from('cram=test\\n'))); return socket;
};
syncBuiltinESMExports();
`);
  const env = { ...process.env, FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'databento-live', FUTURES_TREND_DATA_SOURCE: 'databento-historical',
    FUTURES_POSITION_MARK_SOURCE: 'manual', FUTURES_CATALYST_SOURCE: 'manual', FUTURES_CONTRACT_DISCOVERY_ENABLED: 'true',
    FUTURES_CONTRACT_DISCOVERY_SCOPE: 'dataset', FUTURES_CONTRACT_DISCOVERY_CACHE: join(dir, 'directory.json'),
    FUTURES_ACTIVITY_DISCOVERY_ENABLED: 'true', FUTURES_ACTIVITY_ANALYSIS_ENABLED: 'true', FUTURES_ACTIVITY_REVIEW_FILE: join(dir, 'reviews.json'),
    FUTURES_ACTIVITY_MAX_ANALYSIS: '10', FUTURES_ACTIVITY_DISCOVERY_CACHE: join(dir, 'activity.json'), FUTURES_H1_CACHE: join(dir, 'h1.json'),
    FUTURES_FILE: join(root, 'futures/examples/futures.json'), FUTURES_DAY_SESSION_FILE: join(dir, 'session.json'),
    DATABENTO_API_KEY: 'test-only-key', DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_MAX_SCAN_COST_USD: '.03',
    TRADING_RISK_STATE_PATH: riskPath, PAPER_ACCOUNT_EQUITY_USD: '200000', OMNIMOD_FORWARD_SHADOW_STATE_DIR: shadowPath,
    OMNIMOD_SIGNAL_RESEARCH_PATH: join(dir, 'signals.jsonl'), OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
    DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: '', DISCORD_DELIVERY_MODE: 'webhook' };
  const run = (overrides = {}) => {
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'futures/src/index.js')],
      { cwd: dir, encoding: 'utf8', timeout: 20000, env: { ...env, ...overrides } });
    assert.equal(child.status, 0, child.stderr.slice(-2000)); return JSON.parse(child.stdout);
  };
  const first = run(), route = first.funnel.activityAnalysis;
  assert.equal(first.funnel.activityDiscovery.universe, 2); assert.equal(first.funnel.activityDiscovery.candidates, 2);
  assert.equal(route.selected, 1, JSON.stringify(route)); assert.equal(route.rejected, 1);
  assert.equal(route.rejectionReasons.reviewed_contract_metadata_missing, 1);
  assert.equal(first.trendDataDiagnostics.complete, 1); assert.equal(first.liveSessionDiagnostics.status, 'complete');
  assert.equal(first.funnel.dayTrade.strategyQualified, 1, JSON.stringify(first.dayResults));
  assert.equal(first.funnel.dayTrade.riskRejected, 1); assert.equal(first.funnel.dayTrade.reservationsCreated, 0);
  const candidate = first.dayResults[0].candidate;
  assert.equal(candidate.researchContext.discovery.cohort, 'broad_activity_reviewed');
  assert.equal(candidate.future.providerPublisherId, '1'); assert.equal(candidate.future.providerDataset, 'GLBX.MDP3');
  assert.ok(first.dayResults[0].decision.reasons.some(r => r.includes('emergency')));
  assert.equal(first.funnel.provider.estimatedTotalCostUsd, .03); assert.equal(await readFile(riskPath, 'utf8'), risk);
  assert.ok((await readdir(shadowPath)).length > 0, 'isolated shadow state');
  const requests = (await readFile(requestsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const activityIndex = requests.findIndex(r => r.operation.includes('timeseries') && r.schema === 'ohlcv-1m');
  const h1Index = requests.findIndex(r => r.operation.includes('timeseries') && r.schema === 'ohlcv-1h');
  assert.ok(activityIndex >= 0 && h1Index > activityIndex);
  assert.equal(requests.filter(r => r.schema === 'ohlcv-1h' && r.operation.includes('timeseries')).length, 1);
  const failed = run({ ROUTING_FIXTURE_FAIL_LIVE: 'true' });
  assert.equal(failed.funnel.activityAnalysis.selected, 1); assert.equal(failed.funnel.dayTrade.strategyQualified, 0);
  assert.ok(failed.dayResults[0].reasons.includes('live_session_data_incomplete')); assert.equal(await readFile(riskPath, 'utf8'), risk);
  const capped = run({ FUTURES_MAX_SCAN_COST_USD: '.02', FUTURES_H1_CACHE: join(dir, 'new-h1.json'),
    FUTURES_CONTRACT_DISCOVERY_CACHE: join(dir, 'new-directory.json'), FUTURES_ACTIVITY_DISCOVERY_CACHE: join(dir, 'new-activity.json') });
  assert.equal(capped.funnel.dayTrade.strategyQualified, 0); assert.equal(capped.funnel.dayTrade.reservationsCreated, 0);
  assert.equal(capped.funnel.provider.estimatedTotalCostUsd, .02);
  assert.ok(capped.dayResults[0].reasons.includes('h1_trend_data_incomplete'));
  assert.equal(capped.liveSessionDiagnostics.activityInputsSkippedWithoutH1, 1);
  const journal = (await readFile(join(dir, 'data/futures-scan-diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal[0].diagnostics.activityAnalysis.selected, 1);
  assert.equal(journal[0].diagnostics.forwardShadow[0].strategyVersion, 'future-session-orb-h1-broad-activity-shadow-v2-decision-clock');
  // Only the intercepted fixture changes its stop, to verify reservation persistence and deduplication.
  const paper = run({ OMNIMOD_EMERGENCY_STOP: 'false', PAPER_ACCOUNT_EQUITY_USD: '500000' });
  assert.equal(paper.funnel.activityAnalysis.reservations, 1, JSON.stringify(paper.dayResults));
  const ledger = JSON.parse(await readFile(riskPath, 'utf8'));
  assert.equal(ledger.orders.length, 1);
  assert.equal(ledger.orders[0].researchContext.discoveryVersion, 'futures-reviewed-activity-routing-v1');
  assert.equal(ledger.orders[0].future.discovery.identity, 'GLBX.MDP3:2026-10-02:1:1');
  assert.equal(ledger.orders[0].future.discovery.reviewSha256.length, 64);
  const repeat = run({ OMNIMOD_EMERGENCY_STOP: 'false', PAPER_ACCOUNT_EQUITY_USD: '500000' });
  assert.equal(repeat.funnel.activityAnalysis.reservations, 0);
  assert.equal(JSON.parse(await readFile(riskPath, 'utf8')).orders.length, 1);
});
