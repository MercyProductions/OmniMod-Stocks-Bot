import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnosticCount } from '../formatDiagnosticCount.js';

test('formats measured counts including zero, and preserves unknown telemetry', () => {
  assert.equal(formatDiagnosticCount(0), '0');
  assert.equal(formatDiagnosticCount('1200'), '1,200');
  for (const value of [null, undefined, '', NaN, -1, 1.5, 'bad']) assert.equal(formatDiagnosticCount(value), 'unknown');
});
