import test from 'node:test';
import assert from 'node:assert/strict';
import { isMarketObservationFresh, marketObservationAgeMinutes } from '../src/freshness.js';

const now = Date.parse('2026-09-24T12:00:00.000Z');

test('freshness supports configured per-row age for slower daily data', () => {
  const daily = { observedAt: new Date(now - 8 * 60 * 60_000).toISOString(), maxAgeMinutes: 1440 };
  assert.equal(isMarketObservationFresh(daily, now, 15), true);
  assert.ok(Math.abs(marketObservationAgeMinutes(daily, now) - 480) < 1e-9);
});

test('global limit applies by default and stale/future observations are rejected', () => {
  assert.equal(isMarketObservationFresh({ observedAt: new Date(now - 20 * 60_000).toISOString() }, now, 15), false);
  assert.equal(isMarketObservationFresh({ observedAt: new Date(now + 60_000).toISOString() }, now, 1440), false);
  assert.equal(isMarketObservationFresh({ observedAt: 'invalid' }, now, 15), false);
});
