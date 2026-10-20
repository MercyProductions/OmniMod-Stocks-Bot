// Discovery parsing only. Nothing from this module is an executable strategy input.
import { optionNumber as numeric, validOptionDate, tradierUnderlyingSymbol, optionIdentityOccurrences,
  tradierContractIdentity } from '../../shared/optionContractIdentity.js';
import { tradierChainRows } from '../../shared/tradierOptionResponses.js';
export { validOptionDate, tradierUnderlyingSymbol } from '../../shared/optionContractIdentity.js';
export { parseExpirationInventory } from '../../shared/tradierOptionResponses.js';
const text = (value, limit = 40) => typeof value === 'string' && value.length <= limit ? value.trim() : '';
export function selectResearchExpirations(dates, { sessionDate, minDays = 1, maxDays = 45, maxChains = 2, cursor = 0 } = {}) {
  const days = (date) => (Date.parse(date + 'T00:00:00Z') - Date.parse(sessionDate + 'T00:00:00Z')) / 86400000;
  const eligible = dates.filter((date) => days(date) >= minDays && days(date) <= maxDays);
  const rest = eligible.slice(1), offset = rest.length ? cursor % rest.length : 0;
  const rotating = [...rest.slice(offset), ...rest.slice(0, offset)].slice(0, Math.max(0, maxChains - 1));
  const selected = eligible.length ? [eligible[0], ...rotating] : [];
  return { eligible, selected, rotating,
    excluded: dates.filter((date) => !eligible.includes(date)).map((date) => ({ date, daysToExpiry: days(date),
      reason: days(date) < 0 ? 'past_expiration' : 'outside_research_dte_window' })),
    deferred: eligible.filter((date) => !selected.includes(date)).map((date) => ({ date, reason: 'expiration_chain_budget' })),
    nextCursor: rest.length ? (offset + rotating.length) % rest.length : 0 };
}
function time(value) {
  const n = numeric(value);
  if (n !== null && n > 0) {
    const milliseconds = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : NaN;
  }
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

/** Retain every returned strike/call/put, including rejected identities and unusable quotes. */
export function parseContractInventory(payload, { underlying, expiry, environment, now, maxQuoteAgeMs = 10000 } = {}) {
  if (!tradierUnderlyingSymbol(underlying) || !validOptionDate(expiry) || !['sandbox', 'production'].includes(environment) || !Number.isFinite(now))
    throw new TypeError('Contract inventory context is invalid.');
  const raw = tradierChainRows(payload);
  const occurrences = optionIdentityOccurrences(raw);
  const requested = tradierUnderlyingSymbol(underlying);
  const contracts = raw.map((row, index) => {
    const identity = tradierContractIdentity(row, { underlying, expiry, occurrences });
    const { symbol, underlying: observedUnderlying, type, strike, multiplier, root, reasons } = identity;
    const bid = numeric(row?.bid), ask = numeric(row?.ask), bidAt = time(row?.bid_date), askAt = time(row?.ask_date);
    const quoteReasons = [];
    if (!(bid >= 0 && ask > 0 && ask >= bid) || bid === null || ask === null) quoteReasons.push('invalid_bid_ask');
    const freshLimit = environment === 'sandbox' ? 20 * 60000 : maxQuoteAgeMs;
    if (![bidAt, askAt].every(Number.isFinite) || bidAt > now + 5000 || askAt > now + 5000 || now - Math.min(bidAt, askAt) > freshLimit)
      quoteReasons.push('stale_future_or_missing_quote_time');
    if ([bidAt, askAt].every(Number.isFinite) && Math.abs(bidAt - askAt) > 3000) quoteReasons.push('quote_side_time_skew');
    const volume = numeric(row?.volume), openInterest = numeric(row?.open_interest);
    return { row: index, symbol, underlying: observedUnderlying, expiry: text(row?.expiration_date, 10) || null,
      root, type: ['call', 'put'].includes(type) ? type : null, strike,
      multiplier, expirationType: text(row?.expiration_type, 30) || null,
      identityStatus: reasons.length ? 'unverified' : 'verified_standard_contract', reasons,
      quote: { bid, ask, bidAt: Number.isFinite(bidAt) ? new Date(bidAt).toISOString() : null,
        askAt: Number.isFinite(askAt) ? new Date(askAt).toISOString() : null,
        ageMs: [bidAt, askAt].every(Number.isFinite) ? Math.max(0, now - Math.min(bidAt, askAt)) : null,
        status: quoteReasons.length ? 'unusable' : environment === 'sandbox' ? 'delayed_research' : 'fresh_research', reasons: quoteReasons,
        volume: Number.isInteger(volume) && volume >= 0 ? volume : null,
        openInterest: Number.isInteger(openInterest) && openInterest >= 0 ? openInterest : null },
      eligibleForPaper: false };
  });
  const rejectionReasons = {};
  for (const row of contracts) for (const reason of [...row.reasons, ...row.quote.reasons]) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
  return { underlying: requested, expiry, status: raw.length ? 'chain_response_complete' : 'empty_chain',
    contracts, counts: { contractsReturned: raw.length, verifiedIdentities: contracts.filter((row) => !row.reasons.length).length,
      identityRejected: contracts.filter((row) => row.reasons.length).length,
      calls: contracts.filter((row) => row.type === 'call').length, puts: contracts.filter((row) => row.type === 'put').length,
      distinctStrikes: new Set(contracts.filter((row) => !row.reasons.length).map((row) => row.strike)).size,
      freshResearchQuotes: contracts.filter((row) => !row.reasons.length && row.quote.status === 'fresh_research').length,
      delayedResearchQuotes: contracts.filter((row) => !row.reasons.length && row.quote.status === 'delayed_research').length,
      paperEligible: 0 }, rejectionReasons };
}
