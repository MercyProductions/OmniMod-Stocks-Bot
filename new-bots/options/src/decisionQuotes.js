import { normalizedQuote, fetchTradierMarketClock } from './tradierMarketData.js';
import { createTradierMarketFetch } from '../../shared/tradierHttp.js';
import { waitForTradierStartSlot } from './tradierRateLimit.js';
import { tradierQuoteRows } from '../../shared/tradierOptionResponses.js';
import { parseOccSymbol, optionIdentityOccurrences, validateStandardOptionIdentity, tradierContractIdentity,
  tradierUnderlyingSymbol, optionNumber } from '../../shared/optionContractIdentity.js';
import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { assessOptionHypothesis } from './primaryHypothesis.js';

const stamp = value => typeof value === 'number' ? value : Date.parse(value ?? '');

/** Refresh prices only for already-downloaded primary-signal contracts. Never expands/rebases the hypothesis. */
export function createOptionDecisionRefresher({ source, token, environment = 'sandbox', config = {},
  providerMetrics = [], clock = Date.now, fetchImpl = fetch, startPacer = waitForTradierStartSlot,
  budgetMs = 8000, primarySignalMaxAgeMs = 120000 } = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 8000
    || !Number.isFinite(primarySignalMaxAgeMs) || primarySignalMaxAgeMs <= 0 || primarySignalMaxAgeMs > 120000)
    throw new RangeError('Invalid Options decision quote budget.');
  const diagnostics = { version: 'options-decision-quotes-v1', observations: 0, reused: 0, refreshed: 0, rejected: 0, skipped: 0,
    quoteBatchesRequested: 0, contractsRequested: 0, elapsedMs: 0, rows: [] };
  const cache = new WeakMap();
  let deadline = null, lastTime = null;
  const at = () => {
    const time = clock();
    if (!Number.isFinite(time) || lastTime !== null && time < lastTime) throw new RangeError('Invalid Options decision observation clock.');
    lastTime = time;
    return time;
  };
  const fresh = (quote, now, age) => quote?.quality === 'executable' && Number.isFinite(stamp(quote.time))
    && stamp(quote.time) <= now + 5000 && now - stamp(quote.time) <= age;
  return { diagnostics, async refresh(original) {
    if (source !== 'tradier') return original;
    diagnostics.observations++;
    let row = cache.get(original)?.row ?? original;
    const entry = { symbol: row.signal?.underlyingSymbol ?? null, status: 'not_started', quoteAgeBeforeMs: null };
    diagnostics.rows.push(entry);
    const reject = reason => {
      diagnostics.rejected++; entry.status = 'rejected'; entry.reason = reason;
      const rejected = { ...row, marketDataStatus: reason, chain: row.chain ? { ...row.chain, quoteQuality: 'unusable' } : row.chain,
        signal: row.signal ? { ...row.signal, underlyingQuote: { ...row.signal.underlyingQuote, quality: 'unusable' } } : row.signal };
      cache.set(original, { row: rejected, attempted: true });
      return rejected;
    };
    let now;
    try { now = at(); } catch { return reject('decision_observation_clock_invalid'); }
    entry.evaluatedAt = new Date(now).toISOString();
    const previous = stamp(row.signal?.underlyingQuote?.time);
    entry.quoteAgeBeforeMs = Number.isFinite(previous) ? now - previous : null;
    if (environment !== 'production' || !token) return reject(environment !== 'production' ? 'sandbox_data_is_delayed' : 'credentials_missing');
    if (!['ready', 'no_verified_contract_quotes'].includes(row.marketDataStatus)) return reject(row.marketDataStatus || 'provider_data_unavailable');
    if ((row.config?.requireDividendProvider ?? config.requireDividendProvider) === true
      && row.signal?.direction === 'long' && row.signal.corporateActionScreenStatus !== 'pagination_complete') {
      diagnostics.skipped++; entry.status = 'skipped'; entry.reason = 'cash_dividend_screen_unavailable_or_incomplete';
      return row; // The unchanged strategy reports this known block without spending quote quota.
    }
    const maxAge = Number(row.config?.maxQuoteAgeMs ?? config.maxQuoteAgeMs ?? 10000);
    const skew = Number(row.config?.maxLegSkewMs ?? config.maxLegSkewMs ?? 3000);
    if (!(maxAge > 0 && maxAge <= 10000 && skew > 0 && skew <= 3000)) return reject('invalid_strategy_config');
    const primary = assessOptionHypothesis({ signal: row.signal, primarySignalObservedAt: row.primarySignalObservedAt,
      now, maxAgeMs: primarySignalMaxAgeMs });
    if (!primary.valid) return reject(primary.reason === 'primary_signal_expired'
      ? 'primary_signal_expired_before_quote_refresh' : primary.reason);
    entry.primarySignalObservedAt = primary.hypothesis.observedAt;
    entry.entryExpiresAt = primary.entryExpiresAt;
    if (!isFreshClearCatalystReview(row.signal?.catalystReview, { now,
      maxAgeMs: Number(row.config?.maxCatalystReviewAgeMs ?? config.maxCatalystReviewAgeMs ?? 1800000) })) return reject('catalyst_review_required');
    const underlying = tradierUnderlyingSymbol(row.signal?.underlyingSymbol), expiry = row.chain?.expiry;
    const options = Array.isArray(row.chain?.options) ? row.chain.options : [];
    const occurrences = optionIdentityOccurrences(options);
    const type = row.signal?.direction === 'long' ? 'call' : row.signal?.direction === 'short' ? 'put' : null;
    const legs = options.filter(leg => leg?.type === type && validateStandardOptionIdentity(leg, { underlying, expiry, occurrences }).valid);
    if (!underlying || !legs.length) return reject('no_verified_contracts_for_refresh');
    const quotes = [row.signal.underlyingQuote, ...legs.map(leg => ({ ...leg, quality: leg.quoteQuality }))];
    if (cache.get(original)?.attempted && row.marketDataStatus === 'ready'
      && fresh(row.signal.underlyingQuote, now, maxAge)) {
      // Reuse the same refresh across shadow profiles; each profile still checks
      // every leg, timestamp and strategy rule at its current decision time.
      diagnostics.reused++; entry.status = 'reused'; return row;
    }
    if (row.marketDataStatus === 'ready' && quotes.every(q => fresh(q, now, Math.min(2500, maxAge / 2)))
      && Math.max(...quotes.map(q => stamp(q.time))) - Math.min(...quotes.map(q => stamp(q.time))) <= skew) {
      diagnostics.reused++; entry.status = 'reused'; return row;
    }
    if (cache.get(original)?.attempted) return reject('decision_quotes_expired_after_refresh');
    deadline ??= now + budgetMs;
    if (now >= deadline) return reject('decision_quote_budget_exhausted');
    const began = now;
    const pacer = (key, env, settings = {}) => startPacer(key, env, { ...settings, maxWaitMs: Math.max(0, Math.min(2000, deadline - at())) });
    pacer.observe = (...args) => startPacer.observe?.(...args);
    pacer.deferStarts = (...args) => startPacer.deferStarts?.(...args);
    const boundedFetch = (url, init) => fetchImpl(url, { ...init,
      signal: AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(deadline - at()))))].filter(Boolean)) });
    const measured = createTradierMarketFetch({ token, environment, fetchImpl: boundedFetch, providerMetrics, clockNow: at,
      startPacer: pacer, deadline, maxAttempts: 1, maxRetryWaitMs: 0,
      operation: args => new URL(args[0]).pathname.endsWith('/clock') ? 'decision-market-clock' : 'decision-option-quotes' });
    try {
      const market = await fetchTradierMarketClock({ token, environment, fetchImpl: measured, now: at(), clockNow: at });
      if (market.status !== 'open') return reject(market.status);
      if (market.sessionDate !== row.signal.sessionDate || market.sessionClose !== row.signal.sessionClose) return reject('decision_session_changed');
      const currentLegs = new Map(), symbolReasons = {};
      let underlyingQuote;
      // 39 contracts plus the underlying in each request keep URLs bounded and
      // allow the final strategy to compare native times, including cross-batch skew.
      for (let offset = 0; offset < legs.length; offset += 39) {
        if (at() >= deadline) return reject('decision_quote_budget_exhausted');
        const selected = legs.slice(offset, offset + 39);
        const url = new URL('https://api.tradier.com/v1/markets/quotes');
        url.searchParams.set('symbols', [underlying, ...selected.map(leg => parseOccSymbol(leg.symbol).canonical)].join(','));
        url.searchParams.set('greeks', 'true');
        diagnostics.quoteBatchesRequested++; diagnostics.contractsRequested += selected.length;
        const response = await measured(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(deadline - at())))) });
        if (!response.ok) return reject(`decision_quote_http_${Number(response.status) || 0}`);
        const raw = tradierQuoteRows(await response.json());
        now = at();
        const underlyingRows = raw.filter(value => tradierUnderlyingSymbol(value?.symbol) === underlying);
        if (underlyingRows.length !== 1) return reject('decision_underlying_quote_missing_or_duplicate');
        underlyingQuote = normalizedQuote(underlyingRows[0], now, maxAge, environment);
        if (!fresh(underlyingQuote, now, maxAge)) return reject('decision_underlying_quote_invalid');
        const counts = optionIdentityOccurrences(raw);
        for (const previousLeg of selected) {
          const symbol = parseOccSymbol(previousLeg.symbol).canonical;
          const value = raw.find(value => parseOccSymbol(value?.symbol)?.canonical === symbol);
          const identity = tradierContractIdentity(value, { underlying, expiry, occurrences: counts });
          const quote = normalizedQuote(value, now, maxAge, environment, { allowZeroBid: true });
          if (!identity.valid || quote.quality !== 'executable') {
            symbolReasons[symbol] = !identity.valid ? identity.reasons : ['stale_or_invalid_quote'];
            continue;
          }
          currentLegs.set(symbol, { ...previousLeg, bid: quote.bid, ask: quote.ask, time: quote.time, quoteQuality: quote.quality,
            volume: optionNumber(value.volume), openInterest: optionNumber(value.open_interest),
            greeks: value.greeks ? { delta: optionNumber(value.greeks.delta), gamma: optionNumber(value.greeks.gamma),
              theta: optionNumber(value.greeks.theta), vega: optionNumber(value.greeks.vega),
              impliedVolatility: optionNumber(value.greeks.mid_iv), updatedAt: value.greeks.updated_at ?? null } : null });
        }
      }
      now = at();
      entry.contractRejections = symbolReasons;
      if (now >= deadline) return reject('decision_quote_budget_exhausted');
      if (now >= Date.parse(market.sessionClose)) return reject('session_closed_during_quotes');
      if (!fresh(underlyingQuote, now, maxAge)) return reject('decision_underlying_quote_expired');
      if (now >= Date.parse(primary.entryExpiresAt)) return reject('primary_signal_expired_during_quote_refresh');
      for (const [symbol, leg] of currentLegs) {
        if (!fresh({ ...leg, quality: leg.quoteQuality }, now, maxAge)) {
          currentLegs.delete(symbol); symbolReasons[symbol] = ['quote_expired_during_collection'];
        }
      }
      const midpoint = (underlyingQuote.bid + underlyingQuote.ask) / 2;
      const low = row.signal.entryLow == null ? -Infinity : Number(row.signal.entryLow);
      const high = row.signal.entryHigh == null ? Infinity : Number(row.signal.entryHigh);
      if (!(midpoint >= low && midpoint <= high)) return reject('quote_outside_primary_entry_zone');
      row = { ...row, marketDataStatus: 'ready', primarySignalObservedAt: primary.hypothesis.observedAt,
        quote: underlyingQuote, signal: { ...row.signal, primaryHypothesis: primary.hypothesis,
          underlyingQuote, underlyingPrice: midpoint, observedAt: underlyingQuote.time },
        chain: { ...row.chain, options: options.map(leg => currentLegs.get(parseOccSymbol(leg?.symbol)?.canonical)
          ?? { ...leg, quoteQuality: 'unusable' }), quoteQuality: currentLegs.size ? 'executable' : 'unusable' } };
      cache.set(original, { row, attempted: true });
      diagnostics.refreshed++; entry.status = 'refreshed'; entry.refreshedAt = new Date(now).toISOString();
      entry.quoteAgeAfterMs = now - stamp(underlyingQuote.time); entry.contractsRefreshed = currentLegs.size;
      return row;
    } catch (error) { return reject(error.code || 'decision_quote_refresh_failed'); }
    finally { diagnostics.elapsedMs += Math.max(0, lastTime - began); }
  } };
}
