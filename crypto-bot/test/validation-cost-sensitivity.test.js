import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStrategy } from '../src/backtest.js';
import { compareCurrentQuoteCost } from '../src/validationCostSensitivity.js';
import { summarizeValidationCostSensitivity } from '../src/scanDiagnostics.js';

function candles(count = 360) {
  let previous = 100;
  return Array.from({ length: count }, (_, index) => {
    const close = previous * (1 + 0.0006 + Math.sin(index / 7) * 0.0008);
    const row = { time: 1_700_000_000_000 + index * 900_000, open: previous,
      high: Math.max(previous, close) * 1.003, low: Math.min(previous, close) * 0.997,
      close, volume: 1_000_000 + Math.sin(index / 5) * 100_000 };
    previous = close;
    return row;
  });
}

test('current quote-cost sensitivity replays the same historical path without changing baseline approval', () => {
  const rows = candles();
  const baseline = validateStrategy(rows, { minimumScore: 64, rewardRisk: 1.7, roundTripFeeBps: 20 });
  const comparison = compareCurrentQuoteCost({ candles: rows, baseline,
    execution: { estimatedRoundTripBps: 75, quality: 'REST/ATR fallback' },
    providerCount: 2, minimumScore: 64, rewardRisk: 1.7 });
  assert.equal(comparison.status, 'compared');
  assert.equal(comparison.basis, 'current_quote_cost_applied_to_prior_candles');
  assert.equal(comparison.baselineCostBps, 20);
  assert.equal(comparison.quoteCostBps, 75);
  assert.equal(comparison.baseline.overall.trades, baseline.overall.trades);
  assert.equal(comparison.quoteScenario.overall.trades,
    validateStrategy(rows, { minimumScore: 64, rewardRisk: 1.7, roundTripFeeBps: 75 }).overall.trades);
  assert.equal(baseline.costModel.roundTripBps, 20);
  assert.equal(compareCurrentQuoteCost({ candles: rows, baseline,
    execution: { estimatedRoundTripBps: 75 }, providerCount: 1 }).reason,
  'executable_quote_consensus_unavailable');
  assert.equal(compareCurrentQuoteCost({ candles: rows, baseline,
    execution: { estimatedRoundTripBps: 201 }, providerCount: 2 }).reason,
  'cost_outside_replay_range');
  assert.equal(compareCurrentQuoteCost({ candles: rows.slice(0, 5), baseline,
    execution: { estimatedRoundTripBps: 75 }, providerCount: 2 }).reason,
  'missing_historical_validation');
});

test('scan summary distinguishes observed reversals from unavailable comparisons', () => {
  const compared = { status: 'compared', baselinePassed: true, quoteScenarioPassed: false };
  const summary = summarizeValidationCostSensitivity([
    { id: 'one', symbol: 'ONE', marketData: { validationCostSensitivity: compared } },
    { id: 'two', symbol: 'TWO', marketData: { validationCostSensitivity: {
      status: 'unavailable', reason: 'incomplete_historical_candle_path' } } },
  ]);
  assert.equal(summary.deepAssets, 2);
  assert.equal(summary.compared, 1);
  assert.equal(summary.passedToFailed, 1);
  assert.equal(summary.quoteScenarioPassing, 0);
  assert.deepEqual(summary.unavailableByReason, { incomplete_historical_candle_path: 1 });
});
