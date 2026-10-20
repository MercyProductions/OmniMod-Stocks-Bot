import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFinnhubEconomicCalendar, mapFinnhubEconomicCalendar } from '../src/economicCalendar.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const marketDate = '2026-09-29';

test('high/medium releases conservatively block affected pairs across adjacent provider-local dates', () => {
  const result = mapFinnhubEconomicCalendar({ economicCalendar: [
    { time: '2026-09-28 23:30:00', country: 'US', event: 'FOMC decision', impact: 'high' },
    { time: '2026-09-29 14:00:00', country: 'GB', event: 'Labor data', impact: 'medium' },
    { time: '2026-09-29 12:00:00', country: 'US', event: 'Minor survey', impact: 'low' },
  ] }, ['EUR_USD', 'GBP_JPY'], { marketDate, now });
  assert.equal(result.reviews.EUR_USD.status, 'blocked');
  assert.equal(result.reviews.EUR_USD.events[0].name, 'FOMC decision');
  assert.equal(result.reviews.GBP_JPY.status, 'blocked');
  assert.deepEqual([result.diagnostics.from, result.diagnostics.to], ['2026-09-28', '2026-09-30']);
});

test('no material scheduled events yields sourced per-pair clearance; unsupported currencies fail closed', () => {
  const result = mapFinnhubEconomicCalendar({ economicCalendar: [
    { time: '2026-09-29 12:00:00', country: 'US', event: 'Minor survey', impact: 'low' },
  ] }, ['EUR_USD', 'USD_XYZ'], { marketDate, now });
  assert.equal(result.reviews.EUR_USD.status, 'clear');
  assert.match(result.reviews.EUR_USD.summary, /No medium\/high-impact/);
  assert.equal(result.reviews['USD_XYZ'].status, 'blocked');
});

test('common non-major currency pairs receive country-specific event coverage', () => {
  const calendar = { economicCalendar: [
    { time: '2026-09-29 08:00:00', country: 'TR', event: 'Central Bank Rate Decision', impact: 'high' },
    { time: '2026-09-29 12:00:00', country: 'MX', event: 'Inflation Release', impact: 'medium' },
  ] };
  const result = mapFinnhubEconomicCalendar(calendar, ['EUR_TRY', 'USD_MXN'], { marketDate, now });
  assert.equal(result.reviews.EUR_TRY.status, 'blocked');
  assert.equal(result.reviews.EUR_TRY.events[0].country, 'TR');
  assert.equal(result.reviews.USD_MXN.status, 'blocked');
  assert.equal(result.reviews.USD_MXN.events[0].country, 'MX');
  const clear = mapFinnhubEconomicCalendar({ economicCalendar: [] }, ['EUR_TRY', 'USD_MXN'], { marketDate, now });
  assert.equal(clear.reviews.EUR_TRY.status, 'clear');
  assert.equal(clear.reviews.USD_MXN.status, 'clear');
});

test('shared calendar supports explicit country coverage for non-FX contracts', () => {
  const result = mapFinnhubEconomicCalendar({ economicCalendar: [
    { time: '2026-09-29 14:00:00', country: 'US', event: 'ISM release', impact: 'high' },
  ] }, ['CME_ESZ6', 'COMEX_GCZ6'], { marketDate, now,
    countryCodesByInstrument: { CME_ESZ6: ['US'], COMEX_GCZ6: ['US'] } });
  assert.equal(result.reviews.CME_ESZ6.status, 'blocked');
  assert.equal(result.reviews.COMEX_GCZ6.status, 'blocked');
  assert.equal(result.diagnostics.materialPairBlocks, 2);
});

test('missing credentials do not call Finnhub and block pair clearances', async () => {
  let calls = 0;
  const result = await fetchFinnhubEconomicCalendar({ marketDate, instruments: ['EUR_USD'], now,
    fetcher: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.diagnostics.status, 'credentials_missing');
  assert.equal(result.reviews.EUR_USD.status, 'blocked');
});

test('paid calendar request parses provider payload and records sanitized provider latency', async () => {
  const metrics = [];
  let requested;
  const result = await fetchFinnhubEconomicCalendar({ token: 'private-test-token', marketDate, instruments: ['EUR_USD'], now, metrics,
    fetcher: async (url, options) => {
      requested = new URL(url);
      assert.equal(options.headers['X-Finnhub-Token'], 'private-test-token');
      return { ok: true, status: 200, headers: new Headers({ 'RateLimit-Limit': '30', 'RateLimit-Remaining': '24' }), json: async () => ({ economicCalendar: [] }) };
    } });
  assert.equal(requested.pathname, '/api/v1/calendar/economic');
  assert.equal(requested.searchParams.get('from'), '2026-09-28');
  assert.equal(requested.searchParams.get('to'), '2026-09-30');
  assert.equal(requested.searchParams.has('token'), false);
  assert.equal(result.reviews.EUR_USD.status, 'clear');
  assert.equal(metrics[0].provider, 'Finnhub Economic Calendar');
  assert.equal(metrics[0].operation, 'economic-calendar');
  assert.equal(metrics[0].rateLimit.utilizationPct, 20);
  assert.equal(JSON.stringify(metrics).includes('private-test-token'), false);
});

test('shared Finnhub calendar honors Retry-After, records attempts, and fails closed on long waits', async () => {
  let calls = 0;
  const waits = [];
  const metrics = [];
  const result = await fetchFinnhubEconomicCalendar({ token: 'private-retry-token', marketDate, instruments: ['EUR_USD'], now,
    cache: false, metrics, random: () => 0, sleep: async (ms) => waits.push(ms),
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }) }
        : { ok: true, status: 200, headers: new Headers(), json: async () => ({ economicCalendar: [] }) };
    } });
  assert.equal(result.reviews.EUR_USD.status, 'clear');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
  assert.deepEqual(metrics.map((row) => row.status), [429, 200]);
  assert.equal(metrics[0].retryDelayMs, 1_000);
  assert.equal(JSON.stringify(metrics).includes('private-retry-token'), false);

  calls = 0;
  const deferred = [];
  await assert.rejects(fetchFinnhubEconomicCalendar({ token: 'private-retry-token', marketDate, instruments: ['EUR_USD'], now,
    cache: false, metrics: deferred, maxRetryWaitMs: 1,
    fetcher: async () => { calls += 1; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '30' }) }; } }), /Retry deferred/);
  assert.equal(calls, 1);
  assert.match(deferred[0].error, /Retry deferred/);
});

test('shared Finnhub calendar cache maps one raw event response per bot and refreshes expired entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-economic-calendar-'));
  const cachePath = join(directory, 'calendar.json');
  const payload = { economicCalendar: [{ time: '2026-09-29 14:00:00', country: 'US', event: 'CPI', impact: 'high' }] };
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: true, status: 200, headers: new Headers(), json: async () => payload }; };
  try {
    const firstMetrics = [];
    const first = await fetchFinnhubEconomicCalendar({ token: 'private-cache-token', marketDate, instruments: ['EUR_USD'], now,
      fetcher, cache: true, cachePath, metrics: firstMetrics });
    assert.equal(first.reviews.EUR_USD.status, 'blocked');
    assert.equal(first.diagnostics.cache, 'miss');
    assert.equal(calls, 1);

    const secondMetrics = [];
    const second = await fetchFinnhubEconomicCalendar({ token: 'private-cache-token', marketDate, instruments: ['EUR_GBP'], now: now + 1_000,
      fetcher, cache: true, cachePath, metrics: secondMetrics });
    assert.equal(second.reviews.EUR_GBP.status, 'clear');
    assert.equal(second.diagnostics.cache, 'hit');
    assert.equal(secondMetrics[0].operation, 'economic-calendar-cache');
    assert.equal(calls, 1, 'second market-specific mapping reuses the shared raw calendar payload');
    assert.equal((await readFile(cachePath, 'utf8')).includes('private-cache-token'), false);

    const expired = await fetchFinnhubEconomicCalendar({ token: 'private-cache-token', marketDate, instruments: ['EUR_USD'], now: now + 6 * 60_000,
      fetcher, cache: true, cachePath });
    assert.equal(expired.diagnostics.cache, 'miss');
    assert.equal(calls, 2, 'expired calendar data must be refreshed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent market runners serialize a cold calendar-cache miss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-economic-calendar-lock-'));
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ economicCalendar: [] }) };
  };
  try {
    const results = await Promise.all(['EUR_USD', 'ESZ6'].map((instrument) => fetchFinnhubEconomicCalendar({
      token: 'private-cache-token', marketDate, instruments: [instrument], now, fetcher, cache: true,
      cachePath: join(directory, 'calendar.json'), countryCodesByInstrument: { ESZ6: ['US'] },
    })));
    assert.equal(calls, 1);
    assert.deepEqual(results.map((row) => row.reviews[Object.keys(row.reviews)[0]].status), ['clear', 'clear']);
    assert.deepEqual(results.map((row) => row.diagnostics.cache).sort(), ['hit', 'miss']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing or malformed event payload fails closed rather than declaring calendar clear', () => {
  assert.throws(() => mapFinnhubEconomicCalendar({}, ['EUR_USD'], { marketDate, now }), /missing economicCalendar/);
  assert.throws(() => mapFinnhubEconomicCalendar({ economicCalendar: [{ country: 'US', event: 'Unknown time', impact: 'high' }] }, ['EUR_USD'], { marketDate, now }), /missing a usable date/);
  assert.throws(() => mapFinnhubEconomicCalendar({ economicCalendar: [{ time: '2026-02-31 14:00:00', country: 'US', event: 'Invalid date', impact: 'high' }] }, ['EUR_USD'], { marketDate, now }), /missing a usable date/);
  assert.throws(() => mapFinnhubEconomicCalendar({ economicCalendar: [] }, ['EUR_USD'], { marketDate: '2026-02-31', now }), /valid market date/);
});

test('invalid market dates are rejected before a paid calendar request', async () => {
  let calls = 0;
  await assert.rejects(fetchFinnhubEconomicCalendar({ token: 'private-test-token', marketDate: '2026-02-31', instruments: ['EUR_USD'], now,
    fetcher: async () => { calls += 1; } }), /valid YYYY-MM-DD date/);
  assert.equal(calls, 0);
});
