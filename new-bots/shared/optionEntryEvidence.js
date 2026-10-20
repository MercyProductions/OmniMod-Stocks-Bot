import { assessOptionHypothesis } from './optionHypothesis.js';
import { isFreshClearCatalystReview } from './catalystReview.js';
import { optionNumber, tradierUnderlyingSymbol, validateStandardOptionIdentity, optionIdentityOccurrences } from './optionContractIdentity.js';

export const OPTION_ENTRY_EVIDENCE_VERSION = 'option-entry-evidence-v1';
export const OPTION_CATALYST_SOURCES = ['manual', 'finnhub', 'alpaca', 'finnhub+alpaca'];
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

/** Recheck the specific reserved spread; this never selects a replacement contract. */
export function assessOptionEntryEvidence(order, quote, now, maxQuoteAgeMs = 10000) {
  const reject = (reason, cancel = false) => ({ valid: false, reason, cancel });
  const policy = order.option?.entryValidation, h = order.option?.primaryHypothesis;
  if (!policy || policy.version !== OPTION_ENTRY_EVIDENCE_VERSION || !h || !['long', 'short'].includes(h.direction)
    || !OPTION_CATALYST_SOURCES.includes(policy.catalystSource)
    || !(policy.maxQuoteAgeMs > 0 && policy.maxQuoteAgeMs <= 10000)
    || !(policy.maxLegSkewMs > 0 && policy.maxLegSkewMs <= 3000)
    || !(policy.maxCatalystReviewAgeMs > 0 && policy.maxCatalystReviewAgeMs <= 1800000)
    || !(policy.primarySignalMaxAgeMs > 0 && policy.primarySignalMaxAgeMs <= 120000)
    || !(policy.minOpenInterest >= 100 && Number.isFinite(policy.minOpenInterest))
    || !(policy.minVolume >= 1 && Number.isFinite(policy.minVolume))
    || !(policy.maxLegSpreadPct > 0 && policy.maxLegSpreadPct <= 15)) return reject('option_entry_policy_unavailable');
  const e = quote?.optionEntryEvidence;
  if (!e || e.version !== OPTION_ENTRY_EVIDENCE_VERSION) return reject('option_entry_evidence_missing');
  const underlying = tradierUnderlyingSymbol(order.option.underlyingSymbol), q = e.underlyingQuote;
  if (!underlying || underlying !== tradierUnderlyingSymbol(h.underlyingSymbol)
    || underlying !== tradierUnderlyingSymbol(q?.symbol)) return reject('option_entry_underlying_identity_mismatch');
  if (e.sessionDate !== order.sessionDate || e.sessionDate !== h.sessionDate
    || !Number.isFinite(stamp(e.sessionClose)) || stamp(e.sessionClose) !== stamp(policy.sessionClose)
    || now >= stamp(e.sessionClose)) return reject('option_entry_session_changed_or_closed');
  const bid = optionNumber(q?.bid), ask = optionNumber(q?.ask);
  if (q?.quality !== 'executable' || !(bid > 0 && ask >= bid)) return reject('option_entry_underlying_quote_invalid');
  const legs = e.legs;
  if (!Array.isArray(legs) || legs.length !== 2) return reject('option_entry_leg_evidence_missing');
  const occurrences = optionIdentityOccurrences(legs);
  const selected = [order.option.longLeg, order.option.shortLeg].map(ref => legs.find(leg => leg?.symbol === ref?.symbol));
  if (selected.some(leg => !validateStandardOptionIdentity(leg, { underlying, expiry: order.option.expiry, occurrences }).valid)
    || `${selected[0]?.symbol}+${selected[1]?.symbol}` !== order.instrumentKey)
    return reject('option_entry_leg_identity_mismatch');
  const times = [stamp(q.bidTime), stamp(q.askTime), ...selected.flatMap(leg => [stamp(leg.bidTime), stamp(leg.askTime)])];
  const ttl = Math.min(policy.maxQuoteAgeMs, maxQuoteAgeMs);
  if (!Number.isFinite(now) || !times.every(time => Number.isFinite(time) && time <= now + 5000 && now - time <= ttl)
    || stamp(q.time) !== Math.min(...times.slice(0, 2)) || stamp(quote.time) !== Math.min(...times.slice(2)))
    return reject('option_entry_quotes_stale_or_invalid');
  if (Math.max(...times) - Math.min(...times) > policy.maxLegSkewMs) return reject('option_entry_quotes_unsynchronized');
  if (Math.min(...times) < stamp(order.reservedAt)) return reject('option_entry_quote_precedes_reservation');
  for (const leg of selected) {
    const lb = optionNumber(leg.bid), la = optionNumber(leg.ask);
    if (leg.quoteQuality !== 'executable' || lb === null || la === null || !(lb >= 0 && la > 0 && la >= lb)
      || (la - lb) / ((lb + la) / 2) * 100 > policy.maxLegSpreadPct
      || !(optionNumber(leg.volume) >= policy.minVolume) || !(optionNumber(leg.openInterest) >= policy.minOpenInterest))
      return reject('option_entry_leg_liquidity_or_spread');
  }
  if (Math.abs(Number(quote.bid) - Number(Math.max(0, selected[0].bid - selected[1].ask).toFixed(4))) > 1e-7
    || Math.abs(Number(quote.ask) - Number((selected[0].ask - selected[1].bid).toFixed(4))) > 1e-7)
    return reject('option_entry_composite_quote_mismatch');
  const catalyst = e.catalyst, checkedAt = stamp(catalyst?.checkedAt);
  if (catalyst?.source !== policy.catalystSource || !Number.isFinite(checkedAt)
    || checkedAt > now + 5000 || now - checkedAt > ttl
    || !isFreshClearCatalystReview(catalyst?.review, { now, maxAgeMs: policy.maxCatalystReviewAgeMs }))
    return reject('option_entry_catalyst_clearance_required');
  const reviewedAt = typeof catalyst.review.reviewedAt === 'number' ? catalyst.review.reviewedAt : stamp(catalyst.review.reviewedAt);
  if (checkedAt > Math.min(...times) || reviewedAt > Math.min(...times)) return reject('option_entry_quote_precedes_clearance');
  const stop = h.stopPrice == null ? null : optionNumber(h.stopPrice), target = optionNumber(h.targetPrice);
  if (h.stopPrice != null && (!(stop > 0) || (h.direction === 'long' ? stop >= Number(h.entryPrice) : stop <= Number(h.entryPrice))))
    return reject('option_entry_underlying_stop_invalid');
  if (stop !== null && (h.direction === 'long' ? bid <= stop : ask >= stop)) return reject('option_underlying_invalidated_before_fill', true);
  if (target > 0 && (h.direction === 'long' ? ask >= target : bid <= target)) return reject('option_underlying_target_passed_before_fill', true);
  const source = assessOptionHypothesis({ signal: { underlyingSymbol: underlying, direction: h.direction,
    sessionDate: e.sessionDate, underlyingPrice: (bid + ask) / 2, underlyingTarget: h.targetPrice, underlyingStop: h.stopPrice,
    entryLow: h.entryLow, entryHigh: h.entryHigh, entryExpiresAt: h.entryExpiresAt, forceExitAt: h.forceExitAt,
    primaryHypothesis: h }, now, maxAgeMs: policy.primarySignalMaxAgeMs, forceExitAt: stamp(order.forceExitAt) });
  if (!source.valid) return reject(`option_entry_${source.reason}`);
  const breakout = policy.breakout;
  if (breakout && !(h.direction === 'long' ? bid > breakout.rangeHigh + breakout.buffer && (bid + ask) / 2 > breakout.vwap
    : ask < breakout.rangeLow - breakout.buffer && (bid + ask) / 2 < breakout.vwap)) return reject('option_entry_original_breakout_not_held');
  return { valid: true, evidence: structuredClone(e) };
}
