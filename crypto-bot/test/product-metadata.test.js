import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCoinbaseProduct, parseKrakenProduct } from '../src/cryptoProductMetadata.js';
import { cryptoInstrumentRulesRejection } from '../../new-bots/shared/cryptoInstrumentRules.js';
import { krakenBookEvidence } from '../../new-bots/shared/fixtures/cryptoBookEvidence.js';
const directory = await mkdtemp(join(tmpdir(), 'omnimod-product-metadata-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { fetchCryptoInstrumentRules } = await import('../src/marketProviders.js');
const { refreshCryptoPaperQuotes } = await import('../src/paperQuoteRefresh.js');
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.parse('2026-10-03T13:00:00Z');
const coinbase = (base = 'BTC') => ({ id: `${base}-USD`, base_currency: base, quote_currency: 'USD',
  base_increment: '0.00000001', quote_increment: '0.01', min_market_funds: '1', status: 'online',
  post_only: false, limit_only: false, cancel_only: false, auction_mode: false, trading_disabled: false });
const kraken = (base = 'XBT') => ({ altname: `${base}USD`, wsname: `${base}/USD`, lot: 'unit', lot_multiplier: 1,
  lot_decimals: 8, tick_size: '0.1', ordermin: '0.00005', costmin: '0.5', status: 'online' });
const identity = (base = 'BTC', provider = 'Coinbase', pair = `${base}-USD`) => ({ version: 1, namespace: 'coingecko',
  assetId: `test-${base.toLowerCase()}`, provider, pair, base, quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() });

test('native parsers preserve price/quantity increments, minimums and venue aliases', () => {
  const c = parseCoinbaseProduct(coinbase(), 'BTC-USD', new Date(now).toISOString());
  assert.equal(c.quantityIncrement, '0.00000001'); assert.equal(c.priceIncrement, '0.01'); assert.equal(c.minNotional, '1');
  assert.equal(cryptoInstrumentRulesRejection(c, identity(), now), null);
  const k = parseKrakenProduct(kraken(), 'XBTUSD', new Date(now).toISOString());
  assert.equal(k.base, 'BTC'); assert.equal(k.quantityIncrement, '0.00000001'); assert.equal(k.minQuantity, '0.00005');
  assert.equal(k.priceIncrement, '0.1'); assert.equal(k.minNotional, '0.5');
  assert.equal(cryptoInstrumentRulesRejection(k, identity('BTC', 'Kraken', 'XBTUSD'), now), null);
});

test('native metadata rejects ambiguous identity, missing precision and malformed limits', () => {
  for (const change of [{ id: 'ETH-USD' }, { base_currency: 'ETH' }, { base_increment: null }, { base_increment: true },
    { quote_increment: '' }, { min_market_funds: 0 }, { auction_mode: undefined }, { status: 'mystery' }])
    assert.throws(() => parseCoinbaseProduct({ ...coinbase(), ...change }, 'BTC-USD', new Date(now).toISOString()));
  for (const change of [{ altname: 'ETHUSD' }, { wsname: 'XBT' }, { lot_decimals: 8.5 }, { lot_decimals: -1 },
    { lot_decimals: 19 }, { lot_multiplier: 2 }, { ordermin: null }, { costmin: '' }, { tick_size: false }])
    assert.throws(() => parseKrakenProduct({ ...kraken(), ...change }, 'XBTUSD', new Date(now).toISOString()));
});

test('all restricted trading modes remain explicit, unusable product states', () => {
  for (const field of ['cancel_only', 'post_only', 'limit_only', 'auction_mode', 'trading_disabled']) {
    const out = parseCoinbaseProduct({ ...coinbase(), [field]: true }, 'BTC-USD', new Date(now).toISOString());
    assert.equal(cryptoInstrumentRulesRejection(out, identity(), now), 'crypto_product_not_in_normal_trading');
  }
  for (const status of ['offline', 'internal', 'delisted']) {
    const out = parseCoinbaseProduct({ ...coinbase(), status }, 'BTC-USD', new Date(now).toISOString());
    assert.equal(out.tradingState, 'offline');
  }
  for (const status of ['offline', 'cancel_only', 'post_only', 'limit_only']) {
    const out = parseKrakenProduct({ ...kraken(), status }, 'XBTUSD', new Date(now).toISOString());
    assert.equal(cryptoInstrumentRulesRejection(out, identity('BTC', 'Kraken', 'XBTUSD'), now), 'crypto_product_not_in_normal_trading');
  }
});

test('Coinbase product cache deduplicates requests, expires, and does not hide a later halt', async t => {
  let calls = 0, time = now;
  const id = identity('CACHEFIX');
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://api.exchange.coinbase.com/products/CACHEFIX-USD');
    calls++; return Response.json({ ...coinbase('CACHEFIX'), trading_disabled: calls > 1 });
  });
  const [a, b] = await Promise.all([fetchCryptoInstrumentRules(id, { clock: () => time }), fetchCryptoInstrumentRules(id, { clock: () => time })]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  a.quantityIncrement = '1';
  time += 20000;
  assert.equal((await fetchCryptoInstrumentRules(id, { clock: () => time })).quantityIncrement, '0.00000001');
  assert.equal(calls, 1);
  time += 11000;
  await assert.rejects(fetchCryptoInstrumentRules(id, { clock: () => time }), { code: 'crypto_product_not_in_normal_trading' });
  assert.equal(calls, 2);
});

test('expired product metadata is not reused after an HTTP failure', async t => {
  let calls = 0, time = now;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? Response.json(coinbase('STALEFIX')) : new Response('gone', { status: 404 }));
  const id = identity('STALEFIX');
  await fetchCryptoInstrumentRules(id, { clock: () => time });
  time += 31000;
  await assert.rejects(fetchCryptoInstrumentRules(id, { clock: () => time }));
  assert.equal(calls, 2);
});

test('multiple Kraken products use one fresh directory, with native currency and identity checks', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://api.kraken.com/0/public/AssetPairs'); calls++;
    return Response.json({ error: [], result: { XXBTZUSD: kraken(), XETHZUSD: kraken('ETH') } });
  });
  const out = await Promise.all([fetchCryptoInstrumentRules(identity('BTC', 'Kraken', 'XBTUSD'), { clock: () => now }),
    fetchCryptoInstrumentRules(identity('ETH', 'Kraken', 'ETHUSD'), { clock: () => now })]);
  assert.equal(calls, 1); assert.deepEqual(out.map(row => row.base), ['BTC', 'ETH']);
  await assert.rejects(fetchCryptoInstrumentRules(identity('WRONG', 'Kraken', 'XBTUSD'), { clock: () => now }), { code: 'crypto_instrument_rules_identity_mismatch' });
  assert.equal(calls, 1);
});

test('quote refresh attaches current Kraken product rules without relabeling its stream timestamp', async () => {
  const id = identity('BTC', 'Kraken', 'XBTUSD');
  const rawQuote = { cryptoIdentity: id, provider: 'Kraken', pair: 'XBTUSD', base: 'BTC', target: 'USD',
    bid: 100, ask: 100.1, observedAt: new Date(now - 1000).toISOString(), timestampBasis: 'provider_event' };
  let books = 0;
  const out = await refreshCryptoPaperQuotes([{ id: id.assetId, symbol: 'BTC', marketData: { quotes: [rawQuote] } }], {
    clock: () => now, loadInstrumentRules: async () => parseKrakenProduct(kraken(), 'XBTUSD', new Date(now).toISOString()),
    loadCoinbaseBook: async () => { books++; throw Error('wrong venue'); },
    collectKraken: async symbols => {
      assert.deepEqual(symbols, ['BTC/USD']);
      return { quotes: new Map([['BTC/USD', { symbol: 'BTC/USD', bid: 100, ask: 100.1, time: rawQuote.observedAt,
        cryptoQuoteEvidence: krakenBookEvidence({ bid: 100, ask: 100.1, time: now - 1000 }) }]]), diagnostics: { status: 'complete', sessions: 1 } };
    },
  });
  assert.equal(books, 0); assert.equal(out.quotesByKey.size, 1); assert.equal(out.diagnostics.refresh.rulesReady, 1);
  assert.equal(out.entryByAssetId.get(id.assetId).time, rawQuote.observedAt);
  assert.equal(rawQuote.cryptoInstrumentRules, undefined);
});

test('metadata failure cannot reuse rules already attached to an otherwise fresh quote', async () => {
  const id = identity('BTC', 'Kraken', 'XBTUSD'), rules = parseKrakenProduct(kraken(), 'XBTUSD', new Date(now).toISOString());
  const out = await refreshCryptoPaperQuotes([{ id: id.assetId, symbol: 'BTC', marketData: { quotes: [{
    provider: 'Kraken', pair: id.pair, base: 'BTC', target: 'USD', cryptoIdentity: id, cryptoInstrumentRules: rules,
    bid: 100, ask: 100.1, observedAt: new Date(now).toISOString(), timestampBasis: 'provider_event',
  }] } }], { clock: () => now, loadInstrumentRules: async () => { throw Error('missing'); } });
  assert.equal(out.quotesByKey.size, 0);
  assert.equal(out.diagnostics.rejectionCounts.crypto_product_metadata_unavailable, 1);
});
