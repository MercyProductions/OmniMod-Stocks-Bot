import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectClosedTradeSequence } from '../closedTradeSequence.js';

const closed = (time, pnl) => ({ status: 'closed', closedAt: time, realizedPnlUsd: pnl });

test('closed sequence measures drawdown and loss streak only from a complete unique chronology', () => {
  const rows = [closed('2026-09-01T12:03:00Z', -1), closed('2026-09-01T12:01:00Z', 5),
    closed('2026-09-01T12:02:00Z', -2), closed('2026-09-01T12:04:00Z', 0),
    closed('2026-09-01T12:05:00Z', -3)];
  assert.deepEqual(inspectClosedTradeSequence(rows), {
    status: 'complete', observationCount: 5, maximumDrawdownUsd: 6, currentDrawdownUsd: 6,
    maximumConsecutiveLosses: 2, currentConsecutiveLosses: 1,
  });
  assert.equal(inspectClosedTradeSequence([...rows, closed('', 2)]).maximumDrawdownUsd, null);
  assert.equal(inspectClosedTradeSequence([...rows, closed('2026-09-01T12:06:00Z', null)]).status,
    'incomplete_close_sequence');
  assert.equal(inspectClosedTradeSequence([...rows, closed('2026-09-01T12:05:00Z', -1)]).status,
    'ambiguous_close_order');
  assert.equal(inspectClosedTradeSequence([]).maximumConsecutiveLosses, null);
});
