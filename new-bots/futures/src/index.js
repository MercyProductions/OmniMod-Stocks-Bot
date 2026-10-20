import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordMessage } from '../../shared/discordWebhook.js';
import { buildDayTradingBrief } from '../../shared/discordPresentation.js';
import { assessMarketDataReadiness } from '../../shared/marketDataReadiness.js';
import { horizonScenario } from '../../multi-asset/src/scenarios.js';
import { isMarketObservationFresh, marketObservationAgeMinutes } from '../../multi-asset/src/freshness.js';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger } from '../../shared/paperRisk.js';
import { enforceFuturesTopBookDepth, evaluateFuturesOpeningRange } from './dayStrategy.js';
import { summarizeFuturesFunnel } from './diagnostics.js';
import { validateActiveFutureContract, validateFuturesUniverse } from './universe.js';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';
import { summarizePositionMarkCoverage } from '../../shared/positionMarkDiagnostics.js';
import { summarizeFuturesContractLifecycle } from './contractLifecycle.js';
import { fetchDatabentoUniverse } from './databentoMarketData.js';
import { fetchDatabentoFuturePositionMarks } from './databentoLiveMarks.js';
import { fetchDatabentoFuturesDayMarketData } from './databentoLiveSession.js';
import { fetchDatabentoFuturesH1Trend } from './databentoTrendData.js';
import { readPrimaryResearchSignalsWithDiagnostics } from '../../shared/signalResearch.js';
import { buildPaperResearchHandoffRows, publishDeliveredPaperResearch } from '../../shared/paperSignalHandoff.js';
import { matchPrimaryResearchForFuture } from './sharedSignals.js';
import { fetchFinnhubEconomicCalendar } from '../../shared/finnhubEconomicCalendar.js';
import { futuresMarketDateAt } from './sessionDate.js';
import { getPaperLedgerWorkspaceRoot, resolvePaperLedgerPath } from '../../shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../shared/forwardShadowPaper.js';
import { loadOrDiscoverFuturesContracts } from './contractDiscoveryCache.js';
import { auditFuturesContractDiscovery } from './contractDiscoveryAudit.js';
import { discoverFuturesActivity } from './futuresActivityDiscovery.js';
import { loadFuturesActivityReviews, routeFuturesActivityForAnalysis } from './activityAnalysisRouting.js';
import { remainingFuturesHistoricalBudget } from './historicalCostBudget.js';
import { splitFuturesDaySessionInputs, summarizeFuturesDayTradeReadiness } from './dayTradeReadiness.js';
import { formatDiagnosticCount } from '../../shared/formatDiagnosticCount.js';
import { performance } from 'node:perf_hooks';

const env = (key, fallback) => process.env[key] == null || process.env[key].trim() === '' ? fallback : process.env[key];
const envNumber = (key, fallback) => {
  const value = Number(env(key, fallback));
  return Number.isFinite(value) ? value : NaN;
};
const source = env('FUTURES_SOURCE', 'manual').toLowerCase();
const scanStartedAt = Date.now();
const stageDurationsMs = {};
const startStage = () => performance.now();
const finishStage = (name, startedAt) => { stageDurationsMs[name] = Number(Math.max(0, performance.now() - startedAt).toFixed(2)); };
let now = Date.now();
const statePath = resolvePaperLedgerPath(env('TRADING_RISK_STATE_PATH', ''));
const emergencyStop = env('OMNIMOD_EMERGENCY_STOP', 'true') !== 'false';
const restartRecovery = await recoverPaperOrders({ owner: 'futures', statePath, now, emergencyStop });
const primarySignalMaxAgeMs = Math.max(1_000, Math.min(60 * 60_000, Number(env('FUTURES_PRIMARY_SIGNAL_MAX_AGE_MS', 5 * 60_000)) || 5 * 60_000));
let primarySignals = [];
let primarySignalReadError = null;
let primarySignalReadDiagnostics = { status: 'not_started' };
try {
  const sourceRead = await readPrimaryResearchSignalsWithDiagnostics({ now, maxAgeMs: primarySignalMaxAgeMs, owners: ['stocks', 'crypto', 'forex', 'options', 'etfs-etps'] });
  primarySignals = sourceRead.records;
  primarySignalReadDiagnostics = sourceRead.diagnostics;
} catch (error) {
  primarySignalReadError = String(error.message || error).slice(0, 180);
  primarySignalReadDiagnostics = { status: 'read_error' };
}
if (!['manual', 'databento'].includes(source)) throw new Error(`Unsupported FUTURES_SOURCE: ${source}; configure an authorized active-contract market-data adapter.`);
const providerMetrics = [];
const positionMarkSource = env('FUTURES_POSITION_MARK_SOURCE', 'manual').toLowerCase();
if (!['manual', 'databento-live'].includes(positionMarkSource)) throw new Error('FUTURES_POSITION_MARK_SOURCE must be manual or databento-live.');
const file = resolve(process.cwd(), env('FUTURES_FILE', 'examples/futures.json'));
const dayFile = resolve(process.cwd(), env('FUTURES_DAY_SESSION_FILE', 'examples/day-session.json'));
const inputsStartedAt = startStage();
const maxMarkets = Math.max(1, Math.min(60, Number(env('MAX_FUTURES', 36)) || 36));
const maxAgeMinutes = Math.max(1, Math.min(10080, Number(env('MAX_FUTURE_AGE_MINUTES', 30)) || 30));
const specs = validateFuturesUniverse(JSON.parse(await readFile(file, 'utf8'))).slice(0, maxMarkets);
const dayInput = JSON.parse(await readFile(dayFile, 'utf8'));
if (!Array.isArray(dayInput.dayTrades) || !Array.isArray(dayInput.marks ?? [])) throw new Error('Futures day-session file must contain dayTrades and optional marks arrays.');
const { dayTrades: approvedDayTrades, draftRows: dayTradeDraftRows } = splitFuturesDaySessionInputs(dayInput.dayTrades);
dayInput.dayTrades = approvedDayTrades;
finishStage('inputLoadAndValidation', inputsStartedAt);
// Monitor owned positions before discovery/history and before collecting entry quotes.
now = Date.now();
let sessionDate = dayInput.sessionDate ?? dayInput.dayTrades[0]?.session?.marketDate ?? dayInput.marks?.[0]?.sessionDate ?? futuresMarketDateAt(now);
const accountEquity = envNumber('PAPER_ACCOUNT_EQUITY_USD', 0);
const riskPolicy = {
  now, maxQuoteAgeMs: envNumber('FUTURES_MAX_QUOTE_AGE_MS', 5_000),
  maxOpenMarkAgeMs: envNumber('FUTURES_MAX_OPEN_MARK_AGE_MS', 300_000),
  maxSpreadPct: envNumber('FUTURES_MAX_SPREAD_PCT', 0.05),
  maxTradeRiskPct: envNumber('FUTURES_MAX_TRADE_RISK_PCT', 0.25),
  maxTotalOpenRiskPct: envNumber('FUTURES_MAX_TOTAL_OPEN_RISK_PCT', 1),
  maxGrossExposurePct: envNumber('FUTURES_MAX_GROSS_EXPOSURE_PCT', 500),
  maxDailyLossPct: envNumber('FUTURES_MAX_DAILY_LOSS_PCT', 1),
  maxInitialMarginPct: envNumber('FUTURES_MAX_INITIAL_MARGIN_PCT', 25),
  minRewardRisk: envNumber('FUTURES_MIN_REWARD_RISK', 1.5), emergencyStop,
  liveTradingEnabled: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true',
};
const strategyConfig = {
  roundTripFeesPerContract: envNumber('FUTURES_ROUND_TRIP_FEES_PER_CONTRACT', NaN),
  slippageReservePerContract: envNumber('FUTURES_SLIPPAGE_RESERVE_PER_CONTRACT', NaN),
  maxInitialMarginPct: envNumber('FUTURES_MAX_INITIAL_MARGIN_PCT', 25),
  deliveryEntryBufferHours: envNumber('FUTURES_DELIVERY_ENTRY_BUFFER_HOURS', 24),
};
const positionMarksStartedAt = startStage();
const positionMonitoringStartedAt = Date.now();
const markResults = [];
markResults.push({ type: 'restart_recovery', ...restartRecovery });
const markLedgerBefore = await readPaperRiskLedger({ statePath });
let positionMarkDiagnostics = { status: positionMarkSource === 'manual' ? 'manual_marks_only' : 'not_started', source: positionMarkSource };
let livePositionMarks = [];
if (positionMarkSource === 'databento-live') {
  let positionsToMonitor = 0;
  try {
    const ledger = markLedgerBefore;
    positionsToMonitor = ledger.orders.filter((order) => order?.owner === 'futures' && order.assetClass === 'future'
      && ['reserved', 'filled', 'open'].includes(order.status)).length;
    now = Date.now();
    const marked = await fetchDatabentoFuturePositionMarks(ledger.orders, {
      apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now,
      maxQuoteAgeMs: envNumber('FUTURES_MAX_POSITION_QUOTE_AGE_MS', 5_000),
      maxTransportLagMs: envNumber('FUTURES_MAX_TRANSPORT_LAG_MS', 2_000),
      timeoutMs: envNumber('FUTURES_LIVE_QUOTE_TIMEOUT_MS', 8_000), metrics: providerMetrics,
    });
    livePositionMarks = marked.marks;
    positionMarkDiagnostics = { ...marked.diagnostics, source: positionMarkSource };
  } catch (error) {
    positionMarkDiagnostics = { status: 'provider_error', source: positionMarkSource, positions: positionsToMonitor,
      quoted: 0, rejected: positionsToMonitor,
      providerError: String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180) };
  }
}
const manualMarkIds = new Set((dayInput.marks ?? []).map((mark) => mark.orderId));
const availablePositionMarks = [...(dayInput.marks ?? []), ...livePositionMarks.filter((row) => !manualMarkIds.has(row.orderId))];
const positionMarkAttempts = [];
for (const mark of availablePositionMarks) {
  now = Date.now();
  const result = await processPaperQuote(mark.orderId, mark.quote, { expectedOwner: 'futures',
  statePath, now, observationClock: Date.now, maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs, maxSpreadPct: riskPolicy.maxSpreadPct,
  sessionOpen: mark.sessionOpen === true, emergencyStop,
  });
  markResults.push({ orderId: mark.orderId, ...result });
  positionMarkAttempts.push({ orderId: mark.orderId, ...result });
}
const markLedgerAfter = await readPaperRiskLedger({ statePath });
now = Date.now();
let contractLifecycleDiagnostics;
function updatePositionDiagnostics(ledger, at) {
  contractLifecycleDiagnostics = summarizeFuturesContractLifecycle(ledger.orders, at);
  positionMarkDiagnostics = { ...positionMarkDiagnostics, assessedAt: new Date(at).toISOString(),
    ...summarizePositionMarkCoverage({ owner: 'futures', beforeOrders: markLedgerBefore.orders, afterOrders: ledger.orders,
      availableMarks: availablePositionMarks, attempts: positionMarkAttempts, now: at, maxAgeMs: riskPolicy.maxOpenMarkAgeMs }),
  };
}
updatePositionDiagnostics(markLedgerAfter, now);
finishStage('positionMonitoring', positionMarksStartedAt);
const positionMonitoringCompletedAt = Date.now();

const contractDiscoveryEnabled = env('FUTURES_CONTRACT_DISCOVERY_ENABLED', 'false') === 'true';
const contractDiscoveryStartedAt = startStage();
now = Date.now();
const contractDiscovery = await loadOrDiscoverFuturesContracts({
  enabled: contractDiscoveryEnabled, products: specs,
  scope: env('FUTURES_CONTRACT_DISCOVERY_SCOPE', 'dataset'),
  cachePath: resolve(process.cwd(), env('FUTURES_CONTRACT_DISCOVERY_CACHE', 'data/futures-contract-discovery.json')),
  maxAgeMs: Math.max(15, Math.min(1440, envNumber('FUTURES_CONTRACT_DISCOVERY_CACHE_MINUTES', 360))) * 60_000,
  apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'),
  maxScanCostUsd: envNumber('FUTURES_MAX_SCAN_COST_USD', 0), now, metrics: providerMetrics,
});
finishStage('contractDiscovery', contractDiscoveryStartedAt);
const trendDataSource = env('FUTURES_TREND_DATA_SOURCE', 'manual').toLowerCase();
if (!['manual', 'databento-historical'].includes(trendDataSource)) throw new Error('FUTURES_TREND_DATA_SOURCE must be manual or databento-historical.');
const dayDataSource = env('FUTURES_DAY_DATA_SOURCE', 'manual').toLowerCase();
if (!['manual', 'databento-live'].includes(dayDataSource)) throw new Error('FUTURES_DAY_DATA_SOURCE must be manual or databento-live.');
const contextStartedAt = startStage();
now = Date.now();
let rows = specs;
let contextDataDiagnostics = { status: source === 'manual' ? 'manual_context' : 'not_started' };
if (source === 'databento') {
  const remainingCap = remainingFuturesHistoricalBudget(envNumber('FUTURES_MAX_SCAN_COST_USD', 0), providerMetrics);
  try {
    if (!(remainingCap > 0)) throw new Error('Context budget exhausted.');
    rows = await fetchDatabentoUniverse(specs, { apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'),
      maxScanCostUsd: remainingCap, maxAgeSeconds: envNumber('FUTURES_DATA_MAX_AGE_SECONDS', 180), now, metrics: providerMetrics });
    contextDataDiagnostics = { status: 'provider_returned', remainingCapBeforeRequestUsd: remainingCap };
  } catch {
    // Reference discovery must remain reportable when its cost consumes the context allowance.
    // Never fall back to prices from the manual examples after a provider/budget failure.
    const status = remainingCap > 0 ? 'provider_error' : 'cost_budget_exhausted';
    contextDataDiagnostics = { status, remainingCapBeforeRequestUsd: remainingCap };
    rows = specs.map((row) => ({ ...row, price: null, observedAt: null, return1dPct: null, return5dPct: null,
      providerError: status, providerStatus: status, source: 'Databento context unavailable', stale: true }));
  }
}
now = Date.now();
finishStage('continuousMarketContext', contextStartedAt);
const activityAnalysisEnabled = env('FUTURES_ACTIVITY_ANALYSIS_ENABLED', 'false') === 'true';
// Default-off routing preserves the prior post-delivery research order and cost priority.
async function runBroadActivityDiscovery() {
  const started = startStage();
  const result = await discoverFuturesActivity({
    enabled: env('FUTURES_ACTIVITY_DISCOVERY_ENABLED', 'false') === 'true', directory: contractDiscovery,
    apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now: Date.now(), metrics: providerMetrics,
    maxScanCostUsd: remainingFuturesHistoricalBudget(envNumber('FUTURES_MAX_SCAN_COST_USD', 0), providerMetrics),
    cachePath: resolve(process.cwd(), env('FUTURES_ACTIVITY_DISCOVERY_CACHE', 'data/futures-activity-screen.json')),
    maxCandidates: envNumber('FUTURES_ACTIVITY_MAX_CANDIDATES', 20),
    maxContractsPerRoot: envNumber('FUTURES_ACTIVITY_MAX_CONTRACTS_PER_ROOT', 1),
    lookbackMinutes: envNumber('FUTURES_ACTIVITY_LOOKBACK_MINUTES', 30),
    maxBarAgeMs: envNumber('FUTURES_ACTIVITY_MAX_BAR_AGE_MS', 180000),
  });
  finishStage('broadActivityDiscovery', started);
  return result;
}
let activityDiscovery = activityAnalysisEnabled ? await runBroadActivityDiscovery() : null;
const routingStarted = startStage();
const reviewFile = env('FUTURES_ACTIVITY_REVIEW_FILE', '');
const activityReviews = activityAnalysisEnabled ? await loadFuturesActivityReviews(reviewFile ? resolve(process.cwd(), reviewFile) : '') : null;
now = Date.now();
const activityAnalysis = routeFuturesActivityForAnalysis({
  enabled: activityAnalysisEnabled, activity: activityDiscovery, directory: contractDiscovery, reviews: activityReviews,
  configuredRows: dayInput.dayTrades, dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now,
  maxAdditional: envNumber('FUTURES_ACTIVITY_MAX_ANALYSIS', 10),
  maxBarAgeMs: envNumber('FUTURES_ACTIVITY_MAX_BAR_AGE_MS', 180000), dayDataSource, trendDataSource,
  catalystSource: env('FUTURES_CATALYST_SOURCE', 'manual').toLowerCase(),
  deliveryEntryBufferHours: envNumber('FUTURES_DELIVERY_ENTRY_BUFFER_HOURS', 24),
});
dayInput.dayTrades = activityAnalysis.dayTrades;
finishStage('activityAnalysisRouting', routingStarted);
const trendStartedAt = startStage();
now = Date.now();
let trendDataDiagnostics = { status: dayInput.dayTrades.length === 0 ? 'no_day_trades' : trendDataSource === 'manual' ? 'manual-session-input' : 'not_started', source: trendDataSource };
if (trendDataSource === 'databento-historical' && dayInput.dayTrades.length) {
  try {
    const remainingCap = remainingFuturesHistoricalBudget(envNumber('FUTURES_MAX_SCAN_COST_USD', 0), providerMetrics);
    const trend = await fetchDatabentoFuturesH1Trend(dayInput.dayTrades, {
      apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now,
      maxScanCostUsd: remainingCap, lookbackDays: envNumber('FUTURES_H1_LOOKBACK_DAYS', 7),
      minBars: envNumber('FUTURES_H1_MIN_BARS', 50), metrics: providerMetrics,
      cachePath: resolve(process.cwd(), env('FUTURES_H1_CACHE', 'data/futures-h1-history.json')),
    });
    dayInput.dayTrades = trend.rows;
    trendDataDiagnostics = { ...trend.diagnostics, source: trendDataSource, remainingCapBeforeRequestUsd: remainingCap };
    now = Date.now();
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    dayInput.dayTrades = dayInput.dayTrades.map((row) => ({ ...row, trendBars: [], trendDataStatus: 'provider_error', trendDataReasons: [message] }));
    trendDataDiagnostics = { status: 'provider_error', source: trendDataSource, providerError: message };
  }
}
finishStage('h1Trend', trendStartedAt);
const catalystSource = env('FUTURES_CATALYST_SOURCE', 'manual').toLowerCase();
if (!['manual', 'finnhub'].includes(catalystSource)) throw new Error('FUTURES_CATALYST_SOURCE must be manual or finnhub.');
const calendarStartedAt = startStage();
now = Date.now();
let economicCalendarDiagnostics = { status: dayInput.dayTrades.length === 0 ? 'no_day_trades' : catalystSource === 'manual' ? 'manual-review' : 'not_started', source: catalystSource };
if (catalystSource === 'finnhub' && dayInput.dayTrades.length) {
  const targetIds = [...new Set(dayInput.dayTrades.map((row, index) => String(row.contract?.contractId ?? row.contract?.symbol ?? `contract-${index}`).toUpperCase()))];
  const targetCountryMap = Object.fromEntries(targetIds.map((target) => [target, ['US']]));
  const calendarDate = dayInput.sessionDate ?? dayInput.dayTrades[0]?.session?.marketDate ?? futuresMarketDateAt(now);
  try {
    const calendar = await fetchFinnhubEconomicCalendar({ token: env('FINNHUB_API_KEY'), marketDate: calendarDate,
      instruments: targetIds, countryCodesByInstrument: targetCountryMap, now, metrics: providerMetrics });
    dayInput.dayTrades = dayInput.dayTrades.map((row, index) => {
      const target = String(row.contract?.contractId ?? row.contract?.symbol ?? `contract-${index}`).toUpperCase();
      return { ...row, catalystReview: calendar.reviews[target] };
    });
    economicCalendarDiagnostics = { ...calendar.diagnostics, source: catalystSource };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    dayInput.dayTrades = dayInput.dayTrades.map((row) => ({ ...row, catalystReview: { status: 'blocked', source: 'Finnhub Economic Calendar',
      summary: 'Economic calendar unavailable; scheduled-event clearance is blocked.', reviewedAt: new Date(now).toISOString() } }));
    economicCalendarDiagnostics = { status: 'provider_error', source: catalystSource, providerError: message };
  }
}
finishStage('catalystCalendar', calendarStartedAt);
const liveSessionStartedAt = startStage();
now = Date.now();
const entryFeedStartedAt = now;
let liveSessionDiagnostics = { status: dayInput.dayTrades.length === 0 ? 'no_day_trades' : dayDataSource === 'manual' ? 'manual-session-input' : 'not_started', source: dayDataSource };
if (dayDataSource === 'databento-live' && dayInput.dayTrades.length) {
  try {
    const requestedInputs = dayInput.dayTrades.filter((row) => !row.discoveryContext || row.trendDataStatus === 'complete');
    const liveSession = await fetchDatabentoFuturesDayMarketData(requestedInputs, {
      apiKey: env('DATABENTO_API_KEY'), dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now,
      maxQuoteAgeMs: envNumber('FUTURES_MAX_QUOTE_AGE_MS', 5_000),
      maxTransportLagMs: envNumber('FUTURES_MAX_TRANSPORT_LAG_MS', 2_000),
      timeoutMs: envNumber('FUTURES_LIVE_SESSION_TIMEOUT_MS', 30_000),
      minBookSize: envNumber('FUTURES_MIN_ENTRY_BOOK_SIZE', 1), metrics: providerMetrics,
    });
    let responseIndex = 0;
    dayInput.dayTrades = dayInput.dayTrades.map((row) => requestedInputs.includes(row) ? liveSession.rows[responseIndex++]
      : { ...row, quote: null, bars: [], liveDataStatus: 'skipped_h1_incomplete', liveDataReasons: ['h1_trend_data_incomplete'] });
    liveSessionDiagnostics = { ...liveSession.diagnostics, source: dayDataSource,
      activityInputsSkippedWithoutH1: dayInput.dayTrades.length - requestedInputs.length };
    now = Date.now();
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    dayInput.dayTrades = dayInput.dayTrades.map((row) => ({ ...row, quote: null, bars: [], liveDataStatus: 'provider_error', liveDataReasons: [message] }));
    liveSessionDiagnostics = { status: 'provider_error', source: dayDataSource, providerError: message };
  }
}
finishStage('liveSessionData', liveSessionStartedAt);
now = Date.now();
const entryFeedCompletedAt = now;
sessionDate = dayInput.sessionDate ?? dayInput.dayTrades[0]?.session?.marketDate ?? dayInput.marks?.[0]?.sessionDate ?? futuresMarketDateAt(now);
const dayStrategyStartedAt = startStage();
const dayResults = [];
const decisionAges = [];
const forwardShadowObservations = [];
for (const input of dayInput.dayTrades) {
  now = Date.now();
  const quoteAt = typeof input.quote?.time === 'number' ? input.quote.time : Date.parse(input.quote?.time ?? '');
  decisionAges.push({ contractId: input.contract?.contractId ?? null, evaluatedAt: new Date(now).toISOString(),
    quoteTime: Number.isFinite(quoteAt) ? new Date(quoteAt).toISOString() : null,
    quoteAgeMs: Number.isFinite(quoteAt) ? now - quoteAt : null });
  const primaryResearch = matchPrimaryResearchForFuture(input, primarySignals);
  if (dayDataSource === 'databento-live' && input.liveDataStatus !== 'complete') {
    dayResults.push({ symbol: input.contract?.symbol ?? null, contractId: input.contract?.contractId ?? null,
      status: 'no-setup', reasons: ['live_session_data_incomplete', ...(input.liveDataReasons ?? [])], primaryResearch, discoveryContext: input.discoveryContext ?? null });
    continue;
  }
  if (trendDataSource === 'databento-historical' && input.trendDataStatus !== 'complete') {
    dayResults.push({ symbol: input.contract?.symbol ?? null, contractId: input.contract?.contractId ?? null,
      status: 'no-setup', reasons: ['h1_trend_data_incomplete', ...(input.trendDataReasons ?? [])], primaryResearch, discoveryContext: input.discoveryContext ?? null });
    continue;
  }
  let contract;
  try { contract = validateActiveFutureContract(input.contract, { now }); }
  catch (error) {
    dayResults.push({ symbol: input.contract?.symbol ?? null, status: 'contract-rejected', reasons: [String(error.message)], primaryResearch, discoveryContext: input.discoveryContext ?? null });
    continue;
  }
  if (dayDataSource === 'databento-live' && trendDataSource === 'databento-historical') {
    forwardShadowObservations.push({ instrumentKey: contract.contractId, strategyInput: {
      ...input, contract, now, accountEquityUsd: accountEquity,
      catalystReview: input.catalystReview, config: { ...strategyConfig, ...input.config },
    } });
  }
  const strategy = evaluateFuturesOpeningRange({
    ...input, contract, now, accountEquityUsd: accountEquity,
    catalystReview: input.catalystReview, config: { ...strategyConfig, ...input.config },
  });
  if (strategy.status !== 'candidate') {
    dayResults.push({ symbol: contract.symbol, contractId: contract.contractId, status: strategy.status, reasons: strategy.reasons, primaryResearch, discoveryContext: input.discoveryContext ?? null });
    continue;
  }
  const ledger = await readPaperRiskLedger({ statePath });
  now = Date.now();
  const performance = summarizePaperLedger(ledger, { accountEquity, sessionDate, now });
  const active = ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
  decisionAges.at(-1).riskEvaluatedAt = new Date(now).toISOString();
  decisionAges.at(-1).riskQuoteAgeMs = Number.isFinite(quoteAt) ? now - quoteAt : null;
  let decision = evaluatePaperCandidate(strategy.candidate, {
    accountEquity, realizedPnlToday: performance.realizedPnlRiskDayUtcUsd, openPositions: active,
    closedOrders: ledger.orders.filter((order) => order.status === 'closed'),
  }, { ...riskPolicy, now, maxQuoteAgeMs: Math.min(riskPolicy.maxQuoteAgeMs, Number(input.config?.maxQuoteAgeMs ?? 5_000), 5_000) });
  if (dayDataSource === 'databento-live') decision = enforceFuturesTopBookDepth(decision, input.quote);
  if (decision.status !== 'paper-approved') {
    dayResults.push({ symbol: contract.symbol, contractId: contract.contractId, status: 'risk-blocked', strategy: strategy.strategy, candidate: strategy.candidate, decision, primaryResearch, discoveryContext: input.discoveryContext ?? null });
    continue;
  }
  const reservation = await reservePaperCandidate(strategy.candidate, decision, { statePath, now: Date.now(), observationClock: Date.now, emergencyStop });
  decisionAges.at(-1).reservationCheckedAt = new Date(Date.now()).toISOString();
  decisionAges.at(-1).reservationStatus = reservation.status;
  dayResults.push({ symbol: contract.symbol, contractId: contract.contractId, status: reservation.status, strategy: strategy.strategy, candidate: strategy.candidate, decision, reservation, primaryResearch, discoveryContext: input.discoveryContext ?? null });
}
finishStage('dayStrategyAndRisk', dayStrategyStartedAt);
const activityResults = dayResults.filter((r) => r.discoveryContext?.cohort === 'broad_activity_reviewed');
const activityInputs = dayInput.dayTrades.filter((r) => r.discoveryContext?.cohort === 'broad_activity_reviewed');
Object.assign(activityAnalysis.diagnostics, {
  detailedInputs: activityInputs.length,
  dataReady: activityInputs.filter((r) => r.liveDataStatus === 'complete' && r.trendDataStatus === 'complete').length,
  strategyQualified: activityResults.filter((r) => r.candidate).length,
  riskApproved: activityResults.filter((r) => r.decision?.status === 'paper-approved').length,
  reservations: activityResults.filter((r) => r.reservation?.status === 'reserved').length,
});
for (const row of activityAnalysis.decisions) {
  const outcome = activityResults.find((r) => r.discoveryContext.identity === row.identity);
  if (outcome) { row.analysisStatus = outcome.status; row.analysisReasons = outcome.reasons ?? outcome.decision?.reasons ?? []; }
}
const forwardShadowProfiles = [
  { id: 'higher-relative-volume', overrides: { minRelativeVolume: 1.75 }, hypothesis: 'Stronger relative volume improves costed opening-range expectancy.', changeMade: 'Require relative volume of 1.75.', reason: 'Compare participation quality with the baseline.' },
  { id: 'longer-opening-range', overrides: { rangeBars: 4 }, hypothesis: 'A longer opening range reduces false breakouts enough to improve expectancy.', changeMade: 'Use four completed five-minute opening bars.', reason: 'Measure confirmation benefit against delayed entry.' },
  { id: 'larger-breakout-buffer', overrides: { breakoutBufferAtr: 0.1 }, hypothesis: 'A larger ATR buffer filters false breaks without losing too much upside.', changeMade: 'Use a 0.10 ATR breakout buffer.', reason: 'Compare breakout quality and fill rate after costs.' },
];
const shadowStartedAt = startStage();
now = Date.now();
const forwardShadowResults = dayDataSource === 'databento-live' && trendDataSource === 'databento-historical' ? await runForwardShadowPaper({
  owner: 'futures', strategyVersion: activityAnalysisEnabled ? 'future-session-orb-h1-broad-activity-shadow-v2-decision-clock' : 'future-session-orb-h1-shadow-v3-decision-clock', profiles: forwardShadowProfiles,
  allowlist: ['rangeBars', 'minRelativeVolume', 'breakoutBufferAtr'], baseConfig: { ...strategyConfig,
    ...(activityAnalysisEnabled ? { discoveryPolicy: { version: activityAnalysis.diagnostics.version,
      maxAdditional: envNumber('FUTURES_ACTIVITY_MAX_ANALYSIS', 10), maxCandidates: envNumber('FUTURES_ACTIVITY_MAX_CANDIDATES', 20),
      maxContractsPerRoot: envNumber('FUTURES_ACTIVITY_MAX_CONTRACTS_PER_ROOT', 1),
      lookbackMinutes: envNumber('FUTURES_ACTIVITY_LOOKBACK_MINUTES', 30), maxBarAgeMs: envNumber('FUTURES_ACTIVITY_MAX_BAR_AGE_MS', 180000) } } : {}) },
  observations: forwardShadowObservations,
  evaluate: (observation, config, at) => evaluateFuturesOpeningRange({ ...observation.strategyInput,
    now: at, config: { ...strategyConfig, ...observation.strategyInput.config, ...config } }),
  riskGate: (decision, observation) => enforceFuturesTopBookDepth(decision, observation.strategyInput.quote),
  loadOpenOrderQuotes: async (profiles, at) => {
    const perProfile = new Map(profiles.map((profile) => [profile.profileId, new Map()]));
    const orders = profiles.flatMap((profile) => profile.orders);
    if (!orders.length) return perProfile;
    try {
      const marked = await fetchDatabentoFuturePositionMarks(orders, { apiKey: env('DATABENTO_API_KEY'),
        dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'), now: Date.now(),
        maxQuoteAgeMs: envNumber('FUTURES_MAX_POSITION_QUOTE_AGE_MS', 5_000),
        maxTransportLagMs: envNumber('FUTURES_MAX_TRANSPORT_LAG_MS', 2_000),
        timeoutMs: envNumber('FUTURES_LIVE_QUOTE_TIMEOUT_MS', 8_000), metrics: providerMetrics });
      const profileByOrder = new Map(profiles.flatMap((profile) => profile.orders.map((order) => [order.orderId, profile.profileId])));
      const orderById = new Map(orders.map((order) => [order.orderId, order]));
      for (const mark of marked.marks) {
        const profileId = profileByOrder.get(mark.orderId), order = orderById.get(mark.orderId);
        if (profileId && order) perProfile.get(profileId).set(order.instrumentKey.toUpperCase(), mark.quote);
      }
    } catch { /* Provider failures are retained in providerMetrics; no stale quote is substituted. */ }
    return perProfile;
  },
  quotesByInstrument: new Map(forwardShadowObservations.map((row) => [row.instrumentKey.toUpperCase(), row.strategyInput.quote]).filter((row) => row[1])),
  stateDirectory: env('OMNIMOD_FORWARD_SHADOW_STATE_DIR', `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`), portfolioStatePath: statePath, now, observationClock: Date.now, accountEquity,
riskPolicy, maxQuoteAgeMs: Math.min(riskPolicy.maxQuoteAgeMs, 5_000), maxSpreadPct: riskPolicy.maxSpreadPct,
  sessionOpen: forwardShadowObservations.length > 0, sessionDate,
}) : [];
finishStage('forwardShadow', shadowStartedAt);
const preReportLedger = await readPaperRiskLedger({ statePath });
now = Date.now();
updatePositionDiagnostics(preReportLedger, now);
const observations = rows.map((row) => {
  const ageMinutes = marketObservationAgeMinutes(row, now);
  const stale = !isMarketObservationFresh(row, now, maxAgeMinutes);
  return {
    ...row,
    instrumentType: 'exchange-traded future (continuous provider symbol)',
    contractMode: 'continuous-proxy',
    contractSpecVerified: false,
    ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(1)) : null,
    stale,
    ...(stale ? {} : { scenarios: [horizonScenario(row, 1, row.return1dPct, '1-day'), horizonScenario(row, 5, row.return5dPct, '5-day')] }),
  };
});
const funnel = summarizeFuturesFunnel(dayResults, {
  universe: specs.length, observed: observations.filter((x) => Number.isFinite(x.price) && x.price > 0 && x.ageMinutes !== null).length,
  stale: observations.filter((x) => x.stale).length,
  providerErrors: observations.filter((x) => x.providerError).length, providerMetrics,
  elapsedMs: Date.now() - scanStartedAt, stageDurationsMs, source: `${source}/${dayDataSource}`,
});
const contractDiscoveryAudit = auditFuturesContractDiscovery(dayInput.dayTrades, contractDiscovery.contracts);
const dayTradeReadiness = summarizeFuturesDayTradeReadiness(dayInput.dayTrades, contractDiscovery, dayTradeDraftRows);
funnel.marketDataReadiness = assessMarketDataReadiness('futures', {
  observedRows: dayInput.dayTrades.filter((row) => row.quote?.quality === 'executable').length,
  inputCount: dayInput.dayTrades.length, providerRequests: funnel.provider.requests, providerFailures: funnel.provider.failures });
funnel.activityAnalysis = { ...activityAnalysis.diagnostics, decisions: activityAnalysis.decisions };
funnel.positionMarkDiagnostics = positionMarkDiagnostics;
funnel.decisionTiming = { positionMonitoringStartedAt: new Date(positionMonitoringStartedAt).toISOString(),
  positionMonitoringCompletedAt: new Date(positionMonitoringCompletedAt).toISOString(),
  entryFeedStartedAt: new Date(entryFeedStartedAt).toISOString(), entryFeedCompletedAt: new Date(entryFeedCompletedAt).toISOString(),
  decisions: decisionAges };
funnel.contextDataDiagnostics = contextDataDiagnostics;
funnel.trendDataDiagnostics = trendDataDiagnostics;
funnel.liveSessionDiagnostics = liveSessionDiagnostics;
funnel.dayTradeReadiness = dayTradeReadiness;
funnel.contractLifecycleDiagnostics = contractLifecycleDiagnostics;
funnel.contractDiscovery = { status: contractDiscovery.status, cached: contractDiscovery.cached,
  ageMs: contractDiscovery.ageMs, definitions: contractDiscovery.contracts.length,
  tradeEligible: contractDiscovery.contracts.filter((row) => row.tradeEligible === true).length,
  providerError: contractDiscovery.providerError || null,
  configuredComparisonCounts: contractDiscoveryAudit.statusCounts };
funnel.contractDiscovery.directory = contractDiscovery.diagnostics || null;
funnel.contractDiscovery.archive = contractDiscovery.archive || null;
const journal = await appendPaperSnapshot('futures', observations, {
  strategy: 'cross-horizon futures context; continuous symbols only',
  source,
  maxAgeMinutes,
  contractMode: 'continuous-proxy',
  note: 'Context rows use unverified continuous proxies. Databento Live can supply 1-minute-replayed session bars and fresh MBP-1 quotes; optional Databento Historical H1 bars require exact verified active raw contracts and pass a combined per-scan cost cap. Contract specs and session boundaries remain configured inputs. Catalyst review may be manual or an opt-in Finnhub scheduled macro-event blackout. No broker route exists.',
  dayResults, funnel, providerMetrics, markResults, positionMarkDiagnostics, liveSessionDiagnostics, trendDataDiagnostics, economicCalendarDiagnostics,
  primaryResearchContext: { loaded: primarySignals.length, matched: dayResults.reduce((sum, row) => sum + row.primaryResearch.length, 0), maxAgeMs: primarySignalMaxAgeMs, readError: primarySignalReadError, sourceRead: primarySignalReadDiagnostics },
  performance: summarizePaperLedger(await readPaperRiskLedger({ statePath }), { accountEquity, sessionDate, now }),
});
if (dayResults.length) await appendPaperSnapshot('futures-day', dayResults, { source: `${dayDataSource}-session-input`, sessionDate, liveSessionDiagnostics, trendDataDiagnostics, economicCalendarDiagnostics, paperOnly: true });
const dedupeKey = JSON.stringify({ observations: observations.map((row) => [row.symbol, row.stale, ...(row.scenarios ?? []).map((x) => x.bias)]), dayResults: dayResults.map((row) => [row.contractId, row.status, row.strategy]) });
const researchHandoffRows = buildPaperResearchHandoffRows('futures', dayResults);
let delivery;
try {
  delivery = await postDiscordMessage(buildDayTradingBrief({ bot: 'futures', at: journal.capturedAt,
  readiness: funnel.marketDataReadiness,
  source: `Context: ${source}; day-session data: ${dayDataSource}`,
  coverage: `${formatDiagnosticCount(funnel.contextUniverse.observed)}/${formatDiagnosticCount(funnel.contextUniverse.universe)} context symbols observed · ${dayInput.dayTrades.length} day-strategy inputs · ${formatDiagnosticCount(funnel.provider.failures)} provider failures. Continuous proxies are context only.${contractDiscovery.diagnostics ? `\nProvider directory (${contractDiscovery.status}): ${formatDiagnosticCount(contractDiscovery.diagnostics.uniqueIdentities)} identities · ${formatDiagnosticCount(contractDiscovery.diagnostics.discoveredRoots)} outright roots · ${formatDiagnosticCount(contractDiscovery.diagnostics.currentlyUnexpiredReferences ?? contractDiscovery.diagnostics.unexpiredOutrights)} unexpired references. Historical definitions are not live quotes or approved setups.` : ''}`,
  results: dayResults, handoffRows: researchHandoffRows, emergencyStop,
  context: [`Day-strategy inputs: ${dayTradeReadiness.status}`, `Session feed: ${liveSessionDiagnostics.status} · H1 feed: ${trendDataDiagnostics.status}`, `Catalyst calendar: ${economicCalendarDiagnostics.status}`,
    ...(env('FUTURES_ACTIVITY_DISCOVERY_ENABLED', 'false') === 'true' ? [activityAnalysisEnabled
      ? `Broad activity: ${activityAnalysis.diagnostics.activityCandidates ?? 'unknown'} shortlisted · ${activityAnalysis.diagnostics.selected} routed for full analysis · ${activityAnalysis.diagnostics.rejected} rejected · ${activityAnalysis.diagnostics.deferred} deferred. /futures scanstats shows routing reasons.`
      : 'Separate broad activity research runs after entry delivery; /futures scanstats reports its coverage. Historical bars are not entry alerts or executable quotes.'] : []),
    'Only verified active contracts qualify; tick value, margin, expiry and settlement gates remain required.'],
}), { dedupeKey });
} catch {
  // A messaging outage must not discard market diagnostics or stop independent research.
  delivery = { enabled: true, posted: false, deliveryError: 'Discord delivery failed; verify destination permissions and service availability.' };
}
const researchHandoff = await publishDeliveredPaperResearch('futures', researchHandoffRows, delivery, { now });
// Without analysis opt-in, preserve existing post-delivery research timing.
if (!activityDiscovery) activityDiscovery = await runBroadActivityDiscovery();
const finalReportLedger = await readPaperRiskLedger({ statePath });
now = Date.now();
updatePositionDiagnostics(finalReportLedger, now);
funnel.positionMarkDiagnostics = positionMarkDiagnostics;
funnel.contractLifecycleDiagnostics = contractLifecycleDiagnostics;
Object.assign(funnel, summarizeFuturesFunnel(dayResults, {
  universe: specs.length, observed: observations.filter((x) => Number.isFinite(x.price) && x.price > 0 && x.ageMinutes !== null).length,
  stale: observations.filter((x) => x.stale).length, providerErrors: observations.filter((x) => x.providerError).length,
  providerMetrics, elapsedMs: Date.now() - scanStartedAt, stageDurationsMs, source: `${source}/${dayDataSource}`,
}));
funnel.discordDelivery = { posted: delivery.posted === true, enabled: delivery.enabled === true, error: delivery.deliveryError || null };
funnel.activityDiscovery = { ...activityDiscovery.diagnostics, archive: activityDiscovery.archive || null,
  candidateSample: activityDiscovery.candidates.slice(0, 5).map((r) => ({ rawSymbol: r.providerRawSymbol, root: r.providerRoot,
    direction: r.direction, movePct: r.movePct, observedVolume: r.totalContractsTraded, latestBarClosedAt: r.latestBarClosedAt,
    tradeEligible: false })) };
await appendScanDiagnostic('futures', { ...funnel,
  contractLifecycleDiagnostics,
  forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, mode: track.mode, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
  safety: { emergencyStopActive: emergencyStop, liveTradingEnabled: false,
    liveTradingRequested: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true', orderRoutingAvailable: false,
    observedAt: new Date().toISOString() } }).catch((error) => console.error('Unable to persist Futures scan diagnostics:', error.message));
console.log(JSON.stringify({
  bot: 'futures', mode: `${source} research plus ${dayDataSource} day-input paper reservations; no live orders`,
  source,
  asOf: journal.capturedAt,
  funnel, dayTradeReadiness, providerMetrics, liveSessionDiagnostics, trendDataDiagnostics, economicCalendarDiagnostics,
  contractDiscovery: { ...contractDiscovery, contracts: contractDiscovery.contracts.slice(0, 40),
    contractsShown: Math.min(40, contractDiscovery.contracts.length), totalContractReferences: contractDiscovery.contracts.length }, contractDiscoveryAudit,
  activityDiscovery: { diagnostics: activityDiscovery.diagnostics, archive: activityDiscovery.archive || null, candidates: activityDiscovery.candidates },
  primaryResearchContext: { loaded: primarySignals.length, matched: dayResults.reduce((sum, row) => sum + row.primaryResearch.length, 0), maxAgeMs: primarySignalMaxAgeMs, readError: primarySignalReadError, sourceRead: primarySignalReadDiagnostics },
  counts: { ...funnel.contextUniverse, ...funnel.dayTrade },
  observations, dayResults, markResults, positionMarkDiagnostics, contractLifecycleDiagnostics, performance: summarizePaperLedger(await readPaperRiskLedger({ statePath }), { accountEquity, sessionDate, now }), paperJournal: journal, researchHandoff, discordDelivery: delivery,
}, null, 2));
