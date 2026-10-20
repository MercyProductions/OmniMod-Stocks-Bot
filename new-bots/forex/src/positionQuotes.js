import { assessOandaDiscoveryPrice } from './oandaUniverse.js';
import { isOandaPriceTradeable, readOandaPriceLevel } from './quoteQuality.js';

export function toExecutableForexQuote(price) {
  const bid = readOandaPriceLevel(price?.bids), ask = readOandaPriceLevel(price?.asks);
  return { bid, ask, time: price?.time,
    quality: isOandaPriceTradeable(price) && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid ? 'executable' : 'non-executable' };
}

/** Monitor owned positions independently of today's discovery shortlist/history. */
export async function loadForexPositionQuotes({ instruments = [], quoteRows = {}, fetchPrices, now = Date.now(),
  clock = () => now, maxQuoteAgeMs = 120_000 }) {
  const selected = [...new Set(instruments)], prices = new Map(), failures = [];
  const missing = selected.filter((instrument) => {
    const price = quoteRows[instrument];
    if (price?.instrument === instrument && !assessOandaDiscoveryPrice(price, { now: clock(), maxQuoteAgeMs }).reason) {
      prices.set(instrument, price);
      return false;
    }
    return true;
  });
  for (let index = 0; index < missing.length; index += 50) {
    const batch = missing.slice(index, index + 50), requested = new Set(batch), seen = new Set(), duplicates = new Set();
    try {
      const payload = await fetchPrices(batch);
      if (!Array.isArray(payload?.prices)) throw new Error('Missing position prices array.');
      for (const price of payload.prices) {
        if (!requested.has(price?.instrument)) continue;
        if (seen.has(price.instrument)) duplicates.add(price.instrument);
        seen.add(price.instrument);
        prices.set(price.instrument, price);
      }
      for (const instrument of batch) {
        if (duplicates.has(instrument)) { prices.delete(instrument); failures.push({ instrument, reason: 'duplicate_quote_identity' }); }
        else if (!seen.has(instrument)) failures.push({ instrument, reason: 'provider_returned_no_quote' });
      }
    } catch {
      for (const instrument of batch) { prices.delete(instrument); failures.push({ instrument, reason: 'position_quote_request_failed' }); }
    }
  }
  // The paper engine checks age/market/spread again immediately before each mark.
  return { quotes: new Map([...prices].map(([instrument, price]) => [instrument, toExecutableForexQuote(price)])), failures };
}
