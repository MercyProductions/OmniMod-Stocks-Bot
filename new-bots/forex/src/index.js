import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordMessage } from '../../shared/discordWebhook.js';
import { buildDayTradingBrief } from '../../shared/discordPresentation.js';
import { assessMarketDataReadiness } from '../../shared/marketDataReadiness.js';
import { frameWatch } from './scenarios.js';
import { requestForexJson } from './providerRequest.js';
import { fetchFinnhubEconomicCalendar } from './economicCalendar.js';
import { summarizeForexScan } from './diagnostics.js';
import { getForexMarketSession } from './marketSession.js';
import { refreshForexDecisionQuotes, summarizeDecisionQuotes } from './decisionQuotes.js';
import { evaluateForexDayBreakout } from './dayStrategy.js';
import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger } from '../../shared/paperRisk.js';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';
import { summarizePositionMarkCoverage } from '../../shared/positionMarkDiagnostics.js';
import { getPaperLedgerWorkspaceRoot, resolvePaperLedgerPath } from '../../shared/paperStatePath.js';
import { runForwardShadowPaper } from '../../shared/forwardShadowPaper.js';
import { readPrimaryResearchSignalsWithDiagnostics } from '../../shared/signalResearch.js';
import { buildPaperResearchHandoffRows, publishDeliveredPaperResearch } from '../../shared/paperSignalHandoff.js';
import { mapForexPrimaryResearch, parseForexPrimarySignalMap } from './sharedSignals.js';
import { assessForexQuoteTime, isOandaPriceTradeable, readOandaPriceLevel } from './quoteQuality.js';
import { formatDiagnosticCount } from '../../shared/formatDiagnosticCount.js';
import { performance as highResolutionClock } from 'node:perf_hooks';
import { discoverOandaFxUniverse } from './oandaUniverse.js';
import { loadOandaDirectory, saveOandaDirectory, oandaDirectoryCachePath } from './oandaDirectoryCache.js';
import { loadForexPositionQuotes, toExecutableForexQuote } from './positionQuotes.js';

const env = (key, fallback = '') => process.env[key] == null || process.env[key].trim() === '' ? fallback : process.env[key];
const envNumber = (key, fallback) => {
  const value = Number(env(key, fallback));
  return Number.isFinite(value) ? value : NaN;
};
const source = env('FOREX_SOURCE', 'disabled').toLowerCase();
const practice = env('OANDA_ENV', 'practice').toLowerCase();
const account = env('OANDA_ACCOUNT_ID');
const token = env('OANDA_API_TOKEN');
if (!['disabled', 'oanda-practice'].includes(source)) throw new Error(`Unsupported FOREX_SOURCE: ${source}; automated Yahoo Chart access is disabled.`);
if (source === 'oanda-practice' && practice !== 'practice') throw new Error('This research bot supports OANDA practice endpoints only.');
if (source === 'oanda-practice' && (!account || !token)) throw new Error('Set OANDA_ACCOUNT_ID and OANDA_API_TOKEN in a local .env file.');
const base = 'https://api-fxpractice.oanda.com';
const configuredInstruments = [...new Set(env('FOREX_INSTRUMENTS', 'EUR_USD,GBP_USD').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))];
let instruments = configuredInstruments;
const dynamicDiscoveryEnabled = env('FOREX_DYNAMIC_DISCOVERY', 'true') !== 'false';
const maxScanInstruments = envNumber('FOREX_MAX_SCAN_INSTRUMENTS', 20);
if (!Number.isSafeInteger(maxScanInstruments) || maxScanInstruments < 1 || maxScanInstruments > 100) throw new Error('FOREX_MAX_SCAN_INSTRUMENTS must be an integer from 1 to 100.');
const granularities = [...new Set(env('FOREX_GRANULARITIES', 'M15,H1,H4,D').split(',').map((x) => x.trim()).filter(Boolean))];
const maxQuoteAgeSeconds = Math.max(15, Math.min(120, Number(env('MAX_QUOTE_AGE_SECONDS', 120)) || 120));
const targetAtrMultiple = Math.max(1, Math.min(4, Number(env('FOREX_TARGET_ATR_MULTIPLE', 1.5)) || 1.5));
const earlyClosesEt = JSON.parse(env('FOREX_EARLY_CLOSES_ET_JSON', '{}'));
const marketCalendar = { closedSessionDates: env('FOREX_CLOSED_SESSION_DATES').split(',').map((x) => x.trim()).filter(Boolean), earlyClosesEt };
const statePath = resolvePaperLedgerPath(env('TRADING_RISK_STATE_PATH', ''));
const emergencyStop = env('OMNIMOD_EMERGENCY_STOP', 'true') !== 'false';
const restartRecovery = await recoverPaperOrders({ owner: 'forex', statePath, now: Date.now(), emergencyStop });
const accountEquity = envNumber('PAPER_ACCOUNT_EQUITY_USD', 0);
const riskPolicy = {
  now: Date.now(), maxQuoteAgeMs: maxQuoteAgeSeconds * 1000,
  maxOpenMarkAgeMs: envNumber('FOREX_MAX_OPEN_MARK_AGE_MS', 300_000),
  maxSpreadPct: envNumber('FOREX_MAX_SPREAD_PCT', 0.03),
  maxTradeRiskPct: envNumber('FOREX_MAX_TRADE_RISK_PCT', 0.25),
  maxTotalOpenRiskPct: envNumber('FOREX_MAX_TOTAL_OPEN_RISK_PCT', 1),
  maxGrossExposurePct: envNumber('FOREX_MAX_GROSS_EXPOSURE_PCT', 200),
  maxDailyLossPct: envNumber('FOREX_MAX_DAILY_LOSS_PCT', 1),
  minRewardRisk: envNumber('FOREX_MIN_REWARD_RISK', 1.5), emergencyStop,
  liveTradingEnabled: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true',
};
const strategyConfig = {
  quoteToUsd: NaN,
  roundTripFeesPerUnit: envNumber('FOREX_ROUND_TRIP_FEES_PER_UNIT', NaN),
  slippageReservePerUnit: envNumber('FOREX_SLIPPAGE_RESERVE_PER_UNIT', NaN),
  maxQuoteAgeMs: maxQuoteAgeSeconds * 1000, marketCalendar,
};
const manualCatalystReview = {
  status: env('FOREX_CATALYST_CLEAR', 'false') === 'true' ? 'clear' : 'blocked',
  source: env('FOREX_CATALYST_REVIEW_SOURCE'),
  summary: env('FOREX_CATALYST_REVIEW_SUMMARY'),
  reviewedAt: env('FOREX_CATALYST_REVIEWED_AT'),
};

const scanStartedAt = Date.now();
const stageDurationsMs = {};
const startStage = () => highResolutionClock.now();
const finishStage = (name, startedAt) => { stageDurationsMs[name] = Number(Math.max(0, highResolutionClock.now() - startedAt).toFixed(2)); };

const providerMetrics = [];
async function get(path, operation, instrument = null, relatedInstrument = null, instruments = [], requestOptions = {}) {
  return requestForexJson(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` }, metrics: providerMetrics, operation, instrument, relatedInstrument, instruments, timeoutMs: 12_000, ...requestOptions,
  });
}
let universeDiscovery = { status: 'disabled', diagnostics: null, quoteRows: {} };
if (source === 'oanda-practice' && dynamicDiscoveryEnabled) {
  const discoveryStartedAt = startStage();
  try {
    const directoryPath = oandaDirectoryCachePath({ account });
    const directory = await loadOandaDirectory({ path: directoryPath, now: Date.now(),
      ttlMs: envNumber('FOREX_DIRECTORY_REFRESH_MS', 3_600_000),
      fetchInstruments: () => get(`/v3/accounts/${encodeURIComponent(account)}/instruments`, 'instrument-universe') });
    universeDiscovery = { status: 'complete', ...(await discoverOandaFxUniverse({ configuredInstruments, maxInstruments: maxScanInstruments,
      now: Date.now(), clock: Date.now, maxQuoteAgeMs: maxQuoteAgeSeconds * 1000,
      maxSpreadPct: riskPolicy.maxSpreadPct, previousQuotes: directory.previousQuotes,
      fetchInstruments: async () => directory.payload,
      fetchPrices: (pairs) => get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent(pairs.join(','))}`,
        'universe-pricing', null, null, pairs),
    })) };
    instruments = universeDiscovery.instruments;
    universeDiscovery.quoteRows = universeDiscovery.quoteRows || {};
    universeDiscovery.directory = directory.diagnostics;
    await saveOandaDirectory({ path: directoryPath, state: directory.state, quoteRows: universeDiscovery.quoteRows });
  } catch (error) {
    universeDiscovery = { status: 'provider_error', diagnostics: { error: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180),
      configuredInstruments: configuredInstruments.length, configuredFallbackCount: 0 }, quoteRows: {} };
    instruments = [];
  }
  finishStage('universeDiscovery', discoveryStartedAt);
} else stageDurationsMs.universeDiscovery = 0;
function ema(values, period) {
  if (values.length < period) return NaN;
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  const k = 2 / (period + 1);
  for (const x of values.slice(period)) value = x * k + value * (1 - k);
  return value;
}
function atr(candles, period = 14) {
  const rows = candles.slice(-period - 1);
  const ranges = rows.slice(1).map((c, i) => Math.max(Number(c.mid.h) - Number(c.mid.l), Math.abs(Number(c.mid.h) - Number(rows[i].mid.c)), Math.abs(Number(c.mid.l) - Number(rows[i].mid.c))));
  return ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : NaN;
}

const now = Date.now();
const marketSession = getForexMarketSession(now, marketCalendar);
const sessionDate = marketSession.marketDate;
const configuredPrimarySignalMaxAgeMs = envNumber('FOREX_PRIMARY_SIGNAL_MAX_AGE_MS', 5 * 60_000);
if (!Number.isFinite(configuredPrimarySignalMaxAgeMs) || configuredPrimarySignalMaxAgeMs <= 0) throw new Error('FOREX_PRIMARY_SIGNAL_MAX_AGE_MS must be a positive number.');
const primarySignalMaxAgeMs = Math.max(30_000, Math.min(30 * 60_000, configuredPrimarySignalMaxAgeMs));
const primarySignalMapping = parseForexPrimarySignalMap(env('FOREX_PRIMARY_SIGNAL_MAP_JSON', '{}'));
let stageStartedAt = startStage();
let primarySignals = [];
let primarySignalReadError = null;
let primarySignalRecordsLoaded = 0;
let primarySignalReadDiagnostics = { status: 'not_started' };
try {
  // Cross-market context is read-only research and does not depend on whether
  // the Forex quote provider is enabled. It never enters strategy/risk inputs.
  const sourceRead = await readPrimaryResearchSignalsWithDiagnostics({ now, maxAgeMs: primarySignalMaxAgeMs, owners: ['stocks', 'crypto', 'futures', 'options', 'etfs-etps'] });
  const records = sourceRead.records;
  primarySignalReadDiagnostics = sourceRead.diagnostics;
  primarySignalRecordsLoaded = records.length;
  primarySignals = new Map(mapForexPrimaryResearch(instruments, records, primarySignalMapping));
} catch (error) {
  primarySignalReadError = String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  primarySignalReadDiagnostics = { status: 'read_error' };
  primarySignals = new Map(instruments.map((instrument) => [instrument.toUpperCase(), []]));
}
finishStage('sharedResearchContext', stageStartedAt);
stageStartedAt = startStage();
const catalystSource = env('FOREX_CATALYST_SOURCE', 'manual').toLowerCase();
if (!['manual', 'finnhub'].includes(catalystSource)) throw new Error('FOREX_CATALYST_SOURCE must be manual or finnhub.');
let catalystReviews = Object.fromEntries(instruments.map((instrument) => [instrument, manualCatalystReview]));
let economicCalendarDiagnostics = { status: catalystSource === 'manual' ? 'manual-review' : 'not_started', source: catalystSource };
if (catalystSource === 'finnhub' && source === 'oanda-practice') {
  try {
    const calendar = await fetchFinnhubEconomicCalendar({ token: env('FINNHUB_API_KEY'), marketDate: sessionDate,
      instruments, now, metrics: providerMetrics });
    catalystReviews = { ...catalystReviews, ...calendar.reviews };
    economicCalendarDiagnostics = { ...calendar.diagnostics, source: catalystSource };
  } catch (error) {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    catalystReviews = Object.fromEntries(instruments.map((instrument) => [instrument, { status: 'blocked', source: 'Finnhub Economic Calendar',
      summary: 'Economic calendar unavailable; scheduled-event clearance is blocked.', reviewedAt: new Date(now).toISOString() }]));
    economicCalendarDiagnostics = { status: 'provider_error', source: catalystSource, providerError: message };
  }
} else if (catalystSource === 'finnhub') {
  economicCalendarDiagnostics = { status: 'market_source_disabled', source: catalystSource };
}
const catalystReviewClear = Object.values(catalystReviews).every((review) => isFreshClearCatalystReview(review, { now }));
finishStage('catalystReview', stageStartedAt);
const observations = [];
const paperResults = [];
const markLedgerBefore = await readPaperRiskLedger({ statePath });
const availablePositionMarks = [];
const positionMarkAttempts = [];
const forwardShadowObservations = [];
const decisionQuoteRows = { ...universeDiscovery.quoteRows };
const decisionQuoteDiagnostics = [];
const shadowQuoteDiagnostics = [];
async function decisionQuotes(instrument, diagnostics) {
  const result = await refreshForexDecisionQuotes({ instrument, quoteRows: decisionQuoteRows, availableInstruments: accountInstruments,
    maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs, clock: Date.now,
    fetchPrices: (pairs) => get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent(pairs.join(','))}`,
      'decision-pricing', instrument, null, pairs, { maxAttempts: 1, maxGateWaitMs: 2_000, timeoutMs: 5_000 }) });
  diagnostics.push(result.diagnostics);
  return result;
}
const accountInstruments = dynamicDiscoveryEnabled ? (universeDiscovery.accountInstruments ?? []) : null;
paperResults.push({ type: 'restart_recovery', ...restartRecovery });
stageStartedAt = startStage();
if (source === 'oanda-practice') {
  const positions = markLedgerBefore.orders.filter((row) => row.owner === 'forex' && ['reserved', 'filled', 'open'].includes(row.status));
  const marks = await loadForexPositionQuotes({ instruments: positions.map((row) => row.instrumentKey),
    quoteRows: universeDiscovery.quoteRows, now: Date.now(), clock: Date.now, maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs,
    fetchPrices: (pairs) => get(`/v3/accounts/${encodeURIComponent(account)}/pricing?instruments=${encodeURIComponent(pairs.join(','))}`,
      'position-pricing', null, null, pairs) });
  for (const order of positions) {
    const quote = marks.quotes.get(order.instrumentKey);
    if (!quote) {
      positionMarkAttempts.push({ orderId: order.orderId, status: 'blocked',
        reason: marks.failures.find((row) => row.instrument === order.instrumentKey)?.reason ?? 'position_quote_missing' });
      continue;
    }
    const positionSession = getForexMarketSession(Date.now(), { ...marketCalendar, instrument: order.instrumentKey });
    const result = await processPaperQuote(order.orderId, quote, { expectedOwner: 'forex', statePath, now: Date.now(), observationClock: Date.now,
      maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs, maxSpreadPct: riskPolicy.maxSpreadPct, sessionOpen: positionSession.isOpen, emergencyStop });
    paperResults.push({ instrument: order.instrumentKey, orderId: order.orderId, mark: result });
    availablePositionMarks.push({ orderId: order.orderId, quote });
    positionMarkAttempts.push({ orderId: order.orderId, ...result });
  }
}
finishStage('openPositionMonitoring', stageStartedAt);
stageStartedAt = startStage();
if (source === 'oanda-practice') for (const instrument of instruments) {
  let series;
  const recordProviderFailure = (error, pair = instrument, fallbackOperation = 'market-data') => {
    const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
    const failedOperation = String(error.providerOperation || fallbackOperation);
    observations.push({ instrument: pair, bias: 'PROVIDER ERROR', source: 'OANDA practice', providerError: message,
      providerOperation: failedOperation, providerInstrument: error.providerInstrument || null, reason: 'provider_request_failed' });
    paperResults.push({ instrument: pair, status: 'provider-error', reason: 'provider_request_failed', providerOperation: failedOperation, error: message });
  };
  try {
    const candleResults = await Promise.allSettled(granularities.map((g) =>
      get(`/v3/instruments/${encodeURIComponent(instrument)}/candles?price=M&granularity=${encodeURIComponent(g)}&count=120`, `candles-${g}`, instrument)
    ));
    const failure = candleResults.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    series = candleResults.map((result) => result.value);
  } catch (error) {
    recordProviderFailure(error, instrument, 'candles');
    continue;
  }
  const refreshed = await decisionQuotes(instrument, decisionQuoteDiagnostics);
  const { price, quoteConversion } = refreshed;
  if (!price) {
    const reasons = refreshed.diagnostics.rejections.map(row => row.reason);
    observations.push({ instrument, bias: 'NO CURRENT QUOTE', reason: reasons[0] ?? 'decision_quote_unavailable',
      decisionQuotes: refreshed.diagnostics, dayStrategy: { status: 'no-setup', reasons } });
    paperResults.push({ instrument, status: 'unavailable', reason: reasons[0] ?? 'decision_quote_unavailable' });
    continue;
  }
  const quoteFreshness = assessForexQuoteTime(price.time, { now: Date.now(), maxAgeMs: maxQuoteAgeSeconds * 1000 });
  const quoteAgeSeconds = quoteFreshness.ageMs == null ? NaN : quoteFreshness.ageMs / 1000;
  const bid = readOandaPriceLevel(price.bids), ask = readOandaPriceLevel(price.asks), midpoint = (bid + ask) / 2;
  const quoteValid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;
  const providerTradeable = isOandaPriceTradeable(price);
  const executableQuote = { bid, ask, time: price.time, quality: providerTradeable ? 'executable' : 'non-executable' };
  const frames = series.map((response, i) => {
    const candles = (response.candles || []).filter((c) => c.complete && c.mid);
    const closes = candles.map((c) => Number(c.mid.c));
    const last = closes.at(-1), fast = ema(closes, 9), slow = ema(closes, 21);
    return { granularity: granularities[i], last, ema9: fast, ema21: slow, atr14: atr(candles), direction: fast > slow && last > fast ? 'up' : fast < slow && last < fast ? 'down' : 'mixed' };
  });
  const usable = frames.filter((x) => Number.isFinite(x.last) && Number.isFinite(x.ema21));
  const directions = new Set(usable.map((x) => x.direction));
  const stale = quoteFreshness.status !== 'fresh';
  const tradeable = providerTradeable;
  const direction = !stale && tradeable && quoteValid && usable.length === granularities.length && directions.size === 1 && !directions.has('mixed') ? [...directions][0] : 'unclear';
  const range = frames[0]?.atr14, spread = ask - bid;
  const frameWatches = frames.map((frame) => frameWatch(frame, { stale, tradeable, quoteValid, bid, ask, targetAtrMultiple }));
  const strategyNow = Date.now();
  const instrumentSession = getForexMarketSession(strategyNow, { ...marketCalendar, instrument });
  const strategyInput = {
    instrument, quote: executableQuote,
    m15: (series[granularities.indexOf('M15')]?.candles || []).filter((c) => c.complete && c.mid),
    h1: (series[granularities.indexOf('H1')]?.candles || []).filter((c) => c.complete && c.mid),
    now: strategyNow, sessionDate: instrumentSession.marketDate, catalystReview: catalystReviews[instrument] ?? { status: 'blocked' },
  };
  const strategyBaseConfig = { ...strategyConfig, quoteToUsd: quoteConversion.quoteToUsd ?? NaN,
    gainQuoteToUsd: quoteConversion.gainQuoteToUsd ?? NaN, conversionQuoteTime: quoteConversion.conversionTime ?? null };
  forwardShadowObservations.push({ instrumentKey: instrument, strategyInput, strategyBaseConfig });
  const day = evaluateForexDayBreakout({ ...strategyInput, config: strategyBaseConfig });
  let dayResult = { status: day.status, strategy: day.strategy, reasons: day.reasons };
  if (day.status === 'candidate') {
    const ledger = await readPaperRiskLedger({ statePath });
    const performance = summarizePaperLedger(ledger, { accountEquity, sessionDate: strategyInput.sessionDate, now: Date.now() });
    const active = ledger.orders.filter((row) => ['reserved', 'filled', 'open'].includes(row.status));
    const decision = evaluatePaperCandidate(day.candidate, { accountEquity, realizedPnlToday: performance.realizedPnlRiskDayUtcUsd,
      openPositions: active, closedOrders: ledger.orders.filter((row) => row.status === 'closed') }, { ...riskPolicy, now: Date.now() });
    if (decision.status !== 'paper-approved') dayResult = { status: 'risk-blocked', candidate: day.candidate, decision };
    else {
      const reservation = await reservePaperCandidate(day.candidate, decision, { statePath, now: Date.now(), observationClock: Date.now, emergencyStop });
      dayResult = { status: reservation.status, candidate: day.candidate, decision, reservation };
    }
  }
  paperResults.push({ instrument, strategy: dayResult });
  observations.push({
    instrument, bias: direction === 'up' ? 'UPWARD WATCH' : direction === 'down' ? 'DOWNWARD WATCH' : stale ? 'STALE QUOTE' : !tradeable ? 'NOT TRADEABLE' : !quoteValid ? 'INVALID QUOTE' : 'TIMEFRAMES DISAGREE',
    marketDate: instrumentSession.marketDate, marketTimeZone: instrumentSession.timeZone, marketSchedule: instrumentSession.schedule,
    marketSessionOpen: instrumentSession.isOpen, nzdMaintenanceBreak: instrumentSession.nzdMaintenanceBreak,
    quoteMid: Number.isFinite(midpoint) ? midpoint : null, quoteTime: price.time, quoteAgeSeconds: Number.isFinite(quoteAgeSeconds) ? Number(quoteAgeSeconds.toFixed(1)) : null,
    bid, ask, spread: Number.isFinite(spread) ? spread : null, spreadToFastAtr: Number.isFinite(range) && range > 0 && Number.isFinite(spread) ? Number((spread / range).toFixed(4)) : null,
    usdConversion: { status: quoteConversion.status, quoteCurrency: quoteConversion.quoteCurrency ?? instrument.split('_')[1],
      quoteToUsd: Number.isFinite(quoteConversion.quoteToUsd) ? quoteConversion.quoteToUsd : null,
      gainQuoteToUsd: Number.isFinite(quoteConversion.gainQuoteToUsd) ? quoteConversion.gainQuoteToUsd : null,
      valuationBasis: quoteConversion.valuationBasis ?? 'USD quote currency',
      conversionInstrument: quoteConversion.conversionInstrument ?? null, conversionTime: quoteConversion.conversionTime ?? null,
      conversionAgeMs: quoteConversion.conversionAgeMs ?? null,
      ...(quoteConversion.error ? { error: quoteConversion.error } : {}) },
    decisionQuotes: refreshed.diagnostics, frames, frameWatches, dayStrategy: dayResult, primaryResearch: primarySignals.get(instrument.toUpperCase()) ?? [],
    directionRule: `Overall bias requires all configured frames (${granularities.join(', ')}) to agree. Individual frame watches are heuristic and may conflict; they are not calibrated probabilities.`
  });
}
finishStage('instrumentDataAndStrategy', stageStartedAt);
stageStartedAt = startStage();
const forwardShadowProfiles = [
  { id: 'larger-buffer', overrides: { breakoutBufferAtr: 0.1 }, hypothesis: 'A larger ATR buffer improves net breakout expectancy.', changeMade: 'Use a 0.10 ATR breakout buffer.', reason: 'Measure false-break reduction against later entry.' },
  { id: 'no-buffer', overrides: { breakoutBufferAtr: 0 }, hypothesis: 'Earlier range breaks may compensate for higher false-break risk.', changeMade: 'Remove only the strategy breakout buffer in shadow research.', reason: 'Quantify timing cost while retaining data and portfolio risk gates.' },
  { id: 'longer-range', overrides: { breakoutBars: 12 }, hypothesis: 'A longer M15 range identifies more durable breaks.', changeMade: 'Use twelve completed M15 range bars.', reason: 'Measure confirmation benefit against missed moves.' },
];
const shadowDecisionQuotes = new Map();
const forwardShadowResults = source === 'oanda-practice' ? await runForwardShadowPaper({
  owner: 'forex', strategyVersion: 'forex-m15-range-breakout-h1-trend-shadow-v4-decision-quotes',
  profiles: forwardShadowProfiles, allowlist: ['breakoutBars', 'breakoutBufferAtr'],
  baseConfig: {}, observations: forwardShadowObservations,
  evaluate: async (observation, config) => {
    // One refresh opportunity per observation, shared by all profiles. A failed
    // request does not trigger a retry storm or revive a cached price.
    if (!shadowDecisionQuotes.has(observation)) shadowDecisionQuotes.set(observation,
      decisionQuotes(observation.instrumentKey, shadowQuoteDiagnostics));
    const refreshed = await shadowDecisionQuotes.get(observation);
    const at = Date.now();
    const session = getForexMarketSession(at, { ...marketCalendar, instrument: observation.instrumentKey });
    return evaluateForexDayBreakout({ ...observation.strategyInput, now: at, sessionDate: session.marketDate,
      quote: toExecutableForexQuote(refreshed.price),
      config: { ...observation.strategyBaseConfig, ...config, quoteToUsd: refreshed.quoteConversion.quoteToUsd ?? NaN,
        gainQuoteToUsd: refreshed.quoteConversion.gainQuoteToUsd ?? NaN,
        conversionQuoteTime: refreshed.quoteConversion.conversionTime ?? null } });
  },
  loadOpenOrderQuotes: async (profiles) => {
    const perProfile = new Map(profiles.map((profile) => [profile.profileId, new Map()]));
    const instrumentsToMark = [...new Set(profiles.flatMap((profile) => profile.orders.map((order) => String(order.instrumentKey).toUpperCase())))];
    if (!instrumentsToMark.length) return perProfile;
    const loaded = await loadForexPositionQuotes({ instruments: instrumentsToMark,
      quoteRows: universeDiscovery.quoteRows, now: Date.now(), clock: Date.now, maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs,
      fetchPrices: (pairs) => get('/v3/accounts/' + encodeURIComponent(account) + '/pricing?instruments=' + encodeURIComponent(pairs.join(',')),
        'forward-shadow-position-pricing', null, null, pairs) });
    for (const profile of profiles) for (const order of profile.orders) {
      const quote = loaded.quotes.get(String(order.instrumentKey).toUpperCase());
      if (quote) perProfile.get(profile.profileId).set(String(order.instrumentKey).toUpperCase(), quote);
    }
    return perProfile;
  },
  quotesByInstrument: new Map(forwardShadowObservations.map((row) => [row.instrumentKey.toUpperCase(), row.strategyInput.quote])),
  stateDirectory: `${getPaperLedgerWorkspaceRoot()}/shared/data/forward-shadow`, portfolioStatePath: statePath, now: Date.now(), observationClock: Date.now, accountEquity,
riskPolicy, maxQuoteAgeMs: riskPolicy.maxQuoteAgeMs, maxSpreadPct: riskPolicy.maxSpreadPct,
  sessionOpen: marketSession.isOpen, sessionDate,
}) : [];
finishStage('forwardShadow', stageStartedAt);
if (forwardShadowResults.length) paperResults.push({ type: 'forward_shadow_summary', tracks: forwardShadowResults.map((track) => ({
  id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, mode: track.mode, counts: track.counts, performance: track.performance,
})) });
const dataLabel = source === 'oanda-practice' ? 'OANDA practice' : 'data source disabled';
const currentLedger = await readPaperRiskLedger({ statePath });
const performance = summarizePaperLedger(currentLedger, { accountEquity, sessionDate, now });
const scanDiagnostics = summarizeForexScan({ instruments, observations, paperResults, providerMetrics, source, maxQuoteAgeSeconds, scanDurationMs: Date.now() - scanStartedAt, stageDurationsMs, universeDiscovery });
scanDiagnostics.decisionQuotes = { production: summarizeDecisionQuotes(decisionQuoteDiagnostics),
  shadow: summarizeDecisionQuotes(shadowQuoteDiagnostics) };
scanDiagnostics.marketDataReadiness = assessMarketDataReadiness('forex', {
  observedRows: scanDiagnostics.funnel.referencePriceAvailable, providerRequests: scanDiagnostics.provider.requests,
  providerFailures: scanDiagnostics.provider.failures, marketOpen: marketSession.isOpen, discoveryStatus: universeDiscovery.status });
scanDiagnostics.positionMarkCoverage = summarizePositionMarkCoverage({ owner: 'forex', beforeOrders: markLedgerBefore.orders,
  afterOrders: currentLedger.orders, availableMarks: availablePositionMarks, attempts: positionMarkAttempts, now: Date.now(),
  maxAgeMs: riskPolicy.maxOpenMarkAgeMs });
scanDiagnostics.primaryResearchContext = {
  loaded: primarySignalRecordsLoaded,
  matched: observations.reduce((sum, row) => sum + (row.primaryResearch?.length ?? 0), 0),
  mappedPairs: Object.keys(primarySignalMapping).filter((pair) => instruments.some((instrument) => instrument.toUpperCase() === pair.toUpperCase())).length,
  maxAgeMs: primarySignalMaxAgeMs,
  advisoryOnly: true,
  readError: primarySignalReadError,
  sourceRead: primarySignalReadDiagnostics,
};
await appendScanDiagnostic('forex', { ...scanDiagnostics,
  forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, manifest: track.manifest, mode: track.mode, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })),
  safety: { emergencyStopActive: emergencyStop, liveTradingEnabled: false,
    liveTradingRequested: env('OMNIMOD_LIVE_TRADING_ENABLED', 'false') === 'true', orderRoutingAvailable: false,
    observedAt: new Date().toISOString() } }).catch((error) => console.error('Unable to persist Forex scan diagnostics:', error.message));
const journal = await appendPaperSnapshot('forex', observations, { strategy: 'multi-timeframe EMA research; OANDA-only M15 breakout paper path', source, practiceOnly: source === 'oanda-practice', granularities, maxQuoteAgeSeconds, targetAtrMultiple, catalystReviewClear, catalystSource, economicCalendarDiagnostics, providerMetrics, scanDiagnostics, performance, paperResults, forwardShadow: forwardShadowResults.map((track) => ({ id: track.id, configHash: track.configHash, experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, counts: track.counts, topRejectionReasons: track.topRejectionReasons, performance: track.performance })) });
const dedupeKey = JSON.stringify(observations.map((x) => [x.instrument, x.bias, ...(x.frameWatches || []).map((watch) => watch.bias)]));

const currencyConflictLine = scanDiagnostics.currencyExposureConflicts.length
  ? `Currency concentration blocks: ${scanDiagnostics.currencyExposureConflicts.slice(0, 5).map((row) => `${row.currency} ${row.direction} overlaps ${row.existingInstrument}`).join('; ')}.`
  : 'Currency concentration blocks: 0.';
const crossBotHandoffRows = buildPaperResearchHandoffRows('forex', paperResults);
const discoveryLine = universeDiscovery.status === 'complete'
  ? `FX universe: ${formatDiagnosticCount(scanDiagnostics.universe.accountCurrencyInstruments)} account FX pairs screened · ${formatDiagnosticCount(scanDiagnostics.universe.quoteQualified)} quote-qualified · ${instruments.length} selected for full analysis · ${formatDiagnosticCount(scanDiagnostics.universe.capOmissions)} deferred by analysis cap.`
  : `FX universe discovery: ${universeDiscovery.status}; ${universeDiscovery.status === 'provider_error' ? 'new analysis withheld; existing positions monitored separately' : 'configured pairs only'}.`;
const delivery = await postDiscordMessage(buildDayTradingBrief({ bot: 'forex', at: journal.capturedAt, source: dataLabel,
  readiness: scanDiagnostics.marketDataReadiness,
  coverage: `${discoveryLine}\n${formatDiagnosticCount(scanDiagnostics.universe.observed)}/${formatDiagnosticCount(scanDiagnostics.universe.selected)} selected pairs observed · ${formatDiagnosticCount(scanDiagnostics.provider.failures)} provider failures`,
  results: paperResults, handoffRows: crossBotHandoffRows, emergencyStop,
  context: [`Session: ${marketSession.isOpen ? 'open' : 'closed'}`, `Catalyst calendar: ${economicCalendarDiagnostics.status}`, currencyConflictLine,
    source === 'oanda-practice' ? 'M15 breakout with H1 confirmation; OANDA practice quotes. Spread, currency exposure and costs remain gated.' : 'No authorized live market-data source configured. Scanning is paused.'],
}), { dedupeKey });
const researchHandoff = await publishDeliveredPaperResearch('forex', crossBotHandoffRows, delivery, { now });
console.log(JSON.stringify({ bot: 'forex', mode: `${dataLabel}; paper reservations only; no live orders`, observationTime: journal.capturedAt, observations, paperResults, forwardShadow: forwardShadowResults, economicCalendarDiagnostics, scanDiagnostics, providerMetrics, performance, paperJournal: journal, researchHandoff, discordDelivery: delivery }, null, 2));
