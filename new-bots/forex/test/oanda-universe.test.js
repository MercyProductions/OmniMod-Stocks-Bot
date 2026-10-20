import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOandaFxUniverse, normalizeOandaDirectory } from '../src/oandaUniverse.js';

const now = Date.parse('2026-09-30T16:00:00.000Z');
const instrument = (name, type = 'CURRENCY') => ({ name, type });
const quote = (name, spread, { time = new Date(now).toISOString(), status = 'tradeable' } = {}) => ({
  instrument: name, status, time, bids: [{ price: String(1 - spread / 2) }], asks: [{ price: String(1 + spread / 2) }],
});

test('account-listed non-G10 pairs are screened while metals/CFDs and malformed FX have explicit exclusions', async () => {
  const result = await discoverOandaFxUniverse({ configuredInstruments: ['EUR_USD'], now, maxInstruments: 2, maxSpreadPct: 0.03,
    fetchInstruments: async () => ({ instruments: ['EUR_USD', 'EUR_SGD', 'USD_ZAR', 'USD_TRY'].map((name) => instrument(name))
      .concat([instrument('XAU_USD', 'METAL'), instrument('US30_USD', 'CFD'), instrument('USD_USD')]) }),
    fetchPrices: async (pairs) => ({ prices: pairs.map((name) => quote(name, name === 'USD_TRY' ? 0.01 : 0.0001)) }),
  });
  assert.equal(result.diagnostics.providerInstruments, 7);
  assert.equal(result.diagnostics.accountCurrencyInstruments, 4);
  assert.equal(result.diagnostics.nonG10Instruments, 3);
  assert.equal(result.diagnostics.cheaplyScreened, 4);
  assert.equal(result.diagnostics.quoteQualified, 3);
  assert.deepEqual(result.instruments, ['EUR_USD', 'EUR_SGD']);
  assert.equal(result.screenRows.find((row) => row.instrument === 'USD_TRY').rejectionReason, 'spread_exceeds_existing_risk_limit');
  assert.equal(result.screenRows.find((row) => row.instrument === 'USD_ZAR').rejectionReason, 'deep_analysis_cap');
  assert.equal(result.diagnostics.rejected.filter((row) => row.stage === 'membership').length, 3);
  assert.ok(result.quoteRows.USD_ZAR, 'off-shortlist prices remain available for conversion/monitoring');
});

test('duplicate identities, contradictory tradeability, unexpected rows, and aged batches cannot qualify', async () => {
  const result = await discoverOandaFxUniverse({ now, clock: () => now + 121_000, maxInstruments: 3,
    fetchInstruments: async () => ({ instruments: ['EUR_USD', 'EUR_SGD', 'USD_ZAR'].map((name) => instrument(name)) }),
    fetchPrices: async () => ({ prices: [quote('EUR_USD', 0.0001), quote('EUR_USD', 0.0002),
      { ...quote('EUR_SGD', 0.0001), tradeable: false }, quote('USD_ZAR', 0.0001), quote('USD_TRY', 0.0001)] }),
  });
  assert.deepEqual(result.instruments, []);
  assert.deepEqual(result.diagnostics.rejected.map((row) => row.reason).sort(),
    ['duplicate_quote_identity', 'instrument_not_tradeable', 'stale_or_invalid_quote']);
  assert.equal(result.diagnostics.unexpectedQuoteRows.length, 1);
  assert.equal(result.quoteRows.EUR_USD, undefined);
  assert.throws(() => normalizeOandaDirectory({ instruments: [instrument('EUR_USD'), instrument('EUR_USD')] }), /Duplicate/);
  assert.throws(() => normalizeOandaDirectory({ instruments: [], nextPageToken: 'more' }), /incomplete/);
});

test('cheap movement telemetry compares prior valid quotes without changing candidate ranking', async () => {
  const previous = quote('USD_ZAR', 0.0001, { time: new Date(now - 60_000).toISOString() });
  const result = await discoverOandaFxUniverse({ now, previousQuotes: { USD_ZAR: previous },
    fetchInstruments: async () => ({ instruments: [instrument('USD_ZAR')] }),
    fetchPrices: async () => ({ prices: [{ ...quote('USD_ZAR', 0.0001), bids: [{ price: '1.00995' }], asks: [{ price: '1.01005' }] }] }),
  });
  assert.ok(Math.abs(result.screenRows[0].movementBps - 100) < 1e-8);
  assert.equal(result.screenRows[0].movementWindowMs, 60_000);
  assert.equal(result.diagnostics.movementMeasured, 1);
});

test('Forex discovery quality-checks configured pairs then ranks all fresh account-supported FX inside the deep-analysis cap', async () => {
  const calls = [];
  const result = await discoverOandaFxUniverse({ configuredInstruments: ['eur_usd'], maxInstruments: 3, now,
    fetchInstruments: async () => ({ instruments: [instrument('EUR_USD'), instrument('USD_JPY'), instrument('EUR_GBP'), instrument('AUD_NZD'), instrument('XAU_USD', 'CFD')] }),
    fetchPrices: async (pairs) => { calls.push(pairs); return { prices: [quote('EUR_USD', 0.001), quote('USD_JPY', 0.003), quote('EUR_GBP', 0.001), quote('AUD_NZD', 0.002)] }; },
  });
  assert.deepEqual(result.instruments, ['EUR_USD', 'EUR_GBP', 'AUD_NZD']);
  assert.deepEqual(calls, [['AUD_NZD', 'EUR_GBP', 'EUR_USD', 'USD_JPY']]);
  assert.equal(result.diagnostics.accountCurrencyInstruments, 4);
  assert.equal(result.diagnostics.eligibleG10Instruments, 4);
  assert.equal(result.diagnostics.discoveryEligibleInstruments, 4);
  assert.equal(result.diagnostics.discoveredQuoteQualified, 3);
  assert.equal(result.diagnostics.selectedDiscovered, 2);
  assert.equal(result.diagnostics.capOmissions, 1);
  assert.equal(result.diagnostics.rejected.at(-1).instrument, 'USD_JPY');
  assert.equal(result.quoteRows.EUR_GBP.instrument, 'EUR_GBP');
});

test('Forex discovery excludes stale, future, crossed, non-tradeable, and missing quotes including configured pairs', async () => {
  const symbols = ['USD_JPY', 'EUR_GBP', 'AUD_NZD', 'GBP_CHF', 'CAD_JPY'];
  const result = await discoverOandaFxUniverse({ configuredInstruments: ['EUR_USD'], maxInstruments: 5, now,
    fetchInstruments: async () => ({ instruments: [instrument('EUR_USD'), ...symbols.map((symbol) => instrument(symbol))] }),
    fetchPrices: async () => ({ prices: [
      quote('USD_JPY', 0.001, { time: new Date(now - 180_000).toISOString() }),
      quote('EUR_GBP', 0.001, { time: new Date(now + 60_000).toISOString() }),
      { ...quote('AUD_NZD', 0.001), asks: [{ price: '0.9' }], bids: [{ price: '1.1' }] },
      quote('GBP_CHF', 0.001, { status: 'non-tradeable' }),
    ] }),
  });
  assert.deepEqual(result.instruments, []);
  assert.equal(result.diagnostics.quoteRejected, 6);
  assert.deepEqual(Object.fromEntries(result.diagnostics.rejected.map((row) => [row.instrument, row.reason])), {
    USD_JPY: 'stale_or_invalid_quote', EUR_GBP: 'stale_or_invalid_quote', AUD_NZD: 'invalid_bid_ask',
    GBP_CHF: 'instrument_not_tradeable', CAD_JPY: 'provider_returned_no_quote', EUR_USD: 'provider_returned_no_quote',
  });
});

test('Forex discovery keeps unsupported configured pairs visible as rejection diagnostics and fails invalid caps closed', async () => {
  const result = await discoverOandaFxUniverse({ configuredInstruments: ['EUR_USD', 'USD_TRY'], maxInstruments: 2, now,
    fetchInstruments: async () => ({ instruments: [instrument('EUR_USD')] }), fetchPrices: async () => ({ prices: [quote('EUR_USD', 0.001)] }),
  });
  assert.deepEqual(result.instruments, ['EUR_USD']);
  assert.equal(result.diagnostics.configuredUnsupported, 1);
  assert.deepEqual(result.diagnostics.rejected, [{ instrument: 'USD_TRY', stage: 'membership', reason: 'configured_instrument_not_supported_by_account' }]);
  const capped = await discoverOandaFxUniverse({ configuredInstruments: ['EUR_USD', 'GBP_USD'], maxInstruments: 1, now,
    fetchInstruments: async () => ({ instruments: [instrument('EUR_USD'), instrument('GBP_USD')] }),
    fetchPrices: async (pairs) => ({ prices: pairs.map((pair) => quote(pair, 0.001)) }),
  });
  assert.equal(capped.diagnostics.cheaplyScreened, 2);
  assert.equal(capped.diagnostics.capOmissions, 1);
  await assert.rejects(discoverOandaFxUniverse({ configuredInstruments: ['EUR/USD'], maxInstruments: 4,
    fetchInstruments: async () => ({ instruments: [] }), fetchPrices: async () => ({ prices: [] }),
  }), /BASE_QUOTE/);
});

test('Forex discovery chunks large account universes into at most 50 quote symbols per provider request', async () => {
  const currencies = ['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'NOK', 'SEK'];
  const symbols = currencies.flatMap((base) => currencies.filter((quoteCurrency) => quoteCurrency !== base).map((quoteCurrency) => `${base}_${quoteCurrency}`));
  const chunks = [];
  const result = await discoverOandaFxUniverse({ configuredInstruments: [], maxInstruments: 10, now,
    fetchInstruments: async () => ({ instruments: symbols.map((symbol) => instrument(symbol)) }),
    fetchPrices: async (pairs) => { chunks.push(pairs); return { prices: pairs.map((symbol) => quote(symbol, 0.001)) }; },
  });
  assert.equal(result.diagnostics.accountCurrencyInstruments, 90);
  assert.equal(result.diagnostics.eligibleG10Instruments, 90);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 50));
  assert.equal(result.instruments.length, 10);
  assert.equal(result.diagnostics.capOmissions, 80);
});

test('Forex discovery request failures are visible and quote failures do not become discovery candidates', async () => {
  const failedQuote = await discoverOandaFxUniverse({ configuredInstruments: [], maxInstruments: 4, now,
    fetchInstruments: async () => ({ instruments: [instrument('EUR_USD'), instrument('USD_JPY')] }),
    fetchPrices: async () => { throw new Error('provider down'); },
  });
  assert.deepEqual(failedQuote.instruments, []);
  assert.equal(failedQuote.diagnostics.providerQuoteErrors.length, 1);
  assert.equal(failedQuote.diagnostics.quoteRejected, 2);
  await assert.rejects(discoverOandaFxUniverse({ configuredInstruments: [], maxInstruments: 4,
    fetchInstruments: async () => ({ instruments: null }), fetchPrices: async () => ({ prices: [] }),
  }), /instruments array/);
});
