import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { dataDir } from './config.js';
import { readMarketSnapshot, writeMarketSnapshot } from './storage.js';

const DAY_MS = 86_400_000;
const DIRECTORY_TTL_MS = DAY_MS;
const MAX_DIRECTORY_AGE_MS = 2 * DAY_MS;
const pending = new Map();
const known = (value) => typeof value === 'string' && value.trim() !== '';
const iso = (now) => new Date(now).toISOString();
const age = (timestamp, now) => now - Date.parse(timestamp || '');
const compress = promisify(gzip);

async function archiveObservation(key, kind, now, payload) {
  const folder = path.join(dataDir, 'broad-discovery-history');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const safeKey = String(key).replace(/[^0-9a-z_-]/gi, '');
  const file = path.join(folder, `${safeKey}-${kind}-${now}.json.gz`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, await compress(JSON.stringify(payload)), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

// A directory is metadata, never a claim that a coin has an executable market.
// Keep every durable provider ID, including colliding symbols and contract case.
export function normalizeCoinDirectory(payload, now = Date.now()) {
  if (!Array.isArray(payload) || !payload.length) throw new Error('Empty or invalid CoinGecko asset directory.');
  const assets = new Map();
  for (const row of payload) {
    if (!known(row?.id) || typeof row?.symbol !== 'string' || typeof row?.name !== 'string'
      || !row.platforms || typeof row.platforms !== 'object' || Array.isArray(row.platforms)) {
      throw new Error('Incomplete CoinGecko directory row; previous membership retained.');
    }
    const id = row.id.trim();
    if (assets.has(id)) throw new Error('Duplicate provider asset ID in directory; previous membership retained.');
    const contracts = [];
    for (const [network, contract] of Object.entries(row.platforms)) {
      if (contract !== null && typeof contract !== 'string') throw new Error('Invalid token contract metadata.');
      if (known(network) && known(contract)) contracts.push({ network, contract });
    }
    contracts.sort((a, b) => a.network < b.network ? -1 : a.network > b.network ? 1 : 0);
    assets.set(id, { id, identity: `coingecko:${id}`, symbol: row.symbol.trim().toUpperCase(), name: row.name.trim(), contracts,
      metadataIssues: [...(!known(row.symbol) ? ['missing_symbol'] : []), ...(!known(row.name) ? ['missing_name'] : [])] });
  }
  const rows = [...assets.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const counts = new Map();
  for (const row of rows) if (row.symbol) counts.set(row.symbol, (counts.get(row.symbol) || 0) + 1);
  return { version: 1, provider: 'CoinGecko', fetchedAt: iso(now), providerUpdatedAt: null,
    enumeration: 'complete_active_endpoint_response', pagination: 'unpaginated',
    membershipHash: createHash('sha256').update(JSON.stringify(rows.map((row) => row.id))).digest('hex'),
    assets: rows, assetCount: rows.length, ambiguousSymbols: [...counts].filter(([, count]) => count > 1).map(([symbol]) => symbol),
    incompleteMetadataCount: rows.filter((row) => row.metadataIssues.length > 0).length,
    changes: null };
}

export function directoryChanges(previous, current) {
  if (!previous) return { baseline: true, added: [], absentFromActiveDirectory: [], identityMetadataChanged: [] };
  const old = new Map(previous.assets.map((row) => [row.id, row]));
  const next = new Map(current.assets.map((row) => [row.id, row]));
  return { baseline: false,
    added: [...next.keys()].filter((id) => !old.has(id)),
    // Absence is not proof of exchange delisting or token death.
    absentFromActiveDirectory: [...old.keys()].filter((id) => !next.has(id)),
    identityMetadataChanged: [...next].filter(([id, row]) => old.has(id)
      && JSON.stringify(old.get(id)) !== JSON.stringify(row)).map(([id]) => id) };
}

export function planBroadDiscovery(settings = {}, legacyCallsPer30Days = 0, tier = 'public') {
  const requestedMinutes = Math.max(5, Number(settings.discoveryMinutes) || 15);
  const directoryCalls = 30;
  // Reuse the existing Demo bulk-discovery planning ceiling. This is explicitly
  // not an account-wide guard: identity checks, retries and other clients add calls.
  const remaining = tier === 'demo' ? Math.max(0, 9000 - legacyCallsPer30Days - directoryCalls) : Infinity;
  const directoryAllowed = tier !== 'demo' || legacyCallsPer30Days + directoryCalls <= 9000;
  const intervalMinutes = remaining > 0 ? Math.max(requestedMinutes, Math.ceil(43_200 / remaining)) : null;
  // Provider docs allow 250 IDs, but a real public 250-ID/3,901-character
  // query returned 403 while 50 IDs/917 characters succeeded (2026-10-02).
  // Keep this a rotating request-size boundary, never a universe ceiling.
  return { intervalMinutes, directoryAllowed, maxIdsPerBatch: 50, maxEncodedIdsLength: 1500,
    requestBoundary: '50_ids_and_1500_encoded_id_characters_public_verified_envelope',
    projectedCallsPer30Days: !directoryAllowed ? 0 : intervalMinutes === null ? directoryCalls : Math.ceil(43_200 / intervalMinutes) + directoryCalls,
    legacyCallsPer30Days, scope: 'scheduled_discovery_with_existing_keyed_identity_reserve_excludes_monitoring_retries_other_clients' };
}

// The cursor is an ID, not an offset or rank. New listings do not reset progress
// to page one. One completed sweep is not a simultaneous market snapshot.
export function nextDirectoryBatch(directory, cursor = '', { maxIdsPerBatch = 250, maxEncodedIdsLength = 6000 } = {}) {
  const rows = directory.assets;
  let start = cursor ? rows.findIndex((row) => row.id > cursor) : 0;
  if (start < 0) start = 0;
  const ids = [];
  let encodedLength = 0;
  for (let index = start; index < rows.length && ids.length < maxIdsPerBatch; index += 1) {
    const length = encodeURIComponent(rows[index].id).length + (ids.length ? 3 : 0);
    if (ids.length && encodedLength + length > maxEncodedIdsLength) break;
    if (length > maxEncodedIdsLength) throw new Error('Provider asset ID exceeds the request URL budget.');
    ids.push(rows[index].id);
    encodedLength += length;
  }
  return { ids, nextCursor: ids.at(-1) || cursor, wrapped: Boolean(cursor) && start === 0,
    reachedEnd: ids.at(-1) === rows.at(-1)?.id };
}

export function inspectBroadPrices(ids, payload, now = Date.now(), maxAgeMinutes = 30) {
  if (!Array.isArray(payload)) throw new Error('Invalid broad price batch response.');
  const requested = new Set(ids);
  const byId = new Map();
  for (const row of payload) {
    if (!requested.has(row?.id) || byId.has(row.id)) throw new Error('Broad price batch has unexpected or duplicate asset IDs.');
    byId.set(row.id, row);
  }
  return ids.map((id) => {
    const row = byId.get(id);
    let reason = !row ? 'not_returned_by_markets' : null;
    const timestampAge = age(row?.last_updated, now);
    if (!reason && !(Number.isFinite(row.current_price) && row.current_price > 0)) reason = 'missing_or_invalid_price';
    if (!reason && !Number.isFinite(timestampAge)) reason = 'provider_timestamp_missing';
    if (!reason && timestampAge < -60_000) reason = 'provider_timestamp_future';
    if (!reason && timestampAge > maxAgeMinutes * 60_000) reason = 'provider_timestamp_stale';
    return { id, identity: `coingecko:${id}`, checkedAt: iso(now),
      status: reason || 'fresh_price', providerUpdatedAt: row?.last_updated || null,
      price: Number.isFinite(row?.current_price) ? row.current_price : null,
      volume24hUsd: Number.isFinite(row?.total_volume) ? row.total_volume : null,
      marketCapUsd: Number.isFinite(row?.market_cap) ? row.market_cap : null,
      rank: Number.isFinite(row?.market_cap_rank) ? row.market_cap_rank : null,
      change1hPct: Number.isFinite(row?.price_change_percentage_1h_in_currency) ? row.price_change_percentage_1h_in_currency : null,
      change24hPct: Number.isFinite(row?.price_change_percentage_24h_in_currency) ? row.price_change_percentage_24h_in_currency : null };
  });
}

export function screenBroadObservations(rows, settings = {}) {
  const minVolumeUsd = Number(settings.minVolumeUsd) > 0 ? Number(settings.minVolumeUsd) : 5_000_000;
  const rankBaseline = Number(settings.maxMarketRank) > 0 ? Number(settings.maxMarketRank) : 250;
  return rows.map((row) => {
    const reasons = [];
    if (row.status !== 'fresh_price') reasons.push(row.status);
    if (!(row.volume24hUsd >= minVolumeUsd)) reasons.push('liquidity_volume');
    if (!(row.marketCapUsd > 0 && row.volume24hUsd / row.marketCapUsd >= 0.004)) reasons.push('liquidity_turnover');
    if (row.change1hPct === null || row.change24hPct === null) reasons.push('missing_activity_fields');
    else if (!(row.change1hPct > 0.05 && row.change24hPct > -3.5)) reasons.push('snapshot_trend');
    return { ...row, cheapCandidate: reasons.length === 0, screenReasons: reasons,
      outsideBaselineRank: row.rank === null ? null : row.rank > rankBaseline,
      screenPolicy: { version: 1, minVolumeUsd, minimumVolumeToMarketCap: 0.004, minChange1hPct: 0.05, minChange24hPct: -3.5,
        scope: 'preliminary_snapshot_research_only_no_score_model_quote_or_risk_approval' } };
  });
}

function summarize(directory, state, status, errors, plan, now, timing = {}) {
  const currentIds = new Set(directory?.assets?.map((row) => row.id) || []);
  const observations = Object.values(state?.observations || {}).filter((row) => currentIds.has(row.id));
  const recent = observations.filter((row) => age(row.checkedAt, now) >= 0 && age(row.checkedAt, now) <= DAY_MS);
  const reasons = {};
  for (const row of recent) reasons[row.status] = (reasons[row.status] || 0) + 1;
  const lastBatch = state?.lastBatch || null;
  const count = directory?.assetCount ?? null;
  const directoryAgeMs = directory ? age(directory.fetchedAt, now) : null;
  return { version: 1, mode: 'discovery_research', status, provider: 'CoinGecko',
    directory: { assetCount: count, fetchedAt: directory?.fetchedAt || null, ageMs: directoryAgeMs,
      fresh: directoryAgeMs !== null && directoryAgeMs >= 0 && directoryAgeMs <= DIRECTORY_TTL_MS,
      enumeration: directory?.enumeration || 'unknown', pagination: directory?.pagination || 'unknown',
      providerUpdatedAt: null, membershipHash: directory?.membershipHash || null,
      ambiguousSymbolCount: directory?.ambiguousSymbols?.length ?? null,
      incompleteMetadataCount: directory?.incompleteMetadataCount ?? null,
      changes: directory?.changes ? { baseline: directory.changes.baseline,
        added: directory.changes.added.length, absentFromActiveDirectory: directory.changes.absentFromActiveDirectory.length,
        identityMetadataChanged: directory.changes.identityMetadataChanged.length } : null },
    prices: { requestedLastBatch: lastBatch?.requested ?? null, returnedLastBatch: lastBatch?.returned ?? null,
      freshAtLastBatch: lastBatch?.fresh ?? null, batchCompletedAt: lastBatch?.completedAt || null,
      cheapCandidatesLastBatch: lastBatch?.cheapCandidates ?? null,
      cheapCandidatesOutsideBaselineRankLastBatch: lastBatch?.cheapCandidatesOutsideBaselineRank ?? null,
      rejectionReasonsLastBatch: lastBatch?.rejectionReasons || null,
      checkedLast24h: recent.length, uncheckedLast24h: count === null ? null : count - recent.length,
      observedAcrossHistory: observations.length, outcomesLast24h: reasons,
      minimumProjectedSweepMinutes: count === null || plan.intervalMinutes === null ? null : Math.ceil(count / plan.maxIdsPerBatch) * plan.intervalMinutes,
      nextAttemptAt: state?.nextAttemptAt || null },
    plan, timing, errors,
    interpretation: 'Full active provider directory; rolling price observations, not simultaneous executable coverage. Fresh refers to each observation time. URL length, failures and retries can extend the sweep estimate. Broad rows do not enter production approval or publish watches. The existing rank gate remains a baseline strategy limitation.' };
}

export function formatBroadDiscoverySummary(report) {
  if (!report) return 'Not recorded. The production price shortlist is not the full provider universe.';
  const n = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : 'unknown';
  return `${report.status || 'unknown'} | active provider IDs ${n(report.directory?.assetCount)}; directory ${report.directory?.fresh ? 'fresh' : 'unavailable/stale'}. `
    + `Last batch: ${n(report.prices?.returnedLastBatch)}/${n(report.prices?.requestedLastBatch)} returned; ${n(report.prices?.freshAtLastBatch)} fresh at observation. `
    + `Checked in 24h ${n(report.prices?.checkedLast24h)}; unchecked ${n(report.prices?.uncheckedLast24h)}. `
    + `Cheap candidates in last batch ${n(report.prices?.cheapCandidatesLastBatch)}. `
    + 'Rolling research coverage; no additional approvals or watch alerts. Rank-based production baseline unchanged.'
    + (report.errors?.length ? ` Errors: ${report.errors.join('; ')}` : '');
}

export async function fetchBroadDiscovery({ provider, cacheKey, fetchJson, settings = {}, legacyCallsPer30Days = 0,
  now = Date.now() }) {
  const key = `broad-${cacheKey}`;
  if (pending.has(key)) return pending.get(key);
  const request = refresh({ provider, key, fetchJson, settings, legacyCallsPer30Days, now });
  pending.set(key, request);
  try { return await request; }
  finally { if (pending.get(key) === request) pending.delete(key); }
}

async function refresh({ provider, key, fetchJson, settings, legacyCallsPer30Days, now }) {
  const plan = planBroadDiscovery(settings, legacyCallsPer30Days, provider.tier);
  const errors = [];
  const timing = {};
  let directory = await readMarketSnapshot(`${key}-directory`);
  let state = await readMarketSnapshot(`${key}-prices`) || { version: 1, cursor: '', observations: {} };
  if (directory && (directory.version !== 1 || !Array.isArray(directory.assets) || directory.assetCount !== directory.assets.length)) {
    throw new Error('Invalid broad directory cache; retained for operator review.');
  }
  if (state.version !== 1 || !state.observations || typeof state.observations !== 'object' || Array.isArray(state.observations)) {
    throw new Error('Invalid broad price cache; retained for operator review.');
  }
  // Persist backoff before I/O, so forced/monitor calls and process restarts do
  // not hammer a failing directory or repeatedly advance the research cursor.
  const due = !Number.isFinite(Date.parse(state.nextAttemptAt || '')) || Date.parse(state.nextAttemptAt) <= now;
  if (!due) return summarize(directory, state, !plan.directoryAllowed ? 'budget_deferred'
    : state.errors?.length ? 'degraded_cached' : 'cached', state.errors || [], plan, now);
  state = { ...state, nextAttemptAt: iso(now + (plan.intervalMinutes ?? 60) * 60_000) };
  await writeMarketSnapshot(`${key}-prices`, state);
  if (!plan.directoryAllowed) return summarize(directory, state, 'budget_deferred', [], plan, now, timing);
  const directoryAge = directory ? age(directory.fetchedAt, now) : Infinity;
  if (!directory || !Number.isFinite(directoryAge) || directoryAge < 0 || directoryAge >= DIRECTORY_TTL_MS) {
    const started = performance.now();
    try {
      const response = await fetchJson(`${provider.base}/coins/list?include_platform=true`, {
        headers: provider.headers, provider: 'CoinGecko Broad Directory', returnDetails: true });
      const next = normalizeCoinDirectory(response.payload, now);
      next.changes = directoryChanges(directory, next);
      // Archive each successful refresh before replacing the current directory.
      // Failed/malformed responses never remove previously known membership.
      await archiveObservation(key, 'directory', now, next);
      await writeMarketSnapshot(`${key}-directory`, next);
      directory = next;
    } catch (error) { errors.push(`directory: ${String(error?.message || error).slice(0, 180)}`); }
    timing.directoryMs = Math.round(performance.now() - started);
  }
  const currentAge = directory ? age(directory.fetchedAt, now) : Infinity;
  if (!directory || !Number.isFinite(currentAge) || currentAge < 0 || currentAge > MAX_DIRECTORY_AGE_MS || plan.intervalMinutes === null) {
    state.errors = errors;
    await writeMarketSnapshot(`${key}-prices`, state);
    return summarize(directory, state, !directory || currentAge > MAX_DIRECTORY_AGE_MS ? 'directory_unavailable' : 'budget_deferred', errors, plan, now, timing);
  }
  const batch = nextDirectoryBatch(directory, state.cursor, plan);
  const query = new URLSearchParams({ vs_currency: 'usd', ids: batch.ids.join(','), per_page: '250', page: '1',
    sparkline: 'false', price_change_percentage: '1h,24h', include_rehypothecated: 'true' });
  const started = performance.now();
  try {
    const response = await fetchJson(`${provider.base}/coins/markets?${query}`, {
      headers: provider.headers, provider: 'CoinGecko Broad Prices', returnDetails: true });
    const rows = screenBroadObservations(inspectBroadPrices(batch.ids, response.payload, now,
      Number(settings.maxDiscoveryAssetAgeMinutes) || 30), settings);
    await archiveObservation(key, 'prices', now, { version: 1, provider: 'CoinGecko', observedAt: iso(now),
      directoryFetchedAt: directory.fetchedAt, membershipHash: directory.membershipHash,
      requestedIds: batch.ids, observations: rows, scope: 'discovery_research_no_trade_approval' });
    const observations = Object.fromEntries([...Object.entries(state.observations), ...rows.map((row) => [row.id, row])]);
    const rejectionReasons = {};
    for (const row of rows) for (const reason of row.screenReasons) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    state = { ...state, cursor: batch.nextCursor, observations,
      lastBatch: { requested: batch.ids.length, returned: response.payload.length,
        fresh: rows.filter((row) => row.status === 'fresh_price').length,
        cheapCandidates: rows.filter((row) => row.cheapCandidate).length,
        cheapCandidatesOutsideBaselineRank: rows.filter((row) => row.cheapCandidate && row.outsideBaselineRank).length,
        rejectionReasons, completedAt: iso(now) }, errors };
    await writeMarketSnapshot(`${key}-prices`, state);
  } catch (error) {
    errors.push(`prices: ${String(error?.message || error).slice(0, 180)}`);
    state.errors = errors;
    await writeMarketSnapshot(`${key}-prices`, state);
  }
  timing.pricesMs = Math.round(performance.now() - started);
  return summarize(directory, state, errors.length ? 'degraded' : 'updated', errors, plan, now, timing);
}
