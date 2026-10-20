/**
 * Pure forward research journal. Callers supply real capture timestamps and
 * authoritative exchange-session bars; this module does not fetch data or trade.
 * Keep at least one benchmark bar opening at/before observation time so a
 * truncated provider response cannot silently move the simulated entry forward.
 */
const JOURNAL_VERSION = 1;
const MARKET_REGIMES = new Set(['risk_on', 'mixed', 'risk_off', 'insufficient_history', 'unknown']);
const VOLATILITY_REGIMES = new Set(['lower_quartile', 'typical', 'elevated', 'extreme', 'insufficient_history', 'unknown']);
const SELECTION_TRACKS = new Set(['market-cap core', 'weekly momentum discovery', 'relative-turnover discovery', 'market-cap fill', 'single-asset query']);
const GLOBAL_CONTEXT_STATUSES = new Set(['fresh', 'stale', 'unavailable']);

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && Number.isFinite(new Date(parsed).getTime()) ? parsed : null;
}

function symbolName(value) {
  if (typeof value !== 'string') return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9.^][A-Z0-9.^/_:-]{0,63}$/.test(symbol) ? symbol : null;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeGlobalContext(value) {
  if (value === undefined || value === null) return null;
  const percent = (field) => typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= 100 ? field : null;
  const nonnegative = (field) => typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : null;
  const source = value.source === 'CoinGecko public /global' ? value.source : null;
  const status = source && GLOBAL_CONTEXT_STATUSES.has(value.status) ? value.status : 'unavailable';
  return Object.freeze({
    source,
    status,
    available: Boolean(source && value.available === true && ['fresh', 'stale'].includes(status)),
    fetchedAt: timestamp(value.fetchedAt) === null ? null : new Date(timestamp(value.fetchedAt)).toISOString(),
    providerUpdatedAt: timestamp(value.providerUpdatedAt) === null ? null : new Date(timestamp(value.providerUpdatedAt)).toISOString(),
    btcDominancePct: percent(value.btcDominancePct), ethDominancePct: percent(value.ethDominancePct),
    totalMarketCapUsd: nonnegative(value.totalMarketCapUsd), totalVolumeUsd: nonnegative(value.totalVolumeUsd),
    marketCapChange24hPct: typeof value.marketCapChange24hPct === 'number' && Number.isFinite(value.marketCapChange24hPct) ? value.marketCapChange24hPct : null,
    volumeChange24hPct: typeof value.volumeChange24hPct === 'number' && Number.isFinite(value.volumeChange24hPct) ? value.volumeChange24hPct : null
  });
}

function validGlobalContext(value) {
  return value && typeof value === 'object' && (value.source === null || value.source === 'CoinGecko public /global')
    && GLOBAL_CONTEXT_STATUSES.has(value.status) && typeof value.available === 'boolean'
    && (value.fetchedAt === null || timestamp(value.fetchedAt) !== null)
    && (value.providerUpdatedAt === null || timestamp(value.providerUpdatedAt) !== null)
    && ['btcDominancePct', 'ethDominancePct'].every((key) => value[key] === null || Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100)
    && ['totalMarketCapUsd', 'totalVolumeUsd'].every((key) => value[key] === null || Number.isFinite(value[key]) && value[key] >= 0)
    && ['marketCapChange24hPct', 'volumeChange24hPct'].every((key) => value[key] === null || Number.isFinite(value[key]));
}

function keyOf(observation) {
  const asOf = timestamp(observation?.asOf);
  const symbol = symbolName(observation?.symbol);
  const horizon = observation?.horizonSessions;
  const model = observation?.modelVersion;
  if (!symbol || asOf === null || !Number.isSafeInteger(horizon) || horizon < 1 || typeof model !== 'string' || !model.trim()) return null;
  return JSON.stringify([symbol, asOf, horizon, model]);
}

function validObservation(observation) {
  const captured = timestamp(observation?.observedAt);
  const asOf = timestamp(observation?.asOf);
  return observation?.version === JOURNAL_VERSION && keyOf(observation) !== null &&
    symbolName(observation.benchmarkSymbol) !== null && captured !== null && asOf <= captured &&
    typeof observation.decision === 'string' && observation.decision.trim().length > 0 &&
    (observation.score === null || typeof observation.score === 'number' && Number.isFinite(observation.score)) &&
    (observation.marketRegime === undefined || MARKET_REGIMES.has(observation.marketRegime)) &&
    (observation.volatilityRegime === undefined || VOLATILITY_REGIMES.has(observation.volatilityRegime)) &&
    (observation.globalMarketContext === undefined || validGlobalContext(observation.globalMarketContext)) &&
    (observation.selectionTrack === undefined || SELECTION_TRACKS.has(observation.selectionTrack)) &&
    typeof observation.roundTripCostBps === 'number' && Number.isFinite(observation.roundTripCostBps) &&
    observation.roundTripCostBps >= 0 && observation.roundTripCostBps < 10_000;
}

export function createForwardObservation({ symbol, benchmarkSymbol, horizonSessions, asOf, observedAt, decision, score, marketRegime = 'unknown', volatilityRegime = 'unknown', globalMarketContext, selectionTrack, roundTripCostBps = 20, modelVersion = 'daily-research-v1' } = {}) {
  const asOfMs = timestamp(asOf);
  const observedMs = timestamp(observedAt);
  const record = {
    version: JOURNAL_VERSION,
    kind: 'forward_daily_research',
    symbol: symbolName(symbol),
    benchmarkSymbol: symbolName(benchmarkSymbol),
    horizonSessions,
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    observedAt: observedMs === null ? null : new Date(observedMs).toISOString(),
    decision: typeof decision === 'string' ? decision.trim() : decision,
    score,
    marketRegime,
    volatilityRegime,
    ...(globalMarketContext == null ? {} : { globalMarketContext: normalizeGlobalContext(globalMarketContext) }),
    ...(selectionTrack ? { selectionTrack } : {}),
    roundTripCostBps,
    modelVersion: typeof modelVersion === 'string' ? modelVersion.trim() : modelVersion,
    resolution: null
  };
  if (!validObservation(record)) throw new TypeError('Invalid forward observation: require symbols, positive integer horizon, null or finite score, known trend/volatility regime, finite cost, decision/model and asOf <= actual observedAt.');
  return Object.freeze({ ...record, id: keyOf(record) });
}

/** Existing issued records are never replaced. Earliest wins in a new batch. */
export function mergeForwardObservations(existing = [], incoming = []) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new TypeError('Forward journal inputs must be arrays.');
  const records = new Map();
  const earliestFirst = (rows) => [...rows].sort((a, b) => timestamp(a?.observedAt) - timestamp(b?.observedAt));
  for (const batch of [existing, incoming]) {
    if (batch.some((row) => !validObservation(row))) throw new TypeError('Forward journal contains an invalid observation; existing records must be preserved.');
    for (const record of earliestFirst(batch)) {
      const key = keyOf(record);
      if (!records.has(key)) records.set(key, record);
    }
  }
  return [...records.values()].sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt) || keyOf(a).localeCompare(keyOf(b)));
}

function validBars(bars) {
  if (!Array.isArray(bars) || !bars.length) return false;
  return bars.every((bar, index) => bar &&
    typeof bar.time === 'number' && timestamp(bar.time) !== null &&
    typeof bar.closeTime === 'number' && timestamp(bar.closeTime) !== null && bar.closeTime > bar.time &&
    positiveNumber(bar.open) && positiveNumber(bar.close) &&
    (index === 0 || (bar.time > bars[index - 1].time && bar.time >= bars[index - 1].closeTime)));
}

/**
 * Horizon N includes the entry session and resolves at its Nth session close.
 * Benchmark sessions define the schedule (supply contiguous daily crypto bars).
 * Both securities must cover every aligned session; missing data never shortens
 * the horizon or moves entry. Existing resolutions remain immutable.
 */
export function resolveForwardObservation(observation, assetBars, benchmarkBars, { now } = {}) {
  if (!observation || observation.resolution !== null && observation.resolution !== undefined) return observation;
  const nowMs = timestamp(now);
  if (!validObservation(observation) || nowMs === null || !validBars(assetBars) || !validBars(benchmarkBars)) return observation;
  const captured = timestamp(observation.observedAt);
  if (captured > nowMs || benchmarkBars[0].time > captured) return observation;
  const entryIndex = benchmarkBars.findIndex((bar) => bar.time >= captured);
  if (entryIndex < 0) return observation;
  const sessions = benchmarkBars.slice(entryIndex, entryIndex + observation.horizonSessions);
  if (sessions.length !== observation.horizonSessions) return observation;
  const assetByTime = new Map(assetBars.map((bar) => [bar.time, bar]));
  const aligned = [];
  for (const benchmark of sessions) {
    const asset = assetByTime.get(benchmark.time);
    if (!asset || asset.closeTime !== benchmark.closeTime || asset.closeTime > nowMs || benchmark.closeTime > nowMs) return observation;
    aligned.push(asset);
  }
  const entry = aligned[0];
  const exit = aligned.at(-1);
  const benchmarkEntry = sessions[0];
  const benchmarkExit = sessions.at(-1);
  const costFraction = observation.roundTripCostBps / 10_000;
  const grossReturn = exit.close / entry.open - 1;
  const benchmarkGrossReturn = benchmarkExit.close / benchmarkEntry.open - 1;
  const netReturn = grossReturn - costFraction;
  const benchmarkNetReturn = benchmarkGrossReturn - costFraction;
  if (![grossReturn, benchmarkGrossReturn, netReturn, benchmarkNetReturn].every(Number.isFinite)) return observation;
  const resolution = Object.freeze({
    kind: 'simulated_daily_outcome',
    status: 'resolved',
    noTradeExecuted: true,
    resolvedAt: new Date(nowMs).toISOString(),
    entryAt: new Date(entry.time).toISOString(),
    exitAt: new Date(exit.closeTime).toISOString(),
    horizonSessions: observation.horizonSessions,
    completedSessions: sessions.length,
    entryPrice: entry.open,
    exitPrice: exit.close,
    benchmarkEntryPrice: benchmarkEntry.open,
    benchmarkExitPrice: benchmarkExit.close,
    roundTripCostBps: observation.roundTripCostBps,
    costFraction,
    grossReturn,
    netReturn,
    benchmarkGrossReturn,
    benchmarkNetReturn,
    excessReturn: netReturn - benchmarkNetReturn,
    costMethod: 'Subtract roundTripCostBps/10000 from each gross return; no compounded cost or actual fill assumption.',
    methodology: 'Hypothetical long exposure from first session open at/after observation through Nth aligned session close; applies to all research decisions, not an executed strategy.'
  });
  return Object.freeze({ ...observation, resolution });
}
