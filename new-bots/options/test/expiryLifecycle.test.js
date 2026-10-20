import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOptionExpiryLifecycle } from '../src/expiryLifecycle.js';

test('option expiry diagnostics use New York market date and distinguish open, reserved, and terminal rows', () => {
  const now = Date.parse('2026-10-01T03:30:00Z'); // 2026-09-30 23:30 in New York.
  const orders = [
    { owner: 'options', assetClass: 'option', status: 'open', option: { expiry: '2026-09-29' } },
    { owner: 'options', assetClass: 'option', status: 'reserved', option: { expiry: '2026-09-29' } },
    { owner: 'options', assetClass: 'option', status: 'filled', option: { expiry: '2026-09-30' } },
    { owner: 'options', assetClass: 'option', status: 'open', option: { expiry: '2026-10-03' } },
    { owner: 'options', assetClass: 'option', status: 'open', option: { expiry: 'not-a-date' } },
    { owner: 'options', assetClass: 'option', status: 'closed', option: { expiry: '2026-09-20' } },
    { owner: 'stocks', assetClass: 'stock', status: 'open', option: { expiry: '2026-09-20' } },
  ];
  const result = summarizeOptionExpiryLifecycle(orders, now);
  assert.equal(result.status, 'attention_required');
  assert.equal(result.marketDate, '2026-09-30');
  assert.equal(result.activeOrders, 5);
  assert.equal(result.openPositions, 4);
  assert.equal(result.pastExpiryPositions, 1);
  assert.equal(result.pastExpiryReservations, 1);
  assert.equal(result.expiryTodayPositions, 1);
  assert.equal(result.expiryWithinThreeDaysPositions, 1);
  assert.equal(result.missingOrInvalidExpiry, 1);
  assert.match(result.semantics, /No option settlement/);
});

test('empty option ledger reports clear and invalid inputs fail closed', () => {
  assert.equal(summarizeOptionExpiryLifecycle([], Date.parse('2026-09-30T16:00:00Z')).status, 'clear');
  assert.throws(() => summarizeOptionExpiryLifecycle({}, Date.now()), /orders array/);
  assert.throws(() => summarizeOptionExpiryLifecycle([], NaN), /finite timestamp/);
});

test('an active option expiring today cannot be reported as a clear lifecycle', () => {
  const now = Date.parse('2026-10-01T15:00:00Z');
  const position = summarizeOptionExpiryLifecycle([
    { owner: 'options', assetClass: 'option', status: 'open', option: { expiry: '2026-10-01' } },
  ], now);
  assert.equal(position.status, 'attention_required');
  assert.equal(position.expiryTodayPositions, 1);
  assert.equal(position.expiryTodayReservations, 0);

  const reservation = summarizeOptionExpiryLifecycle([
    { owner: 'options', assetClass: 'option', status: 'reserved', option: { expiry: '2026-10-01' } },
  ], now);
  assert.equal(reservation.status, 'attention_required');
  assert.equal(reservation.expiryTodayPositions, 0);
  assert.equal(reservation.expiryTodayReservations, 1);
  assert.match(reservation.semantics, /No option settlement/);
});
