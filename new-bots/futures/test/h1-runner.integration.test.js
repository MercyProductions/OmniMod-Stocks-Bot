import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
test('documented provider H1 history reaches unchanged ORB and risk gates; cache eliminates next-scan HTTP', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-h1-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-02T16:00:00Z'), hour = 3_600_000, open = now - 2 * hour;
  const iso = (at) => new Date(at).toISOString();
  const contract = { symbol: 'ES', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612',
    assetClass: 'equity-index-future', exposureKey: 'SPY', activeContract: true, contractSpecVerified: true,
    expiry: '2026-12-18T14:30:00Z', specSource: 'https://example.test/fixture-specs', specVerifiedAt: iso(now - hour),
    multiplier: 50, tickSize: .25, tickValueUsd: 12.5, initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000,
    settlementReview: { settlementType: 'cash_settled', source: 'https://example.test/fixture-settlement',
      reviewedAt: iso(now - hour), lastTradeAt: '2026-12-18T14:30:00Z' } };
  const bars = Array.from({ length: 24 }, (_, i) => ({ time: iso(open + i * 300_000), open: 5999.95 + i * .02,
    high: 6000.1 + i * .02, low: 5999.9 + i * .02, close: 6000 + i * .02, volume: 100 }));
  Object.assign(bars[0], { high: 6001, low: 5999 });
  Object.assign(bars[1], { high: 6001.25, low: 5999.25 });
  Object.assign(bars[2], { high: 6000.75, low: 5999.5 });
  Object.assign(bars.at(-1), { open: 6000.4, close: 6010, high: 6010.25, low: 6000.3, volume: 250 });
  const session = { marketDate: '2026-10-02', timeZone: 'America/Chicago', openTime: iso(open), closeTime: iso(now + 5 * hour),
    source: 'https://example.test/fixture-session', reviewedAt: iso(now) };
  const trade = { contract, bars, trendBars: [], session, quote: { bid: 6009.75, ask: 6010, time: iso(now), quality: 'executable' },
    catalystReview: { status: 'clear', source: 'Fixture-only event review', summary: 'Synthetic test; no provider clearance asserted.', reviewedAt: iso(now) },
    config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 } };
  const sourceRecords = Array.from({ length: 60 }, (_, i) => ({ hd: { ts_event: iso(now - (60 - i) * hour),
    rtype: 34, publisher_id: 1, instrument_id: 123 }, symbol: 'ESZ6', open: 5999.95 + i * .02,
    high: 6000.1 + i * .02, low: 5999.9 + i * .02, close: 6000 + i * .02, volume: '100' }));
  const preload = join(dir, 'provider.mjs'), riskPath = join(dir, 'risk.json');
  const risk = JSON.stringify({ schemaVersion: 1, orders: [], events: [] });
  await writeFile(riskPath, risk);
  await writeFile(join(dir, 'universe.json'), JSON.stringify([{ symbol: 'ES', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }]));
  await writeFile(join(dir, 'session.json'), JSON.stringify({ sessionDate: session.marketDate, dayTrades: [trade], marks: [] }));
  await writeFile(preload, `
Date.now = () => ${now};
globalThis.fetch = async (url, init = {}) => {
  if (process.env.OMNIMOD_TEST_NO_HTTP === 'true') throw Error('Unexpected repeat HTTP');
  const target = new URL(url);
  if (target.hostname !== 'hist.databento.com') throw Error('Unmocked network blocked');
  if (target.pathname === '/v0/metadata.get_cost') return new Response('0.004');
  const form = new URLSearchParams(init.body);
  if (form.get('schema') !== 'ohlcv-1h' || form.get('symbols') !== 'ESZ6' || form.get('map_symbols') !== 'true') throw Error('Invalid H1 request');
  return new Response(${JSON.stringify(sourceRecords.map(JSON.stringify).join('\n') + '\n')});
};
`);
  const env = { ...process.env, FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'manual', FUTURES_POSITION_MARK_SOURCE: 'manual',
    FUTURES_TREND_DATA_SOURCE: 'databento-historical', FUTURES_CATALYST_SOURCE: 'manual', FUTURES_CONTRACT_DISCOVERY_ENABLED: 'false',
    FUTURES_ACTIVITY_DISCOVERY_ENABLED: 'false', FUTURES_FILE: join(dir, 'universe.json'), FUTURES_DAY_SESSION_FILE: join(dir, 'session.json'),
    FUTURES_H1_CACHE: join(dir, 'h1.json'), FUTURES_H1_MIN_BARS: '50', FUTURES_H1_LOOKBACK_DAYS: '7', DATABENTO_API_KEY: 'test-fixture-only',
    DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_MAX_SCAN_COST_USD: '1', TRADING_RISK_STATE_PATH: riskPath, PAPER_ACCOUNT_EQUITY_USD: '200000',
    OMNIMOD_SIGNAL_RESEARCH_PATH: join(dir, 'signals.jsonl'), OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
    DISCORD_WEBHOOK_URL: '', DISCORD_TOKEN: '', DISCORD_DELIVERY_MODE: 'webhook' };
  const run = (overrides = {}) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'futures/src/index.js')],
      { cwd: dir, encoding: 'utf8', timeout: 20_000, env: { ...env, ...overrides } });
    assert.equal(result.status, 0, result.stderr.slice(-2000)); return JSON.parse(result.stdout);
  };
  const first = run();
  assert.equal(first.trendDataDiagnostics.complete, 1);
  assert.equal(first.funnel.dayTrade.strategyQualified, 1, JSON.stringify(first.dayResults));
  assert.equal(first.funnel.dayTrade.riskRejected, 1);
  assert.equal(first.funnel.dayTrade.reservationsCreated, 0);
  assert.equal(first.dayResults[0].candidate.direction, 'long');
  assert.ok(first.dayResults[0].decision.reasons.some((r) => r.includes('emergency')));
  assert.equal(first.funnel.provider.requests, 2);
  const second = run({ OMNIMOD_TEST_NO_HTTP: 'true', FUTURES_MAX_SCAN_COST_USD: '0' });
  assert.equal(second.trendDataDiagnostics.cache.hit, true);
  assert.equal(second.funnel.provider.requests, 0);
  assert.equal(second.funnel.dayTrade.strategyQualified, 1);
  assert.equal(await readFile(riskPath, 'utf8'), risk);
  const journal = (await readFile(join(dir, 'data/futures-scan-diagnostics.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).diagnostics.trendDataDiagnostics.cache.hit, true);
  assert.equal(journal.at(-1).diagnostics.trendDataDiagnostics.recordDispositions.h1_accepted_bar, 60);
});
