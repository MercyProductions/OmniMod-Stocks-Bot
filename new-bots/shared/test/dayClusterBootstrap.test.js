import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapSessionExpectancy } from '../dayClusterBootstrap.js';

test('market-session bootstrap deterministically resamples whole entry-session clusters', () => {
  const orders = [
    { sessionDate: '2026-09-29', riskUsd: 100, realizedPnlUsd: 100 },
    { sessionDate: '2026-09-29', riskUsd: 100, realizedPnlUsd: -100 },
    { sessionDate: '2026-09-30', riskUsd: 100, realizedPnlUsd: -100 },
    { sessionDate: '2026-10-01', riskUsd: 100, realizedPnlUsd: 200 },
  ];
  const options = { replicates: 1_000, seed: 23 };
  const first = bootstrapSessionExpectancy(orders, options);
  assert.deepEqual(bootstrapSessionExpectancy(orders, options), first);
  assert.equal(first.trades, 4);
  assert.equal(first.excluded, 0);
  assert.equal(first.sessionDays, 3);
  assert.equal(first.expectancyR, 0.25);
  assert.ok(first.lower95R <= first.upper95R);
});

test('market-session bootstrap excludes malformed PnL/risk/date and reports insufficient clusters', () => {
  const result = bootstrapSessionExpectancy([
    { sessionDate: '2026-09-30', riskUsd: 100, realizedPnlUsd: 25 },
    { sessionDate: '2026-09-30', riskUsd: true, realizedPnlUsd: 25 },
    { sessionDate: '2026-09-30', riskUsd: 100, realizedPnlUsd: null },
    { sessionDate: '2026-02-30', riskUsd: 100, realizedPnlUsd: -10 },
  ]);
  assert.equal(result.trades, 1);
  assert.equal(result.excluded, 3);
  assert.equal(result.sessionDays, 1);
  assert.equal(result.lower95R, null);
  assert.equal(result.upper95R, null);
});
