import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from '../../shared/strategyConfig.js';
import { getForexMarketSession } from './marketSession.js';

const M15 = 15 * 60_000;

const timeOf = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);

function validCandle(row) {
  const mid = row?.mid;
  return row?.complete === true && Number.isFinite(timeOf(row.time))
    && ['o', 'h', 'l', 'c'].every((key) => hasExplicitPositiveFiniteAmount(mid?.[key]))
    && Number(mid.l) > 0 && Number(mid.l) <= Math.min(Number(mid.o), Number(mid.c))
    && Number(mid.h) >= Math.max(Number(mid.o), Number(mid.c));
}

function ema(values, period) {
  if (values.length < period) return NaN;
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const alpha = 2 / (period + 1);
  for (const value of values.slice(period)) result = alpha * value + (1 - alpha) * result;
  return result;
}

function atr(candles, period = 14) {
  const rows = candles.slice(-(period + 1));
  if (rows.length < period + 1) return NaN;
  const ranges = rows.slice(1).map((row, index) => Math.max(
    Number(row.mid.h) - Number(row.mid.l),
    Math.abs(Number(row.mid.h) - Number(rows[index].mid.c)),
    Math.abs(Number(row.mid.l) - Number(rows[index].mid.c)),
  ));
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

/**
 * Session-bounded M15 range breakout with H1 EMA trend alignment.
 * Requires completed OANDA candles, an executable bid/ask and a fresh,
 * source-backed operator review of scheduled catalysts.
 */
export function evaluateForexDayBreakout({ instrument, quote, m15, h1, now = Date.now(), sessionDate, catalystReview, config = {} }) {
  const reasons = [];
  const quoteTime = timeOf(quote?.time);
  const settings = {
    maxQuoteAgeMs: 120_000, maxBarAgeMs: 16 * 60_000, maxQuoteBarSkewMs: 16 * 60_000,
    breakoutBars: 8, breakoutBufferAtr: 0.05, stopAtr: 1.25, targetR: 2,
    maxSpreadAtr: 0.15, minRewardRisk: 1.5, noEntryBeforeExitMs: 15 * 60_000,
    quoteToUsd: NaN, roundTripFeesPerUnit: NaN, slippageReservePerUnit: NaN,
  };
  const invalidConfig = Object.keys(settings).some((key) => config[key] !== undefined && !hasExplicitFiniteAmount(config[key]));
  const get = (key) => hasExplicitFiniteAmount(config[key]) ? Number(config[key]) : Number(settings[key]);
  const marketSession = Number.isFinite(now) ? getForexMarketSession(now, { ...(config.marketCalendar || {}), instrument }) : null;
  const exitAt = marketSession?.closeAt ?? NaN;
  if (!/^[A-Z]{3}_[A-Z]{3}$/.test(String(instrument ?? ''))) reasons.push('invalid_fx_instrument');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate ?? '')) || !Number.isFinite(exitAt) || sessionDate !== marketSession?.marketDate) reasons.push('invalid_session_date');
  if (!Number.isFinite(now) || !marketSession?.isOpen || now >= exitAt - get('noEntryBeforeExitMs')) reasons.push('outside_fx_day_entry_window');
  if (!isFreshClearCatalystReview(catalystReview, { now, maxAgeMs: Number(config.maxCatalystReviewAgeMs ?? 30 * 60_000) })) reasons.push('scheduled_catalyst_status_unverified');
  if (invalidConfig) reasons.push('invalid_strategy_config');
  if (!Number.isFinite(quoteTime) || quoteTime > now + 5_000 || now - quoteTime > get('maxQuoteAgeMs')) reasons.push('stale_or_future_quote');
  const bid = hasExplicitPositiveFiniteAmount(quote?.bid) ? Number(quote.bid) : NaN;
  const ask = hasExplicitPositiveFiniteAmount(quote?.ask) ? Number(quote.ask) : NaN;
  if (!(bid > 0) || !(ask >= bid) || quote?.quality !== 'executable') reasons.push('executable_quote_required');

  const m15Bars = Array.isArray(m15) ? m15.filter(validCandle).sort((a, b) => timeOf(a.time) - timeOf(b.time)) : [];
  const h1Bars = Array.isArray(h1) ? h1.filter(validCandle).sort((a, b) => timeOf(a.time) - timeOf(b.time)) : [];
  if (new Set(m15Bars.map((row) => timeOf(row.time))).size !== m15Bars.length) reasons.push('duplicate_m15_candle_timestamps');
  if (new Set(h1Bars.map((row) => timeOf(row.time))).size !== h1Bars.length) reasons.push('duplicate_h1_candle_timestamps');
  const last = m15Bars.at(-1);
  if (m15Bars.length < Math.max(16, get('breakoutBars') + 1) || h1Bars.length < 50) reasons.push('insufficient_completed_history');
  if (!last || now - (timeOf(last.time) + M15) > get('maxBarAgeMs') || timeOf(last.time) + M15 > now) reasons.push('stale_or_incomplete_m15_bar');
  const lastH1 = h1Bars.at(-1);
  if (!lastH1 || now - (timeOf(lastH1.time) + 60 * 60_000) > 65 * 60_000 || timeOf(lastH1.time) + 60 * 60_000 > now) reasons.push('stale_or_incomplete_h1_bar');
  if (last && Number.isFinite(quoteTime) && Math.abs(quoteTime - (timeOf(last.time) + M15)) > get('maxQuoteBarSkewMs')) reasons.push('quote_bar_time_skew');

  const closes = h1Bars.map((row) => Number(row.mid.c));
  const h1Fast = ema(closes, 20), h1Slow = ema(closes, 50);
  const previous = m15Bars.slice(-(get('breakoutBars') + 1), -1);
  const rangeHigh = previous.length ? Math.max(...previous.map((row) => Number(row.mid.h))) : NaN;
  const rangeLow = previous.length ? Math.min(...previous.map((row) => Number(row.mid.l))) : NaN;
  const volatility = atr(m15Bars);
  if (!Number.isFinite(h1Fast) || !Number.isFinite(h1Slow) || !Number.isFinite(volatility) || volatility <= 0) reasons.push('trend_or_atr_unavailable');
  if (!hasExplicitNonNegativeFiniteAmount(config.roundTripFeesPerUnit)
    || !hasExplicitNonNegativeFiniteAmount(config.slippageReservePerUnit)
    || !(get('quoteToUsd') > 0)) reasons.push('usd_conversion_or_cost_reserve_missing');
  const conversionQuoteTime = config.conversionQuoteTime == null ? NaN : timeOf(config.conversionQuoteTime);
  if (config.conversionQuoteTime != null && (!Number.isFinite(conversionQuoteTime) || conversionQuoteTime > now + 5_000
    || now - conversionQuoteTime >= get('maxQuoteAgeMs'))) reasons.push('stale_or_future_conversion_quote');
  const usdQuoted = String(instrument ?? '').endsWith('_USD');
  if ((!usdQuoted || config.gainQuoteToUsd !== undefined) && (!hasExplicitFiniteAmount(config.gainQuoteToUsd)
    || !(Number(config.gainQuoteToUsd) > 0) || Number(config.gainQuoteToUsd) > get('quoteToUsd')))
    reasons.push('invalid_gain_conversion_factor');
  if (usdQuoted && (get('quoteToUsd') !== 1 || (config.gainQuoteToUsd !== undefined && Number(config.gainQuoteToUsd) !== 1)))
    reasons.push('usd_quote_currency_requires_unit_conversion');
  if (!(get('maxSpreadAtr') > 0) || !(get('targetR') >= get('minRewardRisk')) || !(get('stopAtr') > 0)) reasons.push('invalid_strategy_limits');
  const spread = ask - bid;
  if (Number.isFinite(volatility) && volatility > 0 && spread / volatility > get('maxSpreadAtr')) reasons.push('spread_exceeds_atr_limit');
  if (reasons.length) return { status: 'no-setup', strategy: 'forex-m15-range-breakout-h1-trend-v2', reasons: [...new Set(reasons)] };

  const lastClose = Number(last.mid.c);
  const trigger = volatility * get('breakoutBufferAtr');
  const long = h1Fast > h1Slow && lastClose > rangeHigh + trigger && ask > rangeHigh + trigger;
  const short = h1Fast < h1Slow && lastClose < rangeLow - trigger && bid < rangeLow - trigger;
  if (long === short) return { status: 'no-setup', strategy: 'forex-m15-range-breakout-h1-trend-v2', reasons: ['no_trend_aligned_range_breakout'] };
  const direction = long ? 'long' : 'short';
  const entryPrice = long ? ask : bid;
  const stopDistance = volatility * get('stopAtr');
  const stopPrice = entryPrice + (long ? -1 : 1) * stopDistance;
  const targetPrice = entryPrice + (long ? 1 : -1) * stopDistance * get('targetR');
  const quoteToUsd = get('quoteToUsd');
  const normalizedInstrument = instrument.toUpperCase();
  return {
    status: 'candidate', strategy: 'forex-m15-range-breakout-h1-trend-v2',
    candidate: {
      mode: 'paper', owner: 'forex', assetClass: 'forex', instrumentKey: normalizedInstrument,
      exposureKey: normalizedInstrument, strategyId: 'forex-m15-range-breakout-h1-trend-v2', sessionDate, sessionTimeZone: marketSession.timeZone,
      idempotencyKey: `${normalizedInstrument}:${sessionDate}:m15-range-breakout:${direction}`,
      direction, bid, ask, entryPrice, stopPrice, targetPrice,
      quoteTime: new Date(quoteTime).toISOString(), quoteQuality: 'executable', sessionOpen: true,
      // The risk ledger stores USD risk/notional. Convert the pair's quote currency to USD.
      multiplier: quoteToUsd, gainMultiplier: Number(config.gainQuoteToUsd ?? quoteToUsd),
      lotSize: 1, roundTripFeesPerUnit: get('roundTripFeesPerUnit'),
      slippageReservePerUnit: get('slippageReservePerUnit'),
      forceExitAt: new Date(exitAt).toISOString(),
      entryExpiresAt: new Date(Math.min(exitAt - get('noEntryBeforeExitMs'),
        Number.isFinite(conversionQuoteTime) ? conversionQuoteTime + get('maxQuoteAgeMs') : Infinity)).toISOString(),
      researchContext: { setupType: 'm15_range_breakout', observedAt: new Date(quoteTime).toISOString(),
        features: { atr14: volatility, h1_ema20: h1Fast, h1_ema50: h1Slow,
          range_high: rangeHigh, range_low: rangeLow, spread_atr: (ask - bid) / volatility } },
      marketGateTrace: { source: 'market_candidate_emission', owner: 'forex',
        strategyId: 'forex-m15-range-breakout-h1-trend-v2', observedAt: new Date(quoteTime).toISOString(),
        passedGates: ['session_entry_window', 'fresh_catalyst_review', 'fresh_executable_quote',
          'completed_m15_h1_history', 'spread_within_atr', 'usd_conversion_and_costs',
          'trend_aligned_range_breakout'] },
      signal: { strategy: 'forex-m15-range-breakout-h1-trend-v2', rangeHigh, rangeLow, atr14: volatility, h1Ema20: h1Fast, h1Ema50: h1Slow, latestCompletedBarAt: new Date(timeOf(last.time) + M15).toISOString(),
        catalystReview: { source: catalystReview.source.trim(), summary: catalystReview.summary.trim().slice(0, 240), reviewedAt: new Date(Number.isFinite(Number(catalystReview.reviewedAt)) ? Number(catalystReview.reviewedAt) : Date.parse(catalystReview.reviewedAt)).toISOString() } },
    },
  };
}
