import test from 'node:test';
import assert from 'node:assert/strict';
import { observedNonNegativeNumber } from '../diagnosticNumbers.js';

test('diagnostic measurements preserve missing versus measured zero', () => {
  for (const value of [null, undefined, '', '  ', false, true, NaN, Infinity, -1, 'unknown']) {
    assert.equal(observedNonNegativeNumber(value), null);
  }
  assert.equal(observedNonNegativeNumber(0), 0);
  assert.equal(observedNonNegativeNumber('12.5'), 12.5);
});
