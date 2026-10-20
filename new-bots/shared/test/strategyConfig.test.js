import test from 'node:test';
import assert from 'node:assert/strict';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from '../strategyConfig.js';

test('explicit cost inputs accept finite non-negative numbers and numeric strings only', () => {
  for (const value of [0, 1.25, '0', ' 2.5 ']) assert.equal(hasExplicitNonNegativeFiniteAmount(value), true, String(value));
  for (const value of [undefined, null, '', '  ', false, true, [], {}, NaN, Infinity, -1, '-0.1', 'NaN']) {
    assert.equal(hasExplicitNonNegativeFiniteAmount(value), false, String(value));
  }
});

test('explicit positive amounts reject booleans and non-positive values', () => {
  for (const value of [1, 0.01, '1', ' 2.5 ']) assert.equal(hasExplicitPositiveFiniteAmount(value), true, String(value));
  for (const value of [undefined, null, '', '  ', false, true, 0, -1, NaN, Infinity, 'Infinity'])
    assert.equal(hasExplicitPositiveFiniteAmount(value), false, String(value));
});

test('explicit finite amounts accept signed P&L but reject coercible malformed values', () => {
  for (const value of [-10, 0, 2.5, '-4.2', '0']) assert.equal(hasExplicitFiniteAmount(value), true, String(value));
  for (const value of [undefined, null, '', '  ', false, true, NaN, Infinity, 'NaN']) assert.equal(hasExplicitFiniteAmount(value), false, String(value));
});
