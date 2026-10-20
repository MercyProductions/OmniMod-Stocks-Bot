import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordMessage } from '../../shared/discordWebhook.js';
import { buildDayTradingBrief } from '../../shared/discordPresentation.js';
import { assessMarketDataReadiness } from '../../shared/marketDataReadiness.js';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger } from '../../shared/paperRisk.js';
import { buildOptionDayTradeCandidate } from './strategies.js';
import { OPTIONS_DAY_STRATEGY_ID } from './primaryHypothesis.js';
import { createOptionDecisionRefresher } from './decisionQuotes.js';
import { fetchTradierOptionInputs, fetchTradierOptionPositionMarks, summarizeOptionSignalUniverse } from './tradierMarketData.js';
import { readPrimaryResearchSignalsWithDiagnostics } from '../../shared/signalResearch.js';
import { buildPaperResearchHandoffRows, publishDeliveredPaperResearch } from '../../shared/paperSignalHandoff.js';
import { resolveOptionSignalsFromShared } from './signalSources.js';
import { summarizeOptionsScan } from './diagnostics.js';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';
import { summarizePositionMarkCoverage } from '../../shared/positionMarkDiagnostics.js';
import { fetchFinnhubEconomicCalendar } from '../../shared/finnhubEconomicCalendar.js';
import { applyAlpacaCatalystNews, fetchAlpacaCatalystNews } from '../../shared/alpacaCatalystNews.js';
import { fetchAlpacaCallDividendScreen } from './alpacaDividendScreen.js';
import { getPaperLedgerWorkspaceRoot, resolvePaperLedgerPath } from '../../shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../shared/forwardShadowPaper.js';
import { marketDateAt } from '../../shared/marketDate.js';
import { performance as highResolutionClock } from 'node:perf_hooks';
import { summarizeOptionExpiryLifecycle } from './expiryLifecycle.js';
import { formatDiagnosticCount } from '../../shared/formatDiagnosticCount.js';
import { discoverOptionUnderlyings, describeOptionsDiscovery } from './underlyingDiscovery.js';
import { discoverOptionContracts, describeOptionContracts } from './contractDiscovery.js';
import { analyzeOptionUnderlyings, describeUnderlyingResearch } from './underlyingIntradayResearch.js';
import { runIndependentOptionPaper, describeIndependentOptionPaper } from './independentPaperResearch.js';

const env = (key, fallback = '') => process.env[key] == null || process.env[key].trim() === '' ? fallback : process.env[key];
const envNumber = (key, fallback) => {
  const value = Number(env(key, fallback));
  return Number.isFinite(value) ? value : NaN;
};
let now = Date.now();
const statePath = resolvePaperLedgerPath(env('TRADING_RISK_STATE_PATH', ''));
const emergencyStop = env('OMNIMOD_EMERGENCY_STOP', 'true') !== 'false';
const restartRecovery = await recoverPaperOrders({ owner: 'options', statePath, now, emergencyStop });
const inputPath = resolve(process.cwd(), env('OPTIONS_SESSION_FILE', 'examples/paper-session.json'));
const input = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(input.signals)) throw new Error('Options session file must contain a signals array.');
const scanStartedAt = Date.now();
const stageDurationsMs = {};
const startStage = () => highResolutionClock.now();
const finishStage = (name, startedAt) => { stageDurationsMs[name] = Number(Math.max(0, highResolutionClock.now() - startedAt).toFixed(2)); };
const source = env('OPTIONS_SOURCE', 'manual').toLowerCase();
if (!['manual', 'tradier'].includes(source)) throw new Error('OPTIONS_SOURCE must be manual or tradier.');
const signalSource = env('OPTIONS_SIGNAL_SOURCE', 'manual').toLowerCase();
if (!['manual', 'shared'].includes(signalSource)) throw new Error('OPTIONS_SIGNAL_SOURCE must be manual or shared.');
if (signalSource === 'shared' && source !== 'tradier') throw new Error('OPTIONS_SIGNAL_SOURCE=shared requires OPTIONS_SOURCE=tradier to verify live session and quotes.');
let signalRows = input.signals;
let signalMappingDiagnostics = { status: signalSource === 'shared' ? 'not_started' : 'manual-input' };
let stageStartedAt = startStage();
if (signalSource === 'shared') {
  const maxAgeMs = envNumber('OPTIONS_PRIMARY_SIGNAL_MAX_AGE_MS', 120_000);
  const sourceRead = await readPrimaryResearchSignalsWithDiagnostics({ now, maxAgeMs, owners: ['stocks', 'etfs-etps'] });
  const reviewPath = resolve(process.cwd(), env('OPTIONS_CATALYST_REVIEW_FILE', 'examples/catalyst-reviews.json'));
  const reviewInput = JSON.parse(await readFile(reviewPath, 'utf8'));
  if (!Array.isArray(reviewInput.reviews)) throw new Error('Catalyst review file must contain a reviews array.');
  const mapping = resolveOptionSignalsFromShared(sourceRead.records, reviewInput);
  signalRows = mapping.rows;
  signalMappingDiagnostics = { ...mapping.diagnostics, sourceRead: sourceRead.diagnostics };
}
finishStage('signalLoadingAndMapping', stageStartedAt);
let marketDataLatencyMs = null;
const providerMetrics = [];
// Owned positions receive current quotes before new entry data is collected.
const markResults = [];
markResults.push({ type: 'restart_recovery', ...restartRecovery });
stageStartedAt = startStage();
const markLedgerBefore = await readPaperRiskLedger({ statePath });
let positionMarkDiagnostics = { status: source === 'tradier' ? 'not_started' : 'manual_marks_only' };
let positionMarks = [];
if (source === 'tradier') {
  try {
    const marked = await fetchTradierOptionPositionMarks(markLedgerBefore.orders, {
      token: env('TRADIER_TOKEN'), environment: env('TRADIER_ENV', 'sandbox'), now: Date.now(),
      maxQuoteAgeMs: envNumber('OPTIONS_MAX_QUOTE_AGE_MS', 10_000), providerMetrics,
      maxLegSkewMs: envNumber('OPTIONS_MAX_LEG_SKEW_MS', 3_000),
      entryReviewOptions: signalSource === 'manual' && !process.env.OPTIONS_CATALYST_REVIEW_FILE
        ? { manualSessionFile: inputPath } : {},
    });
    positionMarks = marked.marks;
    positionMarkDiagnostics = marked.diagnostics;
  } catch (error) {
    positionMarkDiagnostics = { status: 'provider_error', providerError: String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180) };
  }
}
const manualMarkIds = new Set((input.marks ?? []).map((mark) => mark.orderId));
const availablePositionMarks = [...(input.marks ?? []), ...positionMarks.filter((row) => !manualMarkIds.has(row.orderId))];
const positionMarkAttempts = [];
for (const mark of availablePositionMarks) {
  const result = await processPaperQuote(mark.orderId, mark.quote, { expectedOwner: 'options',
    statePath, now: Date.now(), observationClock: Date.now, maxQuoteAgeMs: envNumber('OPTIONS_MAX_QUOTE_AGE_MS', 10_000),
    maxSpreadPct: envNumber('OPTIONS_MAX_COMBO_SPREAD_PCT', 25), sessionOpen: mark.sessionOpen === true, emergencyStop,
  });
  markResults.push({ orderId: mark.orderId, ...result });
  positionMarkAttempts.push({ orderId: mark.orderId, ...result });
}
const markLedgerAfter = await readPaperRiskLedger({ statePath });
now = Date.now();
let optionExpiryDiagnostics;
finishStage('positionMonitoring', stageStartedAt);
function updatePositionDiagnostics(ledger, at) {
  optionExpiryDiagnostics = summarizeOptionExpiryLifecycle(ledger.orders, at, 'America/New_York');
  positionMarkDiagnostics = { ...positionMarkDiagnostics, assessedAt: new Date(at).toISOString(),
    ...summarizePositionMarkCoverage({ owner: 'options', beforeOrders: markLedgerBefore.orders, afterOrders: ledger.orders,
      availableMarks: availablePositionMarks, attempts: positionMarkAttempts, now: at,
      maxAgeMs: envNumber('OPTIONS_MAX_OPEN_MARK_AGE_MS', 300_000) }),
  };
}
updatePositionDiagnostics(markLedgerAfter, now);

const catalystSource = env('OPTIONS_CATALYST_SOURCE', 'manual').toLowerCase();
if (!['manual', 'finnhub', 'alpaca', 'finnhub+alpaca'].includes(catalystSource)) throw new Error('OPTIONS_CATALYST_SOURCE must be manual, finnhub, alpaca, or finnhub+alpaca.');
const catalystSources = new Set(catalystSource.split('+'));
const usesFinnhubCalendar = catalystSources.has('finnhub');
const usesAlpacaNews = catalystSources.has('alpaca');
const dividendDataSource = env('OPTIONS_ASSIGNMENT_DATA_SOURCE', 'manual').toLowerCase();
if (!['manual', 'alpaca'].includes(dividendDataSource)) throw new Error('OPTIONS_ASSIGNMENT_DATA_SOURCE must be manual or alpaca.');
if (dividendDataSource === 'alpaca' && source !== 'tradier') throw new Error('OPTIONS_ASSIGNMENT_DATA_SOURCE=alpaca requires OPTIONS_SOURCE=tradier so each event can be checked against the actual option expiry.');
let dividendScreenDiagnostics = { status: dividendDataSource === 'alpaca' ? 'not_started' : 'disabled', source: dividendDataSource === 'alpaca' ? 'Alpaca Corporate Actions' : null };
let economicCalendarDiagnostics = { status: usesFinnhubCalendar ? 'not_started' : 'disabled', source: usesFinnhubCalendar ? 'Finnhub Economic Calendar' : null };
stageStartedAt = startStage();
now = Date.now();
if (usesFinnhubCalendar && signalRows.length) {
  const targets = [...new Set(signalRows.map((row) => String(row.signal?.underlyingSymbol ?? '').trim().toUpperCase()).filter(Boolean))];
  const targetCountryMap = Object.fromEntries(targets.map((symbol) => [symbol, ['US']]));
  const calendarDate = input.sessionDate ?? signalRows[0]?.signal?.sessionDate ?? marketDateAt(now, 'America/New_York');
  try {
    const calendar = await fetchFinnhubEconomicCalendar({ token: env('FINNHUB_API_KEY'), marketDate: calendarDate,
      instruments: targets, countryCodesByInstrument: targetCountryMap, now, metrics: providerMetrics });
    signalRows = signalRows.map((row) => ({ ...row, signal: { ...row.signal, catalystReview: calendar.reviews[String(row.signal?.underlyingSymbol ?? '').toUpperCase()] } }));
    economicCalendarDiagnostics = { ...calendar.diagnostics, source: catalystSource };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    signalRows = signalRows.map((row) => ({ ...row, signal: { ...row.signal, catalystReview: { status: 'blocked', source: 'Finnhub Economic Calendar',
      summary: 'Economic calendar unavailable; scheduled-event clearance is blocked.', reviewedAt: new Date(now).toISOString() } } }));
    economicCalendarDiagnostics = { status: 'provider_error', source: catalystSource, providerError: message };
  }
} else if (usesFinnhubCalendar) {
  economicCalendarDiagnostics = { status: 'no_signals', source: catalystSource };
}
let companyNewsDiagnostics = { status: usesAlpacaNews ? 'not_started' : 'disabled', source: usesAlpacaNews ? 'Alpaca' : null };
now = Date.now();
if (usesAlpacaNews && signalRows.length) {
  const targets = [...new Set(signalRows.map((row) => String(row.signal?.underlyingSymbol ?? '').trim().toUpperCase()).filter(Boolean))];
  try {
    const news = await fetchAlpacaCatalystNews(targets, {
      key: env('ALPACA_API_KEY_ID', env('APCA_API_KEY_ID')),
      secret: env('ALPACA_API_SECRET_KEY', env('APCA_API_SECRET_KEY')),
      now, metrics: providerMetrics,
    });
    now = Date.now();
    signalRows = applyAlpacaCatalystNews(signalRows, news, { now });
    companyNewsDiagnostics = { ...news.diagnostics, source: 'Alpaca', rejected: signalRows.filter((row) => row.catalystNewsStatus !== 'clear').length };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    signalRows = signalRows.map((row) => ({ ...row, catalystNewsStatus: 'provider-error', signal: { ...row.signal,
      catalystReview: { status: 'blocked', source: 'Alpaca recent company news', summary: 'Recent company-news coverage unavailable; catalyst clearance is blocked.', reviewedAt: new Date(now).toISOString() } } }));
    companyNewsDiagnostics = { status: 'provider_error', source: 'Alpaca', providerError: message };
  }
} else if (usesAlpacaNews) {
  companyNewsDiagnostics = { status: 'no_signals', source: 'Alpaca' };
}
finishStage('calendarAndCompanyNews', stageStartedAt);
stageStartedAt = startStage();
if (source === 'tradier' && signalRows.length) {
  const startedAt = Date.now();
  try {
    signalRows = await fetchTradierOptionInputs(signalRows, {
      token: env('TRADIER_TOKEN'), environment: env('TRADIER_ENV', 'sandbox'), now: Date.now(),
      maxQuoteAgeMs: envNumber('OPTIONS_MAX_QUOTE_AGE_MS', 10_000),
      maxCatalystReviewAgeMs: envNumber('OPTIONS_CATALYST_REVIEW_MAX_AGE_MS', 30 * 60_000),
      minDaysToExpiry: envNumber('OPTIONS_MIN_DTE', 1), maxDaysToExpiry: envNumber('OPTIONS_MAX_DTE', 7),
      providerMetrics,
    });
  } catch (error) {
    const marketDataDiagnostics = summarizeOptionSignalUniverse(signalRows);
    signalRows = signalRows.filter((row) => row?.signal?.underlyingSymbol)
      .filter((row, index, rows) => rows.findIndex((other) => String(other.signal.underlyingSymbol).trim().toUpperCase()
        === String(row.signal.underlyingSymbol).trim().toUpperCase()) === index)
      .slice(0, marketDataDiagnostics.maxSymbols)
      .map((row) => ({ ...row, marketDataStatus: 'provider-error', marketDataDiagnostics,
        providerError: String(error.message || error).slice(0, 180) }));
  }
  marketDataLatencyMs = Date.now() - startedAt;
}
finishStage('tradierSessionQuotesAndChains', stageStartedAt);
stageStartedAt = startStage();
if (dividendDataSource === 'alpaca') {
  try {
    const dividendScreen = await fetchAlpacaCallDividendScreen(signalRows, {
      key: env('ALPACA_API_KEY_ID', env('APCA_API_KEY_ID')),
      secret: env('ALPACA_API_SECRET_KEY', env('APCA_API_SECRET_KEY')),
      metrics: providerMetrics,
    });
    signalRows = dividendScreen.rows;
    dividendScreenDiagnostics = { ...dividendScreen.diagnostics, source: 'Alpaca Corporate Actions' };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    signalRows = signalRows.map((row) => row.signal?.direction === 'long' ? { ...row, signal: { ...row.signal, corporateActionScreenStatus: 'provider_error' } } : row);
    dividendScreenDiagnostics = { status: 'provider_error', source: 'Alpaca Corporate Actions', providerError: message };
  }
}
finishStage('dividendAssignmentScreen', stageStartedAt);
const ledger = await readPaperRiskLedger({ statePath });
const sessionDate = input.sessionDate ?? signalRows[0]?.signal?.sessionDate ?? input.marks?.[0]?.sessionDate ?? marketDateAt(now, 'America/New_York');
const accountEquity = envNumber('PAPER_ACCOUNT_EQUITY_USD', 0);
let performance = summarizePaperLedger(ledger, { accountEquity, sessionDate, now });
let portfolio = {
  accountEquity,
  realizedPnlToday: performance.realizedPnlRiskDayUtcUsd,
  openPositions: ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status)),
  closedOrders: ledger.orders.filter((order) => order.status === 'closed'),
};
const strategyConfig = {
  catalystSource,
  primarySignalMaxAgeMs: Math.min(120000, envNumber('OPTIONS_PRIMARY_SIGNAL_MAX_AGE_MS', 120000)),
  maxQuoteAgeMs: envNumber('OPTIONS_MAX_QUOTE_AGE_MS', 10_000),
  maxLegSkewMs: envNumber('OPTIONS_MAX_LEG_SKEW_MS', 3_000),
  maxCatalystReviewAgeMs: envNumber('OPTIONS_CATALYST_REVIEW_MAX_AGE_MS', 30 * 60_000),
  maxAssignmentReviewAgeMs: envNumber('OPTIONS_ASSIGNMENT_REVIEW_MAX_AGE_MS', 24 * 60 * 60_000),
  requireDividendProvider: dividendDataSource === 'alpaca',
  maxLegSpreadPct: envNumber('OPTIONS_MAX_LEG_SPREAD_PCT', 15),
  minOpenInterest: envNumber('OPTIONS_MIN_OPEN_INTEREST', 100),
  minVolume: envNumber('OPTIONS_MIN_VOLUME', 1),
  minDaysToExpiry: envNumber('OPTIONS_MIN_DTE', 1),
  maxDaysToExpiry: envNumber('OPTIONS_MAX_DTE', 45),
  forceExitBufferMinutes: envNumber('OPTIONS_FORCE_EXIT_BUFFER_MINUTES', 5),
  minRewardRisk: envNumber('OPTIONS_MIN_REWARD_RISK', 1.5),
  feePerContractRoundTrip: envNumber('OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP', NaN),
  slippageReservePerContract: envNumber('OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT', NaN),
};
const policy = {
  now, maxQuoteAgeMs: strategyConfig.maxQuoteAgeMs,
  maxOpenMarkAgeMs: envNumber('OPTIONS_MAX_OPEN_MARK_AGE_MS', 300_000),
  maxSpreadPct: envNumber('OPTIONS_MAX_COMBO_SPREAD_PCT', 25),
  maxTradeRiskPct: envNumber('OPTIONS_MAX_TRADE_RISK_PCT', 0.25),
  maxTotalOpenRiskPct: envNumber('OPTIONS_MAX_TOTAL_OPEN_RISK_PCT', 1),
  maxGrossExposurePct: envNumber('OPTIONS_MAX_GROSS_EXPOSURE_PCT', 100),
  maxDailyLossPct: envNumber('OPTIONS_MAX_DAILY_LOSS_PCT', 1),
  minRewardRisk: strategyConfig.minRewardRisk,
  emergencyStop,
  liveTradingEnabled: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true',
};

const decisionRefresher = createOptionDecisionRefresher({ source, token: env('TRADIER_TOKEN'),
  environment: env('TRADIER_ENV', 'sandbox').trim().toLowerCase(), config: strategyConfig, providerMetrics,
  primarySignalMaxAgeMs: Math.min(120000, envNumber('OPTIONS_PRIMARY_SIGNAL_MAX_AGE_MS', 120000)) });
const results = [];
const tradierEnvironment = env('TRADIER_ENV', 'sandbox').trim().toLowerCase();
const productionTradierData = source === 'tradier' && tradierEnvironment === 'production';
const forwardShadowObservations = signalRows.filter((row) => source === 'tradier'
  && productionTradierData && ['ready', 'no_verified_contract_quotes'].includes(row.marketDataStatus))
  .map((row) => ({ instrumentKey: String(row.signal?.underlyingSymbol ?? '').toUpperCase(), strategyInput: row }));
stageStartedAt = startStage();
for (let index = 0; index < signalRows.length; index++) {
  const row = await decisionRefresher.refresh(signalRows[index]);
  signalRows[index] = row;
  if (source === 'tradier' && row.marketDataStatus !== 'ready') {
    results.push({ symbol: row.signal?.underlyingSymbol ?? null, strategy: OPTIONS_DAY_STRATEGY_ID, status: row.marketDataStatus || 'provider-data-unavailable', providerStatus: row.marketDataStatus || 'provider-data-unavailable', reasons: [row.marketDataStatus || 'provider_data_unavailable'], providerError: row.providerError });
    continue;
  }
  const evaluatedAt = Date.now();
  const strategy = buildOptionDayTradeCandidate({ ...row, now: evaluatedAt, config: { ...strategyConfig, ...row.config, catalystSource } });
  if (strategy.status !== 'candidate') {
    results.push({ symbol: row.signal?.underlyingSymbol ?? null, strategy: strategy.strategy, status: strategy.status, providerStatus: source === 'tradier' ? row.marketDataStatus : undefined, reasons: strategy.reasons, diagnostics: strategy.diagnostics });
    continue;
  }
  const currentLedger = await readPaperRiskLedger({ statePath });
  now = Date.now();
  performance = summarizePaperLedger(currentLedger, { accountEquity, sessionDate, now });
  portfolio = { accountEquity, realizedPnlToday: performance.realizedPnlRiskDayUtcUsd,
    openPositions: currentLedger.orders.filter(order => ['reserved', 'filled', 'open'].includes(order.status)),
    closedOrders: currentLedger.orders.filter(order => order.status === 'closed') };
  const decision = evaluatePaperCandidate(strategy.candidate, portfolio, { ...policy, now });
  if (decision.status !== 'paper-approved') {
    results.push({ symbol: row.signal.underlyingSymbol, strategy: strategy.strategy, status: 'risk-blocked', providerStatus: source === 'tradier' ? row.marketDataStatus : undefined, candidate: strategy.candidate, decision });
    continue;
  }
  const reservation = await reservePaperCandidate(strategy.candidate, decision, { statePath, now: Date.now(), observationClock: Date.now, emergencyStop });
  results.push({ symbol: row.signal.underlyingSymbol, strategy: strategy.strategy, status: reservation.status, providerStatus: source === 'tradier' ? row.marketDataStatus : undefined, candidate: strategy.candidate, decision, reservation });
  if (reservation.status === 'reserved') portfolio.openPositions.push(reservation.order);
}
finishStage('strategyAndRisk', stageStartedAt);
stageStartedAt = startStage();
const forwardShadowProfiles = [
  { id: 'tighter-leg-spreads', overrides: { maxLegSpreadPct: 10 }, hypothesis: 'Tighter option legs improve net vertical expectancy after execution costs.', changeMade: 'Limit each leg spread to 10 percent.', reason: 'Measure fill quality without relaxing other liquidity gates.' },
  { id: 'higher-open-interest', overrides: { minOpenInterest: 250 }, hypothesis: 'Higher open interest improves realized spread execution.', changeMade: 'Require at least 250 open contracts per leg.', reason: 'Compare liquidity and fill rate after costs.' },
  { id: 'fresh-complete-greeks', overrides: { requireCompleteGreeks: true }, hypothesis: 'Complete fresh Greek observations identify better spread cohorts.', changeMade: 'Require complete Greeks in shadow research.', reason: 'Test incremental descriptive value without changing production approval.' },
];
const forwardShadowQuotes = new Map();
for (const observation of forwardShadowObservations) {
  const row = observation.strategyInput;
  for (const profile of forwardShadowProfiles) {
    const result = buildOptionDayTradeCandidate({ ...row, now: Date.now(), config: { ...strategyConfig, ...row.config, ...profile.overrides, catalystSource } });
    if (result.status === 'candidate') forwardShadowQuotes.set(result.candidate.instrumentKey.toUpperCase(), {
      bid: result.candidate.bid, ask: result.candidate.ask, time: result.candidate.quoteTime,
      quality: result.candidate.quoteQuality,
    });
  }
}
const forwardShadowResults = productionTradierData ? await runForwardShadowPaper({
  owner: 'options', strategyVersion: 'underlying-confirmed-debit-vertical-shadow-v6-entry-evidence', profiles: forwardShadowProfiles,
  allowlist: ['maxLegSpreadPct', 'minOpenInterest', 'requireCompleteGreeks'], baseConfig: strategyConfig,
  observations: forwardShadowObservations,
  evaluate: async (observation, config) => {
    const row = await decisionRefresher.refresh(observation.strategyInput);
    if (row.marketDataStatus !== 'ready') return { status: 'no-setup', reasons: [row.marketDataStatus] };
    return buildOptionDayTradeCandidate({ ...row, now: Date.now(), config: { ...strategyConfig, ...row.config, ...config, catalystSource } });
  },
  loadOpenOrderQuotes: async (profiles, at) => {
    const perProfile = new Map(profiles.map((profile) => [profile.profileId, new Map()]));
    const orders = profiles.flatMap((profile) => profile.orders);
    if (!orders.length) return perProfile;
    try {
      const marks = await fetchTradierOptionPositionMarks(orders, { token: env('TRADIER_TOKEN'), environment: tradierEnvironment, now: Date.now(),
        maxQuoteAgeMs: envNumber('OPTIONS_MAX_QUOTE_AGE_MS', 10_000), providerMetrics,
        maxLegSkewMs: envNumber('OPTIONS_MAX_LEG_SKEW_MS', 3_000),
        entryReviewOptions: signalSource === 'manual' && !process.env.OPTIONS_CATALYST_REVIEW_FILE
          ? { manualSessionFile: inputPath } : {} });
      const profileByOrder = new Map(profiles.flatMap((profile) => profile.orders.map((order) => [order.orderId, profile.profileId])));
      const orderById = new Map(orders.map((order) => [order.orderId, order]));
      for (const mark of marks.marks) {
        const profileId = profileByOrder.get(mark.orderId);
        const order = orderById.get(mark.orderId);
        if (profileId && order) perProfile.get(profileId).set(order.instrumentKey.toUpperCase(), mark.quote);
      }
    } catch { /* Provider failures are retained in providerMetrics; no stale quote is substituted. */ }
    return perProfile;
  },
  quotesByInstrument: forwardShadowQuotes,
  stateDirectory: env('OMNIMOD_FORWARD_SHADOW_STATE_DIR', `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`),
  portfolioStatePath: statePath, now: Date.now(), accountEquity,
  observationClock: Date.now,
riskPolicy: policy, maxQuoteAgeMs: policy.maxQuoteAgeMs, maxSpreadPct: policy.maxSpreadPct,
  sessionOpen: true, sessionDate,
}) : [];
finishStage('forwardShadow', stageStartedAt);
const researchHandoffRows = buildPaperResearchHandoffRows('options', results);
let journal = null, delivery = null, researchHandoff = null;
const makeScanDiagnostics = (underlyingDiscovery = null) => {
  const diagnostics = summarizeOptionsScan({ signalRows, results, providerMetrics, source, signalSource, signalMappingDiagnostics,
    underlyingDiscovery: underlyingDiscovery?.diagnostics ?? null,
    elapsedMs: Date.now() - scanStartedAt, stageDurationsMs });
  diagnostics.decisionQuotes = decisionRefresher.diagnostics;
  diagnostics.marketDataReadiness = assessMarketDataReadiness('options', {
    underlyingDiscovery: underlyingDiscovery?.diagnostics ?? null,
    observedRows: diagnostics.funnel.providerReady ?? 0, inputCount: signalRows.length,
    providerRequests: diagnostics.provider.requests, providerFailures: diagnostics.provider.failures });
  return diagnostics;
};
async function deliverResultBrief(scanDiagnostics, underlyingDiscovery = null, independentContracts = null, independentIntraday = null, independentOptionPaper = null) {
  journal = await appendPaperSnapshot('options', results, {
    strategy: 'primary-bot intraday direction -> defined-risk debit vertical, 50% premium stop, 2x premium target capped at spread width',
    forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
    source: source === 'tradier' ? `Tradier ${env('TRADIER_ENV', 'sandbox')}` : (input.source ?? 'unspecified-input'), paperOnly: true, performance, marketDataLatencyMs, providerMetrics, scanDiagnostics, positionMarkDiagnostics, optionExpiryDiagnostics, catalystSource, economicCalendarDiagnostics, companyNewsDiagnostics, dividendScreenDiagnostics,
    independentUnderlyingResearch: underlyingDiscovery,
    independentContractResearch: independentContracts,
    independentIntradayResearch: independentIntraday,
    independentOptionPaperResearch: independentOptionPaper,
  });
  delivery = await postDiscordMessage(buildDayTradingBrief({ bot: 'options', at: journal.capturedAt,
    readiness: scanDiagnostics.marketDataReadiness,
    source: source === 'tradier' ? `Tradier ${env('TRADIER_ENV', 'sandbox')}` : String(input.source ?? 'manual'),
    coverage: `${underlyingDiscovery ? describeOptionsDiscovery(underlyingDiscovery.diagnostics) : 'Independent discovery follows this alert; completed coverage is available in administrator scan statistics.'}\nProduction: ${formatDiagnosticCount(scanDiagnostics.funnel.primarySignals)} primary underlying signals · ${formatDiagnosticCount(scanDiagnostics.funnel.providerReady)} provider-ready · ${formatDiagnosticCount(scanDiagnostics.funnel.strategyCandidates)} strategy candidates · ${formatDiagnosticCount(scanDiagnostics.provider.failures)} provider failures.`,
    results, handoffRows: researchHandoffRows, emergencyStop,
    context: [independentIntraday ? describeUnderlyingResearch(independentIntraday.diagnostics) : 'Independent intraday research follows this alert.', independentOptionPaper ? describeIndependentOptionPaper(independentOptionPaper.diagnostics) : 'Independent option paper research follows this alert.', independentContracts ? describeOptionContracts(independentContracts.diagnostics) : 'Independent contract research follows this alert.', `Catalyst news: ${companyNewsDiagnostics.status} · dividend screen: ${dividendScreenDiagnostics.status}`, 'Defined-risk debit verticals only; fresh synchronized quotes, expiry, liquidity and risk checks remain required.'],
  }), { dedupeKey: JSON.stringify(results.map(row => [row.symbol, row.status, row.candidate?.idempotencyKey])) });
  researchHandoff = await publishDeliveredPaperResearch('options', researchHandoffRows, delivery, { now: Date.now() });
}
// Qualified setups/watches are persisted and delivered before optional market-wide research.
const preDeliveryLedger = await readPaperRiskLedger({ statePath });
now = Date.now();
updatePositionDiagnostics(preDeliveryLedger, now);
performance = summarizePaperLedger(preDeliveryLedger, { accountEquity, sessionDate, now });
if (results.some((row) => row.candidate)) await deliverResultBrief(makeScanDiagnostics());
// Research runs after position monitoring/approval, so it cannot age their input quotes.
stageStartedAt = startStage();
const underlyingDiscovery = await discoverOptionUnderlyings({ now: Date.now(), observationClock: Date.now, providerMetrics });
finishStage('independentUnderlyingDiscovery', stageStartedAt);
stageStartedAt = startStage();
// Refresh shared context independently of production's manual/shared selector. Research does not append to signalRows.
let independentPrimaryContext = { rows: [], diagnostics: { status: 'not_checked' } };
if (underlyingDiscovery.shortlist.length) {
  try {
    const contextRead = await readPrimaryResearchSignalsWithDiagnostics({ now: Date.now(), maxAgeMs: 120000, owners: ['stocks', 'etfs-etps'] });
    independentPrimaryContext = resolveOptionSignalsFromShared(contextRead.records, { reviews: [] });
    independentPrimaryContext.diagnostics.sourceRead = contextRead.diagnostics;
  } catch { independentPrimaryContext.diagnostics.status = 'context_unavailable'; }
}
const independentIntraday = await analyzeOptionUnderlyings({ underlyingDiscovery, now: Date.now(), observationClock: Date.now, providerMetrics,
  signalRows: independentPrimaryContext.rows, signalMappingDiagnostics: independentPrimaryContext.diagnostics });
underlyingDiscovery.diagnostics.intradayResearch = independentIntraday.diagnostics;
finishStage('independentIntradayResearch', stageStartedAt);
stageStartedAt = startStage();
let independentReviews = { reviews: [], assignmentReviews: [] };
let independentReviewStatus = 'not_needed';
if (independentIntraday.diagnostics.technicalWatches > 0) {
  try {
    independentReviews = JSON.parse(await readFile(resolve(env('OPTIONS_CATALYST_REVIEW_FILE', 'examples/catalyst-reviews.json')), 'utf8'));
    independentReviewStatus = 'read';
  } catch { independentReviewStatus = 'unavailable'; }
}
const independentOptionPaperFull = await runIndependentOptionPaper({ intradayResearch: independentIntraday, reviews: independentReviews,
  strategyConfig, riskPolicy: policy, accountEquity, portfolioStatePath: statePath,
  stateDirectory: env('OMNIMOD_FORWARD_SHADOW_STATE_DIR', `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`),
  now: Date.now(), observationClock: Date.now, providerMetrics });
// Large input chains stay in the durable research journal, not every Discord/operational payload.
const independentOptionPaper = { diagnostics: { ...independentOptionPaperFull.diagnostics, reviewFileStatus: independentReviewStatus },
  forward: independentOptionPaperFull.forward.map((track) => ({ id: track.id, experimentHash: track.experimentHash,
    strategyVersion: track.strategyVersion, manifest: track.manifest, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })) };
forwardShadowResults.push(...independentOptionPaperFull.forward);
underlyingDiscovery.diagnostics.optionPaperResearch = independentOptionPaper.diagnostics;
finishStage('independentOptionPaperResearch', stageStartedAt);
stageStartedAt = startStage();
const independentContracts = await discoverOptionContracts({ underlyingDiscovery, now: Date.now(), providerMetrics });
underlyingDiscovery.diagnostics.contractDiscovery = independentContracts.diagnostics;
underlyingDiscovery.diagnostics.downstreamStatus = independentContracts.diagnostics.downstreamStatus;
finishStage('independentContractDiscovery', stageStartedAt);
const finalLedger = await readPaperRiskLedger({ statePath });
now = Date.now();
updatePositionDiagnostics(finalLedger, now);
performance = summarizePaperLedger(finalLedger, { accountEquity, sessionDate, now });
const scanDiagnostics = makeScanDiagnostics(underlyingDiscovery);
await appendScanDiagnostic('options', { ...scanDiagnostics, positionMarkDiagnostics,
  optionExpiryDiagnostics,
  dividendScreen: dividendScreenDiagnostics,
  forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, mode: track.mode, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
  safety: { emergencyStopActive: emergencyStop, liveTradingEnabled: false,
    liveTradingRequested: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true', orderRoutingAvailable: false,
    observedAt: new Date().toISOString() } }).catch((error) => console.error('Unable to persist Options scan diagnostics:', error.message));

if (!journal) await deliverResultBrief(scanDiagnostics, underlyingDiscovery, independentContracts, independentIntraday, independentOptionPaper);
console.log(JSON.stringify({
  bot: 'options', mode: 'paper only; no broker or exchange orders', source: source === 'tradier' ? `Tradier ${env('TRADIER_ENV', 'sandbox')}` : (input.source ?? null), sessionDate,
  counts: { inputs: signalRows.length, candidates: results.filter((row) => ['reserved', 'duplicate', 'exposure-conflict'].includes(row.status)).length, riskBlocked: results.filter((row) => row.status === 'risk-blocked').length, noSetup: results.filter((row) => row.status === 'no-setup').length, providerRejected: results.filter((row) => row.providerStatus && row.providerStatus !== 'ready').length },
  scanDiagnostics,
  independentUnderlyingResearch: underlyingDiscovery,
  independentContractResearch: independentContracts,
  independentIntradayResearch: independentIntraday,
  independentOptionPaperResearch: independentOptionPaper,
  economicCalendarDiagnostics, companyNewsDiagnostics, dividendScreenDiagnostics,
  provider: { name: source === 'tradier' ? 'Tradier' : 'manual input', environment: source === 'tradier' ? env('TRADIER_ENV', 'sandbox') : null, requestLatencyMs: marketDataLatencyMs, requests: Math.max(0, ...signalRows.map((row) => Number(row.providerRequests) || 0)) },
  markResults, positionMarkDiagnostics, optionExpiryDiagnostics, results, forwardShadow: forwardShadowResults, performance, paperJournal: journal, researchHandoff, discordDelivery: delivery,
  limitations: ['Tradier sandbox quotes are delayed and are rejected for paper entries; production read-only data requires a market-data entitled account. No order endpoint is used.', 'Shared-signal mode consumes fresh delivered Stocks and ETF/ETP paper signals only; conflicting directions for one underlying are withheld before option-chain requests. Catalyst review is manual by default; Finnhub screens scheduled US macro releases, while optional Alpaca mode checks recent company headlines only to invalidate an older review. Headline sentiment is not scored and missing/incomplete news coverage blocks entries. Tradier market clock verifies regular-session state and close.', 'Quote-driven fills are paper simulations; the premium stop/target does not model intraday IV/Greeks or calibrated fills. Exercise/assignment/expiration lifecycle and out-of-sample strategy validation remain unfinished.'],
  signalMappingDiagnostics,
}, null, 2));
