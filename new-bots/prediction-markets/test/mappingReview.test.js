import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewMarketMappings } from '../src/mappingReview.js';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const valid = { polymarketSlug: 'exact-market', kalshiTicker: 'EVENT-26', rulesReviewed: true, reviewedAt: '2026-09-20T12:00:00.000Z' };

test('only recently reviewed exact mappings are enabled', () => {
  const status = reviewMarketMappings([valid], { now, maxAgeDays: 30 });
  assert.equal(status.confirmed.length, 1);
  assert.equal(status.expired.length, 0);
  assert.equal(status.unreviewed.length, 0);
});

test('stale or future review dates expire instead of comparing potentially changed rules', () => {
  const stale = { ...valid, reviewedAt: '2026-07-01T12:00:00.000Z' };
  const future = { ...valid, reviewedAt: '2026-09-25T12:00:00.000Z' };
  const status = reviewMarketMappings([stale, future], { now, maxAgeDays: 30 });
  assert.equal(status.confirmed.length, 0);
  assert.equal(status.expired.length, 2);
});

test('placeholders and unreviewed mappings never become active', () => {
  const placeholder = { ...valid, kalshiTicker: 'REPLACE-TICKER' };
  const unreviewed = { ...valid, rulesReviewed: false };
  const status = reviewMarketMappings([placeholder, unreviewed], { now, maxAgeDays: 30 });
  assert.equal(status.confirmed.length, 0);
  assert.equal(status.unreviewed.length, 2);
});
