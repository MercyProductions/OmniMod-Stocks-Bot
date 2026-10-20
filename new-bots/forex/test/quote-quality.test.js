import test from 'node:test';
import assert from 'node:assert/strict';
import { assessForexQuoteTime } from '../src/quoteQuality.js';

const now = Date.parse('2026-09-29T15:00:00Z');

test('Forex quote freshness consistently allows at most five seconds of future clock skew', () => {
  assert.equal(assessForexQuoteTime(now + 5_000, { now, maxAgeMs: 120_000 }).status, 'fresh');
  assert.equal(assessForexQuoteTime(now + 5_001, { now, maxAgeMs: 120_000 }).status, 'future_quote');
  assert.equal(assessForexQuoteTime(now - 120_000, { now, maxAgeMs: 120_000 }).status, 'fresh');
  assert.equal(assessForexQuoteTime(now - 120_001, { now, maxAgeMs: 120_000 }).status, 'stale_quote');
});

test('Forex quote freshness rejects malformed time and age policies', () => {
  assert.equal(assessForexQuoteTime('not-a-date', { now, maxAgeMs: 10_000 }).status, 'invalid_timestamp_or_policy');
  assert.equal(assessForexQuoteTime(now, { now, maxAgeMs: -1 }).status, 'invalid_timestamp_or_policy');
});
