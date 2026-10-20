import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-venue-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { normalizeBinanceDirectory, screenBinanceBulk, buildVenueIdentityMap, selectVenueCandidates,
  refreshVenueIdentity, fetchVenueDiscovery, planVenueResearch, selectVenueResearchAssets, cachedVenueRequest, venueDirectoryChanges } = await import('../src/venueDiscovery.js');
const { paths, readMarketSnapshot, writeMarketSnapshot } = await import('../src/storage.js');
const now = Date.parse('2026-10-02T15:00:00Z');
const provider = { base: 'https://api.coingecko.com/api/v3', headers: {}, tier: 'public' };
const instrument = (base, overrides = {}) => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true, ...overrides });
const ticker = (base, overrides = {}) => ({ symbol: `${base}USDT`, lastPrice: '10', bidPrice: '9.99', askPrice: '10.01',
  closeTime: now, quoteVolume: '10000000', priceChangePercent: '8', highPrice: '10.5', lowPrice: '9', ...overrides });
const identity = (base, id = base.toLowerCase(), overrides = {}) => ({ base, target: 'USDT', coin_id: id,
  market: { identifier: 'binance' }, is_stale: false, is_anomaly: false, ...overrides });
const anchors = [{ id: 'tether', price: 0.99, lastUpdated: new Date(now).toISOString() }];
after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

test('whole native directory is counted before inactivity, freshness, currency and liquidity filtering', () => {
  const catalog = normalizeBinanceDirectory({ symbols: [instrument('MEME'), instrument('OLD', { status: 'BREAK' }),
    instrument('STALE'), instrument('TRY', { quoteAsset: 'TRY' }), instrument('NULL'), instrument('BADTIME')] }, now);
  const screen = screenBinanceBulk(catalog, [ticker('MEME'), ticker('OLD'), ticker('STALE', { closeTime: now - 900000 }),
    ticker('TRY'), ticker('NULL', { quoteVolume: null }), ticker('BADTIME', { closeTime: 1e30 }), ticker('UNLISTED')], { now, assets: anchors });
  assert.equal(screen.counts.providerInstruments, 6);
  assert.equal(screen.counts.activeSpotPairs, 5);
  assert.equal(screen.counts.cheaplyScreened, 6);
  assert.equal(screen.counts.unexpectedTickerPairs, 1);
  assert.deepEqual(screen.ranked.map((row) => row.base), ['MEME']);
  assert.equal(screen.ranked[0].volumeUsd, 9_900_000, 'stablecoin peg is not assumed');
  assert.equal(screen.rejectionReasons.stale_provider_timestamp, 1);
  assert.equal(screen.rejectionReasons.missing_provider_timestamp, 1);
  assert.equal(screen.rows.find((row) => row.base === 'NULL').volumeUsd, null);
  assert.equal(screenBinanceBulk(catalog, [ticker('MEME')], { now, assets: [] }).ranked.length, 0);
  assert.throws(() => normalizeBinanceDirectory({ symbols: [instrument('A'), instrument('A')] }), /duplicate/);
  assert.throws(() => screenBinanceBulk(catalog, [ticker('A'), ticker('A')]), /duplicate/);
});

test('venue shortlist uses exact asset IDs and rejects conflicting, stale and wrong-venue identity', () => {
  const catalog = normalizeBinanceDirectory({ symbols: ['MEME', 'COLLIDE', 'STALE', 'WRONG'].map((base) => instrument(base)) }, now);
  const screen = screenBinanceBulk(catalog, ['MEME', 'COLLIDE', 'STALE', 'WRONG'].map((base) => ticker(base)), { now, assets: anchors });
  const mapping = buildVenueIdentityMap([identity('MEME', 'micro-cap-9999'), identity('COLLIDE', 'one'), identity('COLLIDE', 'two'),
    identity('STALE', 'stale', { is_stale: true }), identity('WRONG', 'wrong', { market: { identifier: 'other' } })], 'binance');
  const result = selectVenueCandidates(screen, mapping, 2);
  assert.deepEqual(result.candidates.map((row) => row.coinId), ['micro-cap-9999']);
  assert.equal(mapping.conflicts.size, 1);
  assert.equal(result.rejections.length, 3);
  assert.equal(selectVenueCandidates(screen, null).candidates.length, 0);
});

test('paged identity refresh resumes without treating first page or failures as complete', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('order'), 'base_target');
    calls.push(query.get('page'));
    return { payload: { tickers: query.get('page') === '1' ? Array.from({ length: 100 }, (_, n) => identity(`A${n}`)) : [identity('FINAL')] } };
  };
  const args = { provider, cacheKey: 'paging', fetchJson, now, clock: () => now, maxPages: 1, spacingMs: 0 };
  const first = await refreshVenueIdentity(args);
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.tickers, []);
  const failed = await refreshVenueIdentity({ ...args, fetchJson: async () => { throw new Error('test timeout'); } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.nextPage, 2);
  const second = await refreshVenueIdentity(args);
  assert.equal(second.status, 'complete');
  assert.equal(second.tickers.length, 101);
  assert.deepEqual(calls, ['1', '2']);
  assert.equal((await refreshVenueIdentity(args)).cacheHit, true);
});

test('repeated pages and page ceilings remain explicit incomplete identity coverage', async () => {
  const rows = Array.from({ length: 100 }, (_, n) => identity(`R${n}`));
  const result = await refreshVenueIdentity({ provider, cacheKey: 'repeated', now, maxPages: 3, spacingMs: 0,
    fetchJson: async () => ({ payload: { tickers: rows } }) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Repeated/);
  await writeMarketSnapshot('venue-identity-ceiling-binance-pending', { startedAt: new Date(now).toISOString(), nextPage: 51, tickers: rows, pageHashes: [] });
  const capped = await refreshVenueIdentity({ provider, cacheKey: 'ceiling', now, fetchJson: async () => assert.fail('No requests beyond page budget') });
  assert.equal(capped.status, 'failed');
  assert.match(capped.error, /50-page/);
});

test('bulk discovery shares in-flight requests and reports all stages without executable quote claims', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    const payload = url.includes('exchangeInfo') ? { symbols: [instrument('BROAD')] }
      : url.includes('ticker/24hr') ? [ticker('BROAD')]
        : { tickers: [identity('BROAD', 'broad-id')] };
    return { payload };
  };
  const args = { provider, cacheKey: 'whole', fetchJson, now, clock: () => now, mappingSpacingMs: 0, assets: anchors, settings: { maxProviderCandidates: 8 } };
  const [a, b] = await Promise.all([fetchVenueDiscovery(args), fetchVenueDiscovery(args)]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
  assert.equal(a.report.counts.shortlisted, 1);
  assert.equal(a.report.prices.approvedExecutionQuote, false);
  assert.equal(a.report.directory.accountTradability, 'unverified');
  const archive = JSON.parse(gunzipSync(await fs.readFile(path.join(paths.researchDir(), 'venue-discovery-history', a.report.journal.file))));
  assert.equal(archive.rows.length, 1);
  assert.equal(archive.rows[0].venueInstrumentId, 'binance:spot:BROADUSDT');
  await fetchVenueDiscovery(args);
  assert.equal(calls.length, 3);
  assert.equal((await readMarketSnapshot('venue-binance-whole-latest')).candidates[0].coinId, 'broad-id');
});

test('research selection accepts high ranks but never bypasses stale, identity, collision or workload guards', () => {
  const row = (id, symbol = id) => ({ id, symbol, price: 5, rank: 9999, lastUpdated: new Date(now).toISOString(),
    requiresVerifiedIdentity: true, venueDiscovery: { coinId: id } });
  const snapshot = { assets: [row('different', 'COLLIDE')], venueDiscovery: { status: 'available' },
    venueCandidates: [row('already'), row('bad', 'COLLIDE'), { ...row('stale'), lastUpdated: '2020-01-01' },
      { ...row('unchecked'), requiresVerifiedIdentity: false }, row('new'), row('capped')] };
  const selected = selectVenueResearchAssets(snapshot, [row('already')], { venueResearchCandidates: 1 }, now);
  assert.deepEqual(selected.assets.map((asset) => asset.id), ['new']);
  assert.deepEqual(selected.rejections.map((item) => item.code), ['already_deep_analyzed', 'ambiguous_research_identity',
    'stale_or_unavailable_research_metadata', 'unverified_research_identity', 'venue_research_analysis_budget']);
  assert.equal(selectVenueResearchAssets(snapshot, [], { venueResearchCandidates: 0 }, now).assets.length, 0);
});

test('Demo planning reserves broad, baseline, metadata and worst-case per-asset identity traffic', () => {
  const blocked = planVenueResearch({ venueResearchCandidates: 2, discoveryMinutes: 15 }, { tier: 'demo', baselineCalls: 6000, broadCalls: 2000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.detailedIdentityCalls, 28_800);
  assert.equal(blocked.projectedCallsPer30Days, 41_240);
  assert.equal(planVenueResearch({ venueResearchCandidates: 2 }, { tier: 'public' }).allowed, true);
});

test('shortlist metadata cache preserves refresh cadence and does not cache a failed response', async () => {
  let count = 0;
  const request = async () => ({ fetchedAt: new Date(now).toISOString(), rows: [{ id: String(++count) }] });
  assert.equal((await cachedVenueRequest('shortlist-test', 10000, request, now)).cacheHit, false);
  assert.equal((await cachedVenueRequest('shortlist-test', 10000, request, now + 1)).cacheHit, true);
  await assert.rejects(cachedVenueRequest('shortlist-fail', 10000, async () => { throw new Error('timeout'); }, now), /timeout/);
  assert.equal(await readMarketSnapshot('shortlist-fail'), null);
  assert.equal(count, 1);
});

test('directory changes distinguish status transitions and absence without inventing delisting', () => {
  const previous = normalizeBinanceDirectory({ symbols: [instrument('A'), instrument('B')] }, now);
  const current = normalizeBinanceDirectory({ symbols: [instrument('A', { status: 'BREAK' }), instrument('C')] }, now);
  const changes = venueDirectoryChanges(previous, current);
  assert.deepEqual(changes.added, ['CUSDT']);
  assert.deepEqual(changes.absent, ['BUSDT']);
  assert.deepEqual(changes.statusChanged, ['AUSDT']);
  assert.equal(changes.baseline, false);
});

test('large administrator diagnostic embeds fit Discord limits while keeping every field name', async () => {
  const { fitDiagnosticEmbed } = await import('../src/scanDiagnostics.js');
  const embed = fitDiagnosticEmbed({ title: 'Scan diagnostics', description: 'd'.repeat(800), footer: { text: 'f'.repeat(400) },
    fields: Array.from({ length: 23 }, (_, n) => ({ name: `Diagnostic ${n}`, value: 'v'.repeat(1024) })) });
  const chars = embed.title.length + embed.description.length + embed.footer.text.length
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(chars <= 5900);
  assert.equal(embed.fields.length, 23);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
});

test('429 identity backoff survives another invocation and honors a longer Retry-After', async () => {
  const args = { provider, cacheKey: '429', now, clock: () => now, spacingMs: 0 };
  const failed = await refreshVenueIdentity({ ...args, fetchJson: async () => {
    const error = new Error('rate limited'); error.status = 429; error.retryAfter = '1800'; throw error;
  } });
  assert.equal(Date.parse(failed.nextRetryAt), now + 1_800_000);
  const blocked = await refreshVenueIdentity({ ...args, now: now + 120_000, fetchJson: async () => assert.fail('No request during persisted backoff') });
  assert.equal(blocked.status, 'cooldown');
  assert.equal(blocked.nextPage, 1);
});

test('pending research keeps following exact source pairs after they leave discovery, with fair bounded rotation', async () => {
  const { refreshVenueResearchOutcomes } = await import('../src/venueResearch.js');
  const observations = ['A', 'B', 'C'].map((symbol) => ({ observationId: symbol, assetId: symbol.toLowerCase(), symbol,
    researchCohort: 'full-venue-discovery-v1', createdAt: new Date(now - 60_000).toISOString(), candleProvider: 'Binance', candlePair: `${symbol}USDT` }));
  const fetched = [], stored = [];
  const fetchCandles = async (asset, options) => {
    fetched.push(asset.id);
    assert.deepEqual(options.providers, ['Binance']);
    assert.deepEqual(options.sourcePairs, { Binance: `${asset.symbol}USDT` });
    return { provider: 'Binance', pair: `${asset.symbol}USDT`, candles: [{ time: now - 900000 }] };
  };
  const appendCandles = async (...args) => stored.push(args);
  const a = await refreshVenueResearchOutcomes({ now, observations, fetchCandles, appendCandles });
  assert.deepEqual([a.attempted, a.updated, a.deferred], [2, 2, 1]);
  const b = await refreshVenueResearchOutcomes({ now: now + 1000, observations, fetchCandles, appendCandles });
  assert.deepEqual([b.attempted, b.updated], [1, 1]);
  assert.deepEqual(fetched, ['a', 'b', 'c']);
  assert.equal(stored.length, 3);
  const wrong = await refreshVenueResearchOutcomes({ now: now + 901000, observations, appendCandles,
    fetchCandles: async () => ({ provider: 'Coinbase', pair: 'A-USD', candles: [{}] }) });
  assert.equal(wrong.failed, 2);
  assert.equal(stored.length, 3, 'fallback provider history must not contaminate source-pinned outcomes');
});

test('additional public requests share pacing across metadata and identity calls and recover after failure', async () => {
  const { createResearchRequestQueue } = await import('../src/researchProviderPacing.js');
  const queue = createResearchRequestQueue();
  const order = [];
  const options = { spacingMs: 20_000, sleep: async (ms) => { order.push(`wait:${ms}`); } };
  const result = await Promise.allSettled([
    queue(async () => { order.push('directory'); return 1; }, options),
    queue(async () => { order.push('metadata'); throw new Error('fixture failure'); }, options),
    queue(async () => { order.push('coin-id'); return 3; }, options),
  ]);
  assert.deepEqual(order, ['wait:20000', 'directory', 'wait:20000', 'metadata', 'wait:20000', 'coin-id']);
  assert.deepEqual(result.map((row) => row.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('strict candidate identity cannot reuse a legacy allowlist or accept missing provider quality flags', async (t) => {
  const { fetchProviderQuotes } = await import('../src/marketProviders.js');
  let identityRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    if (value.includes('/exchanges/list')) return new Response(JSON.stringify([
      { id: 'binance', name: 'Binance' }, { id: 'gdax', name: 'Coinbase Exchange' }, { id: 'kraken', name: 'Kraken' },
    ]));
    if (value.includes('/coins/venue-identity-test/tickers')) {
      identityRequests += 1;
      assert.equal(new URL(value).searchParams.get('order'), 'volume_desc', 'coin tickers do not support base_target sorting');
      return new Response(JSON.stringify({ tickers: [{ base: 'FIX', target: 'USDT', coin_id: 'venue-identity-test', market: { identifier: 'binance' } }] }));
    }
    if (value.includes('binance.vision')) return new Response(JSON.stringify({ lastPrice: '10', bidPrice: '9.99', askPrice: '10.01', quoteVolume: '10000000', closeTime: Date.now() }));
    if (value.includes('coinbase.com')) return new Response(JSON.stringify({ price: '10', bid: '9.99', ask: '10.01', volume: '1000000', time: new Date().toISOString() }));
    throw new Error('Unexpected fixture request');
  });
  const settings = { coingeckoApiTier: 'demo', coingeckoApiKey: 'fixture-key-venue-identity' };
  const realtimeQuote = { provider: 'Kraken', pair: 'FIX/USD', base: 'FIX', target: 'USD', price: 10,
    bid: 9.99, ask: 10.01, observedAt: new Date().toISOString(), timestampBasis: 'provider_event' };
  const asset = { id: 'venue-identity-test', symbol: 'FIX' };
  const legacy = await fetchProviderQuotes(asset, { settings, realtimeQuote });
  assert.equal(legacy.quotes.length, 1);
  const strict = await fetchProviderQuotes({ ...asset, requiresVerifiedIdentity: true }, { settings, realtimeQuote });
  assert.equal(strict.quotes.length, 0);
  assert.equal(identityRequests, 2, 'required verification has a separate cache from legacy single-page lookups');
  assert.equal(strict.identity.status, 'no_verified_pairs');
  assert.equal(strict.identity.coverage.excludedUncleanRows, 1);
  assert.equal(strict.identity.coverage.terminalPageObserved, true);
});
