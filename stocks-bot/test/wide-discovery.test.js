import test from 'node:test';
import assert from 'node:assert/strict';
import { alpacaFeedCoverageNote, fetchAlpacaWideDiscoverySymbols, mergeDynamicDiscoveryCandidates, normalizeAlpacaEligibleEquities, rankAlpacaSnapshotCandidates } from '../src/stocksData.js';

const now = new Date('2026-09-24T15:00:00.000Z');
const eligibleAssets = [
  { symbol: 'AAA', exchange: 'NASDAQ', status: 'active', tradable: true, name: 'Alpha Inc', class: 'us_equity' },
  { symbol: 'BBB', exchange: 'NYSE', status: 'active', tradable: true, name: 'Beta Inc', class: 'us_equity' },
  { symbol: 'OTC', exchange: 'OTC', status: 'active', tradable: true },
  { symbol: 'HALT', exchange: 'NYSE', status: 'inactive', tradable: true },
  { symbol: 'NTRADE', exchange: 'NYSE', status: 'active', tradable: false },
  { symbol: 'CTX', exchange: 'NASDAQ', status: 'active', tradable: true }
].map((row) => ({ id: `test-${row.symbol}`, class: 'us_equity', ...row }));

test('Alpaca discovery exposes feed coverage limits without changing eligibility', () => {
  assert.match(alpacaFeedCoverageNote('iex'), /one exchange/);
  assert.match(alpacaFeedCoverageNote('sip'), /consolidates U\.S\. exchanges/);
  assert.match(alpacaFeedCoverageNote('delayed_sip'), /delayed 15 minutes/);
  assert.match(alpacaFeedCoverageNote(''), /unknown/);
});

test('wide discovery distinguishes a configured feed from one actually queried', async () => {
  const skipped = await fetchAlpacaWideDiscoverySymbols({ feed: 'sip' });
  assert.equal(skipped.feed, 'sip');
  assert.equal(skipped.feedUsed, false);
  const queried = await fetchAlpacaWideDiscoverySymbols({
    keys: { alpaca_key_id: 'wide-feed-used-test-id', alpaca_secret_key: 'wide-feed-used-test-secret' },
    cacheKey: 'wide-feed-used-test-unique', feed: 'sip', now,
    fetcher: async (url) => String(url).includes('/v2/assets?')
      ? new Response(JSON.stringify(eligibleAssets.slice(0, 2)), { status: 200 })
      : new Response('{}', { status: 200 })
  });
  assert.equal(queried.feed, 'sip');
  assert.equal(queried.feedUsed, true);
});

test('active equity universe includes tradable primary listings and excludes inactive, nontradable, context, and OTC assets', () => {
  assert.deepEqual(normalizeAlpacaEligibleEquities(eligibleAssets, ['CTX']).map((row) => row.symbol), ['AAA', 'BBB']);
  assert.deepEqual(normalizeAlpacaEligibleEquities([...eligibleAssets, { symbol: 'ETF1', exchange: 'NYSE', status: 'active', tradable: true }], ['CTX', 'ETF1']).map((row) => row.symbol), ['AAA', 'BBB']);
});

test('wide Stocks discovery excludes ETF and reviewed ETN ownership before snapshot requests and deep-analysis ranking', async () => {
  const snapshotCalls = [];
  const rows = [...eligibleAssets.slice(0, 2), { id: 'bond', class: 'us_equity', symbol: 'BND', exchange: 'NYSE', status: 'active', tradable: true },
    { id: 'note', class: 'us_equity', symbol: 'ETN1', exchange: 'NYSE', status: 'active', tradable: true }];
  const result = await fetchAlpacaWideDiscoverySymbols({
    keys: { alpaca_key_id: 'wide-etf-owner-test-id', alpaca_secret_key: 'wide-etf-owner-test-secret' },
    cacheKey: 'wide-etf-owner-test-unique', excludedSymbols: ['BND', 'ETN1'], exclusionRevision: 'test-directory-v1', feed: 'sip', now,
    fetcher: async (url) => {
      if (String(url).includes('/v2/assets?')) return new Response(JSON.stringify(rows), { status: 200 });
      snapshotCalls.push(String(url));
      return new Response('{}', { status: 200 });
    }
  });
  assert.equal(result.eligibleUniverseSize, 2);
  assert.equal(result.etfOwnershipExcludedCount, 2);
  assert.deepEqual(result.etfOwnershipExcludedSymbols, ['BND', 'ETN1']);
  assert.equal(result.snapshotSymbolsReturned, 0);
  assert.equal(snapshotCalls.length, 1);
  assert.doesNotMatch(snapshotCalls[0], /BND/);
  assert.doesNotMatch(snapshotCalls[0], /ETN1/);
});

test('broad snapshot ranking requires fresh same-session positive movement and liquidity', () => {
  const snapshot = (price, tradeAt = '2026-09-24T14:59:00Z') => ({
    latestTrade: { p: price, t: tradeAt }, dailyBar: { t: '2026-09-24T04:00:00Z', c: price, v: 1_000_000 }, prevDailyBar: { c: 10 }
  });
  const result = rankAlpacaSnapshotCandidates({ AAA: snapshot(11), BBB: snapshot(9), OLD: snapshot(15, '2026-09-24T14:00:00Z') },
    eligibleAssets.slice(0, 2), { now, maxSymbols: 5 });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.rows[0].symbol, 'AAA');
  assert.ok(Math.abs(result.rows[0].changePct - 10) < 1e-9);
});

test('wide discovery records bounded first-failure reason counts and candidate-cap omissions', () => {
  const asset = (symbol) => ({ symbol, exchange: 'NASDAQ', name: symbol });
  const good = (price = 11, volume = 1_000_000) => ({
    latestTrade: { p: price, t: '2026-09-24T14:59:00Z' },
    dailyBar: { t: '2026-09-24T04:00:00Z', c: price, v: volume },
    prevDailyBar: { c: 10, v: volume }
  });
  const assets = [asset('MISSING'), asset('NOTRADE'), asset('STALE'), asset('OLD'), asset('CHEAP'), asset('NOCLOSE'), asset('NOVOL'), asset('DOWN'), asset('LOWDOLLAR'), ...Array.from({ length: 102 }, (_, i) => asset(`GOOD${i}`))];
  const snapshots = {
    NOTRADE: { dailyBar: { t: '2026-09-24T04:00:00Z', c: 11, v: 1_000_000 }, prevDailyBar: { c: 10, v: 1_000_000 } },
    STALE: good(11),
    OLD: { ...good(), dailyBar: { ...good().dailyBar, t: '2026-09-23T04:00:00Z' } },
    CHEAP: good(1),
    NOCLOSE: { ...good(), prevDailyBar: { c: 0 } },
    NOVOL: { ...good(), dailyBar: { ...good().dailyBar, v: 0 } },
    DOWN: good(9),
    LOWDOLLAR: good(11, 10_000),
    ...Object.fromEntries(Array.from({ length: 102 }, (_, i) => [`GOOD${i}`, good(11 + i / 100)]))
  };
  snapshots.STALE.latestTrade.t = '2026-09-24T14:00:00Z';
  const result = rankAlpacaSnapshotCandidates(snapshots, assets, { now, maxSymbols: 5 });
  assert.equal(result.candidateCount, 102);
  assert.equal(result.capOmissions, 97);
  assert.equal(result.capOmissionRecords.length, 97);
  assert.equal(result.capOmissionRecords[0].reasonCode, 'deep_analysis_cap');
  assert.equal(result.capOmissionRecords[0].stage, 'deep_analysis_cap');
  assert.equal(result.capOmissionRecords[0].symbol, 'GOOD96');
  assert.deepEqual(result.rejectionCounts, {
    snapshot_missing: 1,
    latest_trade_missing: 1,
    latest_trade_stale_or_future: 1,
    daily_bar_not_current_session: 1,
    price_below_floor_or_missing: 1,
    previous_close_missing: 1,
    share_volume_missing: 1,
    non_positive_gap_or_move: 1,
    prior_or_current_dollar_volume_below_floor: 1
  });
  assert.equal(result.rejectionSamples.length, 9);
  assert.deepEqual(result.rejectionSamples[0], { symbol: 'MISSING', reasonCode: 'snapshot_missing' });
});

test('combined screener and broad-market cap records every discovery candidate omitted from deep analysis', () => {
  const row = (symbol, changePct = null) => ({ symbol, changePct, discoverySource: 'test source' });
  const result = mergeDynamicDiscoveryCandidates({
    rows: [row('SHARED', 5), row('S2', 4), row('S3', 3)],
    capOmissionRecords: [{ symbol: 'S4', reasonCode: 'deep_analysis_cap', stage: 'deep_analysis_cap', reason: 'screener cap' }]
  }, {
    rows: [row('W1', 10), row('W2', 9), row('SHARED', 5)],
    capOmissionRecords: [{ symbol: 'W3', reasonCode: 'deep_analysis_cap', stage: 'deep_analysis_cap', reason: 'wide cap' }]
  }, 2);

  assert.deepEqual(result.symbols, ['W1', 'W2']);
  assert.deepEqual(result.capOmissionRecords.map((item) => item.symbol).sort(), ['S2', 'S3', 'S4', 'SHARED', 'W3']);
  assert.ok(result.capOmissionRecords.every((item) => item.reasonCode === 'deep_analysis_cap'));
});

test('premarket broad discovery uses fresh last trade versus prior close without requiring a current-session daily bar', () => {
  const premarketNow = new Date('2026-09-24T12:59:00Z');
  const snapshots = {
    AAA: { latestTrade: { p: 12, t: '2026-09-24T12:58:00Z' }, dailyBar: { t: '2026-09-23T13:30:00Z', c: 10, v: 0 }, prevDailyBar: { c: 10, v: 1_000_000 } },
    BBB: { latestTrade: { p: 12, t: '2026-09-24T12:45:00Z' }, dailyBar: { t: '2026-09-23T13:30:00Z', c: 10, v: 0 }, prevDailyBar: { c: 10, v: 1_000_000 } },
    DOWN: { latestTrade: { p: 9, t: '2026-09-24T12:58:00Z' }, dailyBar: { t: '2026-09-23T13:30:00Z', c: 10, v: 0 }, prevDailyBar: { c: 10, v: 1_000_000 } }
  };
  const result = rankAlpacaSnapshotCandidates(snapshots, eligibleAssets.slice(0, 2), { now: premarketNow, maxSymbols: 5, session: 'pre_market' });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.rows[0].symbol, 'AAA');
  assert.equal(result.rows[0].discoverySource, 'Alpaca fresh premarket gap snapshot');
});

test('wide discovery batches active symbols, reports universe/snapshot counts, and caches results', async () => {
  const calls = [];
  const options = {
    keys: { alpaca_key_id: 'wide-test-id', alpaca_secret_key: 'wide-test-secret' },
    cacheKey: 'wide-test-cache-unique', maxSymbols: 5, cacheMinutes: 15, feed: 'iex', now,
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/v2/assets?')) return new Response(JSON.stringify(eligibleAssets.slice(0, 2)), { status: 200 });
      return new Response(JSON.stringify({
        AAA: { latestTrade: { p: 11, t: '2026-09-24T14:59:00Z' }, dailyBar: { t: '2026-09-24T04:00:00Z', c: 11, v: 1_000_000 }, prevDailyBar: { c: 10 } },
        BBB: { latestTrade: { p: 9, t: '2026-09-24T14:59:00Z' }, dailyBar: { t: '2026-09-24T04:00:00Z', c: 9, v: 1_000_000 }, prevDailyBar: { c: 10 } }
      }), { status: 200 });
    }
  };
  const first = await fetchAlpacaWideDiscoverySymbols(options);
  const second = await fetchAlpacaWideDiscoverySymbols(options);
  assert.deepEqual(first.symbols, ['AAA']);
  assert.equal(first.eligibleUniverseSize, 2);
  assert.equal(first.snapshotSymbolsReturned, 2);
  assert.equal(first.feed, 'iex');
  assert.equal(first.feedUsed, true);
  assert.equal(first.cached, false);
  assert.equal(second.feed, 'iex');
  assert.equal(second.feedUsed, true);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /v2\/stocks\/snapshots\?symbols=AAA%2CBBB&feed=iex/);
});

test('concurrent wide-discovery requests share one cold scan and cache keys isolate feed and watchlist settings', async () => {
  const calls = [];
  const options = {
    keys: { alpaca_key_id: 'wide-coalesce-test-id', alpaca_secret_key: 'wide-coalesce-test-secret' },
    cacheKey: 'wide-coalesce-test-unique', maxSymbols: 5, cacheMinutes: 15, feed: 'iex', now,
    fetcher: async (url) => {
      calls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 8));
      if (String(url).includes('/v2/assets?')) return new Response(JSON.stringify(eligibleAssets.slice(0, 2)), { status: 200 });
      return new Response(JSON.stringify({
        ...(new URL(url).searchParams.get('symbols').includes('AAA') ? { AAA: { latestTrade: { p: 11, t: '2026-09-24T14:59:00Z' }, dailyBar: { t: '2026-09-24T04:00:00Z', c: 11, v: 1_000_000 }, prevDailyBar: { c: 10 } } } : {}),
        BBB: { latestTrade: { p: 12, t: '2026-09-24T14:59:00Z' }, dailyBar: { t: '2026-09-24T04:00:00Z', c: 12, v: 1_000_000 }, prevDailyBar: { c: 10 } }
      }), { status: 200 });
    }
  };
  const [first, joined] = await Promise.all([
    fetchAlpacaWideDiscoverySymbols(options),
    fetchAlpacaWideDiscoverySymbols(options),
  ]);
  assert.deepEqual(first.symbols, ['BBB', 'AAA']);
  assert.deepEqual(joined.symbols, first.symbols);
  assert.equal(first.cached, false);
  assert.equal(joined.cached, true);
  assert.equal(calls.length, 2, 'one asset-master and one snapshots request serve both scans');

  const changedConfiguration = await fetchAlpacaWideDiscoverySymbols({ ...options, feed: 'sip', existingSymbols: ['AAA'] });
  assert.deepEqual(changedConfiguration.symbols, ['BBB']);
  assert.equal(changedConfiguration.cached, false, 'a changed feed/watchlist must trigger a fresh candidate snapshot');
  assert.equal(calls.length, 3, 'the six-hour asset master may be reused while the feed-specific snapshot is refreshed');
  assert.match(calls[2], /symbols=BBB&feed=sip/);
});

test('premarket wide discovery uses a separate cache cohort and does not call session screeners', async () => {
  const calls = [];
  const result = await fetchAlpacaWideDiscoverySymbols({
    keys: { alpaca_key_id: 'wide-premarket-test-id', alpaca_secret_key: 'wide-premarket-test-secret' },
    cacheKey: 'wide-premarket-test-unique', maxSymbols: 5, cacheMinutes: 5, feed: 'iex', now: new Date('2026-09-24T12:59:00Z'), session: 'pre_market',
    fetcher: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/v2/assets?')) return new Response(JSON.stringify(eligibleAssets.slice(0, 2)), { status: 200 });
      return new Response(JSON.stringify({
        AAA: { latestTrade: { p: 11, t: '2026-09-24T12:58:00Z' }, dailyBar: { t: '2026-09-23T13:30:00Z', v: 0 }, prevDailyBar: { c: 10, v: 1_000_000 } },
        BBB: { latestTrade: { p: 9, t: '2026-09-24T12:58:00Z' }, dailyBar: { t: '2026-09-23T13:30:00Z', v: 0 }, prevDailyBar: { c: 10, v: 1_000_000 } }
      }), { status: 200 });
    }
  });
  assert.deepEqual(result.symbols, ['AAA']);
  assert.equal(result.feed, 'iex');
  assert.equal(result.feedUsed, true);
  assert.equal(result.rows[0].discoverySource, 'Alpaca fresh premarket gap snapshot');
  assert.equal(calls.filter((url) => url.includes('/screener/')).length, 0);
});

test('broad snapshots are chunked before request URLs grow beyond the bounded batch size', async () => {
  const assets = Array.from({ length: 401 }, (_, index) => ({ id: `test-${index}`, class: 'us_equity', symbol: `T${String(index).padStart(4, '0')}`, exchange: 'NASDAQ', status: 'active', tradable: true }));
  const snapshotCalls = [];
  const result = await fetchAlpacaWideDiscoverySymbols({
    keys: { alpaca_key_id: 'wide-batch-test-id', alpaca_secret_key: 'wide-batch-test-secret' },
    cacheKey: 'wide-batch-test-unique', maxSymbols: 5, now,
    fetcher: async (url) => {
      if (String(url).includes('/v2/assets?')) return new Response(JSON.stringify(assets), { status: 200 });
      snapshotCalls.push(String(url));
      return new Response('{}', { status: 200 });
    }
  });
  assert.equal(result.eligibleUniverseSize, 401);
  assert.equal(snapshotCalls.length, 2);
  assert.match(snapshotCalls[0], /feed=iex/);
});
