import { assessOandaDiscoveryPrice } from './oandaUniverse.js';
import { forexConversionInstrument, resolveForexQuoteToUsd } from './quoteConversion.js';

/** Reuse recent discovery prices, otherwise refresh the pair and USD conversion
 * together after history work. Never turn receipt time into provider quote time. */
export async function refreshForexDecisionQuotes({ instrument, quoteRows = {}, availableInstruments = null,
  fetchPrices, clock = Date.now, maxQuoteAgeMs = 120_000 }) {
  if (!/^[A-Z]{3}_[A-Z]{3}$/.test(instrument) || typeof fetchPrices !== 'function'
    || typeof clock !== 'function' || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) {
    throw new TypeError('Invalid Forex decision-quote inputs.');
  }
  const startedAt = clock();
  if (!Number.isFinite(startedAt)) throw new TypeError('Invalid Forex decision clock.');
  const conversionInstrument = forexConversionInstrument(instrument, availableInstruments);
  const requested = [...new Set([instrument, conversionInstrument].filter(Boolean))];
  const reusableAgeMs = Math.min(30_000, maxQuoteAgeMs / 2);
  const ages = (rows, at) => Object.fromEntries(requested.map(pair => {
    const time = Date.parse(rows[pair]?.time);
    return [pair, Number.isFinite(time) ? at - time : null];
  }));
  const diagnostics = { instrument, conversionInstrument, status: 'reused', requested: 0,
    beforeAgeMs: ages(quoteRows, startedAt), afterAgeMs: null, durationMs: 0, rejections: [] };
  const needsRefresh = requested.some(pair => quoteRows[pair]?.instrument !== pair
    || assessOandaDiscoveryPrice(quoteRows[pair], { now: startedAt, maxQuoteAgeMs: reusableAgeMs }).reason);
  let rows = Object.fromEntries(requested.map(pair => [pair, quoteRows[pair]]));
  if (needsRefresh) {
    // Invalidate before I/O, so failure cannot be hidden by the previous cache.
    for (const pair of requested) delete quoteRows[pair];
    rows = {};
    diagnostics.status = 'refreshed';
    diagnostics.requested = requested.length;
    try {
      const payload = await fetchPrices(requested);
      if (!Array.isArray(payload?.prices)) throw new Error('Missing decision prices array.');
      for (const pair of requested) {
        const matches = payload.prices.filter(price => price?.instrument === pair);
        if (matches.length !== 1) diagnostics.rejections.push({ instrument: pair,
          reason: matches.length > 1 ? 'duplicate_quote_identity' : 'provider_returned_no_quote' });
        else rows[pair] = matches[0];
      }
    } catch (error) {
      diagnostics.status = 'failed';
      diagnostics.rejections.push({ instrument, reason: error.code === 'FOREX_COOLDOWN_DEFERRED'
        ? 'decision_quote_cooldown_deferred' : 'decision_quote_request_failed' });
    }
  }
  const receivedAt = clock();
  if (!Number.isFinite(receivedAt) || receivedAt < startedAt) throw new RangeError('Forex decision clock moved backwards.');
  diagnostics.durationMs = receivedAt - startedAt;
  diagnostics.afterAgeMs = ages(rows, receivedAt);
  for (const pair of requested) {
    if (!rows[pair]) continue;
    const reason = assessOandaDiscoveryPrice(rows[pair], { now: receivedAt, maxQuoteAgeMs }).reason;
    if (reason) { diagnostics.rejections.push({ instrument: pair, reason }); delete rows[pair]; }
    else quoteRows[pair] = rows[pair];
  }
  const quoteConversion = resolveForexQuoteToUsd({ instrument, conversionQuote: rows[conversionInstrument],
    availableInstruments, now: receivedAt, maxQuoteAgeMs });
  if (!(quoteConversion.quoteToUsd > 0)) diagnostics.rejections.push({ instrument: conversionInstrument ?? instrument,
    reason: quoteConversion.status });
  if (diagnostics.rejections.length) diagnostics.status = 'failed';
  return { price: rows[instrument] ?? null, quoteConversion, diagnostics };
}

export function summarizeDecisionQuotes(rows) {
  const reasons = {};
  for (const row of rows) for (const item of row.rejections) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  return { observations: rows.length, reused: rows.filter(row => row.status === 'reused').length,
    refreshed: rows.filter(row => row.status === 'refreshed').length, failed: rows.filter(row => row.status === 'failed').length,
    pricingBatchesRequested: rows.filter(row => row.requested > 0).length,
    durationMs: rows.reduce((sum, row) => sum + row.durationMs, 0), rejectionReasons: reasons, rows };
}
