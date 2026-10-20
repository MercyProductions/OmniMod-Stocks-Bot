import test from 'node:test';
import assert from 'node:assert/strict';
import { horizonScenario } from '../src/scenarios.js';

const base = { price: 100, volatility20dPct: 20 };

test('upward watch places invalidation below entry and targets above it', () => {
  const result = horizonScenario(base, 1, 3, '1-day');
  assert.equal(result.bias, 'UPWARD WATCH');
  assert.ok(result.invalidationScenario < result.entryReference);
  assert.ok(result.target1Scenario > result.entryReference);
  assert.ok(result.target2Scenario > result.target1Scenario);
});

test('downward watch places targets below entry and invalidation above it', () => {
  const result = horizonScenario(base, 5, -8, '5-day');
  assert.equal(result.bias, 'DOWNWARD WATCH');
  assert.ok(result.target2Scenario < result.target1Scenario);
  assert.ok(result.target1Scenario < result.entryReference);
  assert.ok(result.invalidationScenario > result.entryReference);
});

test('weak movement remains neutral and missing inputs are unavailable', () => {
  assert.equal(horizonScenario(base, 1, 0.1, '1-day').bias, 'NEUTRAL');
  assert.equal(horizonScenario({ price: 100, volatility20dPct: 0 }, 1, 2, '1-day').bias, 'UNAVAILABLE');
});
