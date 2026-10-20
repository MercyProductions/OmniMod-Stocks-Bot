import test from 'node:test';
import assert from 'node:assert/strict';
import { marketDateAt } from '../marketDate.js';

test('market dates follow Eastern and Central local dates across UTC midnight', () => {
  const timestamp = Date.parse('2026-09-30T01:30:00Z');
  assert.equal(marketDateAt(timestamp, 'America/New_York'), '2026-09-29');
  assert.equal(marketDateAt(timestamp, 'America/Chicago'), '2026-09-29');
  assert.equal(marketDateAt(timestamp, 'UTC'), '2026-09-30');
});

test('market dates observe timezone DST and reject missing or invalid inputs', () => {
  assert.equal(marketDateAt(Date.parse('2026-03-08T07:30:00Z'), 'America/New_York'), '2026-03-08');
  assert.throws(() => marketDateAt(NaN, 'UTC'), /finite timestamp/);
  assert.throws(() => marketDateAt(Date.now(), ''), /explicit IANA timezone/);
  assert.throws(() => marketDateAt(Date.now(), 'Not/A_Timezone'), RangeError);
});
