import { createHash } from 'node:crypto';
import { getGuildSettings } from './guildSettings.js';
import { readMarketSnapshot, writeMarketSnapshot } from './storage.js';
import { recordProviderRequest } from './providerTelemetry.js';
import { isRetryableProviderFailure, retryPlan } from './retryPolicy.js';
import { assertProviderAvailable, recordProviderCooldown, waitForProviderCooldown } from './providerCooldown.js';
import { appendCryptoUniverseSnapshot } from './cryptoUniverseJournal.js';
import { fetchBroadDiscovery } from './broadDiscovery.js';
import { cachedVenueRequest, fetchVenueDiscovery, planVenueResearch } from './venueDiscovery.js';
import { paceCoinGeckoResearch } from './researchProviderPacing.js';

const PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
const STABLE_SYMBOLS = new Set([
  'usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'usds', 'usdd', 'pyusd', 'gusd', 'frax',
  'lusd', 'susd', 'eurc', 'eurt', 'usdp', 'usd0', 'usd1', 'usdf', 'rlusd', 'usdt0'
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const nullableFinite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const COINGECKO_PAGE_SIZE = 250;
const DEMO_MONTHLY_REQUEST_BUDGET = 9_000;
const GLOBAL_CONTEXT_CACHE_MS = 60 * 60_000;
const marketUniverseInFlight = new Map();
const GLOBAL_CONTEXT_MAX_AGE_MS = 6 * 60 * 60_000;
const DEFAULT_DISCOVERY_ASSET_MAX_AGE_MS = 30 * 60_000;
let globalContextInFlight = null;

export function classifyDiscoveryTimestamp(value, now = Date.now(), maxAgeMs = DEFAULT_DISCOVERY_ASSET_MAX_AGE_MS) {
  if (value === null || value === undefined || String(value).trim() === '') return { state: 'unknown', observedAt: null, ageMs: null };
  const observedMs = Date.parse(String(value));
  if (!Number.isFinite(observedMs)) return { state: 'invalid', observedAt: null, ageMs: null };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) return { state: 'invalid', observedAt: new Date(observedMs).toISOString(), ageMs: null };
  const ageMs = nowMs - observedMs;
  const maximumAgeMs = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : DEFAULT_DISCOVERY_ASSET_MAX_AGE_MS;
  const state = ageMs < -60_000 ? 'future' : ageMs > maximumAgeMs ? 'stale' : 'fresh';
  return { state, observedAt: new Date(observedMs).toISOString(), ageMs: Math.max(0, Math.round(ageMs)) };
}

export function normalizeGlobalMarketContext(payload, { now = new Date(), fetchedAt = now } = {}) {
  const data = payload?.data || payload || {};
  const nowMs = new Date(now).getTime();
  const fetchedMs = new Date(fetchedAt).getTime();
  const rawUpdated = Number(data.updated_at);
  const normalizedUpdated = Date.parse(data.providerUpdatedAt || '');
  const providerUpdatedMs = Number.isFinite(normalizedUpdated) ? normalizedUpdated
    : Number.isFinite(rawUpdated) && rawUpdated > 0 ? (rawUpdated < 1e12 ? rawUpdated * 1000 : rawUpdated) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(fetchedMs) || !Number.isFinite(providerUpdatedMs)) return null;
  const boundedPct = (value) => {
    const n = nullableFinite(value);
    return n !== null && n >= 0 && n <= 100 ? n : null;
  };
  const normalized = data.source === 'CoinGecko public /global';
  const rawMarketCap = nullableFinite(normalized ? data.totalMarketCapUsd : data.total_market_cap?.usd);
  const rawVolume = nullableFinite(normalized ? data.totalVolumeUsd : data.total_volume?.usd);
  const totalMarketCapUsd = rawMarketCap !== null && rawMarketCap > 0 ? rawMarketCap : null;
  const totalVolumeUsd = rawVolume !== null && rawVolume >= 0 ? rawVolume : null;
  const btcDominancePct = boundedPct(normalized ? data.btcDominancePct : data.market_cap_percentage?.btc);
  const ethDominancePct = boundedPct(normalized ? data.ethDominancePct : data.market_cap_percentage?.eth);
  const rawMarketCapChange = nullableFinite(normalized ? data.marketCapChange24hPct : data.market_cap_change_percentage_24h_usd);
  const rawVolumeChange = nullableFinite(normalized ? data.volumeChange24hPct : data.volume_change_percentage_24h_usd);
  const marketCapChange24hPct = rawMarketCapChange !== null && rawMarketCapChange >= -100 ? rawMarketCapChange : null;
  const volumeChange24hPct = rawVolumeChange !== null && rawVolumeChange >= -100 ? rawVolumeChange : null;
  const activeValue = normalized ? data.activeCryptocurrencies : data.active_cryptocurrencies;
  const activeCryptocurrencies = activeValue !== null && activeValue !== undefined && activeValue !== ''
    && Number.isSafeInteger(Number(activeValue)) && Number(activeValue) >= 0 ? Number(activeValue) : null;
  const observed = [totalMarketCapUsd, totalVolumeUsd, btcDominancePct, ethDominancePct, marketCapChange24hPct, volumeChange24hPct]
    .some((value) => Number.isFinite(value));
  if (!observed) return null;
  const ageMs = nowMs - providerUpdatedMs;
  const fresh = ageMs >= -60_000 && ageMs <= GLOBAL_CONTEXT_MAX_AGE_MS;
  return {
    source: 'CoinGecko public /global', status: fresh ? 'fresh' : 'stale', available: true,
    fetchedAt: new Date(fetchedMs).toISOString(), providerUpdatedAt: new Date(providerUpdatedMs).toISOString(),
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
    activeCryptocurrencies,
    totalMarketCapUsd, totalVolumeUsd, btcDominancePct, ethDominancePct,
    marketCapChange24hPct, volumeChange24hPct
  };
}

async function getGlobalMarketContext({ now = new Date(), force = false } = {}) {
  const cacheKey = 'global-market-context';
  const nowMs = new Date(now).getTime();
  let cached = null;
  try { cached = await readMarketSnapshot(cacheKey); } catch {
    return { source: 'CoinGecko public /global', status: 'unavailable', available: false,
      cacheHit: false, cacheAgeMs: null, fetchError: 'Saved global-context cache is unreadable and was preserved.' };
  }
  const cacheAgeMs = cached?.fetchedAt ? nowMs - Date.parse(cached.fetchedAt) : Infinity;
  if (!force && cached?.available && cacheAgeMs >= 0 && cacheAgeMs < GLOBAL_CONTEXT_CACHE_MS) {
    const normalized = normalizeGlobalMarketContext(cached, { now, fetchedAt: cached.fetchedAt });
    return normalized ? { ...normalized, cacheHit: true, cacheAgeMs }
      : { source: 'CoinGecko public /global', status: 'unavailable', available: false, cacheHit: true, cacheAgeMs,
        fetchError: 'Saved global-context cache has invalid fields.' };
  }
  if (!force && globalContextInFlight) return globalContextInFlight;
  const request = (async () => {
    try {
      const payload = await fetchJson(`${PUBLIC_BASE}/global`, { provider: 'CoinGecko Global' });
      const context = normalizeGlobalMarketContext(payload, { now: new Date(), fetchedAt: new Date() });
      if (!context) throw new Error('CoinGecko global response had no usable market totals, dominance, or update time.');
      try { await writeMarketSnapshot(cacheKey, context); }
      catch { return { ...context, cacheHit: false, cacheAgeMs: 0, persistenceError: 'Fresh global context could not be cached.' }; }
      return { ...context, cacheHit: false, cacheAgeMs: 0 };
    } catch (error) {
      if (cached?.available) {
        const normalized = normalizeGlobalMarketContext(cached, { now, fetchedAt: cached.fetchedAt });
        return { ...(normalized || { source: 'CoinGecko public /global', available: false }), status: normalized ? 'stale' : 'unavailable', cacheHit: Boolean(normalized), cacheAgeMs,
          fetchError: String(error?.message || error).slice(0, 180) };
      }
      return { source: 'CoinGecko public /global', status: 'unavailable', available: false,
        cacheHit: false, cacheAgeMs: null, fetchError: String(error?.message || error).slice(0, 180) };
    }
  })();
  if (force) return request;
  globalContextInFlight = request;
  try { return await request; }
  finally { if (globalContextInFlight === request) globalContextInFlight = null; }
}

async function withGlobalMarketContext(snapshot, options = {}) {
  const context = await getGlobalMarketContext({ now: options.now || new Date(), force: options.forceGlobalContext });
  return { ...snapshot, globalMarketContext: context };
}

export function planMarketDiscovery(settings = {}, tier = 'public') {
  const discoveryMinutes = Math.max(5, Number(settings.discoveryMinutes) || 15);
  const marketRankCap = Math.max(1, Number(settings.maxMarketRank) || 250);
  const requestedMarketCapPages = Math.ceil(marketRankCap / COINGECKO_PAGE_SIZE);
  const refreshesPer30Days = Math.ceil(30 * 24 * 60 / discoveryMinutes);
  const demo = String(tier).toLowerCase() === 'demo';
  const requestsPerRefreshBudget = demo
    ? Math.max(1, Math.floor(DEMO_MONTHLY_REQUEST_BUDGET / refreshesPer30Days))
    : Infinity;
  const marketCapPages = Math.min(requestedMarketCapPages, Math.max(0, requestsPerRefreshBudget - 1));
  const bulkCallsPer30Days = (1 + marketCapPages) * refreshesPer30Days;
  const deepCandidateCap = Math.max(1, Math.min(20, Number(settings.maxProviderCandidates) || 8));
  // These are planning scenarios for scheduled discovery only, not an account-wide
  // quota guard. Monitoring, manual commands, retries, other guilds and clients
  // can add requests; the one-hour coin-ID cache can reduce repeat requests.
  const keyedDemoIdentityPlanning = demo && String(settings.coingeckoApiKey || '').trim()
    ? {
        deepCandidateCap,
        stableShortlistCallsPer30Days: bulkCallsPer30Days
          + deepCandidateCap * Math.min(refreshesPer30Days, 30 * 24)
          + Math.min(refreshesPer30Days, 30 * 2),
        fullTurnoverCallsPer30Days: bulkCallsPer30Days
          + deepCandidateCap * refreshesPer30Days
          + Math.min(refreshesPer30Days, 30 * 2),
        scope: 'scheduled_discovery_illustration_only'
      }
    : null;
  return {
    discoveryMinutes, marketRankCap, requestedMarketCapPages, marketCapPages,
    requestsPerRefresh: 1 + marketCapPages,
    estimatedCallsPer30Days: bulkCallsPer30Days,
    monthlyBudgetGuarded: demo,
    budgetGuardScope: demo ? 'bulk_discovery_pages_only' : null,
    demoMonthlyBudget: demo ? DEMO_MONTHLY_REQUEST_BUDGET : null,
    keyedDemoIdentityPlanning
  };
}

function providerConfig(settings) {
  const key = String(settings.coingeckoApiKey || '');
  const tier = String(settings.coingeckoApiTier || 'demo');
  if (!key || tier === 'public') return { base: PUBLIC_BASE, headers: {}, tier: 'public' };
  if (tier === 'pro') return { base: PRO_BASE, headers: { 'x-cg-pro-api-key': key }, tier };
  return { base: PUBLIC_BASE, headers: { 'x-cg-demo-api-key': key }, tier: 'demo' };
}

function providerCacheIdentity(settings = {}) {
  const provider = providerConfig(settings);
  const credentialIdentity = provider.tier === 'public' ? 'public'
    : createHash('sha256').update(String(settings.coingeckoApiKey || '')).digest('hex').slice(0, 12);
  return `${provider.tier}-${credentialIdentity}`;
}

export function marketUniverseCacheKey(settings = {}) {
  const provider = providerConfig(settings);
  const plan = planMarketDiscovery(settings, provider.tier);
  return `global-${providerCacheIdentity(settings)}-rank${plan.marketRankCap}-interval${plan.discoveryMinutes}`;
}

async function fetchJson(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt === 0) assertProviderAvailable(url);
      else await waitForProviderCooldown(url);
    } catch (error) {
      recordProviderRequest(options.provider || 'Market provider', { latencyMs: 0, error: 'Request deferred by provider-host cooldown', deferred: true });
      throw error;
    }
    const started = performance.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'OmniMod-Crypto/1.0', ...(options.headers || {}) },
        signal: AbortSignal.timeout(15_000)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${options.provider || 'Market provider'} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        error.serverDate = response.headers.get('date');
        throw error;
      }
      const payload = JSON.parse(text);
      recordProviderRequest(options.provider || 'Market provider', { latencyMs: performance.now() - started, status: response.status, headers: response.headers });
      return options.returnDetails ? { payload, headers: response.headers } : payload;
    } catch (error) {
      recordProviderRequest(options.provider || 'Market provider', {
        latencyMs: performance.now() - started, status: response?.status, headers: response?.headers,
        error: response?.ok ? 'Response body or JSON parsing failed' : response ? `HTTP ${response.status}` : error?.message || error
      });
      lastError = error;
      if (error?.status === 429) recordProviderCooldown(url, error.retryAfter, attempt, { serverDateHeader: error.serverDate });
      if (!isRetryableProviderFailure(error) || attempt === 2) break;
      const plan = retryPlan(error.retryAfter, attempt, { serverDateHeader: error.serverDate, baseDelayMs: 1_000 });
      if (!plan.retry) {
        error.message += ` Retry deferred because Retry-After requests ${plan.delayMs}ms, above the retry wait limit.`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    }
  }
  throw lastError;
}

export function normalizeAsset(item) {
  const price = finite(item.current_price);
  const marketCap = finite(item.market_cap);
  const volume24h = finite(item.total_volume);
  const high24h = finite(item.high_24h, price);
  const low24h = finite(item.low_24h, price);
  return {
    id: String(item.id || ''), symbol: String(item.symbol || '').toUpperCase(), name: String(item.name || ''),
    rank: finite(item.market_cap_rank, 9999), price, marketCap, volume24h, high24h, low24h,
    circulatingSupply: nullableFinite(item.circulating_supply), totalSupply: nullableFinite(item.total_supply),
    maxSupply: nullableFinite(item.max_supply), fullyDilutedValuation: nullableFinite(item.fully_diluted_valuation),
    athChangePercent: finite(item.ath_change_percentage),
    change1h: finite(item.price_change_percentage_1h_in_currency),
    change24h: finite(item.price_change_percentage_24h_in_currency ?? item.price_change_percentage_24h),
    change7d: finite(item.price_change_percentage_7d_in_currency),
    change30d: finite(item.price_change_percentage_30d_in_currency),
    volumeToMarketCap: marketCap > 0 ? volume24h / marketCap : 0,
    lastUpdated: String(item.last_updated || ''),
    // Preserve sample slots: compacting malformed observations silently shifts
    // later values and can make cross-asset index-wise correlation misleading.
    sparkline: Array.isArray(item.sparkline_in_7d?.price)
      ? item.sparkline_in_7d.price.map((value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null)
      : []
  };
}

function normalizePaprikaAsset(item) {
  const quote = item?.quotes?.USD || {};
  const price = finite(quote.price);
  const marketCap = finite(quote.market_cap);
  const volume24h = finite(quote.volume_24h);
  return {
    id: String(item.id || ''), symbol: String(item.symbol || '').toUpperCase(), name: String(item.name || ''),
    rank: finite(item.rank, 9999), price, marketCap, volume24h, high24h: price, low24h: price,
    athChangePercent: finite(quote.percent_from_price_ath), change1h: finite(quote.percent_change_1h),
    change24h: finite(quote.percent_change_24h), change7d: finite(quote.percent_change_7d),
    change30d: finite(quote.percent_change_30d), volumeToMarketCap: marketCap > 0 ? volume24h / marketCap : 0,
    lastUpdated: String(item.last_updated || ''), sparkline: []
  };
}

async function fetchCoinPaprikaFallback() {
  const rows = await fetchJson('https://api.coinpaprika.com/v1/tickers?quotes=USD', { provider: 'CoinPaprika' });
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('CoinPaprika returned an empty market universe.');
  return rows.map(normalizePaprikaAsset).filter((asset) => asset.id && asset.price > 0);
}

export async function fetchMarketUniverse(guildId, options = {}) {
  const settings = options.settings || await getGuildSettings(guildId);
  const cacheKey = options.cacheKey || marketUniverseCacheKey(settings);
  const pending = marketUniverseInFlight.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    const snapshot = await fetchMarketUniverseUncached(guildId, { ...options, settings, cacheKey });
    if (!settings.broadDiscoveryEnabled && !settings.venueDiscoveryEnabled) return snapshot;
    const provider = providerConfig(settings);
    const plan = planMarketDiscovery(settings, provider.tier);
    // The broader cohort is isolated from production candidates and paper orders
    // until the rank/identity/score changes have their own forward validation.
    const broadDiscovery = settings.broadDiscoveryEnabled ? await fetchBroadDiscovery({ provider, cacheKey: providerCacheIdentity(settings), fetchJson, settings,
      legacyCallsPer30Days: Math.max(plan.estimatedCallsPer30Days,
        plan.keyedDemoIdentityPlanning?.fullTurnoverCallsPer30Days || 0) }).catch((error) => ({
      version: 1, mode: 'discovery_research', status: 'error', errors: [String(error?.message || error).slice(0, 180)]
    })) : null;
    let venueDiscovery = null;
    let venueCandidates = [];
    if (settings.venueDiscoveryEnabled) {
      try {
        const researchPlan = planVenueResearch(settings, { tier: provider.tier,
          baselineCalls: Math.max(plan.estimatedCallsPer30Days, plan.keyedDemoIdentityPlanning?.fullTurnoverCallsPer30Days || 0),
          broadCalls: broadDiscovery?.plan?.projectedCallsPer30Days || 0 });
        const venue = await fetchVenueDiscovery({ provider, cacheKey: providerCacheIdentity(settings), fetchJson, settings,
          assets: snapshot.stale ? [] : snapshot.assets,
          mappingPagesPerRefresh: options.primeVenueIdentity ? 50 : 3,
          identityBudgetAvailable: researchPlan.allowed });
        venueDiscovery = { ...venue.report, requestPlanning: researchPlan };
        if (venue.candidates.length && researchPlan.allowed && Number(settings.venueResearchCandidates) > 0) {
          const ids = venue.candidates.map((row) => row.coinId);
          const query = new URLSearchParams({ vs_currency: 'usd', ids: ids.join(','), per_page: '50', page: '1',
            sparkline: 'true', price_change_percentage: '1h,24h,7d,30d' });
          // One shared cache per credential caps metadata refresh frequency even
          // if native venue rankings change during intervening monitor passes.
          const metadata = await cachedVenueRequest(`venue-shortlist-${providerCacheIdentity(settings)}`,
            Math.max(5, Number(settings.discoveryMinutes) || 15) * 60_000, async () => {
              const rows = await paceCoinGeckoResearch(provider.tier, () => fetchJson(`${provider.base}/coins/markets?${query}`, { provider: 'CoinGecko Venue Shortlist', headers: provider.headers }));
              if (!Array.isArray(rows) || rows.some((row) => !ids.includes(row?.id)) || new Set(rows.map((row) => row.id)).size !== rows.length) {
                throw new Error('Invalid venue shortlist market response.');
              }
              return { rows, ids, fetchedAt: new Date().toISOString() };
            }, Date.now());
          const rows = metadata.rows.filter((row) => ids.includes(row.id));
          venueCandidates = rows.map(normalizeAsset).filter((asset) => asset.id && asset.price > 0).map((asset) => ({
            ...asset, requiresVerifiedIdentity: true, discoveryOrigin: 'binance_full_venue',
            venueDiscovery: venue.candidates.find((row) => row.coinId === asset.id).identityEvidence,
          }));
          venueDiscovery.counts.marketMetadataReturned = venueCandidates.length;
          venueDiscovery.counts.marketMetadataMissing = ids.length - venueCandidates.length;
          venueDiscovery.metadataCacheHit = metadata.cacheHit;
          venueDiscovery.counts.metadataDeferredByCadence = ids.filter((id) => !metadata.ids.includes(id)).length;
        }
      } catch (error) {
        venueDiscovery = { ...venueDiscovery, status: 'degraded', error: String(error?.message || error).slice(0, 240) };
      }
    }
    return { ...snapshot, broadDiscovery, venueDiscovery, venueCandidates };
  })();
  marketUniverseInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (marketUniverseInFlight.get(cacheKey) === request) marketUniverseInFlight.delete(cacheKey);
  }
}

async function fetchMarketUniverseUncached(guildId, options = {}) {
  const settings = options.settings || await getGuildSettings(guildId);
  const cacheKey = options.cacheKey || marketUniverseCacheKey(settings);
  const cached = await readMarketSnapshot(cacheKey);
  const maxAgeMs = Math.max(2, Number(options.maxAgeMinutes ?? settings.discoveryMinutes) || 15) * 60_000;
  const cacheAgeMs = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  if (!options.force && cached?.assets?.length && cacheAgeMs >= 0 && cacheAgeMs < maxAgeMs) {
    return withGlobalMarketContext({ ...cached, source: `${cached.source || 'CoinGecko'} cache`, cacheHit: true, cacheAgeMs }, options);
  }

  const provider = providerConfig(settings);
  try {
    const plan = planMarketDiscovery(settings, provider.tier);
    const fields = {
      vs_currency: 'usd', per_page: String(COINGECKO_PAGE_SIZE), sparkline: 'true',
      price_change_percentage: '1h,24h,7d,30d', locale: 'en', precision: 'full'
    };
    const tracks = [];
    const requestPage = async (order, page) => {
      const query = new URLSearchParams({ ...fields, order, page: String(page) });
      return fetchJson(`${provider.base}/coins/markets?${query}`, { headers: provider.headers, provider: 'CoinGecko', returnDetails: true });
    };
    // Preserve the original high-volume discovery track, then add the configured market-cap leaders.
    const volumeResponse = await requestPage('volume_desc', 1);
    if (!Array.isArray(volumeResponse.payload) || volumeResponse.payload.length === 0) throw new Error('CoinGecko returned an empty volume-ranked market page.');
    tracks.push({ order: 'volume_desc', page: 1, response: volumeResponse });
    const providerErrors = [];
    for (let page = 1; page <= plan.marketCapPages; page += 1) {
      try {
        const response = await requestPage('market_cap_desc', page);
        if (!Array.isArray(response.payload) || response.payload.length === 0) throw new Error(`CoinGecko returned an empty market-cap page ${page}.`);
        tracks.push({ order: 'market_cap_desc', page, response });
      } catch (error) {
        providerErrors.push(`market_cap_desc page ${page}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const uniqueAssets = new Map();
    let providerRowsReturned = 0;
    let providerReportedTotal = null;
    let providerPageSize = null;
    for (const track of tracks) {
      const rows = track.response.payload;
      providerRowsReturned += rows.length;
      const total = Number(track.response.headers.get('total'));
      const pageSize = Number(track.response.headers.get('per-page'));
      if (!providerReportedTotal && Number.isSafeInteger(total) && total > 0) providerReportedTotal = total;
      if (!providerPageSize && Number.isSafeInteger(pageSize) && pageSize > 0) providerPageSize = pageSize;
      for (const row of rows) {
        const asset = normalizeAsset(row);
        if (asset.id && asset.price > 0) uniqueAssets.set(asset.id, asset);
      }
    }
    const snapshot = {
      version: 2, fetchedAt: new Date().toISOString(), source: `CoinGecko ${provider.tier}`,
      providerReportedTotal, providerPageSize: providerPageSize || COINGECKO_PAGE_SIZE,
      providerRowsReturned, discoveryPages: tracks.length,
      volumePagesFetched: tracks.filter((track) => track.order === 'volume_desc').length,
      marketCapPagesFetched: tracks.filter((track) => track.order === 'market_cap_desc').length,
      marketCapPagesRequested: plan.requestedMarketCapPages,
      marketCapRankCapRequested: plan.marketRankCap, discoveryIntervalMinutes: plan.discoveryMinutes,
      queryOrder: 'volume_desc + market_cap_desc',
      estimatedCallsPer30Days: plan.estimatedCallsPer30Days,
      discoveryBudget: { guarded: plan.monthlyBudgetGuarded, scope: plan.budgetGuardScope,
        monthlyCeiling: plan.demoMonthlyBudget, keyedIdentityPlanning: plan.keyedDemoIdentityPlanning },
      providerErrors,
      providerError: providerErrors.length ? providerErrors.join('; ') : undefined,
      assets: [...uniqueAssets.values()]
    };
    snapshot.universeJournal = await appendCryptoUniverseSnapshot(snapshot).catch((error) => ({
      status: 'error', reason: String(error?.message || error).slice(0, 180)
    }));
    await writeMarketSnapshot(cacheKey, snapshot);
    return withGlobalMarketContext({ ...snapshot, cacheHit: false, cacheAgeMs: 0 }, options);
  } catch (error) {
    try {
      const assets = await fetchCoinPaprikaFallback();
      const snapshot = {
        version: 2, fetchedAt: new Date().toISOString(), source: 'CoinPaprika public fallback', assets,
        providerReportedTotal: null, providerPageSize: null, providerRowsReturned: assets.length, discoveryPages: 1, queryOrder: 'provider-defined',
        providerError: error instanceof Error ? error.message : String(error)
      };
      snapshot.universeJournal = await appendCryptoUniverseSnapshot(snapshot).catch((journalError) => ({
        status: 'error', reason: String(journalError?.message || journalError).slice(0, 180)
      }));
      await writeMarketSnapshot(cacheKey, snapshot);
      return withGlobalMarketContext({ ...snapshot, cacheHit: false, cacheAgeMs: 0, fallback: true }, options);
    } catch (fallbackError) {
    const combinedError = `${error instanceof Error ? error.message : String(error)}; CoinPaprika: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
    if (cached?.assets?.length) {
      return withGlobalMarketContext({
        ...cached, source: `${cached.source || 'CoinGecko'} stale cache`, cacheHit: true, stale: true,
          cacheAgeMs, providerError: combinedError
      }, options);
    }
      throw new Error(combinedError);
    }
  }
}

function logRangeScore(value, lowExponent, highExponent) {
  if (!(Number.isFinite(Number(value)) && Number(value) > 0)) return null;
  return clamp((Math.log10(Number(value)) - lowExponent) / (highExponent - lowExponent) * 100, 0, 100);
}

function executionLiquidityShadow(asset, productionScore, liquidity, technicallyConfirmed, snapshotScore, now) {
  const micro = asset.marketData?.microstructure;
  const execution = asset.marketData?.execution;
  const observedMs = Date.parse(micro?.observedAt || '');
  const ageMs = new Date(now).getTime() - observedMs;
  const volume = Number(asset.volume24h);
  const depth = Number(micro?.depthUsd1Pct);
  const spread = Number(micro?.spreadP95Bps);
  const slippage = Number(execution?.oneWaySlippageBps);
  if (!micro?.available || !execution?.available || !Number.isFinite(observedMs) || ageMs < 0 || ageMs > 90_000
    || !(volume > 0 && depth > 0) || !Number.isFinite(spread) || spread < 0 || !Number.isFinite(slippage) || slippage < 0) return null;
  const volumeScore = logRangeScore(volume, 5, 11); // $100k–$100B USD/day
  const depthScore = logRangeScore(depth, 4, 7); // $10k–$10M within 1% of midpoint
  const spreadScore = clamp(100 - spread / 2, 0, 100); // 0–200 bps 95th-percentile spread
  const impactScore = clamp(100 - slippage / 2, 0, 100); // 0–200 bps modeled one-way cost
  const factor = volumeScore * 0.4 + depthScore * 0.3 + spreadScore * 0.15 + impactScore * 0.15;
  const scoreDelta = (factor - liquidity) * 0.24 * 0.48 * (technicallyConfirmed ? 0.19 : 1);
  return {
    version: 'execution-liquidity-v1', score: clamp(productionScore + scoreDelta, 0, 100), factor,
    productionLiquidityFactor: liquidity, volumeScore, depthScore, spreadScore, impactScore,
    volume24hUsd: volume, depthUsd1Pct: depth, spreadP95Bps: spread, modeledOneWaySlippageBps: slippage,
    observedAt: micro.observedAt, observationAgeMs: ageMs,
    method: 'Research-only score replacement. Volume $100k–$100B, 1%-depth $10k–$10M, and 95th-percentile spread/modeled one-way cost 0–200 bps are log/linear scaled and weighted 40/30/15/15. Anchors and weights are unvalidated.'
  };
}

export function assessStrategyValidation(validation) {
  const recent = validation?.recent;
  const overall = validation?.overall;
  const availableNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const hasObservedTrades = (segment) => Number.isInteger(segment?.trades) && segment.trades > 0;
  const profitFactor = (value) => Number.isFinite(Number(value)) ? Number(value) : value === Infinity ? 3 : 0;
  const recentProfitFactor = profitFactor(recent?.profitFactor);
  const overallProfitFactor = profitFactor(overall?.profitFactor);
  const reasons = [];
  if (validation?.dataQuality && !validation.dataQuality.contiguous) reasons.push('incomplete_historical_candle_path');
  if (!validation?.sufficient) reasons.push('insufficient_historical_sample');
  if (!hasObservedTrades(recent) || !availableNumber(recent?.expectancyR)) reasons.push('missing_recent_expectancy');
  else if (!(finite(recent.expectancyR) > 0)) reasons.push('nonpositive_recent_expectancy');
  if (!hasObservedTrades(overall) || !availableNumber(overall?.expectancyR)) reasons.push('missing_overall_expectancy');
  else if (!(finite(overall.expectancyR) > 0)) reasons.push('nonpositive_overall_expectancy');
  if (!hasObservedTrades(recent) || (!availableNumber(recent?.profitFactor) && recent?.profitFactor !== Infinity)) reasons.push('missing_recent_profit_factor');
  else if (!(recentProfitFactor > 1)) reasons.push('recent_profit_factor_not_above_one');
  if (!hasObservedTrades(overall) || (!availableNumber(overall?.profitFactor) && overall?.profitFactor !== Infinity)) reasons.push('missing_overall_profit_factor');
  else if (!(overallProfitFactor > 1)) reasons.push('overall_profit_factor_not_above_one');
  return { passed: reasons.length === 0, reasons, recentProfitFactor, overallProfitFactor };
}

export function scoreAsset(asset, options = {}) {
  const momentum = clamp(50 + asset.change1h * 1.4 + asset.change24h * 1.7 + asset.change7d * 0.8, 0, 100);
  const liquidity = clamp(88 - Math.max(0, asset.rank - 1) * 2.2 + Math.log10(Math.max(1, asset.volume24h)) * 2, 0, 100);
  const breadth = clamp(50 + (asset.change24h > 0 ? 12 : -8) + (asset.change7d > 0 ? 14 : -10), 0, 100);
  const pullback = clamp(70 + asset.athChangePercent * 0.35, 10, 100);
  const volatilityPenalty = clamp(Math.abs(asset.change24h) * 1.3 + Math.abs(asset.change7d) * 0.22, 0, 26);
  const desktopScore = clamp(momentum * 0.38 + liquidity * 0.24 + breadth * 0.22 + pullback * 0.16 - volatilityPenalty, 0, 100);

  const range = Math.max(0, asset.high24h - asset.low24h);
  const rangePosition = range > 0 ? clamp((asset.price - asset.low24h) / range, 0, 1) : 0.5;
  const burst = clamp(50 + asset.change1h * 8 + asset.change24h * 2 + asset.change7d * 0.25, 0, 100);
  const relativeVolume = clamp(50 + Math.log10(Math.max(0.0001, asset.volumeToMarketCap) / 0.02) * 25, 0, 100);
  const trendConsistency = [asset.change1h, asset.change24h, asset.change7d].filter((value) => value > 0).length / 3 * 100;
  const chasePenalty = clamp(Math.max(0, asset.change1h - 4) * 2.5 + Math.max(0, rangePosition - 0.96) * 80, 0, 18);
  const snapshotScore = clamp(
    desktopScore * 0.48 + burst * 0.22 + relativeVolume * 0.13 + trendConsistency * 0.10 + rangePosition * 100 * 0.07 - chasePenalty,
    0, 100
  );

  const marketData = asset.marketData || {};
  const technicals = marketData.technicals || {};
  const technicallyConfirmed = Boolean(technicals.dataSufficient);
  const providerQuality = finite(marketData.coverageScore, 0);
  const regimeScore = finite(marketData.regime?.score, 50);
  const orderBookScore = marketData.orderBook?.available
    ? clamp(50 + finite(marketData.orderBook.imbalance) * 45, 15, 85) : 50;
  const validation = marketData.validation?.recent;
  const overallValidation = marketData.validation?.overall;
  const validationAssessment = assessStrategyValidation(marketData.validation);
  const validationProfitFactor = validationAssessment.recentProfitFactor;
  const validationScore = validation?.trades >= 5
    ? clamp(50 + finite(validation.expectancyR) * 25 + (Math.min(3, validationProfitFactor) - 1) * 8, 10, 90)
    : 50;
  const validationPassed = validationAssessment.passed;
  const consensusPenalty = clamp(
    finite(marketData.priceDispersionPct) * 18 + finite(marketData.medianSpreadPct) * 12,
    0, 24
  );
  const derivatives = marketData.derivatives || {};
  const derivativesScore = derivatives.available ? clamp(derivatives.score, 0, 100) : 50;
  const micro = marketData.microstructure || {};
  const microstructureScore = micro.available ? clamp(
    50 + finite(micro.orderFlowImbalance) * 22 + finite(micro.depthImbalance) * 12
      + (finite(micro.aggressorBuyRatio, 0.5) - 0.5) * 24
      - Math.max(0, finite(micro.spreadBps) - 8) * 0.7
      - Math.max(0, finite(micro.quoteVolatilityBps) - 6) * 0.4,
    0, 100
  ) : 50;
  const executionPenalty = marketData.execution?.blockTrade
    ? 18 : clamp(Math.max(0, finite(marketData.execution?.oneWaySlippageBps) - 12) * 0.35, 0, 10);
  const score = technicallyConfirmed
    ? clamp(
      snapshotScore * 0.19 + finite(technicals.technicalScore) * 0.28 + providerQuality * 0.12
      + regimeScore * 0.09 + orderBookScore * 0.05 + validationScore * 0.10
      + derivativesScore * 0.09 + microstructureScore * 0.08 - consensusPenalty - executionPenalty,
      0, 100
    )
    : snapshotScore;
  const liquidityShadow = executionLiquidityShadow(asset, score, liquidity, technicallyConfirmed, snapshotScore, options.now || new Date());

  const swing = Math.abs(asset.change24h) + Math.abs(asset.change7d) * 0.28;
  const atrPct = finite(technicals.atrPct);
  const risk = marketData.conflicted || atrPct > 4.5 || derivatives.blockLongs
    || marketData.execution?.blockTrade || marketData.eventRisk?.blocked ? 'High'
    : asset.rank <= 2 && swing < 10 && atrPct < 2.5 ? 'Core'
    : swing > 18 || asset.rank > 100 ? 'High'
      : swing > 10 || asset.rank > 35 ? 'Elevated' : 'Moderate';
  const trend = technicallyConfirmed && technicals.ema9 > technicals.ema21 && technicals.ema21 > technicals.ema50 ? 'Confirmed EMA uptrend'
    : technicallyConfirmed && technicals.ema9 < technicals.ema21 && technicals.macdHistogram < 0 ? 'Intraday trend weakening'
      : asset.change1h > 0 && asset.change24h > 0 && asset.change7d > 0 ? 'Stacked uptrend'
    : asset.change1h > 0.4 && asset.change24h > -3 ? 'Bullish reversal'
      : asset.change24h < -4 && asset.change7d < -6 ? 'Risk-off slide'
        : Math.abs(asset.change24h) < 2 && Math.abs(asset.change7d) < 5 ? 'Range-bound'
          : asset.change7d >= 0 ? 'Constructive' : 'Under pressure';

  return {
    score, snapshotScore, desktopScore, momentum, liquidity, breadth, pullback, burst, relativeVolume, liquidityShadow,
    trendConsistency, rangePosition, volatilityPenalty, chasePenalty, risk, trend,
    technicallyConfirmed, technicalScore: finite(technicals.technicalScore), rsi14: finite(technicals.rsi14, 50),
    adx14: finite(technicals.adx14), atrPct, volumeZScore: finite(technicals.volumeZScore),
    providerQuality, providerCount: finite(marketData.providerCount), exchangeProviderCount: finite(marketData.exchangeProviderCount),
    priceDispersionPct: finite(marketData.priceDispersionPct), medianSpreadPct: finite(marketData.medianSpreadPct),
    orderBookImbalance: finite(marketData.orderBook?.imbalance), regime: marketData.regime || null,
    derivativesScore, derivativesProviderCount: finite(derivatives.providerCount),
    fundingAnnualizedPct: finite(derivatives.fundingAnnualizedPct),
    openInterestChangePct: finite(derivatives.openInterestChangePct),
    longShortRatio: finite(derivatives.longShortRatio),
    longShortRatioAvailable: Boolean(derivatives.longShortRatioAvailable),
    takerBuySellRatio: finite(derivatives.takerBuySellRatio),
    takerBuySellRatioAvailable: Boolean(derivatives.takerBuySellRatioAvailable),
    basisPct: finite(derivatives.basisPct), derivativesBlocked: Boolean(derivatives.blockLongs),
    microstructureScore, microstructureAvailable: Boolean(micro.available),
    orderFlowImbalance: finite(micro.orderFlowImbalance), depthImbalance: finite(micro.depthImbalance),
    microSpreadBps: finite(micro.spreadBps), depthUsd1Pct: finite(micro.depthUsd1Pct),
    executionCostBps: finite(marketData.execution?.estimatedRoundTripBps),
    executionBlocked: Boolean(marketData.execution?.blockTrade), eventBlocked: Boolean(marketData.eventRisk?.blocked),
    validationScore, validationTrades: finite(validation?.trades), validationExpectancyR: finite(validation?.expectancyR),
    validationOverallTrades: finite(overallValidation?.trades),
    validationOverallExpectancyR: finite(overallValidation?.expectancyR), validationPassed,
    validationFailureReasons: validationAssessment.reasons,
    validationWarning: String(marketData.validation?.warning || ''),
    dataConflict: Boolean(marketData.conflicted), consensusPenalty,
    discoveryTimestampState: String(asset.discoveryTimestampState || 'unknown'),
    discoveryTimestampAgeMs: nullableFinite(asset.discoveryTimestampAgeMs)
  };
}

export function screenMomentum(snapshot, settings, options = {}) {
  return screenMomentumDetailed(snapshot, settings, options).candidates;
}

export function getAmbiguousProviderSymbols(assets = []) {
  const idsBySymbol = new Map();
  for (const [index, asset] of assets.entries()) {
    const symbol = String(asset?.symbol || '').trim().toLowerCase();
    if (!symbol) continue;
    if (!idsBySymbol.has(symbol)) idsBySymbol.set(symbol, new Set());
    idsBySymbol.get(symbol).add(String(asset?.id || `row-${index}`).trim().toLowerCase());
  }
  return new Set([...idsBySymbol].filter(([, ids]) => ids.size > 1).map(([symbol]) => symbol));
}

export function screenMomentumDetailed(snapshot, settings, options = {}) {
  const requireConfirmation = Boolean(options.requireConfirmation);
  const collectAllRejections = options.collectAllRejections === true;
  const validationAdvisory = options.validationAdvisory === true;
  const requireDiscoveryTimestamp = options.requireDiscoveryTimestamp === true;
  const staleSnapshot = options.staleSnapshot === true;
  const now = options.now ?? Date.now();
  const configuredAgeMinutes = Number(settings.maxDiscoveryAssetAgeMinutes);
  const maxAssetAgeMs = options.maxDiscoveryQuoteAgeMs ?? (Number.isFinite(configuredAgeMinutes) && configuredAgeMinutes > 0
    ? configuredAgeMinutes * 60_000 : DEFAULT_DISCOVERY_ASSET_MAX_AGE_MS);
  const minimumProviders = Math.max(2, Number(settings.minProviderConfirmations) || 2);
  const ambiguousProviderSymbols = getAmbiguousProviderSymbols(snapshot.assets || []);
  const candidates = [];
  const rejections = [];
  const stageCounts = { universe: (snapshot.assets || []).length, freshnessPassed: 0, freshnessUnknown: 0, freshnessRejected: 0,
    nonStable: 0, identityRejected: 0, rankPassed: 0, liquidityPassed: 0, scorePassed: 0, trendPassed: 0 };
  const reject = (asset, stage, code) => rejections.push({ symbol: String(asset.symbol || '').trim().toUpperCase(),
    assetId: String(asset.id || '').slice(0, 120) || null, stage, code });
  for (const asset of snapshot.assets || []) {
    const symbol = String(asset.symbol || '').trim().toLowerCase();
    if (symbol && STABLE_SYMBOLS.has(symbol)) { reject(asset, 'discovery', 'stable_asset'); continue; }
    stageCounts.nonStable += 1;
    if (!symbol) {
      stageCounts.identityRejected += 1;
      rejections.push({ symbol: '', assetId: String(asset.id || '').slice(0, 120), stage: 'data_identity', code: 'missing_asset_symbol' });
      continue;
    }
    if (ambiguousProviderSymbols.has(symbol)) {
      stageCounts.identityRejected += 1;
      reject(asset, 'data_identity', 'duplicate_provider_symbol');
      continue;
    }
    const freshness = classifyDiscoveryTimestamp(asset.lastUpdated, now, maxAssetAgeMs);
    const freshnessRejection = staleSnapshot ? 'stale_market_snapshot'
      : ['invalid', 'stale', 'future'].includes(freshness.state) ? `provider_timestamp_${freshness.state}`
        : freshness.state === 'unknown' && requireDiscoveryTimestamp ? 'provider_timestamp_missing' : '';
    if (freshnessRejection) {
      stageCounts.freshnessRejected += 1;
      reject(asset, 'data_freshness', freshnessRejection);
      continue;
    }
    if (freshness.state === 'unknown') stageCounts.freshnessUnknown += 1;
    else stageCounts.freshnessPassed += 1;
    if (!(asset.rank <= settings.maxMarketRank)) { reject(asset, 'candidate_filter', 'market_rank'); continue; }
    stageCounts.rankPassed += 1;
    if (!(asset.volume24h >= settings.minVolumeUsd && asset.volumeToMarketCap >= 0.004)) { reject(asset, 'candidate_filter', 'liquidity'); continue; }
    stageCounts.liquidityPassed += 1;
    const row = { ...asset, discoveryTimestampState: freshness.state, discoveryTimestampAgeMs: freshness.ageMs, model: null };
    row.model = scoreAsset(row);
    const scorePassed = row.model.score >= settings.minScore;
    let rejected = false;
    if (!scorePassed) {
      reject(asset, 'candidate_filter', 'minimum_score');
      rejected = true;
      // Keep the historical first-failure behavior for ordinary callers. The
      // full audit mode evaluates later gates too, without changing eligibility.
      if (!collectAllRejections || !requireConfirmation) continue;
    } else stageCounts.scorePassed += 1;
    if (requireConfirmation) {
      const confirmationChecks = [
        [row.model.technicallyConfirmed, 'technical_data'],
        ...(['coingecko_pro', 'coingecko_demo', 'coingecko_public'].includes(row.marketData?.assetIdentity?.mode)
          ? [[Number(row.marketData.assetIdentity.verifiedVenueCount) >= minimumProviders, 'coin_id_pair_verification']]
          : []),
        [row.model.providerCount >= minimumProviders, 'provider_confirmation'],
        [!row.model.dataConflict, 'provider_conflict'],
        [row.model.regime?.allowNewLongs !== false, 'market_regime'],
        [!row.model.derivativesBlocked, 'derivatives_crowding'],
        [!row.model.executionBlocked, 'execution_cost'],
        [!row.model.eventBlocked, 'event_veto'],
        ...(validationAdvisory ? [] : [[row.model.validationPassed, 'strategy_validation']])
      ];
      for (const [passes, reason] of confirmationChecks) {
        if (passes) continue;
        reject(asset, 'model_approval', reason);
        rejected = true;
        if (!collectAllRejections) break;
      }
      if (rejected && !collectAllRejections) continue;
    }
    const trendPasses = row.model.technicallyConfirmed
      ? row.marketData.technicals.return1h > -0.6 && row.marketData.technicals.ema9 > row.marketData.technicals.ema21
      : row.change1h > 0.05 && row.change24h > -3.5;
    if (!trendPasses) {
      reject(asset, 'candidate_filter', 'trend_continuation');
      rejected = true;
    } else stageCounts.trendPassed += 1;
    if (rejected) continue;
    candidates.push(row);
  }
  candidates.sort((a, b) => b.model.score - a.model.score || b.volume24h - a.volume24h);
  return { candidates, rejections, stageCounts };
}

export function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'n/a';
  const digits = price >= 1000 ? 2 : price >= 1 ? 4 : price >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(price);
}

export function formatPercent(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}
