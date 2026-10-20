/** Reject contradictory provider tradeability fields rather than trusting either one. */
export function isOandaPriceTradeable(price) {
  return price?.status === 'tradeable' ? price.tradeable !== false
    : price?.status == null && price?.tradeable === true;
}

export function readOandaPriceLevel(levels) {
  const value = Array.isArray(levels) ? levels[0]?.price : null;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return NaN;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : NaN;
}

/** Classify quote timestamps consistently with the shared paper-entry tolerance. */
export function assessForexQuoteTime(value, { now = Date.now(), maxAgeMs, maxFutureMs = 5_000 } = {}) {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(now) || !Number.isFinite(parsed) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || !Number.isFinite(maxFutureMs) || maxFutureMs < 0) {
    return { status: 'invalid_timestamp_or_policy', quoteTimeMs: Number.isFinite(parsed) ? parsed : null, ageMs: null };
  }
  const ageMs = now - parsed;
  if (ageMs < -maxFutureMs) return { status: 'future_quote', quoteTimeMs: parsed, ageMs };
  if (ageMs > maxAgeMs) return { status: 'stale_quote', quoteTimeMs: parsed, ageMs };
  return { status: 'fresh', quoteTimeMs: parsed, ageMs };
}
