import { Client, EmbedBuilder, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config, requireRuntimeConfig, dataDir } from './config.js';
import { buildCommands } from './commands.js';
import { DEFAULT_WATCHLIST, getGuildSettings, listConfiguredGuildIds, maskSecret, providerKeys, saveProviderKey, updateGuildSettings } from './guildSettings.js';
import { alpacaFeedCoverageNote, analyzeMomentum, fetchMarketUniverse, formatPercent, formatPrice, pendingConfirmationRejections, scoreAsset, selectConfirmationAdvisoryCandidates, summarizeSectorProxyCoverage, summarizeSecIndustryCoverage, summarizeStockUniverseCoverage, updateCandidateConfirmations } from './stocksData.js';
import { analyzePremarketBreakoutWatches, buildResearchWatches, newResearchWatchUpdates, premarketWatchNoticeKey } from './researchWatches.js';
import { buildPrediction, buildPredictions, evaluatePrediction, mergeNewPredictions, summarizePerformance } from './predictionEngine.js';
import { readDailyDiscovery, readMarketSnapshot, readTracker, writeDailyDiscovery, writeTracker } from './storage.js';
import { loadChallenger, loadGuildModel, maybeTrainGuildModel, modelHealth, predictEnsemble, trainGuildModel, trainingExamples } from './ensembleModel.js';
import { buildResearchDispositions, pruneResearchStore, recordFeatureSnapshot, recordMarketBar, recordPredictionCreated, recordPredictionEvents, recordScanDiagnostic, readScanDiagnostics, researchStoreStats } from './researchStore.js';
import { getAlpacaStreamStatus, registerAlpacaBarHandler, startAlpacaStream, stopAlpacaStream, updateAlpacaStreamSymbols } from './alpacaStream.js';
import { labelPendingResearch } from './counterfactualLabels.js';
import { loadResearchChallenger, loadResearchExamples, loadResearchModel, maybeTrainResearchModel, predictResearchEnsemble, researchModelHealth, trainResearchModel } from './researchModel.js';
import { captureUniverseSnapshot } from './universeStore.js';
import { selectPortfolioCandidates, portfolioReadinessText } from './portfolioSelector.js';
import { fetchInvestmentResearch, investmentResearchText, latestCompletedSession } from './investmentResearch.js';
import { fetchIssuerAnnualFundamentals } from './eventIntelligence.js';
import { summarizeStockHeadlineClassification } from './stockHeadlineClassifier.js';
import { annualHistoryFacts, formatAnnualHistory, latestAnnualTrendFacts } from './thesisReviewFormat.js';
import { collectInvestmentResearch, LONG_WINDOW_SHADOW_HORIZONS } from './investmentJournalStore.js';
import { appendThesisAssessment, appendThesisEvidenceReview, appendThesisPerformanceSnapshot, appendThesisRevision, compareThesisGrowthEvidence, latestTheses, recentThesisAssessments, recentThesisEvidenceReviews, readThesisJournal, summarizeThesisPerformance, thesisEvidenceCoverage, thesisReviewPrompts, thesesDueForReview } from './thesisJournal.js';
import { COLORS, handleAlertButton, isAdminInteraction, logEvent, postDailyReview, postNewPrediction, postOpeningSummary, postOutcome, postResearchWatchUpdate, postRolePanel, postWeeklyStatus, predictionEmbed } from './discordPublisher.js';
import { markNotificationAttempt, markNotificationPosted, notificationRetryReady } from './notificationState.js';
import { ensurePrimaryWorkspace } from './workspace.js';
import { isDailyDiscoveryDue, isDailyReviewDue, localDateKey, localParts, localTimeLabel, marketSession, shouldScanConfiguredUniverse } from './time.js';
import { countStaleRejections, createProviderMetrics, summarizeProviderMetrics, summarizeScanDiagnostics } from './scanDiagnostics.js';
import { formatStockResearchSegment, summarizeStockResearchSegments } from './researchTaxonomy.js';
import { addManualCatalyst, catalystsForSymbol, clearManualCatalyst, listManualCatalysts } from './manualCatalysts.js';
import { buildPrimarySignalCandidate, getSharedPaperDiagnostics, isSharedPaperConfigured, markSharedPaperOrders, reconcileSharedPaperOrders, reserveSharedPaperCandidate, sharedPaperPolicy } from '../../new-bots/shared/primarySignal.js';
import { recoverPaperOrders } from '../../new-bots/shared/paperRisk.js';
import { transitionPaperOrder } from '../../new-bots/shared/paperRisk.js';
import { publishPrimaryResearchSignals } from '../../new-bots/shared/signalResearch.js';
import { createRunnerHeartbeat } from '../../new-bots/shared/runnerHeartbeat.js';
import { getPaperLedgerWorkspaceRoot, paperLedgerFingerprint } from '../../new-bots/shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../new-bots/shared/forwardShadowPaper.js';
import { formatDiagnosticCount } from '../../new-bots/shared/formatDiagnosticCount.js';
import { createStockPositionMonitor } from './paperPositionMonitor.js';
import { buildStockPaperQuotes } from './paperExecutionQuotes.js';
import { refreshStockPaperQuotes, mergeStockRefreshedQuotes, stockDecisionQuoteObservation, stockQuoteRefreshRejections, formatStockQuoteRefresh, STOCK_QUOTE_REFRESH_VERSION } from './paperQuoteRefresh.js';

requireRuntimeConfig();

function formatUsd(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits }).format(Number(value));
}

function thesisHorizonOutcomeText(summary) {
  if (!summary?.baseline) return 'Long-term horizon checkpoint: pending a first saved reference mark.';
  const months = summary.thesis.horizonMonths;
  if (!summary.horizonOutcome) return `${months}-month checkpoint target: ${summary.horizonTargetAsOf}. No mark at or after that date has been saved yet.`;
  const outcome = summary.horizonOutcome;
  return `${months}-month checkpoint (target ${outcome.targetAsOf}; first saved mark ${outcome.observedAsOf}, ${Math.floor(outcome.elapsedDays)} days after baseline): ${outcome.assetReturnPct >= 0 ? '+' : ''}${outcome.assetReturnPct.toFixed(2)}% for ${summary.thesis.assetId}; ${summary.baseline.benchmarkSymbol} ${outcome.benchmarkReturnPct >= 0 ? '+' : ''}${outcome.benchmarkReturnPct.toFixed(2)}%; relative ${outcome.relativeReturnPp >= 0 ? '+' : ''}${outcome.relativeReturnPp.toFixed(2)} percentage points.`;
}

const runtime = globalThis.__omnimodStocksRuntime = {
  state: 'connecting', phase: 'boot', discordReady: false, discordUser: '', lastError: '',
  lastScanAt: '', scansCompleted: 0, lastTickAt: '', nextTickAt: '',
  configuredGuilds: 0, schedulerRunning: false, startedAt: new Date().toISOString()
};
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const running = new Set();
const lastScanByGuild = new Map();
let scheduler;
let shutdownPromise;
const paperPositionMonitor = createStockPositionMonitor({ onState: state => { updateRuntime({ positionMonitor: state }); } });
let unregisterAlpacaBarHandler;
let resolveWorkerReady;
export const workerReady = new Promise((resolve) => {
  resolveWorkerReady = resolve;
});

export function getRuntimeState() { return { ...runtime }; }
const updateRuntime = (patch) => Object.assign(runtime, patch);
const runnerHeartbeat = createRunnerHeartbeat({ bot: 'stocks', directory: dataDir, role: 'discord-service',
  getState: () => ({ state: runtime.state, phase: runtime.phase, discordReady: runtime.discordReady, schedulerRunning: runtime.schedulerRunning,
    lastScanAt: runtime.lastScanAt || null, positionMonitor: paperPositionMonitor.snapshot(), emergencyStopActive: config.sharedPaperEmergencyStop, liveTradingEnabled: false,
    liveTradingRequested: process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true', orderRoutingAvailable: false,
    ledgerFingerprint: paperLedgerFingerprint(config.sharedPaperStatePath) }) });
runnerHeartbeat.start();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function registerCommands(guildId = '') {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = guildId ? Routes.applicationGuildCommands(config.clientId, guildId) : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body: buildCommands() });
}

function activePredictions(tracker) {
  return (tracker.predictions || []).filter((row) => !['loss', 'fell_short', 'target_hit', 'exceeded', 'not_filled'].includes(row.status));
}

export async function runGuildScan(guildId, options = {}) {
  if (running.has(guildId)) return { skipped: true, reason: 'scan_already_running', assetsScreened: 0, candidates: [], predictions: [], outcomes: [] };
  running.add(guildId);
  const now = new Date();
  const startedAt = now.toISOString();
  const scanStartedMs = Date.now();
  const providerMetrics = createProviderMetrics();
  const stageDurationsMs = {};
  let stage = 'settings';
  let partialFunnel = {};
  try {
    const settings = await getGuildSettings(guildId);
    const restartRecovery = config.sharedPaperStatePath
      ? await recoverPaperOrders({ owner: 'stocks', statePath: config.sharedPaperStatePath, now: Date.now(), emergencyStop: config.sharedPaperEmergencyStop }) : null;
    const session = marketSession(now);
    const tracker = await readTracker(guildId);
    let restartTrackerReconciliation = { status: 'not_configured', linked: 0, missing: 0, ownerMismatch: 0, activeDivergence: 0, statusChanges: 0 };
    if (config.sharedPaperStatePath) {
      try {
        const reconciled = await reconcileSharedPaperOrders({ owner: 'stocks', predictions: tracker.predictions, config,
          now: Date.now(), activeStatuses: ['pending_entry', 'tracking', 'target_tracking'] });
        tracker.predictions = reconciled.predictions;
        const { predictions: _predictions, ...summary } = reconciled;
        restartTrackerReconciliation = summary;
        if (summary.statusChanges > 0) await writeTracker(guildId, tracker);
      } catch (error) {
        restartTrackerReconciliation = { ...restartTrackerReconciliation, status: 'unavailable', error: String(error.message || error).slice(0, 160) };
      }
    }
    const dateKey = localDateKey(now, config.timezone);
    const previousDiscovery = await readDailyDiscovery(guildId, dateKey);
    const hasOpen = activePredictions(tracker).length > 0;
    if (!session.monitorable && !options.forceProvider && !options.manual && !hasOpen) {
      return { skipped: true, reason: 'market_closed', session, assetsScreened: 0, candidates: [], predictions: [], outcomes: [] };
    }

    let researchMaintenance = null;
    if (options.opening || options.manual) {
      const universeStarted = Date.now();
      const keys = providerKeys(settings);
      const universe = await captureUniverseSnapshot(guildId, keys, now, providerMetrics).catch((error) => ({ skipped: true, reason: error.message }));
      const labeling = await labelPendingResearch({ guildId, provider: `alpaca-${config.alpacaDataFeed}`, slippageBps: config.counterfactualSlippageBps }).catch((error) => ({ labelsAdded: 0, error: error.message }));
      const training = labeling.labelsAdded > 0 ? await maybeTrainResearchModel(guildId, settings).catch((error) => ({ skipped: true, reason: error.message })) : { skipped: true, reason: 'No newly matured counterfactual labels.' };
      researchMaintenance = { universe, labeling, training };
      stageDurationsMs.universeMaintenance = Date.now() - universeStarted;
    }

    const allowNewSignals = Boolean(options.allowNewSignals ?? session.openForDiscovery);
    const discoverPremarket = Boolean((options.discoverPremarket ?? (session.state === 'pre_market')) && session.state === 'pre_market');
    const scanConfiguredUniverse = shouldScanConfiguredUniverse(session, { allowNewSignals, discoverPremarket });
    const openSymbols = activePredictions(tracker).map((row) => row.symbol);
    const scanSettings = scanConfiguredUniverse ? settings : { ...settings, watchlist: [...new Set([...openSymbols, 'SPY', 'QQQ'])] };
    updateAlpacaStreamSymbols(guildId, [...openSymbols, ...scanSettings.watchlist]);
    stage = 'market_data';
    const marketDataStarted = Date.now();
    const snapshot = await fetchMarketUniverse(guildId, {
      settings: scanSettings, cacheKey: scanConfiguredUniverse ? guildId : `${guildId}-monitor`, force: Boolean(options.forceProvider),
      now,
      maxAgeMinutes: (hasOpen || discoverPremarket) ? settings.monitorMinutes : settings.discoveryMinutes,
      crossCheck: Boolean(options.opening || options.manual || hasOpen || discoverPremarket),
      prioritySymbols: openSymbols, metrics: providerMetrics,
      dynamicDiscovery: Boolean(config.dynamicDiscovery && ['regular', 'pre_market'].includes(session.state)),
      dynamicDiscoveryMode: discoverPremarket ? 'pre_market' : 'regular',
      maxDynamicSymbols: config.dynamicDiscoveryMaxSymbols,
      dynamicCacheMinutes: discoverPremarket ? Math.min(config.dynamicDiscoveryCacheMinutes, settings.monitorMinutes) : config.dynamicDiscoveryCacheMinutes
    });
    const manualCatalystRows = await listManualCatalysts(guildId, now, { activeOnly: false }).catch((error) => {
      logEvent(client, guildId, `Manual catalyst context could not be loaded: ${String(error.message || error).slice(0, 180)}. Market scan continued without it.`, { title: 'Catalyst journal unavailable', color: COLORS.orange }).catch(() => {});
      return [];
    });
    const scanAssets = (snapshot.assets || []).map((asset) => ({ ...asset, manualCatalysts: catalystsForSymbol(manualCatalystRows, asset.symbol, now) }));
    const dynamicSymbols = snapshot.dynamicSymbols || [];
    if (dynamicSymbols.length) {
      updateAlpacaStreamSymbols(guildId, [...openSymbols, ...scanSettings.watchlist, ...dynamicSymbols]);
    }
    stageDurationsMs.marketData = Date.now() - marketDataStarted;
    const universeCoverage = summarizeStockUniverseCoverage(snapshot);
    const scannedAssetCount = universeCoverage.scannedTotal;
    const requestedAssetCount = universeCoverage.requestedTotal;
    partialFunnel = {
      universeSize: requestedAssetCount,
      successfullyScanned: scannedAssetCount,
      skipped: universeCoverage.missingMarketContext === null ? null
        : universeCoverage.missingMarketContext + universeCoverage.missingNonContext,
      ...universeCoverage,
      discoveryCandidates: null,
      dynamicScreenerCandidates: snapshot.dynamicDiscovery?.screenerCandidates ?? null,
      stockDirectory: snapshot.dynamicDiscovery?.directoryDiagnostics ?? null,
      discoveryArchive: snapshot.dynamicDiscovery?.archive ?? null,
      wideEligibleUniverse: snapshot.dynamicDiscovery?.wideEligibleUniverse ?? null,
      wideDiscoveryCandidates: snapshot.dynamicDiscovery?.wideCandidates ?? null,
      wideSnapshotsReturned: snapshot.dynamicDiscovery?.wideSnapshotsReturned ?? null,
      wideDataFeed: snapshot.dynamicDiscovery?.feed || config.alpacaDataFeed,
      wideFeedUsed: Boolean(snapshot.dynamicDiscovery?.feedUsed),
      wideCapOmissions: snapshot.dynamicDiscovery?.wideCapOmissions ?? null,
      wideRejectionCounts: snapshot.dynamicDiscovery?.wideRejectionCounts || {},
      wideRejectionSamples: snapshot.dynamicDiscovery?.wideRejectionSamples || [],
      dynamicSymbolsRequested: snapshot.dynamicDiscovery?.symbolsRequested || 0,
      dynamicDiscoveryError: snapshot.dynamicDiscovery?.error || '',
      discoveryMode: snapshot.dynamicDiscovery?.enabled ? 'watchlist + Alpaca broad snapshot and screener' : 'configured watchlist'
    };
    const scored = scanAssets.map((asset) => ({ ...asset, model: scoreAsset(asset) }));
    const sharedQuoteResult = buildStockPaperQuotes(scored, { feed: config.alpacaDataFeed,
      maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs });
    const sharedPaperQuoteEvidence = sharedQuoteResult.diagnostics;
    const executableQuotes = sharedQuoteResult.quotes;
    let sharedPaperMarkDiagnostics = { status: isSharedPaperConfigured(config) ? 'not_started' : 'not_configured', expectedPositions: 0, quotesProvided: 0, quoteMissing: 0, quoteRejected: 0 };
    if (config.sharedPaperStatePath) {
      sharedPaperMarkDiagnostics = await markSharedPaperOrders({ owner: 'stocks', quotesBySymbol: executableQuotes, config,
        sessionOpen: (at) => marketSession(new Date(at)).state === 'regular' }).catch((error) => {
        sharedPaperMarkDiagnostics = { status: 'provider_or_ledger_error', error: String(error.message || error).slice(0, 160), expectedPositions: 0, quotesProvided: executableQuotes.size, quoteMissing: 0, quoteRejected: 0 };
        logEvent(client, guildId, `Shared paper monitoring failed for this scan: ${String(error.message || error).slice(0, 160)}`, { title: 'Paper monitor unavailable', color: COLORS.orange }).catch(() => {});
        return sharedPaperMarkDiagnostics;
      });
    }
    partialFunnel.sharedPaperMarkDiagnostics = sharedPaperMarkDiagnostics;
    partialFunnel.sharedPaperQuoteEvidence = sharedPaperQuoteEvidence;
    const bySymbol = new Map(scored.map((asset) => [asset.symbol, asset]));
    const events = [];
    tracker.predictions = (tracker.predictions || []).map((prediction) => {
      const asset = bySymbol.get(prediction.symbol);
      if (!asset) return prediction;
      const result = evaluatePrediction(prediction, asset, now);
      events.push(...result.events);
      return result.prediction;
    });
    let sharedPaperReconciliation = restartTrackerReconciliation;
    if (config.sharedPaperStatePath) {
      try {
        const reconciled = await reconcileSharedPaperOrders({ owner: 'stocks', predictions: tracker.predictions, config,
          now: now.getTime(), activeStatuses: ['pending_entry', 'tracking', 'target_tracking'] });
        tracker.predictions = reconciled.predictions;
        const { predictions: _predictions, ...summary } = reconciled;
        sharedPaperReconciliation = summary;
      } catch (error) {
        sharedPaperReconciliation = { ...sharedPaperReconciliation, status: 'unavailable', error: String(error.message || error).slice(0, 160) };
      }
    }

    let trainingAttempt = null;
    if (events.length) trainingAttempt = await maybeTrainGuildModel(guildId, tracker.predictions || [], settings);
    const [champion, researchChampion] = await Promise.all([loadGuildModel(guildId), loadResearchModel(guildId)]);
    const modelStatus = researchChampion
      ? 'A v4 research model is installed. Each candidate still needs current health, edge, and execution checks.'
      : champion
        ? 'A validated v3 fallback is installed. Each candidate still needs current health, edge, and execution checks.'
        : !getAlpacaStreamStatus().configured && !settings.allowRuleOnlySignals
          ? 'No validated model is installed. The Alpaca bar stream is unconfigured, so intraday outcome labels cannot accumulate; rule-only entry alerts are disabled.'
          : settings.allowRuleOnlySignals
          ? 'No validated model is installed. This server permits explicitly labeled rule-only paper alerts.'
          : 'No validated model is installed. Rule-only entry alerts are disabled while the bot collects research.';
    stage = 'candidate_analysis';
    const analysisStarted = Date.now();
    const analysis = analyzeMomentum({ ...snapshot, assets: scanAssets }, settings);
    const decisions = new Map();
    const decidedCandidates = analysis.candidates.map((asset) => {
      const ensemble = predictResearchEnsemble(asset, researchChampion, settings, tracker.predictions || [])
        || predictEnsemble(asset, champion, settings, tracker.predictions || []);
      decisions.set(asset.symbol, ensemble);
      return { ...asset, ensemble };
    });
    for (const asset of analysis.watchCandidates) decisions.set(asset.symbol, predictResearchEnsemble(asset, researchChampion, settings, tracker.predictions || [])
      || predictEnsemble(asset, champion, settings, tracker.predictions || []));
    const candidates = decidedCandidates;
    const confirmation = updateCandidateConfirmations(previousDiscovery?.candidateStates, candidates, {
      now,
      required: settings.confirmationScans,
      discoveryMinutes: settings.discoveryMinutes
    });
    const confirmedCandidates = confirmation.confirmed;
    let modelApprovedCandidates = confirmedCandidates.filter((asset) => asset.ensemble?.decision === 'BUY'
      || (settings.allowRuleOnlySignals && asset.ensemble?.decision === 'RULE_ONLY'));
    let modelRejectedCandidates = confirmedCandidates.filter((asset) => !modelApprovedCandidates.includes(asset));
    let confirmationAdvisoryCandidates = selectConfirmationAdvisoryCandidates(candidates, confirmedCandidates, {
      required: settings.confirmationScans, allowRuleOnlySignals: settings.allowRuleOnlySignals,
    });
    const sharedPaperQuoteRefresh = { qualification: null, entry: null, entryRiskRejected: [], decisions: [] };
    partialFunnel.sharedPaperQuoteRefresh = sharedPaperQuoteRefresh;
    let candidateExecutableQuotes = executableQuotes;
    stageDurationsMs.modelAndConfirmation = Date.now() - analysisStarted;
    if (isSharedPaperConfigured(config) && marketSession(new Date()).state === 'regular') {
      stage = 'qualification_quote_refresh';
      const refreshed = await refreshStockPaperQuotes([...modelApprovedCandidates, ...modelRejectedCandidates, ...confirmationAdvisoryCandidates], {
        keys: providerKeys(settings), feed: config.alpacaDataFeed, maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, metrics: providerMetrics });
      sharedPaperQuoteRefresh.qualification = refreshed.diagnostics;
      stageDurationsMs.qualificationQuoteRefresh = refreshed.diagnostics.durationMs;
      candidateExecutableQuotes = mergeStockRefreshedQuotes(executableQuotes, refreshed);
      const refreshedBySymbol = new Map(refreshed.assets.map(asset => [asset.symbol, asset]));
      modelApprovedCandidates = modelApprovedCandidates.map(asset => refreshedBySymbol.get(asset.symbol));
      modelRejectedCandidates = modelRejectedCandidates.map(asset => refreshedBySymbol.get(asset.symbol));
      confirmationAdvisoryCandidates = confirmationAdvisoryCandidates.map(asset => refreshedBySymbol.get(asset.symbol));
    }
    stage = 'portfolio_approval';
    const portfolioNow = new Date();
    const portfolio = selectPortfolioCandidates(modelApprovedCandidates, tracker.predictions || [], settings,
      localDateKey(portfolioNow, config.marketTimezone), { now: portfolioNow });
    const signalCandidates = portfolio.selected;
    let forwardShadowResults = [];
    let forwardShadowError = null;
    if (isSharedPaperConfigured(config) && session.state === 'regular') {
      try {
        const shadowProfiles = [
          { id: 'production-exits', overrides: { stopScale: 1, targetScale: 1 }, hypothesis: 'The current exit rules retain favorable after-cost expectancy.', changeMade: 'No exit change; mirror production-selected candidates.', reason: 'Provide a contemporaneous shadow baseline.' },
          { id: 'wider-target', overrides: { stopScale: 1, targetScale: 1.2 }, hypothesis: 'A wider target improves net expectancy despite fewer target hits.', changeMade: 'Increase the target distance by 20 percent.', reason: 'Measure whether current exits truncate favorable movement.' },
          { id: 'tighter-stop', overrides: { stopScale: 0.8, targetScale: 1 }, hypothesis: 'A tighter stop reduces adverse excursion enough to improve net expectancy.', changeMade: 'Reduce stop distance by 20 percent.', reason: 'Test stop placement without changing production approval.' },
          { id: 'model-advisory', overrides: { stopScale: 1, targetScale: 1 }, hypothesis: 'Model-rejected technical candidates may have positive after-cost expectancy.', changeMade: 'Observe model-rejected candidates in a separate paper cohort.', reason: 'Quantify the model approval bottleneck without bypassing it in production.' },
          { id: 'single-scan-confirmation', overrides: { stopScale: 1, targetScale: 1 }, hypothesis: 'Earlier technical candidates may retain net expectancy after costs.', changeMade: 'Observe confirmation-advisory candidates after one scan.', reason: 'Measure the cost and benefit of consecutive confirmation.' },
        ];
        const toShadowInput = (asset, shadowCohort = 'production-selected') => ({
          instrumentKey: String(asset.symbol).toUpperCase(),
          prediction: {
            ...buildPrediction(asset, settings, guildId, now, config.timezone, tracker.predictions || []),
            confirmationCount: Number(asset.confirmationCount) || 1,
            confirmationRequired: settings.confirmationScans,
          }, asset, shadowCohort,
        });
        const shadowInputs = signalCandidates.map(toShadowInput);
        const quotes = candidateExecutableQuotes;
        const policy = sharedPaperPolicy(config, now.getTime());
        forwardShadowResults = await runForwardShadowPaper({
          owner: 'stocks', strategyVersion: 'stocks-intraday-paper-v5-decision-quote-refresh', profiles: shadowProfiles,
          monitoringEnv: { PAPER_MONITOR_INTERVAL_SECONDS: config.paperMonitor.intervalSeconds },
          allowlist: ['stopScale', 'targetScale'], baseConfig: { executionFeed: config.alpacaDataFeed, executionQuoteRefresh: STOCK_QUOTE_REFRESH_VERSION },
          observationsByProfile: {
            'model-advisory': modelRejectedCandidates.map((asset) => toShadowInput(asset, 'model-advisory')),
            'single-scan-confirmation': confirmationAdvisoryCandidates.map((asset) => toShadowInput(asset, 'confirmation-advisory')),
          },
          observations: shadowInputs, quotesByInstrument: quotes,
          evaluate: (observation, variant, decisionAt) => {
            const prediction = observation.prediction, asset = observation.asset;
            const result = buildPrimarySignalCandidate({
              owner: 'stocks', assetClass: 'stock', symbol: prediction.symbol,
              strategyId: `stocks:${prediction.horizonKey || 'daytrade'}`, signalId: prediction.id,
              sessionDate: dateKey, sessionTimeZone: config.marketTimezone,
              quote: quotes.get(String(prediction.symbol).toUpperCase()), now: decisionAt,
              entryLow: prediction.entryLow, entryHigh: prediction.entryHigh,
              stopPct: Number(prediction.stopPct) * variant.stopScale,
              targetPct: Number(prediction.targetPct) * variant.targetScale,
              forceExitAt: prediction.deadlineAt, entryExpiresAt: prediction.entryExpiresAt,
              maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, sessionOpen: marketSession(new Date(decisionAt)).state === 'regular',
              roundTripFeesPerUnit: config.sharedPaperRoundTripFeesPerShare,
              slippageReservePerUnit: Number(prediction.entryPrice || asset.askPrice || asset.price)
                * Number(config.assumedSlippageBps) * 2 / 10_000,
              signal: { guildId, horizon: prediction.horizonKey, score: prediction.score, confidence: prediction.confidence,
                modelDecision: prediction.ensembleDecision, modelSource: prediction.ensembleSource,
                confirmationCount: prediction.confirmationCount, confirmationRequired: prediction.confirmationRequired,
                shadowCohort: observation.shadowCohort,
                modelReason: String(prediction.ensemble?.reason || '').slice(0, 180) },
            });
            return result.status === 'candidate' ? result : { status: 'no-setup', reasons: result.reasons };
          },
          stateDirectory: `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`, portfolioStatePath: config.sharedPaperStatePath, now: Date.now(), observationClock: Date.now,
          accountEquity: config.sharedPaperAccountEquity, riskPolicy: policy,
          maxQuoteAgeMs: policy.maxQuoteAgeMs, maxSpreadPct: policy.maxSpreadPct, sessionOpen: true, sessionDate: dateKey,
        });
      } catch (error) { forwardShadowError = String(error.message || error).slice(0, 180); }
    }
    analysis.diagnostics.confirmed = confirmedCandidates.length;
    analysis.diagnostics.modelApproved = modelApprovedCandidates.length;
    analysis.diagnostics.portfolioSelected = signalCandidates.length;
    analysis.diagnostics.portfolioRejected = portfolio.rejected.length;
    analysis.diagnostics.circuitBreaker = portfolio.breaker;
    analysis.diagnostics.portfolioReadiness = portfolioReadinessText(portfolio);
    analysis.diagnostics.exposure = portfolio.exposure;
    analysis.diagnostics.portfolioRejections = portfolio.rejected;
    analysis.diagnostics.ensembleBuy = confirmedCandidates.filter((asset) => asset.ensemble?.decision === 'BUY').length;
    analysis.diagnostics.ensembleWatch = confirmedCandidates.filter((asset) => asset.ensemble?.decision === 'WATCH').length;
    analysis.diagnostics.noEdge = confirmedCandidates.filter((asset) => asset.ensemble?.decision === 'NO_EDGE').length;
    analysis.diagnostics.pendingConfirmation = Math.max(0, candidates.length - confirmedCandidates.length);
    stageDurationsMs.candidateApproval = Math.max(0, Date.now() - analysisStarted
      - stageDurationsMs.modelAndConfirmation - (stageDurationsMs.qualificationQuoteRefresh || 0));
    analysis.diagnostics.sharedPaperQuoteRefresh = sharedPaperQuoteRefresh;
    stage = 'snapshot_persistence';
    const dispositions = buildResearchDispositions({ analysis, candidates, confirmed: confirmedCandidates,
      modelRejected: modelRejectedCandidates, portfolio, selected: signalCandidates });
    await recordFeatureSnapshot({ guildId, assets: scored, analysis: { ...analysis, candidates }, decisions, dispositions,
      reason: options.reason || (options.manual ? 'manual' : 'scheduled'), now });
    let posted = [];
    if (allowNewSignals) {
      const todaysCount = (tracker.predictions || []).filter((item) => item.dateKey === dateKey).length;
      const slots = Math.max(0, settings.maxSignals - todaysCount);
      let entryCandidates = signalCandidates.slice(0, slots), entryQuotes = candidateExecutableQuotes;
      if (isSharedPaperConfigured(config) && entryCandidates.length && marketSession(new Date()).state === 'regular') {
        stage = 'entry_quote_refresh';
        const refreshed = await refreshStockPaperQuotes(entryCandidates, { keys: providerKeys(settings),
          feed: config.alpacaDataFeed, maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, metrics: providerMetrics });
        sharedPaperQuoteRefresh.entry = refreshed.diagnostics;
        stageDurationsMs.entryQuoteRefresh = refreshed.diagnostics.durationMs;
        entryQuotes = refreshed.quotes;
        // Shadow work and persistence can age quotes. Reapply every local portfolio
        // gate with the refreshed spread and current clock before shared reservation.
        const entryNow = new Date();
        const entryPortfolio = selectPortfolioCandidates(refreshed.assets, tracker.predictions || [], settings,
          localDateKey(entryNow, config.marketTimezone), { now: entryNow });
        entryCandidates = entryPortfolio.selected;
        sharedPaperQuoteRefresh.entryRiskRejected = entryPortfolio.rejected;
      }
      stage = 'entry_reservation';
      let proposed = buildPredictions(
        entryCandidates,
        { ...settings, maxSignals: slots },
        guildId,
        now,
        config.timezone,
        tracker.predictions || []
      );
      const sharedReservations = new Map();
      if (isSharedPaperConfigured(config)) {
        const approved = [];
        const stockBySymbol = new Map(entryCandidates.map((asset) => [String(asset.symbol).toUpperCase(), asset]));
        for (const prediction of proposed) {
          const asset = stockBySymbol.get(String(prediction.symbol).toUpperCase());
          const quote = entryQuotes.get(String(prediction.symbol).toUpperCase());
          const decisionAt = Date.now();
          sharedPaperQuoteRefresh.decisions.push(stockDecisionQuoteObservation(prediction.symbol, quote, decisionAt));
          const shared = buildPrimarySignalCandidate({
            owner: 'stocks', assetClass: 'stock', symbol: prediction.symbol, strategyId: `stocks:${prediction.horizonKey || 'daytrade'}`,
            signalId: prediction.id, sessionDate: dateKey, sessionTimeZone: config.marketTimezone, quote, now: decisionAt,
            entryLow: prediction.entryLow, entryHigh: prediction.entryHigh, stopPct: prediction.stopPct,
            targetPct: prediction.targetPct, forceExitAt: prediction.deadlineAt, entryExpiresAt: prediction.entryExpiresAt,
            maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs, sessionOpen: marketSession(new Date(decisionAt)).state === 'regular',
            roundTripFeesPerUnit: config.sharedPaperRoundTripFeesPerShare,
            slippageReservePerUnit: Number(prediction.entryPrice || asset?.askPrice || asset?.price) * Number(config.assumedSlippageBps) * 2 / 10_000,
            researchContext: { setupType: prediction.setupFamily || 'intraday_momentum',
              marketRegime: prediction.marketRegime || asset?.marketRegime, regimeSource: 'spy_breadth',
              observedAt: asset?.lastUpdated || null,
              features: { setup_score: prediction.score, relative_volume: asset?.relativeVolume,
                rsi14: asset?.rsi14, atr_percent: prediction.atrPercent,
                vwap_distance_pct: asset?.vwapDistancePct, relative_strength_day: asset?.relativeStrengthDay,
                confirmation_count: prediction.confirmationCount } },
            marketGateTrace: { source: 'market_candidate_emission', owner: 'stocks',
              strategyId: `stocks:${prediction.horizonKey || 'daytrade'}`, observedAt: quote?.time,
              passedGates: ['confirmed_candidate', 'model_or_rule_gate', 'portfolio_selected',
                ...(asset?.ensemble?.decision === 'BUY' ? ['model_buy_decision'] : []),
                ...(asset?.ensemble?.decision === 'RULE_ONLY' ? ['rule_only_allowed'] : [])] },
            signal: { guildId, horizon: prediction.horizonKey, score: prediction.score, confidence: prediction.confidence }
          });
          if (shared.status !== 'candidate') {
            analysis.diagnostics.sharedPaperRejected = (analysis.diagnostics.sharedPaperRejected || 0) + 1;
            analysis.diagnostics.sharedPaperTopRejections ||= {};
            for (const reason of shared.reasons) analysis.diagnostics.sharedPaperTopRejections[reason] = (analysis.diagnostics.sharedPaperTopRejections[reason] || 0) + 1;
            continue;
          }
          try {
            const reservation = await reserveSharedPaperCandidate(shared.candidate, config);
            if (reservation.status !== 'reserved') {
              analysis.diagnostics.sharedPaperRejected = (analysis.diagnostics.sharedPaperRejected || 0) + 1;
              analysis.diagnostics.sharedPaperTopRejections ||= {};
              for (const reason of (reservation.reasons || [reservation.reason || reservation.status])) analysis.diagnostics.sharedPaperTopRejections[reason] = (analysis.diagnostics.sharedPaperTopRejections[reason] || 0) + 1;
              continue;
            }
            prediction.sharedPaperOrderId = reservation.order.orderId;
            prediction.sharedPaperStatus = 'reserved';
            sharedReservations.set(prediction.id, reservation.order.orderId);
            approved.push(prediction);
          } catch (error) {
            analysis.diagnostics.sharedPaperRejected = (analysis.diagnostics.sharedPaperRejected || 0) + 1;
            analysis.diagnostics.sharedPaperTopRejections ||= {};
            analysis.diagnostics.sharedPaperTopRejections.ledger_error = (analysis.diagnostics.sharedPaperTopRejections.ledger_error || 0) + 1;
            logEvent(client, guildId, `Shared paper ledger unavailable; ${prediction.symbol} was not posted. ${String(error.message || error).slice(0, 160)}`, { title: 'Paper risk ledger unavailable', color: COLORS.orange }).catch(() => {});
          }
        }
        proposed = approved;
      }
      const merged = mergeNewPredictions(tracker, proposed);
      tracker.predictions = merged.predictions;
      posted = merged.added;
      for (const prediction of posted) {
        try {
          const message = await postNewPrediction(client, guildId, prediction);
          prediction.messageId = message.id; prediction.channelId = message.channelId;
        } catch (error) {
          const orderId = sharedReservations.get(prediction.id);
          if (orderId) await transitionPaperOrder(orderId, 'cancelled', { statePath: config.sharedPaperStatePath }).catch(() => {});
          throw error;
        }
      }
    }
    tracker.updatedAt = now.toISOString();
    await writeTracker(guildId, tracker);
    if (posted.length) {
      try {
        const handoff = await publishPrimaryResearchSignals('stocks', posted, { now: now.getTime() });
        if (handoff.rowsRejected) await logEvent(client, guildId,
          `Cross-bot research handoff wrote ${handoff.rowsWritten} signal(s) and rejected ${handoff.rowsRejected}: ${handoff.rejectionCounts.explicit_no_action} explicit no-action, ${handoff.rejectionCounts.ambiguous_direction} ambiguous direction, ${handoff.rejectionCounts.other_invalid_record} other invalid record(s).`,
          { title: 'Cross-bot signal quality', color: COLORS.orange }).catch(() => {});
      } catch (error) {
        logEvent(client, guildId, `Primary signal research handoff could not be saved: ${String(error.message || error).slice(0, 140)}`, { title: 'Cross-bot research handoff unavailable', color: COLORS.orange }).catch(() => {});
      }
    }
    await Promise.all([recordPredictionCreated(guildId, posted), recordPredictionEvents(guildId, events)]).catch(async (error) => {
      await logEvent(client, guildId, `Tracker was saved, but the append-only research event log failed: ${error.message}`, { title: 'Research store degraded', color: COLORS.orange, pingAdmin: true }).catch(() => {});
    });
    for (const outcome of events) await postOutcome(client, guildId, outcome);
    if (trainingAttempt?.accepted) await logEvent(client, guildId, `Validated challenger ${trainingAttempt.id} passed chronological holdout gates and was promoted to champion.`, { title: 'Ensemble model promoted', color: COLORS.green });
    if (researchMaintenance?.training?.validation?.accepted) await logEvent(client, guildId, `Auralith v4 research champion ${researchMaintenance.training.id} promoted with ${researchMaintenance.training.acceptedExperts.length} purged expert(s).`, { title: 'Research model promoted', color: COLORS.green });

    const ordinaryWatches = buildResearchWatches(analysis, posted, confirmedCandidates, now);
    const premarketAnalysis = discoverPremarket ? analyzePremarketBreakoutWatches(scanAssets, now, settings) : null;
    const premarketBreakouts = premarketAnalysis?.watches || [];
    if (premarketAnalysis) analysis.diagnostics.premarket = premarketAnalysis.diagnostics;
    const prioritizedWatches = new Map(premarketBreakouts.map((row) => [row.symbol, row]));
    for (const row of ordinaryWatches) if (!prioritizedWatches.has(row.symbol)) prioritizedWatches.set(row.symbol, row);
    const watchOnly = [...prioritizedWatches.values()].map((row) => ({
      ...row,
      session: discoverPremarket ? 'pre_market' : session.state,
      ...(discoverPremarket ? { premarketBreakout: Boolean(row.premarketBreakout) } : {})
    }));
    const announcedWatches = new Set(previousDiscovery?.watchNoticeSymbols || previousDiscovery?.watchOnly?.map((row) => row.symbol) || []);
    const newWatches = newResearchWatchUpdates(watchOnly, previousDiscovery);
    const discovery = {
      ...(previousDiscovery || {}), version: 4, guildId, dateKey, updatedAt: now.toISOString(), source: snapshot.source,
      stale: Boolean(snapshot.stale), assetsScreened: snapshot.assets?.length || 0, modelStatus,
      candidateCount: candidates.length, confirmedCount: confirmedCandidates.length, modelApprovedCount: modelApprovedCandidates.length, portfolioSelectedCount: signalCandidates.length,
      candidateStates: confirmation.states,
      premarketWatchNoticeKeys: [...(previousDiscovery?.premarketWatchNoticeKeys || [])],
      dynamicUniverse: snapshot.dynamicDiscovery || { enabled: false, screenerCandidates: 0, symbolsRequested: 0 },
      watchOnly,
      watchNoticeSymbols: options.opening ? [...new Set([...announcedWatches, ...watchOnly.filter((row) => row.direction === 'UPWARD WATCH').map((row) => row.symbol)])] : [...announcedWatches],
      diagnostics: analysis.diagnostics,
      predictions: [...(previousDiscovery?.predictions || []), ...posted].filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index)
    };
    const reasonCounts = { ...(analysis.diagnostics.rejectedByReason || {}) };
    const rejectionDetails = [...(analysis.rejectionRecords || [])];
    const etfOwnershipExclusions = snapshot.dynamicDiscovery?.etfDirectory?.excludedSymbols || [];
    if (etfOwnershipExclusions.length) {
      const blocked = new Set(snapshot.dynamicDiscovery.etfDirectory.blockedExcludedSymbols || []);
      const blockedCount = snapshot.dynamicDiscovery.etfDirectory.blockedExcludedCount || 0;
      reasonCounts.primary_owner_etf_etp = (reasonCounts.primary_owner_etf_etp || 0)
        + Math.max(0, snapshot.dynamicDiscovery.etfDirectory.excludedFromDiscovery - blockedCount);
      reasonCounts.unreviewed_etp_classification = (reasonCounts.unreviewed_etp_classification || 0) + blockedCount;
      rejectionDetails.push(...etfOwnershipExclusions.map((symbol) => ({ symbol, stage: 'instrument_ownership',
        reasonCodes: [blocked.has(symbol) ? 'unreviewed_etp_classification' : 'primary_owner_etf_etp'],
        reasons: [blocked.has(symbol)
          ? 'ETP wrapper classification is expired or invalid; withheld from Stocks discovery pending review.'
          : 'Classified by the Nasdaq Trader ETF directory or reviewed ETP registry; ETF/ETP is its primary scanner.'] })));
    }
    const deepAnalysisOmissions = snapshot.dynamicDiscovery?.capOmissionRecords || [];
    for (const omission of deepAnalysisOmissions) {
      const code = omission.reasonCode || 'deep_analysis_cap';
      reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      rejectionDetails.push({ symbol: omission.symbol, stage: omission.stage || 'deep_analysis_cap', reasonCodes: [code],
        reasons: [omission.reason || 'Passed discovery but was omitted from deep analysis by the configured candidate cap.'],
        discoverySource: omission.discoverySource || '', discoveryScore: omission.discoveryScore ?? null,
        price: omission.price ?? null, previousClose: omission.previousClose ?? null,
        changePct: omission.changePct ?? null, dollarVolume: omission.dollarVolume ?? null });
    }
    for (const rejection of pendingConfirmationRejections(candidates, confirmation.states, settings.confirmationScans)) {
      for (const code of rejection.reasonCodes) reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      rejectionDetails.push(rejection);
    }
    for (const asset of modelRejectedCandidates) {
      const decision = asset.ensemble?.decision || 'NO_MODEL_DECISION';
      const code = `model_${String(decision).toLowerCase()}`;
      reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      rejectionDetails.push({ symbol: asset.symbol, stage: 'model', reasonCodes: [code], reasons: [asset.ensemble?.reason || 'No validated model BUY approval.'] });
    }
    for (const rejection of portfolio.rejected || []) {
      const code = `risk_${String(rejection.reason || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
      reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      rejectionDetails.push({ symbol: rejection.symbol, stage: 'risk', reasonCodes: [code], reasons: [rejection.reason] });
    }
    for (const rejection of stockQuoteRefreshRejections(sharedPaperQuoteRefresh)) {
      for (const code of rejection.reasonCodes) reasonCounts[code] = (reasonCounts[code] || 0) + 1;
      rejectionDetails.push(rejection);
    }
    const providerSummary = summarizeProviderMetrics(providerMetrics);
    const staleRejectionBreakdown = countStaleRejections({ technical: analysis.rejectionRecords || [],
      wideDiscovery: snapshot.dynamicDiscovery || {}, premarket: premarketAnalysis?.diagnostics || {} });
    const totalDurationMs = Date.now() - scanStartedMs;
    stageDurationsMs.persistenceAndPosts = Math.max(0, totalDurationMs - Object.values(stageDurationsMs).reduce((sum, value) => sum + value, 0));
    const diagnostic = {
      guildId: String(guildId), startedAt, completedAt: new Date().toISOString(), durationMs: totalDurationMs,
      reason: options.reason || (options.manual ? 'manual' : 'scheduled'), stageDurationsMs,
      cacheHit: Boolean(snapshot.cacheHit), source: snapshot.source || 'unknown',
      universeSize: requestedAssetCount,
      successfullyScanned: scannedAssetCount,
      skipped: partialFunnel.skipped,
      ...universeCoverage,
      providerFailures: providerSummary.reduce((sum, provider) => sum + provider.failures, 0),
      discoveryCandidates: analysis.diagnostics.instruments,
      ownershipStatus: analysis.diagnostics.ownershipStatus,
      ownershipExcluded: analysis.diagnostics.ownershipExcluded,
      ownershipError: snapshot.ownership?.error || '',
      sectorProxyCoverage: summarizeSectorProxyCoverage(scanAssets),
      secIndustryCoverage: summarizeSecIndustryCoverage(scanAssets),
      recentNewsClassification: summarizeStockHeadlineClassification(scanAssets.flatMap((asset) => asset.recentNews || [])),
      discoveryMode: snapshot.dynamicDiscovery?.enabled ? 'watchlist + Alpaca broad snapshot and screener' : 'configured watchlist; dynamic discovery disabled',
      dynamicScreenerCandidates: snapshot.dynamicDiscovery?.screenerCandidates ?? null,
      stockDirectory: snapshot.dynamicDiscovery?.directoryDiagnostics ?? null,
      discoveryArchive: snapshot.dynamicDiscovery?.archive ?? null,
      wideEligibleUniverse: snapshot.dynamicDiscovery?.wideEligibleUniverse ?? null,
      wideDiscoveryCandidates: snapshot.dynamicDiscovery?.wideCandidates ?? null,
      deepAnalysisCapOmissions: deepAnalysisOmissions.length,
      wideSnapshotsReturned: snapshot.dynamicDiscovery?.wideSnapshotsReturned ?? null,
      wideDataFeed: snapshot.dynamicDiscovery?.feed || config.alpacaDataFeed,
      wideFeedUsed: Boolean(snapshot.dynamicDiscovery?.feedUsed),
      dynamicSymbolsRequested: snapshot.dynamicDiscovery?.symbolsRequested ?? null,
      dynamicDiscoveryError: snapshot.dynamicDiscovery?.error || '',
      etfDirectory: snapshot.dynamicDiscovery?.etfDirectory || null,
      premarketDiscovery: premarketAnalysis?.diagnostics || null,
      candidateFilterPassed: analysis.diagnostics.liquid,
      technicalQualified: candidates.length,
      watchOnly: analysis.diagnostics.watchOnly,
      confirmed: confirmedCandidates.length,
      pendingConfirmation: analysis.diagnostics.pendingConfirmation,
      modelApproved: modelApprovedCandidates.length,
      modelRejected: modelRejectedCandidates.length,
      riskRejected: (portfolio.rejected || []).length,
      sharedPaperConfigured: isSharedPaperConfigured(config),
      sharedPaperMarkDiagnostics,
      sharedPaperQuoteEvidence,
      sharedPaperQuoteRefresh,
      sharedPaperEmergencyStop: config.sharedPaperEmergencyStop,
      liveTradingEnabled: false,
      liveTradingRequested: process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true',
      orderRoutingAvailable: false,
      restartRecovery,
      sharedPaperReconciliation,
      forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
      forwardShadowError,
      sharedPaperRejected: analysis.diagnostics.sharedPaperRejected || 0,
      sharedPaperRejectionReasons: analysis.diagnostics.sharedPaperTopRejections || {},
      sharedPaper: await getSharedPaperDiagnostics(config, { sessionDate: dateKey, now: Date.now() }),
      setups: posted.length,
      staleRejections: staleRejectionBreakdown.totalGateRejections,
      staleRejectionBreakdown,
      topRejectionReasons: reasonCounts,
      rejectionDetails,
      failedSymbols: snapshot.failedSymbols || [],
      providers: providerSummary
    };
    discovery.funnel = diagnostic;
    discovery.scanHistory = [...(previousDiscovery?.scanHistory || []), diagnostic].slice(-100);
    await recordScanDiagnostic(diagnostic).catch((error) => console.error('Unable to persist scan diagnostics:', error.message));
    await writeDailyDiscovery(guildId, dateKey, discovery);
    if (options.opening && !discovery.openingPostedAt) {
      discovery = markNotificationAttempt(discovery, 'opening');
      await writeDailyDiscovery(guildId, dateKey, discovery);
      const message = await postOpeningSummary(client, guildId, discovery);
      discovery = markNotificationPosted(discovery, 'opening', message);
      await writeDailyDiscovery(guildId, dateKey, discovery);
    } else if ((session.openForDiscovery || discoverPremarket) && newWatches.length) {
      const message = await postResearchWatchUpdate(client, guildId, dateKey, newWatches, { assetsScreened: discovery.assetsScreened });
      if (message) {
        if (discoverPremarket) {
          discovery.premarketWatchNoticeKeys = [...new Set([...(discovery.premarketWatchNoticeKeys || []),
            ...newWatches.filter((row) => row.session === 'pre_market').map(premarketWatchNoticeKey)])];
        } else {
          discovery.watchNoticeSymbols = [...new Set([...announcedWatches, ...newWatches.map((row) => row.symbol)])];
        }
        await writeDailyDiscovery(guildId, dateKey, discovery);
      }
    }
    updateRuntime({ state: 'running', phase: 'idle', lastScanAt: now.toISOString(), scansCompleted: runtime.scansCompleted + 1, lastError: '' });
    lastScanByGuild.set(guildId, now.getTime());
    return { ...discovery, candidates, confirmedCandidates, modelApprovedCandidates, signalCandidates, portfolio, researchMaintenance, predictions: posted, outcomes: events, session, cacheHit: snapshot.cacheHit };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateRuntime({ state: 'degraded', phase: 'scan_error', lastError: message, lastScanAt: now.toISOString() });
    const failedDiagnostic = {
      guildId: String(guildId), startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - scanStartedMs,
      failed: true, failedStage: stage, error: message.slice(0, 500), stageDurationsMs,
      liveTradingEnabled: false, liveTradingRequested: process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true', orderRoutingAvailable: false,
      ...partialFunnel, providers: summarizeProviderMetrics(providerMetrics)
    };
    await recordScanDiagnostic(failedDiagnostic).catch((writeError) => console.error('Unable to persist failed scan diagnostics:', writeError.message));
    await logEvent(client, guildId, message, { title: 'Stock scan failed', color: COLORS.red, pingAdmin: true }).catch(() => {});
    throw error;
  } finally { running.delete(guildId); }
}

async function scheduledTick() {
  const tickStartedAt = new Date();
  updateRuntime({ phase: 'scheduler_tick', lastTickAt: tickStartedAt.toISOString(), lastError: '' });
  if (!client.isReady()) {
    updateRuntime({ state: 'reconnecting', phase: 'discord_not_ready' });
    return;
  }
  const session = marketSession();
  const guildIds = await listConfiguredGuildIds(client);
  updateRuntime({ configuredGuilds: guildIds.length });
  try {
    for (const guildId of guildIds) {
      const settings = await getGuildSettings(guildId);
      const tracker = await readTracker(guildId);
      const open = activePredictions(tracker).length > 0;
      const dateKey = localDateKey(new Date(), config.timezone);
      let discovery = await readDailyDiscovery(guildId, dateKey);
      if (session.state === 'closed' && localParts(new Date(), config.marketTimezone).weekday === 'Sun'
        && !discovery?.weeklyStatusPostedAt) {
        const [champion, researchChampion] = await Promise.all([loadGuildModel(guildId), loadResearchModel(guildId)]);
        const modelStatus = researchChampion || champion
          ? 'A validated model is installed; current market data and execution checks are still required before any entry alert.'
          : !getAlpacaStreamStatus().configured && !settings.allowRuleOnlySignals
            ? 'No validated model is installed. The Alpaca bar stream is unconfigured, so intraday outcome labels cannot accumulate; rule-only entry alerts are disabled.'
            : settings.allowRuleOnlySignals
            ? 'No validated model is installed; rule-only paper alerts are enabled for this server.'
            : 'No validated model is installed. Rule-only trade alerts remain disabled while research is collected.';
        const message = await postWeeklyStatus(client, guildId, { dateKey, modelStatus });
        discovery = { ...(discovery || {}), version: 4, guildId, dateKey,
          weeklyStatusPostedAt: new Date().toISOString(), weeklyStatusMessageId: message.id };
        await writeDailyDiscovery(guildId, dateKey, discovery);
      }
      const opening = session.openForDiscovery
        && notificationRetryReady(discovery, 'opening')
        && (isDailyDiscoveryDue(new Date(), settings) || session.state === 'regular');
      const elapsed = lastScanByGuild.has(guildId) ? Date.now() - lastScanByGuild.get(guildId) : Infinity;
      const activeCadence = activePredictions(tracker).map((prediction) => Number(prediction.monitoringMinutes)).filter(Number.isFinite);
      const cadence = open ? Math.min(settings.monitorMinutes, ...(activeCadence.length ? activeCadence : [settings.monitorMinutes]))
        : session.state === 'pre_market' ? Math.min(settings.monitorMinutes, settings.discoveryMinutes) : settings.discoveryMinutes;
      if (opening || ((session.monitorable || open) && elapsed >= cadence * 60_000)) {
        await runGuildScan(guildId, {
          reason: opening ? 'opening' : 'interval',
          opening,
          allowNewSignals: session.openForDiscovery,
          discoverPremarket: session.state === 'pre_market'
        });
        await sleep(500);
      }
      discovery = await readDailyDiscovery(guildId, dateKey);
      if (discovery && isDailyReviewDue() && notificationRetryReady(discovery, 'review')) {
        discovery = markNotificationAttempt(discovery, 'review');
        await writeDailyDiscovery(guildId, dateKey, discovery);
        const latestTracker = await readTracker(guildId);
        const message = await postDailyReview(client, guildId, discovery, latestTracker.predictions || []);
        if (message) {
          discovery = markNotificationPosted(discovery, 'review', message);
          await writeDailyDiscovery(guildId, dateKey, discovery);
          await logEvent(client, guildId, `Posted restart-safe daily stock review for ${dateKey}.`, { title: 'Daily stock review' });
        }
      }
      if (config.investmentDailyResearch && latestCompletedSession(new Date()) === localDateKey(new Date(), config.marketTimezone)) {
        const symbols = settings.watchlist.filter((s) => !['SPY', 'QQQ', 'IWM', 'DIA'].includes(s) && !s.startsWith('XL'));
        // Once per completed session, restart-safe; no new channel or notification.
        await collectInvestmentResearch(guildId, symbols, { automatic: true, settings });
      }
    }
    updateRuntime({
      state: 'running', phase: 'idle',
      nextTickAt: new Date(Date.now() + 60_000).toISOString(),
      lastError: ''
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    updateRuntime({
      state: 'degraded', phase: 'scheduler_error', lastError: message.slice(0, 2000),
      nextTickAt: new Date(Date.now() + 60_000).toISOString()
    });
    console.error(`[${new Date().toISOString()}] Stocks scheduler tick failed:`, error);
  }
}

function parseSymbols(value) {
  return [...new Set(String(value || '').toUpperCase().split(/[\s,;]+/).filter((s) => /^[A-Z][A-Z0-9.-]{0,10}$/.test(s)))];
}

function fitPrivateThesisContent(content, limit = 1990) {
  if (content.length <= limit) return content;
  const separator = content.lastIndexOf('\n\n');
  const disclosure = separator >= 0 ? content.slice(separator + 2) : '';
  const body = separator >= 0 ? content.slice(0, separator) : content;
  const budget = Math.max(0, limit - disclosure.length - (disclosure ? 5 : 1));
  return disclosure ? `${body.slice(0, budget).trimEnd()}…\n\n${disclosure}` : `${body.slice(0, limit - 1)}…`;
}

function outcomeLines(rows, count) {
  return rows.slice(-count).reverse().map((p) => `**${p.symbol}** | ${p.status.replace('_', ' ')} | ${formatPrice(p.currentPrice)} | ${formatPercent((p.currentPrice / p.entryPrice - 1) * 100)}`).join('\n') || 'No matching paper setups.';
}

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const watchlistChange = sub === 'watchlist' && interaction.options.getString('action') !== 'show';
  const modelTraining = sub === 'model' && interaction.options.getString('action') === 'train';
  const adminOnly = ['setup', 'configure', 'api-key', 'scan', 'role', 'diagnostics', 'catalyst'].includes(sub) || watchlistChange || modelTraining;
  if (adminOnly && !isAdminInteraction(interaction)) return interaction.reply({ content: 'This command requires Manage Server or Administrator.', ephemeral: true });
  await interaction.deferReply({ ephemeral: adminOnly || ['status', 'ticker', 'thesis'].includes(sub) });
  const guildId = interaction.guildId;
  if (sub === 'thesis') {
    const action = interaction.options.getString('action', true);
    const userId = interaction.user.id;
    if (action === 'add') {
      try {
        const result = await appendThesisRevision(userId, {
          assetId: interaction.options.getString('asset'), thesisType: interaction.options.getString('thesis_type'),
          horizonMonths: interaction.options.getInteger('horizon_months'), reviewDate: interaction.options.getString('review_date'),
          thesis: interaction.options.getString('thesis'), assumptions: interaction.options.getString('assumptions'),
          baseCase: interaction.options.getString('base_case'), bullCase: interaction.options.getString('bull_case'),
          bearCase: interaction.options.getString('bear_case'), invalidation: interaction.options.getString('invalidation'),
          catalysts: interaction.options.getString('catalysts'), sources: (interaction.options.getString('source_urls') || '').split(/\s+/).filter(Boolean)
        });
        const entry = result.entry;
        return interaction.editReply({ content: `Private thesis revision ${entry.revision} saved for **${entry.assetId}** (${entry.horizonMonths}-month horizon). It is a user-authored research record, not a score, forecast, or buy instruction.`, allowedMentions: { parse: [] } });
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
      const asset = String(interaction.options.getString('asset') || '').trim().toUpperCase();
      const thesis = latestTheses(journal).find((row) => row.assetId === asset);
      if (!thesis) return interaction.editReply({ content: `No saved thesis found for ${asset || 'that ticker'}. Save a thesis first.`, allowedMentions: { parse: [] } });
      const priorPerformance = summarizeThesisPerformance(journal, asset);
      if (priorPerformance.latest?.asOf === latestCompletedSession(new Date())) {
        const cachedText = priorPerformance.snapshots === 1 || priorPerformance.elapsedDays === 0
          ? `Reference baseline ${priorPerformance.baseline.assetPrice.toFixed(2)} saved on ${priorPerformance.baseline.asOf}; a later completed session is needed to measure change.`
          : `Since ${priorPerformance.baseline.asOf}: ${priorPerformance.assetReturnPct >= 0 ? '+' : ''}${priorPerformance.assetReturnPct.toFixed(2)}% for ${asset}; SPY ${priorPerformance.benchmarkReturnPct >= 0 ? '+' : ''}${priorPerformance.benchmarkReturnPct.toFixed(2)}%; relative ${priorPerformance.relativeReturnPp >= 0 ? '+' : ''}${priorPerformance.relativeReturnPp.toFixed(2)} percentage points over ${Math.floor(priorPerformance.elapsedDays)} days.`;
        const cachedDrawdown = priorPerformance.assetObservedMaxDrawdownPct === null
          ? 'Observed mark-to-mark drawdown: unavailable until at least two comparable marks exist.'
          : `Observed mark-to-mark maximum drawdown: ${priorPerformance.assetObservedMaxDrawdownPct.toFixed(2)}% for ${asset}; SPY ${priorPerformance.benchmarkObservedMaxDrawdownPct.toFixed(2)}%. Sparse captures can miss deeper declines between marks.`;
        const sample = `Stored marks: ${priorPerformance.snapshots}; comparable marks in current provider segment: ${priorPerformance.comparableSnapshots}.`;
        return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis reference performance — ${asset} | revision ${thesis.revision}**\n${cachedText}\n${thesisHorizonOutcomeText(priorPerformance)}\n${cachedDrawdown}\n${sample}\nCurrent completed session was already captured, so no new provider request was made. This is a user-authored reference series, not an executed position, bot recommendation, or after-cost portfolio return.`), allowedMentions: { parse: [] } });
      }
      try {
        const report = await fetchInvestmentResearch([asset], { maxSymbols: 1, includeHistory: true, now: new Date() });
        const assetBars = report.histories?.[asset]?.bars || [];
        const benchmarkBars = report.histories?.SPY?.bars || [];
        const latest = assetBars.at(-1);
        const benchmark = benchmarkBars.find((row) => row.date === latest?.date);
        if (!latest || !benchmark || !(latest.close > 0 && benchmark.close > 0))
          return interaction.editReply({ content: `A completed adjusted-price bar for ${asset} and SPY on the same session was unavailable; no performance snapshot was saved.`, allowedMentions: { parse: [] } });
        const observedAt = new Date().toISOString();
        const saved = await appendThesisPerformanceSnapshot(userId, { assetId: asset, source: 'Yahoo adjusted daily close',
          marketKey: 'Yahoo adjusted close | SPY aligned session', benchmarkSymbol: 'SPY', asOf: latest.date, observedAt,
          assetPrice: latest.close, benchmarkPrice: benchmark.close });
        const summary = summarizeThesisPerformance(saved.journal, asset);
        const reset = summary.providerChanged ? ' Provider/source identity changed; comparison begins at the first matching snapshot.' : '';
        const line = summary.snapshots === 1 || summary.elapsedDays === 0
          ? `Reference baseline saved at adjusted close ${latest.close.toFixed(2)} on ${latest.date}; capture again after a later completed session to measure change.`
          : `Since ${summary.baseline.asOf}: ${summary.assetReturnPct >= 0 ? '+' : ''}${summary.assetReturnPct.toFixed(2)}% for ${asset}; SPY ${summary.benchmarkReturnPct >= 0 ? '+' : ''}${summary.benchmarkReturnPct.toFixed(2)}%; relative change ${summary.relativeReturnPp >= 0 ? '+' : ''}${summary.relativeReturnPp.toFixed(2)} percentage points over ${Math.floor(summary.elapsedDays)} days.`;
        const maturity = summary.horizonComplete ? `The ${thesis.horizonMonths}-month target date has passed; assess the horizon checkpoint and thesis evidence together.`
          : `Horizon: ${thesis.horizonMonths} months; ${Math.floor(summary.elapsedDays)} days have elapsed. A long-term judgment is premature.`;
        const sample = `Stored marks: ${summary.snapshots}; comparable marks in current provider segment: ${summary.comparableSnapshots}.`;
        const drawdown = summary.assetObservedMaxDrawdownPct === null
          ? 'Observed mark-to-mark drawdown: unavailable until at least two comparable marks exist.'
          : `Observed mark-to-mark maximum drawdown: ${summary.assetObservedMaxDrawdownPct.toFixed(2)}% for ${asset}; SPY ${summary.benchmarkObservedMaxDrawdownPct.toFixed(2)}%. Sparse captures can miss deeper declines between marks.`;
        const duplicate = saved.duplicate ? ' This session was already captured; no duplicate row was added.' : '';
        return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis reference performance — ${asset} | revision ${thesis.revision}**\nProvider: ${report.provider}; completed adjusted daily close as of ${latest.date}.\n${line}\n${thesisHorizonOutcomeText(summary)}\n${drawdown}\n${sample}\n${maturity}${reset}\n\nThis is a user-authored reference series, not an executed position, bot recommendation, or after-cost total portfolio return. Yahoo adjusted close incorporates provider adjustments; taxes, fees, contributions, and actual entry timing are not represented.${duplicate}`), allowedMentions: { parse: [] } });
      } catch (error) {
        return interaction.editReply({ content: `Could not capture thesis reference performance: ${String(error?.message || error).slice(0, 260)}. No recommendation or risk setting was changed.`, allowedMentions: { parse: [] } });
      }
    }
    if (action === 'coverage') {
      const asset = String(interaction.options.getString('asset') || '').trim().toUpperCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact ticker to inspect saved long-term evidence coverage.', allowedMentions: { parse: [] } });
      const coverage = thesisEvidenceCoverage(journal, asset);
      if (!coverage.review) return interaction.editReply({ content: `No SEC evidence snapshot is saved for ${asset}. Save a thesis and run action Capture evidence review first.`, allowedMentions: { parse: [] } });
      const review = coverage.review;
      const lines = coverage.domains.map((row) => `• ${row.label}: ${row.status} (${row.observed}/${row.total} selected fields with numeric values)${row.latestPeriodEnd
        ? ` | newest reported period ${row.latestPeriodEnd}${row.periodAgeDays === null ? '' : ` (${row.periodAgeDays}d ${row.periodRelation.replace('_', ' ')})`}` : ' | no dated numeric fact'}`);
      const missing = 'Not supplied by this SEC snapshot: forward estimates and valuation history, insider or institutional activity, customers/suppliers, competition/moat, management, legal/product pipeline events, and your portfolio fit. Standardized debt-maturity buckets appear only when the selected filing reports supported SEC facts; missing/custom tags do not mean zero debt or zero maturities. Dividend and repurchase values likewise appear only where reported; missing tags do not mean zero activity.';
      const valuationPrice = review.facts.find((fact) => fact.key === 'valuation_price');
      const content = `**Private evidence coverage — ${asset}**\nEvidence captured ${review.observedAt} | SEC ${review.source} | annual period ${review.filing?.periodEnd || 'unavailable'} | quarter ${review.quarterlyFiling?.periodEnd || 'unavailable'} | Yahoo price as of ${valuationPrice?.periodEnd || 'unavailable'}\nSelected numeric facts: ${coverage.fieldsObserved}/${coverage.fieldsReported} reported fields\n${lines.join('\n')}\n\nPeriod age is descriptive, not a universal stale-data verdict; annual and quarterly filings, SEC facts, and market prices update on different schedules. ${missing}\nCoverage describes only the saved capture; it is not a completeness score, company-quality assessment, intrinsic-value estimate, or investment instruction.`;
      return interaction.editReply({ content: fitPrivateThesisContent(content), allowedMentions: { parse: [] } });
    }
    if (action === 'history') {
      const asset = String(interaction.options.getString('asset') || '').trim().toUpperCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact ticker to view its private evidence-review history.', allowedMentions: { parse: [] } });
      const rows = recentThesisEvidenceReviews(journal, asset, 3);
      const assessments = recentThesisAssessments(journal, asset, 3);
      const performanceRows = (journal.performanceSnapshots || []).filter((row) => row.assetId === asset)
        .sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)) || String(b.observedAt).localeCompare(String(a.observedAt))).slice(0, 3);
      if (!rows.length && !performanceRows.length && !assessments.length) return interaction.editReply({ content: `No evidence, assessment or performance captures are saved for ${asset}. Use action Capture evidence review, Record your assessment, or Reference performance first.`, allowedMentions: { parse: [] } });
      const lines = rows.map((row) => {
        const currentFacts = row.facts.filter((fact) => ['revenue', 'netIncome', 'dilutedEps', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases', 'operatingCashFlow', 'freeCashFlow', 'currentRatio', 'cashLessLongTermDebt', 'weightedAverageDilutedShares', 'revenue_growth_pct', 'diluted_share_growth_pct', 'q_revenue', 'q_netIncome', 'q_dilutedEps', 'q_cashDividendsPerShare', 'q_cashDividendsPaid', 'q_commonStockRepurchases', 'q_operatingCashFlow', 'q_freeCashFlow', 'q_currentRatio', 'q_cashLessLongTermDebt', 'q_revenue_growth_pct'].includes(fact.key)).slice(0, 8);
        const trendFacts = latestAnnualTrendFacts(row.facts);
        const facts = [...currentFacts, ...trendFacts];
        const values = facts.map((fact) => `${fact.label}: ${Number.isFinite(fact.value) ? fact.unit === 'shares'
          ? `${(Number(fact.value) / 1e6).toFixed(1)}M shares`
          : `${fact.unit === 'USD' ? formatUsd(fact.value) : fact.unit === 'USD/shares' ? `${formatUsd(fact.value, 2)}/share` : Number(fact.value).toLocaleString('en-US', { maximumFractionDigits: 2 })}${fact.unit === 'percent' ? '%' : ''}` : 'unavailable'}${fact.periodEnd ? ` (${fact.periodEnd})` : ''}`).join('; ');
        return `• ${row.observedAt.slice(0, 10)} | thesis rev ${row.thesisRevision} | ${row.status} | annual ${row.filing?.periodEnd || 'n/a'}; quarter ${row.quarterlyFiling?.periodEnd || 'n/a'}${values ? `\n  ${values}` : ''}`;
      });
      const performance = performanceRows.length ? `\n\nReference performance marks (not executed positions):\n${performanceRows.map((row) => `• rev ${row.thesisRevision} | ${row.asOf} | adjusted close ${row.assetPrice.toFixed(2)} | SPY ${row.benchmarkPrice.toFixed(2)}`).join('\n')}` : '';
      const assessmentText = assessments.length ? `\n\nYour recorded thesis assessments:\n${assessments.map((row) => `• ${row.assessedAt.slice(0, 10)} | rev ${row.thesisRevision} | ${row.status.replaceAll('_', ' ')} | ${row.notes}`).join('\n')}` : '';
      return interaction.editReply({ content: fitPrivateThesisContent(`**Private thesis history — ${asset}**\n${lines.join('\n') || 'No SEC evidence captures saved.'}${assessmentText}${performance}\n\nEvidence rows are source-dated observations; annual and quarterly periods are not directly comparable. Assessments are your own judgments linked to the saved thesis revision. Missing fields remain unavailable. Reference marks are not actual holdings; history does not score the thesis or provide a valuation or buy/sell instruction.`), allowedMentions: { parse: [] } });
    }
    if (action === 'review') {
      const asset = String(interaction.options.getString('asset') || '').trim().toUpperCase();
      const thesis = latestTheses(journal).find((row) => row.assetId === asset);
      if (!thesis) return interaction.editReply({ content: `No saved thesis found for ${asset || 'that ticker'}. Save a thesis first; evidence reviews attach to a specific thesis revision.`, allowedMentions: { parse: [] } });
      const reviewNow = new Date();
      const marketReport = await fetchInvestmentResearch([asset], { maxSymbols: 1, includeFundamentals: true, fundamentalLimit: 1, now: reviewNow });
      const marketRow = marketReport.rows.find((row) => row.symbol === asset) || null;
      const fundamentals = marketRow?.annualFundamentals || (await fetchIssuerAnnualFundamentals([asset], reviewNow))[0];
      const annualValuation = marketRow?.annualValuation || null;
      const metricLabels = {
        revenue: 'Revenue', netIncome: 'Net income', dilutedEps: 'Diluted EPS', operatingCashFlow: 'Operating cash flow',
        capitalExpenditure: 'Capital expenditure', freeCashFlow: 'Calculated free cash flow', grossMarginPct: 'Gross margin',
        operatingMarginPct: 'Operating margin', netMarginPct: 'Net margin', freeCashFlowMarginPct: 'FCF margin',
        cash: 'Cash and equivalents', longTermDebtCurrent: 'Current long-term debt', longTermDebtNoncurrent: 'Noncurrent long-term debt',
        currentRatio: 'Current ratio', workingCapital: 'Working capital', sharesOutstanding: 'Common shares outstanding',
        weightedAverageDilutedShares: 'Weighted average diluted shares', cashLessLongTermDebt: 'Cash less reported long-term debt',
        cashDividendsPerShare: 'Cash dividends paid per common share', cashDividendsPaid: 'Reported cash dividends paid',
        commonStockRepurchases: 'Reported common-stock repurchases'
      };
      const facts = Object.entries(fundamentals?.metrics || {}).flatMap(([key, metric]) => {
        const label = metricLabels[key];
        return label ? [{ key, label, value: metric.value, unit: metric.unit, periodStart: metric.periodStart, periodEnd: metric.periodEnd,
          factSource: metric.tag ? `SEC ${metric.tag} from the selected annual filing accession.` : '' }] : [];
      });
      facts.push(...annualHistoryFacts(fundamentals));
      const valuationSource = marketReport.provider;
      const valuationAsOf = annualValuation?.priceAsOf || '';
      const valuationRows = [
        ['valuation_price', 'Yahoo completed-session raw close used in estimate', annualValuation?.price, 'USD'],
        ['valuation_market_cap_estimate', 'Indicative market-cap estimate using filing-date shares', annualValuation?.marketCapEstimate, 'USD'],
        ['valuation_price_to_sales', 'Indicative price / annual sales', annualValuation?.priceToSales, 'x'],
        ['valuation_price_to_earnings', 'Indicative price / annual earnings', annualValuation?.priceToEarnings, 'x'],
        ['valuation_price_to_free_cash_flow', 'Indicative price / annual free cash flow', annualValuation?.priceToFreeCashFlow, 'x'],
        ['valuation_fcf_yield_pct', 'Indicative annual FCF / market-cap estimate', annualValuation?.freeCashFlowYieldPct, 'percent']
      ];
      for (const [key, label, value, unit] of valuationRows) facts.push({ key, label, value, unit, periodEnd: valuationAsOf, factSource: valuationSource });
      if (Number.isFinite(fundamentals?.metrics?.revenue?.growthPct)) facts.push({ key: 'revenue_growth_pct', label: 'Revenue growth vs prior annual period', value: fundamentals.metrics.revenue.growthPct, unit: 'percent', periodEnd: fundamentals.metrics.revenue.periodEnd });
      if (Number.isFinite(fundamentals?.metrics?.weightedAverageDilutedShares?.growthPct)) facts.push({ key: 'diluted_share_growth_pct', label: 'Diluted-share growth vs prior annual period', value: fundamentals.metrics.weightedAverageDilutedShares.growthPct, unit: 'percent', periodEnd: fundamentals.metrics.weightedAverageDilutedShares.periodEnd });
      const quarterLabels = { revenue: 'Revenue', grossProfit: 'Gross profit', netIncome: 'Net income', operatingIncome: 'Operating income',
        operatingCashFlow: 'Operating cash flow', capitalExpenditure: 'Capital expenditure', freeCashFlow: 'Calculated free cash flow',
        dilutedEps: 'Diluted EPS', cashDividendsPerShare: 'Cash dividends paid per common share', cashDividendsPaid: 'Reported cash dividends paid',
        commonStockRepurchases: 'Reported common-stock repurchases', weightedAverageDilutedShares: 'Weighted-average diluted shares', grossMarginPct: 'Gross margin',
        operatingMarginPct: 'Operating margin', netMarginPct: 'Net margin', freeCashFlowMarginPct: 'FCF margin',
        cash: 'Cash and equivalents', longTermDebtCurrent: 'Current long-term debt', longTermDebtNoncurrent: 'Noncurrent long-term debt',
        currentAssets: 'Current assets', currentLiabilities: 'Current liabilities', workingCapital: 'Working capital', currentRatio: 'Current ratio',
        sharesOutstanding: 'Common shares outstanding', cashLessLongTermDebt: 'Cash less reported long-term debt' };
      for (const [key, metric] of Object.entries(fundamentals?.quarterly?.metrics || {})) {
        if (quarterLabels[key]) facts.push({ key: `q_${key}`, label: `Latest quarter ${quarterLabels[key].toLowerCase()}`, value: metric.value,
          unit: metric.unit, periodStart: metric.periodStart, periodEnd: metric.periodEnd,
          factSource: metric.tag ? `SEC ${metric.tag} from the selected quarterly filing accession.` : '' });
      }
      const quarterlyRevenueGrowth = fundamentals?.quarterly?.metrics?.revenue?.growthPct;
      if (Number.isFinite(quarterlyRevenueGrowth)) facts.push({ key: 'q_revenue_growth_pct', label: 'Quarter revenue growth vs prior-year quarter', value: quarterlyRevenueGrowth,
        unit: 'percent', periodStart: fundamentals.quarterly.metrics.revenue.periodStart, periodEnd: fundamentals.quarterly.metrics.revenue.periodEnd });
      const observedAt = reviewNow.toISOString();
      const saved = await appendThesisEvidenceReview(userId, { assetId: asset, source: 'SEC EDGAR Company Facts', status: fundamentals?.status || 'unavailable', observedAt,
        filing: fundamentals?.filing, quarterlyFiling: fundamentals?.quarterly?.filing, note: [fundamentals?.reason, fundamentals?.quarterly?.reason, fundamentals?.quarterly?.note,
          annualValuation?.status === 'unavailable' ? `Indicative multiples unavailable: ${annualValuation.reason}` : ''].filter(Boolean).join(' ').slice(0, 240), facts });
      const render = (fact) => {
        if (!Number.isFinite(fact.value)) return `${fact.label}: unavailable`;
        const value = fact.unit === 'USD' ? formatUsd(fact.value)
          : fact.unit === 'shares' ? `${(Number(fact.value) / 1e6).toFixed(1)}M shares`
            : fact.unit === 'USD/shares' ? `${formatUsd(fact.value, 2)}/share`
              : fact.unit === 'percent' ? `${Number(fact.value).toFixed(1)}%` : `${Number(fact.value).toFixed(2)}${fact.unit === 'x' ? 'x' : ''}`;
        return `${fact.label}: ${value}${fact.periodEnd ? ` (${fact.periodEnd})` : ''}${fact.factSource ? ` [${fact.factSource}]` : ''}`;
      };
      const filing = saved.review.filing, quarterlyFiling = saved.review.quarterlyFiling;
      const annualFields = saved.review.facts.filter((fact) => ['revenue', 'netIncome', 'dilutedEps', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases', 'operatingCashFlow', 'freeCashFlow', 'currentRatio', 'cashLessLongTermDebt', 'weightedAverageDilutedShares', 'revenue_growth_pct', 'diluted_share_growth_pct', 'valuation_price', 'valuation_market_cap_estimate', 'valuation_price_to_sales', 'valuation_price_to_earnings', 'valuation_price_to_free_cash_flow', 'valuation_fcf_yield_pct'].includes(fact.key));
      const quarterlyFields = saved.review.facts.filter((fact) => fact.key.startsWith('q_') && ['q_revenue','q_netIncome','q_dilutedEps','q_cashDividendsPerShare','q_cashDividendsPaid','q_commonStockRepurchases','q_operatingCashFlow','q_freeCashFlow','q_currentRatio','q_cashLessLongTermDebt','q_revenue_growth_pct'].includes(fact.key));
      const annualHistoryFields = saved.review.facts.filter((fact) => fact.key.startsWith('annual_history_'));
      const annualHistoryText = formatAnnualHistory(annualHistoryFields);
      const prior = saved.priorReview ? `Prior evidence capture: ${saved.priorReview.observedAt} (annual ${saved.priorReview.filing?.periodEnd || 'unavailable'}; quarter ${saved.priorReview.quarterlyFiling?.periodEnd || 'unavailable'}).` : 'First evidence capture for this thesis.';
      const growthChanges = compareThesisGrowthEvidence(saved.review, saved.priorReview);
      const growthComparison = growthChanges.length ? `Period-aligned growth change since prior capture (percentage points): ${growthChanges.map((row) => `${row.label} ${row.priorValue.toFixed(1)}% → ${row.currentValue.toFixed(1)}% (${row.changePercentagePoints >= 0 ? '+' : ''}${row.changePercentagePoints.toFixed(1)} pp; ${row.priorPeriodEnd} → ${row.currentPeriodEnd})`).join('; ')}.`
        : 'Growth comparison: unavailable until the same SEC growth metric has a later reported period in a subsequent capture.';
      const sourceLink = [filing?.url ? `Annual: <${filing.url}>` : '', quarterlyFiling?.url ? `Quarter: <${quarterlyFiling.url}>` : ''].filter(Boolean).join(' | ');
      const coverage = `${fundamentals?.status === 'partial' ? 'Some standardized facts were unavailable; unavailable fields remain explicit.' : 'Standardized SEC annual facts are unavailable for this ticker.'}${saved.review.note ? ` ${saved.review.note}` : ''}`;
      const reviewPrompts = thesisReviewPrompts(thesis).map((prompt, index) => `${index + 1}. ${prompt}`).join('\n');
      const content = `**Private evidence review ${saved.review.reviewNumber} — ${asset} | thesis revision ${saved.review.thesisRevision}**\nCaptured ${observedAt}\n**Questions for your ${String(thesis.thesisType).replaceAll('_', ' ')} thesis**\n${reviewPrompts}\n\nSEC annual history from selected filing accession (oldest → newest):\n${annualHistoryText || 'No aligned historical values were available in the selected filing.'}\nCalculated per-share series use revenue/free cash flow divided by weighted-average diluted shares only for identical reported annual periods; they are historical ratios, not forecasts. Diluted-share history can reflect issuance, buybacks, acquisitions, and corporate actions.\n\nLatest annual facts: ${filing?.form || 'unavailable'} filed ${filing?.filedAt || 'unknown'} | fiscal period ${filing?.periodEnd || 'unknown'}\n${annualFields.map(render).join('\n')}\nLatest quarter: ${quarterlyFiling?.form || 'unavailable'} filed ${quarterlyFiling?.filedAt || 'unknown'} | period ${quarterlyFiling?.periodEnd || 'unknown'}\n${quarterlyFields.map(render).join('\n')}\n${growthComparison}\nCoverage: ${coverage}\n${prior}${sourceLink ? `\n${sourceLink}` : ''}\n\nUse these as a checklist against your saved assumptions and invalidation conditions. SEC annual history comes only from the selected filing accession; missing or custom-tagged facts may be absent. The snapshot does not contain every answer. Facts are issuer-reported historical data, not a thesis verdict, forecast, valuation, or buy/sell instruction.`;
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
        : 'No private thesis notes saved yet. Use `/stocks thesis` with action Add revision to record one.', allowedMentions: { parse: [] } });
    }
    if (action === 'show') {
      const asset = String(interaction.options.getString('asset') || '').trim().toUpperCase();
      if (!asset) return interaction.editReply({ content: 'Choose an exact ticker to show its thesis history.', allowedMentions: { parse: [] } });
      const rows = journal.revisions.filter((row) => String(row.assetId).toUpperCase() === asset).sort((a, b) => Number(b.revision) - Number(a.revision));
      if (!rows.length) return interaction.editReply({ content: `No thesis revisions found for ${asset}.`, allowedMentions: { parse: [] } });
      const latest = rows[0];
      const sources = latest.sources.length ? `\nSources: ${latest.sources.map((source) => `<${source}>`).join(' ')}` : '\nSources: none supplied.';
      const disclaimer = `\n\nUser-authored research, not an independent fact-check, forecast, or buy instruction. ${rows.length} immutable revision(s) saved.`;
      const body = `**${latest.assetId} | ${String(latest.thesisType || 'unclassified').replaceAll('_', ' ')} | revision ${latest.revision} | ${latest.horizonMonths}-month horizon**\nRecorded ${latest.createdAt} | next review ${latest.reviewDate || 'not set'}\nThesis: ${latest.thesis}\nAssumptions: ${latest.assumptions}\nBase case: ${latest.baseCase}\nBull case: ${latest.bullCase}\nBear case: ${latest.bearCase}\nInvalidation: ${latest.invalidation}\nCatalysts: ${latest.catalysts}${sources}`;
      const marker = '\n[Details truncated]';
      const budget = 1900 - disclaimer.length;
      const details = body.length > budget ? `${body.slice(0, budget - marker.length).trimEnd()}${marker}` : body;
      return interaction.editReply({ content: `${details}${disclaimer}`, allowedMentions: { parse: [] } });
    }
    return interaction.editReply({ content: 'Unknown thesis action.', allowedMentions: { parse: [] } });
  }
  if (sub === 'catalyst') {
    const action = interaction.options.getString('action', true);
    const symbol = (interaction.options.getString('symbol') || '').trim();
    if (action === 'add') {
      if (!symbol) return interaction.editReply('Adding a catalyst requires a U.S. ticker or `*` for market-wide context.');
      const startsAtRaw = interaction.options.getString('starts_at');
      const startsAt = startsAtRaw ? new Date(startsAtRaw) : new Date();
      if (!Number.isFinite(startsAt.getTime()) || (startsAtRaw && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(startsAtRaw)))
        return interaction.editReply('`starts_at` must be a valid ISO timestamp with a timezone, such as `2026-10-02T14:00:00Z`.');
      const durationHours = interaction.options.getInteger('duration_hours') || 24;
      try {
        const row = await addManualCatalyst(guildId, {
          symbol, reason: interaction.options.getString('reason'), eventType: interaction.options.getString('event_type'),
          direction: interaction.options.getString('direction'), expectedness: interaction.options.getString('expectedness'),
          horizon: interaction.options.getString('horizon'), impact: interaction.options.getString('impact'),
          sourceUrl: interaction.options.getString('source_url'), startsAt,
          endsAt: new Date(startsAt.getTime() + durationHours * 3_600_000), createdBy: interaction.user.id
        });
        return interaction.editReply(`Catalyst ${row.id} saved for ${row.symbol}: ${row.eventType} | ${row.direction} | ${row.expectedness} | ${row.horizon} | ${row.impact} | until ${localTimeLabel(new Date(row.endsAt))}${row.sourceUrl ? ` | source ${row.sourceUrl}` : ' | source not supplied'}. Operator-supplied context only; not independently verified and has no score or gate effect.`);
      } catch (error) {
        return interaction.editReply(`Catalyst was not saved: ${String(error.message || error).slice(0, 300)}`);
      }
    }
    if (action === 'clear') {
      if (!symbol) return interaction.editReply('Clearing requires a symbol or catalyst id.');
      return interaction.editReply(`Removed ${await clearManualCatalyst(guildId, symbol)} matching catalyst record(s).`);
    }
    const rows = await listManualCatalysts(guildId, new Date(), { activeOnly: false });
    const nowMs = Date.now();
    const visible = rows.slice(-14).reverse().map((row) => `${row.id} | ${new Date(row.startsAt).getTime() > nowMs ? 'upcoming' : new Date(row.endsAt).getTime() < nowMs ? 'expired/retained' : 'active'} | ${row.symbol} | ${row.eventType}/${row.direction}/${row.expectedness}/${row.horizon}/${row.impact} | until ${localTimeLabel(new Date(row.endsAt))} | ${row.reason}${row.sourceUrl ? ` | ${row.sourceUrl}` : ''}`);
    return interaction.editReply(`${visible.join('\n').slice(0, 1700) || 'No active, upcoming, or recently expired Stock catalysts.'}\n\nManual source/context only; no automated verification, score adjustment, or approval-gate effect.`);
  }
  const settings = await getGuildSettings(guildId);

  if (sub === 'help') {
    const embed = new EmbedBuilder().setColor(COLORS.purple).setTitle('OmniMod Stocks | Setup and model guide')
      .setDescription('Separate intraday paper setups, swing-horizon daily trend research, and private long-term thesis notes. Daily trend research is not a swing trade entry or fundamental underwriting. The bot never connects to a brokerage or places orders.')
      .addFields(
        { name: 'Keep the strategy horizons separate', value: '`/stocks momentum` and `/stocks ticker` are intraday paper-trade analysis. `/stocks invest` ranks 5/20/60-session trend behavior against SPY and displays up to about five years of adjusted-price context; longer returns do not affect its rank. It is not an actionable swing entry/exit system. `/stocks thesis` stores your own months-to-years thesis and review date; it is not scored by intraday indicators. `review` privately captures dated evidence; `assess` records your own linked judgment; `history` shows the audit trail; `coverage` identifies supplied evidence and major data gaps. Admins can use `/stocks catalyst` to record sourced event context; it is unverified and has no score or gate effect.' },
        { name: 'Owner setup', value: '1. Run `/stocks setup` and assign signals/results/log channels.\n2. Optionally store Alpaca, Alpha Vantage, Finnhub, or Polygon credentials with `/stocks api-key`.\n3. Tune cadence and spread limits with `/stocks configure`.\n4. Use `/stocks role` to post alert opt-in buttons.\n5. Maintain the universe with `/stocks watchlist`.' },
        { name: 'Auralith v4', value: 'Every point-in-time screen is labeled at three horizons. Purged day-aware logistic and boosted-tree experts must pass calibration, an untouched holdout, and bootstrap gates. The model can BUY, WATCH, or abstain with NO EDGE.' },
        { name: 'Workflow', value: `Candidates must pass hard quality gates, persist for ${settings.confirmationScans} scan(s), receive model approval, and survive correlation, sector-exposure, and loss-circuit-breaker checks. Until a v4 champion exists, a validated v3 champion may approve setups; rule-only alerts are ${settings.allowRuleOnlySignals ? 'enabled by this server' : 'disabled by default'}.` },
        { name: 'Commands', value: '`momentum` / `ticker` for intraday; `invest` for 5/20/60-session daily research; `thesis` actions `add`, `list`, `show`, `due`, `review`, `assess`, `history`, `coverage`, and `performance` for private long-term notes, evidence, personal assessment, and reference returns; `tracker`, `history`, `performance`, `model`, `status`, admin `/stocks diagnostics`, `scan`, `watchlist`, `setup`, `configure`, `api-key`, `role`.' },
        { name: 'Important', value: 'Outputs are general research, may use delayed data, and are not financial advice or a promise of profit.' }
      );
    return interaction.editReply({ embeds: [embed] });
  }
  if (sub === 'setup') {
    const patch = {
      signalsChannelId: interaction.options.getChannel('signals_channel').id,
      resultsChannelId: interaction.options.getChannel('results_channel')?.id || interaction.options.getChannel('signals_channel').id,
      logsChannelId: interaction.options.getChannel('logs_channel')?.id || interaction.options.getChannel('signals_channel').id,
      alertRoleId: interaction.options.getRole('alert_role')?.id || '', adminRoleId: interaction.options.getRole('admin_role')?.id || '',
      configuredBy: interaction.user.id
    };
    await updateGuildSettings(guildId, patch);
    await registerCommands(guildId);
    const session = marketSession();
    const shouldScan = interaction.options.getBoolean('scan_now') !== false;
    if (shouldScan) {
      const dateKey = localDateKey(new Date(), config.timezone);
      const discovery = await readDailyDiscovery(guildId, dateKey);
      await runGuildScan(guildId, {
        manual: true,
        opening: session.openForDiscovery && notificationRetryReady(discovery, 'opening'),
        allowNewSignals: session.openForDiscovery
      });
    }
    return interaction.editReply(
      shouldScan
        ? 'OmniMod Stocks is configured. Channels and roles are ready, and the first market scan completed.'
        : 'OmniMod Stocks is configured. Channels and roles are ready; the next scheduled market scan will run automatically.'
    );
  }
  if (sub === 'configure') {
    const map = { monitor_minutes: 'monitorMinutes', discovery_minutes: 'discoveryMinutes', minimum_score: 'minScore', max_signals: 'maxSignals', confirmation_scans: 'confirmationScans', min_data_quality: 'minDataQuality', earnings_blackout_days: 'earningsBlackoutDays', slippage_bps: 'assumedSlippageBps', max_spread_bps: 'maxSpreadBps', model_min_samples: 'modelMinSamples', research_model_min_samples: 'researchModelMinSamples', expert_min_samples: 'expertMinSamples', model_embargo_minutes: 'modelEmbargoMinutes', model_lookback_days: 'modelLookbackDays', max_sector_signals: 'maxSectorSignals', daily_loss_limit_r: 'dailyLossLimitR', consecutive_loss_limit: 'consecutiveLossLimit', sec_filing_blackout_hours: 'secFilingBlackoutHours', corporate_action_blackout_days: 'corporateActionBlackoutDays', daily_hour: 'dailyHour', daily_minute: 'dailyMinute' };
    const patch = {};
    for (const [option, key] of Object.entries(map)) { const value = interaction.options.getInteger(option); if (value !== null) patch[key] = value; }
    const ensembleBuyPercent = interaction.options.getInteger('ensemble_buy_percent');
    if (ensembleBuyPercent !== null) patch.ensembleBuyProbability = ensembleBuyPercent / 100;
    const maxCorrelationPercent = interaction.options.getInteger('max_correlation_percent');
    if (maxCorrelationPercent !== null) patch.maxPairCorrelation = maxCorrelationPercent / 100;
    const minPortfolioEdge = interaction.options.getInteger('min_portfolio_edge_hundredths_r');
    if (minPortfolioEdge !== null) patch.minPortfolioExpectedR = minPortfolioEdge / 100;
    const allowRuleOnlySignals = interaction.options.getBoolean('allow_rule_only_signals');
    if (allowRuleOnlySignals !== null) patch.allowRuleOnlySignals = allowRuleOnlySignals;
    await updateGuildSettings(guildId, patch);
    return interaction.editReply(`Configuration updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ') || 'no changes'}.`);
  }
  if (sub === 'api-key') {
    const provider = interaction.options.getString('provider'); const action = interaction.options.getString('action');
    const key = interaction.options.getString('key') || '';
    if (action === 'save' && !key) return interaction.editReply('Provide a key when action is Save.');
    await saveProviderKey(guildId, provider, action === 'save' ? key : '');
    return interaction.editReply(`${provider.replace('_', ' ')} key ${action === 'save' ? 'stored encrypted' : 'cleared'}. It will never be echoed.`);
  }
  if (sub === 'watchlist') {
    const action = interaction.options.getString('action'); const symbols = parseSymbols(interaction.options.getString('symbols'));
    if (action === 'show') return interaction.editReply(`Watchlist (${settings.watchlist.length}):\n${settings.watchlist.join(', ')}`);
    let watchlist = [...settings.watchlist];
    if (action === 'reset') watchlist = [...DEFAULT_WATCHLIST];
    if (action === 'add') watchlist = [...new Set([...watchlist, ...symbols])].slice(0, 75);
    if (action === 'remove') watchlist = watchlist.filter((s) => !symbols.includes(s));
    await updateGuildSettings(guildId, { watchlist });
    return interaction.editReply(`Watchlist updated (${watchlist.length}):\n${watchlist.join(', ')}`);
  }
  if (sub === 'scan') {
    const result = await runGuildScan(guildId, { manual: true, forceProvider: interaction.options.getBoolean('force_provider'), allowNewSignals: marketSession().openForDiscovery });
    return interaction.editReply(`Scan complete: ${result.assetsScreened} symbols, ${result.candidates.length} quality-gated, ${result.confirmedCandidates.length} confirmed, ${result.modelApprovedCandidates?.length || 0} model-approved, ${result.predictions.length} new paper setup(s), ${result.outcomes.length} outcome update(s).\n${portfolioReadinessText(result.portfolio)}`);
  }
  if (sub === 'diagnostics') {
    const records = await readScanDiagnostics(guildId, 100);
    const report = summarizeScanDiagnostics(records, 100);
    if (!report.latest) return interaction.editReply('No scan diagnostics have been recorded yet. The next scheduled or manual scan will start the history.');
    const last = report.latest;
    const duration = (value) => value === null || value === undefined ? 'n/a' : `${(Number(value) / 1000).toFixed(1)}s`;
    const providers = report.providers.slice(0, 8).map((row) => {
      const quota = row.rateLimitUtilization === null ? 'quota unknown' : `${(row.rateLimitUtilization * 100).toFixed(0)}% quota used`;
      return `**${row.provider}** — ${row.requests} calls, ${row.failures} failed, ${row.rateLimits} rate-limited, avg ${duration(row.averageLatencyMs)}, ${quota}`;
    }).join('\n') || 'No provider HTTP calls recorded yet.';
    const reasons = report.topRejectionReasons.map((row) => `\`${row.reason}\` ${row.count}`).join(' · ') || 'No rejection reasons recorded.';
    const shadowSummary = (last.forwardShadow || []).map((track) => `${track.id}: ${track.counts?.strategyQualified ?? 0} qualified, ${track.performance?.sampleSize ?? 0} closes, expectancy $${track.performance?.expectancyUsd ?? 'n/a'}, target/stop ${track.performance?.target1Hits ?? 0}/${track.performance?.stopCount ?? 0}, unfilled ${track.performance?.notFilledCount ?? 0}, rejected ${Object.entries(track.topRejectionReasons || {}).slice(0, 3).map(([reason, count]) => `${reason}:${count}`).join(', ') || 'none'}`).join(' | ')
      || (last.forwardShadowError ? `Unavailable: ${last.forwardShadowError}` : 'No provider-backed shadow observation recorded.');
    const premarketRejections = (last.premarketDiscovery?.rejections || []).slice(0, 16)
      .map((row) => `${row.symbol}: ${row.reasonCode}`).join('\n') || 'No premarket breakout-gate rejections recorded.';
    const deepAnalysisCapSamples = (last.rejectionDetails || []).filter((row) => row.stage === 'deep_analysis_cap').slice(0, 16)
      .map((row) => `${row.symbol}: ${row.changePct !== null && row.changePct !== undefined && Number.isFinite(Number(row.changePct)) ? `${Number(row.changePct).toFixed(2)}% move` : 'discovery candidate'} (${row.discoverySource || 'discovery'})`).join('\n');
    const funnel = [
      `Requested ${formatDiagnosticCount(last.universeSize)} (${formatDiagnosticCount(last.requestedNonContext)} non-context, ${formatDiagnosticCount(last.requestedMarketContext)} market-context ETFs) → available charts ${formatDiagnosticCount(last.successfullyScanned)} (${formatDiagnosticCount(last.scannedNonContext)} non-context, ${formatDiagnosticCount(last.scannedMarketContext)} context) → stock-owned seeds ${formatDiagnosticCount(last.discoveryCandidates)} (${last.discoveryMode || 'unknown'}) → candidate filters passed ${formatDiagnosticCount(last.candidateFilterPassed)}`,
      `Stocks ownership ${last.ownershipStatus || 'unknown'}: ${formatDiagnosticCount(last.ownershipExcluded)} configured/charted candidates withheld${last.ownershipError ? ` | ${String(last.ownershipError).slice(0, 120)}` : ''}`,
      `Unavailable requested charts ${formatDiagnosticCount(last.skipped)} (${formatDiagnosticCount(last.missingNonContext)} non-context, ${formatDiagnosticCount(last.missingMarketContext)} context) | unexpected returns ${formatDiagnosticCount(last.unexpectedReturned)} | provider errors ${formatDiagnosticCount(last.providerFailures)}`,
      `Sector proxy coverage ${formatDiagnosticCount(last.sectorProxyCoverage?.proxyAvailable)}/${formatDiagnosticCount(last.sectorProxyCoverage?.candidates)} mapped; ${formatDiagnosticCount(last.sectorProxyCoverage?.proxyUnavailable)} unknown${last.sectorProxyCoverage?.coveragePct == null ? '' : ` (${last.sectorProxyCoverage.coveragePct}%)`}`,
      `SEC SIC classification ${formatDiagnosticCount(last.secIndustryCoverage?.classified)}/${formatDiagnosticCount(last.secIndustryCoverage?.candidates)} available; ${formatDiagnosticCount(last.secIndustryCoverage?.unavailable)} unavailable${last.secIndustryCoverage?.coveragePct == null ? '' : ` (${last.secIndustryCoverage.coveragePct}%)`}`,
      `Headline rule tags: ${formatDiagnosticCount(last.recentNewsClassification?.total)} headlines → ${formatDiagnosticCount(last.recentNewsClassification?.topicMatched)} topic matched, ${formatDiagnosticCount(last.recentNewsClassification?.ambiguous)} ambiguous, ${formatDiagnosticCount(last.recentNewsClassification?.unverifiedWording)} unverified wording, ${formatDiagnosticCount(last.recentNewsClassification?.unclassified)} unclassified; ${formatDiagnosticCount(last.recentNewsClassification?.explicitPolarityTags)} explicit headline-polarity labels (no strategy effect)`,
      `Technical qualify ${formatDiagnosticCount(last.technicalQualified)} | watch-only ${formatDiagnosticCount(last.watchOnly)}`,
      `Confirmed ${formatDiagnosticCount(last.confirmed)} (${formatDiagnosticCount(last.pendingConfirmation)} waiting) | model approved ${formatDiagnosticCount(last.modelApproved)} / rejected ${formatDiagnosticCount(last.modelRejected)}`,
      `Risk rejected ${formatDiagnosticCount(last.riskRejected)} | setups ${formatDiagnosticCount(last.setups)}`,
      `Shared paper portfolio ${last.sharedPaperConfigured === true ? `configured${last.sharedPaperEmergencyStop ? ' (emergency stop active)' : ''}` : last.sharedPaperConfigured === false ? 'not configured; legacy signal tracking only' : 'configuration unknown'} | extra risk rejects ${formatDiagnosticCount(last.sharedPaperRejected)}`,
      ...(last.sharedPaper?.status === 'available' ? [`Shared ledger: ${last.sharedPaper.activeReservations} reserved + ${last.sharedPaper.filledOpen} open | risk $${last.sharedPaper.openRiskUsd} | unrealized $${last.sharedPaper.unrealizedPnlUsd} | market-session realized $${last.sharedPaper.realizedPnlTodayUsd} | account UTC risk day ${last.sharedPaper.riskDayUtc}: $${last.sharedPaper.realizedPnlRiskDayUtcUsd} | stale/unmarked ${last.sharedPaper.staleOrUnmarked} | net $${last.sharedPaper.netPnlUsd} across ${last.sharedPaper.closedTrades} closed`] : []),
      `Forward-shadow paper: ${shadowSummary}`,
      `Tracker ↔ ledger: ${last.sharedPaperReconciliation?.status || 'unknown'} | linked ${formatDiagnosticCount(last.sharedPaperReconciliation?.linked)} | active-state mismatches ${formatDiagnosticCount(last.sharedPaperReconciliation?.activeDivergence)} | missing ${formatDiagnosticCount(last.sharedPaperReconciliation?.missing)} | owner mismatch ${formatDiagnosticCount(last.sharedPaperReconciliation?.ownerMismatch)}`,
      `Alpaca discovery ${last.wideFeedUsed ? `queried ${String(last.wideDataFeed || 'unknown').toUpperCase()}` : `feed not queried (configured ${String(last.wideDataFeed || config.alpacaDataFeed).toUpperCase()})`}: ${formatDiagnosticCount(last.wideSnapshotsReturned)}/${formatDiagnosticCount(last.wideEligibleUniverse)} eligible stock snapshots returned; ${formatDiagnosticCount(last.wideDiscoveryCandidates)} wide candidates + ${formatDiagnosticCount(last.dynamicScreenerCandidates)} screener candidates → ${formatDiagnosticCount(last.dynamicSymbolsRequested)} deep scans; ETF/ETP ownership directory ${last.etfDirectory?.status || 'unknown'}, ${formatDiagnosticCount(last.etfDirectory?.excludedFromDiscovery)} wrappers excluded (${formatDiagnosticCount(last.etfDirectory?.blockedExcludedCount)} held for review)${last.dynamicDiscoveryError ? ` | ${String(last.dynamicDiscoveryError).slice(0, 120)}` : ''}`,
      `Directory ${last.stockDirectory?.status || 'unknown'}: ${formatDiagnosticCount(last.stockDirectory?.providerInstruments)} returned records; ${formatDiagnosticCount(last.stockDirectory?.activeRecords)} active; ${formatDiagnosticCount(last.stockDirectory?.attempted)} snapshot symbols attempted; ${formatDiagnosticCount(last.stockDirectory?.deferred)} deferred.`,
      `Wide seed exclusions (first failure) ${Object.entries(last.wideRejectionCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'} | wide rank cap ${formatDiagnosticCount(last.wideCapOmissions)} | combined deep-analysis cap omissions ${formatDiagnosticCount(last.deepAnalysisCapOmissions)}`,
      ...(last.premarketDiscovery ? [`Premarket funnel ${last.premarketDiscovery.considered} symbols → window ${last.premarketDiscovery.stages.inWindow} → fresh ${last.premarketDiscovery.stages.fresh} (${last.premarketDiscovery.freshCrossProviderPrices || 0} fresh cross-provider prices) → quality ${last.premarketDiscovery.stages.dataQuality} → liquid ${last.premarketDiscovery.stages.priceAndLiquidity} → move ${last.premarketDiscovery.stages.movement} → breakouts ${last.premarketDiscovery.breakoutCandidates} → posted watch cap 5 (${last.premarketDiscovery.watchCapOmissions} omitted); rejects ${Object.entries(last.premarketDiscovery.rejectionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'}`] : []),
      `Stale gate rejections ${formatDiagnosticCount(last.staleRejections)} (deep ${formatDiagnosticCount(last.staleRejectionBreakdown?.technical)}, wide ${formatDiagnosticCount(last.staleRejectionBreakdown?.wideDiscovery)}, premarket ${formatDiagnosticCount(last.staleRejectionBreakdown?.premarket)}; counts may overlap)`
    ].join('\n');
    const embed = new EmbedBuilder().setColor(COLORS.purple).setTitle('Stocks scan diagnostics')
      .setDescription(`Latest scan: <t:${Math.floor(new Date(last.completedAt || last.startedAt).getTime() / 1000)}:R> | ${last.cacheHit ? 'cache hit' : 'provider refresh'} | history ${report.scansIncluded} scans`)
      .addFields(
        { name: 'Latest funnel', value: funnel.slice(0, 1024), inline: false },
        ...(last.sharedPaperQuoteRefresh ? [{ name: 'Execution quote refresh',
          value: formatStockQuoteRefresh(last.sharedPaperQuoteRefresh).slice(0, 1024), inline: false }] : []),
        { name: 'Alpaca feed coverage', value: last.wideFeedUsed
          ? `${String(last.wideDataFeed || config.alpacaDataFeed).toUpperCase()} queried — ${alpacaFeedCoverageNote(last.wideDataFeed || config.alpacaDataFeed)}`
          : `Not queried during this scan. Configured feed: ${String(last.wideDataFeed || config.alpacaDataFeed).toUpperCase()}${last.dynamicDiscoveryError ? ` | ${String(last.dynamicDiscoveryError).slice(0, 140)}` : ''}`,
          inline: false },
        ...(last.wideRejectionSamples?.length ? [{ name: 'Wide discovery rejected symbols (latest scan)',
          value: last.wideRejectionSamples.slice(0, 16).map((row) => `${row.symbol}: ${row.reasonCode}`).join('\n').slice(0, 1024), inline: false }] : []),
        ...(deepAnalysisCapSamples ? [{ name: 'Discovery candidates omitted from deep analysis (latest scan)',
          value: deepAnalysisCapSamples.slice(0, 1024), inline: false }] : []),
        ...(last.premarketDiscovery ? [{ name: 'Premarket rejected symbols (latest scan)', value: premarketRejections.slice(0, 1024), inline: false }] : []),
        { name: 'Top rejection reasons (history)', value: reasons.slice(0, 1024), inline: false },
        { name: 'Timing', value: `Latest total ${duration(last.durationMs)} | average total ${duration(report.averageScanDurationMs)}\n${Object.entries(last.stageDurationsMs || {}).map(([name, value]) => `${name}: ${duration(value)}`).join(' · ') || 'No stage timing'}`.slice(0, 1024), inline: false },
        { name: 'Provider use (history)', value: providers.slice(0, 1024), inline: false }
      ).setFooter({ text: 'Quota usage is reported only when providers return rate-limit headers; otherwise it is unknown.' });
    return interaction.editReply({ embeds: [embed] });
  }
  if (sub === 'role') { await postRolePanel(client, guildId); return interaction.editReply('Stock alert role panel posted.'); }

  const tracker = await readTracker(guildId);
  if (sub === 'model') {
    const action = interaction.options.getString('action');
    if (action === 'train') {
      const labeling = await labelPendingResearch({ guildId, provider: `alpaca-${config.alpacaDataFeed}`, slippageBps: config.counterfactualSlippageBps });
      const [researchResult, legacyResult] = await Promise.all([
        trainResearchModel(guildId, settings), trainGuildModel(guildId, tracker.predictions || [], settings)
      ]);
      return interaction.editReply(`Counterfactual labels added: ${labeling.labelsAdded}. v4 research champion: ${researchResult.validation.accepted ? `promoted ${researchResult.id} with ${researchResult.acceptedExperts.length} expert(s)` : `not promoted (${researchResult.sampleSize} labels; no global expert passed all gates)`}. Legacy challenger: ${legacyResult.accepted ? `promoted ${legacyResult.id}` : legacyResult.reason}.`);
    }
    const [champion, challenger, researchChampion, researchChallenger, researchExamples] = await Promise.all([
      loadGuildModel(guildId), loadChallenger(guildId), loadResearchModel(guildId), loadResearchChallenger(guildId), loadResearchExamples(guildId, { lookbackDays: settings.modelLookbackDays })
    ]);
    const examples = trainingExamples(tracker.predictions || []); const health = modelHealth(champion, tracker.predictions || []);
    const researchHealth = researchModelHealth(researchChampion, tracker.predictions || []);
    const taxonomyRows = summarizeStockResearchSegments(researchExamples);
    const coverageDimensions = ['eventCoverage', 'macroCoverage'];
    const coverageSummary = coverageDimensions.flatMap((dimension) => taxonomyRows.filter((row) => row.dimension === dimension).slice(0, 2)
      .map((row) => `${dimension}: ${formatStockResearchSegment(row)}`)).join('\n') || 'No matured coverage-tagged outcomes yet.';
    const manualCatalystDimensions = ['manualCatalystType', 'manualCatalystDirection', 'manualCatalystExpectedness', 'manualCatalystHorizon', 'manualCatalystImpact'];
    const manualCatalystSummary = manualCatalystDimensions.flatMap((dimension) => taxonomyRows.filter((row) => row.dimension === dimension).slice(0, 2)
      .map((row) => `${dimension}: ${formatStockResearchSegment(row)}`)).join('\n') || 'No matured manually tagged catalyst outcomes yet.';
    const taxonomyDimensions = ['setupFamily', 'sessionBucket', 'marketRegime', 'eventStatus', 'spreadCohort', 'dollarVolumeCohort', 'horizonMinutes', 'modelVersion'];
    const taxonomySummary = taxonomyDimensions.flatMap((dimension) => taxonomyRows.filter((row) => row.dimension === dimension).slice(0, 2)
      .map((row) => `${dimension}: ${formatStockResearchSegment(row)}`)).join('\n') || 'No matured executable counterfactual labels yet.';
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(researchHealth.healthy || health.healthy ? COLORS.green : COLORS.orange).setTitle('Auralith validated models').addFields(
      { name: 'v4 research champion', value: researchChampion ? `${researchChampion.id} | ${researchChampion.acceptedExperts.length} expert(s) | ${researchChampion.sampleSize} labels across ${researchChampion.independentDays} day(s)` : `None; v3 fallback remains available and rule-only alerts are ${settings.allowRuleOnlySignals ? 'enabled' : 'disabled'}.`, inline: false },
      { name: 'v4 health', value: researchHealth.healthy ? `Healthy | recent model outcomes ${researchHealth.recent || 0}` : researchHealth.reason, inline: false },
      { name: 'Counterfactual readiness', value: `${researchExamples.length} executable labels | 30m ${researchExamples.filter((row) => row.horizonMinutes === 30).length} | 90m ${researchExamples.filter((row) => row.horizonMinutes === 90).length} | 240m ${researchExamples.filter((row) => row.horizonMinutes === 240).length}`, inline: false },
      { name: 'Feed-coverage outcome segments', value: `Coverage is recorded as-of each screen. These cost-modeled outcomes are descriptive, not causal; sparse segments stay unqualified.\n${coverageSummary}`.slice(0, 1024), inline: false },
      { name: 'Manual-catalyst outcome segments', value: `Operator tags are unverified context; segments are descriptive, not causal. Under 20 outcomes or five outcome days is insufficient.\n${manualCatalystSummary}`.slice(0, 1024), inline: false },
      { name: 'Other shadow outcome attribution', value: `Cost-modeled labels from screened names, not actual fills. Under 20 labels or five outcome days is insufficient; intervals are exploratory, overlapping, and not multiplicity-adjusted.\n${taxonomySummary}`.slice(0, 1024), inline: false },
      { name: 'Last v4 challenger', value: researchChallenger?.id ? `${researchChallenger.id} | ${researchChallenger.validation?.accepted ? 'accepted' : 'rejected'} | ${researchChallenger.acceptedExperts?.length || 0} accepted expert(s)` : 'No v4 training attempt yet', inline: false },
      { name: 'v3 fallback', value: champion ? `${champion.id} | ${health.healthy ? 'healthy' : 'suspended'} | ${champion.sampleSize} trade outcomes` : `No v3 champion | ${examples.length}/${settings.modelMinSamples} outcomes`, inline: false },
      { name: 'Last v3 challenger', value: challenger?.id ? `${challenger.id} | ${challenger.validation?.accepted ? 'accepted' : 'rejected'}` : challenger?.reason || 'No v3 attempt', inline: false }
    ).setFooter({ text: 'v4 promotion requires purged walk-forward, separate calibration, untouched holdout, and bootstrap gates. No model guarantees profit.' })] });
  }
  if (sub === 'tracker') {
    const symbol = (interaction.options.getString('symbol') || '').toUpperCase();
    const rows = activePredictions(tracker).filter((p) => !symbol || p.symbol === symbol);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle('SHORT-TERM ACTIVE PAPER SETUPS').setDescription(outcomeLines(rows, 20))] });
  }
  if (sub === 'history') {
    const rows = (tracker.predictions || []).filter((p) => ['loss', 'fell_short', 'target_hit', 'exceeded'].includes(p.status));
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.gray).setTitle('SHORT-TERM GRADED PAPER OUTCOMES').setDescription(outcomeLines(rows, interaction.options.getInteger('count') || 10))] });
  }
  if (sub === 'performance') {
    const p = summarizePerformance(tracker.predictions);
    const profitFactor = Number.isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : 'Infinity';
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle('SHORT-TERM PAPER PERFORMANCE').addFields(
      { name: 'Signals', value: `${p.total} proposed | ${p.notFilled} not filled | ${p.open} open | ${p.closed} graded`, inline: false },
      { name: 'Outcomes', value: `Target 1 hits: ${p.wins} | Target 2 hits: ${p.exceeded} | Shortfalls: ${p.fellShort} | Losses: ${p.losses}`, inline: false },
      { name: 'Target-hit rate', value: `${p.winRate.toFixed(1)}% of graded setups`, inline: true },
      { name: 'Net-profitable rate', value: `${p.profitableRate.toFixed(1)}% after modeled slippage`, inline: true },
      { name: 'Expectancy', value: `${p.expectancyR.toFixed(2)}R / setup`, inline: true },
      { name: 'Profit factor', value: profitFactor, inline: true },
      { name: 'Drawdown / net', value: `${p.maxDrawdownR.toFixed(2)}R max drawdown | ${p.netR.toFixed(2)}R net`, inline: false },
      { name: 'Average excursions', value: p.excursionSampleSize
        ? `MFE +${Number(p.averageMaxFavorableExcursionR).toFixed(2)}R | MAE ${Number(p.averageMaxAdverseExcursionR).toFixed(2)}R | ${p.excursionSampleSize} graded setups. Price-range estimates; same-bar order is unknown.`
        : 'Not available until completed setups include entry, stop, and tracked price extremes.', inline: false },
      { name: 'Probability reliability (descriptive)', value: (() => {
        const evidence = p.probabilityReliability;
        if (!evidence.samples) return `Collecting only: no eligible completed v2 outcomes with a displayed issuance-time target-hit estimate. Needs ${evidence.minimumSamples} outcomes across ${evidence.minimumDays} UTC days.`;
        const forecast = Number.isFinite(evidence.meanProbability) ? `${(evidence.meanProbability * 100).toFixed(1)}% mean forecast` : 'forecast unavailable';
        const observed = Number.isFinite(evidence.observedTargetHitRate) ? `${(evidence.observedTargetHitRate * 100).toFixed(1)}% target-hit rate` : 'outcome rate unavailable';
        const gap = Number.isFinite(evidence.absoluteCalibrationGap) ? `${(evidence.absoluteCalibrationGap * 100).toFixed(1)} pts gap` : 'gap unavailable';
        const brier = Number.isFinite(evidence.brierScore) ? `Brier ${evidence.brierScore.toFixed(3)}` : 'Brier unavailable';
        const baseline = Number.isFinite(evidence.sameSampleBaseRateBrier) ? `same-sample base-rate Brier ${evidence.sameSampleBaseRateBrier.toFixed(3)}` : 'same-sample baseline unavailable';
        const segments = evidence.segments.slice(0, 6).map((row) => `${row.dimension}/${row.key}: n=${row.samples}, days=${row.independentDayClusters}, gap=${Number.isFinite(row.absoluteCalibrationGap) ? `${(row.absoluteCalibrationGap * 100).toFixed(1)}pt` : 'n/a'} (${row.status})`).join('\n');
        return `${evidence.status.replaceAll('_', ' ')} | n=${evidence.samples}/${evidence.minimumSamples}, ${evidence.independentDayClusters}/${evidence.minimumDays} UTC days | ${forecast} vs ${observed} | ${gap} | ${brier} vs ${baseline}. ${evidence.method}${segments ? `\n${segments}` : ''}`.slice(0, 1024);
      })(), inline: false }
    ).setFooter({ text: 'Paper results are not evidence of future returns.' })] });
  }
  if (sub === 'invest') {
    const symbol = interaction.options.getString('symbol');
    const universe = symbol ? [symbol] : settings.watchlist.filter((s) => !['SPY', 'QQQ', 'IWM', 'DIA'].includes(s) && !s.startsWith('XL'));
    const horizon = interaction.options.getInteger('sessions') || 20;
    const count = interaction.options.getInteger('count') || 5;
    const report = await collectInvestmentResearch(guildId, universe, { horizon, settings, includeFundamentals: true, fundamentalLimit: count, persistFundamentalEvidence: true });
    const longWindowVolatilityCounts = LONG_WINDOW_SHADOW_HORIZONS.map((shadowHorizon) => `${shadowHorizon}: ${['lower_quartile', 'typical', 'elevated', 'extreme'].map((regime) => `${regime} ${report.forward.longWindowShadowByVolatilityRegime[regime][shadowHorizon].nonOverlappingWindows}`).join(', ')}`).join(' | ');
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle(`SWING-HORIZON DAILY TREND RESEARCH — NOT A TRADE SETUP | ${horizon} sessions`)
      .setDescription(investmentResearchText(report, count))
      .addFields({ name: 'Data and evidence', value: `${report.provider} | SPY ${report.benchmark.sessions} completed sessions through ${report.benchmark.asOf || 'unavailable'} | ${report.requested.length} requested stocks.\nAdjusted daily OHLC; 20 bps assumed round-trip costs; next-session-open historical entries. ${report.evidence}` })
      .addFields({ name: 'Forward evidence journal', value: `${report.forward.issued} observations issued at actual capture time | ${report.forward.resolved} resolved | ${report.forward.pending} pending. Preserves research decisions before future prices arrive; these are hypothetical outcomes, not executed trades. Overlapping observations are not independent samples.` })
      .addFields({ name: 'Monthly long-window shadow | 60-session trend screen', value: `${LONG_WINDOW_SHADOW_HORIZONS.map((horizon) => {
        const row = report.forward.longWindowShadow[horizon];
        const net = row.meanNetReturnPct === null ? 'pending' : `${row.meanNetReturnPct >= 0 ? '+' : ''}${row.meanNetReturnPct.toFixed(2)}% net`;
        const excess = row.meanExcessReturnPct === null ? 'SPY excess unavailable' : `${row.meanExcessReturnPct >= 0 ? '+' : ''}${row.meanExcessReturnPct.toFixed(2)} pp vs SPY`;
        return `${horizon} sessions (~${Math.round(horizon / 21)} months): ${row.nonOverlappingWindows} non-overlap resolved | ${row.pending} pending | ${net} | ${excess}`;
      }).join('\n')}\nCaptured trend-regime non-overlap counts — ${LONG_WINDOW_SHADOW_HORIZONS.map((horizon) => `${horizon}: ${['risk_on', 'mixed', 'risk_off'].map((regime) => `${regime} ${report.forward.longWindowShadowByRegime[regime][horizon].nonOverlappingWindows}`).join(', ')}`).join(' | ')}\nVolatility-regime non-overlap counts — ${longWindowVolatilityCounts}\nResearch-only counterfactual of the 60-session daily trend screen. Not a multi-year thesis or investment recommendation; overlapping captures are filtered for summary, and live portfolio costs/taxes are not modeled.` })
      .addFields({ name: 'SEC point-in-time evidence', value: report.secEvidence?.error
        || (report.secEvidence?.total === null ? 'No eligible SEC annual facts were available to archive. 0 captures saved; no prior archive exists.'
          : `${report.secEvidence?.added || 0} new accession/price-date snapshot(s) archived; ${report.secEvidence?.total} total. Captures successful standardized filing facts from this manual run; duplicates are skipped.`) })
      .setFooter({ text: 'SWING-HORIZON PRICE RESEARCH; separate from intraday setups and multi-year fundamental theses. No entry/exit signal. Fundamentals and future event coverage incomplete.' })] });
  }
  if (sub === 'ticker') {
    const symbol = interaction.options.getString('symbol').toUpperCase();
    const snapshot = await fetchMarketUniverse(guildId, { settings: { ...settings, watchlist: [symbol] }, cacheKey: `${guildId}-ticker-${symbol}`, maxAgeMinutes: 2, crossCheck: true, prioritySymbols: [symbol] });
    const manualCatalystRows = await listManualCatalysts(guildId, new Date(), { activeOnly: false }).catch(() => []);
    const asset = snapshot.assets.find((a) => a.symbol === symbol);
    if (!asset) return interaction.editReply('That ticker could not be resolved by the current providers.');
    const scoredAsset = { ...asset, manualCatalysts: catalystsForSymbol(manualCatalystRows, symbol), model: scoreAsset(asset) };
    const [champion, researchChampion] = await Promise.all([loadGuildModel(guildId), loadResearchModel(guildId)]);
    const ensemble = predictResearchEnsemble(scoredAsset, researchChampion, settings, tracker.predictions || []) || predictEnsemble(scoredAsset, champion, settings, tracker.predictions || []);
    const eligible = analyzeMomentum(snapshot, settings).candidates.some((row) => row.symbol === symbol);
    const portfolio = selectPortfolioCandidates(eligible && marketSession().openForDiscovery ? [{ ...scoredAsset, ensemble }] : [], tracker.predictions || [], settings);
    const selected = portfolio.selected[0];
    const prediction = buildPrediction(selected || { ...scoredAsset, ensemble }, settings, guildId, new Date(), config.timezone, tracker.predictions || []);
    if (!selected) {
      prediction.action = 'RESEARCH ONLY / NOT APPROVED FOR NEW EXPOSURE';
      prediction.buyCondition = portfolio.rejected[0]?.reason || (!eligible ? 'The ticker does not pass the intraday quality screen.' : 'The regular market session is closed.');
    }
    return interaction.editReply({ embeds: [predictionEmbed(prediction, { title: `SHORT-TERM ANALYSIS SNAPSHOT (NOT A SETUP) | ${symbol}` })] });
  }
  if (sub === 'momentum') {
    const snapshot = await fetchMarketUniverse(guildId, { settings, maxAgeMinutes: settings.discoveryMinutes });
    const analysis = analyzeMomentum(snapshot, settings);
    const [champion, researchChampion] = await Promise.all([loadGuildModel(guildId), loadResearchModel(guildId)]);
    const count = interaction.options.getInteger('count') || 8;
    const rows = analysis.candidates.slice(0, count);
    const watches = rows.length ? [] : analysis.watchCandidates.slice(0, count);
    const description = rows.map((a) => {
      const decision = predictResearchEnsemble(a, researchChampion, settings, tracker.predictions || []) || predictEnsemble(a, champion, settings, tracker.predictions || []);
      const edge = decision.probability ? ` | ${decision.decision} ${decision.probability.toFixed(1)}%` : ` | ${decision.decision}`;
      return `**${a.symbol}** ${formatPrice(a.price)} | score ${a.model.score.toFixed(1)}${edge} | 1h ${formatPercent(a.change1h)} | RVOL ${a.relativeVolume.toFixed(2)}x | spread ${a.microstructureProvider ? `${Number(a.spreadBps).toFixed(1)} bps` : 'n/a'}`;
    }).join('\n')
      || watches.map((a) => `**${a.symbol}** watch only | score ${a.model.score.toFixed(1)} | blocked: ${a.rejectionReasons.join(', ')}`).join('\n')
      || 'No watchlist ticker currently clears the quality gates. No signal is preferable to a weak setup.';
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle('SHORT-TERM STOCK MOMENTUM SCREEN').setDescription(description).setFooter({ text: `${snapshot.source} | research only` })] });
  }
  if (sub === 'status') {
    const snapshot = await readMarketSnapshot(guildId); const keys = providerKeys(settings); const session = marketSession();
    const discovery = await readDailyDiscovery(guildId, localDateKey());
    const stream = getAlpacaStreamStatus(); const [champion, researchChampion, store] = await Promise.all([loadGuildModel(guildId), loadResearchModel(guildId), researchStoreStats()]);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.purple).setTitle('OmniMod Stocks status').addFields(
      { name: 'Session', value: session.label, inline: true }, { name: 'Watchlist', value: `${settings.watchlist.length} symbols`, inline: true },
      { name: 'Last snapshot', value: snapshot?.fetchedAt ? `<t:${Math.floor(new Date(snapshot.fetchedAt).getTime() / 1000)}:R>` : 'none', inline: true },
      { name: 'Data source', value: snapshot?.source || 'Yahoo Chart fallback', inline: false },
      { name: 'Optional keys', value: `Alpaca ID: ${maskSecret(keys.alpaca_key_id)} | Alpaca secret: ${maskSecret(keys.alpaca_secret_key)} | FRED: ${maskSecret(keys.fred)}\nAlpha Vantage: ${maskSecret(keys.alpha_vantage)} | Finnhub: ${maskSecret(keys.finnhub)} | Polygon: ${maskSecret(keys.polygon)} | SEC UA: ${config.secUserAgent && /@/.test(config.secUserAgent) ? 'configured' : 'not configured'}`, inline: false },
      { name: 'Alpaca stream', value: `${stream.connection} | ${stream.feed.toUpperCase()} | ${stream.subscribedSymbols}/${stream.desiredSymbols} symbols | ${stream.cachedQuotes} quotes | ${stream.cachedLulds} LULD | ${stream.cachedStatuses} status${stream.lastError ? ` | ${stream.lastError}` : ''}`, inline: false },
      { name: 'v4 research ensemble', value: researchChampion ? `${researchChampion.id} | ${researchModelHealth(researchChampion, tracker.predictions || []).healthy ? 'healthy' : 'suspended'} | ${researchChampion.acceptedExperts.length} expert(s) | ${researchChampion.sampleSize} labels` : 'No v4 champion; validated v3 may be used', inline: false },
      { name: 'v3 fallback ensemble', value: champion ? `${champion.id} | ${modelHealth(champion, tracker.predictions || []).healthy ? 'healthy' : 'suspended'} | ${champion.sampleSize} samples` : `No v3 champion; rule-only alerts ${settings.allowRuleOnlySignals ? 'enabled' : 'blocked'}`, inline: false },
      { name: 'Research store', value: `${store.files} append-only file(s) | ${(store.bytes / 1024 / 1024).toFixed(2)} MiB`, inline: true },
      { name: 'Portfolio readiness', value: discovery?.diagnostics?.portfolioReadiness || 'No portfolio scan yet. Research collection continues.', inline: false },
      { name: 'Exposure / cost limits', value: `${settings.maxOpenPositions} open positions | ${settings.maxOpenRiskR} planned paper risk units | current spread plus ${settings.executionStressBps} bps adverse-cost reserve | unknown correlation blocks additional exposure`, inline: false },
      { name: 'Longer-horizon collection', value: config.investmentDailyResearch ? 'Daily research/journal enabled after the completed session; 5/20/60-session observations. Also available through /stocks invest.' : 'Automatic daily collection disabled; /stocks invest collects on demand.', inline: false },
      { name: 'Cadence', value: `Open setups ${settings.monitorMinutes}m | Discovery ${settings.discoveryMinutes}m | ${settings.confirmationScans} confirmations`, inline: false },
      { name: 'Quality gates', value: `Score ${settings.minScore}+ | Data ${settings.minDataQuality}+ | Spread <=${settings.maxSpreadBps} bps | Validated model ${settings.allowRuleOnlySignals ? 'preferred (rule-only alerts allowed)' : 'required'} | Sector max ${settings.maxSectorSignals} | Correlation <${Math.round(settings.maxPairCorrelation * 100)}% | Loss breaker ${settings.dailyLossLimitR}R/${settings.consecutiveLossLimit} consecutive`, inline: false }
    )] });
  }
}

client.once(Events.ClientReady, async () => {
  updateRuntime({ state: 'running', phase: 'ready', discordReady: true, discordUser: client.user.tag, lastError: '' });
  client.user.setPresence({ activities: [{ name: 'stock momentum | /stocks help' }], status: 'online' });
  try {
    unregisterAlpacaBarHandler ||= registerAlpacaBarHandler((bar) => recordMarketBar(`alpaca-${config.alpacaDataFeed}`, bar).catch((error) => {
      updateRuntime({ state: 'degraded', phase: 'research_bar_write_error', lastError: error.message });
    }));
    startAlpacaStream();
    paperPositionMonitor.start();
    void pruneResearchStore().catch((error) => console.error('Research-store retention failed:', error));
    scheduler = setInterval(() => {
      void scheduledTick();
    }, 60_000);
    updateRuntime({
      schedulerRunning: true,
      nextTickAt: new Date(Date.now() + 60_000).toISOString()
    });
    resolveWorkerReady(getRuntimeState());
    void scheduledTick();
    void (async () => {
      if (config.guildId) await registerCommands(config.guildId); else await registerCommands();
      if (config.autoProvision && config.guildId) await ensurePrimaryWorkspace(client, config.guildId);
    })().catch((error) => {
      updateRuntime({ state: 'degraded', phase: 'command_registration_error', lastError: error.message });
      console.error(error);
    });
  } catch (error) {
    updateRuntime({ state: 'degraded', phase: 'ready_error', lastError: error.message });
    console.error(error);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('stocks_alerts_')) return handleAlertButton(interaction);
    if (interaction.isChatInputCommand() && interaction.commandName === 'stocks') return handleCommand(interaction);
  } catch (error) {
    updateRuntime({ state: 'degraded', phase: 'interaction_error', lastError: error.message });
    const message = `Request failed: ${error.message}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {}); else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
  }
});

client.on('error', (error) => updateRuntime({ state: 'degraded', phase: 'discord_error', lastError: error.message }));
client.on('shardDisconnect', () => updateRuntime({ state: 'reconnecting', phase: 'shard_disconnected', discordReady: false }));
client.on('shardReconnecting', () => updateRuntime({ state: 'reconnecting', phase: 'shard_reconnecting', discordReady: false }));
client.on('shardResume', () => updateRuntime({ state: 'running', phase: 'idle', discordReady: true, lastError: '' }));
client.on('invalidated', () => updateRuntime({
  state: 'error', phase: 'session_invalidated', discordReady: false,
  lastError: 'Discord invalidated the session. Restart the cPanel application.'
}));
process.on('unhandledRejection', (error) => { updateRuntime({ state: 'degraded', phase: 'unhandled_rejection', lastError: String(error) }); console.error(error); });
process.on('uncaughtException', (error) => { updateRuntime({ state: 'degraded', phase: 'uncaught_exception', lastError: error.stack || error.message }); console.error(error); });

export function shutdown(signal = 'shutdown') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
  if (scheduler) {
    clearInterval(scheduler);
    scheduler = null;
  }
  updateRuntime({
    state: 'stopping',
    phase: String(signal).toLowerCase(),
    discordReady: false,
    schedulerRunning: false
  });
  await paperPositionMonitor.stop();
  await runnerHeartbeat.stop();
  unregisterAlpacaBarHandler?.();
  unregisterAlpacaBarHandler = null;
  stopAlpacaStream();
  client.destroy();
  })();
  return shutdownPromise;
}

if (process.env.OMNIMOD_EMBEDDED_HOST !== '1') {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown(signal));
  }
}

if (process.env.NODE_ENV === 'test' && process.env.OMNIMOD_TEST_SKIP_DISCORD_LOGIN === '1') {
  updateRuntime({ state: 'test-ready', phase: 'discord_login_skipped_for_test' });
} else {
  await client.login(config.discordToken);
}

