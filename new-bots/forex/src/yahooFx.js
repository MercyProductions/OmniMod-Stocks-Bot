import { assessForexQuoteTime } from './quoteQuality.js';
import { requestForexJson } from './providerRequest.js';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const FOUR_HOURS = 4 * 60 * 60 * 1000;

export function yahooFxSymbol(instrument) {
  const map = {
    EUR_USD: 'EURUSD=X', GBP_USD: 'GBPUSD=X', AUD_USD: 'AUDUSD=X', NZD_USD: 'NZDUSD=X',
    USD_JPY: 'JPY=X', USD_CHF: 'CHF=X', USD_CAD: 'CAD=X', EUR_GBP: 'EURGBP=X',
    EUR_JPY: 'EURJPY=X', GBP_JPY: 'GBPJPY=X'
  };
  const key = String(instrument).toUpperCase();
  if (!map[key]) throw new Error(`No public Yahoo FX symbol mapping for ${instrument}; add an explicit reviewed mapping first`);
  return map[key];
}

function chartBars(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(payload?.chart?.error?.description || 'No price bars returned');
  const quote = result.indicators?.quote?.[0] || {};
  return result.timestamp.map((seconds, i) => ({
    time: Number(seconds) * 1000, open: Number(quote.open?.[i]), high: Number(quote.high?.[i]),
    low: Number(quote.low?.[i]), close: Number(quote.close?.[i])
  })).filter((bar) => Number.isFinite(bar.time) && [bar.open, bar.high, bar.low, bar.close].every((x) => Number.isFinite(x) && x > 0));
}

export function aggregateFourHourBars(hourlyBars) {
  const buckets = new Map();
  for (const bar of hourlyBars) {
    const start = Math.floor(bar.time / FOUR_HOURS) * FOUR_HOURS;
    const rows = buckets.get(start) || [];
    rows.push(bar); buckets.set(start, rows);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).flatMap(([time, rows]) => {
    rows.sort((a, b) => a.time - b.time);
    if (rows.length !== 4 || rows.at(-1).time - rows[0].time !== 3 * 60 * 60 * 1000) return [];
    return [{ time, open: rows[0].open, high: Math.max(...rows.map((x) => x.high)), low: Math.min(...rows.map((x) => x.low)), close: rows.at(-1).close }];
  });
}

function ema(values, period) {
  if (values.length < period) return NaN;
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  const k = 2 / (period + 1);
  for (const x of values.slice(period)) value = x * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return NaN;
  const rows = candles.slice(-period - 1);
  const ranges = rows.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - rows[i].close), Math.abs(c.low - rows[i].close)));
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function analyzeFrame(candles, granularity) {
  const closes = candles.map((x) => x.close);
  const last = closes.at(-1), ema9 = ema(closes, 9), ema21 = ema(closes, 21);
  return { granularity, last, ema9, ema21, atr14: atr(candles), direction: ema9 > ema21 && last > ema9 ? 'up' : ema9 < ema21 && last < ema9 ? 'down' : 'mixed', candleCount: candles.length,
    observedAt: candles.at(-1)?.time ? new Date(candles.at(-1).time).toISOString() : null };
}

async function fetchInterval(providerSymbol, instrument, interval, range, fetcher, metrics = [], clock = Date.now, retrySleep, requestGate) {
  const params = new URLSearchParams({ interval, range, includePrePost: 'false', events: 'div,splits' });
  const payload = await requestForexJson(`${BASE}${encodeURIComponent(providerSymbol)}?${params}`, {
    fetcher, metrics, clock, operation: `chart-${interval}`, instrument, provider: 'Yahoo Chart public',
    timeoutMs: 15_000, maxAttempts: 2, maxRetryWaitMs: 2_000, ...(retrySleep ? { sleep: retrySleep } : {}), ...(requestGate ? { requestGate } : {}),
  });
  return chartBars(payload);
}

export async function fetchYahooFxObservation(instrument, { fetcher = fetch, now = Date.now(), maxQuoteAgeSeconds = 3600, targetAtrMultiple = 1.5, metrics = [], clock = Date.now, permissionConfirmed = false, retrySleep, requestGate } = {}) {
  if (permissionConfirmed !== true) throw new Error('Yahoo Chart access requires a documented permission attestation; this provider is disabled by default.');
  const providerSymbol = yahooFxSymbol(instrument);
  const results = await Promise.allSettled([
    fetchInterval(providerSymbol, instrument, '15m', '60d', fetcher, metrics, clock, retrySleep, requestGate),
    fetchInterval(providerSymbol, instrument, '1h', '60d', fetcher, metrics, clock, retrySleep, requestGate),
    fetchInterval(providerSymbol, instrument, '1d', '2y', fetcher, metrics, clock, retrySleep, requestGate)
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [m15Raw, h1Raw, dailyRaw] = results.map((result) => result.value);
  const m15 = m15Raw.filter((bar) => bar.time + 15 * 60000 <= now);
  const h1 = h1Raw.filter((bar) => bar.time + 60 * 60000 <= now);
  const daily = dailyRaw.filter((bar) => bar.time + 24 * 60 * 60000 <= now);
  const hourly4 = aggregateFourHourBars(h1);
  const frames = [analyzeFrame(m15, 'M15'), analyzeFrame(hourly4, 'H4'), analyzeFrame(daily, 'D')];
  const last = m15.at(-1);
  const quoteTime = last?.time ?? NaN;
  const quoteFreshness = assessForexQuoteTime(quoteTime, { now, maxAgeMs: maxQuoteAgeSeconds * 1000 });
  const quoteAgeSeconds = quoteFreshness.ageMs == null ? NaN : quoteFreshness.ageMs / 1000;
  const priceValid = Number.isFinite(last?.close) && last.close > 0;
  const stale = quoteFreshness.status !== 'fresh';
  const directions = new Set(frames.map((frame) => frame.direction));
  const direction = !stale && priceValid && frames.every((frame) => Number.isFinite(frame.ema21) && Number.isFinite(frame.atr14)) && directions.size === 1 && !directions.has('mixed') ? [...directions][0] : 'unclear';
  const frameWatches = frames.map((frame) => {
    const watch = frame.direction === 'up' || frame.direction === 'down'
      ? {
        granularity: frame.granularity, bias: frame.direction === 'up' ? 'UPWARD PAPER WATCH' : 'DOWNWARD PAPER WATCH',
        entryReference: last?.close ?? null,
        invalidationPrice: Number.isFinite(frame.atr14) && last ? last.close + (frame.direction === 'up' ? -1 : 1) * frame.atr14 : null,
        targetPrice: Number.isFinite(frame.atr14) && last ? last.close + (frame.direction === 'up' ? 1 : -1) * frame.atr14 * targetAtrMultiple : null,
        stopDistanceAtr: 1, targetDistanceAtr: targetAtrMultiple, spreadToAtr: null, quoteSide: 'last completed bar close; bid/ask unavailable',
        method: 'EMA9/EMA21 with ATR references based on the last completed public chart bar; unofficial delayed data, not an executable quote or calibrated probability.'
      }
      : { granularity: frame.granularity, bias: 'NO SETUP', reason: 'Trend alignment or sufficient completed-bar ATR is unavailable.' };
    if (stale && watch.bias !== 'NO SETUP') return { ...watch, bias: 'NO SETUP', reason: 'Latest completed public chart bar is stale.' };
    return watch;
  });
  return {
    instrument, providerSymbol, source: 'Yahoo Chart (public delayed/unofficial)', delayed: true,
    bias: direction === 'up' ? 'UPWARD WATCH' : direction === 'down' ? 'DOWNWARD WATCH' : stale ? 'STALE REFERENCE PRICE' : 'TIMEFRAMES DISAGREE OR INCOMPLETE',
    quoteMid: priceValid ? last.close : null, quoteTime: Number.isFinite(quoteTime) ? new Date(quoteTime).toISOString() : null,
    quoteAgeSeconds: Number.isFinite(quoteAgeSeconds) ? Number(quoteAgeSeconds.toFixed(1)) : null,
    bid: null, ask: null, spread: null, spreadToFastAtr: null, frames, frameWatches,
    directionRule: 'Combined bias requires all M15, H4, and daily completed-bar directions to agree. Individual timeframe watches are heuristic and use a last-close reference, not executable prices.'
  };
}

export async function fetchYahooFxUniverse(instruments, options = {}) {
  const observations = await Promise.all(instruments.map(async (instrument) => {
    try { return await fetchYahooFxObservation(instrument, options); }
    catch (error) { return { instrument, source: 'Yahoo Chart (public delayed/unofficial)', bias: 'DATA UNAVAILABLE', reason: error.message, frames: [], frameWatches: [] }; }
  }));
  return observations;
}
