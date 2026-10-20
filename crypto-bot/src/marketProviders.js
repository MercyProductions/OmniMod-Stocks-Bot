import { analyzeCandles, classifyMarketRegime, normalizeCandles } from './technicalAnalysis.js';
import { validateStrategy } from './backtest.js';
import { appendCandleBatch } from './researchStore.js';
import { fetchDerivativesSnapshot } from './derivativesProviders.js';
import { estimateExecutionCost } from './executionSimulator.js';
import { compareCurrentQuoteCost } from './validationCostSensitivity.js';
import { evaluateEventRisk } from './eventRisk.js';
import { recordProviderRequest } from './providerTelemetry.js';
import { isRetryableProviderFailure, retryPlan } from './retryPolicy.js';
import { assertProviderAvailable, recordProviderCooldown, waitForProviderCooldown } from './providerCooldown.js';
import { createHash } from 'node:crypto';
import { inspectCoinGeckoPairEvidence, inspectPinnedSpotPair, planVerifiedSpotRoutes, SPOT_PAIR_ROUTING_VERSION } from './spotPairRouting.js';

import { parseCoinbaseProduct, parseKrakenProduct } from './cryptoProductMetadata.js';
import { cryptoInstrumentRulesRejection } from '../../new-bots/shared/cryptoInstrumentRules.js';
import { parseCoinbasePaperBook } from './coinbasePaperBook.js';
import { normalizeCryptoExecutionIdentity, cryptoIdentityRejection, CRYPTO_IDENTITY_MAX_AGE_MS } from '../../new-bots/shared/cryptoExecutionIdentity.js';

const BINANCE_BASE = 'https://data-api.binance.vision';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const KRAKEN_BASE = 'https://api.kraken.com/0/public';
const COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
const COINGECKO_DEMO_BASE = 'https://api.coingecko.com/api/v3';
const USER_AGENT = 'OmniMod-Crypto/3.0 market-research-bot';
const candleCache = new Map();
const candleInFlight = new Map();
const providerQuoteInFlight = new Map();
let krakenPairCache = { expiresAt: 0, pairs: [] };
let krakenPairRequest = null;
let spotCoverageCache = { expiresAt: 0, venues: null };
let spotCoverageRequest = null;
const identityCache = new Map();
const identityInFlight = new Map();
const exchangeDirectoryCache = new Map();
const exchangeDirectoryRequests = new Map();

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const providerTimestamp = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const observed = new Date(typeof value === 'number' || /^\d{12,17}$/.test(String(value)) ? Number(value) : value);
  return Number.isFinite(observed.getTime()) && observed.getTime() > 0 ? observed.toISOString() : null;
};

function median(values = []) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

// Public REST limit is 10 requests/s/IP. Share a 150ms gate across this
// process's Coinbase books, tickers, directories and history (including retries).
// Other processes on the same IP still require deployment-wide quota budgeting.
let coinbasePacing = Promise.resolve();
let lastCoinbaseRequestAt = 0;
async function paceCoinbaseRequest(url) {
  if (new URL(url).origin !== COINBASE_BASE) return;
  const turn = coinbasePacing.catch(() => {}).then(async () => {
    const delay = Math.max(0, 150 - (Date.now() - lastCoinbaseRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastCoinbaseRequestAt = Date.now();
  });
  coinbasePacing = turn;
  await turn;
}

async function requestJson(url, provider, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt === 0) assertProviderAvailable(url);
      else await waitForProviderCooldown(url);
      await paceCoinbaseRequest(url);
      // A concurrent response may establish a cooldown while this request queues.
      assertProviderAvailable(url);
    } catch (error) {
      recordProviderRequest(provider, { latencyMs: 0, error: 'Request deferred by provider-host cooldown', deferred: true });
      throw error;
    }
    const started = performance.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 10_000)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${provider} returned HTTP ${response.status}: ${text.slice(0, 180)}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        error.serverDate = response.headers.get('date');
        throw error;
      }
      const payload = JSON.parse(text);
      recordProviderRequest(provider, { latencyMs: performance.now() - started, status: response.status, headers: response.headers });
      return payload;
    } catch (error) {
      recordProviderRequest(provider, {
        latencyMs: performance.now() - started, status: response?.status, headers: response?.headers,
        error: response?.ok ? 'Response body or JSON parsing failed' : response ? `HTTP ${response.status}` : error?.message || error
      });
      lastError = error;
      if (error?.status === 429) recordProviderCooldown(url, error.retryAfter, attempt, { serverDateHeader: error.serverDate });
      if (!isRetryableProviderFailure(error) || attempt === 2) break;
      const plan = retryPlan(error.retryAfter, attempt, { serverDateHeader: error.serverDate });
      if (!plan.retry) {
        error.message += ` Retry deferred because Retry-After requests ${plan.delayMs}ms, above the retry wait limit.`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    }
  }
  throw lastError;
}

function providerSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  const aliases = { XBT: 'BTC', XDG: 'DOGE' };
  return aliases[normalized] || normalized;
}

function normalizedPairPart(value) {
  return providerSymbol(String(value || '').trim()).replace(/[^A-Z0-9]/g, '');
}

function identityPairKey(provider, base, target) {
  return `${String(provider || '').toLowerCase()}:${normalizedPairPart(base)}:${normalizedPairPart(target)}`;
}

export function verifiedCoinGeckoTickerPairs(asset, tickerPayload, exchangeIds = {}) {
  const coinId = String(asset?.id || '').trim().toLowerCase();
  if (!coinId || !Array.isArray(tickerPayload?.tickers)) return new Set();
  const providerByExchangeId = new Map(Object.entries(exchangeIds).map(([provider, id]) => [String(id).toLowerCase(), provider]));
  const verified = new Set();
  for (const ticker of tickerPayload.tickers) {
    const provider = providerByExchangeId.get(String(ticker?.market?.identifier || '').toLowerCase());
    if (!provider || String(ticker?.coin_id || '').toLowerCase() !== coinId || ticker?.is_stale === true || ticker?.is_anomaly === true) continue;
    const base = normalizedPairPart(ticker.base);
    const target = normalizedPairPart(ticker.target);
    if (base && target) verified.add(identityPairKey(provider, base, target));
  }
  return verified;
}

async function coingeckoExchangeIds(apiKey, tier) {
  const credentialKey = `${tier}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
  const cached = exchangeDirectoryCache.get(credentialKey);
  if (cached?.expiresAt > Date.now()) return cached.ids;
  if (exchangeDirectoryRequests.has(credentialKey)) return exchangeDirectoryRequests.get(credentialKey);
  const base = tier === 'pro' ? COINGECKO_PRO_BASE : COINGECKO_DEMO_BASE;
  const headers = apiKey ? { [tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: apiKey } : {};
  const request = (async () => {
    const payload = await paceCoinGeckoResearch(tier, () => requestJson(`${base}/exchanges/list?status=active`, 'CoinGecko Identity', { headers }));
    if (!Array.isArray(payload)) throw new Error('CoinGecko returned an invalid exchange directory.');
    const names = payload.map((row) => ({ id: String(row?.id || '').trim(), name: String(row?.name || '').trim().toLowerCase() }));
    const match = (predicate) => names.find((row) => predicate(row.name))?.id || '';
    const ids = {
      Binance: match((name) => name === 'binance'),
      Coinbase: match((name) => name === 'coinbase exchange'),
      Kraken: match((name) => name === 'kraken')
    };
    if (Object.values(ids).filter(Boolean).length < 2) throw new Error('CoinGecko exchange directory did not identify at least two configured spot venues.');
    exchangeDirectoryCache.set(credentialKey, { expiresAt: Date.now() + 12 * 60 * 60_000, ids });
    return ids;
  })();
  exchangeDirectoryRequests.set(credentialKey, request);
  try { return await request; }
  finally { if (exchangeDirectoryRequests.get(credentialKey) === request) exchangeDirectoryRequests.delete(credentialKey); }
}

async function verifyCoinGeckoAssetMarkets(asset, settings = {}) {
  const configuredTier = String(settings.coingeckoApiTier || '').trim().toLowerCase();
  const configuredKey = String(settings.coingeckoApiKey || '').trim();
  const required = asset.requiresVerifiedIdentity === true;
  if (!required && !configuredKey && configuredTier !== 'pro') return { mode: configuredTier === 'demo' ? 'ticker_only_demo' : 'ticker_only_free', verifiedPairs: null };
  if (!required && (configuredTier === 'public' || configuredTier === '')) return { mode: 'ticker_only_free', verifiedPairs: null };
  const tier = configuredTier === 'pro' ? 'pro' : configuredKey && configuredTier === 'demo' ? 'demo' : 'public';
  const apiKey = tier === 'public' ? '' : configuredKey;
  if (configuredTier && !['public', 'pro', 'demo'].includes(configuredTier)) throw new Error('Unrecognized CoinGecko API tier for identity verification.');
  const coinId = String(asset?.id || '').trim().toLowerCase();
  if ((!apiKey && tier !== 'public') || !coinId) throw new Error('CoinGecko identity verification requires the selected tier credentials and asset ID.');
  const key = `${tier}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}:${coinId}:${required ? 'complete' : 'legacy'}`;
  const cached = identityCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;
  if (identityInFlight.has(key)) return identityInFlight.get(key);
  const request = (async () => {
    const exchangeIds = await coingeckoExchangeIds(apiKey, tier);
    const allowedIds = Object.values(exchangeIds).filter(Boolean);
    const base = tier === 'pro' ? COINGECKO_PRO_BASE : COINGECKO_DEMO_BASE;
    const headers = apiKey ? { [tier === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: apiKey } : {};
    const tickers = [];
    let tickerRowsReturned = 0, excludedUncleanRows = 0, identityPages = 0;
    // Required broad identities never fall back to ticker-only matching. Keep
    // expensive identity requests bounded and fail explicitly on truncation.
    let complete = false;
    for (let page = 1; page <= (required ? 5 : 1); page += 1) {
      const query = new URLSearchParams({ exchange_ids: allowedIds.join(','), page: String(page), order: 'volume_desc' });
      const payload = await paceCoinGeckoResearch(tier, () => requestJson(`${base}/coins/${encodeURIComponent(coinId)}/tickers?${query}`, 'CoinGecko Identity', { headers }));
      if (!Array.isArray(payload?.tickers) || payload.tickers.length > 100) throw new Error('Invalid coin-ID ticker response.');
      identityPages += 1;
      tickerRowsReturned += payload.tickers.length;
      excludedUncleanRows += payload.tickers.filter((row) => required && (row.is_stale !== false || row.is_anomaly !== false)).length;
      tickers.push(...payload.tickers.filter((row) => !required || (row.is_stale === false && row.is_anomaly === false)));
      if (payload.tickers.length < 100) { complete = true; break; }
    }
    if (required && !complete) throw new Error('Coin-ID pair verification pagination exceeded the request budget.');
    const evidence = required ? inspectCoinGeckoPairEvidence(asset, { tickers }, exchangeIds, { strict: true }) : null;
    const value = { mode: `coingecko_${tier}`, verifiedAt: new Date().toISOString(), verifiedPairs: evidence?.verifiedPairs ?? verifiedCoinGeckoTickerPairs(asset, { tickers }, exchangeIds),
      coverage: { pages: identityPages, terminalPageObserved: complete, tickerRowsReturned, excludedUncleanRows,
        ...(evidence ? { pairRejectionReasons: evidence.rejectionReasons } : {}) } };
    identityCache.set(key, { expiresAt: Date.now() + 60 * 60_000, value });
    return value;
  })();
  identityInFlight.set(key, request);
  try { return await request; }
  finally { if (identityInFlight.get(key) === request) identityInFlight.delete(key); }
}

/** Refresh the exact saved asset/venue association; native product metadata validates the native alias separately. */
export async function refreshCryptoPaperIdentity(raw, settings = {}) {
  const id = normalizeCryptoExecutionIdentity(raw);
  if (!id || !['Coinbase', 'Kraken'].includes(id.provider) || id.quoteCurrency !== 'USD'
    || Date.parse(id.verifiedAt) > Date.now() + 5000) throw Object.assign(new Error('Invalid saved paper identity.'), { code: 'invalid_saved_crypto_identity' });
  const evidence = await verifyCoinGeckoAssetMarkets({ id: id.assetId, symbol: id.base, requiresVerifiedIdentity: true }, settings);
  if (evidence.coverage?.terminalPageObserved !== true || !evidence.verifiedPairs?.has(identityPairKey(id.provider, id.base, id.quoteCurrency)))
    throw Object.assign(new Error('Saved asset/venue association is no longer verified.'), { code: 'crypto_pair_identity_not_verified' });
  const refreshed = { ...id, verifiedAt: evidence.verifiedAt };
  const reason = cryptoIdentityRejection(refreshed, Date.now());
  if (reason) throw Object.assign(new Error(reason), { code: reason });
  return refreshed;
}

async function binanceQuote(asset, route) {
  const pair = route?.pair || `${providerSymbol(asset.symbol)}USDT`;
  const row = await requestJson(`${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`, 'Binance');
  if (route && row?.symbol !== pair) throw new Error('Requested Binance pair does not match the returned ticker.');
  const observedAt = providerTimestamp(row.closeTime);
  return {
    provider: 'Binance', pair, base: route?.base || providerSymbol(asset.symbol), target: route?.target || 'USDT', price: finite(row.lastPrice), bid: finite(row.bidPrice), ask: finite(row.askPrice),
    volumeUsd: finite(row.quoteVolume), observedAt, timestampBasis: observedAt ? 'provider_event' : 'unknown'
  };
}

// Product rules are independent of research directory caches: execution status
// must not inherit the six-hour discovery cache. No stale fallback after expiry.
const paperProductCache = new Map(), paperProductRequests = new Map();
let krakenPaperDirectory = null, krakenPaperDirectoryRequest = null;
async function freshKrakenPaperDirectory(clock) {
  const at = clock();
  if (krakenPaperDirectory && at >= krakenPaperDirectory.at && at - krakenPaperDirectory.at < 30000) return krakenPaperDirectory;
  if (krakenPaperDirectoryRequest) return krakenPaperDirectoryRequest;
  krakenPaperDirectoryRequest = (async () => {
    const raw = await requestJson(`${KRAKEN_BASE}/AssetPairs`, 'Kraken Paper Metadata');
    if (!Array.isArray(raw?.error) || raw.error.length || !raw.result || Array.isArray(raw.result) || typeof raw.result !== 'object')
      throw new Error('Invalid Kraken paper instrument directory.');
    return krakenPaperDirectory = { rows: Object.values(raw.result), at: clock() };
  })();
  try { return await krakenPaperDirectoryRequest; } finally { krakenPaperDirectoryRequest = null; }
}
export async function fetchCryptoInstrumentRules(rawIdentity, { clock = Date.now } = {}) {
  const identity = normalizeCryptoExecutionIdentity(rawIdentity), at = clock();
  const age = at - Date.parse(identity?.verifiedAt);
  if (!identity || !['Coinbase', 'Kraken'].includes(identity.provider) || !Number.isFinite(at)
    || age < -5000 || age > CRYPTO_IDENTITY_MAX_AGE_MS) throw new TypeError('Invalid or stale paper product identity.');
  const key = `${identity.provider}:${identity.pair}`;
  let rules = paperProductCache.get(key);
  if (!rules || at < Date.parse(rules.observedAt) || at - Date.parse(rules.observedAt) >= 30000) {
    if (!paperProductRequests.has(key)) {
      const request = (async () => {
        if (identity.provider === 'Coinbase') {
          const raw = await requestJson(`${COINBASE_BASE}/products/${encodeURIComponent(identity.pair)}`, 'Coinbase Paper Metadata');
          return parseCoinbaseProduct(raw, identity.pair, new Date(clock()).toISOString());
        }
        const directory = await freshKrakenPaperDirectory(clock);
        const rows = directory.rows.filter(row => row?.altname === identity.pair);
        if (rows.length !== 1) throw new Error('Kraken paper product is absent or ambiguous.');
        return parseKrakenProduct(rows[0], identity.pair, new Date(directory.at).toISOString());
      })();
      paperProductRequests.set(key, request);
    }
    const request = paperProductRequests.get(key);
    try { rules = await request; paperProductCache.set(key, rules); }
    finally { if (paperProductRequests.get(key) === request) paperProductRequests.delete(key); }
  }
  const reason = cryptoInstrumentRulesRejection(rules, identity, clock());
  if (reason) { const error = new Error(reason); error.code = reason; throw error; }
  return structuredClone(rules);
}

// Quote-only acquisition for paper execution; ticker/history remain research inputs.
export async function fetchCoinbasePaperBook(rawIdentity, { maxQuoteAgeMs = 15000, clock = Date.now } = {}) {
  const identity = normalizeCryptoExecutionIdentity(rawIdentity);
  const at = clock(), age = at - Date.parse(identity?.verifiedAt);
  if (!identity || identity.provider !== 'Coinbase' || !Number.isFinite(at)
    || age < -5000 || age > CRYPTO_IDENTITY_MAX_AGE_MS
    || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) throw new TypeError('Invalid or stale Coinbase paper book identity/policy.');
  const payload = await requestJson(`${COINBASE_BASE}/products/${encodeURIComponent(identity.pair)}/book?level=1`, 'Coinbase Paper Book');
  return parseCoinbasePaperBook(payload, identity, { now: clock(), maxQuoteAgeMs });
}

async function coinbaseQuote(asset, route) {
  const pair = route?.pair || `${providerSymbol(asset.symbol)}-USD`;
  const row = await requestJson(`${COINBASE_BASE}/products/${encodeURIComponent(pair)}/ticker`, 'Coinbase');
  const observedAt = providerTimestamp(row.time);
  return {
    provider: 'Coinbase', pair, base: route?.base || providerSymbol(asset.symbol), target: route?.target || 'USD', price: finite(row.price), bid: finite(row.bid), ask: finite(row.ask),
    volumeBase: finite(row.volume), observedAt, timestampBasis: observedAt ? 'provider_event' : 'unknown'
  };
}

function normalizeKrakenAsset(value) {
  let normalized = String(value || '').toUpperCase();
  if (['XBT', 'XDG'].includes(normalized)) return providerSymbol(normalized);
  if (normalized.startsWith('XX') || (/^[XZ][A-Z]{3,4}$/.test(normalized) && normalized.length >= 4)) normalized = normalized.slice(1);
  return providerSymbol(normalized);
}

async function krakenPairs() {
  if (krakenPairCache.expiresAt > Date.now() && krakenPairCache.pairs.length) return krakenPairCache.pairs;
  if (krakenPairRequest) return krakenPairRequest;
  krakenPairRequest = (async () => {
    try {
      const payload = await requestJson(`${KRAKEN_BASE}/AssetPairs`, 'Kraken');
      if (payload?.error?.length) throw new Error(`Kraken AssetPairs: ${payload.error.join(', ')}`);
      const pairs = Object.entries(payload?.result || {}).map(([key, value]) => {
        const [wsBase = '', wsQuote = ''] = String(value.wsname || '').split('/');
        return {
          key, altname: String(value.altname || key), wsname: String(value.wsname || ''), status: value.status,
          base: normalizeKrakenAsset(wsBase || value.base), quote: normalizeKrakenAsset(wsQuote || value.quote)
        };
      });
      krakenPairCache = { expiresAt: Date.now() + 6 * 60 * 60_000, pairs };
      return pairs;
    } finally {
      krakenPairRequest = null;
    }
  })();
  return krakenPairRequest;
}

// Exchange directories are inexpensive relative to per-symbol quote requests
// and let discovery avoid deep analysis for assets that cannot meet the
// configured multi-venue confirmation requirement. This is only a preflight:
// live quotes remain the final authority. Callers fail open if this lookup is
// unavailable so a directory outage cannot silently hide candidates.
async function spotVenueDirectories() {
  if (spotCoverageCache.expiresAt > Date.now() && spotCoverageCache.venues) return spotCoverageCache.venues;
  if (spotCoverageRequest) return spotCoverageRequest;
  spotCoverageRequest = (async () => {
    const [binanceResult, coinbaseResult, krakenResult] = await Promise.allSettled([
      requestJson(`${BINANCE_BASE}/api/v3/exchangeInfo`, 'Binance'),
      requestJson(`${COINBASE_BASE}/products`, 'Coinbase'),
      krakenPairs()
    ]);
    const venues = {};
    if (binanceResult.status === 'fulfilled' && Array.isArray(binanceResult.value?.symbols)) {
      venues.Binance = new Set(binanceResult.value.symbols
        .filter((row) => row.status === 'TRADING' && row.isSpotTradingAllowed !== false)
        .map((row) => String(row.symbol || '').toUpperCase()));
    }
    if (coinbaseResult.status === 'fulfilled' && Array.isArray(coinbaseResult.value)) {
      venues.Coinbase = new Set(coinbaseResult.value
        .filter((row) => row.status === 'online' && !row.trading_disabled && !row.cancel_only)
        .filter((row) => ['USD', 'USDT'].includes(String(row.quote_currency || '').toUpperCase()))
        .map((row) => `${providerSymbol(row.base_currency)}-${String(row.quote_currency).toUpperCase()}`));
    }
    if (krakenResult.status === 'fulfilled' && Array.isArray(krakenResult.value)) {
      venues.Kraken = new Set(krakenResult.value
        .filter((row) => ['USD', 'USDT'].includes(row.quote))
        .map((row) => `${providerSymbol(row.base)}:${row.quote}`));
    }
    if (Object.keys(venues).length < 3) {
      const errors = [binanceResult, coinbaseResult, krakenResult]
        .filter((result) => result.status === 'rejected').map((result) => result.reason?.message || 'directory unavailable');
      throw new Error(`At least one spot-venue directory is unavailable${errors.length ? `: ${errors.join('; ').slice(0, 220)}` : '.'}`);
    }
    spotCoverageCache = { expiresAt: Date.now() + 6 * 60 * 60_000, venues };
    return venues;
  })();
  try { return await spotCoverageRequest; }
  finally { spotCoverageRequest = null; }
}

export async function screenSpotPairCoverage(assets = [], { minProviders = 2 } = {}) {
  let venues;
  try { venues = await spotVenueDirectories(); }
  catch (error) {
    return { available: false, reason: String(error?.message || error).slice(0, 240), venues: [],
      supportedVenueCounts: {}, krakenDependentAssetIds: [], candidates: assets, rejections: [] };
  }
  const candidates = [];
  const rejections = [];
  const krakenDependentAssetIds = [];
  const supportedVenueCounts = Object.fromEntries(Object.keys(venues).map((venue) => [venue, 0]));
  for (const asset of assets) {
    const symbol = providerSymbol(asset?.symbol);
    const coverage = Object.entries(venues).filter(([venue, pairs]) => {
      if (venue === 'Binance') return pairs.has(`${symbol}USDT`);
      if (venue === 'Coinbase') return pairs.has(`${symbol}-USD`) || pairs.has(`${symbol}-USDT`);
      return pairs.has(`${symbol}:USD`) || pairs.has(`${symbol}:USDT`);
    }).map(([venue]) => venue);
    for (const venue of coverage) supportedVenueCounts[venue] += 1;
    if (coverage.length >= minProviders) {
      candidates.push(asset);
      // Kraken REST ticker receipt time cannot satisfy executable consensus.
      // Flag candidates that need a source-timestamped Kraken WS quote so the
      // scanner can warm that feed before its final provider-count gate.
      if (coverage.includes('Kraken') && coverage.filter((venue) => venue !== 'Kraken').length < minProviders) {
        krakenDependentAssetIds.push(asset?.id);
      }
    }
    else rejections.push({ symbol: asset?.symbol, assetId: asset?.id, stage: 'provider_coverage', code: 'insufficient_listed_spot_venues',
      observed: coverage.length, required: minProviders, venues: coverage });
  }
  return { available: true, venues: Object.keys(venues), supportedVenueCounts,
    krakenDependentAssetIds, candidates, rejections };
}

async function resolveKrakenPair(asset, route) {
  const base = providerSymbol(asset.symbol);
  const pairs = await krakenPairs();
  if (route) {
    const matching = pairs.filter(row => row.base === base && ['USD', 'USDT'].includes(row.quote)
      && (!route.target || row.quote === route.target)
      && (!route.pair || [row.key, row.altname, row.wsname].includes(route.pair)));
    if (matching.length !== 1) throw new Error('Exact Kraken source pair is unavailable or ambiguous.');
    if (route.requireActive && matching[0].status !== 'online') throw new Error('Exact Kraken source pair is not online.');
    return matching[0];
  }
  return pairs.find((row) => row.base === base && row.quote === 'USD')
    || pairs.find((row) => row.base === base && row.quote === 'USDT')
    || null;
}

async function krakenQuote(asset, route, realtimeQuote) {
  const match = await resolveKrakenPair(asset, route);
  if (!match) throw new Error(`Kraken has no USD market for ${asset.symbol}.`);
  if (route && realtimeQuote) {
    const normalizedWs = String(match.wsname).split('/').map(providerSymbol).join('/');
    const normalizedIncoming = String(realtimeQuote.pair || '').split('/').map(providerSymbol).join('/');
    if (providerSymbol(realtimeQuote.base) !== match.base || providerSymbol(realtimeQuote.target) !== match.quote
      || ![match.key, match.altname, normalizedWs].includes(normalizedIncoming)) throw new Error('Kraken stream pair does not match the exact verified market.');
    return { ...realtimeQuote, pair: match.altname, wirePair: realtimeQuote.pair, base: match.base, target: match.quote };
  }
  const payload = await requestJson(`${KRAKEN_BASE}/Ticker?pair=${encodeURIComponent(match.altname)}`, 'Kraken');
  if (payload?.error?.length) throw new Error(`Kraken Ticker: ${payload.error.join(', ')}`);
  if (route) requireKrakenResponsePair(payload, match);
  const row = Object.values(payload?.result || {})[0];
  if (!row) throw new Error(`Kraken returned no ticker for ${match.altname}.`);
  return {
    provider: 'Kraken', pair: match.altname, base: match.base, target: match.quote, price: finite(row.c?.[0]), bid: finite(row.b?.[0]), ask: finite(row.a?.[0]),
    volumeBase: finite(row.v?.[1]), observedAt: new Date().toISOString(), timestampBasis: 'response_received'
  };
}

function spreadPercent(quote) {
  const bid = finite(quote.bid);
  const ask = finite(quote.ask);
  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : finite(quote.price);
  return midpoint > 0 && ask >= bid && bid > 0 ? (ask - bid) / midpoint * 100 : 0;
}

export function aggregateProviderQuotes(quotes = [], snapshotPrice = 0, {
  now = Date.now(), maxAgeMs = 5 * 60_000, maxFutureMs = 5_000
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || !Number.isFinite(maxFutureMs) || maxFutureMs < 0) throw new RangeError('Provider quote freshness policy is invalid.');
  const seen = new Set();
  const rejectionCounts = {};
  const rejectedQuotes = [];
  const unconfirmedQuotes = [];
  const reject = (quote, reason) => {
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    rejectedQuotes.push({ provider: String(quote?.provider || 'unknown').slice(0, 40), reason,
      observedAt: typeof quote?.observedAt === 'string' ? quote.observedAt.slice(0, 40) : null });
  };
  const valid = [];
  for (const quote of quotes) {
    if (!(finite(quote?.price) > 0 && finite(quote.bid) > 0 && finite(quote.ask) >= finite(quote.bid))) {
      reject(quote, 'invalid_or_crossed_quote'); continue;
    }
    // Receipt time proves when this process fetched a payload, not when its
    // market observation occurred. Such quotes stay diagnostic-only.
    if (quote.timestampBasis === 'response_received') {
      unconfirmedQuotes.push({ ...quote, timestampTrust: 'receipt_time_only' });
      reject(quote, 'receipt_time_only'); continue;
    }
    if (!quote.observedAt) { reject(quote, 'missing_observation_timestamp'); continue; }
    const observed = Date.parse(quote.observedAt);
    if (!Number.isFinite(observed)) { reject(quote, 'invalid_observation_timestamp'); continue; }
    if (observed - nowMs > maxFutureMs) { reject(quote, 'future_observation_timestamp'); continue; }
    if (nowMs - observed > maxAgeMs) { reject(quote, 'stale_observation_timestamp'); continue; }
    if (!quote.provider || seen.has(quote.provider)) { reject(quote, 'missing_or_duplicate_provider'); continue; }
    seen.add(quote.provider);
    valid.push({ ...quote, spreadPct: spreadPercent(quote) });
  }
  const prices = valid.map((quote) => quote.price);
  const consensusPrice = median(prices);
  const priceDispersionPct = consensusPrice > 0 && prices.length > 1
    ? (Math.max(...prices) - Math.min(...prices)) / consensusPrice * 100 : 0;
  const exchangeSpreads = valid.map((quote) => quote.spreadPct).filter((value) => value >= 0);
  const medianSpreadPct = median(exchangeSpreads);
  const exchangeProviderCount = valid.length;
  const referenceValue = finite(snapshotPrice);
  const referenceQuote = referenceValue > 0 ? {
    provider: 'CoinGecko/CoinPaprika', price: referenceValue,
    timestampTrust: 'snapshot_reference_only', executable: false,
  } : null;
  const referencePriceDeviationPct = referenceQuote && consensusPrice > 0
    ? Number((Math.abs(referenceValue - consensusPrice) / consensusPrice * 100).toFixed(6)) : null;
  const coverageScore = clamp(
    exchangeProviderCount * 22 - priceDispersionPct * 35 - medianSpreadPct * 20,
    0, 100
  );
  const conflicted = priceDispersionPct > 0.8 || medianSpreadPct > 0.65;
  return {
    quotes: valid, providers: valid.map((quote) => quote.provider),
    providerCount: exchangeProviderCount, exchangeProviderCount, referenceQuote, referencePriceDeviationPct,
    unconfirmedQuotes, rejectedQuotes, rejectionCounts,
    consensusPrice, priceDispersionPct, medianSpreadPct, coverageScore, conflicted
  };
}

async function binanceCandles(asset, limit, interval = '15m', route) {
  const pair = route?.pair || `${providerSymbol(asset.symbol)}USDT`;
  const rows = await requestJson(
    `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${interval}&limit=${Math.min(1000, Math.max(80, limit))}`,
    'Binance'
  );
  if (!Array.isArray(rows)) throw new Error('Binance returned invalid candles.');
  return {
    provider: 'Binance', pair,
    candles: rows.map((row) => ({
      time: finite(row[0]), open: finite(row[1]), high: finite(row[2]), low: finite(row[3]), close: finite(row[4]), volume: finite(row[5])
    }))
  };
}

async function coinbaseCandles(asset, limit, interval = '15m', route) {
  const pair = route?.pair || `${providerSymbol(asset.symbol)}-USD`;
  const rows = await requestJson(
    `${COINBASE_BASE}/products/${encodeURIComponent(pair)}/candles?granularity=${interval === '1d' ? 86400 : 900}`,
    'Coinbase'
  );
  if (!Array.isArray(rows)) throw new Error('Coinbase returned invalid candles.');
  return {
    provider: 'Coinbase', pair,
    candles: rows.slice(0, Math.min(300, limit)).map((row) => ({
      time: finite(row[0]) * 1000, low: finite(row[1]), high: finite(row[2]), open: finite(row[3]), close: finite(row[4]), volume: finite(row[5])
    })).sort((a, b) => a.time - b.time)
  };
}

async function krakenCandles(asset, limit, interval = '15m', route) {
  const match = await resolveKrakenPair(asset, route);
  if (!match) throw new Error(`Kraken has no USD candles for ${asset.symbol}.`);
  const payload = await requestJson(`${KRAKEN_BASE}/OHLC?pair=${encodeURIComponent(match.altname)}&interval=${interval === '1d' ? 1440 : 15}`, 'Kraken');
  if (payload?.error?.length) throw new Error(`Kraken OHLC: ${payload.error.join(', ')}`);
  if (route) requireKrakenResponsePair(payload, match);
  const rows = Object.entries(payload?.result || {}).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1] || [];
  return {
    provider: 'Kraken', pair: match.altname,
    candles: rows.slice(-Math.min(720, limit)).map((row) => ({
      time: finite(row[0]) * 1000, open: finite(row[1]), high: finite(row[2]), low: finite(row[3]), close: finite(row[4]), volume: finite(row[6])
    }))
  };
}

function requireKrakenResponsePair(payload, match) {
  const keys = Object.keys(payload?.result || {}).filter(key => key !== 'last');
  if (keys.length !== 1 || ![match.key, match.altname, match.wsname].includes(keys[0])) {
    throw new Error('Returned Kraken data does not match the exact source pair.');
  }
}

export function summarizeCandleCoverage(candles = [], intervalMs = 900_000) {
  const rows = normalizeCandles(candles);
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) throw new RangeError('Candle interval must be positive.');
  let missingIntervals = 0;
  let irregularTransitions = 0;
  let largestGapMs = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index].time - rows[index - 1].time;
    largestGapMs = Math.max(largestGapMs, gap);
    if (gap !== interval) irregularTransitions += 1;
    if (gap > interval) missingIntervals += Math.max(0, Math.floor(gap / interval) - 1);
  }
  const iso = (time) => Number.isFinite(time) && time >= 0 && time <= 8.64e15 ? new Date(time).toISOString() : null;
  return {
    candleCount: rows.length,
    firstOpenAt: rows.length ? iso(rows[0].time) : null,
    lastCompletedAt: rows.length ? iso(rows.at(-1).time + interval) : null,
    missingIntervals, irregularTransitions, largestGapMs,
    contiguous: rows.length >= 2 && irregularTransitions === 0,
  };
}

export async function fetchHistoricalCandles(asset, options = {}) {
  const interval = options.interval === '1d' ? '1d' : '15m';
  const intervalMs = interval === '1d' ? 86_400_000 : 900_000;
  const limit = Math.min(1000, Math.max(80, Number(options.limit) || 300));
  const clients = { Binance: binanceCandles, Coinbase: coinbaseCandles, Kraken: krakenCandles };
  const pinned = Object.hasOwn(options, 'sourcePairs');
  const sourcePairs = options.sourcePairs;
  if ((asset.requiresVerifiedIdentity === true && !pinned)
    || (pinned && (!sourcePairs || typeof sourcePairs !== 'object' || Array.isArray(sourcePairs) || !Object.keys(sourcePairs).length)))
    return { provider: '', pair: '', candles: [], errors: ['Exact verified source pair required for history.'] };
  const requestedProviders = Array.isArray(options.providers) ? options.providers.filter((provider) => Object.hasOwn(clients, provider)) : [];
  const preferred = requestedProviders.length ? requestedProviders : pinned ? Object.keys(sourcePairs).filter(provider => Object.hasOwn(clients, provider)) : ['Binance', 'Coinbase', 'Kraken'];
  const routes = {};
  if (pinned) for (const provider of preferred) {
    const route = inspectPinnedSpotPair(asset, provider, sourcePairs[provider]);
    if (!route) return { provider: '', pair: '', candles: [], errors: [`${provider}: exact source pair is missing or invalid.`] };
    routes[provider] = route;
  }
  if (!preferred.length) return { provider: '', pair: '', candles: [], errors: ['No supported exact source provider.'] };
  const cacheKey = JSON.stringify([String(asset.id || '').toLowerCase(), providerSymbol(asset.symbol), interval, limit,
    preferred.map(provider => [provider, pinned ? sourcePairs[provider] : 'legacy-default'])]);
  const cached = candleCache.get(cacheKey);
  if (!options.force && cached?.expiresAt > Date.now()) return cached.value;
  const pending = candleInFlight.get(cacheKey);
  if (pending) return pending;
  const request = (async () => {
    const errors = [];
    for (const provider of preferred) {
      try {
        const value = await clients[provider](asset, limit, interval, routes[provider]);
        if (pinned && value.pair !== sourcePairs[provider]) throw new Error('Returned history does not match the exact source pair.');
        value.candles = normalizeCandles(value.candles).filter((row) => row.time + intervalMs <= Date.now());
        if (value.candles.length < 50) throw new Error(`${provider} supplied only ${value.candles.length} candles.`);
        if (Date.now() - (value.candles.at(-1).time + intervalMs) > intervalMs * 2) throw new Error(`${provider} supplied stale candles.`);
        const result = { ...value, interval, intervalMs, errors };
        candleCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: result });
        return result;
      } catch (error) {
        errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { provider: '', pair: '', candles: [], errors };
  })();
  candleInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (candleInFlight.get(cacheKey) === request) candleInFlight.delete(cacheKey);
  }
}

function bookImbalance(bids = [], asks = []) {
  const notional = (rows) => rows.slice(0, 20).reduce((sum, row) => sum + finite(row?.[0]) * finite(row?.[1]), 0);
  const bid = notional(bids);
  const ask = notional(asks);
  return bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
}

async function fetchOrderBook(asset, quote) {
  if (!quote) return { provider: '', imbalance: 0, available: false };
  if (quote.provider === 'Binance') {
    const row = await requestJson(`${BINANCE_BASE}/api/v3/depth?symbol=${encodeURIComponent(quote.pair)}&limit=20`, 'Binance');
    return { provider: 'Binance', imbalance: bookImbalance(row.bids, row.asks), available: true };
  }
  if (quote.provider === 'Coinbase') {
    const row = await requestJson(`${COINBASE_BASE}/products/${encodeURIComponent(quote.pair)}/book?level=1`, 'Coinbase');
    return { provider: 'Coinbase', imbalance: bookImbalance(row.bids, row.asks), available: true };
  }
  const row = await requestJson(`${KRAKEN_BASE}/Depth?pair=${encodeURIComponent(quote.pair)}&count=20`, 'Kraken');
  if (row?.error?.length) throw new Error(`Kraken Depth: ${row.error.join(', ')}`);
  const book = Object.values(row?.result || {})[0] || {};
  return { provider: 'Kraken', imbalance: bookImbalance(book.bids, book.asks), available: true };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => next()));
  return results;
}

export async function fetchProviderQuotes(asset, options = {}) {
  const settings = options.settings || {};
  const liveKraken = options.realtimeQuote?.provider === 'Kraken'
    && providerSymbol(options.realtimeQuote.base) === providerSymbol(asset.symbol)
    && ['USD', 'USDT'].includes(providerSymbol(options.realtimeQuote.target))
    && Number.isFinite(Date.parse(options.realtimeQuote.observedAt))
    ? { ...options.realtimeQuote, timestampBasis: 'provider_event' } : null;
  const identityConfig = `${String(settings.coingeckoApiTier || 'public').toLowerCase()}:${String(settings.coingeckoApiKey || '').trim()
    ? createHash('sha256').update(String(settings.coingeckoApiKey || '')).digest('hex').slice(0, 12) : 'no-key'}`;
  const identity = `${String(asset.id || '').trim().toLowerCase()}:${providerSymbol(asset.symbol)}:${identityConfig}:${asset.requiresVerifiedIdentity === true ? 'required-id' : 'legacy-id'}:${liveKraken ? 'kraken-ws' : 'http'}`;
  const pending = providerQuoteInFlight.get(identity);
  if (pending) return pending;
  const request = (async () => {
    let assetIdentity;
    try {
      assetIdentity = await verifyCoinGeckoAssetMarkets(asset, settings);
    } catch (error) {
      return { quotes: [], errors: [`CoinGecko identity verification: ${error instanceof Error ? error.message : String(error)}`],
        identity: { mode: `coingecko_${String(settings.coingeckoApiTier || 'unknown').toLowerCase()}`, status: 'failed', verifiedVenueCount: 0 } };
    }
    const pairPlan = asset.requiresVerifiedIdentity === true ? planVerifiedSpotRoutes(asset, assetIdentity.verifiedPairs) : null;
    const providers = ['Binance', 'Coinbase', 'Kraken'];
    const settled = await Promise.allSettled(providers.map(provider => {
      if (pairPlan && !pairPlan.routes[provider]) return Promise.reject(new Error('no_supported_verified_pair'));
      const route = pairPlan?.routes[provider];
      if (provider === 'Binance') return binanceQuote(asset, route);
      if (provider === 'Coinbase') return coinbaseQuote(asset, route);
      if (!route) return liveKraken ? Promise.resolve(liveKraken) : krakenQuote(asset);
      // Prefer the available timestamped stream only when that exact quote currency is verified.
      const streamVerified = liveKraken && assetIdentity.verifiedPairs.has(identityPairKey('Kraken', liveKraken.base, liveKraken.target));
      return krakenQuote(asset, { ...route, target: streamVerified ? providerSymbol(liveKraken.target) : route.target, requireActive: true }, streamVerified ? liveKraken : null);
    }));
    const quotes = [];
    const errors = [];
    for (let index = 0; index < settled.length; index += 1) {
      const provider = ['Binance', 'Coinbase', 'Kraken'][index];
      if (settled[index].status === 'fulfilled' && finite(settled[index].value.price) > 0) {
        const quote = settled[index].value;
        if (assetIdentity.verifiedPairs && !assetIdentity.verifiedPairs.has(identityPairKey(provider, quote.base, quote.target))) {
          errors.push(`${provider}: exact CoinGecko coin ID/pair identity was not verified`);
          continue;
        }
        quotes.push({ ...quote, ...(pairPlan && assetIdentity.coverage?.terminalPageObserved === true ? { cryptoIdentity: {
          version: 1, namespace: 'coingecko', assetId: String(asset.id).trim().toLowerCase(),
          provider: quote.provider, pair: quote.pair, base: providerSymbol(quote.base), quoteCurrency: providerSymbol(quote.target),
          verificationSource: 'coingecko_tickers_complete', verifiedAt: assetIdentity.verifiedAt,
        } } : {}) });
      }
      else errors.push(`${provider}: ${settled[index].reason instanceof Error ? settled[index].reason.message : 'unavailable'}`);
    }
    return { quotes, errors, identity: {
      mode: assetIdentity.mode,
      status: assetIdentity.verifiedPairs?.size === 0 ? 'no_verified_pairs'
        : assetIdentity.verifiedPairs ? `${assetIdentity.mode.slice('coingecko_'.length)}_verified_pair_allowlist` : 'ticker_only_unverified',
      coverage: assetIdentity.coverage || null, verifiedPairCount: assetIdentity.verifiedPairs?.size ?? null,
      verifiedVenueCount: assetIdentity.verifiedPairs ? quotes.length : null,
      ...(pairPlan ? { pairRouting: { version: SPOT_PAIR_ROUTING_VERSION,
        plannedProviders: Object.keys(pairPlan.routes), skipped: pairPlan.rejections, unsupportedPairs: pairPlan.unsupportedPairs,
        quotedSources: quotes.map(({ provider, pair, base, target }) => ({ provider, pair, base, target })) } } : {})
    } };
  })();
  providerQuoteInFlight.set(identity, request);
  try {
    return await request;
  } finally {
    if (providerQuoteInFlight.get(identity) === request) providerQuoteInFlight.delete(identity);
  }
}

export async function enrichMarketAssets(assets = [], options = {}) {
  if (!assets.length) return { assets: [], regime: { key: 'neutral', label: 'Neutral', score: 50, allowNewLongs: true }, providerErrors: [] };
  const technicalIds = options.technicalAssetIds instanceof Set ? options.technicalAssetIds : new Set(options.technicalAssetIds || []);
  const bitcoin = options.bitcoinAsset || assets.find((asset) => providerSymbol(asset.symbol) === 'BTC') || {
    id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price: 0, change24h: 0
  };
  const bitcoinHistory = await fetchHistoricalCandles(bitcoin, { limit: technicalIds.has(bitcoin.id) ? 600 : 300 });
  if (bitcoinHistory.candles.length) {
    await appendCandleBatch(bitcoin.symbol, bitcoinHistory.provider, bitcoinHistory.candles, bitcoinHistory.pair).catch(() => {});
  }
  const bitcoinTechnicals = analyzeCandles(bitcoinHistory.candles);
  const regime = { ...classifyMarketRegime(bitcoinTechnicals, bitcoin), globalMarketContext: options.globalMarketContext || null };
  const providerErrors = [...(bitcoinHistory.errors || [])];

  const enriched = await mapLimit(assets, Number(options.concurrency) || 3, async (asset) => {
    const realtimeQuote = options.realtimeQuoteBySymbol instanceof Map
      ? options.realtimeQuoteBySymbol.get(String(asset.symbol || '').toUpperCase()) : null;
    const quoteResult = await fetchProviderQuotes(asset, { settings: options.settings || {}, realtimeQuote });
    const consensus = aggregateProviderQuotes(quoteResult.quotes, asset.price, { now: options.clock?.() ?? options.now ?? Date.now() });
    const shouldAnalyze = technicalIds.has(asset.id) && (asset.requiresVerifiedIdentity !== true
      || (consensus.providerCount >= 2 && !consensus.conflicted && quoteResult.identity?.mode?.startsWith('coingecko_')));
    const history = shouldAnalyze
      ? (providerSymbol(asset.symbol) === 'BTC' && asset.requiresVerifiedIdentity !== true ? bitcoinHistory : await fetchHistoricalCandles(asset, {
        limit: 600, providers: consensus.providers,
        ...(asset.requiresVerifiedIdentity === true ? { sourcePairs: Object.fromEntries(consensus.quotes.map(q => [q.provider, q.pair])) } : {}),
      }))
      : { provider: '', pair: '', candles: [], errors: [] };
    const technicals = shouldAnalyze ? analyzeCandles(history.candles) : null;
    if (shouldAnalyze && history.candles.length && (providerSymbol(asset.symbol) !== 'BTC' || asset.requiresVerifiedIdentity === true)) {
      await appendCandleBatch(asset.symbol, history.provider, history.candles, history.pair).catch(() => {});
    }
    const validation = shouldAnalyze ? validateStrategy(history.candles, {
      minimumScore: options.minimumScore ?? 66, rewardRisk: options.rewardRisk ?? 1.7,
      roundTripFeeBps: options.roundTripFeeBps ?? 20
    }) : null;
    let orderBook = { provider: '', imbalance: 0, available: false };
    if (shouldAnalyze && quoteResult.quotes.length) {
      orderBook = await fetchOrderBook(asset, quoteResult.quotes[0]).catch((error) => {
        quoteResult.errors.push(`Order book: ${error instanceof Error ? error.message : String(error)}`);
        return { provider: '', imbalance: 0, available: false };
      });
    }
    const derivatives = shouldAnalyze && options.derivativesEnabled !== false
      ? await fetchDerivativesSnapshot(asset).catch((error) => ({
        available: false, providers: [], providerCount: 0, score: 50, blockLongs: false,
        errors: [`Derivatives: ${error instanceof Error ? error.message : String(error)}`]
      }))
      : null;
    const price = consensus.providerCount >= 2 && consensus.consensusPrice > 0 ? consensus.consensusPrice : asset.price;
    const eventRisk = evaluateEventRisk(asset, options.eventRisks || []);
    const microstructure = options.microstructureBySymbol?.get?.(providerSymbol(asset.symbol)) || null;
    const provisional = {
      ...asset, price,
      marketData: {
        ...consensus, candleProvider: history.provider, candlePair: history.pair, candleCount: history.candles.length,
        candleCoverage: shouldAnalyze ? summarizeCandleCoverage(history.candles, history.intervalMs || 900_000) : null,
        technicals, validation, orderBook, derivatives, microstructure, eventRisk, regime,
        assetIdentity: quoteResult.identity || { mode: 'unknown', status: 'unknown' },
        errors: [...quoteResult.errors, ...(history.errors || []), ...(derivatives?.errors || [])],
        confirmedAt: new Date().toISOString()
      }
    };
    provisional.marketData.execution = estimateExecutionCost(provisional, options.settings || options);
    if (shouldAnalyze) provisional.marketData.validationCostSensitivity = compareCurrentQuoteCost({
      candles: history.candles, baseline: validation, execution: provisional.marketData.execution,
      providerCount: consensus.providerCount, conflicted: consensus.conflicted,
      minimumScore: options.minimumScore ?? 66, rewardRisk: options.rewardRisk ?? 1.7,
    });
    return provisional;
  });
  return { assets: enriched, regime, providerErrors, bitcoinHistory: {
    provider: bitcoinHistory.provider || '', pair: bitcoinHistory.pair || '', candleCount: bitcoinHistory.candles.length,
    errors: bitcoinHistory.errors || [],
  } };
}
import { paceCoinGeckoResearch } from './researchProviderPacing.js';
