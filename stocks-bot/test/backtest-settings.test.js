import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssumedSlippageBps, predictionCostSettings } from '../src/backtestSettings.js';

test('stock backtest honors explicit zero slippage and uses the documented default only when omitted', () => {
  assert.equal(parseAssumedSlippageBps(undefined), 8);
  assert.equal(parseAssumedSlippageBps('0'), 0);
  assert.equal(parseAssumedSlippageBps('12.5'), 12.5);
});

test('stock backtest rejects invalid or out-of-range per-side slippage assumptions', () => {
  for (const value of ['NaN', 'unlimited', '-1', '100.1']) {
    assert.throws(() => parseAssumedSlippageBps(value), /0 to 100 per side/);
  }
});

test('dated stock cost provenance and spread-adjusted slippage reach prediction grading', () => {
  const row = { id: 'alpaca-2026', feeBpsPerSide: 1, slippageBpsPerSide: 2, source: 'https://example.com/fees' };
  const settings = predictionCostSettings({ assumedSlippageBps: 8 }, row, 10);
  assert.equal(settings.commissionBpsPerSide, 1);
  assert.equal(settings.assumedSlippageBps, 2);
  assert.equal(settings.executionCostContext.id, row.id);
  assert.equal(settings.executionCostContext.appliedSlippageBpsPerSide, 5);
  assert.equal(settings.allowRuleOnlySignals, true);
});
