import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-broad-discovery-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { normalizeCoinDirectory, directoryChanges, nextDirectoryBatch, inspectBroadPrices, fetchBroadDiscovery,
  planBroadDiscovery, formatBroadDiscoverySummary, screenBroadObservations } = await import('../src/broadDiscovery.js');
const { readMarketSnapshot, writeMarketSnapshot, paths } = await import('../src/storage.js');
const now = Date.parse('2026-10-02T09:00:00Z');
const provider = { base: 'https://api.coingecko.com/api/v3', tier: 'public', headers: {} };
const asset = (id, overrides = {}) => ({ id, symbol: id, name: `Name ${id}`, platforms: {}, ...overrides });
const assets = Array.from({ length: 503 }, (_, n) => asset(`id-${String(n).padStart(4, '0')}`));
const prices = (ids, time = now) => ids.map((id) => ({ id, current_price: 1, total_volume: 10_000_000,
  market_cap: 100_000_000, market_cap_rank: 9000, last_updated: new Date(time).toISOString() }));
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

test('complete directory preserves provider IDs and network/contract case despite ticker collisions', () => {
  const rows = [asset('meme-a', { symbol: 'SAME', platforms: { solana: 'MiXeDCaSe', ethereum: '0xAa' } }),
    asset('micro-b', { symbol: 'same' })];
  const result = normalizeCoinDirectory(rows, now);
  assert.equal(result.assetCount, 2);
  assert.deepEqual(result.ambiguousSymbols, ['SAME']);
  assert.equal(result.assets[0].identity, 'coingecko:meme-a');
  assert.equal(result.assets[0].contracts.find((row) => row.network === 'solana').contract, 'MiXeDCaSe');
  const reordered = normalizeCoinDirectory([rows[1], { ...rows[0], platforms: { ethereum: '0xAa', solana: 'MiXeDCaSe' } }], now);
  assert.deepEqual(directoryChanges(result, reordered).identityMetadataChanged, []);
  assert.throws(() => normalizeCoinDirectory([...rows, rows[0]], now), /Duplicate/);
  assert.throws(() => normalizeCoinDirectory([asset('bad', { platforms: [] })], now), /Incomplete/);
});

test('cursor batches cover every provider ID without a rank ceiling and survive changing membership', () => {
  const catalog = normalizeCoinDirectory(assets, now);
  const first = nextDirectoryBatch(catalog);
  const second = nextDirectoryBatch(catalog, first.nextCursor);
  const third = nextDirectoryBatch(catalog, second.nextCursor);
  assert.deepEqual([first.ids.length, second.ids.length, third.ids.length], [250, 250, 3]);
  assert.equal(new Set([...first.ids, ...second.ids, ...third.ids]).size, 503);
  assert.equal(third.reachedEnd, true);
  const changed = normalizeCoinDirectory([asset('brand-new'), ...assets], now);
  assert.equal(nextDirectoryBatch(changed, first.nextCursor).ids[0], 'id-0250', 'new first-page listings must not reset progress');
  assert.equal(nextDirectoryBatch(changed, third.nextCursor).ids[0], 'brand-new');
  assert.equal(nextDirectoryBatch(changed, third.nextCursor).wrapped, true);
  const long = normalizeCoinDirectory([asset('a'.repeat(3000)), asset('b'.repeat(3000))], now);
  assert.equal(nextDirectoryBatch(long).ids.length, 1, 'encoded URL length is a computational batch boundary');
});

test('valid provider IDs with empty ticker metadata remain discoverable and explicitly flagged', () => {
  const result = normalizeCoinDirectory([asset('no-ticker', { symbol: '' }), asset('no-name', { name: '' })], now);
  assert.equal(result.assetCount, 2);
  assert.equal(result.incompleteMetadataCount, 2);
  assert.deepEqual(result.ambiguousSymbols, []);
  assert.deepEqual(result.assets.find((row) => row.id === 'no-ticker').metadataIssues, ['missing_symbol']);
  assert.deepEqual(nextDirectoryBatch(result).ids, ['no-name', 'no-ticker']);
});

test('batch validation accounts for omitted, stale, future, missing and malformed prices by exact provider ID', () => {
  const ids = ['fresh', 'omitted', 'stale', 'future', 'no-time', 'null-price'];
  const payload = [prices(['fresh'])[0], prices(['stale'], now - 31 * 60_000)[0],
    prices(['future'], now + 120_000)[0], { ...prices(['no-time'])[0], last_updated: null },
    { ...prices(['null-price'])[0], current_price: null }];
  const rows = inspectBroadPrices(ids, payload, now);
  assert.deepEqual(rows.map((row) => row.status), ['fresh_price', 'not_returned_by_markets', 'provider_timestamp_stale',
    'provider_timestamp_future', 'provider_timestamp_missing', 'missing_or_invalid_price']);
  assert.equal(rows[1].price, null);
  assert.throws(() => inspectBroadPrices(['a'], prices(['other']), now), /unexpected/);
  assert.throws(() => inspectBroadPrices(['a'], prices(['a', 'a']), now), /duplicate/);
});

test('refresh persists cursor, shares concurrent calls and resumes without repeating the first batch', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes('/coins/list')) return { payload: assets };
    return { payload: prices(new URL(url).searchParams.get('ids').split(',')) };
  };
  const args = { provider, cacheKey: 'resume', fetchJson, now };
  const [one, same] = await Promise.all([fetchBroadDiscovery(args), fetchBroadDiscovery(args)]);
  assert.equal(calls.length, 2);
  assert.deepEqual(one, same);
  assert.equal(one.directory.assetCount, 503);
  assert.equal(one.prices.checkedLast24h, 50);
  assert.equal(one.prices.uncheckedLast24h, 453);
  assert.equal((await fetchBroadDiscovery({ ...args, now: now + 60_000 })).status, 'cached');
  assert.equal(calls.length, 2);
  const two = await fetchBroadDiscovery({ ...args, now: now + 16 * 60_000 });
  assert.equal(two.prices.checkedLast24h, 100);
  assert.equal(new URL(calls.at(-1)).searchParams.get('ids').split(',')[0], 'id-0050');
  assert.equal(calls.filter((url) => url.includes('/coins/list')).length, 1);
  assert.ok(calls.filter((url) => url.includes('/markets')).every((url) => url.includes('sparkline=false')));
  assert.match(formatBroadDiscoverySummary(two), /503.*Rolling research/);
  const archived = JSON.parse(gunzipSync(await fs.readFile(path.join(directory, 'broad-discovery-history', `broad-resume-prices-${now}.json.gz`))));
  assert.equal(archived.observations.length, 50);
  assert.deepEqual(archived.observations[0].screenReasons, ['missing_activity_fields']);
  assert.equal(archived.scope, 'discovery_research_no_trade_approval');
});

test('cheap research screen retains high-rank activity while recording liquidity, freshness and missing-field failures', () => {
  const good = { ...inspectBroadPrices(['x'], prices(['x']), now)[0], change1hPct: 1, change24hPct: 3 };
  const rows = screenBroadObservations([good, { ...good, id: 'thin', volume24hUsd: 100 },
    { ...good, id: 'stale', status: 'provider_timestamp_stale' }, { ...good, id: 'missing', change1hPct: null }],
  { minVolumeUsd: 5_000_000, maxMarketRank: 250 });
  assert.equal(rows[0].cheapCandidate, true);
  assert.equal(rows[0].outsideBaselineRank, true);
  assert.match(rows[0].screenPolicy.scope, /no_score_model_quote_or_risk_approval/);
  assert.deepEqual(rows.slice(1).map((row) => row.cheapCandidate), [false, false, false]);
  assert.deepEqual(rows[1].screenReasons, ['liquidity_volume', 'liquidity_turnover']);
  assert.deepEqual(rows[2].screenReasons, ['provider_timestamp_stale']);
  assert.deepEqual(rows[3].screenReasons, ['missing_activity_fields']);
});

test('price failures retain the cursor and persist backoff rather than falsely completing a batch', async () => {
  let count = 0;
  const args = { provider, cacheKey: 'failure', now, fetchJson: async (url) => {
    count += 1;
    if (url.includes('/coins/list')) return { payload: assets };
    throw new Error('HTTP 429');
  } };
  const failed = await fetchBroadDiscovery(args);
  assert.equal(failed.status, 'degraded');
  assert.equal(failed.prices.checkedLast24h, 0);
  assert.equal(failed.prices.requestedLastBatch, null);
  assert.equal((await readMarketSnapshot('broad-failure-prices')).cursor, '');
  await fetchBroadDiscovery({ ...args, now: now + 60_000 });
  assert.equal(count, 2);
  const recovered = await fetchBroadDiscovery({ ...args, now: now + 16 * 60_000, fetchJson: async (url) => {
    const ids = new URL(url).searchParams.get('ids').split(',');
    assert.equal(ids[0], 'id-0000');
    return { payload: prices(ids, now + 16 * 60_000) };
  } });
  assert.equal(recovered.prices.checkedLast24h, 50);
});

test('malformed refresh retains the last complete directory and expired membership stops price requests', async () => {
  const old = normalizeCoinDirectory(assets, now);
  await writeMarketSnapshot('broad-stale-directory', old);
  let priceCalls = 0;
  const args = { provider, cacheKey: 'stale', now: now + 25 * 60 * 60_000, fetchJson: async (url) => {
    if (url.includes('/coins/list')) return { payload: [asset('x', { symbol: null })] };
    priceCalls += 1;
    return { payload: [] };
  } };
  const tolerated = await fetchBroadDiscovery(args);
  assert.equal(tolerated.directory.assetCount, 503);
  assert.equal(tolerated.directory.fresh, false);
  assert.equal(tolerated.status, 'degraded');
  assert.deepEqual(await readMarketSnapshot('broad-stale-directory'), old);
  const expired = await fetchBroadDiscovery({ ...args, now: now + 50 * 60 * 60_000 });
  assert.equal(expired.status, 'directory_unavailable');
  assert.equal(priceCalls, 1);
  assert.equal(expired.prices.uncheckedLast24h, 503);
});

test('successful metadata refresh records additions, absences and migrations without symbol-based identity merging', async () => {
  const old = normalizeCoinDirectory([asset('a'), asset('b')], now);
  await writeMarketSnapshot('broad-delta-directory', old);
  const later = now + 25 * 60 * 60_000;
  const result = await fetchBroadDiscovery({ provider, cacheKey: 'delta', now: later, fetchJson: async (url) => {
    if (url.includes('/coins/list')) return { payload: [asset('b', { platforms: { solana: 'NewContract' } }), asset('c')] };
    return { payload: prices(['b', 'c'], later) };
  } });
  assert.deepEqual(result.directory.changes, { baseline: false, added: 1, absentFromActiveDirectory: 1, identityMetadataChanged: 1 });
  const stored = await readMarketSnapshot('broad-delta-directory');
  assert.deepEqual(stored.changes.added, ['c']);
  assert.deepEqual(stored.changes.absentFromActiveDirectory, ['a']);
  assert.ok((await fs.readdir(path.join(directory, 'broad-discovery-history'))).includes(`broad-delta-directory-${later}.json.gz`));
});

test('corrupt persisted state remains visible and is not silently overwritten', async () => {
  await fs.writeFile(paths.marketSnapshot('broad-corrupt-prices'), '{broken');
  await assert.rejects(fetchBroadDiscovery({ provider, cacheKey: 'corrupt', now,
    fetchJson: async () => { throw new Error('must not fetch'); } }), /Unable to read stored JSON/);
  assert.equal(await fs.readFile(paths.marketSnapshot('broad-corrupt-prices'), 'utf8'), '{broken');
});

test('Demo rotating discovery cadence accounts for legacy bulk calls instead of adding unlimited requests', () => {
  const plan = planBroadDiscovery({ discoveryMinutes: 15 }, 5760, 'demo');
  assert.equal(plan.intervalMinutes, 15);
  assert.ok(plan.projectedCallsPer30Days + plan.legacyCallsPer30Days <= 9000);
  assert.ok(planBroadDiscovery({ discoveryMinutes: 15 }, 8640, 'demo').intervalMinutes > 120);
  assert.equal(planBroadDiscovery({}, 9000, 'demo').intervalMinutes, null);
  assert.match(plan.scope, /excludes_monitoring/);
  assert.equal(planBroadDiscovery({}, 28_860, 'demo').directoryAllowed, false);
});

test('existing keyed identity traffic can defer broad collection without spending more Demo calls', async () => {
  const result = await fetchBroadDiscovery({ provider: { ...provider, tier: 'demo' }, cacheKey: 'no-headroom', now,
    legacyCallsPer30Days: 28_860, fetchJson: async () => { throw new Error('must not request with no planning allowance'); } });
  assert.equal(result.status, 'budget_deferred');
  assert.equal(result.plan.projectedCallsPer30Days, 0);
  assert.equal(result.directory.assetCount, null);
});

test('runtime broad observations do not enter the baseline snapshot, published watches or production strategy', async (t) => {
  const { fetchMarketUniverse } = await import('../src/cryptoData.js');
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    let payload;
    if (parsed.pathname.endsWith('/global')) payload = { data: { updated_at: Date.now() / 1000,
      total_market_cap: { usd: 1e12 }, market_cap_percentage: { btc: 50 } } };
    else if (parsed.pathname.endsWith('/list')) payload = [asset('baseline'), asset('new-small-cap')];
    else payload = prices(parsed.searchParams.has('ids') ? ['baseline', 'new-small-cap'] : ['baseline'], Date.now());
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await fetchMarketUniverse('integration', { force: true, settings: { broadDiscoveryEnabled: true,
    coingeckoApiKey: '', coingeckoApiTier: 'public', maxMarketRank: 250, discoveryMinutes: 15 } });
  assert.deepEqual(result.assets.map((row) => row.id), ['baseline']);
  assert.equal(result.broadDiscovery.directory.assetCount, 2);
  assert.equal(result.broadDiscovery.prices.checkedLast24h, 2);
  assert.equal(result.broadDiscovery.mode, 'discovery_research');
  assert.match(result.broadDiscovery.interpretation, /do not enter production/);
});
