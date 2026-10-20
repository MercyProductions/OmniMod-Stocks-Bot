import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crypto-universe-coverage-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { fetchMarketUniverse, marketUniverseCacheKey, planMarketDiscovery } = await import('../src/cryptoData.js');
const { readCryptoUniverseSnapshot } = await import('../src/cryptoUniverseJournal.js');
const { writeMarketSnapshot } = await import('../src/storage.js');
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

test('CoinGecko discovery unions volume and market-cap leaders and deduplicates assets', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/global')) return new Response(JSON.stringify({ data: {
      updated_at: Date.now() / 1000, total_market_cap: { usd: 2_500_000_000_000 }, total_volume: { usd: 90_000_000_000 },
      market_cap_percentage: { btc: 58, eth: 12 }, market_cap_change_percentage_24h_usd: 1.2, volume_change_percentage_24h_usd: 3.4
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const isVolume = String(url).includes('order=volume_desc');
    const rows = [{ id: 'shared', symbol: 'shr', name: 'Shared', current_price: 2,
      market_cap: 2000, market_cap_rank: 1, total_volume: 500, high_24h: 2.1, low_24h: 1.9 }];
    if (isVolume) rows.push({ id: 'volume-only', symbol: 'vol', name: 'Volume', current_price: 1,
      market_cap: 1000, market_cap_rank: 900, total_volume: 800, high_24h: 1.1, low_24h: 0.9 });
    else rows.push({ id: 'cap-only', symbol: 'cap', name: 'Capitalization', current_price: 3,
      market_cap: 3000, market_cap_rank: 2, total_volume: 300, high_24h: 3.1, low_24h: 2.9 });
    return new Response(JSON.stringify(rows), {
      status: 200, headers: { total: '16989', 'per-page': '250', 'content-type': 'application/json' }
    });
  });
  const snapshot = await fetchMarketUniverse('coverage-test', { force: true, settings: {
    coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250
  } });
  assert.equal(requests.length, 3, `expected global context plus two market pages; received ${JSON.stringify(requests)}`);
  assert.ok(requests.some((url) => url.endsWith('/global')));
  assert.ok(requests.some((url) => /order=volume_desc/.test(url)));
  assert.ok(requests.some((url) => /order=market_cap_desc/.test(url)));
  assert.equal(snapshot.providerReportedTotal, 16989);
  assert.equal(snapshot.providerPageSize, 250);
  assert.equal(snapshot.providerRowsReturned, 4);
  assert.equal(snapshot.discoveryPages, 2);
  assert.equal(snapshot.marketCapPagesFetched, 1);
  assert.equal(snapshot.marketCapPagesRequested, 1);
  assert.equal(snapshot.queryOrder, 'volume_desc + market_cap_desc');
  assert.equal(snapshot.assets.length, 3);
  assert.equal(snapshot.estimatedCallsPer30Days, 5_760);
  assert.equal(snapshot.discoveryBudget.scope, 'bulk_discovery_pages_only');
  assert.deepEqual(snapshot.discoveryBudget.keyedIdentityPlanning, {
    deepCandidateCap: 8, stableShortlistCallsPer30Days: 11_580,
    fullTurnoverCallsPer30Days: 28_860, scope: 'scheduled_discovery_illustration_only'
  });
  assert.equal(snapshot.globalMarketContext.status, 'fresh');
  assert.equal(snapshot.globalMarketContext.btcDominancePct, 58);
  assert.equal(snapshot.universeJournal.status, 'recorded');
  const datedMembership = await readCryptoUniverseSnapshot(snapshot.fetchedAt.slice(0, 10), 'coingecko');
  assert.equal(datedMembership.assetCount, 3);
  assert.deepEqual(datedMembership.assets.map((asset) => asset.id), ['shared', 'volume-only', 'cap-only']);
  const cached = await fetchMarketUniverse('coverage-test', { settings: {
    coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250
  } });
  assert.equal(requests.length, 3);
  assert.equal(cached.globalMarketContext.cacheHit, true);
});

test('Demo discovery budget bounds added pages while preserving the volume page', () => {
  const fifteenMinute = planMarketDiscovery({ discoveryMinutes: 15, maxMarketRank: 1000 }, 'demo');
  assert.equal(fifteenMinute.marketCapPages, 2);
  assert.equal(fifteenMinute.requestsPerRefresh, 3);
  assert.equal(fifteenMinute.estimatedCallsPer30Days, 8_640);
  const fiveMinute = planMarketDiscovery({ discoveryMinutes: 5, maxMarketRank: 1000 }, 'demo');
  assert.equal(fiveMinute.marketCapPages, 0);
  assert.equal(fiveMinute.requestsPerRefresh, 1);
  const publicPlan = planMarketDiscovery({ discoveryMinutes: 15, maxMarketRank: 1000 }, 'public');
  assert.equal(publicPlan.marketCapPages, 4);
  assert.equal(publicPlan.keyedDemoIdentityPlanning, null);
  assert.equal(fifteenMinute.keyedDemoIdentityPlanning, null, 'Demo without a key has no keyed identity requests');
  const keyedPlan = planMarketDiscovery({ coingeckoApiKey: 'fixture-key', discoveryMinutes: 15,
    maxMarketRank: 1000, maxProviderCandidates: 20 }, 'demo');
  assert.equal(keyedPlan.estimatedCallsPer30Days, 8_640, 'the existing page cap is unchanged');
  assert.equal(keyedPlan.keyedDemoIdentityPlanning.stableShortlistCallsPer30Days, 23_100);
  assert.equal(keyedPlan.keyedDemoIdentityPlanning.fullTurnoverCallsPer30Days, 66_300);
});

test('market-universe cache identity separates provider credentials and discovery plans', () => {
  const base = { coingeckoApiKey: 'fixture-key-a', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250 };
  assert.notEqual(marketUniverseCacheKey(base), marketUniverseCacheKey({ ...base, coingeckoApiKey: 'fixture-key-b' }));
  assert.notEqual(marketUniverseCacheKey(base), marketUniverseCacheKey({ ...base, coingeckoApiTier: 'pro' }));
  assert.notEqual(marketUniverseCacheKey(base), marketUniverseCacheKey({ ...base, maxMarketRank: 500 }));
  assert.notEqual(marketUniverseCacheKey(base), marketUniverseCacheKey({ ...base, discoveryMinutes: 30 }));
  assert.equal(marketUniverseCacheKey(base).includes('fixture-key'), false, 'cache identity must not reveal provider credentials');
});

test('identical concurrent forced discovery scans share one provider request set', async (t) => {
  await writeMarketSnapshot('global-market-context', null);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (String(url).endsWith('/global')) return new Response(JSON.stringify({ data: {
      updated_at: Date.now() / 1000, total_market_cap: { usd: 2_500_000_000_000 }, market_cap_percentage: { btc: 58 }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify([{ id: 'shared-refresh', symbol: 's', name: 'Shared refresh', current_price: 1,
      market_cap: 100, market_cap_rank: 1, total_volume: 90 }]), {
      status: 200, headers: { total: '1', 'per-page': '250', 'content-type': 'application/json' }
    });
  });
  const settings = { coingeckoApiKey: 'concurrency-fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250 };
  const [first, second] = await Promise.all([
    fetchMarketUniverse('concurrent-a', { force: true, settings }),
    fetchMarketUniverse('concurrent-b', { force: true, settings })
  ]);
  assert.equal(first.fetchedAt, second.fetchedAt);
  assert.equal(requests.filter((url) => url.endsWith('/global')).length, 1);
  assert.equal(requests.filter((url) => url.includes('/coins/markets')).length, 2);
});

test('market-cap page failures remain diagnostic and do not discard the volume-ranked universe', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/global')) return new Response(JSON.stringify({ data: {
      updated_at: Date.now() / 1000, total_market_cap: { usd: 2_500_000_000_000 },
      market_cap_percentage: { btc: 58 }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('order=market_cap_desc')) return new Response('forbidden', { status: 403 });
    return new Response(JSON.stringify([{ id: 'volume-kept', symbol: 'v', current_price: 1, market_cap: 100,
      market_cap_rank: 20, total_volume: 80 }]), { status: 200, headers: { total: '1000', 'per-page': '250' } });
  });
  const snapshot = await fetchMarketUniverse('partial-test', { force: true, settings: {
    coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250
  }, forceGlobalContext: true });
  assert.equal(requests.length, 3);
  assert.deepEqual(snapshot.assets.map((asset) => asset.id), ['volume-kept']);
  assert.equal(snapshot.marketCapPagesFetched, 0);
  assert.equal(snapshot.marketCapPagesRequested, 1);
  assert.match(snapshot.providerError, /market_cap_desc page 1.*HTTP 403/);
});

test('CoinGecko global-context failure is reported without discarding the asset universe', async (t) => {
  await writeMarketSnapshot('global-market-context', null);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/global')) return new Response('forbidden', { status: 403 });
    return new Response(JSON.stringify([{ id: 'still-available', symbol: 'ok', name: 'Available', current_price: 1,
      market_cap: 100, market_cap_rank: 1, total_volume: 90 }]), {
      status: 200, headers: { total: '1', 'per-page': '250', 'content-type': 'application/json' }
    });
  });
  const snapshot = await fetchMarketUniverse('global-context-failure', { force: true, forceGlobalContext: true, settings: {
    coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250
  } });
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].id, 'still-available');
  assert.equal(snapshot.globalMarketContext.status, 'unavailable');
  assert.match(snapshot.globalMarketContext.fetchError, /HTTP 403/);
  assert.equal(requests.filter((url) => url.endsWith('/global')).length, 1);
});

test('stale universe fallback still attaches global-market context when live providers fail', async (t) => {
  await writeMarketSnapshot('global-market-context', null);
  const fallbackSettings = {
    coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250
  };
  await writeMarketSnapshot(marketUniverseCacheKey(fallbackSettings), {
    fetchedAt: new Date(Date.now() - 60 * 60_000).toISOString(), source: 'CoinGecko demo',
    assets: [{ id: 'cached-asset', symbol: 'cache', name: 'Cached', price: 1, marketCap: 100, volume24h: 80 }]
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response('provider unavailable', { status: 403 });
  });
  const snapshot = await fetchMarketUniverse('stale-context-fallback', {
    force: true, forceGlobalContext: true, settings: fallbackSettings
  });
  assert.equal(snapshot.stale, true);
  assert.deepEqual(snapshot.assets.map((asset) => asset.id), ['cached-asset']);
  assert.equal(snapshot.globalMarketContext.status, 'unavailable');
  assert.match(snapshot.globalMarketContext.fetchError, /HTTP 403/);
  assert.ok(requests.some((url) => url.endsWith('/global')));
});

test('CoinGecko 429 cooldown suppresses later requests while CoinPaprika fallback remains available', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.startsWith('https://api.coingecko.com/'))
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
    if (value.startsWith('https://api.coinpaprika.com/')) return new Response(JSON.stringify([
      { id: 'btc-bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, last_updated: new Date().toISOString(), quotes: { USD: {
        price: 60_000, market_cap: 1_000_000_000_000, volume_24h: 20_000_000_000,
        percent_change_1h: 0.1, percent_change_24h: 1, percent_change_7d: 2,
      } } },
    ]));
    throw new Error(`Unexpected provider request: ${value}`);
  });
  const settings = { coingeckoApiKey: 'fixture-key', coingeckoApiTier: 'demo', discoveryMinutes: 15, maxMarketRank: 250 };
  const first = await fetchMarketUniverse('coingecko-cooldown-first', { force: true, forceGlobalContext: true, settings });
  const second = await fetchMarketUniverse('coingecko-cooldown-second', { force: true, forceGlobalContext: true, settings });
  assert.equal(first.source, 'CoinPaprika public fallback');
  assert.equal(second.source, 'CoinPaprika public fallback');
  assert.equal(requests.filter((url) => url.startsWith('https://api.coingecko.com/')).length, 1,
    'the active host cooldown should suppress the second scan’s upstream CoinGecko calls');
  assert.equal(requests.filter((url) => url.startsWith('https://api.coinpaprika.com/')).length, 2,
    'the independent free fallback remains available for both scans');
  assert.match(second.providerError, /cooling down/i);
});
