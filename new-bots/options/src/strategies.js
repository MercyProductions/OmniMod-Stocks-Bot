import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { assessOptionHypothesis, OPTIONS_DAY_STRATEGY_ID } from './primaryHypothesis.js';
import { OPTION_ENTRY_EVIDENCE_VERSION, OPTION_CATALYST_SOURCES } from '../../shared/optionEntryEvidence.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from '../../shared/strategyConfig.js';
import { OPTION_IDENTITY_VERSION, validOptionDate, tradierUnderlyingSymbol, parseOccSymbol, optionIdentityOccurrences, validateStandardOptionIdentity } from '../../shared/optionContractIdentity.js';

function asTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  return Date.parse(value);
}

function spreadPct(leg) {
  const bid = hasExplicitNonNegativeFiniteAmount(leg.bid) ? Number(leg.bid) : NaN;
  const ask = hasExplicitPositiveFiniteAmount(leg.ask) ? Number(leg.ask) : NaN;
  const midpoint = (bid + ask) / 2;
  return midpoint > 0 ? (ask - bid) / midpoint * 100 : Infinity;
}

function optionalFinite(value) {
  if (!hasExplicitFiniteAmount(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validateCallAssignmentReview(review, { now, sessionDate, expiry, maxAgeMs }) {
  const reviewedAt = Number.isFinite(Number(review?.reviewedAt)) ? Number(review.reviewedAt) : Date.parse(review?.reviewedAt);
  let safeSource = false;
  try {
    const url = new URL(String(review?.source ?? ''));
    safeSource = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* invalid source fails closed */ }
  const reasons = [];
  if (review?.status !== 'clear' || !safeSource || typeof review?.summary !== 'string' || review.summary.trim().length < 5
    || !Number.isFinite(reviewedAt) || reviewedAt > now + 5_000 || now - reviewedAt > maxAgeMs
    || !validCalendarDate(review?.reviewedThrough) || review.reviewedThrough < expiry
    || (review?.nextExDividendDate != null && !validCalendarDate(review.nextExDividendDate))) {
    reasons.push('call_assignment_review_missing_stale_or_incomplete');
  } else if (review.nextExDividendDate && review.nextExDividendDate >= sessionDate && review.nextExDividendDate <= expiry) {
    reasons.push('short_call_ex_dividend_within_option_expiry');
  }
  return { reasons, review: safeSource && Number.isFinite(reviewedAt) ? {
    status: String(review?.status ?? 'unknown'), source: String(review.source), reviewedAt: new Date(reviewedAt).toISOString(),
    reviewedThrough: String(review?.reviewedThrough ?? ''), nextExDividendDate: review?.nextExDividendDate ?? null,
    summary: String(review?.summary ?? '').trim().slice(0, 240),
  } : null };
}

/**
 * Turn a primary-bot intraday direction into one defined-risk debit vertical.
 * Requires synchronized executable leg quotes. This is a paper candidate only.
 */
export function buildOptionDayTradeCandidate({
  signal, chain, primarySignalObservedAt, now = Date.now(), config = {},
}) {
  const reasons = [];
  const minOpenInterest = Number(config.minOpenInterest ?? 100);
  const minVolume = Number(config.minVolume ?? 1);
  const maxLegSpreadPct = Number(config.maxLegSpreadPct ?? 15);
  const maxQuoteAgeMs = Number(config.maxQuoteAgeMs ?? 10_000);
  const maxLegSkewMs = Number(config.maxLegSkewMs ?? 3_000);
  const maxCatalystReviewAgeMs = Number(config.maxCatalystReviewAgeMs ?? 30 * 60_000);
  const maxAssignmentReviewAgeMs = Number(config.maxAssignmentReviewAgeMs ?? 24 * 60 * 60_000);
  const minDaysToExpiry = Number(config.minDaysToExpiry ?? 1);
  const maxDaysToExpiry = Number(config.maxDaysToExpiry ?? 45);
  const forceExitBufferMinutes = Number(config.forceExitBufferMinutes ?? 5);
  const feePerContractRoundTrip = hasExplicitNonNegativeFiniteAmount(config.feePerContractRoundTrip) ? Number(config.feePerContractRoundTrip) : NaN;
  const slippageReservePerContract = hasExplicitNonNegativeFiniteAmount(config.slippageReservePerContract) ? Number(config.slippageReservePerContract) : NaN;
  const minRewardRisk = Number(config.minRewardRisk ?? 1.5);
  const requireCompleteGreeks = config.requireCompleteGreeks ?? false;
  const requireDividendProvider = config.requireDividendProvider ?? false;
  const catalystSource = config.catalystSource ?? 'manual';
  if (!OPTION_CATALYST_SOURCES.includes(catalystSource)) reasons.push('invalid_strategy_config');
  if (typeof requireCompleteGreeks !== 'boolean' || typeof requireDividendProvider !== 'boolean') reasons.push('invalid_strategy_config');
  const numeric = [minOpenInterest, minVolume, maxLegSpreadPct, maxQuoteAgeMs, maxLegSkewMs, maxCatalystReviewAgeMs, maxAssignmentReviewAgeMs, minDaysToExpiry, maxDaysToExpiry, forceExitBufferMinutes, feePerContractRoundTrip, slippageReservePerContract, minRewardRisk];
  if (!numeric.every(Number.isFinite) || minOpenInterest < 100 || minVolume < 1 || maxLegSpreadPct <= 0 || maxLegSpreadPct > 15
    || maxQuoteAgeMs <= 0 || maxQuoteAgeMs > 10_000 || maxLegSkewMs <= 0 || maxLegSkewMs > 3_000
    || maxCatalystReviewAgeMs <= 0 || maxCatalystReviewAgeMs > 30 * 60_000
    || maxAssignmentReviewAgeMs <= 0 || maxAssignmentReviewAgeMs > 24 * 60 * 60_000
    || minDaysToExpiry < 1 || maxDaysToExpiry < minDaysToExpiry || maxDaysToExpiry > 45
    || forceExitBufferMinutes < 5 || forceExitBufferMinutes > 30 || feePerContractRoundTrip < 0
    || slippageReservePerContract < 0 || minRewardRisk < 1.5) reasons.push('invalid_strategy_config');
  if (!signal || !['long', 'short'].includes(signal.direction) || !signal.underlyingSymbol || !signal.sessionDate
    || !hasExplicitPositiveFiniteAmount(signal.underlyingPrice) || !hasExplicitPositiveFiniteAmount(signal.underlyingTarget)) reasons.push('invalid_underlying_signal');
  const sessionClose = asTime(signal?.sessionClose);
  if (!Number.isFinite(sessionClose) || sessionClose <= now) reasons.push('invalid_underlying_session_close');
  let forceExitAt = sessionClose - forceExitBufferMinutes * 60_000;
  const primary = assessOptionHypothesis({ signal, primarySignalObservedAt, now,
    maxAgeMs: Number(config.primarySignalMaxAgeMs ?? 120000), forceExitAt });
  if (!primary.valid) reasons.push(primary.reason);
  else forceExitAt = primary.forceExitAt;
  if (Number.isFinite(sessionClose) && forceExitAt <= now) reasons.push('insufficient_time_before_option_exit');
  if (signal?.sessionOpen !== true) reasons.push('outside_underlying_session');
  if (signal?.direction === 'long' && requireDividendProvider && signal?.corporateActionScreenStatus !== 'pagination_complete') {
    reasons.push('cash_dividend_screen_unavailable_or_incomplete');
  }
  if (signal?.catalystBlocked === true) reasons.push('underlying_catalyst_blackout');
  if (!isFreshClearCatalystReview(signal?.catalystReview, { now, maxAgeMs: maxCatalystReviewAgeMs })) reasons.push('fresh_catalyst_clearance_required');
  if (chain?.quoteQuality !== 'executable') reasons.push('option_quotes_not_executable');
  const underlyingBid = hasExplicitNonNegativeFiniteAmount(signal?.underlyingQuote?.bid) ? Number(signal.underlyingQuote.bid) : NaN;
  const underlyingAsk = hasExplicitPositiveFiniteAmount(signal?.underlyingQuote?.ask) ? Number(signal.underlyingQuote.ask) : NaN;
  const underlyingQuoteTime = asTime(signal?.underlyingQuote?.time);
  if (signal?.underlyingQuote?.quality !== 'executable' || !(underlyingBid > 0) || !(underlyingAsk >= underlyingBid)
    || !Number.isFinite(underlyingQuoteTime) || underlyingQuoteTime > now + 5_000 || now - underlyingQuoteTime > maxQuoteAgeMs
    || Math.abs((underlyingBid + underlyingAsk) / 2 - Number(signal?.underlyingPrice)) > Math.max(0.01, Number(signal?.underlyingPrice) * 0.001)) {
    reasons.push('underlying_quote_missing_stale_or_mismatched');
  }
  if (!Array.isArray(chain?.options) || !chain.options.length) reasons.push('option_chain_unavailable');
  if (reasons.length) return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons };

  const underlyingSymbol = tradierUnderlyingSymbol(signal.underlyingSymbol)?.replaceAll('/', '.');
  if (!underlyingSymbol) return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['invalid_underlying_identity'] };
  const direction = signal.direction;
  const type = direction === 'long' ? 'call' : 'put';
  const underlyingPrice = Number(signal.underlyingPrice), underlyingTarget = Number(signal.underlyingTarget);
  if ((direction === 'long' && underlyingTarget <= underlyingPrice) || (direction === 'short' && underlyingTarget >= underlyingPrice)) {
    return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['underlying_target_conflicts_with_signal'] };
  }

  const signalTime = asTime(signal.observedAt);
  if (!Number.isFinite(signalTime) || signalTime > now + 5_000 || now - signalTime > maxQuoteAgeMs) {
    return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['underlying_signal_stale_or_future'] };
  }
  if (Math.abs(signalTime - underlyingQuoteTime) > maxLegSkewMs) {
    return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['underlying_quote_signal_time_skew'] };
  }
  const legRejections = {};
  const occurrences = optionIdentityOccurrences(chain.options);
  const valid = chain.options.map((leg) => leg && typeof leg === 'object' ? leg : {}).filter((leg) => {
    const time = asTime(leg.time);
    const failures = [...validateStandardOptionIdentity(leg, { underlying: underlyingSymbol, expiry: chain.expiry, occurrences }).reasons];
    if (leg.type !== type) failures.push('option_type_mismatch');
    if (leg.expiry !== chain.expiry) failures.push('expiry_mismatch');
    if (leg.quoteQuality !== 'executable') failures.push('leg_quote_not_executable');
    if (!hasExplicitNonNegativeFiniteAmount(leg.bid) || !hasExplicitPositiveFiniteAmount(leg.ask)
      || Number(leg.ask) < Number(leg.bid)) failures.push('crossed_or_missing_leg_quote');
    if (!hasExplicitPositiveFiniteAmount(leg.strike)) failures.push('invalid_strike');
    if (!hasExplicitPositiveFiniteAmount(leg.multiplier)) failures.push('invalid_multiplier');
    if (!hasExplicitNonNegativeFiniteAmount(leg.openInterest) || Number(leg.openInterest) < minOpenInterest) failures.push('open_interest_below_minimum');
    if (!hasExplicitNonNegativeFiniteAmount(leg.volume) || Number(leg.volume) < minVolume) failures.push('volume_below_minimum');
    if (!(Number.isFinite(time) && time <= now + 5_000 && now - time <= maxQuoteAgeMs)) failures.push('stale_or_invalid_leg_time');
    if (!(Math.abs(time - signalTime) <= maxLegSkewMs)) failures.push('leg_quote_skew');
    if (!(spreadPct(leg) <= maxLegSpreadPct)) failures.push('leg_spread_above_maximum');
    for (const failure of new Set(failures)) legRejections[failure] = (legRejections[failure] || 0) + 1;
    return failures.length === 0;
  }).map((leg) => ({ ...leg, symbol: parseOccSymbol(leg.symbol).canonical }));
  const expiryTime = validOptionDate(chain.expiry) ? Date.parse(`${chain.expiry}T23:59:59Z`) : NaN;
  const daysToExpiry = (expiryTime - now) / 86_400_000;
  if (!Number.isFinite(expiryTime) || daysToExpiry < minDaysToExpiry || daysToExpiry > maxDaysToExpiry) {
    return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['expiry_outside_configured_holding_window'] };
  }
  const assignmentReview = direction === 'long'
    ? validateCallAssignmentReview(signal.optionAssignmentReview, { now, sessionDate: signal.sessionDate,
      expiry: chain.expiry, maxAgeMs: maxAssignmentReviewAgeMs })
    : { reasons: [], review: null };
  if (assignmentReview.reasons.length) return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: assignmentReview.reasons };
  const providerDividendEvent = signal.corporateActionDividendVeto;
  if (direction === 'long' && providerDividendEvent?.provider === 'Alpaca' && providerDividendEvent.eventType === 'cash_dividend'
    && validCalendarDate(providerDividendEvent.exDate) && providerDividendEvent.exDate >= signal.sessionDate && providerDividendEvent.exDate <= chain.expiry) {
    return { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: ['short_call_ex_dividend_within_option_expiry'] };
  }
  const longs = valid.filter((leg) => direction === 'long' ? Number(leg.strike) <= underlyingPrice : Number(leg.strike) >= underlyingPrice);
  const candidates = [];
  const pairDiagnostics = { validLegs: valid.length, legRejections, possibleLongLegs: longs.length, directionAlignedPairs: 0, legQuoteSkewPairs: 0, validDebitPairs: 0, greekDataRejectedPairs: 0, rewardRiskQualifiedPairs: 0 };
  for (const longLeg of longs) for (const shortLeg of valid) {
    const ordered = direction === 'long' ? Number(shortLeg.strike) > Number(longLeg.strike) : Number(shortLeg.strike) < Number(longLeg.strike);
    const shortReachable = direction === 'long' ? Number(shortLeg.strike) <= underlyingTarget : Number(shortLeg.strike) >= underlyingTarget;
    if (!ordered || !shortReachable || shortLeg.symbol === longLeg.symbol) continue;
    pairDiagnostics.directionAlignedPairs += 1;
    const quoteTimes = [asTime(longLeg.time), asTime(shortLeg.time)];
    if (Math.abs(quoteTimes[0] - quoteTimes[1]) > maxLegSkewMs) {
      pairDiagnostics.legQuoteSkewPairs += 1;
      continue;
    }
    const width = Math.abs(Number(shortLeg.strike) - Number(longLeg.strike));
    if (Number(longLeg.multiplier) !== Number(shortLeg.multiplier)) continue;
    const debit = Number((Number(longLeg.ask) - Number(shortLeg.bid)).toFixed(4));
    const spreadBid = Number(Math.max(0, Number(longLeg.bid) - Number(shortLeg.ask)).toFixed(4));
    const spreadAsk = Number((Number(longLeg.ask) - Number(shortLeg.bid)).toFixed(4));
    if (!(debit > 0 && debit < width && spreadAsk >= spreadBid)) continue;
    pairDiagnostics.validDebitPairs += 1;
    const multiplier = Number(longLeg.multiplier);
    const longDelta = optionalFinite(longLeg.greeks?.delta ?? longLeg.delta);
    const shortDelta = optionalFinite(shortLeg.greeks?.delta ?? shortLeg.delta);
    const longIv = optionalFinite(longLeg.greeks?.impliedVolatility ?? longLeg.impliedVolatility);
    const shortIv = optionalFinite(shortLeg.greeks?.impliedVolatility ?? shortLeg.impliedVolatility);
    const greekStatus = longDelta !== null && shortDelta !== null && longIv !== null && shortIv !== null ? 'complete' : 'partial_or_unavailable';
    const greekValue = (leg, key) => optionalFinite(leg.greeks?.[key] ?? leg[key]);
    const longGamma = greekValue(longLeg, 'gamma'), shortGamma = greekValue(shortLeg, 'gamma');
    const longTheta = greekValue(longLeg, 'theta'), shortTheta = greekValue(shortLeg, 'theta');
    const longVega = greekValue(longLeg, 'vega'), shortVega = greekValue(shortLeg, 'vega');
    const greekUpdateTimes = [longLeg.greeks?.updatedAt, shortLeg.greeks?.updatedAt]
      .map((value) => Date.parse(value || '')).filter(Number.isFinite);
    const greeksAsOf = greekUpdateTimes.length === 2 ? new Date(Math.min(...greekUpdateTimes)).toISOString() : null;
    const greeksAgeMs = greeksAsOf ? Math.max(0, now - Date.parse(greeksAsOf)) : null;
    const greeksTimestampSkewMs = greekUpdateTimes.length === 2 ? Math.abs(greekUpdateTimes[0] - greekUpdateTimes[1]) : null;
    if (requireCompleteGreeks && ([longDelta, shortDelta, longGamma, shortGamma, longTheta, shortTheta, longVega, shortVega, longIv, shortIv].some((value) => value === null)
      || greekUpdateTimes.length !== 2 || greekUpdateTimes.some((time) => time > now + 5_000 || now - time > 2 * 60 * 60_000)
      || greekUpdateTimes.length === 2 && Math.abs(greekUpdateTimes[0] - greekUpdateTimes[1]) > 2 * 60 * 60_000)) {
      pairDiagnostics.greekDataRejectedPairs += 1;
      continue;
    }
    const stopPrice = debit * 0.5;
    const targetPrice = Math.min(debit * 2, width);
    const rewardRisk = (targetPrice - debit) / (debit - stopPrice);
    if (!(rewardRisk >= minRewardRisk)) continue;
    pairDiagnostics.rewardRiskQualifiedPairs += 1;
    candidates.push({
      mode: 'paper', owner: 'options', assetClass: 'option', instrumentKey: `${longLeg.symbol}+${shortLeg.symbol}`,
      strategyId: OPTIONS_DAY_STRATEGY_ID, sessionDate: signal.sessionDate,
      dataIdentityVersion: OPTION_IDENTITY_VERSION,
      sessionTimeZone: signal.sessionTimeZone || 'America/New_York', forceExitAt: new Date(forceExitAt).toISOString(),
      entryExpiresAt: primary.entryExpiresAt,
      exposureKey: underlyingSymbol, idempotencyKey: `${underlyingSymbol}:${signal.sessionDate}:${direction}:option-vertical:${chain.expiry}`,
      direction: 'long', underlyingDirection: direction, bid: spreadBid, ask: spreadAsk, entryPrice: debit, stopPrice, targetPrice,
      researchSignal: { symbol: underlyingSymbol, direction, underlyingPrice, underlyingTarget, entryLow: signal.entryLow ?? null,
        entryHigh: signal.entryHigh ?? null, sessionDate: signal.sessionDate, signalId: signal.signalId ?? null },
      maxLossPerUnit: debit, multiplier, lotSize: 1,
      // A vertical is two option contracts; config costs are specified per contract for a full round trip.
      roundTripFeesPerUnit: feePerContractRoundTrip * 2, slippageReservePerUnit: slippageReservePerContract * 2,
      quoteTime: new Date(Math.min(...quoteTimes)).toISOString(), quoteQuality: 'executable', sessionOpen: true,
      researchContext: { setupType: 'underlying_confirmed_debit_vertical', observedAt: new Date(Math.min(...quoteTimes)).toISOString(),
        features: { days_to_expiry: daysToExpiry, spread_width: width, debit,
          leg_spread_pct_total: spreadPct(longLeg) + spreadPct(shortLeg),
          combined_open_interest: Number(longLeg.openInterest) + Number(shortLeg.openInterest),
          combined_volume: Number(longLeg.volume) + Number(shortLeg.volume) } },
      marketGateTrace: { source: 'market_candidate_emission', owner: 'options',
        strategyId: OPTIONS_DAY_STRATEGY_ID,
        observedAt: new Date(Math.min(...quoteTimes)).toISOString(),
        passedGates: ['frozen_primary_hypothesis', 'primary_entry_window', 'fresh_underlying_signal', 'fresh_underlying_quote', 'fresh_catalyst_review', 'standard_option_contract_identity',
          'executable_option_chain', 'fresh_synchronized_legs', 'leg_liquidity_and_spread',
          'expiry_window', 'valid_debit_geometry', 'cost_configured', 'minimum_reward_risk',
          ...(direction === 'long' ? ['call_assignment_review'] : []),
          ...(requireCompleteGreeks ? ['complete_greeks_required'] : []),
          ...(direction === 'long' && requireDividendProvider ? ['cash_dividend_screen'] : [])] },
      option: { underlyingSymbol, primaryHypothesis: primary.hypothesis,
        entryValidation: { version: OPTION_ENTRY_EVIDENCE_VERSION, catalystSource, sessionClose: new Date(sessionClose).toISOString(),
          maxQuoteAgeMs, maxLegSkewMs, maxCatalystReviewAgeMs, primarySignalMaxAgeMs: Number(config.primarySignalMaxAgeMs ?? 120000),
          minOpenInterest, minVolume, maxLegSpreadPct }, dataIdentityVersion: OPTION_IDENTITY_VERSION, strategy: direction === 'long' ? 'bull-call-debit-vertical' : 'bear-put-debit-vertical', expiry: chain.expiry, daysToExpiry: Number(daysToExpiry.toFixed(2)), width, longLeg: { symbol: longLeg.symbol, strike: Number(longLeg.strike), bid: Number(longLeg.bid), ask: Number(longLeg.ask) }, shortLeg: { symbol: shortLeg.symbol, strike: Number(shortLeg.strike), bid: Number(shortLeg.bid), ask: Number(shortLeg.ask) }, contractsPerSpread: 2, feePerContractRoundTrip, slippageReservePerContractRoundTrip: slippageReservePerContract, spreadFeesPerRoundTrip: feePerContractRoundTrip * 2, spreadSlippageReservePerRoundTrip: slippageReservePerContract * 2, maxLossPerContractUsd: Number((debit * multiplier).toFixed(2)), maxGainAtExpiryUsd: Number(((width - debit) * multiplier).toFixed(2)), targetPriceMultiplier: Number((targetPrice / debit).toFixed(3)), stopPriceMultiplier: 0.5, forceExitBeforeSessionClose: true, forceExitBufferMinutes, assignmentReview: assignmentReview.review, source: chain.source ?? null },
      optionGreekContext: {
        status: greekStatus,
        longDelta, shortDelta,
        netDeltaPerSpread: longDelta !== null && shortDelta !== null ? Number((longDelta - shortDelta).toFixed(6)) : null,
        netDeltaSharesPerSpread: longDelta !== null && shortDelta !== null ? Number(((longDelta - shortDelta) * multiplier).toFixed(4)) : null,
        netDeltaUsdPerSpread: longDelta !== null && shortDelta !== null ? Number(((longDelta - shortDelta) * multiplier * underlyingPrice).toFixed(2)) : null,
        netGammaPerSpread: longGamma !== null && shortGamma !== null ? Number((longGamma - shortGamma).toFixed(8)) : null,
        netThetaPerSpread: longTheta !== null && shortTheta !== null ? Number((longTheta - shortTheta).toFixed(8)) : null,
        netThetaUsdPerDay: longTheta !== null && shortTheta !== null ? Number(((longTheta - shortTheta) * multiplier).toFixed(4)) : null,
        netVegaPerSpread: longVega !== null && shortVega !== null ? Number((longVega - shortVega).toFixed(8)) : null,
        longImpliedVolatility: longIv, shortImpliedVolatility: shortIv,
        impliedVolatilityDifference: longIv !== null && shortIv !== null ? Number((longIv - shortIv).toFixed(6)) : null,
        greeksAsOf, greeksAgeMs, greeksTimestampSkewMs,
        greekDataFreshness: greeksAgeMs === null ? 'timestamp_unavailable' : greeksAgeMs <= 2 * 60 * 60_000 ? 'within_two_hours' : 'older_than_two_hours',
        source: chain.source ?? null,
        interpretation: 'Descriptive Tradier/ORATS Greeks only. Tradier describes Greeks as hourly data; timestamp age/skew is shown, and these values do not change approval, sizing, exits, or paper P&L or replace a calibrated risk forecast.',
      },
      strategySelection: { legSpreadPctTotal: Number((spreadPct(longLeg) + spreadPct(shortLeg)).toFixed(3)), combinedOpenInterest: Number(longLeg.openInterest) + Number(shortLeg.openInterest), combinedVolume: Number(longLeg.volume) + Number(shortLeg.volume) },
      note: 'Defined-risk same-day paper plan; premium stop is 50% of debit, target is capped at vertical width, and open exposure must be closed before session end. Call verticals require a fresh cited ex-dividend review through expiry. Review cannot eliminate early-assignment risk; no fill, time-decay model, or live order is implied.',
    });
  }
  candidates.sort((a, b) => a.strategySelection.legSpreadPctTotal - b.strategySelection.legSpreadPctTotal
    || b.strategySelection.combinedOpenInterest - a.strategySelection.combinedOpenInterest
    || b.strategySelection.combinedVolume - a.strategySelection.combinedVolume);
  return candidates.length
    ? { status: 'candidate', strategy: OPTIONS_DAY_STRATEGY_ID, candidate: candidates[0] }
    : { status: 'no-setup', strategy: OPTIONS_DAY_STRATEGY_ID, reasons: [
      ...(pairDiagnostics.greekDataRejectedPairs ? ['required_greeks_missing_stale_or_skewed'] : []),
      ...(pairDiagnostics.legQuoteSkewPairs ? ['option_leg_quote_pair_skew'] : []),
      'no_liquid_positive_payoff_vertical',
    ], diagnostics: pairDiagnostics };
}
