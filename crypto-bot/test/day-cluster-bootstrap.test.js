import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapDayClusterExpectancy } from '../src/dayClusterBootstrap.js';

test('day-cluster bootstrap resamples complete UTC signal days deterministically', () => {
  const trades = [
    { signalTime: '2026-09-29T23:45:00Z', realizedR: 1 },
    { signalTime: '2026-09-30T00:15:00Z', realizedR: -1 },
    { signalTime: '2026-09-30T12:00:00Z', realizedR: -1 },
    { signalTime: '2026-10-01T09:00:00Z', realizedR: 2 },
  ];
  const options = { replicates: 1_000, seed: 17 };
  const first = bootstrapDayClusterExpectancy(trades, options);
  const second = bootstrapDayClusterExpectancy(trades, options);
  assert.deepEqual(first, second);
  assert.equal(first.trades, 4);
  assert.equal(first.signalDays, 3);
  assert.equal(first.expectancyR, 0.25);
  assert.ok(first.lower95R <= first.expectancyR && first.upper95R >= first.expectancyR);
  assert.equal(first.replicates, 1_000);
});

test('day-cluster interval is unavailable for fewer than two clusters and rejects malformed data', () => {
  const oneDay = bootstrapDayClusterExpectancy([{ signalTime: '2026-09-30T12:00:00Z', realizedR: 0.5 }]);
  assert.equal(oneDay.signalDays, 1);
  assert.equal(oneDay.lower95R, null);
  assert.throws(() => bootstrapDayClusterExpectancy([{ signalTime: 'bad', realizedR: 0 }]), /valid signalTime/);
  assert.throws(() => bootstrapDayClusterExpectancy([{ signalTime: 1, realizedR: Infinity }]), /finite numeric/);
});
