import { fetchFinnhubEconomicCalendar } from '../../new-bots/shared/finnhubEconomicCalendar.js';
import { createHash } from 'node:crypto';

const cache = new Map();
const inFlight = new Map();
const SUCCESS_TTL_MS = 15 * 60_000;
const FAILURE_TTL_MS = 30_000;

export function clearCryptoMacroCalendarCache() {
  cache.clear();
  inFlight.clear();
}

/**
 * Converts the optional scheduled US macro calendar review into a conservative
 * all-crypto event veto. It is a context gate only; it never supplies direction.
 */
export async function loadCryptoMacroCalendar({ enabled = false, token = '', now = new Date(), fetcher = fetch,
  clock = Date.now, successTtlMs = SUCCESS_TTL_MS, failureTtlMs = FAILURE_TTL_MS, skipReason = 'not_configured' } = {}) {
  if (!enabled) return { events: [], diagnostics: { status: skipReason, provider: 'Finnhub Economic Calendar' } };
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Crypto macro-calendar review time must be valid.');
  const marketDate = new Date(timestamp).toISOString().slice(0, 10);
  const tokenFingerprint = createHash('sha256').update(String(token)).digest('hex');
  const key = `${marketDate}:${tokenFingerprint}`;
  const currentTime = Number(clock());
  const cached = cache.get(key);
  if (cached && cached.expiresAt > currentTime) {
    return { ...cached.value, diagnostics: { ...cached.value.diagnostics, cache: 'hit' } };
  }
  if (inFlight.has(key)) {
    const value = await inFlight.get(key);
    return { ...value, diagnostics: { ...value.diagnostics, cache: 'coalesced' } };
  }
  const request = fetchCalendarReview({ token, timestamp, marketDate, fetcher });
  inFlight.set(key, request);
  const result = await request;
  inFlight.delete(key);
  const ttl = result.diagnostics.status === 'complete' ? successTtlMs : failureTtlMs;
  cache.set(key, { value: result, expiresAt: Number(clock()) + Math.max(0, Number(ttl) || 0) });
  return { ...result, diagnostics: { ...result.diagnostics, cache: 'miss' } };
}

async function fetchCalendarReview({ token, timestamp, marketDate, fetcher }) {
  const metrics = [];
  try {
    const result = await fetchFinnhubEconomicCalendar({
      token, marketDate, instruments: ['CRYPTO'], countryCodesByInstrument: { CRYPTO: ['US'] },
      now: timestamp, fetcher, metrics
    });
    const review = result.reviews.CRYPTO;
    const events = review?.status === 'blocked' ? [{
      id: `finnhub-crypto-${marketDate}`, symbol: '*', severity: 'block', eventType: 'macro',
      direction: 'unknown', expectedness: 'scheduled', horizon: 'intraday', impact: 'high',
      reason: review.summary, source: review.source, sourceUrl: '',
      startsAt: new Date(`${review.coveredDates?.from || marketDate}T00:00:00.000Z`).toISOString(),
      endsAt: new Date(`${review.coveredDates?.to || marketDate}T23:59:59.999Z`).toISOString(),
      reviewedAt: review.reviewedAt
    }] : [];
    return { events, diagnostics: { ...result.diagnostics, reviewStatus: review?.status || 'invalid', metrics } };
  } catch (error) {
    return {
      events: [{ id: `finnhub-crypto-error-${marketDate}`, symbol: '*', severity: 'block', eventType: 'macro',
        direction: 'unknown', expectedness: 'unknown', horizon: 'intraday', impact: 'unknown',
        reason: 'Scheduled macro-event clearance unavailable; new crypto candidates fail closed.',
        startsAt: new Date(`${marketDate}T00:00:00.000Z`).toISOString(),
        endsAt: new Date(`${marketDate}T23:59:59.999Z`).toISOString() }],
      diagnostics: { status: 'provider_error', provider: 'Finnhub Economic Calendar', reviewStatus: 'blocked',
        error: String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180), metrics }
    };
  }
}
