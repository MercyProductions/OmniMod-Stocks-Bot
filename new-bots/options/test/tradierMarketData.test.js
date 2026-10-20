import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTradierOptionInputs as loadInputs, fetchTradierOptionPositionMarks as loadMarks } from '../src/tradierMarketData.js';
import { createTradierStartPacer } from '../src/tradierRateLimit.js';

// These fixtures test parsing, retries and strategy gates. Isolate their synthetic
// tokens/clock; shared filesystem limits have separate real-process regressions.
function isolatedPacer() { let at = 0; return createTradierStartPacer({ now: () => at, sleep: async ms => { at += ms; } }); }
const fetchTradierOptionInputs = (rows, options) => loadInputs(rows, { startPacer: isolatedPacer(), ...options });
const fetchTradierOptionPositionMarks = (rows, options) => loadMarks(rows, { startPacer: isolatedPacer(), ...options });
import { buildOptionDayTradeCandidate } from '../src/strategies.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const timestamp = now - 1_000;
const signalRow = { signal: { underlyingSymbol: 'SPY', sessionDate: '2026-09-29', sessionClose: new Date(now + 5 * 60 * 60_000).toISOString(), direction: 'long', underlyingPrice: 100, underlyingTarget: 104, observedAt: new Date(timestamp).toISOString(), entryLow: 99, entryHigh: 101, catalystReview: { status: 'clear', source: 'manual-review', summary: 'No high-impact event found.', reviewedAt: new Date(timestamp).toISOString() }, optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'No ex-dividend date through option expiry.', reviewedAt: new Date(timestamp).toISOString(), reviewedThrough: '2026-10-02', nextExDividendDate: null }, sessionOpen: true } };
const json = (body, headers = new Headers({ 'X-Ratelimit-Allowed': '120', 'X-Ratelimit-Used': '24', 'X-Ratelimit-Available': '96', 'X-Ratelimit-Expiry': '1790700000000' })) => ({ ok: true, status: 200, headers, json: async () => body });

test('long data retrieval uses response time, refreshes underlying quotes, and preserves independent target levels', async () => {
  let current = now;
  const pacer = async () => ({ localQueueDelayMs: 0 }); pacer.deferStarts = () => {};
  const fetchImpl = async (url) => {
    current += 2000;
    const path = new URL(url).pathname;
    if (path.endsWith('/clock')) return json({ clock: { state: 'open', timestamp: new Date(current).toISOString(), next_change: '2026-09-29T20:00:00Z' } });
    if (path.endsWith('/quotes')) return json({ quotes: { quote: { symbol: 'SPY', bid: 100.19, ask: 100.21, bid_date: current, ask_date: current } } });
    if (path.endsWith('/expirations')) return json({ expirations: { date: ['2026-10-02'] } });
    return json({ options: { option: [
      { underlying: 'SPY', symbol: 'SPY261002C00100000', expiration_date: '2026-10-02', option_type: 'call', strike: 100, bid: 2, ask: 2.05, bid_date: current, ask_date: current, volume: 100, open_interest: 500, contract_size: 100 },
      { underlying: 'SPY', symbol: 'SPY261002C00103000', expiration_date: '2026-10-02', option_type: 'call', strike: 103, bid: 1, ask: 1.05, bid_date: current, ask_date: current, volume: 100, open_interest: 500, contract_size: 100 },
    ] } });
  };
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'fixture', environment: 'production', fetchImpl, now,
    clockNow: () => current, startPacer: pacer, refreshUnderlyingAfterChains: true });
  assert.equal(current - now, 10000);
  assert.equal(rows[0].marketDataStatus, 'ready');
  assert.equal(rows[0].chain.options[0].quoteQuality, 'executable', 'later fresh data must not be rejected as future relative to scan start');
  assert.equal(rows[0].signal.observedAt, new Date(current).toISOString());
  assert.equal(rows[0].signal.underlyingTarget, 104);
  assert.equal(buildOptionDayTradeCandidate({ ...rows[0], now: current, config: { feePerContractRoundTrip: 0, slippageReservePerContract: 0 } }).status, 'candidate');
});

function fixtureFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    if (parsed.pathname.endsWith('/markets/quotes')) return json({ quotes: { quote: { symbol: 'SPY', bid: 99.99, ask: 100.01, bid_date: timestamp, ask_date: timestamp } } });
    if (parsed.pathname.endsWith('/markets/options/expirations')) return json({ expirations: { date: ['2026-10-02'] } });
    if (parsed.pathname.endsWith('/markets/options/chains')) return json({ options: { option: [
      { underlying: 'SPY', symbol: 'SPY261002C00100000', expiration_date: '2026-10-02', option_type: 'call', strike: 100, bid: 2, ask: 2.05, bid_date: timestamp, ask_date: timestamp, volume: 100, open_interest: 500, contract_size: 100 },
      { underlying: 'SPY', symbol: 'SPY261002C00103000', expiration_date: '2026-10-02', option_type: 'call', strike: 103, bid: 1, ask: 1.05, bid_date: timestamp, ask_date: timestamp, volume: 100, open_interest: 500, contract_size: 100 },
    ] } });
    throw new Error(`Unexpected endpoint ${parsed.pathname}`);
  };
  return { calls, fetchImpl };
}

test('Tradier production paper-data adapter makes only quote, expiration and chain reads with fresh executable timestamps', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const providerMetrics = [];
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'production', fetchImpl, now, providerMetrics });
  assert.equal(rows[0].marketDataStatus, 'ready');
  assert.equal(rows[0].signal.underlyingQuote.quality, 'executable');
  assert.equal(rows[0].signal.underlyingPrice, 100);
  assert.equal(rows[0].chain.quoteQuality, 'executable');
  assert.equal(rows[0].chain.options[0].quoteQuality, 'executable');
  assert.deepEqual(providerMetrics.map((row) => row.operation), ['market-clock', 'underlying-quotes', 'option-expirations', 'option-chains']);
  assert.ok(providerMetrics.every((row) => Number.isFinite(row.localQueueDelayMs)), 'every Tradier request records local limiter delay separately from provider latency');
  assert.ok(providerMetrics.every((row) => row.provider === 'Tradier' && row.status === 200 && Number.isFinite(row.latencyMs)));
  assert.deepEqual(providerMetrics[0].rateLimit, { allowed: 120, used: 24, available: 96, expiresAt: 1790700000000 });
  assert.deepEqual(calls.map((url) => url.pathname), ['/v1/markets/clock', '/v1/markets/quotes', '/v1/markets/options/expirations', '/v1/markets/options/chains']);
  assert.equal(calls.some((url) => /orders/i.test(url.pathname)), false);
});

test('Tradier HTTP failures are measured without logging request URLs', async () => {
  const providerMetrics = [];
  await assert.rejects(fetchTradierOptionInputs([signalRow], {
    token: 'test-only', environment: 'production', now, providerMetrics, retrySleep: async () => {}, random: () => 0,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  }), /HTTP 429/);
  assert.equal(providerMetrics.length, 3);
  assert.equal(providerMetrics[0].operation, 'market-clock');
  assert.equal(providerMetrics[0].status, 429);
  assert.equal(providerMetrics[0].attempt, 1);
  assert.deepEqual(providerMetrics.map((row) => row.attempt), [1, 2, 3]);
  assert.match(providerMetrics[0].error, /HTTP 429/);
  assert.equal(JSON.stringify(providerMetrics).includes('tradier.com'), false);
});

test('Tradier retries a transient 429 using its reset expiry while pacing each request', async () => {
  const { fetchImpl: fixture } = fixtureFetch();
  const providerMetrics = [];
  const waits = [];
  let clockCalls = 0;
  let simulatedTime = now;
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.endsWith('/markets/clock') && clockCalls++ === 0) {
      return { ok: false, status: 429, headers: new Headers({ 'X-Ratelimit-Expiry': String(now + 1_000) }) };
    }
    return fixture(url, options);
  };
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'retry-test-only', environment: 'production', now,
    fetchImpl, providerMetrics, clockNow: () => simulatedTime,
    retrySleep: async (ms) => { waits.push(ms); simulatedTime += ms; }, random: () => 0 });
  assert.equal(rows[0].marketDataStatus, 'ready');
  assert.deepEqual(waits, [1_000]);
  assert.equal(providerMetrics[0].status, 429);
  assert.equal(providerMetrics[0].retryDelayMs, 1_000);
  assert.equal(providerMetrics[0].attempt, 1);
  assert.equal(providerMetrics.find((row) => row.operation === 'market-clock' && row.attempt === 2).cooldownDelayMs, 1_000);
  assert.equal(rows[0].providerRequests, 5, 'actual provider attempts include the retried clock request');
});

test('fresh Tradier session, quote and chain data form a strategy candidate only after catalyst clearance', async () => {
  const { fetchImpl } = fixtureFetch();
  const [row] = await fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'production', fetchImpl, now });
  const result = buildOptionDayTradeCandidate({ ...row, now, config: { feePerContractRoundTrip: 0, slippageReservePerContract: 0 } });
  assert.equal(row.marketDataStatus, 'ready');
  assert.equal(result.status, 'candidate', JSON.stringify({ reasons: result.reasons, diagnostics: result.diagnostics, chain: row.chain }));
  assert.equal(result.candidate.option.strategy, 'bull-call-debit-vertical');
  assert.equal(result.candidate.sessionDate, '2026-09-29');
  assert.equal(result.candidate.quoteQuality, 'executable');
  assert.equal(row.providerRequests, 4);
});

test('Tradier sandbox delayed quote is blocked before downloading expensive option chains', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'sandbox', fetchImpl, now });
  assert.equal(rows[0].marketDataStatus, 'sandbox_data_is_delayed');
  assert.deepEqual(calls.map((url) => url.pathname), []);
});

test('Tradier reports duplicate and request-cap drops instead of silently hiding upstream option signals', async () => {
  const inputs = Array.from({ length: 14 }, (_, index) => ({ signal: { underlyingSymbol: `T${index}` } }));
  inputs.push({ signal: { underlyingSymbol: 't0' } });
  const rows = await fetchTradierOptionInputs(inputs, { token: 'test-only', environment: 'sandbox', now });
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0].marketDataDiagnostics, {
    inputSignals: 15, validSignals: 15, distinctUnderlyings: 14, duplicateSignals: 1,
    maxSymbols: 12, retainedUnderlyings: 12, cappedUnderlyings: 2,
    cappedUnderlyingSymbols: ['T12', 'T13'], cappedRejectionReason: 'provider_request_symbol_cap',
  });
  assert.ok(rows.every((row) => row.marketDataDiagnostics.cappedUnderlyings === 2));
});

test('stale or missing production underlying quotes cannot trigger option-chain requests', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    return json({ quotes: { quote: { symbol: 'SPY', bid: 99.99, ask: 100.01, bid_date: now - 60_000, ask_date: now - 60_000 } } });
  };
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'production', fetchImpl, now, maxQuoteAgeMs: 10_000 });
  assert.equal(rows[0].marketDataStatus, 'stale_or_invalid_quote');
  assert.equal(calls.length, 2);
});

test('production quote outside the primary signal entry zone does not fetch option chains', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const outside = { ...signalRow, signal: { ...signalRow.signal, entryHigh: 99.98 } };
  const rows = await fetchTradierOptionInputs([outside], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(rows[0].marketDataStatus, 'quote_outside_primary_entry_zone');
  assert.equal(calls.length, 2);
});

test('closed or stale market clock blocks quotes and chains', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    return json({ clock: { state: 'closed', timestamp: new Date(now).toISOString(), next_change: new Date(now + 60_000).toISOString() } });
  };
  const rows = await fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(rows[0].marketDataStatus, 'market_not_open');
  assert.equal(calls.length, 1);
});

test('missing or stale catalyst review blocks underlying and chain requests', async () => {
  const { calls, fetchImpl } = fixtureFetch();
  const rows = await fetchTradierOptionInputs([{ signal: { ...signalRow.signal, catalystReview: undefined } }], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(rows[0].marketDataStatus, 'catalyst_review_required');
  assert.deepEqual(calls.map((url) => url.pathname), ['/v1/markets/clock']);
});

test('missing credentials and unsupported environment fail before any API request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({}); };
  await assert.rejects(() => fetchTradierOptionInputs([signalRow], { fetchImpl, now }), /TRADIER_TOKEN/);
  await assert.rejects(() => fetchTradierOptionInputs([signalRow], { token: 'test-only', environment: 'live', fetchImpl, now }), /TRADIER_ENV/);
  assert.equal(calls, 0);
});

test('Tradier position monitor creates conservative composite bid and ask from synchronized live leg quotes', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const calls = [];
  const metrics = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url); calls.push(parsed);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    if (parsed.pathname.endsWith('/markets/quotes')) return json({ quotes: { quote: [
      { symbol: long, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 100, contract_size: 100, bid: 2, ask: 2.05, bid_date: timestamp, ask_date: timestamp,
        greeks: { delta: 0.62, gamma: 0.03, theta: -0.04, vega: 0.08, mid_iv: 0.31, updated_at: new Date(now - 30 * 60_000).toISOString() } },
      { symbol: short, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 103, contract_size: 100, bid: 1, ask: 1.05, bid_date: timestamp, ask_date: timestamp,
        greeks: { delta: 0.28, gamma: 0.02, theta: -0.03, vega: 0.05, mid_iv: 0.27, updated_at: new Date(now - 30 * 60_000).toISOString() } },
    ] } });
    throw new Error(`Unexpected endpoint ${parsed.pathname}`);
  };
  const result = await fetchTradierOptionPositionMarks([
    { orderId: 'open-1', owner: 'options', assetClass: 'option', status: 'filled', instrumentKey: `${long}+${short}`, exposureKey: 'SPY', multiplier: 100, option: { expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } },
    { orderId: 'other', owner: 'stocks', assetClass: 'stock', status: 'open', instrumentKey: 'SPY' },
  ], { token: 'test-only', environment: 'production', fetchImpl, now, clockNow: () => now, providerMetrics: metrics });
  assert.equal(result.marks.length, 1);
  assert.deepEqual(result.marks[0].quote, { bid: 0.95, ask: 1.05, time: new Date(timestamp).toISOString(), quality: 'executable',
    optionGreekContext: { source: 'Tradier/ORATS',
      long: { delta: 0.62, gamma: 0.03, theta: -0.04, vega: 0.08, impliedVolatility: 0.31, asOf: new Date(now - 30 * 60_000).toISOString(), ageMs: 30 * 60_000, freshness: 'within_two_hours' },
      short: { delta: 0.28, gamma: 0.02, theta: -0.03, vega: 0.05, impliedVolatility: 0.27, asOf: new Date(now - 30 * 60_000).toISOString(), ageMs: 30 * 60_000, freshness: 'within_two_hours' },
      net: { delta: 0.34, gamma: 0.01, theta: -0.01, vega: 0.03 }, asOf: new Date(now - 30 * 60_000).toISOString(), freshness: 'within_two_hours' } });
  assert.equal(result.marks[0].sessionOpen, true);
  assert.deepEqual(calls.map((url) => url.pathname), ['/v1/markets/clock', '/v1/markets/quotes']);
  assert.equal(new URL(calls[1]).searchParams.get('symbols'), `${long},${short}`);
  assert.equal(new URL(calls[1]).searchParams.get('greeks'), 'true');
  assert.ok(metrics.every((row) => row.provider === 'Tradier' && Number.isFinite(row.latencyMs)));
});

test('Tradier option position marks retain a zero-floored liquidation bid for a worthless debit vertical', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    return json({ quotes: { quote: [
      { symbol: long, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 100, contract_size: 100, bid: 0.1, ask: 0.3, bid_date: timestamp, ask_date: timestamp },
      { symbol: short, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 103, contract_size: 100, bid: 0.1, ask: 0.2, bid_date: timestamp, ask_date: timestamp },
    ] } });
  };
  const order = { orderId: 'worthless-vertical', owner: 'options', assetClass: 'option', status: 'open',
    instrumentKey: `${long}+${short}`, exposureKey: 'SPY', multiplier: 100, option: { expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } };
  const result = await fetchTradierOptionPositionMarks([order], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(result.marks.length, 1);
  assert.deepEqual(result.marks[0].quote, { bid: 0, ask: 0.2, time: new Date(timestamp).toISOString(), quality: 'executable',
    optionGreekContext: { source: 'Tradier/ORATS', long: null, short: null,
      net: { delta: null, gamma: null, theta: null, vega: null }, asOf: null, freshness: 'partial_or_stale' } });
});

test('option position monitor rejects stale legs, missing metadata, and delayed or closed feeds', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const positions = [
    { orderId: 'stale', owner: 'options', assetClass: 'option', status: 'open', instrumentKey: `${long}+${short}`, exposureKey: 'SPY', multiplier: 100, option: { expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } },
    { orderId: 'legacy', owner: 'options', assetClass: 'option', status: 'open', instrumentKey: 'SPY+SPY2' },
  ];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    return json({ quotes: { quote: [
      { symbol: long, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 100, contract_size: 100, bid: 2, ask: 2.05, bid_date: now - 60_000, ask_date: now - 60_000 },
      { symbol: short, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 103, contract_size: 100, bid: 1, ask: 1.05, bid_date: timestamp, ask_date: timestamp },
    ] } });
  };
  const result = await fetchTradierOptionPositionMarks(positions, { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(result.marks.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.stale_or_future_option_leg_quote, 1);
  assert.equal(result.diagnostics.rejectionReasons.option_contract_metadata_missing_or_invalid, 1);
  const before = calls;
  const delayed = await fetchTradierOptionPositionMarks(positions, { token: 'test-only', environment: 'sandbox', fetchImpl, now });
  const missing = await fetchTradierOptionPositionMarks(positions, { environment: 'production', fetchImpl, now });
  assert.equal(delayed.diagnostics.status, 'sandbox_data_is_delayed');
  assert.equal(missing.diagnostics.status, 'credentials_missing');
  assert.equal(calls, before);
});

test('option position Greeks remain descriptive when timestamps are absent, stale, or future-dated', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const rows = [
    { symbol: long, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 100, contract_size: 100, bid: 2, ask: 2.05, bid_date: timestamp, ask_date: timestamp, greeks: { delta: 0.6, mid_iv: 0.3 } },
    { symbol: short, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 103, contract_size: 100, bid: 1, ask: 1.05, bid_date: timestamp, ask_date: timestamp, greeks: { delta: 0.25, mid_iv: 0.25, updated_at: new Date(now + 60_000).toISOString() } },
  ];
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    return json({ quotes: { quote: rows } });
  };
  const order = { orderId: 'open-greeks', owner: 'options', assetClass: 'option', status: 'open', instrumentKey: `${long}+${short}`,
    exposureKey: 'SPY', multiplier: 100, option: { expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } };
  const result = await fetchTradierOptionPositionMarks([order], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].quote.optionGreekContext.long.freshness, 'timestamp_unavailable');
  assert.equal(result.marks[0].quote.optionGreekContext.short.freshness, 'future_or_invalid_timestamp');
  assert.equal(result.marks[0].quote.optionGreekContext.net.delta, 0.35);
  assert.equal(result.marks[0].quote.quality, 'executable');

  rows[0].greeks.updated_at = new Date(now - 3 * 60 * 60_000).toISOString();
  rows[1].greeks.updated_at = new Date(now - 3 * 60 * 60_000).toISOString();
  const stale = await fetchTradierOptionPositionMarks([order], { token: 'test-only', environment: 'production', fetchImpl, now });
  assert.equal(stale.marks[0].quote.optionGreekContext.freshness, 'partial_or_stale');
  assert.equal(stale.marks[0].quote.optionGreekContext.long.freshness, 'older_than_two_hours');
});

test('option position composite marks require all four bid and ask timestamps to stay synchronized', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/markets/clock')) return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 60 * 60_000).toISOString() } });
    return json({ quotes: { quote: [
      { symbol: long, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 100, contract_size: 100, bid: 2, ask: 2.05, bid_date: timestamp, ask_date: timestamp },
      { symbol: short, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call', strike: 103, contract_size: 100, bid: 1, ask: 1.05, bid_date: timestamp, ask_date: timestamp - 4_000 },
    ] } });
  };
  const order = { orderId: 'open-1', owner: 'options', assetClass: 'option', status: 'open', instrumentKey: `${long}+${short}`,
    exposureKey: 'SPY', multiplier: 100, option: { expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } };
  const result = await fetchTradierOptionPositionMarks([order], { token: 'test-only', environment: 'production', fetchImpl, now, maxLegSkewMs: 3_000 });
  assert.equal(result.marks.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.option_leg_quote_skew, 1);
});

test('invalid identities do not enter the production strategy path and their contract reasons survive', async () => {
  const fixture = fixtureFetch();
  const [row] = await fetchTradierOptionInputs([signalRow], { token: 'identity-test', environment: 'production', now,
    fetchImpl: async (url, init) => {
      const response = await fixture.fetchImpl(url, init);
      if (!new URL(url).pathname.endsWith('/chains')) return response;
      const body = await response.json();
      body.options.option[0].underlying = 'QQQ';
      delete body.options.option[1].contract_size;
      return json(body);
    } });
  assert.equal(row.marketDataStatus, 'no_verified_contract_quotes');
  assert.equal(row.chain.quoteQuality, 'unusable');
  assert.equal(row.chain.identityDiagnostics.identityRejected, 2);
  assert.equal(row.chain.options[1].multiplier, null);
  assert.ok(row.chain.options[0].identityReasons.includes('underlying_identity_mismatch'));
  assert.equal(buildOptionDayTradeCandidate({ ...row, now }).status, 'no-setup');
});

test('duplicate share-class underlying quotes and future or skewed quote sides block chain requests', async () => {
  for (const variant of ['duplicate', 'future', 'skew', 'boolean']) {
    const fixture = fixtureFetch();
    const [row] = await fetchTradierOptionInputs([signalRow], { token: `underlying-${variant}`, environment: 'production', now,
      fetchImpl: async (url, init) => {
        const response = await fixture.fetchImpl(url, init);
        if (!new URL(url).pathname.endsWith('/quotes')) return response;
        const body = await response.json();
        if (variant === 'duplicate') body.quotes.quote = [body.quotes.quote, { ...body.quotes.quote }];
        if (variant === 'future') body.quotes.quote.ask_date = now + 60_000;
        if (variant === 'skew') body.quotes.quote.ask_date = timestamp - 4_000;
        if (variant === 'boolean') body.quotes.quote.bid = true;
        return json(body);
      } });
    assert.equal(row.marketDataStatus, variant === 'duplicate' ? 'duplicate_underlying_quote' : 'stale_or_invalid_quote');
    assert.equal(fixture.calls.some((url) => url.pathname.endsWith('/chains')), false);
  }
});

test('position monitor rejects mismatched contracts, duplicate quotes, and unverifiable ledger identity', async () => {
  const long = 'SPY261002C00100000', short = 'SPY261002C00103000';
  const position = { orderId: 'identity-position', owner: 'options', assetClass: 'option', status: 'open',
    exposureKey: 'SPY', multiplier: 100, instrumentKey: `${long}+${short}`, option: { expiry: '2026-10-02',
      strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } };
  const quote = (symbol, strike) => ({ symbol, underlying: 'SPY', expiration_date: '2026-10-02', option_type: 'call',
    strike, contract_size: 100, bid: strike === 100 ? 2 : 1, ask: strike === 100 ? 2.05 : 1.05, bid_date: timestamp, ask_date: timestamp });
  const variants = [
    ['underlying_identity_mismatch', (rows) => { rows[0].underlying = 'QQQ'; }],
    ['strike_identity_mismatch', (rows) => { rows[0].strike = 90; }],
    ['expiration_identity_mismatch', (rows) => { rows[0].expiration_date = '2026-10-09'; }],
    ['contract_deliverable_unverified', (rows) => { delete rows[0].contract_size; }],
    ['duplicate_contract_identity', (rows) => { rows.push({ ...rows[0], symbol: 'SPY   261002C00100000' }); }],
  ];
  for (const [reason, mutate] of variants) {
    const rows = [quote(long, 100), quote(short, 103)]; mutate(rows);
    const result = await fetchTradierOptionPositionMarks([position], { token: `marks-${reason}`, environment: 'production', now,
      fetchImpl: async (url) => new URL(url).pathname.endsWith('/clock')
        ? json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 3600000).toISOString() } })
        : json({ quotes: { quote: rows } }) });
    assert.equal(result.marks.length, 0, reason);
    assert.equal(result.diagnostics.rejectionReasons[reason], 1, reason);
  }
  const corrupt = [
    { ...position, multiplier: undefined }, { ...position, exposureKey: 'QQQ' },
    { ...position, option: { ...position.option, expiry: '2026-10-09' } },
    { ...position, option: { ...position.option, longLeg: { symbol: long, strike: 90 } } },
  ].map((order, index) => ({ ...order, orderId: `corrupt-${index}` }));
  let requests = 0;
  const result = await fetchTradierOptionPositionMarks(corrupt, { token: 'bad-order-identity', environment: 'production', now,
    fetchImpl: async (url) => {
      requests++;
      assert.ok(new URL(url).pathname.endsWith('/clock'), 'unverified orders must not request marks');
      return json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 3600000).toISOString() } });
    } });
  assert.equal(result.marks.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.option_contract_metadata_missing_or_invalid, 4);
  assert.equal(requests, 1);
});

test('position identity retains actual ETF underlying while validating the shared portfolio risk alias', async () => {
  const long = 'TLT261002C00100000', short = 'TLT261002C00103000';
  const order = { orderId: 'tlt-position', owner: 'options', assetClass: 'option', status: 'open',
    exposureKey: 'UST_RATES', multiplier: 100, instrumentKey: `${long}+${short}`, option: { underlyingSymbol: 'TLT',
      expiry: '2026-10-02', strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } } };
  const fetchImpl = async (url) => new URL(url).pathname.endsWith('/clock')
    ? json({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 5 * 3600000).toISOString() } })
    : json({ quotes: { quote: [100, 103].map((strike, index) => ({ symbol: index ? short : long, underlying: 'TLT',
      expiration_date: '2026-10-02', option_type: 'call', strike, contract_size: 100, bid: index ? 1 : 2,
      ask: index ? 1.05 : 2.05, bid_date: timestamp, ask_date: timestamp })) } });
  const result = await fetchTradierOptionPositionMarks([order], { token: 'tlt-alias', environment: 'production', now, fetchImpl });
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].quote.bid, 0.95);
  const legacy = structuredClone(order); delete legacy.option.underlyingSymbol;
  const legacyResult = await fetchTradierOptionPositionMarks([legacy], { token: 'tlt-alias-legacy', environment: 'production', now, fetchImpl });
  assert.equal(legacyResult.marks.length, 1, 'explicit OCC root plus stored metadata can verify older records');
});
