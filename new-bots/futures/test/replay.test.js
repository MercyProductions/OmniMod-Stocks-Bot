import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replayFuturesOpeningRange } from '../src/replay.js';
import { runFuturesReplayFile } from '../scripts/replay.js';

const open = Date.parse('2026-09-29T13:00:00Z');
const decision = Date.parse('2026-09-29T15:00:00Z');
const step = 5 * 60_000;
const contract = {
  symbol: 'ES', providerSymbol: 'ESZ26', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', assetClass: 'equity-index-future',
  underlying: 'S&P 500', exposureKey: 'SPY', activeContract: true, contractSpecVerified: true, contractMode: 'active-contract',
  expiry: '2026-12-18T14:30:00.000Z', multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5,
  initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000,
  specSource: 'https://example.test/fixture-contract-master', specVerifiedAt: '2026-09-29T12:00:00.000Z',
  settlementReview: { settlementType: 'cash_settled', source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html',
    reviewedAt: '2026-09-29T12:00:00.000Z', lastTradeAt: '2026-12-18T14:30:00.000Z' },
};
const bars = Array.from({ length: 24 }, (_, i) => {
  const close = 6000 + i * 0.02;
  const time = open + i * step;
  return { time: new Date(time).toISOString(), completedAt: new Date(time + step).toISOString(),
    open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100 };
});
bars[0] = { ...bars[0], high: 6001, low: 5999 };
bars[1] = { ...bars[1], high: 6001.25, low: 5999.25 };
bars[2] = { ...bars[2], high: 6000.75, low: 5999.5 };
bars.at(-1).open = 6000.4; bars.at(-1).close = 6010; bars.at(-1).high = 6010.25; bars.at(-1).low = 6000.3; bars.at(-1).volume = 250;
const trendBars = Array.from({ length: 60 }, (_, i) => {
  const close = 6000 + i * 0.02, time = decision - 60 * 60_000 * 60 + i * 60 * 60_000;
  return { time: new Date(time).toISOString(), open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100 };
});
const session = { marketDate: '2026-09-29', timeZone: 'America/Chicago', openTime: open,
  closeTime: Date.parse('2026-09-29T20:00:00Z'), source: 'https://www.cmegroup.com/markets/equities.html',
  reviewedAt: new Date(decision).toISOString() };
const catalystReview = { status: 'clear', source: 'fixture exchange calendar review',
  summary: 'Point-in-time reviewed event state.', reviewedAt: new Date(decision).toISOString() };
const quote = (minutes, bid, ask) => ({ bid, ask, time: new Date(decision + minutes * 60_000).toISOString(), quality: 'executable' });

test('futures replay calls the existing contract/session/catalyst strategy and completes costed later-quote trade', async () => {
  const context = { contract, trendBars, session, catalystReview };
  const report = await replayFuturesOpeningRange({ contract, fiveMinuteBars: bars, accountEquityUsd: 200_000,
    config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 },
    executionCostSchedule: [{ id: 'es-fees', validFrom: new Date(decision - 60_000).toISOString(), validUntil: new Date(decision + 20 * 60_000).toISOString(),
      roundTripFeesPerUnit: 6, slippageReservePerUnit: 3, source: 'https://data.example.com/futures-fees' }],
    shadowConfigs: [{ id: 'higher-relative-volume', overrides: { minRelativeVolume: 1.8 } }],
    policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 0.1, maxTradeRiskPct: 0.5,
      maxTotalOpenRiskPct: 3, maxGrossExposurePct: 200, maxDailyLossPct: 3, minRewardRisk: 1.25 },
    observations: [
      { asOf: quote(0, 6009.75, 6010).time, quote: quote(0, 6009.75, 6010), context },
      { asOf: quote(5, 6009.5, 6009.75).time, quote: quote(5, 6009.5, 6009.75), context },
      { asOf: quote(10, 6030.25, 6030.5).time, quote: quote(10, 6030.25, 6030.5), context },
    ] });
  assert.equal(report.candidatesConsidered, 2);
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.unresolvedOrders, 0);
  assert.equal(report.trades[0].exitReason, 'target');
  assert.ok(report.feesUsd > 0);
  assert.ok(report.slippageReserveUsd > 0);
  assert.equal(report.trades[0].executionCostContext.id, 'es-fees');
  assert.equal(report.shadowStrategies.length, 1);
  assert.equal(report.shadowStrategies[0].mode, 'isolated_shadow_paper_replay');
  assert.equal(report.shadowStrategies[0].report.owner, 'futures');
});

test('futures replay rejects contract metadata learned after the historical decision time', async () => {
  const report = await replayFuturesOpeningRange({ contract: { ...contract, specVerifiedAt: '2026-09-29T16:00:00Z' },
    fiveMinuteBars: bars, accountEquityUsd: 200_000,
    observations: [{ asOf: quote(0, 6009.75, 6010).time, quote: quote(0, 6009.75, 6010), context: {
      contract: { ...contract, specVerifiedAt: '2026-09-29T16:00:00Z' }, trendBars, session, catalystReview,
    } }], config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 } });
  assert.equal(report.candidatesConsidered, 0);
  assert.equal(report.topRejectionReasons.historical_contract_metadata_not_valid_as_of_decision, 1);
});

test('Futures backtest command reads a local JSON dataset and performs no provider fetch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-replay-'));
  const file = join(directory, 'replay.json');
  try {
    await writeFile(file, JSON.stringify({ contract, fiveMinuteBars: bars, accountEquityUsd: 200_000,
      config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 },
      policy: { maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 3, maxGrossExposurePct: 200, maxDailyLossPct: 3, minRewardRisk: 1.25 },
      observations: [{ asOf: quote(0, 6009.75, 6010).time, quote: quote(0, 6009.75, 6010), context: { trendBars, session, catalystReview } }] }));
    const result = await runFuturesReplayFile(file);
    assert.equal(result.dataset, resolve(file));
    assert.equal(result.report.candidatesConsidered, 1);
    assert.equal(result.report.reservationsCreated, 1);
    assert.equal(result.report.unresolvedOrders, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Futures replay CLI evaluates disjoint chronological windows with the same frozen contract and strategy config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-holdout-'));
  const file = join(directory, 'replay.json');
  const observations = [0, 1, 2, 3].map((minute) => ({ asOf: quote(minute, 6009.75, 6010).time,
    quote: quote(minute, 6009.75, 6010), context: { contract, trendBars, session, catalystReview } }));
  try {
    await writeFile(file, JSON.stringify({ contract, fiveMinuteBars: bars, accountEquityUsd: 200_000,
      config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 },
      policy: { maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 3, maxGrossExposurePct: 200, maxDailyLossPct: 3, minRewardRisk: 1.25 },
      observations, evaluationWindows: [
        { id: 'holdout-a', start: observations[0].asOf, end: observations[1].asOf },
        { id: 'holdout-b', start: observations[2].asOf, end: observations[3].asOf },
      ] }));
    const result = await runFuturesReplayFile(file);
    assert.equal(result.report.mode, 'fixed-strategy-chronological-holdout-windows');
    assert.deepEqual(result.report.windows.map((row) => row.id), ['holdout-a', 'holdout-b']);
    assert.ok(result.report.windows.every((row) => row.report.owner === 'futures' && row.report.scoreFrom === row.start));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
