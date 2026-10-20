import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFinnhubJson, fetchPolygonJson, retryAfterMs } from '../src/stocksData.js';

test('Stocks Finnhub requests send the token in a header, not the URL or diagnostics', async () => {
  const metrics = { requests: [] };
  let requestedUrl;
  let requestedOptions;
  const payload = await fetchFinnhubJson('/calendar/earnings', { from: '2026-09-29', symbol: 'BRK.B' }, 'private-fixture-token', {
    provider: 'Finnhub earnings calendar', metrics,
    fetcher: async (url, options) => {
      requestedUrl = new URL(url);
      requestedOptions = options;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ earningsCalendar: [] }) };
    },
  });

  assert.deepEqual(payload, { earningsCalendar: [] });
  assert.equal(requestedUrl.origin, 'https://finnhub.io');
  assert.equal(requestedUrl.pathname, '/api/v1/calendar/earnings');
  assert.equal(requestedUrl.searchParams.get('symbol'), 'BRK.B');
  assert.equal(requestedUrl.searchParams.has('token'), false);
  assert.equal(requestedOptions.headers['X-Finnhub-Token'], 'private-fixture-token');
  assert.equal(JSON.stringify(metrics).includes('private-fixture-token'), false);
});

test('Stocks Finnhub request refuses missing credentials before network access', async () => {
  let requests = 0;
  await assert.rejects(fetchFinnhubJson('/quote', { symbol: 'AAPL' }, '', {
    fetcher: async () => { requests += 1; },
  }), /token is required/);
  assert.equal(requests, 0);
});

test('Stocks Polygon requests use Bearer authentication without a query-string key', async () => {
  const metrics = { requests: [] };
  let requestedUrl;
  let requestedOptions;
  const payload = await fetchPolygonJson('/v2/last/trade/AAPL', {}, 'private-polygon-fixture', {
    metrics,
    fetcher: async (url, options) => {
      requestedUrl = new URL(url);
      requestedOptions = options;
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ results: { p: 240, t: 1_790_000_000_000_000_000 } }) };
    },
  });

  assert.equal(payload.results.p, 240);
  assert.equal(requestedUrl.origin, 'https://api.polygon.io');
  assert.equal(requestedUrl.pathname, '/v2/last/trade/AAPL');
  assert.equal(requestedUrl.searchParams.has('apiKey'), false);
  assert.equal(requestedOptions.headers.authorization, 'Bearer private-polygon-fixture');
  assert.equal(JSON.stringify(metrics).includes('private-polygon-fixture'), false);
});

test('Stocks retries a 429 after the provider Retry-After delay', async () => {
  const delays = [];
  const metrics = { requests: [] };
  let calls = 0;
  const payload = await fetchFinnhubJson('/quote', { symbol: 'AAPL' }, 'fixture-token', {
    metrics,
    sleepFn: async (ms) => delays.push(ms),
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '3' }), text: async () => 'rate limited' }
        : { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ c: 240 }) };
    },
  });
  assert.deepEqual(payload, { c: 240 });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [3000]);
  assert.equal(metrics.requests.length, 2);
  assert.equal(metrics.requests[0].status, 429);
  assert.equal(metrics.requests[1].retry, 1);
});

test('Stocks fails closed rather than retrying before a long provider Retry-After window', async () => {
  let calls = 0;
  await assert.rejects(fetchPolygonJson('/v2/last/trade/AAPL', {}, 'fixture-key', {
    sleepFn: async () => assert.fail('long Retry-After must not be shortened'),
    fetcher: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '11' }), text: async () => 'rate limited' };
    },
  }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('Stocks retries transient provider transport failures with bounded backoff and records each attempt', async () => {
  const delays = [];
  const metrics = { requests: [] };
  let calls = 0;
  const payload = await fetchFinnhubJson('/quote', { symbol: 'AAPL' }, 'fixture-token', {
    metrics,
    sleepFn: async (ms) => delays.push(ms),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('temporary network failure');
      if (calls === 2) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ c: 240 }) };
    },
  });

  assert.deepEqual(payload, { c: 240 });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(metrics.requests.map((row) => row.retry), [0, 1, 1]);
  assert.deepEqual(metrics.requests.map((row) => row.status), [0, 0, 200]);
});

test('Stocks does not retry non-transient request construction or response parsing failures', async () => {
  let calls = 0;
  await assert.rejects(fetchPolygonJson('/v2/last/trade/AAPL', {}, 'fixture-key', {
    sleepFn: async () => assert.fail('non-transient error must not be retried'),
    fetcher: async () => {
      calls += 1;
      return { ok: true, status: 200, headers: new Headers(), text: async () => '{bad json' };
    },
  }), SyntaxError);
  assert.equal(calls, 1);
});

test('Retry-After parser handles delay-seconds and HTTP dates, with malformed values unknown', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  assert.equal(retryAfterMs('4', now), 4000);
  assert.equal(retryAfterMs('Wed, 30 Sep 2026 12:00:05 GMT', now), 5000);
  assert.equal(retryAfterMs('not-a-date', now), null);
  assert.equal(retryAfterMs('Wed, 30 Sep 2026 11:59:00 GMT', now), 0);
});
