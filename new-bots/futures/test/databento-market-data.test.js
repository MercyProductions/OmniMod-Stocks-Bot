import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDatabentoUniverse, normalizeDatabentoFutures, parseDatabentoJsonLines } from '../src/databentoMarketData.js';

const now = Date.parse('2026-09-29T15:00:00.000Z');
const universe = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }];
const bar = (ts_event, close, symbol = 'ESZ6') => ({ ts_event, open: close - 1, high: close + 1, low: close - 2, close, volume: 1000, symbol, instrument_id: 123 });

test('parses Databento NDJSON and rejects malformed records', () => {
  assert.deepEqual(parseDatabentoJsonLines('{"close":1}\r\n\n{"close":2}\n'), [{ close: 1 }, { close: 2 }]);
  assert.throws(() => parseDatabentoJsonLines('{bad json}'), /malformed JSON record 1/);
});

test('normalizes mapped bars as continuous research context with returns and no contract promotion', () => {
  const intraday = [bar('2026-09-29T14:59:00.000Z', 6001)];
  const daily = Array.from({ length: 22 }, (_, i) => bar(new Date(now - (21 - i) * 86_400_000).toISOString(), 5800 + i * 10));
  const [row] = normalizeDatabentoFutures(universe, intraday, daily, { now });
  assert.equal(row.providerSymbol, 'ESZ6');
  assert.equal(row.requestedContinuousSymbol, 'ES.V.0');
  assert.equal(row.providerInstrumentId, '123');
  assert.equal(row.price, 6001);
  assert.ok(row.return1dPct > 0);
  assert.ok(row.return5dPct > 0);
  assert.equal(row.stale, false);
  assert.equal(row.contractMode, 'continuous-proxy');
  assert.equal(row.contractSpecVerified, false);
});

test('future-dated and absent mapped bars fail freshness closed', () => {
  const future = normalizeDatabentoFutures(universe, [bar('2026-09-29T15:02:00.000Z', 6000)], [bar('2026-09-28T00:00:00Z', 5900)], { now })[0];
  assert.equal(future.stale, true);
  assert.equal(future.providerAgeSeconds, null);
  const missing = normalizeDatabentoFutures(universe, [], [], { now })[0];
  assert.equal(missing.stale, true);
  assert.equal(missing.providerStatus, 'no-usable-bars');
});

test('manual/default safety boundaries refuse missing credentials or zero cost cap without network calls', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(fetchDatabentoUniverse(universe, { fetcher }), /DATABENTO_API_KEY is required/);
  await assert.rejects(fetchDatabentoUniverse(universe, { apiKey: 'test-key', fetcher }), /FUTURES_MAX_SCAN_COST_USD must be greater than zero/);
  assert.equal(calls, 0);
});

test('network failures are sanitized, surfaced in request metrics, and stop before bar downloads', async () => {
  const metrics = [];
  await assert.rejects(fetchDatabentoUniverse(universe, {
    apiKey: 'test-key', maxScanCostUsd: 1, now, metrics,
    fetcher: async () => { throw new Error('failed https://hist.databento.com/v0/private?secret=hidden'); },
  }), /request failed/);
  assert.equal(metrics.length, 2, 'both independently issued cost estimates expose failure telemetry');
  assert.ok(metrics.every((metric) => metric.status === 0 && metric.error.includes('[provider-url]')));
  assert.ok(metrics.every((metric) => !metric.error.includes('secret=hidden')));
  assert.ok(metrics.every((metric) => metric.operation.startsWith('cost-')));
});

test('free Databento cost metadata retries transient transport failures and records every attempt', async () => {
  const metrics = [];
  const calls = new Map();
  const delays = [];
  const fetcher = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('metadata.get_cost')) {
      const schema = parsed.searchParams.get('schema');
      const attempt = (calls.get(schema) || 0) + 1;
      calls.set(schema, attempt);
      if (attempt === 1) throw new TypeError('temporary network disconnect');
      return new Response('0.10', { status: 200 });
    }
    return new Response(`${JSON.stringify(bar('2026-09-29T14:59:00.000Z', 6001))}\n`, { status: 200 });
  };
  await fetchDatabentoUniverse(universe, { apiKey: 'test-key', maxScanCostUsd: 1, now, fetcher, metrics, sleep: async (ms) => delays.push(ms) });
  const costAttempts = metrics.filter((metric) => metric.operation.startsWith('cost-') && metric.operation !== 'estimated-scan-cost');
  assert.equal(costAttempts.length, 4);
  assert.equal(costAttempts.filter((metric) => metric.status === 0).length, 2);
  assert.equal(costAttempts.filter((metric) => metric.status === 200 && metric.retry).length, 2);
  assert.deepEqual(delays, [1000, 1000]);
  assert.equal(metrics.filter((metric) => metric.operation.startsWith('bars-')).length, 2);
});

test('billable Databento streaming requests are not retried after a transport failure', async () => {
  const metrics = [];
  const calls = new Map();
  const fetcher = async (url) => {
    const key = new URL(url).pathname.endsWith('metadata.get_cost') ? 'cost' : 'bars';
    calls.set(key, (calls.get(key) || 0) + 1);
    if (key === 'cost') return new Response('0.10', { status: 200 });
    throw new TypeError('stream connection interrupted');
  };
  await assert.rejects(fetchDatabentoUniverse(universe, { apiKey: 'test-key', maxScanCostUsd: 1, now, fetcher, metrics }), /request failed/);
  assert.equal(calls.get('cost'), 2, 'metadata checks run before billable streams');
  assert.equal(calls.get('bars'), 2, 'each paid stream is attempted only once');
  assert.equal(metrics.filter((metric) => metric.operation.startsWith('bars-') && metric.status === 0).length, 2);
});

test('cost estimates are checked before any history download; requests use authenticated Databento historical API', async () => {
  const requests = [];
  const metrics = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('metadata.get_cost')) return new Response('0.30', { status: 200, headers: { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '80' } });
    return new Response(`${JSON.stringify(bar('2026-09-29T14:59:00.000Z', 6001))}\n`, { status: 200, headers: { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '80' } });
  };
  await assert.rejects(fetchDatabentoUniverse(universe, { apiKey: 'test-key', maxScanCostUsd: 0.5, now, fetcher, metrics }), /estimated \$0\.600000 exceeds configured cap/);
  assert.equal(requests.length, 2, 'only two cost estimates; no bars fetched over cap');
  assert.ok(requests.every(({ url, options }) => url.startsWith('https://hist.databento.com/v0/metadata.get_cost?')
    && options.headers.authorization === `Basic ${Buffer.from('test-key:').toString('base64')}`));

  requests.length = 0;
  const result = await fetchDatabentoUniverse(universe, { apiKey: 'test-key', maxScanCostUsd: 1, now, fetcher, metrics });
  assert.equal(requests.length, 4);
  assert.equal(requests.filter((x) => x.url.includes('metadata.get_cost')).length, 2);
  const barRequests = requests.filter((x) => x.url.endsWith('/timeseries.get_range'));
  assert.equal(barRequests.length, 2);
  assert.ok(barRequests.every(({ options }) => options.method === 'POST'
    && options.headers['content-type'] === 'application/x-www-form-urlencoded'
    && options.body.get('encoding') === 'json'
    && options.body.get('map_symbols') === 'true'));
  assert.equal(result[0].contractSpecVerified, false);
  assert.ok(metrics.some((metric) => metric.operation === 'estimated-scan-cost' && metric.estimatedCostUsd === 0.6));
  assert.ok(metrics.filter((metric) => metric.operation.startsWith('cost-') || metric.operation.startsWith('bars-'))
    .every((metric) => metric.rateLimit?.utilizationPct === 20));
});

test('Databento retries one 429 only when it supplies a bounded Retry-After delay', async () => {
  const attempts = new Map();
  const delays = [];
  const fetcher = async (url) => {
    const key = String(url).includes('metadata.get_cost') ? 'cost' : String(url).includes('timeseries.get_range') ? 'bars' : 'other';
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (key === 'cost' && attempts.get(key) === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } });
    if (key === 'cost') return new Response('0.10', { status: 200 });
    return new Response(`${JSON.stringify(bar('2026-09-29T14:59:00.000Z', 6001))}\n`, { status: 200 });
  };
  await fetchDatabentoUniverse(universe, {
    apiKey: 'test-key', maxScanCostUsd: 1, now, fetcher,
    sleep: async (ms) => delays.push(ms),
  });
  assert.deepEqual(delays, [2000]);
  assert.equal(attempts.get('cost'), 3, 'two estimates, with one estimate retried once');
  assert.equal(attempts.get('bars'), 2, 'each schema is downloaded once');

  let calls = 0;
  const noHeader = async () => { calls++; return new Response('rate limited', { status: 429 }); };
  await assert.rejects(fetchDatabentoUniverse(universe, { apiKey: 'test-key', maxScanCostUsd: 1, now, fetcher: noHeader }), /HTTP 429/);
  assert.equal(calls, 2, 'both parallel estimates fail closed without speculative retries');
});
