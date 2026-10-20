import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countStaleRejections,
  createProviderMetrics,
  recordProviderRequest,
  summarizeProviderMetrics,
  summarizeScanDiagnostics
} from '../src/scanDiagnostics.js';
import { analyzeMomentum, summarizeStockUniverseCoverage } from '../src/stocksData.js';

test('local quota deferrals are not counted as provider requests, failures or latency', () => {
  const metrics = createProviderMetrics();
  recordProviderRequest(metrics, 'Alpaca', { status: 0, latencyMs: 500, requestAttempted: false, error: 'ALPACA_PACING_DEFERRED' });
  recordProviderRequest(metrics, 'Alpaca', { status: 200, latencyMs: 30 });
  const [provider] = summarizeProviderMetrics(metrics);
  assert.equal(provider.requests, 1); assert.equal(provider.failures, 0);
  assert.equal(provider.budgetDeferrals, 1); assert.equal(provider.averageLatencyMs, 30);
  assert.equal(summarizeScanDiagnostics([{ providers: [provider] }]).providers[0].budgetDeferrals, 1);
});

test('stock scan universe accounting separates context, missing symbols, and unrequested returns', () => {
  const coverage = summarizeStockUniverseCoverage({
    requestedSymbols: ['SPY', 'NVDA', 'BND', 'MISSING', 'spy'],
    assets: [{ symbol: 'SPY' }, { symbol: 'NVDA' }, { symbol: 'BND' }, { symbol: 'EXTRA' }, { symbol: 'nvda' }]
  });
  assert.deepEqual(coverage, {
    requestedTotal: 4, requestedMarketContext: 1, requestedNonContext: 3,
    scannedTotal: 4, scannedMarketContext: 1, scannedNonContext: 3,
    missingMarketContext: 0, missingNonContext: 1, unexpectedReturned: 1
  });
  assert.equal(summarizeStockUniverseCoverage({ assets: [] }).requestedTotal, null);
  assert.equal(summarizeStockUniverseCoverage({ requestedSymbols: [] }).scannedTotal, null);
});

test('provider telemetry counts actual attempts and only reports quota when headers exist', () => {
  const metrics = createProviderMetrics();
  recordProviderRequest(metrics, 'Alpaca', { latencyMs: 80, cooldownDelayMs: 250, status: 200, headers: new Headers({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '75' }) });
  recordProviderRequest(metrics, 'Yahoo Chart', { latencyMs: 120, status: 200, headers: new Headers() });
  recordProviderRequest(metrics, 'Yahoo Chart', { latencyMs: 600, status: 429, retry: 1, error: 'rate limited' });
  const result = summarizeProviderMetrics(metrics);
  assert.deepEqual(result.map((row) => row.provider), ['Alpaca', 'Yahoo Chart']);
  assert.equal(result[0].rateLimitUtilization, 0.25);
  assert.equal(result[0].cooldownWaitSamples, 1);
  assert.equal(result[0].averageCooldownWaitMs, 250);
  assert.equal(result[0].p95CooldownWaitMs, 250);
  assert.equal(result[0].requests, 1);
  assert.equal(result[1].rateLimitStatus, 'unknown; no quota headers received');
  assert.equal(result[1].rateLimits, 1);
  assert.equal(result[1].retries, 1);
  assert.equal(result[1].averageLatencyMs, 360);
  assert.equal(result[1].latencySamples, 2);
});

test('provider latency remains unknown when a request has no measured duration', () => {
  const metrics = createProviderMetrics();
  recordProviderRequest(metrics, 'Alpaca', { status: 200 });
  const [provider] = summarizeProviderMetrics(metrics);
  assert.equal(provider.requests, 1);
  assert.equal(provider.latencySamples, 0);
  assert.equal(provider.averageLatencyMs, null);
  assert.equal(provider.p95LatencyMs, null);

  const history = summarizeScanDiagnostics([{ durationMs: 5, providers: [provider] }]);
  assert.equal(history.providers[0].requests, 1);
  assert.equal(history.providers[0].latencySamples, 0);
  assert.equal(history.providers[0].averageLatencyMs, null);
  assert.equal(history.providers[0].cooldownWaitSamples, 0);
  assert.equal(history.providers[0].averageCooldownWaitMs, null);
});

test('historical provider summaries retain legacy request-count weighting', () => {
  const history = summarizeScanDiagnostics([
    { providers: [{ provider: 'Alpaca', requests: 2, averageLatencyMs: 10 }] },
    { providers: [{ provider: 'Alpaca', requests: 1, averageLatencyMs: 40 }] }
  ]);
  assert.equal(history.providers[0].latencySamples, 3);
  assert.equal(history.providers[0].averageLatencyMs, 20);
});

test('diagnostic history aggregates funnel gate reasons and average scan time', () => {
  const result = summarizeScanDiagnostics([
    { durationMs: 1000, topRejectionReasons: { stale_data: 2, price_floor: 3 }, providers: [] },
    { durationMs: 3000, topRejectionReasons: { stale_data: 4, model_no_edge: 1 }, providers: [] }
  ]);
  assert.equal(result.scansIncluded, 2);
  assert.equal(result.averageScanDurationMs, 2000);
  assert.deepEqual(result.topRejectionReasons, [
    { reason: 'stale_data', count: 6 }, { reason: 'price_floor', count: 3 }, { reason: 'model_no_edge', count: 1 }
  ]);
});

test('stale rejections are attributed across deep, broad-discovery, and premarket gates', () => {
  assert.deepEqual(countStaleRejections({
    technical: [{ reasonCodes: ['stale_data'] }, { reasonCodes: ['stale_live_quote'] }, { reasonCodes: ['spread_too_wide'] }],
    wideDiscovery: { rejectionCounts: { latest_trade_stale_or_future: 4 } },
    premarket: { rejectionCounts: { stale_or_old_observation: 2 } }
  }), { technical: 2, wideDiscovery: 4, premarket: 2, totalGateRejections: 8, countsMayOverlap: true });
});

test('existing screen reports symbols removed by cheap price and volume filters', () => {
  const row = (symbol, price, averageDailyVolume) => ({
    symbol, price, averageDailyVolume, freshness: 'live/delayed', changeDay: 0, change1h: 0,
    ema9: price, ema21: price, vwap: price, rsi14: 50, dataQuality: 80, model: { score: 60 }
  });
  const result = analyzeMomentum({ assets: [row('CHEAP', 1, 2_000_000), row('THIN', 10, 10_000), row('SPY', 500, 1_000_000)] }, {
    minPrice: 2, minAverageVolume: 500_000, minScore: 68, maxSignals: 5
  });
  assert.equal(result.diagnostics.universeRequested, 3);
  assert.equal(result.diagnostics.marketContext, 1);
  assert.equal(result.diagnostics.instruments, 2);
  assert.equal(result.diagnostics.priceRejected, 1);
  assert.equal(result.diagnostics.averageVolumeRejected, 1);
  assert.equal(result.diagnostics.liquid, 0);
  assert.equal(result.diagnostics.rejectedByReason.price_floor, 1);
  assert.equal(result.diagnostics.rejectedByReason.average_share_volume_floor, 1);
});
