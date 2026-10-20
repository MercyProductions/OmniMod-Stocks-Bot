import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectionalDebitSpread, buildOptionCandidatesForChains, fetchTradierChains as loadChains } from '../src/tradierOptions.js';

// Parsing/concurrency fixtures isolate synthetic requests from the persistent
// runtime budget, which has separate real-process and native-header regressions.
function fetchTradierChains(rows, options) {
  const startPacer = async () => ({ localQueueDelayMs: 0 });
  startPacer.deferStarts = async () => {};
  return loadChains(rows, { startPacer, ...options });
}

const now = Date.parse('2026-09-24T15:00:00Z');
const q = (symbol, strike, type, bid, ask, extra = {}) => ({
  symbol, underlying: 'SPY', strike, option_type: type, bid, ask, expiration_date: '2026-10-16',
  bid_date: now - 60_000, ask_date: now - 60_000, open_interest: 1000, volume: 200,
  contract_size: 100, greeks: { delta: 0.5, mid_iv: 0.3 }, ...extra,
});

test('Tradier adapter requests only read-only sandbox chains and normalizes fresh quotes', async () => {
  let requested;
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'test-token', now,
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return { ok: true, json: async () => ({ options: { option: [q('SPY261016C00500000', 500, 'call', 3, 3.2)] } }) };
    },
  });
  assert.match(requested.url, /^https:\/\/sandbox\.tradier\.com\/v1\/markets\/options\/chains\?/);
  assert.match(requested.url, /symbol=SPY/);
  assert.equal(requested.options.headers.Authorization, 'Bearer test-token');
  assert.equal(result[0].status, 'chain-loaded');
  assert.equal(result[0].options[0].quoteValid, true);
  assert.equal(result[0].options[0].openInterest, 1000);
});

test('missing/null Greeks and IV stay unknown rather than being coerced to zero', async () => {
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'test-token', now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: [
      q('SPY261016C00500000', 500, 'call', 3, 3.2, { greeks: { delta: null, mid_iv: null } }),
      q('SPY261016C00505000', 505, 'call', 2, 2.2, { greeks: {} }),
      q('SPY261016C00510000', 510, 'call', 1, 1.2, { greeks: { delta: 0, mid_iv: 0 } }),
    ] } }) }),
  });
  assert.deepEqual(result[0].options.map((option) => [option.delta, option.impliedVolatility]), [
    [null, null], [null, null], [0, 0],
  ]);
  assert.ok(result[0].options.every((option) => option.quoteValid), 'Greek absence does not change quote validity');
});

test('Greeks preserve every returned measure and their independent source timestamp without gating fresh option quotes', async () => {
  const updatedAt = new Date(now - 3 * 60 * 60_000).toISOString();
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'test-token', now, clockNow: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: [q('SPY261016C00500000', 500, 'call', 3, 3.2, {
      greeks: { delta: 0.5, gamma: 0.04, theta: -0.08, vega: 0.12, rho: 0.01, bid_iv: 0.29, mid_iv: 0.3, ask_iv: 0.31, updated_at: updatedAt }
    })] } }) }),
  });
  const option = result[0].options[0];
  assert.equal(option.quoteValid, true);
  assert.deepEqual(option.greeks, { delta: 0.5, gamma: 0.04, theta: -0.08, vega: 0.12, rho: 0.01,
    bidIv: 0.29, midIv: 0.3, askIv: 0.31, updatedAt, ageMs: 3 * 60 * 60_000, freshness: 'older_than_two_hours' });
});

test('Tradier chain adapter bounds concurrent underlyings and preserves input order', async () => {
  let active = 0, peak = 0;
  const universe = ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'].map((symbol) => ({ symbol, expiry: '2026-10-16' }));
  const result = await fetchTradierChains(universe, { token: 'test-token', environment: 'production', now, maxConcurrentUnderlyings: 3,
    fetchImpl: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      return { ok: true, json: async () => ({ options: { option: [] } }) };
    } });
  assert.equal(result.length, universe.length);
  assert.deepEqual(result.map((row) => row.symbol), universe.map((row) => row.symbol));
  assert.ok(peak > 1, `requests remained serial; peak=${peak}`);
  assert.ok(peak <= 3, `concurrency cap exceeded; peak=${peak}`);
  await assert.rejects(fetchTradierChains([], { token: 'test-token', maxConcurrentUnderlyings: 5 }), /from 1 to 4/);
});

test('automatic option expiry discovery selects the first listed date inside the configured window', async () => {
  const calls = [];
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: 'auto' }], {
    token: 'test-token', now, minDaysToExpiry: 7, maxDaysToExpiry: 45,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/expirations?')) return { ok: true, json: async () => ({ expirations: { date: ['2026-09-25', '2026-10-02', '2026-10-16', '2026-12-18'] } }) };
      return { ok: true, json: async () => ({ options: { option: [q('SPY261002C00500000', 500, 'call', 3, 3.2, { expiration_date: '2026-10-02' })] } }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /markets\/options\/expirations\?symbol=SPY/);
  assert.match(calls[1], /expiration=2026-10-02/);
  assert.equal(result[0].expiry, '2026-10-02');
  assert.equal(result[0].options[0].quoteValid, true);
});

test('automatic expiry discovery withholds when no listed date matches the configured holding window', async () => {
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: 'auto' }], {
    token: 'test-token', now, minDaysToExpiry: 30, maxDaysToExpiry: 45,
    fetchImpl: async () => ({ ok: true, json: async () => ({ expirations: { date: ['2026-10-02', '2026-10-16'] } }) }),
  });
  assert.equal(result[0].status, 'no-expiration-in-configured-window');
  assert.equal(result[0].expiry, null);
});

test('missing token and invalid environment fail closed; stale, crossed and wrong-expiry quotes are rejected', async () => {
  await assert.rejects(fetchTradierChains([], {}), /TRADIER_TOKEN/);
  await assert.rejects(fetchTradierChains([], { token: 'x', environment: 'other' }), /TRADIER_ENV/);
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'test', now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: [
      q('SPY261016C00500000', 500, 'call', 3, 3.2, { bid_date: now - 60 * 60_000, ask_date: now - 60 * 60_000 }),
      q('SPY261016C00505000', 505, 'call', 4, 3.2),
      q('SPY261016C00510000', 510, 'call', 2, 2.2, { expiration_date: '2026-10-23' }),
      q('SPY261016C00515000', 515, 'call', 2, 2.2, { ask_date: now + 90_000 }),
    ] } }) }),
  });
  assert.equal(result[0].options.filter((x) => x.quoteValid).length, 0);
});

test('option chain timestamps use a bounded five-second future-clock tolerance', async () => {
  const result = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'test', now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: [
      q('SPY261016C00500000', 500, 'call', 3, 3.2, { bid_date: now + 4_000, ask_date: now + 4_000 }),
      q('SPY261016C00505000', 505, 'call', 2, 2.2, { bid_date: now + 6_000, ask_date: now + 6_000 }),
    ] } }) }),
  });
  assert.deepEqual(result[0].options.map((option) => [option.symbol, option.quoteValid]), [
    ['SPY261016C00500000', true], ['SPY261016C00505000', false],
  ]);
  await assert.rejects(fetchTradierChains([], { token: 'test', maxFutureQuoteMs: 30_001 }), /maxFutureQuoteMs/);
});

test('aligned bullish watches create bounded-risk call debit candidates from ask/bid legs', () => {
  const underlying = { symbol: 'SPY', price: 100, stale: false, scenarios: [
    { horizon: '1-day', bias: 'UPWARD WATCH', target1Scenario: 110 },
    { horizon: '5-day', bias: 'UPWARD WATCH', target1Scenario: 115 },
  ] };
  const chain = { expiry: '2026-10-16', source: 'Tradier sandbox', options: [
    { symbol: 'SPY261016C00100000', underlying: 'SPY', expiry: '2026-10-16', type: 'call', strike: 100, bid: 1.9, ask: 2, quoteValid: true, openInterest: 500, multiplier: 100, quoteAgeMinutes: 1 },
    { symbol: 'SPY261016C00105000', underlying: 'SPY', expiry: '2026-10-16', type: 'call', strike: 105, bid: 0.8, ask: 0.9, quoteValid: true, openInterest: 500, multiplier: 100, quoteAgeMinutes: 1 },
  ] };
  const [candidate] = buildDirectionalDebitSpread(underlying, chain);
  assert.equal(candidate.strategy, 'bull-call-debit');
  assert.equal(candidate.estimatedNetDebitPerShare, 1.2);
  assert.equal(candidate.maxLossUsd, 120);
  assert.equal(candidate.maxProfitAtExpiryUsd, 380);
  assert.equal(candidate.estimatedExpiryPnlAtScenarioTargetUsd, 380);
  assert.equal(candidate.status, 'research-candidate');
});

test('unaligned, stale, thin, excessively wide or negative-scenario-payoff spreads are not surfaced', () => {
  const underlying = { symbol: 'SPY', price: 100, stale: false, scenarios: [
    { horizon: '1-day', bias: 'UPWARD WATCH', target1Scenario: 101 },
    { horizon: '5-day', bias: 'NEUTRAL', target1Scenario: 100 },
  ] };
  const chain = { expiry: '2026-10-16', options: [
    { type: 'call', strike: 100, bid: 4.9, ask: 5, quoteValid: true, openInterest: 1000, multiplier: 100 },
    { type: 'call', strike: 105, bid: 1.9, ask: 2, quoteValid: true, openInterest: 1000, multiplier: 100 },
  ] };
  assert.deepEqual(buildDirectionalDebitSpread(underlying, chain), []);
  underlying.scenarios[1].bias = 'UPWARD WATCH';
  assert.deepEqual(buildDirectionalDebitSpread(underlying, chain), []);
  underlying.scenarios[1].bias = 'DOWNWARD WATCH';
  assert.deepEqual(buildDirectionalDebitSpread(underlying, chain), []);
  underlying.scenarios[1].bias = 'UPWARD WATCH';
  underlying.stale = true;
  assert.deepEqual(buildDirectionalDebitSpread(underlying, chain), []);
});

test('Tradier candidate integration requires a fresh underlying and synchronized option quotes', () => {
  const observedAt = new Date(now - 5 * 60_000).toISOString();
  const underlying = { symbol: 'SPY', observedAt, price: 100, stale: false, scenarios: [
    { horizon: '1-day', bias: 'UPWARD WATCH', target1Scenario: 110 },
    { horizon: '5-day', bias: 'UPWARD WATCH', target1Scenario: 115 },
  ] };
  const chain = { symbol: 'SPY', status: 'chain-loaded', expiry: '2026-10-16', options: [
    { symbol: 'SPY261016C00100000', underlying: 'SPY', expiry: '2026-10-16', type: 'call', strike: 100, bid: 1.9, ask: 2, bidAt: new Date(now - 6 * 60_000).toISOString(), askAt: new Date(now - 6 * 60_000).toISOString(), quoteValid: true, openInterest: 500, multiplier: 100 },
    { symbol: 'SPY261016C00105000', underlying: 'SPY', expiry: '2026-10-16', type: 'call', strike: 105, bid: 0.8, ask: 0.9, bidAt: new Date(now - 6 * 60_000).toISOString(), askAt: new Date(now - 6 * 60_000).toISOString(), quoteValid: true, openInterest: 500, multiplier: 100 },
  ] };
  assert.equal(buildOptionCandidatesForChains([chain], [underlying], { maxUnderlyingQuoteSkewMinutes: 15 }).length, 1);
  const staleQuotes = { ...chain, options: chain.options.map((leg) => ({ ...leg, bidAt: new Date(now - 40 * 60_000).toISOString(), askAt: new Date(now - 40 * 60_000).toISOString() })) };
  assert.deepEqual(buildOptionCandidatesForChains([staleQuotes], [underlying], { maxUnderlyingQuoteSkewMinutes: 15 }), []);
  assert.deepEqual(buildOptionCandidatesForChains([chain], [{ ...underlying, stale: true }], { maxUnderlyingQuoteSkewMinutes: 15 }), []);
});

test('chain parser rejects wrong identities and missing multipliers without dropping diagnostic rows', async () => {
  const badRows = [
    q('QQQ261016C00500000', 500, 'call', 3, 3.2, { underlying: 'QQQ' }),
    q('SPY261016C00510000', 511, 'call', 3, 3.2),
    q('SPY261016P00520000', 520, 'call', 3, 3.2),
    q('SPY261016C00530000', 530, 'call', 3, 3.2, { contract_size: undefined }),
    q('SPY1261016C00540000', 540, 'call', 3, 3.2),
    q('SPY261016C00550000', 550, 'call', 3, 3.2),
    q('SPY   261016C00550000', 550, 'call', 3, 3.2),
  ];
  const [result] = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'fixture', environment: 'production', now, fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: badRows } }) }),
  });
  assert.equal(result.options.length, 7);
  assert.equal(result.identityDiagnostics.identityRejected, 7);
  assert.equal(result.identityDiagnostics.validQuotes, 0);
  assert.equal(result.options[3].multiplier, null, 'missing deliverable must not become 100 shares');
  assert.equal(result.options[0].underlying, 'QQQ', 'provider identity must not be overwritten with SPY');
  for (const reason of ['underlying_identity_mismatch', 'strike_identity_mismatch', 'option_type_mismatch', 'contract_deliverable_unverified', 'adjusted_root_unverified', 'duplicate_contract_identity'])
    assert.ok(result.identityDiagnostics.rejectionReasons[reason] > 0, reason);
});

test('malformed or partial chain and expiry envelopes are provider failures, not empty markets', async () => {
  const bodies = [{}, { options: {} }, { options: { option: [], next_page_token: 'more' } },
    { expirations: { date: ['2026-02-30'] } }, { expirations: { date: ['2026-10-16'] }, next_page_token: 'more' }];
  for (const body of bodies) {
    const [result] = await fetchTradierChains([{ symbol: 'SPY', expiry: Object.hasOwn(body, 'expirations') ? 'auto' : '2026-10-16' }], {
      token: 'fixture', now, fetchImpl: async () => ({ ok: true, json: async () => body }),
    });
    assert.equal(result.status, 'provider-error');
    assert.match(result.errorCode, /^invalid_/);
    assert.equal(result.options, undefined);
  }
  const [empty] = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], {
    token: 'fixture', now, fetchImpl: async () => ({ ok: true, json: async () => ({ options: null }) }),
  });
  assert.equal(empty.status, 'empty-chain');
  assert.equal(empty.identityDiagnostics.contractsReturned, 0);
});

test('provider requests use share-class slash syntax while retaining the caller identity', async () => {
  const requested = [];
  const [result] = await fetchTradierChains([{ symbol: 'BRK.B', expiry: 'auto' }], { token: 'fixture', now,
    fetchImpl: async (input) => {
      const url = new URL(input); requested.push(url.searchParams.get('symbol'));
      return { ok: true, json: async () => url.pathname.endsWith('/expirations') ? { expirations: { date: ['2026-10-16'] } }
        : { options: { option: q('BRK.B261016C00500000', 500, 'call', 3, 3.2, { underlying: 'BRK/B', root_symbol: 'BRK.B' }) } } };
    } });
  assert.deepEqual(requested, ['BRK/B', 'BRK/B']);
  assert.equal(result.symbol, 'BRK.B');
  assert.equal(result.options[0].quoteValid, true);
});

test('numeric coercion and huge timestamps cannot create valid quotes or crash a chain', async () => {
  const [result] = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], { token: 'fixture', now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: [
      q('SPY261016C00500000', 500, 'call', true, 3),
      q('SPY261016C00505000', 505, 'call', 2, 3, { bid_date: 1e100 }), null,
    ] } }) }) });
  assert.equal(result.status, 'chain-loaded');
  assert.equal(result.options.length, 3);
  assert.equal(result.identityDiagnostics.validQuotes, 0);
});

test('both contract quote sides must be synchronized before a chain labels them valid', async () => {
  const [result] = await fetchTradierChains([{ symbol: 'SPY', expiry: '2026-10-16' }], { token: 'fixture', now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ options: { option: q('SPY261016C00500000', 500, 'call', 2, 2.1,
      { bid_date: now - 1000, ask_date: now - 8000 }) } }) }) });
  assert.equal(result.options[0].quoteValid, false);
  assert.ok(result.options[0].rejectionReasons.includes('quote_side_time_skew'));
});
