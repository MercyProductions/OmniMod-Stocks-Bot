import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFuturesFunnel } from '../src/diagnostics.js';

test('summarizes context coverage and every day-trade funnel gate with ranked rejection reasons', () => {
  const report = summarizeFuturesFunnel([
    { status: 'contract-rejected', reasons: ['stale_contract_spec'] },
    { status: 'no-setup', reasons: ['stale_quote', 'insufficient_bars'] },
    { symbol: '6E', status: 'risk-blocked', decision: { status: 'rejected', reasons: ['portfolio_risk_limit'],
      currencyExposureConflicts: [{ currency: 'EUR', direction: 'long', existingInstrument: 'EUR_JPY', existingOwner: 'forex' }] } },
    { status: 'reserved', decision: { status: 'paper-approved' } },
    { status: 'duplicate', decision: { status: 'paper-approved' } },
  ], { universe: 20, observed: 18, stale: 3, providerErrors: 1 });
  assert.deepEqual(report.contextUniverse, { universe: 20, observed: 18, skipped: 2, stale: 3, providerErrors: 1 });
  assert.deepEqual(report.dayTrade, {
    inputs: 5, contractValidated: 4, strategyQualified: 3, riskApproved: 2,
    reservationsCreated: 1, duplicateOrConflict: 1, riskRejected: 1, reservationRejected: 0,
    strategyRejected: 1, contractRejected: 1,
    currencyExposureConflicts: [{ symbol: '6E', currency: 'EUR', direction: 'long', existingInstrument: 'EUR_JPY', existingOwner: 'forex' }],
    topRejectionReasons: [
      { reason: 'insufficient_bars', count: 1 }, { reason: 'portfolio_risk_limit', count: 1 },
      { reason: 'stale_contract_spec', count: 1 }, { reason: 'stale_quote', count: 1 },
    ],
  });
});

test('does not count successful reservation outcomes as rejection reasons', () => {
  const report = summarizeFuturesFunnel([{ status: 'reserved', decision: { status: 'paper-approved' } }]);
  assert.equal(report.dayTrade.topRejectionReasons.length, 0);
});

test('counts a Futures rejection reason once per contract row when repeated by later gates', () => {
  const report = summarizeFuturesFunnel([{ symbol: 'ES', status: 'risk-blocked', reasons: ['spread_too_wide'], decision: { reasons: ['spread_too_wide', 'portfolio_risk_limit'] } }]);
  assert.deepEqual(report.dayTrade.topRejectionReasons, [
    { reason: 'portfolio_risk_limit', count: 1 }, { reason: 'spread_too_wide', count: 1 },
  ]);
});

test('top Futures rejection totals count one contract once across duplicate input rows', () => {
  const report = summarizeFuturesFunnel([
    { symbol: 'ES', contractId: 'CME-ES-DEC', status: 'risk-blocked', reasons: ['portfolio_risk_limit'] },
    { symbol: 'ES', contractId: 'CME-ES-DEC', status: 'risk-blocked', decision: { reasons: ['portfolio_risk_limit', 'spread_too_wide'] } },
    { symbol: 'ES', contractId: 'CME-ES-MAR', status: 'risk-blocked', reasons: ['portfolio_risk_limit'] },
    { symbol: 'ES', contractId: '', contract: { providerRawSymbol: 'ESH6' }, status: 'no-setup', reasons: ['fallback_reason'] },
    { symbol: 'ES', contractId: '', contract: { providerRawSymbol: 'ESH6' }, status: 'no-setup', reasons: ['fallback_reason'] },
  ]);
  assert.deepEqual(report.dayTrade.topRejectionReasons, [
    { reason: 'portfolio_risk_limit', count: 2 }, { reason: 'fallback_reason', count: 1 }, { reason: 'spread_too_wide', count: 1 },
  ]);
  assert.equal(report.dayTrade.inputs, 5, 'raw inputs remain visible even when a duplicated contract reason is reconciled');
});

test('reports provider request latency/failures, estimated cost, and total elapsed scan time', () => {
  const report = summarizeFuturesFunnel([], {
    source: 'databento', elapsedMs: 250,
    providerMetrics: [
      { operation: 'cost-ohlcv-1m', status: 200, latencyMs: 10 },
      { operation: 'bars-ohlcv-1d', status: 503, latencyMs: 30, error: 'HTTP 503' },
      { operation: 'estimated-scan-cost', estimatedCostUsd: 0.3, configuredCapUsd: 1 },
    ],
  });
  assert.equal(report.source, 'databento');
  assert.equal(report.provider.requests, 2);
  assert.equal(report.provider.failures, 1);
  assert.equal(report.provider.latencyByOperation['bars-ohlcv-1d'].p95LatencyMs, 30);
  assert.equal(report.elapsedMs, 250);
  assert.equal(report.provider.rateLimitUtilization, null);
  assert.equal(report.provider.estimatedScanCostUsd, 0.3);
  assert.equal(report.provider.estimatedContractDiscoveryCostUsd, null);
  assert.equal(report.provider.estimatedTotalCostUsd, 0.3);
  assert.equal(report.provider.configuredScanCostCapUsd, 1);
  assert.match(report.provider.rateLimitNote, /unknown/);
});

test('records observed Futures processing-stage duration while preserving zero and unknown distinctly', () => {
  const report = summarizeFuturesFunnel([], { stageDurationsMs: { inputLoad: 0, providerFeed: 12.345, unavailable: null, invalid: -1 } });
  assert.deepEqual(report.performance.stageDurationsMs, { inputLoad: 0, providerFeed: 12.35, unavailable: null, invalid: null });
  assert.equal(summarizeFuturesFunnel().performance.stageDurationsMs, null);
});

test('combines contract-discovery and market-data estimates under the scan cost ceiling', () => {
  const report = summarizeFuturesFunnel([], { providerMetrics: [
    { operation: 'contract-definition-cost', status: 200, latencyMs: 10 },
    { operation: 'estimated-contract-discovery-cost', estimatedCostUsd: 0.08, configuredCapUsd: 0.25 },
    { operation: 'estimated-scan-cost', estimatedCostUsd: 0.15, configuredCapUsd: 0.25 },
  ] });
  assert.equal(report.provider.requests, 1);
  assert.equal(report.provider.estimatedContractDiscoveryCostUsd, 0.08);
  assert.equal(report.provider.estimatedScanCostUsd, 0.15);
  assert.equal(report.provider.estimatedTotalCostUsd, 0.23);
  assert.equal(report.provider.configuredScanCostCapUsd, 0.25);
});

test('reports only observed response quota utilization when the provider returns headers', () => {
  const report = summarizeFuturesFunnel([], { providerMetrics: [
    { operation: 'bars-ohlcv-1m', status: 200, latencyMs: 10, rateLimit: { limit: 100, remaining: 20, used: 80, utilizationPct: 80 } },
  ] });
  assert.equal(report.provider.rateLimitUtilization, 80);
  assert.equal(report.provider.rateLimit.remaining, 20);
  assert.match(report.provider.rateLimitNote, /provider-supplied/);
});

test('keeps quota utilization unknown when response headers expose no limit denominator', () => {
  const report = summarizeFuturesFunnel([], { providerMetrics: [
    { operation: 'bars', status: 200, rateLimit: { limit: null, remaining: null, used: null, utilizationPct: null, retryAfter: '2' } },
  ] });
  assert.equal(report.provider.rateLimitUtilization, null);
  assert.equal(report.provider.rateLimit.retryAfter, '2');
});

test('leaves unmeasured scan duration unknown', () => {
  assert.equal(summarizeFuturesFunnel().elapsedMs, null);
});

test('Futures provider latency and cost estimates distinguish missing from zero', () => {
  const report = summarizeFuturesFunnel([], { providerMetrics: [
    { operation: 'bars', status: 200, latencyMs: null },
    { operation: 'estimated-scan-cost', estimatedCostUsd: null, configuredCapUsd: null },
  ] });
  assert.equal(report.provider.latencyByOperation.bars.averageLatencyMs, null);
  assert.equal(report.provider.latencyByOperation.bars.p95LatencyMs, null);
  assert.equal(report.provider.estimatedScanCostUsd, null);
  assert.equal(report.provider.estimatedTotalCostUsd, null);
  assert.equal(report.provider.configuredScanCostCapUsd, null);
  const zero = summarizeFuturesFunnel([], { providerMetrics: [{ operation: 'bars', status: 200, latencyMs: 0 }] });
  assert.equal(zero.provider.latencyByOperation.bars.averageLatencyMs, 0);
});
