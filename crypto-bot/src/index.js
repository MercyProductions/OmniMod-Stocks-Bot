import { buildDayTradingWatches, unannouncedDayTradingWatches, recordDayTradingWatchDelivery } from './dayTradingWatches.js';
import {
  Client, EmbedBuilder, Events, GatewayIntentBits, REST, Routes
} from 'discord.js';
import { config, requireRuntimeConfig, dataDir } from './config.js';
import { formatBroadDiscoverySummary } from './broadDiscovery.js';
import { formatVenueDiscoverySummary, selectVenueResearchAssets } from './venueDiscovery.js';
import { refreshVenueResearchOutcomes } from './venueResearch.js';
import { buildCommands } from './commands.js';
import { assessStrategyValidation, fetchMarketUniverse, getAmbiguousProviderSymbols, marketUniverseCacheKey, formatPercent, formatPrice, screenMomentum, screenMomentumDetailed, scoreAsset } from './cryptoData.js';
import { enrichMarketAssets, fetchHistoricalCandles, screenSpotPairCoverage } from './marketProviders.js';
import { researchInvestments, isInvestmentSnapshotFresh } from './investmentResearch.js';
import { LONG_WINDOW_SHADOW_DAYS } from './investmentJournal.js';
import { formatDiagnosticCount } from '../../new-bots/shared/formatDiagnosticCount.js';
import { resolveCryptoAsset } from './paperExecutionQuotes.js';
import { refreshCryptoPaperQuotes } from './paperQuoteRefresh.js';
import { recordTokenSupplySnapshots } from './tokenSupplyJournal.js';
import { appendThesisAssessment, appendThesisEvidenceReview, appendThesisPerformanceSnapshot, appendThesisRevision, compareProtocolActivityCaptures, latestTheses, recentThesisAssessments, recentThesisEvidenceReviews, readThesisJournal, summarizeProtocolActivityHistory, summarizeThesisPerformance, thesisEvidenceCoverage, thesisReviewPrompts, thesesDueForReview } from './thesisJournal.js';
import { fetchProtocolFundamentals } from './protocolFundamentals.js';
import { FEATURE_SCHEMA_VERSION } from './modelFeatures.js';
import { fetchGithubActivity } from './githubActivity.js';
import { cryptoEvidenceFactSource } from './thesisEvidence.js';
import { formatEdgeEvidence } from './edgeEvidence.js';
import { validateStrategy } from './backtest.js';
import { getGuildSettings, listConfiguredGuildIds, maskSecret, updateGuildSettings } from './guildSettings.js';
import {
  claimDailyDiscovery, claimProviderWindow, finishDailyDiscovery, listDiscoveries, listScanDiagnostics, readDailyDiscovery, readMarketSnapshot,
  readTracker, readJson, writeJson, paths, writeDailyDiscovery, writeScanDiagnostic, writeTracker
} from './storage.js';
import {
  buildPrediction, buildPredictions, deliverPredictionsSafely, evaluatePrediction, mergeNewPredictions,
  mergePendingOutcomeDeliveries, removeDeliveredOutcomeDeliveries, summarizePerformance
} from './predictionEngine.js';
import {
  COLORS, handleAlertButton, isAdminInteraction, logEvent, postNewPrediction, postOpeningSummary,
  postOutcome, postRolePanel, postDayTradingWatchUpdate, paperOutcomeLabel, predictionEmbed, resolveResources, trackerConfidenceText
} from './discordPublisher.js';
import { isDailyDiscoveryTime, localDateKey, localTimeLabel } from './time.js';
import { ensurePrimaryWorkspace } from './workspace.js';
import {
  createObservationId, getResearchStatus, pruneResearch, recordShadowCandidates, resolvePendingObservations
} from './researchStore.js';
import { buildSourcePinnedShadowPrediction } from './shadowEntryEvidence.js';
import {
  maybeTrainAndStageModels, readModelRegistry, readProductionModels, summarizeModelReadiness, trainAndStageModels
} from './modelRegistry.js';
import { applyPortfolioRisk } from './portfolioRisk.js';
import { getRiskGuard, setRiskGuardPause } from './riskGuard.js';
import { RealtimeMarketHub } from './realtimeFeeds.js';
import { addEventRisk, clearEventRisk, listEventRisks } from './eventRisk.js';
import { loadCryptoMacroCalendar } from './cryptoMacroCalendar.js';
import { loadFinnhubCryptoNews } from './cryptoNews.js';
import { monteCarloCostStress } from './executionSimulator.js';
import { importHistoricalResearch } from './historicalImporter.js';
import { pruneMicrostructure } from './microstructure.js';
import { withProviderTelemetry } from './providerTelemetry.js';
import { countRiskRejections, countUniqueRejectionReasons, countValidationFailureReasons, createFailedScanDiagnostic, dailyCapacityRejections, fitDiagnosticEmbed, summarizeScanDiagnostics, summarizeShadowResearchRecording, summarizeUniverseCoverage, summarizeValidationCostSensitivity } from './scanDiagnostics.js';
import { classifyResearchMetadata } from './researchTaxonomy.js';
import { buildPrimarySignalCandidate, getSharedPaperDiagnostics, isSharedPaperConfigured, markSharedPaperOrders, reconcileSharedPaperOrders, reserveSharedPaperCandidate, sharedPaperPolicy } from '../../new-bots/shared/primarySignal.js';
import { recoverPaperOrders } from '../../new-bots/shared/paperRisk.js';
import { transitionPaperOrder } from '../../new-bots/shared/paperRisk.js';
import { publishPrimaryResearchSignals } from '../../new-bots/shared/signalResearch.js';
import { createRunnerHeartbeat } from '../../new-bots/shared/runnerHeartbeat.js';
import { getPaperLedgerWorkspaceRoot, paperLedgerFingerprint } from '../../new-bots/shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../new-bots/shared/forwardShadowPaper.js';
import { createCryptoPositionMonitor } from './paperPositionMonitor.js';

requireRuntimeConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const runtime = {
  state: 'starting', phase: 'boot', startedAt: new Date().toISOString(), discordReady: false,
  discordUser: '', lastScanAt: '', lastScanReason: '', lastProviderAt: '', lastError: '',
  scansCompleted: 0, interactionsHandled: 0, dataDir
};
const paperPositionMonitor = createCryptoPositionMonitor();
let shutdownPromise;
const runnerHeartbeat = createRunnerHeartbeat({ bot: 'crypto', directory: dataDir, role: 'discord-service',
  getState: () => ({ state: runtime.state, phase: runtime.phase, discordReady: runtime.discordReady, lastScanAt: runtime.lastScanAt || null,
    positionMonitor: paperPositionMonitor.snapshot(), emergencyStopActive: config.sharedPaperEmergencyStop, liveTradingEnabled: false,
    liveTradingRequested: process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true', orderRoutingAvailable: false,
    ledgerFingerprint: paperLedgerFingerprint(config.sharedPaperStatePath) }) });
runnerHeartbeat.start();
const scanPromises = new Map();
const lastMonitorByGuild = new Map();
const lastDiscoveryByGuild = new Map();
const lastDailyByGuild = new Map();
let scheduler = null;
let shuttingDown = false;
const lastRealtimeScanByGuild = new Map();

const realtimeHub = new RealtimeMarketHub({
  enabled: config.realtimeEnabled,
  flushSeconds: config.microstructureFlushSeconds,
  movementThresholdPct: 0.45,
  onThreshold: async (event) => {
    if (!client.isReady() || shuttingDown) return;
    const guildIds = await listConfiguredGuildIds(client);
    for (const guildId of guildIds) {
      const last = lastRealtimeScanByGuild.get(guildId) || 0;
      if (Date.now() - last < 2 * 60_000) continue;
      lastRealtimeScanByGuild.set(guildId, Date.now());
      void runGuildScan(guildId, { reason: `realtime:${event.symbol}`, allowNewSignals: true, maxAgeMinutes: 2 }).catch(() => {});
    }
  }
});

export function getRuntimeState() {
  return { ...runtime, uptimeSeconds: Math.floor(process.uptime()) };
}

function updateRuntime(patch) {
  Object.assign(runtime, patch);
  globalThis.__omnimodCryptoRuntime = getRuntimeState();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeProviderErrorSummary(value) {
  return String(value || '').replace(/(api[_-]?key|token|secret)(?:=|%3d)[^&\s]*/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, 'provider endpoint').slice(0, 220);
}

function globalMarketContextSummary(context) {
  if (!context?.available) return `Unavailable; this scan has no CoinGecko total-market or dominance context.${context?.fetchError ? ` ${String(context.fetchError).slice(0, 150)}` : ''}`;
  const money = (value) => Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 })}` : 'n/a';
  const pct = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : 'n/a';
  const change = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : 'n/a';
  return `${context.status === 'fresh' ? 'Fresh' : 'STALE'} | total market cap ${money(context.totalMarketCapUsd)} | BTC dominance ${pct(context.btcDominancePct)} | ETH dominance ${pct(context.ethDominancePct)} | cap change 24h ${change(context.marketCapChange24hPct)} | volume ${money(context.totalVolumeUsd)} (${change(context.volumeChange24hPct)}) | provider as of ${context.providerUpdatedAt || 'unknown'}.${context.fetchError ? ` Refresh error: ${String(context.fetchError).slice(0, 100)}.` : ''} Descriptive only; it does not change scanner scores or approvals.`;
}

function providerIdentityWarning(assets, asset) {
  const symbol = String(asset?.symbol || '').trim().toLowerCase();
  if (!symbol || !getAmbiguousProviderSymbols(assets).has(symbol)) return '';
  return `Ticker ${String(asset.symbol).trim().toUpperCase()} is shared by multiple assets in the current universe. Exchange adapters resolve markets by ticker rather than token identity, so exchange-based analysis for ${asset.id || asset.name || symbol} was skipped.`;
}

function fitPrivateThesisContent(content, limit = 1990) {
  if (content.length <= limit) return content;
  const separator = content.lastIndexOf('\n\n');
  const disclosure = separator >= 0 ? content.slice(separator + 2) : '';
  const body = separator >= 0 ? content.slice(0, separator) : content;
  const budget = Math.max(0, limit - disclosure.length - (disclosure ? 5 : 1));
  return disclosure ? `${body.slice(0, budget).trimEnd()}…\n\n${disclosure}` : `${body.slice(0, limit - 1)}…`;
}

function quoteCurrency(pair) {
  const compact = String(pair || '').toUpperCase().replace(/[\/-]/g, '');
  return ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'].find((currency) => compact.endsWith(currency)) || '';
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const commands = buildCommands();
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    return;
  }
  const guilds = await client.guilds.fetch();
  await Promise.all([...guilds.keys()].map((guildId) =>
    rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body: commands })
  ));
}

function providerWindowKey(maxAgeMinutes, cacheKey, now = new Date()) {
  const interval = Math.max(2, Number(maxAgeMinutes) || 15);
  const bucket = Math.floor(now.getTime() / (interval * 60_000));
  return `${cacheKey}-${interval}-${bucket}`;
}

async function getSnapshot(guildId, settings, options = {}) {
  const request = typeof options === 'boolean' ? { forceProvider: options } : options;
  const maxAgeMinutes = Math.max(2, Number(request.maxAgeMinutes ?? settings.discoveryMinutes) || 15);
  const cacheKey = marketUniverseCacheKey(settings);
  const cached = await readMarketSnapshot(cacheKey);
  if (request.forceProvider) return fetchMarketUniverse(guildId, { settings, force: true, maxAgeMinutes, cacheKey });
  const age = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  if (cached?.assets?.length && age < maxAgeMinutes * 60_000) {
    return { ...cached, cacheHit: true, cacheAgeMs: age };
  }
  // The file claim coordinates duplicate Passenger roots. Only one process
  // may request a provider refresh in a configured interval.
  const windowKey = providerWindowKey(maxAgeMinutes, cacheKey);
  const window = await claimProviderWindow(windowKey, { processId: process.pid, requestedByGuild: guildId });
  if (!window.claimed) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshed = await readMarketSnapshot(cacheKey);
      if (refreshed?.assets?.length && refreshed.fetchedAt !== cached?.fetchedAt) {
        return { ...refreshed, source: `${refreshed.source || 'CoinGecko'} shared cache`, cacheHit: true, cacheAgeMs: Date.now() - new Date(refreshed.fetchedAt).getTime() };
      }
    }
    if (cached?.assets?.length) return { ...cached, source: `${cached.source || 'CoinGecko'} stale shared cache`, cacheHit: true, stale: true, cacheAgeMs: age };
    throw new Error('Another OmniMod Crypto worker owns this provider window and has not produced a market snapshot yet.');
  }
  const snapshot = await fetchMarketUniverse(guildId, { settings, force: false, maxAgeMinutes, cacheKey });
  updateRuntime({ lastProviderAt: snapshot.cacheHit ? runtime.lastProviderAt : new Date().toISOString(), providerWindow: windowKey });
  return snapshot;
}

function activeStatus(status) {
  return ['tracking', 'target_tracking'].includes(status);
}

async function executeGuildScan(guildId, options = {}) {
  const settings = await getGuildSettings(guildId);
  const restartRecovery = config.sharedPaperStatePath
    ? await recoverPaperOrders({ owner: 'crypto', statePath: config.sharedPaperStatePath, now: Date.now(), emergencyStop: config.sharedPaperEmergencyStop }) : null;
  await resolveResources(client, guildId);
  let tracker = await readTracker(guildId);
  let restartTrackerReconciliation = { status: 'not_configured', linked: 0, missing: 0, ownerMismatch: 0, activeDivergence: 0, statusChanges: 0 };
  if (config.sharedPaperStatePath) {
    try {
      const reconciled = await reconcileSharedPaperOrders({ owner: 'crypto', predictions: tracker.predictions, config,
        now: Date.now(), activeStatuses: ['tracking', 'target_tracking'] });
      tracker.predictions = reconciled.predictions;
      const { predictions: _predictions, ...summary } = reconciled;
      restartTrackerReconciliation = summary;
      if (summary.statusChanges > 0) await writeTracker(guildId, tracker);
    } catch (error) {
      restartTrackerReconciliation = { ...restartTrackerReconciliation, status: 'unavailable', error: String(error.message || error).slice(0, 160) };
    }
  }
  let now = new Date();
  const marketStarted = performance.now();
  let snapshot;
  try {
    snapshot = await getSnapshot(guildId, settings, {
      forceProvider: Boolean(options.forceProvider),
      maxAgeMinutes: options.maxAgeMinutes ?? settings.discoveryMinutes
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      try { Object.defineProperty(error, 'scanStage', { value: 'market_snapshot', configurable: true }); } catch { /* Preserve the provider failure. */ }
    }
    throw error;
  }
  const marketSnapshotMs = Math.round(performance.now() - marketStarted);
  now = new Date();
  const snapshotById = new Map((snapshot.assets || []).map((asset) => [asset.id, asset]));
  const preliminarySettings = { ...settings, minScore: Math.max(50, settings.minScore - 12) };
  const discoveryStarted = performance.now();
  const freshnessScreenOptions = { requireDiscoveryTimestamp: true, staleSnapshot: Boolean(snapshot.stale), now,
    maxDiscoveryQuoteAgeMs: config.maxDiscoveryAssetAgeMinutes * 60_000 };
  const discoveryScreen = options.allowNewSignals === false ? { candidates: [], rejections: [] }
    : screenMomentumDetailed(snapshot, preliminarySettings, freshnessScreenOptions);
  const preliminaryCandidates = discoveryScreen.candidates;
  const providerCoverageStarted = performance.now();
  const coverageScreen = options.allowNewSignals === false ? { available: false, candidates: preliminaryCandidates, rejections: [] }
    : await screenSpotPairCoverage(preliminaryCandidates, { minProviders: settings.minProviderConfirmations });
  const providerCoverageMs = Math.round(performance.now() - providerCoverageStarted);
  const deepAnalysisCandidates = coverageScreen.candidates;
  const preliminary = deepAnalysisCandidates.slice(0, settings.maxProviderCandidates);
  const venueSelection = options.allowNewSignals === false ? { assets: [], rejections: [] }
    : selectVenueResearchAssets(snapshot, preliminary, settings, now.getTime());
  const venueResearchIds = new Set(venueSelection.assets.map((asset) => asset.id));
  const deepResearchAssets = [...preliminary, ...venueSelection.assets];
  // New Kraken-dependent candidates otherwise wait until the next scan: the
  // hub used to subscribe only after this scan's confirmation had finished.
  if (settings.realtimeEnabled && options.allowNewSignals !== false) realtimeHub.start(deepResearchAssets);
  const rejectionRows = [...discoveryScreen.rejections, ...coverageScreen.rejections, ...deepAnalysisCandidates.slice(settings.maxProviderCandidates)
    .map((asset) => ({ symbol: asset.symbol, assetId: asset.id, stage: 'discovery_cap', code: 'deep_analysis_cap' }))];
  const discoveryMs = Math.round(performance.now() - discoveryStarted);
  const openAssets = (tracker.predictions || [])
    .filter((prediction) => activeStatus(prediction.status))
    .map((prediction) => resolveCryptoAsset(prediction, snapshotById))
    .filter(Boolean);
  const requestedAssets = [...new Map([...openAssets, ...deepResearchAssets].map((asset) => [asset.id, asset])).values()]
    .map((asset) => ({ ...asset, requiresVerifiedIdentity: true }));
  const activeEventRisks = settings.eventVetoEnabled ? await listEventRisks(guildId, now) : [];
  const catalystSources = new Set(config.catalystSource.split('+'));
  const validCatalystSources = new Set(['manual', 'finnhub', 'news', 'finnhub+news']);
  if (!validCatalystSources.has(config.catalystSource)) throw new Error('CRYPTO_CATALYST_SOURCE must be manual, finnhub, news, or finnhub+news.');
  const macroCalendarSelected = catalystSources.has('finnhub');
  const macroCalendarNeeded = macroCalendarSelected && options.allowNewSignals !== false && deepResearchAssets.length > 0;
  const macroCalendarStarted = performance.now();
  const macroCalendar = await loadCryptoMacroCalendar({
    enabled: macroCalendarNeeded, token: config.finnhubApiKey, now,
    skipReason: macroCalendarSelected ? options.allowNewSignals === false ? 'monitor_only' : 'no_discovery_candidates'
      : catalystSources.has('news') ? 'news_only_mode' : 'manual_mode'
  });
  const macroCalendarMs = Math.round(performance.now() - macroCalendarStarted);
  activeEventRisks.push(...macroCalendar.events);
  const cryptoNewsSelected = catalystSources.has('news');
  const cryptoNewsNeeded = cryptoNewsSelected && options.allowNewSignals !== false && deepResearchAssets.length > 0;
  const cryptoNewsStarted = performance.now();
  const cryptoNews = await loadFinnhubCryptoNews({ enabled: cryptoNewsNeeded, token: config.finnhubApiKey, now,
    skipReason: cryptoNewsSelected ? options.allowNewSignals === false ? 'monitor_only' : 'no_discovery_candidates' : 'not_selected' });
  const cryptoNewsMs = Math.round(performance.now() - cryptoNewsStarted);
  const krakenDependentIds = new Set(coverageScreen.krakenDependentAssetIds || []);
  const krakenDependentSymbols = deepResearchAssets.filter((asset) => krakenDependentIds.has(asset.id) || venueResearchIds.has(asset.id))
    .map((asset) => asset.symbol);
  const realtimeWarmupStarted = performance.now();
  const realtimeWarmup = settings.realtimeEnabled && options.allowNewSignals !== false
    ? await realtimeHub.waitForExecutableKrakenQuotes(krakenDependentSymbols)
    : { status: 'disabled', requested: krakenDependentSymbols.length, ready: 0, waitedMs: 0 };
  const realtimeWarmupMs = Math.round(performance.now() - realtimeWarmupStarted);
  const microstructureBySymbol = new Map(requestedAssets.map((asset) => [
    String(asset.symbol).toUpperCase(), settings.microstructureEnabled ? realtimeHub.getMicrostructure(asset.symbol) : null
  ]));
  const enrichmentStarted = performance.now();
  const confirmation = await enrichMarketAssets(requestedAssets, {
    technicalAssetIds: new Set(deepResearchAssets.map((asset) => asset.id)),
    bitcoinAsset: (snapshot.assets || []).find((asset) => asset.id === 'bitcoin'), concurrency: 3,
    minimumScore: settings.minScore, rewardRisk: settings.minRiskReward, roundTripFeeBps: settings.estimatedRoundTripBps,
    derivativesEnabled: settings.derivativesEnabled, microstructureBySymbol,
    realtimeQuoteBySymbol: new Map(requestedAssets.map((asset) => [
      String(asset.symbol).toUpperCase(), settings.realtimeEnabled ? realtimeHub.getExecutableKrakenQuote(asset.symbol) : null
    ])),
    eventRisks: activeEventRisks, globalMarketContext: snapshot.globalMarketContext, settings, now, clock: Date.now
  });
  const enrichmentMs = Math.round(performance.now() - enrichmentStarted);
  const confirmedById = new Map(confirmation.assets.map((asset) => [asset.id, asset]));
  const providerOperationFailures = [...confirmation.providerErrors, ...confirmation.assets.flatMap((asset) => asset.marketData?.errors || [])]
    .map((error) => String(error).split(':')[0].trim().slice(0, 60) || 'unknown')
    .reduce((counts, provider) => counts.set(provider, (counts.get(provider) || 0) + 1), new Map());
  const confirmedScreen = options.allowNewSignals === false ? { candidates: [], rejections: [] } : screenMomentumDetailed({
    assets: preliminary.map((asset) => confirmedById.get(asset.id) || asset)
  }, settings, { ...freshnessScreenOptions, requireConfirmation: true, collectAllRejections: true });
  const rawCandidates = confirmedScreen.candidates;
  const validationRejectionRows = confirmedScreen.rejections.map((row) => {
    if (row.code !== 'strategy_validation') return row;
    const asset = confirmedById.get(row.assetId) || snapshotById.get(row.assetId);
    const validation = asset?.marketData?.validation;
    return { ...row, detailCodes: assessStrategyValidation(validation).reasons,
      evidence: { candleProvider: asset?.marketData?.candleProvider || null,
        candleCount: asset?.marketData?.candleCount ?? null,
        missingIntervals: asset?.marketData?.candleCoverage?.missingIntervals ?? null,
        lastCompletedAt: asset?.marketData?.candleCoverage?.lastCompletedAt ?? null,
        costRoundTripBps: validation?.costModel?.roundTripBps ?? null,
        recentTrades: validation?.recent?.trades ?? null,
        overallTrades: validation?.overall?.trades ?? null,
        recentSignalDays: validation?.coverage?.recent?.signalDays ?? null,
        overallSignalDays: validation?.coverage?.overall?.signalDays ?? null } };
  });
  rejectionRows.push(...validationRejectionRows);
  const validationFailureCounts = countValidationFailureReasons(validationRejectionRows);
  const validationCostSensitivity = summarizeValidationCostSensitivity(confirmation.assets.filter((asset) =>
    preliminary.some((candidate) => candidate.id === asset.id)));
  const validationAdvisoryScreen = options.allowNewSignals === false ? { candidates: [], rejections: [] }
    : screenMomentumDetailed({ assets: preliminary.map((asset) => confirmedById.get(asset.id) || asset) }, settings,
      { ...freshnessScreenOptions, requireConfirmation: true, validationAdvisory: true, collectAllRejections: true });
  const strictCandidateIds = new Set(rawCandidates.map((asset) => asset.id));
  const validationAdvisoryCandidates = validationAdvisoryScreen.candidates.filter((asset) =>
    asset.model?.validationPassed === false && !strictCandidateIds.has(asset.id));
  const approvalStarted = performance.now();
  const assetsById = new Map((snapshot.assets || []).map((asset) => {
    const observed = confirmedById.get(asset.id) || asset;
    const model = scoreAsset(observed);
    return [asset.id, { ...observed, model }];
  }));
  const venueResearchAssets = venueSelection.assets.map((asset) => {
    const observed = confirmedById.get(asset.id) || asset;
    return { ...observed, model: scoreAsset(observed) };
  });
  const venueResearchScreen = screenMomentumDetailed({ assets: venueResearchAssets }, settings,
    { ...freshnessScreenOptions, requireConfirmation: true, collectAllRejections: true });
  const events = [];
  tracker.predictions = (tracker.predictions || []).map((prediction) => {
    if (!activeStatus(prediction.status)) return prediction;
    const asset = resolveCryptoAsset(prediction, assetsById);
    if (!asset) return prediction;
    const evaluated = evaluatePrediction(prediction, asset, now);
    events.push(...evaluated.events);
    return evaluated.prediction;
  });

  const venueResearchMonitoring = await refreshVenueResearchOutcomes().catch(() => ({ status: 'unavailable' }));
  await resolvePendingObservations([...assetsById.values(), ...venueResearchAssets], new Date()).catch(() => []);
  const registry = await maybeTrainAndStageModels(settings, now).catch(() => readModelRegistry());
  const metaBundle = registry.production?.meta || null;
  const outcomeBundle = registry.production?.outcomes || null;
  const guard = await getRiskGuard(guildId, tracker.predictions, settings, now);
  const portfolio = applyPortfolioRisk(rawCandidates, tracker.predictions, [...assetsById.values()], settings);
  const advisoryPortfolio = applyPortfolioRisk(validationAdvisoryCandidates, tracker.predictions, [...assetsById.values()], settings);
  const candidates = guard.allowNewSignals ? portfolio.selected : [];
  rejectionRows.push(...portfolio.rejected.map((row) => ({ symbol: row.asset.symbol, assetId: row.asset.id,
    stage: 'risk_approval', code: String(row.reason || 'portfolio_limit').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_').slice(0, 60) })));
  if (!guard.allowNewSignals) {
    rejectionRows.push(...rawCandidates.map((asset) => ({ symbol: asset.symbol, assetId: asset.id, stage: 'risk_approval', code: 'risk_guard' })));
  }
  const approvalMs = Math.round(performance.now() - approvalStarted);

  let shadowRows = [];
  let shadowResearch = summarizeShadowResearchRecording([], null, { enabled: options.allowNewSignals !== false });
  const confirmationCandidateIds = new Set(rawCandidates.map((asset) => asset.id));
  if (options.allowNewSignals !== false) {
    const researchAssets = [...preliminary.map((asset) => assetsById.get(asset.id)).filter(Boolean), ...venueResearchAssets];
    shadowRows = researchAssets.map((asset) => {
      const productionPrediction = buildPrediction(asset, settings, guildId, now, config.timezone,
        tracker.predictions, { metaBundle, outcomeBundle });
      const observedAt = new Date();
      const sourcePinned = buildSourcePinnedShadowPrediction(asset, settings, guildId, observedAt,
        config.timezone, tracker.predictions, { metaBundle, outcomeBundle });
      const sourceQuote = sourcePinned?.quote || null;
      const prediction = sourcePinned?.prediction || productionPrediction;
      return {
        observationId: createObservationId(guildId, venueResearchIds.has(asset.id) ? `venue-${asset.id}` : prediction.symbol, prediction.horizonKey, observedAt),
        ...(venueResearchIds.has(asset.id) ? { researchCohort: 'full-venue-discovery-v1', excludedFromProductionLearning: true,
          pairRoutingVersion: asset.marketData?.assetIdentity?.pairRouting?.version || null,
          discoveryEvidence: asset.venueDiscovery, productionGateRejections: venueResearchScreen.rejections.filter((row) => row.assetId === asset.id) } : {}),
        guildId, assetId: prediction.assetId, symbol: prediction.symbol, score: prediction.score,
        createdAt: observedAt.toISOString(),
        candleProvider: asset.marketData?.candleProvider || null,
        candlePair: asset.marketData?.candlePair || null,
        entryEvidenceVersion: sourcePinned?.entryEvidenceVersion || null,
        entryQuoteBasis: sourceQuote ? 'same_source_ask' : null,
        entryQuoteProvider: sourceQuote?.provider || null, entryQuotePair: sourceQuote?.pair || null,
        entryQuoteObservedAt: sourceQuote?.observedAt || null, entryQuoteAgeMs: sourceQuote?.ageMs ?? null,
        entryQuoteBid: sourceQuote?.bid ?? null, entryQuoteAsk: sourceQuote?.ask ?? null,
        counterfactuals: asset.model.liquidityShadow ? { ...asset.model.liquidityShadow,
          productionScore: asset.model.score, productionRank: asset.rank } : null,
        horizonKey: prediction.horizonKey, assetClass: prediction.assetClass, regimeKey: prediction.regimeKey,
        ...classifyResearchMetadata(asset, now, settings, registry),
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        features: prediction.modelFeatures, entryPrice: prediction.entryPrice, targetPrice: prediction.targetPrice,
        stopPrice: prediction.stopPrice, partialTargetPrice: prediction.partialTargetPrice,
        estimatedCostPct: sourcePinned?.estimatedCostPct ?? prediction.estimatedCostPct,
        deadlineAt: prediction.deadlineAt,
        qualifiedAtCreation: !venueResearchIds.has(asset.id) && productionPrediction.expectedProfitable,
        approvalRejections: [...productionPrediction.approvalRejections,
          ...(venueResearchIds.has(asset.id) ? ['unvalidated_discovery_cohort'] : [])],
        rejectionReasons: [
          ...(asset.model.validationPassed ? [] : ['walk-forward validation']),
          ...(asset.marketData?.conflicted ? ['provider conflict'] : []),
          ...(asset.marketData?.derivatives?.blockLongs ? ['derivatives crowding'] : []),
          ...(asset.marketData?.execution?.blockTrade ? ['execution-cost gate'] : []),
          ...(asset.marketData?.eventRisk?.blocked ? ['crypto event veto'] : []),
          ...(prediction.metaAbstained ? ['uncertainty/OOD abstention'] : []),
          ...(guard.allowNewSignals ? [] : ['risk guard']),
          ...(portfolio.rejected.find((row) => row.asset.id === asset.id)?.reason ? ['portfolio correlation/cap'] : [])
        ]
      };
    });
    for (const row of shadowRows) {
      if (!confirmationCandidateIds.has(row.assetId) || row.qualifiedAtCreation) continue;
      for (const code of row.approvalRejections) rejectionRows.push({ symbol: row.symbol, assetId: row.assetId, stage: 'strategy_approval', code });
    }
    const sourcePinnedRows = shadowRows.filter((row) => row.candleProvider && row.candlePair
      && row.entryQuoteBasis === 'same_source_ask');
    let newlyRecorded = null;
    let researchWriteFailed = false;
    try { newlyRecorded = await recordShadowCandidates(sourcePinnedRows, now); }
    catch { researchWriteFailed = true; }
    shadowResearch = summarizeShadowResearchRecording(shadowRows, newlyRecorded, { writeFailed: researchWriteFailed });
    await pruneResearch(settings.researchRetentionDays, now).catch(() => 0);
    await pruneMicrostructure(settings.researchRetentionDays, now).catch(() => 0);
  }

  const dateKey = localDateKey(now, config.timezone);
  const todaysCount = tracker.predictions.filter((item) => item.dateKey === dateKey).length;
  const slots = Math.max(0, settings.maxSignals - todaysCount);
  const paperQuotes = await refreshCryptoPaperQuotes([...assetsById.values()], { maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs });
  const executableQuotesByIdentity = paperQuotes.quotesByKey;
  rejectionRows.push(...paperQuotes.rejections);
  let sharedPaperMarkDiagnostics = { status: isSharedPaperConfigured(config) ? 'not_started' : 'not_configured', expectedPositions: 0, quotesProvided: 0, quoteMissing: 0, quoteRejected: 0 };
  if (config.sharedPaperStatePath) {
    sharedPaperMarkDiagnostics = await markSharedPaperOrders({ owner: 'crypto', quotesBySymbol: executableQuotesByIdentity, config, sessionOpen: true })
      .catch((error) => {
        sharedPaperMarkDiagnostics = { status: 'provider_or_ledger_error', error: String(error.message || error).slice(0, 160), expectedPositions: 0, quotesProvided: executableQuotesByIdentity.size, quoteMissing: 0, quoteRejected: 0 };
        logEvent(client, guildId, `Shared paper monitoring failed for this scan: ${String(error.message || error).slice(0, 160)}`, { title: 'Paper monitor unavailable', color: COLORS.orange }).catch(() => {});
        return sharedPaperMarkDiagnostics;
      });
  }
  let forwardShadowResults = [];
  let forwardShadowError = null;
  if (config.sharedPaperStatePath) {
    try {
      const shadowProfiles = [
        { id: 'production-exits', overrides: { stopScale: 1, targetScale: 1 }, hypothesis: 'The current exit rules retain favorable after-cost expectancy.', changeMade: 'No exit change; mirror production-selected candidates.', reason: 'Provide a contemporaneous shadow baseline.' },
        { id: 'wider-target', overrides: { stopScale: 1, targetScale: 1.2 }, hypothesis: 'A wider target improves net expectancy despite fewer target hits.', changeMade: 'Increase target distance by 20 percent.', reason: 'Measure whether current exits truncate favorable movement.' },
        { id: 'tighter-stop', overrides: { stopScale: 0.8, targetScale: 1 }, hypothesis: 'A tighter stop improves net expectancy after costs.', changeMade: 'Reduce stop distance by 20 percent.', reason: 'Test stop placement without changing production approval.' },
        { id: 'validation-advisory', overrides: { stopScale: 1, targetScale: 1 }, hypothesis: 'Validation-rejected candidates may show positive after-cost expectancy.', changeMade: 'Observe advisory candidates in an isolated paper cohort.', reason: 'Quantify abstention cost without weakening production validation.' },
      ];
      const toShadowInput = (asset) => ({
        instrumentKey: String(asset.symbol).toUpperCase(),
        prediction: buildPrediction(asset, settings, guildId, now, config.timezone, tracker.predictions, { metaBundle, outcomeBundle }),
        asset,
      });
      const shadowInputs = candidates.map(toShadowInput);
      const advisoryShadowInputs = guard.allowNewSignals ? advisoryPortfolio.selected.map(toShadowInput) : [];
      const policy = sharedPaperPolicy(config, now.getTime());
      forwardShadowResults = await runForwardShadowPaper({
        owner: 'crypto', strategyVersion: 'crypto-intraday-paper-v8-native-book-evidence', profiles: shadowProfiles,
        monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: config.paperMonitor.intervalSeconds },
        allowlist: ['stopScale', 'targetScale'], baseConfig: {},
        observationsByProfile: { 'validation-advisory': advisoryShadowInputs },
        observations: shadowInputs, quotesByInstrument: executableQuotesByIdentity,
        evaluate: (observation, variant, decisionAt) => {
          const prediction = observation.prediction, asset = observation.asset;
          const entry = Number(prediction.entryPrice);
          const result = buildPrimarySignalCandidate({
            owner: 'crypto', assetClass: 'crypto', symbol: prediction.symbol,
            strategyId: `crypto:${prediction.horizonKey || 'intraday'}`,
            signalId: prediction.id,
            sessionDate: dateKey, sessionTimeZone: config.timezone,
            quote: paperQuotes.entryByAssetId.get(prediction.assetId) || null,
            now: decisionAt, entryLow: prediction.entryLow, entryHigh: prediction.entryHigh,
            stopPct: Number(prediction.stopPct) * variant.stopScale,
            targetPct: Number(prediction.targetPct) * variant.targetScale,
            forceExitAt: prediction.deadlineAt, maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, sessionOpen: true,
            roundTripFeesPerUnit: entry * Number(config.estimatedRoundTripBps) / 10_000,
            slippageReservePerUnit: entry * Number(config.maxExecutionSlippageBps) / 10_000,
            signal: { guildId, horizon: prediction.horizonKey, score: prediction.score, probability: prediction.probability,
              assetId: asset.id },
          });
          return result.status === 'candidate' ? result : { status: 'no-setup', reasons: result.reasons };
        },
        stateDirectory: `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`, portfolioStatePath: config.sharedPaperStatePath, now: Date.now(), observationClock: Date.now,
        accountEquity: config.sharedPaperAccountEquity, riskPolicy: policy,
        maxQuoteAgeMs: policy.maxQuoteAgeMs, maxSpreadPct: policy.maxSpreadPct, sessionOpen: true, sessionDate: dateKey,
      });
    } catch (error) { forwardShadowError = errorMessage(error).slice(0, 180); }
  }
  let sharedPaperReconciliation = restartTrackerReconciliation;
  if (isSharedPaperConfigured(config)) {
    try {
      const reconciled = await reconcileSharedPaperOrders({ owner: 'crypto', predictions: tracker.predictions, config,
        now: now.getTime(), activeStatuses: ['tracking', 'target_tracking'] });
      tracker.predictions = reconciled.predictions;
      const { predictions: _predictions, ...summary } = reconciled;
      sharedPaperReconciliation = summary;
    } catch (error) {
      sharedPaperReconciliation = { ...sharedPaperReconciliation, status: 'unavailable', error: String(error.message || error).slice(0, 160) };
    }
  }
  let proposed = options.allowNewSignals === false
    ? []
    : buildPredictions(candidates.slice(0, slots), { ...settings, maxSignals: slots }, guildId, now, config.timezone, tracker.predictions,
      { metaBundle, outcomeBundle, recentMarketNews: cryptoNewsSelected ? cryptoNews.items : undefined });
  const sharedReservations = new Map();
  if (isSharedPaperConfigured(config) && proposed.length) {
    const approved = [];
    for (const prediction of proposed) {
      const asset = resolveCryptoAsset(prediction, assetsById);
      const executionQuote = paperQuotes.entryByAssetId.get(prediction.assetId);
      const entry = Number(prediction.entryPrice);
      const shared = buildPrimarySignalCandidate({
        owner: 'crypto', assetClass: 'crypto', symbol: prediction.symbol, strategyId: `crypto:${prediction.horizonKey || 'intraday'}`,
        signalId: prediction.id, sessionDate: dateKey, sessionTimeZone: config.timezone,
        quote: executionQuote || null,
        now: Date.now(), entryLow: prediction.entryLow, entryHigh: prediction.entryHigh,
        stopPct: Number(prediction.stopPct), targetPct: Number(prediction.targetPct),
        forceExitAt: prediction.deadlineAt, maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, sessionOpen: true,
        roundTripFeesPerUnit: entry * Number(config.estimatedRoundTripBps) / 10_000,
        slippageReservePerUnit: entry * Number(config.maxExecutionSlippageBps) / 10_000,
        researchContext: { setupType: `momentum_${prediction.horizonKey || 'intraday'}`,
          marketRegime: prediction.marketRegime || asset?.marketData?.regime?.label,
          volatilityRegime: asset?.marketData?.regime?.volatilityRegime,
          regimeSource: 'btc_market_regime', observedAt: executionQuote?.time,
          features: { setup_score: prediction.score, rsi14: asset?.model?.rsi14,
            adx14: asset?.model?.adx14, atr_pct: asset?.model?.atrPct,
            relative_volume: asset?.model?.relativeVolume, volume_z_score: asset?.model?.volumeZScore,
            order_book_imbalance: asset?.model?.orderBookImbalance } },
        marketGateTrace: { source: 'market_candidate_emission', owner: 'crypto',
          strategyId: `crypto:${prediction.horizonKey || 'intraday'}`, observedAt: executionQuote?.time,
          passedGates: ['strict_momentum_screen', 'risk_guard_allowed', 'portfolio_selected'] },
        signal: { guildId, assetId: prediction.assetId, horizon: prediction.horizonKey, score: prediction.score, probability: prediction.probability }
      });
      if (shared.status !== 'candidate') {
        rejectionRows.push({ symbol: prediction.symbol, assetId: prediction.assetId, stage: 'shared_portfolio_risk', code: shared.reasons[0] || 'invalid_candidate' });
        continue;
      }
      try {
        const reservation = await reserveSharedPaperCandidate(shared.candidate, config);
        if (reservation.status !== 'reserved') {
          rejectionRows.push({ symbol: prediction.symbol, assetId: prediction.assetId, stage: 'shared_portfolio_risk', code: (reservation.reasons || [reservation.reason || reservation.status])[0] });
          continue;
        }
        prediction.sharedPaperOrderId = reservation.order.orderId;
        prediction.sharedPaperStatus = 'reserved';
        sharedReservations.set(prediction.id, reservation.order.orderId);
        approved.push(prediction);
      } catch (error) {
        rejectionRows.push({ symbol: prediction.symbol, assetId: prediction.assetId, stage: 'shared_portfolio_risk', code: 'ledger_error' });
        logEvent(client, guildId, `Shared paper ledger unavailable; ${prediction.symbol} was not posted. ${String(error.message || error).slice(0, 160)}`, { title: 'Paper risk ledger unavailable', color: COLORS.orange }).catch(() => {});
      }
    }
    proposed = approved;
  }
  const dailyCapacityRows = dailyCapacityRejections(candidates, slots);
  rejectionRows.push(...dailyCapacityRows);
  const mergeCandidates = mergeNewPredictions(tracker, proposed);
  for (const row of mergeCandidates.rejected) {
    rejectionRows.push({ symbol: row.prediction.symbol, assetId: row.prediction.assetId, stage: 'notification_suppression', code: row.reason });
  }
  const delivery = await deliverPredictionsSafely(mergeCandidates.added,
    (prediction) => postNewPrediction(client, guildId, prediction), async (updated) => {
      tracker = mergeNewPredictions(tracker, [updated]);
      tracker.updatedAt = now.toISOString();
      await writeTracker(guildId, tracker);
    });
  const posted = delivery.delivered;
  const undelivered = [...delivery.failures, ...delivery.persistenceFailures];
  for (const row of undelivered) {
    const orderId = sharedReservations.get(row.prediction.id);
    if (orderId) await transitionPaperOrder(orderId, 'cancelled', { statePath: config.sharedPaperStatePath }).catch(() => {});
  }
  const deliveryFailures = delivery.failures.length;
  for (const row of delivery.failures) rejectionRows.push({ symbol: row.prediction.symbol, assetId: row.prediction.assetId, stage: 'delivery', code: row.reason });
  for (const row of delivery.persistenceFailures) rejectionRows.push({ symbol: row.prediction.symbol, assetId: row.prediction.assetId, stage: 'storage', code: row.reason });
  // Successful calls are saved immediately after Discord confirms delivery.
  // Failed sends remain eligible for a later scan instead of becoming open,
  // invisible paper trades.
  const outcomeQueue = mergePendingOutcomeDeliveries(tracker.pendingOutcomeDeliveries, events);
  tracker.pendingOutcomeDeliveries = outcomeQueue;
  // Persist the outbox before attempting delivery so scan restarts can retry.
  tracker.updatedAt = now.toISOString();
  await writeTracker(guildId, tracker);
  const outcomeDelivery = await deliverPredictionsSafely(outcomeQueue, async (outcome) => {
    await postOutcome(client, guildId, outcome);
    return outcome;
  });
  for (const row of outcomeDelivery.failures) rejectionRows.push({ symbol: row.prediction.prediction.symbol,
    assetId: row.prediction.prediction.assetId, stage: 'delivery', code: 'discord_outcome_send_failed' });
  tracker.pendingOutcomeDeliveries = removeDeliveredOutcomeDeliveries(outcomeQueue, outcomeDelivery.delivered);
  const outcomeDeliveryFailures = outcomeDelivery.failures.length;
  tracker.updatedAt = now.toISOString();
  await writeTracker(guildId, tracker);
  if (posted.length) {
    try {
      const handoff = await publishPrimaryResearchSignals('crypto', posted, { now: now.getTime() });
      if (handoff.rowsRejected) await logEvent(client, guildId,
        `Cross-bot research handoff wrote ${handoff.rowsWritten} signal(s) and rejected ${handoff.rowsRejected}: ${handoff.rejectionCounts.explicit_no_action} explicit no-action, ${handoff.rejectionCounts.ambiguous_direction} ambiguous direction, ${handoff.rejectionCounts.other_invalid_record} other invalid record(s).`,
        { title: 'Cross-bot signal quality', color: COLORS.orange });
    } catch (error) {
      logEvent(client, guildId, `Primary signal research handoff could not be saved: ${String(error.message || error).slice(0, 140)}`, { title: 'Cross-bot research handoff unavailable', color: COLORS.orange }).catch(() => {});
    }
  }

  const dayTradingWatches = options.allowNewSignals === false ? [] : buildDayTradingWatches(validationAdvisoryScreen.candidates, tracker.predictions.filter(row => activeStatus(row.status)), new Date());
  const watchNoticeState = await readJson(paths.dayTradingWatchNotices(guildId), null);
  const newWatchRows = unannouncedDayTradingWatches(dayTradingWatches, watchNoticeState, dateKey);
  if (!String(options.reason || '').startsWith('opening:') && newWatchRows.length) {
    try {
      await postDayTradingWatchUpdate(client, guildId, { dateKey, assetsScreened: snapshot.assets?.length || 0, watches: newWatchRows, guardPaused: guard.paused });
      await writeJson(paths.dayTradingWatchNotices(guildId), recordDayTradingWatchDelivery(watchNoticeState, newWatchRows, dateKey));
    } catch (error) {
      logEvent(client, guildId, 'Day-trading watch delivery was not confirmed; it remains eligible for retry.', { title: 'Watch delivery unavailable', color: COLORS.orange }).catch(() => {});
    }
  }

  const result = {
    guildId, dateKey, generatedAt: now.toISOString(), timezone: config.timezone,
    source: `${snapshot.source} + Binance/Coinbase/Kraken spot + derivatives confirmation`, stale: Boolean(snapshot.stale), providerError: snapshot.providerError || '',
    marketRegime: confirmation.regime,
    assetsScreened: snapshot.assets?.length || 0, candidates, dayTradingWatches, predictions: posted,
    outcomes: outcomeDelivery.delivered,
    scanDecision: {
      preliminary: preliminary.length, confirmed: rawCandidates.length,
      portfolioSelected: portfolio.selected.length,
      guardPaused: guard.paused, guardReasons: guard.reasons.slice(0, 3),
      evidenceStatus: guard.evidenceStatus
    },
    diagnostics: {
      liveTradingEnabled: false,
      liveTradingRequested: process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true',
      orderRoutingAvailable: false,
      reason: options.reason || 'scheduled', stale: Boolean(snapshot.stale), cacheHit: Boolean(snapshot.cacheHit),
      restartRecovery,
      discoveryEnabled: options.allowNewSignals !== false,
      sharedPaperStatus: isSharedPaperConfigured(config)
        ? config.sharedPaperEmergencyStop ? 'configured; emergency stop active' : 'configured; paper monitoring active'
        : 'not configured; legacy signal tracking only',
      sharedPaperMarkDiagnostics,
      sharedPaperQuoteIdentity: paperQuotes.diagnostics,
      sharedPaper: await getSharedPaperDiagnostics(config, { sessionDate: dateKey, now: Date.now() }),
      sharedPaperReconciliation,
      portfolioCorrelation: portfolio.correlationDiagnostics,
      forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
      forwardShadowError,
      source: snapshot.source, providerError: safeProviderErrorSummary(snapshot.providerError),
      universeCoverage: summarizeUniverseCoverage(snapshot, settings),
      venueResearch: { cohort: 'full-venue-discovery-v1', candidates: snapshot.venueCandidates?.length || 0,
        monitoring: venueResearchMonitoring,
        deepRequested: venueSelection.assets.length, analyzed: venueResearchAssets.filter((asset) => asset.marketData?.technicals?.dataSufficient).length,
        sourcePinned: shadowRows.filter((row) => row.researchCohort === 'full-venue-discovery-v1' && row.entryQuoteBasis === 'same_source_ask').length,
        productionGatePassed: venueResearchScreen.candidates.length, approvedSetups: 0,
        rejections: [...venueSelection.rejections, ...venueResearchScreen.rejections], excludedFromProductionLearning: true },
      globalMarketContext: snapshot.globalMarketContext || null,
      macroEventCalendar: macroCalendar.diagnostics,
      recentCryptoMarketNews: cryptoNews.diagnostics,
      providerOperationFailures: Object.fromEntries(providerOperationFailures),
      funnel: {
        universe: snapshot.assets?.length || 0,
        discoveryFreshness: { ...(discoveryScreen.stageCounts || {}), snapshotStale: Boolean(snapshot.stale),
          maximumAssetAgeMs: config.maxDiscoveryAssetAgeMinutes * 60_000 },
        identityRejected: discoveryScreen.stageCounts?.identityRejected || 0,
        nonStable: discoveryScreen.stageCounts?.nonStable || 0, rankPassed: discoveryScreen.stageCounts?.rankPassed || 0,
        liquidityPassed: discoveryScreen.stageCounts?.liquidityPassed || 0, scorePassed: discoveryScreen.stageCounts?.scorePassed || 0,
        trendPassed: discoveryScreen.stageCounts?.trendPassed || preliminaryCandidates.length,
        discoveryQualified: preliminaryCandidates.length,
        providerCoverage: { available: coverageScreen.available, venues: coverageScreen.venues || [],
          supportedVenueCounts: coverageScreen.supportedVenueCounts || {},
          rejected: coverageScreen.rejections.length, passed: deepAnalysisCandidates.length,
          deepAnalysisCandidates: preliminary.length,
          krakenDependentDeepCandidates: krakenDependentSymbols.length,
          krakenWebsocketWarmup: realtimeWarmup,
          laterQuoteConfirmationRejected: new Set(confirmedScreen.rejections
            .filter((row) => row.code === 'provider_confirmation').map((row) => row.assetId || row.symbol)).size,
          interpretation: 'Directory coverage is a preflight only; timestamped live quotes determine provider confirmation.' },
        deepAnalysisCap: preliminary.length,
        validationFailureCounts,
        validationCostSensitivity,
        deepAnalysisSymbols: requestedAssets.length, confirmationPassed: rawCandidates.length,
        modelApproved: shadowRows.filter((row) => confirmationCandidateIds.has(row.assetId) && row.qualifiedAtCreation).length,
        shadowResearch,
        riskSelected: candidates.length, setupsProposed: proposed.length, setupsPosted: posted.length,
        deliveryFailures, notificationPersistenceFailures: delivery.persistenceFailures.length,
        outcomeDeliveryFailures, pendingOutcomeDeliveries: tracker.pendingOutcomeDeliveries.length,
        duplicateSuppressions: mergeCandidates.rejected.length,
        riskRejections: countRiskRejections(portfolio.rejected, !guard.allowNewSignals, rawCandidates),
        dailyCapacityRejections: dailyCapacityRows.length,
        topRejectionReasons: Object.fromEntries(Object.entries(countUniqueRejectionReasons(rejectionRows)).slice(0, 12)),
        rejections: rejectionRows.slice(0, 500)
      },
      stageDurationsMs: { marketSnapshot: marketSnapshotMs, discovery: discoveryMs, providerCoverage: providerCoverageMs,
        macroCalendar: macroCalendarMs, cryptoNews: cryptoNewsMs, realtimeWarmup: realtimeWarmupMs,
        enrichment: enrichmentMs, modelAndRisk: Math.max(0, approvalMs) }
    },
    rejectedByPortfolio: portfolio.rejected, guard, modelRegistry: registry, metaModel: metaBundle,
    activeEventRisks: activeEventRisks.length, minimumScore: settings.minScore, tracker
  };
  updateRuntime({
    state: 'running', phase: 'idle', lastScanAt: now.toISOString(), lastScanReason: options.reason || 'scheduled',
    scansCompleted: runtime.scansCompleted + 1, lastError: snapshot.providerError || '',
    marketRegime: confirmation.regime?.label || 'Unknown', confirmationProviders: 'Binance/Coinbase/Kraken + futures',
    guardPaused: guard.paused, metaModelsActive: metaBundle?.activeModels || 0,
    challengerPending: Boolean(registry.challenger), activeEventRisks: activeEventRisks.length
  });
  return result;
}

export async function runGuildScan(guildId, options = {}) {
  if (scanPromises.has(guildId)) return scanPromises.get(guildId);
  const started = performance.now();
  const promise = withProviderTelemetry(() => executeGuildScan(guildId, options)).then(async ({ result, providers }) => {
    result.diagnostics.providers = providers;
    result.diagnostics.totalDurationMs = Math.round(performance.now() - started);
    const diagnosticRow = { ...result.diagnostics, generatedAt: result.generatedAt };
    await writeScanDiagnostic(guildId, diagnosticRow).catch((error) => updateRuntime({ diagnosticsError: errorMessage(error) }));
    updateRuntime({ lastScanDiagnostics: diagnosticRow, diagnosticsError: '' });
    return result;
  })
    .catch(async (error) => {
      const message = errorMessage(error);
      const generatedAt = new Date().toISOString();
      const providers = Object.fromEntries(Object.entries(error?.providerTelemetry || {}).map(([name, row]) => [name,
        { ...row, lastError: safeProviderErrorSummary(row.lastError) }]));
      const failure = safeProviderErrorSummary(message) || 'Unknown scan failure.';
      const diagnosticRow = createFailedScanDiagnostic({ generatedAt, failureStage: error?.scanStage || 'scan_execution',
        failure, durationMs: Math.max(0, Math.round(performance.now() - started)), providers });
      await writeScanDiagnostic(guildId, diagnosticRow)
        .then((saved) => updateRuntime({ lastScanDiagnostics: saved, diagnosticsError: '' }))
        .catch((diagnosticsError) => updateRuntime({ diagnosticsError: errorMessage(diagnosticsError) }));
      updateRuntime({ state: 'degraded', phase: 'scan_failed', lastError: failure });
      await logEvent(client, guildId, failure, { title: 'Crypto scan failed', color: COLORS.red, pingAdmin: true });
      throw error;
    })
    .finally(() => scanPromises.delete(guildId));
  scanPromises.set(guildId, promise);
  return promise;
}

async function runOpeningDiscovery(guildId, reason = 'scheduled') {
  const dateKey = localDateKey();
  const cached = await readDailyDiscovery(guildId, dateKey);
  if (cached) return cached;
  const claim = await claimDailyDiscovery(guildId, dateKey, { reason, processId: process.pid });
  if (!claim.claimed) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const shared = await readDailyDiscovery(guildId, dateKey);
      if (shared) return shared;
    }
    return null;
  }
  try {
    const scan = await runGuildScan(guildId, { reason: `opening:${reason}`, allowNewSignals: true });
    let investmentResearch;
    try {
      const settings = await getGuildSettings(guildId);
      const market = await readMarketSnapshot(marketUniverseCacheKey(settings));
      if (!isInvestmentSnapshotFresh({ ...market, stale: scan.stale })) {
        investmentResearch = { unavailable: 'Daily investment research skipped: liquidity snapshot is stale or unavailable.', results: [] };
      } else {
        investmentResearch = await researchInvestments((market.assets || []).filter((asset) => Number(asset.volume24h) >= settings.minVolumeUsd), {
          guildId, minVolumeUsd: settings.minVolumeUsd, roundTripFeeBps: settings.estimatedRoundTripBps,
          snapshotSource: market.source, snapshotFetchedAt: market.fetchedAt, globalMarketContext: scan.diagnostics.globalMarketContext
        });
      }
    } catch {
      investmentResearch = { unavailable: 'Daily investment research or private journal unavailable; inspect /crypto invest before relying on a watchlist.', results: [] };
    }
    const discovery = {
      guildId, dateKey, generatedAt: scan.generatedAt, timezone: scan.timezone, source: scan.source,
      assetsScreened: scan.assetsScreened, minimumScore: scan.minimumScore, investmentResearch,
      scanDecision: scan.scanDecision, dayTradingWatches: scan.dayTradingWatches,
      predictions: scan.tracker.predictions.filter((item) => item.dateKey === dateKey)
    };
    await writeDailyDiscovery(guildId, dateKey, discovery);
    const openingDelivery = await postOpeningSummary(client, guildId, discovery);
    if (openingDelivery.created && discovery.dayTradingWatches?.length) {
      const noticeState = await readJson(paths.dayTradingWatchNotices(guildId), null);
      await writeJson(paths.dayTradingWatchNotices(guildId), recordDayTradingWatchDelivery(noticeState, discovery.dayTradingWatches, dateKey));
    }
    await finishDailyDiscovery(guildId, dateKey, { predictionCount: discovery.predictions.length, source: discovery.source });
    return discovery;
  } catch (error) {
    await finishDailyDiscovery(guildId, dateKey, { failed: true, error: errorMessage(error) });
    throw error;
  }
}

async function schedulerTick() {
  if (!client.isReady() || shuttingDown) return;
  const guildIds = await listConfiguredGuildIds(client);
  for (const guildId of guildIds) {
    const settings = await getGuildSettings(guildId);
    const now = new Date();
    const dateKey = localDateKey(now);
    if (isDailyDiscoveryTime(now, settings) && lastDailyByGuild.get(guildId) !== dateKey) {
      lastDailyByGuild.set(guildId, dateKey);
      void runOpeningDiscovery(guildId, 'scheduler').catch(() => {});
    }
    const tracker = await readTracker(guildId);
    const hasOpenSignals = (tracker.predictions || []).some((item) => activeStatus(item.status));
    const previousMonitor = lastMonitorByGuild.get(guildId) || 0;
    const previousDiscovery = lastDiscoveryByGuild.get(guildId) || 0;
    const monitorDue = hasOpenSignals && now.getTime() - previousMonitor >= settings.monitorMinutes * 60_000;
    const discoveryDue = now.getTime() - previousDiscovery >= settings.discoveryMinutes * 60_000;
    if (monitorDue || discoveryDue) {
      if (monitorDue) lastMonitorByGuild.set(guildId, now.getTime());
      if (discoveryDue) lastDiscoveryByGuild.set(guildId, now.getTime());
      void runGuildScan(guildId, {
        reason: monitorDue && discoveryDue ? 'monitor+discovery' : monitorDue ? 'active-monitor' : 'discovery',
        allowNewSignals: discoveryDue,
        maxAgeMinutes: monitorDue ? settings.monitorMinutes : settings.discoveryMinutes
      }).catch(() => {});
    }
  }
}

function momentumEmbed(candidates, count, source) {
  const rows = candidates.slice(0, count);
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle('SHORT-TERM CRYPTO MOMENTUM BOARD')
    .setDescription(`Source: ${source}\nResearch and paper tracking only. No trade is executed.`).setTimestamp();
  if (!rows.length) embed.addFields({ name: 'No qualifying momentum', value: 'No liquid asset currently clears this server\'s score and trend filters.' });
  for (const asset of rows) {
    embed.addFields({
      name: `${asset.symbol} | ${asset.name} | ${asset.model.score.toFixed(1)}`,
      value: `${formatPrice(asset.price)} | 1h ${formatPercent(asset.change1h)} | 24h ${formatPercent(asset.change24h)} | Vol $${Math.round(asset.volume24h).toLocaleString()}\n${asset.model.trend} | RSI ${asset.model.rsi14.toFixed(1)} | ${asset.model.providerCount} sources | ${asset.model.regime?.label || 'unknown regime'} | ${asset.model.risk} risk`,
      inline: false
    });
  }
  return embed;
}

function trackerEmbed(predictions, title) {
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle(title).setTimestamp();
  if (!predictions.length) return embed.setDescription('No matching paper signals are stored.');
  for (const p of predictions.slice(0, 12)) {
    const move = p.entryPrice ? (p.currentPrice / p.entryPrice - 1) * 100 : 0;
    const paperResult = p.realizedR != null && Number.isFinite(Number(p.realizedR)) ? `${Number(p.realizedR) > 0 ? '+' : ''}${Number(p.realizedR).toFixed(2)}R` : 'not graded yet';
    embed.addFields({
      name: `${p.symbol} | ${paperOutcomeLabel(p.status)}`,
      value: `Entry ${formatPrice(p.entryPrice)} | Now ${formatPrice(p.currentPrice)} | coin-price move ${formatPercent(move)}\nModeled paper result: ${paperResult} | T1 ${formatPrice(p.partialTargetPrice || p.targetPrice)} | Final ${formatPrice(p.targetPrice)} | Stop ${formatPrice(p.effectiveStopPrice || p.stopPrice)}\n${trackerConfidenceText(p)} | ${p.horizonLabel || 'Intraday'} | deadline <t:${Math.floor(new Date(p.deadlineAt).getTime() / 1000)}:R>`,
      inline: false
    });
  }
  return embed;
}

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const adminOnly = ['setup', 'configure', 'api-key', 'scan', 'diagnostics', 'validate', 'role', 'train', 'guard', 'event', 'import-data'].includes(sub);
  if (adminOnly && !isAdminInteraction(interaction)) {
    return interaction.reply({ content: 'This command requires the Manage Server permission.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: adminOnly || sub === 'thesis' });
  runtime.interactionsHandled += 1;
  const guildId = interaction.guildId;

  if (sub === 'thesis') {
    const action = interaction.options.getString('action', true);
    const userId = interaction.user.id;
    if (action === 'add') {
      try {
        const result = await appendThesisRevision(userId, {
          assetId: interaction.options.getString('asset'), thesisType: interaction.options.getString('thesis_type'),
          protocolSlug: interaction.options.getString('protocol_slug'),
          githubRepo: interaction.options.getString('github_repo'),
          horizonMonths: interaction.options.getInteger('horizon_months'), reviewDate: interaction.options.getString('review_date'),
          thesis: interaction.options.getString('thesis'), assumptions: interaction.options.getString('assumptions'),
          baseCase: interaction.options.getString('base_case'), bullCase: interaction.options.getString('bull_case'),
          bearCase: interaction.options.getString('bear_case'), invalidation: interaction.options.getString('invalidation'),
          catalysts: interaction.options.getString('catalysts'), sources: (interaction.options.getString('source_urls') || '').split(/\s+/).filter(Boolean)
        });
        const entry = result.entry;
        return interaction.editReply({ content: `Private thesis revision ${entry.revision} saved for **${entry.assetId}** (${entry.horizonMonths}-month horizon)${entry.protocolSlug ? ` | DeFiLlama protocol: ${entry.protocolSlug}` : ''}${entry.githubRepo ? ` | exact GitHub repo: ${entry.githubRepo}` : ''}. It is a user-authored research record, not a score, forecast, or buy instruction.`, allowedMentions: { parse: [] } });
      } catch (error) {
        return interaction.editReply({ content: `Thesis was not saved: ${String(error.message || error).slice(0, 300)}`, allowedMentions: { parse: [] } });
      }
    }
    const journal = await readThesisJournal(userId);
    if (action === 'assess') {
      try {
        const result = await appendThesisAssessment(userId, { assetId: interaction.options.getString('asset'),
          status: interaction.options.getString('assessment'), notes: interaction.options.getString('assessment_notes') });
        return interaction.editReply({ content: `Your private assessment #${result.entry.assessmentNumber} was saved for **${result.entry.assetId}** | thesis revision ${result.entry.thesisRevision} | ${result.entry.status.replaceAll('_', ' ')}. This records your judgment only; the bot does not endorse it or create a buy/sell instruction.`, allowedMentions: { parse: [] } });
      } catch (error) {
        return interaction.editReply({ content: `Assessment was not saved: ${String(error.message || error).slice(0, 300)}`, allowedMentions: { parse: [] } });
      }
    }
    if (action === 'performance') {
      const assetQuery = String(interaction.options.getString('asset') || '').trim();
      const thesis = latestTheses(journal).find((row) => row.assetId.toLowerCase() === assetQuery.toLowerCase());
      if (!thesis) return interaction.editReply({ content: `No saved thesis found for ${assetQuery || 'that asset id'}. Save a thesis first.`, allowedMentions: { parse: [] } });
      const priorPerformance = summarizeThesisPerformance(journal, thesis.assetId);
      const priorObservedAt = Date.parse(priorPerformance.latest?.observedAt || '');
      if (Number.isFinite(priorObservedAt) && Date.now() - priorObservedAt < 30 * 60_000) {
        const cachedText = priorPerformance.snapshots === 1 || priorPerformance.elapsedDays === 0
          ? `Reference baseline ${priorPerformance.baseline.assetPrice} saved on ${priorPerformance.baseline.asOf}; a later completed UTC candle is needed to measure change.`
          : `Since ${priorPerformance.baseline.asOf}: ${priorPerformance.assetReturnPct >= 0 ? '+' : ''}${priorPerformance.assetReturnPct.toFixed(2)}% for ${thesis.assetId}; BTC ${priorPerformance.benchmarkReturnPct >= 0 ? '+' : ''}${priorPerformance.benchmarkReturnPct.toFixed(2)}%; relative ${priorPerformance.relativeReturnPp >= 0 ? '+' : ''}${priorPerformance.relativeReturnPp.toFixed(2)} percentage points over ${Math.floor(priorPerformance.elapsedDays)} days.`;
        const cachedDrawdown = priorPerformance.assetObservedMaxDrawdownPct === null
          ? 'Observed mark-to-mark drawdown: unavailable until at least two comparable marks exist.'
          : `Observed mark-to-mark maximum drawdown: ${priorPerformance.assetObservedMaxDrawdownPct.toFixed(2)}% for ${thesis.assetId}; BTC ${priorPerformance.benchmarkObservedMaxDrawdownPct.toFixed(2)}%. Sparse captures can miss deeper declines between marks.`;
        const sample = `Stored marks: ${priorPerformance.snapshots}; comparable marks in current provider segment: ${priorPerformance.comparableSnapshots}.`;
        return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis reference performance — ${thesis.assetId} | revision ${thesis.revision}**\n${cachedText}\n${cachedDrawdown}\n${sample}\nRecent completed-candle snapshot reused; no provider request was made. This is a user-authored reference series, not an executed position, bot recommendation, or after-cost portfolio return.`), allowedMentions: { parse: [] } });
      }
      try {
        const snapshot = await fetchMarketUniverse(guildId);
        const matches = (snapshot.assets || []).filter((row) => String(row.id).toLowerCase() === thesis.assetId.toLowerCase()
          || String(row.symbol).toLowerCase() === thesis.assetId.toLowerCase());
        const unique = [...new Map(matches.map((row) => [row.id, row])).values()];
        if (unique.length !== 1) return interaction.editReply({ content: unique.length
          ? 'That asset id or ticker is ambiguous in the current provider universe. Use the exact provider asset id in the thesis.'
          : `The saved asset ${thesis.assetId} was not found in the current provider market universe; no snapshot was saved.`, allowedMentions: { parse: [] } });
        const asset = unique[0];
        const bitcoin = snapshot.assets.find((row) => String(row.id).toLowerCase() === 'bitcoin') || { id: 'bitcoin', symbol: 'BTC' };
        const assetHistory = await fetchHistoricalCandles(asset, { interval: '1d', limit: 100, force: true });
        if (assetHistory.error || !assetHistory.candles?.length) throw new Error(assetHistory.errors?.join('; ') || 'No current completed daily candles were returned.');
        const benchmarkHistory = asset.id === bitcoin.id ? assetHistory : await fetchHistoricalCandles(bitcoin, {
          interval: '1d', limit: 100, providers: [assetHistory.provider], force: true
        });
        const assetQuote = quoteCurrency(assetHistory.pair), benchmarkQuote = quoteCurrency(benchmarkHistory.pair);
        if (assetHistory.provider !== benchmarkHistory.provider || !assetQuote || assetQuote !== benchmarkQuote)
          return interaction.editReply({ content: `No comparable crypto reference was saved: asset and BTC histories must use the same exchange and quote currency (asset ${assetHistory.provider || 'unknown'} ${assetHistory.pair || ''}; BTC ${benchmarkHistory.provider || 'unknown'} ${benchmarkHistory.pair || ''}).`, allowedMentions: { parse: [] } });
        const benchmarkByTime = new Map(benchmarkHistory.candles.map((row) => [row.time, row]));
        const latest = [...assetHistory.candles].reverse().find((row) => benchmarkByTime.has(row.time) && row.close > 0 && benchmarkByTime.get(row.time).close > 0);
        if (!latest) return interaction.editReply({ content: 'No completed UTC daily candle was aligned between the asset and BTC; no performance snapshot was saved.', allowedMentions: { parse: [] } });
        const asOf = new Date(latest.time).toISOString().slice(0, 10), observedAt = new Date().toISOString();
        const saved = await appendThesisPerformanceSnapshot(userId, { assetId: thesis.assetId, source: `${assetHistory.provider} daily exchange candles`,
          marketKey: `${assetHistory.provider}|${assetHistory.pair}|${benchmarkHistory.pair}`, benchmarkSymbol: 'BTC', asOf, observedAt,
          assetPrice: latest.close, benchmarkPrice: benchmarkByTime.get(latest.time).close });
        const summary = summarizeThesisPerformance(saved.journal, thesis.assetId);
        const line = summary.snapshots === 1 || summary.elapsedDays === 0
          ? `Reference baseline saved at ${assetHistory.provider} ${assetHistory.pair} close ${latest.close} on UTC candle date ${asOf}; capture again after a later completed candle to measure change.`
          : `Since ${summary.baseline.asOf}: ${summary.assetReturnPct >= 0 ? '+' : ''}${summary.assetReturnPct.toFixed(2)}% for ${thesis.assetId}; BTC ${summary.benchmarkReturnPct >= 0 ? '+' : ''}${summary.benchmarkReturnPct.toFixed(2)}%; relative change ${summary.relativeReturnPp >= 0 ? '+' : ''}${summary.relativeReturnPp.toFixed(2)} percentage points over ${Math.floor(summary.elapsedDays)} days.`;
        const maturity = summary.horizonComplete ? `The saved ${thesis.horizonMonths}-month horizon has elapsed (calendar-day approximation); the result is still a price comparison, not thesis validation.`
          : `Horizon: ${thesis.horizonMonths} months; elapsed ${Math.floor(summary.elapsedDays)} days. It is too early to judge a long-term thesis.`;
        const reset = summary.providerChanged ? ' Exchange or pair changed; the comparison restarts from the first matching provider snapshot.' : '';
        const sample = `Stored marks: ${summary.snapshots}; comparable marks in current exchange/pair segment: ${summary.comparableSnapshots}.`;
        const drawdown = summary.assetObservedMaxDrawdownPct === null
          ? 'Observed mark-to-mark drawdown: unavailable until at least two comparable marks exist.'
          : `Observed mark-to-mark maximum drawdown: ${summary.assetObservedMaxDrawdownPct.toFixed(2)}% for ${thesis.assetId}; BTC ${summary.benchmarkObservedMaxDrawdownPct.toFixed(2)}%. Sparse captures can miss deeper declines between marks.`;
        const duplicate = saved.duplicate ? ' This UTC candle was already captured; no duplicate row was added.' : '';
        return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis reference performance — ${thesis.assetId} | revision ${thesis.revision}**\nProvider: ${assetHistory.provider} | quote currency ${assetQuote} | completed daily candle as of ${asOf}.\n${line}\n${drawdown}\n${sample}\n${maturity}${reset}\n\nThis is a user-authored thesis reference series, not an executed position, bot recommendation, or after-cost portfolio return. It compares asset price change with BTC on the same provider and quote currency; fees, taxes, custody, contributions, and actual entry timing are not represented.${duplicate}`), allowedMentions: { parse: [] } });
      } catch (error) {
        return interaction.editReply({ content: `Could not capture thesis reference performance: ${String(error?.message || error).slice(0, 260)}. No recommendation or risk setting was changed.`, allowedMentions: { parse: [] } });
      }
    }
    if (action === 'coverage') {
      const asset = String(interaction.options.getString('asset') || '').trim().toLowerCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact provider asset id to inspect saved long-term evidence coverage.', allowedMentions: { parse: [] } });
      const coverage = thesisEvidenceCoverage(journal, asset);
      if (!coverage.review) return interaction.editReply({ content: `No provider evidence snapshot is saved for ${asset}. Save a thesis and run action Capture evidence review first.`, allowedMentions: { parse: [] } });
      const review = coverage.review;
      const lines = coverage.domains.map((row) => `• ${row.label}: ${row.status} (${row.observed}/${row.total} selected fields with numeric values)${row.latestPeriodEnd
        ? ` | newest reported period ${row.latestPeriodEnd}${row.periodAgeDays === null ? '' : ` (${row.periodAgeDays}d ${row.periodRelation.replace('_', ' ')})`}` : ' | no dated numeric fact'} | ${row.sources.length ? `field source ${row.sources.join(' / ')}` : `field source not stored; capture source ${review.source || 'unknown'}`}`);
      const protocol = review.protocolSummary;
      const protocolState = protocol ? `\nProtocol provider review: exact slug ${protocol.slug || 'unknown'} | free TVL ${protocol.tvlStatus || 'status unavailable'} | paid financial statement ${protocol.financialStatus || 'status unavailable'} | paid users/transactions ${protocol.usageStatus || 'status unavailable'} | emissions ${protocol.emissions?.note || 'not returned'} | paid exploit history ${protocol.security?.status || 'not measured'}${protocol.security?.incidentCount === null || protocol.security?.incidentCount === undefined ? '' : ` (${protocol.security.incidentCount} exact-ID matches)`}`
        : '\nProtocol provider review: not captured in this review. An exact slug is required for DeFiLlama metrics; paid fields also require a local API key.';
      const github = coverage.github;
      const githubState = github ? `\nGitHub activity: ${github.repository} | ${github.status} | recent 90d ${github.recentCommits ?? 'unavailable'} commits / ${github.recentContributors ?? 'unavailable'} identified contributors; prior 90d ${github.priorCommits ?? 'unavailable'} / ${github.priorContributors ?? 'unavailable'}${github.truncated ? ' (lower bound)' : ''}. Activity is not a code-quality or security measure.`
        : '\nGitHub activity: not captured; an exact manually verified repository mapping is required.';
      const missing = `Still not measured by this snapshot: ownership concentration, network security/decentralization, governance, ${protocol?.security?.status === 'available' ? 'complete exploit history' : 'exploit history (paid matching is not enabled or available)'}, regulation, and independently verified token value capture. A missing provider metric can also mean coverage is unavailable for this protocol.`;
      const content = `**Private evidence coverage — ${asset}**\nSnapshot ${review.observedAt} | ${review.source} | provider as-of ${review.providerAsOf || 'unknown'}\nSelected numeric facts: ${coverage.fieldsObserved}/${coverage.fieldsReported} reported fields\n${lines.join('\n')}${protocolState}${githubState}\n\nReported-period age is descriptive, not a uniform stale-data verdict; market snapshots, on-chain aggregates, and financial statements have different update cadences. ${missing}\nCoverage describes only the saved snapshot; it is not a completeness score, protocol-quality assessment, valuation, or investment instruction.`;
      return interaction.editReply({ content: fitPrivateThesisContent(content), allowedMentions: { parse: [] } });
    }
    if (action === 'history') {
      const asset = String(interaction.options.getString('asset') || '').trim().toLowerCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact provider asset id to view its private evidence-review history.', allowedMentions: { parse: [] } });
      const rows = recentThesisEvidenceReviews(journal, asset, 3);
      const assessments = recentThesisAssessments(journal, asset, 3);
      const performanceRows = (journal.performanceSnapshots || []).filter((row) => String(row.assetId).toLowerCase() === asset)
        .sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)) || String(b.observedAt).localeCompare(String(a.observedAt))).slice(0, 3);
      if (!rows.length && !performanceRows.length && !assessments.length) return interaction.editReply({ content: `No evidence, assessment or performance captures are saved for ${asset}. Use action Capture evidence review, Record your assessment, or Reference performance first.`, allowedMentions: { parse: [] } });
      const lines = rows.map((row) => {
        const relevant = row.facts.filter((fact) => ['price_usd', 'market_cap_usd', 'volume_24h_usd', 'change_24h_pct', 'change_7d_pct', 'circulating_supply', 'total_supply', 'max_supply', 'fdv_usd', 'circulating_supply_change_30d', 'circulating_supply_change_90d', 'circulating_supply_change_365d', 'total_supply_change_30d', 'total_supply_change_90d', 'total_supply_change_365d', 'protocol_tvl_usd', 'protocol_tvl_change_30d', 'protocol_tvl_change_90d', 'protocol_tvl_change_365d', 'protocol_gross_revenue_usd', 'token_holder_net_income_usd', 'protocol_earnings_usd', 'protocol_max_supply', 'protocol_adjusted_supply', 'protocol_incentive_supply', 'protocol_non_incentive_supply', 'protocol_active_users_24h', 'protocol_active_users_7d', 'protocol_active_users_30d', 'protocol_active_users_1y', 'protocol_transactions_24h', 'protocol_transactions_7d', 'protocol_transactions_30d', 'protocol_transactions_1y'].includes(fact.key));
        const marketFacts = relevant.filter((fact) => !fact.key.startsWith('protocol_') && fact.key !== 'token_holder_net_income_usd').slice(0, 6);
        const protocolFacts = [
          ...relevant.filter((fact) => ['protocol_tvl_usd', 'protocol_tvl_change_30d'].includes(fact.key)).slice(0, 2),
          ...relevant.filter((fact) => ['protocol_gross_revenue_usd', 'token_holder_net_income_usd', 'protocol_earnings_usd'].includes(fact.key)).slice(0, 3),
          ...relevant.filter((fact) => ['protocol_active_users_24h', 'protocol_active_users_30d', 'protocol_transactions_24h', 'protocol_transactions_30d'].includes(fact.key)).slice(0, 4),
          ...relevant.filter((fact) => ['protocol_max_supply', 'protocol_adjusted_supply', 'protocol_incentive_supply', 'protocol_non_incentive_supply'].includes(fact.key)).slice(0, 4)
        ];
        const facts = [...marketFacts, ...protocolFacts];
        const values = facts.map((fact) => `${fact.label}: ${Number.isFinite(fact.value) ? `${fact.unit === 'USD' ? '$' : ''}${Number(fact.value).toLocaleString('en-US', { maximumFractionDigits: 5 })}${fact.unit === 'percent' ? '%' : fact.unit === 'tokens' ? ' tokens' : fact.unit === 'users' ? ' users' : fact.unit === 'transactions' ? ' transactions' : ''}` : 'unavailable'}${fact.factSource ? ` [${fact.factSource}]` : ''}`).join('; ');
        const protocol = row.protocolSummary ? ` | DeFiLlama ${row.protocolSummary.slug || 'slug unknown'}: TVL ${row.protocolSummary.tvlStatus || 'unknown'}, paid financials ${row.protocolSummary.financialStatus || 'unknown'}, users/transactions ${row.protocolSummary.usageStatus || 'unknown'}, emissions ${row.protocolSummary.emissions?.available ? `returned (${row.protocolSummary.emissions.eventCount ?? '?'} events)` : 'not returned'}` : '';
        return `• ${row.observedAt.slice(0, 10)} | thesis rev ${row.thesisRevision} | ${row.status} | provider as-of ${row.providerAsOf || 'unknown'}${protocol}${values ? `\n  ${values}` : ''}`;
      });
      const performance = performanceRows.length ? `\n\nReference performance marks (not executed positions):\n${performanceRows.map((row) => `• rev ${row.thesisRevision} | ${row.asOf} | ${row.source} | ${row.marketKey} | asset ${row.assetPrice} | BTC ${row.benchmarkPrice}`).join('\n')}` : '';
      const assessmentText = assessments.length ? `\n\nYour recorded thesis assessments:\n${assessments.map((row) => `• ${row.assessedAt.slice(0, 10)} | rev ${row.thesisRevision} | ${row.status.replaceAll('_', ' ')} | ${row.notes}`).join('\n')}` : '';
      return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis history — ${asset}**\n${lines.join('\n') || 'No market evidence captures saved.'}${assessmentText}${performance}\n\nProvider snapshots may differ in timestamp and coverage. Assessments are your own judgments linked to the saved thesis revision. Reference marks are not actual holdings. These records do not provide comprehensive protocol underwriting, score the thesis, or give a valuation or buy/sell instruction.`), allowedMentions: { parse: [] } });
    }
    if (action === 'review') {
      const asset = String(interaction.options.getString('asset') || '').trim().toLowerCase();
      const thesis = latestTheses(journal).find((row) => row.assetId.toLowerCase() === asset);
      if (!thesis) return interaction.editReply({ content: `No saved thesis found for ${asset || 'that asset id'}. Save a thesis first; evidence reviews attach to a specific thesis revision.`, allowedMentions: { parse: [] } });
      let snapshot = null, selected = [], fetchError = '';
      try {
        snapshot = await fetchMarketUniverse(guildId, { force: true });
        selected = (snapshot.assets || []).filter((row) => [row.id, row.symbol].some((value) => String(value || '').toLowerCase() === asset));
      } catch (error) { fetchError = String(error?.message || error).slice(0, 200); /* Save an explicit unavailable review below; do not invent data. */ }
      const unique = new Map(selected.map((row) => [row.id, row]));
      selected = [...unique.values()];
      if (selected.length > 1) return interaction.editReply({ content: 'That ticker matches multiple assets. Use the exact provider asset id in the thesis and review command.', allowedMentions: { parse: [] } });
      const row = selected[0];
      const observedAt = new Date().toISOString();
      const rawFacts = row ? [
        ['price_usd', 'Snapshot price', row.price, 'USD'], ['market_cap_usd', 'Market capitalization', row.marketCap, 'USD'],
        ['volume_24h_usd', '24-hour volume', row.volume24h, 'USD'], ['change_24h_pct', '24-hour price change', row.change24h, 'percent'],
        ['change_7d_pct', '7-day price change', row.change7d, 'percent'], ['circulating_supply', 'Reported circulating supply', row.circulatingSupply, 'tokens'],
        ['total_supply', 'Reported total supply', row.totalSupply, 'tokens'], ['max_supply', 'Reported maximum supply', row.maxSupply, 'tokens'],
        ['fdv_usd', 'Reported fully diluted valuation', row.fullyDilutedValuation, 'USD']
      ].map(([key, label, value, unit]) => ({ key, label, value, unit, periodEnd: row.lastUpdated || snapshot.fetchedAt })) : [];
      const providerAsOfMs = Date.parse(row?.lastUpdated || '');
      const fresh = Boolean(row && isInvestmentSnapshotFresh(snapshot, new Date(), 60) && !snapshot?.stale
        && Number.isFinite(providerAsOfMs) && providerAsOfMs <= Date.now() + 60_000 && Date.now() - providerAsOfMs <= 60 * 60_000);
      let supplyHistory = null, supplyHistoryError = '';
      if (fresh && row) {
        try {
          const history = await recordTokenSupplySnapshots(guildId, [{ result: { assetId: row.id, symbol: row.symbol, supplySnapshot: {
            circulating: row.circulatingSupply, total: row.totalSupply, maximum: row.maxSupply, marketCapUsd: row.marketCap,
            fullyDilutedValuationUsd: row.fullyDilutedValuation, source: snapshot.source, observedAt: row.lastUpdated
          } } }]);
          supplyHistory = history.byAssetId?.[row.id] || null;
        } catch (error) { supplyHistoryError = String(error?.message || error).slice(0, 160); }
      }
      for (const change of supplyHistory?.changes || []) {
        const actualDays = change.elapsedDays ? `; ${change.elapsedDays}d observed` : '';
        rawFacts.push({ key: `circulating_supply_change_${change.targetDays}d`, label: `Circulating-supply change (${change.targetDays}d target${actualDays})`,
          value: change.circulatingChangePct, unit: 'percent', periodEnd: change.to || row?.lastUpdated || '' });
        rawFacts.push({ key: `total_supply_change_${change.targetDays}d`, label: `Total-supply change (${change.targetDays}d target${actualDays})`,
          value: change.totalChangePct, unit: 'percent', periodEnd: change.to || row?.lastUpdated || '' });
      }
      let protocolResearch = null;
      if (thesis.protocolSlug) {
        try { protocolResearch = await fetchProtocolFundamentals(thesis.protocolSlug, { apiKey: config.defillamaApiKey, hacksEnabled: config.defillamaHacksEnabled }); }
        catch (error) { protocolResearch = { slug: thesis.protocolSlug, tvlFacts: [], financialFacts: [], usageFacts: [], financialStatus: 'unavailable', usageStatus: 'request failed', emissions: { available: false, note: 'Research request failed.' }, security: { status: 'request failed', protocolId: '', incidentCount: null, events: [] }, note: String(error?.message || error).slice(0, 120) }; }
        rawFacts.push(...(protocolResearch.tvlFacts || []), ...(protocolResearch.financialFacts || []), ...(protocolResearch.usageFacts || []));
        const supply = protocolResearch.emissions?.supplyMetrics || {};
        for (const [field, key, label] of [['maxSupply', 'protocol_max_supply', 'Provider maximum supply'], ['adjustedSupply', 'protocol_adjusted_supply', 'Provider adjusted circulating supply'],
          ['incentiveAmount', 'protocol_incentive_supply', 'Provider incentive allocation'], ['nonIncentiveAmount', 'protocol_non_incentive_supply', 'Provider non-incentive allocation']]) {
          if (Number.isFinite(supply[field])) rawFacts.push({ key, label, value: supply[field], unit: 'tokens', periodEnd: protocolResearch.emissions.lastModified || observedAt });
        }
      }
      let githubActivity = null;
      if (thesis.githubRepo) {
        githubActivity = await fetchGithubActivity(thesis.githubRepo, { token: config.githubToken });
        const sourceLabel = `GitHub public commits (${githubActivity.repository}; 180-day window)`;
        if (Number.isFinite(githubActivity.recentCommits)) rawFacts.push(
          { key: 'github_commits_recent_90d', label: 'GitHub commits (recent 90d)', value: githubActivity.recentCommits, unit: 'commits', periodEnd: observedAt, factSource: sourceLabel },
          { key: 'github_commits_prior_90d', label: 'GitHub commits (prior 90d)', value: githubActivity.priorCommits, unit: 'commits', periodEnd: observedAt, factSource: sourceLabel },
          { key: 'github_contributors_recent_90d', label: 'GitHub identified contributors (recent 90d)', value: githubActivity.recentContributors, unit: 'contributors', periodEnd: observedAt, factSource: sourceLabel },
          { key: 'github_contributors_prior_90d', label: 'GitHub identified contributors (prior 90d)', value: githubActivity.priorContributors, unit: 'contributors', periodEnd: observedAt, factSource: sourceLabel }
        );
      }
      const evidenceFacts = [...(fresh && row ? rawFacts.filter((fact) => !String(fact.key).startsWith('protocol_') && fact.key !== 'token_holder_net_income_usd') : []),
        ...(protocolResearch?.tvlFacts || []), ...(protocolResearch?.financialFacts || []), ...(protocolResearch?.usageFacts || []),
        ...rawFacts.filter((fact) => /^protocol_(max_supply|adjusted_supply|incentive_supply|non_incentive_supply)$/.test(fact.key)),
        ...rawFacts.filter((fact) => String(fact.key).startsWith('github_'))]
        .map((fact) => ({ ...fact, factSource: fact.factSource || cryptoEvidenceFactSource(fact, snapshot?.source || 'Market snapshot provider') }));
      const review = await appendThesisEvidenceReview(userId, {
        assetId: thesis.assetId, source: `${snapshot?.source || 'Crypto market snapshot'}${protocolResearch ? ' + DeFiLlama' : ''}${githubActivity ? ' + GitHub' : ''}`, status: !fresh || !row ? (protocolResearch?.tvlFacts?.length || protocolResearch?.financialFacts?.length ? 'partial' : 'unavailable') : 'coverage_limited',
        observedAt, providerAsOf: row?.lastUpdated || snapshot?.fetchedAt || protocolResearch?.observedAt || '', note: [fetchError, snapshot?.providerError, snapshot?.stale ? 'Provider fetch failed; only stale cached data was available.' : '', !row ? 'Exact asset was absent from the current provider snapshot.' : '', supplyHistoryError, protocolResearch?.note,
          githubActivity && !['available', 'partial_lower_bound'].includes(githubActivity.status) ? `GitHub activity ${githubActivity.status}${githubActivity.httpStatus ? ` (HTTP ${githubActivity.httpStatus})` : ''}.` : ''].filter(Boolean).join(' ').slice(0, 240),
        facts: evidenceFacts,
        protocolSummary: protocolResearch ? { slug: protocolResearch.slug, tvlStatus: protocolResearch.tvlStatus, financialStatus: protocolResearch.financialStatus, usageStatus: protocolResearch.usageStatus, emissions: protocolResearch.emissions,
          allocation: protocolResearch.emissions?.allocation, security: protocolResearch.security } : null,
        githubSummary: githubActivity
      });
      const visibleFacts = review.review.facts.filter((fact) => ['price_usd', 'market_cap_usd', 'volume_24h_usd', 'change_24h_pct', 'change_7d_pct', 'circulating_supply', 'total_supply', 'max_supply', 'fdv_usd'].includes(fact.key));
      visibleFacts.push(...review.review.facts.filter((fact) => /^(circulating|total)_supply_change_(30|90|365)d$/.test(fact.key)));
      visibleFacts.push(...review.review.facts.filter((fact) => String(fact.key).startsWith('github_')));
      const protocolFacts = review.review.facts;
      visibleFacts.push(
        ...protocolFacts.filter((fact) => ['protocol_tvl_usd', 'protocol_tvl_change_30d'].includes(fact.key)).slice(0, 2),
        ...protocolFacts.filter((fact) => ['protocol_gross_revenue_usd', 'token_holder_net_income_usd', 'protocol_earnings_usd'].includes(fact.key)).slice(0, 3),
        ...protocolFacts.filter((fact) => ['protocol_active_users_24h', 'protocol_active_users_30d', 'protocol_transactions_24h', 'protocol_transactions_30d'].includes(fact.key)).slice(0, 4),
        ...protocolFacts.filter((fact) => ['protocol_max_supply', 'protocol_adjusted_supply', 'protocol_incentive_supply', 'protocol_non_incentive_supply'].includes(fact.key)).slice(0, 4)
      );
      const render = (fact) => {
        if (!Number.isFinite(fact.value)) return `${fact.label}: unavailable`;
        const value = fact.unit === 'USD' ? `$${Number(fact.value).toLocaleString('en-US', { maximumFractionDigits: 6 })}`
          : fact.unit === 'percent' ? `${Number(fact.value).toFixed(2)}%`
            : `${Number(fact.value).toLocaleString('en-US', { maximumSignificantDigits: 5 })}${fact.unit ? ` ${fact.unit}` : ''}`;
        return `${fact.label}: ${value}${fact.factSource ? ` [${fact.factSource}]` : ''}`;
      };
      const previous = review.priorReview ? `Prior evidence capture: ${review.priorReview.observedAt} (${review.priorReview.source}).` : 'First evidence capture for this thesis.';
      const activityChanges = compareProtocolActivityCaptures(review.review, review.priorReview);
      const activityHistory = summarizeProtocolActivityHistory(review.journal.reviews, review.review);
      const activityComparison = activityHistory.length
        ? `\nRecent DeFiLlama activity direction (same exact slug, metric and unit; descriptive only): ${activityHistory.slice(0, 4).map((trend) => `${trend.label} (n=${trend.sampleCount}): ${trend.firstValue.toLocaleString('en-US')} → ${trend.latestValue.toLocaleString('en-US')}${trend.changePct === null ? ' (percentage change unavailable from a zero baseline)' : ` (${trend.changePct >= 0 ? '+' : ''}${trend.changePct.toFixed(1)}%)`} | ${trend.risingSteps} rising / ${trend.fallingSteps} falling / ${trend.flatSteps} flat steps | ${trend.firstObservedAt.slice(0, 10)} → ${trend.latestObservedAt.slice(0, 10)}`).join('; ')}. These small, irregular samples are not evidence of sustained adoption.`
        : activityChanges.length
          ? `\nChange from prior DeFiLlama capture (same slug, metric and window; provider-reported snapshots, not a sustained trend): ${activityChanges.slice(0, 4).map((change) => `${change.label}: ${change.priorValue.toLocaleString('en-US')} → ${change.currentValue.toLocaleString('en-US')} (${change.changePct >= 0 ? '+' : ''}${change.changePct.toFixed(1)}%; ${change.priorObservedAt.slice(0, 10)} → ${change.currentObservedAt.slice(0, 10)})`).join('; ')}`
          : '';
      const storedProtocol = review.review.protocolSummary;
      const storedGithub = review.review.githubSummary;
      const githubLine = storedGithub ? `\nGitHub public repository activity: ${storedGithub.repository} | status ${storedGithub.status} | recent 90d ${storedGithub.recentCommits ?? 'unavailable'} commits / ${storedGithub.recentContributors ?? 'unavailable'} identified contributors | prior 90d ${storedGithub.priorCommits ?? 'unavailable'} commits / ${storedGithub.priorContributors ?? 'unavailable'} identified contributors${storedGithub.truncated ? ' | lower bound only (pagination cap reached)' : ''}. Commits/contributors are activity counts, not code quality, maintainer independence, security, or project health.` : '';
      const unlockLines = (storedProtocol?.emissions?.upcomingEvents || []).map((event) => `• ${event.date.slice(0, 10)} | ${event.category || 'Uncategorized'} | ${event.tokenAmount === null ? 'amount unavailable' : `${event.tokenAmount.toLocaleString('en-US', { maximumSignificantDigits: 6 })} tokens`} | ${event.unlockType || 'type unavailable'}`);
      const allocationLines = Object.entries(storedProtocol?.allocation?.current || {}).slice(0, 5).map(([category, value]) => `${category}: ${value}%`);
      const hackLines = (storedProtocol?.security?.events || []).map((event) => `• ${event.date.slice(0, 10)} | ${event.classification || 'Classification unavailable'} | ${event.technique || 'Technique unavailable'} | ${event.amountUsd === null ? 'loss amount unavailable' : `$${event.amountUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`} | ${(event.chains || []).join(', ') || 'chain unavailable'}${event.bridgeHack ? ' | bridge-related' : ''}${event.source ? ` | <${event.source}>` : ''}`);
      const hackSummary = storedProtocol?.security ? `\nHistorical exploits: paid DeFiLlama exact protocol ID ${storedProtocol.security.protocolId || 'unavailable'} | ${storedProtocol.security.status}${storedProtocol.security.incidentCount === null ? '' : ` | ${storedProtocol.security.incidentCount} matched incident(s)`}${hackLines.length ? `\n${hackLines.join('\n')}` : ''}. This source is incomplete and an empty result does not mean no incidents occurred.` : '';
      const protocolLine = protocolResearch ? `\nDeFiLlama exact slug: ${protocolResearch.slug} | TVL: ${protocolResearch.tvlStatus} | paid financial statement: ${protocolResearch.financialStatus} | paid usage: ${protocolResearch.usageStatus} | emissions: ${protocolResearch.emissions.note}${storedProtocol?.emissions?.lastModified ? ` (updated ${storedProtocol.emissions.lastModified})` : ''}${unlockLines.length ? `\nNext scheduled unlocks:\n${unlockLines.join('\n')}` : ''}${allocationLines.length ? `\nCurrent reported allocation: ${allocationLines.join(' | ')}` : ''}${hackSummary}` : `\nProtocol metrics: not queried. Add the exact DeFiLlama protocol slug to a new thesis revision to capture free TVL and optional paid financial/usage/emission data.`;
      const gapParts = [];
      if (!fresh || !row) gapParts.push(`A fresh crypto market/supply snapshot was not verified. ${review.review.note}`);
      if (!protocolResearch) gapParts.push('Protocol metrics were not queried; an exact saved DeFiLlama slug is required.');
      else {
        if (!protocolResearch.tvlFacts.length) gapParts.push(`TVL history unavailable (${protocolResearch.tvlStatus}).`);
        if (protocolResearch.financialStatus !== 'available') gapParts.push(`Paid financial statement ${protocolResearch.financialStatus}.`);
        if (!protocolResearch.usageFacts.length) gapParts.push(`Paid users/transactions ${protocolResearch.usageStatus}.`);
        if (!protocolResearch.emissions.available) gapParts.push(`Emission data unavailable (${protocolResearch.emissions.note}).`);
        gapParts.push(`Security incident history status: ${protocolResearch.security?.status || 'not measured'}. An empty incident match is not proof of safety. Validator/owner concentration, decentralization, audit quality, and independently verified token value capture remain unmeasured. User/transaction totals are provider-reported activity measures, not unique economic users or proof of token value capture. TVL is price-sensitive.`);
      }
      if (!thesis.githubRepo) gapParts.push('Developer activity was not queried; add an exact GitHub owner/repo mapping in a new thesis revision.');
      else if (!githubActivity || !['available', 'partial_lower_bound'].includes(githubActivity.status)) gapParts.push(`Developer activity could not be measured from the mapped repository (${githubActivity?.status || 'unavailable'}).`);
      gapParts.push('GitHub activity counts are descriptive and do not establish code quality, independent maintenance, security, or economic value.');
      const gap = gapParts.join(' ');
      const reviewPrompts = thesisReviewPrompts(thesis).map((prompt, index) => `${index + 1}. ${prompt}`).join('\n');
      const content = `**Private evidence review ${review.review.reviewNumber} — ${thesis.assetId} | thesis revision ${review.review.thesisRevision}**\nCaptured ${observedAt} | provider as-of ${review.review.providerAsOf || 'unknown'} | ${review.review.source}\n**Questions for your ${String(thesis.thesisType).replaceAll('_', ' ')} thesis**\n${reviewPrompts}\n\n${visibleFacts.map(render).join('\n') || 'No current provider facts available.'}${protocolLine}${githubLine}${activityComparison}\n${previous}\n\nUse these as a checklist against your saved assumptions and invalidation conditions. Provider-reported facts only. ${gap} This is not a thesis verdict, forecast, valuation, or buy/sell instruction.`;
      return interaction.editReply({ content: fitPrivateThesisContent(content), allowedMentions: { parse: [] } });
    }
    if (action === 'due') {
      const today = localDateKey(new Date(), config.timezone);
      const rows = thesesDueForReview(journal, today);
      return interaction.editReply({ content: rows.length
        ? `Private thesis reviews due as of ${today} (${config.timezone}):\n${rows.slice(0, 20).map((row) => `• **${row.assetId}** | ${row.reviewStatus}${row.daysOverdue ? ` by ${row.daysOverdue} day(s)` : ''} | review ${row.reviewDate} | rev ${row.revision}`).join('\n')}\n\nThis is a date-only reminder; it does not verify thesis evidence or update a recommendation.`
        : `No thesis reviews are due today or overdue as of ${today} (${config.timezone}). Future review dates are not shown.`, allowedMentions: { parse: [] } });
    }
    if (action === 'list') {
      const rows = latestTheses(journal);
      return interaction.editReply({ content: rows.length
        ? `Your private thesis notes (latest revisions):\n${rows.slice(0, 20).map((row) => `• ${row.assetId} | ${String(row.thesisType || 'unclassified').replaceAll('_', ' ')} | rev ${row.revision} | ${row.horizonMonths} months | review ${row.reviewDate || 'not set'}`).join('\n')}`
        : 'No private thesis notes saved yet. Use `/crypto thesis` with action Add revision to record one.', allowedMentions: { parse: [] } });
    }
    if (action === 'show') {
      const asset = String(interaction.options.getString('asset') || '').trim().toLowerCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact asset id or ticker to show its thesis history.', allowedMentions: { parse: [] } });
      const rows = journal.revisions.filter((row) => String(row.assetId).toLowerCase() === asset).sort((a, b) => Number(b.revision) - Number(a.revision));
      if (!rows.length) return interaction.editReply({ content: `No thesis revisions found for ${asset}.`, allowedMentions: { parse: [] } });
      const latest = rows[0];
      const sources = latest.sources.length ? `\nSources: ${latest.sources.map((source) => `<${source}>`).join(' ')}` : '\nSources: none supplied.';
      const disclaimer = `\n\nUser-authored research, not an independent fact-check, forecast, or buy instruction. ${rows.length} immutable revision(s) saved.`;
      const body = `**${latest.assetId} | ${String(latest.thesisType || 'unclassified').replaceAll('_', ' ')} | revision ${latest.revision} | ${latest.horizonMonths}-month horizon**\nRecorded ${latest.createdAt} | next review ${latest.reviewDate || 'not set'}${latest.protocolSlug ? `\nDeFiLlama protocol slug: ${latest.protocolSlug}` : ''}${latest.githubRepo ? `\nExact GitHub repository: ${latest.githubRepo}` : ''}\nThesis: ${latest.thesis}\nAssumptions: ${latest.assumptions}\nBase case: ${latest.baseCase}\nBull case: ${latest.bullCase}\nBear case: ${latest.bearCase}\nInvalidation: ${latest.invalidation}\nCatalysts: ${latest.catalysts}${sources}`;
      const marker = '\n[Details truncated]';
      const budget = 1900 - disclaimer.length;
      const details = body.length > budget ? `${body.slice(0, budget - marker.length).trimEnd()}${marker}` : body;
      return interaction.editReply({ content: `${details}${disclaimer}`, allowedMentions: { parse: [] } });
    }
    return interaction.editReply({ content: 'Unknown thesis action.', allowedMentions: { parse: [] } });
  }

  if (sub === 'help') {
    const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle('OmniMod Crypto setup and model guide')
      .setDescription('Separate short-term paper setups, completed-daily trend research, and private long-term thesis notes. Daily trend research is not tokenomics or protocol underwriting. The bot never accepts wallet keys or places orders.')
      .addFields(
        { name: 'Keep the strategy horizons separate', value: '`/crypto momentum` tracks short-duration paper setups. `/crypto invest` is swing-horizon daily price-trend research over 5/20/60 calendar days versus BTC; it is not an actionable swing entry/exit system, forecast, or long-term value estimate. `/crypto thesis` records your own months-to-years thesis and planned review date, separate from technical signals. `review` captures dated provider market/supply facts and optional activity for the exact GitHub repo you manually mapped; `assess` records your own linked judgment; `history` shows the audit trail; `coverage` identifies the supplied evidence and major provider gaps.' },
        { name: '1. Assign channels', value: 'Run `/crypto setup` and choose signals, results, logs, an optional alert role, and an admin role.' },
        { name: '2. Configure cadence', value: 'Run `/crypto configure`. Open paper signals refresh from the provider every 5 minutes by default; new setup discovery runs every 15 minutes.' },
        { name: '3. Optional API key', value: 'Use `/crypto api-key` for CoinGecko Demo/Pro, or select keyless public mode. Keys are stored server-side and never echoed.' },
        { name: '4. Start', value: 'Run `/crypto scan`. The scheduler continuously discovers momentum and monitors open calls. Each call receives a model-selected 45-minute, 2-hour, 4-hour, or 6-hour horizon.' },
        { name: 'How a call qualifies', value: 'Broad discovery, three-exchange spot agreement, 15m technicals, BTC regime, futures/options context, Level-2 flow, execution-cost stress, repeated purged validation, uncertainty/event vetoes, and portfolio limits.' },
        { name: 'How probability works', value: 'Probability is segmented by horizon, asset class, and regime, then combined with target-before-stop estimates. Learned models stay inactive until repeated folds and a blind future segment pass; uncertain or shifted inputs force abstention.' },
        { name: 'Exit plan', value: 'Green starts at the 1R partial: bank 50% and protect the remainder at break-even. The final target starts follow-through tracking. Blue means the exceeded threshold cleared; red means the initial stop or a negative timed result.' },
        { name: 'Useful commands', value: '`/crypto momentum`, `/crypto invest`, `/crypto thesis` actions `add`, `list`, `show`, `due`, `review`, `assess`, `history`, `coverage`, and `performance`, `/crypto asset`, `/crypto validate`, `/crypto model`, `/crypto research`, `/crypto train`, `/crypto guard`, `/crypto event`, `/crypto import-data`, `/crypto status`.' },
        { name: 'Limits', value: 'Predictions are uncertain, market data may be delayed, stops can gap, and this is not financial advice.' }
      );
    return interaction.editReply({ embeds: [embed] });
  }

  if (sub === 'setup') {
    const patch = {
      signalsChannelId: interaction.options.getChannel('signals_channel').id,
      resultsChannelId: interaction.options.getChannel('results_channel')?.id || interaction.options.getChannel('signals_channel').id,
      logsChannelId: interaction.options.getChannel('logs_channel')?.id || '',
      alertRoleId: interaction.options.getRole('alert_role')?.id || '',
      adminRoleId: interaction.options.getRole('admin_role')?.id || '', configuredBy: interaction.user.id
    };
    await updateGuildSettings(guildId, patch);
    await interaction.editReply('OmniMod Crypto setup saved. No channels were created.');
    if (interaction.options.getBoolean('scan_now')) void runOpeningDiscovery(guildId, 'setup').catch(() => {});
    return;
  }

  if (sub === 'configure') {
    const mapping = {
      monitor_minutes: 'monitorMinutes', discovery_minutes: 'discoveryMinutes', minimum_score: 'minScore',
      max_signals: 'maxSignals', min_providers: 'minProviderConfirmations',
      round_trip_fee_bps: 'estimatedRoundTripBps', simulated_order_usd: 'simulatedOrderUsd',
      max_slippage_bps: 'maxExecutionSlippageBps', max_concurrent_signals: 'maxConcurrentSignals',
      daily_hour: 'dailyHour', daily_minute: 'dailyMinute'
    };
    const patch = { configuredBy: interaction.user.id };
    for (const [option, key] of Object.entries(mapping)) {
      const value = interaction.options.getInteger(option);
      if (value !== null) patch[key] = value;
    }
    const riskBasisPoints = interaction.options.getInteger('risk_basis_points');
    const minimumRrTenths = interaction.options.getInteger('minimum_rr_tenths');
    if (riskBasisPoints !== null) patch.accountRiskPct = riskBasisPoints / 100;
    if (minimumRrTenths !== null) patch.minRiskReward = minimumRrTenths / 10;
    const maximumCorrelationPercent = interaction.options.getInteger('max_correlation_percent');
    if (maximumCorrelationPercent !== null) patch.maxSignalCorrelation = maximumCorrelationPercent / 100;
    const settings = await updateGuildSettings(guildId, patch);
    return interaction.editReply(`Configuration saved: monitor ${settings.monitorMinutes}m, discovery ${settings.discoveryMinutes}m, score ≥${settings.minScore}, providers ≥${settings.minProviderConfirmations}, reward/risk ≥${settings.minRiskReward.toFixed(1)}R, account risk ${settings.accountRiskPct.toFixed(2)}%, paper order $${settings.simulatedOrderUsd.toLocaleString()}, max slippage ${settings.maxExecutionSlippageBps} bps, active cap ${settings.maxConcurrentSignals}, correlation ${settings.maxSignalCorrelation.toFixed(2)}, max ${settings.maxSignals} signals/day.`);
  }

  if (sub === 'api-key') {
    const tier = interaction.options.getString('tier');
    const key = interaction.options.getString('key') || '';
    if (tier !== 'public' && !key) return interaction.editReply('Demo and Pro modes require a key. Use public mode for keyless access.');
    await updateGuildSettings(guildId, { coingeckoApiTier: tier, coingeckoApiKey: tier === 'public' ? '' : key, configuredBy: interaction.user.id });
    return interaction.editReply(`CoinGecko ${tier} mode saved. The key will not be displayed or logged.`);
  }

  if (sub === 'scan') {
    const result = await runGuildScan(guildId, { reason: `command:${interaction.user.id}`, forceProvider: interaction.options.getBoolean('force_provider'), allowNewSignals: true });
    return interaction.editReply(`Scan complete: ${result.assetsScreened} assets screened, ${result.candidates.length} qualified, ${result.predictions.length} new signal(s), ${result.outcomes.length} outcome update(s).`);
  }

  if (sub === 'diagnostics') {
    const diagnostics = summarizeScanDiagnostics(await listScanDiagnostics(guildId, 50));
    const latest = diagnostics.latest;
    if (!latest) return interaction.editReply('No scan diagnostics have been recorded yet. Run `/crypto scan` or wait for the scheduler.');
    const funnel = latest.funnel;
    const providerText = Object.entries(diagnostics.providers).sort((a, b) => b[1].requests - a[1].requests).slice(0, 10)
      .map(([name, row]) => `${name}: ${row.requests} req, ${row.failures} failed, ${row.rateLimits} HTTP 429, ${row.cooldownDeferrals || 0} cooldown defer, avg ${formatDiagnosticCount(row.averageLatencyMs)}ms${row.utilizationPct === null ? '' : `, quota ${row.utilizationPct}%`}${row.usedWeightLastMinute === null ? '' : `, weight/min ${row.usedWeightLastMinute}`}`)
      .join('\n') || 'No instrumented provider calls in this scan window.';
    const rejects = diagnostics.topRejectionReasons.map((row) => `${row.reason}: ${row.count}`).join(' | ') || 'none recorded';
    const validationDetails = Object.entries(funnel.validationFailureCounts || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${reason}: ${count}`).join(' | ') || 'none recorded';
    const costSensitivity = funnel.validationCostSensitivity;
    const sample = (funnel.rejections || []).slice(0, 12).map((row) => `${row.symbol || row.assetId || '(unidentified asset)'} ${row.stage}/${row.code}`).join(', ') || 'none';
    const shadowSummary = (latest.forwardShadow || []).map((track) => `${track.id}: ${track.counts?.strategyQualified ?? 0} qualified, ${track.performance?.sampleSize ?? 0} closes, expectancy $${track.performance?.expectancyUsd ?? 'n/a'}, target/stop ${track.performance?.target1Hits ?? 0}/${track.performance?.stopCount ?? 0}, unfilled ${track.performance?.notFilledCount ?? 0}, rejected ${Object.entries(track.topRejectionReasons || {}).slice(0, 3).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'none'}`).join(' | ')
      || (latest.forwardShadowError ? `Unavailable: ${latest.forwardShadowError}` : 'No configured shadow paper observations.');
    const operationFailures = Object.entries(latest.providerOperationFailures || {}).map(([name, count]) => `${name}: ${count}`).join(' | ') || 'none reported by candidate enrichment';
    const coverage = latest.universeCoverage;
    const demoIdentityPlan = coverage?.discoveryBudget?.keyedIdentityPlanning;
    const identityRequests = latest.providers?.['CoinGecko Identity']?.requests;
    const demoBudgetDiagnostic = demoIdentityPlan
      ? `Bulk discovery projection ${formatDiagnosticCount(coverage.estimatedCallsPer30Days)} calls/30d; with up to ${formatDiagnosticCount(demoIdentityPlan.deepCandidateCap)} deep candidates per scheduled discovery, same-candidate cache scenario up to ${formatDiagnosticCount(demoIdentityPlan.stableShortlistCallsPer30Days)}, full-turnover scenario ${formatDiagnosticCount(demoIdentityPlan.fullTurnoverCallsPer30Days)} calls/30d, including exchange-directory refreshes. Against the ${formatDiagnosticCount(coverage.discoveryBudget.monthlyCeiling)}-call Demo planning ceiling: same candidates ${demoIdentityPlan.stableShortlistCallsPer30Days > coverage.discoveryBudget.monthlyCeiling ? 'above' : 'within'}, full turnover ${demoIdentityPlan.fullTurnoverCallsPer30Days > coverage.discoveryBudget.monthlyCeiling ? 'above' : 'within'}. Latest scan identity API attempts: ${Number.isFinite(identityRequests) ? identityRequests : 'not recorded'}. Scenarios exclude monitoring, manual commands, retries, other guilds and account clients; no account-wide quota guard is enforced.`
      : coverage?.discoveryBudget?.guarded
        ? 'Demo bulk-page planning is recorded; keyed identity scenario was not recorded for this scan. Identity calls may add to provider usage.'
        : 'Keyed Demo identity-call planning does not apply to this scan.';
    const membership = coverage?.pointInTimeMembership;
    const membershipHistory = membership?.status === 'recorded' || membership?.status === 'unchanged'
      ? `Latest ${membership.provider} snapshot ${membership.dateUtc}: ${membership.assetCount} asset IDs. Daily snapshots retain up to ${membership.retentionDays || 1_460} days.`
      : membership?.status === 'error' ? `Daily membership capture failed: ${String(membership.reason || 'unknown error').slice(0, 180)}`
        : 'No point-in-time membership snapshot is recorded for this scan.';
    const pagesReported = Number.isFinite(Number(coverage?.pagesFetched)) && Number.isFinite(Number(coverage?.marketCapPagesFetched));
    const coverageState = coverage?.coverageLimited === true ? 'Some requested market-cap pages were skipped or failed; volume discovery remains active.'
      : coverage?.coverageLimited === false ? 'Configured market-cap pages were fetched.' : 'Market-cap page coverage is unknown.';
    const universeCoverage = latest.failed
      ? `Market snapshot unavailable at ${latest.failureStage || 'unknown stage'}; universe size and downstream funnel counts are unknown.${latest.failure ? ` ${String(latest.failure).slice(0, 180)}` : ''}`
      : coverage?.provider === 'CoinGecko'
      ? `${formatDiagnosticCount(coverage.assetsReturned)} unique assets from ${formatDiagnosticCount(coverage.providerRowsReturned)} rows across ${formatDiagnosticCount(coverage.pagesFetched)} pages (volume ${pagesReported ? formatDiagnosticCount(Math.max(0, coverage.pagesFetched - coverage.marketCapPagesFetched)) : 'unknown'} + market-cap ${formatDiagnosticCount(coverage.marketCapPagesFetched)}/${formatDiagnosticCount(coverage.marketCapPagesRequested)}). CoinGecko reports ${formatDiagnosticCount(coverage.providerReportedTotal)} matching assets; observed ${Number.isFinite(coverage.providerCoveragePct) ? coverage.providerCoveragePct.toFixed(2) + '%' : 'unknown'}. Rank ceiling ${formatDiagnosticCount(coverage.marketRankCap)}; approx. ${formatDiagnosticCount(coverage.estimatedCallsPer30Days)} bulk-discovery calls/30d (keyed coin-ID checks extra) at ${formatDiagnosticCount(coverage.discoveryMinutes)}-minute refreshes${coverage.discoveryBudget?.guarded ? ` (Demo planning ceiling ${formatDiagnosticCount(coverage.discoveryBudget.monthlyCeiling)}/month)` : ''}. ${coverageState}${latest.providerError ? ` Partial provider errors: ${String(latest.providerError).slice(0, 160)}` : ''}`
      : `${formatDiagnosticCount(coverage?.assetsReturned ?? funnel.universe)} assets from ${coverage?.provider || latest.source || 'current provider'}; provider-defined coverage.`;
    const diagnosticEmbed = new EmbedBuilder().setColor(COLORS.brand).setTitle('OmniMod Crypto scan diagnostics')
      .setDescription(`Last scan ${localTimeLabel(new Date(latest.generatedAt))} | ${formatDiagnosticCount(diagnostics.scans)} retained scans | average duration ${formatDiagnosticCount(diagnostics.averageDurationMs)}ms over ${formatDiagnosticCount(diagnostics.durationSamples)} measured scans.`)
      .addFields(
        { name: 'Latest funnel', value: `${latest.discoveryEnabled ? '' : 'Discovery not evaluated (monitor-only scan). '}`
          + `Universe ${formatDiagnosticCount(funnel.universe)} → non-stable ${formatDiagnosticCount(funnel.nonStable)} → duplicate-ticker identity rejects ${formatDiagnosticCount(funnel.identityRejected)} → rank ${formatDiagnosticCount(funnel.rankPassed)} → liquidity ${formatDiagnosticCount(funnel.liquidityPassed)} → score ${formatDiagnosticCount(funnel.scorePassed)} → trend ${formatDiagnosticCount(funnel.trendPassed)} → deep cap ${formatDiagnosticCount(funnel.deepAnalysisCap)} (${formatDiagnosticCount(funnel.deepAnalysisSymbols)} incl. open positions) → confirmation passed ${formatDiagnosticCount(funnel.confirmationPassed ?? funnel.modelApproved)} → model/strategy approved ${formatDiagnosticCount(funnel.modelApproved)} → risk selected ${formatDiagnosticCount(funnel.riskSelected)} → posted ${formatDiagnosticCount(funnel.setupsPosted)}`, inline: false },
        { name: 'Risk / capacity / delivery / status', value: `Risk rejections ${formatDiagnosticCount(funnel.riskRejections)} | daily-cap ${formatDiagnosticCount(funnel.dailyCapacityRejections)} | duplicates ${formatDiagnosticCount(funnel.duplicateSuppressions)} | strict corr ${formatDiagnosticCount(latest.portfolioCorrelation?.comparablePairs)}/${formatDiagnosticCount(latest.portfolioCorrelation?.comparedPairs)} comparable; legacy flags on unavailable pairs ${formatDiagnosticCount(latest.portfolioCorrelation?.approvalFlagsOnUnavailableData)}; estimate disagreements ${formatDiagnosticCount(latest.portfolioCorrelation?.approvalDiagnosticDisagreements)} (strict view is audit-only) | proposed ${formatDiagnosticCount(funnel.setupsProposed)}, posted ${formatDiagnosticCount(funnel.setupsPosted)} | signal-send failures ${formatDiagnosticCount(funnel.deliveryFailures)} | state-save failures ${formatDiagnosticCount(funnel.notificationPersistenceFailures)} | outcome-send failures ${formatDiagnosticCount(funnel.outcomeDeliveryFailures)}, pending ${formatDiagnosticCount(funnel.pendingOutcomeDeliveries)} | stale snapshot ${latest.stale ? 'yes' : 'no'} | cache ${latest.cacheHit ? 'hit' : 'miss'}${latest.providerError ? ` | provider error: ${latest.providerError.slice(0, 180)}` : ''}`, inline: false },
        { name: 'Shared paper portfolio', value: `${String(latest.sharedPaperStatus || 'unknown')}${latest.sharedPaper?.status === 'available' ? ` | ${latest.sharedPaper.activeReservations} reserved + ${latest.sharedPaper.filledOpen} open | risk $${latest.sharedPaper.openRiskUsd} | unrealized $${latest.sharedPaper.unrealizedPnlUsd} | market-session realized $${latest.sharedPaper.realizedPnlTodayUsd} | account UTC risk day ${latest.sharedPaper.riskDayUtc}: $${latest.sharedPaper.realizedPnlRiskDayUtcUsd} | stale/unmarked ${latest.sharedPaper.staleOrUnmarked} | net $${latest.sharedPaper.netPnlUsd} across ${latest.sharedPaper.closedTrades} closed` : latest.sharedPaper?.status === 'unavailable' ? ` | unavailable: ${latest.sharedPaper.error}` : ''}`.slice(0, 1024), inline: false },
        { name: 'Tracker ↔ paper-ledger reconciliation', value: `${latest.sharedPaperReconciliation?.status || 'unknown'} | linked ${formatDiagnosticCount(latest.sharedPaperReconciliation?.linked)} | active-state mismatches ${formatDiagnosticCount(latest.sharedPaperReconciliation?.activeDivergence)} | missing ${formatDiagnosticCount(latest.sharedPaperReconciliation?.missing)} | owner mismatch ${formatDiagnosticCount(latest.sharedPaperReconciliation?.ownerMismatch)} | lifecycle updates ${formatDiagnosticCount(latest.sharedPaperReconciliation?.statusChanges)}`.slice(0, 1024), inline: false },
        { name: 'Forward-shadow paper tracks', value: shadowSummary.slice(0, 1024), inline: false },
        { name: 'Universe coverage / provider cost', value: universeCoverage.slice(0, 1024), inline: false },
        { name: 'Full directory / rolling price research', value: formatBroadDiscoverySummary(coverage?.broadDiscovery).slice(0, 1024), inline: false },
        { name: 'Full venue activity / separate research', value: formatVenueDiscoverySummary(coverage?.venueDiscovery, latest.venueResearch).slice(0, 1024), inline: false },
        { name: 'Global market / BTC dominance context', value: globalMarketContextSummary(latest.globalMarketContext).slice(0, 1024), inline: false },
        { name: 'Headline topic-tag coverage (descriptive only)', value: (() => {
          const news = latest.recentCryptoMarketNews || {};
          const tags = news.tagCoverage || {};
          const eventTypes = Object.entries(tags.eventTypes || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([name, count]) => `${name} ${count}`).join(' | ') || 'none';
          return `${news.status || 'unavailable'} | ${formatDiagnosticCount(tags.total)} fresh headlines: ${formatDiagnosticCount(tags.topicMatched)} topic matched, ${formatDiagnosticCount(tags.ambiguous)} ambiguous, ${formatDiagnosticCount(tags.unverifiedWording)} unverified wording, ${formatDiagnosticCount(tags.unclassified)} unclassified; ${formatDiagnosticCount(tags.explicitIncidentRiskBias)} explicit incident-risk topic tags. Types: ${eventTypes}. Tags are heuristic context only; no strategy effect.`.slice(0, 1024);
        })(), inline: false },
        { name: 'Point-in-time universe history', value: `${membershipHistory} This archives provider page membership going forward; omission from a page does not prove delisting, and no historical membership is backfilled.`, inline: false },
        { name: 'CoinGecko Demo request planning', value: demoBudgetDiagnostic.slice(0, 1024), inline: false },
        { name: 'Stage duration (latest / average)', value: Object.entries(latest.stageDurationsMs || {}).map(([stage, ms]) => `${stage} ${formatDiagnosticCount(ms)}/${formatDiagnosticCount(diagnostics.averageStageDurationsMs[stage])}ms`).join(' | ') || 'unavailable', inline: false },
        { name: 'Top rejection reasons (last 50 scans)', value: rejects.slice(0, 1024), inline: false },
        { name: 'Historical validation failures (latest scan; overlapping)', value: validationDetails.slice(0, 1024), inline: false },
        { name: 'Quote-cost historical sensitivity (research only)', value: costSensitivity
          ? `${costSensitivity.compared}/${costSensitivity.deepAssets} deep assets replayed; fixed-cost pass ${costSensitivity.baselinePassing}, current quote-cost scenario pass ${costSensitivity.quoteScenarioPassing}; pass→fail ${costSensitivity.passedToFailed}, fail→pass ${costSensitivity.failedToPassed}. Current estimated cost is applied to old candles, not historical point-in-time fills; production gate unchanged.`
          : 'Not recorded in this scan version.', inline: false },
        { name: 'Latest scan state', value: latest.failed ? `FAILED at ${latest.failureStage || 'unknown stage'}: ${String(latest.failure || latest.providerError || 'scan failed').slice(0, 700)}. Universe counts remain unknown.` : 'Completed', inline: false },
        { name: 'Recent rejected symbols', value: sample.slice(0, 1024), inline: false },
        { name: 'Provider requests (last 50 scans)', value: providerText.slice(0, 1024), inline: false },
        { name: 'Enrichment API failures (latest scan)', value: operationFailures.slice(0, 1024), inline: false }
      ).setFooter({ text: `Full details in attached JSON | latest 100 scans | missing quota headers are unavailable.` });
    return interaction.editReply({ embeds: [fitDiagnosticEmbed(diagnosticEmbed.toJSON())],
      files: [{ attachment: Buffer.from(JSON.stringify(diagnostics, null, 2)), name: 'crypto-scan-diagnostics.json' }] });
  }

  if (sub === 'role') {
    await postRolePanel(client, guildId);
    return interaction.editReply('Crypto Alerts role panel posted.');
  }

  const settings = await getGuildSettings(guildId);
  if (sub === 'model') {
    const [registry, research] = await Promise.all([readModelRegistry(), getResearchStatus()]);
    const readiness = summarizeModelReadiness(registry, research, settings);
    const bundle = registry.production?.meta;
    const models = Object.entries(bundle?.models || {});
    const active = models.filter(([, model]) => model.active);
    const global = bundle?.models?.global;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(active.length ? COLORS.green : COLORS.warn)
      .setTitle('OmniMod learning-model status')
      .setDescription(active.length
        ? 'Only models that beat the prior on an untouched chronological holdout can influence new signals.'
        : readiness.schemaCompatible === false
          ? `Stored model feature/entry/outcome-evidence schema does not match the current training policy; it is disabled. The deterministic safety model remains authoritative while current-schema labels accumulate.`
          : 'The boosted model is inactive. The deterministic safety model remains authoritative while clean labels accumulate.')
      .addFields(
        { name: 'Labeled observations', value: String(bundle?.labeledSamples || 0), inline: true },
        { name: 'Schema / eligible labels', value: `Features v${readiness.currentFeatureSchema} / entry v${readiness.currentEntryEvidenceVersion} / outcome v${readiness.currentOutcomeEvidenceVersion} | production ${readiness.productionFeatureSchema ?? 'none'} / ${readiness.productionEntryEvidenceVersion ?? 'none'} / ${readiness.productionOutcomeEvidenceVersion ?? 'none'}${readiness.schemaCompatible === false ? ' DISABLED' : ''} | ${readiness.eligibleSamples}/${readiness.minimumSamples} eligible / required`, inline: false },
        { name: 'Active context models', value: String(bundle?.activeModels || 0), inline: true },
        { name: 'Last training', value: bundle?.trainedAt ? localTimeLabel(new Date(bundle.trainedAt)) : 'not yet', inline: true },
        { name: 'Production', value: registry.production?.id || 'deterministic only', inline: true },
        { name: 'Challenger', value: registry.challenger ? `${registry.challenger.id} | waiting for ${settings.challengerMinSamples} fresh labels` : 'none staged', inline: true },
        { name: 'Promotions', value: String(registry.promotions?.length || 0), inline: true },
        { name: 'Execution-cost assumptions', value: `Current configured round-trip fee: ${Number(settings.estimatedRoundTripBps).toFixed(1)} bps (fee setting only). Model stress base: ${Number.isFinite(registry.costStress?.baseCostBps) ? `${registry.costStress.baseCostBps} bps` : 'unrecorded in stored model'}; stress multiplier ${registry.costStress?.stressMultiplier ?? 'n/a'}×. This model stress excludes verified account-specific fee schedules and actual paper fills.`, inline: false },
        { name: 'Model cost-stress result', value: registry.costStress
          ? `${registry.costStress.samples} labeled outcomes | 5th-percentile expectancy ${Number(registry.costStress.p05ExpectancyR).toFixed(2)}R | ${(Number(registry.costStress.probabilityPositive) * 100).toFixed(1)}% positive | ${registry.costStress.passed ? 'passed' : 'failed'}`
          : 'No model cost-stress result stored.', inline: false },
        { name: 'Global holdout', value: global?.metrics
          ? `${global.holdoutSamples} samples / ${global.dayCoverage?.blindDays ?? 0} UTC days | folds ${global.dayCoverage?.foldDays?.join('/') || 'n/a'} days | AUC ${global.metrics.auc.toFixed(3)} | Brier ${global.metrics.brier.toFixed(3)} vs ${global.baselineMetrics.brier.toFixed(3)} baseline`
          : global?.reason || `Needs at least ${settings.metaMinSamples} labeled observations.`, inline: false }
      ).setTimestamp()] });
  }
  if (sub === 'research') {
    const research = await getResearchStatus({ guildId });
    const taxonomyDimensions = [
      ['Setup family', 'setupFamily'], ['UTC time bucket', 'timeBucketUtc'],
      ['Reported turnover', 'reportedTurnoverCohort'], ['Manual event action', 'manualEventStatus'],
      ['Catalyst type', 'manualCatalystType'], ['Catalyst direction', 'manualCatalystDirection'],
      ['Catalyst expectedness', 'manualCatalystExpectedness'], ['Catalyst horizon', 'manualCatalystHorizon'],
      ['Catalyst impact', 'manualCatalystImpact']
    ];
    const taxonomyText = taxonomyDimensions.map(([label, dimension]) => {
      const groups = research.segments.filter((row) => row.dimension === dimension).sort((a, b) => b.samples - a.samples);
      if (!groups.length) return `${label}: collecting labeled observations`;
      const rows = groups.slice(0, 2).map((row) => {
        const mean = row.expectancyR === null ? 'mean n/a' : `mean ${row.expectancyR.toFixed(2)}R`;
        const interval = row.lower95R === null ? 'CI n/a' : `CI ${row.lower95R.toFixed(2)} to ${row.upper95R.toFixed(2)}R`;
        return `${row.key}: n=${row.samples}/${row.independentDayClusters}d ${row.status} ${mean} ${interval}`;
      });
      return `${label}: ${rows.join('; ')}${groups.length > 2 ? `; +${groups.length - 2} more groups` : ''}`;
    }).join('\n');
    const researchEmbed = new EmbedBuilder().setColor(COLORS.brand).setTitle('OmniMod shadow-research dataset')
      .setDescription('Source-pinned deep-analysis candidates are recorded, including approved and rejected rows. This is not the full discovery universe. Version-3 outcomes use completed 15-minute candles from the recorded venue and pair, abstain on ambiguous entry bars or missing intervals, and assume stop first when one later candle crosses both levels. Training additionally requires a fresh ask from that same venue and pair and excludes early-close approximations of unaligned deadlines. Attribution labels are descriptive, and small or correlated cohorts do not establish an edge.')
      .addFields(
        { name: 'Observations', value: String(research.total), inline: true },
        { name: 'Eligible v3 labels / legacy', value: `${research.eligibleLabeled} / ${research.legacyLabeled}`, inline: true },
        { name: 'Unusable resolved v3 / entry basis missing', value: `${research.malformedResolved} / ${research.entryEvidenceExcludedResolved}`, inline: true },
        { name: 'Approximate deadlines excluded', value: String(research.approximateDeadlineExcludedResolved), inline: true },
        { name: 'Independent venue research', value: `${research.venueResearch.observed} recorded · ${research.venueResearch.pending} pending · ${research.venueResearch.exactCandleOutcomes.sampleSize} source-validated candle outcomes · ${research.venueResearch.approximateDeadlineAudits.sampleSize} approximate deadline audits · ${research.venueResearch.excludedResolved} unusable resolutions. ${research.venueResearch.exactCandleOutcomes.meanModeledNetR === null ? 'No usable modeled mean.' : `Modeled after-cost mean ${research.venueResearch.exactCandleOutcomes.meanModeledNetR.toFixed(2)}R across ${research.venueResearch.exactCandleOutcomes.entryUtcDays} UTC entry date(s).`} Separate experimental cohort; no measured fills or production-model training. Small/correlated samples do not establish an edge.`, inline: false },
        { name: 'Net outcome evidence', value: formatEdgeEvidence(research.evidence) },
        { name: 'Shadow: execution-based liquidity factor', value: research.liquidityShadow?.lowerHalf?.lower95R != null && research.liquidityShadow?.upperHalf?.lower95R != null
          ? `Resolved ${research.liquidityShadow.resolved} of ${research.liquidityShadow.observed} recorded candidates. Lower score half: ${research.liquidityShadow.lowerHalf.status}, n=${research.liquidityShadow.lowerHalf.n}/${research.liquidityShadow.lowerHalf.observationDays} days, mean ${research.liquidityShadow.lowerHalf.meanR.toFixed(2)}R (95% ${research.liquidityShadow.lowerHalf.lower95R.toFixed(2)} to ${research.liquidityShadow.lowerHalf.upper95R.toFixed(2)}R); upper half: ${research.liquidityShadow.upperHalf.status}, n=${research.liquidityShadow.upperHalf.n}/${research.liquidityShadow.upperHalf.observationDays} days, mean ${research.liquidityShadow.upperHalf.meanR.toFixed(2)}R (95% ${research.liquidityShadow.upperHalf.lower95R.toFixed(2)} to ${research.liquidityShadow.upperHalf.upper95R.toFixed(2)}R). Production-preselected candidates only; repeated observations remain dependent; research comparison, not a promotion test.`
          : research.liquidityShadow?.resolved
            ? `Resolved ${research.liquidityShadow.resolved} of ${research.liquidityShadow.observed} recorded candidates. Comparison withheld until each score half has at least ${research.liquidityShadow.minimumPerHalf} outcomes across ${research.liquidityShadow.minimumDays} observation days. Current lower/upper halves: ${research.liquidityShadow.lowerHalf?.n || 0}/${research.liquidityShadow.lowerHalf?.observationDays || 0}d and ${research.liquidityShadow.upperHalf?.n || 0}/${research.liquidityShadow.upperHalf?.observationDays || 0}d. Production ranking and approvals remain unchanged.`
            : 'No resolved observations yet; this track only replaces the market-rank liquidity factor in a shadow score. Production ranking and all approvals remain unchanged.' },        { name: 'Horizon / regime diagnostics', value: research.segments.slice(0, 8).map((row) => `${row.key}: ${formatEdgeEvidence(row)}`).join('\n').slice(0, 1024) || 'Collecting; no segment evidence.' },
        { name: 'Exploratory attribution (not approval factors)', value: taxonomyText.slice(0, 1024), inline: false },
        { name: 'Pending', value: String(research.pending), inline: true },
        { name: 'Liquidity shadow pending / unusable', value: `${research.liquidityShadow?.pending || 0} / ${research.liquidityShadow?.unusableResolved || 0}`, inline: true },
        { name: 'Retention', value: `${settings.researchRetentionDays} days`, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [fitDiagnosticEmbed(researchEmbed.toJSON())],
      files: [{ attachment: Buffer.from(JSON.stringify(research, null, 2)), name: 'crypto-research.json' }] });
  }
  if (sub === 'train') {
    const registry = await trainAndStageModels(settings);
    const bundle = registry.production?.meta;
    const candidate = registry.challenger?.meta || registry.latestRejected?.meta;
    const global = candidate?.models?.global || bundle?.models?.global;
    return interaction.editReply(`Training cycle complete: production ${registry.production?.id || 'deterministic only'}, ${bundle?.activeModels || 0} active production context model(s), challenger ${registry.challenger?.id || 'none'}. ${global?.reason || `Need at least ${settings.metaMinSamples} labels.`}`);
  }
  if (sub === 'import-data') {
    if (!config.historicalImportDir) return interaction.editReply('Set `CRYPTO_HISTORICAL_IMPORT_DIR` to a server-local normalized NDJSON directory first.');
    const report = await importHistoricalResearch(config.historicalImportDir);
    return interaction.editReply(`Historical import complete: ${report.filesRead} file(s) read, ${report.filesSkipped} unchanged, ${report.rowsImported}/${report.rowsRead} rows imported.`);
  }
  if (sub === 'guard') {
    const tracker = await readTracker(guildId);
    const action = interaction.options.getString('action');
    if (action === 'pause') await setRiskGuardPause(guildId, true, interaction.options.getString('reason') || `Paused by ${interaction.user.id}`);
    if (action === 'resume') await setRiskGuardPause(guildId, false);
    const guard = await getRiskGuard(guildId, tracker.predictions, settings);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(guard.paused ? COLORS.red : COLORS.green).setTitle('OmniMod automatic risk guard')
      .setDescription(guard.paused ? `New signals are paused. ${guard.reasons.join(' ')}` : `${guard.operatingMode.replaceAll('_', ' ')}. Only paper research is allowed; no validated investment edge is implied.`)
      .addFields(
        { name: 'Rolling samples', value: String(guard.metrics.samples), inline: true },
        { name: 'Expectancy', value: guard.metrics.expectancyR === null ? 'unavailable' : `${guard.metrics.expectancyR.toFixed(2)}R`, inline: true },
        { name: 'Drawdown', value: `${guard.metrics.maxDrawdownR.toFixed(2)}R`, inline: true },
        { name: 'Probability Brier (guard input)', value: guard.metrics.brier === null ? 'unavailable' : `${guard.metrics.brier.toFixed(3)} (${guard.metrics.probabilitySamples} v2 outcome pairs)`, inline: true },
        { name: 'Forecast / outcome gap (guard input)', value: guard.metrics.calibrationDrift === null ? 'unavailable' : `${(guard.metrics.calibrationDrift * 100).toFixed(1)} pts`, inline: true },
        { name: 'Probability reliability sample', value: (() => {
          const evidence = guard.metrics.probabilityEvidence;
          if (!evidence || !evidence.samples) return 'No eligible probability/outcome pairs.';
          const forecast = `${(evidence.meanProbability * 100).toFixed(1)}% forecast mean`;
          const observed = `${(evidence.observedPositiveRate * 100).toFixed(1)}% observed positive after-cost R`;
          const brier = evidence.brier === null ? 'Brier unavailable' : `Brier ${evidence.brier.toFixed(3)}`;
          const baseline = evidence.sameSampleBaseRateBrier === null ? 'same-sample baseline unavailable' : `same-sample base-rate Brier ${evidence.sameSampleBaseRateBrier.toFixed(3)}`;
          return `${evidence.status.replaceAll('_', ' ')} | n=${evidence.samples} / ${evidence.independentDayClusters} UTC days | ${forecast} vs ${observed} | gap ${evidence.absoluteCalibrationGap === null ? 'unavailable' : `${(evidence.absoluteCalibrationGap * 100).toFixed(1)} pts`} | ${brier} | ${baseline}. Descriptive only; not an independent calibration test.`;
        })().slice(0, 1024), inline: false },
        { name: 'Probability reliability by context', value: guard.metrics.probabilitySegments.slice(0, 8).map((row) => `${row.dimension}/${row.key}: n=${row.samples}, days=${row.independentDayClusters}, Brier=${row.brier === null ? 'n/a' : row.brier.toFixed(3)}, gap=${row.absoluteCalibrationGap === null ? 'n/a' : `${(row.absoluteCalibrationGap * 100).toFixed(1)}pt`} (${row.status})`).join('\n').slice(0, 1024) || 'No eligible segmented probabilities.' },
        { name: 'Manual pause', value: guard.manualPaused ? 'Yes' : 'No', inline: true },
        { name: 'Hard limits (all sample sizes)', value: `24h gross losses ${guard.metrics.dailyLossR.toFixed(2)}R | lookback drawdown ${guard.metrics.hardDrawdownR.toFixed(2)}R | planned open risk ${guard.metrics.openRiskPct.toFixed(2)}%` },
        { name: 'Corrected paper evidence', value: formatEdgeEvidence(guard.metrics.evidence) },
        { name: 'Horizon / regime diagnostics', value: guard.metrics.segments.slice(0, 8).map((row) => `${row.key}: ${formatEdgeEvidence(row)}`).join('\n').slice(0, 1024) || 'Collecting; no eligible segments.' }
      ).setTimestamp()] });
  }
  if (sub === 'event') {
    const action = interaction.options.getString('action');
    const symbol = (interaction.options.getString('symbol') || '').trim();
    if (action === 'add') {
      const reason = interaction.options.getString('reason') || '';
      if (!symbol || !reason) return interaction.editReply('Adding an event requires both `symbol` and `reason`. Use `*` for a market-wide event.');
      const durationHours = interaction.options.getInteger('duration_hours') || 24;
      const startsAtRaw = interaction.options.getString('starts_at');
      const startsAt = startsAtRaw ? new Date(startsAtRaw) : new Date();
      if (!Number.isFinite(startsAt.getTime()) || (startsAtRaw && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(startsAtRaw))) return interaction.editReply('`starts_at` must be a valid ISO timestamp with a timezone, such as `2026-10-02T14:00:00Z`.');
      const row = await addEventRisk(guildId, {
        symbol, severity: interaction.options.getString('severity') || 'block', reason,
        eventType: interaction.options.getString('event_type'), direction: interaction.options.getString('direction'),
        expectedness: interaction.options.getString('expectedness'), horizon: interaction.options.getString('horizon'),
        impact: interaction.options.getString('impact'), sourceUrl: interaction.options.getString('source_url'),
        startsAt, endsAt: new Date(startsAt.getTime() + durationHours * 3_600_000), createdBy: interaction.user.id
      });
      const effect = row.severity === 'block' ? 'blocks approval while event veto is enabled'
        : row.severity === 'caution' ? 'sets the caution feature for the learned model while event veto is enabled'
          : 'is stored as context only';
      return interaction.editReply(`Event ${row.id} added for ${row.symbol}: ${row.severity} | ${row.eventType} | ${row.direction} | ${row.expectedness} | ${row.horizon} | ${row.impact} until ${localTimeLabel(new Date(row.endsAt))}${row.sourceUrl ? ` | source ${row.sourceUrl}` : ' | source not supplied'}. Effect: ${effect}. Event tags are manually supplied, not independently verified.`);
    }
    if (action === 'clear') {
      if (!symbol) return interaction.editReply('Clearing requires a symbol or event id.');
      const removed = await clearEventRisk(guildId, symbol);
      return interaction.editReply(`Removed ${removed} matching event veto(s).`);
    }
    const rows = await listEventRisks(guildId, new Date(), { activeOnly: false });
    const now = Date.now();
    return interaction.editReply(rows.length ? rows.map((row) => `${row.id} | ${new Date(row.startsAt).getTime() > now ? 'upcoming' : 'active/retained'} | ${row.symbol} | ${row.severity} | ${row.eventType}/${row.direction}/${row.expectedness}/${row.horizon}/${row.impact} | until ${localTimeLabel(new Date(row.endsAt))} | ${row.reason}${row.sourceUrl ? ` | ${row.sourceUrl}` : ''}`).join('\n').slice(0, 1900) : 'No active or upcoming crypto events.');
  }
  const snapshot = await getSnapshot(guildId, settings, { maxAgeMinutes: settings.discoveryMinutes });
  if (sub === 'invest') {
    if (!isInvestmentSnapshotFresh(snapshot)) return interaction.editReply('Daily price-trend research is unavailable: the liquidity/market-rank snapshot is stale or its timestamp is invalid. Refresh market data before treating it as current research.');
    const query = (interaction.options.getString('query') || '').trim().toLowerCase();
    const universe = (snapshot.assets || []).filter((asset) => Number(asset.volume24h) >= settings.minVolumeUsd);
    let selected = universe;
    if (query) {
      const exact = universe.filter((asset) => [asset.id, asset.symbol, asset.name].some((value) => String(value).toLowerCase() === query));
      selected = exact.length ? exact : universe.filter((asset) => [asset.id, asset.symbol, asset.name].some((value) => String(value).toLowerCase().includes(query)));
      if (selected.length !== 1) return interaction.editReply(selected.length ? 'Query matches multiple assets. Use an exact coin id or symbol.' : 'No matching asset passed the current liquidity screen.');
    }
    const report = await researchInvestments(selected, { guildId, minVolumeUsd: settings.minVolumeUsd,
      roundTripFeeBps: settings.estimatedRoundTripBps, snapshotSource: snapshot.source, snapshotFetchedAt: snapshot.fetchedAt,
      globalMarketContext: snapshot.globalMarketContext });
    const percent = (value) => value == null ? 'unavailable' : `${value.toFixed(1)}%`;
    const tokenCount = (value) => value == null || !Number.isFinite(value) ? 'unavailable' : value.toLocaleString('en-US', { maximumSignificantDigits: 5 });
    const usdValue = (value) => value == null || !Number.isFinite(value) ? 'unavailable' : `$${value.toLocaleString('en-US', { maximumSignificantDigits: 5 })}`;
    const regimeEvidence = Object.entries(report.forwardJournal?.byRegime || {}).flatMap(([label, horizons]) => {
      const rows = [5, 20, 60].flatMap((horizon) => {
        const row = horizons[horizon];
        return row?.nonOverlappingWindows ? [`${horizon}d n=${row.nonOverlappingWindows}, net ${percent(row.meanNetReturnPct)}`] : [];
      });
      return rows.length ? [`${label}: ${rows.join('; ')}`] : [];
    }).join('\n').slice(0, 900) || 'No resolved observations yet; older observations without regime tags are recorded as unknown.';
    const longRegimeEvidence = Object.entries(report.forwardJournal?.longWindowShadowByRegime || {}).flatMap(([label, horizons]) => {
      const rows = LONG_WINDOW_SHADOW_DAYS.flatMap((horizon) => {
        const row = horizons[horizon];
        return row?.nonOverlappingWindows ? [`${horizon}d n=${row.nonOverlappingWindows}, net ${percent(row.meanNetReturnPct)}, BTC excess ${percent(row.meanExcessReturnPct)}`] : [];
      });
      return rows.length ? [`${label}: ${rows.join('; ')}`] : [];
    }).join('\n');
    const volatilityEvidence = Object.entries(report.forwardJournal?.byVolatilityRegime || {}).flatMap(([label, horizons]) => {
      const rows = [5, 20, 60].flatMap((horizon) => {
        const row = horizons[horizon];
        return row?.nonOverlappingWindows ? [`${horizon}d n=${row.nonOverlappingWindows}, net ${percent(row.meanNetReturnPct)}, BTC excess ${percent(row.meanExcessReturnPct)}`] : [];
      });
      return rows.length ? [`${label}: ${rows.join('; ')}`] : [];
    }).join('\n');
    const longVolatilityEvidence = Object.entries(report.forwardJournal?.longWindowShadowByVolatilityRegime || {}).flatMap(([label, horizons]) => {
      const rows = LONG_WINDOW_SHADOW_DAYS.flatMap((horizon) => {
        const row = horizons[horizon];
        return row?.nonOverlappingWindows ? [`${horizon}d n=${row.nonOverlappingWindows}, net ${percent(row.meanNetReturnPct)}, BTC excess ${percent(row.meanExcessReturnPct)}`] : [];
      });
      return rows.length ? [`${label}: ${rows.join('; ')}`] : [];
    }).join('\n');
    const embeds = report.results.slice(0, 3).map((row) => new EmbedBuilder().setColor(row.suitableForWatch ? COLORS.brand : COLORS.warn)
      .setTitle(`SWING-HORIZON DAILY PRICE-TREND RESEARCH — NOT A TRADE SETUP | ${row.symbol} | ${row.decision}`)
      .setDescription(`${row.reasons.join(' ')} Daily technical research; no buy instruction or win probability.`)
      .addFields(
        { name: 'Discovery track', value: row.selectionTrack || 'single-asset query', inline: true },
        { name: 'Daily evidence', value: `${row.provider || 'unavailable'} | ${row.candles} completed bars | as of ${row.asOf || 'unavailable'}\nThis is not protocol underwriting: usage, value capture, scheduled unlocks, governance, security and custody are not assessed.` },
        { name: 'BTC market regime', value: `${row.marketRegime?.label || 'unknown'} trend | ${row.marketRegime?.volatilityRegime || 'volatility unavailable'}${Number.isFinite(row.marketRegime?.annualizedVolatilityPct) ? ` (${row.marketRegime.annualizedVolatilityPct.toFixed(1)}% annualized; ${Number.isFinite(row.marketRegime.volatilityPercentile) ? `${row.marketRegime.volatilityPercentile.toFixed(0)}th percentile` : 'percentile unavailable'})` : ''} | ${Number.isFinite(row.marketRegime?.drawdownFrom252DayPeakPct) ? `${row.marketRegime.drawdownFrom252DayPeakPct.toFixed(1)}% from 252-day peak` : 'drawdown unavailable'} as of ${row.marketRegime?.asOf || 'unknown'}\n${row.marketRegime?.method || 'Benchmark regime unavailable.'}` },
        { name: 'Provider-reported supply snapshot', value: row.supplySnapshot ? `Circulating ${tokenCount(row.supplySnapshot.circulating)} | total ${tokenCount(row.supplySnapshot.total)} | max ${tokenCount(row.supplySnapshot.maximum)} tokens\nMarket cap ${usdValue(row.supplySnapshot.marketCapUsd)} | reported FDV ${usdValue(row.supplySnapshot.fullyDilutedValuationUsd)} | ${row.supplySnapshot.source || 'source unavailable'} as of ${row.supplySnapshot.observedAt || 'unknown'}\nCirculating / reported total ${percent(row.supplyContext?.circulatingOfTotalPct)} | circulating / max ${percent(row.supplyContext?.circulatingOfMaximumPct)} | FDV premium to market cap ${percent(row.supplyContext?.fdvPremiumPct)}${row.supplyContext?.issues?.length ? `\nData consistency: ${row.supplyContext.issues.join('; ')}` : ''}\nRatios use positive values from this one provider snapshot. Missing or inconsistent pairs are unavailable. They do not establish an unlock schedule, audited tokenomics, token value capture, or valuation.` : 'Supply coverage unavailable.' },
        { name: 'Reported supply history', value: row.supplyHistory ? `${row.supplyHistory.provider}; ${row.supplyHistory.samples} daily snapshot(s), from ${row.supplyHistory.firstObservedAt.slice(0, 10)}. ${row.supplyHistory.changes.filter((change) => change.elapsedDays && (change.circulatingChangePct !== null || change.totalChangePct !== null)).map((change) => `${change.targetDays}d target/${change.elapsedDays}d actual: circulating ${percent(change.circulatingChangePct)}, total ${percent(change.totalChangePct)}${change.targetDays === 365 && (change.annualizedCirculatingChangePct !== null || change.annualizedTotalChangePct !== null) ? ` (365d annualized equivalent: circulating ${percent(change.annualizedCirculatingChangePct)}, total ${percent(change.annualizedTotalChangePct)})` : ''}`).join('; ') || 'History is still accumulating.'}\n${row.supplyHistory.coverage} Annualized equivalent is descriptive net provider-reported change over at least 180 days; it is not a forecast or unlock schedule.` : 'History is still accumulating; collection begins when the bot observes provider snapshots.' },
        { name: 'Trend / BTC comparison', value: row.score == null ? 'Insufficient evidence; no rank assigned.' : `Research rank score ${row.score}/100 | above daily 50-session mean ${percent(row.trendPersistencePct)} of last 60 days\n20d ${percent(row.return20Pct)} / excess vs BTC ${percent(row.excess20Pct)}; 60d ${percent(row.return60Pct)} / excess ${percent(row.excess60Pct)}` },
        { name: 'Multi-month / multi-year price history', value: `${(row.longTermPerformance || []).map((item) => `${item.days}d ${item.status === 'observed' ? `${percent(item.assetReturnPct)} / BTC excess ${percent(item.excessVsBenchmarkPct)}` : item.status}`).join(' | ') || 'Unavailable'}\nCompleted daily close-to-close returns only; price context, not a forecast or tokenomics/valuation assessment.`.slice(0, 1024) },
        { name: 'Frozen forward research', value: row.forwardEvidence ? `${row.forwardEvidence.resolved} resolved / ${row.forwardEvidence.pending} pending snapshots. ${row.forwardEvidence.horizons.map((h) => `${h.horizonSessions}d: ${h.resolved} outcomes (${h.nonOverlappingWindows} separate windows), net ${percent(h.meanNetReturnPct)}`).join('; ')}. Hypothetical; daily snapshots overlap.` : 'Not collected; no prospective evidence.' },
        { name: 'Monthly long-window shadow | daily 200-session screen', value: `${LONG_WINDOW_SHADOW_DAYS.map((horizon) => {
          const item = row.forwardEvidence?.longWindowShadow?.[horizon];
          if (!item) return `${horizon}d: not captured`;
          const net = item.meanNetReturnPct === null ? 'no resolved sample' : `net ${percent(item.meanNetReturnPct)}`;
          const excess = item.meanExcessReturnPct === null ? 'BTC excess unavailable' : `BTC excess ${percent(item.meanExcessReturnPct)}`;
          return `${horizon}d: ${item.nonOverlappingWindows} non-overlap resolved / ${item.pending} pending; ${net}; ${excess}`;
        }).join('\n')}\nCaptures require contiguous daily candles from the same provider and quote as BTC. Research-only price paths, not protocol/fundamental underwriting or a holder recommendation.` },
        { name: 'Forward outcomes by BTC regime', value: `${regimeEvidence}\nNon-overlapping hypothetical windows; descriptive only. Small samples are not predictive.`.slice(0, 1024) },
        { name: 'Forward outcomes by BTC volatility regime', value: `${volatilityEvidence || 'No resolved volatility-regime cohorts yet.'}\nNon-overlapping hypothetical windows; descriptive only. Samples may be small and correlated.`.slice(0, 1024) },
        { name: 'Long-window shadow by BTC regime', value: (`${longRegimeEvidence || 'No resolved monthly long-window outcomes yet; capture begins from the current daily research screen.'}
These are non-overlapping historical price paths, not predictive results.`).slice(0, 1024) },
        { name: 'Long-window shadow by BTC volatility regime', value: `${longVolatilityEvidence || 'No resolved volatility-tagged long-window observations yet.'}\nNon-overlapping historical price paths, descriptive only; small cohorts do not establish regime-specific performance.`.slice(0, 1024) },
        { name: 'Downside', value: row.score == null ? 'Unavailable.' : `Annualized daily volatility ${percent(row.volatilityPct)} | 90d close drawdown ${percent(row.drawdown90Pct)} | now below peak ${percent(row.recentDrawdownPct)}` },
        { name: 'Fixed-rule forward history after estimated costs', value: row.horizons.map((result) => `${result.horizonDays}d: ${result.samples} separate windows | mean ${percent(result.meanNetReturnPct)} | BTC excess ${percent(result.meanExcessReturnPct)} | worst ${percent(result.worstReturnPct)} | ${result.evidence}`).join('\n').slice(0, 1024) }
      ).setFooter({ text: 'Swing-horizon price research only; no entry/exit signal and not a multi-year thesis or buy instruction. Short history, changing fees, survivorship, and intraday risk limit inference.' }));
    const contextCoverage = report.forwardJournal?.globalContextCoverage;
    const frozenContext = contextCoverage ? `Frozen context coverage (unique asset/capture): ${contextCoverage.fresh} fresh, ${contextCoverage.stale} stale, ${contextCoverage.unavailable} unavailable, ${contextCoverage.missing} legacy/unrecorded; descriptive only.` : 'Historical context coverage unavailable.';
    return interaction.editReply({ content: `Showing up to three ranked results. ${report.universeNote} BTC benchmark source: ${report.benchmarkProvider || 'unavailable'}. Global market context now: ${globalMarketContextSummary(snapshot.globalMarketContext)} ${frozenContext} Liquidity snapshot: ${snapshot.fetchedAt}. Historical round-trip cost: ${settings.estimatedRoundTripBps} bps. ${report.forwardJournal?.cohortIncomplete ? `INCOMPLETE forward cohort: ${report.forwardJournal.overduePending} overdue snapshots remain unresolved; no edge claim.` : "Forward snapshot windows overlap; no proven edge."}${report.supplyHistoryError ? ` Supply history unavailable: ${report.supplyHistoryError}` : ''}`, embeds });
  }
  if (sub === 'momentum') {
    const freshnessOptions = { requireDiscoveryTimestamp: true, staleSnapshot: Boolean(snapshot.stale), now: Date.now(),
      maxDiscoveryQuoteAgeMs: config.maxDiscoveryAssetAgeMinutes * 60_000 };
    const preliminary = screenMomentum(snapshot, { ...settings, minScore: Math.max(50, settings.minScore - 12) }, freshnessOptions)
      .slice(0, settings.maxProviderCandidates);
    const confirmation = await enrichMarketAssets(preliminary, {
      technicalAssetIds: new Set(preliminary.map((asset) => asset.id)),
      bitcoinAsset: (snapshot.assets || []).find((asset) => asset.symbol === 'BTC'), concurrency: 3,
      minimumScore: settings.minScore, rewardRisk: settings.minRiskReward, roundTripFeeBps: settings.estimatedRoundTripBps,
      derivativesEnabled: settings.derivativesEnabled,
      microstructureBySymbol: new Map(preliminary.map((asset) => [asset.symbol, realtimeHub.getMicrostructure(asset.symbol)])),
      eventRisks: settings.eventVetoEnabled ? await listEventRisks(guildId) : [], globalMarketContext: snapshot.globalMarketContext, settings, now: freshnessOptions.now
    });
    const candidates = screenMomentum({ assets: confirmation.assets }, settings, { ...freshnessOptions, requireConfirmation: true });
    return interaction.editReply({ embeds: [momentumEmbed(candidates, interaction.options.getInteger('count') || 8, `${snapshot.source} + exchange confirmation`)] });
  }
  if (sub === 'validate') {
    const query = interaction.options.getString('query').toLowerCase();
    const asset = (snapshot.assets || []).find((item) => [item.id, item.symbol, item.name].some((value) => String(value).toLowerCase().includes(query)));
    if (!asset) return interaction.editReply('That asset is not in the current liquid market snapshot.');
    const identityWarning = providerIdentityWarning(snapshot.assets || [], asset);
    if (identityWarning) return interaction.editReply(identityWarning);
    const history = await fetchHistoricalCandles(asset, { limit: 1000, force: true });
    const validation = validateStrategy(history.candles, {
      minimumScore: settings.minScore, rewardRisk: settings.minRiskReward, roundTripFeeBps: settings.estimatedRoundTripBps
    });
    const stress = monteCarloCostStress(validation.overall.tradesList.map((trade) => ({
      realizedR: trade.realizedR, estimatedCostPct: trade.estimatedCostPct,
      stopPct: trade.entry > 0 ? (trade.entry - trade.stop) / trade.entry * 100 : 2.5
    })), { baseCostBps: settings.estimatedRoundTripBps, stressMultiplier: 3, iterations: 1500 });
    const metric = (row) => `${row.trades} trades | ${row.winRate.toFixed(1)}% positive | ${row.expectancyR.toFixed(2)}R expectancy | PF ${Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : '∞'} | drawdown ${row.maxDrawdownR.toFixed(2)}R`;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(validation.warning ? COLORS.warn : COLORS.green)
      .setTitle(`${asset.symbol} | conservative walk-forward check`)
      .setDescription(`Source: ${history.provider || 'unavailable'} ${history.pair || ''} | ${validation.candleCount} 15-minute candles. Rules use only information available at each signal; same-candle stop/target ambiguity is graded stop-first.`)
      .addFields(
        { name: 'Earlier segment', value: metric(validation.earlier) },
        { name: 'Recent holdout segment', value: metric(validation.recent) },
        { name: 'Overall', value: metric(validation.overall) },
        { name: 'Calendar coverage (UTC dates)', value: `Earlier: ${validation.coverage.earlier.candleDays} candle dates / ${validation.coverage.earlier.signalDays} signal dates\nHoldout: ${validation.coverage.recent.candleDays} candle dates / ${validation.coverage.recent.signalDays} signal dates\nOverall: ${validation.coverage.overall.candleDays} candle dates / ${validation.coverage.overall.signalDays} signal dates\nSignals on one date are clustered evidence, not independent trades.` },
        { name: 'Holdout uncertainty', value: formatEdgeEvidence(validation.evidence) },
        { name: 'Execution-cost stress', value: `${stress.iterations} simulations | median ${stress.medianExpectancyR.toFixed(2)}R | 5th percentile ${stress.p05ExpectancyR.toFixed(2)}R | ${(stress.probabilityPositive * 100).toFixed(1)}% positive`, inline: false },
        { name: 'Assessment', value: validation.warning || 'Recent expectancy is positive, but this small historical sample is not a profit guarantee.' }
      ).setFooter({ text: 'Paper research only; costs and observed stop gaps included. Day-cluster intervals assume independent days.' }).setTimestamp()] });
  }
  if (sub === 'asset') {
    const query = interaction.options.getString('query').toLowerCase();
    const asset = (snapshot.assets || []).find((item) => [item.id, item.symbol, item.name].some((value) => String(value).toLowerCase().includes(query)));
    if (!asset) return interaction.editReply('That asset is not in the current liquid market snapshot.');
    const identityWarning = providerIdentityWarning(snapshot.assets || [], asset);
    if (identityWarning) return interaction.editReply(identityWarning);
    const confirmed = (await enrichMarketAssets([asset], {
      technicalAssetIds: new Set([asset.id]), bitcoinAsset: (snapshot.assets || []).find((item) => item.symbol === 'BTC'),
      minimumScore: settings.minScore, rewardRisk: settings.minRiskReward, roundTripFeeBps: settings.estimatedRoundTripBps,
      derivativesEnabled: settings.derivativesEnabled,
      microstructureBySymbol: new Map([[asset.symbol, realtimeHub.getMicrostructure(asset.symbol)]]),
      eventRisks: settings.eventVetoEnabled ? await listEventRisks(guildId) : [], globalMarketContext: snapshot.globalMarketContext, settings, now: Date.now()
    })).assets[0] || asset;
    const model = scoreAsset(confirmed);
    const tracker = await readTracker(guildId);
    const production = await readProductionModels();
    const prediction = buildPrediction({ ...confirmed, model }, settings, guildId, new Date(), config.timezone, tracker.predictions, {
      metaBundle: production.meta, outcomeBundle: production.outcomes
    });
    return interaction.editReply({ embeds: [predictionEmbed(prediction, { title: `SHORT-TERM ANALYSIS SNAPSHOT (NOT A SETUP) | ${asset.symbol}` })] });
  }
  if (sub === 'tracker' || sub === 'history' || sub === 'performance') {
    const tracker = await readTracker(guildId);
    if (sub === 'performance') {
      const summary = summarizePerformance(tracker.predictions);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('SHORT-TERM CRYPTO PAPER PERFORMANCE')
        .addFields(
          { name: 'Tracked', value: String(summary.total), inline: true }, { name: 'Open', value: String(summary.open), inline: true },
          { name: 'Closed', value: String(summary.closed), inline: true }, { name: 'Targets', value: String(summary.wins), inline: true },
          { name: 'Exceeded', value: String(summary.exceeded), inline: true }, { name: 'Losses', value: String(summary.losses), inline: true },
          { name: 'Target not reached', value: String(summary.fellShort), inline: true }, { name: 'Positive rate', value: `${summary.winRate.toFixed(1)}%`, inline: true },
          { name: 'Net expectancy', value: `${summary.expectancyR.toFixed(2)}R / signal`, inline: true },
          { name: 'Profit factor', value: Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : '∞', inline: true },
          { name: 'Net result', value: `${summary.netR.toFixed(2)}R`, inline: true },
          { name: 'Max drawdown', value: `${summary.maxDrawdownR.toFixed(2)}R`, inline: true }
        ).setFooter({ text: 'Paper results only; not audited investment performance.' })] });
    }
    if (sub === 'tracker') {
      const symbol = (interaction.options.getString('symbol') || '').toUpperCase();
      const rows = tracker.predictions.filter((item) => activeStatus(item.status) && (!symbol || item.symbol === symbol)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return interaction.editReply({ embeds: [trackerEmbed(rows, 'SHORT-TERM ACTIVE CRYPTO PAPER TRACKER')] });
    }
    const count = interaction.options.getInteger('count') || 10;
    const rows = tracker.predictions.filter((item) => !activeStatus(item.status)).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, count);
    return interaction.editReply({ embeds: [trackerEmbed(rows, 'SHORT-TERM GRADED CRYPTO PAPER OUTCOMES')] });
  }
  if (sub === 'status') {
    const tracker = await readTracker(guildId);
    const discoveries = await listDiscoveries(guildId, 1);
    const [research, registry, guard, eventRisks] = await Promise.all([
      getResearchStatus({ guildId }), readModelRegistry(), getRiskGuard(guildId, tracker.predictions, settings), listEventRisks(guildId)
    ]);
    const bundle = registry.production?.meta;
    const realtime = realtimeHub.status();
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(runtime.lastError ? COLORS.warn : COLORS.green).setTitle('OmniMod Crypto status')
      .addFields(
        { name: 'Worker', value: runtime.state, inline: true }, { name: 'Discord', value: client.isReady() ? 'Connected' : 'Connecting', inline: true },
        { name: 'Active monitor', value: `${settings.monitorMinutes} minutes`, inline: true },
        { name: 'Opportunity discovery', value: `${settings.discoveryMinutes} minutes`, inline: true },
        { name: 'Provider', value: `${snapshot.source}${snapshot.stale ? ' (stale)' : ''}`, inline: true },
        { name: 'Confirmation', value: 'Binance + Coinbase + Kraken (best available)', inline: true },
        { name: 'Exchange asset identity', value: ['demo', 'pro'].includes(String(settings.coingeckoApiTier || 'demo').toLowerCase()) && settings.coingeckoApiKey
          ? `CoinGecko ${String(settings.coingeckoApiTier || 'demo').toLowerCase()} exact coin-ID/pair allowlist (candidate-scoped; cached)`
          : settings.coingeckoApiKey && !['public', ''].includes(String(settings.coingeckoApiTier || '').toLowerCase())
            ? 'Unrecognized CoinGecko key tier; keyed identity verification fails closed'
            : 'Ticker-only; exact exchange asset identity is not verified', inline: false },
        { name: 'Derivatives', value: settings.derivativesEnabled ? 'Kraken + Deribit + Binance best-effort' : 'Disabled', inline: true },
        { name: 'Realtime feeds', value: `${realtime.connectedProviders}/3 connected | ${realtime.symbols} symbols${realtime.restrictedProviders?.length ? ` | restricted: ${realtime.restrictedProviders.join(', ')}` : ''}`, inline: true },
        { name: 'Microstructure', value: `${realtime.microstructureSymbols || 0} symbols | execution order $${settings.simulatedOrderUsd.toLocaleString()}`, inline: true },
        { name: 'Event vetoes', value: String(eventRisks.length), inline: true },
        { name: 'Risk guard', value: guard.paused ? 'PAUSED' : 'Allowing qualified signals', inline: true },
        { name: 'Risk decision', value: guard.paused ? guard.reasons.join(' ').slice(0, 1024) : 'No active risk pause; model and execution checks still apply.', inline: false },
        { name: 'Learning model', value: `${bundle?.activeModels || 0} active | ${bundle?.labeledSamples || 0} labels`, inline: true },
        { name: 'Challenger', value: registry.challenger ? 'Staged; awaiting fresh labels' : 'None', inline: true },
        { name: 'Shadow research', value: `${research.labeled} labeled / ${research.pending} pending`, inline: true },
        { name: 'BTC regime', value: runtime.marketRegime || 'not yet', inline: true },
        { name: 'API key', value: maskSecret(settings.coingeckoApiKey), inline: true },
        { name: 'Last scan', value: runtime.lastScanAt ? localTimeLabel(new Date(runtime.lastScanAt)) : 'not yet', inline: true },
        { name: 'Latest opening scan', value: discoveries[0]?.dateKey || 'not yet', inline: true },
        { name: 'Tracked signals', value: String(tracker.predictions.length), inline: true },
        { name: 'Last error', value: runtime.lastError || 'none', inline: false }
      ).setTimestamp()] });
  }
}

client.once(Events.ClientReady, async () => {
  if (client.application?.id !== config.clientId || !client.user?.bot) {
    updateRuntime({ state: 'error', phase: 'discord_identity_mismatch', discordReady: false, lastError: 'Configured Discord application does not match the connected bot.' });
    await shutdown('discord_identity_mismatch');
    return;
  }
  updateRuntime({ state: 'running', phase: 'discord_ready', discordReady: true, discordUser: client.user.tag, lastError: '' });
  console.log(`[${new Date().toISOString()}] OmniMod Crypto logged in as ${client.user.tag}.`);
  void registerCommands().catch((error) => updateRuntime({ lastError: `Command registration: ${errorMessage(error)}` }));
  if (config.autoProvision && config.guildId) {
    try {
      const provisioned = await ensurePrimaryWorkspace(client, config.guildId);
      updateRuntime({ phase: provisioned.created ? 'workspace_provisioned' : 'workspace_ready', lastError: '' });
    } catch (error) {
      updateRuntime({ state: 'degraded', phase: 'workspace_setup_failed', lastError: errorMessage(error) });
    }
  }
  paperPositionMonitor.start();
  scheduler = setInterval(() => void schedulerTick().catch((error) => updateRuntime({ lastError: errorMessage(error) })), 60_000);
  scheduler.unref?.();
  updateRuntime({ schedulerRunning: true });
  if (config.postOnStart) {
    const guildIds = await listConfiguredGuildIds(client);
    for (const guildId of guildIds) {
      void runOpeningDiscovery(guildId, 'startup').catch(() =>
        runGuildScan(guildId, { reason: 'startup-tracker', allowNewSignals: true }).catch(() => {}));
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('crypto_alerts_')) return handleAlertButton(interaction);
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'crypto') return;
    await handleCommand(interaction);
  } catch (error) {
    const message = errorMessage(error);
    updateRuntime({ lastError: message });
    if (interaction.deferred || interaction.replied) await interaction.editReply(`OmniMod Crypto could not complete that request: ${message}`).catch(() => {});
    else await interaction.reply({ content: `OmniMod Crypto could not complete that request: ${message}`, ephemeral: true }).catch(() => {});
  }
});

client.on('error', (error) => updateRuntime({ state: 'degraded', lastError: errorMessage(error) }));
client.on('shardDisconnect', (event, shardId) => updateRuntime({ state: 'reconnecting', phase: `shard_${shardId}_disconnect`, discordReady: false, lastError: `Discord disconnect ${event?.code || ''}` }));
client.on('shardResume', () => updateRuntime({ state: 'running', phase: 'discord_resumed', discordReady: true, lastError: '' }));

export function shutdown(signal = 'shutdown') {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    updateRuntime({ state: 'stopping', phase: String(signal).toLowerCase(), discordReady: false, schedulerRunning: false });
    await paperPositionMonitor.stop();
    await runnerHeartbeat.stop();
    if (scheduler) {
      clearInterval(scheduler);
      scheduler = null;
    }
    realtimeHub.stop();
    client.destroy();
  })();
  return shutdownPromise;
}

if (process.env.OMNIMOD_EMBEDDED_HOST !== '1') {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown(signal).finally(() => process.exit(0)));
  }
}
process.on('unhandledRejection', (reason) => updateRuntime({ state: 'degraded', lastError: `Unhandled rejection: ${errorMessage(reason)}` }));
process.on('uncaughtException', (error) => updateRuntime({ state: 'degraded', lastError: `Uncaught exception: ${errorMessage(error)}` }));

updateRuntime({ state: 'connecting', phase: 'discord_login' });
if (process.env.NODE_ENV === 'test' && process.env.OMNIMOD_TEST_SKIP_DISCORD_LOGIN === '1') {
  updateRuntime({ state: 'test-ready', phase: 'discord_login_skipped_for_test' });
} else {
  await client.login(config.discordToken);
}

