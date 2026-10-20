import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { screenEtfSnapshot, screenFullEtfMarket, archiveEtfDiscovery } from '../src/fullMarketDiscovery.js';
import { fetchAlpacaEtfSession, fetchEtfSessionBars } from '../src/alpacaMarketData.js';
import { formatEtfDiscoverySummary } from '../src/alertFormat.js';
import { summarizeEtfScan } from '../src/diagnostics.js';

const now = Date.parse('2026-09-29T15:00:00Z'), openTime = Date.parse('2026-09-29T13:30:00Z'), closeTime = Date.parse('2026-09-29T20:00:00Z');
const snapshot = (move = 1, quoteAt = now) => ({ latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], bp: 100 + move, ap: 100.02 + move, t: new Date(quoteAt).toISOString() },
  dailyBar: { o: 100, c: 100 + move, h: 101 + Math.max(0, move), l: 99 + Math.min(0, move), v: 50_000, t: '2026-09-29T04:00:00Z' },
  prevDailyBar: { c: 100, t: '2026-09-28T04:00:00Z' } });
const response = (payload) => ({ ok: true, status: 200, headers: new Headers(), json: async () => payload });
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-etf-full-'));
  try { return await run(directory); }
  finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('omnimod-etf-full-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
}

test('full ETF screening sees every symbol before applying the deep-analysis budget', async () => {
  const assets = Array.from({ length: 1001 }, (_, index) => ({ symbol: `ETF${index}` }));
  const requests = [], waits = [];
  let elapsed = 0;
  const result = await screenFullEtfMarket({ assets, now, openTime, closeTime, maxCandidates: 2, priorities: ['ETF0'],
    clock: () => elapsed, sleep: async (ms) => { waits.push(ms); elapsed += ms; },
    requestSnapshots: async (symbols) => { requests.push(symbols); return Object.fromEntries(symbols.map((symbol) => [symbol, snapshot(symbol === 'ETF1000' ? 10 : 1)])); } });
  assert.equal(new Set(requests.flat()).size, 1001);
  assert.equal(requests.length, 11);
  assert.equal(Math.max(...requests.map((batch) => batch.length)), 100);
  assert.deepEqual(result.shortlist, ['ETF1000', 'ETF0']);
  assert.equal(result.diagnostics.cheaplyScreened, 1001);
  assert.equal(result.diagnostics.analysisDeferred, 999);
  assert.equal(result.rows.length, 1001);
  assert.ok(waits.every((ms) => ms === 350));
  assert.equal(result.diagnostics.elapsedMs, 3500);
});

test('cheap ETF screen rejects stale, invalid, future and prior-session data but permits a new listing without prior close', () => {
  for (const [input, reason] of [
    [null, 'snapshot_missing'],
    [{ ...snapshot(), latestQuote: { bs: 100000, as: 100000, bx: 'P', ax: 'P', z: 'B', c: ['R'], ...snapshot().latestQuote, bp: true } }, 'invalid_bid_ask'],
    [snapshot(1, now - 16_000), 'stale_or_future_quote'],
    [snapshot(1, now + 1), 'stale_or_future_quote'],
    [{ ...snapshot(), dailyBar: { ...snapshot().dailyBar, t: '2026-09-28T04:00:00Z' } }, 'daily_bar_not_current_session'],
    [{ ...snapshot(), dailyBar: { ...snapshot().dailyBar, v: 0 } }, 'invalid_or_inactive_daily_bar'],
  ]) assert.deepEqual(screenEtfSnapshot('TEST', input, { now, openTime }).reasons, [reason]);
  const initialListing = screenEtfSnapshot('NEW', { ...snapshot(), prevDailyBar: null }, { now, openTime });
  assert.equal(initialListing.status, 'screened');
  assert.equal(initialListing.changePct, null);
  assert.ok(Number.isFinite(initialListing.rankingScore));
});

test('authentication/rate-limit failures defer unrequested symbols instead of claiming full coverage', async () => {
  for (const status of [401, 403, 429]) {
    const result = await screenFullEtfMarket({ assets: [{ symbol: 'A' }, { symbol: 'B' }], now, openTime, closeTime,
      batchSize: 1, minimumIntervalMs: 0, requestSnapshots: async () => { throw Object.assign(new Error('private provider response'), { cause: { status } }); } });
    assert.equal(result.diagnostics.requests, 1);
    assert.equal(result.diagnostics.unrequestedSymbols, 1);
    assert.equal(result.diagnostics.status, 'provider_auth_or_quota_deferred');
    assert.deepEqual(result.rows[1].reasons, ['provider_auth_or_quota_deferred']);
    assert.equal(JSON.stringify(result).includes('private provider response'), false);
  }
});

test('missing snapshots, unexpected symbols and isolated failed batches have explicit coverage', async () => {
  let calls = 0;
  const result = await screenFullEtfMarket({ assets: ['A', 'B', 'C', 'D'].map((symbol) => ({ symbol })), now, openTime, closeTime,
    batchSize: 2, minimumIntervalMs: 0, requestSnapshots: async () => {
      if (++calls === 2) throw Object.assign(new Error('upstream'), { status: 503 });
      return { A: snapshot(), EXTRA: snapshot() };
    } });
  assert.equal(result.diagnostics.attemptedSymbols, 4);
  assert.equal(result.diagnostics.returnedSymbols, 1);
  assert.equal(result.diagnostics.missingSnapshots, 1);
  assert.equal(result.diagnostics.rejectionReasons.snapshot_provider_error, 2);
  assert.deepEqual(result.diagnostics.unexpectedSymbols, ['EXTRA']);
  assert.deepEqual(result.shortlist, ['A']);
  assert.equal(result.diagnostics.status, 'partial_provider_failure');
});

test('a quota failure after useful observations prevents additional deep-provider work', async () => {
  let calls = 0;
  const result = await screenFullEtfMarket({ assets: ['A', 'B'].map((symbol) => ({ symbol })), now, openTime, closeTime,
    batchSize: 1, minimumIntervalMs: 0, requestSnapshots: async () => {
      if (++calls === 2) throw Object.assign(new Error('quota'), { status: 429 });
      return { A: snapshot() };
    } });
  assert.equal(result.diagnostics.cheaplyScreened, 1);
  assert.deepEqual(result.shortlist, []);
  assert.deepEqual(result.rows[0].reasons, ['provider_auth_or_quota_deferred']);
});

test('closing-session deferrals and invalid screen limits cannot silently drop members', async () => {
  const result = await screenFullEtfMarket({ assets: [{ symbol: 'A' }], now: closeTime, openTime, closeTime,
    requestSnapshots: async () => { throw new Error('No closed-session request is expected'); } });
  assert.equal(result.diagnostics.requests, 0);
  assert.equal(result.diagnostics.unrequestedSymbols, 1);
  assert.deepEqual(result.rows[0].reasons, ['session_closed_before_screen']);
  await assert.rejects(screenFullEtfMarket({ assets: [], now, openTime, closeTime, maxCandidates: 201 }), /budget/);
  await assert.rejects(screenFullEtfMarket({ assets: [{ symbol: 'A' }, { symbol: 'A' }], now, openTime, closeTime }), /unique/);
});

test('full screen archive preserves every reason, deduplicates identical captures and only expires its own files', () => temporary(async (directory) => {
  const oldName = `2026-08-01-${'a'.repeat(24)}.json.gz`;
  await writeFile(join(directory, oldName), 'old');
  await writeFile(join(directory, 'keep.json'), 'unrelated');
  const value = { rows: [{ symbol: 'A', reasons: ['stale_or_future_quote'] }] };
  const stored = await archiveEtfDiscovery(value, { directory, now });
  const repeated = await archiveEtfDiscovery(value, { directory, now });
  assert.equal(repeated.status, 'existing');
  const decoded = JSON.parse(gunzipSync(await readFile(join(directory, stored.file))));
  assert.deepEqual(decoded.rows, value.rows);
  assert.deepEqual((await readdir(directory)).sort(), [stored.file, 'keep.json'].sort());
}));

async function sessionFixture(directory, { reviews = false, assetsOverride, laterQuote = null, historyFailure = false, listingExchange = 'ARCA', nativeOverride = {}, feed = 'sip' } = {}) {
  const symbols = ['SPY', 'NEWONE', 'NEWTWO', 'INACTIVE'];
  const directoryEntries = symbols.map((symbol) => ({ symbol, source: 'other', instrumentType: 'etf', exchange: listingExchange, name: `${symbol} Fund` }));
  const cache = join(directory, 'directory.json'), classifications = join(directory, 'classification.json');
  await writeFile(cache, JSON.stringify({ fetchedAt: new Date(now).toISOString(), entries: directoryEntries }));
  await writeFile(classifications, '[]');
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url)); const parsed = new URL(url), path = parsed.pathname;
    if (path.endsWith('/clock')) return response({ timestamp: new Date(now).toISOString(), is_open: true });
    if (path.endsWith('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (path.endsWith('/assets')) return response(assetsOverride || symbols.map((symbol) => ({ symbol, id: `id-${symbol}`, class: 'us_equity',
      status: symbol === 'INACTIVE' ? 'inactive' : 'active', tradable: true, exchange: listingExchange, name: `${symbol} Fund` })));
    if (path.endsWith('/snapshots')) {
      const quoteAt = laterQuote && parsed.searchParams.get('symbols') === 'NEWONE' ? laterQuote() : now;
      return response(Object.fromEntries(parsed.searchParams.get('symbols').split(',').map((symbol) => {
        const row = snapshot(symbol === 'NEWONE' ? 10 : 1, quoteAt);
        if (parsed.searchParams.get('symbols') === 'NEWONE') Object.assign(row.latestQuote, nativeOverride);
        return [symbol, row];
      })));
    }
    if (path.endsWith('/news')) return response({ news: [] });
    if (path.endsWith('/bars')) return historyFailure ? { ok: false, status: 403, headers: new Headers() }
      : response({ bars: { NEWONE: [{ t: '2026-09-29T14:50:00Z', o: 100, h: 111, l: 99, c: 110, v: 5000 }] } });
    throw new Error('Unexpected provider operation: ' + path);
  };
  const result = await fetchAlpacaEtfSession({ env: { ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret',
    ETF_SYMBOLS: 'SPY', ETF_ALPACA_FEED: feed, ETF_UNIVERSE_CACHE_PATH: cache, ETF_ETP_CLASSIFICATION_PATH: classifications,
    ETF_DISCOVERY_MAX_CANDIDATES: '1', ETF_DISCOVERY_HISTORY_PATH: join(directory, 'history') }, now: new Date(now), fetcher,
    catalystReviews: reviews ? { NEWONE: { status: 'clear', source: 'manual source review', summary: 'No event in fixture', reviewedAt: new Date(now).toISOString() } } : {} });
  const archived = JSON.parse(gunzipSync(await readFile(join(directory, 'history', result.diagnostics.discovery.journal.file))));
  return { result, calls, archived };
}

test('default adapter screens unconfigured ETF symbols before catalyst gates; configured watchlist is only priority', () => temporary(async (directory) => {
  const { result, calls, archived } = await sessionFixture(directory);
  const d = result.diagnostics.discovery;
  assert.equal(d.mode, 'full-market-directory');
  assert.equal(d.universeSize, 4);
  assert.equal(d.activeTradableCandidates, 3);
  assert.equal(d.cheapScreen.attemptedSymbols, 3);
  assert.equal(d.cheapScreen.cheaplyScreened, 3);
  assert.equal(d.selectedCandidates, 1);
  assert.equal(result.diagnostics.rejectedCatalysts.catalyst_review_missing_stale_or_unclear, 1);
  assert.equal(result.trades.length, 0);
  assert.equal(calls.filter((url) => /\/news|\/bars|most-actives|\/movers/.test(url)).length, 0);
  assert.equal(archived.rows.length, 4);
  assert.equal(archived.rows.find((row) => row.symbol === 'NEWONE').status, 'shortlisted');
  assert.deepEqual(archived.rows.find((row) => row.symbol === 'INACTIVE').reasons, ['asset_not_active']);
  assert.deepEqual(archived.rows.find((row) => row.symbol === 'SPY').reasons, ['deep_analysis_budget']);
  const diagnostics = summarizeEtfScan({ sessionInput: result });
  assert.equal(diagnostics.topRejectionReasons.deep_analysis_budget, 2);
  assert.match(formatEtfDiscoverySummary(d), /4 listed ETFs\/ETPs.*3 eligible\n3 snapshot requests/);
}));

test('only the dynamic shortlist receives deep history and refreshed quotes, with its discovery cohort retained', () => temporary(async (directory) => {
  const { result, calls } = await sessionFixture(directory, { reviews: true });
  assert.deepEqual(result.trades.map((row) => row.symbol), ['NEWONE']);
  assert.equal(result.trades[0].session.discoveryVersion, 'etf-full-directory-v2-audited-listings');
  assert.equal(result.trades[0].quote.quality, 'executable');
  const snapshots = calls.filter((url) => url.includes('/snapshots')).map((url) => new URL(url).searchParams.get('symbols'));
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0].split(',').sort(), ['NEWONE', 'NEWTWO', 'SPY']);
  assert.equal(snapshots[1], 'NEWONE');
  assert.deepEqual(calls.filter((url) => url.includes('/bars')).map((url) => new URL(url).searchParams.get('symbols')), ['NEWONE']);
}));

test('account-confirmed TXSE ETFs enter discovery without bypassing inactive listing or catalyst checks', () => temporary(async (directory) => {
  const { result, archived, calls } = await sessionFixture(directory, { listingExchange: 'TXSE' });
  assert.equal(result.diagnostics.discovery.activeTradableCandidates, 3);
  assert.equal(result.diagnostics.discovery.cheapScreen.cheaplyScreened, 3);
  assert.equal(result.diagnostics.rejectedCatalysts.catalyst_review_missing_stale_or_unclear, 1);
  assert.deepEqual(archived.rows.find(row => row.symbol === 'INACTIVE').reasons, ['asset_not_active']);
  assert.equal(result.trades.length, 0); assert.ok(!calls.some(url => url.includes('/bars')));
}));

test('ambiguous account identities are excluded before cheap quotes', () => temporary(async (directory) => {
  const { result, archived, calls } = await sessionFixture(directory, { assetsOverride: [
    { symbol: 'SPY', id: 'first', class: 'us_equity', status: 'active', tradable: true, exchange: 'ARCA' },
    { symbol: 'SPY', id: 'second', class: 'us_equity', status: 'active', tradable: true, exchange: 'ARCA' },
  ] });
  assert.equal(result.diagnostics.discovery.cheapScreen.attemptedSymbols, 0);
  assert.deepEqual(archived.rows.find((row) => row.symbol === 'SPY').reasons, ['ambiguous_active_asset_identity']);
  assert.ok(!calls.some((url) => url.includes('/snapshots')));
}));

test('a detailed-history entitlement failure preserves the already-measured full discovery funnel', () => temporary(async (directory) => {
  const { result } = await sessionFixture(directory, { reviews: true, historyFailure: true });
  assert.equal(result.trades.length, 0);
  assert.equal(result.diagnostics.reason, 'detailed_market_data_incomplete');
  assert.equal(result.diagnostics.discovery.cheapScreen.cheaplyScreened, 3);
  assert.equal(result.diagnostics.discovery.selectedCandidates, 1);
  assert.equal(result.diagnostics.scanned, 1);
  assert.equal(result.diagnostics.rowsWithUsableData, 0);
  assert.equal(result.providerMetrics.filter((row) => row.status === 403).length, 1);
}));

test('fresh quotes observed after a lengthy discovery stage are not compared to the old scan-start timestamp', (t) => temporary(async (directory) => {
  let wallTime = now;
  t.mock.method(Date, 'now', () => wallTime);
  const { result } = await sessionFixture(directory, { reviews: true, laterQuote: () => { wallTime += 5_000; return wallTime; } });
  assert.equal(result.trades.length, 1);
  assert.equal(Date.parse(result.trades[0].quote.time), now + 5_000);
}));

test('refreshed ETF membership records additions and removals instead of preserving obsolete seeds', () => temporary(async (directory) => {
  const cache = join(directory, 'cache.json'), classification = join(directory, 'classifications.json');
  await writeFile(cache, JSON.stringify({ fetchedAt: '2026-09-28T15:00:00Z', entries: [{ symbol: 'OLD', source: 'nasdaq', instrumentType: 'etf' }] }));
  await writeFile(classification, '[]');
  const fetcher = async (url) => {
    if (url.includes('nasdaqlisted.txt')) return { ok: true, status: 200, text: async () => 'Symbol|Security Name|ETF|Test Issue\nNEW|New Fund|Y|N\nFile Creation Time: 0929202610:00|||' };
    if (url.includes('otherlisted.txt')) return { ok: true, status: 200, text: async () => 'ACT Symbol|Security Name|Exchange|ETF|Test Issue\nSPY|SPDR Fund|P|Y|N\nFile Creation Time: 0929202610:00||||' };
    if (url.includes('/clock')) return response({ timestamp: new Date(now).toISOString(), is_open: true });
    if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
    if (url.includes('/assets')) return response([]);
    throw new Error('No historical/snapshot request expected');
  };
  const result = await fetchAlpacaEtfSession({ env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture',
    ETF_UNIVERSE_CACHE_PATH: cache, ETF_ETP_CLASSIFICATION_PATH: classification, ETF_DISCOVERY_HISTORY_PATH: join(directory, 'history') }, now: new Date(now), fetcher });
  const changes = result.diagnostics.discovery.membershipChanges;
  assert.deepEqual(changes.addedSample, ['NEW', 'SPY']);
  assert.deepEqual(changes.removedSample, ['OLD']);
  assert.equal(changes.addedCount, 2);
  assert.equal(changes.removedCount, 1);
  assert.equal(changes.comparedTo, '2026-09-28T15:00:00Z');
  assert.equal(result.diagnostics.discovery.universeSize, 2);
}));

test('intraday history consumes complete provider pages and rejects repeated tokens', async () => {
  const url = 'https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=5Min';
  const calls = [];
  const fetcher = async (endpoint) => { calls.push(String(endpoint)); return response(new URL(endpoint).searchParams.has('page_token')
    ? { bars: { SPY: [{ t: 'second' }] }, next_page_token: null }
    : { bars: { SPY: [{ t: 'first' }] }, next_page_token: 'page-two' }); };
  assert.deepEqual((await fetchEtfSessionBars(url, {}, fetcher, [])).bars.SPY, [{ t: 'first' }, { t: 'second' }]);
  assert.equal(calls.length, 2);
  await assert.rejects(fetchEtfSessionBars(url, {}, async () => response({ bars: { SPY: [] }, next_page_token: 'same' }), []), /pagination incomplete/);
});

test('closed-session and early provider failures do not substitute a seed-list size for an unmeasured full universe', async () => {
  const result = await fetchAlpacaEtfSession({ env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture', ETF_SYMBOLS: 'SPY' },
    now: new Date(now), fetcher: async (url) => response(url.includes('/clock') ? { timestamp: new Date(now).toISOString(), is_open: false } : []) });
  assert.equal(result.diagnostics.universeSize, null);
  assert.equal(summarizeEtfScan({ sessionInput: result }).universe.configured, null);
  assert.equal(summarizeEtfScan({ sessionInput: { diagnostics: { universeSize: null, providerError: 'clock failed' } } }).universe.configured, null);
});


test('detailed SIP inputs preserve source sizes and expose per-symbol native evidence rejections', () => temporary(async directory => {
  const valid = await sessionFixture(directory, { reviews: true, nativeOverride: { bs: 123, as: 456 } });
  assert.equal(valid.result.trades[0].quote.stockQuoteEvidence.askSizeShares, 456);
  assert.equal(valid.result.trades[0].quote.stockQuoteEvidence.source, 'snapshot');
  assert.equal(valid.result.diagnostics.quoteEvidence.nativeVerified, 1);
  assert.equal(valid.result.diagnostics.quoteEvidence.executable, 1);
  for (const [nativeOverride, reason] of [[{ bs: null }, 'stock_quote_evidence_required'],
    [{ c: ['N'] }, 'stock_quote_condition_not_regular'], [{ S: 'SPY' }, 'stock_quote_symbol_mismatch']]) {
    const { result } = await sessionFixture(directory, { reviews: true, nativeOverride });
    assert.equal(result.trades.length, 0);
    assert.deepEqual(result.diagnostics.rejectedRows, [{ symbol: 'NEWONE', reason }]);
    const summary = summarizeEtfScan({ sessionInput: result });
    assert.deepEqual(summary.quoteEvidence.evidenceRejections, [{ symbol: 'NEWONE', reason }]);
    assert.equal(summary.topRejectionReasons[reason], 1);
    assert.deepEqual(summary.rejectedDataRows, result.diagnostics.rejectedRows);
  }
}));

test('IEX discovery and reference rows remain available without claiming executable SIP evidence', () => temporary(async directory => {
  const { result } = await sessionFixture(directory, { reviews: true, feed: 'iex', nativeOverride: { bs: undefined } });
  assert.equal(result.diagnostics.discovery.cheapScreen.cheaplyScreened, 3);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].quote.quality, 'reference');
  assert.equal(result.trades[0].quote.stockQuoteEvidence, undefined);
  assert.equal(result.diagnostics.quoteEvidence.executable, 0);
  assert.equal(result.diagnostics.quoteEvidence.referenceOnly, 1);
  assert.equal(result.diagnostics.quoteEvidence.evidenceRejections.length, 1);
}));
