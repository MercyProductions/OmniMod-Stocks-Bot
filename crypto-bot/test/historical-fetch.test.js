import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBinanceSpotCandles } from '../scripts/fetch-historical-candles.js';

const barMs = 15 * 60_000;
const row = (time, close = 100) => [time, String(close - 1), String(close + 1), String(close - 2), String(close), '12', time + barMs - 1, '1200', 4, '6', '600', '0'];
const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: (key) => headers[key.toLowerCase()] ?? null }, json: async () => body });

test('fetches only bounded completed 15-minute bars with provenance and UTC range', async () => {
  const startTime = Date.parse('2026-09-01T00:00:00Z');
  const calls = [];
  const result = await fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime, endTime: startTime + 3 * barMs,
    maxBars: 3, now: startTime + 4 * barMs, pageDelayMs: 0, sleepFn: async () => {},
    fetcher: async (url) => {
      calls.push(new URL(url));
      return response([row(startTime), row(startTime + barMs), row(startTime + 2 * barMs)]);
    } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://data-api.binance.vision');
  assert.equal(calls[0].pathname, '/api/v3/klines');
  assert.equal(calls[0].searchParams.get('symbol'), 'BTCUSDT');
  assert.equal(calls[0].searchParams.get('interval'), '15m');
  assert.equal(calls[0].searchParams.get('limit'), '1000');
  assert.equal(result.candles.length, 3);
  assert.equal(result.candles[0].symbol, 'BTC');
  assert.equal(result.candles[0].pair, 'BTCUSDT');
  assert.equal(result.candles[0].provider, 'Binance Spot');
  assert.equal(result.diagnostics.complete, true);
  assert.equal(result.diagnostics.observationsAreOHLCVNotExecutableQuotes, true);
});

test('drops an incomplete current candle and exposes missing bar slots', async () => {
  const startTime = Date.parse('2026-09-01T00:00:00Z');
  const malformed = row(startTime + barMs);
  malformed[2] = '99';
  const result = await fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime, endTime: startTime + 3 * barMs,
    maxBars: 3, now: startTime + 2 * barMs + 1, pageDelayMs: 0, sleepFn: async () => {},
    fetcher: async () => response([row(startTime), malformed, row(startTime + 2 * barMs), row(startTime + 2 * barMs)]) });
  assert.deepEqual(result.candles.map((candle) => candle.time), [startTime]);
  assert.equal(result.diagnostics.returnedBars, 1);
  assert.equal(result.diagnostics.missingBarSlots, 2);
  assert.equal(result.diagnostics.complete, false);
});

test('retries rate-limited pages with bounded delay and reports each attempt', async () => {
  const startTime = Date.parse('2026-09-01T00:00:00Z');
  const waits = [];
  let calls = 0;
  const result = await fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime, endTime: startTime + barMs,
    maxBars: 1, now: startTime + 2 * barMs, pageDelayMs: 0, sleepFn: async (ms) => waits.push(ms),
    fetcher: async () => ++calls === 1 ? response([], 429, { 'retry-after': '1' }) : response([row(startTime)]) });
  assert.equal(result.candles.length, 1);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(result.diagnostics.requestAttempts.map((request) => request.status), [429, 200]);
});

test('does not retry a Binance rate limit before a server-requested long wait', async () => {
  const startTime = Date.parse('2026-09-01T00:00:00Z');
  const waits = [];
  let calls = 0;
  await assert.rejects(fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime, endTime: startTime + barMs,
    maxBars: 1, now: startTime + 2 * barMs, pageDelayMs: 0, sleepFn: async (ms) => waits.push(ms),
    fetcher: async () => { calls += 1; return response([], 429, { 'retry-after': '30' }); } }), /retry deferred.*30000ms/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('rejects invalid market, unaligned interval boundaries, and ranges above the explicit bar cap before networking', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return response([]); };
  const startTime = Date.parse('2026-09-01T00:00:00Z');
  await assert.rejects(fetchBinanceSpotCandles({ symbol: 'BTC/USDT', startTime, endTime: startTime + barMs, maxBars: 1, fetcher }), /valid Binance Spot/);
  await assert.rejects(fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime: startTime + 1, endTime: startTime + barMs, maxBars: 1, fetcher }), /aligned/);
  await assert.rejects(fetchBinanceSpotCandles({ symbol: 'BTCUSDT', startTime, endTime: startTime + 2 * barMs, maxBars: 1, fetcher }), /above maxBars/);
  assert.equal(calls, 0);
});
