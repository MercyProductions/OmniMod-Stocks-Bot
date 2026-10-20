import test from 'node:test';
import assert from 'node:assert/strict';
import { askLevels, bidLevels, buyCost, buyCostWithFees, displayedSpread, displayedSpreadWithFees, feeForFill, sizeCompleteSetToBudget } from '../src/bookAnalysis.js';

test('book helpers choose best levels independent of provider ordering', () => {
  const book = { asks: [{ price: '0.55', size: '3' }, { price: '0.42', size: '5' }], bids: [{ price: '0.37', size: '8' }, { price: '0.40', size: '2' }] };
  assert.equal(askLevels(book)[0].price, 0.42);
  assert.equal(bidLevels(book)[0].price, 0.4);
  assert.ok(Math.abs(displayedSpread(book).spreadCents - 2) < 1e-9);
  assert.equal(displayedSpread(book).visibleTwoSidedSize, 2);
});

test('buy cost walks visible ask depth and rejects insufficient displayed size', () => {
  const book = { asks: [{ price: '0.50', size: '2' }, { price: '0.40', size: '3' }] };
  assert.ok(Math.abs(buyCost(book, 4) - 1.7) < 1e-9);
  assert.equal(buyCost(book, 6), null);
});

test('crossed or incomplete top of book is not treated as a spread', () => {
  assert.equal(displayedSpread({ bids: [{ price: 0.51, size: 5 }], asks: [{ price: 0.50, size: 5 }] }), null);
  assert.equal(displayedSpread({ bids: [], asks: [{ price: 0.5, size: 5 }] }), null);
});

test('Polymarket market fee schedule is applied to taker fills and omitted for taker-only makers', () => {
  const schedule = { rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.15 };
  assert.equal(feeForFill(100, 0.5, schedule), 1.25);
  assert.equal(feeForFill(100, 0.5, schedule, { liquidityRole: 'maker' }), 0);
  const book = { asks: [{ price: '0.50', size: '100' }] };
  assert.deepEqual(buyCostWithFees(book, 100, { feesEnabled: true, feeSchedule: schedule }), {
    notionalUsd: 50, feeUsd: 1.25, totalUsd: 51.25, filledShares: 100,
  });
  assert.equal(buyCostWithFees(book, 100, { feesEnabled: true }), null);
  assert.deepEqual(buyCostWithFees(book, 100, { feesEnabled: false }), {
    notionalUsd: 50, feeUsd: 0, totalUsd: 50, filledShares: 100,
  });
});

test('complete-set sizing stays within all-in cash budget and enforces each leg minimum', () => {
  const yes = { asks: [{ price: '0.40', size: '100' }] };
  const no = { asks: [{ price: '0.50', size: '100' }] };
  const market = { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } };
  const sized = sizeCompleteSetToBudget(yes, no, 25, market, { minOrderUsd: 5 });
  assert.ok(sized);
  assert.ok(sized.totalCostUsd <= 25);
  assert.ok(sized.totalCostUsd > 24.99);
  assert.ok(sized.yes.notionalUsd >= 5 && sized.no.notionalUsd >= 5);
  assert.ok(sized.netProfitUsd < sized.grossProfitUsd);
  assert.equal(sizeCompleteSetToBudget(yes, no, 5, market, { minOrderUsd: 5 }), null);
});

test('maker spread watch reports maker-fee-adjusted spread or fails closed when fees are unknown', () => {
  const book = { bids: [{ price: 0.45, size: 100 }], asks: [{ price: 0.55, size: 100 }] };
  const spread = displayedSpreadWithFees(book, { feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1, takerOnly: true } });
  assert.equal(spread.makerFeeStatus, 'market-schedule-applied');
  assert.equal(spread.netDisplayedSpreadCents, 10);
  const unknown = displayedSpreadWithFees(book, {});
  assert.equal(unknown.netDisplayedSpreadCents, null);
  assert.equal(unknown.makerFeeStatus, 'fee-status-unknown');
});
