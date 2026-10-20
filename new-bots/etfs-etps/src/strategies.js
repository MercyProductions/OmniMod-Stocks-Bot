import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { stockQuoteEvidenceRejection, normalizeStockQuoteEvidence } from '../../shared/stockQuoteEvidence.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from '../../shared/strategyConfig.js';

const FIVE_MINUTES = 5 * 60_000;
const REVIEWED_ETP_TYPES = new Set(['etn', 'etv', 'commodity_pool', 'leveraged_etf', 'inverse_etf']);
const REVIEW_MAX_AGE_MS = 180 * 24 * 60 * 60_000;

function hasValidEtpClassification({ productType, exposureKey, leverage, inverse, classificationSourceUrl, classificationReviewedAt }, now) {
  const type = String(productType || '').toLowerCase();
  const key = String(exposureKey || '').trim().toUpperCase();
  const multiplier = hasExplicitFiniteAmount(leverage) ? Number(leverage) : NaN;
  const reviewedAt = Date.parse(classificationReviewedAt || '');
  let sourceIsValid = false;
  try {
    const source = new URL(String(classificationSourceUrl || ''));
    sourceIsValid = source.protocol === 'https:' && Boolean(source.hostname) && !source.username && !source.password
      && String(classificationSourceUrl).length <= 500;
  } catch { /* invalid or absent URL */ }
  const freshnessValid = Number.isFinite(reviewedAt) && reviewedAt <= now + 5_000 && now - reviewedAt <= REVIEW_MAX_AGE_MS;
  const exposureValid = /^[A-Z][A-Z0-9._-]{0,19}$/.test(key);
  const leverageValid = Number.isFinite(multiplier) && multiplier !== 0 && multiplier >= -5 && multiplier <= 5
    && (inverse === true) === (multiplier < 0)
    && (type !== 'leveraged_etf' || multiplier > 1)
    && (type !== 'inverse_etf' || multiplier <= -1);
  return REVIEWED_ETP_TYPES.has(type) && sourceIsValid && freshnessValid && exposureValid && leverageValid;
}

function timestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return Date.parse(value);
}

function validBar(bar) {
  return Number.isFinite(timestamp(bar?.time))
    && ['open', 'high', 'low', 'close', 'volume'].every((key) => hasExplicitFiniteAmount(bar?.[key]))
    && Number(bar.low) > 0 && Number(bar.low) <= Math.min(Number(bar.open), Number(bar.close))
    && Number(bar.high) >= Math.max(Number(bar.open), Number(bar.close))
    && Number(bar.volume) > 0;
}

function atr(bars) {
  const rows = bars.slice(-15);
  if (rows.length < 15) return NaN;
  const ranges = rows.slice(1).map((bar, index) => Math.max(
    Number(bar.high) - Number(bar.low),
    Math.abs(Number(bar.high) - Number(rows[index].close)),
    Math.abs(Number(bar.low) - Number(rows[index].close)),
  ));
  return ranges.reduce((sum, x) => sum + x, 0) / ranges.length;
}

/** Compare a completed bar with prior completed bars from the same session slot. */
export function calculateTimeOfDayRelativeVolume({ observations = [], marketDate, sessionOpenTime, barTime, barVolume, now = Date.now(), minSessions = 5 } = {}) {
  const currentOpen = timestamp(sessionOpenTime), currentBarTime = timestamp(barTime);
  if (!Array.isArray(observations) || !/^\d{4}-\d{2}-\d{2}$/.test(String(marketDate || ''))
    || !Number.isFinite(currentOpen) || !Number.isFinite(currentBarTime) || !Number.isFinite(now)
    || !hasExplicitPositiveFiniteAmount(barVolume) || !Number.isInteger(minSessions) || minSessions < 1) {
    return { status: 'invalid_input', ratio: null, baselineVolume: null, sampleSessions: 0, slotIndex: null };
  }
  const slotIndex = Math.floor((currentBarTime - currentOpen) / FIVE_MINUTES);
  if (slotIndex < 0 || currentBarTime + FIVE_MINUTES > now) {
    return { status: 'current_bar_incomplete_or_outside_session', ratio: null, baselineVolume: null, sampleSessions: 0, slotIndex };
  }
  const byDate = new Map();
  for (const row of observations) {
    const date = String(row?.marketDate ?? '');
    const open = timestamp(row?.sessionOpenTime), time = timestamp(row?.time);
    const volume = hasExplicitPositiveFiniteAmount(row?.volume) ? Number(row.volume) : NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= marketDate || !Number.isFinite(open)
      || !Number.isFinite(time) || time + FIVE_MINUTES > now || !(volume > 0)
      || Math.floor((time - open) / FIVE_MINUTES) !== slotIndex) continue;
    const prior = byDate.get(date);
    if (!prior || time >= prior.time) byDate.set(date, { time, volume });
  }
  const values = [...byDate.values()].map((row) => row.volume);
  if (values.length < minSessions) return { status: 'insufficient_prior_sessions', ratio: null,
    baselineVolume: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null,
    sampleSessions: values.length, slotIndex };
  const baselineVolume = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { status: 'available', ratio: Number((Number(barVolume) / baselineVolume).toFixed(4)),
    baselineVolume: Number(baselineVolume.toFixed(2)), sampleSessions: values.length, slotIndex };
}

/**
 * Session-aware 15-minute opening-range breakout for liquid ETFs/ETPs.
 * The caller must supply completed 5-minute bars and a synchronized executable quote.
 * This returns a paper candidate; it never submits or simulates an order fill.
 */
export function evaluateOpeningRangeBreakout({
  symbol, exposureKey, assetClass = 'etf', productType, leverage, inverse, classificationSourceUrl, classificationReviewedAt,
  bars, quote, session, now = Date.now(), config = {},
}) {
  const reasons = [];
  const numericSettings = {
    rangeBars: 3, minHistoryBars: 24, maxQuoteAgeMs: 15_000, maxQuoteBarSkewMs: 90_000,
    minRelativeVolume: 1.5, breakoutBufferAtr: 0.05, breakoutBufferBps: 5, maxStopPct: 1.25,
    minRewardRisk: 1.5, targetRewardRisk: 2, noNewEntryMinutesBeforeClose: 30,
    roundTripFeesPerUnit: NaN, slippageReservePerUnit: NaN,
  };
  const invalidConfig = Object.keys(numericSettings).some((key) => config[key] !== undefined && !hasExplicitFiniteAmount(config[key]))
    || !Number.isInteger(Number(config.rangeBars ?? numericSettings.rangeBars))
    || Number(config.rangeBars ?? numericSettings.rangeBars) < numericSettings.rangeBars
    || Number(config.rangeBars ?? numericSettings.rangeBars) > 12
    || !Number.isInteger(Number(config.minHistoryBars ?? numericSettings.minHistoryBars))
    || Number(config.minHistoryBars ?? numericSettings.minHistoryBars) < numericSettings.minHistoryBars
    || !(Number(config.maxQuoteAgeMs ?? numericSettings.maxQuoteAgeMs) > 0)
    || Number(config.maxQuoteAgeMs ?? numericSettings.maxQuoteAgeMs) > numericSettings.maxQuoteAgeMs
    || !(Number(config.maxQuoteBarSkewMs ?? numericSettings.maxQuoteBarSkewMs) > 0)
    || Number(config.maxQuoteBarSkewMs ?? numericSettings.maxQuoteBarSkewMs) > numericSettings.maxQuoteBarSkewMs
    || Number(config.minRelativeVolume ?? numericSettings.minRelativeVolume) < numericSettings.minRelativeVolume
    || Number(config.breakoutBufferAtr ?? numericSettings.breakoutBufferAtr) < numericSettings.breakoutBufferAtr
    || Number(config.breakoutBufferBps ?? numericSettings.breakoutBufferBps) < numericSettings.breakoutBufferBps
    || !(Number(config.maxStopPct ?? numericSettings.maxStopPct) > 0)
    || Number(config.maxStopPct ?? numericSettings.maxStopPct) > numericSettings.maxStopPct
    || Number(config.minRewardRisk ?? numericSettings.minRewardRisk) < numericSettings.minRewardRisk
    || Number(config.targetRewardRisk ?? numericSettings.targetRewardRisk) < numericSettings.targetRewardRisk
    || Number(config.noNewEntryMinutesBeforeClose ?? numericSettings.noNewEntryMinutesBeforeClose) < numericSettings.noNewEntryMinutesBeforeClose;
  const setting = (key) => hasExplicitFiniteAmount(config[key]) ? Number(config[key]) : numericSettings[key];
  const rangeBars = Math.max(3, Math.floor(setting('rangeBars')));
  const minHistoryBars = Math.max(15, Math.floor(setting('minHistoryBars')));
  const maxQuoteAgeMs = Math.max(1_000, Math.min(numericSettings.maxQuoteAgeMs, setting('maxQuoteAgeMs')));
  const maxQuoteBarSkewMs = Math.max(1_000, Math.min(numericSettings.maxQuoteBarSkewMs, setting('maxQuoteBarSkewMs')));
  const minRelativeVolume = Math.max(numericSettings.minRelativeVolume, setting('minRelativeVolume'));
  const breakoutBufferAtr = Math.max(numericSettings.breakoutBufferAtr, setting('breakoutBufferAtr'));
  const breakoutBufferBps = Math.max(numericSettings.breakoutBufferBps, setting('breakoutBufferBps'));
  const stopAtOrMid = config.stopAtOpeningRangeMidpoint !== false;
  const maxStopPct = Math.max(0.01, Math.min(numericSettings.maxStopPct, setting('maxStopPct')));
  const minRewardRisk = Math.max(numericSettings.minRewardRisk, setting('minRewardRisk'));
  const targetRewardRisk = Math.max(minRewardRisk, setting('targetRewardRisk'));
  const closeBufferMs = Math.max(numericSettings.noNewEntryMinutesBeforeClose, setting('noNewEntryMinutesBeforeClose')) * 60_000;
  const marketDate = String(session?.marketDate ?? '');
  const openTime = timestamp(session?.openTime), closeTime = timestamp(session?.closeTime);
  const quoteTime = timestamp(quote?.time);

  if (!symbol || !marketDate || !Number.isFinite(openTime) || !Number.isFinite(closeTime) || closeTime <= openTime) reasons.push('invalid_symbol_or_session');
  if (!['etf', 'etp'].includes(String(assetClass).toLowerCase())) reasons.push('unsupported_instrument_type');
  if (String(assetClass).toLowerCase() === 'etp' && !hasValidEtpClassification({ productType, exposureKey, leverage, inverse, classificationSourceUrl, classificationReviewedAt }, now))
    reasons.push('etp_classification_missing_stale_or_invalid');
  if (!Number.isFinite(now) || now < openTime || now >= closeTime - closeBufferMs) reasons.push('outside_entry_window');
  if (session?.marketHalted === true) reasons.push('market_halt');
  if (session?.catalystBlocked === true) reasons.push('catalyst_blackout');
  if (config.requireCatalystReview === true && !isFreshClearCatalystReview(session?.catalystReview, {
    now, maxAgeMs: Number(config.maxCatalystReviewAgeMs || 30 * 60_000),
  })) reasons.push('catalyst_review_missing_stale_or_unclear');
  if (invalidConfig) reasons.push('invalid_strategy_config');
  if (!hasExplicitNonNegativeFiniteAmount(config.roundTripFeesPerUnit)
    || !hasExplicitNonNegativeFiniteAmount(config.slippageReservePerUnit)) reasons.push('cost_reserve_missing_or_invalid');
  if (!Array.isArray(bars) || bars.length < minHistoryBars) reasons.push('insufficient_intraday_history');
  if (quote?.quality !== 'executable') reasons.push('quote_not_executable');
  if (!Number.isFinite(quoteTime) || quoteTime > now + 5_000 || now - quoteTime > maxQuoteAgeMs) reasons.push('stale_or_future_quote');
  const bid = hasExplicitPositiveFiniteAmount(quote?.bid) ? Number(quote.bid) : NaN;
  const ask = hasExplicitPositiveFiniteAmount(quote?.ask) ? Number(quote.ask) : NaN;
  if (!(bid > 0) || !(ask >= bid)) reasons.push('invalid_bid_ask');
  const evidenceReason = stockQuoteEvidenceRejection(String(symbol).toUpperCase(), quote?.stockQuoteEvidence,
    { bid, ask, time: Number.isFinite(quoteTime) ? new Date(quoteTime).toISOString() : null }, 'sip');
  if (evidenceReason) reasons.push(evidenceReason);

  const completed = Array.isArray(bars) ? bars.filter((bar) => validBar(bar) && timestamp(bar.time) + FIVE_MINUTES <= now).sort((a, b) => timestamp(a.time) - timestamp(b.time)) : [];
  const sameSession = completed.filter((bar) => timestamp(bar.time) >= openTime && timestamp(bar.time) < closeTime);
  if (sameSession.length < minHistoryBars) reasons.push('insufficient_completed_session_bars');
  for (let index = 1; index < sameSession.length; index += 1) {
    if (timestamp(sameSession[index].time) - timestamp(sameSession[index - 1].time) !== FIVE_MINUTES) {
      reasons.push('intraday_history_has_gap');
      break;
    }
  }
  const firstRange = sameSession.slice(0, rangeBars);
  if (firstRange.length === rangeBars) {
    for (let index = 0; index < rangeBars; index += 1) {
      if (timestamp(firstRange[index].time) !== openTime + index * FIVE_MINUTES) reasons.push('opening_range_has_gap');
    }
  }
  const last = sameSession.at(-1);
  const previous = sameSession.at(-2);
  if (!last || !previous || timestamp(last.time) - timestamp(previous.time) !== FIVE_MINUTES) reasons.push('latest_bars_have_gap');
  if (last && Number.isFinite(quoteTime) && Math.abs(quoteTime - (timestamp(last.time) + FIVE_MINUTES)) > maxQuoteBarSkewMs) reasons.push('quote_bar_time_skew');
  if (session?.expectedBarsThroughNow === true && last && now - (timestamp(last.time) + FIVE_MINUTES) > maxQuoteBarSkewMs) reasons.push('intraday_bars_stale');

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length) return { status: 'no-setup', strategy: 'etp-opening-range-breakout-v1', reasons: uniqueReasons };

  const openingHigh = Math.max(...firstRange.map((bar) => Number(bar.high)));
  const openingLow = Math.min(...firstRange.map((bar) => Number(bar.low)));
  const openingMid = (openingHigh + openingLow) / 2;
  const totalVolume = sameSession.reduce((sum, bar) => sum + Number(bar.volume), 0);
  const cumulativeTypicalPriceVolume = sameSession.reduce((sum, bar) => sum + ((Number(bar.high) + Number(bar.low) + Number(bar.close)) / 3) * Number(bar.volume), 0);
  const vwap = cumulativeTypicalPriceVolume / totalVolume;
  const rangeAtr = atr(sameSession);
  const priorVolumes = sameSession.slice(-21, -1).map((bar) => Number(bar.volume));
  const volumeBaseline = priorVolumes.length ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length : NaN;
  const relativeVolume = Number(last.volume) / volumeBaseline;
  const timeOfDayRelativeVolume = calculateTimeOfDayRelativeVolume({
    observations: Array.isArray(session?.priorSessionVolumeBars) ? session.priorSessionVolumeBars : [],
    marketDate, sessionOpenTime: openTime, barTime: timestamp(last.time), barVolume: Number(last.volume), now,
    minSessions: Number.isInteger(config.timeOfDayVolumeMinSessions) ? config.timeOfDayVolumeMinSessions : 5,
  });
  const buffer = Math.max(rangeAtr * breakoutBufferAtr, Number(last.close) * breakoutBufferBps / 10_000);
  const longBreakout = Number(last.close) > openingHigh + buffer && Number(last.close) > vwap
    && ask >= openingHigh + buffer && relativeVolume >= minRelativeVolume;
  const shortBreakout = Number(last.close) < openingLow - buffer && Number(last.close) < vwap
    && bid <= openingLow - buffer && relativeVolume >= minRelativeVolume;
  if (!Number.isFinite(rangeAtr) || !(rangeAtr > 0)) return { status: 'no-setup', strategy: 'etp-opening-range-breakout-v1', reasons: ['atr_unavailable'] };
  if (longBreakout === shortBreakout) return { status: 'no-setup', strategy: 'etp-opening-range-breakout-v1', reasons: ['no_unique_confirmed_breakout'] };

  const direction = longBreakout ? 'long' : 'short';
  const entryPrice = direction === 'long' ? ask : bid;
  const stopPrice = stopAtOrMid ? openingMid : direction === 'long' ? openingHigh : openingLow;
  const stopDistance = Math.abs(entryPrice - stopPrice);
  const stopPct = stopDistance / entryPrice * 100;
  if (!(stopDistance > 0) || stopPct > maxStopPct) return { status: 'no-setup', strategy: 'etp-opening-range-breakout-v1', reasons: ['stop_distance_out_of_bounds'] };
  const targetPrice = entryPrice + (direction === 'long' ? 1 : -1) * stopDistance * targetRewardRisk;
  const marketSide = String(session.marketSide ?? 'equity-us');
  const costs = {
    roundTripFeesPerUnit: Number(config.roundTripFeesPerUnit),
    slippageReservePerUnit: Number(config.slippageReservePerUnit),
  };
  const declaredExposureMultiplier = hasExplicitFiniteAmount(leverage) ? Number(leverage) : NaN;
  const exposureMultiplier = Number.isFinite(declaredExposureMultiplier) ? Math.abs(declaredExposureMultiplier) : 1;
  const normalizedProductType = String(productType || '').toLowerCase();
  const riskNotices = [];
  if (['leveraged_etf', 'inverse_etf'].includes(normalizedProductType) || (normalizedProductType === 'etn' && exposureMultiplier !== 1)) {
    riskNotices.push('daily_reset_path_risk');
  }
  if (normalizedProductType === 'etn') riskNotices.push('issuer_credit_risk_not_modeled');
  if (normalizedProductType === 'commodity_pool') riskNotices.push('futures_roll_risk_not_modeled');
  const idempotencyKey = `${String(symbol).toUpperCase()}:${marketDate}:etp-orb:${direction}`;
  return {
    status: 'candidate', strategy: 'etp-opening-range-breakout-v1',
    candidate: {
      mode: 'paper', owner: 'etfs-etps', assetClass: String(assetClass).toLowerCase(), instrumentKey: String(symbol).toUpperCase(),
      strategyId: 'etp-opening-range-breakout-v1', sessionDate: marketDate, sessionTimeZone: session?.timeZone || 'America/New_York', forceExitAt: new Date(closeTime).toISOString(),
      entryExpiresAt: new Date(closeTime - closeBufferMs).toISOString(),
      exposureKey: String(exposureKey || symbol).toUpperCase(), idempotencyKey, direction,
      exposureMultiplier,
      instrumentMetadata: productType ? { productType: String(productType).slice(0, 40), leverage: hasExplicitFiniteAmount(leverage) ? Number(leverage) : null,
        inverse: inverse === true, classificationSourceUrl: /^https:\/\//i.test(String(classificationSourceUrl || '')) ? String(classificationSourceUrl).slice(0, 300) : null,
        classificationReviewedAt: Number.isFinite(Date.parse(classificationReviewedAt || '')) ? new Date(Date.parse(classificationReviewedAt)).toISOString() : null,
        riskNotices } : null,
      bid, ask, entryPrice, stopPrice, targetPrice, quoteTime: new Date(quoteTime).toISOString(),
      stockQuoteEvidence: normalizeStockQuoteEvidence(quote.stockQuoteEvidence),
      quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
      ...costs,
      researchContext: { setupType: 'opening_range_breakout', observedAt: new Date(quoteTime).toISOString(),
        discoveryVersion: session?.discoveryVersion ?? 'unspecified',
        features: { opening_high: openingHigh, opening_low: openingLow, vwap,
          atr14: rangeAtr, relative_volume: relativeVolume, time_of_day_relative_volume: timeOfDayRelativeVolume } },
      marketGateTrace: { source: 'market_candidate_emission', owner: 'etfs-etps',
        strategyId: 'etp-opening-range-breakout-v1', observedAt: new Date(quoteTime).toISOString(),
        passedGates: ['supported_instrument_type', 'session_entry_window', 'fresh_executable_quote', 'native_consolidated_quote_evidence',
          'completed_intraday_bars', 'opening_range_breakout', 'vwap_alignment',
          'relative_volume', 'stop_distance',
          ...(String(assetClass).toLowerCase() === 'etp' ? ['reviewed_etp_classification'] : []),
          ...(config.requireCatalystReview === true ? ['fresh_catalyst_review'] : [])] },
      signal: { strategy: 'etp-opening-range-breakout-v1', marketDate, openingHigh, openingLow, openingMid, vwap, atr14: rangeAtr, relativeVolume,
        discoveryVersion: session?.discoveryVersion ?? 'unspecified',
        relativeVolumeBasis: 'latest completed bar divided by mean of up to 20 preceding completed bars in the current session',
        timeOfDayRelativeVolume, breakoutBuffer: buffer, latestCompletedBarAt: new Date(timestamp(last.time) + FIVE_MINUTES).toISOString(), sessionSide: marketSide,
        catalystReview: session?.catalystReview ? { source: String(session.catalystReview.source).slice(0, 120), summary: String(session.catalystReview.summary).slice(0, 240), reviewedAt: session.catalystReview.reviewedAt } : null,
        catalystNews: Array.isArray(session?.catalystNews) ? session.catalystNews.slice(0, 10) : [] },
    },
  };
}
