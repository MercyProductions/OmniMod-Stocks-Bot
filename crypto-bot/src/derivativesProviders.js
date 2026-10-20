import { paths, readJson, writeJson } from './storage.js';
import { recordProviderRequest } from './providerTelemetry.js';
import { isRetryableProviderFailure, retryPlan } from './retryPolicy.js';
import { assertProviderAvailable, recordProviderCooldown, waitForProviderCooldown } from './providerCooldown.js';

const BINANCE_FUTURES = 'https://fapi.binance.com';
const KRAKEN_FUTURES = 'https://futures.kraken.com/derivatives/api/v3';
const DERIBIT = 'https://www.deribit.com/api/v2';
const USER_AGENT = 'OmniMod-Crypto/3.0 derivatives-research-bot';
const cache = new Map();
const inFlight = new Map();
let krakenTickerCache = { expiresAt: 0, rows: [] };
let binanceBlockedUntil = 0;
const optionsCache = new Map();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));

async function requestJson(url, provider) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt === 0) assertProviderAvailable(url);
      else await waitForProviderCooldown(url);
    } catch (error) {
      recordProviderRequest(provider, { latencyMs: 0, error: 'Request deferred by provider-host cooldown', deferred: true });
      throw error;
    }
    const started = performance.now();
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${provider} HTTP ${response.status}: ${text.slice(0, 160)}`);
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

function median(values = []) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function symbolAlias(symbol) {
  return String(symbol || '').toUpperCase() === 'XBT' ? 'BTC' : String(symbol || '').toUpperCase();
}

export function summarizeOpenInterestHistory(history = [], { now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  const byTimestamp = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const value = finite(row?.sumOpenInterestValue);
    const timestamp = finite(row?.timestamp, NaN);
    if (value > 0 && timestamp > 0) byTimestamp.set(timestamp, { value, timestamp });
  }
  const samples = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  const latest = samples.at(-1);
  const fresh = latest && latest.timestamp <= now + 60_000 && now - latest.timestamp <= maxAgeMs;
  if (samples.length < 2 || !fresh) return { openInterestChangePct: 0, openInterestChangeAvailable: false };
  const earlier = samples[0].value;
  return { openInterestChangePct: (latest.value / earlier - 1) * 100, openInterestChangeAvailable: true };
}

function isFreshFiveMinuteSample(row, now = Date.now()) {
  const timestamp = finite(row?.timestamp, NaN);
  // Taker-ratio rows are timestamped at interval start; account-ratio rows at
  // interval end. Two intervals allow a delayed completed sample, plus skew.
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 5_000 && now - timestamp <= 10 * 60_000;
}

async function fetchBinance(symbol) {
  if (binanceBlockedUntil > Date.now()) throw new Error('Binance Futures is temporarily disabled after an eligibility/location response.');
  const pair = `${symbolAlias(symbol)}USDT`;
  const query = (path, parameters = '') => requestJson(`${BINANCE_FUTURES}${path}?symbol=${encodeURIComponent(pair)}${parameters}`, 'Binance Futures');
  let payloads;
  try {
    payloads = await Promise.all([
      query('/fapi/v1/premiumIndex'),
      query('/futures/data/openInterestHist', '&period=5m&limit=2'),
      query('/futures/data/globalLongShortAccountRatio', '&period=5m&limit=1'),
      query('/futures/data/takerlongshortRatio', '&period=5m&limit=1')
    ]);
  } catch (error) {
    if (/HTTP 451|restricted location|eligibility/i.test(String(error?.message || error))) binanceBlockedUntil = Date.now() + 60 * 60_000;
    throw error;
  }
  const [premium, interestHistory, positioning, taker] = payloads;
  const history = Array.isArray(interestHistory) ? interestHistory : [];
  let latest = finite(history.at(-1)?.sumOpenInterestValue);
  // The current snapshot endpoint duplicates the successful history value.
  // Request it only when the history payload cannot provide usable notional.
  if (!(latest > 0)) {
    const interest = await query('/fapi/v1/openInterest');
    latest = finite(interest.openInterest) * finite(premium.markPrice);
  }
  const oiHistory = summarizeOpenInterestHistory(history);
  const ratioNow = Date.now();
  const positioningRow = Array.isArray(positioning) ? positioning[0] : null;
  const takerRow = Array.isArray(taker) ? taker[0] : null;
  const longShortRatioAvailable = isFreshFiveMinuteSample(positioningRow, ratioNow);
  const takerBuySellRatioAvailable = isFreshFiveMinuteSample(takerRow, ratioNow);
  return {
    provider: 'Binance Futures', symbol: pair, markPrice: finite(premium.markPrice), indexPrice: finite(premium.indexPrice),
    fundingAnnualizedPct: finite(premium.lastFundingRate) * 100 * 3 * 365,
    openInterestUsd: latest, ...oiHistory,
    longShortRatio: longShortRatioAvailable ? finite(positioningRow?.longShortRatio) : 0,
    longShortRatioAvailable,
    takerBuySellRatio: takerBuySellRatioAvailable ? finite(takerRow?.buySellRatio) : 0,
    takerBuySellRatioAvailable,
    observedAt: new Date(finite(premium.time, Date.now())).toISOString()
  };
}

async function krakenTickers() {
  if (krakenTickerCache.expiresAt > Date.now()) return krakenTickerCache.rows;
  const payload = await requestJson(`${KRAKEN_FUTURES}/tickers`, 'Kraken Futures');
  if (payload?.result !== 'success' || !Array.isArray(payload.tickers)) throw new Error('Kraken Futures returned invalid tickers.');
  krakenTickerCache = { expiresAt: Date.now() + 60_000, rows: payload.tickers };
  return payload.tickers;
}

async function fetchKraken(symbol) {
  const base = symbolAlias(symbol) === 'BTC' ? 'XBT' : symbolAlias(symbol);
  const row = (await krakenTickers()).find((ticker) => ticker.symbol === `PF_${base}USD`)
    || (await krakenTickers()).find((ticker) => ticker.tag === 'perpetual' && String(ticker.pair).startsWith(`${base}:`));
  if (!row) throw new Error(`Kraken Futures has no perpetual market for ${symbol}.`);
  const openInterestUsd = finite(row.openInterest) * finite(row.markPrice);
  return {
    provider: 'Kraken Futures', symbol: row.symbol, markPrice: finite(row.markPrice), indexPrice: finite(row.indexPrice),
    fundingAnnualizedPct: finite(row.fundingRate), openInterestUsd,
    // This endpoint is a snapshot; comparing it to the prior bot poll produces a variable interval, not a 5m change.
    openInterestChangePct: 0, openInterestChangeAvailable: false,
    longShortRatio: 0, takerBuySellRatio: 0, observedAt: String(row.lastTime || new Date().toISOString())
  };
}

async function fetchDeribit(symbol) {
  const currency = symbolAlias(symbol);
  if (!['BTC', 'ETH'].includes(currency)) throw new Error(`Deribit public futures coverage is not enabled for ${currency}.`);
  const payload = await requestJson(`${DERIBIT}/public/get_book_summary_by_currency?currency=${currency}&kind=future`, 'Deribit');
  const row = payload?.result?.find((item) => item.instrument_name === `${currency}-PERPETUAL`);
  if (!row) throw new Error(`Deribit returned no ${currency} perpetual summary.`);
  const openInterestUsd = finite(row.open_interest);
  return {
    provider: 'Deribit', symbol: row.instrument_name, markPrice: finite(row.mark_price),
    indexPrice: finite(row.estimated_delivery_price), fundingAnnualizedPct: finite(row.funding_8h) * 3 * 365,
    // This endpoint is a snapshot; comparing it to the prior bot poll produces a variable interval, not a 5m change.
    openInterestUsd, openInterestChangePct: 0, openInterestChangeAvailable: false,
    longShortRatio: 0, takerBuySellRatio: 0,
    observedAt: new Date(finite(row.creation_timestamp, Date.now())).toISOString()
  };
}

function parseDeribitOption(name) {
  const match = String(name || '').match(/^([A-Z]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:\.\d+)?)-([CP])$/);
  if (!match) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const expiryMatch = match[2].match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  const expiry = Date.UTC(2000 + Number(expiryMatch[3]), months[expiryMatch[2]], Number(expiryMatch[1]), 8);
  return { currency: match[1], expiry, strike: Number(match[3]), type: match[4] };
}

function weightedAverage(rows, selector) {
  let value = 0;
  let weight = 0;
  for (const row of rows) {
    const rowWeight = Math.max(0.1, finite(row.open_interest) + finite(row.volume));
    value += finite(selector(row)) * rowWeight;
    weight += rowWeight;
  }
  return weight > 0 ? value / weight : 0;
}

export function summarizeOptionsSurface(optionRows = [], dvolRows = [], trades = [], now = new Date()) {
  const current = new Date(now).getTime();
  const parsed = optionRows.map((row) => ({ ...row, option: parseDeribitOption(row.instrument_name) }))
    .filter((row) => row.option && finite(row.mark_iv) > 0 && finite(row.underlying_price) > 0);
  const relevant = parsed.filter((row) => {
    const days = (row.option.expiry - current) / 86_400_000;
    const ratio = row.option.strike / finite(row.underlying_price);
    return days >= 2 && days <= 60 && ratio >= 0.75 && ratio <= 1.25;
  });
  const puts = relevant.filter((row) => row.option.type === 'P' && row.option.strike / finite(row.underlying_price) >= 0.8 && row.option.strike / finite(row.underlying_price) <= 0.98);
  const calls = relevant.filter((row) => row.option.type === 'C' && row.option.strike / finite(row.underlying_price) >= 1.02 && row.option.strike / finite(row.underlying_price) <= 1.2);
  const atm = relevant.filter((row) => Math.abs(row.option.strike / finite(row.underlying_price) - 1) <= 0.08);
  const expiries = [...new Set(atm.map((row) => row.option.expiry))].sort((a, b) => a - b);
  const front = atm.filter((row) => row.option.expiry === expiries[0]);
  const back = atm.filter((row) => row.option.expiry === expiries.at(-1));
  const putIv = weightedAverage(puts, (row) => row.mark_iv);
  const callIv = weightedAverage(calls, (row) => row.mark_iv);
  const frontIv = weightedAverage(front, (row) => row.mark_iv);
  const backIv = weightedAverage(back, (row) => row.mark_iv);
  const putOpenInterest = puts.reduce((sum, row) => sum + finite(row.open_interest), 0);
  const callOpenInterest = calls.reduce((sum, row) => sum + finite(row.open_interest), 0);
  const dvolCloses = dvolRows.map((row) => finite(row?.[4])).filter((value) => value > 0);
  const dvol = dvolCloses.at(-1) || 0;
  const dvolChangePct = dvolCloses[0] > 0 ? (dvol / dvolCloses[0] - 1) * 100 : 0;
  const liquidationTrades = trades.filter((row) => row.liquidation);
  const liquidationBuyUsd = liquidationTrades.filter((row) => row.direction === 'buy')
    .reduce((sum, row) => sum + finite(row.amount) * finite(row.price), 0);
  const liquidationSellUsd = liquidationTrades.filter((row) => row.direction === 'sell')
    .reduce((sum, row) => sum + finite(row.amount) * finite(row.price), 0);
  const liquidationUsd1h = liquidationBuyUsd + liquidationSellUsd;
  return {
    available: relevant.length >= 10, optionCount: relevant.length, dvol, dvolChangePct, dvolAvailable: dvolCloses.length > 0,
    putCallSkewAvailable: putIv > 0 && callIv > 0,
    putIv, callIv, putCallSkewIv: putIv && callIv ? putIv - callIv : 0,
    frontIv, backIv, ivTermStructure: frontIv && backIv ? backIv - frontIv : 0,
    putCallOpenInterestRatio: callOpenInterest > 0 ? putOpenInterest / callOpenInterest : 0,
    liquidationUsd1h,
    liquidationImbalance: liquidationUsd1h > 0 ? (liquidationBuyUsd - liquidationSellUsd) / liquidationUsd1h : 0,
    observedAt: new Date(now).toISOString()
  };
}

async function fetchDeribitOptionsContext(symbol) {
  const currency = symbolAlias(symbol);
  if (!['BTC', 'ETH'].includes(currency)) return { available: false };
  const cached = optionsCache.get(currency);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const end = Date.now();
  const start = end - 60 * 60_000;
  const [options, dvol, trades] = await Promise.all([
    requestJson(`${DERIBIT}/public/get_book_summary_by_currency?currency=${currency}&kind=option`, 'Deribit Options'),
    requestJson(`${DERIBIT}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`, 'Deribit DVOL'),
    requestJson(`${DERIBIT}/public/get_last_trades_by_currency_and_time?currency=${currency}&kind=future&start_timestamp=${start}&end_timestamp=${end}&count=1000&sorting=desc`, 'Deribit Trades')
  ]);
  const value = summarizeOptionsSurface(options?.result || [], dvol?.result?.data || [], trades?.result?.trades || []);
  optionsCache.set(currency, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}

export function aggregateDerivatives(rows = [], spotPrice = 0, errors = []) {
  const valid = rows.filter((row) => finite(row?.markPrice) > 0);
  if (!valid.length) return {
    available: false, providers: [], providerCount: 0, score: 50, blockLongs: false,
    fundingAnnualizedPct: 0, openInterestChangePct: 0, openInterestChangeAvailable: false, longShortRatio: 0,
    takerBuySellRatio: 0, basisPct: 0, errors
  };
  const mark = median(valid.map((row) => row.markPrice));
  const index = median(valid.map((row) => row.indexPrice).filter((value) => value > 0)) || finite(spotPrice, mark);
  const fundingAnnualizedPct = median(valid.map((row) => row.fundingAnnualizedPct));
  const openInterestChangeRows = valid.filter((row) => row.openInterestChangeAvailable !== false && Number.isFinite(Number(row.openInterestChangePct)));
  const openInterestChangePct = openInterestChangeRows.length ? median(openInterestChangeRows.map((row) => row.openInterestChangePct)) : 0;
  const longShortValues = valid.filter((row) => row.longShortRatioAvailable !== false)
    .map((row) => row.longShortRatio).filter((value) => value > 0);
  const takerValues = valid.filter((row) => row.takerBuySellRatioAvailable !== false)
    .map((row) => row.takerBuySellRatio).filter((value) => value > 0);
  const longShortRatio = median(longShortValues);
  const takerBuySellRatio = median(takerValues);
  const basisPct = index > 0 ? (mark / index - 1) * 100 : 0;
  let score = 50;
  if (fundingAnnualizedPct >= -12 && fundingAnnualizedPct <= 22) score += 8;
  else if (fundingAnnualizedPct > 60) score -= 18;
  else if (fundingAnnualizedPct < -50) score -= 8;
  if (openInterestChangePct > 0 && openInterestChangePct <= 4) score += 8;
  if (openInterestChangePct < -4 || openInterestChangePct > 10) score -= 8;
  if (takerBuySellRatio >= 1.02 && takerBuySellRatio <= 1.8) score += 8;
  else if (takerBuySellRatio > 0 && takerBuySellRatio < 0.8) score -= 10;
  if (longShortRatio >= 0.8 && longShortRatio <= 1.8) score += 5;
  else if (longShortRatio > 2.5) score -= 14;
  if (Math.abs(basisPct) <= 0.45) score += 6;
  else if (basisPct > 2.5) score -= 16;
  const blockLongs = fundingAnnualizedPct > 90 || longShortRatio > 3 || basisPct > 3.5;
  return {
    available: true, providers: valid.map((row) => row.provider), providerCount: valid.length,
    markPrice: mark, indexPrice: index, fundingAnnualizedPct, openInterestChangePct,
    openInterestChangeAvailable: openInterestChangeRows.length > 0,
    longShortRatio, takerBuySellRatio,
    longShortRatioAvailable: longShortValues.length > 0,
    takerBuySellRatioAvailable: takerValues.length > 0,
    basisPct, score: clamp(score, 0, 100), blockLongs,
    openInterestUsd: valid.reduce((sum, row) => sum + finite(row.openInterestUsd), 0),
    observations: valid, errors
  };
}

export async function fetchDerivativesSnapshot(asset, options = {}) {
  const symbol = symbolAlias(asset?.symbol);
  const cached = cache.get(symbol);
  if (!options.force && cached?.expiresAt > Date.now()) return cached.value;
  const pending = inFlight.get(symbol);
  if (pending) return pending;
  const request = fetchDerivativesSnapshotUncached(asset, symbol);
  inFlight.set(symbol, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(symbol) === request) inFlight.delete(symbol);
  }
}

async function fetchDerivativesSnapshotUncached(asset, symbol) {
  const state = await readJson(paths.derivativesState(), {});
  const settled = await Promise.allSettled([
    fetchBinance(symbol), fetchKraken(symbol), fetchDeribit(symbol)
  ]);
  const rows = [];
  const errors = [];
  settled.forEach((result, index) => {
    const provider = ['Binance Futures', 'Kraken Futures', 'Deribit'][index];
    if (result.status === 'fulfilled') rows.push(result.value);
    else errors.push(`${provider}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  const optionsContext = await fetchDeribitOptionsContext(symbol).catch((error) => {
    errors.push(`Deribit Options: ${error instanceof Error ? error.message : String(error)}`);
    return { available: false };
  });
  const value = { ...aggregateDerivatives(rows, asset?.price, errors), options: optionsContext };
  if (optionsContext.available) {
    value.score = clamp(value.score
      - Math.max(0, optionsContext.putCallSkewIv - 12) * 0.5
      - Math.max(0, optionsContext.dvolChangePct - 12) * 0.5
      + (optionsContext.ivTermStructure >= 0 ? 2 : -2), 0, 100);
    value.blockLongs = value.blockLongs
      || optionsContext.dvolChangePct > 30
      || (optionsContext.liquidationUsd1h > 10_000_000 && optionsContext.liquidationImbalance < -0.6);
  }
  state[symbol] = { ...value, updatedAt: new Date().toISOString() };
  await writeJson(paths.derivativesState(), state).catch(() => {});
  cache.set(symbol, { expiresAt: Date.now() + 2 * 60_000, value });
  return value;
}
