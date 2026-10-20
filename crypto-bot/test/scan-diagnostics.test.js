import test from 'node:test';
import assert from 'node:assert/strict';
import { countRiskRejections, countUniqueRejectionReasons, countValidationFailureReasons, createFailedScanDiagnostic, dailyCapacityRejections, summarizeScanDiagnostics, summarizeShadowResearchRecording, summarizeUniverseCoverage } from '../src/scanDiagnostics.js';

test('shadow research diagnostics separate missing candle and entry provenance, existing rows, and write failure', () => {
  const rows = [{ candleProvider: 'Binance', candlePair: 'BTCUSDT', entryQuoteBasis: 'same_source_ask',
    entryQuoteProvider: 'Binance', entryQuotePair: 'BTCUSDT' },
    { candleProvider: 'Coinbase', candlePair: 'ETH-USD' }, { candleProvider: '', candlePair: '' }];
  assert.deepEqual(summarizeShadowResearchRecording(rows, 1), {
    status: 'recorded_or_existing', deepCandidates: 3, sourcePinnedEligible: 1,
    missingCandleProvenance: 1, missingEntryQuoteProvenance: 1,
    newlyRecorded: 1, existingOrDuplicate: 0,
  });
  assert.equal(summarizeShadowResearchRecording(rows, null, { writeFailed: true }).newlyRecorded, null);
  assert.equal(summarizeShadowResearchRecording(rows, null, { writeFailed: true }).status, 'write_failed');
  assert.equal(summarizeShadowResearchRecording(rows, null, { enabled: false }).deepCandidates, null);
});
import { recordProviderRequest, withProviderTelemetry } from '../src/providerTelemetry.js';

test('universe summary keeps full directory counts separate from production price assets', () => {
  const broadDiscovery = { mode: 'discovery_research', directory: { assetCount: 21782 }, prices: { checkedLast24h: 50 } };
  const report = summarizeUniverseCoverage({ source: 'CoinGecko public', assets: [{ id: 'btc' }], broadDiscovery });
  assert.equal(report.assetsReturned, 1);
  assert.deepEqual(report.broadDiscovery, broadDiscovery);
  assert.equal(summarizeUniverseCoverage({ assets: [] }).broadDiscovery, null);
});

test('missing provider quota headers stay unknown instead of becoming zero', async () => {
  const { providers } = await withProviderTelemetry(async () => {
    recordProviderRequest('Directory', { latencyMs: 1, status: 200, headers: new Headers() });
    recordProviderRequest('Partial', { latencyMs: 2, status: 200, headers: new Headers({ 'x-ratelimit-limit': '100' }) });
  });
  assert.equal(providers.Directory.rateLimit, null);
  assert.equal(providers.Directory.usedWeightLastMinute, null);
  assert.deepEqual(providers.Partial.rateLimit, { limit: 100, remaining: null, utilizationPct: null });
});

test('provider telemetry is isolated per concurrent scan and exposes available quota headers', async () => {
  const [a, b] = await Promise.all([
    withProviderTelemetry(async () => {
      recordProviderRequest('CoinGecko', { latencyMs: 40, status: 200, headers: new Headers({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '65' }) });
      recordProviderRequest('CoinGecko', { latencyMs: 7, status: 200, error: 'Response body or JSON parsing failed' });
      recordProviderRequest('CoinGecko', { latencyMs: 0, deferred: true, error: 'Request deferred by provider-host cooldown' });
      await new Promise((resolve) => setTimeout(resolve, 4));
      recordProviderRequest('Binance', { latencyMs: 12, status: 429, headers: new Headers({ 'x-mbx-used-weight-1m': '950' }) });
      return 'scan-a';
    }),
    withProviderTelemetry(async () => {
      recordProviderRequest('Coinbase', { latencyMs: 18, status: 503 });
      return 'scan-b';
    })
  ]);
  assert.equal(a.result, 'scan-a');
  assert.deepEqual(Object.keys(a.providers).sort(), ['Binance', 'CoinGecko']);
  assert.equal(a.providers.CoinGecko.requests, 2);
  assert.equal(a.providers.CoinGecko.successes, 1);
  assert.equal(a.providers.CoinGecko.failures, 1);
  assert.equal(a.providers.CoinGecko.cooldownDeferrals, 1);
  assert.equal(a.providers.CoinGecko.averageLatencyMs, 24, 'deferred calls must not inflate actual request latency denominators');
  assert.equal(a.providers.CoinGecko.latencySamples, 2);
  assert.equal(a.providers.CoinGecko.rateLimit.utilizationPct, 35);
  assert.equal(a.providers.Binance.rateLimits, 1);
  assert.equal(a.providers.Binance.usedWeightLastMinute, 950);
  assert.deepEqual(Object.keys(b.providers), ['Coinbase']);
  assert.equal(b.providers.Coinbase.failures, 1);
});

test('provider telemetry remains attached when a scan fails after provider requests', async () => {
  await assert.rejects(withProviderTelemetry(async () => {
    recordProviderRequest('CoinGecko', { latencyMs: 23, status: 503, error: 'HTTP 503' });
    throw new Error('market snapshot unavailable');
  }), (error) => {
    assert.equal(error.message, 'market snapshot unavailable');
    assert.equal(error.providerTelemetry.CoinGecko.failures, 1);
    assert.equal(error.providerTelemetry.CoinGecko.averageLatencyMs, 23);
    return true;
  });
});

test('diagnostic summary reports real scan average, top rejection reasons, and weighted provider latency', () => {
  const summary = summarizeScanDiagnostics([
    { generatedAt: '2026-09-24T15:00:00Z', totalDurationMs: 800, stageDurationsMs: { enrich: 400 }, funnel: { universe: 250, topRejectionReasons: { minimum_score: 10, liquidity: 4 } }, providers: { Binance: { requests: 2, failures: 1, rateLimits: 1, cooldownDeferrals: 2, averageLatencyMs: 20, rateLimit: { limit: 100, remaining: 60, utilizationPct: 40 } } } },
    { generatedAt: '2026-09-24T14:45:00Z', totalDurationMs: 1200, stageDurationsMs: { enrich: 600 }, funnel: { universe: 248, topRejectionReasons: { minimum_score: 2, market_rank: 9 } }, providers: { Binance: { requests: 1, failures: 0, rateLimits: 0, averageLatencyMs: 80, rateLimit: { limit: 100, remaining: 20, utilizationPct: 80 } }, CoinGecko: { requests: 1, failures: 0, rateLimits: 0, averageLatencyMs: 30 } } }
  ]);
  assert.equal(summary.scans, 2);
  assert.equal(summary.latest.funnel.universe, 250);
  assert.equal(summary.averageDurationMs, 1000);
  assert.deepEqual(summary.topRejectionReasons.slice(0, 2), [
    { reason: 'minimum_score', count: 12 }, { reason: 'market_rank', count: 9 }
  ]);
  assert.equal(summary.providers.Binance.averageLatencyMs, 40);
  assert.equal(summary.providers.Binance.rateLimits, 1);
  assert.equal(summary.providers.Binance.cooldownDeferrals, 2);
  assert.equal(summary.providers.Binance.utilizationPct, 40);
  assert.equal(summary.averageStageDurationsMs.enrich, 500);
});

test('unmeasured scan and stage durations remain unknown in the history summary', () => {
  const empty = summarizeScanDiagnostics([]);
  assert.equal(empty.averageDurationMs, null);
  const unmeasured = summarizeScanDiagnostics([
    { funnel: {}, totalDurationMs: null, stageDurationsMs: { discovery: null } },
  ]);
  assert.equal(unmeasured.averageDurationMs, null);
  assert.deepEqual(unmeasured.averageStageDurationsMs, {});
});

test('failed scan summary keeps funnel counts unknown and includes measured provider failures', () => {
  const failedScan = createFailedScanDiagnostic({ generatedAt: '2026-09-30T12:00:00Z', failureStage: 'market_snapshot',
    failure: 'Both discovery providers failed.', durationMs: 41,
    providers: { CoinGecko: { requests: 1, successes: 0, failures: 1, rateLimits: 0,
      cooldownDeferrals: 0, averageLatencyMs: 23, latencySamples: 1 } } });
  const summary = summarizeScanDiagnostics([failedScan]);
  assert.equal(failedScan.failureStage, 'market_snapshot');
  assert.equal(failedScan.funnel.rejections[0].code, 'scan_failed');
  assert.equal(summary.latest.funnel.universe, null);
  assert.equal(summary.latest.funnel.successfullyScanned, null);
  assert.equal(summary.topRejectionReasons[0].reason, 'scan_failed');
  assert.equal(summary.providers.CoinGecko.failures, 1);
  assert.equal(summary.averageDurationMs, 41);
});

test('provider cooldown-only rows keep network latency unknown through aggregation', async () => {
  const { providers } = await withProviderTelemetry(async () => {
    recordProviderRequest('CoinGecko', { deferred: true, error: 'cooldown active' });
  });
  assert.equal(providers.CoinGecko.requests, 0);
  assert.equal(providers.CoinGecko.cooldownDeferrals, 1);
  assert.equal(providers.CoinGecko.averageLatencyMs, null);
  assert.equal(providers.CoinGecko.maxLatencyMs, null);
  const summary = summarizeScanDiagnostics([{
    funnel: {}, totalDurationMs: 4, providers,
  }]);
  assert.equal(summary.providers.CoinGecko.requests, 0);
  assert.equal(summary.providers.CoinGecko.cooldownDeferrals, 1);
  assert.equal(summary.providers.CoinGecko.averageLatencyMs, null);
});

test('risk diagnostics count unique candidates once and identify daily-cap omissions', () => {
  const rejected = [{ asset: { symbol: 'BTC' }, reason: 'correlation' }, { asset: { symbol: 'ETH' }, reason: 'cap' }];
  const modelApproved = [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }];
  assert.equal(countRiskRejections(rejected, true, modelApproved), 3);
  assert.equal(countRiskRejections(rejected, false, modelApproved), 2);
  assert.deepEqual(dailyCapacityRejections([{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }], 1), [
    { symbol: 'ETH', assetId: null, stage: 'daily_capacity', code: 'daily_signal_cap' },
    { symbol: 'SOL', assetId: null, stage: 'daily_capacity', code: 'daily_signal_cap' }
  ]);
});

test('top rejection totals count each unique asset once per code while preserving cross-stage detail', () => {
  const rows = [
    { assetId: 'coin-a', symbol: 'DUP', stage: 'risk_approval', code: 'risk_guard' },
    { assetId: 'coin-a', symbol: 'DUP', stage: 'shared_portfolio_risk', code: 'risk_guard' },
    { assetId: 'coin-a', symbol: 'DUP', stage: 'delivery', code: 'discord_failed' },
    { assetId: 'coin-b', symbol: 'DUP', stage: 'risk_approval', code: 'risk_guard' },
    { assetId: 'coin-a', symbol: 'DUP', stage: 'candidate_filter', code: 'minimum_score' },
    { symbol: '', assetId: 'no-symbol', stage: 'data_identity', code: 'missing_asset_symbol' },
    { symbol: '', assetId: 'no-symbol', stage: 'data_identity', code: 'missing_asset_symbol' },
    { symbol: '', stage: 'data_identity', code: 'unidentified_row' },
    { symbol: '', stage: 'data_identity', code: 'unidentified_row' },
  ];
  assert.deepEqual(countUniqueRejectionReasons(rows), {
    risk_guard: 2, discord_failed: 1, minimum_score: 1, missing_asset_symbol: 1, unidentified_row: 2,
  });
  assert.equal(rows.length, 9, 'detailed stage rows remain available to diagnose the funnel');
});

test('historical validation counts distinct rejected assets and overlapping subreasons', () => {
  const rows = [
    { assetId: 'coin-a', code: 'strategy_validation', detailCodes: ['nonpositive_overall_expectancy', 'overall_profit_factor_not_above_one'] },
    { assetId: 'coin-a', code: 'strategy_validation', detailCodes: ['nonpositive_overall_expectancy'] },
    { assetId: 'coin-b', code: 'strategy_validation', detailCodes: ['insufficient_historical_sample', 'nonpositive_overall_expectancy'] },
    { assetId: 'coin-c', code: 'minimum_score', detailCodes: ['nonpositive_overall_expectancy'] },
  ];
  assert.deepEqual(countValidationFailureReasons(rows), {
    nonpositive_overall_expectancy: 2,
    insufficient_historical_sample: 1,
    overall_profit_factor_not_above_one: 1,
  });
});

test('universe diagnostics report fetched discovery tracks and the bounded Demo request estimate', () => {
  const snapshot = { source: 'CoinGecko Demo', providerReportedTotal: 16_989, providerPageSize: 250, providerRowsReturned: 500,
    discoveryPages: 2, marketCapPagesFetched: 1, marketCapPagesRequested: 1, marketCapRankCapRequested: 250,
    discoveryIntervalMinutes: 15, estimatedCallsPer30Days: 5_760,
    discoveryBudget: { guarded: true, scope: 'bulk_discovery_pages_only', monthlyCeiling: 9_000,
      keyedIdentityPlanning: { deepCandidateCap: 8, stableShortlistCallsPer30Days: 11_580,
        fullTurnoverCallsPer30Days: 28_860, scope: 'scheduled_discovery_illustration_only' } },
    universeJournal: { status: 'recorded', provider: 'coingecko', dateUtc: '2026-09-24', assetCount: 400, retentionDays: 1_460 },
    assets: Array.from({ length: 400 }, () => ({})) };
  const defaultDepth = summarizeUniverseCoverage(snapshot, { maxMarketRank: 250, discoveryMinutes: 15 });
  assert.equal(defaultDepth.assetsReturned, 400);
  assert.equal(defaultDepth.providerReportedTotal, 16_989);
  assert.ok(Math.abs(defaultDepth.providerCoveragePct - (100 * 400 / 16_989)) < 1e-12);
  assert.equal(defaultDepth.pagesFetched, 2);
  assert.equal(defaultDepth.coverageLimited, false);
  assert.equal(defaultDepth.estimatedCallsPer30Days, 5_760);
  assert.equal(defaultDepth.discoveryBudget.scope, 'bulk_discovery_pages_only');
  assert.equal(defaultDepth.discoveryBudget.keyedIdentityPlanning.stableShortlistCallsPer30Days, 11_580);
  assert.deepEqual(defaultDepth.pointInTimeMembership, snapshot.universeJournal);

  const expandedSnapshot = { ...snapshot, discoveryPages: 3, marketCapPagesFetched: 2, marketCapPagesRequested: 4,
    marketCapRankCapRequested: 1000, estimatedCallsPer30Days: 8_640 };
  const expandedDepth = summarizeUniverseCoverage(expandedSnapshot, { maxMarketRank: 1000, discoveryMinutes: 15 });
  assert.equal(expandedDepth.pagesNeededForRequestedDepth, 4);
  assert.equal(expandedDepth.coverageLimited, true);
  assert.equal(expandedDepth.marketCapPagesFetched, 2);
  assert.equal(expandedDepth.marketCapPagesRequested, 4);
  assert.equal(expandedDepth.estimatedCallsPer30Days, 8_640);
  assert.equal(snapshot.assets.length, 400, 'coverage summaries do not mutate the fetched asset set');

  const fallback = summarizeUniverseCoverage({ source: 'CoinPaprika public fallback', assets: Array(1800).fill({}) }, { maxMarketRank: 1000 });
  assert.equal(fallback.assetsReturned, 1800);
  assert.equal(fallback.coverageLimited, null, 'alternate-provider listing completeness is unknown without its coverage metadata');
  assert.equal(fallback.providerReportedTotal, null);
  assert.equal(fallback.providerCoveragePct, null);
  assert.equal(fallback.estimatedCallsPer30Days, null);
});

test('universe diagnostics preserve observed zeroes and keep absent provider counters unknown', () => {
  const zero = summarizeUniverseCoverage({
    source: 'CoinGecko Demo', providerRowsReturned: 0, discoveryPages: 0,
    marketCapPagesFetched: 0, marketCapPagesRequested: 1, estimatedCallsPer30Days: 0, assets: [{}],
  }, { maxMarketRank: 250, discoveryMinutes: 15 });
  assert.equal(zero.providerRowsReturned, 0);
  assert.equal(zero.pagesFetched, 0);
  assert.equal(zero.marketCapPagesFetched, 0);
  assert.equal(zero.estimatedCallsPer30Days, 0);
  assert.equal(zero.coverageLimited, true);

  const unknown = summarizeUniverseCoverage({ source: 'CoinGecko Demo', assets: [] }, { maxMarketRank: 250 });
  assert.equal(unknown.pagesFetched, null);
  assert.equal(unknown.marketCapPagesFetched, null);
  assert.equal(unknown.coverageLimited, null);
  assert.equal(unknown.estimatedCallsPer30Days, null);
});
