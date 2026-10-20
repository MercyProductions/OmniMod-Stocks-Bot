import { isOandaPriceTradeable, readOandaPriceLevel } from './quoteQuality.js';

// Descriptive coverage counter only: this set never restricts membership.
const G10_CURRENCIES = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'NOK', 'SEK']);
const validPair = (value) => typeof value === 'string' && /^[A-Z]{3}_[A-Z]{3}$/.test(value) && value.slice(0, 3) !== value.slice(4);

/** OANDA documents one unpaginated, account-specific instrument response. */
export function normalizeOandaDirectory(payload) {
  if (!Array.isArray(payload?.instruments)) throw new Error('OANDA account instrument response is missing its instruments array.');
  if (payload.next || payload.nextPage || payload.nextPageToken) throw new Error('Unexpected instrument pagination; enumeration is incomplete.');
  const seen = new Set();
  const instruments = payload.instruments.map((row) => {
    if (typeof row?.name !== 'string' || !row.name || typeof row.type !== 'string') throw new Error('Invalid account instrument identity.');
    if (seen.has(row.name)) throw new Error('Duplicate account instrument identity.');
    seen.add(row.name);
    const eligibleFx = row.type === 'CURRENCY' && validPair(row.name);
    return { ...row, identity: 'oanda:practice:' + row.name, eligibleFx,
      exclusionReason: eligibleFx ? null : row.type === 'CURRENCY' ? 'invalid_fx_identity' : 'non_fx_instrument' };
  });
  return { instruments, currencyInstruments: instruments.filter((row) => row.eligibleFx).map((row) => row.name).sort(),
    providerRows: instruments.length, enumeration: 'unpaginated_account_endpoint' };
}

export function assessOandaDiscoveryPrice(row, { now, maxQuoteAgeMs, maxSpreadPct = Infinity }) {
  const bid = readOandaPriceLevel(row?.bids), ask = readOandaPriceLevel(row?.asks);
  const time = Date.parse(row?.time);
  if (!isOandaPriceTradeable(row)) return { reason: 'instrument_not_tradeable' };
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) return { reason: 'invalid_bid_ask' };
  if (!Number.isFinite(time) || time > now + 5_000 || now - time > maxQuoteAgeMs) return { reason: 'stale_or_invalid_quote' };
  const midpoint = (bid + ask) / 2;
  const quality = { bid, ask, midpoint, time: new Date(time).toISOString(), spreadBps: (ask - bid) / midpoint * 10_000 };
  // Same midpoint denominator as the existing shared risk gate.
  if ((ask - bid) / midpoint * 100 > maxSpreadPct) return { ...quality, reason: 'spread_exceeds_existing_risk_limit' };
  return quality;
}

/**
 * Quote the complete account-supported FX directory cheaply, then bound history
 * downloads. Configured priority never bypasses quote quality or risk limits.
 * Movement is research telemetry, not a new trading strategy.
 */
export async function discoverOandaFxUniverse({ fetchInstruments, fetchPrices, configuredInstruments = [],
  maxInstruments = 20, now = Date.now(), clock = () => now, maxQuoteAgeMs = 120_000,
  maxSpreadPct = Infinity, previousQuotes = {} } = {}) {
  if (typeof fetchInstruments !== 'function' || typeof fetchPrices !== 'function') throw new TypeError('OANDA instrument and pricing fetchers are required.');
  if (!Number.isSafeInteger(maxInstruments) || maxInstruments < 1 || maxInstruments > 100) throw new RangeError('Forex universe cap must be an integer from 1 to 100.');
  if (!Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 || !(maxSpreadPct > 0)) throw new RangeError('Forex discovery clock and quote policy must be valid.');
  const configured = [...new Set(configuredInstruments.map((value) => String(value).trim().toUpperCase()).filter(Boolean))];
  if (configured.some((pair) => !validPair(pair))) throw new Error('Configured Forex instruments must use BASE_QUOTE currency-pair symbols.');
  const directory = normalizeOandaDirectory(await fetchInstruments());
  const eligible = directory.currencyInstruments;
  const eligibleSet = new Set(eligible), configuredSet = new Set(configured);
  const unsupportedConfigured = configured.filter((pair) => !eligibleSet.has(pair));
  const configuredSupported = configured.filter((pair) => eligibleSet.has(pair));
  const discovered = eligible.filter((pair) => !configuredSet.has(pair));
  const quotes = new Map(), quoteRows = new Map();
  const providerQuoteErrors = [], unexpectedQuoteRows = [];
  let successfulQuoteBatches = 0;
  const quoteStartedAt = clock();
  // 50 is our bounded request size, not a claimed provider maximum.
  for (let index = 0; index < eligible.length; index += 50) {
    const chunk = eligible.slice(index, index + 50), requested = new Set(chunk), seen = new Set(), duplicates = new Set();
    try {
      const result = await fetchPrices(chunk);
      if (!Array.isArray(result?.prices)) throw new Error('OANDA pricing response is missing its prices array.');
      successfulQuoteBatches++;
      for (const price of result.prices) {
        const symbol = price?.instrument;
        if (!requested.has(symbol)) { unexpectedQuoteRows.push({ instrument: typeof symbol === 'string' ? symbol : null, reason: 'unexpected_quote_identity' }); continue; }
        if (seen.has(symbol)) duplicates.add(symbol);
        seen.add(symbol);
        quoteRows.set(symbol, price);
      }
      for (const symbol of chunk) {
        if (duplicates.has(symbol)) {
          quoteRows.delete(symbol);
          quotes.set(symbol, { reason: 'duplicate_quote_identity' });
        } else if (!seen.has(symbol)) quotes.set(symbol, { reason: 'provider_returned_no_quote' });
      }
    } catch (error) {
      providerQuoteErrors.push({ symbols: chunk, reason: String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/[\r\n\t]+/g, ' ').slice(0, 180) });
      for (const symbol of chunk) { quoteRows.delete(symbol); quotes.set(symbol, { reason: 'discovery_quote_request_failed' }); }
    }
  }
  const quoteFinishedAt = clock();
  // Earlier batches may have aged during subsequent requests/retries.
  for (const [symbol, price] of quoteRows) quotes.set(symbol, assessOandaDiscoveryPrice(price, { now: quoteFinishedAt, maxQuoteAgeMs, maxSpreadPct }));
  const qualified = eligible.filter((symbol) => !quotes.get(symbol)?.reason);
  const ranked = discovered.filter((symbol) => !quotes.get(symbol)?.reason)
    .sort((a, b) => quotes.get(a).spreadBps - quotes.get(b).spreadBps || a.localeCompare(b));
  const ordered = [...configuredSupported.filter((symbol) => !quotes.get(symbol)?.reason), ...ranked];
  const selected = ordered.slice(0, maxInstruments), selectedSet = new Set(selected);
  const capOmissions = ordered.slice(maxInstruments);
  const screenRows = eligible.map((instrument) => {
    const quality = quotes.get(instrument);
    const previous = previousQuotes[instrument];
    const previousQuality = assessOandaDiscoveryPrice(previous, { now: quoteFinishedAt, maxQuoteAgeMs: 3_600_000 });
    const oldMid = previousQuality.reason ? NaN : previousQuality.midpoint;
    const movementWindowMs = Date.parse(quality?.time) - Date.parse(previous?.time);
    const movementValid = oldMid > 0 && quality?.midpoint > 0 && movementWindowMs > 0 && movementWindowMs <= 3_600_000;
    return { instrument, identity: 'oanda:practice:' + instrument, configuredPriority: configuredSet.has(instrument),
      quoteQuality: quality, selected: selectedSet.has(instrument),
      movementBps: movementValid ? (quality.midpoint / oldMid - 1) * 10_000 : null,
      movementWindowMs: movementValid ? movementWindowMs : null,
      rejectionReason: quality?.reason ?? (selectedSet.has(instrument) ? null : 'deep_analysis_cap') };
  });
  const rejected = [
    ...directory.instruments.filter((row) => !row.eligibleFx).map((row) => ({ instrument: row.name, stage: 'membership', reason: row.exclusionReason })),
    ...unsupportedConfigured.map((instrument) => ({ instrument, stage: 'membership', reason: 'configured_instrument_not_supported_by_account' })),
    ...screenRows.filter((row) => row.rejectionReason).map((row) => ({ instrument: row.instrument,
      stage: row.rejectionReason === 'deep_analysis_cap' ? 'shortlist' : 'quote_quality', reason: row.rejectionReason })),
  ];
  const counts = {};
  for (const row of rejected) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  const eligibleG10 = eligible.filter((pair) => pair.split('_').every((currency) => G10_CURRENCIES.has(currency)));
  return {
    instruments: selected, accountInstruments: eligible, instrumentDefinitions: directory.instruments, screenRows,
    discoveredQuotes: Object.fromEntries(selected.map((symbol) => [symbol, quotes.get(symbol)])),
    // Full quote coverage supports conversion and monitoring beyond the shortlist.
    // Consumers must recheck freshness/tradeability; rejected prices are not entries.
    quoteRows: Object.fromEntries(quoteRows),
    diagnostics: {
      providerInstruments: directory.providerRows, enumeration: directory.enumeration,
      accountCurrencyInstruments: eligible.length, eligibleG10Instruments: eligibleG10.length,
      nonG10Instruments: eligible.length - eligibleG10.length, excludedNonFxOrInvalid: directory.providerRows - eligible.length,
      discoveryEligibleInstruments: eligible.length, configuredInstruments: configured.length,
      configuredSupported: configuredSupported.length, configuredUnsupported: unsupportedConfigured.length,
      cheaplyScreened: eligible.length, quoteBatches: Math.ceil(eligible.length / 50), successfulQuoteBatches,
      quoteRowsReturned: quoteRows.size, discoveredPairsQuoteScreened: discovered.length,
      quoteCoverageStatus: quoteRows.size === eligible.length ? 'complete' : 'partial',
      quoteQualified: qualified.length, discoveredQuoteQualified: ranked.length,
      selectedDiscovered: selected.filter((symbol) => !configuredSet.has(symbol)).length,
      configuredQuoteRejected: configuredSupported.filter((symbol) => quotes.get(symbol)?.reason).length,
      capOmissions: capOmissions.length, quoteRejected: eligible.length - qualified.length,
      movementMeasured: screenRows.filter((row) => row.movementBps !== null).length,
      quoteStageMs: Math.max(0, quoteFinishedAt - quoteStartedAt),
      providerQuoteErrors, unexpectedQuoteRows, rejected,
      topRejectionReasons: Object.entries(counts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      rankMethod: 'Fresh quality-checked configured pairs first, then every other account-supported FX pair by relative spread and symbol. Movement is research telemetry, not strategy approval.',
    },
  };
}
