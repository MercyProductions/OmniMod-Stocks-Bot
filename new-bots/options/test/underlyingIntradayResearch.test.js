import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { analyzeOptionUnderlyings } from '../src/underlyingIntradayResearch.js';
import { createAlpacaRequestGate } from '../../shared/alpacaRequestGate.js';
import { researchBars, researchInput, researchDiscovery, NOW } from './underlyingResearchFixtures.js';

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-intraday-'));
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  let time = NOW;
  const calls = [], providerMetrics = [];
  const clock = () => time, sleep = async (ms) => { time += ms; }, gate = createAlpacaRequestGate({ now: clock, sleep });
  const env = { ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret', OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH: directory, ...options.env };
  const fetcher = async (target, init) => {
    const url = new URL(target); calls.push({ url, at: time }); assert.equal(init.method ?? 'GET', 'GET');
    const response = options.respond ? await options.respond(url, calls.length, { advance: (ms) => { time += ms; }, now: clock })
      : { payload: url.pathname.endsWith('/bars') ? { bars: Object.fromEntries(url.searchParams.get('symbols').split(',').map((symbol) => [symbol, researchBars()])), next_page_token: null }
        : { quotes: Object.fromEntries(url.searchParams.get('symbols').split(',').map((symbol) => [symbol, { ...researchInput().quote, t: new Date(time).toISOString() }])) } };
    return { ok: !response.status || response.status === 200, status: response.status ?? 200, headers: new Headers(response.headers), json: async () => response.payload };
  };
  return { directory, calls, providerMetrics, gate,
    run: (extra = {}) => analyzeOptionUnderlyings({ underlyingDiscovery: researchDiscovery(), env, now: NOW, clock, sleep, requestGate: gate, providerMetrics, fetcher, ...extra }) };
}

test('batched independent analysis persists point-in-time inputs, rules and rejections with no upstream dependency', async (t) => {
  const h = await harness(t);
  const result = await h.run({ underlyingDiscovery: researchDiscovery(['FRESH', 'NEW']) });
  assert.equal(result.diagnostics.status, 'research_complete');
  assert.equal(result.diagnostics.technicalWatches, 2);
  assert.equal(result.diagnostics.paperEligible, 0);
  assert.equal(result.diagnostics.paginationComplete, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url.searchParams.get('symbols'), 'FRESH,NEW');
  assert.equal(h.calls[0].url.searchParams.get('asof'), '2026-10-02');
  assert.equal(h.calls[0].url.searchParams.get('end'), '2026-10-02T13:59:59.999Z');
  assert.ok(h.calls[1].at - h.calls[0].at >= 350);
  const archive = JSON.parse(gunzipSync(await readFile(join(h.directory, result.diagnostics.archive.file))));
  assert.equal(archive.barsBySymbol.FRESH.length, 30);
  assert.equal(archive.rows[0].eligibleForPaper, false);
  assert.equal(archive.rules.minRelativeVolume, 1.5);
  assert.equal(archive.quotesBySymbol.NEW.bs, 10);
});

test('short/empty history pages are consumed until all symbols finish; quotes refresh after pagination', async (t) => {
  const h = await harness(t, { respond: async (url, n, { now }) => ({ payload: n === 1 ? { bars: {}, next_page_token: 'next' }
    : n === 2 ? { bars: { FRESH: researchBars() }, next_page_token: 'second-symbol' }
      : n === 3 ? { bars: { NEW: researchBars() }, next_page_token: null }
        : { quotes: { FRESH: { ...researchInput().quote, t: new Date(now()).toISOString() }, NEW: { ...researchInput().quote, t: new Date(now()).toISOString() } } } }) });
  const result = await h.run({ underlyingDiscovery: researchDiscovery(['FRESH', 'NEW']) });
  assert.equal(result.diagnostics.technicalWatches, 2);
  assert.equal(result.diagnostics.barPages, 3);
  assert.equal(h.calls[2].url.searchParams.get('page_token'), 'second-symbol');
  assert.equal(h.calls[3].url.pathname, '/v2/stocks/quotes/latest');
});

test('incomplete/repeated page tokens do not allow a partial technical signal', async (t) => {
  const h = await harness(t, { respond: async () => ({ payload: { bars: {}, next_page_token: 'same' } }) });
  const result = await h.run();
  assert.equal(result.diagnostics.status, 'provider_error');
  assert.equal(result.diagnostics.paginationComplete, false);
  assert.equal(result.diagnostics.evaluated, 0);
  assert.equal(result.rows[0].reasons[0], 'invalid_or_repeated_page_token');
  assert.equal(h.calls.length, 2);
});

test('wrong response identity and bars beyond the frozen cutoff invalidate the provider observation', async (t) => {
  for (const bars of [{ WRONG: researchBars() }, { FRESH: researchBars({ count: 31 }) }]) {
    const h = await harness(t, { respond: async () => ({ payload: { bars, next_page_token: null } }) });
    const result = await h.run();
    assert.equal(result.diagnostics.status, 'provider_error');
    assert.equal(result.diagnostics.technicalWatches, 0);
    assert.equal(h.calls.length, 1);
  }
});

test('explicit analysis cap follows discovery and duplicate asset/share-class identities cannot use history', async (t) => {
  const h = await harness(t, { env: { OPTIONS_INTRADAY_RESEARCH_MAX_UNDERLYINGS: '1' } });
  const result = await h.run({ underlyingDiscovery: researchDiscovery(['FRESH', 'NEW']) });
  assert.equal(result.diagnostics.inputShortlist, 2);
  assert.equal(result.diagnostics.selected, 1);
  assert.equal(result.diagnostics.deferred, 1);
  assert.equal(result.diagnostics.rejectionReasons.intraday_analysis_budget, 1);
  assert.equal(h.calls[0].url.searchParams.get('symbols'), 'FRESH');
  const alias = researchDiscovery(['BRK.B', 'BRK/B']);
  const invalid = await h.run({ underlyingDiscovery: alias });
  assert.equal(invalid.diagnostics.selected, 0);
  assert.equal(invalid.diagnostics.dataRejected, 2);
});

test('authentication, quota headroom and shared cooldown stop optional research without fallback', async (t) => {
  const h = await harness(t, { respond: async () => ({ status: 403 }) });
  const discovery = researchDiscovery(); discovery.diagnostics.feed = 'sip';
  const rejected = await h.run({ underlyingDiscovery: discovery });
  assert.equal(rejected.diagnostics.status, 'provider_auth_or_quota_deferred');
  assert.equal(rejected.diagnostics.providerFailures, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.searchParams.get('feed'), 'sip');
  const quota = await harness(t, { respond: async () => ({ payload: { bars: { FRESH: researchBars() }, next_page_token: null }, headers: { 'X-RateLimit-Remaining': '5' } }) });
  assert.equal((await quota.run()).diagnostics.status, 'provider_quota_headroom');
  assert.equal(quota.calls.length, 1);
  const cooldown = await harness(t);
  cooldown.gate.defer('fixture-key', 60000);
  assert.equal((await cooldown.run()).diagnostics.status, 'alpaca_pacing_deferred');
  assert.equal(cooldown.calls.length, 0);
});

test('a 429 installs a shared cooldown and no second research request is attempted', async (t) => {
  const h = await harness(t, { respond: async () => ({ status: 429, headers: { 'Retry-After': '60' } }) });
  const first = await h.run();
  assert.equal(first.diagnostics.status, 'provider_auth_or_quota_deferred');
  const second = await h.run();
  assert.equal(second.diagnostics.status, 'alpaca_pacing_deferred');
  assert.equal(second.diagnostics.attemptedSymbols, 0);
  assert.equal(h.calls.length, 1);
});

test('opening window and stale shortlist deferrals do not download historical data', async (t) => {
  const h = await harness(t);
  const discovery = researchDiscovery();
  discovery.diagnostics.sessionOpen = '2026-10-02T13:50:00Z';
  assert.equal((await h.run({ underlyingDiscovery: discovery })).diagnostics.status, 'opening_window_incomplete');
  const stale = researchDiscovery(); stale.shortlist[0].quoteAt = new Date(NOW - 120001).toISOString();
  const result = await h.run({ underlyingDiscovery: stale });
  assert.equal(result.diagnostics.rejectionReasons.stale_underlying_shortlist, 1);
  assert.equal(h.calls.length, 0);
});

test('slow scans recheck the observation clock and deadline rather than accepting quotes frozen at scan start', async (t) => {
  const h = await harness(t, { env: { OPTIONS_INTRADAY_RESEARCH_BUDGET_MS: '1000' }, respond: async (_, n, { advance }) => {
    advance(1500); return { payload: { bars: { FRESH: researchBars() }, next_page_token: null } };
  } });
  const result = await h.run();
  assert.equal(result.diagnostics.status, 'research_time_budget');
  assert.equal(h.calls.length, 1);
  const stale = await harness(t, { respond: async (_, n, { advance }) => {
    if (n === 1) return { payload: { bars: { FRESH: researchBars() }, next_page_token: null } };
    advance(20000); return { payload: { quotes: { FRESH: researchInput().quote } } };
  } });
  assert.equal((await stale.run()).rows[0].reasons[0], 'stale_future_or_unsynchronized_quote');
});

test('missing quotes, missing minutes and conflicting primary sources are separate funnel failures', async (t) => {
  const h = await harness(t, { respond: async (_, n) => ({ payload: n === 1 ? { bars: {
    FRESH: researchBars(), NEW: researchBars(), GAP: researchBars().filter((_, i) => i !== 3),
  }, next_page_token: null } : { quotes: { FRESH: researchInput().quote, GAP: researchInput().quote } } }) });
  const result = await h.run({ underlyingDiscovery: researchDiscovery(['FRESH', 'NEW', 'GAP']),
    signalRows: [{ signal: { underlyingSymbol: 'FRESH', primarySignalOwner: 'stocks', direction: 'short', sessionDate: '2026-10-02', observedAt: new Date(NOW).toISOString() } }] });
  assert.equal(result.diagnostics.evaluated, 3);
  assert.equal(result.diagnostics.dataReady, 1);
  assert.equal(result.diagnostics.dataRejected, 2);
  assert.equal(result.diagnostics.technicalQualified, 1);
  assert.equal(result.diagnostics.conflicts, 1);
  assert.equal(result.diagnostics.technicalWatches, 0);
});

test('no credentials, disabled selector and closed session make zero requests and preserve unknown coverage', async (t) => {
  const h = await harness(t);
  const result = await h.run({ env: {} });
  assert.equal(result.diagnostics.status, 'credentials_missing');
  assert.equal(result.diagnostics.inputShortlist, null);
  assert.equal((await h.run({ env: { OPTIONS_INTRADAY_RESEARCH_SOURCE: 'disabled' } })).diagnostics.status, 'disabled');
  const discovery = researchDiscovery(); discovery.diagnostics.marketOpen = false;
  assert.equal((await h.run({ underlyingDiscovery: discovery })).diagnostics.status, 'session_unavailable_or_closed');
  assert.equal(h.calls.length, 0);
});
