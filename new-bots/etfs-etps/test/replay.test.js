import { stockQuote } from '../../shared/fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayEtfOpeningRange } from '../src/replay.js';
import { runEtfReplayFile } from '../scripts/replay.js';

const open = Date.parse('2026-09-29T13:30:00Z');
const step = 5 * 60_000;
const bars = Array.from({ length: 27 }, (_, index) => {
  const time = open + index * step;
  const breakout = index === 24;
  const continuation = index > 24;
  return { time: new Date(time).toISOString(), completedAt: new Date(time + step).toISOString(),
    open: continuation ? 100.7 : 100.1, high: breakout || continuation ? 100.95 : 100.2,
    low: breakout ? 99.8 : continuation ? 100.65 : 99.8,
    close: breakout || continuation ? 100.8 : 100.1, volume: breakout || continuation ? 2_500 : 1_000 };
});
const session = { marketDate: '2026-09-29', openTime: open, closeTime: open + 78 * step,
  timeZone: 'America/New_York', catalystReview: { status: 'clear', source: 'point-in-time fixture review',
    summary: 'No scheduled material event.', reviewedAt: '2026-09-29T15:35:00.000Z' } };
const quote = (minutes, bid, ask) => stockQuote('SPY', { bid, ask, time: new Date(Date.parse('2026-09-29T15:35:00Z') + minutes * 60_000).toISOString(), quality: 'executable' });

test('ETF/ETP replay uses the existing strategy, costed later-quote paper lifecycle, and isolated shadow profile', async () => {
  const report = await replayEtfOpeningRange({ symbol: 'SPY', accountEquityUsd: 10_000,
    fiveMinuteBars: bars, config: { roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03, requireCatalystReview: true },
    executionCostSchedule: [{ id: 'spy-fees', validFrom: '2026-09-29T15:30:00.000Z', validUntil: '2026-09-29T16:00:00.000Z',
      roundTripFeesPerUnit: 0.04, slippageReservePerUnit: 0.02, source: 'https://data.example.com/etf-fees' }],
    shadowConfigs: [{ id: 'high-volume-only', overrides: { minRelativeVolume: 3 } }],
    policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 3,
      maxGrossExposurePct: 200, maxDailyLossPct: 3, minRewardRisk: 1.5 },
    observations: [
      { asOf: quote(0, 100.8, 100.81).time, quote: quote(0, 100.8, 100.81), context: { session } },
      { asOf: quote(5, 100.8, 100.81).time, quote: quote(5, 100.8, 100.81), context: { session } },
      { asOf: quote(10, 102.5, 102.51).time, quote: quote(10, 102.5, 102.51), context: { session } },
    ] });
  assert.equal(report.candidatesConsidered, 2);
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.unresolvedOrders, 0);
  assert.equal(report.trades[0].exitReason, 'target');
  assert.ok(report.feesUsd > 0);
  assert.ok(report.slippageReserveUsd > 0);
  assert.equal(report.trades[0].executionCostContext.id, 'spy-fees');
  assert.equal(report.shadowStrategies.length, 1);
  assert.equal(report.shadowStrategies[0].mode, 'isolated_shadow_paper_replay');
  assert.equal(report.shadowStrategies[0].report.owner, 'etfs-etps');
});

test('ETF/ETP replay cannot see bars before their completion timestamp', async () => {
  const report = await replayEtfOpeningRange({ symbol: 'SPY', accountEquityUsd: 10_000, fiveMinuteBars: bars,
    observations: [{ asOf: '2026-09-29T15:34:59.000Z', quote: quote(-1, 100.8, 100.81), context: { session } }] });
  assert.equal(report.candidatesConsidered, 0);
  assert.ok(report.futureBarsExcluded > 0);
});

test('ETF replay CLI evaluates explicit holdout windows independently with one frozen config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-etf-holdout-'));
  try {
    const path = join(directory, 'dataset.json');
    const observations = [0, 5, 10, 15].map((minute) => ({
      asOf: quote(minute, 100, 100.01).time,
      quote: quote(minute, 100, 100.01),
      context: { regimeKey: 'mixed', session },
    }));
    await writeFile(path, JSON.stringify({ symbol: 'SPY', accountEquityUsd: 10_000, fiveMinuteBars: [], config: { roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.02 },
      observations, evaluationWindows: [
        { id: 'holdout-a', start: observations[0].asOf, end: observations[1].asOf },
        { id: 'holdout-b', start: observations[2].asOf, end: observations[3].asOf },
      ] }), 'utf8');
    const result = await runEtfReplayFile(path);
    assert.equal(result.report.mode, 'fixed-strategy-chronological-holdout-windows');
    assert.deepEqual(result.report.windows.map((row) => row.id), ['holdout-a', 'holdout-b']);
    assert.deepEqual(result.report.windows.map((row) => row.scoredObservations), [2, 2]);
    assert.ok(result.report.windows.every((row) => row.report.owner === 'etfs-etps' && row.report.reservationsCreated === 0));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
