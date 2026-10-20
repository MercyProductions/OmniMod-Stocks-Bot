import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBacktestSegment } from '../src/backtestReport.js';

test('stock backtest marks performance estimates unavailable when a segment has no graded trades', () => {
  const report = formatBacktestSegment([{ status: 'not_filled', dateKey: '2026-09-28' }, { status: 'tracking', dateKey: '2026-09-29' }]);
  assert.equal(report.signals, 2);
  assert.equal(report.graded, 0);
  assert.equal(report.performanceByOutcome.not_filled.count, 1);
  assert.equal(report.performanceByOutcome.not_filled.expectancyR, null);
  assert.equal(report.performanceByOutcome.loss.count, 0);
  assert.equal(report.performanceByOutcome.loss.netR, null);
  assert.equal(report.signalSessions, 2);
  assert.equal(report.gradedSessions, 0);
  assert.equal(report.performanceStatus, 'no graded trades; estimates unavailable');
  for (const key of ['targetHitRate', 'profitableRate', 'expectancyR', 'profitFactor', 'maxDrawdownR', 'netR']) {
    assert.equal(report[key], null, `${key} must not imply zero-return evidence`);
  }
});

test('stock backtest reports trades and distinct graded sessions for descriptive outcome metrics', () => {
  const report = formatBacktestSegment([
    { status: 'loss', entryPrice: 100, currentPrice: 99, stopPct: 1, dateKey: '2026-09-28' },
    { status: 'target_hit', targetPct: 2, stopPct: 1, dateKey: '2026-09-28' },
    { status: 'fell_short', currentPrice: 100, entryPrice: 100, stopPct: 1, dateKey: '2026-09-29' },
  ]);
  assert.equal(report.signals, 3);
  assert.equal(report.graded, 3);
  assert.equal(report.signalSessions, 2);
  assert.equal(report.gradedSessions, 2);
  assert.equal(report.performanceStatus, 'descriptive only; inspect trade and session sample sizes');
  assert.equal(report.targetHitRate, '33.3%');
  assert.equal(report.profitableRate, '33.3%');
  assert.equal(report.expectancyR, 0.333);
  assert.equal(report.profitFactor, 2);
  assert.equal(report.netR, 1);
  assert.equal(report.performanceByOutcome.loss.count, 1);
  assert.equal(report.performanceByOutcome.loss.expectancyR, -1);
  assert.equal(report.performanceByOutcome.target_hit.count, 1);
  assert.equal(report.performanceByOutcome.target_hit.expectancyR, 2);
  assert.equal(report.performanceByOutcome.fell_short.count, 1);
  assert.equal(report.performanceByOutcome.fell_short.netR, 0);
  assert.equal(report.performanceByOutcome.exceeded.expectancyR, null);
});
