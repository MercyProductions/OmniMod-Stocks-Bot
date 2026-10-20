import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDataDir, paths, readJson, writeJson } from './storage.js';
import { summarizeEdgeEvidence, segmentEdgeEvidence } from './edgeEvidence.js';
import { normalizeCandles } from './technicalAnalysis.js';
import { FEATURE_SCHEMA_VERSION } from './modelFeatures.js';

const DAY_MS = 86_400_000;
const BAR_MS = 15 * 60_000;
const ENTRY_SECOND_MS = 1_000;
export const RESEARCH_LABEL_VERSION = 3;
export const RESEARCH_ENTRY_EVIDENCE_VERSION = 1;
export const RESEARCH_OUTCOME_EVIDENCE_VERSION = 1;
export const MAX_SHADOW_ENTRY_QUOTE_AGE_MS = 30_000;
const EXACT_SOURCE_CANDLE_OUTCOMES = new Set([
  'candle_stop_first', 'candle_protected_stop', 'candle_target', 'deadline_candle',
  'second_stop_first', 'second_protected_stop', 'second_target',
]);
export const isExactSourceCandleOutcome = (reason) => EXACT_SOURCE_CANDLE_OUTCOMES.has(reason);
let appendQueue = Promise.resolve();
const safe = (value) => String(value || 'unknown').replace(/[^0-9a-z_-]/gi, '-').toLowerCase();
const monthKey = (date = new Date()) => new Date(date).toISOString().slice(0, 7);

async function appendLines(file, rows) {
  if (!rows.length) return;
  await ensureDataDir();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function createObservationId(guildId, symbol, horizonKey, now = new Date()) {
  const hourBucket = Math.floor(new Date(now).getTime() / 3_600_000);
  return `${safe(guildId)}-${safe(symbol)}-${safe(horizonKey)}-${hourBucket}`;
}

export function selectSourcePinnedEntryQuote(asset, now = new Date()) {
  const market = asset?.marketData || {};
  if (!market.candleProvider || !market.candlePair || market.conflicted || market.execution?.blockTrade
    || Number(market.providerCount) < 2) return null;
  const quote = (market.quotes || []).find((row) => row.provider === market.candleProvider
    && row.pair === market.candlePair && row.timestampBasis === 'provider_event');
  const ageMs = new Date(now).getTime() - Date.parse(quote?.observedAt || '');
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!(bid > 0 && ask >= bid) || !Number.isFinite(ageMs) || ageMs < 0
    || ageMs > MAX_SHADOW_ENTRY_QUOTE_AGE_MS) return null;
  return { provider: quote.provider, pair: quote.pair, observedAt: quote.observedAt, ageMs, bid, ask };
}

export async function appendResearchEvents(events = []) {
  const valid = events.filter((event) => event?.type && event?.observationId && event?.timestamp);
  if (!valid.length) return 0;
  appendQueue = appendQueue.catch(() => {}).then(async () => {
    const groups = new Map();
    for (const event of valid) {
      const file = path.join(paths.researchDir(), `observations-${monthKey(event.timestamp)}.ndjson`);
      groups.set(file, [...(groups.get(file) || []), event]);
    }
    for (const [file, rows] of groups) await appendLines(file, rows);
  });
  await appendQueue;
  return valid.length;
}

export async function recordShadowCandidates(rows = [], now = new Date()) {
  const timestamp = new Date(now).toISOString();
  const existing = new Set(materializeObservations(await readResearchEvents({ months: 2 })).map((row) => row.observationId));
  const events = rows.map((row) => ({
    type: 'shadow_created', timestamp,
    observationId: row.observationId || createObservationId(row.guildId, row.symbol, row.horizonKey, now),
    ...row, version: RESEARCH_LABEL_VERSION, createdAt: row.createdAt || timestamp
  })).filter((event) => !existing.has(event.observationId));
  return appendResearchEvents(events);
}

async function listObservationFiles(months = 24) {
  await ensureDataDir();
  await fs.mkdir(paths.researchDir(), { recursive: true, mode: 0o700 });
  const cutoff = Date.now() - Math.max(1, months) * 31 * DAY_MS;
  return (await fs.readdir(paths.researchDir()).catch(() => []))
    .filter((name) => /^observations-\d{4}-\d{2}\.ndjson$/.test(name))
    .filter((name) => new Date(`${name.slice(13, 20)}-01T00:00:00Z`).getTime() >= cutoff)
    .sort().map((name) => path.join(paths.researchDir(), name));
}

export async function readResearchEvents(options = {}) {
  const files = await listObservationFiles(Number(options.months) || 24);
  const limit = Math.max(100, Number(options.limit) || 200_000);
  const events = [];
  for (const file of files) {
    const lines = String(await fs.readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* tolerate a truncated final line */ }
    }
  }
  return events.slice(-limit);
}

export function materializeObservations(events = []) {
  const byId = new Map();
  for (const event of events) {
    if (!event?.observationId) continue;
    const current = byId.get(event.observationId) || {};
    if (event.type === 'shadow_created') byId.set(event.observationId, { ...current, ...event });
    else if (event.type === 'shadow_resolved') byId.set(event.observationId, { ...current, resolution: event });
  }
  return [...byId.values()];
}

function hasFiniteValue(value) {
  return value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
}

function hasSourcePinnedEntryEvidence(row) {
  return row?.entryEvidenceVersion === RESEARCH_ENTRY_EVIDENCE_VERSION
    && row.entryQuoteBasis === 'same_source_ask' && row.entryQuoteProvider === row.candleProvider
    && row.entryQuotePair === row.candlePair && hasFiniteValue(row.entryQuoteAsk)
    && Number(row.entryQuoteAsk) > 0 && hasFiniteValue(row.entryPrice)
    && Math.abs(Number(row.entryPrice) - Number(row.entryQuoteAsk)) <= 1e-9 * Number(row.entryQuoteAsk)
    && hasFiniteValue(row.entryQuoteAgeMs) && Number(row.entryQuoteAgeMs) >= 0
    && Number(row.entryQuoteAgeMs) <= MAX_SHADOW_ENTRY_QUOTE_AGE_MS
    && Number.isFinite(Date.parse(row.entryQuoteObservedAt || ''))
    && Math.abs(Date.parse(row.createdAt || '') - Date.parse(row.entryQuoteObservedAt)
      - Number(row.entryQuoteAgeMs)) <= 1_000;
}

/** Only complete, source-pinned version-3 outcomes are eligible for model targets. */
export function normalizeLabeledObservations(rows = []) {
  return rows
    .filter((row) => {
      const result = row?.resolution;
      // Experimental discovery cohorts require a deliberate reviewed promotion;
      // accumulating labels must not silently train the production model.
      if (row?.excludedFromProductionLearning === true || row?.researchCohort === 'full-venue-discovery-v1') return false;
      if (!row?.features || row.featureSchemaVersion !== FEATURE_SCHEMA_VERSION || row.version !== RESEARCH_LABEL_VERSION
        || !result || result.version !== RESEARCH_LABEL_VERSION
        || !row.candleProvider || !row.candlePair || result.candleProvider !== row.candleProvider
        || result.candlePair !== row.candlePair || result.priceBasis !== 'completed_source_candles'
        || !isExactSourceCandleOutcome(result.reason)
        || !hasSourcePinnedEntryEvidence(row)) return false;
      const label = hasFiniteValue(result.label) ? Number(result.label) : NaN;
      const targetLabel = hasFiniteValue(result.targetLabel) ? Number(result.targetLabel) : NaN;
      const realizedR = hasFiniteValue(result.realizedR) ? Number(result.realizedR) : NaN;
      const costs = hasFiniteValue(result.estimatedCostPct) ? Number(result.estimatedCostPct) : NaN;
      const timeToEvent = hasFiniteValue(result.timeToEventMinutes) ? Number(result.timeToEventMinutes) : NaN;
      const favorable = hasFiniteValue(result.maxFavorableExcursionR) ? Number(result.maxFavorableExcursionR) : NaN;
      const adverse = hasFiniteValue(result.maxAdverseExcursionR) ? Number(result.maxAdverseExcursionR) : NaN;
      const completedAt = Date.parse(result.timestamp || '');
      return (label === 0 || label === 1) && (targetLabel === 0 || targetLabel === 1)
        && Number.isFinite(realizedR) && label === (realizedR > 0 ? 1 : 0)
        && Number.isFinite(costs) && costs >= 0
        && Number.isFinite(timeToEvent) && timeToEvent > 0
        && Number.isFinite(favorable) && favorable >= 0
        && Number.isFinite(adverse) && adverse <= 0
        && Number.isFinite(completedAt) && completedAt <= Date.now();
    })
    .map((row) => ({
      observationId: row.observationId, createdAt: row.createdAt, deadlineAt: row.deadlineAt,
      guildId: row.guildId, symbol: row.symbol, horizonKey: row.horizonKey,
      entryPrice: Number(row.entryPrice) || 0, targetPrice: Number(row.targetPrice) || 0, stopPrice: Number(row.stopPrice) || 0,
      stopPct: Number(row.entryPrice) > 0 ? (Number(row.entryPrice) - Number(row.stopPrice)) / Number(row.entryPrice) * 100 : 0,
      assetClass: row.assetClass, regimeKey: row.regimeKey, featureSchemaVersion: row.featureSchemaVersion, features: row.features,
      label: Number(row.resolution.label), realizedR: Number(row.resolution.realizedR),
      estimatedCostPct: Number(row.resolution.estimatedCostPct),
      targetLabel: Number(row.resolution.targetLabel),
      outcomeClass: String(row.resolution.outcomeClass || (row.resolution.label ? 'deadline_win' : 'deadline_loss')),
      timeToEventMinutes: Number(row.resolution.timeToEventMinutes),
      maxFavorableExcursionR: Number(row.resolution.maxFavorableExcursionR),
      maxAdverseExcursionR: Number(row.resolution.maxAdverseExcursionR),
      resolvedAt: row.resolution.timestamp, resolutionReason: row.resolution.reason
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function loadLabeledObservations(options = {}) {
  return normalizeLabeledObservations(materializeObservations(await readResearchEvents(options)));
}

function conflictingSourceBars(rows = []) {
  const byTime = new Map();
  for (const row of rows) {
    const time = Number(row?.time);
    const values = ['open', 'high', 'low', 'close', 'volume'].map((key) => Number(row?.[key]));
    if (!Number.isFinite(time) || values.some((value) => !Number.isFinite(value))) return true;
    const prior = byTime.get(time);
    if (prior && prior.some((value, index) => value !== values[index])) return true;
    byTime.set(time, values);
  }
  return false;
}

export function selectObservationCandles(rows = [], observation = {}) {
  if (observation.version !== RESEARCH_LABEL_VERSION || !observation.candleProvider || !observation.candlePair) return [];
  const createdMs = Date.parse(observation.createdAt);
  const deadlineMs = Date.parse(observation.deadlineAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(deadlineMs)) return [];
  const matching = rows.filter((bar) => bar.provider === observation.candleProvider
    && bar.pair === observation.candlePair && Number(bar.time) >= Math.floor(createdMs / BAR_MS) * BAR_MS
    && Number(bar.time) < deadlineMs);
  if (conflictingSourceBars(matching)) return [];
  return normalizeCandles(matching).map((bar) => ({ ...bar, provider: observation.candleProvider,
    pair: observation.candlePair }));
}

function sourcePinnedEntryBarIssue(row, complete, createdMs, entry, stop, partialTarget) {
  const firstFullOpen = Math.ceil(createdMs / BAR_MS) * BAR_MS;
  if (row.version !== RESEARCH_LABEL_VERSION || firstFullOpen <= createdMs) return null;
  const partial = complete.find((bar) => bar.time === firstFullOpen - BAR_MS);
  if (!partial) return 'entry_containing_candle_missing';
  // The containing bar started before the quote that froze entry. Its extremes
  // cannot establish whether a barrier was touched before or after that quote.
  if (partial.low <= stop || partial.high >= partialTarget) return 'entry_containing_candle_ambiguous';
  return null;
}

// A complete same-source 1-second path can prove that the otherwise ambiguous
// entry-containing 15-minute bar had no post-observation stop or first target.
// A barrier in the containing second still has unknown order around creation.
export function inspectSourcePinnedEntrySeconds(row, seconds = [], now = new Date()) {
  const createdMs = Date.parse(row?.createdAt || '');
  const deadlineMs = Date.parse(row?.deadlineAt || '');
  const nowMs = new Date(now).getTime();
  const entry = Number(row?.entryPrice);
  const stop = Number(row?.stopPrice);
  const partialTarget = Number(row?.partialTargetPrice) || entry + (entry - stop);
  const firstFullOpen = Math.ceil(createdMs / BAR_MS) * BAR_MS;
  const firstSecondOpen = Math.floor(createdMs / ENTRY_SECOND_MS) * ENTRY_SECOND_MS;
  const count = (firstFullOpen - firstSecondOpen) / ENTRY_SECOND_MS;
  if (row?.version !== RESEARCH_LABEL_VERSION || !row?.candleProvider || !row?.candlePair
    || ![createdMs, deadlineMs, nowMs, entry, stop, partialTarget].every(Number.isFinite)
    || !(entry > stop && stop > 0 && partialTarget > entry)
    || !(count > 0 && count <= BAR_MS / ENTRY_SECOND_MS && firstFullOpen <= deadlineMs))
    return { status: 'invalid_entry_segment' };
  if (!Array.isArray(seconds) || seconds.length !== count || firstFullOpen > nowMs)
    return { status: 'incomplete_entry_seconds' };
  let maxHigh = entry;
  let minLow = entry;
  for (let index = 0; index < seconds.length; index += 1) {
    const bar = seconds[index];
    const values = [bar?.open, bar?.high, bar?.low, bar?.close];
    const [open, high, low, close] = values.map(Number);
    if (bar?.provider !== row.candleProvider || bar?.pair !== row.candlePair
      || !hasFiniteValue(bar?.time) || Number(bar.time) !== firstSecondOpen + index * ENTRY_SECOND_MS
      || !values.every(hasFiniteValue)
      || !(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close)))
      return { status: 'invalid_entry_seconds' };
  }
  for (let index = 0; index < seconds.length; index += 1) {
    const bar = seconds[index];
    const high = Number(bar.high), low = Number(bar.low);
    if (index === 0) {
      if (low <= stop || high >= partialTarget) return { status: 'entry_second_ambiguous' };
    } else {
      if (low <= stop || high >= partialTarget) return { status: 'post_entry_barrier_in_finer_data' };
      maxHigh = Math.max(maxHigh, high);
      minLow = Math.min(minLow, low);
    }
  }
  return { status: 'clear', intervalMs: ENTRY_SECOND_MS, barCount: count,
    firstOpenAt: new Date(firstSecondOpen).toISOString(),
    lastCompletedAt: new Date(firstFullOpen).toISOString(),
    excursionCoverage: 'excludes_entry_containing_second', maxHigh, minLow };
}

// Complete seconds can audit the otherwise unobserved final part of an
// unaligned deadline. The last subsecond is deliberately not called exact.
export function inspectSourcePinnedDeadlineSeconds(row, seconds = [], now = new Date()) {
  const deadlineMs = Date.parse(row?.deadlineAt || '');
  const nowMs = new Date(now).getTime();
  const startMs = Math.floor(deadlineMs / BAR_MS) * BAR_MS;
  const lastCompleteMs = Math.floor(deadlineMs / ENTRY_SECOND_MS) * ENTRY_SECOND_MS;
  const count = (lastCompleteMs - startMs) / ENTRY_SECOND_MS;
  if (row?.version !== RESEARCH_LABEL_VERSION || !row?.candleProvider || !row?.candlePair
    || ![deadlineMs, nowMs, startMs, lastCompleteMs].every(Number.isFinite)
    || !(count > 0 && count < BAR_MS / ENTRY_SECOND_MS && nowMs >= deadlineMs))
    return { status: 'invalid_deadline_segment' };
  if (!Array.isArray(seconds) || seconds.length !== count)
    return { status: 'incomplete_deadline_seconds' };
  for (let index = 0; index < seconds.length; index += 1) {
    const bar = seconds[index];
    const values = [bar?.open, bar?.high, bar?.low, bar?.close];
    const [open, high, low, close] = values.map(Number);
    if (bar?.provider !== row.candleProvider || bar?.pair !== row.candlePair
      || !hasFiniteValue(bar?.time) || Number(bar.time) !== startMs + index * ENTRY_SECOND_MS
      || !values.every(hasFiniteValue)
      || !(low > 0 && low <= Math.min(open, close) && high >= Math.max(open, close)))
      return { status: 'invalid_deadline_seconds' };
  }
  return { status: 'complete', intervalMs: ENTRY_SECOND_MS, barCount: count,
    firstOpenAt: new Date(startMs).toISOString(),
    lastCompletedAt: new Date(lastCompleteMs).toISOString(),
    unobservedTailMs: deadlineMs - lastCompleteMs };
}

export function inspectSourcePinnedEntryBar(row, sourceCandles = [], now = new Date()) {
  if (row?.version !== RESEARCH_LABEL_VERSION || !row?.candleProvider || !row?.candlePair
    || sourceCandles.some((bar) => bar.provider !== row.candleProvider || bar.pair !== row.candlePair)
    || conflictingSourceBars(sourceCandles)) return null;
  const createdMs = Date.parse(row.createdAt);
  const deadlineMs = Date.parse(row.deadlineAt);
  const nowMs = new Date(now).getTime();
  const entry = Number(row.entryPrice);
  const stop = Number(row.stopPrice);
  if (![createdMs, deadlineMs, nowMs, entry, stop].every(Number.isFinite)
    || !(entry > stop && stop > 0)) return null;
  const partialTarget = Number(row.partialTargetPrice) || entry + (entry - stop);
  const complete = normalizeCandles(sourceCandles)
    .filter((bar) => bar.time + BAR_MS <= Math.min(nowMs, deadlineMs));
  return sourcePinnedEntryBarIssue(row, complete, createdMs, entry, stop, partialTarget);
}

async function readStoredCandles(symbol, cache = null) {
  const key = safe(symbol);
  if (cache?.has(key)) return cache.get(key);
  const names = (await fs.readdir(paths.researchDir()).catch(() => []))
    .filter((name) => name.startsWith(`candles-${key}-`) && name.endsWith('.ndjson')).sort().slice(-3);
  const candles = [];
  for (const name of names) {
    const lines = String(await fs.readFile(path.join(paths.researchDir(), name), 'utf8').catch(() => '')).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      try { candles.push(JSON.parse(line)); } catch { /* tolerate partial append */ }
    }
  }
  cache?.set(key, candles);
  return candles;
}

export async function inspectStoredSourcePinnedEntryBar(row, now = new Date()) {
  const matching = selectObservationCandles(await readStoredCandles(row.symbol), row);
  return inspectSourcePinnedEntryBar(row, matching, now);
}

// Candle timestamps denote opens. Never inspect a candle extending past the
// observation window or use a post-deadline quote as an on-time training label.
export function resolveObservation(row, sourceCandles = [], currentPrice, now = new Date(), options = {}) {
  const createdMs = Date.parse(row.createdAt);
  const deadlineMs = Date.parse(row.deadlineAt);
  const nowMs = new Date(now).getTime();
  const entry = Number(row.entryPrice);
  const stop = Number(row.stopPrice);
  const target = Number(row.targetPrice);
  const risk = entry - stop;
  if (![createdMs, deadlineMs, nowMs, entry, stop, target].every(Number.isFinite)
    || !(entry > stop && stop > 0 && target > entry)) return null;
  const sourcePinned = row.version === RESEARCH_LABEL_VERSION;
  if (sourcePinned && (!row.candleProvider || !row.candlePair)) return null;
  if (sourcePinned && (sourceCandles.some((bar) => bar.provider !== row.candleProvider
    || bar.pair !== row.candlePair) || conflictingSourceBars(sourceCandles))) return null;
  const costR = Math.max(0, Number(row.estimatedCostPct) || 0) / 100 * entry / risk;
  const partialTarget = Number(row.partialTargetPrice) || entry + risk;
  const complete = normalizeCandles(sourceCandles).filter((bar) => bar.time + BAR_MS <= Math.min(nowMs, deadlineMs));
  const firstFullOpen = Math.ceil(createdMs / BAR_MS) * BAR_MS;
  const entryBarIssue = sourcePinnedEntryBarIssue(row, complete, createdMs, entry, stop, partialTarget);
  const entrySeconds = entryBarIssue === 'entry_containing_candle_ambiguous'
    ? inspectSourcePinnedEntrySeconds(row, options.entrySecondCandles, now) : null;
  if (entryBarIssue && entrySeconds?.status !== 'clear') return null;
  const candles = complete.filter((bar) => bar.time >= firstFullOpen);
  let partial = false;
  let maxFavorableExcursionR = entrySeconds?.status === 'clear'
    ? Math.max(0, (entrySeconds.maxHigh - entry) / risk) : 0;
  let maxAdverseExcursionR = entrySeconds?.status === 'clear'
    ? Math.min(0, (entrySeconds.minLow - entry) / risk) : 0;
  let deadlineSecondEvidence = null;
  const settle = (price, reason, eventTime, targetHit = false) => {
    const remainingR = (price - entry) / risk;
    const realizedR = (partial ? 0.5 + remainingR * 0.5 : remainingR) - costR;
    return {
      type: 'shadow_resolved', version: sourcePinned ? RESEARCH_LABEL_VERSION : 2,
      ...(sourcePinned ? { candleProvider: row.candleProvider, candlePair: row.candlePair,
        priceBasis: deadlineSecondEvidence
          ? 'completed_source_candles_with_second_deadline_audit'
          : entrySeconds?.status === 'clear'
            ? 'completed_source_candles_with_second_entry_clearance' : 'completed_source_candles',
        ...(entrySeconds?.status === 'clear' ? { entrySegmentEvidence: entrySeconds } : {}),
        ...(deadlineSecondEvidence ? { deadlineSegmentEvidence: deadlineSecondEvidence } : {}) } : {}),
      timestamp: new Date(nowMs).toISOString(), observationId: row.observationId,
      label: realizedR > 0 ? 1 : 0, targetLabel: targetHit ? 1 : 0,
      outcomeClass: targetHit ? 'target' : reason.includes('stop') ? 'stop' : realizedR > 0 ? 'deadline_win' : 'deadline_loss',
      reason, currentPrice: price, realizedR, estimatedCostPct: Number(row.estimatedCostPct) || 0,
      timeToEventMinutes: Math.max(1, (eventTime - createdMs) / 60_000),
      maxFavorableExcursionR, maxAdverseExcursionR, candleCount: candles.length,
      ...(deadlineSecondEvidence ? { secondBarCount: deadlineSecondEvidence.barCount } : {})
    };
  };
  let expectedOpen = firstFullOpen;
  for (const bar of candles) {
    // Missing intervals can hide an earlier stop; do not infer a later winner.
    if (bar.time !== expectedOpen) return null;
    expectedOpen += 900_000;
    maxFavorableExcursionR = Math.max(maxFavorableExcursionR, (bar.high - entry) / risk);
    maxAdverseExcursionR = Math.min(maxAdverseExcursionR, (bar.low - entry) / risk);
    const floor = partial ? entry : stop;
    if (bar.low <= floor) return settle(Math.min(floor, bar.open), 'candle_stop_first', bar.time + 900_000);
    if (!partial && bar.high >= partialTarget) {
      partial = true;
      if (bar.low <= entry) return settle(entry, 'candle_protected_stop', bar.time + 900_000);
    }
    if (bar.high >= target) return settle(target, 'candle_target', bar.time + 900_000, true);
  }
  if (sourcePinned && options.deadlineSecondCandles && nowMs >= deadlineMs) {
    const evidence = inspectSourcePinnedDeadlineSeconds(row, options.deadlineSecondCandles, now);
    if (evidence.status !== 'complete' || Date.parse(evidence.firstOpenAt) !== expectedOpen) return null;
    deadlineSecondEvidence = evidence;
    for (const bar of options.deadlineSecondCandles) {
      const high = Number(bar.high), low = Number(bar.low);
      const open = Number(bar.open), end = Number(bar.time) + ENTRY_SECOND_MS;
      maxFavorableExcursionR = Math.max(maxFavorableExcursionR, (high - entry) / risk);
      maxAdverseExcursionR = Math.min(maxAdverseExcursionR, (low - entry) / risk);
      const floor = partial ? entry : stop;
      if (low <= floor) return settle(Math.min(floor, open), 'second_stop_first', end);
      if (!partial && high >= partialTarget) {
        partial = true;
        if (low <= entry) return settle(entry, 'second_protected_stop', end);
      }
      if (high >= target) return settle(target, 'second_target', end, true);
    }
    const last = options.deadlineSecondCandles.at(-1);
    return settle(Number(last.close), 'deadline_last_completed_second',
      Number(last.time) + ENTRY_SECOND_MS);
  }
  if (sourcePinned && options.requireDeadlineSecondEvidence && nowMs >= deadlineMs
    && deadlineMs % BAR_MS !== 0) return null;
  // Use the latest completed candle at/before the deadline, explicitly marking
  // the up-to-15-minute approximation. Never use a later quote for that window.
  if (nowMs > deadlineMs) {
    const deadlineCandle = candles.at(-1);
    const closeMs = deadlineCandle ? deadlineCandle.time + 900_000 : NaN;
    return deadlineCandle && deadlineMs - closeMs < 900_000
      ? settle(deadlineCandle.close, closeMs === deadlineMs ? 'deadline_candle' : 'deadline_last_closed_candle', closeMs) : null;
  }
  if (sourcePinned) return null;
  if (!(Number.isFinite(currentPrice) && currentPrice > 0)) return null;
  maxFavorableExcursionR = Math.max(maxFavorableExcursionR, (currentPrice - entry) / risk);
  maxAdverseExcursionR = Math.min(maxAdverseExcursionR, (currentPrice - entry) / risk);
  if (currentPrice <= (partial ? entry : stop)) return settle(currentPrice, 'stop_observed', nowMs);
  if (currentPrice >= target) { partial = true; return settle(target, 'target_observed', nowMs, true); }
  if (nowMs === deadlineMs) return settle(currentPrice, 'deadline_observed', nowMs);
  return null;
}

export async function resolvePendingObservations(currentAssets = [], now = new Date(), options = {}) {
  const events = await readResearchEvents({ months: Number(options.months) || 3 });
  const pending = materializeObservations(events).filter((row) => row.type === 'shadow_created'
    && row.version === RESEARCH_LABEL_VERSION && row.candleProvider && row.candlePair && !row.resolution);
  const resolved = [];
  const candleCache = new Map();
  for (const row of pending) {
    const matchingCandles = selectObservationCandles(await readStoredCandles(row.symbol, candleCache), row);
    const resolution = resolveObservation(row, matchingCandles, null, now, {
      entrySecondCandles: options.entrySecondsByObservationId?.get(row.observationId),
      deadlineSecondCandles: options.deadlineSecondsByObservationId?.get(row.observationId),
      requireDeadlineSecondEvidence: options.requireDeadlineSecondsIds?.has(row.observationId),
    });
    if (resolution) resolved.push(resolution);
    else if (typeof options.onUnresolved === 'function') options.onUnresolved(row.observationId,
      inspectSourcePinnedEntryBar(row, matchingCandles, now) || 'candle_path_or_deadline_unavailable');
  }
  await appendResearchEvents(resolved);
  return resolved;
}

export async function appendCandleBatch(symbol, provider, candles = [], pair = '') {
  const rows = normalizeCandles(candles).filter((row) => row.time + 900_000 <= Date.now());
  if (!rows.length) return 0;
  let appended = 0;
  appendQueue = appendQueue.catch(() => {}).then(async () => {
    const indexFile = path.join(paths.researchDir(), 'candle-index.json');
    const index = await readJson(indexFile, {});
    const key = `${safe(provider)}:${safe(symbol)}:${safe(pair)}`;
    const last = Number(index[key]) || 0;
    const fresh = rows.filter((row) => row.time > last).map((row) => ({ ...row, symbol: String(symbol).toUpperCase(), provider, pair }));
    const groups = new Map();
    for (const row of fresh) {
      const file = path.join(paths.researchDir(), `candles-${safe(symbol)}-${monthKey(row.time)}.ndjson`);
      groups.set(file, [...(groups.get(file) || []), row]);
    }
    for (const [file, batch] of groups) await appendLines(file, batch);
    if (fresh.length) {
      index[key] = fresh.at(-1).time;
      await writeJson(indexFile, index);
    }
    appended = fresh.length;
  });
  await appendQueue;
  return appended;
}

export async function pruneResearch(retentionDays = 730, now = new Date()) {
  await ensureDataDir();
  await fs.mkdir(paths.researchDir(), { recursive: true, mode: 0o700 });
  const cutoff = new Date(now).getTime() - Math.max(30, Number(retentionDays) || 730) * DAY_MS;
  let removed = 0;
  for (const entry of await fs.readdir(paths.researchDir(), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\d{4}-\d{2}\.ndjson$/.test(entry.name)) continue;
    const match = entry.name.match(/(\d{4}-\d{2})\.ndjson$/);
    if (match && new Date(`${match[1]}-01T00:00:00Z`).getTime() + 35 * DAY_MS < cutoff) {
      await fs.unlink(path.join(paths.researchDir(), entry.name)).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

export function summarizeLiquidityShadowCohorts(rows = [], options = {}) {
  const liquidityShadowRows = rows.filter((row) => row.counterfactuals?.version === 'execution-liquidity-v1'
    && hasFiniteValue(row.counterfactuals.score));
  const liquidityShadowResolved = liquidityShadowRows.filter((row) => row.resolution?.version >= 2
    && row.version === RESEARCH_LABEL_VERSION && row.resolution.version === RESEARCH_LABEL_VERSION
    && hasSourcePinnedEntryEvidence(row)
    && row.candleProvider && row.candlePair && row.resolution.candleProvider === row.candleProvider
    && row.resolution.candlePair === row.candlePair
    && row.resolution.priceBasis === 'completed_source_candles'
    && isExactSourceCandleOutcome(row.resolution.reason)
    && hasFiniteValue(row.resolution.realizedR))
    .sort((a, b) => Number(a.counterfactuals.score) - Number(b.counterfactuals.score));
  const split = Math.floor(liquidityShadowResolved.length / 2);
  const summarizeHalf = (observations) => {
    if (!observations.length) return null;
    const evidence = summarizeEdgeEvidence(observations.map((row) => ({
      observationId: row.observationId,
      realizedR: row.resolution.realizedR,
      completedAt: row.createdAt || row.resolution.timestamp
    })), { minimumSamples: options.minimumSamples ?? 20, minimumDays: options.minimumDays ?? 5 });
    return {
      n: evidence.samples,
      observationDays: evidence.independentDayClusters,
      meanR: evidence.expectancyR,
      lower95R: evidence.lower95R,
      upper95R: evidence.upper95R,
      status: evidence.status
    };
  };
  const pending = liquidityShadowRows.filter((row) => !row.resolution).length;
  const unusableResolved = liquidityShadowRows.length - liquidityShadowResolved.length - pending;
  return {
    observed: liquidityShadowRows.length, resolved: liquidityShadowResolved.length, pending, unusableResolved,
    minimumPerHalf: Math.max(10, Number(options.minimumSamples) || 20),
    minimumDays: Math.max(5, Number(options.minimumDays) || 5),
    lowerHalf: split > 0 ? summarizeHalf(liquidityShadowResolved.slice(0, split)) : null,
    upperHalf: split > 0 ? summarizeHalf(liquidityShadowResolved.slice(-split)) : null
  };
}

/** Descriptive outcomes for the independent venue cohort, never fills or model-training labels. */
export function summarizeVenueResearchRows(rows = [], { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Venue research report time must be finite.');
  const cohort = rows.filter((row) => row?.type === 'shadow_created' && row.researchCohort === 'full-venue-discovery-v1');
  const pending = cohort.filter((row) => !row.resolution), exact = [], approximate = [], exclusions = {};
  const finite = (value) => hasFiniteValue(value) && !(typeof value === 'string' && !value.trim());
  const reject = (reason) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
  const date = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
  const bases = new Set(['completed_source_candles', 'completed_source_candles_with_second_entry_clearance',
    'completed_source_candles_with_second_deadline_audit']);
  const approximateReasons = new Set(['deadline_last_closed_candle', 'deadline_last_completed_second']);
  for (const row of cohort.filter((item) => item.resolution)) {
    const result = row.resolution, created = date(row.createdAt), deadline = date(row.deadlineAt), resolved = date(result.timestamp);
    if (row.version !== RESEARCH_LABEL_VERSION || result.version !== RESEARCH_LABEL_VERSION) { reject('unsupported_label_version'); continue; }
    if (!row.candleProvider || !row.candlePair || result.candleProvider !== row.candleProvider || result.candlePair !== row.candlePair
      || !bases.has(result.priceBasis) || (!isExactSourceCandleOutcome(result.reason) && !approximateReasons.has(result.reason))) {
      reject('source_or_outcome_basis_unverified'); continue;
    }
    if (!hasSourcePinnedEntryEvidence(row)) { reject('entry_quote_evidence_missing'); continue; }
    if (![created, deadline, resolved].every(Number.isFinite) || created >= deadline || resolved < created || resolved > now
      || !finite(result.timeToEventMinutes) || Number(result.timeToEventMinutes) <= 0
      || Number(result.timeToEventMinutes) > (Math.min(resolved, deadline) - created) / 60_000 + 1e-6) {
      reject('invalid_observation_timing'); continue;
    }
    if (![row.entryPrice, row.stopPrice, row.targetPrice, result.realizedR, row.estimatedCostPct, result.estimatedCostPct,
      result.maxFavorableExcursionR, result.maxAdverseExcursionR, result.currentPrice].every(finite)
      || !(Number(row.entryPrice) > Number(row.stopPrice) && Number(row.stopPrice) > 0 && Number(row.targetPrice) > Number(row.entryPrice))
      || Number(result.currentPrice) <= 0 || Number(row.estimatedCostPct) < 0
      || Math.abs(Number(result.estimatedCostPct) - Number(row.estimatedCostPct)) > 1e-9
      || Number(result.maxFavorableExcursionR) < 0 || Number(result.maxAdverseExcursionR) > 0
      || ![0, 1].includes(result.label) || result.label !== (Number(result.realizedR) > 0 ? 1 : 0)
      || ![0, 1].includes(result.targetLabel)) { reject('invalid_cost_or_outcome_values'); continue; }
    const stopPct = (Number(row.entryPrice) - Number(row.stopPrice)) / Number(row.entryPrice) * 100;
    const netPct = Number(result.realizedR) * stopPct;
    const risk = Number(row.entryPrice) - Number(row.stopPrice), costR = Number(row.estimatedCostPct) / stopPct;
    const remainingR = (Number(result.currentPrice) - Number(row.entryPrice)) / risk;
    const possibleNetR = [remainingR - costR];
    const partialR = finite(row.partialTargetPrice) ? (Number(row.partialTargetPrice) - Number(row.entryPrice)) / risk : 1;
    if (partialR > 0 && Number(result.maxFavorableExcursionR) >= partialR - 1e-8) possibleNetR.push(0.5 + remainingR * 0.5 - costR);
    if (![stopPct, netPct, netPct + Number(row.estimatedCostPct)].every(Number.isFinite)
      || !possibleNetR.some((value) => Number.isFinite(value) && Math.abs(value - Number(result.realizedR)) <= 1e-8 * Math.max(1, Math.abs(value)))) {
      reject('modeled_return_does_not_reconcile'); continue;
    }
    const observation = { row, netR: Number(result.realizedR), netPct,
      grossPct: netPct + Number(result.estimatedCostPct), costPct: Number(result.estimatedCostPct) };
    (approximateReasons.has(result.reason) ? approximate : exact).push(observation);
  }
  const summarize = (items) => {
    const mean = (key) => items.length ? items.reduce((sum, item) => sum + item[key], 0) / items.length : null;
    const reasons = {};
    for (const item of items) reasons[item.row.resolution.reason] = (reasons[item.row.resolution.reason] || 0) + 1;
    const mfe = items.map((item) => Number(item.row.resolution.maxFavorableExcursionR));
    const mae = items.map((item) => Number(item.row.resolution.maxAdverseExcursionR));
    return { sampleSize: items.length, entryUtcDays: new Set(items.map((item) => new Date(date(item.row.createdAt)).toISOString().slice(0, 10))).size,
      positiveModeledOutcomes: items.filter((item) => item.netR > 0).length,
      negativeModeledOutcomes: items.filter((item) => item.netR < 0).length,
      flatModeledOutcomes: items.filter((item) => item.netR === 0).length,
      meanModeledNetR: mean('netR'), meanModeledNetReturnPct: mean('netPct'), meanModeledGrossReturnPct: mean('grossPct'),
      meanFrozenCostPct: mean('costPct'),
      meanMfeR: mfe.length ? mfe.reduce((a, b) => a + b, 0) / mfe.length : null,
      meanMaeR: mae.length ? mae.reduce((a, b) => a + b, 0) / mae.length : null,
      worstObservedMaeR: mae.length ? mae.reduce((worst, value) => Math.min(worst, value), 0) : null, reasons };
  };
  const deadlines = pending.map((row) => date(row.deadlineAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const futureDeadline = deadlines.find((time) => time > now);
  const routingVersion = row => typeof row.pairRoutingVersion === 'string' && row.pairRoutingVersion.trim()
    ? row.pairRoutingVersion : 'legacy_or_unrecorded';
  const byPairRoutingVersion = [...new Set(cohort.map(routingVersion))].sort().map(version => {
    const group = cohort.filter(row => routingVersion(row) === version);
    const exactGroup = exact.filter(item => routingVersion(item.row) === version);
    const approximateGroup = approximate.filter(item => routingVersion(item.row) === version);
    const resolved = group.filter(row => row.resolution).length;
    return { version, observed: group.length, pending: group.length - resolved, resolved,
      excludedResolved: resolved - exactGroup.length - approximateGroup.length,
      exactCandleOutcomes: summarize(exactGroup), approximateDeadlineAudits: summarize(approximateGroup) };
  });
  return { cohort: 'full-venue-discovery-v1', asOf: new Date(now).toISOString(), status: 'descriptive_candle_research_only',
    observed: cohort.length, pending: pending.length, due: deadlines.filter((time) => time <= now).length,
    pendingWithoutValidDeadline: pending.length - deadlines.length, resolved: cohort.length - pending.length,
    excludedResolved: Object.values(exclusions).reduce((a, b) => a + b, 0), exclusionReasons: exclusions,
    nextFutureDeadlineAt: futureDeadline === undefined ? null : new Date(futureDeadline).toISOString(),
    exactCandleOutcomes: summarize(exact), approximateDeadlineAudits: summarize(approximate),
    byPairRoutingVersion,
    fillRate: null, target1HitRate: null, tradingPnlUsd: null, trainingEligible: false, strategyPromotionEligible: false,
    interpretation: 'Recorded observations only, not the discovery universe or executed trades. Candle paths and frozen estimated costs are modeled outcomes; early deadline marks are separate. Fill rates, unrecorded partial-target history and dollar P&L are unmeasured. Small, overlapping or same-day observations do not establish profitability.' };
}

export function summarizeResearchStatusRows(rows = []) {
  const eligible = normalizeLabeledObservations(rows).map((row) => ({ ...row, completedAt: row.resolvedAt }));
  const experiment = (row) => row.excludedFromProductionLearning === true || row.researchCohort === 'full-venue-discovery-v1';
  const currentResolved = rows.filter((row) => !experiment(row) && row.resolution?.version === RESEARCH_LABEL_VERSION).length;
  return {
    eligibleLabeled: eligible.length,
    experimentalExcludedResolved: rows.filter((row) => experiment(row) && row.resolution).length,
    malformedResolved: Math.max(0, currentResolved - eligible.length),
    approximateDeadlineExcludedResolved: rows.filter((row) => row.resolution?.version === RESEARCH_LABEL_VERSION
      && ['deadline_last_closed_candle', 'deadline_last_completed_second']
        .includes(row.resolution.reason)).length,
    entryEvidenceExcludedResolved: rows.filter((row) => row.resolution?.version === RESEARCH_LABEL_VERSION
      && !hasSourcePinnedEntryEvidence(row)).length,
    legacyLabeled: rows.filter((row) => row.resolution && row.resolution.version !== RESEARCH_LABEL_VERSION).length,
    evidence: summarizeEdgeEvidence(eligible), segments: segmentEdgeEvidence(eligible),
    liquidityShadow: summarizeLiquidityShadowCohorts(rows.filter((row) => !experiment(row))),
    venueResearch: summarizeVenueResearchRows(rows),
    total: rows.length, labeled: rows.filter((row) => row.resolution).length,
    pending: rows.filter((row) => !row.resolution).length,
    firstAt: rows[0]?.createdAt || '', lastAt: rows.at(-1)?.createdAt || ''
  };
}

export async function getResearchStatus(options = {}) {
  const events = await readResearchEvents({ months: 24 });
  const rows = materializeObservations(events).filter((row) => !options.guildId || row.guildId === options.guildId);
  return summarizeResearchStatusRows(rows);
}
