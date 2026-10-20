import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchYahooObservation, fetchYahooUniverse, summarizeDailyBars } from '../src/yahooChart.js';

test('Yahoo Chart adapter refuses requests until permission is explicitly attested', async () => {
  let requested = false;
  await assert.rejects(fetchYahooObservation({ symbol: 'SPY' }, { fetcher: async () => { requested = true; } }), /permission attestation/);
  assert.equal(requested, false);
});

function chartPayload(times, closes) {
  return { chart: { result: [{ timestamp: times, meta: { exchangeTimezoneName: 'America/New_York' }, indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }], adjclose: [{ adjclose: closes }] } }] } };
}

test('summarizes multi-day returns and annualized daily volatility from closes', () => {
  const bars = Array.from({ length: 22 }, (_, i) => ({ close: 100 + i }));
  const result = summarizeDailyBars(bars);
  assert.equal(result.return1dPct, 0.8333);
  assert.ok(result.return5dPct > 0);
  assert.ok(result.volatility20dPct > 0);
});

test('Yahoo observation normalizes current and adjusted daily bars with provider time', async () => {
  const now = Date.parse('2026-09-24T15:00:00Z');
  const dailyTimes = Array.from({ length: 25 }, (_, i) => Math.floor((now - (24 - i) * 86400000) / 1000));
  const intradayTimes = [now - 600000, now - 300000].map((n) => Math.floor(n / 1000));
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => url.includes('interval=1d') ? chartPayload(dailyTimes, dailyTimes.map((_, i) => 100 + i)) : chartPayload(intradayTimes, [120, 121]) });
  const metrics = [];
  const row = await fetchYahooObservation({ symbol: 'SPY', assetClass: 'equity' }, { fetcher, now, metrics, clock: () => 10, permissionConfirmed: true });
  assert.equal(row.price, 121);
  assert.equal(row.providerSymbol, 'SPY');
  assert.equal(row.providerAgeMinutes, 5);
  assert.equal(row.providerTimeZone, 'America/New_York');
  assert.equal(row.source, 'Yahoo Chart (public delayed/unofficial)');
  assert.ok(Number.isFinite(row.volatility20dPct));
  assert.deepEqual(metrics.map((metric) => metric.operation).sort(), ['chart-1d', 'chart-5m']);
  assert.ok(metrics.every((metric) => metric.status === 200 && metric.latencyMs === 0));
});

test('Yahoo observation preserves leveraged and wrapper-specific risk context', async () => {
  const now = Date.parse('2026-09-24T15:00:00Z');
  const dailyTimes = Array.from({ length: 25 }, (_, i) => Math.floor((now - (24 - i) * 86400000) / 1000));
  const intradayTimes = [now - 600000, now - 300000].map((n) => Math.floor(n / 1000));
  const fetcher = async (url) => ({ ok: true, json: async () => url.includes('interval=1d') ? chartPayload(dailyTimes, dailyTimes.map((_, i) => 100 + i)) : chartPayload(intradayTimes, [120, 121]) });
  const row = await fetchYahooObservation({ symbol: 'TQQQ', assetClass: 'leveraged-equity-index-etf', leverageReset: 'daily', instrumentNote: 'Daily reset can compound path-dependent returns.' }, { fetcher, now, permissionConfirmed: true });
  assert.equal(row.leverageReset, 'daily');
  assert.match(row.instrumentNote, /path-dependent/);
});

test('universe scan preserves symbols and exposes per-symbol provider errors', async () => {
  const metrics = [];
  const results = await fetchYahooUniverse([{ symbol: 'BAD' }], { metrics, fetcher: async () => ({ ok: false, status: 403 }), permissionConfirmed: true });
  assert.equal(results[0].symbol, 'BAD');
  assert.match(results[0].providerError, /403/);
  assert.equal(results[0].observedAt, null);
  assert.equal(metrics.length, 2);
  assert.ok(metrics.every((metric) => metric.status === 403 && metric.operation.startsWith('chart-')));
});
