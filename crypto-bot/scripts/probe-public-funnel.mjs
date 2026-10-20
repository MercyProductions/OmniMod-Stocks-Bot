import { appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Isolate this diagnostic from the worker's cache and journals. Its market
// requests use explicit public settings, even if a local paid key exists.
process.env.OMNIMOD_CRYPTO_DATA_DIR = fileURLToPath(new URL('../data/public-funnel-probe/', import.meta.url));
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';

const [{ config }, { assessStrategyValidation, fetchMarketUniverse, screenMomentumDetailed }, {
  screenSpotPairCoverage, fetchProviderQuotes, aggregateProviderQuotes, enrichMarketAssets,
}, { getProviderTelemetry }] = await Promise.all([
  import('../src/config.js'), import('../src/cryptoData.js'), import('../src/marketProviders.js'),
  import('../src/providerTelemetry.js'),
]);
const { parseKrakenMessage } = await import('../src/realtimeFeeds.js');
const deepRequested = process.argv.includes('--deep');
const captureRequested = process.argv.includes('--capture');
const resolveRequested = process.argv.includes('--resolve');
const finerResolveRequested = process.argv.includes('--resolve-finer');
const statusRequested = process.argv.includes('--status');
if (process.argv.slice(2).some((argument) => !['--deep', '--capture', '--resolve', '--resolve-finer', '--status'].includes(argument))
  || (captureRequested && !deepRequested)
  || ((resolveRequested || finerResolveRequested)
    && (deepRequested || captureRequested || statusRequested || (resolveRequested && finerResolveRequested)))
  || (statusRequested && (deepRequested || captureRequested))) {
  throw new Error('Use --deep [--capture] for a bounded scan, --status for the isolated cohort, --resolve for completed 15-minute bars, or --resolve-finer for bounded Binance 1-second entry clearance.');
}
if (statusRequested) {
  const { summarizePublicProbeObservations } = await import('./public-probe-research.mjs');
  console.log(JSON.stringify(await summarizePublicProbeObservations(), null, 2));
  process.exit(0);
}
if (resolveRequested || finerResolveRequested) {
  const { resolvePublicProbeObservations } = await import('./public-probe-research.mjs');
  console.log(JSON.stringify(await resolvePublicProbeObservations(new Date(),
    { finerEntry: finerResolveRequested }), null, 2));
  process.exit(0);
}

async function collectKrakenQuotes(assets, timeoutMs = 6_000) {
  const symbols = [...new Set(assets.map((asset) => String(asset.symbol || '').toUpperCase()).filter(Boolean))];
  if (!symbols.length) return { quotes: new Map(), status: 'no_symbols', elapsedMs: 0 };
  const requested = new Set(symbols);
  const quotes = new Map();
  const arrivalMs = new Map();
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const socket = new WebSocket('wss://ws.kraken.com/v2', { handshakeTimeout: timeoutMs });
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
      resolve({ quotes, arrivalMs, status, elapsedMs: Math.round(performance.now() - startedAt) });
    };
    const timer = setTimeout(() => finish('timed_out_or_partial'), timeoutMs);
    socket.on('open', () => socket.send(JSON.stringify({ method: 'subscribe', params: {
      channel: 'ticker', symbol: symbols.map((symbol) => `${symbol}/USD`), event_trigger: 'bbo', snapshot: true,
    } })));
    socket.on('message', (buffer) => {
      let payload;
      try { payload = JSON.parse(String(buffer)); } catch { return; }
      for (const row of Array.isArray(payload?.data) ? payload.data : []) {
        const quote = parseKrakenMessage({ ...payload, data: [row] });
        const ageMs = Date.now() - Date.parse(quote?.providerObservedAt || '');
        if (!quote || !requested.has(quote.symbol) || !(quote.bid > 0 && quote.ask >= quote.bid)
          || !Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > 300_000) continue;
        if (!quotes.has(quote.symbol)) arrivalMs.set(quote.symbol, Math.round(performance.now() - startedAt));
        quotes.set(quote.symbol, quote);
      }
      if (quotes.size === requested.size) finish('all_requested_quotes_observed');
    });
    socket.on('error', () => finish('websocket_error'));
    socket.on('close', () => finish('websocket_closed'));
  });
}

const settings = {
  discoveryMinutes: config.discoveryMinutes,
  maxMarketRank: config.maxMarketRank,
  minVolumeUsd: config.minVolumeUsd,
  minScore: config.minScore,
  minProviderConfirmations: config.minProviderConfirmations,
  maxProviderCandidates: config.maxProviderCandidates,
  minRiskReward: config.minRiskReward,
  estimatedRoundTripBps: config.estimatedRoundTripBps,
  derivativesEnabled: config.derivativesEnabled,
  maxExecutionSlippageBps: config.maxExecutionSlippageBps,
  coingeckoApiKey: '', coingeckoApiTier: 'public',
};
const startedAt = new Date();
const started = performance.now();
const snapshot = await fetchMarketUniverse('public-funnel-probe', { settings, force: false });
const snapshotMs = Math.round(performance.now() - started);
const discovery = screenMomentumDetailed(snapshot, { ...settings, minScore: Math.max(50, settings.minScore - 12) }, {
  requireDiscoveryTimestamp: true, staleSnapshot: Boolean(snapshot.stale), now: new Date(),
  maxDiscoveryQuoteAgeMs: config.maxDiscoveryAssetAgeMinutes * 60_000,
});
const discoveryMs = Math.round(performance.now() - started) - snapshotMs;
const coverage = await screenSpotPairCoverage(discovery.candidates, { minProviders: settings.minProviderConfirmations });
const directoryMs = Math.round(performance.now() - started) - snapshotMs - discoveryMs;
const selected = coverage.candidates.slice(0, settings.maxProviderCandidates);
// A small negative sample can reveal a false exclusion without requesting
// quotes for every discovery candidate. It cannot measure full recall.
const excludedSample = coverage.available ? coverage.rejections.slice(0, 4) : [];
const byId = new Map(discovery.candidates.map((asset) => [asset.id, asset]));
const checks = [...selected.map((asset) => ({ asset, preflight: 'passed' })),
  ...excludedSample.map((row) => ({ asset: byId.get(row.assetId), preflight: 'rejected' }))]
  .filter((row) => row.asset);
const krakenWebsocket = await collectKrakenQuotes(checks.map((row) => row.asset));
const quoteChecks = [];
for (let index = 0; index < checks.length; index += 3) {
  const batch = checks.slice(index, index + 3);
  const rows = await Promise.all(batch.map(async ({ asset, preflight }) => {
    const live = krakenWebsocket.quotes.get(String(asset.symbol || '').toUpperCase());
    const realtimeQuote = live ? { ...live, provider: 'Kraken', observedAt: live.providerObservedAt,
      timestampBasis: 'provider_event' } : null;
    const fetched = await fetchProviderQuotes(asset, { settings, realtimeQuote });
    const consensus = aggregateProviderQuotes(fetched.quotes, asset.price, { now: Date.now() });
    return {
      assetId: asset.id, symbol: asset.symbol, preflight,
      respondingVenues: fetched.quotes.map((quote) => quote.provider),
      timestampedExecutableVenues: consensus.providers,
      timestampedVenueThresholdMet: consensus.providerCount >= settings.minProviderConfirmations && !consensus.conflicted,
      krakenWebsocketTimestampObserved: Boolean(live),
      krakenWebsocketFirstArrivalMs: krakenWebsocket.arrivalMs.get(String(asset.symbol || '').toUpperCase()) ?? null,
      sourceIdentity: fetched.identity?.status || 'unknown',
      quoteRejections: consensus.rejectionCounts,
      providerErrorCount: fetched.errors.length,
    };
  }));
  quoteChecks.push(...rows);
}
const countCodes = (rows) => Object.fromEntries([...new Set(rows.map((row) => row.code))].sort()
  .map((code) => [code, rows.filter((row) => row.code === code).length]));
const finiteMetric = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const profitFactorMetric = (value) => value === Infinity ? 'infinite' : finiteMetric(value);
const observedMetric = (segment, metric, normalize = finiteMetric) =>
  Number.isInteger(segment?.trades) && segment.trades > 0 ? normalize(segment?.[metric]) : null;
const errorCategory = (value) => {
  const prefix = String(value || '').split(':')[0].trim().slice(0, 60);
  return /^[A-Za-z0-9 /._-]+$/.test(prefix) ? prefix : 'other_provider_error';
};
const quoteCompletedMs = Math.round(performance.now() - started);
let deepAnalysis = { status: 'not_requested' };
if (deepRequested && selected.length) {
  const realtimeQuoteBySymbol = new Map([...krakenWebsocket.quotes].map(([symbol, quote]) => [symbol, {
    ...quote, provider: 'Kraken', observedAt: quote.providerObservedAt, timestampBasis: 'provider_event',
  }]));
  const enrichment = await enrichMarketAssets(selected, {
    technicalAssetIds: new Set(selected.map((asset) => asset.id)),
    bitcoinAsset: snapshot.assets.find((asset) => asset.symbol === 'BTC'),
    concurrency: 3, minimumScore: settings.minScore, rewardRisk: settings.minRiskReward,
    roundTripFeeBps: settings.estimatedRoundTripBps,
    derivativesEnabled: settings.derivativesEnabled, realtimeQuoteBySymbol,
    eventRisks: [], globalMarketContext: snapshot.globalMarketContext, settings, now: new Date(),
  });
  const screenOptions = { requireDiscoveryTimestamp: true, staleSnapshot: Boolean(snapshot.stale),
    now: new Date(), maxDiscoveryQuoteAgeMs: config.maxDiscoveryAssetAgeMinutes * 60_000,
    requireConfirmation: true, collectAllRejections: true };
  const strict = screenMomentumDetailed({ assets: enrichment.assets }, settings, screenOptions);
  const advisory = screenMomentumDetailed({ assets: enrichment.assets }, settings,
    { ...screenOptions, validationAdvisory: true });
  const strictIds = new Set(strict.candidates.map((asset) => asset.id));
  const advisoryIds = new Set(advisory.candidates.map((asset) => asset.id));
  const providerErrors = [...(enrichment.providerErrors || []),
    ...enrichment.assets.flatMap((asset) => asset.marketData?.errors || [])];
  const validationFailureCounts = {};
  for (const asset of enrichment.assets) {
    const rejectedForValidation = strict.rejections.some((row) => row.assetId === asset.id && row.code === 'strategy_validation');
    if (!rejectedForValidation) continue;
    for (const code of assessStrategyValidation(asset.marketData?.validation).reasons) {
      validationFailureCounts[code] = (validationFailureCounts[code] || 0) + 1;
    }
  }
  deepAnalysis = {
    status: 'public_diagnostic_only', analyzed: enrichment.assets.length,
    marketRegime: enrichment.regime?.key || 'unknown',
    strictScreenCandidates: strict.candidates.length,
    validationAdvisoryOnlyCandidates: advisory.candidates.filter((asset) => !strictIds.has(asset.id)).length,
    multiGateRejectionCodes: countCodes(strict.rejections),
    validationFailureCounts,
    providerErrorCount: providerErrors.length,
    providerErrorCategories: Object.fromEntries([...new Set(providerErrors.map(errorCategory))].sort()
      .map((category) => [category, providerErrors.filter((error) => errorCategory(error) === category).length])),
    assets: enrichment.assets.map((asset) => ({
      assetId: asset.id, symbol: asset.symbol,
      exchangeProviderCount: asset.marketData?.providerCount ?? null,
      candleCount: asset.marketData?.candleCount ?? null,
      candleProvider: asset.marketData?.candleProvider || null,
      candlePair: asset.marketData?.candlePair || null,
      candleCoverage: asset.marketData?.candleCoverage || null,
      technicalDataSufficient: asset.marketData?.technicals?.dataSufficient === true,
      strategyValidationCostRoundTripBps: finiteMetric(asset.marketData?.validation?.costModel?.roundTripBps),
      executionEstimatedRoundTripBps: finiteMetric(asset.marketData?.execution?.estimatedRoundTripBps),
      executionStressedRoundTripBps: finiteMetric(asset.marketData?.execution?.stressedRoundTripBps),
      executionSpreadBps: finiteMetric(asset.marketData?.execution?.spreadBps),
      executionOneWaySlippageBps: finiteMetric(asset.marketData?.execution?.oneWaySlippageBps),
      strategyValidationSufficient: asset.marketData?.validation?.sufficient === true,
      strategyValidationRecentTrades: asset.marketData?.validation?.recent?.trades ?? null,
      strategyValidationOverallTrades: asset.marketData?.validation?.overall?.trades ?? null,
      strategyValidationCoverage: asset.marketData?.validation?.coverage || null,
      strategyValidationRecentExpectancyR: observedMetric(asset.marketData?.validation?.recent, 'expectancyR'),
      strategyValidationOverallExpectancyR: observedMetric(asset.marketData?.validation?.overall, 'expectancyR'),
      strategyValidationRecentProfitFactor: observedMetric(asset.marketData?.validation?.recent, 'profitFactor', profitFactorMetric),
      strategyValidationOverallProfitFactor: observedMetric(asset.marketData?.validation?.overall, 'profitFactor', profitFactorMetric),
      strategyValidationFailureReasons: assessStrategyValidation(asset.marketData?.validation).reasons,
      derivativesAvailable: asset.marketData?.derivatives?.available === true,
      derivativesProviderCount: asset.marketData?.derivatives?.providerCount ?? null,
      strictScreenQualified: strictIds.has(asset.id),
      validationAdvisoryQualified: advisoryIds.has(asset.id) && !strictIds.has(asset.id),
      strictRejectionCodes: strict.rejections.filter((row) => row.assetId === asset.id).map((row) => row.code),
      executionBlocked: asset.marketData?.execution?.blockTrade === true,
      dataConflict: asset.marketData?.conflicted === true,
    })),
    interpretation: 'The existing strict technical/validation screen only. Manual catalysts, learned model, portfolio guard, shared risk, Discord delivery and paper outcomes were not evaluated. Multi-gate counts overlap.',
  };
  if (captureRequested) {
    const { capturePublicProbeObservations } = await import('./public-probe-research.mjs');
    deepAnalysis.researchCapture = await capturePublicProbeObservations(enrichment.assets, settings,
      new Date(), strict.rejections);
  }
} else if (deepRequested) deepAnalysis = { status: 'no_selected_candidates', analyzed: 0 };
const totalElapsedMs = Math.round(performance.now() - started);
const providerTelemetry = Object.fromEntries(Object.entries(getProviderTelemetry()).map(([provider, stats]) => [provider, {
  requests: stats.requests, successes: stats.successes, failures: stats.failures,
  rateLimits: stats.rateLimits, cooldownDeferrals: stats.cooldownDeferrals,
  averageLatencyMs: stats.averageLatencyMs, maxLatencyMs: stats.maxLatencyMs,
  rateLimit: stats.rateLimit, usedWeightLastMinute: stats.usedWeightLastMinute,
}]));
const payload = {
  startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(),
  elapsedMs: totalElapsedMs,
  stageDurationsMs: { snapshot: snapshotMs, discovery: discoveryMs, directory: directoryMs,
    websocket: krakenWebsocket.elapsedMs,
    quotes: quoteCompletedMs - snapshotMs - discoveryMs - directoryMs - krakenWebsocket.elapsedMs,
    deepAnalysis: totalElapsedMs - quoteCompletedMs },
  scope: deepRequested
    ? `One bounded public discovery, quote, technical and historical-validation diagnostic.${captureRequested ? ' Opt-in isolated prospective research capture; no model training.' : ''} No learned model, full event review, portfolio risk, Discord, paper reservation, or order action.`
    : 'One bounded public discovery, spot-directory, and exchange quote observation. No deep strategy, model, risk, Discord, paper reservation, or order action.',
  settings: { ...settings, coingeckoApiKey: undefined },
  snapshot: {
    source: snapshot.source, fetchedAt: snapshot.fetchedAt, cacheHit: Boolean(snapshot.cacheHit),
    stale: Boolean(snapshot.stale), providerRowsReturned: snapshot.providerRowsReturned ?? null,
    uniqueAssets: snapshot.assets?.length || 0, providerReportedTotal: snapshot.providerReportedTotal ?? null,
    providerErrorPresent: Boolean(snapshot.providerError),
  },
  funnel: {
    ...discovery.stageCounts, discoveryQualified: discovery.candidates.length,
    directoryAvailable: coverage.available, directoryVenues: coverage.venues || [],
    directorySupportedVenueCounts: coverage.supportedVenueCounts || {},
    directoryPassed: coverage.candidates.length, directoryRejected: coverage.rejections.length,
    deepAnalysisCapSelected: selected.length,
    omittedByDeepAnalysisCap: Math.max(0, coverage.candidates.length - selected.length),
    selectedVenueThresholdMet: quoteChecks.filter((row) => row.preflight === 'passed' && row.timestampedVenueThresholdMet).length,
    selectedVenueThresholdNotMet: quoteChecks.filter((row) => row.preflight === 'passed' && !row.timestampedVenueThresholdMet).length,
    sampledDirectoryExclusionsMeetingVenueThreshold: quoteChecks.filter((row) => row.preflight === 'rejected' && row.timestampedVenueThresholdMet).length,
    sampledDirectoryExclusions: excludedSample.length,
  },
  discoveryRejectionCodes: countCodes(discovery.rejections),
  directoryRejectionCodes: countCodes(coverage.rejections),
  krakenWebsocket: { status: krakenWebsocket.status, requestedSymbols: checks.length,
    sourceTimestampedQuotes: krakenWebsocket.quotes.size },
  providerTelemetry,
  quoteChecks,
  deepAnalysis,
  limitations: [
    'Ticker-only exchange matching can confuse assets with the same symbol; paid coin-ID pair verification is not exercised.',
    'Kraken REST ticker receipt time is not a trusted market-observation timestamp. This probe separately attempts bounded source-timestamped WebSocket quotes.',
    'The excluded sample is capped at four and does not establish directory recall or market-wide opportunity coverage.',
    'A quote confirmation is not a strategy approval, executable fill, or evidence of positive expectancy.',
    'The optional deep analysis lacks the worker’s manual catalysts, learned model, portfolio state, shared risk and delivery gates; it is not a full production scan.',
    'Opt-in research capture is an isolated ticker-only public cohort with source-pinned candle outcomes and modeled costs; it cannot train the production model or establish executable fills.',
  ],
};
payload.historyJournal = 'data/public-funnel-probe/probe-history.ndjson';
await appendFile(new URL('../data/public-funnel-probe/probe-history.ndjson', import.meta.url),
  `${JSON.stringify({ startedAt: payload.startedAt, completedAt: payload.completedAt,
    snapshotFetchedAt: payload.snapshot.fetchedAt, snapshotSource: payload.snapshot.source,
    universe: payload.funnel.universe, discoveryQualified: payload.funnel.discoveryQualified,
    directoryPassed: payload.funnel.directoryPassed, quoteThresholdMet: payload.funnel.selectedVenueThresholdMet,
    deepRequested, deepAnalyzed: payload.deepAnalysis.analyzed ?? null,
    researchCapture: payload.deepAnalysis.researchCapture ?? null,
    strictScreenCandidates: payload.deepAnalysis.strictScreenCandidates ?? null,
    validationAdvisoryOnlyCandidates: payload.deepAnalysis.validationAdvisoryOnlyCandidates ?? null,
    deepRejectionCodes: payload.deepAnalysis.multiGateRejectionCodes ?? null,
    validationFailureCounts: payload.deepAnalysis.validationFailureCounts ?? null,
    deepAssets: payload.deepAnalysis.assets?.map((row) => ({ assetId: row.assetId,
      candleProvider: row.candleProvider, candleCount: row.candleCount,
      lastCompletedAt: row.candleCoverage?.lastCompletedAt ?? null,
      missingIntervals: row.candleCoverage?.missingIntervals ?? null,
      validationCostRoundTripBps: row.strategyValidationCostRoundTripBps,
      executionEstimatedRoundTripBps: row.executionEstimatedRoundTripBps,
      executionStressedRoundTripBps: row.executionStressedRoundTripBps,
      recentSignalDays: row.strategyValidationCoverage?.recent?.signalDays ?? null,
      overallSignalDays: row.strategyValidationCoverage?.overall?.signalDays ?? null,
      recentExpectancyR: row.strategyValidationRecentExpectancyR,
      overallExpectancyR: row.strategyValidationOverallExpectancyR })) ?? null,
    elapsedMs: payload.elapsedMs })}\n`);
await writeFile(new URL('../PUBLIC_FUNNEL_PROBE.md', import.meta.url),
  `# Crypto public funnel probe\n\nObserved ${payload.completedAt}. This is a diagnostic snapshot, not a trading signal.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);
console.log(JSON.stringify(payload, null, 2));
