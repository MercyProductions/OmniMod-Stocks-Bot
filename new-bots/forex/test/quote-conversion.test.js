import test from 'node:test';
import assert from 'node:assert/strict';
import { forexConversionInstrument, resolveForexQuoteToUsd } from '../src/quoteConversion.js';

const now = Date.parse('2026-09-29T15:00:00.000Z');
const quote = (instrument, bid, ask, overrides = {}) => ({ instrument, bids: [{ price: bid }], asks: [{ price: ask }],
  time: new Date(now - 1_000).toISOString(), tradeable: true, ...overrides });

test('USD-quoted pairs use a unit conversion and major non-USD quote currencies select their OANDA cross', () => {
  assert.equal(forexConversionInstrument('EUR_USD'), null);
  assert.equal(resolveForexQuoteToUsd({ instrument: 'EUR_USD', now }).quoteToUsd, 1);
  assert.equal(forexConversionInstrument('EUR_JPY'), 'USD_JPY');
  assert.equal(forexConversionInstrument('EUR_GBP'), 'GBP_USD');
  assert.equal(forexConversionInstrument('CAD_JPY'), 'USD_JPY');
  assert.equal(resolveForexQuoteToUsd({ instrument: 'EUR_ZAR', now }).status, 'unsupported_quote_currency');
});

test('non-G10 conversion selects a verified account-listed USD cross; absent currencies remain blocked', () => {
  const availableInstruments = ['EUR_SGD', 'USD_SGD', 'EUR_ZAR', 'ZAR_USD'];
  assert.equal(forexConversionInstrument('EUR_SGD', availableInstruments), 'USD_SGD');
  assert.equal(forexConversionInstrument('EUR_JPY', availableInstruments), null);
  const sgd = resolveForexQuoteToUsd({ instrument: 'EUR_SGD', availableInstruments, conversionQuote: quote('USD_SGD', 1.35, 1.351), now });
  assert.equal(sgd.quoteToUsd, 1 / 1.35);
  assert.equal(sgd.gainQuoteToUsd, 1 / 1.351);
  const zar = resolveForexQuoteToUsd({ instrument: 'EUR_ZAR', availableInstruments, conversionQuote: quote('ZAR_USD', 0.055, 0.056), now });
  assert.equal(zar.quoteToUsd, 0.056);
  assert.equal(zar.gainQuoteToUsd, 0.055);
  assert.equal(resolveForexQuoteToUsd({ instrument: 'EUR_TRY', availableInstruments, now }).status, 'unsupported_quote_currency');
});

test('conflicting tradeability fields and infinite conversion quotes fail closed', () => {
  for (const conversionQuote of [
    quote('USD_JPY', 150, 151, { status: 'non-tradeable', tradeable: true }),
    quote('USD_JPY', 150, 151, { status: 'tradeable', tradeable: false }),
    quote('USD_JPY', 150, 'Infinity'),
  ]) assert.equal(resolveForexQuoteToUsd({ instrument: 'EUR_JPY', conversionQuote, now }).quoteToUsd, null);
});

test('quote-currency liabilities use ask/inverse bid while gains use bid/inverse ask', () => {
  const inverse = resolveForexQuoteToUsd({ instrument: 'EUR_JPY', conversionQuote: quote('USD_JPY', 150, 151), now });
  assert.equal(inverse.status, 'converted');
  assert.equal(inverse.method, 'loss-inverse-bid-gain-inverse-ask');
  assert.equal(inverse.quoteToUsd, 1 / 150);
  assert.equal(inverse.gainQuoteToUsd, 1 / 151);

  const direct = resolveForexQuoteToUsd({ instrument: 'EUR_GBP', conversionQuote: quote('GBP_USD', 1.25, 1.26), now });
  assert.equal(direct.status, 'converted');
  assert.equal(direct.method, 'loss-ask-gain-bid');
  assert.equal(direct.quoteToUsd, 1.26);
  assert.equal(direct.gainQuoteToUsd, 1.25);
});

test('stale, invalid, non-tradeable, missing, or mismatched conversion quotes never produce a factor', () => {
  for (const [conversionQuote, status] of [
    [null, 'conversion_quote_missing'],
    [quote('USD_JPY', 150, 151, { time: new Date(now - 121_000).toISOString() }), 'conversion_quote_stale_or_invalid'],
    [quote('USD_JPY', 150, 151, { tradeable: false }), 'conversion_not_tradeable'],
    [quote('USD_JPY', 150, 151, { tradeable: undefined, status: 'invalid' }), 'conversion_not_tradeable'],
    [quote('GBP_USD', 1.25, 1.26), 'conversion_instrument_mismatch'],
    [quote('USD_JPY', 0, 151), 'conversion_quote_stale_or_invalid'],
  ]) {
    const result = resolveForexQuoteToUsd({ instrument: 'EUR_JPY', conversionQuote, now, maxQuoteAgeMs: 120_000 });
    assert.equal(result.status, status);
    assert.equal(result.quoteToUsd, null);
  }
});
