import test from 'node:test';
import assert from 'node:assert/strict';
import { conservativeApyRate, poolTimestampStatus, rankPoolsByConservativeApy } from '../src/ranking.js';

test('pool ranking does not let a high old mean hide a lower current APY', () => {
  const pools = [
    { pool: 'falling', apy: 2, apyMean30d: 12 },
    { pool: 'steady', apy: 5, apyMean30d: 5 },
    { pool: 'spiking', apy: 18, apyMean30d: 3 }
  ];
  assert.deepEqual(rankPoolsByConservativeApy(pools).map((pool) => pool.pool), ['steady', 'spiking', 'falling']);
  assert.equal(conservativeApyRate(pools[0]), 2);
});

test('invalid APY data cannot receive a positive rank', () => {
  assert.equal(conservativeApyRate({ apy: 8, apyMean30d: null }), Number.NEGATIVE_INFINITY);
  assert.equal(conservativeApyRate({ apy: -1, apyMean30d: 4 }), Number.NEGATIVE_INFINITY);
});

test('missing upstream timestamps are visible as unknown instead of silently dropping every pool', () => {
  assert.deepEqual(poolTimestampStatus({ apy: 3 }, Date.parse('2026-09-24T12:00:00Z')), {
    eligible: true, upstreamAgeMinutes: null, status: 'upstream timestamp unavailable'
  });
});

test('provided upstream timestamps reject stale, malformed, and future rows', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(poolTimestampStatus({ timestamp: '2026-09-24T11:00:00Z' }, now).eligible, true);
  assert.equal(poolTimestampStatus({ timestamp: '2026-09-22T00:00:00Z' }, now).status, 'stale upstream timestamp');
  assert.equal(poolTimestampStatus({ timestamp: 'not-a-date' }, now).status, 'invalid upstream timestamp');
  assert.equal(poolTimestampStatus({ timestamp: '2026-09-25T00:00:00Z' }, now).status, 'future upstream timestamp');
});
