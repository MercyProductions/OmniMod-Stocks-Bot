import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachEtfTimeOfDayVolumeProfiles, fetchAlpacaEtfPositionMarks, fetchAlpacaEtfSession, fetchEtfDirectoryText, requestAlpacaJson } from '../src/alpacaMarketData.js';

// Preserve the legacy adapter fixtures as an explicit comparison baseline.
const auth = { ETF_DISCOVERY_MODE: 'baseline', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret', ETF_SYMBOLS: 'SPY,TLT',
  ETF_UNIVERSE_CACHE_PATH: fileURLToPath(new URL('./fixtures/etf-universe-cache.json', import.meta.url)) };
function response(payload, status = 200, headers = new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150', 'X-RateLimit-Reset': '1790700000' })) {
  return { ok: status === 200, status, headers, json: async () => payload };
}
const activeAssets = [
  { symbol: 'SPY', status: 'active', tradable: true, exchange: 'ARCA', name: 'SPDR S&P 500 ETF Trust' },
  { symbol: 'TLT', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'iShares 20+ Year Treasury Bond ETF' },
];
const clearReview = (date) => ({ status: 'clear', source: 'manual provider review', summary: 'Reviewed recent company and fund notices.', reviewedAt: date.toISOString() });

test('ETF directory retries a bounded 429 Retry-After and records attempt telemetry', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const waits = [];
  const metrics = [];
  const text = await fetchEtfDirectoryText('https://example.test/directory', async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) }
      : { ok: true, status: 200, headers: new Headers(), text: async () => 'Symbol|ETF\nSPY|Y' };
  }, metrics, 'ETF directory', { clock: () => now, random: () => 0,
    sleep: async (ms) => { waits.push(ms); now += ms; } });
  assert.equal(text, 'Symbol|ETF\nSPY|Y');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(metrics.map((row) => row.status), [429, 200]);
  assert.equal(metrics[0].retryDelayMs, 2_000);
  assert.equal(metrics[1].attempt, 2);
});

test('ETF directory retries transient 5xx but fails closed on 403', async () => {
  const metrics = [];
  const waits = [];
  let calls = 0;
  await assert.rejects(fetchEtfDirectoryText('https://example.test/directory', async () => {
    calls += 1;
    return { ok: false, status: 503, headers: new Headers() };
  }, metrics, 'ETF directory', { random: () => 0, sleep: async (ms) => waits.push(ms) }), /HTTP 503/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1_000]);
  calls = 0;
  await assert.rejects(fetchEtfDirectoryText('https://example.test/directory', async () => {
    calls += 1;
    return { ok: false, status: 403, headers: new Headers() };
  }, [], 'ETF directory'), /HTTP 403/);
  assert.equal(calls, 1);
});

test('Alpaca GET retries honor X-RateLimit-Reset and record each attempt', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const waits = [];
  const metrics = [];
  const payload = await requestAlpacaJson('https://data.alpaca.markets/v2/test', {}, async () => {
    calls += 1;
    return calls === 1
      ? response({}, 429, new Headers({ 'X-RateLimit-Reset': String((now + 2_000) / 1000) }))
      : response({ ok: true });
  }, metrics, 'Alpaca test', { clock: () => now, random: () => 0,
    sleep: async (ms) => { waits.push(ms); now += ms; } });
  assert.deepEqual(payload, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(metrics.map((row) => row.status), [429, 200]);
  assert.equal(metrics[0].retryDelayMs, 2_000);
});

test('Alpaca GET defers when the provider reset is beyond the bounded retry window', async () => {
  const metrics = [];
  let calls = 0;
  await assert.rejects(requestAlpacaJson('https://data.alpaca.markets/v2/test', {}, async () => {
    calls += 1;
    return response({}, 429, new Headers({ 'X-RateLimit-Reset': String(Date.now() / 1000 + 30) }));
  }, metrics, 'Alpaca test', { maxRetryWaitMs: 1, random: () => 0 }), /Retry deferred until the rate window resets/);
  assert.equal(calls, 1);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].status, 429);
  assert.equal(metrics[0].retryDelayMs, undefined);
});

test('Alpaca GET retries transient server errors with bounded backoff but does not retry 403', async () => {
  const metrics = [];
  const waits = [];
  let calls = 0;
  await assert.rejects(requestAlpacaJson('https://data.alpaca.markets/v2/test', {}, async () => {
    calls += 1;
    return response({}, 503, new Headers());
  }, metrics, 'Alpaca test', { maxAttempts: 3, random: () => 0, sleep: async (ms) => waits.push(ms) }), /HTTP 503/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1_000]);
  calls = 0;
  await assert.rejects(requestAlpacaJson('https://data.alpaca.markets/v2/test', {}, async () => {
    calls += 1;
    return response({}, 403, new Headers());
  }, [], 'Alpaca test'), /HTTP 403/);
  assert.equal(calls, 1);
});

test('Alpaca request wrapper defers subsequent same-key work after a 429', async () => {
  const metrics = [];
  const gateCalls = [];
  const deferred = [];
  let now = 1_800_000_000_000;
  let calls = 0;
  const gate = async (credential) => { gateCalls.push(credential); };
  gate.defer = (credential, delayMs) => deferred.push({ credential, delayMs });
  const fetcher = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) }
      : { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }) };
  };
  const headers = { 'APCA-API-KEY-ID': 'same-key', 'APCA-API-SECRET-KEY': 'test-secret' };
  const args = { clock: () => now, random: () => 0, sleep: async (ms) => { now += ms; }, requestGate: gate };
  await requestAlpacaJson('https://example.test/first', headers, fetcher, metrics, 'Alpaca test', args);
  await requestAlpacaJson('https://example.test/second', headers, fetcher, metrics, 'Alpaca test', args);
  assert.deepEqual(deferred, [{ credential: 'same-key', delayMs: 2_000 }]);
  assert.deepEqual(gateCalls, ['same-key', 'same-key', 'same-key']);
  assert.equal(JSON.stringify({ metrics, deferred, gateCalls }).includes('test-secret'), false);
});

test('ETF/ETP provider adapter passes the Alpaca credential to the shared request gate', async () => {
  const calls = [];
  const gate = async (credential) => { calls.push(['wait', credential]); };
  gate.defer = (credential, delayMs) => calls.push(['defer', credential, delayMs]);
  let request = 0;
  const fetcher = async () => {
    request += 1;
    return request === 1
      ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }) }
      : { ok: true, status: 200, headers: new Headers(), json: async () => ({ ready: true }) };
  };
  let now = 1_800_000_000_000;
  const headers = { 'APCA-API-KEY-ID': 'same-key', 'APCA-API-SECRET-KEY': 'fixture-secret' };
  const options = { clock: () => now, random: () => 0, sleep: async (ms) => { now += ms; }, requestGate: gate };
  const metrics = [];
  await requestAlpacaJson('https://example.test/first', headers, fetcher, metrics, 'Alpaca ETF quote', options);
  await requestAlpacaJson('https://example.test/second', headers, fetcher, metrics, 'Alpaca ETF quote', options);
  assert.deepEqual(calls, [['wait', 'same-key'], ['defer', 'same-key', 1_000], ['wait', 'same-key'], ['wait', 'same-key']]);
  assert.deepEqual(metrics.map((row) => row.cooldownDelayMs), [0, 1_000, 0]);
});

test('requires credentials before any provider call', async () => {
  let calls = 0;
  await assert.rejects(fetchAlpacaEtfSession({ env: {}, fetcher: async () => { calls += 1; } }), /credentials/);
  assert.equal(calls, 0);
});

test('same-slot volume history is bounded, persisted, and reused from cache', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'omnimod-etf-volume-'));
  try {
    const dates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    const currentOpen = Date.parse('2026-09-29T13:30:00Z');
    const currentSlot = 24;
    const now = new Date(currentOpen + (currentSlot + 1) * 300_000);
    const currentBars = Array.from({ length: currentSlot + 1 }, (_, index) => ({
      time: new Date(currentOpen + index * 300_000).toISOString(), volume: index === currentSlot ? 5000 : 1000,
    }));
    let historicalCalls = 0;
    const fetcher = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/calendar')) return response(dates.map((date) => ({ date, open: '09:30', close: '16:00' })));
      if (parsed.pathname.endsWith('/bars')) {
        historicalCalls += 1;
        assert.equal(parsed.searchParams.get('limit'), '10000');
        assert.equal(parsed.searchParams.get('feed'), 'sip');
        return response({ bars: { SPY: dates.map((date, index) => ({
          t: new Date(Date.parse(`${date}T13:30:00Z`) + currentSlot * 300_000).toISOString(), v: 3000 + index * 100,
        })) } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const options = { env: { ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED: 'true', ETF_TOD_VOLUME_CACHE_DIR: cache },
      fetcher, now, marketDate: '2026-09-29', currentOpenTime: currentOpen, feed: 'sip' };
    const first = await attachEtfTimeOfDayVolumeProfiles([{ symbol: 'SPY', bars: currentBars }], options);
    assert.equal(first.diagnostics.status, 'available_or_insufficient_history');
    assert.equal(first.diagnostics.symbolsRequested, 1);
    assert.equal(first.trades[0].session.priorSessionVolumeBars.length, 5);
    assert.equal(first.trades[0].session.timeOfDayVolumeProfile.status, 'complete');
    assert.equal(historicalCalls, 1);
    const saved = JSON.parse(await readFile(join(cache, '2026-09-29-sip-SPY.json'), 'utf8'));
    assert.equal(saved.observations.length, 5);

    const second = await attachEtfTimeOfDayVolumeProfiles([{ symbol: 'SPY', bars: currentBars }], {
      ...options, fetcher: async () => { throw new Error('Cache should prevent provider calls.'); },
    });
    assert.equal(second.diagnostics.cachedProfiles, 1);
    assert.equal(second.trades[0].session.timeOfDayVolumeProfile.status, 'cached');
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test('historical volume provider errors remain diagnostic and do not drop candidates', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'omnimod-etf-volume-error-'));
  try {
    const now = new Date('2026-09-29T15:35:00Z');
    const currentOpen = Date.parse('2026-09-29T13:30:00Z');
    const trade = { symbol: 'SPY', bars: [{ time: '2026-09-29T15:30:00Z', volume: 50 }] };
    const result = await attachEtfTimeOfDayVolumeProfiles([trade], {
      env: { ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED: 'true', ETF_TOD_VOLUME_CACHE_DIR: cache }, now,
      marketDate: '2026-09-29', currentOpenTime: currentOpen,
      fetcher: async (url) => new URL(url).pathname.endsWith('/calendar')
        ? response([{ date: '2026-09-25', open: '09:30', close: '16:00' }])
        : response({}, 503),
    });
    assert.equal(result.trades.length, 1);
    assert.equal(result.trades[0].session.timeOfDayVolumeProfile.status, 'provider_error');
    assert.match(result.diagnostics.providerError, /HTTP 503/);
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test('closed clock returns an empty scan without requesting market data', async () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const fetcher = async (url) => url.includes('/clock')
    ? response({ timestamp: now.toISOString(), is_open: false })
    : response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
  const result = await fetchAlpacaEtfSession({ env: auth, now, fetcher });
  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.reason, 'market_closed_or_clock_stale');
  assert.equal(result.providerMetrics.length, 2);
  assert.deepEqual(result.providerMetrics[0].rateLimit, { limit: 200, remaining: 150, reset: 1790700000, utilizationPct: 25 });
});

test('exposes failed request telemetry to the caller for journaling', async () => {
  const providerMetrics = [];
  let requests = 0;
  await assert.rejects(fetchAlpacaEtfSession({ env: { ...auth, ALPACA_API_KEY_ID: 'failed-telemetry-only' }, providerMetrics,
    fetcher: async () => { requests++; return { ok: false, status: 429 }; } }), /HTTP 429|ALPACA_PACING_DEFERRED/);
  assert.equal(providerMetrics.filter(row => row.requestAttempted !== false).length, requests);
  assert.ok(providerMetrics.some((row) => row.provider === 'Alpaca market clock'));
  assert.ok(providerMetrics.some((row) => row.status === 429 && /HTTP 429/.test(row.error)));
  assert.ok(providerMetrics.every((row) => row.status === 429 || (row.status === 0 && row.requestAttempted === false && row.budgetRejection === 'ALPACA_PACING_DEFERRED')));
  assert.ok(providerMetrics.some((row) => row.provider === 'Alpaca market calendar'));
  assert.ok(providerMetrics.some((row) => row.requestAttempted === false));
});

test('open clock uses fresh bulk quote and five-minute bars with ET session boundaries', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const start = Date.parse('2026-09-29T13:30:00Z');
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response(activeAssets);
    if (url.includes('/news')) return response({ news: [] });
    if (url.includes('/snapshots')) return response({ snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 500, ap: 500.01 } }, TLT: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 90, ap: 90.02 } } } });
    if (url.includes('/bars')) return response({ bars: Object.fromEntries(['SPY','TLT'].map((symbol) => [symbol, Array.from({ length: 18 }, (_, i) => ({ t: new Date(start + i * 300_000).toISOString(), o: 10, h: 11, l: 9, c: 10, v: 1000 }))])) });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await fetchAlpacaEtfSession({ env: auth, now, fetcher, catalystReviews: { SPY: clearReview(now), TLT: clearReview(now) } });
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].quote.quality, 'reference');
  assert.equal(result.diagnostics.quoteUse, 'single-venue-screening-only');
  assert.equal(result.trades[0].session.openTime, start);
  assert.equal(result.trades[0].session.closeTime, Date.parse('2026-09-29T20:00:00Z'));
  assert.equal(result.diagnostics.scanned, 2);
  assert.ok(urls.some((url) => url.includes('timeframe=5Min')));
});

test('rejects stale quotes and disallows delayed SIP as entry data', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  let marketDataCalls = 0;
  const common = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response(activeAssets);
    if (url.includes('/news')) return response({ news: [] });
    marketDataCalls += 1;
    if (url.includes('/snapshots')) return response({ snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: '2026-09-29T14:00:00Z', bp: 500, ap: 500.01 } } } });
    return response({ bars: { SPY: [] } });
  };
  const stale = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'SPY' }, now, fetcher: common, catalystReviews: { SPY: clearReview(now) } });
  assert.equal(stale.trades.length, 0);
  assert.equal(stale.diagnostics.rejected.stale_or_future_quote, 1);
  marketDataCalls = 0;
  const delayed = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'SPY', ETF_ALPACA_FEED: 'delayed_sip' }, now, fetcher: common });
  assert.equal(delayed.trades.length, 0);
  assert.equal(marketDataCalls, 0);
});

test('refreshes eligibility from active tradable asset master before market-data calls', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([
      activeAssets[0],
      { symbol: 'TLT', status: 'active', tradable: false, exchange: 'NASDAQ', name: 'inactive trading status' },
    ]);
    if (url.includes('/news')) return response({ news: [] });
    if (url.includes('/snapshots')) return response({ snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 500, ap: 500.01 } } } });
    if (url.includes('/bars')) return response({ bars: { SPY: [{ t: '2026-09-29T14:00:00Z', o: 500, h: 501, l: 499, c: 500, v: 10000 }] } });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'SPY,TLT' }, now, fetcher, catalystReviews: { SPY: clearReview(now), TLT: clearReview(now) } });
  assert.ok(calls.some((url) => url.includes('/assets?status=active')));
  const requestedSnapshot = new URL(calls.find((url) => url.includes('/snapshots'))).searchParams.get('symbols');
  assert.equal(requestedSnapshot, 'SPY');
  assert.equal(result.diagnostics.activeTradable, 1);
  assert.equal(result.diagnostics.rejectedAssets.asset_not_tradable, 1);
});

test('configured ETF_SYMBOLS uses the bundled registry by default, applies reviewed leverage, and blocks stale wrappers', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-etp-override-'));
  const classificationPath = join(directory, 'classifications.json');
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([{ symbol: 'NVD', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'NVD' }]);
    if (url.includes('/news')) return response({ news: [] });
    if (url.includes('/snapshots')) return response({ snapshots: { NVD: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 20, ap: 20.01 } } } });
    if (url.includes('/bars')) return response({ bars: { NVD: [{ t: '2026-09-29T14:00:00Z', o: 20, h: 20.5, l: 19.9, c: 20, v: 10000 }] } });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const row = (reviewedAt) => ({ symbol: 'NVD', name: 'GraniteShares 2x Short NVDA Daily ETF', productType: 'inverse_etf',
    exposureKey: 'NVDA', leverage: -2, inverse: true, sourceUrl: 'https://graniteshares.com/etfs/nvd/', reviewedAt });
  try {
    await writeFile(classificationPath, JSON.stringify([row(now.toISOString())]));
    const fresh = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'NVD', ETF_ETP_CLASSIFICATION_PATH: classificationPath },
      now, fetcher, catalystReviews: { NVD: clearReview(now) } });
    assert.equal(fresh.trades.length, 1);
    assert.equal(fresh.trades[0].assetClass, 'etp');
    assert.equal(fresh.trades[0].leverage, -2);
    assert.equal(fresh.trades[0].inverse, true);
    assert.deepEqual(fresh.diagnostics.discovery.blockedClassifications, []);

    const bundled = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'NVD' },
      now, fetcher, catalystReviews: { NVD: clearReview(now) } });
    assert.equal(bundled.trades.length, 1);
    assert.equal(bundled.trades[0].leverage, -2);
    assert.equal(bundled.trades[0].assetClass, 'etp');

    await writeFile(classificationPath, JSON.stringify([row('2026-01-01T00:00:00.000Z')]));
    let marketDataRequested = false;
    const stale = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'NVD', ETF_ETP_CLASSIFICATION_PATH: classificationPath },
      now, fetcher: async (url, options) => {
        if (url.includes('/news') || url.includes('/snapshots') || url.includes('/bars')) marketDataRequested = true;
        return fetcher(url, options);
      }, catalystReviews: { NVD: clearReview(now) } });
    assert.deepEqual(stale.diagnostics.discovery.blockedClassifications, ['NVD']);
    assert.equal(stale.diagnostics.discovery.classificationBlockedCandidates, 1);
    assert.equal(stale.trades.length, 0);
    assert.equal(marketDataRequested, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configured symbols must have ETF-directory or source-reviewed ETP identity before catalyst and quote requests', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const downstream = [];
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([{ symbol: 'ORDINARY', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'Ordinary Security' }]);
    downstream.push(url);
    throw new Error('Unverified configured instruments must be rejected before news or quotes.');
  };
  const result = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'ORDINARY' }, now, fetcher,
    catalystReviews: { ORDINARY: clearReview(now) } });
  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.discovery.unverifiedConfiguredSymbols[0], 'ORDINARY');
  assert.equal(result.diagnostics.discovery.rejectedDiscovery.security_type_unverified, 1);
  assert.deepEqual(downstream, []);
});

test('unreviewed leveraged-product names are blocked before catalyst and quote requests', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const downstreamCalls = [];
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([{ symbol: 'UNREVIEWED', status: 'active', tradable: true,
      exchange: 'NASDAQ', name: 'Example Daily S&P 2x ETF' }]);
    downstreamCalls.push(url);
    throw new Error(`Unexpected downstream URL: ${url}`);
  };
  const result = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'UNREVIEWED' }, now, fetcher,
    catalystReviews: { UNREVIEWED: clearReview(now) } });
  assert.equal(result.diagnostics.discovery.rejectedDiscovery.unreviewed_leveraged_or_inverse_name, 1);
  assert.deepEqual(result.diagnostics.discovery.unreviewedWrapperSymbols, ['UNREVIEWED']);
  assert.equal(result.trades.length, 0);
  assert.deepEqual(downstreamCalls, []);
});

test('an ETF-directory-flagged but unreviewed ETN is blocked before news and quotes', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const downstreamCalls = [];
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([{ symbol: 'UNREVIEWED', status: 'active', tradable: true,
      exchange: 'NASDAQ', name: 'Example Index ETN' }]);
    downstreamCalls.push(url);
    throw new Error(`Unexpected downstream URL: ${url}`);
  };
  const result = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'UNREVIEWED' }, now, fetcher,
    catalystReviews: { UNREVIEWED: clearReview(now) } });
  assert.equal(result.diagnostics.discovery.rejectedDiscovery.unreviewed_etn_name, 1);
  assert.deepEqual(result.diagnostics.discovery.unreviewedWrapperSymbols, ['UNREVIEWED']);
  assert.equal(result.trades.length, 0);
  assert.deepEqual(downstreamCalls, []);
});

test('a post-review headline invalidates the clearance and prevents market-data requests', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  let marketDataRequests = 0;
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([activeAssets[0]]);
    if (url.includes('/news')) return response({ news: [{ id: 42, created_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
      updated_at: now.toISOString(), symbols: ['SPY'], headline: 'Fund issuer announces material event', source: 'wire', url: 'https://news.example/etf-event' }] });
    marketDataRequests += 1;
    throw new Error('Quote and bars should not be requested after catalyst invalidation.');
  };
  const reviewTime = new Date(now.getTime() - 60_000);
  const result = await fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'SPY' }, now, fetcher, catalystReviews: { SPY: clearReview(reviewTime) } });
  assert.equal(result.diagnostics.rejectedCatalysts.news_activity_after_review, 1);
  assert.equal(result.trades.length, 0);
  assert.equal(marketDataRequests, 0);
});

test('rejects oversized and malformed configured universes', async () => {
  const fetcher = async () => { throw new Error('should not fetch'); };
  await assert.rejects(fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: Array(201).fill('SPY').map((v, i) => `${v}${i}`).join(',') }, fetcher }), /capped/);
  await assert.rejects(fetchAlpacaEtfSession({ env: { ...auth, ETF_SYMBOLS: 'SPY,INVALID!' }, fetcher }), /invalid ticker/);
});

test('position monitoring fetches consolidated quotes independently of entry catalyst gates', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const calls = [];
  const metrics = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/snapshots')) return response({ snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 500, ap: 500.02 } } } });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await fetchAlpacaEtfPositionMarks([
    { orderId: 'open-1', owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY', status: 'filled' },
    { orderId: 'other-bot', owner: 'stocks', assetClass: 'stock', instrumentKey: 'SPY', status: 'filled' },
  ], { env: { ...auth, ETF_ALPACA_FEED: 'sip' }, now, fetcher, providerMetrics: metrics });
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].orderId, 'open-1');
  assert.equal(result.marks[0].quote.quality, 'executable');
  assert.equal(result.marks[0].quote.time, now.toISOString());
  assert.equal(result.diagnostics.quoted, 1);
  assert.equal(calls.filter((url) => url.includes('/snapshots')).length, 1);
  assert.ok(calls.every((url) => !url.includes('/news')));
  assert.equal(metrics.length, 3);
});

test('position monitoring reports unavailable marks without an eligible feed or credentials', async () => {
  const orders = [{ orderId: 'open-1', owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'TQQQ', status: 'open' }];
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not fetch'); };
  const noFeed = await fetchAlpacaEtfPositionMarks(orders, { env: { ...auth, ETF_ALPACA_FEED: 'iex' }, fetcher });
  assert.equal(noFeed.diagnostics.status, 'consolidated_sip_required_for_position_marks');
  const noCredentials = await fetchAlpacaEtfPositionMarks(orders, { env: { ETF_ALPACA_FEED: 'sip' }, fetcher });
  assert.equal(noCredentials.diagnostics.status, 'credentials_missing');
  assert.equal(calls, 0);
});

test('position monitoring rejects stale and crossed consolidated quotes', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const fetcher = async (url) => {
    if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/snapshots')) return response({ snapshots: {
      SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: '2026-09-29T14:00:00Z', bp: 500, ap: 500.01 } },
      TLT: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: now.toISOString(), bp: 90.02, ap: 90 } },
    } });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await fetchAlpacaEtfPositionMarks(['SPY', 'TLT'].map((instrumentKey, i) => ({ orderId: `open-${i}`, owner: 'etfs-etps', assetClass: 'etf', instrumentKey, status: 'open' })),
    { env: { ...auth, ETF_ALPACA_FEED: 'sip' }, now, fetcher });
  assert.equal(result.marks.length, 0);
  assert.equal(result.diagnostics.rejected, 2);
  assert.equal(result.diagnostics.rejectionReasons.stale_or_future_quote, 1);
  assert.equal(result.diagnostics.rejectionReasons.invalid_bid_ask, 1);
});

test('ETF marks reject malformed numeric prices and session/quote expiry during requests', async () => {
  const at = Date.parse('2026-09-29T15:00:00Z');
  for (const [bp, ap, delay, expected] of [[true, true, 0, 'invalid_bid_ask'], [100, 100.1, 16000, 'stale_or_future_quote'],
    [100, 100.1, 5 * 3600000, 'session_closed_during_quotes']]) {
    let current = at;
    const fetcher = async (url) => {
      if (url.includes('/clock')) return response({ is_open: true, timestamp: new Date(at).toISOString() });
      if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
      current += delay;
      return response({ snapshots: { SPY: { latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], t: new Date(at).toISOString(), bp, ap } } } });
    };
    const result = await fetchAlpacaEtfPositionMarks([{ orderId: 'test', owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY', status: 'open' }],
      { env: { ...auth, ETF_ALPACA_FEED: 'sip' }, now: new Date(at), clock: () => current, fetcher });
    assert.equal(result.marks.length, 0); assert.equal(result.diagnostics.rejectionReasons[expected], 1);
  }
});
