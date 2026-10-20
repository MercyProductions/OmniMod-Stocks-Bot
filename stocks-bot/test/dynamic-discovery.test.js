import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMarketDiscoverySymbols, fetchAlpacaDiscoverySymbols, normalizeAlpacaDiscoverySymbols } from '../src/stocksData.js';
import { createProviderMetrics } from '../src/scanDiagnostics.js';

test('Alpaca discovery deduplicates movers and actives, excludes configured/context names, and caps the candidate set', () => {
  const rows = normalizeAlpacaDiscoverySymbols(
    { gainers: [{ symbol: 'AAA', percent_change: 8 }, { symbol: 'B.B', percent_change: 4 }, { symbol: 'SPY', percent_change: 3 }, { symbol: 'BAD/1', percent_change: 40 }] },
    { most_actives: [{ symbol: 'AAA', volume: 9_000_000 }, { symbol: 'BBB', volume: 8_000_000 }, { symbol: 'CCC', volume: 7_000_000 }] },
    { existingSymbols: ['B.B'], maxSymbols: 2 }
  );
  assert.deepEqual(rows.map((row) => row.symbol), ['AAA', 'BBB']);
  assert.deepEqual(rows[0].sources, ['mover', 'most_active']);
  assert.equal(rows[0].changePct, 8);
});

test('full configured universe does not silently crowd out bounded dynamic discovery names', () => {
  const configured = Array.from({ length: 90 }, (_, index) => `BASE${index}`);
  const dynamic = Array.from({ length: 30 }, (_, index) => `NEW${index}`);
  const result = composeMarketDiscoverySymbols(configured, dynamic);
  assert.equal(result.symbols.length, 120);
  assert.equal(result.dynamicSymbols.length, 30);
  assert.equal(result.symbols.at(-1), 'NEW29');
  assert.equal(composeMarketDiscoverySymbols(configured, ['BASE0', 'NEW0']).dynamicSymbols[0], 'NEW0');
});

test('Alpaca screener discovery performs two bounded documented requests and caches the ranked result', async () => {
  const calls = [];
  const metrics = createProviderMetrics();
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), options });
    const payload = String(url).includes('/movers?')
      ? { gainers: [{ symbol: 'AAA', percent_change: 7 }, { symbol: 'BBB', percent_change: 4 }], losers: [{ symbol: 'LOSER' }] }
      : { most_actives: [{ symbol: 'AAA', volume: 1_000_000 }, { symbol: 'CCC', volume: 900_000 }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '98' } });
  };
  const options = { keys: { alpaca_key_id: 'local-test-id', alpaca_secret_key: 'local-test-secret' }, metrics,
    maxSymbols: 2, cacheMinutes: 15, cacheKey: 'dynamic-discovery-test-unique', fetcher };
  const first = await fetchAlpacaDiscoverySymbols(options);
  const second = await fetchAlpacaDiscoverySymbols(options);
  assert.deepEqual(first.symbols, ['AAA', 'BBB']);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((call) => call.url.endsWith('/v1beta1/screener/stocks/movers?top=50')));
  assert.ok(calls.some((call) => call.url.endsWith('/v1beta1/screener/stocks/most-actives?by=volume&top=100')));
  assert.equal(calls[0].options.headers['APCA-API-KEY-ID'], 'local-test-id');
  assert.deepEqual(metrics.requests.map((row) => row.provider).sort(), ['Alpaca most-active stocks', 'Alpaca stock movers']);
});

test('missing credentials skip market-wide discovery without making a request', async () => {
  let requests = 0;
  const result = await fetchAlpacaDiscoverySymbols({ cacheKey: 'no-credentials-test-unique', fetcher: async () => { requests += 1; } });
  assert.deepEqual(result.symbols, []);
  assert.match(result.error, /credentials/);
  assert.equal(requests, 0);
});

test('a screener endpoint denial is reported while results from the other endpoint remain usable', async () => {
  const calls = [];
  const result = await fetchAlpacaDiscoverySymbols({
    keys: { alpaca_key_id: 'local-test-id', alpaca_secret_key: 'local-test-secret' },
    cacheKey: 'dynamic-discovery-partial-failure-test', maxSymbols: 5,
    fetcher: async (url) => {
      calls.push(String(url));
      return String(url).includes('/movers?')
        ? new Response('forbidden', { status: 403 })
        : new Response(JSON.stringify({ most_actives: [{ symbol: 'ACTIVE' }] }), { status: 200 });
    }
  });
  assert.deepEqual(result.symbols, ['ACTIVE']);
  assert.match(result.error, /movers: .*403/);
  assert.equal(calls.length, 2);
});
