import { fetchTradierChains } from '../../multi-asset/src/tradierOptions.js';
import { captureOptionHypothesis } from './primaryHypothesis.js';
import { optionNumber, parseOccSymbol, tradierUnderlyingSymbol, optionIdentityOccurrences, tradierContractIdentity,
  validateStandardOptionIdentity } from '../../shared/optionContractIdentity.js';
import { tradierQuoteRows } from '../../shared/tradierOptionResponses.js';
import { canonicalExposureKey } from '../../shared/exposureAliases.js';
import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { waitForTradierStartSlot } from './tradierRateLimit.js';
import { createTradierMarketFetch } from '../../shared/tradierHttp.js';
import { loadPendingOptionReviews } from './pendingEntryReviews.js';
import { OPTION_ENTRY_EVIDENCE_VERSION, assessOptionEntryEvidence } from '../../shared/optionEntryEvidence.js';
export { requestTradierWithRetry } from '../../shared/tradierHttp.js';

const BASE_URL = 'https://api.tradier.com/v1';

function toTime(value) {
  if (value == null || value === '') return NaN;
  const n = optionNumber(value);
  const milliseconds = n !== null ? (n < 1e12 ? n * 1000 : n) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : NaN;
}
export function normalizedQuote(row, now, maxAgeMs, environment, { allowZeroBid = false } = {}) {
  const bid = optionNumber(row?.bid), ask = optionNumber(row?.ask);
  const bidTime = toTime(row?.bid_date ?? row?.biddate);
  const askTime = toTime(row?.ask_date ?? row?.askdate);
  const time = Math.min(bidTime, askTime);
  const valid = row?.symbol && Number.isFinite(bid) && (allowZeroBid ? bid >= 0 : bid > 0) && Number.isFinite(ask) && ask > 0 && ask >= bid
    && [bidTime, askTime].every((stamp) => Number.isFinite(stamp) && stamp <= now + 5_000 && now - stamp <= maxAgeMs)
    && Math.abs(bidTime - askTime) <= 3_000;
  return {
    symbol: String(row?.symbol ?? '').toUpperCase(), bid, ask,
    time: Number.isFinite(time) ? new Date(time).toISOString() : null,
    bidTime: Number.isFinite(bidTime) ? new Date(bidTime).toISOString() : null,
    askTime: Number.isFinite(askTime) ? new Date(askTime).toISOString() : null,
    quality: valid && environment === 'production' ? 'executable' : 'delayed',
    source: `Tradier ${environment}`, reason: !valid ? 'stale_or_invalid_quote' : environment !== 'production' ? 'sandbox_data_is_delayed' : null,
  };
}

export async function fetchTradierMarketClock({ token, environment = 'production', fetchImpl = fetch, now = Date.now(), clockNow = Date.now, providerMetrics = [] } = {}) {
  const startedAt = clockNow(), initialNow = now;
  if (!token) throw new Error('TRADIER_TOKEN is required to verify the market session.');
  fetchImpl = createTradierMarketFetch({ fetchImpl, token, environment, providerMetrics, clockNow });
  const url = new URL(`${environment === 'production' ? BASE_URL : 'https://sandbox.tradier.com/v1'}/markets/clock`);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Tradier market clock returned HTTP ${response.status}.`);
  const clock = (await response.json())?.clock;
  now = initialNow + Math.max(0, clockNow() - startedAt);
  const observedAt = toTime(clock?.timestamp);
  const closeAt = toTime(clock?.next_change);
  const state = String(clock?.state ?? '').toLowerCase();
  if (!['open', 'closed', 'premarket', 'postmarket'].includes(state)
    || !Number.isFinite(observedAt) || Math.abs(now - observedAt) > 30_000) {
    return { status: 'invalid_or_stale_market_clock', state: state || null, observedAt: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null };
  }
  if (state !== 'open' || !Number.isFinite(closeAt) || closeAt <= now) {
    return { status: 'market_not_open', state, observedAt: new Date(observedAt).toISOString() };
  }
  const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  return { status: 'open', state, observedAt: new Date(observedAt).toISOString(), sessionDate, sessionClose: new Date(closeAt).toISOString() };
}

/** Read-only Tradier quotes for open shared-paper debit verticals. */
export async function fetchTradierOptionPositionMarks(orders, {
  token, environment = 'sandbox', fetchImpl = fetch, now = Date.now(), maxQuoteAgeMs = 10_000, maxLegSkewMs = 3_000,
  providerMetrics = [], clockNow = Date.now, retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random, maxAttempts = 3, maxRetryWaitMs = 10_000,
  startPacer = waitForTradierStartSlot, deadline = Infinity, entryReviewOptions = {},
} = {}) {
  const initialNow = now, startedAt = clockNow();
  const observedNow = () => initialNow + Math.max(0, clockNow() - startedAt);
  if (!Array.isArray(orders)) throw new TypeError('Open paper orders must be an array.');
  if (!Array.isArray(providerMetrics)) throw new TypeError('providerMetrics must be an array.');
  const positions = orders.filter((order) => order?.owner === 'options' && order.assetClass === 'option'
    && ['reserved', 'filled', 'open'].includes(order.status));
  if (!positions.length) return { marks: [], diagnostics: { status: 'no_open_option_positions', positions: 0, quoted: 0, rejected: 0 } };
  if (environment !== 'production') return { marks: [], diagnostics: { status: environment === 'sandbox' ? 'sandbox_data_is_delayed' : 'unsupported_environment', positions: positions.length, quoted: 0, rejected: positions.length } };
  if (!token) return { marks: [], diagnostics: { status: 'credentials_missing', positions: positions.length, quoted: 0, rejected: positions.length } };
  if (!(maxQuoteAgeMs > 0) || !Number.isFinite(maxQuoteAgeMs)) throw new RangeError('maxQuoteAgeMs must be positive.');
  if (!(maxLegSkewMs > 0) || !Number.isFinite(maxLegSkewMs)) throw new RangeError('maxLegSkewMs must be positive.');
  if (!Number.isFinite(now)) throw new TypeError('Position mark time must be a finite timestamp.');

  const entryReviews = await loadPendingOptionReviews(positions, { ...entryReviewOptions, now: observedNow(), clockNow,
    fetchImpl, providerMetrics, budgetMs: Math.max(1, Math.min(8000, deadline - clockNow())) });
  now = observedNow();

  let providerRequests = 0;
  const measuredFetch = createTradierMarketFetch({ fetchImpl, token, environment, providerMetrics,
    operation: args => new URL(args[0]).pathname.endsWith('/clock') ? 'position-market-clock' : 'position-option-quotes',
    clockNow, retrySleep, random, maxAttempts, maxRetryWaitMs, startPacer, deadline, onRequest: () => { providerRequests += 1; } });
  const clock = await fetchTradierMarketClock({ token, environment, fetchImpl: measuredFetch, now, clockNow });
  if (clock.status !== 'open') return { marks: [], diagnostics: { status: clock.status, positions: positions.length, quoted: 0, rejected: positions.length, providerRequests } };

  const specs = new Map();
  const invalidOrders = new Map();
  for (const order of positions) {
    const long = parseOccSymbol(order.option?.longLeg?.symbol)?.canonical;
    const short = parseOccSymbol(order.option?.shortLeg?.symbol)?.canonical;
    const keys = String(order.instrumentKey ?? '').split('+').map((value) => parseOccSymbol(value)?.canonical);
    // Portfolio aliases (e.g. TLT -> UST_RATES) are risk groups, not contract underlyings.
    // Older genuine OCC records can supply the root, but never a missing multiplier or strike.
    const underlying = tradierUnderlyingSymbol(order.option?.underlyingSymbol ?? parseOccSymbol(long)?.root), expiry = order.option?.expiry;
    const exposureMatches = underlying && canonicalExposureKey({ assetClass: 'option', exposureKey: underlying.replaceAll('/', '.') }) === canonicalExposureKey(order);
    const type = order.option?.strategy === 'bull-call-debit-vertical' ? 'call' : order.option?.strategy === 'bear-put-debit-vertical' ? 'put' : null;
    const identities = ['longLeg', 'shortLeg'].map((key) => validateStandardOptionIdentity({ ...order.option?.[key],
      underlying, expiry, type, multiplier: order.multiplier }, { underlying, expiry }));
    const ordered = type === 'call' ? identities[0].strike < identities[1].strike : identities[0].strike > identities[1].strike;
    if (!long || !short || long === short || keys.length !== 2 || keys[0] !== long || keys[1] !== short
      || !exposureMatches || !identities.every((identity) => identity.valid) || !ordered) {
      invalidOrders.set(order.orderId, 'option_contract_metadata_missing_or_invalid');
      continue;
    }
    if (expiry < clock.sessionDate) { invalidOrders.set(order.orderId, 'option_contract_past_expiry'); continue; }
    specs.set(order.orderId, { long, short, underlying, expiry, pending: order.status === 'reserved' });
  }
  const symbols = [...new Set([...specs.values()].flatMap(({ long, short, underlying, pending }) => pending ? [long, short, underlying] : [long, short]))];
  const rawQuoteRows = [];
  for (let offset = 0; offset < symbols.length; offset += 40) {
    const url = new URL(`${BASE_URL}/markets/quotes`);
    url.searchParams.set('symbols', symbols.slice(offset, offset + 40).join(','));
    // Position marks remain executable bid/ask quotes; Greeks are descriptive
    // hourly provider estimates and never participate in exits or approval.
    url.searchParams.set('greeks', 'true');
    const response = await measuredFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Tradier option position quotes returned HTTP ${response.status}.`);
    rawQuoteRows.push(...tradierQuoteRows(await response.json()));
  }
  const quoteOccurrences = optionIdentityOccurrences(rawQuoteRows);
  now = observedNow();
  if (now >= Date.parse(clock.sessionClose)) return { marks: [], diagnostics: { status: 'session_closed_during_quotes', positions: positions.length, quoted: 0, rejected: positions.length, providerRequests } };
  const quoteRows = new Map(rawQuoteRows.map((row) => [parseOccSymbol(row?.symbol)?.canonical, row]));
  const underlyingRows = symbol => rawQuoteRows.filter(row => tradierUnderlyingSymbol(row?.symbol) === symbol);
  const sessionDateOf = (time) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
  const rejectionReasons = {};
  const reject = (reason) => { rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1; };
  for (const reason of invalidOrders.values()) reject(reason);
  const marks = [];
  for (const order of positions) {
    const spec = specs.get(order.orderId);
    if (!spec) continue;
    const long = quoteRows.get(spec.long), short = quoteRows.get(spec.short);
    const identityReasons = [long, short].flatMap((row) => tradierContractIdentity(row,
      { underlying: spec.underlying, expiry: spec.expiry, occurrences: quoteOccurrences }).reasons);
    if (long && short && identityReasons.length) {
      for (const reason of new Set(identityReasons)) reject(reason);
      continue;
    }
    const longBidTime = toTime(long?.bid_date ?? long?.biddate), longAskTime = toTime(long?.ask_date ?? long?.askdate);
    const shortBidTime = toTime(short?.bid_date ?? short?.biddate), shortAskTime = toTime(short?.ask_date ?? short?.askdate);
    const times = [longBidTime, longAskTime, shortBidTime, shortAskTime];
    const prices = [optionNumber(long?.bid), optionNumber(long?.ask), optionNumber(short?.bid), optionNumber(short?.ask)];
    const reason = !long || !short ? 'option_leg_quote_missing'
      : !times.every((time) => Number.isFinite(time) && time <= now + 5_000 && now - time <= maxQuoteAgeMs) ? 'stale_or_future_option_leg_quote'
        : !times.every((time) => sessionDateOf(time) === clock.sessionDate) ? 'option_quote_outside_current_session'
          : Math.max(...times) - Math.min(...times) > maxLegSkewMs ? 'option_leg_quote_skew'
            : !prices.every(Number.isFinite) || !(prices[0] > 0 && prices[1] >= prices[0] && prices[2] >= 0 && prices[3] >= prices[2]) ? 'invalid_option_leg_bid_ask'
              : null;
    if (reason) { reject(reason); continue; }
    // Liquidate a long debit vertical at long bid minus short ask.
    // A debit vertical cannot be worth less than zero. Near expiry or when
    // deeply OTM, fresh leg quotes may imply a negative natural bid; expose a
    // zero liquidation bid so the shared paper ledger can realize that loss.
    const bid = Number(Math.max(0, prices[0] - prices[3]).toFixed(4));
    const ask = Number((prices[1] - prices[2]).toFixed(4));
    if (!(ask >= bid && ask >= 0)) { reject('invalid_composite_vertical_quote'); continue; }
    const greekSnapshot = (quote) => {
      const source = quote?.greeks;
      if (!source || typeof source !== 'object') return null;
      const asOfRaw = source.updated_at ?? source.updatedAt;
      const asOfMs = Date.parse(asOfRaw ?? '');
      const ageMs = Number.isFinite(asOfMs) ? now - asOfMs : null;
      const value = (...keys) => {
        for (const key of keys) if (source[key] != null && source[key] !== '' && Number.isFinite(Number(source[key]))) return Number(source[key]);
        return null;
      };
      return {
        delta: value('delta'), gamma: value('gamma'), theta: value('theta'), vega: value('vega'),
        impliedVolatility: value('mid_iv', 'midIv', 'smv_vol'),
        asOf: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null,
        ageMs,
        freshness: !Number.isFinite(asOfMs) ? 'timestamp_unavailable'
          : ageMs < 0 ? 'future_or_invalid_timestamp' : ageMs <= 2 * 60 * 60_000 ? 'within_two_hours' : 'older_than_two_hours',
      };
    };
    const longGreeks = greekSnapshot(long), shortGreeks = greekSnapshot(short);
    const net = (field) => Number.isFinite(longGreeks?.[field]) && Number.isFinite(shortGreeks?.[field])
      ? Number((longGreeks[field] - shortGreeks[field]).toFixed(6)) : null;
    const optionGreekContext = {
      source: 'Tradier/ORATS', long: longGreeks, short: shortGreeks,
      net: { delta: net('delta'), gamma: net('gamma'), theta: net('theta'), vega: net('vega') },
      asOf: [longGreeks?.asOf, shortGreeks?.asOf].filter(Boolean).sort().at(-1) ?? null,
      freshness: longGreeks?.freshness === 'within_two_hours' && shortGreeks?.freshness === 'within_two_hours'
        ? 'within_two_hours' : 'partial_or_stale',
    };
    const quote = { bid, ask, time: new Date(Math.min(...times)).toISOString(), quality: 'executable', optionGreekContext };
    if (spec.pending) {
      const rows = underlyingRows(spec.underlying);
      quote.optionEntryEvidence = { version: OPTION_ENTRY_EVIDENCE_VERSION, sessionDate: clock.sessionDate, sessionClose: clock.sessionClose,
        underlyingQuote: rows.length === 1 ? normalizedQuote(rows[0], now, maxQuoteAgeMs, environment) : null,
        catalyst: entryReviews.get(order.orderId) ?? null,
        legs: [long, short].map(row => { const identity = tradierContractIdentity(row, { underlying: spec.underlying, expiry: spec.expiry });
          const q = normalizedQuote(row, now, maxQuoteAgeMs, environment, { allowZeroBid: true });
          return { ...q, quoteQuality: q.quality, type: identity.type, underlying: identity.underlying,
            expiry: identity.expiry, strike: identity.strike, root: identity.root, multiplier: identity.multiplier,
            volume: optionNumber(row.volume), openInterest: optionNumber(row.open_interest) }; }),
      };
    }
    marks.push({ orderId: order.orderId, quote, sessionOpen: true });
  }
  const entryChecks = marks.filter(mark => specs.get(mark.orderId)?.pending).map(mark => assessOptionEntryEvidence(
    positions.find(order => order.orderId === mark.orderId), mark.quote, now, maxQuoteAgeMs));
  const entryRejections = {};
  for (const check of entryChecks) if (!check.valid) entryRejections[check.reason] = (entryRejections[check.reason] || 0) + 1;
  return { marks, diagnostics: { status: 'complete', positions: positions.length, symbols: symbols.length, quoted: marks.length,
    pendingEntryChecks: entryChecks.length, pendingEntryReady: entryChecks.filter(check => check.valid).length, pendingEntryRejections: entryRejections,
    rejected: positions.length - marks.length, rejectionReasons, providerRequests, environment: 'production', maxQuoteAgeMs, maxLegSkewMs } };
}

/** Read-only Tradier quote + chain fetch. Never uses an order endpoint. */
export function summarizeOptionSignalUniverse(rows = [], maxSymbols = 12) {
  if (!Array.isArray(rows)) throw new TypeError('Options signals must be an array.');
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1) throw new RangeError('The option signal cap must be a positive integer.');
  const validRows = rows.filter((row) => row?.signal?.underlyingSymbol);
  const uniqueSignals = [...new Map(validRows
    .map((row) => [String(row.signal.underlyingSymbol).trim().toUpperCase(), row])).values()];
  const retainedRows = uniqueSignals.slice(0, maxSymbols);
  const cappedUnderlyingSymbols = uniqueSignals.slice(maxSymbols)
    .map((row) => String(row.signal.underlyingSymbol).trim().toUpperCase());
  return {
    inputSignals: rows.length,
    validSignals: validRows.length,
    distinctUnderlyings: uniqueSignals.length,
    duplicateSignals: Math.max(0, validRows.length - uniqueSignals.length),
    maxSymbols,
    retainedUnderlyings: retainedRows.length,
    cappedUnderlyings: Math.max(0, uniqueSignals.length - retainedRows.length),
    cappedUnderlyingSymbols,
    cappedRejectionReason: 'provider_request_symbol_cap',
  };
}

export async function fetchTradierOptionInputs(rows, {
  token, environment = 'sandbox', fetchImpl = fetch, now = Date.now(), maxQuoteAgeMs = 10_000,
  maxCatalystReviewAgeMs = 30 * 60_000,
  minDaysToExpiry = 1, maxDaysToExpiry = 7, providerMetrics = [], clockNow = Date.now,
  retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random, maxAttempts = 3, maxRetryWaitMs = 10_000,
  startPacer = waitForTradierStartSlot, deadline = Infinity, refreshUnderlyingAfterChains = false,
} = {}) {
  const initialNow = now, startedAt = clockNow();
  const observedNow = () => initialNow + Math.max(0, clockNow() - startedAt);
  if (!token) throw new Error('TRADIER_TOKEN is required for the Tradier options data source.');
  if (!['sandbox', 'production'].includes(environment)) throw new Error('TRADIER_ENV must be sandbox or production.');
  if (!Array.isArray(rows)) throw new TypeError('Options signals must be an array.');
  if (!(maxQuoteAgeMs > 0) || !Number.isFinite(maxQuoteAgeMs)) throw new RangeError('maxQuoteAgeMs must be positive.');
  if (!(maxCatalystReviewAgeMs > 0) || !Number.isFinite(maxCatalystReviewAgeMs)) throw new RangeError('maxCatalystReviewAgeMs must be positive.');
  if (!Array.isArray(providerMetrics)) throw new TypeError('providerMetrics must be an array.');
  const maxSymbols = 12;
  const marketDataDiagnostics = summarizeOptionSignalUniverse(rows, maxSymbols);
  const uniqueRows = [...new Map(rows.filter((row) => row?.signal?.underlyingSymbol)
    .map((row) => [String(row.signal.underlyingSymbol).trim().toUpperCase(), { ...row,
      signal: { ...row.signal, primaryHypothesis: captureOptionHypothesis(row.signal, row.primarySignalObservedAt) } }])).values()].slice(0, maxSymbols);
  const withDiagnostics = (row) => ({ ...row, marketDataDiagnostics });
  if (!uniqueRows.length) return [];
  let providerRequests = 0;
  const measuredFetch = createTradierMarketFetch({ fetchImpl, token, environment, providerMetrics,
    clockNow, retrySleep, random, maxAttempts, maxRetryWaitMs, startPacer, deadline, onRequest: () => { providerRequests += 1; } });
  if (environment === 'sandbox') return uniqueRows.map((row) => withDiagnostics({ ...row, marketDataStatus: 'sandbox_data_is_delayed', providerRequests }));
  const clock = await fetchTradierMarketClock({ token, environment, fetchImpl: measuredFetch, now, clockNow });
  now = observedNow();
  if (clock.status !== 'open') return uniqueRows.map((row) => withDiagnostics({ ...row, marketDataStatus: clock.status, marketClock: clock, providerRequests }));
  const reviewedRows = uniqueRows.filter((row) => {
    return isFreshClearCatalystReview(row.signal.catalystReview, { now, maxAgeMs: maxCatalystReviewAgeMs });
  });
  if (!reviewedRows.length) return uniqueRows.map((row) => withDiagnostics({ ...row, marketDataStatus: 'catalyst_review_required', marketClock: clock, providerRequests }));
  const baseUrl = environment === 'production' ? BASE_URL : 'https://sandbox.tradier.com/v1';
  const url = new URL(`${baseUrl}/markets/quotes`);
  url.searchParams.set('symbols', reviewedRows.map((row) => tradierUnderlyingSymbol(row.signal.underlyingSymbol)).filter(Boolean).join(','));
  const response = await measuredFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Tradier underlying quotes returned HTTP ${response.status}.`);
  const rawQuotes = tradierQuoteRows(await response.json());
  now = observedNow();
  const symbolKey = (symbol) => tradierUnderlyingSymbol(symbol);
  const quoteCounts = new Map();
  for (const row of rawQuotes) {
    const key = symbolKey(row?.symbol);
    if (key) quoteCounts.set(key, (quoteCounts.get(key) || 0) + 1);
  }
  const quotes = new Map(rawQuotes.filter((row) => symbolKey(row?.symbol)).map((row) => {
    const key = symbolKey(row.symbol);
    return [key, quoteCounts.get(key) > 1 ? { quality: 'unusable', reason: 'duplicate_underlying_quote' }
      : normalizedQuote(row, now, maxQuoteAgeMs, environment)];
  }));
  const eligibleRows = reviewedRows.filter((row) => {
    const quote = quotes.get(symbolKey(row.signal.underlyingSymbol));
    if (quote?.quality !== 'executable') return false;
    const midpoint = (quote.bid + quote.ask) / 2;
    const low = row.signal.entryLow == null ? -Infinity : Number(row.signal.entryLow);
    const high = row.signal.entryHigh == null ? Infinity : Number(row.signal.entryHigh);
    return midpoint >= low && midpoint <= high;
  });
  const chains = eligibleRows.length ? await fetchTradierChains(eligibleRows.map((row) => ({ symbol: row.signal.underlyingSymbol, expiry: 'auto' })), {
    token, environment, fetchImpl: measuredFetch, now: observedNow(), clockNow, maxAgeMinutes: maxQuoteAgeMs / 60_000,
    minDaysToExpiry, maxDaysToExpiry,
  }) : [];
  if (refreshUnderlyingAfterChains && chains.length) {
    const refreshed = await measuredFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!refreshed.ok) throw new Error(`Tradier refreshed underlying quotes returned HTTP ${refreshed.status}.`);
    const values = tradierQuoteRows(await refreshed.json());
    const counts = new Map();
    for (const row of values) counts.set(symbolKey(row?.symbol), (counts.get(symbolKey(row?.symbol)) || 0) + 1);
    quotes.clear(); now = observedNow();
    for (const row of values) {
      const symbol = symbolKey(row?.symbol);
      if (symbol) quotes.set(symbol, counts.get(symbol) > 1 ? { quality: 'unusable', reason: 'duplicate_underlying_quote' }
        : normalizedQuote(row, now, maxQuoteAgeMs, environment));
    }
  }
  now = observedNow();
  const chainBySymbol = new Map(chains.map((chain) => [symbolKey(chain.symbol), chain]));
  return uniqueRows.map((row) => {
    if (now >= Date.parse(clock.sessionClose)) return withDiagnostics({ ...row, marketDataStatus: 'session_closed_during_quotes', providerRequests });
    const sourceSignal = row.signal;
    if (!isFreshClearCatalystReview(sourceSignal.catalystReview, { now, maxAgeMs: maxCatalystReviewAgeMs })) return withDiagnostics({ ...row, marketDataStatus: 'catalyst_review_required', marketClock: clock, providerRequests });
    const quote = quotes.get(symbolKey(sourceSignal.underlyingSymbol));
    const chain = chainBySymbol.get(symbolKey(sourceSignal.underlyingSymbol));
    if (!quote || quote.quality !== 'executable') return withDiagnostics({ ...row, marketDataStatus: quote?.reason || 'underlying_quote_unavailable', quote, chain, providerRequests });
    const originalEntry = Number(sourceSignal.underlyingPrice);
    const originalTarget = Number(sourceSignal.underlyingTarget);
    if (!(originalEntry > 0) || !(originalTarget > 0)) return withDiagnostics({ ...row, marketDataStatus: 'invalid_primary_signal_levels', quote, chain, providerRequests });
    const midpoint = (quote.bid + quote.ask) / 2;
    if (sourceSignal.direction === 'long' && ((sourceSignal.entryLow != null && midpoint < Number(sourceSignal.entryLow))
      || (sourceSignal.entryHigh != null && midpoint > Number(sourceSignal.entryHigh)))) return withDiagnostics({ ...row, marketDataStatus: 'quote_outside_primary_entry_zone', quote, chain, providerRequests });
    if (sourceSignal.direction === 'short' && ((sourceSignal.entryLow != null && midpoint < Number(sourceSignal.entryLow))
      || (sourceSignal.entryHigh != null && midpoint > Number(sourceSignal.entryHigh)))) return withDiagnostics({ ...row, marketDataStatus: 'quote_outside_primary_entry_zone', quote, chain, providerRequests });
    const normalizedChain = chain?.status === 'chain-loaded' ? {
      expiry: chain.expiry, source: chain.source, identityDiagnostics: chain.identityDiagnostics,
      quoteQuality: environment === 'production' && chain.options.some((leg) => leg.quoteValid) ? 'executable' : 'unusable',
      options: chain.options.map((leg) => {
        const quoteTime = Math.min(Date.parse(leg.bidAt), Date.parse(leg.askAt));
        return {
          symbol: leg.symbol, underlying: leg.underlying, root: leg.root, type: leg.type, expiry: leg.expiry, strike: leg.strike, bid: leg.bid, ask: leg.ask,
          identityStatus: leg.identityStatus, identityReasons: leg.identityReasons, rejectionReasons: leg.rejectionReasons,
          time: Number.isFinite(quoteTime) ? new Date(quoteTime).toISOString() : null,
          bidTime: leg.bidAt, askTime: leg.askAt,
          volume: leg.volume, openInterest: leg.openInterest, multiplier: leg.multiplier,
          quoteQuality: leg.quoteValid && environment === 'production' ? 'executable' : 'unusable',
          greeks: leg.greeks ? { ...leg.greeks, impliedVolatility: leg.greeks.midIv ?? leg.impliedVolatility }
            : { delta: leg.delta, impliedVolatility: leg.impliedVolatility },
        };
      }),
    } : chain;
    return withDiagnostics({
      ...row, primarySignalObservedAt: row.primarySignalObservedAt ?? sourceSignal.primaryHypothesis.observedAt,
      marketDataStatus: normalizedChain?.quoteQuality === 'executable' ? 'ready'
        : chain?.status === 'chain-loaded' ? 'no_verified_contract_quotes' : chain?.status || 'chain_unavailable', providerRequests,
      signal: { ...sourceSignal, sessionDate: clock.sessionDate, sessionClose: clock.sessionClose, sessionOpen: true,
        underlyingPrice: midpoint, underlyingTarget: originalTarget, observedAt: quote.time, underlyingQuote: quote },
      chain: normalizedChain, quote,
    });
  });
}
