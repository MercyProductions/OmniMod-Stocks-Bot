import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withProviderTelemetry } from '../src/providerTelemetry.js';

test('derivatives requests honor Retry-After and coalesce concurrent same-asset scans', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-derivatives-retry-'));
  process.env.OMNIMOD_CRYPTO_DATA_DIR = temporaryData;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let premiumAttempts = 0;
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl.includes('/fapi/v1/premiumIndex') && premiumAttempts++ === 0) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0.05' } });
    }
    if (requestUrl.includes('/fapi/v1/premiumIndex')) return new Response(JSON.stringify({ markPrice: '100', indexPrice: '99', lastFundingRate: '0.0001', time: Date.now() }), { status: 200 });
    if (requestUrl.includes('/fapi/v1/openInterest')) return new Response(JSON.stringify({ openInterest: '1200' }), { status: 200 });
    if (requestUrl.includes('/futures/data/openInterestHist')) {
      const symbol = new URL(requestUrl).searchParams.get('symbol');
      return new Response(JSON.stringify(symbol === 'XRPUSDT' ? [] : [
        { sumOpenInterestValue: '100000', timestamp: Date.now() - 60_000 },
        { sumOpenInterestValue: '101000', timestamp: Date.now() },
      ]), { status: 200 });
    }
    if (requestUrl.includes('/futures/data/globalLongShortAccountRatio')) {
      const stale = new URL(requestUrl).searchParams.get('symbol') === 'XRPUSDT';
      return new Response(JSON.stringify([{ longShortRatio: stale ? '3.5' : '1.1', timestamp: Date.now() - (stale ? 11 : 0) * 60_000 }]), { status: 200 });
    }
    if (requestUrl.includes('/futures/data/takerlongshortRatio')) {
      const stale = new URL(requestUrl).searchParams.get('symbol') === 'XRPUSDT';
      return new Response(JSON.stringify([{ buySellRatio: '1.2', timestamp: Date.now() - (stale ? 11 : 0) * 60_000 }]), { status: 200 });
    }
    if (requestUrl.includes('/tickers')) return new Response(JSON.stringify({ result: 'success', tickers: [
      { symbol: 'PF_SOLUSD', markPrice: 100, indexPrice: 99, fundingRate: 10, openInterest: 100, lastTime: new Date().toISOString() },
      { symbol: 'PF_XRPUSD', markPrice: 100, indexPrice: 99, fundingRate: 10, openInterest: 100, lastTime: new Date().toISOString() },
    ] }), { status: 200 });
    throw new Error(`Unexpected fixture URL: ${requestUrl}`);
  };
  try {
    const { fetchDerivativesSnapshot } = await import('../src/derivativesProviders.js');
    const observed = await withProviderTelemetry(() => Promise.all([
      fetchDerivativesSnapshot({ symbol: 'SOL', price: 100 }),
      fetchDerivativesSnapshot({ symbol: 'SOL', price: 100 }),
    ]));
    assert.strictEqual(observed.result[0], observed.result[1]);
    assert.equal(observed.result[0].available, true);
    const freshBinance = observed.result[0].observations.find((row) => row.provider === 'Binance Futures');
    assert.equal(freshBinance.longShortRatioAvailable, true);
    assert.equal(freshBinance.takerBuySellRatioAvailable, true);
    assert.equal(calls.filter((url) => url.includes('/fapi/v1/premiumIndex')).length, 2, 'one 429 is retried once');
    assert.equal(calls.filter((url) => url.includes('/fapi/v1/openInterest?')).length, 0, 'successful five-minute history supplies current notional');
    assert.equal(calls.filter((url) => url.includes('/tickers')).length, 1, 'same-asset calls share one derivative scan');
    assert.equal(observed.providers['Binance Futures'].requests, 5);
    assert.equal(observed.providers['Binance Futures'].rateLimits, 1);
    assert.equal(observed.providers['Binance Futures'].successes, 4);
    assert.equal(observed.providers['Kraken Futures'].requests, 1);

    const { result: emptyHistory } = await withProviderTelemetry(() => fetchDerivativesSnapshot({ symbol: 'XRP', price: 100 }));
    assert.equal(emptyHistory.available, true);
    const staleBinance = emptyHistory.observations.find((row) => row.provider === 'Binance Futures');
    assert.equal(staleBinance.longShortRatioAvailable, false);
    assert.equal(staleBinance.longShortRatio, 0, 'stale crowding ratios are omitted from scoring');
    assert.equal(staleBinance.takerBuySellRatioAvailable, false);
    assert.equal(staleBinance.takerBuySellRatio, 0, 'stale taker ratios are omitted from scoring');
    assert.equal(emptyHistory.longShortRatioAvailable, false);
    assert.equal(emptyHistory.takerBuySellRatioAvailable, false);
    assert.equal(emptyHistory.observations.find((row) => row.provider === 'Binance Futures').openInterestUsd, 120_000,
      'current open interest remains the fallback when no history value exists');
    assert.equal(calls.filter((url) => url.includes('/fapi/v1/openInterest?')).length, 1,
      'current open-interest endpoint runs only for the empty-history fallback');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OMNIMOD_CRYPTO_DATA_DIR;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});
