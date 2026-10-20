import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFuturesContractLifecycle } from '../src/contractLifecycle.js';

const now = Date.parse('2026-10-01T15:00:00Z');
const order = (status, expiryAt, settlementReview = {}) => ({ owner: 'futures', assetClass: 'future', status,
  future: { contractId: 'ESZ6', contractMode: 'active-contract', activeContract: true, contractSpecVerified: true,
    specSource: 'https://example.test/spec', specVerifiedAt: '2026-09-30T15:00:00Z', expiryAt, settlementReview } });
const terms = (overrides = {}) => ({ settlementType: 'cash_settled', lastTradeAt: '2026-10-02T15:00:00Z',
  entryCutoffAt: '2026-10-02T15:00:00Z', reviewedAt: '2026-09-30T15:00:00Z', ...overrides });

test('Futures lifecycle distinguishes expired positions, cutoff windows, reservations, delivery, and invalid evidence', () => {
  const staleSpec = order('open', '2026-12-18T15:00:00Z', terms({ lastTradeAt: '2026-12-17T15:00:00Z', entryCutoffAt: '2026-12-17T15:00:00Z' }));
  staleSpec.future.specVerifiedAt = '2026-05-20T15:00:00Z';
  const result = summarizeFuturesContractLifecycle([
    order('open', '2026-09-30T15:00:00Z', terms({ lastTradeAt: '2026-09-30T15:00:00Z', entryCutoffAt: '2026-09-30T15:00:00Z' })),
    order('reserved', '2026-10-02T15:00:00Z', terms({ lastTradeAt: '2026-10-01T14:00:00Z', entryCutoffAt: '2026-10-01T14:00:00Z' })),
    order('open', '2026-10-20T15:00:00Z', terms({ settlementType: 'physical_delivery', firstNoticeAt: '2026-10-01T14:00:00Z',
      lastTradeAt: '2026-10-15T15:00:00Z', entryCutoffAt: '2026-10-01T14:00:00Z' })),
    order('open', '2026-10-20T15:00:00Z', terms({ lastTradeAt: '2026-10-02T14:00:00Z', entryCutoffAt: '2026-10-02T14:00:00Z' })),
    order('open', 'bad-expiry', {}),
    staleSpec,
    { owner: 'futures', assetClass: 'future', status: 'closed', future: { contractId: 'ESZ6', expiryAt: '2020-01-01T00:00:00Z' } },
    { owner: 'stocks', assetClass: 'stock', status: 'open' },
  ], now);
  assert.equal(result.status, 'attention_required');
  assert.equal(result.activeOrders, 6);
  assert.equal(result.openPositions, 5);
  assert.equal(result.expiredPositions, 1);
  assert.equal(result.pastSettlementCutoffPositions, 2);
  assert.equal(result.pastSettlementCutoffReservations, 1);
  assert.equal(result.physicalFirstNoticePassedPositions, 1);
  assert.equal(result.settlementCutoffWithinWindowPositions, 1);
  assert.equal(result.missingOrInvalidMetadata, 1);
  assert.equal(result.staleContractSpecs, 1);
  assert.equal(result.staleSettlementReviews, 1);
});

test('Futures lifecycle clear/approaching states and invalid inputs are explicit', () => {
  assert.equal(summarizeFuturesContractLifecycle([], now).status, 'clear');
  const approaching = summarizeFuturesContractLifecycle([
    order('open', '2026-12-18T15:00:00Z', terms({ lastTradeAt: '2026-10-02T15:00:00Z', entryCutoffAt: '2026-10-02T15:00:00Z' })),
  ], now);
  assert.equal(approaching.status, 'approaching_cutoff');
  assert.equal(approaching.settlementCutoffWithinWindowPositions, 1);
  assert.throws(() => summarizeFuturesContractLifecycle({}, now), /orders array/);
  assert.throws(() => summarizeFuturesContractLifecycle([], NaN), /finite timestamp/);
});
