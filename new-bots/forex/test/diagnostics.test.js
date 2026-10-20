import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForexObservationLines, summarizeForexScan } from '../src/diagnostics.js';

test('reports Forex funnel, rejection reasons, provider failures, and latency by operation', () => {
  const result = summarizeForexScan({
    instruments: ['EUR_USD', 'GBP_USD', 'USD_JPY'],
    observations: [
      { instrument: 'EUR_USD', bias: 'UPWARD WATCH', quoteMid: 1.1, quoteTime: '2026-09-29T10:00:00Z', bid: 1.0999, ask: 1.1001, quoteAgeSeconds: 1, dayStrategy: { status: 'candidate' } },
      { instrument: 'GBP_USD', bias: 'PROVIDER ERROR', providerError: 'HTTP 429', reason: 'provider_request_failed' },
      { instrument: 'USD_JPY', bias: 'STALE QUOTE', quoteMid: 150, quoteTime: '2026-09-29T09:00:00Z', quoteAgeSeconds: 500 },
    ],
    paperResults: [
      { instrument: 'EUR_USD', strategy: { status: 'risk-blocked', decision: { reasons: ['spread_exceeds_limit'],
        currencyExposureConflicts: [{ currency: 'EUR', direction: 'long', existingInstrument: 'EUR_JPY', existingOwner: 'forex' }] } } },
      { instrument: 'GBP_USD', status: 'provider-error' },
    ],
    providerMetrics: [
      { operation: 'pricing', status: 200, requestStartedAt: 1_000, latencyMs: 20, cooldownDelayMs: 0 },
      { operation: 'candles-M15', instrument: 'GBP_USD', status: 429, requestStartedAt: 1_500, latencyMs: 40, cooldownDelayMs: 1_250, error: 'HTTP 429' },
    ],
    source: 'oanda-practice', maxQuoteAgeSeconds: 120,
  });
  assert.deepEqual(result.universe, { configured: 3, configuredSupported: null, selected: 3, observed: 3, missing: 0, discoveryStatus: 'disabled', accountCurrencyInstruments: null,
    eligibleG10Instruments: null, discoveryEligibleInstruments: null, discoveredQuoteQualified: null, selectedDiscovered: null, capOmissions: null, quoteRejected: null,
    providerInstruments: null, nonG10Instruments: null, cheaplyScreened: null, quoteQualified: null });
  assert.equal(result.provider.failures, 1);
  assert.deepEqual(result.provider.failuresByInstrument, { GBP_USD: { failures: 1, byOperation: { 'candles-M15': 1 } } });
  assert.equal(result.provider.unattributedFailures, 0);
  assert.equal(result.provider.latencyByOperation['candles-M15'].p95LatencyMs, 40);
  assert.equal(result.provider.latencyByOperation['candles-M15'].averageCooldownWaitMs, 1_250);
  assert.equal(result.provider.latencyByOperation['candles-M15'].cooldownWaitSamples, 1);
  assert.equal(result.provider.rateLimitUtilization, 1.67);
  assert.deepEqual(result.provider.rateLimitEstimate, {
    basis: 'observed request starts in this runner scan only; shared-IP traffic is not visible',
    peakRequestsPerSecond: 2, documentedRequestsPerSecondLimit: 120, utilizationPct: 1.67,
  });
  assert.equal(result.funnel.referencePriceAvailable, 2);
  assert.equal(result.funnel.executableBidAskAvailable, 1);
  assert.equal(result.funnel.directionalMultiTimeframeWatch, 1);
  assert.equal(result.funnel.riskRejected, 1);
  assert.equal(result.funnel.paperSetupsReserved, 0);
  assert.equal(result.staleDataRejections, 1);
  assert.equal(result.topRejectionReasons.provider_request_failed, 1);
  assert.equal(result.topRejectionReasons.spread_exceeds_limit, 1);
  assert.deepEqual(result.currencyExposureConflicts, [{ instrument: 'EUR_USD', currency: 'EUR', direction: 'long', existingInstrument: 'EUR_JPY', existingOwner: 'forex' }]);
});

test('attributes a batched quote failure to its requested pairs and leaves unscoped events visible', () => {
  const result = summarizeForexScan({ source: 'oanda-practice', providerMetrics: [
    { operation: 'forward-shadow-position-pricing', status: 503, error: 'unavailable', instruments: ['EUR_USD', 'GBP_USD'] },
    { operation: 'economic-calendar', status: 0, error: 'timeout' },
  ] });
  assert.equal(result.provider.failuresByInstrument.EUR_USD.byOperation['forward-shadow-position-pricing'], 1);
  assert.equal(result.provider.failuresByInstrument.GBP_USD.failures, 1);
  assert.equal(result.provider.unattributedFailures, 1);
});

test('counts each Forex rejection reason once per instrument across observation and approval rows', () => {
  const result = summarizeForexScan({
    instruments: ['EUR_USD'],
    observations: [{ instrument: 'EUR_USD', reason: 'spread_exceeds_limit', dayStrategy: { reasons: ['spread_exceeds_limit', 'weak_breakout'] } }],
    paperResults: [{ instrument: 'EUR_USD', strategy: { decision: { reasons: ['spread_exceeds_limit', 'portfolio_risk_limit'] } } }],
  });
  assert.deepEqual(result.topRejectionReasons, { portfolio_risk_limit: 1, spread_exceeds_limit: 1, weak_breakout: 1 });
});

test('labels Yahoo as observation-only and does not invent provider metrics', () => {
  const result = summarizeForexScan({ instruments: ['EUR_USD'], observations: [], source: 'yahoo-chart' });
  assert.equal(result.dayTradeApprovalAvailable, false);
  assert.equal(result.funnel.quoteMissingOrFailed, 1);
  assert.equal(result.funnel.executableBidAskAvailable, 0);
  assert.equal(result.provider.rateLimitUtilization, null);
  assert.equal(result.provider.rateLimitObserved, null);
  assert.equal(result.provider.rateLimitEstimate, null);
  assert.match(result.limitations[0], /no executable bid\/ask/);
});

test('prefers explicit provider quota headers over the scan-local request-rate estimate', () => {
  const result = summarizeForexScan({ source: 'oanda-practice', providerMetrics: [
    { operation: 'pricing', status: 200, requestStartedAt: 1_000, latencyMs: 10, rateLimit: { limit: 100, remaining: 40, used: 60, utilizationPct: 60 } },
  ] });
  assert.equal(result.provider.rateLimitUtilization, 60);
  assert.equal(result.provider.rateLimitObserved.remaining, 40);
  assert.match(result.provider.rateLimitNote, /provider-supplied/);
});

test('does not convert absent quota utilization into zero when only retry metadata is observed', () => {
  const result = summarizeForexScan({ source: 'oanda-practice', providerMetrics: [
    { operation: 'pricing', status: 200, requestStartedAt: 1_000, rateLimit: { limit: null, remaining: null, used: null, utilizationPct: null, retryAfter: '2' } },
  ] });
  assert.equal(result.provider.rateLimitUtilization, 0.83, 'the process-local estimate remains the fallback');
  assert.equal(result.provider.rateLimitObserved.utilizationPct, null, 'retry metadata alone is not quota utilization');
  assert.equal(result.provider.rateLimitObserved.retryAfter, '2');
  assert.match(result.provider.rateLimitNote, /Scan-local estimate/);
});

test('OANDA request-rate estimate excludes missing starts and other providers', () => {
  const result = summarizeForexScan({ source: 'oanda-practice', providerMetrics: [
    { provider: 'OANDA practice', operation: 'pricing', status: 200, requestStartedAt: 1_000 },
    { provider: 'OANDA practice', operation: 'candles-M15', status: 200, requestStartedAt: null },
    { provider: 'Finnhub Economic Calendar', operation: 'economic-calendar', status: 200, requestStartedAt: 1_100,
      rateLimit: { utilizationPct: 90 } },
  ] });
  assert.equal(result.provider.rateLimitEstimate.peakRequestsPerSecond, 1);
  assert.equal(result.provider.rateLimitUtilization, 0.83);
  assert.equal(result.provider.rateLimitObserved, null, 'Finnhub quota is not OANDA quota');
  const noOandaStarts = summarizeForexScan({ source: 'oanda-practice', providerMetrics: [
    { provider: 'OANDA practice', operation: 'pricing', status: 200, requestStartedAt: null },
    { provider: 'Finnhub Economic Calendar', operation: 'economic-calendar', status: 200, requestStartedAt: 1_100 },
  ] });
  assert.equal(noOandaStarts.provider.rateLimitEstimate, null);
  assert.equal(noOandaStarts.provider.rateLimitUtilization, null);
});

test('formats provider-error and no-quote rows without assuming timeframe watches exist', () => {
  const rows = formatForexObservationLines([
    { instrument: 'EUR_USD', bias: 'PROVIDER ERROR', providerError: 'HTTP 403' },
    { instrument: 'GBP_USD', bias: 'NO CURRENT QUOTE' },
  ], 'OANDA practice');
  assert.equal(rows.length, 2);
  assert.match(rows[0], /PROVIDER ERROR/);
  const attributed = formatForexObservationLines([{ instrument: 'EUR_USD', bias: 'PROVIDER ERROR', providerOperation: 'pricing' }], 'OANDA practice');
  assert.match(attributed[0], /pricing failed/);
  assert.match(rows[1], /NO CURRENT QUOTE/);
});

test('leaves unmeasured scan duration unknown', () => {
  assert.equal(summarizeForexScan().scanDurationMs, null);
});

test('Forex provider timing excludes unknown latency but retains measured zero', () => {
  const result = summarizeForexScan({ providerMetrics: [
    { operation: 'pricing', status: 200, latencyMs: null },
    { operation: 'pricing', status: 200, latencyMs: 0 },
  ] });
  assert.equal(result.provider.latencyByOperation.pricing.averageLatencyMs, 0);
  assert.equal(result.provider.latencyByOperation.pricing.p95LatencyMs, 0);
  const missing = summarizeForexScan({ providerMetrics: [{ operation: 'pricing', status: 200, latencyMs: null }] });
  assert.equal(missing.provider.latencyByOperation.pricing.averageLatencyMs, null);
  assert.equal(missing.provider.latencyByOperation.pricing.p95LatencyMs, null);
});

test('preserves measured Forex stage timings and zero while unknown remains null', () => {
  assert.deepEqual(summarizeForexScan({ stageDurationsMs: { marketData: 3.5, shadow: 0, missing: null } }).performance.stageDurationsMs,
    { marketData: 3.5, shadow: 0, missing: null });
});

test('reports dynamic Forex universe coverage and unique discovery-cap rejection counts', () => {
  const result = summarizeForexScan({ source: 'oanda-practice', instruments: ['EUR_USD', 'EUR_GBP'],
    observations: [{ instrument: 'EUR_USD', bias: 'UPWARD WATCH', quoteMid: 1.1, quoteTime: '2026-09-29T10:00:00Z', bid: 1.0999, ask: 1.1001 }],
    universeDiscovery: { status: 'complete', diagnostics: { accountCurrencyInstruments: 76, eligibleG10Instruments: 42,
      discoveredQuoteQualified: 30, selectedDiscovered: 1, capOmissions: 29, quoteRejected: 12,
      rejected: [{ instrument: 'USD_CHF', reason: 'deep_analysis_cap' }, { instrument: 'USD_CHF', reason: 'deep_analysis_cap' }] } },
  });
  assert.deepEqual(result.universe, { configured: 2, configuredSupported: null, selected: 2, observed: 1, missing: 1, discoveryStatus: 'complete',
    accountCurrencyInstruments: 76, eligibleG10Instruments: 42, discoveryEligibleInstruments: null, discoveredQuoteQualified: 30,
    selectedDiscovered: 1, capOmissions: 29, quoteRejected: 12,
    providerInstruments: null, nonG10Instruments: null, cheaplyScreened: null, quoteQualified: null });
  assert.equal(result.topRejectionReasons.deep_analysis_cap, 1);
  assert.match(result.limitations[1], /all account-listed currency pairs/);
});
