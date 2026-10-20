import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshClearCatalystReview } from '../catalystReview.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const clearReview = { status: 'clear', source: 'manual-review', summary: 'No high-impact scheduled event found.', reviewedAt: new Date(now - 1_000).toISOString() };

test('catalyst clearance requires status, provenance, explanation and a fresh timestamp', () => {
  assert.equal(isFreshClearCatalystReview(clearReview, { now }), true);
  for (const review of [
    { ...clearReview, source: '' }, { ...clearReview, summary: 'no' },
    { ...clearReview, reviewedAt: new Date(now - 31 * 60_000).toISOString() },
    { ...clearReview, reviewedAt: new Date(now + 60_000).toISOString() },
    { ...clearReview, status: 'blocked' },
  ]) assert.equal(isFreshClearCatalystReview(review, { now }), false);
});
