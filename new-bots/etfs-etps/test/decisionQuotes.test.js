import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshEtfDecisionQuotes } from '../src/decisionQuotes.js';
import { evaluateOpeningRangeBreakout } from '../src/strategies.js';
import { evaluateEtfEntries } from '../src/entryWorkflow.js';
import { etfInput, rawQuote, NOW, portfolio, policy } from './quoteRefreshFixtures.js';

const env = { ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'synthetic', ALPACA_API_SECRET_KEY: 'synthetic' };
const response = (quotes, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => ({ quotes }) });
const stale = symbol => etfInput(symbol, NOW - 20000);
const noFetch = async () => { throw new Error('Unexpected network work'); };
const options = extra => ({ env, clock: () => NOW, requestGate: async () => ({}), fetcher: noFetch, ...extra });
const syntheticFetch = (clock, calls = [], overrides = {}) => async url => {
  const parsed = new URL(url); calls.push(parsed);
  assert.equal(parsed.pathname, '/v2/stocks/quotes/latest');
  return response(Object.fromEntries(parsed.searchParams.get('symbols').split(',').map(s => [s, rawQuote(clock(), overrides)])));
};

test('fresh native quotes need no credentials or requests and preserve history/reviews', async () => {
  const input = etfInput(); const result = await refreshEtfDecisionQuotes([input], options({ env: { ETF_ALPACA_FEED: 'sip' } }));
  assert.equal(result.diagnostics.reusedFresh, 1); assert.equal(result.diagnostics.batchRequests, 0);
  assert.equal(result.trades[0].quote, input.quote); assert.equal(result.trades[0].bars, input.bars);
  assert.equal(result.trades[0].session, input.session);
});

test('refresh uses native bid/ask evidence and leaves all research timestamps intact', async () => {
  const input = stale('SPY'), original = structuredClone(input), calls = [];
  const result = await refreshEtfDecisionQuotes([input], options({ fetcher: syntheticFetch(() => NOW, calls) }));
  assert.equal(result.diagnostics.refreshed, 1); assert.equal(result.diagnostics.observations[0].priorQuoteAgeMs, 20000);
  assert.equal(result.trades[0].quote.time, new Date(NOW).toISOString());
  assert.equal(result.trades[0].quote.stockQuoteEvidence.source, 'latest');
  assert.equal(calls[0].searchParams.get('feed'), 'sip');
  assert.deepEqual(input, original); assert.equal(result.trades[0].bars, input.bars); assert.equal(result.trades[0].session, input.session);
  assert.equal(evaluateOpeningRangeBreakout({ ...result.trades[0], now: NOW }).status, 'candidate');
});

test('201 selected candidates refresh in three quote-only batches without dropping the tail', async () => {
  const calls = []; const inputs = Array.from({ length: 201 }, (_, i) => stale(`X${i}`));
  const result = await refreshEtfDecisionQuotes(inputs, options({ fetcher: syntheticFetch(() => NOW, calls) }));
  assert.equal(result.diagnostics.refreshed, 201); assert.equal(result.diagnostics.attemptedSymbols, 201);
  assert.deepEqual(calls.map(url => url.searchParams.get('symbols').split(',').length), [100, 100, 1]);
});

test('missing symbols and malformed native evidence clear old quotes', async () => {
  const result = await refreshEtfDecisionQuotes([stale('SPY'), stale('QQQ')], options({ fetcher: async () => response({ SPY: rawQuote(NOW, { bs: 0 }) }) }));
  assert.equal(result.diagnostics.rejected, 2); assert.ok(result.trades.every(row => row.quote === null));
  assert.equal(result.trades[1].quoteRefreshReason, 'quote_refresh_symbol_missing');
});

test('missing credentials, failed provider and exhausted quota cannot reuse old quotes', async () => {
  const missing = await refreshEtfDecisionQuotes([stale('SPY')], options({ env: { ETF_ALPACA_FEED: 'sip' } }));
  assert.equal(missing.trades[0].quoteRefreshReason, 'quote_refresh_credentials_missing');
  let requests = 0;
  const inputs = Array.from({ length: 101 }, (_, i) => stale(`X${i}`));
  const failed = await refreshEtfDecisionQuotes(inputs, options({ fetcher: async () => { requests++; return response({}, 403); } }));
  assert.equal(requests, 1); assert.equal(failed.diagnostics.rejectionReasons.quote_refresh_http_403, 101);
  const quota = await refreshEtfDecisionQuotes(inputs, options({ fetcher: async url => {
    const rows = new URL(url).searchParams.get('symbols').split(',');
    return response(Object.fromEntries(rows.map(s => [s, rawQuote()])), 200, { 'X-RateLimit-Remaining': '5' });
  } }));
  assert.equal(quota.diagnostics.refreshed, 100); assert.equal(quota.trades[100].quoteRefreshReason, 'quote_refresh_quota_headroom');
});

test('local shared-budget rejection is not counted as an HTTP request', async () => {
  const metrics = [];
  const result = await refreshEtfDecisionQuotes([stale('SPY')], options({ providerMetrics: metrics,
    requestGate: async () => { throw Object.assign(new Error('Deferred'), { code: 'ALPACA_BUDGET_WAIT_EXCEEDED' }); } }));
  assert.equal(result.trades[0].quoteRefreshReason, 'quote_refresh_budget_deferred');
  assert.equal(result.diagnostics.batchRequests, 0); assert.equal(metrics[0].requestAttempted, false);
});

test('time budget stops further batches and clears quotes when collection finishes too late', async () => {
  let at = NOW;
  const result = await refreshEtfDecisionQuotes([stale('SPY')], options({ clock: () => at, fetcher: async () => { at += 8001; return response({ SPY: rawQuote(at) }); } }));
  assert.equal(result.trades[0].quoteRefreshReason, 'quote_refresh_time_budget'); assert.equal(result.trades[0].quote, null);
  const noBudget = await refreshEtfDecisionQuotes([stale('SPY'), etfInput('QQQ')], options({ budgetMs: 0 }));
  assert.equal(noBudget.trades[0].quoteRefreshReason, 'quote_refresh_time_budget'); assert.ok(noBudget.trades[1].quote);
});

test('completed-batch quotes are checked again after later batches finish', async () => {
  let at = NOW, count = 0;
  const inputs = Array.from({ length: 101 }, (_, i) => stale(`X${i}`));
  const result = await refreshEtfDecisionQuotes(inputs, options({ clock: () => at, maxQuoteAgeMs: 1000, fetcher: async url => {
    if (count++) at += 1500;
    return syntheticFetch(() => at)(url);
  } }));
  assert.equal(result.diagnostics.rejected, 100); assert.equal(result.diagnostics.refreshed, 1);
  assert.equal(result.trades[0].quoteRefreshReason, 'stale_or_future_quote');
});

test('free IEX remains reference only and delayed SIP never supplies entry quotes', async () => {
  const result = await refreshEtfDecisionQuotes([stale('SPY')], options({ env: { ...env, ETF_ALPACA_FEED: 'iex' }, fetcher: syntheticFetch(() => NOW, [], { bx: 'V', ax: 'V' }) }));
  assert.equal(result.trades[0].quote.quality, 'reference');
  assert.ok(evaluateOpeningRangeBreakout({ ...result.trades[0], now: NOW }).reasons.includes('quote_not_executable'));
  const delayed = await refreshEtfDecisionQuotes([etfInput()], options({ env: { ...env, ETF_ALPACA_FEED: 'delayed_sip' } }));
  assert.equal(delayed.trades[0].quoteRefreshReason, 'quote_refresh_delayed_feed_not_executable');
});

test('refresh never launders stale or missing bars, duplicates, closed sessions or future quotes', async () => {
  const input = etfInput(), missing = { ...input, bars: [] };
  assert.equal((await refreshEtfDecisionQuotes([missing], options())).trades[0].quoteRefreshReason, 'quote_refresh_intraday_bars_missing');
  const old = await refreshEtfDecisionQuotes([input], options({ clock: () => NOW + 90000 }));
  assert.equal(old.trades[0].quoteRefreshReason, 'quote_refresh_intraday_bars_stale');
  const closed = await refreshEtfDecisionQuotes([input], options({ clock: () => input.session.closeTime }));
  assert.equal(closed.trades[0].quoteRefreshReason, 'quote_refresh_session_closed');
  const duplicates = await refreshEtfDecisionQuotes([input, input], options());
  assert.equal(duplicates.diagnostics.rejectionReasons.quote_refresh_duplicate_symbol, 2);
  const future = await refreshEtfDecisionQuotes([stale('SPY')], options({ fetcher: syntheticFetch(() => NOW + 1000) }));
  assert.equal(future.trades[0].quoteRefreshReason, 'stale_or_future_quote');
});

test('non-finite and backward observation clocks fail closed', async () => {
  await assert.rejects(refreshEtfDecisionQuotes([], options({ clock: () => NaN })), /clock/);
  let count = 0;
  await assert.rejects(refreshEtfDecisionQuotes([etfInput()], options({ clock: () => NOW - count++ })), /clock/);
});

const workflowOptions = (clock, fetcher, extra = {}) => ({ sourceMode: 'alpaca', env, clock, portfolio: portfolio(), policy: policy(),
  refresh: (rows, opts) => refreshEtfDecisionQuotes(rows, { ...opts, fetcher, requestGate: async () => ({}) }), ...extra });

test('workflow refreshes a later candidate after the earlier reservation waits', async () => {
  let at = NOW; const calls = [], reservations = [];
  const result = await evaluateEtfEntries([etfInput('SPY'), etfInput('QQQ')], workflowOptions(() => at, syntheticFetch(() => at, calls), {
    reserve: async (candidate, decision, opts) => {
      reservations.push({ candidate, decision, opts });
      if (candidate.instrumentKey === 'SPY') at += 20000;
      return { status: 'blocked', reason: 'synthetic_lock_test' };
    } }));
  assert.equal(reservations.length, 2); assert.equal(calls.length, 1);
  assert.equal(reservations[1].candidate.quoteTime, new Date(NOW + 20000).toISOString());
  assert.equal(reservations[1].opts.observationClock(), NOW + 20000);
  assert.equal(result.observations[1].strategyInput.bars[0].time, etfInput('QQQ').bars[0].time);
});

test('refreshed price must pass the full strategy again before reservation', async () => {
  let reservations = 0;
  const result = await evaluateEtfEntries([stale('SPY')], workflowOptions(() => NOW, syntheticFetch(() => NOW, [], { bp: 110, ap: 110.01 }), {
    reserve: async () => { reservations++; } }));
  assert.equal(reservations, 0); assert.equal(result.results[0].status, 'no-setup');
});

test('emergency stop and unreviewed ETP classifications still block new entries', async () => {
  let reservations = 0;
  const reserve = async () => { reservations++; };
  const stopped = await evaluateEtfEntries([stale('SPY')], workflowOptions(() => NOW, syntheticFetch(() => NOW), { reserve, policy: { ...policy(), emergencyStop: true } }));
  assert.equal(stopped.results[0].status, 'risk-blocked');
  const unclassified = await evaluateEtfEntries([{ ...stale('SPY'), assetClass: 'etp' }], workflowOptions(() => NOW, syntheticFetch(() => NOW), { reserve }));
  assert.ok(unclassified.results[0].reasons.includes('etp_classification_missing_stale_or_invalid')); assert.equal(reservations, 0);
});

test('provider rejection does not trigger one retry for every failed row', async () => {
  let calls = 0;
  const result = await evaluateEtfEntries([stale('SPY'), stale('QQQ')], workflowOptions(() => NOW,
    async () => { calls++; return response({}, 403); }));
  assert.equal(calls, 1); assert.ok(result.results.every(row => row.reasons.includes('quote_refresh_http_403')));
});

test('fixture mode stays offline and retains explicit historical inputs', async () => {
  const result = await evaluateEtfEntries([etfInput()], workflowOptions(() => NOW, noFetch, { sourceMode: 'fixture',
    reserve: async () => ({ status: 'reserved', order: {} }) }));
  assert.equal(result.results[0].status, 'reserved'); assert.equal(result.diagnostics.qualification, null);
});
