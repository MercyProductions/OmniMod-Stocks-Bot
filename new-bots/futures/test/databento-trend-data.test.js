import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDatabentoFuturesH1Trend, normalizeDatabentoH1TrendBars } from '../src/databentoTrendData.js';

const now = Date.parse('2026-09-29T16:00:00Z');
const row = { contract: { symbol: 'ES', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', exposureKey: 'SPY',
  expiry: '2026-12-18T14:30:00.000Z', activeContract: true, contractSpecVerified: true,
  specSource: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', specVerifiedAt: new Date(now - 60_000).toISOString(),
  multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5, initialMarginUsd: 1000, maintenanceMarginUsd: 900 } };
const bars = (raw = 'ESZ6') => Array.from({ length: 52 }, (_, i) => ({ raw_symbol: raw,
  rtype: 34, publisher_id: 1, instrument_id: 123,
  ts_event: new Date(now - (53 - i) * 3_600_000).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 100 }));
const response = (body, ok = true, status = 200) => ({ ok, status, text: async () => body });

test('H1 normalization retains only completed bars and requires fresh 50-bar verified contract history', () => {
  const result = normalizeDatabentoH1TrendBars([row], [...bars(), { ...bars()[0], ts_event: new Date(now).toISOString() }], { now });
  assert.equal(result[0].trendDataStatus, 'complete');
  assert.equal(result[0].trendBars.length, 52);
  const stale = normalizeDatabentoH1TrendBars([row], bars().map((bar) => ({ ...bar, ts_event: new Date(now - 4 * 3_600_000).toISOString() })), { now });
  assert.equal(stale[0].trendDataStatus, 'incomplete');
  assert.ok(stale[0].trendDataReasons.includes('h1_history_stale_or_missing'));
  const unverified = normalizeDatabentoH1TrendBars([{ contract: { ...row.contract, contractSpecVerified: false } }], bars(), { now });
  assert.equal(unverified[0].trendDataStatus, 'incomplete');
  assert.deepEqual(unverified[0].trendBars, []);
});

test('missing credentials fail closed without calling the provider', async () => {
  let calls = 0;
  const result = await fetchDatabentoFuturesH1Trend([row], { now, fetcher: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.rows[0].trendDataStatus, 'credentials_missing');
});

test('cost estimate over cap prevents H1 download', async () => {
  const urls = [];
  await assert.rejects(fetchDatabentoFuturesH1Trend([row], { apiKey: 'test', now, maxScanCostUsd: 0.01,
    fetcher: async (url) => { urls.push(String(url)); return response('0.02'); } }), /exceeds remaining scan cap/);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /schema=ohlcv-1h/);
  assert.match(urls[0], /stype_in=raw_symbol/);
  assert.match(urls[0], /symbols=ESZ6/);
});

test('H1 free cost metadata retries transient transport failure before one paid stream', async () => {
  const calls = [];
  const metrics = [];
  const delays = [];
  const result = await fetchDatabentoFuturesH1Trend([row], { apiKey: 'test', now, maxScanCostUsd: 1, metrics,
    sleep: async (ms) => delays.push(ms), fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('metadata.get_cost')) {
        if (calls.filter((call) => call.url.includes('metadata.get_cost')).length === 1) throw new TypeError('temporary disconnect');
        return response('0.004');
      }
      return response(bars().map((bar) => JSON.stringify({ ...bar,
        pretty_ts_event: bar.ts_event, pretty_open: bar.open, pretty_high: bar.high, pretty_low: bar.low, pretty_close: bar.close })).join('\n'));
    } });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(metrics.filter((metric) => metric.operation === 'h1-cost-estimate').map((metric) => metric.status), [0, 200]);
  assert.equal(metrics.find((metric) => metric.operation === 'h1-cost-estimate' && metric.status === 200).retry, true);
  assert.equal(calls.filter((call) => call.url.endsWith('/timeseries.get_range')).length, 1);
  assert.equal(result.rows[0].trendDataStatus, 'complete');
});

test('expired or internally inconsistent contract metadata is rejected before cost estimation', async () => {
  let calls = 0;
  const stale = { ...row, contract: { ...row.contract, specVerifiedAt: new Date(now - 100 * 86_400_000).toISOString() } };
  const result = await fetchDatabentoFuturesH1Trend([stale], { apiKey: 'test', now, maxScanCostUsd: 1,
    fetcher: async () => { calls++; return response('0'); } });
  assert.equal(calls, 0);
  assert.equal(result.diagnostics.status, 'contract_metadata_unavailable');
  assert.equal(result.diagnostics.eligible, 0);
  assert.equal(result.diagnostics.metadataRejected, 1);
  assert.equal(result.diagnostics.preflightRejectionReasons.contract_spec_stale, 1);
  assert.deepEqual(result.rows[0].trendDataReasons, ['verified_active_contract_metadata_invalid']);
});

test('fetch requests exact raw symbols and returns normalized H1 bars after estimate passes', async () => {
  const calls = [];
  const stale = { ...row, contract: { ...row.contract, specVerifiedAt: new Date(now - 100 * 86_400_000).toISOString() } };
  const result = await fetchDatabentoFuturesH1Trend([row, stale], { apiKey: 'test', now, maxScanCostUsd: 1,
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? response('0.004') : response(bars().map((bar) => JSON.stringify({ ...bar,
        pretty_ts_event: bar.ts_event, pretty_open: bar.open, pretty_high: bar.high, pretty_low: bar.low, pretty_close: bar.close })).join('\n'));
    } });
  assert.equal(calls.length, 2);
  assert.equal(result.diagnostics.status, 'partial');
  assert.equal(result.diagnostics.requested, 2);
  assert.equal(result.diagnostics.eligible, 1);
  assert.equal(result.diagnostics.metadataRejected, 1);
  assert.equal(result.rows[0].trendBars.length, 52);
  assert.equal(result.rows[1].trendDataStatus, 'incomplete');
  assert.ok(result.rows[1].trendDataReasons.includes('verified_active_contract_metadata_invalid'));
  assert.equal(calls[1].init.body.get('schema'), 'ohlcv-1h');
  assert.equal(calls[1].init.body.get('stype_in'), 'raw_symbol');
  assert.equal(calls[1].init.body.get('map_symbols'), 'true');
  assert.equal(calls[1].init.body.get('pretty_px'), 'true');
  assert.equal(calls[1].init.body.get('pretty_ts'), 'true');
  assert.equal(calls[1].init.body.get('compression'), 'none');
  assert.equal(calls[1].init.method, 'POST');
});

test('H1 preserves one explicit bounded 429 retry and reserves its cost estimate once', async () => {
  const metrics = [], delays = [];
  let barsCalls = 0;
  const result = await fetchDatabentoFuturesH1Trend([row], { apiKey: 'test', now, maxScanCostUsd: 1, metrics,
    sleep: async (ms) => delays.push(ms), fetcher: async (url) => {
      if (String(url).includes('metadata.get_cost')) return response('0.004');
      barsCalls++;
      if (barsCalls === 1) return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }), text: async () => 'rate limited' };
      return response(bars().map((bar) => JSON.stringify({ ...bar, pretty_ts_event: bar.ts_event,
        pretty_open: bar.open, pretty_high: bar.high, pretty_low: bar.low, pretty_close: bar.close })).join('\n'));
    } });
  assert.equal(barsCalls, 2);
  assert.deepEqual(delays, [2000]);
  assert.deepEqual(metrics.filter((metric) => metric.operation === 'h1-bars').map((metric) => metric.status), [429, 200]);
  assert.equal(result.rows[0].trendDataStatus, 'complete');
  assert.equal(metrics.filter((metric) => metric.operation === 'estimated-h1-cost').length, 1);
  assert.equal(metrics.find((metric) => metric.operation === 'estimated-h1-cost').budgetReserved, true);
});

test('malformed H1 response is rejected', async () => {
  let calls = 0;
  await assert.rejects(fetchDatabentoFuturesH1Trend([row], { apiKey: 'test', now, maxScanCostUsd: 1,
    fetcher: async () => (++calls === 1 ? response('0') : response('{broken')) }), /malformed H1 bar/);
});
