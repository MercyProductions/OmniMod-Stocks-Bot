import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOptionsScan } from '../src/diagnostics.js';

test('Options Alpaca budget deferrals do not inflate requests, failures or provider latency', () => {
  const result = summarizeOptionsScan({ providerMetrics: [
    { provider: 'Alpaca', status: 0, requestAttempted: false, latencyMs: 900, error: 'ALPACA_PACING_DEFERRED' },
    { provider: 'Alpaca', status: 200, latencyMs: 25 },
  ] });
  assert.equal(result.provider.requests, 1); assert.equal(result.provider.failures, 0);
  assert.equal(result.provider.budgetDeferrals, 1);
  assert.equal(result.provider.latencyByOperation.Alpaca.budgetDeferrals, 1);
  assert.equal(result.provider.latencyByOperation.Alpaca.averageLatencyMs, 25);
});

test('contract quality counts stay distinct from underlying funnel and missing coverage remains unknown', () => {
  assert.equal(summarizeOptionsScan().marketData.contractQuality.contractsReturned, null);
  const result = summarizeOptionsScan({ signalRows: [
    { chain: { identityDiagnostics: { contractsReturned: 10, verifiedIdentities: 6, identityRejected: 4, validQuotes: 5,
      rejectionReasons: { duplicate_contract_identity: 2, underlying_identity_mismatch: 3 } } } },
    { chain: { identityDiagnostics: { contractsReturned: 0, verifiedIdentities: 0, identityRejected: 0, validQuotes: 0, rejectionReasons: {} } } },
    { marketDataStatus: 'provider-error' },
  ] });
  assert.equal(result.marketData.contractQuality.chainsMeasured, 2);
  assert.equal(result.marketData.contractQuality.contractsReturned, 10);
  assert.equal(result.marketData.contractQuality.identityRejected, 4);
  assert.equal(result.marketData.contractQuality.validQuotes, 5);
  assert.equal(result.funnel.primarySignals, 3);
  assert.deepEqual(result.marketData.contractQuality.rejectionReasons, { duplicate_contract_identity: 2, underlying_identity_mismatch: 3 });
});

test('preserves measured Options stage timings and zero while unknown remains null', () => {
  assert.deepEqual(summarizeOptionsScan({ stageDurationsMs: { provider: 3.5, shadow: 0, missing: null } }).performance.stageDurationsMs,
    { provider: 3.5, shadow: 0, missing: null });
});

test('unmeasured Options request and queue timing stay unknown while measured zero survives', () => {
  const result = summarizeOptionsScan({ providerMetrics: [
    { operation: 'option-chains', status: 200, latencyMs: null, localQueueDelayMs: null },
    { operation: 'option-chains', status: 200, latencyMs: 0, localQueueDelayMs: 0,
      rateLimit: { allowed: 120, used: 10, available: null, expiresAt: null } },
  ] });
  const operation = result.provider.latencyByOperation['option-chains'];
  assert.equal(operation.averageLatencyMs, 0);
  assert.equal(operation.averageLocalQueueDelayMs, 0);
  assert.equal(result.provider.rateLimit.available, null);
  assert.equal(result.provider.rateLimit.expiresAt, null);
  const missing = summarizeOptionsScan({ providerMetrics: [{ operation: 'option-chains', status: 200, latencyMs: null }] });
  assert.equal(missing.provider.latencyByOperation['option-chains'].averageLatencyMs, null);
  assert.equal(missing.provider.latencyByOperation['option-chains'].averageLocalQueueDelayMs, null);
});

test('retains primary-signal source mapping and conflict counts in scan diagnostics', () => {
  const signalMapping = { status: 'complete', sourceCounts: { stocks: 2, 'etfs-etps': 1 }, mappedUnderlyings: 1,
    directionConflicts: 1, conflicts: [{ symbol: 'SPY', directions: ['long', 'short'], owners: ['stocks', 'etfs-etps'] }] };
  assert.deepEqual(summarizeOptionsScan({ signalMappingDiagnostics: signalMapping }).signalMapping, signalMapping);
});

test('summarizes option provider, strategy, risk, duplicate, and latency stages', () => {
  const result = summarizeOptionsScan({
    signalRows: [
      { signal: { underlyingSymbol: 'AAPL' }, marketDataStatus: 'ready' },
      { signal: { underlyingSymbol: 'MSFT' }, marketDataStatus: 'ready' },
      { signal: { underlyingSymbol: 'NVDA' }, marketDataStatus: 'ready' },
    ], source: 'tradier', signalSource: 'shared', elapsedMs: 123,
    results: [
      { status: 'reserved', providerStatus: 'ready', candidate: {} },
      { status: 'risk-blocked', providerStatus: 'ready', candidate: {}, decision: { reasons: ['daily_loss_limit'] } },
      { status: 'no-setup', providerStatus: 'ready', reasons: ['thin_option_chain', 'thin_option_chain'], decision: { reasons: ['thin_option_chain'] } },
      { status: 'provider-error', providerStatus: 'provider-error', reasons: ['provider_error'] },
    ],
    providerMetrics: [
      { operation: 'market-clock', status: 200, latencyMs: 8 },
      { operation: 'market-clock', status: 503, latencyMs: 12, error: 'HTTP 503' },
      { operation: 'option-chains', status: 200, latencyMs: 30,
        rateLimit: { allowed: 120, used: 30, available: 90, expiresAt: 1790700000000 } },
    ],
  });
  assert.deepEqual(result.funnel, {
    sourceInputRecords: null, sourceRejectedRecords: null, directionConflictUnderlyings: null, providerCapUnderlyings: null,
    primarySignals: 3, providerReady: 3, providerRejected: 1, strategyCandidates: 2,
    strategyRejected: 1, riskRejected: 1, reservationRejected: 0, paperReservations: 1, duplicatesOrExposureConflicts: 0,
  });
  assert.equal(result.marketData.inputSignals, 3);
  assert.equal(result.marketData.distinctUnderlyings, 3);
  assert.deepEqual(result.marketData.statusCounts, { ready: 3 });
  assert.equal(result.provider.failures, 1);
  assert.equal(result.provider.latencyByOperation['market-clock'].averageLatencyMs, 10);
  assert.equal(result.provider.latencyByOperation['market-clock'].p95LatencyMs, 12);
  assert.equal(result.topRejectionReasons.thin_option_chain, 1, 'duplicate labels on one candidate count as one rejected candidate');
  assert.equal(result.elapsedMs, 123);
  assert.equal(result.provider.rateLimitUtilization, 25);
  assert.deepEqual(result.provider.rateLimit, { allowed: 120, used: 30, available: 90, expiresAt: 1790700000000, utilizationPct: 25 });
  assert.equal(result.provider.latencyByOperation['option-chains'].rateLimit.used, 30);
});

test('Options funnel retains source, conflict, and provider-cap losses before chain analysis', () => {
  const result = summarizeOptionsScan({ source: 'tradier', signalSource: 'shared',
    signalMappingDiagnostics: { status: 'complete', inputRecords: 17, rejectedRecordCount: 2,
      rejectionCounts: { stale_source_signal: 2 }, directionConflicts: 1,
      conflicts: [{ symbol: 'SPY', directions: ['long', 'short'] }] },
    signalRows: [{ signal: { underlyingSymbol: 'AAPL' }, marketDataStatus: 'ready', marketDataDiagnostics: {
      inputSignals: 14, validSignals: 14, distinctUnderlyings: 14, retainedUnderlyings: 12,
      cappedUnderlyings: 2, cappedUnderlyingSymbols: ['MSFT', 'NVDA'],
      cappedRejectionReason: 'provider_request_symbol_cap' } }],
    results: [{ symbol: 'AAPL', providerStatus: 'ready', status: 'no-setup', reasons: ['thin_option_chain'] }],
  });
  assert.equal(result.funnel.sourceInputRecords, 17);
  assert.equal(result.funnel.sourceRejectedRecords, 2);
  assert.equal(result.funnel.directionConflictUnderlyings, 1);
  assert.equal(result.funnel.providerCapUnderlyings, 2);
  assert.equal(result.topRejectionReasons['source_record:stale_source_signal'], 2);
  assert.equal(result.topRejectionReasons.primary_direction_conflict, 1);
  assert.equal(result.topRejectionReasons.provider_request_symbol_cap, 2);
  assert.equal(result.topRejectionReasons.thin_option_chain, 1);
  assert.deepEqual(result.marketData.cappedUnderlyingSymbols, ['MSFT', 'NVDA']);
  assert.match(result.topRejectionReasonBasis, /stage-specific/);
});

test('manual input mode makes provider readiness unknown rather than fabricated', () => {
  const result = summarizeOptionsScan({ signalRows: [{ signal: { underlyingSymbol: 'AAPL' } }, { signal: { underlyingSymbol: 'aapl' } }], results: [], source: 'manual' });
  assert.equal(result.funnel.providerReady, null);
  assert.equal(result.marketData.inputSignals, 2);
  assert.equal(result.marketData.distinctUnderlyings, 1);
  assert.deepEqual(result.marketData.statusCounts, { manual_input: 2 });
  assert.equal(result.provider.requests, 0);
  assert.equal(result.provider.rateLimitUtilization, null);
  assert.equal(result.provider.rateLimit, null);
});

test('reports measured request-queue delay separately from provider latency', () => {
  const result = summarizeOptionsScan({ providerMetrics: [
    { operation: 'option-chains', status: 200, latencyMs: 40, localQueueDelayMs: 550, cooldownDelayMs: 0 },
    { operation: 'option-chains', status: 200, latencyMs: 60, localQueueDelayMs: 1_100, cooldownDelayMs: 1_000 },
  ] });
  assert.equal(result.provider.latencyByOperation['option-chains'].averageLatencyMs, 50);
  assert.equal(result.provider.latencyByOperation['option-chains'].averageLocalQueueDelayMs, 825);
  assert.equal(result.provider.latencyByOperation['option-chains'].p95LocalQueueDelayMs, 1_100);
  assert.equal(result.provider.latencyByOperation['option-chains'].cooldownWaitSamples, 2);
  assert.equal(result.provider.latencyByOperation['option-chains'].averageCooldownWaitMs, 500);
  assert.equal(result.provider.latencyByOperation['option-chains'].p95CooldownWaitMs, 1_000);
});

test('reports call-assignment review coverage separately from general catalyst status', () => {
  const result = summarizeOptionsScan({ source: 'tradier', signalRows: [
    { signal: { underlyingSymbol: 'AAPL', optionAssignmentReview: { status: 'clear' } } },
    { signal: { underlyingSymbol: 'MSFT', optionAssignmentReview: { status: 'blocked' } } },
    { signal: { underlyingSymbol: 'NVDA' } },
  ], results: [] });
  assert.deepEqual(result.marketData.callAssignmentReviewStatuses, { clear: 1, blocked: 1, missing: 1 });
});

test('reports each Tradier pre-strategy gate by status without treating it as a strategy rejection', () => {
  const result = summarizeOptionsScan({ source: 'tradier', signalRows: [
    { signal: { underlyingSymbol: 'AAPL' }, marketDataStatus: 'ready', marketDataDiagnostics: {
      inputSignals: 15, validSignals: 15, distinctUnderlyings: 14, duplicateSignals: 1,
      maxSymbols: 12, retainedUnderlyings: 12, cappedUnderlyings: 2, cappedUnderlyingSymbols: ['T12', 'T13'],
      cappedRejectionReason: 'provider_request_symbol_cap',
    } },
    { signal: { underlyingSymbol: 'MSFT' }, marketDataStatus: 'catalyst_review_required' },
    { signal: { underlyingSymbol: 'NVDA' }, marketDataStatus: 'stale_or_invalid_quote' },
    { signal: { underlyingSymbol: 'TSLA' }, marketDataStatus: 'chain_unavailable' },
  ], results: [
    { symbol: 'AAPL', status: 'no-setup', providerStatus: 'ready', reasons: ['thin_option_chain'] },
    { symbol: 'MSFT', status: 'catalyst_review_required', providerStatus: 'catalyst_review_required', reasons: ['catalyst_review_required'] },
    { symbol: 'NVDA', status: 'stale_or_invalid_quote', providerStatus: 'stale_or_invalid_quote', reasons: ['stale_or_invalid_quote'] },
    { symbol: 'TSLA', status: 'chain_unavailable', providerStatus: 'chain_unavailable', reasons: ['chain_unavailable'] },
  ] });
  assert.deepEqual(result.marketData.statusCounts, {
    ready: 1, catalyst_review_required: 1, stale_or_invalid_quote: 1, chain_unavailable: 1,
  });
  assert.equal(result.marketData.inputSignals, 15);
  assert.equal(result.marketData.distinctUnderlyings, 14);
  assert.equal(result.marketData.cappedUnderlyings, 2);
  assert.deepEqual(result.marketData.cappedUnderlyingSymbols, ['T12', 'T13']);
  assert.equal(result.marketData.cappedRejectionReason, 'provider_request_symbol_cap');
  assert.equal(result.funnel.providerReady, 1);
  assert.equal(result.funnel.strategyRejected, 1);
  assert.equal(result.topRejectionReasons.chain_unavailable, 1);
});

test('nullable upstream counts fall back to observed inputs and absent timing stays unknown', () => {
  const result = summarizeOptionsScan({ signalRows: [
    { signal: { underlyingSymbol: 'AAPL' }, marketDataDiagnostics: {
      inputSignals: null, validSignals: null, distinctUnderlyings: null, duplicateSignals: null,
      retainedUnderlyings: null, maxSymbols: null, cappedUnderlyings: null,
    } },
    { signal: { underlyingSymbol: 'aapl' } },
  ] });
  assert.equal(result.marketData.inputSignals, 2);
  assert.equal(result.marketData.validSignals, 2);
  assert.equal(result.marketData.distinctUnderlyings, 1);
  assert.equal(result.marketData.duplicateSignals, null);
  assert.equal(result.marketData.retainedUnderlyings, 2);
  assert.equal(result.marketData.maxSymbols, null);
  assert.equal(result.marketData.cappedUnderlyings, null);
  assert.equal(result.elapsedMs, null);
});
