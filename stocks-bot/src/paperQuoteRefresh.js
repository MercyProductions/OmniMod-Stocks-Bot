import { requestAlpacaJson, alpacaRateLimit } from '../../new-bots/shared/alpacaHttp.js';
import { parseAlpacaStockQuote } from '../../new-bots/shared/stockQuoteEvidence.js';
import { buildStockPaperQuotes } from './paperExecutionQuotes.js';
import { waitForAlpacaRequest } from './alpacaRequestGate.js';
import { recordProviderRequest } from './scanDiagnostics.js';
import { refreshAssetFreshness } from './stocksData.js';

export const STOCK_QUOTE_REFRESH_VERSION = 'stock-decision-quotes-v1-batched';
export const STOCK_QUOTE_REFRESH_BUDGET_MS = 8000;
const symbolOf = asset => String(asset?.symbol || '').toUpperCase();
const validSymbol = symbol => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol);
const errorWith = code => Object.assign(new Error(code), { code });
const ageAt = (time, now) => Number.isFinite(Date.parse(time)) ? now - Date.parse(time) : null;

// Copy execution fields only. Prices/indicators/model decisions and their original
// observation times are never made current by refreshing the order quote.
function withQuote(asset, quote, now, reason = null) {
  const e = quote?.stockQuoteEvidence;
  return { ...asset, bidPrice: quote?.bid ?? 0, askPrice: quote?.ask ?? 0,
    bidSize: e?.bidSizeShares ?? 0, askSize: e?.askSizeShares ?? 0,
    quoteUpdatedAt: quote?.time || '', stockQuoteEvidence: e || null, stockQuoteRejection: reason,
    microstructureProvider: e ? `Alpaca ${e.feed.toUpperCase()} ${e.source}` : '', streamingQuote: e?.source === 'stream',
    spreadBps: quote ? (quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2) * 10000 : 0,
    quoteImbalance: e ? (e.bidSizeShares - e.askSizeShares) / (e.bidSizeShares + e.askSizeShares) : 0,
    quoteAgeSeconds: quote ? ageAt(quote.time, now) / 1000 : null };
}

function failureCode(error) {
  const code = error?.code || error?.cause?.code;
  if (code === 'ALPACA_PACING_DEFERRED') return 'quote_refresh_cooldown_deferred';
  if (code === 'quote_refresh_time_budget') return code;
  const status = Number(error?.status);
  if ([401, 403, 429].includes(status)) return `quote_refresh_http_${status}`;
  return 'quote_refresh_provider_failure';
}

/** Bounded quote-only refresh for already qualified candidates, never universe discovery. */
export async function refreshStockPaperQuotes(assets, { keys = {}, feed = 'iex', maxQuoteAgeMs = 15000,
  budgetMs = STOCK_QUOTE_REFRESH_BUDGET_MS, clock = Date.now, fetcher = fetch, requestGate = waitForAlpacaRequest,
  metrics, force = false } = {}) {
  const started = clock();
  if (!Array.isArray(assets) || !Number.isFinite(started) || !['iex', 'sip'].includes(feed)
    || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0 || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 15000)
    throw new TypeError('Invalid Stocks execution-quote refresh policy.');
  const deadline = started + budgetMs, bySymbol = new Map(), counts = new Map(), reasons = new Map(), sources = new Map();
  for (const asset of assets) {
    const symbol = symbolOf(asset); counts.set(symbol, (counts.get(symbol) || 0) + 1); bySymbol.set(symbol, asset);
  }
  const cached = buildStockPaperQuotes(assets, { feed, now: started, maxQuoteAgeMs }).quotes;
  const quotes = new Map(), requested = [], nativeMetrics = [];
  let attemptedSymbols = 0, batchRequests = 0, quotaRemaining = null, stopped = null;
  for (const [symbol, asset] of bySymbol) {
    if (!validSymbol(symbol)) reasons.set(symbol, 'invalid_stock_symbol');
    else if (counts.get(symbol) > 1) reasons.set(symbol, 'duplicate_stock_symbol');
    else if (asset.halted) reasons.set(symbol, 'stock_halted');
    else if (refreshAssetFreshness(asset, started).freshness === 'stale') reasons.set(symbol, 'quote_refresh_stale_chart');
    else if (!force && cached.has(symbol)) { quotes.set(symbol, cached.get(symbol)); sources.set(symbol, 'reused_fresh'); }
    else requested.push(symbol);
  }
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': keys.alpaca_key_id, 'APCA-API-SECRET-KEY': keys.alpaca_secret_key };
  const gate = credential => requestGate(credential, { maxWaitMs: Math.max(0, Math.min(2000, deadline - clock())) });
  gate.defer = (credential, ms) => requestGate.defer?.(credential, ms);
  gate.observe = (...args) => requestGate.observe?.(...args);
  const boundedFetch = async (url, options) => {
    const remaining = Math.floor(deadline - clock());
    if (remaining <= 0) throw errorWith('quote_refresh_time_budget');
    batchRequests++;
    const symbols = new URL(url).searchParams.get('symbols').split(','); attemptedSymbols += symbols.length;
    const response = await fetcher(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(5000, remaining))]) });
    quotaRemaining = alpacaRateLimit(response.headers)?.remaining ?? null;
    return response;
  };
  if (!keys.alpaca_key_id || !keys.alpaca_secret_key) stopped = 'quote_refresh_credentials_missing';
  for (let offset = 0; offset < requested.length; offset += 100) {
    const batch = requested.slice(offset, offset + 100);
    if (!stopped && clock() >= deadline) stopped = 'quote_refresh_time_budget';
    if (!stopped && quotaRemaining !== null && quotaRemaining <= 5) stopped = 'quote_refresh_quota_headroom';
    if (stopped) { for (const symbol of batch) reasons.set(symbol, stopped); continue; }
    let payload;
    try {
      const query = new URLSearchParams({ symbols: batch.join(','), feed, currency: 'USD' });
      payload = await requestAlpacaJson(`https://data.alpaca.markets/v2/stocks/quotes/latest?${query}`, headers,
        boundedFetch, nativeMetrics, 'Alpaca Stocks decision quotes', { maxAttempts: 1, requestGate: gate, clock });
      if (clock() >= deadline) throw errorWith('quote_refresh_time_budget');
      if (!payload?.quotes || typeof payload.quotes !== 'object' || Array.isArray(payload.quotes)) throw errorWith('quote_refresh_invalid_response');
    } catch (error) {
      const reason = error.code === 'quote_refresh_invalid_response' ? error.code : failureCode(error);
      for (const symbol of batch) reasons.set(symbol, reason);
      if (['quote_refresh_http_401', 'quote_refresh_http_403', 'quote_refresh_http_429', 'quote_refresh_cooldown_deferred', 'quote_refresh_time_budget'].includes(reason)) stopped = reason;
      continue;
    }
    for (const symbol of batch) {
      if (!Object.hasOwn(payload.quotes, symbol)) { reasons.set(symbol, 'quote_refresh_missing_symbol'); continue; }
      try {
        quotes.set(symbol, parseAlpacaStockQuote(payload.quotes[symbol], { symbol, feed, source: 'latest', now: clock(), maxQuoteAgeMs }));
        sources.set(symbol, 'refreshed');
      } catch (error) { reasons.set(symbol, error.code || 'stock_quote_evidence_required'); }
    }
  }
  // Recheck the earliest batch/reused stream quotes after the whole collection.
  const completed = clock();
  const rows = assets.map(asset => withQuote(asset, quotes.get(symbolOf(asset)), completed));
  const validated = buildStockPaperQuotes(rows, { feed, now: completed, maxQuoteAgeMs });
  for (const [symbol, asset] of bySymbol) {
    if (refreshAssetFreshness(asset, completed).freshness === 'stale') {
      validated.quotes.delete(symbol); reasons.set(symbol, 'quote_refresh_stale_chart');
    }
  }
  for (const rejection of validated.diagnostics.rejections) if (!reasons.has(rejection.symbol)) reasons.set(rejection.symbol, rejection.reason);
  const observations = [...bySymbol].map(([symbol, asset]) => ({ symbol,
    source: validated.quotes.has(symbol) ? sources.get(symbol) : 'unavailable',
    priorQuoteAgeMs: ageAt(asset.quoteUpdatedAt, started), quoteAgeMs: ageAt(validated.quotes.get(symbol)?.time, completed),
    researchDataAgeMs: ageAt(asset.lastUpdated, completed),
    reason: validated.quotes.has(symbol) ? null : reasons.get(symbol) || 'stock_quote_evidence_required' }));
  const rejectionReasons = {};
  for (const row of observations) if (row.reason) rejectionReasons[row.reason] = (rejectionReasons[row.reason] || 0) + 1;
  for (const row of nativeMetrics) recordProviderRequest(metrics, row.provider, { latencyMs: row.latencyMs, cooldownDelayMs: row.cooldownDelayMs,
    status: row.status, retry: row.attempt - 1, error: row.error,
    headers: { 'x-ratelimit-limit': row.rateLimit?.limit ?? '', 'x-ratelimit-remaining': row.rateLimit?.remaining ?? '', 'x-ratelimit-reset': row.rateLimit?.reset ?? '' } });
  return { quotes: validated.quotes,
    assets: assets.map(asset => withQuote(refreshAssetFreshness(asset, completed), validated.quotes.get(symbolOf(asset)), completed, reasons.get(symbolOf(asset)) || null)),
    diagnostics: { version: STOCK_QUOTE_REFRESH_VERSION,
      status: !assets.length ? 'idle' : validated.quotes.size === bySymbol.size ? 'complete' : validated.quotes.size ? 'partial' : 'unavailable',
      feed, candidateRows: assets.length, uniqueSymbols: bySymbol.size, refreshNeeded: requested.length, attemptedSymbols, batchRequests,
      refreshed: observations.filter(row => row.source === 'refreshed').length, reusedFresh: observations.filter(row => row.source === 'reused_fresh').length,
      executableQuotes: validated.quotes.size, rejectedSymbols: observations.filter(row => row.reason).length,
      durationMs: Math.max(0, completed - started), budgetMs, quotaRemaining, rejectionReasons, observations } };
}

export function stockDecisionQuoteObservation(symbol, quote, now) {
  return { symbol, decisionAt: new Date(now).toISOString(), quoteTime: quote?.time || null, quoteAgeMs: ageAt(quote?.time, now) };
}

/** Keep unrelated active-position quotes; never fall back for a failed refresh symbol. */
export function mergeStockRefreshedQuotes(existing, refreshed) {
  const merged = new Map(existing);
  for (const asset of refreshed.assets) merged.delete(symbolOf(asset));
  for (const [symbol, quote] of refreshed.quotes) merged.set(symbol, quote);
  return merged;
}

export function stockQuoteRefreshRejections(diagnostics = {}) {
  const rows = [];
  for (const pass of ['qualification', 'entry']) for (const observation of diagnostics[pass]?.observations || []) {
    if (observation.reason) rows.push({ symbol: observation.symbol, stage: `${pass}_quote_refresh`,
      reasonCodes: [observation.reason], reasons: [observation.reason] });
  }
  for (const rejection of diagnostics.entryRiskRejected || []) rows.push({ symbol: rejection.symbol, stage: 'entry_risk_recheck',
    reasonCodes: [`risk_quote_recheck_${String(rejection.reason || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`],
    reasons: [rejection.reason] });
  return rows;
}

export function formatStockQuoteRefresh(diagnostics = {}) {
  const lines = ['Qualified candidates only; these counts are not universe coverage.'];
  for (const [key, label] of [['qualification', 'Qualification'], ['entry', 'Before reservation']]) {
    const row = diagnostics[key];
    lines.push(row ? `${label}: ${row.executableQuotes}/${row.uniqueSymbols} current | ${row.refreshed} refreshed | ${row.reusedFresh} reused | ${row.batchRequests} requests`
      : `${label}: not run`);
  }
  const ages = (diagnostics.decisions || []).map(row => row.quoteAgeMs).filter(value => typeof value === 'number' && Number.isFinite(value));
  lines.push(`Final decision quote age: ${ages.length ? `max ${(Math.max(...ages) / 1000).toFixed(2)}s across ${ages.length} observations` : 'not observed'}`);
  lines.push(`Entry risk rejections: ${(diagnostics.entryRiskRejected || []).length}`);
  return lines.join('\n');
}
