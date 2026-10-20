import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scoreAsset } from '../src/cryptoData.js';
import { buildSourcePinnedShadowPrediction } from '../src/shadowEntryEvidence.js';
import { fetchHistoricalCandles } from '../src/marketProviders.js';
import { paths } from '../src/storage.js';
import {
  appendCandleBatch, createObservationId, isExactSourceCandleOutcome, materializeObservations, readResearchEvents,
  inspectSourcePinnedDeadlineSeconds, inspectSourcePinnedEntrySeconds,
  inspectStoredSourcePinnedEntryBar, recordShadowCandidates,
  resolvePendingObservations, RESEARCH_LABEL_VERSION,
} from '../src/researchStore.js';

export const PROBE_GUILD_ID = 'public-probe-research';
const MAX_RESOLUTION_SOURCES = 12;
const MAX_FINER_REQUESTS = 2;
const ONE_SECOND_MS = 1_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const approximateDeadlineReasons = new Set(['deadline_last_closed_candle', 'deadline_last_completed_second']);
const createdUtcDay = (row) => {
  const value = typeof row?.createdAt === 'string' ? row.createdAt : '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};

const entrySecondsPath = (row) => path.join(paths.researchDir(),
  `entry-seconds-${createHash('sha256').update(String(row.observationId)).digest('hex').slice(0, 24)}.json`);
const deadlineSecondsPath = (row) => path.join(paths.researchDir(),
  `deadline-seconds-${createHash('sha256').update(String(row.observationId)).digest('hex').slice(0, 24)}.json`);
const entrySecondsDigest = (candles) => createHash('sha256').update(JSON.stringify(candles)).digest('hex');

async function readEntrySeconds(row) {
  let stored;
  try { stored = JSON.parse(await fs.readFile(entrySecondsPath(row), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : { status: 'entry_seconds_cache_invalid' }; }
  if (stored?.schemaVersion !== 1 || stored.observationId !== row.observationId
    || stored.provider !== row.candleProvider || stored.pair !== row.candlePair
    || stored.createdAt !== row.createdAt || !Array.isArray(stored.candles)
    || stored.sha256 !== entrySecondsDigest(stored.candles))
    return { status: 'entry_seconds_cache_invalid' };
  return { status: 'available', candles: stored.candles };
}

async function storeEntrySeconds(row, candles, now) {
  await fs.mkdir(paths.researchDir(), { recursive: true, mode: 0o700 });
  const stored = { schemaVersion: 1, observationId: row.observationId,
    provider: row.candleProvider, pair: row.candlePair, createdAt: row.createdAt,
    interval: '1s', fetchedAt: new Date(now).toISOString(),
    sha256: entrySecondsDigest(candles), candles };
  try { await fs.writeFile(entrySecondsPath(row), `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function readDeadlineSeconds(row) {
  let stored;
  try { stored = JSON.parse(await fs.readFile(deadlineSecondsPath(row), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : { status: 'deadline_seconds_cache_invalid' }; }
  if (stored?.schemaVersion !== 1 || stored.observationId !== row.observationId
    || stored.provider !== row.candleProvider || stored.pair !== row.candlePair
    || stored.deadlineAt !== row.deadlineAt || !Array.isArray(stored.candles)
    || stored.sha256 !== entrySecondsDigest(stored.candles))
    return { status: 'deadline_seconds_cache_invalid' };
  return { status: 'available', candles: stored.candles };
}

async function storeDeadlineSeconds(row, candles, now) {
  await fs.mkdir(paths.researchDir(), { recursive: true, mode: 0o700 });
  const stored = { schemaVersion: 1, observationId: row.observationId,
    provider: row.candleProvider, pair: row.candlePair, deadlineAt: row.deadlineAt,
    interval: '1s', fetchedAt: new Date(now).toISOString(),
    sha256: entrySecondsDigest(candles), candles };
  try { await fs.writeFile(deadlineSecondsPath(row), `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export async function fetchBinanceEntrySeconds(row, { request = fetch } = {}) {
  const symbol = String(row?.symbol ?? '').toUpperCase();
  const pair = String(row?.candlePair ?? '');
  const createdMs = Date.parse(row?.createdAt || '');
  const startTime = Math.floor(createdMs / ONE_SECOND_MS) * ONE_SECOND_MS;
  const endTime = Math.ceil(createdMs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS - ONE_SECOND_MS;
  const limit = (endTime - startTime) / ONE_SECOND_MS + 1;
  if (row?.candleProvider !== 'Binance' || !/^[A-Z0-9]{2,20}$/.test(symbol)
    || pair !== `${symbol}USDT` || !(limit > 0 && limit <= 900))
    throw new Error('unsupported_finer_source_or_window');
  const url = new URL('https://data-api.binance.vision/api/v3/klines');
  url.search = new URLSearchParams({ symbol: pair, interval: '1s',
    startTime: String(startTime), endTime: String(endTime), limit: String(limit) }).toString();
  const response = await request(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`finer_source_http_${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('finer_source_invalid_payload');
  return data.map((bar) => ({ time: Number(bar?.[0]), open: Number(bar?.[1]),
    high: Number(bar?.[2]), low: Number(bar?.[3]), close: Number(bar?.[4]),
    provider: 'Binance', pair }));
}

export async function fetchBinanceDeadlineSeconds(row, { request = fetch } = {}) {
  const symbol = String(row?.symbol ?? '').toUpperCase();
  const pair = String(row?.candlePair ?? '');
  const deadlineMs = Date.parse(row?.deadlineAt || '');
  const startTime = Math.floor(deadlineMs / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  const lastCompleteBoundary = Math.floor(deadlineMs / ONE_SECOND_MS) * ONE_SECOND_MS;
  const endTime = lastCompleteBoundary - ONE_SECOND_MS;
  const limit = (endTime - startTime) / ONE_SECOND_MS + 1;
  if (row?.candleProvider !== 'Binance' || !/^[A-Z0-9]{2,20}$/.test(symbol)
    || pair !== `${symbol}USDT` || !(limit > 0 && limit < 900))
    throw new Error('unsupported_finer_deadline_source_or_window');
  const url = new URL('https://data-api.binance.vision/api/v3/klines');
  url.search = new URLSearchParams({ symbol: pair, interval: '1s',
    startTime: String(startTime), endTime: String(endTime), limit: String(limit) }).toString();
  const response = await request(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`finer_deadline_http_${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('finer_deadline_invalid_payload');
  return data.map((bar) => ({ time: Number(bar?.[0]), open: Number(bar?.[1]),
    high: Number(bar?.[2]), low: Number(bar?.[3]), close: Number(bar?.[4]),
    provider: 'Binance', pair }));
}

async function publicProbeRows() {
  return materializeObservations(await readResearchEvents({ months: 2 }))
    .filter((row) => row.type === 'shadow_created' && row.version === RESEARCH_LABEL_VERSION
      && row.guildId === PROBE_GUILD_ID);
}

export async function summarizePublicProbeObservations(now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('A valid observation time is required.');
  const rows = await publicProbeRows();
  const pending = rows.filter((row) => !row.resolution);
  const due = pending.filter((row) => Number.isFinite(Date.parse(row.deadlineAt))
    && Date.parse(row.deadlineAt) <= nowMs);
  let dueNeedsFinerData = 0;
  let dueWithCachedFinerClearance = 0;
  for (const row of due) {
    if (await inspectStoredSourcePinnedEntryBar(row, now) !== 'entry_containing_candle_ambiguous') continue;
    const evidence = await readEntrySeconds(row);
    if (evidence?.status === 'available'
      && inspectSourcePinnedEntrySeconds(row, evidence.candles, now).status === 'clear')
      dueWithCachedFinerClearance += 1;
    else dueNeedsFinerData += 1;
  }
  const resolved = rows.filter((row) => row.resolution);
  const byCreationDay = new Map();
  let unknownCreationDay = 0;
  for (const row of rows) {
    const day = createdUtcDay(row);
    if (!day) { unknownCreationDay++; continue; }
    const counts = byCreationDay.get(day) || { created: 0, resolved: 0, pending: 0 };
    counts.created++;
    if (row.resolution) counts.resolved++;
    else counts.pending++;
    byCreationDay.set(day, counts);
  }
  const exactResolved = resolved.filter((row) => isExactSourceCandleOutcome(row.resolution.reason)).length;
  const coarseDeadlineResolved = resolved.filter((row) =>
    row.resolution.reason === 'deadline_last_closed_candle').length;
  const subsecondDeadlineResolved = resolved.filter((row) =>
    row.resolution.reason === 'deadline_last_completed_second').length;
  const approximateDeadline = coarseDeadlineResolved + subsecondDeadlineResolved;
  const byOutcome = new Map();
  const byRejectionCode = new Map();
  for (const row of rows) {
    for (const code of new Set(Array.isArray(row.rejectionCodes) ? row.rejectionCodes : [])) {
      if (typeof code !== 'string' || !code) continue;
      const current = byRejectionCode.get(code) || { created: 0, pending: 0, due: 0,
        resolved: 0, exactResolved: 0, approximateDeadlineResolved: 0 };
      current.created += 1;
      if (row.resolution) {
        current.resolved += 1;
        if (isExactSourceCandleOutcome(row.resolution.reason)) current.exactResolved += 1;
        if (approximateDeadlineReasons.has(row.resolution.reason)) current.approximateDeadlineResolved += 1;
      }
      else {
        current.pending += 1;
        if (Number.isFinite(Date.parse(row.deadlineAt)) && Date.parse(row.deadlineAt) <= nowMs) current.due += 1;
      }
      byRejectionCode.set(code, current);
    }
  }
  for (const row of resolved) {
    const outcome = approximateDeadlineReasons.has(row.resolution.reason)
      ? 'approximate_deadline_audit' : String(row.resolution.outcomeClass || 'unknown');
    byOutcome.set(outcome, (byOutcome.get(outcome) || 0) + 1);
  }
  const pendingDeadlines = pending.map((row) => row.deadlineAt)
    .filter((value) => Number.isFinite(Date.parse(value))).sort();
  const futureDeadlines = pendingDeadlines.filter((value) => Date.parse(value) > nowMs);
  return {
    observedAt: new Date(nowMs).toISOString(), created: rows.length, pending: pending.length,
    due: due.length, dueNeedsFinerData, dueWithCachedFinerClearance,
    dueRetryableWithCurrentBars: due.length - dueNeedsFinerData,
    resolved: resolved.length,
    exactBarrierOrDeadlineResolved: exactResolved,
    approximateDeadlineResolved: approximateDeadline,
    coarseDeadlineResolved, subsecondDeadlineResolved,
    otherOrUnknownResolved: resolved.length - exactResolved - approximateDeadline,
    missingDeadline: pending.length - pendingDeadlines.length,
    nextPendingDeadlineAt: pendingDeadlines[0] || null,
    nextFutureDeadlineAt: futureDeadlines[0] || null,
    resolvedByOutcome: Object.fromEntries(byOutcome),
    creationDayCoverage: {
      distinctUtcDays: byCreationDay.size,
      resolvedEntryUtcDays: [...byCreationDay.values()].filter((counts) => counts.resolved > 0).length,
      unknownCreationDay,
      byUtcDay: Object.fromEntries([...byCreationDay.entries()].sort(([a], [b]) => a.localeCompare(b))),
      interpretation: 'UTC entry-date coverage only; multiple assets or overlapping horizons on one date are correlated and do not constitute independent trading sessions.',
    },
    byRejectionCode: Object.fromEntries([...byRejectionCode.entries()].sort(([a], [b]) => a.localeCompare(b))),
    rejectionCodeCountsOverlap: true,
    trainingEligible: false, status: 'research_only_no_orders',
  };
}

// Public/Demo ticker matching is not exact coin-ID verification. Keep this
// isolated cohort out of production training even if its files are copied.
export function makePublicProbeObservation(asset, settings, now = new Date(), rejectionCodes = []) {
  const market = asset?.marketData || {};
  if (!asset?.id || !asset?.symbol || !market.candleProvider || !market.candlePair
    || !market.technicals?.dataSufficient) return null;
  const sourcePinned = buildSourcePinnedShadowPrediction({ ...asset, model: scoreAsset(asset) },
    settings, PROBE_GUILD_ID, now);
  if (!sourcePinned) return null;
  const { quote: sourceQuote, prediction, estimatedCostPct } = sourcePinned;
  if (!(prediction.entryPrice > prediction.stopPrice && prediction.stopPrice > 0
    && prediction.targetPrice > prediction.entryPrice)) return null;
  return {
    observationId: createObservationId(PROBE_GUILD_ID, asset.id, prediction.horizonKey, now),
    guildId: PROBE_GUILD_ID, assetId: asset.id, symbol: asset.symbol, horizonKey: prediction.horizonKey,
    createdAt: new Date(now).toISOString(), deadlineAt: prediction.deadlineAt,
    candleProvider: market.candleProvider, candlePair: market.candlePair,
    quoteProvider: sourceQuote.provider, quotePair: sourceQuote.pair,
    quoteObservedAt: sourceQuote.observedAt, quoteAgeMs: sourceQuote.ageMs,
    quoteBid: Number(sourceQuote.bid), quoteAsk: Number(sourceQuote.ask),
    entryEvidenceVersion: sourcePinned.entryEvidenceVersion, entryQuoteBasis: 'same_source_ask',
    entryQuoteProvider: sourceQuote.provider, entryQuotePair: sourceQuote.pair,
    entryQuoteObservedAt: sourceQuote.observedAt, entryQuoteAgeMs: sourceQuote.ageMs,
    entryQuoteBid: sourceQuote.bid, entryQuoteAsk: sourceQuote.ask,
    entryPrice: prediction.entryPrice, stopPrice: prediction.stopPrice,
    partialTargetPrice: prediction.partialTargetPrice, targetPrice: prediction.targetPrice,
    estimatedCostPct, costBasis: 'source_ask_plus_modeled_round_trip_reserve',
    setupScore: prediction.score, rejectionCodes: [...new Set(rejectionCodes)].slice(0, 20),
    identityBasis: 'public_ticker_only_unverified', productionApproval: 'not_evaluated',
    trainingEligible: false, features: null, featureSchemaVersion: null,
  };
}

export async function capturePublicProbeObservations(assets, settings, now = new Date(), rejections = []) {
  const rejectedByAsset = new Map();
  for (const row of rejections) rejectedByAsset.set(row.assetId,
    [...(rejectedByAsset.get(row.assetId) || []), row.code]);
  const observations = assets.map((asset) => makePublicProbeObservation(asset, settings, now,
    rejectedByAsset.get(asset.id) || [])).filter(Boolean);
  const recorded = await recordShadowCandidates(observations, now);
  return { considered: assets.length, sourcePinnedEligible: observations.length, recorded,
    alreadyPresent: observations.length - recorded,
    researchDirectory: 'data/public-funnel-probe/research', trainingEligible: false };
}

export async function resolvePublicProbeObservations(now = new Date(), {
  fetchCandles = fetchHistoricalCandles, fetchEntrySeconds = fetchBinanceEntrySeconds,
  fetchDeadlineSeconds = fetchBinanceDeadlineSeconds, finerEntry = false,
} = {}) {
  const rows = (await publicProbeRows())
    .filter((row) => !row.resolution && row.candleProvider && row.candlePair);
  const due = rows.filter((row) => Date.parse(row.deadlineAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const knownAmbiguous = new Set();
  for (const row of due) {
    if (await inspectStoredSourcePinnedEntryBar(row, now) === 'entry_containing_candle_ambiguous') {
      knownAmbiguous.add(row.observationId);
    }
  }
  const entrySecondsByObservationId = new Map();
  const finerStatuses = new Map();
  let finerEntryRequests = 0;
  for (const row of due.filter((candidate) => knownAmbiguous.has(candidate.observationId))) {
    let evidence = await readEntrySeconds(row);
    if (!evidence && finerEntry && finerEntryRequests < MAX_FINER_REQUESTS) {
      if (row.candleProvider !== 'Binance') {
        finerStatuses.set(row.observationId, 'finer_source_not_supported');
        continue;
      }
      finerEntryRequests += 1;
      try {
        const candles = await fetchEntrySeconds(row);
        const assessment = inspectSourcePinnedEntrySeconds(row, candles, now);
        if (['clear', 'entry_second_ambiguous', 'post_entry_barrier_in_finer_data'].includes(assessment.status)) {
          await storeEntrySeconds(row, candles, now);
          evidence = await readEntrySeconds(row);
        } else finerStatuses.set(row.observationId, assessment.status);
      } catch {
        finerStatuses.set(row.observationId, 'finer_source_fetch_or_store_failed');
      }
    }
    if (evidence?.status === 'available') {
      const assessment = inspectSourcePinnedEntrySeconds(row, evidence.candles, now);
      if (assessment.status === 'clear') entrySecondsByObservationId.set(row.observationId, evidence.candles);
      else finerStatuses.set(row.observationId, assessment.status);
    } else if (evidence?.status) finerStatuses.set(row.observationId, evidence.status);
  }
  const fetchableDue = due.filter((row) => !knownAmbiguous.has(row.observationId)
    || entrySecondsByObservationId.has(row.observationId));
  const sources = new Map();
  const sourceKey = (row) => `${row.symbol}:${row.candleProvider}:${row.candlePair}`;
  for (const row of fetchableDue) {
    const key = sourceKey(row);
    if (!sources.has(key) && sources.size < MAX_RESOLUTION_SOURCES) sources.set(key, row);
  }
  let fetched = 0;
  let unavailable = 0;
  let appendedBars = 0;
  const sourceStatus = new Map();
  for (const [key, row] of sources) {
    let result;
    try {
      result = await fetchCandles({ id: row.assetId, symbol: row.symbol },
        { providers: [row.candleProvider], limit: 1000, force: true });
    } catch {
      sourceStatus.set(key, 'history_fetch_failed');
      unavailable += 1;
      continue;
    }
    if (result?.provider !== row.candleProvider || result?.pair !== row.candlePair) {
      sourceStatus.set(key, 'provider_pair_mismatch');
      unavailable += 1;
      continue;
    }
    if (!result.candles?.length) {
      sourceStatus.set(key, 'empty_history');
      unavailable += 1;
      continue;
    }
    fetched += 1;
    try {
      appendedBars += await appendCandleBatch(row.symbol, row.candleProvider, result.candles, row.candlePair);
      sourceStatus.set(key, 'history_available');
    } catch {
      sourceStatus.set(key, 'history_store_failed');
      unavailable += 1;
    }
  }
  const deadlineSecondsByObservationId = new Map();
  const requireDeadlineSecondsIds = new Set();
  const deadlineStatuses = new Map();
  let finerDeadlineRequests = 0;
  for (const row of fetchableDue) {
    const deadlineMs = Date.parse(row.deadlineAt);
    if (row.candleProvider !== 'Binance' || deadlineMs % FIFTEEN_MINUTES_MS === 0
      || sourceStatus.get(sourceKey(row)) !== 'history_available') continue;
    if (finerEntry) requireDeadlineSecondsIds.add(row.observationId);
    let evidence = await readDeadlineSeconds(row);
    if (!evidence && finerEntry && finerEntryRequests + finerDeadlineRequests < MAX_FINER_REQUESTS) {
      finerDeadlineRequests += 1;
      try {
        const candles = await fetchDeadlineSeconds(row);
        const assessment = inspectSourcePinnedDeadlineSeconds(row, candles, now);
        if (assessment.status === 'complete') {
          await storeDeadlineSeconds(row, candles, now);
          evidence = await readDeadlineSeconds(row);
        } else deadlineStatuses.set(row.observationId, assessment.status);
      } catch {
        deadlineStatuses.set(row.observationId, 'finer_deadline_fetch_or_store_failed');
      }
    }
    if (evidence?.status === 'available') {
      const assessment = inspectSourcePinnedDeadlineSeconds(row, evidence.candles, now);
      if (assessment.status === 'complete') deadlineSecondsByObservationId.set(row.observationId, evidence.candles);
      else deadlineStatuses.set(row.observationId, assessment.status);
    } else if (evidence?.status) deadlineStatuses.set(row.observationId, evidence.status);
  }
  const unresolvedEvidence = new Map();
  const resolutions = await resolvePendingObservations([], now, {
    entrySecondsByObservationId, deadlineSecondsByObservationId, requireDeadlineSecondsIds,
    onUnresolved: (observationId, reason) => unresolvedEvidence.set(observationId, reason)
  });
  const pendingIds = new Set(rows.map((row) => row.observationId));
  const dueIds = new Set(due.map((row) => row.observationId));
  const resolvedIds = new Set(resolutions.map((row) => row.observationId));
  const unresolvedByReason = {};
  for (const row of due) {
    if (resolvedIds.has(row.observationId)) continue;
    const reason = knownAmbiguous.has(row.observationId) && !entrySecondsByObservationId.has(row.observationId)
      ? finerStatuses.get(row.observationId) || 'entry_containing_candle_ambiguous'
      : requireDeadlineSecondsIds.has(row.observationId)
        && !deadlineSecondsByObservationId.has(row.observationId)
        ? deadlineStatuses.get(row.observationId) || 'finer_source_cap'
        : sourceStatus.get(sourceKey(row)) || 'source_cap';
    const code = reason === 'history_available'
      ? unresolvedEvidence.get(row.observationId) || 'candle_path_or_deadline_unavailable' : reason;
    unresolvedByReason[code] = (unresolvedByReason[code] || 0) + 1;
  }
  const newlyResolved = resolutions.filter((row) => pendingIds.has(row.observationId)).length;
  const resolvedDue = resolutions.filter((row) => dueIds.has(row.observationId)).length;
  return { pendingBefore: rows.length, due: due.length, sourcesSelected: sources.size,
    sourcesCapped: Math.max(0, new Set(fetchableDue.map(sourceKey)).size - sources.size),
    ambiguousEntryRowsSkipped: knownAmbiguous.size - entrySecondsByObservationId.size,
    finerEntryRequests, finerEntryRowsCleared: entrySecondsByObservationId.size,
    finerDeadlineRequests, finerDeadlineRowsCovered: deadlineSecondsByObservationId.size,
    sourcesFetched: fetched, sourcesUnavailable: unavailable, completedBarsAppended: appendedBars,
    newlyResolved, unresolvedDue: due.length - resolvedDue, unresolvedByReason,
    trainingEligible: false, status: 'research_only_no_orders' };
}
