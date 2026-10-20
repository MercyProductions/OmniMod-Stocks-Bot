import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { discoverOptionContracts } from '../src/contractDiscovery.js';
import { OPTIONS_DISCOVERY_VERSION } from '../src/underlyingDiscovery.js';
import { createTradierStartPacer } from '../src/tradierRateLimit.js';

const NOW = Date.parse('2026-10-02T15:00:00Z');
const response = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
const dates = ['2026-10-09', '2026-10-16', '2026-10-23', '2028-01-21'];
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-option-contracts-'));
  try { return await run(directory); }
  finally {
    const rel = relative(tmpdir(), directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
}
function fixture(directory, symbols = ['AAA']) {
  let clock = NOW;
  const calls = [], metrics = [];
  const env = { TRADIER_TOKEN: 'fixture-secret', TRADIER_ENV: 'sandbox',
    OPTIONS_EXPIRATION_CACHE_PATH: join(directory, 'cache'), OPTIONS_CONTRACT_HISTORY_PATH: join(directory, 'history') };
  const underlyingDiscovery = { diagnostics: { version: OPTIONS_DISCOVERY_VERSION, marketOpen: true, sessionClose: '2026-10-02T20:00:00Z' },
    shortlist: symbols.map((symbol) => ({ symbol, assetId: 'id-' + symbol, quoteAt: new Date(NOW).toISOString() })) };
  const pacer = createTradierStartPacer({ now: () => clock, sleep: async (ms) => { clock += ms; } });
  const fetcher = async (input, options) => {
    const url = new URL(input); calls.push(url);
    assert.equal(options.method, 'GET');
    if (url.pathname.endsWith('/expirations')) {
      assert.equal(url.searchParams.get('includeAllRoots'), 'true');
      return response({ expirations: { date: dates } });
    }
    assert.equal(url.pathname, '/v1/markets/options/chains');
    assert.equal(url.searchParams.get('greeks'), 'false');
    const underlying = url.searchParams.get('symbol'), expiry = url.searchParams.get('expiration');
    const root = underlying.replaceAll('/', '.');
    const stamp = env.TRADIER_ENV === 'sandbox' ? clock - 15 * 60000 : clock;
    return response({ options: { option: ['C', 'P'].map((type) => ({ symbol: `${root}${expiry.slice(2).replaceAll('-', '')}${type}00100000`,
      underlying, root_symbol: root, expiration_date: expiry, option_type: type === 'C' ? 'call' : 'put', strike: 100,
      contract_size: 100, bid: 2, ask: 2.1, bid_date: stamp, ask_date: stamp, open_interest: 300, volume: 10 })) } });
  };
  const args = { env, underlyingDiscovery, providerMetrics: metrics, clock: () => clock, startPacer: pacer,
    retrySleep: async (ms) => { clock += ms; }, random: () => 0, fetcher };
  return { env, calls, metrics, underlyingDiscovery, args, fetcher, pacer, advance: (ms) => { clock += ms; },
    run: (overrides = {}) => discoverOptionContracts({ ...args, now: clock, ...overrides }) };
}

test('independent complete expiration inventories precede round-robin chain requests; archive retains every contract', async () => temporary(async (directory) => {
  const f = fixture(directory, ['AAA', 'BBB']);
  const result = await f.run();
  assert.equal(result.diagnostics.status, 'inventory_observed');
  assert.equal(result.diagnostics.expirationDates, 8);
  assert.equal(result.diagnostics.eligibleExpirations, 6);
  assert.equal(result.diagnostics.deferredExpirations, 2);
  assert.equal(result.diagnostics.contractsReturned, 8);
  assert.equal(result.diagnostics.verifiedIdentities, 8);
  assert.equal(result.diagnostics.delayedResearchQuotes, 8);
  assert.equal(result.diagnostics.providerRequests, 6);
  assert.deepEqual(f.calls.map((url) => [url.pathname.split('/').at(-1), url.searchParams.get('symbol'), url.searchParams.get('expiration')]),
    [['expirations', 'AAA', null], ['expirations', 'BBB', null], ['chains', 'AAA', '2026-10-09'], ['chains', 'BBB', '2026-10-09'],
      ['chains', 'AAA', '2026-10-16'], ['chains', 'BBB', '2026-10-16']]);
  assert.ok(result.underlyings[0].expirations.includes('2028-01-21'));
  const archive = JSON.parse(gunzipSync(await readFile(join(directory, 'history', result.diagnostics.archive.file))));
  assert.equal(archive.inventories.length, 4);
  assert.ok(archive.inventories.flatMap((row) => row.contracts).every((row) => row.eligibleForPaper === false));
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  assert.ok(f.metrics.every((metric) => metric.operation.startsWith('research-')));
}));

test('cached expirations avoid repeated API work while later expiries rotate and every chain quote is refreshed', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await f.run();
  const next = await f.run();
  assert.equal(next.underlyings[0].expirationCache.status, 'fresh');
  assert.deepEqual(next.underlyings[0].selectedExpirations, ['2026-10-09', '2026-10-23']);
  assert.equal(f.calls.filter((url) => url.pathname.endsWith('/expirations')).length, 1);
  assert.equal(f.calls.filter((url) => url.pathname.endsWith('/chains')).length, 4);
  assert.deepEqual(next.underlyings[0].chains[0].membershipChanges, { baseline: false, added: 0, removed: 0, removalStatus: 'observed' });
}));

test('new/removed strikes are measured from complete verified responses; identity errors cannot imply delisting', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await f.run();
  const changed = await f.run({ fetcher: async (url, options) => {
    const response = await f.fetcher(url, options), body = await response.json();
    if (new URL(url).pathname.endsWith('/chains')) body.options.option = [body.options.option[0],
      { ...body.options.option[1], symbol: body.options.option[1].symbol.replace('00100000', '00101000'), strike: 101 }];
    return { ...response, json: async () => body };
  } });
  assert.deepEqual(changed.underlyings[0].chains[0].membershipChanges, { baseline: false, added: 1, removed: 1, removalStatus: 'observed' });
  const broken = await f.run({ fetcher: async (url, options) => {
    const response = await f.fetcher(url, options), body = await response.json();
    if (new URL(url).pathname.endsWith('/chains')) body.options.option[1].underlying = 'WRONG';
    return { ...response, json: async () => body };
  } });
  assert.equal(broken.underlyings[0].chains[0].membershipChanges.removed, null);
  assert.equal(broken.diagnostics.identityRejected, 2);
}));

test('production observations remain research-only despite current quote timestamps', async () => temporary(async (directory) => {
  const f = fixture(directory); f.env.TRADIER_ENV = 'production';
  const result = await f.run();
  assert.equal(result.diagnostics.freshResearchQuotes, 4);
  assert.equal(result.diagnostics.delayedResearchQuotes, 0);
  assert.equal(result.diagnostics.paperEligible, 0);
  assert.equal(result.diagnostics.strategyCandidates, 0);
  assert.ok(f.calls.every((url) => url.hostname === 'api.tradier.com'));
}));

test('missing credentials, disabled research, unverified session and invalid configuration do not request data', async () => temporary(async (directory) => {
  const f = fixture(directory);
  for (const [overrides, status] of [
    [{ env: {} }, 'credentials_missing'], [{ env: { OPTIONS_CONTRACT_DISCOVERY_SOURCE: 'disabled' } }, 'disabled'],
    [{ env: { ...f.env, OPTIONS_CONTRACT_MAX_EXPIRATIONS: '0' } }, 'invalid_contract_configuration'],
    [{ env: { ...f.env, TRADIER_ENV: 'other' } }, 'invalid_environment'],
    [{ underlyingDiscovery: null }, 'underlying_discovery_unavailable'],
    [{ underlyingDiscovery: { ...f.underlyingDiscovery, diagnostics: { ...f.underlyingDiscovery.diagnostics, sessionClose: null } } }, 'underlying_session_unverified_or_closed'],
    [{ underlyingDiscovery: { ...f.underlyingDiscovery, shortlist: [] } }, 'no_independent_underlying_shortlist'],
  ]) {
    const result = await f.run(overrides);
    assert.equal(result.diagnostics.status, status);
    assert.equal(result.diagnostics.contractsReturned, null);
  }
  assert.equal(f.calls.length, 0);
}));

test('duplicates, stale inputs and work caps are separate from actual underlying universe size', async () => temporary(async (directory) => {
  const f = fixture(directory, ['AAA', 'AAA', 'OLD', 'BBB', 'CCC']);
  f.underlyingDiscovery.shortlist[2].quoteAt = new Date(NOW - 180000).toISOString();
  f.env.OPTIONS_CONTRACT_MAX_UNDERLYINGS = '1';
  const result = await f.run();
  assert.equal(result.diagnostics.inputUnderlyings, 5);
  assert.equal(result.diagnostics.selectedUnderlyings, 1);
  assert.equal(result.diagnostics.deferredUnderlyings, 4);
  assert.equal(result.diagnostics.rejectionReasons.ambiguous_underlying_identity, 2);
  assert.equal(result.diagnostics.rejectionReasons.stale_underlying_shortlist, 1);
  assert.equal(result.diagnostics.rejectionReasons.underlying_chain_budget, 1);
  assert.ok(f.calls.every((url) => url.searchParams.get('symbol') === 'BBB'));
}));

test('cache scope changes with token, environment and durable underlying identity', async () => temporary(async (directory) => {
  const f = fixture(directory);
  await f.run(); f.env.TRADIER_TOKEN = 'other-fixture'; await f.run();
  f.env.TRADIER_ENV = 'production'; await f.run();
  f.underlyingDiscovery.shortlist[0].assetId = 'new-listing-id'; await f.run();
  assert.equal(f.calls.filter((url) => url.pathname.endsWith('/expirations')).length, 4);
}));

test('expired metadata refresh detects new dates and never falls back after authentication failure', async () => temporary(async (directory) => {
  const f = fixture(directory); await f.run();
  const [name] = await readdir(join(directory, 'cache')), file = join(directory, 'cache', name);
  const expire = async () => { const cached = JSON.parse(await readFile(file)); cached.observedAt = NOW - 2 * 3600000; await writeFile(file, JSON.stringify(cached)); };
  await expire();
  const changed = await f.run({ fetcher: (url, options) => new URL(url).pathname.endsWith('/expirations')
    ? Promise.resolve(response({ expirations: { date: ['2026-10-09', '2026-11-20'] } })) : f.fetcher(url, options) });
  assert.deepEqual(changed.underlyings[0].expirationCache.changes.added, ['2026-11-20']);
  assert.equal(changed.underlyings[0].expirationCache.changes.removed.length, 3);
  await expire();
  const failed = await f.run({ fetcher: async () => response({}, 403) });
  assert.equal(failed.diagnostics.status, 'provider_auth_or_quota_deferred');
  assert.equal(failed.diagnostics.expirationDates, null);
  assert.equal(failed.diagnostics.chainRequests, 0);
  assert.equal(failed.diagnostics.expiredMetadataFallbacks, 0);
}));

test('rate-limit headroom preserves the current metadata observation and defers remaining requests', async () => temporary(async (directory) => {
  const f = fixture(directory, ['AAA', 'BBB']);
  const result = await f.run({ fetcher: async () => response({ expirations: { date: dates } }, 200, { 'X-Ratelimit-Available': '5' }) });
  assert.equal(result.diagnostics.status, 'provider_quota_headroom');
  assert.equal(result.diagnostics.providerRequests, 1);
  assert.equal(result.diagnostics.expirationInventories, 1);
  assert.equal(result.diagnostics.chainRequests, 0);
  assert.equal(result.diagnostics.deferredChains, 2);
}));

test('429 long cooldown and an already deferred token do not block research beyond its time budget', async () => temporary(async (directory) => {
  const f = fixture(directory);
  const result = await f.run({ fetcher: async () => response({}, 429, { 'Retry-After': '600' }) });
  assert.equal(result.diagnostics.status, 'provider_auth_or_quota_deferred');
  assert.equal(result.diagnostics.providerRequests, 1);
  const next = await f.run();
  assert.equal(next.diagnostics.status, 'provider_pacing_deferred');
  assert.equal(next.diagnostics.providerRequests, 0);
  assert.equal(f.calls.length, 0);
}));

test('time budget stops new chains and retains explicit unfinished expiration records', async () => temporary(async (directory) => {
  const f = fixture(directory, ['AAA', 'BBB']);
  const result = await f.run({ fetcher: async (url, options) => {
    const response = await f.fetcher(url, options);
    if (new URL(url).pathname.endsWith('/expirations')) f.advance(46000);
    return response;
  } });
  assert.equal(result.diagnostics.status, 'research_time_budget');
  assert.equal(result.diagnostics.providerRequests, 1);
  assert.equal(result.diagnostics.chainRequests, 0);
  assert.equal(result.diagnostics.deferredUnderlyings, 1);
}));

test('malformed successful provider responses are parsing failures, not zero-contract observations', async () => temporary(async (directory) => {
  const f = fixture(directory);
  const result = await f.run({ fetcher: (url, options) => new URL(url).pathname.endsWith('/chains')
    ? Promise.resolve(response({ options: { option: [] }, next_page_token: 'more' })) : f.fetcher(url, options) });
  assert.equal(result.diagnostics.status, 'partial_provider_failure');
  assert.equal(result.diagnostics.contractsReturned, null);
  assert.equal(result.diagnostics.failedOperations, 2);
  assert.equal(result.diagnostics.providerFailures, 0);
  assert.equal(result.diagnostics.rejectionReasons.invalid_chain_response, 2);
}));
