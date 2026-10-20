import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePinnedCostScenario } from '../scripts/study-public-cost-sensitivity.mjs';
import { validateStrategy } from '../src/backtest.js';

const BAR_MS = 900_000;

function fixture() {
  const first = Date.parse('2026-09-25T00:00:00Z');
  const candles = Array.from({ length: 180 }, (_, index) => {
    const open = 100 + index * 0.12;
    return { time: first + index * BAR_MS, open, high: open + 0.3,
      low: open - 0.2, close: open + 0.1, volume: 1000 + index,
      provider: 'Binance', pair: 'TESTUSDT' };
  });
  const settings = { minScore: 64, minRiskReward: 1.7 };
  const baseline = validateStrategy(candles, { minimumScore: settings.minScore,
    rewardRisk: settings.minRiskReward, roundTripFeeBps: 20 });
  const asset = {
    assetId: 'test-coin', symbol: 'TEST', candleProvider: 'Binance', candlePair: 'TESTUSDT',
    candleCount: candles.length, candleCoverage: { contiguous: true,
      firstOpenAt: new Date(first).toISOString(),
      lastCompletedAt: new Date(candles.at(-1).time + BAR_MS).toISOString() },
    strategyValidationCostRoundTripBps: 20, executionEstimatedRoundTripBps: 35,
    strategyValidationRecentTrades: baseline.recent.trades,
    strategyValidationOverallTrades: baseline.overall.trades,
    strategyValidationRecentExpectancyR: baseline.recent.trades ? baseline.recent.expectancyR : null,
    strategyValidationOverallExpectancyR: baseline.overall.trades ? baseline.overall.expectancyR : null,
  };
  return { asset, candles, settings };
}

test('cost sensitivity replays only the frozen exact venue/pair and cutoff', () => {
  const { asset, candles, settings } = fixture();
  const baseline = comparePinnedCostScenario(asset, candles, settings);
  assert.equal(baseline.status, 'compared');
  assert.equal(baseline.candleCount, 180);
  assert.equal(baseline.costDifferenceBps, 15);
  const unrelated = [
    { ...candles[100], provider: 'Coinbase', pair: 'TEST-USD', high: 999 },
    { ...candles.at(-1), time: candles.at(-1).time + BAR_MS, high: 999 },
  ];
  assert.deepEqual(comparePinnedCostScenario(asset, [...candles, ...unrelated], settings), baseline);
  assert.equal(comparePinnedCostScenario(asset, candles.map((row) => ({ ...row, pair: 'OTHERUSDT' })), settings).reason,
    'frozen_candle_coverage_mismatch');
  assert.equal(comparePinnedCostScenario(asset, [...candles, { ...candles[100], close: candles[100].close + 0.05 }], settings).reason,
    'conflicting_source_candles');
});

test('cost sensitivity withholds incomplete or irreproducible histories', () => {
  const { asset, candles, settings } = fixture();
  assert.equal(comparePinnedCostScenario(asset, candles.filter((_, index) => index !== 120), settings).reason,
    'frozen_candle_coverage_mismatch');
  assert.equal(comparePinnedCostScenario({ ...asset, executionEstimatedRoundTripBps: 250 }, candles, settings).reason,
    'cost_outside_replay_range');
  assert.equal(comparePinnedCostScenario({ ...asset, strategyValidationOverallTrades: 999,
    strategyValidationOverallExpectancyR: 0 }, candles, settings).reason,
    'frozen_baseline_replay_mismatch');
  assert.equal(comparePinnedCostScenario({ ...asset, strategyValidationRecentExpectancyR: undefined }, candles, settings).reason,
    'missing_frozen_baseline_metrics');
});
