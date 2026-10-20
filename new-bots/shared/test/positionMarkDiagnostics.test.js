import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePositionMarkCoverage } from '../positionMarkDiagnostics.js';

test('summarizes expected marks, missing and rejected quotes, and post-scan freshness without identities', () => {
  const now = Date.parse('2026-09-29T15:00:00Z');
  const before = [
    { orderId: 'a', owner: 'options', status: 'filled' },
    { orderId: 'b', owner: 'options', status: 'open' },
    { orderId: 'c', owner: 'options', status: 'reserved' },
    { orderId: 'd', owner: 'stocks', status: 'open' },
  ];
  const after = [
    { orderId: 'a', owner: 'options', status: 'open', markedAt: new Date(now - 1_000).toISOString() },
    { orderId: 'b', owner: 'options', status: 'open', markedAt: new Date(now - 6 * 60_000).toISOString() },
    { orderId: 'c', owner: 'options', status: 'reserved' },
  ];
  const summary = summarizePositionMarkCoverage({ owner: 'options', beforeOrders: before, afterOrders: after, now,
    availableMarks: [{ orderId: 'a' }, { orderId: 'c' }, { orderId: 'd' }],
    attempts: [{ orderId: 'a', status: 'open' }, { orderId: 'b', status: 'blocked', reason: 'quote_not_current_and_executable' }] });
  assert.deepEqual(summary, {
    expectedPositions: 2, quotesProvided: 1, quoteMissing: 1, quoteAttempts: 2, quoteAccepted: 1,
    quoteRejected: 1, rejectionReasons: { quote_not_current_and_executable: 1 }, freshPositions: 1,
    staleOrUnmarkedPositions: 1, maximumMarkAgeMs: 5 * 60_000, markAgePolicyValid: true,
  });
  assert.equal(JSON.stringify(summary).includes('orderId'), false);
});

test('saved per-position mark thresholds stay stricter than the current scan threshold', () => {
  const now = Date.parse('2026-09-29T15:00:00Z');
  const summary = summarizePositionMarkCoverage({ owner: 'futures', now, maxAgeMs: 10 * 60_000,
    beforeOrders: [], availableMarks: [], attempts: [], afterOrders: [
      { owner: 'futures', status: 'open', markedAt: new Date(now - 2 * 60_000).toISOString(), maxOpenMarkAgeMs: 60_000 },
    ] });
  assert.equal(summary.staleOrUnmarkedPositions, 1);
  assert.equal(summary.freshPositions, 0);
});

test('invalid configured mark age reports every active position stale without crashing the scan', () => {
  const now = Date.parse('2026-09-29T15:00:00Z');
  const summary = summarizePositionMarkCoverage({ owner: 'forex', now, maxAgeMs: NaN,
    beforeOrders: [], afterOrders: [{ owner: 'forex', status: 'open', markedAt: new Date(now).toISOString() }] });
  assert.equal(summary.markAgePolicyValid, false);
  assert.equal(summary.maximumMarkAgeMs, null);
  assert.equal(summary.staleOrUnmarkedPositions, 1);
});
