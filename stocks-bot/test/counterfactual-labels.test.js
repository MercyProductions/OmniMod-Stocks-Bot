import test from 'node:test';
import assert from 'node:assert/strict';
import { counterfactualTradePlan, labelCounterfactualSnapshot } from '../src/counterfactualLabels.js';

function snapshot(overrides = {}) {
  return {
    snapshotId: 'snapshot-1', guildId: 'guild', symbol: 'NVDA', recordedAt: '2026-07-21T15:00:00.000Z',
    price: 100, livePrice: 100, bidPrice: 99.98, askPrice: 100.02, spreadBps: 4, halted: false,
    marketRegime: 'risk-on trend', marketMinute: 660,
    features: { dailyAtrPercent: 2, intradayAtrPercent: 0.4 }, ...overrides
  };
}

function bars(overrides = {}) {
  return Array.from({ length: 31 }, (_, index) => ({
    symbol: 'NVDA', timestamp: Math.floor(new Date('2026-07-21T15:00:00.000Z').getTime() / 1000) + index * 60,
    open: 100.05, high: 100.3, low: 99.9, close: 100.1, volume: 1000, ...overrides
  }));
}

test('counterfactual label uses executable costs and matures only with full horizon coverage', () => {
  const row = snapshot(); const plan = counterfactualTradePlan(row, 30, { slippageBps: 10 });
  const labels = labelCounterfactualSnapshot(row, bars(), { horizons: [30], slippageBps: 10 });
  assert.equal(labels.length, 1);
  assert.equal(labels[0].horizonMinutes, 30);
  assert.ok(labels[0].entryPrice > row.askPrice);
  assert.equal(labels[0].terminal, 'timeout');
  assert.ok(labels[0].netReturnPct < 0.1);
  assert.equal(labelCounterfactualSnapshot(row, bars().slice(0, 10), { horizons: [30] }).length, 0);
  assert.ok(plan.stopPrice < plan.entryPrice && plan.targetPrice > plan.entryPrice);
});

test('counterfactual barrier labels ambiguous bars stop-first', () => {
  const row = snapshot(); const plan = counterfactualTradePlan(row, 30, { slippageBps: 8 });
  const path = bars({ high: plan.targetPrice * 1.01, low: plan.stopPrice * 0.99 });
  const [label] = labelCounterfactualSnapshot(row, path, { horizons: [30], slippageBps: 8 });
  assert.equal(label.terminal, 'stop');
  assert.equal(label.ambiguousBarrier, true);
  assert.ok(label.realizedR < 0);
});

test('counterfactual still records a screen without treating a missing quote as executable training data', () => {
  const [label] = labelCounterfactualSnapshot(snapshot({ bidPrice: 0, askPrice: 0 }), bars(), { horizons: [30] });
  assert.equal(label.executable, false);
});
