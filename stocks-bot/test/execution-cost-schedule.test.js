import test from 'node:test';
import assert from 'node:assert/strict';
import { executionCostsAt, validateExecutionCostSchedule } from '../src/executionCostSchedule.js';

const source = 'https://data.example.com/broker-fees';
const row = (id, validFrom, validUntil, feeBpsPerSide = 1, slippageBpsPerSide = 2) => ({
  id, validFrom, validUntil, feeBpsPerSide, slippageBpsPerSide, source,
});

test('stock cost schedule selects point-in-time bps assumptions using half-open intervals', () => {
  const schedule = validateExecutionCostSchedule([
    row('later', '2026-09-29T10:01:00Z', '2026-09-29T10:02:00Z', 1.5, 3),
    row('earlier', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z'),
  ]);
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:00:00Z').id, 'earlier');
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:01:00Z').id, 'later');
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:02:00Z'), null);
  assert.equal(executionCostsAt(schedule, '2026-09-29T10:01:30Z').feeBpsPerSide, 1.5);
});

test('stock cost schedule rejects gaps only at lookup and rejects overlap, unsafe sources and invalid values', () => {
  assert.throws(() => validateExecutionCostSchedule([
    row('a', '2026-09-29T10:00:00Z', '2026-09-29T10:02:00Z'),
    row('b', '2026-09-29T10:01:00Z', '2026-09-29T10:03:00Z'),
  ]), /overlap/);
  assert.throws(() => validateExecutionCostSchedule([row('bad', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z', -1)]), /0–100 bps/);
  assert.throws(() => validateExecutionCostSchedule([{ ...row('unsafe', '2026-09-29T10:00:00Z', '2026-09-29T10:01:00Z'), source: 'https://data.example.com/fees?token=x' }]), /no credentials/);
  assert.throws(() => validateExecutionCostSchedule([row('bad-id', 'not-a-date', '2026-09-29T10:01:00Z')]), /UTC ISO timestamp/);
});
