import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshStockPaperQuotes, mergeStockRefreshedQuotes, stockDecisionQuoteObservation, stockQuoteRefreshRejections, formatStockQuoteRefresh } from '../src/paperQuoteRefresh.js';
import { buildStockPaperQuotes } from '../src/paperExecutionQuotes.js';
import { stockQuoteEvidence } from '../../new-bots/shared/fixtures/stockQuoteEvidence.js';
import { createAlpacaRequestGate } from '../src/alpacaRequestGate.js';
import { selectPortfolioCandidates } from '../src/portfolioSelector.js';
import { buildPrimarySignalCandidate } from '../../new-bots/shared/primarySignal.js';
import { createProviderMetrics, summarizeProviderMetrics } from '../src/scanDiagnostics.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveSharedPaperCandidate } from '../../new-bots/shared/primarySignal.js';
import { processPaperQuote } from '../../new-bots/shared/paperRisk.js';

const start = Date.parse('2026-10-02T15:00:00Z');
const iso = at => new Date(at).toISOString();
const settings = { maxSpreadBps: 35, minPortfolioExpectedR: 0.05, maxSectorSignals: 2, maxOpenPositions: 3 };
const keys = { alpaca_key_id: 'fixture-key', alpaca_secret_key: 'fixture-secret' };
function asset(symbol = 'AAPL', at = start - 120000) {
  const q = { bid: 99.99, ask: 100.01, time: iso(at) };
  return { symbol, sector: 'XLK', price: 100, livePrice: 100, lastUpdated: iso(start - 300000), freshness: 'fresh',
    bidPrice: q.bid, askPrice: q.ask, quoteUpdatedAt: q.time, stockQuoteEvidence: stockQuoteEvidence(symbol, q),
    dailyAtrPercent: 2, dataQuality: 85, model: { score: 82 },
    ensemble: { active: true, decision: 'BUY', expectedR: 0.4, conservativeExpectedR: 0.35, probabilityLow: 60, probabilityHigh: 72 } };
}
const native = (symbol, at, extra = {}) => ({ S: symbol, t: iso(at), bp: 99.99, ap: 100.01, bs: 500, as: 400,
  bx: 'Q', ax: 'Q', z: 'C', c: ['R'], ...extra });
const response = (body, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => body });
function fixture({ extraQuote, status = 200, headers = {}, advanceMs = 0, responseBody } = {}) {
  let now = start; const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input); calls.push(url); now += advanceMs;
    assert.equal(url.origin + url.pathname, 'https://data.alpaca.markets/v2/stocks/quotes/latest');
    assert.equal(url.searchParams.get('currency'), 'USD'); assert.equal(url.searchParams.get('feed'), 'sip');
    assert.equal(options.headers['APCA-API-KEY-ID'], keys.alpaca_key_id);
    assert.ok(!options.method || options.method === 'GET'); assert.ok(options.signal);
    const quotes = Object.fromEntries(url.searchParams.get('symbols').split(',').map(s => [s, native(s, now - 200, extraQuote?.(s))]));
    return response(responseBody ? responseBody(quotes) : { quotes }, status, headers);
  };
  const gate = createAlpacaRequestGate({ now: () => now, sleep: async ms => { now += ms; } });
  return { calls, gate, clock: () => now, advance: ms => { now += ms; },
    options: { keys, feed: 'sip', clock: () => now, fetcher, requestGate: gate } };
}

test('slow analysis no longer makes a valid current provider quote invisible to portfolio approval', async () => {
  const f = fixture(), original = asset(), before = structuredClone(original);
  assert.equal(buildStockPaperQuotes([original], { feed: 'sip', now: start }).quotes.size, 0);
  assert.equal(selectPortfolioCandidates([original], [], settings, '2026-10-02', { now: new Date(start) }).selected.length, 0);
  const refreshed = await refreshStockPaperQuotes([original], f.options);
  assert.equal(refreshed.quotes.size, 1); assert.equal(f.calls.length, 1);
  assert.equal(refreshed.diagnostics.observations[0].priorQuoteAgeMs, 120000);
  assert.equal(refreshed.diagnostics.observations[0].quoteAgeMs, 200);
  assert.equal(selectPortfolioCandidates(refreshed.assets, [], settings, '2026-10-02', { now: new Date(start) }).selected.length, 1);
  assert.deepEqual(original, before);
  for (const key of ['price', 'livePrice', 'lastUpdated', 'model', 'ensemble']) assert.deepEqual(refreshed.assets[0][key], original[key]);
});

test('entry pass reuses fresh quotes and refreshes again after shadow/persistence delay', async () => {
  const f = fixture();
  const first = await refreshStockPaperQuotes([asset()], f.options);
  const quick = await refreshStockPaperQuotes(first.assets, f.options);
  assert.equal(f.calls.length, 1); assert.equal(quick.diagnostics.reusedFresh, 1);
  f.advance(16000);
  const late = await refreshStockPaperQuotes(quick.assets, f.options);
  assert.equal(f.calls.length, 2); assert.equal(late.diagnostics.refreshed, 1);
  assert.equal(stockDecisionQuoteObservation('AAPL', late.quotes.get('AAPL'), f.clock()).quoteAgeMs, 200);
});

test('a quote acquired after scan start is judged against the current portfolio clock', async () => {
  const f = fixture(); f.advance(80000);
  const late = asset('AAPL', f.clock() - 1000);
  assert.equal(selectPortfolioCandidates([late], [], settings, '2026-10-02', { now: new Date(start) }).selected.length, 0);
  const result = await refreshStockPaperQuotes([late], f.options);
  assert.equal(result.diagnostics.reusedFresh, 1); assert.equal(f.calls.length, 0);
  assert.equal(selectPortfolioCandidates(result.assets, [], settings, '2026-10-02', { now: new Date(f.clock()) }).selected.length, 1);
});

test('250 qualified symbols are requested in bounded batches with no watchlist truncation', async () => {
  const f = fixture(), result = await refreshStockPaperQuotes(Array.from({ length: 250 }, (_, i) => asset(`S${i}`)), f.options);
  assert.deepEqual(f.calls.map(u => u.searchParams.get('symbols').split(',').length), [100, 100, 50]);
  assert.equal(result.diagnostics.attemptedSymbols, 250); assert.equal(result.quotes.size, 250);
});

test('empty and fresh-only pools make no provider request, even without credentials', async () => {
  for (const rows of [[], [asset('AAPL', start - 1000)]]) {
    const result = await refreshStockPaperQuotes(rows, { feed: 'sip', clock: () => start, fetcher: () => assert.fail('no request') });
    assert.equal(result.diagnostics.batchRequests, 0); assert.equal(result.quotes.size, rows.length);
  }
});

test('unconfigured, duplicate, invalid and halted symbols are accounted for without requests', async () => {
  const rows = [asset(), asset('MSFT'), asset('msft'), asset('../bad'), { ...asset('NVDA'), halted: true }];
  const result = await refreshStockPaperQuotes(rows, { feed: 'sip', clock: () => start, fetcher: () => assert.fail('no request') });
  assert.equal(result.quotes.size, 0); assert.equal(result.diagnostics.uniqueSymbols, 4);
  assert.deepEqual(result.diagnostics.rejectionReasons, { quote_refresh_credentials_missing: 1, duplicate_stock_symbol: 1, invalid_stock_symbol: 1, stock_halted: 1 });
});

test('failed forced refresh never resurrects an earlier fresh quote', async () => {
  const f = fixture({ status: 503 }), original = asset('AAPL', start - 1000);
  const result = await refreshStockPaperQuotes([original], { ...f.options, force: true });
  assert.equal(result.quotes.size, 0); assert.equal(result.assets[0].stockQuoteEvidence, null);
  const activeQuote = buildStockPaperQuotes([asset('MSFT', start - 1000)], { feed: 'sip', now: start }).quotes.get('MSFT');
  const merged = mergeStockRefreshedQuotes(new Map([['AAPL', original], ['MSFT', activeQuote]]), result);
  assert.equal(merged.has('AAPL'), false); assert.deepEqual(merged.get('MSFT'), activeQuote);
});

test('provider quota headroom stops later batches and explicitly counts deferred candidates', async () => {
  const f = fixture({ headers: { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '5' } });
  const result = await refreshStockPaperQuotes(Array.from({ length: 150 }, (_, i) => asset(`S${i}`)), f.options);
  assert.equal(f.calls.length, 1); assert.equal(result.quotes.size, 100);
  assert.equal(result.diagnostics.rejectionReasons.quote_refresh_quota_headroom, 50);
});

test('429 stops the pass and defers the shared Stocks request gate without immediate retries', async () => {
  const f = fixture({ status: 429, headers: { 'Retry-After': '60' } });
  const metrics = createProviderMetrics();
  const result = await refreshStockPaperQuotes(Array.from({ length: 150 }, (_, i) => asset(`S${i}`)), { ...f.options, metrics });
  assert.equal(f.calls.length, 1); assert.equal(result.diagnostics.rejectionReasons.quote_refresh_http_429, 150);
  await assert.rejects(f.gate(keys.alpaca_key_id, { maxWaitMs: 2000 }), { code: 'ALPACA_PACING_DEFERRED' });
  assert.equal(summarizeProviderMetrics(metrics)[0].rateLimits, 1);
  assert.equal(JSON.stringify(result).includes(keys.alpaca_secret_key), false);
});

test('authentication and entitlement failures stop further batches', async () => {
  for (const status of [401, 403]) {
    const f = fixture({ status });
    const result = await refreshStockPaperQuotes(Array.from({ length: 150 }, (_, i) => asset(`S${i}`)), f.options);
    assert.equal(f.calls.length, 1); assert.equal(result.diagnostics.rejectionReasons[`quote_refresh_http_${status}`], 150);
  }
});

test('collection budget and final freshness check reject aged early observations', async () => {
  const f = fixture({ advanceMs: 3000 });
  const rows = Array.from({ length: 201 }, (_, i) => asset(`S${i}`));
  const result = await refreshStockPaperQuotes(rows, { ...f.options, maxQuoteAgeMs: 1500, budgetMs: 6500 });
  assert.equal(result.quotes.size, 0); assert.equal(f.calls.length, 3);
  assert.equal(result.diagnostics.rejectionReasons.quote_refresh_time_budget, 1);
  assert.equal(result.diagnostics.rejectionReasons.stale_or_future_quote, 200);
  assert.ok(result.assets.every(a => a.bidPrice === 0));
});

test('one bad batch does not erase another successful independent batch', async () => {
  const f = fixture(); let calls = 0; const fetcher = f.options.fetcher;
  const result = await refreshStockPaperQuotes(Array.from({ length: 101 }, (_, i) => asset(`S${i}`)), {
    ...f.options, fetcher: async (...args) => ++calls === 1 ? response({}, 503) : fetcher(...args) });
  assert.equal(result.quotes.size, 1); assert.equal(result.quotes.has('S100'), true);
  assert.equal(result.diagnostics.rejectionReasons.quote_refresh_provider_failure, 100);
});

test('missing, stale, nonregular and mismatched native quotes never become execution fields', async () => {
  const f = fixture({ extraQuote: s => s === 'MSFT' ? { S: 'NVDA' } : s === 'AMD' ? { c: ['N'] } : s === 'NVDA' ? { t: iso(start - 60000) } : {},
    responseBody: quotes => { delete quotes.AAPL; quotes.UNREQUESTED = native('UNREQUESTED', start); return { quotes }; } });
  const result = await refreshStockPaperQuotes(['AAPL', 'MSFT', 'AMD', 'NVDA'].map(s => asset(s)), f.options);
  assert.equal(result.quotes.size, 0); assert.equal(result.diagnostics.rejectedSymbols, 4);
  assert.deepEqual(result.diagnostics.rejectionReasons, { quote_refresh_missing_symbol: 1, stock_quote_symbol_mismatch: 1,
    stock_quote_condition_not_regular: 1, stale_or_future_quote: 1 });
});

test('new spread, model, chart freshness and exposure gates still reject after refresh', async () => {
  for (const [changes, quoteChanges, reason] of [
    [{}, { bp: 99, ap: 101 }, /spread/],
    [{ ensemble: { active: false, decision: 'WATCH' } }, {}, /validated BUY/],
    [{ freshness: 'stale' }, {}, /Stale chart/],
  ]) {
    const f = fixture({ extraQuote: () => quoteChanges });
    const result = await refreshStockPaperQuotes([{ ...asset(), ...changes }], f.options);
    const portfolio = selectPortfolioCandidates(result.assets, [], settings, '2026-10-02', { now: new Date(start) });
    assert.equal(portfolio.selected.length, 0); assert.match(portfolio.rejected[0].reason, reason);
  }
  const f = fixture(), result = await refreshStockPaperQuotes([asset()], f.options);
  const portfolio = selectPortfolioCandidates(result.assets, [{ symbol: 'AAPL', status: 'tracking' }], settings, '2026-10-02', { now: new Date(start) });
  assert.equal(portfolio.selected.length, 0); assert.match(portfolio.rejected[0].reason, /active/);
});

test('current quotes cannot extend an elapsed entry plan or approve chasing a moved price', async () => {
  const f = fixture({ extraQuote: () => ({ bp: 110, ap: 110.01 }) });
  const result = await refreshStockPaperQuotes([asset()], f.options);
  const decision = buildPrimarySignalCandidate({ owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', strategyId: 'fixture', signalId: 'one',
    sessionDate: '2026-10-02', now: start, quote: result.quotes.get('AAPL'), sessionOpen: true,
    entryLow: 99.9, entryHigh: 100.2, stopPct: 1, targetPct: 2, entryExpiresAt: iso(start - 1000),
    forceExitAt: iso(start + 3600000), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.02 });
  assert.equal(decision.status, 'rejected'); assert.ok(decision.reasons.includes('entry_window_expired'));
  assert.ok(decision.reasons.some(reason => /entry|chase/.test(reason) && reason !== 'entry_window_expired'));
});

test('administrator diagnostics distinguish qualified quotes, stage failures and final quote ages', async () => {
  const f = fixture({ responseBody: () => ({ quotes: {} }) });
  const result = await refreshStockPaperQuotes([asset()], f.options);
  const diagnostics = { qualification: result.diagnostics, entry: null,
    entryRiskRejected: [{ symbol: 'MSFT', reason: 'Spread exceeds the limit.' }],
    decisions: [stockDecisionQuoteObservation('MSFT', { time: iso(start - 1000) }, start)] };
  const rows = stockQuoteRefreshRejections(diagnostics);
  assert.equal(rows[0].stage, 'qualification_quote_refresh');
  assert.equal(rows[0].reasonCodes[0], 'quote_refresh_missing_symbol');
  assert.equal(rows[1].stage, 'entry_risk_recheck');
  const summary = formatStockQuoteRefresh(diagnostics);
  assert.match(summary, /0\/1 current/); assert.match(summary, /max 1.00s/);
  assert.match(summary, /Before reservation: not run/); assert.match(summary, /not universe coverage/);
});

test('IEX stays on the explicit free-feed route and retains conservative single-venue sizes', async () => {
  const result = await refreshStockPaperQuotes([asset()], { keys, feed: 'iex', clock: () => start,
    requestGate: async () => ({ cooldownDelayMs: 0 }), fetcher: async input => {
      assert.equal(new URL(input).searchParams.get('feed'), 'iex');
      return response({ quotes: { AAPL: native('AAPL', start, { bx: 'V', ax: 'V', bs: 5, as: 10 }) } });
    } });
  const q = result.quotes.get('AAPL');
  assert.equal(q.coverage, 'single_venue'); assert.equal(q.stockQuoteEvidence.askSizeShares, 10);
  assert.equal(result.diagnostics.feed, 'iex');
});

test('a prior Stocks cooldown defers refresh with no fetch and no stale cache fallback', async () => {
  const f = fixture(); f.gate.defer(keys.alpaca_key_id, 60000);
  const result = await refreshStockPaperQuotes([asset()], f.options);
  assert.equal(f.calls.length, 0); assert.equal(result.diagnostics.batchRequests, 0);
  assert.equal(result.diagnostics.rejectionReasons.quote_refresh_cooldown_deferred, 1);
  assert.equal(result.quotes.size, 0);
});

test('malformed responses and unsupported feed configuration remain unavailable', async () => {
  const f = fixture({ responseBody: () => ({ quotes: [] }) });
  const result = await refreshStockPaperQuotes([asset()], f.options);
  assert.equal(result.quotes.size, 0); assert.equal(result.diagnostics.rejectionReasons.quote_refresh_invalid_response, 1);
  await assert.rejects(refreshStockPaperQuotes([asset()], { ...f.options, feed: 'delayed_sip' }), TypeError);
  await assert.rejects(refreshStockPaperQuotes([asset()], { ...f.options, budgetMs: 60000 }), TypeError);
});

test('a current execution quote cannot renew expired chart/model evidence', async () => {
  const f = fixture(), original = { ...asset('AAPL', start - 100), lastUpdated: iso(start - 20 * 60000) };
  const result = await refreshStockPaperQuotes([original], f.options);
  assert.equal(result.quotes.size, 0); assert.equal(f.calls.length, 0);
  assert.equal(result.assets[0].freshness, 'stale'); assert.equal(result.assets[0].lastUpdated, original.lastUpdated);
  assert.equal(result.diagnostics.rejectionReasons.quote_refresh_stale_chart, 1);
  assert.equal(original.freshness, 'fresh');
  const slow = fixture({ advanceMs: 3000 });
  const boundary = { ...asset(), lastUpdated: iso(start - 20 * 60000 + 1000) };
  const expired = await refreshStockPaperQuotes([boundary], slow.options);
  assert.equal(expired.quotes.size, 0); assert.equal(expired.diagnostics.rejectionReasons.quote_refresh_stale_chart, 1);
});

test('native refresh flows through portfolio approval, reservation and later after-cost execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stock-refresh-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'paper.json'); let bid = 99.99;
  const f = fixture({ extraQuote: () => ({ bp: bid, ap: bid + 0.02 }) });
  const result = await refreshStockPaperQuotes([asset()], f.options);
  const portfolio = selectPortfolioCandidates(result.assets, [], settings, '2026-10-02', { now: new Date(start) });
  assert.equal(portfolio.selected.length, 1);
  const decision = buildPrimarySignalCandidate({ owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', strategyId: 'refresh-integration', signalId: 'one',
    sessionDate: '2026-10-02', now: start, quote: result.quotes.get('AAPL'), sessionOpen: true,
    entryLow: 99.9, entryHigh: 100.2, stopPct: 1, targetPct: 2, entryExpiresAt: iso(start + 600000),
    forceExitAt: iso(start + 3600000), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.02,
    researchContext: { observedAt: portfolio.selected[0].lastUpdated, features: { setup_score: portfolio.selected[0].model.score } } });
  assert.equal(decision.status, 'candidate');
  const reserved = await reserveSharedPaperCandidate(decision.candidate, { sharedPaperStatePath: statePath,
    sharedPaperAccountEquity: 10000, sharedPaperEmergencyStop: false }, start);
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.order.researchContext.observedAt, asset().lastUpdated);
  f.advance(1000);
  const next = await refreshStockPaperQuotes(portfolio.selected, { ...f.options, force: true });
  const filled = await processPaperQuote(reserved.order.orderId, next.quotes.get('AAPL'), { statePath, now: f.clock(), emergencyStop: false });
  assert.equal(filled.status, 'filled');
  bid = 102.1; f.advance(1000);
  const last = await refreshStockPaperQuotes(portfolio.selected, { ...f.options, force: true });
  const closed = await processPaperQuote(reserved.order.orderId, last.quotes.get('AAPL'), { statePath, now: f.clock(), emergencyStop: false });
  assert.equal(closed.status, 'closed'); assert.ok(closed.order.realizedPnlUsd < closed.order.grossPnlUsd);
  assert.equal(closed.order.lastStockQuoteEvidence.source, 'latest');
});
