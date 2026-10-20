import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { paths, readMarketSnapshot, writeMarketSnapshot } from './storage.js';
import { retryPlan } from './retryPolicy.js';
import { paceCoinGeckoResearch } from './researchProviderPacing.js';

const BINANCE = 'https://data-api.binance.vision';
const HOUR = 3_600_000;
const pending = new Map();
const text = (value) => typeof value === 'string' ? value.trim() : '';
const number = (value) => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean'
  && Number.isFinite(Number(value)) ? Number(value) : null;
const age = (value, now) => now - Date.parse(value || '');
const fresh = (value, now, ttl) => Number.isFinite(age(value, now)) && age(value, now) >= 0 && age(value, now) <= ttl;
const pairKey = (base, quote) => JSON.stringify([text(base).toUpperCase(), text(quote).toUpperCase()]);
const tally = (rows) => rows.reduce((counts, row) => {
  for (const reason of row.reasons || []) counts[reason] = (counts[reason] || 0) + 1;
  return counts;
}, {});

export function normalizeBinanceDirectory(payload, now = Date.now()) {
  if (!Array.isArray(payload?.symbols) || !payload.symbols.length) throw new Error('Missing Binance instrument directory.');
  const seen = new Set();
  const instruments = payload.symbols.map((row) => {
    if (!text(row?.symbol) || !text(row.baseAsset) || !text(row.quoteAsset) || !text(row.status) || seen.has(row.symbol)) {
      throw new Error('Malformed or duplicate Binance instrument definition.');
    }
    seen.add(row.symbol);
    return { pair: row.symbol, base: row.baseAsset, quote: row.quoteAsset,
      venueInstrumentId: `binance:spot:${row.symbol}`, status: row.status,
      activeSpot: row.status === 'TRADING' && row.isSpotTradingAllowed === true,
      filters: Array.isArray(row.filters) ? row.filters : [], accountTradable: null };
  });
  return { version: 1, fetchedAt: new Date(now).toISOString(), instruments,
    source: 'Binance /api/v3/exchangeInfo', pagination: 'unpaginated',
    rateLimits: Array.isArray(payload.rateLimits) ? payload.rateLimits : [] };
}

export function venueDirectoryChanges(previous, current) {
  const before = new Map((previous?.instruments || []).map((row) => [row.pair, row]));
  const after = new Map(current.instruments.map((row) => [row.pair, row]));
  return { baseline: !previous, added: [...after.keys()].filter((pair) => !before.has(pair)),
    absent: [...before.keys()].filter((pair) => !after.has(pair)),
    statusChanged: [...after].filter(([pair, row]) => before.has(pair) && before.get(pair).status !== row.status).map(([pair]) => pair),
    interpretation: 'Provider membership/status changes; absence alone does not establish delisting.' };
}

// Enumerate the entire response before applying currency, data or strategy
// eligibility. A stablecoin's quoted volume is never silently called USD.
export function screenBinanceBulk(directory, tickers, { now = Date.now(), assets = [], minVolumeUsd = 5_000_000 } = {}) {
  if (!Array.isArray(tickers) || !tickers.length) throw new Error('Missing Binance bulk ticker response.');
  const quotes = new Map();
  for (const row of tickers) {
    if (!text(row?.symbol) || quotes.has(row.symbol)) throw new Error('Malformed or duplicate Binance bulk ticker.');
    quotes.set(row.symbol, row);
  }
  const usdRates = new Map([['USD', { rate: 1, source: 'USD denomination', observedAt: null }]]);
  // These are currency identity mappings, not a searchable-asset watchlist.
  for (const [quote, id] of [['USDT', 'tether'], ['USDC', 'usd-coin'], ['BTC', 'bitcoin'], ['ETH', 'ethereum']]) {
    const row = assets.find((item) => item.id === id);
    if (row?.price > 0 && fresh(row.lastUpdated, now, 30 * 60_000)) {
      usdRates.set(quote, { rate: row.price, source: `coingecko:${id}`, observedAt: row.lastUpdated });
    }
  }
  const rows = directory.instruments.map((instrument) => {
    const ticker = quotes.get(instrument.pair);
    const reasons = [];
    if (!instrument.activeSpot) reasons.push('inactive_or_nonspot');
    if (!ticker) reasons.push('missing_bulk_ticker');
    const rawClosed = number(ticker?.closeTime);
    const closed = rawClosed > 0 && Number.isFinite(new Date(rawClosed).getTime()) ? rawClosed : null;
    const timestampAgeMs = closed === null ? null : now - closed;
    if (timestampAgeMs === null) reasons.push('missing_provider_timestamp');
    else if (timestampAgeMs < -5_000) reasons.push('future_provider_timestamp');
    else if (timestampAgeMs > 5 * 60_000) reasons.push('stale_provider_timestamp');
    const last = number(ticker?.lastPrice);
    const bid = number(ticker?.bidPrice);
    const ask = number(ticker?.askPrice);
    if (!(last > 0 && bid > 0 && ask >= bid)) reasons.push('invalid_price_or_spread');
    const conversion = usdRates.get(instrument.quote);
    if (!conversion) reasons.push('unsupported_or_stale_usd_conversion');
    const quoteVolume = number(ticker?.quoteVolume);
    const volumeUsd = conversion && quoteVolume !== null && quoteVolume >= 0 ? quoteVolume * conversion.rate : null;
    if (volumeUsd === null) reasons.push('missing_usd_volume');
    else if (volumeUsd < minVolumeUsd) reasons.push('minimum_liquidity');
    const change24h = number(ticker?.priceChangePercent);
    if (change24h === null) reasons.push('missing_price_movement');
    else if (change24h <= 0) reasons.push('not_positive_24h_activity');
    const high = number(ticker?.highPrice);
    const low = number(ticker?.lowPrice);
    const rangePosition = high > low && last !== null ? Math.max(0, Math.min(1, (last - low) / (high - low))) : null;
    return { ...instrument, reasons, eligible: reasons.length === 0, last, bid, ask,
      change24h, volumeUsd, quoteVolume, rangePosition, conversion: conversion || null,
      observedAt: closed === null ? null : new Date(closed).toISOString(), timestampBasis: 'provider_window_close',
      // Activity priority is not a probability or a strategy approval.
      activityPriority: change24h === null ? null : change24h * (rangePosition ?? 0.5) };
  });
  const ranked = rows.filter((row) => row.eligible)
    .sort((a, b) => b.activityPriority - a.activityPriority || b.volumeUsd - a.volumeUsd || a.pair.localeCompare(b.pair));
  const directoryPairs = new Set(directory.instruments.map((row) => row.pair));
  return { rows, ranked, counts: { providerInstruments: rows.length,
    activeSpotPairs: rows.filter((row) => row.activeSpot).length,
    bulkTickerRows: tickers.length, matchedTickerPairs: rows.filter((row) => quotes.has(row.pair)).length,
    unexpectedTickerPairs: [...quotes.keys()].filter((pair) => !directoryPairs.has(pair)).length,
    cheaplyScreened: rows.length, preliminaryPairs: ranked.length, preliminaryBaseAssets: new Set(ranked.map((row) => row.base)).size },
    rejectionReasons: tally(rows) };
}

export function buildVenueIdentityMap(tickers, exchangeId) {
  const values = new Map();
  const rejected = {};
  for (const row of tickers) {
    const reason = row?.market?.identifier !== exchangeId ? 'wrong_venue'
      : !text(row.base) || !text(row.target) || !text(row.coin_id) ? 'missing_identity'
        : row.is_stale !== false || row.is_anomaly !== false ? 'stale_or_anomalous_identity' : null;
    if (reason) { rejected[reason] = (rejected[reason] || 0) + 1; continue; }
    const key = pairKey(row.base, row.target);
    const ids = values.get(key) || new Set();
    ids.add(row.coin_id);
    values.set(key, ids);
  }
  return { byPair: new Map([...values].filter(([, ids]) => ids.size === 1).map(([key, ids]) => [key, [...ids][0]])),
    conflicts: new Set([...values].filter(([, ids]) => ids.size > 1).map(([key]) => key)), rejected };
}

export function selectVenueCandidates(screen, mapping, maxCandidates = 8) {
  const byId = new Map();
  const rejections = [];
  for (const row of screen.ranked) {
    const key = pairKey(row.base, row.quote);
    const id = mapping?.byPair?.get(key);
    if (!id || mapping.conflicts.has(key)) {
      rejections.push({ venueInstrumentId: row.venueInstrumentId, pair: row.pair,
        code: mapping?.conflicts?.has(key) ? 'conflicting_provider_identity' : 'unverified_provider_identity' });
      continue;
    }
    if (!byId.has(id)) byId.set(id, { ...row, coinId: id,
      identityEvidence: { source: 'CoinGecko exchange tickers', exchangeId: 'binance', coinId: id, base: row.base, target: row.quote } });
  }
  const all = [...byId.values()];
  return { candidates: all.slice(0, maxCandidates), identityVerifiedAssets: all.length, rejections,
    deferredByAnalysisBudget: all.slice(maxCandidates).map((row) => ({ coinId: row.coinId, pair: row.pair, code: 'detailed_analysis_budget' })) };
}

export async function cachedVenueRequest(key, ttl, request, now) {
  const stored = await readMarketSnapshot(key);
  if (stored && fresh(stored.fetchedAt, now, ttl)) return { ...stored, cacheHit: true };
  const value = await request();
  await writeMarketSnapshot(key, value);
  return { ...value, cacheHit: false };
}

// Paging is resumable computational batching. Only a short/empty terminal page
// publishes a new complete mapping; partial refreshes never erase old entries.
export async function refreshVenueIdentity({ provider, cacheKey, fetchJson, now = Date.now(), maxPages = 3,
  spacingMs = provider.tier === 'public' ? 20000 : 2500, clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const key = `venue-identity-${cacheKey}-binance`;
  const previous = await readMarketSnapshot(key);
  if (previous && fresh(previous.completedAt, now, 24 * HOUR)) return { ...previous, cacheHit: true };
  let stage = await readMarketSnapshot(`${key}-pending`);
  if (!stage || !fresh(stage.startedAt, now, 6 * HOUR)) stage = { version: 1, startedAt: new Date(now).toISOString(), nextPage: 1, tickers: [], pageHashes: [] };
  if (!Array.isArray(stage.tickers) || !Array.isArray(stage.pageHashes) || !Number.isSafeInteger(stage.nextPage) || stage.nextPage < 1) {
    throw new Error('Invalid persisted venue identity pagination; retained for review.');
  }
  if (Date.parse(stage.nextRetryAt || '') > now) return { status: 'cooldown', pages: stage.nextPage - 1,
    nextPage: stage.nextPage, nextRetryAt: stage.nextRetryAt, tickers: [], pagination: 'incomplete', error: 'Persisted provider backoff is active.' };
  let error = null;
  for (let index = 0; index < maxPages; index += 1) {
    if (stage.nextPage > 50) { error = 'Identity directory exceeded the 50-page request budget; coverage remains incomplete.'; break; }
    if (index && provider.tier !== 'public') await sleep(spacingMs);
    try {
      const query = new URLSearchParams({ order: 'base_target', page: String(stage.nextPage) });
      const response = await paceCoinGeckoResearch(provider.tier, () => fetchJson(`${provider.base}/exchanges/binance/tickers?${query}`, {
        provider: 'CoinGecko Venue Identity', headers: provider.headers, returnDetails: true }), { spacingMs, sleep });
      const rows = response.payload?.tickers;
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid CoinGecko exchange page.');
      const hash = createHash('sha256').update(JSON.stringify(rows.map((row) => [row.base, row.target, row.coin_id]))).digest('hex');
      if (rows.length && stage.pageHashes.includes(hash)) throw new Error('Repeated identity page; pagination is incomplete.');
      stage = { ...stage, nextPage: stage.nextPage + 1, tickers: [...stage.tickers, ...rows], pageHashes: [...stage.pageHashes, hash] };
      await writeMarketSnapshot(`${key}-pending`, stage);
      if (rows.length < 100) {
        const complete = { version: 1, status: 'complete', exchangeId: 'binance', completedAt: new Date(clock()).toISOString(),
          pages: stage.nextPage - 1, tickers: stage.tickers, pagination: 'terminal_page_observed' };
        await writeMarketSnapshot(key, complete);
        await writeMarketSnapshot(`${key}-pending`, null);
        return complete;
      }
    } catch (failure) {
      error = String(failure?.message || failure).slice(0, 200);
      if (failure?.status === 429 || failure?.code === 'PROVIDER_COOLDOWN_ACTIVE') {
        const failedAt = clock();
        const delay = retryPlan(failure.retryAfter, 0, { now: failedAt, serverDateHeader: failure.serverDate,
          maxRetryDelayMs: Number.MAX_SAFE_INTEGER }).delayMs;
        stage.nextRetryAt = new Date(Math.max(failedAt + Math.max(60_000, delay), Date.parse(failure.retryAt || '') || 0)).toISOString();
        await writeMarketSnapshot(`${key}-pending`, stage);
      }
      break;
    }
  }
  return { status: error ? 'failed' : 'partial', pages: stage.nextPage - 1, nextPage: stage.nextPage, error,
    tickers: [], pagination: 'incomplete', nextRetryAt: stage.nextRetryAt || null, previousCompletedAt: previous?.completedAt || null };
}

export async function fetchVenueDiscovery(args) {
  const key = args.cacheKey;
  if (pending.has(key)) return pending.get(key);
  const work = fetchUncached(args);
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}

async function fetchUncached({ provider, cacheKey, fetchJson, settings = {}, assets = [], now = Date.now(),
  mappingPagesPerRefresh = 3, mappingSpacingMs, sleep, identityBudgetAvailable = true, clock = Date.now }) {
  const started = performance.now();
  // Native all-pair market requests have no dependence on CoinGecko rank or IDs.
  const directory = await cachedVenueRequest('venue-binance-directory', HOUR, async () => {
    const response = await fetchJson(`${BINANCE}/api/v3/exchangeInfo`, { provider: 'Binance Directory', returnDetails: true });
    const normalized = normalizeBinanceDirectory(response.payload, clock());
    return { ...normalized, changes: venueDirectoryChanges(await readMarketSnapshot('venue-binance-directory'), normalized) };
  }, now);
  const identity = identityBudgetAvailable
    ? await refreshVenueIdentity({ provider, cacheKey, fetchJson, now, maxPages: mappingPagesPerRefresh, spacingMs: mappingSpacingMs, sleep, clock })
    : { status: 'budget_deferred', tickers: [], pages: 0, pagination: 'unknown' };
  now = clock();
  const priceSnapshot = await cachedVenueRequest('venue-binance-bulk', 2 * 60_000, async () => {
    const response = await fetchJson(`${BINANCE}/api/v3/ticker/24hr`, { provider: 'Binance Bulk', returnDetails: true });
    if (!Array.isArray(response.payload)) throw new Error('Invalid Binance bulk response.');
    return { fetchedAt: new Date(clock()).toISOString(), rows: response.payload };
  }, now);
  now = clock();
  const screen = screenBinanceBulk(directory, priceSnapshot.rows, { now, assets, minVolumeUsd: Number(settings.minVolumeUsd) || 5_000_000 });
  const mapped = identity.status === 'complete' ? buildVenueIdentityMap(identity.tickers, 'binance') : null;
  const selected = selectVenueCandidates(screen, mapped, Number(settings.maxProviderCandidates) || 8);
  const report = { version: 1, status: identity.status === 'complete' ? 'available' : identity.status === 'failed' ? 'degraded' : 'identity_pending',
    generatedAt: new Date(now).toISOString(), venue: 'Binance', source: 'public market-data-only API',
    directory: { fetchedAt: directory.fetchedAt, cacheHit: directory.cacheHit, pagination: directory.pagination,
      changes: directory.changes, accountTradability: 'unverified' },
    prices: { fetchedAt: priceSnapshot.fetchedAt, cacheHit: priceSnapshot.cacheHit, timestampBasis: 'provider_window_close',
      approvedExecutionQuote: false },
    counts: { ...screen.counts, identityVerifiedAssets: selected.identityVerifiedAssets, shortlisted: selected.candidates.length,
      identityRejectedPairs: selected.rejections.length, deferredByAnalysisBudget: selected.deferredByAnalysisBudget.length },
    rejectionReasons: screen.rejectionReasons,
    identity: { status: identity.status, pages: identity.pages, nextPage: identity.nextPage || null,
      pagination: identity.pagination, completedAt: identity.completedAt || null, error: identity.error || null, nextRetryAt: identity.nextRetryAt || null,
      conflicts: mapped?.conflicts?.size ?? null, rejectedRows: mapped?.rejected || null },
    durationMs: Math.round(performance.now() - started),
    scope: 'full_native_venue_directory_then_filters; shortlist_requires_detailed_analysis_and_normal_risk_gates' };
  const journal = await archiveVenueScreen({ ...report, rows: screen.rows.map(({ filters: _filters, ...row }) => row),
    candidates: selected.candidates, identityRejections: selected.rejections,
    deferred: selected.deferredByAnalysisBudget }, now);
  report.journal = journal;
  await writeMarketSnapshot(`venue-binance-${cacheKey}-latest`, { ...report, candidates: selected.candidates,
    rejections: [...screen.rows.filter((row) => row.reasons.length).map((row) => ({ pair: row.pair, reasons: row.reasons })),
      ...selected.rejections, ...selected.deferredByAnalysisBudget] });
  return { report, candidates: selected.candidates };
}

async function archiveVenueScreen(value, now) {
  const folder = path.join(paths.researchDir(), 'venue-discovery-history');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(JSON.stringify([value.directory.fetchedAt, value.prices.fetchedAt,
    value.identity.completedAt, value.identity.pages, value.identity.status, value.counts, value.rejectionReasons])).digest('hex').slice(0, 24);
  const name = `${new Date(now).toISOString().slice(0, 10)}-${hash}.json.gz`;
  let status = 'recorded';
  try { await fs.writeFile(path.join(folder, name), gzipSync(JSON.stringify(value)), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; status = 'existing'; }
  const cutoff = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{4}-\d{2}-\d{2}-[0-9a-f]{24}\.json\.gz$/.test(entry.name) && entry.name.slice(0, 10) < cutoff) {
      await fs.unlink(path.join(folder, entry.name));
    }
  }
  return { status, file: name, retentionDays: 14, format: 'gzip-json-full-screen-with-rejections' };
}

export function formatVenueDiscoverySummary(discovery, research) {
  if (!discovery) return 'Venue discovery was not evaluated.';
  const counts = discovery.counts || {};
  const n = (value) => Number.isFinite(value) ? String(value) : 'unknown';
  return `Binance ${discovery.status}: ${n(counts.providerInstruments)} directory pairs → ${n(counts.activeSpotPairs)} active spot → ${n(counts.cheaplyScreened)} checked → ${n(counts.preliminaryPairs)} initial pairs → ${n(counts.identityVerifiedAssets)} identity-verified assets → ${n(counts.shortlisted)} shortlisted. Identity ${discovery.identity?.status || 'unknown'}, ${n(discovery.identity?.pages)} pages. Additional research ${n(research?.deepRequested)} requested / ${n(research?.analyzed)} analyzed / ${n(research?.sourcePinned)} source-pinned. Research only; no new approvals. Account tradability unverified.`;
}

// Conservative scheduled-request planning, not an account-wide credit balance.
// Identity paging can cost five requests per newly seen detailed candidate.
export function planVenueResearch(settings = {}, { tier = 'public', baselineCalls = 0, broadCalls = 0 } = {}) {
  const refreshes = Math.ceil(43_200 / Math.max(5, Number(settings.discoveryMinutes) || 15));
  const candidates = Math.max(0, Math.min(4, Number(settings.venueResearchCandidates) || 0));
  const identityDirectoryCalls = 50 * 30; // Max 50 pages for each daily mapping refresh.
  const shortlistCalls = refreshes;
  const detailedIdentityCalls = candidates * 5 * refreshes;
  const exchangeDirectoryCalls = Math.min(refreshes, 60);
  const projectedCallsPer30Days = baselineCalls + broadCalls + identityDirectoryCalls
    + shortlistCalls + detailedIdentityCalls + exchangeDirectoryCalls;
  return { identityDirectoryCalls, shortlistCalls, detailedIdentityCalls, exchangeDirectoryCalls,
    baselineCalls, broadCalls, projectedCallsPer30Days, allowed: tier !== 'demo' || projectedCallsPer30Days <= 9000,
    scope: 'scheduled_worst_case_excludes_retries_monitoring_other_guilds_clients_not_account_balance' };
}

export function selectVenueResearchAssets(snapshot, alreadyAnalyzed = [], settings = {}, now = Date.now()) {
  const limit = Math.max(0, Math.min(4, Number(settings.venueResearchCandidates) || 0));
  const ids = new Set(alreadyAnalyzed.map((row) => row.id));
  const known = new Map();
  for (const row of [...(snapshot.assets || []), ...alreadyAnalyzed]) {
    const key = text(row.symbol).toUpperCase();
    if (!known.has(key)) known.set(key, new Set());
    known.get(key).add(row.id);
  }
  const assets = [], rejections = [];
  for (const row of snapshot.venueCandidates || []) {
    const symbol = text(row.symbol).toUpperCase();
    const conflict = [...(known.get(symbol) || [])].some((id) => id !== row.id);
    const code = !limit ? 'venue_research_disabled'
      : ids.has(row.id) ? 'already_deep_analyzed'
        : !row.id || !symbol || conflict ? 'ambiguous_research_identity'
          : row.requiresVerifiedIdentity !== true || row.venueDiscovery?.coinId !== row.id ? 'unverified_research_identity'
            : snapshot.venueDiscovery?.status !== 'available' || !(row.price > 0)
              || !fresh(row.lastUpdated, now, Math.max(1, Number(settings.maxDiscoveryAssetAgeMinutes) || 30) * 60_000)
              ? 'stale_or_unavailable_research_metadata'
              : assets.length >= limit ? 'venue_research_analysis_budget' : null;
    if (code) { rejections.push({ assetId: row.id, symbol, stage: 'venue_research', code }); continue; }
    assets.push(row);
    ids.add(row.id);
    known.set(symbol, new Set([row.id]));
  }
  return { assets, rejections, cohort: 'full-venue-discovery-v1' };
}
