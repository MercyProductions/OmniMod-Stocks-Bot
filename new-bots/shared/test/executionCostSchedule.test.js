import test from 'node:test';
import assert from 'node:assert/strict';
import { executionCostsAt, validateExecutionCostSchedule } from '../executionCostSchedule.js';

const source = 'https://data.example.com/costs';
const row = (id, from, until, fees = 1, slip = 0.5) => ({ id, validFrom: from, validUntil: until,
  roundTripFeesPerUnit: fees, slippageReservePerUnit: slip, source });

test('selects half-open timestamp intervals and preserves auditable cost source fields', () => {
  const schedule = validateExecutionCostSchedule([
    row('second', '2026-09-29T10:01:00Z', '2026-09-29T10:02:00Z', 2, 1),
    row('first', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z'),
  ]);
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:00:00Z').id, 'first');
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:00:59.999Z').id, 'first');
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:01:00Z').id, 'second');
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:02:00Z'), null);
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:01:30Z').source, source);
});

test('rejects overlapping intervals, invalid costs, malformed time, and unsafe source URLs', () => {
  assert.throws(() => validateExecutionCostSchedule([
    row('first', '2026-09-29T10:00:00Z', '2026-09-29T10:02:00Z'),
    row('second', '2026-09-29T10:01:00Z', '2026-09-29T10:03:00Z'),
  ]), /overlap/);
  assert.throws(() => validateExecutionCostSchedule([row('negative', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z', -1)]), /nonnegative/);
  assert.throws(() => validateExecutionCostSchedule([row('bad-date', '2026-09-29', '2026-09-29T10:01:00Z')]), /UTC ISO timestamp/);
  assert.throws(() => validateExecutionCostSchedule([{
    ...row('unsafe', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z'), source: 'https://data.example.com/costs?token=secret',
  }]), /without query or fragment/);
});
