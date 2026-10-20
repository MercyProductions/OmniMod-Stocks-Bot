import test from 'node:test';
import assert from 'node:assert/strict';
import { futuresMarketDateAt } from '../src/sessionDate.js';
import { marketDateAt } from '../../shared/marketDate.js';

test('Futures fallback market date follows Chicago through the UTC evening rollover', () => {
  assert.equal(futuresMarketDateAt(Date.parse('2026-09-30T01:30:00Z')), '2026-09-29');
  assert.equal(new Date('2026-09-30T01:30:00Z').toISOString().slice(0, 10), '2026-09-30');
});

test('Futures market date observes Chicago daylight-saving time boundaries', () => {
  assert.equal(futuresMarketDateAt(Date.parse('2026-03-08T07:30:00Z')), '2026-03-08');
  assert.equal(futuresMarketDateAt(Date.parse('2026-11-01T07:30:00Z')), '2026-11-01');
});

test('Futures market date rejects invalid timestamps and timezones', () => {
  assert.throws(() => futuresMarketDateAt(NaN), /finite timestamp/);
  assert.throws(() => marketDateAt(Date.now(), 'Not/A_Timezone'), RangeError);
});
