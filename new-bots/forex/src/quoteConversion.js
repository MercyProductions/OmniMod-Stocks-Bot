import { isOandaPriceTradeable, readOandaPriceLevel } from './quoteQuality.js';

const CONVERSION_INSTRUMENT_BY_QUOTE_CURRENCY = Object.freeze({
  EUR: 'EUR_USD', GBP: 'GBP_USD', AUD: 'AUD_USD', NZD: 'NZD_USD',
  JPY: 'USD_JPY', CHF: 'USD_CHF', CAD: 'USD_CAD',
});

/** Return the OANDA instrument needed to convert an FX quote currency into USD. */
export function forexConversionInstrument(instrument, availableInstruments = null) {
  const match = /^([A-Z]{3})_([A-Z]{3})$/.exec(String(instrument ?? '').trim().toUpperCase());
  if (!match) return null;
  if (match[2] === 'USD') return null;
  const legacy = CONVERSION_INSTRUMENT_BY_QUOTE_CURRENCY[match[2]] ?? null;
  if (availableInstruments == null) return legacy; // Explicit static mode compatibility.
  const supported = new Set(availableInstruments);
  return [legacy, match[2] + '_USD', 'USD_' + match[2]].find((pair) => pair && supported.has(pair)) ?? null;
}

/**
 * Convert one unit of quote currency into USD using a fresh executable OANDA quote.
 * Liabilities use direct ask / reciprocal bid; proceeds use direct bid /
 * reciprocal ask. Both are frozen paper assumptions, not broker conversion fills.
 */
export function resolveForexQuoteToUsd({ instrument, conversionQuote = null, availableInstruments = null, now = Date.now(), maxQuoteAgeMs = 120_000 } = {}) {
  const normalized = String(instrument ?? '').trim().toUpperCase();
  const match = /^([A-Z]{3})_([A-Z]{3})$/.exec(normalized);
  if (!match) return { status: 'invalid_instrument', quoteToUsd: null, conversionInstrument: null };
  const quoteCurrency = match[2];
  if (quoteCurrency === 'USD') return { status: 'verified_quote_currency_usd', quoteToUsd: 1, gainQuoteToUsd: 1, quoteCurrency, conversionInstrument: null, conversionTime: null };
  const conversionInstrument = forexConversionInstrument(normalized, availableInstruments);
  if (!conversionInstrument) return { status: 'unsupported_quote_currency', quoteToUsd: null, quoteCurrency, conversionInstrument: null };
  if (!conversionQuote) return { status: 'conversion_quote_missing', quoteToUsd: null, quoteCurrency, conversionInstrument };
  if (String(conversionQuote.instrument ?? '').toUpperCase() !== conversionInstrument) {
    return { status: 'conversion_instrument_mismatch', quoteToUsd: null, quoteCurrency, conversionInstrument };
  }
  const bid = readOandaPriceLevel(conversionQuote.bids), ask = readOandaPriceLevel(conversionQuote.asks);
  const quoteTime = Date.parse(conversionQuote.time);
  const ageMs = now - quoteTime;
  if (!isOandaPriceTradeable(conversionQuote)) {
    return { status: 'conversion_not_tradeable', quoteToUsd: null, quoteCurrency, conversionInstrument };
  }
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
    && Number.isFinite(quoteTime) && Number.isFinite(maxQuoteAgeMs) && maxQuoteAgeMs > 0 && ageMs >= -5_000 && ageMs <= maxQuoteAgeMs)) {
    return { status: 'conversion_quote_stale_or_invalid', quoteToUsd: null, quoteCurrency, conversionInstrument,
      conversionAgeMs: Number.isFinite(ageMs) ? Math.round(ageMs) : null };
  }
  const direct = conversionInstrument.startsWith(`${quoteCurrency}_`);
  const quoteToUsd = direct ? ask : 1 / bid;
  const gainQuoteToUsd = direct ? bid : 1 / ask;
  if (!(Number.isFinite(quoteToUsd) && quoteToUsd > 0)) {
    return { status: 'conversion_factor_invalid', quoteToUsd: null, quoteCurrency, conversionInstrument };
  }
  return { status: 'converted', quoteToUsd, gainQuoteToUsd, quoteCurrency, conversionInstrument, conversionTime: conversionQuote.time,
    conversionAgeMs: Math.max(0, Math.round(ageMs)), method: direct ? 'loss-ask-gain-bid' : 'loss-inverse-bid-gain-inverse-ask',
    valuationBasis: 'conversion factors frozen at paper proposal; future conversion movement and broker fees are not modeled' };
}
