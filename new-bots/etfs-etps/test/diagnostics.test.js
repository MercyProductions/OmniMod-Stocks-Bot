import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEtfScan } from '../src/diagnostics.js';

test('ETF diagnostics separate local budget deferrals from HTTP requests and latency', () => {
  const summary = summarizeEtfScan({ providerMetrics: [
    { provider: 'Alpaca', status: 0, latencyMs: 500, requestAttempted: false, error: 'ALPACA_PACING_DEFERRED' },
    { provider: 'Alpaca', status: 200, latencyMs: 30 },
  ] });
  assert.equal(summary.provider.requests, 1); assert.equal(summary.provider.failures, 0);
  assert.equal(summary.provider.budgetDeferrals, 1);
  assert.equal(summary.provider.byEndpoint.Alpaca.budgetDeferrals, 1);
  assert.equal(summary.provider.byEndpoint.Alpaca.averageLatencyMs, 30);
});

test('combines universe and provider stages with strategy and shared-risk results', () => {
  const summary = summarizeEtfScan({
    sessionInput: { source: 'Alpaca sip', diagnostics: {
      universeSize: 10, activeTradable: 8, catalystCleared: 6, scanned: 6, rowsWithUsableData: 4,
      rejectedAssets: { not_in_active_asset_master: 1, asset_not_tradable: 1 },
      rejectedCatalysts: { catalyst_review_missing_stale_or_unclear: 2 },
      rejected: { stale_or_future_quote: 1, invalid_bid_ask: 1 },
    } },
    trades: [{}, {}, {}, {}], elapsedMs: 250,
    results: [
      { status: 'reserved', candidate: {} },
      { status: 'risk-blocked', candidate: {}, reasons: ['daily_loss_limit'], decision: { reasons: ['daily_loss_limit'] } },
      { status: 'no-setup', reasons: ['opening_range_not_broken', 'opening_range_not_broken'] },
    ],
    providerMetrics: [
      { provider: 'Alpaca ETF snapshots', status: 200, latencyMs: 20, cooldownDelayMs: 125 },
      { provider: 'Alpaca ETF snapshots', status: 429, latencyMs: 60, error: 'HTTP 429',
        rateLimit: { limit: 200, remaining: 0, reset: 1790700000, utilizationPct: 100 } },
    ],
  });
  assert.deepEqual(summary.universe, { configured: 10, discovery: null, activeTradable: 8, catalystCleared: 6, providerScanned: 6, withUsableMarketData: 4, strategyInputs: 4 });
  assert.deepEqual(summary.funnel, { strategyCandidates: 2, strategyRejected: 1, riskRejected: 1, reservationRejected: 0, paperReservations: 1, duplicateOrExposureConflicts: 0, unavailableRows: 0 });
  assert.equal(summary.provider.failures, 1);
  assert.equal(summary.provider.byEndpoint['Alpaca ETF snapshots'].p95LatencyMs, 60);
  assert.equal(summary.provider.byEndpoint['Alpaca ETF snapshots'].cooldownWaitSamples, 1);
  assert.equal(summary.provider.byEndpoint['Alpaca ETF snapshots'].averageCooldownWaitMs, 125);
  assert.equal(summary.provider.byEndpoint['Alpaca ETF snapshots'].rateLimitUtilizationPct, 100);
  assert.deepEqual(summary.provider.latestRateLimit, { limit: 200, remaining: 0, reset: 1790700000, utilizationPct: 100 });
  assert.equal(summary.provider.rateLimitUtilizationPct, 100);
  assert.equal(summary.topRejectionReasons.daily_loss_limit, 1);
  assert.equal(summary.topRejectionReasons.opening_range_not_broken, 1);
  assert.equal(summary.topRejectionReasons.stale_or_future_quote, 1);
  assert.equal(summary.elapsedMs, 250);
});

test('preserves provider-stage failure even when no universe results are available', () => {
  const summary = summarizeEtfScan({
    sessionInput: { source: 'Alpaca provider error', diagnostics: { universeSize: 65, providerError: 'HTTP 503', failedProviderOperation: 'Alpaca market clock' } },
    providerMetrics: [{ provider: 'Alpaca market clock', status: 0, error: 'socket closed', latencyMs: 10 }],
  });
  assert.equal(summary.universe.configured, 65);
  assert.equal(summary.provider.failures, 1);
  assert.equal(summary.funnel.strategyCandidates, 0);
  assert.equal(summary.topRejectionReasons.provider_request_failed, 1);
});

test('preserves observed zero counts and keeps unobserved stages unknown', () => {
  const summary = summarizeEtfScan({
    sessionInput: { source: 'Alpaca sip', diagnostics: {
      universeSize: 120, activeTradable: 0, catalystCleared: 0, scanned: 0, rowsWithUsableData: 0,
    } },
    trades: [{ symbol: 'SHOULD_NOT_FALL_BACK' }],
  });
  assert.deepEqual(summary.universe, {
    configured: 120, discovery: null, activeTradable: 0, catalystCleared: 0,
    providerScanned: 0, withUsableMarketData: 0, strategyInputs: 1,
  });

  const failed = summarizeEtfScan({
    sessionInput: { source: 'Alpaca provider error', diagnostics: { universeSize: 120, providerError: 'unavailable' } },
  });
  assert.equal(failed.universe.configured, 120);
  assert.equal(failed.universe.activeTradable, null);
  assert.equal(failed.universe.catalystCleared, null);
  assert.equal(failed.universe.providerScanned, null);
  assert.equal(failed.universe.withUsableMarketData, null);
});

test('leaves unmeasured scan duration unknown', () => {
  assert.equal(summarizeEtfScan().elapsedMs, null);
});

test('ETF provider latency ignores missing samples without dropping measured zero', () => {
  const summary = summarizeEtfScan({ providerMetrics: [
    { provider: 'Alpaca quotes', status: 200, latencyMs: null },
    { provider: 'Alpaca quotes', status: 200, latencyMs: 0 },
  ] });
  assert.equal(summary.provider.byEndpoint['Alpaca quotes'].averageLatencyMs, 0);
  assert.equal(summary.provider.byEndpoint['Alpaca quotes'].p95LatencyMs, 0);
  const missing = summarizeEtfScan({ providerMetrics: [{ provider: 'Alpaca quotes', status: 200, latencyMs: null }] });
  assert.equal(missing.provider.byEndpoint['Alpaca quotes'].averageLatencyMs, null);
  assert.equal(missing.provider.byEndpoint['Alpaca quotes'].p95LatencyMs, null);
});

test('headline Alpaca quota excludes later Finnhub calendar headers', () => {
  const alpaca = { limit: 200, remaining: 100, utilizationPct: 50 };
  const finnhub = { limit: 60, remaining: 1, utilizationPct: 98.33 };
  const summary = summarizeEtfScan({ providerMetrics: [
    { provider: 'Alpaca ETF snapshots', status: 200, rateLimit: alpaca },
    { provider: 'Finnhub Economic Calendar', status: 200, rateLimit: finnhub },
  ] });
  assert.deepEqual(summary.provider.latestRateLimit, alpaca);
  assert.equal(summary.provider.rateLimitUtilizationPct, 50);
  assert.deepEqual(summary.provider.byEndpoint['Finnhub Economic Calendar'].latestRateLimit, finnhub);
  const noAlpaca = summarizeEtfScan({ providerMetrics: [
    { provider: 'Finnhub Economic Calendar', status: 200, rateLimit: finnhub },
  ] });
  assert.equal(noAlpaca.provider.latestRateLimit, null);
  assert.equal(noAlpaca.provider.rateLimitUtilizationPct, null);
});

test('reports only measured ETF scan stages and preserves zero durations', () => {
  const summary = summarizeEtfScan({ stageDurationsMs: {
    universeAndMarketData: 12.5, strategyAndRisk: 0, forwardShadow: null, malformed: 'unknown',
  } });
  assert.deepEqual(summary.performance.stageDurationsMs, {
    universeAndMarketData: 12.5, strategyAndRisk: 0, forwardShadow: null, malformed: null,
  });
});


test('absent native quote diagnostics remain unknown rather than implying measured zero coverage', () => {
  assert.equal(summarizeEtfScan().quoteEvidence, null);
  assert.deepEqual(summarizeEtfScan().rejectedDataRows, []);
});
