import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { parseAlpacaStockQuote } from '../../shared/stockQuoteEvidence.js';
import { etfQuoteAges } from './decisionQuotes.js';
import { hasExplicitFiniteAmount } from '../../shared/strategyConfig.js';
import { normalizeAlpacaNewsArticle } from '../../shared/alpacaCatalystNews.js';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestAlpacaJson, retryAfterMs, retryableAlpacaError, alpacaRateLimit } from '../../shared/alpacaHttp.js';
export { requestAlpacaJson } from '../../shared/alpacaHttp.js';
import { CURATED_ETF_SEEDS, hasUnreviewedEtnMarker, hasUnreviewedLeverageMarker, mergeEtfDirectories, parseSupplementalEtpRegistryDetailed, parseScreenerSymbols, selectEtfDiscoveryCandidates, NASDAQ_ETF_DIRECTORY_URLS } from './universe.js';
import { archiveEtfDiscovery, screenFullEtfMarket, ETF_DISCOVERY_VERSION } from './fullMarketDiscovery.js';

const API_ROOT = 'https://paper-api.alpaca.markets/v2';
const DATA_ROOT = 'https://data.alpaca.markets/v2';
const NEWS_ROOT = 'https://data.alpaca.markets/v1beta1/news';
const SCREENER_ROOT = 'https://data.alpaca.markets/v1beta1/screener';
const DEFAULT_CLASSIFICATION_PATH = fileURLToPath(new URL('../examples/etp-classifications.json', import.meta.url));
const SUPPORTED_LISTINGS = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'NYSEARCA', 'BATS', 'TXSE']);
const MAX_SCAN_SYMBOLS = 200;

export function parseEtfSymbols(value) {
  const rows = String(value || '').split(/[\s,;]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  const symbols = [...new Set(rows.length ? rows : CURATED_ETF_SEEDS)];
  if (symbols.length > MAX_SCAN_SYMBOLS) throw new Error(`ETF_SYMBOLS is capped at ${MAX_SCAN_SYMBOLS} symbols per scan.`);
  if (symbols.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))) throw new Error('ETF_SYMBOLS contains an invalid ticker.');
  return symbols;
}

export async function fetchEtfDirectoryText(url, fetcher, metrics, provider, {
  maxAttempts = 3, maxRetryWaitMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now, random = Math.random,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError('ETF directory maxAttempts must be from 1 to 5.');
  if (!Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) throw new RangeError('ETF directory retry wait limit must be non-negative.');
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const startedAt = clock();
    let response;
    try {
      response = await fetcher(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const error = new Error(`${provider} returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      metrics.push({ provider, latencyMs: Math.max(0, clock() - startedAt), status: response.status, attempt: attempt + 1,
        rateLimit: alpacaRateLimit(response.headers), rows: text.split(/\r?\n/).length });
      return text;
    } catch (error) {
      const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
      const status = Number(response?.status || error?.status) || 0;
      let delayMs = null;
      if (attempt + 1 < maxAttempts && retryableAlpacaError(error, response)) {
        delayMs = retryAfterMs(response?.headers, clock(), attempt, random);
        if (delayMs > maxRetryWaitMs) delayMs = null;
      }
      const deferred = attempt + 1 < maxAttempts && retryableAlpacaError(error, response) && delayMs === null;
      metrics.push({ provider, latencyMs: Math.max(0, clock() - startedAt), status, attempt: attempt + 1,
        rateLimit: alpacaRateLimit(response?.headers), ...(delayMs !== null ? { retryDelayMs: delayMs } : {}),
        ...(deferred ? { retryDeferred: true } : {}), error: message });
      if (delayMs === null) {
        const failure = new Error(message, { cause: error });
        failure.providerOperation = provider;
        throw failure;
      }
      await sleep(delayMs);
    }
  }
  throw new Error(`${provider} failed after bounded retries.`);
}

async function loadConfiguredEtpClassifications({ env, now }) {
  const classificationPath = String(env.ETF_ETP_CLASSIFICATION_PATH || '').trim() || DEFAULT_CLASSIFICATION_PATH;
  try {
    const configured = JSON.parse(await readFile(resolve(classificationPath), 'utf8'));
    return parseSupplementalEtpRegistryDetailed(configured, { now,
      maxReviewAgeDays: env.ETF_ETP_CLASSIFICATION_MAX_AGE_DAYS || 180 });
  } catch (error) {
    throw new Error(`Supplemental ETP classification registry invalid: ${error.message}`);
  }
}

async function loadEtfRegistry({ env, fetcher, metrics, now }) {
  const cachePath = resolve(env.ETF_UNIVERSE_CACHE_PATH || '.cache/etf-universe.json');
  const refreshMs = Math.max(60_000, Number(env.ETF_UNIVERSE_REFRESH_MS || 6 * 60 * 60_000));
  const maxStaleMs = Math.max(refreshMs, Number(env.ETF_UNIVERSE_MAX_STALE_MS || 48 * 60 * 60_000));
  let cached = null;
  try {
    cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!Array.isArray(cached?.entries) || !Number.isFinite(Date.parse(cached?.fetchedAt))) cached = null;
  } catch {}
  const cachedAgeMs = cached ? Math.max(0, now.getTime() - Date.parse(cached.fetchedAt)) : null;
  if (cached && Date.parse(cached.fetchedAt) > now.getTime() + 5_000) cached = null;
  const classifications = await loadConfiguredEtpClassifications({ env, now });
  const revalidateCached = (record) => {
    const blocked = new Set(classifications.blockedSymbols);
    const bySymbol = new Map(record.entries.filter((row) => row?.source !== 'supplemental-reviewed' && !blocked.has(row.symbol))
      .map((row) => [row.symbol, row]));
    for (const row of classifications.entries) if (!blocked.has(row.symbol)) bySymbol.set(row.symbol, row);
    return { ...record, entries: [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
      supplementalCount: classifications.entries.filter((row) => !blocked.has(row.symbol)).length,
      blockedSymbols: [...blocked] };
  };
  if (cached && cachedAgeMs <= refreshMs) return { ...revalidateCached(cached), cache: 'fresh', cacheAgeMs: cachedAgeMs };
  try {
    const [nasdaqText, otherText] = await Promise.all([
      fetchEtfDirectoryText(NASDAQ_ETF_DIRECTORY_URLS.nasdaq, fetcher, metrics, 'Nasdaq ETF directory'),
      fetchEtfDirectoryText(NASDAQ_ETF_DIRECTORY_URLS.other, fetcher, metrics, 'Other-listed ETF directory'),
    ]);
    const merged = mergeEtfDirectories(nasdaqText, otherText);
    const supplemental = classifications.entries;
    const blockedSymbols = classifications.blockedSymbols;
    const bySymbol = new Map(merged.entries.map((row) => [row.symbol, row]));
    for (const row of supplemental) bySymbol.set(row.symbol, row);
    for (const symbol of blockedSymbols) bySymbol.delete(symbol);
    const next = { ...merged, entries: [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)), supplementalCount: supplemental.length,
      blockedSymbols,
      fetchedAt: now.toISOString(), schemaVersion: 2 };
    const priorEntries = new Map((cached?.entries || []).map((row) => [row.symbol, row]));
    next.membershipChanges = { comparedTo: cached?.fetchedAt ?? null, observedAt: now.toISOString(),
      added: next.entries.filter((row) => !priorEntries.has(row.symbol)).map((row) => row.symbol),
      removed: [...priorEntries.keys()].filter((symbol) => !bySymbol.has(symbol)),
      changed: next.entries.filter((row) => priorEntries.has(row.symbol) && JSON.stringify(priorEntries.get(row.symbol)) !== JSON.stringify(row)).map((row) => row.symbol) };
    await mkdir(dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(next), 'utf8');
    await rename(tempPath, cachePath);
    return { ...next, cache: 'refreshed', cacheAgeMs: 0 };
  } catch (error) {
    if (cached && cachedAgeMs <= maxStaleMs) return { ...revalidateCached(cached), cache: 'stale-fallback', cacheAgeMs: cachedAgeMs,
      refreshError: String(error.message || error).slice(0, 180) };
    throw error;
  }
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeFilePart(value) { return String(value).replace(/[^A-Z0-9._-]/gi, '_').slice(0, 40); }

async function readEtfVolumeProfile(profilePath, { marketDate, feed, symbol }) {
  try {
    const profile = JSON.parse(await readFile(profilePath, 'utf8'));
    if (profile?.schemaVersion !== 1 || profile.marketDate !== marketDate || profile.feed !== feed
      || profile.symbol !== symbol || !Array.isArray(profile.observations)) return null;
    return profile;
  } catch { return null; }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value), 'utf8');
  await rename(tempPath, filePath);
}

/**
 * Fetch a capped, prior-session volume cohort for descriptive same-slot relative volume.
 * Never turns history-provider failures into candidate rejection.
 */
export async function attachEtfTimeOfDayVolumeProfiles(trades, { env = process.env, headers, fetcher = fetch,
  metrics = [], now = new Date(), marketDate, currentOpenTime, feed = 'sip', maxCandidates = 10, dailySymbolCap = 10 } = {}) {
  if (!Array.isArray(trades) || !Array.isArray(metrics)) throw new TypeError('ETF volume profile inputs are invalid.');
  if (env.ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED !== 'true') return { trades,
    diagnostics: { status: 'disabled', enabled: false, candidatesSelected: 0, symbolsRequested: 0, profilesAvailable: 0 } };
  const finiteNow = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(finiteNow) || !/^\d{4}-\d{2}-\d{2}$/.test(String(marketDate || ''))
    || !Number.isFinite(Number(currentOpenTime))) throw new TypeError('ETF volume profile needs valid current session timestamps.');
  const cap = Math.max(1, Math.min(10, Math.floor(Number(maxCandidates) || 10)));
  const dailyCap = Math.max(1, Math.min(30, Math.floor(Number(dailySymbolCap) || 10)));
  const cacheDirectory = resolve(env.ETF_TOD_VOLUME_CACHE_DIR || '.cache/etf-tod-volume');
  const candidates = trades.map((trade) => {
    const completed = (trade.bars || []).filter((bar) => Date.parse(bar.time) + 5 * 60_000 <= finiteNow);
    const last = completed.at(-1);
    const prior = completed.slice(-21, -1).map((bar) => Number(bar.volume)).filter((volume) => volume > 0);
    const mean = prior.length ? prior.reduce((sum, volume) => sum + volume, 0) / prior.length : 0;
    return { trade, symbol: String(trade.symbol || '').toUpperCase(), rank: mean > 0 && last ? Number(last.volume) / mean : 0 };
  }).filter((row) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(row.symbol))
    .sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol)).slice(0, cap);
  const chosen = new Map(candidates.map((row) => [row.symbol, row]));
  const profiles = new Map();
  for (const { symbol } of candidates) {
    const file = resolve(cacheDirectory, `${marketDate}-${feed}-${safeFilePart(symbol)}.json`);
    const cached = await readEtfVolumeProfile(file, { marketDate, feed, symbol });
    if (cached) profiles.set(symbol, { ...cached, cacheHit: true });
  }

  let dailyFiles = [];
  await readdir(cacheDirectory).then((files) => { dailyFiles = files.filter((name) => name.startsWith(`${marketDate}-${feed}-`) && name.endsWith('.json')); }).catch(() => {});
  let requestSymbols = [...chosen.keys()].filter((symbol) => !profiles.has(symbol)).slice(0, Math.max(0, dailyCap - dailyFiles.length));
  let providerError = null;
  if (requestSymbols.length) {
    try {
      const startDate = shiftDate(marketDate, -14), endDate = shiftDate(marketDate, -1);
      const calendarUrl = new URL(`${API_ROOT}/calendar?start=${startDate}&end=${endDate}`);
      const calendar = await requestJson(calendarUrl, headers, fetcher, metrics, 'Alpaca ETF historical volume calendar');
      if (!Array.isArray(calendar)) throw new Error('Alpaca historical calendar response was not an array.');
      const sessions = new Map(calendar.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row?.date) && row.date < marketDate
        && row.open && row.close).map((row) => [row.date, { openTime: zonedDateTime(row.date, row.open, 'America/New_York'),
        closeTime: zonedDateTime(row.date, row.close, 'America/New_York') }]));
      const barsBySymbol = new Map(requestSymbols.map((symbol) => [symbol, []]));
      let pageToken = '';
      let page = 0;
      const maxPages = 3;
      do {
        const url = new URL(`${DATA_ROOT}/stocks/bars`);
        url.searchParams.set('symbols', requestSymbols.join(','));
        url.searchParams.set('timeframe', '5Min');
        url.searchParams.set('start', `${startDate}T00:00:00Z`);
        url.searchParams.set('end', new Date(Number(currentOpenTime) - 1).toISOString());
        url.searchParams.set('limit', '10000');
        url.searchParams.set('adjustment', 'split');
        url.searchParams.set('feed', feed);
        url.searchParams.set('sort', 'asc');
        if (pageToken) url.searchParams.set('page_token', pageToken);
        const payload = await requestJson(url, headers, fetcher, metrics, `Alpaca ETF time-of-day volume bars page ${page + 1}`);
        if (!payload?.bars || typeof payload.bars !== 'object') throw new Error('Alpaca historical bars response did not contain a symbol map.');
        for (const [symbol, rows] of Object.entries(payload.bars)) {
          if (!barsBySymbol.has(symbol) || !Array.isArray(rows)) continue;
          for (const bar of rows) {
            const time = Date.parse(bar?.t || '');
            if (!Number.isFinite(time)) continue;
            const date = ymd(new Date(time));
            const session = sessions.get(date);
            if (!session || time < session.openTime || time + 5 * 60_000 > session.closeTime) continue;
            const volume = Number(bar?.v);
            if (volume > 0) barsBySymbol.get(symbol).push({ marketDate: date, sessionOpenTime: session.openTime, time, volume });
          }
        }
        pageToken = String(payload.next_page_token || '');
        page += 1;
      } while (pageToken && page < maxPages);
      const truncated = Boolean(pageToken);
      for (const symbol of requestSymbols) {
        const observations = barsBySymbol.get(symbol).sort((a, b) => a.time - b.time);
        const profile = { schemaVersion: 1, marketDate, feed, symbol, fetchedAt: new Date(finiteNow).toISOString(),
          status: truncated ? 'pagination_cap_reached' : observations.length ? 'complete' : 'no_eligible_historical_bars', observations };
        if (!truncated) {
          const file = resolve(cacheDirectory, `${marketDate}-${feed}-${safeFilePart(symbol)}.json`);
          await atomicWriteJson(file, profile);
          profiles.set(symbol, profile);
        }
      }
      if (truncated) providerError = 'Historical volume pagination cap reached; incomplete profiles were discarded.';
    } catch (error) {
      providerError = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
      requestSymbols = [];
    }
  }
  const attached = trades.map((trade) => {
    const symbol = String(trade.symbol || '').toUpperCase();
    const profile = profiles.get(symbol);
    const isChosen = chosen.has(symbol);
    const profileStatus = !isChosen ? 'not_selected_by_volume_screen'
      : profile?.status === 'complete' || profile?.status === 'no_eligible_historical_bars'
        ? (profile.cacheHit ? 'cached' : profile.status) : providerError ? 'provider_error'
          : dailyFiles.length >= dailyCap ? 'daily_profile_cap_reached' : 'unavailable';
    return { ...trade, session: { ...trade.session,
      priorSessionVolumeBars: profile?.observations || [],
      timeOfDayVolumeProfile: { status: profileStatus, sampleBars: profile?.observations?.length || 0,
        feed, historicalSessionsRequested: 14, candidateSelected: isChosen } } };
  });
  return { trades: attached, diagnostics: { status: providerError ? 'partial' : env.ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED === 'true' ? 'available_or_insufficient_history' : 'disabled',
    enabled: env.ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED === 'true', candidateCap: cap, dailySymbolCap: dailyCap,
    candidatesSelected: candidates.length, symbolsRequested: requestSymbols.length, cachedProfiles: [...profiles.values()].filter((profile) => profile.cacheHit).length,
    profilesAvailable: [...profiles.values()].filter((profile) => profile.status === 'complete' && profile.observations.length).length,
    providerError } };
}

const requestJson = (...args) => requestAlpacaJson(...args);

export async function fetchEtfSessionBars(url, headers, fetcher, metrics) {
  const endpoint = new URL(url), bars = {}, tokens = new Set();
  const requested = new Set(endpoint.searchParams.get('symbols').split(','));
  let token = '';
  for (let page = 0; page < 10; page++) {
    if (token) endpoint.searchParams.set('page_token', token);
    const payload = await requestJson(endpoint.toString(), headers, fetcher, metrics, 'Alpaca ETF 5-minute bars');
    if (!payload?.bars || typeof payload.bars !== 'object' || Array.isArray(payload.bars)) {
      const error = new Error('Alpaca ETF bars response did not contain a symbol map.');
      error.providerOperation = 'Alpaca ETF 5-minute bars'; throw error;
    }
    for (const [symbol, rows] of Object.entries(payload.bars)) {
      if (!requested.has(symbol)) continue;
      if (!Array.isArray(rows)) { const error = new Error('Alpaca ETF bars contained malformed symbol rows.'); error.providerOperation = 'Alpaca ETF 5-minute bars'; throw error; }
      (bars[symbol] ??= []).push(...rows);
    }
    token = payload.next_page_token;
    if (token == null || token === '') return { bars };
    if (typeof token !== 'string' || tokens.has(token)) break;
    tokens.add(token);
  }
  const error = new Error('Alpaca ETF bar pagination incomplete or repeated; no partial history is eligible.');
  error.providerOperation = 'Alpaca ETF 5-minute bars'; throw error;
}

function ymd(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function zonedDateTime(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let result = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(result)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    result += desired - represented;
  }
  return result;
}

/** Read-only Alpaca feed. IEX is screening-only; consolidated SIP is required for executable paper candidates. */
export async function fetchAlpacaEtfSession({ env = process.env, fetcher = fetch, now = new Date(), catalystReviews = {}, providerMetrics = [], observationClock = null } = {}) {
  const startedAt = Date.now();
  let lastObservation = now.getTime();
  const observationTime = () => {
    const current = observationClock ? observationClock() : now.getTime() + Math.max(0, Date.now() - startedAt);
    if (!Number.isFinite(current) || current < lastObservation) throw new Error('Invalid ETF observation clock.');
    return (lastObservation = current);
  };
  const key = env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID;
  const secret = env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  if (!key || !secret) throw new Error('Alpaca credentials are required for ETF_SOURCE=alpaca.');
  const feed = String(env.ETF_ALPACA_FEED || 'iex').toLowerCase();
  if (!['iex', 'sip', 'delayed_sip'].includes(feed)) throw new Error('ETF_ALPACA_FEED must be iex, sip, or delayed_sip.');
  const configuredSymbols = String(env.ETF_SYMBOLS || '').trim();
  const discoveryMode = String(env.ETF_DISCOVERY_MODE || 'full-market');
  if (!['full-market', 'baseline'].includes(discoveryMode)) throw new Error('ETF_DISCOVERY_MODE must be full-market or baseline (comparison only).');
  const fullMarket = discoveryMode === 'full-market';
  let symbols = parseEtfSymbols(configuredSymbols);
  const prioritySymbols = [...symbols];
  let discoveryRegistry = [];
  let directoryChanges = null;
  let discovery = { mode: fullMarket ? 'full-market-directory' : configuredSymbols ? 'configured' : 'dynamic-directory-and-screener', universeSize: fullMarket ? null : symbols.length,
    directoryEligible: 0, screenerCandidates: 0, curatedCandidates: 0, screenerFailure: null, directoryCache: null };
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  if (!Array.isArray(providerMetrics)) throw new TypeError('providerMetrics must be an array.');
  const metrics = providerMetrics;
  const date = ymd(now);
  const sessionResults = await Promise.allSettled([
    requestJson(`${API_ROOT}/clock`, headers, fetcher, metrics, 'Alpaca market clock'),
    requestJson(`${API_ROOT}/calendar?start=${date}&end=${date}`, headers, fetcher, metrics, 'Alpaca market calendar'),
  ]);
  const sessionFailure = sessionResults.find((result) => result.status === 'rejected');
  if (sessionFailure) throw sessionFailure.reason;
  const [clock, calendar] = sessionResults.map((result) => result.value);
  const day = Array.isArray(calendar) ? calendar.find((row) => row.date === date) : null;
  const openTime = day?.open ? zonedDateTime(date, day.open, 'America/New_York') : NaN;
  const closeTime = day?.close ? zonedDateTime(date, day.close, 'America/New_York') : NaN;
  const capturedAt = Date.parse(clock?.timestamp || '');
  const marketOpen = clock?.is_open === true && day && Number.isFinite(openTime) && Number.isFinite(closeTime)
    && capturedAt >= openTime && capturedAt < closeTime && now.getTime() - capturedAt >= -5_000 && now.getTime() - capturedAt <= 30_000;
  if (!marketOpen) return { source: `Alpaca ${feed}`, trades: [], marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: false, universeSize: discovery.universeSize, scanned: 0, discovery, reason: day ? 'market_closed_or_clock_stale' : 'no_trading_session_today' } };
  if (feed === 'delayed_sip') return { source: `Alpaca ${feed}`, trades: [], marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: true, universeSize: discovery.universeSize, scanned: 0, discovery, reason: 'delayed_feed_not_eligible_for_entry' } };

  if (fullMarket) {
    const registry = await loadEtfRegistry({ env, fetcher, metrics, now });
    discoveryRegistry = registry.entries;
    directoryChanges = registry.membershipChanges ?? null;
    symbols = [...new Set([...registry.entries.map((row) => row.symbol), ...(registry.blockedSymbols || [])])];
    discovery = { ...discovery, version: ETF_DISCOVERY_VERSION, universeSize: symbols.length,
      directoryEligible: registry.entries.length, directoryCache: registry.cache, directoryCacheAgeMs: registry.cacheAgeMs,
      directorySources: registry.sources, directoryRefreshError: registry.refreshError ?? null,
      directoryInspection: registry.directoryInspection ?? null,
      membershipChanges: directoryChanges ? { comparedTo: directoryChanges.comparedTo, observedAt: directoryChanges.observedAt,
        addedCount: directoryChanges.added.length, removedCount: directoryChanges.removed.length, changedCount: directoryChanges.changed.length,
        addedSample: directoryChanges.added.slice(0, 20), removedSample: directoryChanges.removed.slice(0, 20), changedSample: directoryChanges.changed.slice(0, 20) } : null,
      supplementalEtpClassifications: registry.supplementalCount || 0, blockedClassifications: registry.blockedSymbols || [],
      prioritySymbolsOutsideDirectory: prioritySymbols.filter((symbol) => !symbols.includes(symbol)),
      selectedCandidates: 0, coverageBoundary: 'Exchange ETF flags plus source-reviewed ETP records, intersected with the account asset master; unclassified non-ETF ETP coverage remains incomplete.' };
  } else if (!configuredSymbols) {
    const registry = await loadEtfRegistry({ env, fetcher, metrics, now });
    discoveryRegistry = registry.entries;
    discovery = { ...discovery, universeSize: registry.entries.length, directoryEligible: registry.entries.length,
      directoryCache: registry.cache, directoryCacheAgeMs: registry.cacheAgeMs, directorySources: registry.sources,
      directoryInspection: registry.directoryInspection ?? null,
      supplementalEtpClassifications: registry.supplementalCount || 0,
      blockedClassifications: registry.blockedSymbols || [],
      directoryRefreshError: registry.refreshError ?? null };
    try {
      const [activePayload, moversPayload] = await Promise.all([
        requestJson(`${SCREENER_ROOT}/stocks/most-actives?by=volume&top=100`, headers, fetcher, metrics, 'Alpaca most-active ETF discovery'),
        requestJson(`${SCREENER_ROOT}/stocks/movers?top=50`, headers, fetcher, metrics, 'Alpaca mover ETF discovery'),
      ]);
      const screenerSymbols = [...new Set([...parseScreenerSymbols(activePayload), ...parseScreenerSymbols(moversPayload)])];
      const selected = selectEtfDiscoveryCandidates({ registry: registry.entries, screenerSymbols,
        curatedSymbols: CURATED_ETF_SEEDS, maxCandidates: Number(env.ETF_DISCOVERY_MAX_CANDIDATES || 200), blockedSymbols: registry.blockedSymbols || [] });
      symbols = selected.candidates;
      discovery = { ...discovery, screenerUniverseSymbols: screenerSymbols.length, screenerCandidates: selected.screenerEtfs,
        curatedCandidates: selected.curatedEtfs, selectedCandidates: symbols.length };
    } catch (error) {
      // Preserve the known curated scan if the optional market screener is unavailable.
      const blocked = new Set(registry.blockedSymbols || []);
      symbols = CURATED_ETF_SEEDS.filter((symbol) => !blocked.has(symbol) && registry.entries.some((entry) => entry.symbol === symbol));
      discovery = { ...discovery, screenerFailure: String(error.message || error).slice(0, 180),
        selectedCandidates: symbols.length, fallback: 'curated-seeds' };
    }
  } else {
    const classifications = await loadConfiguredEtpClassifications({ env, now });
    const blocked = new Set(classifications.blockedSymbols);
    const manualBySymbol = new Map(classifications.entries.map((row) => [row.symbol, row]));
    // An Alpaca us_equity asset is not proof that a configured symbol is an ETF/ETP.
    // Verify ordinary configured symbols against the exchange ETF directories; ETNs
    // and other wrappers require an explicit source-reviewed supplemental row.
    const needsExchangeIdentity = symbols.some((symbol) => !blocked.has(symbol) && !manualBySymbol.has(symbol));
    let listed = { entries: [], cache: 'not_needed', cacheAgeMs: null, sources: null, refreshError: null };
    if (needsExchangeIdentity) listed = await loadEtfRegistry({ env, fetcher, metrics, now });
    const registryBySymbol = new Map(listed.entries.map((row) => [row.symbol, row]));
    for (const row of classifications.entries) registryBySymbol.set(row.symbol, row);
    for (const symbol of blocked) registryBySymbol.delete(symbol);
    const unverifiedConfiguredSymbols = symbols.filter((symbol) => !blocked.has(symbol) && !registryBySymbol.has(symbol));
    discoveryRegistry = [...registryBySymbol.values()];
    const beforeClassification = symbols.length;
    symbols = symbols.filter((symbol) => !blocked.has(symbol) && registryBySymbol.has(symbol));
    discovery = { ...discovery, selectedCandidates: symbols.length,
      requestedCandidates: beforeClassification,
      supplementalEtpClassifications: classifications.entries.length,
      blockedClassifications: classifications.blockedSymbols,
      classificationBlockedCandidates: beforeClassification - symbols.length,
      unverifiedConfiguredSymbols,
      directoryCache: listed.cache, directoryCacheAgeMs: listed.cacheAgeMs,
      directorySources: listed.sources, directoryRefreshError: listed.refreshError ?? null };
  }

  const assetRows = await requestJson(`${API_ROOT}/assets?status=active&asset_class=us_equity`, headers, fetcher, metrics, 'Alpaca active asset master');
  if (!Array.isArray(assetRows)) throw new Error('Alpaca active asset master response was not an array.');
  const bySymbol = new Map(assetRows.map((asset) => [String(asset?.symbol || '').toUpperCase(), asset]));
  const duplicateSymbols = new Set(), seenAssetSymbols = new Set();
  for (const asset of assetRows) {
    const symbol = String(asset?.symbol || '').toUpperCase();
    if (seenAssetSymbols.has(symbol)) duplicateSymbols.add(symbol);
    seenAssetSymbols.add(symbol);
  }
  let eligible = [];
  const directoryExclusions = [];
  const excludeDirectory = (symbol, reason) => directoryExclusions.push({ symbol, status: 'excluded', stage: 'identity_and_account', reasons: [reason] });
  const rejectedAssets = {};
  const rejectedDiscovery = discovery.unverifiedConfiguredSymbols?.length
    ? { security_type_unverified: discovery.unverifiedConfiguredSymbols.length } : {};
  const unreviewedWrapperSymbols = [];
  const registryBySymbol = new Map(discoveryRegistry.map((row) => [row.symbol, row]));
  for (const symbol of symbols) {
    const asset = bySymbol.get(symbol);
    if (!registryBySymbol.has(symbol)) { rejectedDiscovery.security_type_unverified = (rejectedDiscovery.security_type_unverified || 0) + 1; excludeDirectory(symbol, 'security_type_unverified'); continue; }
    const identity = registryBySymbol.get(symbol);
    const listedName = `${identity?.name || ''} ${asset?.name || ''}`;
    const unreviewedReason = identity?.source === 'supplemental-reviewed' ? null
      : hasUnreviewedEtnMarker(listedName) ? 'unreviewed_etn_name'
        : hasUnreviewedLeverageMarker(listedName) ? 'unreviewed_leveraged_or_inverse_name' : null;
    if (unreviewedReason) {
      rejectedDiscovery[unreviewedReason] = (rejectedDiscovery[unreviewedReason] || 0) + 1;
      unreviewedWrapperSymbols.push(symbol);
      excludeDirectory(symbol, unreviewedReason);
      continue;
    }
    const reason = !asset ? 'not_in_active_asset_master'
      : fullMarket && duplicateSymbols.has(symbol) ? 'ambiguous_active_asset_identity'
      : fullMarket && (!asset.id || asset.class !== 'us_equity') ? 'asset_identity_unverified'
      : asset.status !== 'active' ? 'asset_not_active'
        : asset.tradable !== true ? 'asset_not_tradable'
          : !SUPPORTED_LISTINGS.has(String(asset.exchange || '').toUpperCase()) ? 'unsupported_listing' : null;
    if (reason) { rejectedAssets[reason] = (rejectedAssets[reason] || 0) + 1; excludeDirectory(symbol, reason); }
    else eligible.push({ ...registryBySymbol.get(symbol), symbol, exchange: String(asset.exchange).toUpperCase(),
      providerAssetId: asset.id ?? null, name: String(asset.name || registryBySymbol.get(symbol)?.name || ''), instrumentType: registryBySymbol.get(symbol)?.instrumentType || 'etf' });
  }
  discovery = { ...discovery, activeTradableCandidates: eligible.length, rejectedAssets, rejectedDiscovery,
    unreviewedWrapperSymbols: fullMarket ? unreviewedWrapperSymbols.slice(0, 20) : unreviewedWrapperSymbols,
    unreviewedWrapperCount: unreviewedWrapperSymbols.length };
  if (fullMarket) {
    const screen = await screenFullEtfMarket({ assets: eligible, now: observationTime(), observationClock: observationTime, openTime, closeTime,
      maxCandidates: Number(env.ETF_DISCOVERY_MAX_CANDIDATES || 200), maxAgeMs: Number(env.ETF_MAX_QUOTE_AGE_MS || 15_000), priorities: prioritySymbols,
      requestSnapshots: (batch) => requestJson(`${DATA_ROOT}/stocks/snapshots?symbols=${encodeURIComponent(batch.join(','))}&feed=${feed}`,
        headers, fetcher, metrics, 'Alpaca ETF full-market snapshots') });
    const ids = new Map(eligible.map((row) => [row.symbol, row.providerAssetId]));
    const fullRows = [...directoryExclusions, ...screen.rows.map((row) => ({ ...row, providerAssetId: ids.get(row.symbol), stage: 'cheap_screen' }))];
    const journal = await archiveEtfDiscovery({ version: ETF_DISCOVERY_VERSION, feed, directory: discovery,
      counts: screen.diagnostics, membershipChanges: directoryChanges, rows: fullRows }, { directory: env.ETF_DISCOVERY_HISTORY_PATH || '.cache/etf-discovery-history', now: observationTime() });
    discovery = { ...discovery, providerInstruments: assetRows.length, directoryExcluded: directoryExclusions.length,
      cheapScreen: screen.diagnostics, selectedCandidates: screen.shortlist.length, journal };
    const eligibleBySymbol = new Map(eligible.map((row) => [row.symbol, row]));
    eligible = screen.shortlist.map((symbol) => eligibleBySymbol.get(symbol));
  }
  if (!eligible.length) return { source: `Alpaca ${feed}`, trades: [], marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: true, universeSize: discovery.universeSize, activeTradable: discovery.activeTradableCandidates, scanned: 0, rejectedAssets, discovery, reason: 'no_eligible_screen_candidates' } };
  const eligibleWithReview = eligible.filter((asset) => isFreshClearCatalystReview(catalystReviews?.[asset.symbol], { now: observationTime(), maxAgeMs: 30 * 60_000 }));
  const rejectedCatalysts = { catalyst_review_missing_stale_or_unclear: eligible.length - eligibleWithReview.length };
  if (!rejectedCatalysts.catalyst_review_missing_stale_or_unclear) delete rejectedCatalysts.catalyst_review_missing_stale_or_unclear;
  const eligibleSymbols = eligibleWithReview.map((asset) => asset.symbol);
  const newsBySymbol = new Map(eligibleSymbols.map((symbol) => [symbol, []]));
  const newsCoverageErrors = new Set();
  // Reviews are only valid for 30 minutes, so fetch the full interval a valid
  // review could cover. Ten-symbol pages avoid the endpoint's 50-item cap;
  // four pages run concurrently to bound latency and provider pressure.
  const newsWindowEnd = observationTime();
  const reviewWindowStart = new Date(newsWindowEnd - 30 * 60_000).toISOString();
  const newsBatches = [];
  for (let offset = 0; offset < eligibleSymbols.length; offset += 10) newsBatches.push(eligibleSymbols.slice(offset, offset + 10));
  const fetchNewsBatch = async (batch) => {
    let pageToken = '';
    let page = 0;
    try {
      do {
        const params = new URLSearchParams({ symbols: batch.join(','), start: reviewWindowStart, end: new Date(newsWindowEnd).toISOString(), sort: 'desc', limit: '50' });
        if (pageToken) params.set('page_token', pageToken);
        const newsPayload = await requestJson(`${NEWS_ROOT}?${params}`, headers, fetcher, metrics, 'Alpaca ETF catalyst news');
        if (!Array.isArray(newsPayload?.news)) throw new Error('Alpaca news response did not include an article array.');
        for (const article of newsPayload.news) {
          const normalized = normalizeAlpacaNewsArticle(article, { now: observationTime() });
          if (!normalized) {
            for (const symbol of batch) newsCoverageErrors.add(symbol);
            continue;
          }
          for (const symbol of normalized.symbols) if (newsBySymbol.has(symbol) && batch.includes(symbol)) {
            newsBySymbol.get(symbol).push(normalized);
          }
        }
        pageToken = String(newsPayload.next_page_token || '');
        page += 1;
      } while (pageToken && page < 5);
      if (pageToken) for (const symbol of batch) newsCoverageErrors.add(symbol);
    } catch {
      for (const symbol of batch) newsCoverageErrors.add(symbol);
    }
  };
  for (let offset = 0; offset < newsBatches.length; offset += 4) {
    await Promise.all(newsBatches.slice(offset, offset + 4).map(fetchNewsBatch));
  }
  const catalystEligible = [];
  const rejectCatalyst = (reason) => { rejectedCatalysts[reason] = (rejectedCatalysts[reason] || 0) + 1; };
  for (const asset of eligibleWithReview) {
    const review = catalystReviews?.[asset.symbol];
    const reviewAt = Number.isFinite(Number(review?.reviewedAt)) ? Number(review.reviewedAt) : Date.parse(review?.reviewedAt || '');
    const news = newsBySymbol.get(asset.symbol) || [];
    if (newsCoverageErrors.has(asset.symbol)) { rejectCatalyst('news_provider_or_pagination_incomplete'); continue; }
    if (news.some((article) => article.activityAt > reviewAt)) { rejectCatalyst('news_activity_after_review'); continue; }
    catalystEligible.push({ ...asset, catalystReview: review, catalystNews: news });
  }
  if (!catalystEligible.length) return { source: `Alpaca ${feed}`, trades: [], marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: true, universeSize: discovery.universeSize, activeTradable: discovery.activeTradableCandidates, catalystCleared: 0, scanned: 0, rejectedAssets, rejectedCatalysts, discovery, recentNewsBySymbol: Object.fromEntries([...newsBySymbol].map(([symbol, rows]) => [symbol, rows.length])), feed,
      reason: 'no_symbols_passed_catalyst_review' } };
  const scanSymbols = catalystEligible.map((asset) => asset.symbol);
  const marketDataBatches = [];
  for (let offset = 0; offset < scanSymbols.length; offset += 100) marketDataBatches.push(scanSymbols.slice(offset, offset + 100));
  const marketDataResults = await Promise.allSettled(marketDataBatches.flatMap((batch) => {
    const encoded = encodeURIComponent(batch.join(','));
    return [
      requestJson(`${DATA_ROOT}/stocks/snapshots?symbols=${encoded}&feed=${feed}`, headers, fetcher, metrics, 'Alpaca ETF snapshots')
        .then(payload => ({ payload, receivedAt: observationTime() })),
      fetchEtfSessionBars(`${DATA_ROOT}/stocks/bars?symbols=${encoded}&timeframe=5Min&start=${encodeURIComponent(new Date(openTime).toISOString())}&end=${encodeURIComponent(new Date(observationTime()).toISOString())}&limit=10000&feed=${feed}&sort=asc`, headers, fetcher, metrics),
    ];
  }));
  const marketDataFailure = marketDataResults.find((result) => result.status === 'rejected');
  if (marketDataFailure) return { source: `Alpaca ${feed}`, trades: [], marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: true, universeSize: discovery.universeSize, activeTradable: discovery.activeTradableCandidates,
      catalystCleared: catalystEligible.length, scanned: catalystEligible.length, rowsWithUsableData: 0,
      rejectedAssets, rejectedCatalysts, discovery, feed, reason: 'detailed_market_data_incomplete',
      providerError: String(marketDataFailure.reason?.message || 'Detailed data request failed').replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180),
      failedProviderOperation: marketDataFailure.reason?.providerOperation ?? 'Alpaca detailed ETF data' } };
  const data = {};
  const receivedAtBySymbol = {};
  const barsBySymbol = {};
  for (let index = 0; index < marketDataResults.length; index += 2) {
    const { payload: snapshots, receivedAt } = marketDataResults[index].value;
    const barPayload = marketDataResults[index + 1].value;
    for (const symbol of Object.keys(snapshots?.snapshots || snapshots || {})) receivedAtBySymbol[symbol] = receivedAt;
    Object.assign(data, snapshots?.snapshots || snapshots || {});
    Object.assign(barsBySymbol, barPayload?.bars || {});
  }
  const maxAge = Number(env.ETF_MAX_QUOTE_AGE_MS || 15_000);
  const freshnessLimit = feed === 'iex' ? Math.min(maxAge, 15_000) : maxAge;
  let trades = [];
  const rejected = {};
  const quoteRejections = [];
  const rejectedRows = [];
  const reject = (reason, symbol) => { rejected[reason] = (rejected[reason] || 0) + 1; rejectedRows.push({ symbol, reason }); };
  for (const { symbol, exchange, name, instrumentType, productType, exposureKey, leverage, inverse, classificationSourceUrl, classificationReviewedAt, catalystReview, catalystNews } of catalystEligible) {
    const snap = data?.[symbol];
    const q = snap?.latestQuote;
    const qt = Date.parse(q?.t || '');
    const bid = Number(q?.bp), ask = Number(q?.ap);
    const rows = (barsBySymbol?.[symbol] || []).map((bar) => ({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }));
    if (!snap) { reject('snapshot_missing', symbol); continue; }
    // Retain a quote that was valid when received as a dated research input.
    // The entry workflow must refresh/revalidate it after the history work.
    const quoteObservedAt = receivedAtBySymbol[symbol];
    if (!Number.isFinite(qt) || quoteObservedAt - qt < 0 || quoteObservedAt - qt > freshnessLimit || quoteObservedAt >= closeTime) { reject('stale_or_future_quote', symbol); continue; }
    if (!(bid > 0 && ask >= bid)) { reject('invalid_bid_ask', symbol); continue; }
    if (!rows.length) { reject('intraday_bars_missing', symbol); continue; }
    let quote;
    try {
      quote = parseAlpacaStockQuote(q, { symbol, feed, source: 'snapshot', now: quoteObservedAt, maxQuoteAgeMs: freshnessLimit });
    } catch (error) {
      const reason = error.code || 'stock_quote_evidence_required';
      quoteRejections.push({ symbol, reason });
      // Free IEX remains usable as a reference even when it cannot prove an
      // executable quote. SIP candidate inputs must carry native evidence.
      if (feed === 'sip') { reject(reason, symbol); continue; }
      quote = { bid, ask, time: qt, quality: 'reference' };
    }
    if (feed !== 'sip') quote = { ...quote, quality: 'reference' };
    trades.push({ symbol, assetClass: instrumentType === 'etp' ? 'etp' : 'etf', productType: productType || null,
      ...(instrumentType === 'etp' ? { classificationSourceUrl, classificationReviewedAt } : {}),
      exposureKey: exposureKey || symbol, leverage: leverage ?? 1, inverse: inverse === true, exchange, instrumentName: name, bars: rows,
      quote,
      session: { marketDate: date, openTime, closeTime, timeZone: 'America/New_York', marketSide: 'equity-us', expectedBarsThroughNow: true,
        discoveryVersion: fullMarket ? ETF_DISCOVERY_VERSION : 'legacy-curated-and-movers',
        catalystReview, catalystNews: catalystNews.map(({ id, provider, symbols: articleSymbols, createdAt, updatedAt, activityAt, headline, publisher, sourceUrl }) => ({
          id, provider, symbols: articleSymbols, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString(),
          activityAt: new Date(activityAt).toISOString(), headline, publisher, sourceUrl })) },
    });
  }
  const afterDetailedData = etfQuoteAges(trades, observationTime());
  let timeOfDayVolumeProfile = { status: 'disabled', enabled: false, candidatesSelected: 0, symbolsRequested: 0, profilesAvailable: 0 };
  if (env.ETF_TIME_OF_DAY_VOLUME_PROFILE_ENABLED === 'true') {
    try {
      const profiled = await attachEtfTimeOfDayVolumeProfiles(trades, { env, headers, fetcher, metrics, now,
        marketDate: date, currentOpenTime: openTime, feed,
        maxCandidates: Number(env.ETF_TOD_VOLUME_PROFILE_SYMBOLS_PER_SCAN || 10),
        dailySymbolCap: Number(env.ETF_TOD_VOLUME_PROFILE_SYMBOLS_PER_DAY || 10) });
      trades = profiled.trades;
      timeOfDayVolumeProfile = profiled.diagnostics;
    } catch (error) {
      timeOfDayVolumeProfile = { status: 'provider_error', enabled: true,
        providerError: String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180) };
    }
  }
  return { source: `Alpaca ${feed}`, trades, marks: [], sessionDate: date, providerMetrics: metrics,
    diagnostics: { marketOpen: true, universeSize: discovery.universeSize, activeTradable: discovery.activeTradableCandidates, catalystCleared: catalystEligible.length, scanned: catalystEligible.length, rowsWithUsableData: trades.length, rejectedAssets, rejectedCatalysts, discovery, recentNewsBySymbol: Object.fromEntries([...newsBySymbol].map(([symbol, rows]) => [symbol, rows.length])), rejected, rejectedRows,
      quoteCollectionAges: { afterDetailedData, afterVolumeProfiles: etfQuoteAges(trades, observationTime()) },
      quoteEvidence: { scope: 'detailed_candidate_quotes_at_receipt', feed, nativeVerified: trades.filter(row => row.quote.stockQuoteEvidence).length,
        executable: trades.filter(row => row.quote.quality === 'executable').length, referenceOnly: trades.filter(row => row.quote.quality === 'reference').length,
        evidenceRejections: quoteRejections },
      timeOfDayVolumeProfile, feed, quoteUse: feed === 'sip' ? 'consolidated-executable-paper-input' : 'single-venue-screening-only', maxQuoteAgeMs: freshnessLimit } };
}

/** Fetch current consolidated quotes only to manage already-open ETF/ETP paper rows.
 * This exit path deliberately does not run the new-entry universe or catalyst gates.
 */
export async function fetchAlpacaEtfPositionMarks(orders, { env = process.env, fetcher = fetch, now = new Date(), providerMetrics = [], clock: clockNow = Date.now } = {}) {
  if (!Array.isArray(orders)) throw new TypeError('Open paper orders must be an array.');
  if (!Array.isArray(providerMetrics)) throw new TypeError('providerMetrics must be an array.');
  const positions = orders.filter((order) => order?.owner === 'etfs-etps'
    && ['etf', 'etp'].includes(String(order.assetClass).toLowerCase())
    && ['reserved', 'filled', 'open'].includes(order.status));
  const symbols = [...new Set(positions.map((order) => String(order.instrumentKey || '').trim().toUpperCase())
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)))];
  if (!symbols.length) return { marks: [], diagnostics: { status: positions.length ? 'invalid_open_position_instrument' : 'no_open_etf_positions', positions: positions.length, symbols: 0, quoted: 0, rejected: positions.length,
    rejectionReasons: positions.length ? { invalid_instrument_key: positions.length } : {} } };
  const feed = String(env.ETF_ALPACA_FEED || 'iex').toLowerCase();
  if (feed !== 'sip') return { marks: [], diagnostics: { status: 'consolidated_sip_required_for_position_marks', positions: positions.length, symbols: symbols.length, quoted: 0, rejected: positions.length } };
  const key = env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID;
  const secret = env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  if (!key || !secret) return { marks: [], diagnostics: { status: 'credentials_missing', positions: positions.length, symbols: symbols.length, quoted: 0, rejected: positions.length } };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('Position-mark time must be valid.');
  const started = clockNow();
  const observedNow = () => nowMs + Math.max(0, clockNow() - started);
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const date = ymd(new Date(nowMs));
  const sessionResults = await Promise.allSettled([
    requestJson(`${API_ROOT}/clock`, headers, fetcher, providerMetrics, 'Alpaca ETF position market clock'),
    requestJson(`${API_ROOT}/calendar?start=${date}&end=${date}`, headers, fetcher, providerMetrics, 'Alpaca ETF position calendar'),
  ]);
  const sessionFailure = sessionResults.find((result) => result.status === 'rejected');
  if (sessionFailure) throw sessionFailure.reason;
  const [clock, calendar] = sessionResults.map((result) => result.value);
  const day = Array.isArray(calendar) ? calendar.find((row) => row.date === date) : null;
  const openTime = day?.open ? zonedDateTime(date, day.open, 'America/New_York') : NaN;
  const closeTime = day?.close ? zonedDateTime(date, day.close, 'America/New_York') : NaN;
  const capturedAt = Date.parse(clock?.timestamp || '');
  const sessionOpen = clock?.is_open === true && day && Number.isFinite(openTime) && Number.isFinite(closeTime)
    && capturedAt >= openTime && capturedAt < closeTime && Math.abs(nowMs - capturedAt) <= 30_000;
  if (!sessionOpen) return { marks: [], diagnostics: { status: day ? 'market_closed_or_clock_stale' : 'no_trading_session_today', positions: positions.length, symbols: symbols.length, quoted: 0, rejected: positions.length } };

  const marks = [];
  const rejectionReasons = {};
  const configuredMaxAge = Number(env.ETF_MAX_QUOTE_AGE_MS || 15_000);
  const maxAgeMs = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 15_000;
  for (let offset = 0; offset < symbols.length; offset += 100) {
    const batch = symbols.slice(offset, offset + 100);
    const url = `${DATA_ROOT}/stocks/snapshots?symbols=${encodeURIComponent(batch.join(','))}&feed=sip`;
    const payload = await requestJson(url, headers, fetcher, providerMetrics, 'Alpaca ETF position quotes');
    const snapshots = payload?.snapshots || payload;
    for (const order of positions.filter((row) => batch.includes(String(row.instrumentKey || '').trim().toUpperCase()))) {
      const symbol = String(order.instrumentKey).trim().toUpperCase();
      const quote = snapshots?.[symbol]?.latestQuote;
      const time = Date.parse(quote?.t || '');
      const bid = hasExplicitFiniteAmount(quote?.bp) ? Number(quote.bp) : NaN;
      const ask = hasExplicitFiniteAmount(quote?.ap) ? Number(quote.ap) : NaN;
      const current = observedNow();
      const reason = current >= closeTime ? 'session_closed_during_quotes'
        : !Number.isFinite(time) || time > current + 5_000 || current - time > maxAgeMs ? 'stale_or_future_quote'
        : time < openTime || time >= closeTime ? 'quote_outside_regular_session'
          : !(bid > 0 && ask >= bid) ? 'invalid_bid_ask' : null;
      if (reason) { rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1; continue; }
      let nativeQuote;
      try {
        nativeQuote = parseAlpacaStockQuote(quote, { symbol, feed: 'sip', source: 'snapshot', now: current, maxQuoteAgeMs: maxAgeMs });
      } catch (error) {
        const code = error.code || 'stock_quote_evidence_required';
        rejectionReasons[code] = (rejectionReasons[code] || 0) + 1;
        continue;
      }
      marks.push({ orderId: order.orderId, quote: nativeQuote, sessionOpen: true });
    }
  }
  const invalidInstruments = positions.filter((order) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(String(order.instrumentKey || '').trim().toUpperCase())).length;
  if (invalidInstruments) rejectionReasons.invalid_instrument_key = invalidInstruments;
  const completed = observedNow();
  const currentMarks = marks.filter((mark) => {
    const reason = completed >= closeTime ? 'session_closed_during_quotes'
      : completed - Date.parse(mark.quote.time) > maxAgeMs ? 'quote_aged_during_collection' : null;
    if (reason) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    return !reason;
  });
  return { marks: currentMarks, diagnostics: { status: 'complete', positions: positions.length, symbols: symbols.length, quoted: currentMarks.length,
    rejected: positions.length - currentMarks.length, rejectionReasons, feed: 'sip', quoteAgeLimitMs: maxAgeMs } };
}
