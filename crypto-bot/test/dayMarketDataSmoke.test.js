import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDayMarketDataSmoke } from '../src/dayMarketDataSmoke.js';

const goodRow = (symbol) => ({ symbol, quoteProviders: [
  { provider: 'Exchange A' }, { provider: 'Exchange B' },
], staleOrInvalidQuotes: 0, conflicted: false });
const options = { requestedSymbols: ['BTC'], historicalCandleSourceAvailable: true, elapsedMs: 50 };

test('public-data smoke requires unique fresh providers for all symbols and candle history', () => {
  const good = assessDayMarketDataSmoke([goodRow('BTC')], options);
  assert.equal(good.status, 'PASS_PROVIDER_PLUMBING_ONLY');
  assert.equal(good.checks.symbolsWithAtLeastTwoFreshExecutableExchangeQuotes, 1);
  assert.equal(assessDayMarketDataSmoke([{ ...goodRow('BTC'), quoteProviders: [
    { provider: 'Exchange A' }, { provider: 'Exchange A' },
  ] }], options).status, 'INCOMPLETE');
  assert.equal(assessDayMarketDataSmoke([], options).status, 'INCOMPLETE');
  assert.equal(assessDayMarketDataSmoke([goodRow('BTC')], { ...options, historicalCandleSourceAvailable: false }).status, 'INCOMPLETE');
  const duplicateCoverage = assessDayMarketDataSmoke([goodRow('BTC'), goodRow('BTC')], {
    ...options, requestedSymbols: ['BTC', 'ETH'],
  });
  assert.equal(duplicateCoverage.status, 'INCOMPLETE');
  assert.deepEqual(duplicateCoverage.checks.missingSymbols, ['ETH']);
  assert.deepEqual(duplicateCoverage.checks.duplicateSymbols, ['BTC']);
});

test('provider disagreement prevents a pass even when independent quotes and history exist', () => {
  const result = assessDayMarketDataSmoke([{ ...goodRow('ETH'), conflicted: true }], options);
  assert.equal(result.status, 'INCOMPLETE');
  assert.deepEqual(result.checks.symbolsWithQuoteDisagreement, ['ETH']);
});
