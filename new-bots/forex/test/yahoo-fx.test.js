import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFourHourBars, fetchYahooFxObservation, yahooFxSymbol } from '../src/yahooFx.js';
import { createForexRequestGate } from '../src/providerRequest.js';

test('Yahoo FX adapter refuses requests until permission is explicitly attested', async () => {
  let requested = false;
  await assert.rejects(fetchYahooFxObservation('EUR_USD', { fetcher: async () => { requested = true; } }), /permission attestation/);
  assert.equal(requested, false);
});

function payload(times, closes) {
  return { chart: { result: [{ timestamp: times, indicators: { quote: [{
    open: closes.map((x) => x - 0.0001), high: closes.map((x) => x + 0.0005),
    low: closes.map((x) => x - 0.0005), close: closes
  }] } }] } };
}

test('maps only explicit FX pairs to public chart symbols', () => {
  assert.equal(yahooFxSymbol('EUR_USD'), 'EURUSD=X');
  assert.equal(yahooFxSymbol('USD_JPY'), 'JPY=X');
  assert.throws(() => yahooFxSymbol('EUR_TRY'), /No public Yahoo FX symbol mapping/);
});

test('aggregates complete four-hour candles from four hourly bars', () => {
  const start = Date.parse('2026-09-24T08:00:00Z');
  const bars = Array.from({ length: 4 }, (_, i) => ({ time: start + i * 3600000, open: 1 + i, high: 2 + i, low: 0.5 + i, close: 1.5 + i }));
  assert.deepEqual(aggregateFourHourBars(bars), [{ time: start, open: 1, high: 5, low: 0.5, close: 4.5 }]);
  assert.deepEqual(aggregateFourHourBars(bars.slice(0, 3)), []);
});

test('builds completed-bar M15, H4, and daily trend observations without inventing bid/ask', async () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const makeSeries = (count, duration) => {
    const times = Array.from({ length: count }, (_, i) => Math.floor((now - (count - i) * duration) / 1000));
    const closes = times.map((_, i) => 1.1 + i * 0.0001);
    return payload(times, closes);
  };
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => {
    if (url.includes('interval=15m')) return makeSeries(60, 15 * 60000);
    if (url.includes('interval=1h')) return makeSeries(240, 3600000);
    return makeSeries(40, 24 * 3600000);
  } });
  const metrics = [];
  const row = await fetchYahooFxObservation('EUR_USD', { fetcher, now, metrics, clock: () => 100, permissionConfirmed: true });
  assert.equal(row.bias, 'UPWARD WATCH');
  assert.equal(row.source, 'Yahoo Chart (public delayed/unofficial)');
  assert.equal(row.spread, null);
  assert.equal(row.bid, null);
  assert.equal(row.frames.length, 3);
  assert.ok(row.frameWatches.every((watch) => watch.bias === 'UPWARD PAPER WATCH'));
  assert.equal(row.frameWatches[0].entryReference, row.quoteMid);
  assert.match(row.frameWatches[0].method, /not an executable quote/);
  assert.deepEqual(metrics.map((metric) => metric.operation).sort(), ['chart-15m', 'chart-1d', 'chart-1h']);
  assert.ok(metrics.every((metric) => metric.provider === 'Yahoo Chart public' && metric.status === 200 && metric.latencyMs === 0));
});

test('retries a transient Yahoo timeframe failure once and records every attempt', async () => {
  const metrics = [];
  let completed = 0;
  await assert.rejects(fetchYahooFxObservation('EUR_USD', {
    metrics, permissionConfirmed: true, retrySleep: async () => {},
    fetcher: async (url) => {
      await Promise.resolve();
      completed++;
      return url.includes('interval=1h') ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => payload([1_790_000_000], [1.1]) };
    },
  }), /HTTP 503/);
  assert.equal(completed, 4);
  assert.equal(metrics.length, 4);
  assert.equal(metrics.filter((metric) => metric.error).length, 2);
  assert.deepEqual(metrics.filter((metric) => metric.operation === 'chart-1h').map((metric) => metric.attempt), [1, 2]);
  assert.ok(metrics.filter((metric) => metric.operation === 'chart-1h').every((metric) => metric.status === 503));
});

test('Yahoo FX honors a short Retry-After once, while leaving permanent failures unretried', async () => {
  const metrics = [], waits = [];
  let calls = 0, gateNow = Date.parse('2026-09-24T12:00:00Z');
  const result = await fetchYahooFxObservation('EUR_USD', {
    now: Date.parse('2026-09-24T12:00:00Z'), metrics, permissionConfirmed: true, retrySleep: async (ms) => waits.push(ms),
    requestGate: createForexRequestGate({ now: () => gateNow, sleep: async (ms) => { waits.push(ms); gateNow += ms; } }),
    fetcher: async (url) => {
      calls++;
      if (url.includes('interval=15m') && calls === 1) return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }) };
      return { ok: true, status: 200, json: async () => payload([1_790_000_000], [1.1]) };
    },
  });
  assert.equal(result.source, 'Yahoo Chart (public delayed/unofficial)');
  assert.ok(waits.length >= 1);
  assert.ok(waits.every((value) => value === 1_000));
  assert.equal(calls, 4);
  assert.deepEqual(metrics.filter((row) => row.operation === 'chart-15m').map((row) => row.status), [429, 200]);
  assert.equal(metrics.find((row) => row.operation === 'chart-15m' && row.status === 429).retryDelayMs, 1_000);
});
