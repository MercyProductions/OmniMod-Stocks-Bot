import { requestAlpacaJson, alpacaRateLimit } from '../../shared/alpacaHttp.js';
import { waitForAlpacaRequest } from '../../shared/alpacaRequestGate.js';
import { parseAlpacaStockQuote, stockQuoteEvidenceRejection } from '../../shared/stockQuoteEvidence.js';

export const ETF_DECISION_QUOTES_VERSION = 'etf-decision-quotes-v1';
export const timeMs = value => typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value);
const symbolOf = input => String(input?.symbol || '').toUpperCase();
const fail = code => Object.assign(new Error(code), { code });
const age = (value, at) => Number.isFinite(timeMs(value)) ? at - timeMs(value) : null;

function inputReason(input, at) {
  const open = timeMs(input.session?.openTime), close = timeMs(input.session?.closeTime);
  if (![open, close].every(Number.isFinite) || close <= open) return 'quote_refresh_invalid_session';
  if (at < open || at >= close) return 'quote_refresh_session_closed';
  const ends = (Array.isArray(input.bars) ? input.bars : []).map(row => timeMs(row?.time) + 300000)
    .filter(end => Number.isFinite(end) && end <= at && end > open && end <= close);
  if (!ends.length) return 'quote_refresh_intraday_bars_missing';
  const skew = Math.min(90000, Number(input.config?.maxQuoteBarSkewMs ?? 90000));
  if (!Number.isFinite(skew) || skew <= 0 || at - Math.max(...ends) > skew) return 'quote_refresh_intraday_bars_stale';
  return null;
}

function quoteReason(input, feed, at, maxAgeMs) {
  const q = input.quote, elapsed = age(q?.time, at);
  if (elapsed === null || elapsed < 0 || elapsed > maxAgeMs) return 'stale_or_future_quote';
  if (!(typeof q?.bid === 'number' && q.bid > 0 && typeof q?.ask === 'number' && q.ask >= q.bid)) return 'invalid_bid_ask';
  if (feed === 'iex' && q.quality === 'reference' && !q.stockQuoteEvidence) return null;
  return stockQuoteEvidenceRejection(symbolOf(input), q?.stockQuoteEvidence, { ...q, time: new Date(timeMs(q.time)).toISOString() }, feed);
}

/** Quote-only work for the already selected deep-analysis pool. Original bars,
 * reviews, classification and their timestamps are retained, never made fresh. */
export async function refreshEtfDecisionQuotes(inputs, { env = process.env, clock = Date.now, fetcher = fetch,
  requestGate = waitForAlpacaRequest, providerMetrics = [], maxQuoteAgeMs = 15000, budgetMs = 8000 } = {}) {
  let lastTime = -Infinity;
  const suppliedClock = clock;
  clock = () => {
    const current = suppliedClock();
    if (!Number.isFinite(current) || current < lastTime) throw new TypeError('Invalid ETF quote observation clock.');
    return (lastTime = current);
  };
  const started = clock(), feed = String(env.ETF_ALPACA_FEED || 'iex').toLowerCase();
  if (!Array.isArray(inputs) || !Array.isArray(providerMetrics) || !Number.isFinite(started)
    || !['iex', 'sip', 'delayed_sip'].includes(feed) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 || maxQuoteAgeMs > 15000
    || !Number.isFinite(budgetMs) || budgetMs < 0 || budgetMs > 15000) throw new TypeError('Invalid ETF quote refresh policy.');
  const deadline = started + budgetMs, counts = new Map(), quotes = new Map(), reasons = new Map(), sources = new Map(), requested = [];
  for (const row of inputs) counts.set(symbolOf(row), (counts.get(symbolOf(row)) || 0) + 1);
  for (const input of inputs) {
    const symbol = symbolOf(input);
    const reason = !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? 'quote_refresh_invalid_symbol'
      : counts.get(symbol) > 1 ? 'quote_refresh_duplicate_symbol'
      : feed === 'delayed_sip' ? 'quote_refresh_delayed_feed_not_executable' : inputReason(input, started);
    if (reason) reasons.set(symbol, reason);
    else if (!quoteReason(input, feed, started, maxQuoteAgeMs)) { quotes.set(symbol, input.quote); sources.set(symbol, 'reused_fresh'); }
    else requested.push(symbol);
  }
  const key = env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID, secret = env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  let stopped = !key || !secret ? 'quote_refresh_credentials_missing' : null, remainingQuota = null, batchRequests = 0, attemptedSymbols = 0;
  const gate = key => requestGate(key, { maxWaitMs: Math.max(0, Math.min(2000, deadline - clock())) });
  gate.defer = (...args) => requestGate.defer?.(...args); gate.observe = (...args) => requestGate.observe?.(...args);
  const boundedFetch = async (url, options) => {
    const remaining = Math.floor(deadline - clock());
    if (remaining <= 0) throw fail('quote_refresh_time_budget');
    batchRequests++; attemptedSymbols += new URL(url).searchParams.get('symbols').split(',').length;
    const response = await fetcher(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(5000, remaining))]) });
    remainingQuota = alpacaRateLimit(response.headers)?.remaining ?? null;
    return response;
  };
  for (let offset = 0; offset < requested.length; offset += 100) {
    const batch = requested.slice(offset, offset + 100);
    if (!stopped && clock() >= deadline) stopped = 'quote_refresh_time_budget';
    if (!stopped && remainingQuota !== null && remainingQuota <= 5) stopped = 'quote_refresh_quota_headroom';
    if (stopped) { batch.forEach(symbol => reasons.set(symbol, stopped)); continue; }
    let payload;
    try {
      const params = new URLSearchParams({ symbols: batch.join(','), feed, currency: 'USD' });
      payload = await requestAlpacaJson(`https://data.alpaca.markets/v2/stocks/quotes/latest?${params}`, headers,
        boundedFetch, providerMetrics, 'Alpaca ETF decision quotes', { maxAttempts: 1, requestGate: gate, clock });
      if (clock() >= deadline) throw fail('quote_refresh_time_budget');
      if (!payload?.quotes || typeof payload.quotes !== 'object' || Array.isArray(payload.quotes) || payload.next_page_token != null)
        throw fail('quote_refresh_invalid_response');
    } catch (error) {
      const code = error.code || error.cause?.code;
      const reason = code?.startsWith('quote_refresh_') ? code : /^ALPACA_(?:BUDGET_|PACING_DEFERRED)/.test(code || '')
        ? 'quote_refresh_budget_deferred' : [401,403,429].includes(error.status) ? `quote_refresh_http_${error.status}` : 'quote_refresh_provider_failure';
      batch.forEach(symbol => reasons.set(symbol, reason));
      if (reason !== 'quote_refresh_invalid_response') stopped = reason;
      continue;
    }
    for (const symbol of batch) {
      try {
        if (!Object.hasOwn(payload.quotes, symbol)) throw fail('quote_refresh_symbol_missing');
        const quote = parseAlpacaStockQuote(payload.quotes[symbol], { symbol, feed, source: 'latest', now: clock(), maxQuoteAgeMs });
        quotes.set(symbol, { ...quote, quality: feed === 'sip' ? 'executable' : 'reference' }); sources.set(symbol, 'refreshed');
      } catch (error) { reasons.set(symbol, error.code || 'stock_quote_evidence_required'); }
    }
  }
  const completed = clock(), observations = [], rejectionReasons = {};
  const trades = inputs.map(input => {
    const symbol = symbolOf(input), quote = quotes.get(symbol);
    const reason = reasons.get(symbol) || inputReason(input, completed) || quoteReason({ ...input, quote }, feed, completed, maxQuoteAgeMs);
    if (reason) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    observations.push({ symbol, priorQuoteAgeMs: age(input.quote?.time, started), quoteAgeMs: reason ? null : age(quote?.time, completed),
      source: reason ? 'unavailable' : sources.get(symbol), reason: reason || null });
    return { ...input, quote: reason ? null : quote, quoteRefreshReason: reason || null };
  });
  return { trades, diagnostics: { version: ETF_DECISION_QUOTES_VERSION, feed, inputRows: inputs.length,
    refreshNeeded: requested.length, attemptedSymbols, batchRequests, durationMs: Math.max(0, completed - started), budgetMs,
    refreshed: observations.filter(r => r.source === 'refreshed').length, reusedFresh: observations.filter(r => r.source === 'reused_fresh').length,
    rejected: observations.filter(r => r.reason).length, observations, rejectionReasons } };
}

export function etfQuoteAges(inputs, at = Date.now()) {
  return inputs.map(input => ({ symbol: symbolOf(input), observedAt: new Date(at).toISOString(), quoteAgeMs: age(input.quote?.time, at),
    latestCompletedBarAgeMs: (() => { const ends = (input.bars || []).map(row => timeMs(row.time) + 300000).filter(end => Number.isFinite(end) && end <= at);
      return ends.length ? at - Math.max(...ends) : null; })() }));
}
