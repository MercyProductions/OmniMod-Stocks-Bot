import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance as highResolutionClock } from 'node:perf_hooks';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordMessage } from '../../shared/discordWebhook.js';
import { buildDayTradingBrief } from '../../shared/discordPresentation.js';
import { assessMarketDataReadiness } from '../../shared/marketDataReadiness.js';
import { processPaperQuote, readPaperRiskLedger, recoverPaperOrders, summarizePaperLedger } from '../../shared/paperRisk.js';
import { evaluateOpeningRangeBreakout } from './strategies.js';
import { evaluateEtfEntries } from './entryWorkflow.js';
import { formatEtfCount, formatEtfDiscoverySummary } from './alertFormat.js';
import { fetchAlpacaEtfPositionMarks, fetchAlpacaEtfSession, parseEtfSymbols } from './alpacaMarketData.js';
import { resolveEtfExposureKey } from './exposure.js';
import { readPrimaryResearchSignalsWithDiagnostics } from '../../shared/signalResearch.js';
import { buildPaperResearchHandoffRows, publishDeliveredPaperResearch } from '../../shared/paperSignalHandoff.js';
import { attachPrimarySignalContext } from './sharedSignals.js';
import { summarizeEtfScan } from './diagnostics.js';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';
import { summarizePositionMarkCoverage } from '../../shared/positionMarkDiagnostics.js';
import { fetchFinnhubEconomicCalendar } from '../../shared/finnhubEconomicCalendar.js';
import { getPaperLedgerWorkspaceRoot, resolvePaperLedgerPath } from '../../shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../shared/forwardShadowPaper.js';
import { marketDateAt } from '../../shared/marketDate.js';

const env = (key, fallback = '') => process.env[key] == null || process.env[key].trim() === '' ? fallback : process.env[key];
const envNumber = (key, fallback) => {
  const value = Number(env(key, fallback));
  return Number.isFinite(value) ? value : NaN;
};
const sourceMode = env('ETF_SOURCE', 'fixture').toLowerCase();
let now = Date.now();
const stageDurationsMs = {};
const startStage = () => highResolutionClock.now();
const finishStage = (name, startedAt) => { stageDurationsMs[name] = Number(Math.max(0, highResolutionClock.now() - startedAt).toFixed(2)); };
const statePath = resolvePaperLedgerPath(env('TRADING_RISK_STATE_PATH', ''));
const emergencyStop = env('OMNIMOD_EMERGENCY_STOP', 'true') !== 'false';
const restartRecovery = await recoverPaperOrders({ owner: 'etfs-etps', statePath, now, emergencyStop });
const inputPath = resolve(process.cwd(), env('ETF_SESSION_FILE', 'examples/paper-session.json'));
const scanStartedAt = Date.now();
let stageStartedAt = startStage();
const providerMetrics = [];
let catalystReviews = {};
if (sourceMode === 'alpaca') {
  const reviewPath = resolve(process.cwd(), env('ETF_CATALYST_REVIEW_FILE', 'examples/catalyst-reviews.json'));
  try { catalystReviews = JSON.parse(await readFile(reviewPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!catalystReviews || typeof catalystReviews !== 'object' || Array.isArray(catalystReviews)) throw new Error('ETF catalyst review file must contain an object keyed by ticker.');
}
let sessionInput;
if (sourceMode === 'alpaca') {
  try {
    sessionInput = await fetchAlpacaEtfSession({ catalystReviews, providerMetrics, observationClock: Date.now });
  } catch (error) {
    if (!error.providerOperation) throw error;
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    sessionInput = { source: 'Alpaca provider error', trades: [], marks: [], providerMetrics,
      diagnostics: { universeSize: env('ETF_DISCOVERY_MODE', 'full-market') === 'baseline' ? parseEtfSymbols(env('ETF_SYMBOLS')).length : null,
        providerError: message, failedProviderOperation: error.providerOperation, stage: 'market-data-fetch-failed' } };
  }
} else if (sourceMode === 'fixture') {
  sessionInput = JSON.parse(await readFile(inputPath, 'utf8'));
} else {
  throw new Error('ETF_SOURCE must be fixture or alpaca.');
}
if (!Array.isArray(sessionInput.trades)) throw new Error('ETF session file must contain a trades array.');
finishStage('universeAndMarketData', stageStartedAt);
now = Date.now();
stageStartedAt = startStage();
const catalystSource = env('ETF_CATALYST_SOURCE', 'manual').toLowerCase();
if (!['manual', 'finnhub'].includes(catalystSource)) throw new Error('ETF_CATALYST_SOURCE must be manual or finnhub.');
let economicCalendarDiagnostics = { status: catalystSource === 'manual' ? 'manual-review' : 'not_started', source: catalystSource };
if (catalystSource === 'finnhub' && sessionInput.trades.length) {
  const symbols = [...new Set(sessionInput.trades.map((row) => String(row.symbol ?? '').trim().toUpperCase()).filter(Boolean))];
  const targetCountryMap = Object.fromEntries(symbols.map((symbol) => [symbol, ['US']]));
  const calendarDate = sessionInput.sessionDate ?? sessionInput.trades[0]?.session?.marketDate ?? marketDateAt(now, 'America/New_York');
  try {
    const calendar = await fetchFinnhubEconomicCalendar({ token: env('FINNHUB_API_KEY'), marketDate: calendarDate,
      instruments: symbols, countryCodesByInstrument: targetCountryMap, now, metrics: providerMetrics });
    sessionInput.trades = sessionInput.trades.map((row) => {
      const review = calendar.reviews[String(row.symbol ?? '').toUpperCase()];
      return { ...row, session: { ...row.session, catalystBlocked: row.session?.catalystBlocked === true || review?.status !== 'clear',
        macroEventReview: review } };
    });
    economicCalendarDiagnostics = { ...calendar.diagnostics, source: catalystSource };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    sessionInput.trades = sessionInput.trades.map((row) => ({ ...row,
      session: { ...row.session, catalystBlocked: true, macroEventReview: { status: 'blocked', source: 'Finnhub Economic Calendar',
        summary: 'Economic calendar unavailable; scheduled-event clearance is blocked.', reviewedAt: new Date(now).toISOString() } } }));
    economicCalendarDiagnostics = { status: 'provider_error', source: catalystSource, providerError: message };
  }
} else if (catalystSource === 'finnhub') {
  economicCalendarDiagnostics = { status: 'no_trades', source: catalystSource };
}
finishStage('catalystReview', stageStartedAt);
stageStartedAt = startStage();
const markLedgerBefore = await readPaperRiskLedger({ statePath });
let positionMarkDiagnostics = { status: 'fixture_marks_only' };
if (sourceMode === 'alpaca') {
  try {
    const marked = await fetchAlpacaEtfPositionMarks(markLedgerBefore.orders, { providerMetrics, now: new Date() });
    positionMarkDiagnostics = marked.diagnostics;
    const manualOrderIds = new Set((sessionInput.marks ?? []).map((mark) => mark.orderId));
    sessionInput.marks = [...(sessionInput.marks ?? []), ...marked.marks.filter((mark) => !manualOrderIds.has(mark.orderId))];
  } catch (error) {
    if (!error.providerOperation) throw error;
    positionMarkDiagnostics = { status: 'provider_error', providerError: String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180), failedProviderOperation: error.providerOperation };
  }
}
finishStage('positionMarking', stageStartedAt);
stageStartedAt = startStage();
const rawTrades = sessionInput.trades.map((row) => ({ ...row, exposureKey: resolveEtfExposureKey(row.symbol, row.exposureKey) }));
let primarySignals = [];
let primarySignalReadError = null;
let primarySignalReadDiagnostics = { status: 'not_started' };
try {
  const sourceRead = await readPrimaryResearchSignalsWithDiagnostics({
    maxAgeMs: envNumber('ETF_PRIMARY_SIGNAL_MAX_AGE_MS', 5 * 60_000),
    owners: ['stocks', 'crypto', 'forex', 'futures', 'options'],
  });
  primarySignals = sourceRead.records;
  primarySignalReadDiagnostics = sourceRead.diagnostics;
} catch (error) {
  primarySignalReadError = String(error.message || error).slice(0, 180);
  primarySignalReadDiagnostics = { status: 'read_error' };
}
const trades = attachPrimarySignalContext(rawTrades, primarySignals, { resolveExposureKey: resolveEtfExposureKey });
finishStage('sharedResearchContext', stageStartedAt);
const markResults = [];
now = Date.now();
markResults.push({ type: 'restart_recovery', ...restartRecovery });
const availablePositionMarks = sessionInput.marks ?? [];
const positionMarkAttempts = [];
for (const mark of availablePositionMarks) {
  const result = await processPaperQuote(mark.orderId, mark.quote, { expectedOwner: 'etfs-etps',
    statePath, now: Date.now(), observationClock: Date.now, maxQuoteAgeMs: envNumber('ETF_MAX_QUOTE_AGE_MS', 15_000),
    maxSpreadPct: envNumber('ETF_MAX_SPREAD_PCT', 0.5), sessionOpen: mark.sessionOpen === true, emergencyStop,
  });
  markResults.push({ orderId: mark.orderId, ...result });
  positionMarkAttempts.push({ orderId: mark.orderId, ...result });
}
const markLedgerAfter = await readPaperRiskLedger({ statePath });
positionMarkDiagnostics = { ...positionMarkDiagnostics,
  ...summarizePositionMarkCoverage({ owner: 'etfs-etps', beforeOrders: markLedgerBefore.orders, afterOrders: markLedgerAfter.orders,
    availableMarks: availablePositionMarks, attempts: positionMarkAttempts, now,
    maxAgeMs: envNumber('ETF_MAX_OPEN_MARK_AGE_MS', 300_000) }),
};
const ledger = await readPaperRiskLedger({ statePath });
const activeOrders = ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
const sessionDate = sessionInput.sessionDate ?? trades[0]?.session?.marketDate ?? sessionInput.marks?.[0]?.sessionDate ?? marketDateAt(now, 'America/New_York');
const accountEquity = envNumber('PAPER_ACCOUNT_EQUITY_USD', 0);
let performance = summarizePaperLedger(ledger, { accountEquity, sessionDate, now });
const portfolio = {
  accountEquity,
  realizedPnlToday: performance.realizedPnlRiskDayUtcUsd,
  openPositions: activeOrders,
  closedOrders: ledger.orders.filter((order) => order.status === 'closed'),
};
const strategyConfig = {
  maxQuoteAgeMs: envNumber('ETF_MAX_QUOTE_AGE_MS', 15_000),
  roundTripFeesPerUnit: envNumber('ETF_ROUND_TRIP_FEES_PER_UNIT', NaN),
  slippageReservePerUnit: envNumber('ETF_SLIPPAGE_RESERVE_PER_UNIT', NaN),
};
now = Date.now();
const policy = {
  now,
  maxQuoteAgeMs: strategyConfig.maxQuoteAgeMs,
  maxOpenMarkAgeMs: envNumber('ETF_MAX_OPEN_MARK_AGE_MS', 300_000),
  maxSpreadPct: envNumber('ETF_MAX_SPREAD_PCT', 0.5),
  maxTradeRiskPct: envNumber('ETF_MAX_TRADE_RISK_PCT', 0.25),
  maxTotalOpenRiskPct: envNumber('ETF_MAX_TOTAL_OPEN_RISK_PCT', 1),
  maxGrossExposurePct: envNumber('ETF_MAX_GROSS_EXPOSURE_PCT', 200),
  maxDailyLossPct: envNumber('ETF_MAX_DAILY_LOSS_PCT', 1),
  minRewardRisk: envNumber('ETF_MIN_REWARD_RISK', 1.5),
  emergencyStop,
  liveTradingEnabled: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true',
};

stageStartedAt = startStage();
const entryWorkflow = await evaluateEtfEntries(trades, { sourceMode, portfolio, policy, strategyConfig, statePath, providerMetrics });
const { results, observations: forwardShadowObservations } = entryWorkflow;
now = Date.now();
finishStage('strategyAndRisk', stageStartedAt);
stageStartedAt = startStage();
const forwardShadowProfiles = [
  { id: 'higher-volume', overrides: { minRelativeVolume: 2 }, hypothesis: 'Stronger relative volume improves costed ETP breakout expectancy.', changeMade: 'Require relative volume of 2.', reason: 'Measure participation quality across wrapper types.' },
  { id: 'longer-range', overrides: { rangeBars: 4 }, hypothesis: 'A longer opening range reduces false ETP breaks.', changeMade: 'Use four completed five-minute opening bars.', reason: 'Compare confirmation with delayed entry and fewer fills.' },
  { id: 'larger-breakout-buffer', overrides: { breakoutBufferAtr: 0.1 }, hypothesis: 'A larger ATR buffer improves breakout quality after costs.', changeMade: 'Use a 0.10 ATR breakout buffer.', reason: 'Test false-break filtering while retaining wrapper risk gates.' },
];
const forwardShadowResults = sourceMode === 'alpaca' ? await runForwardShadowPaper({
  owner: 'etfs-etps', strategyVersion: sessionInput.diagnostics?.discovery?.mode === 'full-market-directory'
    ? 'etp-opening-range-breakout-shadow-v6-decision-quotes' : 'etp-opening-range-breakout-shadow-v4-decision-quotes', profiles: forwardShadowProfiles,
  allowlist: ['rangeBars', 'minRelativeVolume', 'breakoutBufferAtr'],
  baseConfig: strategyConfig, observations: forwardShadowObservations,
  evaluate: (observation, config, at) => evaluateOpeningRangeBreakout({ ...observation.strategyInput, now: at,
    config: { ...strategyConfig, ...observation.strategyInput.config, ...config, requireCatalystReview: true,
      maxCatalystReviewAgeMs: envNumber('ETF_MAX_CATALYST_REVIEW_AGE_MS', 30 * 60_000) } }),
  quotesByInstrument: new Map(forwardShadowObservations.map((row) => [row.instrumentKey, row.strategyInput.quote]).filter((row) => row[1])),
  loadOpenOrderQuotes: async (profiles, at) => {
    const perProfile = new Map(profiles.map((profile) => [profile.profileId, new Map()]));
    const orders = profiles.flatMap((profile) => profile.orders);
    if (!orders.length) return perProfile;
    try {
      const marked = await fetchAlpacaEtfPositionMarks(orders, { providerMetrics, now: new Date(at) });
      const profileByOrder = new Map(profiles.flatMap((profile) => profile.orders.map((order) => [order.orderId, profile.profileId])));
      const orderById = new Map(orders.map((order) => [order.orderId, order]));
      for (const mark of marked.marks) {
        const profileId = profileByOrder.get(mark.orderId), order = orderById.get(mark.orderId);
        if (profileId && order) perProfile.get(profileId).set(order.instrumentKey.toUpperCase(), mark.quote);
      }
    } catch { /* Provider failures are retained in providerMetrics; no stale quote is substituted. */ }
    return perProfile;
  },
  stateDirectory: env('OMNIMOD_FORWARD_SHADOW_STATE_DIR', `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`), portfolioStatePath: statePath, now, observationClock: Date.now, accountEquity,
riskPolicy: policy, maxQuoteAgeMs: policy.maxQuoteAgeMs, maxSpreadPct: policy.maxSpreadPct,
  sessionOpen: sourceMode === 'alpaca' && sessionInput.trades.length > 0, sessionDate,
}) : [];
finishStage('forwardShadow', stageStartedAt);
now = Date.now();
performance = summarizePaperLedger(await readPaperRiskLedger({ statePath }), { accountEquity, sessionDate, now });
const scanDiagnostics = summarizeEtfScan({ sessionInput, trades, results, providerMetrics, elapsedMs: Date.now() - scanStartedAt, stageDurationsMs });
scanDiagnostics.decisionQuotes = entryWorkflow.diagnostics;
scanDiagnostics.marketDataReadiness = assessMarketDataReadiness('etfs-etps', {
  observedRows: Math.max(scanDiagnostics.universe.withUsableMarketData || 0, scanDiagnostics.universe.discovery?.cheapScreen?.cheaplyScreened || 0), providerRequests: scanDiagnostics.provider.requests,
  providerFailures: scanDiagnostics.provider.failures, marketOpen: sessionInput.diagnostics?.marketOpen ?? null });
await appendScanDiagnostic('etfs-etps', { ...scanDiagnostics, positionMarkDiagnostics,
  forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, mode: track.mode, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
  safety: { emergencyStopActive: emergencyStop, liveTradingEnabled: false,
    liveTradingRequested: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true', orderRoutingAvailable: false,
    observedAt: new Date().toISOString() } }).catch((error) => console.error('Unable to persist ETF/ETP scan diagnostics:', error.message));

const journal = await appendPaperSnapshot('etfs-etps', results, {
  strategy: 'ETF/ETP 15-minute opening-range breakout with VWAP and relative-volume confirmation',
  source: sessionInput.source ?? 'unspecified-input', paperOnly: true, performance,
  scanDiagnostics, positionMarkDiagnostics, catalystSource, economicCalendarDiagnostics,
  forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
  primaryResearchContext: { loaded: primarySignals.length, matched: trades.reduce((sum, row) => sum + row.primaryResearch.length, 0), maxAgeMs: envNumber('ETF_PRIMARY_SIGNAL_MAX_AGE_MS', 5 * 60_000), readError: primarySignalReadError, sourceRead: primarySignalReadDiagnostics },
});
const researchHandoffRows = buildPaperResearchHandoffRows('etfs-etps', results);
const delivery = await postDiscordMessage(buildDayTradingBrief({ bot: 'etfs-etps', at: journal.capturedAt, source: sessionInput.source ?? 'unspecified',
  readiness: scanDiagnostics.marketDataReadiness,
  coverage: `${formatEtfDiscoverySummary(scanDiagnostics.universe.discovery) || 'Configured universe'}\n${formatEtfCount(scanDiagnostics.universe.providerScanned)} detailed requests · ${formatEtfCount(scanDiagnostics.universe.withUsableMarketData)} usable strategy inputs · ${formatEtfCount(scanDiagnostics.provider.failures)} provider failures`,
  results, handoffRows: researchHandoffRows, emergencyStop,
  context: [`Catalyst calendar: ${economicCalendarDiagnostics.status}`, 'Opening-range breakout with VWAP and relative-volume confirmation. Leveraged/inverse products carry daily-reset risk; ETNs issuer risk; commodity pools roll risk. Classification and normal risk gates remain required.'],
}), { dedupeKey: JSON.stringify(results.map(row => [row.symbol, row.status, row.reservation?.order?.idempotencyKey])) });
const researchHandoff = await publishDeliveredPaperResearch('etfs-etps', researchHandoffRows, delivery, { now });
console.log(JSON.stringify({
  bot: 'etfs-etps', mode: 'paper only; no broker or exchange orders', source: sessionInput.source ?? null, sessionDate,
  diagnostics: sessionInput.diagnostics ?? null, scanDiagnostics, providerMetrics, economicCalendarDiagnostics,
  primaryResearchContext: { loaded: primarySignals.length, matched: trades.reduce((sum, row) => sum + row.primaryResearch.length, 0), maxAgeMs: envNumber('ETF_PRIMARY_SIGNAL_MAX_AGE_MS', 5 * 60_000), readError: primarySignalReadError, sourceRead: primarySignalReadDiagnostics },
  counts: { inputs: trades.length, candidates: results.filter((row) => ['reserved', 'duplicate', 'exposure-conflict'].includes(row.status)).length, riskBlocked: results.filter((row) => row.status === 'risk-blocked').length, noSetup: results.filter((row) => row.status === 'no-setup').length },
  markResults, results, performance, paperJournal: journal, researchHandoff, discordDelivery: delivery,
  positionMarkDiagnostics, forwardShadow: forwardShadowResults,
  limitations: [sourceMode === 'fixture' ? 'Fixture input mode has no live provider connection.' : 'Configured Alpaca feed/universe coverage and account entitlement have not been independently verified.', 'Quote-driven fills are paper simulations, not calibrated market-impact/fill estimates.', 'Strategy expectancy has not been validated on point-in-time out-of-sample data.', 'Classified paper candidates disclose daily-reset/path risk for leveraged/inverse wrappers, issuer-credit risk for ETNs, and futures-roll risk for commodity pools; these risks are not quantitatively modeled, source contents are not independently fetched, and distribution/corporate-action risks remain unmodeled.'],
}, null, 2));
