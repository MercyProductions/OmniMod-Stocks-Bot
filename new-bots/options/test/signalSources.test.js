import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionSignalsFromShared, resolveOptionSignalsFromShared } from '../src/signalSources.js';

const record = (overrides = {}) => ({ owner: 'stocks', id: 'journal-1', signalId: 'signal-1', strategyId: 'scalp', status: 'active', symbol: 'spy', sessionDate: '2026-09-29', direction: 'long', entryPrice: 100, targetPrice: 104, entryLow: 99, entryHigh: 101, observedAt: '2026-09-29T15:00:00.000Z', ...overrides });

test('shared Stocks paper signals map to Options inputs with catalyst review but no assumed open session', () => {
  const rows = buildOptionSignalsFromShared([record({ catalystContextStatus: 'available', catalystContext: [{ publisher: 'Wire', headline: 'Earnings update', sourceUrl: 'https://news.example/a', activityAt: '2026-09-29T14:30:00Z' }] })], { reviews: [{ symbol: 'SPY', status: 'clear', source: 'manual-review', summary: 'No high-impact event found.', reviewedAt: '2026-09-29T14:59:00.000Z' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signal.underlyingSymbol, 'SPY');
  assert.equal(rows[0].signal.primarySignalId, 'journal-1');
  assert.equal(rows[0].signal.sessionOpen, false);
  assert.equal(rows[0].signal.catalystReview.status, 'clear');
  assert.equal(rows[0].signal.catalystContext[0].headline, 'Earnings update');
  assert.equal(rows[0].signal.catalystContextStatus, 'available');
});

test('shared ETF/ETP paper signals can supply option underlyings while retaining their source identity', () => {
  const rows = buildOptionSignalsFromShared([record({ owner: 'etfs-etps', symbol: 'QQQ', id: 'etf-journal', signalId: 'etf-signal' })], { reviews: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signal.underlyingSymbol, 'QQQ');
  assert.equal(rows[0].signal.primarySignalOwner, 'etfs-etps');
  assert.deepEqual(rows[0].signal.primarySignalOwners, ['etfs-etps']);
});

test('same-direction Stocks and ETF signals deduplicate to the freshest underlying record', () => {
  const mapped = resolveOptionSignalsFromShared([
    record({ owner: 'stocks', observedAt: '2026-09-29T15:00:00.000Z' }),
    record({ owner: 'etfs-etps', observedAt: '2026-09-29T15:01:00.000Z', id: 'etf', signalId: 'etf-signal' }),
  ], { reviews: [] });
  assert.equal(mapped.rows.length, 1);
  assert.equal(mapped.rows[0].signal.primarySignalOwner, 'etfs-etps');
  assert.deepEqual(mapped.rows[0].signal.primarySignalOwners, ['stocks', 'etfs-etps']);
  assert.deepEqual(mapped.rows[0].signal.primarySignalIds, ['journal-1', 'etf']);
  assert.equal(mapped.diagnostics.mappedUnderlyings, 1);
  assert.equal(mapped.diagnostics.directionConflicts, 0);
});

test('conflicting Stocks and ETF directions are withheld before chain analysis', () => {
  const mapped = resolveOptionSignalsFromShared([
    record({ owner: 'stocks', direction: 'long' }),
    record({ owner: 'etfs-etps', direction: 'short', id: 'etf' }),
  ], { reviews: [] });
  assert.deepEqual(mapped.rows, []);
  assert.equal(mapped.diagnostics.directionConflicts, 1);
  assert.deepEqual(mapped.diagnostics.conflicts, [{ symbol: 'SPY', directions: ['long', 'short'], owners: ['stocks', 'etfs-etps'] }]);
});

test('shared signal mapping attaches per-underlying call-assignment review separately from catalyst clearance', () => {
  const review = { symbol: 'SPY', status: 'clear', source: 'https://issuer.example/dividends', reviewedAt: '2026-09-29T14:59:00.000Z', reviewedThrough: '2026-10-02', nextExDividendDate: null, summary: 'No ex-dividend date through expiry.' };
  const rows = buildOptionSignalsFromShared([record()], { reviews: [], assignmentReviews: [review] });
  assert.equal(rows[0].signal.catalystReview.status, 'missing');
  assert.equal(rows[0].signal.optionAssignmentReview.reviewedThrough, '2026-10-02');
});

test('shared signal mapping reports structured eligibility reasons for ignored source rows', () => {
  const mapped = resolveOptionSignalsFromShared([
    record(), record({ id: 'old', status: 'loss', signalId: 'old' }), record({ id: 'crypto', owner: 'crypto', signalId: 'crypto' }),
    record({ direction: 'neutral', signalId: 'neutral' }), record({ targetPrice: null, signalId: 'missing-target' }),
    record({ strategyId: 'long-hold', signalId: 'long-hold' }), record({ strategyId: 'swing', signalId: 'swing' }),
  ], { reviews: [] });
  assert.deepEqual(mapped.rows.map((row) => row.signal.signalId), ['signal-1']);
  assert.equal(mapped.rows[0].signal.catalystReview.status, 'missing');
  assert.equal(mapped.diagnostics.rejectedRecordCount, 6);
  assert.equal(mapped.diagnostics.eligibleRecords, 1);
  assert.deepEqual(mapped.diagnostics.rejectionCounts, {
    source_status_not_active: 1, unsupported_source_owner: 1, strategy_not_intraday_day_trade: 2,
    direction_invalid_or_missing: 1, target_price_invalid: 1,
  });
  assert.deepEqual(mapped.diagnostics.rejectedRecords.find((row) => row.recordId === 'crypto'), {
    recordId: 'crypto', owner: 'crypto', symbol: 'SPY', reasons: ['unsupported_source_owner'],
  });
});

test('shared signal mapping rejects coercible booleans and impossible calendar dates with named reasons', () => {
  const mapped = resolveOptionSignalsFromShared([
    record({ id: 'boolean-entry', entryPrice: true }),
    record({ id: 'impossible-session', sessionDate: '2026-02-30' }),
  ], { reviews: [] });
  assert.deepEqual(mapped.rows, []);
  assert.deepEqual(mapped.diagnostics.rejectedRecords, [
    { recordId: 'boolean-entry', owner: 'stocks', symbol: 'SPY', reasons: ['entry_price_invalid'] },
    { recordId: 'impossible-session', owner: 'stocks', symbol: 'SPY', reasons: ['session_date_invalid'] },
  ]);
});

test('shared signal mapping rejects invalid catalyst review manifests', () => {
  assert.throws(() => buildOptionSignalsFromShared([], {}), /reviews and an optional assignmentReviews array/);
  assert.throws(() => buildOptionSignalsFromShared([], { reviews: [], assignmentReviews: {} }), /assignmentReviews array/);
});
