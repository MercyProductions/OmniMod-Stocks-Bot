import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCoinGeckoPairEvidence, planVerifiedSpotRoutes } from '../src/spotPairRouting.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-exact-pair-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { fetchProviderQuotes, fetchHistoricalCandles, aggregateProviderQuotes, enrichMarketAssets, screenSpotPairCoverage } = await import('../src/marketProviders.js');
const { refreshVenueResearchOutcomes } = await import('../src/venueResearch.js');
after(() => fs.rm(directory, { recursive: true, force: true }));

function mockMarket(t, id, { tickers, realtime = null, directory = {}, fail = null } = {}) {
  const calls = [], stamp = Date.now();
  const base = 'PAIRFIX';
  const clean = (provider, target, coinId = id) => ({ coin_id: coinId, base, target,
    market: { identifier: provider }, is_stale: false, is_anomaly: false });
  const candles = Array.from({ length: 80 }, (_, i) => [Math.floor(stamp / 900000) * 900000 - (80 - i) * 900000, 10, 10.2, 9.8, 10.1, 100]);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    if (u.pathname.endsWith('/exchanges/list')) return Response.json([{ id: 'binance', name: 'Binance' }, { id: 'gdax', name: 'Coinbase Exchange' }, { id: 'kraken', name: 'Kraken' }]);
    if (u.pathname === `/api/v3/coins/${id}/tickers`) return Response.json({ tickers: tickers ?? [clean('binance', 'USDT'), clean('gdax', 'USDT')] });
    if (u.pathname === '/api/v3/ticker/24hr') return Response.json({ symbol: u.searchParams.get('symbol'), lastPrice: '10', bidPrice: '9.99', askPrice: '10.01', quoteVolume: '10000000', closeTime: stamp });
    if (u.pathname === '/products/PAIRFIX-USDT/ticker') return Response.json({ price: '10', bid: '9.99', ask: '10.01', time: new Date(stamp).toISOString(), volume: '1000000' });
    if (u.pathname === '/products/PAIRFIX-USD/ticker') return new Response('unlisted', { status: 404 });
    if (u.pathname === '/0/public/AssetPairs') return Response.json({ error: [], result: directory });
    if (u.pathname === '/api/v3/klines') return Response.json(candles);
    if (u.pathname === '/products/PAIRFIX-USDT/candles') return Response.json(candles.map(r => [r[0] / 1000, r[3], r[2], r[1], r[4], r[5]]));
    if (fail) return fail(u);
    throw new Error(`Unexpected fixture-only request: ${u.pathname}`);
  });
  return { calls, asset: { id, symbol: base, requiresVerifiedIdentity: true },
    options: { settings: { coingeckoApiTier: 'demo', coingeckoApiKey: `fixture-${id}` }, realtimeQuote: realtime }, clean, stamp };
}

test('required identity routes an actually verified Coinbase USDT pair instead of guessing the USD market', async (t) => {
  const f = mockMarket(t, 'exact-routing-alternate');
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(aggregateProviderQuotes(out.quotes, 10).providerCount, 2, JSON.stringify(out));
  assert.ok(f.calls.includes('/products/PAIRFIX-USDT/ticker'));
  assert.ok(!f.calls.includes('/products/PAIRFIX-USD/ticker'));
  assert.ok(!f.calls.includes('/0/public/AssetPairs'), 'unverified Kraken venue needs no lookup');
  assert.equal(out.quotes.find(r => r.provider === 'Coinbase').pair, 'PAIRFIX-USDT');
  for (const quote of out.quotes) {
    assert.equal(quote.cryptoIdentity.assetId, f.asset.id);
    assert.equal(quote.cryptoIdentity.provider, quote.provider);
    assert.equal(quote.cryptoIdentity.pair, quote.pair);
    assert.equal(quote.cryptoIdentity.quoteCurrency, 'USDT');
    assert.equal(quote.cryptoIdentity.verificationSource, 'coingecko_tickers_complete');
    assert.ok(Number.isFinite(Date.parse(quote.cryptoIdentity.verifiedAt)));
  }
});

test('empty verified identity skips all native quote requests and reports why rows were unusable', async (t) => {
  const id = 'exact-routing-no-identity';
  const f = mockMarket(t, id, { tickers: [{ coin_id: 'wrong-asset', base: 'PAIRFIX', target: 'USDT', market: { identifier: 'binance' }, is_stale: false, is_anomaly: false }] });
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(out.quotes.length, 0); assert.equal(f.calls.length, 2, JSON.stringify(f.calls));
  assert.equal(out.identity.coverage.pairRejectionReasons.coin_id_mismatch, 1);
  assert.equal(out.identity.pairRouting.skipped.length, 3);
});

test('same pair claiming conflicting coin IDs is rejected; unsupported denominations are not guessed', () => {
  const id = 'coin-a', ticker = { base: 'PAIRFIX', target: 'USD', market: { identifier: 'gdax' }, is_stale: false, is_anomaly: false };
  const out = inspectCoinGeckoPairEvidence({ id }, { tickers: [{ ...ticker, coin_id: id }, { ...ticker, coin_id: 'coin-b' },
    { ...ticker, target: 'BTC', coin_id: id }, { ...ticker, base: 'PAIR/FIX', coin_id: id }] }, { Coinbase: 'gdax' }, { strict: true });
  assert.ok(!out.verifiedPairs.has('coinbase:PAIRFIX:USD'));
  assert.equal(out.rejectionReasons.conflicting_coin_ids_for_pair, 1);
  assert.equal(out.rejectionReasons.invalid_pair_identity, 1);
  const plan = planVerifiedSpotRoutes({ symbol: 'PAIRFIX' }, out.verifiedPairs);
  assert.equal(Object.keys(plan.routes).length, 0); assert.deepEqual(plan.unsupportedPairs, ['coinbase:PAIRFIX:BTC']);
});

test('strict Binance quotes reject a successful response for another pair', async (t) => {
  const f = mockMarket(t, 'exact-routing-wrong-response');
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('/ticker/24hr')
    ? Response.json({ symbol: 'WRONGUSDT', lastPrice: 10, bidPrice: 9.99, askPrice: 10.01, closeTime: Date.now() }) : original(url));
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(out.quotes.some(r => r.provider === 'Binance'), false);
  assert.match(out.errors.join(';'), /does not match/);
});

test('verified Kraken stream and historical aliases resolve to the same native pair without a guessed USD request', async (t) => {
  const id = 'exact-routing-kraken-alias', stamp = Date.now();
  const f = mockMarket(t, id, { tickers: [{ coin_id: id, base: 'PAIRFIX', target: 'USDT', market: { identifier: 'kraken' }, is_stale: false, is_anomaly: false }],
    directory: { PAIRFIXUSDT: { wsname: 'PAIRFIX/USDT', altname: 'PAIRFIXUSDT', status: 'online' } },
    realtime: { provider: 'Kraken', pair: 'PAIRFIX/USDT', base: 'PAIRFIX', target: 'USDT',
      price: 10, bid: 9.99, ask: 10.01, observedAt: new Date(stamp).toISOString(), timestampBasis: 'provider_event' } });
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(out.quotes.length, 1, JSON.stringify(out));
  assert.equal(out.quotes[0].pair, 'PAIRFIXUSDT'); assert.equal(out.quotes[0].wirePair, 'PAIRFIX/USDT');
  assert.equal(aggregateProviderQuotes(out.quotes).providerCount, 1, 'one venue still cannot satisfy the two-provider gate');
  assert.equal(f.calls.length, 3, 'two identity requests and one shared native directory');
});

test('history uses the exact supplied Coinbase source and cannot reuse another pair or asset cache', async (t) => {
  const f = mockMarket(t, 'exact-routing-history');
  const options = { providers: ['Coinbase'], sourcePairs: { Coinbase: 'PAIRFIX-USDT' }, limit: 80 };
  const first = await fetchHistoricalCandles(f.asset, options);
  assert.equal(first.provider, 'Coinbase'); assert.equal(first.pair, 'PAIRFIX-USDT'); assert.equal(first.candles.length, 80);
  const repeat = await fetchHistoricalCandles(f.asset, options); assert.equal(repeat, first); assert.equal(f.calls.length, 1);
  const other = await fetchHistoricalCandles({ ...f.asset, id: 'another-coin-id' }, options);
  assert.equal(other.pair, 'PAIRFIX-USDT'); assert.equal(f.calls.length, 2);
  const invalid = await fetchHistoricalCandles(f.asset, { ...options, sourcePairs: { Coinbase: 'WRONG-USD' } });
  assert.equal(invalid.candles.length, 0); assert.equal(f.calls.length, 2, 'invalid source causes no HTTP or cache fallback');
  const missing = await fetchHistoricalCandles(f.asset, { providers: ['Coinbase'] });
  assert.equal(missing.candles.length, 0); assert.equal(f.calls.length, 2);
  const usd = await fetchHistoricalCandles(f.asset, { ...options, sourcePairs: { Coinbase: 'PAIRFIX-USD' } });
  assert.equal(usd.candles.length, 0, 'USDT cache cannot answer a USD query');
  assert.equal(f.calls.length, 3);
});

test('pinned Kraken history verifies the native symbol and rejects missing or mismatched pairs without OHLC', async (t) => {
  const f = mockMarket(t, 'exact-routing-kraken-history', { directory: { PAIRFIXUSDT: { wsname: 'PAIRFIX/USDT', altname: 'PAIRFIXUSDT', status: 'online' } } });
  // The module's native directory may already be cached by the stream test; both map to this same pair.
  const missing = await fetchHistoricalCandles(f.asset, { providers: ['Kraken'], sourcePairs: { Kraken: 'MISSINGUSD' }, force: true });
  assert.equal(missing.candles.length, 0); assert.ok(f.calls.every(path => !path.startsWith('/0/public/OHLC')));
});

test('receipt-time Kraken quotes remain diagnostic even with an exact verified pair', async (t) => {
  const id = 'exact-routing-rest-kraken';
  const f = mockMarket(t, id, { tickers: [{ coin_id: id, base: 'PAIRFIX', target: 'USDT', market: { identifier: 'kraken' }, is_stale: false, is_anomaly: false }],
    directory: { PAIRFIXUSDT: { wsname: 'PAIRFIX/USDT', altname: 'PAIRFIXUSDT', status: 'online' } },
    fail: u => u.pathname === '/0/public/Ticker' ? Response.json({ error: [], result: { PAIRFIXUSDT: { c: ['10'], b: ['9.99'], a: ['10.01'], v: ['1', '100'] } } }) : Promise.reject(new Error('unexpected fixture')) });
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(out.quotes.length, 1); assert.equal(out.quotes[0].timestampBasis, 'response_received');
  const consensus = aggregateProviderQuotes(out.quotes);
  assert.equal(consensus.providerCount, 0); assert.equal(consensus.rejectionCounts.receipt_time_only, 1);
});

test('cheap native coverage retains a Coinbase USDT-only market before deep analysis', async (t) => {
  const f = mockMarket(t, 'exact-routing-directory');
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url);
    if (u.pathname === '/api/v3/exchangeInfo') return Response.json({ symbols: [{ symbol: 'PAIRFIXUSDT', status: 'TRADING' }] });
    if (u.pathname === '/products') return Response.json([
      { base_currency: 'PAIRFIX', quote_currency: 'USDT', status: 'online' },
      { base_currency: 'OFFLINE', quote_currency: 'USDT', status: 'offline' },
      { base_currency: 'WRONG', quote_currency: 'BTC', status: 'online' },
    ]);
    return original(url);
  });
  const out = await screenSpotPairCoverage([f.asset, { symbol: 'OFFLINE' }, { symbol: 'WRONG' }]);
  assert.deepEqual(out.candidates.map(row => row.symbol), ['PAIRFIX']);
  assert.equal(out.supportedVenueCounts.Coinbase, 1);
});

test('strict enrichment and subsequent outcome monitoring preserve the verified alternate source', async (t) => {
  const f = mockMarket(t, 'exact-routing-enrichment');
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url);
    // BTC context still succeeds. Force this asset's history to the second verified venue.
    if (u.pathname === '/api/v3/klines' && u.searchParams.get('symbol') === 'PAIRFIXUSDT') return new Response('history unavailable', { status: 404 });
    if (u.pathname === '/api/v3/depth') return Response.json({ bids: [[9.99, 100]], asks: [[10.01, 100]] });
    return original(url);
  });
  const result = await enrichMarketAssets([{ ...f.asset, price: 10 }], { technicalAssetIds: new Set([f.asset.id]),
    settings: f.options.settings, derivativesEnabled: false });
  const market = result.assets[0].marketData;
  assert.equal(market.providerCount, 2);
  assert.equal(market.candleProvider, 'Coinbase'); assert.equal(market.candlePair, 'PAIRFIX-USDT');
  assert.equal(market.candleCount, 80);
  assert.equal(market.validation.sufficient, false, 'short fixture history does not approve a strategy');
  const appended = [];
  const monitored = await refreshVenueResearchOutcomes({ now: f.stamp, observations: [{
    observationId: 'alternate-monitor', assetId: f.asset.id, symbol: f.asset.symbol,
    researchCohort: 'full-venue-discovery-v1', createdAt: new Date(f.stamp - 1000).toISOString(),
    candleProvider: market.candleProvider, candlePair: market.candlePair,
  }], appendCandles: async (...args) => appended.push(args) });
  assert.equal(monitored.updated, 1); assert.equal(appended[0][3], 'PAIRFIX-USDT');
  assert.ok(!f.calls.some(value => value.includes('PAIRFIX-USD/')));
});

test('strict enrichment with one stale provider still withholds asset history and technical analysis', async (t) => {
  const f = mockMarket(t, 'exact-routing-stale-provider');
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/products/PAIRFIX-USDT/ticker')
    ? Response.json({ price: 10, bid: 9.99, ask: 10.01, time: new Date(Date.now() - 900000).toISOString() }) : original(url));
  const result = await enrichMarketAssets([{ ...f.asset, price: 10 }], { technicalAssetIds: new Set([f.asset.id]),
    settings: f.options.settings, derivativesEnabled: false });
  const market = result.assets[0].marketData;
  assert.equal(market.providerCount, 1); assert.equal(market.technicals, null); assert.equal(market.candleCount, 0);
  assert.ok(!f.calls.some(value => value.includes('PAIRFIX-USDT/candles') || value.includes('symbol=PAIRFIXUSDT&interval=')));
});

test('pinned Kraken candles accept the exact directory identity and reject a different response key', async (t) => {
  const f = mockMarket(t, 'exact-routing-kraken-candle-response', {
    directory: { PAIRFIXUSDT: { wsname: 'PAIRFIX/USDT', altname: 'PAIRFIXUSDT', status: 'online' } },
  });
  let wrongPair = false;
  const original = globalThis.fetch;
  const candles = Array.from({ length: 80 }, (_, i) => [Math.floor(f.stamp / 900000) * 900 - (80 - i) * 900, '10', '10.2', '9.8', '10.1', '10', '100', 10]);
  t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname === '/0/public/OHLC'
    ? Response.json({ error: [], result: { [wrongPair ? 'UNRELATEDUSD' : 'PAIRFIXUSDT']: candles, last: 0 } }) : original(url));
  const options = { providers: ['Kraken'], sourcePairs: { Kraken: 'PAIRFIXUSDT' }, force: true };
  const good = await fetchHistoricalCandles(f.asset, options);
  assert.equal(good.candles.length, 80); assert.equal(good.pair, 'PAIRFIXUSDT');
  wrongPair = true;
  const bad = await fetchHistoricalCandles(f.asset, options);
  assert.equal(bad.candles.length, 0); assert.match(bad.errors.join(';'), /does not match/);
});

test('Kraken stream label cannot claim another verified native market', async (t) => {
  const id = 'exact-routing-stream-mismatch', stamp = Date.now();
  const f = mockMarket(t, id, { tickers: [{ coin_id: id, base: 'PAIRFIX', target: 'USDT', market: { identifier: 'kraken' }, is_stale: false, is_anomaly: false }],
    directory: { PAIRFIXUSDT: { wsname: 'PAIRFIX/USDT', altname: 'PAIRFIXUSDT', status: 'online' } },
    realtime: { provider: 'Kraken', pair: 'WRONG/USDT', base: 'PAIRFIX', target: 'USDT',
      price: 10, bid: 9.99, ask: 10.01, observedAt: new Date(stamp).toISOString() } });
  const out = await fetchProviderQuotes(f.asset, f.options);
  assert.equal(out.quotes.length, 0); assert.match(out.errors.join(';'), /stream pair does not match/);
});
