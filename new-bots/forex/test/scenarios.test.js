import test from 'node:test';
import assert from 'node:assert/strict';
import { frameWatch } from '../src/scenarios.js';

const frame = { granularity: 'M15', atr14: 0.01 };
const quote = { stale: false, tradeable: true, quoteValid: true, bid: 1.1, ask: 1.1002, targetAtrMultiple: 1.5 };

test('upward watch uses ask entry with target above and invalidation below', () => {
  const result = frameWatch({ ...frame, direction: 'up' }, quote);
  assert.equal(result.entryReference, quote.ask);
  assert.ok(result.targetPrice > result.entryReference);
  assert.ok(result.invalidationPrice < result.entryReference);
});

test('downward watch uses bid entry with target below and invalidation above', () => {
  const result = frameWatch({ ...frame, direction: 'down' }, quote);
  assert.equal(result.entryReference, quote.bid);
  assert.ok(result.targetPrice < result.entryReference);
  assert.ok(result.invalidationPrice > result.entryReference);
});

test('stale or malformed quotes cannot create a directional watch', () => {
  assert.equal(frameWatch({ ...frame, direction: 'up' }, { ...quote, quoteValid: false }).bias, 'NO SETUP');
  assert.equal(frameWatch({ ...frame, direction: 'down' }, { ...quote, stale: true }).bias, 'NO SETUP');
});
