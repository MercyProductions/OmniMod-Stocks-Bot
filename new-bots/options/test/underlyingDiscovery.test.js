import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { classifyOptionableAssets, discoverOptionUnderlyings, describeOptionsDiscovery } from '../src/underlyingDiscovery.js';
import { summarizeOptionsScan } from '../src/diagnostics.js';
import { assessMarketDataReadiness } from '../../shared/marketDataReadiness.js';
import { providerProfile, renderProviderConfiguration } from '../../shared/providerProfiles.js';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const asset = (symbol, overrides = {}) => ({ id: `id-${symbol}`, symbol, status: 'active', class: 'us_equity',
  exchange: 'NASDAQ', tradable: true, attributes: ['has_options'], ...overrides });
const snapshot = (now = NOW, move = 1) => ({ latestQuote: { bp: 100 + move, ap: 100.02 + move, t: new Date(now).toISOString() },
  dailyBar: { o: 100, c: 100 + move, h: 101 + Math.max(0, move), l: 99 + Math.min(0, move), v: 100000, t: '2026-10-02T04:00:00Z' },
  prevDailyBar: { c: 100, t: '2026-10-01T04:00:00Z' } });
const response = (payload, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => payload });
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-discovery-'));
  try { return await run(directory); }
  finally {
    const rel = relative(tmpdir(), directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
}
function fixture(directory, assets = [asset('AAA')]) {
  const calls = [], metrics = [];
  let elapsed = 0;
  const env = { ALPACA_API_KEY_ID: 'test-key', ALPACA_API_SECRET_KEY: 'test-secret',
    OPTIONS_DIRECTORY_CACHE_PATH: join(directory, 'directory.json'), OPTIONS_DISCOVERY_HISTORY_PATH: join(directory, 'history') };
  const provider = async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(options.method ?? 'GET', 'GET');
    if (url.pathname === '/v2/assets') return response(assets);
    if (url.pathname === '/v2/clock') return response({ timestamp: new Date(NOW + elapsed).toISOString(), is_open: true,
      next_open: '2026-10-05T09:30:00-04:00', next_close: '2026-10-02T16:00:00-04:00' });
    if (url.pathname === '/v2/calendar') return response([{ date: '2026-10-02', open: '09:30', close: '16:00' }]);
    if (url.pathname === '/v2/stocks/snapshots') return response(Object.fromEntries(url.searchParams.get('symbols').split(',')
      .map((symbol) => [symbol, snapshot(NOW + elapsed, symbol === 'ZZZ' ? 10 : 1)])));
    throw new Error('Unexpected endpoint');
  };
  return { calls, env, metrics, provider, advance: (ms) => { elapsed += ms; },
    args: { env, now: NOW, providerMetrics: metrics, clock: () => elapsed,
      sleep: async (ms) => { elapsed += ms; }, requestOptions: { maxAttempts: 1, requestGate: async () => ({}), clock: () => elapsed }, fetcher: provider } };
}

test('directory retains every record, accepts both documented option attributes, and distinguishes identity/feed exclusions', () => {
  const result = classifyOptionableAssets([
    asset('AAA'), asset('BBB', { attributes: ['options_enabled'], exchange: 'AMEX' }),
    asset('SPY', { exchange: 'ARCA', tradable: false }), asset('NOOPT', { attributes: [] }),
    asset('DEAD', { status: 'inactive' }), asset('OTCQ', { exchange: 'OTC' }),
    asset('DUP'), asset('DUP', { id: 'another' }), asset('IDCLASH', { id: 'id-AAA' }),
    asset('BAD', { id: '' }), asset('BTC', { class: 'crypto' }),
  ]);
  assert.equal(result.diagnostics.providerInstruments, 11);
  assert.deepEqual(result.eligible.map((row) => row.symbol), ['BBB', 'SPY']);
  assert.equal(result.diagnostics.rejectionReasons.ambiguous_active_identity, 4);
  assert.equal(result.diagnostics.rejectionReasons.feed_does_not_cover_otc, 1);
  assert.equal(result.rows.length, 11);
  assert.equal(result.diagnostics.underlyingTradable, 1);
  assert.throws(() => classifyOptionableAssets({ assets: [], next_page_token: 'more' }), /complete array/);
});

test('an inactive old listing does not collide with a new active durable identity', () => {
  const result = classifyOptionableAssets([asset('AAA'), asset('AAA', { id: 'old-id', status: 'inactive' })]);
  assert.equal(result.eligible.length, 1);
});

test('missing credentials, disabled source and invalid config never request or fabricate zero coverage', async () => {
  for (const [env, status] of [[{}, 'credentials_missing'], [{ OPTIONS_DISCOVERY_SOURCE: 'disabled' }, 'disabled'],
    [{ OPTIONS_DISCOVERY_FEED: 'delayed_sip' }, 'invalid_feed'], [{ OPTIONS_DISCOVERY_SOURCE: 'unknown' }, 'invalid_discovery_source'],
    [{ ALPACA_API_KEY_ID: 'x', ALPACA_API_SECRET_KEY: 'y', OPTIONS_DISCOVERY_MAX_CANDIDATES: '0' }, 'invalid_discovery_configuration']]) {
    const result = await discoverOptionUnderlyings({ env, fetcher: () => { throw new Error('must not request'); } });
    assert.equal(result.diagnostics.status, status);
    assert.equal(result.diagnostics.providerInstruments, null);
    assert.equal(result.shortlist.length, 0);
    assert.match(describeOptionsDiscovery(result.diagnostics), /unknown eligible/);
  }
});

test('all 1001 eligible underlyings are requested before the shortlist cap, independent of primary alerts', async () => temporary(async (directory) => {
  const assets = [...Array.from({ length: 1000 }, (_, i) => asset(`S${i}`)), asset('ZZZ')];
  const f = fixture(directory, assets);
  f.env.OPTIONS_DISCOVERY_MAX_CANDIDATES = '2';
  const result = await discoverOptionUnderlyings(f.args);
  assert.equal(result.diagnostics.status, 'screen_complete');
  assert.equal(result.diagnostics.eligibleInstruments, 1001);
  assert.equal(result.diagnostics.cheapScreen.attemptedSymbols, 1001);
  assert.equal(result.diagnostics.cheapScreen.requests, 11);
  assert.equal(result.diagnostics.cheapScreen.analysisDeferred, 999);
  assert.equal(result.shortlist[0].symbol, 'ZZZ');
  assert.equal(result.shortlist.length, 2);
  assert.ok(result.shortlist.every((row) => row.researchOnly && row.strategyApproved === false && row.direction === null));
  assert.equal(result.diagnostics.strategyInputs, 0);
  assert.ok(f.metrics.every((row) => row.operation && row.status === 200));
  const archived = JSON.parse(gunzipSync(await readFile(join(directory, 'history', result.diagnostics.archive.file))));
  assert.equal(archived.rows.length, 1001);
  assert.equal(archived.membershipChanges.added.length, 1001);
  assert.ok(archived.rows.some((row) => row.reasons.includes('deep_analysis_budget')));
  assert.ok(!JSON.stringify(result).includes('test-key'));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
}));

test('fresh directory cache avoids repeated enumeration; expired refresh tracks delisted and newly optionable identities', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await discoverOptionUnderlyings(f.args);
  const cached = await discoverOptionUnderlyings(f.args);
  assert.equal(cached.diagnostics.directoryCache, 'fresh');
  assert.equal(f.calls.filter((url) => url.pathname === '/v2/assets').length, 1);
  const file = f.env.OPTIONS_DIRECTORY_CACHE_PATH;
  const cache = JSON.parse(await readFile(file));
  cache.capturedAt = NOW - 7 * 60 * 60_000;
  await writeFile(file, JSON.stringify(cache));
  const refreshed = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => new URL(url).pathname === '/v2/assets'
    ? Promise.resolve(response([asset('AAA', { status: 'inactive' }), asset('NEW')])) : f.provider(url, options) });
  assert.equal(refreshed.diagnostics.directoryCache, 'refreshed');
  assert.deepEqual(refreshed.diagnostics.membershipChanges, { baseline: false, added: 1, removed: 1 });
  assert.equal(refreshed.shortlist[0].symbol, 'NEW');
}));

test('cache is scoped to the provider key and refreshed after an exchange-date boundary', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await discoverOptionUnderlyings(f.args);
  f.env.ALPACA_API_KEY_ID = 'different-key';
  assert.equal((await discoverOptionUnderlyings(f.args)).diagnostics.directoryCache, 'refreshed');
  const file = f.env.OPTIONS_DIRECTORY_CACHE_PATH;
  const cache = JSON.parse(await readFile(file));
  cache.capturedAt = Date.parse('2026-10-01T23:59:00-04:00');
  await writeFile(file, JSON.stringify(cache));
  // A 24h configured cache still refreshes on a new exchange date.
  f.env.OPTIONS_DIRECTORY_REFRESH_MS = String(24 * 60 * 60_000);
  assert.equal((await discoverOptionUnderlyings(f.args)).diagnostics.directoryCache, 'refreshed');
}));

test('expired cache cannot hide provider authentication failure', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await discoverOptionUnderlyings(f.args);
  const file = f.env.OPTIONS_DIRECTORY_CACHE_PATH, cache = JSON.parse(await readFile(file));
  cache.capturedAt = NOW - 7 * 60 * 60_000; await writeFile(file, JSON.stringify(cache));
  const failed = await discoverOptionUnderlyings({ ...f.args, fetcher: async () => response({}, 403) });
  assert.equal(failed.diagnostics.status, 'provider_error');
  assert.equal(failed.diagnostics.eligibleInstruments, null);
  assert.equal(failed.shortlist.length, 0);
}));

test('closed session enumerates membership but does not request snapshots', async () => temporary(async (directory) => {
  const f = fixture(directory);
  const result = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => new URL(url).pathname === '/v2/clock'
    ? Promise.resolve(response({ timestamp: new Date(NOW).toISOString(), is_open: false })) : f.provider(url, options) });
  assert.equal(result.diagnostics.status, 'market_closed');
  assert.equal(result.diagnostics.eligibleInstruments, 1);
  assert.equal(result.diagnostics.cheapScreen, null);
  assert.ok(!f.calls.some((url) => url.pathname.includes('snapshots')));
}));

test('stale clock and inconsistent session calendar stop snapshot work', async () => temporary(async (directory) => {
  const f = fixture(directory);
  const stale = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => new URL(url).pathname === '/v2/clock'
    ? Promise.resolve(response({ timestamp: new Date(NOW - 60000).toISOString(), is_open: true })) : f.provider(url, options) });
  assert.equal(stale.diagnostics.status, 'invalid_market_clock');
  const inconsistent = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => new URL(url).pathname === '/v2/calendar'
    ? Promise.resolve(response([{ date: '2026-10-02', open: '09:30', close: '13:00' }])) : f.provider(url, options) });
  assert.equal(inconsistent.diagnostics.status, 'invalid_market_session');
  assert.ok(!f.calls.some((url) => url.pathname.includes('snapshots')));
}));

test('missing and stale snapshots have per-symbol reasons; paid SIP selection is explicit', async () => temporary(async (directory) => {
  const f = fixture(directory, [asset('AAA'), asset('BBB'), asset('CCC')]);
  f.env.OPTIONS_DISCOVERY_FEED = 'sip';
  const result = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => {
    if (new URL(url).pathname.includes('snapshots')) {
      assert.equal(new URL(url).searchParams.get('feed'), 'sip');
      return Promise.resolve(response({ AAA: snapshot(), BBB: snapshot(NOW - 60000) }));
    }
    return f.provider(url, options);
  } });
  assert.equal(result.diagnostics.status, 'partial_snapshot_coverage');
  assert.equal(result.diagnostics.cheapScreen.rejectionReasons.snapshot_missing, 1);
  assert.equal(result.diagnostics.cheapScreen.rejectionReasons.stale_or_future_quote, 1);
  assert.deepEqual(result.shortlist.map((row) => row.symbol), ['AAA']);
}));

test('quota exhaustion stops remaining batches, records unrequested symbols and emits no partial shortlist', async () => temporary(async (directory) => {
  const f = fixture(directory, Array.from({ length: 250 }, (_, i) => asset(`S${i}`)));
  let calls = 0;
  const result = await discoverOptionUnderlyings({ ...f.args, fetcher: (url, options) => {
    if (new URL(url).pathname.includes('snapshots') && ++calls === 2) return Promise.resolve(response({}, 429));
    return f.provider(url, options);
  } });
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.status, 'provider_auth_or_quota_deferred');
  assert.equal(result.diagnostics.cheapScreen.unrequestedSymbols, 50);
  assert.equal(result.shortlist.length, 0);
}));

test('research time budget defers remaining symbols explicitly', async () => temporary(async (directory) => {
  const f = fixture(directory, Array.from({ length: 250 }, (_, i) => asset(`S${i}`)));
  const result = await discoverOptionUnderlyings({ ...f.args, fetcher: async (url, options) => {
    const result = await f.provider(url, options);
    if (new URL(url).pathname.includes('snapshots')) f.advance(61000);
    return result;
  } });
  assert.equal(result.diagnostics.status, 'scan_time_budget');
  assert.equal(result.diagnostics.cheapScreen.unrequestedSymbols, 150);
  assert.equal(result.shortlist.length, 0);
}));

test('research counts do not inflate production strategy/entry counts or imply complete coverage', () => {
  const underlyingDiscovery = { status: 'partial_snapshot_coverage', eligibleInstruments: 2000, feedQuality: 'single-venue research',
    cheapScreen: { attemptedSymbols: 2000, cheaplyScreened: 1000, shortlisted: 12 } };
  const report = summarizeOptionsScan({ underlyingDiscovery });
  assert.equal(report.universe, underlyingDiscovery);
  assert.equal(report.funnel.strategyCandidates, 0);
  assert.equal(report.funnel.paperReservations, 0);
  const state = assessMarketDataReadiness('options', { env: {}, inputCount: 0, underlyingDiscovery });
  assert.equal(state.status, 'research_only');
  assert.equal(state.automatedScanRan, true);
  assert.match(state.detail, /No independent option-chain strategy/);
  assert.match(describeOptionsDiscovery(underlyingDiscovery), /12 research shortlist/);
});

test('free/paid discovery profiles preserve the existing Tradier and risk settings', () => {
  for (const [name, feed] of [['discovery-free', 'iex'], ['discovery-paid', 'sip']]) {
    const profile = providerProfile('options', name);
    assert.equal(profile.settings.OPTIONS_DISCOVERY_FEED, feed);
    const text = renderProviderConfiguration('OPTIONS_SOURCE=tradier\nTRADIER_ENV=sandbox\nOMNIMOD_EMERGENCY_STOP=true\n', profile);
    assert.match(text, /TRADIER_ENV=sandbox/);
    assert.match(text, /OMNIMOD_EMERGENCY_STOP=true/);
  }
});
