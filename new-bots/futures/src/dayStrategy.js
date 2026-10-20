import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from '../../shared/strategyConfig.js';
import { parseFuturesExpiry } from './universe.js';
import { validateFuturesSettlementReview } from './contractReview.js';

const FIVE_MINUTES = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const at = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);

function localDateAt(timestamp, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return null; }
}

/** Validate the supplied session clock/date relationship, not the exchange calendar itself. */
export function validateFuturesSession(session = {}, { now = Date.now(), maxReviewAgeMs = 24 * 60 * 60_000 } = {}) {
  const marketDate = String(session.marketDate ?? '').trim();
  const openTime = at(session.openTime), closeTime = at(session.closeTime);
  const timeZone = String(session.timeZone || 'America/Chicago').trim();
  const reasons = [];
  const dayStart = Date.parse(`${marketDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marketDate) || !Number.isFinite(dayStart)
    || new Date(dayStart).toISOString().slice(0, 10) !== marketDate) reasons.push('invalid_or_missing_session_date');
  if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || closeTime <= openTime) reasons.push('invalid_session_timestamps');
  else if (closeTime - openTime > 24 * 60 * 60_000) reasons.push('session_duration_exceeds_24_hours');
  const reviewedAt = at(session.reviewedAt);
  let sourceValid = false;
  try {
    const source = new URL(String(session.source || ''));
    sourceValid = source.protocol === 'https:' && Boolean(source.hostname) && !source.username && !source.password;
  } catch { /* A source URL is required for a trade-eligible exchange session. */ }
  if (!sourceValid || !Number.isFinite(now) || !Number.isFinite(reviewedAt) || reviewedAt > now + 5_000
    || !Number.isFinite(maxReviewAgeMs) || maxReviewAgeMs <= 0 || now - reviewedAt > maxReviewAgeMs)
    reasons.push('session_source_or_freshness_invalid');
  const openDate = Number.isFinite(openTime) ? localDateAt(openTime, timeZone) : null;
  const closeDate = Number.isFinite(closeTime) ? localDateAt(closeTime, timeZone) : null;
  if (!openDate || !closeDate) reasons.push('session_timezone_invalid');
  else if (Number.isFinite(dayStart)) {
    const previousDate = new Date(dayStart - DAY_MS).toISOString().slice(0, 10);
    if (closeDate !== marketDate || ![marketDate, previousDate].includes(openDate)) reasons.push('session_timezone_date_mismatch');
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], marketDate, timeZone, openTime, closeTime,
    source: sourceValid ? String(session.source) : '', reviewedAt: Number.isFinite(reviewedAt) ? new Date(reviewedAt).toISOString() : '' };
}

function validBar(bar) {
  return Number.isFinite(at(bar?.time)) && ['open', 'high', 'low', 'close', 'volume'].every((key) => hasExplicitFiniteAmount(bar?.[key]))
    && Number(bar.low) > 0 && Number(bar.low) <= Math.min(Number(bar.open), Number(bar.close))
    && Number(bar.high) >= Math.max(Number(bar.open), Number(bar.close)) && Number(bar.volume) > 0;
}

function ema(values, period) {
  if (values.length < period) return NaN;
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / period;
  const alpha = 2 / (period + 1);
  for (const x of values.slice(period)) value = alpha * x + (1 - alpha) * value;
  return value;
}

function atr(bars, period = 14) {
  const rows = bars.slice(-(period + 1));
  if (rows.length < period + 1) return NaN;
  const ranges = rows.slice(1).map((bar, i) => Math.max(Number(bar.high) - Number(bar.low), Math.abs(Number(bar.high) - Number(rows[i].close)), Math.abs(Number(bar.low) - Number(rows[i].close))));
  return ranges.reduce((sum, x) => sum + x, 0) / ranges.length;
}

const floorTick = (value, tick) => Math.floor(value / tick + 1e-10) * tick;
const ceilTick = (value, tick) => Math.ceil(value / tick - 1e-10) * tick;

/** The Live MBP-1 adapter exposes only top-level displayed size, not guaranteed fillable depth. */
export function enforceFuturesTopBookDepth(decision, quote) {
  if (decision?.status !== 'paper-approved') return decision;
  const units = hasExplicitPositiveFiniteAmount(decision.sizing?.units) ? Number(decision.sizing.units) : NaN;
  const bidSize = hasExplicitNonNegativeFiniteAmount(quote?.bidSize) ? Number(quote.bidSize) : NaN;
  const askSize = hasExplicitNonNegativeFiniteAmount(quote?.askSize) ? Number(quote.askSize) : NaN;
  if (!(units > 0) || !(bidSize >= units && askSize >= units)) return {
    ...decision, status: 'risk-blocked',
    reasons: [...(decision.reasons ?? []), 'displayed_top_book_size_below_paper_quantity'],
  };
  return decision;
}

/**
 * Active-contract 15-minute opening-range breakout. This creates paper candidates
 * only and requires licensed/executable contract-specific inputs from its caller.
 */
export function evaluateFuturesOpeningRange({ contract, bars, trendBars, quote, session, now = Date.now(), catalystReview, accountEquityUsd, config = {}, discoveryContext }) {
  const reasons = [];
  const settings = { rangeBars: 3, minSessionBars: 24, maxQuoteAgeMs: 5_000, maxBarAgeMs: 6 * 60_000,
    maxSpreadTicks: 2, minRelativeVolume: 1.5, breakoutBufferAtr: 0.05, targetR: 2,
    noEntryBeforeCloseMs: 30 * 60_000, maxInitialMarginPct: 25,
    deliveryEntryBufferHours: 24,
    roundTripFeesPerContract: NaN, slippageReservePerContract: NaN };
  const invalidConfig = Object.keys(settings).some((key) => config[key] !== undefined && !Number.isFinite(Number(config[key])))
    || (config.maxInitialMarginPct !== undefined
      && (!(Number(config.maxInitialMarginPct) > 0) || Number(config.maxInitialMarginPct) > settings.maxInitialMarginPct))
    || !Number.isInteger(Number(config.rangeBars ?? settings.rangeBars))
    || Number(config.rangeBars ?? settings.rangeBars) < settings.rangeBars
    || Number(config.rangeBars ?? settings.rangeBars) > 12
    || !Number.isInteger(Number(config.minSessionBars ?? settings.minSessionBars))
    || Number(config.minSessionBars ?? settings.minSessionBars) < settings.minSessionBars
    || !(Number(config.maxQuoteAgeMs ?? settings.maxQuoteAgeMs) > 0)
    || Number(config.maxQuoteAgeMs ?? settings.maxQuoteAgeMs) > settings.maxQuoteAgeMs
    || !(Number(config.maxBarAgeMs ?? settings.maxBarAgeMs) > 0)
    || Number(config.maxBarAgeMs ?? settings.maxBarAgeMs) > settings.maxBarAgeMs
    || !(Number(config.maxSpreadTicks ?? settings.maxSpreadTicks) > 0)
    || Number(config.maxSpreadTicks ?? settings.maxSpreadTicks) > settings.maxSpreadTicks
    || Number(config.minRelativeVolume ?? settings.minRelativeVolume) < settings.minRelativeVolume
    || Number(config.breakoutBufferAtr ?? settings.breakoutBufferAtr) < settings.breakoutBufferAtr
    || Number(config.targetR ?? settings.targetR) < 1.5
    || Number(config.noEntryBeforeCloseMs ?? settings.noEntryBeforeCloseMs) < settings.noEntryBeforeCloseMs
    || Number(config.deliveryEntryBufferHours ?? settings.deliveryEntryBufferHours) < settings.deliveryEntryBufferHours
    || Number(config.deliveryEntryBufferHours ?? settings.deliveryEntryBufferHours) > 720;
  const get = (key) => Number(config[key] ?? settings[key]);
  // Keep session-review freshness on the same decision clock as the quote,
  // bars, catalyst, and contract checks. In chronological replay, using the
  // process wall clock would incorrectly expire otherwise point-in-time
  // session metadata and prevent a valid historical strategy evaluation.
  const sessionClock = validateFuturesSession(session, { now });
  const { openTime: open, closeTime: close, marketDate, timeZone } = sessionClock;
  const quoteAt = at(quote?.time);
  const tick = hasExplicitPositiveFiniteAmount(contract?.tickSize) ? Number(contract.tickSize) : NaN;
  const multiplier = hasExplicitPositiveFiniteAmount(contract?.multiplier) ? Number(contract.multiplier) : NaN;
  const tickValueUsd = hasExplicitPositiveFiniteAmount(contract?.tickValueUsd) ? Number(contract.tickValueUsd) : NaN;
  const initialMarginUsd = hasExplicitPositiveFiniteAmount(contract?.initialMarginUsd) ? Number(contract.initialMarginUsd) : NaN;
  const maintenanceMarginUsd = hasExplicitPositiveFiniteAmount(contract?.maintenanceMarginUsd) ? Number(contract.maintenanceMarginUsd) : NaN;
  if (contract?.contractMode !== 'active-contract' || contract?.contractSpecVerified !== true || contract?.activeContract !== true) reasons.push('verified_active_contract_required');
  const expiryAt = parseFuturesExpiry(contract?.expiryAt ?? contract?.expiry);
  if (!contract?.contractId || !Number.isFinite(expiryAt) || expiryAt <= now) reasons.push('invalid_or_expired_contract');
  if (get('deliveryEntryBufferHours') < settings.deliveryEntryBufferHours || get('deliveryEntryBufferHours') > 720) reasons.push('invalid_delivery_entry_buffer');
  const settlementReview = validateFuturesSettlementReview(contract, { now,
    maxReviewAgeMs: Number(config.maxSettlementReviewAgeMs ?? 90 * 24 * 60 * 60_000),
    entryBufferMs: Math.max(0, get('deliveryEntryBufferHours')) * 60 * 60_000 });
  reasons.push(...settlementReview.reasons);
  if (!(tick > 0) || !(multiplier > 0) || !(tickValueUsd > 0)
    || Math.abs(tickValueUsd - tick * multiplier) > Math.max(0.01, tickValueUsd * 0.001)
    || !(initialMarginUsd > 0) || !(maintenanceMarginUsd > 0)
    || maintenanceMarginUsd > initialMarginUsd) reasons.push('contract_spec_or_margin_invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marketDate) || !Number.isFinite(open) || !Number.isFinite(close) || close <= open
    || now < open || now >= close - get('noEntryBeforeCloseMs')) reasons.push('outside_exchange_session_entry_window');
  reasons.push(...sessionClock.reasons.filter((reason) => reason !== 'invalid_or_missing_session_date'));
  if (session?.marketHalted === true) reasons.push('exchange_halt');
  if (session?.catalystBlocked === true || !isFreshClearCatalystReview(catalystReview, {
    now, maxAgeMs: Number(config.maxCatalystReviewAgeMs ?? 30 * 60_000),
  })) reasons.push('catalyst_blackout_or_unverified');
  if (invalidConfig) reasons.push('invalid_strategy_config');
  const bid = hasExplicitPositiveFiniteAmount(quote?.bid) ? Number(quote.bid) : NaN;
  const ask = hasExplicitPositiveFiniteAmount(quote?.ask) ? Number(quote.ask) : NaN;
  if (quote?.quality !== 'executable' || !(bid > 0) || !(ask >= bid)) reasons.push('executable_bid_ask_required');
  if (!Number.isFinite(quoteAt) || quoteAt > now + 2_000 || now - quoteAt > get('maxQuoteAgeMs')) reasons.push('stale_or_future_quote');
  if (!hasExplicitNonNegativeFiniteAmount(config.roundTripFeesPerContract)
    || !hasExplicitNonNegativeFiniteAmount(config.slippageReservePerContract)) reasons.push('cost_reserve_missing_or_invalid');
  const equity = hasExplicitPositiveFiniteAmount(accountEquityUsd) ? Number(accountEquityUsd) : NaN;
  if (!(equity > 0) || initialMarginUsd > equity * get('maxInitialMarginPct') / 100) reasons.push('initial_margin_exceeds_budget');

  const completed = Array.isArray(bars) ? bars.filter(validBar).filter((bar) => at(bar.time) + FIVE_MINUTES <= now && at(bar.time) >= open && at(bar.time) < close).sort((a, b) => at(a.time) - at(b.time)) : [];
  if (completed.length < get('minSessionBars')) reasons.push('insufficient_completed_session_bars');
  for (let i = 1; i < completed.length; i += 1) if (at(completed[i].time) - at(completed[i - 1].time) !== FIVE_MINUTES) { reasons.push('session_bars_have_gap'); break; }
  if (!completed.length || now - (at(completed.at(-1).time) + FIVE_MINUTES) > get('maxBarAgeMs')) reasons.push('stale_intraday_bars');
  if (completed[0] && at(completed[0].time) !== open) reasons.push('opening_range_start_mismatch');
  if (completed.at(-1) && Number.isFinite(quoteAt) && Math.abs(quoteAt - (at(completed.at(-1).time) + FIVE_MINUTES)) > get('maxBarAgeMs')) reasons.push('quote_bar_time_skew');
  const opening = completed.slice(0, get('rangeBars'));
  if (opening.length !== get('rangeBars') || opening.some((bar, i) => at(bar.time) !== open + i * FIVE_MINUTES)) reasons.push('opening_range_incomplete');
  const h1 = Array.isArray(trendBars) ? trendBars.filter((bar) => validBar(bar) && at(bar.time) + 60 * 60_000 <= now).sort((a, b) => at(a.time) - at(b.time)) : [];
  const h1Times = h1.map((bar) => at(bar.time));
  if (new Set(h1Times).size !== h1Times.length) reasons.push('h1_trend_bars_have_duplicate_timestamps');
  const latestH1 = h1.at(-1);
  if (h1.length < 50 || !latestH1 || now - (at(latestH1.time) + 60 * 60_000) > 65 * 60_000) reasons.push('h1_trend_history_stale_or_insufficient');
  const volatility = atr(completed), last = completed.at(-1), previous = completed.at(-2);
  if (!(volatility > 0) || !last || !previous) reasons.push('atr_or_latest_bar_unavailable');
  const unique = [...new Set(reasons)];
  if (unique.length) return { status: 'no-setup', strategy: 'future-session-orb-h1-v1', reasons: unique };

  const openingHigh = Math.max(...opening.map((bar) => Number(bar.high)));
  const openingLow = Math.min(...opening.map((bar) => Number(bar.low)));
  const rangeMid = (openingHigh + openingLow) / 2;
  const closePrices = h1.map((bar) => Number(bar.close));
  const ema20 = ema(closePrices, 20), ema50 = ema(closePrices, 50);
  const triggerBuffer = volatility * get('breakoutBufferAtr');
  const relativeVolume = Number(last.volume) / (completed.slice(-21, -1).reduce((sum, bar) => sum + Number(bar.volume), 0) / Math.max(1, completed.slice(-21, -1).length));
  const spreadTicks = (ask - bid) / tick;
  if (spreadTicks > get('maxSpreadTicks')) return { status: 'no-setup', strategy: 'future-session-orb-h1-v1', reasons: ['spread_exceeds_tick_limit'] };
  if (relativeVolume < get('minRelativeVolume')) return { status: 'no-setup', strategy: 'future-session-orb-h1-v1', reasons: ['relative_volume_below_minimum'] };
  const long = ema20 > ema50 && Number(last.close) > openingHigh + triggerBuffer && ask > openingHigh + triggerBuffer;
  const short = ema20 < ema50 && Number(last.close) < openingLow - triggerBuffer && bid < openingLow - triggerBuffer;
  if (long === short) return { status: 'no-setup', strategy: 'future-session-orb-h1-v1', reasons: ['no_unique_trend_aligned_breakout'] };
  const direction = long ? 'long' : 'short';
  const entryPrice = direction === 'long' ? ask : bid;
  const rawStop = rangeMid;
  const stopPrice = direction === 'long' ? floorTick(rawStop, tick) : ceilTick(rawStop, tick);
  const riskDistance = Math.abs(entryPrice - stopPrice);
  if (!(riskDistance >= tick)) return { status: 'no-setup', strategy: 'future-session-orb-h1-v1', reasons: ['stop_is_inside_one_tick'] };
  const rawTarget = entryPrice + (direction === 'long' ? 1 : -1) * riskDistance * get('targetR');
  const targetPrice = direction === 'long' ? ceilTick(rawTarget, tick) : floorTick(rawTarget, tick);
  const id = String(contract.contractId).toUpperCase();
  const symbol = String(contract.symbol).toUpperCase();
  const candidate = {
    mode: 'paper', owner: 'futures', assetClass: 'future', instrumentKey: id,
    exposureKey: contract.exposureKey, strategyId: 'future-session-orb-h1-v1',
    sessionDate: marketDate, sessionTimeZone: timeZone,
    sessionSource: sessionClock.source, sessionReviewedAt: sessionClock.reviewedAt,
    idempotencyKey: `${id}:${marketDate}:session-orb:${direction}`,
    direction, bid, ask, entryPrice, stopPrice, targetPrice,
    quoteTime: new Date(quoteAt).toISOString(), quoteQuality: 'executable', sessionOpen: true,
    multiplier, lotSize: 1, roundTripFeesPerUnit: Number(config.roundTripFeesPerContract),
    slippageReservePerUnit: Number(config.slippageReservePerContract), forceExitAt: new Date(close).toISOString(),
    entryExpiresAt: new Date(close - get('noEntryBeforeCloseMs')).toISOString(),
    initialMarginUsd, maintenanceMarginUsd,
    researchContext: { setupType: 'session_opening_range_breakout', observedAt: new Date(quoteAt).toISOString(),
      ...(discoveryContext ? { discoveryVersion: discoveryContext.version, discovery: structuredClone(discoveryContext) } : {}),
      features: { atr14: volatility, h1_ema20: ema20, h1_ema50: ema50,
        opening_high: openingHigh, opening_low: openingLow, relative_volume: relativeVolume, spread_ticks: spreadTicks } },
    marketGateTrace: { source: 'market_candidate_emission', owner: 'futures',
      strategyId: 'future-session-orb-h1-v1', observedAt: new Date(quoteAt).toISOString(),
      passedGates: ['verified_active_contract', 'reviewed_exchange_session', 'settlement_review',
        'fresh_catalyst_review', 'fresh_executable_quote', 'completed_session_h1_history',
        'opening_range_breakout', 'relative_volume', 'spread_within_ticks', 'initial_margin_budget'] },
    future: { contractId: id, providerRawSymbol: contract.providerRawSymbol, expiry: contract.expiry, expiryAt: new Date(expiryAt).toISOString(),
      entrySession: { marketDate, timeZone, openTime: new Date(open).toISOString(), closeTime: new Date(close).toISOString(),
        source: sessionClock.source, reviewedAt: sessionClock.reviewedAt },
      ...(contract.providerDataset ? { providerDataset: contract.providerDataset } : {}),
      ...(contract.providerPublisherId ? { providerPublisherId: contract.providerPublisherId } : {}),
      ...(discoveryContext ? { discovery: structuredClone(discoveryContext) } : {}),
      tickSize: tick, multiplier, activeContract: contract.activeContract === true,
      contractSpecVerified: contract.contractSpecVerified === true, specSource: contract.specSource, specVerifiedAt: contract.specVerifiedAt,
      settlementReview: settlementReview.normalized },
    signal: { strategy: 'future-session-orb-h1-v1', symbol, contractId: id, expiry: contract.expiry, expiryAt: new Date(expiryAt).toISOString(), sessionSource: sessionClock.source, sessionReviewedAt: sessionClock.reviewedAt, openingHigh, openingLow, rangeMid, atr14: volatility, ema20, ema50, relativeVolume, spreadTicks, tickSize: tick, tickValueUsd: contract.tickValueUsd,
      catalystReview: { source: catalystReview.source.trim(), reviewedAt: new Date(Number.isFinite(Number(catalystReview.reviewedAt)) ? Number(catalystReview.reviewedAt) : Date.parse(catalystReview.reviewedAt)).toISOString() } },
  };
  return { status: 'candidate', strategy: 'future-session-orb-h1-v1', candidate };
}
