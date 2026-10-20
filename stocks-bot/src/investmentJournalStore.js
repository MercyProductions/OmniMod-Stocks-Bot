import path from 'node:path';
import { dataDir } from './config.js';
import { readJson, writeJson, readMarketSnapshot } from './storage.js';
import { localDateKey, marketCloseMinute, marketCloseTime, marketSession } from './time.js';
import { fetchInvestmentResearch, analyzeInvestment, latestCompletedSession, INVESTMENT_HORIZONS } from './investmentResearch.js';
import { createForwardObservation, mergeForwardObservations, resolveForwardObservation } from './forwardInvestmentJournal.js';
import { appendSecFundamentalEvidence } from './secEvidenceJournal.js';

const locks = new Map();
export const LONG_WINDOW_SHADOW_HORIZONS = Object.freeze([126, 252, 756]);
const LONG_WINDOW_MODEL_VERSION = 'stocks-daily-long-window-shadow-v1';
const safeGuild = (value) => {
  if (!/^[a-z0-9_-]{1,80}$/i.test(String(value))) throw new Error('Invalid investment journal guild id.');
  return String(value);
};
const sessionReference = (date) => new Date(`${date}T16:00:00Z`);
function exchangeSession(date) {
  const reference = sessionReference(date);
  if (marketSession(reference).state !== 'regular') return null;
  const closeTime = marketCloseTime(reference).getTime();
  return { date, time: closeTime - (marketCloseMinute(reference) - 570) * 60_000, closeTime };
}

export function normalizeJournalBars(bars = []) {
  return bars.flatMap((row) => {
    const session = exchangeSession(row.date);
    // Provider daily candles must actually begin at the exchange session open.
    if (!session || Math.abs(row.timestamp * 1000 - session.time) > 1000) return [];
    return [{ ...session, open: row.open, close: row.close }];
  });
}

export function resolveWithExchangeCalendar(observation, assetBars, benchmarkBars, now) {
  if (observation.resolution) return observation;
  const captured = Date.parse(observation.observedAt);
  if (!Number.isFinite(captured)) return observation;
  const date = sessionReference(localDateKey(new Date(captured), 'America/New_York'));
  const benchmarkByDate = new Map(benchmarkBars.map((bar) => [bar.date, bar]));
  let sessions = 0;
  // Enumerate the actual exchange calendar independently of BOTH providers;
  // two missing series cannot silently turn N sessions into N+1 sessions.
  for (let i = 0; i < 3700 && date.getTime() <= now.getTime(); i += 1) {
    const key = date.toISOString().slice(0, 10);
    const session = exchangeSession(key);
    if (session && session.time >= captured) {
      if (session.closeTime > now.getTime() || !benchmarkByDate.has(key)) return observation;
      sessions += 1;
      if (sessions === observation.horizonSessions)
        return resolveForwardObservation(observation, assetBars, benchmarkBars, { now: now.toISOString() });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return observation;
}

export function forwardJournalSummary(observations) {
  const regimes = ['risk_on', 'mixed', 'risk_off', 'insufficient_history', 'unknown'];
  const summarizeLongWindow = (rows) => {
    const resolvedRows = rows.filter((row) => row.resolution?.status === 'resolved');
    const exitBySymbol = new Map(), selected = [];
    for (const row of [...resolvedRows].sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt))) {
      const previousExit = exitBySymbol.get(row.symbol) || 0;
      if (Date.parse(row.resolution.entryAt) >= previousExit) {
        selected.push(row);
        exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt));
      }
    }
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { issued: rows.length, resolved: resolvedRows.length,
      pending: rows.filter((row) => !row.resolution).length, nonOverlappingWindows: selected.length,
      meanNetReturnPct: mean(selected.map((row) => row.resolution.netReturn * 100)),
      meanExcessReturnPct: mean(selected.map((row) => row.resolution.excessReturn * 100)) };
  };
  const longWindowRows = observations.filter((row) => row.modelVersion === LONG_WINDOW_MODEL_VERSION);
  return {
    issued: observations.length,
    resolved: observations.filter((r) => r.resolution?.status === 'resolved').length,
    pending: observations.filter((r) => !r.resolution).length,
    byHorizon: Object.fromEntries(
      INVESTMENT_HORIZONS.map((h) => [
        h,
        {
          issued: observations.filter((r) => r.horizonSessions === h).length,
          resolved: observations.filter((r) => r.horizonSessions === h && r.resolution?.status === 'resolved').length,
        },
      ]),
    ),
    longWindowShadow: Object.fromEntries(LONG_WINDOW_SHADOW_HORIZONS.map((horizon) => [horizon,
      summarizeLongWindow(longWindowRows.filter((row) => row.horizonSessions === horizon))])),
    longWindowShadowByRegime: Object.fromEntries(regimes.map((regime) => [regime,
      Object.fromEntries(LONG_WINDOW_SHADOW_HORIZONS.map((horizon) => [horizon,
        summarizeLongWindow(longWindowRows.filter((row) => (row.marketRegime || 'unknown') === regime
          && row.horizonSessions === horizon))]))])),
    longWindowShadowByVolatilityRegime: Object.fromEntries(['lower_quartile', 'typical', 'elevated', 'extreme', 'insufficient_history', 'unknown'].map((regime) => [regime,
      Object.fromEntries(LONG_WINDOW_SHADOW_HORIZONS.map((horizon) => [horizon,
        summarizeLongWindow(longWindowRows.filter((row) => (row.volatilityRegime || 'unknown') === regime
          && row.horizonSessions === horizon))]))])),
    byRegime: Object.fromEntries(regimes.map((regime) => [regime, Object.fromEntries(INVESTMENT_HORIZONS.map((horizon) => {
      const rows = observations.filter((row) => (row.marketRegime || 'unknown') === regime && row.horizonSessions === horizon && row.resolution?.status === 'resolved');
      const exitBySymbol = new Map();
      const selected = [];
      for (const row of rows.sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt))) {
        const previousExit = exitBySymbol.get(row.symbol) || 0;
        if (Date.parse(row.resolution.entryAt) >= previousExit) {
          selected.push(row);
          exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt));
        }
      }
      const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return [horizon, { resolved: rows.length, nonOverlappingWindows: selected.length,
        meanNetReturnPct: mean(selected.map((row) => row.resolution.netReturn * 100)),
        meanExcessReturnPct: mean(selected.map((row) => row.resolution.excessReturn * 100)) }];
    }))])),
    byVolatilityRegime: Object.fromEntries(['lower_quartile', 'typical', 'elevated', 'extreme', 'insufficient_history', 'unknown'].map((regime) => [regime,
      Object.fromEntries(INVESTMENT_HORIZONS.map((horizon) => {
        const rows = observations.filter((row) => (row.volatilityRegime || 'unknown') === regime && row.horizonSessions === horizon && row.resolution?.status === 'resolved');
        const exitBySymbol = new Map(), selected = [];
        for (const row of [...rows].sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt))) {
          const previousExit = exitBySymbol.get(row.symbol) || 0;
          if (Date.parse(row.resolution.entryAt) >= previousExit) { selected.push(row); exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt)); }
        }
        const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        return [horizon, { resolved: rows.length, nonOverlappingWindows: selected.length,
          meanNetReturnPct: mean(selected.map((row) => row.resolution.netReturn * 100)),
          meanExcessReturnPct: mean(selected.map((row) => row.resolution.excessReturn * 100)) }];
      }))])),
  };
}

async function runLocked(guildId, symbols, options) {
  const clock = options.clock || (() => new Date());
  const now = clock();
  const directory = options.directory || dataDir;
  const file = path.join(directory, `investment-journal-${safeGuild(guildId)}.json`);
  const journal = await readJson(file, { version: 1, observations: [], updatedAt: '' });
  if (journal.version !== 1 || !Array.isArray(journal.observations))
    throw new Error('Investment journal schema is invalid; repair it before collecting more evidence.');
  const session = latestCompletedSession(now);
  const attempts = journal.lastAutomaticAttemptAsOf === session ? Number(journal.automaticAttempts || 0) : 0;
  if (
    options.automatic &&
    (journal.lastAutomaticAsOf === session ||
      attempts >= 3 ||
      now.getTime() - Date.parse(journal.lastAutomaticAttemptAt || '') < 60 * 60_000)
  )
    return { skipped: true, forward: forwardJournalSummary(journal.observations) };
  const requested = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()))].slice(0, 20);
  const allPending = [...new Set(journal.observations.filter((r) => !r.resolution).map((r) => r.symbol))];
  const cursor = allPending.length ? Number(journal.pendingCursor || 0) % allPending.length : 0;
  const pendingSymbols = [...allPending.slice(cursor), ...allPending.slice(0, cursor)].slice(0, 20);
  const eventSnapshot = options.eventSnapshot || (await readMarketSnapshot(guildId));
  const researchFetcher = options.researchFetcher || fetchInvestmentResearch;
  const report = await researchFetcher([...new Set([...requested, ...pendingSymbols])], {
    ...options,
    now,
    maxSymbols: 40,
    includeHistory: true,
    eventSnapshot,
  });
  const observedAt = clock(); // Actual capture completion; never backdate issuance to the provider request.
  let secEvidence = null;
  if (options.persistFundamentalEvidence) {
    try {
      secEvidence = await appendSecFundamentalEvidence(report.rows, { directory, observedAt });
    } catch (error) {
      secEvidence = { error: `Unable to save SEC evidence snapshot: ${String(error?.message || error).slice(0, 140)}` };
    }
  }
  const histories = report.histories || {};
  const benchmark = normalizeJournalBars(histories.SPY?.bars || []);
  const resolved = journal.observations.map((row) =>
    resolveWithExchangeCalendar(row, normalizeJournalBars(histories[row.symbol]?.bars || []), benchmark, observedAt),
  );
  const horizons = options.automatic ? INVESTMENT_HORIZONS : [Number(options.horizon) || 20];
  const incoming = [];
  const monthKey = session.slice(0, 7);
  const longWindowCaptureBySymbol = journal.longWindowCaptureBySymbol && typeof journal.longWindowCaptureBySymbol === 'object'
    && !Array.isArray(journal.longWindowCaptureBySymbol) ? { ...journal.longWindowCaptureBySymbol } : {};
  for (const symbol of requested.filter((s) => s !== 'SPY' && histories[s])) {
    for (const horizon of horizons) {
      const row = analyzeInvestment(symbol, histories[symbol].bars, histories.SPY?.bars || [], {
        now: observedAt,
        horizon,
        events: histories[symbol].events,
        settings: options.settings,
        eventContext: { fetchedAt: eventSnapshot?.fetchedAt, asset: eventSnapshot?.assets?.find((row) => row.symbol === symbol) },
      });
      if (!row.asOf || row.asOf !== latestCompletedSession(observedAt)) continue;
      incoming.push(
        createForwardObservation({
          symbol,
          benchmarkSymbol: 'SPY',
          horizonSessions: horizon,
          asOf: marketCloseTime(sessionReference(row.asOf)).toISOString(),
          observedAt: observedAt.toISOString(),
          decision: row.decision,
          score: row.score,
          marketRegime: row.marketRegime?.label || 'unknown',
          volatilityRegime: row.marketRegime?.volatilityRegime || 'unknown',
          roundTripCostBps: 20,
          modelVersion: 'stocks-daily-v1',
        }),
      );
    }
    if (options.automatic && longWindowCaptureBySymbol[symbol] !== monthKey) {
      const longWindowContext = analyzeInvestment(symbol, histories[symbol].bars, histories.SPY?.bars || [], {
        now: observedAt, horizon: 60, events: histories[symbol].events, settings: options.settings,
        eventContext: { fetchedAt: eventSnapshot?.fetchedAt, asset: eventSnapshot?.assets?.find((row) => row.symbol === symbol) },
      });
      if (longWindowContext.asOf === latestCompletedSession(observedAt) && Number.isFinite(longWindowContext.score)) {
        for (const horizon of LONG_WINDOW_SHADOW_HORIZONS) {
          incoming.push({ ...createForwardObservation({
            symbol, benchmarkSymbol: 'SPY', horizonSessions: horizon,
            asOf: marketCloseTime(sessionReference(longWindowContext.asOf)).toISOString(),
            observedAt: observedAt.toISOString(), decision: longWindowContext.decision, score: longWindowContext.score,
            marketRegime: longWindowContext.marketRegime?.label || 'unknown', roundTripCostBps: 20,
            volatilityRegime: longWindowContext.marketRegime?.volatilityRegime || 'unknown',
            modelVersion: LONG_WINDOW_MODEL_VERSION,
          }), researchTrack: 'monthly long-window shadow of the fixed 60-session daily trend screen' });
        }
        longWindowCaptureBySymbol[symbol] = monthKey;
      }
    }
  }
  const observations = mergeForwardObservations(resolved, incoming);
  const saved = {
    ...journal,
    version: 1,
    observations,
    updatedAt: observedAt.toISOString(),
    pendingCursor: allPending.length ? (cursor + 20) % allPending.length : 0,
    longWindowCaptureBySymbol,
    ...(options.automatic
      ? {
          lastAutomaticAttemptAt: observedAt.toISOString(),
          lastAutomaticAttemptAsOf: session,
          automaticAttempts: attempts + 1,
          ...(report.errors.length === 0 && report.benchmark.asOf === session ? { lastAutomaticAsOf: session } : {}),
        }
      : {}),
  };
  await writeJson(file, saved);
  const { histories: _privateHistory, ...publicReport } = report;
  return {
    ...publicReport,
    ...(secEvidence ? { secEvidence } : {}),
    requested,
    rows: report.rows.filter((r) => requested.includes(r.symbol)),
    forward: forwardJournalSummary(observations),
  };
}

export async function collectInvestmentResearch(guildId, symbols, options = {}) {
  const key = `${path.resolve(options.directory || dataDir)}:${safeGuild(guildId)}`;
  const prior = locks.get(key) || Promise.resolve();
  const task = prior.catch(() => {}).then(() => runLocked(guildId, symbols, options));
  locks.set(key, task);
  try {
    return await task;
  } finally {
    if (locks.get(key) === task) locks.delete(key);
  }
}
