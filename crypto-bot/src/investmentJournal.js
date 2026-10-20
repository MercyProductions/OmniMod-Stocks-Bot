import path from 'node:path';
import { dataDir } from './config.js';
import { readJson, writeJson } from './storage.js';
import { createForwardObservation, mergeForwardObservations, resolveForwardObservation } from './forwardInvestmentJournal.js';

const DAY = 86_400_000;
const queues = new Map();
const safeId = (value) => String(value || '').replace(/[^a-z0-9_-]/gi, '');
const average = (rows) => rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
export const LONG_WINDOW_SHADOW_DAYS = Object.freeze([90, 180, 365]);
const LONG_WINDOW_MODEL_VERSION = 'crypto-daily-long-window-shadow-v1';

function quoteCurrency(pair) {
  const compact = String(pair || '').toUpperCase().replace(/[\/-]/g, '');
  return ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'].find((currency) => compact.endsWith(currency)) || '';
}

function hasContiguousDailyCoverage(candles = [], horizonDays) {
  if (!Array.isArray(candles) || candles.length < horizonDays) return false;
  const tail = candles.slice(-horizonDays);
  return tail.every((row, index) => Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.close)) && Number(row.close) > 0
    && (!index || Number(row.time) - Number(tail[index - 1].time) === DAY));
}

function summarizeLongWindow(rows) {
  const resolved = rows.filter((row) => row.resolution?.status === 'resolved');
  const exitBySymbol = new Map(), nonOverlapping = [];
  for (const row of [...resolved].sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt))) {
    const priorExit = exitBySymbol.get(row.symbol) || 0;
    if (Date.parse(row.resolution.entryAt) >= priorExit) {
      nonOverlapping.push(row);
      exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt));
    }
  }
  return { issued: rows.length, resolved: resolved.length, pending: rows.filter((row) => !row.resolution).length,
    nonOverlappingWindows: nonOverlapping.length,
    meanNetReturnPct: average(nonOverlapping.map((row) => row.resolution.netReturn * 100)),
    meanExcessReturnPct: average(nonOverlapping.map((row) => row.resolution.excessReturn * 100)) };
}

export function investmentJournalFile(guildId) {
  const id = safeId(guildId);
  if (!id) throw new Error('A guild id is required for a private investment journal.');
  return path.join(dataDir, `investment-journal-${id}.json`);
}

export function summarizeInvestmentJournal(observations, symbol) {
  const selected = observations.filter((row) => !symbol || row.symbol === symbol);
  const contextCaptures = new Map();
  for (const row of selected) {
    const key = JSON.stringify([row.symbol, row.asOf, row.observedAt]);
    if (!contextCaptures.has(key)) contextCaptures.set(key, row.globalMarketContext?.status || 'missing');
  }
  const globalContextCoverage = { total: contextCaptures.size, fresh: 0, stale: 0, unavailable: 0, missing: 0 };
  for (const status of contextCaptures.values()) globalContextCoverage[Object.hasOwn(globalContextCoverage, status) ? status : 'unavailable'] += 1;
  const longWindowRows = selected.filter((row) => row.modelVersion === LONG_WINDOW_MODEL_VERSION);
  const summarizeSegment = (rows, horizonSessions) => {
    const matching = rows.filter((row) => row.horizonSessions === horizonSessions && row.resolution);
    const exitBySymbol = new Map(), nonOverlapping = [];
    for (const row of [...matching].sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt))) {
      const previousExit = exitBySymbol.get(row.symbol) || 0;
      if (Date.parse(row.resolution.entryAt) >= previousExit) {
        nonOverlapping.push(row);
        exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt));
      }
    }
    return { resolved: matching.length, nonOverlappingWindows: nonOverlapping.length,
      meanNetReturnPct: average(nonOverlapping.map((row) => row.resolution.netReturn * 100)),
      meanExcessReturnPct: average(nonOverlapping.map((row) => row.resolution.excessReturn * 100)) };
  };
  const byRegime = Object.fromEntries(['risk_on', 'mixed', 'risk_off', 'insufficient_history', 'unknown'].map((regime) => [regime,
    Object.fromEntries([5, 20, 60].map((horizonSessions) => [horizonSessions,
      summarizeSegment(selected.filter((row) => (row.marketRegime || 'unknown') === regime), horizonSessions)]))]));
  const byVolatilityRegime = Object.fromEntries(['lower_quartile', 'typical', 'elevated', 'extreme', 'insufficient_history', 'unknown'].map((regime) => [regime,
    Object.fromEntries([5, 20, 60].map((horizonSessions) => [horizonSessions,
      summarizeSegment(selected.filter((row) => (row.volatilityRegime || 'unknown') === regime), horizonSessions)]))]));
  const tracks = [...new Set(selected.map((row) => row.selectionTrack || 'legacy / untagged'))];
  const bySelectionTrack = Object.fromEntries(tracks.map((track) => [track,
    Object.fromEntries([5, 20, 60].map((horizonSessions) => [horizonSessions,
      summarizeSegment(selected.filter((row) => (row.selectionTrack || 'legacy / untagged') === track), horizonSessions)]))]));
  return { snapshots: selected.length, resolved: selected.filter((row) => row.resolution).length, globalContextCoverage, byRegime, byVolatilityRegime, bySelectionTrack,
    pending: selected.filter((row) => !row.resolution).length,
    longWindowShadow: Object.fromEntries(LONG_WINDOW_SHADOW_DAYS.map((horizon) => [horizon,
      summarizeLongWindow(longWindowRows.filter((row) => row.horizonSessions === horizon))])),
    longWindowShadowByRegime: Object.fromEntries(['risk_on', 'mixed', 'risk_off', 'insufficient_history', 'unknown'].map((regime) => [regime,
      Object.fromEntries(LONG_WINDOW_SHADOW_DAYS.map((horizon) => [horizon,
        summarizeLongWindow(longWindowRows.filter((row) => (row.marketRegime || 'unknown') === regime && row.horizonSessions === horizon))]))])),
    longWindowShadowByVolatilityRegime: Object.fromEntries(['lower_quartile', 'typical', 'elevated', 'extreme', 'insufficient_history', 'unknown'].map((regime) => [regime,
      Object.fromEntries(LONG_WINDOW_SHADOW_DAYS.map((horizon) => [horizon,
        summarizeLongWindow(longWindowRows.filter((row) => (row.volatilityRegime || 'unknown') === regime && row.horizonSessions === horizon))]))])),
    horizons: [5, 20, 60].map((horizonSessions) => {
      const rows = selected.filter((row) => row.horizonSessions === horizonSessions && row.resolution)
        .sort((a, b) => Date.parse(a.resolution.entryAt) - Date.parse(b.resolution.entryAt));
      const exitBySymbol = new Map();
      const separate = [];
      for (const row of rows) {
        const previous = exitBySymbol.get(row.symbol) || 0;
        if (Date.parse(row.resolution.entryAt) >= previous) {
          separate.push(row);
          exitBySymbol.set(row.symbol, Date.parse(row.resolution.exitAt));
        }
      }
      return { horizonSessions, resolved: rows.length, nonOverlappingWindows: separate.length,
        meanNetReturnPct: average(separate.map((row) => row.resolution.netReturn * 100)),
        meanExcessReturnPct: average(separate.map((row) => row.resolution.excessReturn * 100)),
        watchSnapshots: rows.filter((row) => ['DAILY TREND WATCH', 'LONGER-HOLD WATCH'].includes(row.decision)).length };
    }),
    limitation: 'Forward frozen research snapshots; daily snapshots overlap and different assets correlate. Hypothetical future-open exposure, never executed trades.' };
}

export async function pendingInvestmentSymbols(guildId, currentSymbols, options = {}) {
  const storage = options.storage || { readJson };
  const saved = await storage.readJson(options.file || investmentJournalFile(guildId), { version: 1, observations: [] });
  if (saved?.version !== 1 || !Array.isArray(saved.observations)) throw new Error('Investment journal has invalid structure; existing data was not replaced.');
  const nowMs = new Date(options.now ?? Date.now()).getTime();
  const current = new Set(currentSymbols);
  const bySymbol = new Map();
  for (const row of saved.observations) {
    if (row.resolution || current.has(row.symbol) || Math.ceil(Date.parse(row.observedAt) / DAY) * DAY + row.horizonSessions * DAY > nowMs) continue;
    const existing = bySymbol.get(row.symbol);
    if (!existing || Date.parse(row.observedAt) < Date.parse(existing.observedAt)) bySymbol.set(row.symbol, row);
  }
  const rows = [...bySymbol.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (!rows.length) return [];
  // Daily rotation provides bounded retries for dropped/unavailable symbols
  // without letting one repeatedly failing symbol starve the remaining cohort.
  const offset = Math.floor(nowMs / DAY) % rows.length;
  return [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 2);
}

export async function updateInvestmentJournal(guildId, contexts, benchmark, options = {}) {
  const file = options.file || investmentJournalFile(guildId);
  const storage = options.storage || { readJson, writeJson };
  const now = new Date(options.now ?? Date.now());
  const task = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const saved = await storage.readJson(file, { version: 1, observations: [] });
    if (saved?.version !== 1 || !Array.isArray(saved.observations)) throw new Error('Investment journal has invalid structure; existing data was not replaced.');
    const bySymbol = new Map(contexts.map((context) => [context.result.symbol, context]));
    const bars = (source) => source.map((row) => ({ time: row.time, closeTime: row.time + DAY, open: row.open, close: row.close }));
    const benchmarkBars = bars(benchmark.candles);
    const resolved = saved.observations.map((row) => {
      const context = bySymbol.get(row.symbol);
      if (!context || row.resolution || row.dataProvider !== context.history.provider || row.dataPair !== context.history.pair
        || row.benchmarkProvider !== benchmark.provider || row.benchmarkPair !== benchmark.pair) return row;
      const required = benchmarkBars.filter((bar) => bar.time >= Math.floor(Date.parse(row.observedAt) / DAY) * DAY - DAY);
      if (!required.every((bar, index) => !index || bar.time - required[index - 1].time === DAY)) return row;
      return resolveForwardObservation(row, bars(context.history.candles), required, { now: now.toISOString() });
    });
    const incoming = contexts.filter((context) => context.capture !== false && context.result.asOf).flatMap(({ result, history }) =>
      [5, 20, 60].map((horizonSessions) => ({
        ...createForwardObservation({ symbol: result.symbol, benchmarkSymbol: 'BTC', horizonSessions,
          asOf: result.asOf, observedAt: now.toISOString(), decision: result.decision, score: result.score ?? null,
          marketRegime: result.marketRegime?.label || 'unknown',
          volatilityRegime: result.marketRegime?.volatilityRegime || 'unknown',
          globalMarketContext: options.globalMarketContext,
          selectionTrack: result.selectionTrack,
          roundTripCostBps: Number(options.roundTripFeeBps ?? 20), modelVersion: 'crypto-daily-v1' }),
        assetId: result.assetId, dataProvider: history.provider, dataPair: history.pair,
        benchmarkProvider: benchmark.provider, benchmarkPair: benchmark.pair
      })));
    const longWindowCaptureBySymbol = saved.longWindowCaptureBySymbol && typeof saved.longWindowCaptureBySymbol === 'object'
      && !Array.isArray(saved.longWindowCaptureBySymbol) ? { ...saved.longWindowCaptureBySymbol } : {};
    const longWindowIncoming = [];
    const captureMonth = now.toISOString().slice(0, 7);
    const contextsPerSymbol = new Map();
    for (const context of contexts) {
      const symbol = String(context?.result?.symbol || '').toUpperCase();
      if (symbol && context.capture !== false) contextsPerSymbol.set(symbol, (contextsPerSymbol.get(symbol) || 0) + 1);
    }
    for (const context of contexts) {
      const { result, history } = context;
      const symbol = String(result?.symbol || '').toUpperCase();
      if (context.capture === false || !symbol || contextsPerSymbol.get(symbol) !== 1 || !result.asOf || !Number.isFinite(Number(result.score))
        || longWindowCaptureBySymbol[symbol] === captureMonth) continue;
      const sameVenueAndQuote = history?.provider && history.provider === benchmark.provider
        && quoteCurrency(history.pair) && quoteCurrency(history.pair) === quoteCurrency(benchmark.pair);
      if (!sameVenueAndQuote || history.interval !== '1d' || benchmark.interval !== '1d') continue;
      const eligibleHorizons = LONG_WINDOW_SHADOW_DAYS.filter((horizon) => hasContiguousDailyCoverage(history.candles, horizon)
        && hasContiguousDailyCoverage(benchmark.candles, horizon));
      if (!eligibleHorizons.length) continue;
      for (const horizonDays of eligibleHorizons) {
        longWindowIncoming.push({ ...createForwardObservation({ symbol, benchmarkSymbol: 'BTC', horizonSessions: horizonDays,
          asOf: result.asOf, observedAt: now.toISOString(), decision: result.decision, score: result.score,
          marketRegime: result.marketRegime?.label || 'unknown', volatilityRegime: result.marketRegime?.volatilityRegime || 'unknown', selectionTrack: result.selectionTrack,
          globalMarketContext: options.globalMarketContext,
          roundTripCostBps: Number(options.roundTripFeeBps ?? 20), modelVersion: LONG_WINDOW_MODEL_VERSION }),
        researchTrack: 'monthly long-window shadow of the daily 200-session trend screen',
        assetId: result.assetId, dataProvider: history.provider, dataPair: history.pair,
        benchmarkProvider: benchmark.provider, benchmarkPair: benchmark.pair });
      }
      longWindowCaptureBySymbol[symbol] = captureMonth;
    }
    const observations = mergeForwardObservations(resolved, [...incoming, ...longWindowIncoming]);
    await storage.writeJson(file, { version: 1, observations, longWindowCaptureBySymbol, updatedAt: now.toISOString() });
    const unrefreshed = observations.filter((row) => !row.resolution && !bySymbol.has(row.symbol));
    const overdueUnrefreshed = unrefreshed.filter((row) => Math.ceil(Date.parse(row.observedAt) / DAY) * DAY + row.horizonSessions * DAY <= now.getTime()).length;
    const overduePending = observations.filter((row) => !row.resolution && Math.ceil(Date.parse(row.observedAt) / DAY) * DAY + row.horizonSessions * DAY <= now.getTime()).length;
    return { ...summarizeInvestmentJournal(observations), unrefreshedPending: unrefreshed.length, overdueUnrefreshed, overduePending, cohortIncomplete: overduePending > 0, bySymbol: Object.fromEntries(contexts.map(({ result }) => [result.symbol, summarizeInvestmentJournal(observations, result.symbol)])) };
  });
  queues.set(file, task);
  try { return await task; }
  finally { if (queues.get(file) === task) queues.delete(file); }
}
