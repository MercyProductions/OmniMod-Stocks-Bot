import { getGuildSettings, providerKeys } from './guildSettings.js';
import { config, dataDir } from './config.js';
import { join } from 'node:path';
import { getAlpacaStreamSnapshot } from './alpacaStream.js';
import { parseAlpacaStockQuote } from '../../new-bots/shared/stockQuoteEvidence.js';
import { enrichAssetsWithIntelligence } from './eventIntelligence.js';
import { readJson, readMarketSnapshot, writeMarketSnapshot, paths } from './storage.js';
import { getListedEtfUniverse, getStockDiscoveryOwnership } from './etfDirectory.js';
import { recordProviderRequest, summarizeProviderMetrics } from './scanDiagnostics.js';
import { localDateKey } from './time.js';
import { alpacaThrottleDelayMs, waitForAlpacaRequest } from './alpacaRequestGate.js';
import { classifyStockDirectory, stockDirectoryChanges, STOCK_DISCOVERY_VERSION } from './stockDirectory.js';
import { archiveDiscovery } from '../../new-bots/shared/equitySnapshotDiscovery.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values) => { const rows = [...values].sort((a, b) => a - b); return rows.length ? rows[Math.floor((rows.length - 1) / 2)] : 0; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

const SECTORS = Object.freeze({
  AAPL:'XLK',MSFT:'XLK',NVDA:'XLK',AVGO:'XLK',AMD:'XLK',CRM:'XLK',ORCL:'XLK',MU:'XLK',INTC:'XLK',ARM:'XLK',SMCI:'XLK',PLTR:'XLK',
  AMZN:'XLY',TSLA:'XLY',HD:'XLY',DIS:'XLY',UBER:'XLY',META:'XLC',GOOGL:'XLC',NFLX:'XLC',
  JPM:'XLF',BAC:'XLF',GS:'XLF',V:'XLF',MA:'XLF',COIN:'XLF',MSTR:'XLK',
  LLY:'XLV',UNH:'XLV',JNJ:'XLV',XOM:'XLE',CVX:'XLE',WMT:'XLP',COST:'XLP',BA:'XLI',CAT:'XLI',GE:'XLI'
});
const MARKET_CONTEXT = Object.freeze(['SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLY','XLI','XLP','XLU','XLC','XLB','XLRE']);

export function summarizeStockUniverseCoverage(snapshot = {}) {
  const symbols = (rows, readSymbol) => Array.isArray(rows)
    ? new Set(rows.map(readSymbol).map((symbol) => String(symbol ?? '').trim().toUpperCase()).filter(Boolean))
    : null;
  const requested = symbols(snapshot.requestedSymbols, (symbol) => symbol);
  const scanned = symbols(snapshot.assets, (asset) => asset?.symbol);
  const count = (set, context) => set === null ? null
    : [...set].filter((symbol) => MARKET_CONTEXT.includes(symbol) === context).length;
  const missing = (context) => requested === null || scanned === null ? null
    : [...requested].filter((symbol) => MARKET_CONTEXT.includes(symbol) === context && !scanned.has(symbol)).length;
  return {
    requestedTotal: requested?.size ?? null,
    requestedMarketContext: count(requested, true),
    requestedNonContext: count(requested, false),
    scannedTotal: scanned?.size ?? null,
    scannedMarketContext: count(scanned, true),
    scannedNonContext: count(scanned, false),
    missingMarketContext: missing(true),
    missingNonContext: missing(false),
    unexpectedReturned: requested === null || scanned === null ? null
      : [...scanned].filter((symbol) => !requested.has(symbol)).length
  };
}
const activeEquityUniverseCache = new Map();
const wideDiscoveryCache = new Map();
const wideDiscoveryInFlight = new Map();
const DAILY_FIELDS = Object.freeze([
  'dailySma20','dailySma50','dailySma200','dailyRsi14','dailyMacd','dailyMacdSignal','dailyMacdHistogram',
  'dailyAtrPercent','previous20High','previous20Low','averageDailyVolume','change5d','change20d','realizedVol20',
  'dailyHistoryCount','dailyUpdatedAt'
]);
const sessionDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const sessionMinuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const sessionDateCache = new Map();
const sessionMinuteCache = new Map();
const dynamicDiscoveryCache = new Map();

export function summarizeSectorProxyCoverage(assets = []) {
  const candidates = Array.isArray(assets) ? assets.filter((asset) => !MARKET_CONTEXT.includes(String(asset?.symbol ?? '').toUpperCase())) : [];
  const proxyAvailable = candidates.filter((asset) => asset.sectorContextStatus === 'available').length;
  const proxyUnavailable = candidates.length - proxyAvailable;
  return { candidates: candidates.length, proxyAvailable, proxyUnavailable,
    coveragePct: candidates.length ? Number((proxyAvailable / candidates.length * 100).toFixed(1)) : null };
}

export function summarizeSecIndustryCoverage(assets = []) {
  const candidates = Array.isArray(assets) ? assets.filter((asset) => !MARKET_CONTEXT.includes(String(asset?.symbol ?? '').toUpperCase())) : [];
  const classified = candidates.filter((asset) => /^\d{4}$/.test(String(asset?.secSic || '')) && String(asset?.secSicDescription || '').trim()).length;
  return { candidates: candidates.length, classified, unavailable: candidates.length - classified,
    coveragePct: candidates.length ? Number((classified / candidates.length * 100).toFixed(1)) : null };
}

async function fetchJson(url, options = {}) {
  let lastError;
  const wait = options.sleepFn || sleep;
  const providerName = String(options.provider || '');
  const alpacaCredential = /alpaca/i.test(providerName)
    ? Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === 'apca-api-key-id')?.[1]
    : null;
  const alpacaGate = options.requestGate ?? (options.sleepFn ? null : waitForAlpacaRequest);
  let retryCooldownDelayMs = 0;
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let cooldownDelayMs = retryCooldownDelayMs;
    retryCooldownDelayMs = 0;
    let gateResult;
    if (alpacaCredential && alpacaGate) {
      try { gateResult = await alpacaGate(alpacaCredential); } catch (error) {
        recordProviderRequest(options.metrics, options.provider, { requestAttempted: false, error: error.code || 'ALPACA_BUDGET_UNAVAILABLE' });
        throw error;
      }
      cooldownDelayMs += Number.isFinite(Number(gateResult?.cooldownDelayMs)) ? Math.max(0, Number(gateResult.cooldownDelayMs)) : 0;
    }
    const startedAt = Date.now();
    let response;
    let recorded = false;
    try {
      response = await (options.fetcher || fetch)(url, {
        headers: { accept: 'application/json', 'user-agent': 'OmniMod-Stocks/2.0 research-only', ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 12000)
      });
      if (alpacaCredential) await alpacaGate?.observe?.(alpacaCredential, response.headers, { reservationId: gateResult?.reservationId, status: response.status });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${options.provider || 'Market provider'} returned HTTP ${response.status}: ${text.slice(0, 180)}`);
        error.status = response.status;
        recordProviderRequest(options.metrics, options.provider, { latencyMs: Date.now() - startedAt, cooldownDelayMs, status: response.status, headers: response.headers, retry: attempt > 0, error: error.message });
        recorded = true;
        throw error;
      }
      const payload = JSON.parse(text);
      const providerMessage = payload?.['Error Message'] || payload?.Information || payload?.Note;
      if (providerMessage) {
        const error = new Error(`${options.provider || 'Market provider'}: ${String(providerMessage).slice(0, 180)}`);
        error.status = payload?.Note || /rate|frequency|limit/i.test(providerMessage) ? 429 : 400;
        recordProviderRequest(options.metrics, options.provider, { latencyMs: Date.now() - startedAt, cooldownDelayMs, status: error.status, headers: response.headers, retry: attempt > 0, error: error.message });
        recorded = true;
        throw error;
      }
      recordProviderRequest(options.metrics, options.provider, { latencyMs: Date.now() - startedAt, cooldownDelayMs, status: response.status, headers: response.headers, retry: attempt > 0 });
      recorded = true;
      return payload;
    } catch (error) {
      if (!recorded) recordProviderRequest(options.metrics, options.provider, { latencyMs: Date.now() - startedAt, cooldownDelayMs, status: error?.status || response?.status || 0, headers: response?.headers, retry: attempt > 0, error: error?.message || String(error) });
      lastError = error;
      const retryableStatus = [429, 500, 502, 503, 504].includes(error?.status);
      const retryableTransport = ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
      const retryAfter = error.status === 429
        ? alpacaCredential
          ? alpacaThrottleDelayMs(response?.headers, Date.now(), 1000 * 2 ** attempt)
          : retryAfterMs(response?.headers?.get?.('retry-after'))
        : null;
      if (error.status === 429 && alpacaCredential) await alpacaGate?.defer?.(alpacaCredential, retryAfter);
      if (attempt >= maxAttempts - 1 || (!retryableStatus && !retryableTransport)) break;
      if (retryAfter !== null && retryAfter > 10_000) break;
      const retryWaitMs = retryAfter ?? 1000 * 2 ** attempt;
      await wait(retryWaitMs);
      if (error.status === 429 && alpacaCredential && alpacaGate) retryCooldownDelayMs = retryWaitMs;
    }
  }
  throw lastError;
}

export async function fetchFinnhubJson(endpoint, params, token, { provider = 'Finnhub', metrics = null, fetcher = fetch, sleepFn } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('Finnhub API token is required.');
  const relativeEndpoint = String(endpoint || '').replace(/^\/+/, '');
  const url = new URL(relativeEndpoint, 'https://finnhub.io/api/v1/');
  if (!relativeEndpoint || url.origin !== 'https://finnhub.io' || !url.pathname.startsWith('/api/v1/')) {
    throw new TypeError('Finnhub endpoint must be a relative API v1 path.');
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return fetchJson(url.toString(), { provider, metrics, fetcher, sleepFn, headers: { 'X-Finnhub-Token': token.trim() } });
}

export async function fetchPolygonJson(endpoint, params, apiKey, { provider = 'Polygon', metrics = null, fetcher = fetch, sleepFn } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('Polygon API key is required.');
  const relativeEndpoint = String(endpoint || '').replace(/^\/+/, '');
  const url = new URL(relativeEndpoint, 'https://api.polygon.io/');
  if (!relativeEndpoint || url.origin !== 'https://api.polygon.io' || !url.pathname.startsWith('/v')) {
    throw new TypeError('Polygon endpoint must be a relative API path.');
  }
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  return fetchJson(url.toString(), { provider, metrics, fetcher, sleepFn, headers: { authorization: `Bearer ${apiKey.trim()}` } });
}

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.length ? mean(slice) : 0;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * k + output[index - 1] * (1 - k));
  }
  return output;
}

function ema(values, period) {
  return emaSeries(values, period).at(-1) || 0;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;
  let gains = 0; let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (!averageLoss) return averageGain ? 100 : 50;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function macd(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const lineSeries = values.map((_, index) => finite(fast[index]) - finite(slow[index]));
  const signalSeries = emaSeries(lineSeries, 9);
  const line = lineSeries.at(-1) || 0;
  const signal = signalSeries.at(-1) || 0;
  return { line, signal, histogram: line - signal };
}

function atrPercent(highs, lows, closes, period = 14) {
  const ranges = [];
  for (let index = 1; index < closes.length; index += 1) {
    ranges.push(Math.max(highs[index] - lows[index], Math.abs(highs[index] - closes[index - 1]), Math.abs(lows[index] - closes[index - 1])));
  }
  return closes.at(-1) ? mean(ranges.slice(-period)) / closes.at(-1) * 100 : 0;
}

function adx(highs, lows, closes, period = 14) {
  if (closes.length <= period + 1) return 0;
  const trueRanges = []; const plusDm = []; const minusDm = [];
  for (let index = 1; index < closes.length; index += 1) {
    trueRanges.push(Math.max(highs[index] - lows[index], Math.abs(highs[index] - closes[index - 1]), Math.abs(lows[index] - closes[index - 1])));
    const up = highs[index] - highs[index - 1];
    const down = lows[index - 1] - lows[index];
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const dx = [];
  for (let index = period - 1; index < trueRanges.length; index += 1) {
    const tr = mean(trueRanges.slice(index - period + 1, index + 1));
    if (!tr) continue;
    const plusDi = mean(plusDm.slice(index - period + 1, index + 1)) / tr * 100;
    const minusDi = mean(minusDm.slice(index - period + 1, index + 1)) / tr * 100;
    if (plusDi + minusDi) dx.push(Math.abs(plusDi - minusDi) / (plusDi + minusDi) * 100);
  }
  return mean(dx.slice(-period));
}

function sessionDate(timestamp) {
  if (!sessionDateCache.has(timestamp)) sessionDateCache.set(timestamp, sessionDateFormatter.format(new Date(timestamp * 1000)));
  return sessionDateCache.get(timestamp);
}

function sessionMinute(timestamp) {
  if (sessionMinuteCache.has(timestamp)) return sessionMinuteCache.get(timestamp);
  const parts = sessionMinuteFormatter.formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = Number(values.hour) * 60 + Number(values.minute);
  sessionMinuteCache.set(timestamp, minute);
  return minute;
}

function percentChange(current, previous) {
  return previous ? (current / previous - 1) * 100 : 0;
}

export function normalizeBars(result) {
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    timestamp,
    open: finite(quote.open?.[index], NaN),
    high: finite(quote.high?.[index], NaN),
    low: finite(quote.low?.[index], NaN),
    close: finite(quote.close?.[index], NaN),
    volume: finite(quote.volume?.[index])
  })).filter((bar) => Number.isFinite(bar.timestamp) && [bar.open, bar.close, bar.high, bar.low].every((value) => Number.isFinite(value) && value > 0)
    && bar.high >= Math.max(bar.open, bar.close, bar.low) && bar.low <= Math.min(bar.open, bar.close))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function intradayFeatures(symbol, result) {
  const meta = result?.meta || {};
  const bars = normalizeBars(result);
  if (bars.length < 20) return null;
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const last = bars.at(-1);
  const latestDate = sessionDate(last.timestamp);
  const dates = [...new Set(bars.map((bar) => sessionDate(bar.timestamp)))];
  const today = bars.filter((bar) => sessionDate(bar.timestamp) === latestDate);
  const previousDate = dates.at(-2);
  const previousSession = previousDate ? bars.filter((bar) => sessionDate(bar.timestamp) === previousDate) : [];
  const previousClose = finite(previousSession.at(-1)?.close, finite(meta.previousClose ?? meta.chartPreviousClose, closes.at(-2)));
  // The latest bar is authoritative during extended hours; regularMarketPrice can still be the prior close.
  const price = last.close;
  const oneHourBar = [...bars].reverse().find((bar) => bar.timestamp <= last.timestamp - 60 * 60) || bars[0];
  const highDay = Math.max(...today.map((bar) => bar.high), price);
  const lowDay = Math.min(...today.map((bar) => bar.low), price);
  const volumeToday = today.reduce((sum, bar) => sum + bar.volume, 0);
  const completedDates = dates.filter((date) => date !== latestDate);
  const latestMinute = sessionMinute(last.timestamp);
  const premarketBars = today.filter((bar) => sessionMinute(bar.timestamp) >= 240 && sessionMinute(bar.timestamp) < 570);
  const priorPremarketBars = premarketBars.filter((bar) => bar.timestamp < last.timestamp).slice(-6);
  const premarketVolume = premarketBars.reduce((sum, bar) => sum + bar.volume, 0);
  const comparablePremarketVolumes = completedDates.map((date) => bars
    .filter((bar) => sessionDate(bar.timestamp) === date && sessionMinute(bar.timestamp) >= 240 && sessionMinute(bar.timestamp) <= latestMinute)
    .reduce((sum, bar) => sum + bar.volume, 0)).filter((value) => value > 0);
  const expectedPremarketVolume = comparablePremarketVolumes.length >= 3 ? median(comparablePremarketVolumes) : 0;
  const comparableVolumes = completedDates.map((date) => bars.filter((bar) => sessionDate(bar.timestamp) === date && sessionMinute(bar.timestamp) <= latestMinute).reduce((sum, bar) => sum + bar.volume, 0)).filter((value) => value > 0);
  const expectedVolume = mean(comparableVolumes);
  const regularBars = today.filter((bar) => sessionMinute(bar.timestamp) >= 570 && sessionMinute(bar.timestamp) < 960);
  const vwapBars = regularBars.length ? regularBars : today;
  const vwapDenominator = vwapBars.reduce((sum, bar) => sum + bar.volume, 0);
  const vwap = vwapDenominator ? vwapBars.reduce((sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume, 0) / vwapDenominator : price;
  const openingRange = regularBars.filter((bar) => sessionMinute(bar.timestamp) < 600);
  const macdValue = macd(closes.slice(-160));
  const intervals = bars.slice(-40).slice(1).map((bar, index) => (bar.timestamp - bars.slice(-40)[index].timestamp) / 60).filter((value) => value > 0 && value <= 60);
  return {
    id: symbol,
    symbol,
    name: String(meta.longName || meta.shortName || symbol),
    exchange: String(meta.exchangeName || meta.fullExchangeName || ''),
    sector: SECTORS[symbol] || (symbol.startsWith('XL') ? symbol : null),
    price,
    previousClose,
    change1h: percentChange(price, oneHourBar.close),
    changeDay: percentChange(price, previousClose),
    highDay,
    lowDay,
    volumeToday,
    relativeVolume: expectedVolume > 0 ? volumeToday / expectedVolume : 1,
    rsi14: rsi(closes.slice(-200)),
    macd: macdValue.line,
    macdSignal: macdValue.signal,
    macdHistogram: macdValue.histogram,
    ema9: ema(closes.slice(-160), 9),
    ema21: ema(closes.slice(-160), 21),
    vwap,
    vwapDistancePct: percentChange(price, vwap),
    intradayAtrPercent: atrPercent(highs, lows, closes),
    adx14: adx(highs.slice(-180), lows.slice(-180), closes.slice(-180)),
    openingRangeHigh: openingRange.length ? Math.max(...openingRange.map((bar) => bar.high)) : 0,
    openingRangeLow: openingRange.length ? Math.min(...openingRange.map((bar) => bar.low)) : 0,
    premarketHigh: premarketBars.length ? Math.max(...premarketBars.map((bar) => bar.high)) : 0,
    premarketLow: premarketBars.length ? Math.min(...premarketBars.map((bar) => bar.low)) : 0,
    premarketRangeHigh: priorPremarketBars.length >= 3 ? Math.max(...priorPremarketBars.map((bar) => bar.high)) : 0,
    premarketVolume,
    premarketRelativeVolume: expectedPremarketVolume > 0 ? premarketVolume / expectedPremarketVolume : null,
    premarketBarCount: premarketBars.length,
    premarketSessionDate: latestDate,
    marketState: String(meta.marketState || ''),
    currency: String(meta.currency || 'USD'),
    lastUpdated: new Date(last.timestamp * 1000).toISOString(),
    provider: 'Yahoo Chart',
    freshness: Date.now() - last.timestamp * 1000 < 20 * 60_000 ? 'live/delayed' : 'stale',
    delayed: true,
    marketMinute: sessionMinute(last.timestamp),
    barIntervalMinutes: intervals.length ? Math.max(1, Math.round(mean(intervals))) : 5,
    intradayHistoryCount: bars.length,
    recentBars: bars.slice(-160),
    providerAgreement: 0,
    providerDispersionBps: 0,
    providerQuoteCount: 1,
    liveProviderQuoteCount: 1,
    providerQuotes: [],
    crossCheckProvider: '',
    crossCheckProviders: [],
    crossCheckPrice: 0
  };
}

function dailyFeatures(result) {
  const bars = normalizeBars(result);
  if (bars.length < 20) return {};
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const volumes = bars.map((bar) => bar.volume);
  const latest = closes.at(-1);
  const macdValue = macd(closes);
  const returns = closes.slice(-21).slice(1).map((value, index) => Math.log(value / closes.slice(-21)[index])).filter(Number.isFinite);
  const returnMean = mean(returns);
  const variance = mean(returns.map((value) => (value - returnMean) ** 2));
  const previousHighs = highs.slice(-21, -1);
  const previousLows = lows.slice(-21, -1);
  return {
    dailySma20: sma(closes, 20),
    dailySma50: sma(closes, 50),
    dailySma200: sma(closes, 200),
    dailyRsi14: rsi(closes),
    dailyMacd: macdValue.line,
    dailyMacdSignal: macdValue.signal,
    dailyMacdHistogram: macdValue.histogram,
    dailyAtrPercent: atrPercent(highs, lows, closes),
    previous20High: previousHighs.length ? Math.max(...previousHighs) : latest,
    previous20Low: previousLows.length ? Math.min(...previousLows) : latest,
    averageDailyVolume: mean(volumes.slice(-21, -1).filter((value) => value > 0)) || mean(volumes.slice(-20)),
    change5d: percentChange(latest, closes.at(-6) || closes[0]),
    change20d: percentChange(latest, closes.at(-21) || closes[0]),
    realizedVol20: Math.sqrt(Math.max(0, variance)) * Math.sqrt(252) * 100,
    dailyHistoryCount: bars.length,
    dailyUpdatedAt: new Date((bars.at(-1)?.timestamp || 0) * 1000).toISOString()
  };
}

function cachedDailyFeatures(asset) {
  return Object.fromEntries(DAILY_FIELDS.filter((key) => asset?.[key] !== undefined).map((key) => [key, asset[key]]));
}

export function alpacaBarsToChartResult(payload, symbol, { currency = 'USD' } = {}) {
  const rows = payload?.bars?.[symbol];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Alpaca returned no bars for ${symbol}.`);
  const bars = [...rows].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return {
    timestamp: bars.map((bar) => Math.floor(Date.parse(bar.t) / 1000)),
    indicators: { quote: [{ open: bars.map((bar) => Number(bar.o)), high: bars.map((bar) => Number(bar.h)), low: bars.map((bar) => Number(bar.l)), close: bars.map((bar) => Number(bar.c)), volume: bars.map((bar) => Number(bar.v || 0)) }] },
    meta: { currency, exchangeName: 'US consolidated market data', marketState: 'REGULAR' }
  };
}

async function fetchAlpacaBars(symbol, timeframe, start, end, { keys, feed, metrics, fetcher, requestGate, sleepFn }) {
  if (!keys?.alpaca_key_id || !keys?.alpaca_secret_key) throw new Error('Alpaca market-data credentials are required; Yahoo Chart fallback is disabled.');
  const query = new URLSearchParams({ timeframe, start: start.toISOString(), end: end.toISOString(), limit: '10000', adjustment: timeframe === '1Day' ? 'split' : 'raw', feed, sort: 'asc' });
  const rows = [];
  let pageToken = '';
  do {
    if (pageToken) query.set('page_token', pageToken);
    const payload = await fetchJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${query}`, {
      provider: `Alpaca ${feed.toUpperCase()} ${timeframe} bars`, metrics, fetcher,
      requestGate, sleepFn,
      headers: { 'APCA-API-KEY-ID': keys.alpaca_key_id, 'APCA-API-SECRET-KEY': keys.alpaca_secret_key }
    });
    const bars = payload?.bars?.[symbol];
    if (!Array.isArray(bars)) throw new Error(`Alpaca returned an invalid ${timeframe} bars response for ${symbol}.`);
    rows.push(...bars);
    pageToken = payload.next_page_token || '';
  } while (pageToken && rows.length < 20_000);
  return alpacaBarsToChartResult({ bars: { [symbol]: rows } }, symbol);
}

export async function fetchAlpacaSymbol(symbol, cachedAsset, dailyCacheHours = 8, options = {}) {
  const { keys, feed = config.alpacaDataFeed, metrics, fetcher = fetch, now = new Date(), requestGate, sleepFn } = options;
  const end = now instanceof Date ? now : new Date(now);
  const intradayStart = new Date(end.getTime() - 7 * 24 * 60 * 60_000);
  const dailyStart = new Date(end.getTime() - 370 * 24 * 60 * 60_000);
  const dailyAge = cachedAsset?.dailyUpdatedAt ? Date.now() - new Date(cachedAsset.dailyUpdatedAt).getTime() : Infinity;
  const reuseDaily = cachedAsset?.dailyHistoryCount >= 50 && dailyAge >= 0 && dailyAge < dailyCacheHours * 60 * 60_000;
  const [intraday, daily] = await Promise.all([
    fetchAlpacaBars(symbol, '5Min', intradayStart, end, { keys, feed, metrics, fetcher, requestGate, sleepFn }),
    reuseDaily ? Promise.resolve(null) : fetchAlpacaBars(symbol, '1Day', dailyStart, end, { keys, feed, metrics, fetcher, requestGate, sleepFn })
  ]);
  const shortTerm = intradayFeatures(symbol, intraday);
  if (!shortTerm) return null;
  shortTerm.provider = `Alpaca ${feed.toUpperCase()}`;
  shortTerm.delayed = feed === 'delayed_sip';
  return { ...shortTerm, ...(daily ? dailyFeatures(daily) : cachedDailyFeatures(cachedAsset)), atrPercent: daily ? dailyFeatures(daily).dailyAtrPercent : cachedAsset?.dailyAtrPercent || shortTerm.intradayAtrPercent };
}

function screenerRows(payload, keys) {
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return Array.isArray(payload) ? payload : [];
}

function screenerSymbol(row) {
  const symbol = String(row?.symbol || row?.ticker || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,10}$/.test(symbol) ? symbol : '';
}

export function normalizeAlpacaDiscoverySymbols(movers, mostActives, { existingSymbols = [], maxSymbols = 15 } = {}) {
  const existing = new Set(existingSymbols.map((symbol) => String(symbol).toUpperCase()));
  const candidates = new Map();
  const add = (row, source, index) => {
    const symbol = screenerSymbol(row);
    if (!symbol || existing.has(symbol) || MARKET_CONTEXT.includes(symbol)) return;
    const current = candidates.get(symbol) || { symbol, sources: [], changePct: null, screenerRank: index };
    if (!current.sources.includes(source)) current.sources.push(source);
    const changePct = Number(row?.percent_change ?? row?.change_percent ?? row?.changePct);
    if (Number.isFinite(changePct)) current.changePct = changePct;
    current.screenerRank = Math.min(current.screenerRank, index);
    candidates.set(symbol, current);
  };
  screenerRows(movers, ['gainers', 'movers', 'data']).forEach((row, index) => add(row, 'mover', index));
  screenerRows(mostActives, ['most_actives', 'mostActives', 'actives', 'data']).forEach((row, index) => add(row, 'most_active', index));
  return [...candidates.values()].sort((a, b) => b.sources.length - a.sources.length
    || (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity)
    || a.screenerRank - b.screenerRank || a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(1, Math.min(30, Number(maxSymbols) || 15)));
}

export function composeMarketDiscoverySymbols(configuredSymbols = [], dynamicSymbols = [], options = {}) {
  const maxConfigured = Math.max(1, Number(options.maxConfigured) || 90);
  const maxTotal = Math.max(maxConfigured, Number(options.maxTotal) || 120);
  const configured = [...new Set(configuredSymbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))].slice(0, maxConfigured);
  const existing = new Set(configured);
  const discovered = [...new Set(dynamicSymbols.map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))]
    .filter((symbol) => !existing.has(symbol)).slice(0, maxTotal - configured.length);
  return { symbols: [...configured, ...discovered], dynamicSymbols: discovered };
}

export function normalizeAlpacaEligibleEquities(assets = [], excludedSymbols = []) {
  return classifyStockDirectory(assets, { configuredSymbols: excludedSymbols, contextSymbols: MARKET_CONTEXT }).eligible;
}

function marketDate(timestamp) {
  const time = Number.isFinite(Number(timestamp)) && String(timestamp).trim() !== '' ? Number(timestamp) : Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return '';
  return localDateKey(new Date(time), 'America/New_York');
}

export function rankAlpacaSnapshotCandidates(snapshots = {}, assets = [], { now = new Date(), existingSymbols = [], maxSymbols = 15, session = 'regular' } = {}) {
  const current = new Date(now).getTime();
  const today = marketDate(current);
  const existing = new Set([...MARKET_CONTEXT, ...existingSymbols].map((symbol) => String(symbol).toUpperCase()));
  const bySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const candidates = [];
  const rejectionCounts = {};
  const rejectionSamples = [], rejectionRecords = [];
  const reject = (symbol, code) => {
    rejectionCounts[code] = (rejectionCounts[code] || 0) + 1;
    rejectionRecords.push({ symbol, stage: 'cheap_screen', reasonCode: code });
    if (rejectionSamples.length < 100) rejectionSamples.push({ symbol, reasonCode: code });
  };
  for (const asset of assets) {
    const symbol = String(asset.symbol || '').toUpperCase();
    if (!symbol || existing.has(symbol)) continue;
    const snapshot = snapshots?.[symbol];
    if (!snapshot) { reject(symbol, 'snapshot_missing'); continue; }
    const tradeTime = Date.parse(snapshot?.latestTrade?.t || '');
    const actualNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : NaN;
    const price = actualNumber(snapshot?.latestTrade?.p);
    const previousClose = actualNumber(snapshot?.prevDailyBar?.c);
    const barTime = snapshot?.dailyBar?.t;
    const volume = actualNumber(session === 'pre_market' ? (snapshot?.prevDailyBar?.v ?? snapshot?.dailyBar?.v) : snapshot?.dailyBar?.v);
    if (!Number.isFinite(tradeTime)) { reject(symbol, 'latest_trade_missing'); continue; }
    if (current - tradeTime < 0 || current - tradeTime > 5 * 60_000) { reject(symbol, 'latest_trade_stale_or_future'); continue; }
    if (session !== 'pre_market' && marketDate(barTime) !== today) { reject(symbol, 'daily_bar_not_current_session'); continue; }
    if (!(price >= 2)) { reject(symbol, 'price_below_floor_or_missing'); continue; }
    if (!(previousClose > 0)) { reject(symbol, 'previous_close_missing'); continue; }
    if (!(volume > 0)) { reject(symbol, 'share_volume_missing'); continue; }
    const changePct = (price / previousClose - 1) * 100;
    const dollarVolume = price * volume;
    if (!(changePct > 0)) { reject(symbol, 'non_positive_gap_or_move'); continue; }
    if (dollarVolume < 250_000) { reject(symbol, 'prior_or_current_dollar_volume_below_floor'); continue; }
    candidates.push({ ...bySymbol.get(symbol), price, previousClose, changePct, volume, dollarVolume,
      discoverySource: session === 'pre_market' ? 'Alpaca fresh premarket gap snapshot' : 'Alpaca account-listed equity snapshot',
      discoveryScore: changePct * 2 + Math.log10(Math.max(1, dollarVolume)) });
  }
  candidates.sort((a, b) => b.discoveryScore - a.discoveryScore || b.dollarVolume - a.dollarVolume || a.symbol.localeCompare(b.symbol));
  const cap = Math.max(1, Math.min(30, Number(maxSymbols) || 15));
  const capOmissionRecords = candidates.slice(cap).map((row) => ({ symbol: row.symbol, stage: 'deep_analysis_cap', reasonCode: 'deep_analysis_cap',
    reason: `Passed broad-market discovery but fell outside the ${cap}-symbol deep-analysis cap.`, discoverySource: row.discoverySource,
    discoveryScore: row.discoveryScore, price: row.price, previousClose: row.previousClose, changePct: row.changePct, dollarVolume: row.dollarVolume }));
  return { rows: candidates.slice(0, cap), candidateCount: candidates.length,
    capOmissions: capOmissionRecords.length, capOmissionRecords, rejectionCounts, rejectionSamples, rejectionRecords };
}

export function mergeDynamicDiscoveryCandidates(screened = {}, wide = {}, maxSymbols = 15) {
  const cap = Math.max(1, Math.min(30, Number(maxSymbols) || 15));
  const candidates = [...(wide.rows || []), ...(screened.rows || [])]
    .filter((row, index, all) => row?.symbol && all.findIndex((item) => item.symbol === row.symbol) === index);
  const rows = candidates.slice(0, cap), selected = new Set(rows.map((row) => row.symbol));
  const omitted = [
    ...(wide.capOmissionRecords || []), ...(screened.capOmissionRecords || []),
    ...candidates.slice(cap).map((row) => ({ symbol: row.symbol, stage: 'deep_analysis_cap', reasonCode: 'deep_analysis_cap',
      reason: `Passed market discovery but fell outside the combined ${cap}-symbol deep-analysis cap.`,
      discoverySource: row.discoverySource || (row.sources?.length ? `Alpaca screeners (${row.sources.join(', ')})` : 'Alpaca discovery'),
      changePct: finite(row.changePct) }))
  ].filter((row, index, all) => row?.symbol && !selected.has(row.symbol) && all.findIndex((item) => item.symbol === row.symbol) === index);
  return { rows, symbols: rows.map((row) => row.symbol), capOmissionRecords: omitted };
}

export function mergeDirectoryVerifiedDiscovery(screened = {}, wide = {}, maxSymbols = 15) {
  const eligible = new Set(wide.eligibleSymbols || []);
  const rejected = (screened.rows || []).filter((row) => !eligible.has(row.symbol))
    .map((row) => ({ symbol: row.symbol, reasonCode: 'screener_identity_not_directory_eligible' }));
  const allowed = ['screen_complete', 'partial_provider_failure'].includes(wide.diagnostics?.status);
  const combined = allowed ? mergeDynamicDiscoveryCandidates({ ...screened,
    rows: (screened.rows || []).filter((row) => eligible.has(row.symbol)) }, wide, maxSymbols)
    : { rows: [], symbols: [], capOmissionRecords: [] };
  return { ...combined, screenerDirectoryRejected: rejected };
}

export function alpacaFeedCoverageNote(feed) {
  const normalized = String(feed || '').trim().toLowerCase();
  if (normalized === 'iex') return 'IEX is one exchange; premarket activity on other U.S. venues may be absent.';
  if (normalized === 'sip') return 'SIP consolidates U.S. exchanges; availability depends on account entitlement.';
  if (normalized === 'delayed_sip') return 'SIP is delayed 15 minutes; fresh premarket seed checks may reject delayed trades.';
  return normalized ? `Coverage follows the configured ${normalized} feed.` : 'Configured feed is unknown.';
}

export async function fetchAlpacaWideDiscoverySymbols(options = {}) {
  const { keys, maxSymbols = 15, cacheMinutes = 15, cacheKey = 'default', existingSymbols = [], excludedSymbols = [], exclusionRevision = '', feed = 'iex', session = 'regular' } = options;
  if (!keys?.alpaca_key_id || !keys?.alpaca_secret_key) return { symbols: [], rows: [], eligibleUniverseSize: null, candidateCount: null, feed, feedUsed: false, diagnostics: { version: STOCK_DISCOVERY_VERSION, status: 'credentials_missing', providerInstruments: null, attempted: 0 }, error: 'Alpaca credentials are not configured.', cached: false };
  const normalizedExisting = [...new Set(existingSymbols.map((symbol) => String(symbol).toUpperCase()))].sort();
  const key = `${cacheKey}:${keys.alpaca_key_id}:${marketDate(options.now ?? Date.now())}:${session}:${feed}:${maxSymbols}:${normalizedExisting.join(',')}:${exclusionRevision}:${[...excludedSymbols].sort().join(',')}`;
  const universeKey = `${cacheKey}:${keys.alpaca_key_id}`;
  const cached = wideDiscoveryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < Math.max(5, Number(cacheMinutes) || 15) * 60_000) {
    const rows = cached.result.rows.filter((row) => !existingSymbols.some((symbol) => String(symbol).toUpperCase() === row.symbol)).slice(0, maxSymbols);
    const selected = new Set(rows.map((row) => row.symbol));
    const capOmissionRecords = (cached.result.capOmissionRecords || []).filter((row) => !selected.has(row.symbol)
      && !existingSymbols.some((symbol) => String(symbol).toUpperCase() === row.symbol));
    return { ...cached.result, rows, symbols: rows.map((row) => row.symbol), capOmissionRecords,
      capOmissions: capOmissionRecords.length, cached: true, cacheAgeMs: Date.now() - cached.fetchedAt };
  }
  const pending = wideDiscoveryInFlight.get(key);
  if (pending) return { ...await pending, cached: true };
  const request = fetchAlpacaWideDiscoverySymbolsUncached({ ...options, keys, maxSymbols, cacheMinutes, cacheKey, existingSymbols, excludedSymbols, feed, session }, key, universeKey);
  wideDiscoveryInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (wideDiscoveryInFlight.get(key) === request) wideDiscoveryInFlight.delete(key);
  }
}

async function fetchAlpacaWideDiscoverySymbolsUncached({ keys, metrics, maxSymbols, existingSymbols, excludedSymbols = [], feed, now,
  session, fetcher = fetch, clock = Date.now, sleepFn = sleep, archiveDirectory, budgetMs = 45000 }, key, universeKey) {
  const started = clock(), initial = new Date(now ?? started).getTime(), observedAt = () => initial + Math.max(0, clock() - started);
  const headers = { 'APCA-API-KEY-ID': keys.alpaca_key_id, 'APCA-API-SECRET-KEY': keys.alpaca_secret_key };
  const d = { version: STOCK_DISCOVERY_VERSION, status: 'not_started', providerInstruments: null, attempted: 0, returned: 0,
    usableScreens: 0, providerFailures: 0, deferred: 0, providerRequests: 0, stageDurationsMs: {} };
  const result = { symbols: [], rows: [], eligibleSymbols: [], eligibleUniverseSize: null, candidateCount: null,
    capOmissions: 0, capOmissionRecords: [], rejectionCounts: {}, rejectionSamples: [], feed, feedUsed: false,
    diagnostics: d, error: '', cached: false };
  let directory = null, assets = null;
  const snapshots = {}, failures = new Map(), remaining = new Map();
  const failure = (code) => Object.assign(new Error(code), { code });
  const boundedFetch = async (url, options) => {
    const parsed = new URL(url), host = parsed.host;
    if (clock() - started >= budgetMs) throw failure('discovery_time_budget');
    if (remaining.get(host) <= 5) throw failure('discovery_quota_headroom');
    d.providerRequests++;
    if (parsed.pathname.endsWith('/snapshots')) { result.feedUsed = true; d.attempted += parsed.searchParams.get('symbols').split(',').length; }
    const response = await fetcher(url, { ...options, signal: AbortSignal.any([options.signal,
      AbortSignal.timeout(Math.max(1, Math.min(20000, Math.floor(budgetMs - (clock() - started)))) )]) });
    const quota = response.headers?.get?.('X-RateLimit-Remaining');
    if (quota != null && String(quota).trim() && Number.isFinite(Number(quota))) remaining.set(host, Number(quota));
    if ([401, 403, 429].includes(response.status)) remaining.set(host, 0);
    return response;
  };
  const discoveryGate = credential => waitForAlpacaRequest(credential, { maxWaitMs: Math.max(0, Math.min(2000, budgetMs - (clock() - started))) });
  discoveryGate.defer = (...args) => waitForAlpacaRequest.defer(...args);
  discoveryGate.observe = (...args) => waitForAlpacaRequest.observe(...args);
  const request = (url, provider) => fetchJson(url, { provider, headers, metrics, fetcher: boundedFetch, maxAttempts: 1, requestGate: discoveryGate });
  try {
    if (!['iex', 'sip', 'delayed_sip'].includes(feed) || !Number.isFinite(initial)
      || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 120000) throw failure('invalid_discovery_configuration');
    const cached = activeEquityUniverseCache.get(universeKey), stage = clock();
    if (cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < 6 * 60 * 60_000) {
      assets = cached.rows; d.directoryCacheAgeMs = Date.now() - cached.fetchedAt; d.membershipChanges = cached.changes;
    } else {
      // Omitted status returns every status; this endpoint documents an unpaginated array.
      assets = await request('https://paper-api.alpaca.markets/v2/assets?asset_class=us_equity', 'Alpaca equity directory');
      if (!Array.isArray(assets)) throw failure('invalid_directory_payload');
      d.membershipChanges = stockDirectoryChanges(cached?.rows, assets);
      activeEquityUniverseCache.set(universeKey, { fetchedAt: Date.now(), rows: assets, changes: d.membershipChanges });
      d.directoryCacheAgeMs = 0;
    }
    directory = classifyStockDirectory(assets, { configuredSymbols: existingSymbols, excludedSymbols, contextSymbols: MARKET_CONTEXT });
    Object.assign(d, directory.diagnostics);
    const eligible = directory.eligible;
    result.eligibleSymbols = eligible.map((row) => row.symbol);
    result.eligibleUniverseSize = eligible.length;
    result.etfOwnershipExcludedSymbols = directory.rows.filter((row) => row.reasonCode === 'etf_etp_primary_owner').map((row) => row.symbol);
    result.etfOwnershipExcludedCount = result.etfOwnershipExcludedSymbols.length;
    d.stageDurationsMs.directory = Math.max(0, clock() - stage);
    const scanStart = clock(); let lastStart = -Infinity, stop = null;
    for (let index = 0; index < eligible.length; index += 400) {
      const chunk = eligible.slice(index, index + 400), symbols = chunk.map((row) => row.symbol);
      if (clock() - started >= budgetMs) stop = 'discovery_time_budget';
      if (remaining.get('data.alpaca.markets') <= 5) stop ||= 'discovery_quota_headroom';
      if (stop) { for (const row of chunk) failures.set(row.symbol, stop); d.deferred += chunk.length; continue; }
      const attemptedBefore = d.attempted;
      try {
        const delay = Math.max(0, 350 - (clock() - lastStart));
        if (delay) await sleepFn(delay);
        lastStart = clock();
        const payload = await request(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=${encodeURIComponent(feed)}`, 'Alpaca broad-market snapshots');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((symbol) => !symbols.includes(symbol))) throw failure('invalid_or_unrequested_snapshot_payload');
        Object.assign(snapshots, payload);
      } catch (error) {
        if (d.attempted === attemptedBefore) d.deferred += chunk.length;
        d.providerFailures++; const reason = error.code || (error.status ? `snapshot_http_${error.status}` : 'snapshot_request_failed');
        for (const row of chunk) failures.set(row.symbol, reason);
        if ([401, 403, 429].includes(error.status) || ['discovery_time_budget', 'discovery_quota_headroom', 'ALPACA_PACING_DEFERRED'].includes(error.code)) stop = reason;
      }
    }
    d.stageDurationsMs.snapshots = Math.max(0, clock() - scanStart);
    const rankStart = clock();
    const ranked = rankAlpacaSnapshotCandidates(snapshots, eligible, { now: new Date(observedAt()), existingSymbols, maxSymbols, session });
    const rejected = ranked.rejectionRecords.map((row) => failures.has(row.symbol) ? { ...row, reasonCode: failures.get(row.symbol) } : row);
    const rejectionCounts = {};
    for (const row of rejected) rejectionCounts[row.reasonCode] = (rejectionCounts[row.reasonCode] || 0) + 1;
    Object.assign(result, ranked, { rejectionRecords: rejected, rejectionCounts, rejectionSamples: rejected.slice(0, 100),
      symbols: ranked.rows.map((row) => row.symbol), snapshotSymbolsReturned: Object.keys(snapshots).length });
    d.returned = result.snapshotSymbolsReturned; d.usableScreens = ranked.candidateCount;
    // Account/feed denial or an exhausted quota must not turn a partial scan into a normal shortlist.
    if (stop) { result.rows = []; result.symbols = []; }
    d.shortlisted = result.symbols.length; d.stageDurationsMs.ranking = Math.max(0, clock() - rankStart);
    d.status = stop ? 'scan_deferred' : d.providerFailures ? 'partial_provider_failure' : 'screen_complete';
    if (stop || d.providerFailures) result.error = stop || 'One or more snapshot batches failed; inspect diagnostics.';
    d.observedAt = new Date(observedAt()).toISOString(); d.elapsedMs = Math.max(0, clock() - started);
    if (archiveDirectory) result.archive = await archiveDiscovery({ owner: 'stocks', version: STOCK_DISCOVERY_VERSION,
      feed, session, diagnostics: d, directory: directory.rows, snapshots, selections: result.rows,
      rejections: [...rejected, ...ranked.capOmissionRecords] }, { directory: archiveDirectory, now: observedAt() });
    if (d.status === 'screen_complete') wideDiscoveryCache.set(key, { fetchedAt: Date.now(), result });
  } catch (error) {
    d.status = 'provider_or_configuration_failure'; d.providerFailures++;
    result.error = error.code || 'Equity discovery failed; coverage is unavailable.';
  }
  d.elapsedMs = Math.max(0, clock() - started);
  return result;
}

export async function fetchAlpacaDiscoverySymbols({ keys, metrics, maxSymbols = 15, cacheMinutes = 15, cacheKey = 'default', existingSymbols = [], fetcher = fetch } = {}) {
  if (!keys?.alpaca_key_id || !keys?.alpaca_secret_key) return { symbols: [], error: 'Alpaca credentials are not configured.', cached: false };
  const cached = dynamicDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < Math.max(5, Number(cacheMinutes) || 15) * 60_000) {
    const rows = cached.result.rows.filter((row) => !existingSymbols.some((symbol) => String(symbol).toUpperCase() === row.symbol)).slice(0, maxSymbols);
    const selected = new Set(rows.map((row) => row.symbol));
    const capOmissionRecords = (cached.result.capOmissionRecords || []).filter((row) => !selected.has(row.symbol)
      && !existingSymbols.some((symbol) => String(symbol).toUpperCase() === row.symbol));
    return { ...cached.result, rows, symbols: rows.map((row) => row.symbol), capOmissionRecords,
      capOmissions: capOmissionRecords.length, cached: true };
  }
  const headers = { 'APCA-API-KEY-ID': keys.alpaca_key_id, 'APCA-API-SECRET-KEY': keys.alpaca_secret_key };
  const [moversResult, activeResult] = await Promise.allSettled([
    fetchJson('https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50', { provider: 'Alpaca stock movers', headers, metrics, fetcher }),
    fetchJson('https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=100', { provider: 'Alpaca most-active stocks', headers, metrics, fetcher })
  ]);
  const movers = moversResult.status === 'fulfilled' ? moversResult.value : null;
  const mostActives = activeResult.status === 'fulfilled' ? activeResult.value : null;
  const available = normalizeAlpacaDiscoverySymbols(movers, mostActives, { maxSymbols: 30, existingSymbols });
  const selected = available.slice(0, maxSymbols);
  const capOmissionRecords = available.slice(maxSymbols).map((row) => ({ symbol: row.symbol, stage: 'deep_analysis_cap', reasonCode: 'deep_analysis_cap',
    reason: `Passed Alpaca screener discovery but fell outside the ${maxSymbols}-symbol deep-analysis cap.`,
    discoverySource: `Alpaca screeners (${row.sources.join(', ')})`, changePct: row.changePct }));
  const errors = [moversResult, activeResult].flatMap((result, index) => result.status === 'rejected'
    ? [`${index === 0 ? 'movers' : 'most-actives'}: ${String(result.reason?.message || result.reason).slice(0, 140)}`] : []);
  const result = { symbols: selected.map((row) => row.symbol), rows: selected, candidateCount: available.length,
    capOmissions: capOmissionRecords.length, capOmissionRecords, error: errors.length ? errors.join(' | ') : '' };
  dynamicDiscoveryCache.set(cacheKey, { fetchedAt: Date.now(), result });
  return { ...result, cached: false };
}

async function mapLimited(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor; cursor += 1;
      try { results[index] = await mapper(values[index]); } catch (error) { results[index] = { error }; }
    }
  }));
  return results;
}

function quoteTimestamp(value, divisor = 1) {
  const timestamp = finite(value) / divisor;
  return timestamp > 0 ? new Date(timestamp).toISOString() : '';
}

async function fetchProviderQuotes(symbol, keys, metrics) {
  const streamed = getAlpacaStreamSnapshot(symbol);
  const preloaded = streamed?.price > 0 ? [streamed] : [];
  const jobs = [];
  if (!streamed && keys.alpaca_key_id && keys.alpaca_secret_key) jobs.push((async () => {
    const data = await fetchJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${encodeURIComponent(config.alpacaDataFeed)}`, {
      provider: 'Alpaca snapshot', metrics,
      headers: {
        'APCA-API-KEY-ID': keys.alpaca_key_id,
        'APCA-API-SECRET-KEY': keys.alpaca_secret_key
      }
    });
    const trade = data?.latestTrade || {};
    const quote = data?.latestQuote || {};
    let stockQuoteEvidence = null, stockQuoteRejection = null;
    try { stockQuoteEvidence = parseAlpacaStockQuote(quote, { symbol, feed: config.alpacaDataFeed,
      source: 'snapshot', maxQuoteAgeMs: 60000 }).stockQuoteEvidence; }
    catch (error) { stockQuoteRejection = error.code || 'stock_quote_evidence_required'; }
    const bid = finite(quote.bp); const ask = finite(quote.ap);
    const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const bidSize = finite(quote.bs); const askSize = finite(quote.as);
    return {
      provider: `Alpaca ${config.alpacaDataFeed.toUpperCase()} snapshot`,
      stockQuoteEvidence,
      stockQuoteRejection,
      price: finite(trade.p, midpoint),
      timestamp: String(trade.t || quote.t || ''),
      classification: 'intraday',
      streaming: false,
      bid,
      ask,
      bidSize,
      askSize,
      spreadBps: midpoint ? (ask - bid) / midpoint * 10_000 : 0,
      quoteImbalance: bidSize + askSize ? (bidSize - askSize) / (bidSize + askSize) : 0,
      quoteTimestamp: String(quote.t || '')
    };
  })());
  if (keys.polygon) jobs.push((async () => {
    const data = await fetchPolygonJson(`/v2/last/trade/${encodeURIComponent(symbol)}`, {}, keys.polygon, { provider: 'Polygon', metrics });
    const rawTimestamp = finite(data?.results?.t);
    return { provider: 'Polygon', price: finite(data?.results?.p), timestamp: quoteTimestamp(rawTimestamp > 1e15 ? rawTimestamp / 1e6 : rawTimestamp), classification: 'intraday' };
  })());
  if (keys.finnhub) jobs.push((async () => {
    const data = await fetchFinnhubJson('/quote', { symbol }, keys.finnhub, { provider: 'Finnhub', metrics });
    return { provider: 'Finnhub', price: finite(data?.c), timestamp: quoteTimestamp(finite(data?.t) * 1000), classification: 'intraday' };
  })());
  if (keys.alpha_vantage) jobs.push((async () => {
    const data = await fetchJson(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(keys.alpha_vantage)}`, { provider: 'Alpha Vantage', metrics });
    const quote = data?.['Global Quote'] || {};
    return { provider: 'Alpha Vantage', price: finite(quote['05. price']), timestamp: String(quote['07. latest trading day'] || ''), classification: 'end-of-day reference' };
  })());
  const settled = await Promise.allSettled(jobs);
  return {
    quotes: [...preloaded, ...settled.filter((result) => result.status === 'fulfilled' && result.value.price > 0).map((result) => result.value)],
    errors: settled.filter((result) => result.status === 'rejected').map((result) => String(result.reason?.message || result.reason).slice(0, 180))
  };
}

export function attachProviderConsensus(asset, result, now = Date.now()) {
  const primary = { provider: asset.provider, price: asset.price, timestamp: asset.lastUpdated, classification: 'intraday primary' };
  const providerQuotes = [primary, ...(result?.quotes || [])];
  const fresh = (timestamp, maxAgeMs) => {
    const age = now - Date.parse(timestamp);
    return Number.isFinite(age) && age >= -5_000 && age <= maxAgeMs;
  };
  const active = providerQuotes.filter((quote) => quote.classification !== 'end-of-day reference'
    && quote.price > 0 && fresh(quote.timestamp, 20 * 60_000));
  const deviations = active.slice(1).map((quote) => Math.abs(quote.price / asset.price - 1) * 10_000);
  const dispersionBps = deviations.length ? Math.max(...deviations) : 0;
  const agreement = active.length > 1 ? clamp(100 - dispersionBps / 2, 0, 100) : 0;
  const crossChecks = providerQuotes.slice(1).map((quote) => quote.provider);
  const newestQuote = [...active].sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime())[0];
  const microstructure = [...active]
    .filter((quote) => finite(quote.bid) > 0 && finite(quote.ask) >= finite(quote.bid)
      && fresh(quote.quoteTimestamp || quote.timestamp, 60_000))
    .sort((left, right) => new Date(right.quoteTimestamp || right.timestamp || 0).getTime() - new Date(left.quoteTimestamp || left.timestamp || 0).getTime())[0];
  return {
    ...asset,
    providerQuotes,
    providerQuoteCount: providerQuotes.length,
    liveProviderQuoteCount: active.length,
    referenceProviderCount: providerQuotes.length - active.length,
    providerAgreement: agreement,
    providerDispersionBps: dispersionBps,
    crossCheckProvider: crossChecks.join(' + '),
    crossCheckProviders: crossChecks,
    crossCheckPrice: providerQuotes[1]?.price || 0,
    livePrice: finite(newestQuote?.price, asset.price),
    livePriceProvider: newestQuote?.provider || asset.provider,
    livePriceUpdatedAt: newestQuote?.timestamp || asset.lastUpdated,
    bidPrice: finite(microstructure?.bid),
    askPrice: finite(microstructure?.ask),
    bidSize: finite(microstructure?.bidSize),
    askSize: finite(microstructure?.askSize),
    spreadBps: Math.max(0, finite(microstructure?.spreadBps)),
    quoteImbalance: clamp(finite(microstructure?.quoteImbalance), -1, 1),
    spreadMean1m: finite(microstructure?.spreadMean1m, microstructure?.spreadBps),
    spreadMean5m: finite(microstructure?.spreadMean5m, microstructure?.spreadBps),
    spreadMean15m: finite(microstructure?.spreadMean15m, microstructure?.spreadBps),
    spreadPercentile15m: finite(microstructure?.spreadPercentile15m, 0.5),
    spreadAcceleration: finite(microstructure?.spreadAcceleration),
    quoteImbalance1m: clamp(finite(microstructure?.quoteImbalance1m, microstructure?.quoteImbalance), -1, 1),
    quoteImbalance5m: clamp(finite(microstructure?.quoteImbalance5m, microstructure?.quoteImbalance), -1, 1),
    quoteImbalance15m: clamp(finite(microstructure?.quoteImbalance15m, microstructure?.quoteImbalance), -1, 1),
    tradeFlow1m: clamp(finite(microstructure?.tradeFlow1m), -1, 1),
    tradeFlow5m: clamp(finite(microstructure?.tradeFlow5m), -1, 1),
    tradeFlow15m: clamp(finite(microstructure?.tradeFlow15m), -1, 1),
    quoteAgeSeconds: microstructure ? Math.max(0, (now - Date.parse(microstructure.quoteTimestamp || microstructure.timestamp)) / 1000) : null,
    tradeAgeSeconds: microstructure?.tradeAgeSeconds ?? null,
    luldUpper: finite(microstructure?.luldUpper),
    luldLower: finite(microstructure?.luldLower),
    luldDistanceBps: finite(microstructure?.luldDistanceBps, 10000),
    luldIndicator: microstructure?.luldIndicator || '',
    halted: Boolean(microstructure?.halted),
    tradingStatus: microstructure?.tradingStatus || null,
    microstructureProvider: microstructure?.provider || '',
    stockQuoteEvidence: microstructure?.stockQuoteEvidence || null,
    stockQuoteRejection: microstructure?.stockQuoteRejection || null,
    streamingQuote: Boolean(microstructure?.streaming),
    quoteUpdatedAt: microstructure?.quoteTimestamp || microstructure?.timestamp || '',
    providerErrors: result?.errors || []
  };
}

async function fetchEarningsRisk(symbol, finnhubKey, blackoutDays = 2, metrics) {
  if (!finnhubKey || blackoutDays <= 0) return {};
  const from = new Date();
  const to = new Date(Date.now() + Math.max(7, blackoutDays + 3) * 24 * 60 * 60_000);
  const date = (value) => value.toISOString().slice(0, 10);
  const data = await fetchFinnhubJson('/calendar/earnings', { from: date(from), to: date(to), symbol }, finnhubKey,
    { provider: 'Finnhub earnings calendar', metrics });
  const event = (data?.earningsCalendar || []).filter((row) => row.symbol === symbol).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  if (!event?.date) return { earningsChecked: true, nextEarningsDate: '', daysToEarnings: null };
  const daysToEarnings = Math.round((new Date(`${event.date}T12:00:00Z`).getTime() - Date.now()) / (24 * 60 * 60_000));
  return { earningsChecked: true, nextEarningsDate: event.date, earningsHour: event.hour || '', daysToEarnings };
}

export function attachMarketContext(assets) {
  const bySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const spy = bySymbol.get('SPY'); const qqq = bySymbol.get('QQQ');
  const benchmarks = [spy, qqq, bySymbol.get('IWM'), bySymbol.get('DIA')].filter(Boolean);
  const marketMove = mean(benchmarks.map((asset) => asset.changeDay));
  const marketFiveDayMove = mean(benchmarks.map((asset) => asset.change5d));
  const instruments = assets.filter((asset) => !MARKET_CONTEXT.includes(asset.symbol));
  const breadthAboveTrend = instruments.length ? instruments.filter((asset) => asset.price > (asset.dailySma20 || asset.ema21)).length / instruments.length * 100 : 50;
  const breadthAdvancing = instruments.length ? instruments.filter((asset) => asset.changeDay > 0).length / instruments.length * 100 : 50;
  const benchmarkTrend = mean(benchmarks.map((asset) => asset.price > (asset.dailySma20 || asset.price) ? 1 : 0));
  const marketRegime = marketMove > 0.35 && benchmarkTrend >= 0.75 && breadthAboveTrend >= 55 ? 'risk-on trend'
    : marketMove < -0.55 && benchmarkTrend <= 0.25 && breadthAboveTrend < 42 ? 'risk-off trend'
      : Math.abs(marketMove) < 0.2 ? 'sideways' : 'mixed';
  return assets.map((asset) => {
    const sectorAsset = bySymbol.get(asset.sector);
    return {
      ...asset,
      marketMove,
      marketFiveDayMove,
      marketRegime,
      marketBreadth: breadthAboveTrend,
      advancingBreadth: breadthAdvancing,
      sectorContextStatus: sectorAsset ? 'available' : 'unavailable',
      // An unavailable sector proxy is unknown, not a duplicate broad-market factor.
      // scoreAsset treats missing sector values neutrally while retaining marketMove separately.
      sectorChange: sectorAsset?.changeDay ?? null,
      sectorFiveDayChange: sectorAsset?.change5d ?? null,
      relativeStrengthDay: asset.changeDay - finite(spy?.changeDay, marketMove),
      relativeStrength5d: asset.change5d - finite(spy?.change5d, marketFiveDayMove),
      sectorRelativeStrength: sectorAsset ? asset.changeDay - sectorAsset.changeDay : null
    };
  });
}

function calculateDataQuality(asset) {
  let quality = asset.freshness === 'stale' ? 5 : 35;
  quality += clamp((asset.intradayHistoryCount || 0) / 80 * 20, 0, 20);
  quality += clamp((asset.dailyHistoryCount || 0) / 200 * 25, 0, 25);
  quality += finite(asset.liveProviderQuoteCount, asset.providerQuoteCount) > 1 ? clamp(asset.providerAgreement / 100 * 20, 0, 20) : 10;
  quality -= Math.min(15, (asset.providerErrors?.length || 0) * 5);
  return clamp(quality, 0, 100);
}

export function buildAssetFromBars(symbol, intradayBars, dailyBars, context = {}) {
  const result = (bars, meta = {}) => ({
    meta,
    timestamp: bars.map((bar) => bar.timestamp),
    indicators: { quote: [{
      open: bars.map((bar) => bar.open), high: bars.map((bar) => bar.high),
      low: bars.map((bar) => bar.low), close: bars.map((bar) => bar.close), volume: bars.map((bar) => bar.volume)
    }] }
  });
  const intraday = intradayFeatures(symbol, result(intradayBars, { shortName: symbol, exchangeName: 'BACKTEST', marketState: 'REGULAR', currency: 'USD' }));
  if (!intraday) return null;
  const daily = dailyFeatures(result(dailyBars));
  const asset = { ...intraday, ...daily, ...context, atrPercent: daily.dailyAtrPercent || intraday.intradayAtrPercent, delayed: false, freshness: 'historical', provider: 'Historical bars', providerQuoteCount: 1 };
  asset.dataQuality = calculateDataQuality(asset);
  asset.model = scoreAsset(asset);
  return asset;
}

function summarizeStockOwnership(assets, currentOwnership, error = '') {
  if (!currentOwnership) return { status: 'unavailable', excludedSymbols: [], ownedSymbols: [], blockedSymbols: [],
    error: error || 'ETF/ETP classification is unavailable.' };
  const candidates = new Set(assets.map((asset) => asset.symbol).filter((symbol) => !MARKET_CONTEXT.includes(symbol)));
  const { etfDirectory, ownership } = currentOwnership;
  const ownedSymbols = ownership.ownedSymbols.filter((symbol) => candidates.has(symbol));
  const blockedSymbols = ownership.blockedSymbols.filter((symbol) => candidates.has(symbol));
  return { status: 'available', directoryStatus: etfDirectory.status, revision: ownership.revision,
    ownedSymbols, blockedSymbols, excludedSymbols: [...new Set([...ownedSymbols, ...blockedSymbols])], error: '' };
}

export async function fetchMarketUniverse(guildId, options = {}) {
  const settings = options.settings || await getGuildSettings(guildId);
  const cacheKey = options.cacheKey || guildId;
  const cached = await readMarketSnapshot(cacheKey);
  const maxAgeMs = Math.max(2, Number(options.maxAgeMinutes ?? settings.discoveryMinutes) || 15) * 60_000;
  const requestedDiscoveryMode = options.dynamicDiscoveryMode === 'pre_market' ? 'pre_market' : 'regular';
  const cacheAgeMs = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  let currentOwnership = null;
  let ownershipError = '';
  try {
    const directoryCache = await readJson(paths.etfDirectoryCache(), null);
    const etfDirectory = await getListedEtfUniverse({ cachePath: paths.etfDirectoryCache(), cached: directoryCache,
      fetcher: options.fetcher || fetch, metrics: options.metrics || [], now: options.now || new Date() });
    const ownership = await getStockDiscoveryOwnership({ directory: etfDirectory, classificationPath: options.classificationPath,
      now: options.now || new Date() });
    currentOwnership = { etfDirectory, ownership };
  } catch (error) {
    ownershipError = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  }
  if (!options.force && cached?.assets?.length && cacheAgeMs >= 0 && cacheAgeMs < maxAgeMs
    && Boolean(options.dynamicDiscovery) === Boolean(cached.dynamicDiscovery?.enabled)
    && (!options.dynamicDiscovery || (cached.dynamicDiscovery?.version === STOCK_DISCOVERY_VERSION && (cached.dynamicDiscovery?.mode || 'regular') === requestedDiscoveryMode
      && currentOwnership?.ownership.revision === cached.dynamicDiscovery?.etfDirectory?.ownershipRevision))) {
    const refreshed = cached.assets.map((asset) => {
      const streamed = getAlpacaStreamSnapshot(asset.symbol);
      const aged = refreshAssetFreshness(asset);
      return attachProviderConsensus(aged, { quotes: streamed?.price > 0 ? [streamed] : (asset.providerQuotes || []).slice(1), errors: asset.providerErrors || [] });
    });
    const assets = attachMarketContext(refreshed).map((asset) => ({ ...asset, dataQuality: calculateDataQuality(asset) }));
    return { ...cached, assets, ownership: summarizeStockOwnership(assets, currentOwnership, ownershipError),
      requestedSymbols: cached.requestedSymbols || assets.map((asset) => asset.symbol), failedSymbols: [], source: `${cached.source} cache${assets.some((asset) => asset.streamingQuote) ? ' + Alpaca stream' : ''}`, cacheHit: true, cacheAgeMs, providerMetrics: summarizeProviderMetrics(options.metrics) };
  }
  try {
    const context = [...new Set([...MARKET_CONTEXT, ...settings.watchlist.map((symbol) => SECTORS[symbol]).filter(Boolean)])];
    const configuredSymbols = [...new Set([...context, ...settings.watchlist])];
    let dynamicDiscovery = { symbols: [], rows: [], error: '', cached: false, enabled: false, eligibleUniverseSize: null, wideCandidates: null,
      feed: config.alpacaDataFeed, feedUsed: false };
    if (options.dynamicDiscovery) {
      const keys = providerKeys(settings);
      const maxSymbols = options.maxDynamicSymbols ?? config.dynamicDiscoveryMaxSymbols;
      const cacheMinutes = options.dynamicCacheMinutes ?? config.dynamicDiscoveryCacheMinutes;
      const session = requestedDiscoveryMode;
      if (!keys?.alpaca_key_id || !keys?.alpaca_secret_key) {
        dynamicDiscovery = { ...dynamicDiscovery, enabled: true, error: 'Alpaca credentials are not configured; dynamic discovery was not requested.' };
      } else {
      try {
        if (!currentOwnership) throw new Error(ownershipError || 'ETF/ETP ownership classification unavailable.');
        const { etfDirectory, ownership } = currentOwnership;
        const wideRequest = fetchAlpacaWideDiscoverySymbols({ keys, metrics: options.metrics, maxSymbols, cacheMinutes, cacheKey,
          existingSymbols: configuredSymbols, excludedSymbols: ownership.excludedSymbols, exclusionRevision: ownership.revision,
          archiveDirectory: join(dataDir, 'research', 'discovery'),
          feed: config.alpacaDataFeed, now: options.now || new Date(), session, fetcher: options.fetcher || fetch });
        const discoveryExclusions = [...new Set([...configuredSymbols, ...ownership.excludedSymbols])];
        const screenedRequest = session === 'regular'
          ? fetchAlpacaDiscoverySymbols({ keys, metrics: options.metrics, maxSymbols, cacheMinutes, cacheKey,
            existingSymbols: discoveryExclusions, fetcher: options.fetcher || fetch })
          : Promise.resolve({ symbols: [], rows: [], candidateCount: 0, error: '', cached: false });
        const [screened, wide] = await Promise.all([screenedRequest, wideRequest]);
        // A screener cannot bypass the account directory or resume deep work after a discovery quota/auth stop.
        const combined = mergeDirectoryVerifiedDiscovery(screened, wide, maxSymbols);
        dynamicDiscovery = { ...screened, ...wide, ...combined,
          candidateCount: (screened.candidateCount || 0) + (wide.candidateCount || 0),
          screenerCandidates: screened.candidateCount ?? null, wideCandidates: wide.candidateCount ?? null,
          eligibleUniverseSize: wide.eligibleUniverseSize ?? null,
          etfDirectory: { status: etfDirectory.status, directorySymbols: etfDirectory.symbols.length,
            ownershipRevision: ownership.revision,
            reviewedSupplementalSymbols: ownership.reviewedSupplementalCount, blockedUnreviewedSymbols: ownership.blockedSymbols.length,
            excludedFromDiscovery: wide.etfOwnershipExcludedCount ?? null,
            excludedSymbols: (wide.etfOwnershipExcludedSymbols || []).slice(0, 500),
            blockedExcludedCount: (wide.etfOwnershipExcludedSymbols || []).filter((symbol) => ownership.blockedSymbols.includes(symbol)).length,
            blockedExcludedSymbols: (wide.etfOwnershipExcludedSymbols || []).filter((symbol) => ownership.blockedSymbols.includes(symbol)).slice(0, 500),
            cacheAgeMs: etfDirectory.cacheAgeMs, refreshError: etfDirectory.refreshError },
          feed: wide.feed || config.alpacaDataFeed,
          feedUsed: Boolean(wide.feedUsed),
          error: [screened.error, wide.error].filter(Boolean).join(' | '), enabled: true };
      } catch (error) {
        dynamicDiscovery = { ...dynamicDiscovery, enabled: true, etfDirectory: { status: 'unavailable', symbols: null, excludedFromDiscovery: null,
          cacheAgeMs: null, refreshError: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180) },
          error: 'Dynamic broad discovery withheld because ETF/ETP ownership classification is unavailable.' };
      }
      }
    }
    const { symbols, dynamicSymbols } = composeMarketDiscoverySymbols(configuredSymbols, dynamicDiscovery.symbols);
    const previousBySymbol = new Map((cached?.assets || []).map((asset) => [asset.symbol, asset]));
    const marketKeys = providerKeys(settings);
    const fetched = await mapLimited(symbols, 6, (symbol) => fetchAlpacaSymbol(symbol, previousBySymbol.get(symbol), settings.dailyCacheHours || 8,
      { keys: marketKeys, feed: config.alpacaDataFeed, metrics: options.metrics, fetcher: options.fetcher || fetch, now: options.now || new Date() }));
    const dynamicSet = new Set(dynamicSymbols);
    const discoverySourceBySymbol = new Map(dynamicDiscovery.rows.map((row) => [row.symbol, row.discoverySource
      || (row.sources?.length ? `Alpaca screeners (${row.sources.join(', ')})` : 'Alpaca discovery')]));
    let assets = attachMarketContext(fetched.filter((row) => row && !row.error).map((asset) => dynamicSet.has(asset.symbol)
      ? { ...asset, discoveryVersion: STOCK_DISCOVERY_VERSION, discoverySource: discoverySourceBySymbol.get(asset.symbol) || 'Alpaca broad discovery' } : asset));
    if (!assets.length) throw new Error('No usable stock chart data was returned.');
    // Streaming snapshots are local cache reads and can enrich every subscribed
    // instrument without spending REST rate limit. Paid REST cross-checks remain
    // limited to the strongest/priority names below.
    assets = assets.map((asset) => {
      const streamed = getAlpacaStreamSnapshot(asset.symbol);
      return streamed?.price > 0 ? attachProviderConsensus(asset, { quotes: [streamed], errors: [] }) : asset;
    });
    if (options.crossCheck !== false) {
      const keys = providerKeys(settings);
      const ranked = assets.map((asset) => ({ ...asset, dataQuality: calculateDataQuality(asset), model: scoreAsset(asset) })).sort((a, b) => b.model.score - a.model.score);
      const priority = new Set([...(options.prioritySymbols || []), ...dynamicSymbols].map((symbol) => String(symbol).toUpperCase()));
      const preliminary = [...ranked.filter((asset) => priority.has(asset.symbol)), ...ranked]
        .filter((asset, index, rows) => rows.findIndex((row) => row.symbol === asset.symbol) === index)
        .slice(0, Math.min(16, Math.max(5, settings.maxSignals * 2, priority.size)));
      await mapLimited(preliminary, 3, async (candidate) => {
        const providerResult = await fetchProviderQuotes(candidate.symbol, keys, options.metrics);
        const rowIndex = assets.findIndex((asset) => asset.symbol === candidate.symbol);
        let row = attachProviderConsensus(assets[rowIndex], providerResult);
        if (keys.finnhub) {
          try { row = { ...row, ...await fetchEarningsRisk(candidate.symbol, keys.finnhub, settings.earningsBlackoutDays, options.metrics) }; }
          catch (error) { row.providerErrors = [...(row.providerErrors || []), `Earnings check: ${String(error.message || error).slice(0, 140)}`]; }
        }
        assets[rowIndex] = row;
      });
      try {
        const intelligence = await enrichAssetsWithIntelligence(preliminary.map((candidate) => assets.find((asset) => asset.symbol === candidate.symbol) || candidate), keys, settings, new Date(), options.metrics);
        if (intelligence.macro) assets = assets.map((asset) => ({ ...asset, ...intelligence.macro }));
        for (const enriched of intelligence.assets) {
          const rowIndex = assets.findIndex((asset) => asset.symbol === enriched.symbol);
          if (rowIndex >= 0) assets[rowIndex] = enriched;
        }
      } catch (error) {
        for (const candidate of preliminary) {
          const rowIndex = assets.findIndex((asset) => asset.symbol === candidate.symbol);
          if (rowIndex >= 0) assets[rowIndex].providerErrors = [...(assets[rowIndex].providerErrors || []), `Event intelligence: ${String(error.message || error).slice(0, 140)}`];
        }
      }
    }
    assets = attachMarketContext(assets).map((asset) => ({ ...asset, dataQuality: calculateDataQuality(asset) }));
    const providers = [`Alpaca ${config.alpacaDataFeed.toUpperCase()}`, ...new Set(assets.flatMap((asset) => asset.crossCheckProviders || []))];
    const snapshot = {
      version: 4,
      fetchedAt: new Date().toISOString(),
      source: providers.join(' + '),
      assets,
      ownership: summarizeStockOwnership(assets, currentOwnership, ownershipError),
      requestedSymbols: symbols,
      dynamicSymbols,
      dynamicDiscovery: { enabled: dynamicDiscovery.enabled, mode: requestedDiscoveryMode, screenerCandidates: dynamicDiscovery.screenerCandidates ?? dynamicDiscovery.candidateCount ?? 0,
        etfDirectory: dynamicDiscovery.etfDirectory || { status: 'not_required', symbols: null, excludedFromDiscovery: 0 },
        feed: dynamicDiscovery.feed || config.alpacaDataFeed,
        feedUsed: Boolean(dynamicDiscovery.feedUsed),
        version: STOCK_DISCOVERY_VERSION, directoryDiagnostics: dynamicDiscovery.diagnostics ?? null, archive: dynamicDiscovery.archive ?? null,
        wideCacheAgeMs: dynamicDiscovery.cacheAgeMs ?? 0,
        screenerDirectoryRejected: dynamicDiscovery.screenerDirectoryRejected || [], capOmissionRecords: dynamicDiscovery.capOmissionRecords || [],
        wideCandidates: dynamicDiscovery.wideCandidates ?? null, wideEligibleUniverse: dynamicDiscovery.eligibleUniverseSize ?? null,
        wideSnapshotsReturned: dynamicDiscovery.snapshotSymbolsReturned ?? null,
        wideCapOmissions: dynamicDiscovery.capOmissions || 0, wideRejectionCounts: dynamicDiscovery.rejectionCounts || {},
        wideRejectionSamples: dynamicDiscovery.rejectionSamples || [],
        symbolsRequested: dynamicSymbols.length, cached: dynamicDiscovery.cached, error: dynamicDiscovery.error || '' },
      failedSymbols: fetched.flatMap((row, index) => row?.error ? [{ symbol: symbols[index], reason: String(row.error.message || row.error).slice(0, 180) }] : []),
      errors: fetched.filter((row) => row?.error).length,
      providerErrors: assets.reduce((sum, asset) => sum + (asset.providerErrors?.length || 0), 0),
      providerMetrics: summarizeProviderMetrics(options.metrics)
    };
    await writeMarketSnapshot(cacheKey, snapshot);
    return { ...snapshot, cacheHit: false, cacheAgeMs: 0 };
  } catch (error) {
    if (cached?.assets?.length) return { ...cached, assets: cached.assets.map((asset) => ({ ...refreshAssetFreshness(asset), freshness: 'stale' })),
      ownership: summarizeStockOwnership(cached.assets, currentOwnership, ownershipError),
      source: `${cached.source} stale cache`, cacheHit: true, stale: true, cacheAgeMs, providerError: error.message };
    throw error;
  }
}

export function refreshAssetFreshness(asset, now = Date.now()) {
  const age = now - Date.parse(asset.lastUpdated);
  return { ...asset, freshness: Number.isFinite(age) && age >= -5_000 && age < 20 * 60_000 ? asset.freshness : 'stale' };
}

export function scoreAsset(asset) {
  const price = finite(asset.price);
  const emaSpread = price && asset.ema21 ? (asset.ema9 / asset.ema21 - 1) * 100 : 0;
  const dailyAlignment = price && asset.dailySma20 ? percentChange(price, asset.dailySma20) : finite(asset.change5d) / 2;
  const longAlignment = asset.dailySma50 && asset.dailySma200 ? percentChange(asset.dailySma50, asset.dailySma200) : finite(asset.change20d) / 4;
  const trend = clamp(50 + emaSpread * 13 + dailyAlignment * 3 + longAlignment * 2 + finite(asset.adx14 - 18) * 0.55, 0, 100);
  const volume = clamp(30 + (finite(asset.relativeVolume, 1) - 0.5) * 38, 0, 100);
  const intradayRsi = finite(asset.rsi14, 50);
  const dailyRsi = finite(asset.dailyRsi14, intradayRsi);
  const rsiQuality = intradayRsi >= 52 && intradayRsi <= 72 ? 78 + Math.min(17, intradayRsi - 52)
    : intradayRsi > 82 ? 20 : intradayRsi > 72 ? 55 : intradayRsi < 40 ? 25 : 50;
  const histogramPct = price ? finite(asset.macdHistogram, asset.macd) / price * 10_000 : 0;
  const dailyHistogramPct = price ? finite(asset.dailyMacdHistogram) / price * 1_000 : 0;
  const momentum = clamp(rsiQuality * 0.45 + clamp(50 + histogramPct * 8, 0, 100) * 0.35 + clamp(50 + finite(asset.change1h) * 10 + (dailyRsi - 50), 0, 100) * 0.20 + dailyHistogramPct * 2, 0, 100);
  const breakoutPct = asset.previous20High ? percentChange(price, asset.previous20High) : 0;
  const openingBreakoutPct = asset.openingRangeHigh ? percentChange(price, asset.openingRangeHigh) : 0;
  const breakout = clamp(50 + breakoutPct * 16 + openingBreakoutPct * 10 + (price >= finite(asset.highDay, price) * 0.995 ? 10 : 0), 0, 100);
  const vwap = clamp(50 + finite(asset.vwapDistancePct) * 15 + (price > finite(asset.ema9, price) ? 8 : -8), 0, 100);
  const relativeStrength = clamp(50 + finite(asset.relativeStrengthDay) * 12 + finite(asset.relativeStrength5d) * 2.5 + finite(asset.sectorRelativeStrength) * 5, 0, 100);
  const sector = clamp(50 + finite(asset.sectorChange) * 8 + finite(asset.sectorFiveDayChange) * 1.5, 0, 100);
  const regime = clamp(35 + finite(asset.marketMove) * 10 + (finite(asset.marketBreadth, 50) - 40) * 0.7 + (finite(asset.advancingBreadth, 50) - 50) * 0.3 - finite(asset.macroStress) * 0.12, 10, 95);
  const agreementQuality = finite(asset.liveProviderQuoteCount, asset.providerQuoteCount) > 1 ? clamp(finite(asset.providerAgreement), 0, 100) : 50;
  const spreadQuality = asset.microstructureProvider ? clamp(100 - finite(asset.spreadBps) * 2.2, 0, 100) : 50;
  const imbalanceQuality = asset.microstructureProvider ? clamp(50 + finite(asset.quoteImbalance) * 30, 20, 80) : 50;
  const provider = asset.microstructureProvider
    ? agreementQuality * 0.70 + spreadQuality * 0.25 + imbalanceQuality * 0.05
    : agreementQuality;
  const raw = trend * 0.20 + momentum * 0.15 + volume * 0.12 + breakout * 0.12 + vwap * 0.10 + relativeStrength * 0.12 + sector * 0.07 + regime * 0.08 + provider * 0.04;
  const chasePenalty = clamp(Math.max(0, finite(asset.change1h) - 2.5) * 4 + Math.max(0, intradayRsi - 76) * 1.4 + Math.max(0, finite(asset.vwapDistancePct) - 2) * 3, 0, 28);
  const stalePenalty = asset.freshness === 'stale' ? 25 : asset.delayed ? 2 : 0;
  const volatilityPenalty = finite(asset.dailyAtrPercent, asset.atrPercent) > 6 ? Math.min(12, (finite(asset.dailyAtrPercent, asset.atrPercent) - 6) * 2) : 0;
  const daysToEarnings = finite(asset.daysToEarnings, Infinity);
  const earningsPenalty = daysToEarnings <= 1 ? 18 : daysToEarnings <= 3 ? 6 : 0;
  const filingPenalty = finite(asset.secFilingRisk) >= 75 ? 12 : finite(asset.secFilingRisk) >= 40 ? 5 : 0;
  const corporateActionPenalty = finite(asset.corporateActionRisk) >= 80 ? 12 : finite(asset.corporateActionRisk) >= 40 ? 5 : 0;
  const macroPenalty = finite(asset.macroStress) >= 85 ? 10 : finite(asset.macroStress) >= 70 ? 4 : 0;
  const eventPenalty = earningsPenalty + filingPenalty + corporateActionPenalty + macroPenalty;
  const qualityPenalty = Math.max(0, 60 - finite(asset.dataQuality, 60)) * 0.3;
  const score = clamp(raw - chasePenalty - stalePenalty - volatilityPenalty - eventPenalty - qualityPenalty, 0, 100);
  const atr = finite(asset.dailyAtrPercent, asset.atrPercent);
  const risk = atr >= 5 ? 'High' : atr >= 3 ? 'Elevated' : atr >= 1.5 ? 'Moderate' : 'Lower';
  const trendLabel = asset.ema9 > asset.ema21 && price > finite(asset.vwap, 0) && (!asset.dailySma20 || price > asset.dailySma20) ? 'Confirmed multi-timeframe uptrend'
    : asset.ema9 > asset.ema21 && finite(asset.change1h) > 0 ? 'Confirmed intraday uptrend'
      : asset.changeDay > 0 && asset.macd > asset.macdSignal ? 'Constructive momentum' : 'Unconfirmed / weak trend';
  return {
    version: '2.0', score, trend, momentum, volume, breakout, vwap, relativeStrength, sector, regime, provider,
    sectorContextStatus: asset.sectorContextStatus || (asset.sector && asset.sectorChange != null ? 'available' : 'unavailable'),
    oscillator: momentum, chasePenalty, stalePenalty, volatilityPenalty, eventPenalty, qualityPenalty,
    risk, trendLabel, breakoutPct, weights: { trend: 20, momentum: 15, volume: 12, breakout: 12, vwap: 10, relativeStrength: 12, sector: 7, regime: 8, provider: 4 }
  };
}

function rejectionReasons(asset, settings) {
  const model = asset.model || scoreAsset(asset);
  const reasons = [];
  if (asset.freshness === 'stale') reasons.push('stale data');
  if (model.score < settings.minScore) reasons.push('score');
  if (finite(asset.relativeVolume, 1) < 0.70) reasons.push('relative volume');
  if (!(asset.ema9 > asset.ema21)) reasons.push('EMA trend');
  if (asset.vwap && asset.price < asset.vwap * 0.998) reasons.push('below VWAP');
  if (finite(asset.change1h) < 0.05) reasons.push('no short-term follow-through');
  if (finite(asset.changeDay) < 0.20) reasons.push('negative/flat day');
  if (asset.openingRangeHigh && asset.price < asset.openingRangeHigh * 0.998 && finite(asset.relativeStrengthDay) < 0.75) reasons.push('no breakout confirmation');
  if (asset.marketRegime === 'sideways') reasons.push('sideways regime');
  if (asset.marketRegime === 'risk-off trend') reasons.push('risk-off regime');
  if (finite(asset.rsi14, 50) < 50 || finite(asset.rsi14, 50) > 72.5) reasons.push('RSI range');
  if (finite(asset.marketMinute) > 810) reasons.push('late-session entry');
  if (finite(asset.dataQuality, 60) < finite(settings.minDataQuality, 60)) reasons.push('data quality');
  if (finite(asset.liveProviderQuoteCount, asset.providerQuoteCount) > 1 && asset.providerAgreement < 90) reasons.push('provider disagreement');
  if (asset.microstructureProvider && finite(asset.spreadBps) > finite(settings.maxSpreadBps, 35)) reasons.push('spread too wide');
  if (asset.halted) reasons.push('trading halt');
  if (asset.microstructureProvider && finite(asset.luldDistanceBps, 10000) < 50) reasons.push('near LULD band');
  if (asset.streamingQuote && finite(asset.quoteAgeSeconds, 0) > 60) reasons.push('stale live quote');
  if (asset.daysToEarnings !== null && asset.daysToEarnings !== undefined && asset.daysToEarnings <= finite(settings.earningsBlackoutDays, 2)) reasons.push('earnings blackout');
  if (finite(asset.secFilingRisk) >= 50 && finite(asset.secFilingAgeHours, 9999) <= finite(settings.secFilingBlackoutHours, 4)) reasons.push('fresh SEC filing');
  if (finite(asset.corporateActionRisk) >= 50 && Math.abs(finite(asset.daysToCorporateAction, 9999)) <= finite(settings.corporateActionBlackoutDays, 2)) reasons.push('corporate action window');
  if (finite(asset.macroStress) >= 90) reasons.push('macro stress');
  if (asset.dailySma20 && asset.price < asset.dailySma20 * 0.985) reasons.push('daily downtrend');
  return reasons;
}

function rejectionCode(reason) {
  return String(reason).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function screenMomentum(snapshot, settings) {
  return analyzeMomentum(snapshot, settings).candidates;
}

export function analyzeMomentum(snapshot, settings) {
  const normalizedSettings = {
    minPrice: finite(settings.minPrice, 2),
    minAverageVolume: finite(settings.minAverageVolume, 500_000),
    minScore: finite(settings.minScore, 68),
    maxSignals: finite(settings.maxSignals, 5),
    minDataQuality: finite(settings.minDataQuality, 60),
    earningsBlackoutDays: finite(settings.earningsBlackoutDays, 2),
    maxSpreadBps: finite(settings.maxSpreadBps, 35),
    secFilingBlackoutHours: finite(settings.secFilingBlackoutHours, 4),
    corporateActionBlackoutDays: finite(settings.corporateActionBlackoutDays, 2)
  };
  const allAssets = snapshot.assets || [];
  const contextRejected = allAssets.filter((asset) => MARKET_CONTEXT.includes(asset.symbol));
  const ownership = snapshot.ownership;
  const owned = new Set(ownership?.ownedSymbols || []);
  const blocked = new Set(ownership?.blockedSymbols || []);
  const ownershipRejected = allAssets.filter((asset) => !MARKET_CONTEXT.includes(asset.symbol)
    && (ownership?.status === 'unavailable' || owned.has(asset.symbol) || blocked.has(asset.symbol)));
  const ownershipRejectedSymbols = new Set(ownershipRejected.map((asset) => asset.symbol));
  const instrumentUniverse = allAssets.filter((asset) => !MARKET_CONTEXT.includes(asset.symbol) && !ownershipRejectedSymbols.has(asset.symbol))
    .map((asset) => snapshot.stale ? { ...asset, freshness: 'stale' } : asset);
  const preScreenRejects = [];
  const underPrice = instrumentUniverse.filter((asset) => !(asset.price >= normalizedSettings.minPrice));
  const underVolume = instrumentUniverse.filter((asset) => asset.price >= normalizedSettings.minPrice && !(asset.averageDailyVolume >= normalizedSettings.minAverageVolume));
  for (const asset of underPrice) preScreenRejects.push({ symbol: asset.symbol, stage: 'candidate_filter', reasons: ['price floor'] });
  for (const asset of underVolume) preScreenRejects.push({ symbol: asset.symbol, stage: 'candidate_filter', reasons: ['average share volume floor'] });
  const liquid = instrumentUniverse.filter((asset) => asset.price >= normalizedSettings.minPrice && asset.averageDailyVolume >= normalizedSettings.minAverageVolume)
    .map((asset) => ({ ...asset, model: scoreAsset(asset) }))
    .sort((a, b) => b.model.score - a.model.score || b.relativeVolume - a.relativeVolume);
  const evaluated = liquid.map((asset) => ({ asset, reasons: rejectionReasons(asset, normalizedSettings) }));
  const candidates = evaluated.filter((row) => row.reasons.length === 0).map((row) => ({ ...row.asset, selectionTier: 'qualified' }));
  const developingThreshold = Math.max(50, normalizedSettings.minScore - 10);
  const watchCandidates = evaluated.filter((row) => row.asset.freshness !== 'stale' && row.asset.model.score >= developingThreshold && row.reasons.length > 0)
    .slice(0, Math.min(5, normalizedSettings.maxSignals)).map((row) => ({ ...row.asset, selectionTier: 'watch_only', rejectionReasons: row.reasons }));
  const rejectionRecords = [
    ...contextRejected.map((asset) => ({ symbol: asset.symbol, stage: 'universe_context', reasons: ['market context symbol'] })),
    ...ownershipRejected.map((asset) => ({ symbol: asset.symbol, stage: 'instrument_ownership',
      reasons: [ownership?.status === 'unavailable' ? 'ownership classification unavailable'
        : blocked.has(asset.symbol) ? 'unreviewed ETP classification' : 'primary owner ETF ETP'] })),
    ...preScreenRejects,
    ...evaluated.filter((row) => row.reasons.length).map((row) => ({ symbol: row.asset.symbol, stage: 'technical', reasons: row.reasons }))
  ].map((row) => ({ ...row, reasonCodes: row.reasons.map(rejectionCode) }));
  const reasonCounts = {};
  for (const row of rejectionRecords) {
    if (row.stage === 'universe_context') continue;
    for (const reason of row.reasonCodes) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  return {
    candidates,
    watchCandidates,
    rejections: Object.fromEntries(rejectionRecords.map((row) => [row.symbol, row.reasons])),
    rejectionRecords,
    diagnostics: {
      assetsReturned: allAssets.length,
      universeRequested: snapshot.requestedSymbols?.length ?? allAssets.length,
      successfullyScanned: allAssets.length,
      marketContext: contextRejected.length,
      ownershipStatus: ownership?.status || 'not_provided',
      ownershipExcluded: ownershipRejected.length,
      instruments: instrumentUniverse.length,
      priceRejected: underPrice.length,
      averageVolumeRejected: underVolume.length,
      liquid: liquid.length,
      strictQualified: candidates.length,
      watchOnly: watchCandidates.length,
      selectedMode: candidates.length ? 'qualified' : watchCandidates.length ? 'watch_only' : 'none',
      configuredScore: normalizedSettings.minScore,
      developingScore: developingThreshold,
      rejectedByReason: reasonCounts,
      staleAssets: liquid.filter((asset) => asset.freshness === 'stale').length
    }
  };
}

export function updateCandidateConfirmations(previousStates = {}, candidates = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const required = Math.max(1, Math.min(5, finite(options.required, 2)));
  const maxGapMs = Math.max(5, finite(options.discoveryMinutes, 15)) * 2.5 * 60_000;
  const states = {};
  const confirmed = [];
  for (const asset of candidates) {
    const previous = previousStates?.[asset.symbol];
    const lastSeen = previous?.lastSeenAt ? new Date(previous.lastSeenAt).getTime() : 0;
    const consecutive = previous && now.getTime() - lastSeen <= maxGapMs ? finite(previous.consecutive, 0) + 1 : 1;
    states[asset.symbol] = {
      firstSeenAt: previous?.firstSeenAt || now.toISOString(),
      lastSeenAt: now.toISOString(),
      consecutive,
      lastScore: asset.model.score,
      dataQuality: asset.dataQuality
    };
    if (consecutive >= required) confirmed.push({ ...asset, confirmationCount: consecutive, confirmationRequired: required });
  }
  return { states, confirmed, required };
}

export function pendingConfirmationRejections(candidates = [], states = {}, requiredScans = 1) {
  const required = Math.max(1, Math.min(5, finite(requiredScans, 1)));
  return candidates.flatMap((asset) => {
    const consecutive = finite(states?.[asset.symbol]?.consecutive, 0);
    if (consecutive >= required) return [];
    return [{ symbol: asset.symbol, stage: 'confirmation', reasonCodes: ['confirmation_scans_pending'],
      reasons: [`${consecutive}/${required} consecutive qualifying scans`] }];
  });
}

// Research lane for measuring the consecutive-scan gate. It cannot relax the
// model decision and is empty when production already requires one scan.
export function selectConfirmationAdvisoryCandidates(candidates = [], confirmed = [], { required = 2, allowRuleOnlySignals = false } = {}) {
  if (finite(required, 2) <= 1) return [];
  const confirmedSymbols = new Set(confirmed.map((asset) => String(asset.symbol).toUpperCase()));
  return candidates.filter((asset) => {
    if (confirmedSymbols.has(String(asset.symbol).toUpperCase())) return false;
    return asset.ensemble?.decision === 'BUY'
      || (allowRuleOnlySignals && asset.ensemble?.decision === 'RULE_ONLY');
  });
}

export function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: number < 10 ? 3 : 2 }).format(number) : 'n/a';
}

export function formatPercent(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}
