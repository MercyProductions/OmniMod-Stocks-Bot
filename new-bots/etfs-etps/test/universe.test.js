import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAlpacaEtfSession } from '../src/alpacaMarketData.js';
import { CURATED_ETF_SEEDS, hasUnreviewedEtnMarker, hasUnreviewedLeverageMarker, mergeEtfDirectories, parseSupplementalEtpRegistry, parseSupplementalEtpRegistryDetailed, parseScreenerSymbols, refreshSupplementalEtpReviews, selectEtfDiscoveryCandidates } from '../src/universe.js';

const nasdaq = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'QQQ|Invesco QQQ Trust|Q|N|N|100|Y|N',
  'BAD|Test ETF|Q|Y|N|100|Y|N',
  'WARR|Issuer Warrant|Q|N|N|100|N|N',
  'File Creation Time: 0929202615:45|||||||',
].join('\n');
const other = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'TEST|Example Growth ETF|A|TEST|Y|100|N|TEST',
  'COMMON|Example Inc Common Stock|N|COMMON|N|100|N|COMMON',
  'FILE|Creation Marker|N||N|100|N|FILE',
  'File Creation Time: 0929202615:45|||||||',
].join('\n');

function response(payload, status = 200) {
  return { ok: status === 200, status, headers: new Headers(), json: async () => payload, text: async () => payload };
}

test('merges current exchange directories and excludes test issues and non-ETF rows', () => {
  const result = mergeEtfDirectories(nasdaq, other);
  assert.deepEqual(result.entries.map((row) => row.symbol), ['QQQ', 'SPY', 'TEST']);
  assert.equal(result.entries.find((row) => row.symbol === 'TEST').exchange, 'AMEX');
  assert.equal(result.sources.nasdaqCreatedAt, null, 'footer has no verified UTC offset');
  assert.equal(result.sources.nasdaqCreationTime.local, '2026-09-29T15:45:00');
  assert.throws(() => mergeEtfDirectories('unexpected schema', other), /schema/);
});

test('supplemental ETN and wrapper classes require a fresh HTTPS citation and explicit exposure metadata', () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const rows = parseSupplementalEtpRegistry([
    { symbol: 'ETN1', productType: 'etn', sourceUrl: 'https://issuer.example/products/etn1', reviewedAt: '2026-09-01T00:00:00Z', exposureKey: 'GOLD', leverage: 1 },
    { symbol: 'GUESS', productType: 'etn', sourceUrl: 'http://issuer.example/x', reviewedAt: '2026-09-01T00:00:00Z', exposureKey: 'GOLD' },
    { symbol: 'STALE', productType: 'etv', sourceUrl: 'https://issuer.example/x', reviewedAt: '2025-01-01T00:00:00Z', exposureKey: 'GOLD' },
    { symbol: 'NOEXPO', productType: 'inverse_etf', sourceUrl: 'https://issuer.example/x', reviewedAt: '2026-09-01T00:00:00Z' },
    { symbol: 'MISLABEL', productType: 'inverse_etf', sourceUrl: 'https://issuer.example/x', reviewedAt: '2026-09-01T00:00:00Z', exposureKey: 'GOLD', leverage: 2, inverse: false },
  ], { now });
  assert.deepEqual(rows.map((row) => row.symbol), ['ETN1']);
  assert.equal(rows[0].instrumentType, 'etp');
  assert.equal(rows[0].exposureKey, 'GOLD');
  assert.deepEqual(parseSupplementalEtpRegistryDetailed([
    { symbol: 'GUESS', productType: 'etn', sourceUrl: 'http://issuer.example/x', reviewedAt: '2026-09-01T00:00:00Z', exposureKey: 'GOLD' },
  ], { now }).blockedSymbols, ['GUESS']);
  assert.deepEqual(parseSupplementalEtpRegistryDetailed([
    { symbol: 'MISLABEL', productType: 'inverse_etf', sourceUrl: 'https://issuer.example/x', reviewedAt: '2026-09-01T00:00:00Z', exposureKey: 'GOLD', leverage: 2, inverse: false },
  ], { now }).blockedSymbols, ['MISLABEL']);
  assert.throws(() => parseSupplementalEtpRegistry({}, { now }), /JSON array/);
  assert.throws(() => parseSupplementalEtpRegistry([], { now, maxReviewAgeDays: 'invalid' }), /finite and positive/);
});

test('default reviewed wrapper registry covers curated leverage and commodity-futures products with current cited terms', async () => {
  const rows = JSON.parse(await readFile(new URL('../examples/etp-classifications.json', import.meta.url), 'utf8'));
  const parsed = parseSupplementalEtpRegistryDetailed(rows, { now: new Date('2026-09-29T15:00:00Z') });
  assert.deepEqual(parsed.blockedSymbols, []);
  const leverageBySymbol = Object.fromEntries(parsed.entries.map((row) => [row.symbol, row.leverage]));
  assert.deepEqual(leverageBySymbol, {
    TQQQ: 3, SQQQ: -3, UPRO: 3, SPXU: -3, SOXL: 3, SOXS: -3,
    LABU: 3, LABD: -3, NVDL: 2, NVD: -2, YINN: 3, YANG: -3,
    TMF: 3, TMV: -3, UVXY: 1.5, SVIX: -1, AGQ: 2, ZSL: -2,
    UCO: 2, SCO: -2, BOIL: 2, KOLD: -2, BITX: 2, DJP: 1,
    USO: 1, USL: 1, BNO: 1, UNG: 1, UNL: 1, UGA: 1, USCI: 1, CPER: 1,
    DBA: 1, DBC: 1, PDBC: 1, PDBA: 1,
  });
  const djp = parsed.entries.find((row) => row.symbol === 'DJP');
  assert.equal(djp.productType, 'etn');
  assert.equal(djp.exposureKey, 'COMMODITY_BASKET');
  for (const [symbol, exposureKey] of Object.entries({ USO: 'OIL', USL: 'OIL', BNO: 'OIL', UNG: 'NATGAS', UNL: 'NATGAS', UGA: 'GASOLINE', USCI: 'COMMODITY_BASKET', CPER: 'COPPER', DBA: 'AGRICULTURE', DBC: 'COMMODITY_BASKET', PDBC: 'COMMODITY_BASKET', PDBA: 'AGRICULTURE' })) {
    const row = parsed.entries.find((entry) => entry.symbol === symbol);
    assert.equal(row?.productType, 'commodity_pool', `${symbol} is identified as a commodity-futures pool`);
    assert.equal(row?.exposureKey, exposureKey);
  }
  assert.ok(CURATED_ETF_SEEDS.includes('DJP'));
  assert.ok(parsed.entries.every((row) => row.classificationSourceUrl?.startsWith('https://')));
  const seeded = selectEtfDiscoveryCandidates({ registry: parsed.entries, screenerSymbols: [] }).candidates;
  for (const symbol of ['UCO', 'SCO', 'BOIL', 'KOLD', 'AGQ', 'ZSL', 'BITX', 'DJP', 'USO', 'USL', 'BNO', 'UNG', 'UNL', 'UGA', 'USCI', 'CPER', 'DBA', 'DBC', 'PDBC', 'PDBA']) {
    assert.ok(CURATED_ETF_SEEDS.includes(symbol), `${symbol} is a curated discovery seed`);
    assert.ok(seeded.includes(symbol), `${symbol} survives curated discovery when listed`);
  }
});

test('name-based leveraged product detection is a reject-only safeguard, not a 1x classifier', () => {
  assert.equal(hasUnreviewedLeverageMarker('Example Daily S&P 2x ETF'), true);
  assert.equal(hasUnreviewedLeverageMarker('ProShares UltraShort Bloomberg Natural Gas'), true);
  assert.equal(hasUnreviewedLeverageMarker('Direxion Daily Semiconductor Bull 3X'), true);
  assert.equal(hasUnreviewedLeverageMarker('Direxion Daily AAPL Bear 1X ETF'), true);
  assert.equal(hasUnreviewedLeverageMarker('Leverage Shares 1X Short SPCX Daily ETF'), true);
  assert.equal(hasUnreviewedLeverageMarker('ProShares Ultra COIN'), true);
  assert.equal(hasUnreviewedLeverageMarker('ProShares Short Bitcoin ETF'), true);
  assert.equal(hasUnreviewedLeverageMarker('iShares 0-3 Month Treasury Bond ETF'), false);
  assert.equal(hasUnreviewedLeverageMarker('Vanguard S&P 500 ETF'), false);
  assert.equal(hasUnreviewedLeverageMarker('Vanguard Ultra-Short Bond ETF'), false);
  assert.equal(hasUnreviewedEtnMarker('MicroSectors -3? Short Artificial Intelligence (AI) ETNs'), true);
  assert.equal(hasUnreviewedEtnMarker('Alerian MLP Index ETN'), true);
  assert.equal(hasUnreviewedEtnMarker('iShares 0-3 Month Treasury Bond ETF'), false);
});

test('cached supplemental ETP reviews are revalidated at the current scan time', () => {
  const rows = [
    { symbol: 'SPY', instrumentType: 'etf', source: 'nasdaq' },
    { symbol: 'ETN1', instrumentType: 'etf', source: 'nasdaq' },
    { symbol: 'ETN1', instrumentType: 'etp', productType: 'etn', exposureKey: 'GOLD', leverage: 1,
      classificationSourceUrl: 'https://issuer.example/etn1', classificationReviewedAt: '2026-01-01T00:00:00Z', source: 'supplemental-reviewed' },
  ];
  const result = refreshSupplementalEtpReviews(rows, { now: new Date('2026-09-29T15:00:00Z'), maxReviewAgeDays: 180 });
  assert.deepEqual(result.entries.map((row) => row.symbol), ['SPY']);
  assert.equal(result.supplementalCount, 0);
  assert.deepEqual(result.blockedSymbols, ['ETN1']);
});

test('maps screener activity to verified ETFs and keeps the candidate pool bounded', () => {
  assert.deepEqual(parseScreenerSymbols({ most_actives: [{ symbol: 'TEST' }, { symbol: 'SPY' }, { symbol: 'not valid!' }] }), ['TEST', 'SPY']);
  const picked = selectEtfDiscoveryCandidates({ registry: [{ symbol: 'SPY' }, { symbol: 'QQQ' }, { symbol: 'TEST' }],
    screenerSymbols: ['TEST', 'COMMON', 'QQQ'], curatedSymbols: ['SPY'], maxCandidates: 2 });
  assert.deepEqual(picked.candidates, ['SPY', 'TEST']);
  assert.equal(picked.screenerEtfs, 2);
});

test('dynamic discovery joins ETF security master to bounded live screeners before deeper gates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-etf-universe-'));
  try {
    const now = new Date('2026-09-29T15:00:00Z');
    const calls = [];
    const fetcher = async (url) => {
      calls.push(url);
      if (url.includes('nasdaqlisted.txt')) return response(nasdaq);
      if (url.includes('otherlisted.txt')) return response(other);
      if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
      if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
      if (url.includes('/most-actives')) return response({ most_actives: [{ symbol: 'TEST' }, { symbol: 'COMMON' }] });
      if (url.includes('/movers')) return response({ gainers: [{ symbol: 'QQQ' }], losers: [] });
      if (url.includes('/assets')) return response(['SPY', 'TEST', 'QQQ'].map((symbol) => ({ symbol, status: 'active', tradable: true, exchange: symbol === 'SPY' ? 'ARCA' : 'NASDAQ', name: symbol })));
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await fetchAlpacaEtfSession({ env: { ETF_DISCOVERY_MODE: 'baseline', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret', ETF_UNIVERSE_CACHE_PATH: join(dir, 'registry.json') }, now, fetcher });
    assert.equal(result.diagnostics.discovery.universeSize, 39); // three exchange ETF rows plus 36 reviewed wrappers
    assert.equal(result.diagnostics.discovery.screenerCandidates, 2);
    assert.equal(result.diagnostics.discovery.selectedCandidates, 39); // curated wrappers plus screen-discovered TEST
    assert.equal(result.diagnostics.activeTradable, 3);
    assert.equal(result.diagnostics.rejectedCatalysts.catalyst_review_missing_stale_or_unclear, 3);
    assert.equal(result.trades.length, 0);
    assert.equal(calls.filter((url) => url.includes('/news')).length, 0);
    assert.ok(calls.some((url) => url.includes('most-actives?by=volume&top=100')));
    assert.ok(calls.some((url) => url.includes('movers?top=50')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh cited ETN classification joins dynamic screening and remains subject to active listing and catalyst gates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-etn-universe-'));
  try {
    const now = new Date('2026-09-29T15:00:00Z');
    const classificationPath = join(dir, 'products.json');
    await writeFile(classificationPath, JSON.stringify([{ symbol: 'ETN1', name: 'Example note', productType: 'etn', exposureKey: 'GOLD', leverage: 1,
      sourceUrl: 'https://issuer.example/etn1', reviewedAt: '2026-09-01T00:00:00Z' }]));
    const fetcher = async (url) => {
      if (url.includes('nasdaqlisted.txt')) return response(nasdaq);
      if (url.includes('otherlisted.txt')) return response(other);
      if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
      if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
      if (url.includes('/most-actives')) return response({ most_actives: [{ symbol: 'ETN1' }] });
      if (url.includes('/movers')) return response({ gainers: [], losers: [] });
      if (url.includes('/assets')) return response([{ symbol: 'ETN1', status: 'active', tradable: true, exchange: 'ARCA', name: 'Example note' }]);
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await fetchAlpacaEtfSession({ env: { ETF_DISCOVERY_MODE: 'baseline', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret',
      ETF_UNIVERSE_CACHE_PATH: join(dir, 'registry-cache.json'), ETF_ETP_CLASSIFICATION_PATH: classificationPath }, now, fetcher });
    assert.equal(result.diagnostics.discovery.supplementalEtpClassifications, 1);
    assert.equal(result.diagnostics.discovery.selectedCandidates, 3); // two curated directory ETFs plus the screener ETN
    assert.equal(result.diagnostics.activeTradable, 1);
    assert.equal(result.diagnostics.rejectedCatalysts.catalyst_review_missing_stale_or_unclear, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an expired cached ETN citation cannot re-enter dynamic discovery during the cache freshness window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-expired-etn-'));
  try {
    const now = new Date('2026-09-29T15:00:00Z');
    const cachePath = join(dir, 'registry-cache.json');
    const classificationPath = join(dir, 'classifications.json');
    const classification = { symbol: 'TQQQ', productType: 'leveraged_etf', exposureKey: 'QQQ', leverage: 3, inverse: false,
      sourceUrl: 'https://issuer.example/tqqq', reviewedAt: '2026-01-01T00:00:00Z' };
    await writeFile(classificationPath, JSON.stringify([classification]));
    const base = mergeEtfDirectories(nasdaq, other);
    await writeFile(cachePath, JSON.stringify({ ...base, fetchedAt: now.toISOString(), schemaVersion: 2, supplementalCount: 1, entries: [
      ...base.entries,
      { symbol: 'TQQQ', name: 'Example leveraged ETF', instrumentType: 'etf', exchange: 'NASDAQ', source: 'nasdaq' },
      { symbol: 'TQQQ', productType: 'leveraged_etf', instrumentType: 'etp', exposureKey: 'QQQ', leverage: 3,
        classificationSourceUrl: 'https://issuer.example/tqqq', classificationReviewedAt: '2026-01-01T00:00:00Z', source: 'supplemental-reviewed' },
    ] }));
    const fetcher = async (url) => {
      if (url.includes('/clock')) return response({ timestamp: now.toISOString(), is_open: true });
      if (url.includes('/calendar')) return response([{ date: '2026-09-29', open: '09:30', close: '16:00' }]);
      if (url.includes('/most-actives')) return response({ most_actives: [{ symbol: 'TQQQ' }] });
      if (url.includes('/movers')) return response({ gainers: [], losers: [] });
      if (url.includes('/assets')) return response([{ symbol: 'TQQQ', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'Example leveraged ETF' }]);
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await fetchAlpacaEtfSession({ env: { ETF_DISCOVERY_MODE: 'baseline', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret',
      ETF_UNIVERSE_CACHE_PATH: cachePath, ETF_ETP_CLASSIFICATION_PATH: classificationPath }, now, fetcher });
    assert.equal(result.diagnostics.discovery.supplementalEtpClassifications, 0);
    assert.deepEqual(result.diagnostics.discovery.blockedClassifications, ['TQQQ']);
    assert.equal(result.diagnostics.discovery.selectedCandidates, 2); // curated SPY and QQQ only
    assert.equal(result.diagnostics.activeTradable, 0);
    await writeFile(classificationPath, JSON.stringify([{ ...classification, reviewedAt: '2026-09-29T00:00:00Z' }]));
    const reviewed = await fetchAlpacaEtfSession({ env: { ETF_DISCOVERY_MODE: 'baseline', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret',
      ETF_UNIVERSE_CACHE_PATH: cachePath, ETF_ETP_CLASSIFICATION_PATH: classificationPath }, now, fetcher });
    assert.equal(reviewed.diagnostics.discovery.supplementalEtpClassifications, 1);
    assert.deepEqual(reviewed.diagnostics.discovery.blockedClassifications, []);
    assert.equal(reviewed.diagnostics.activeTradable, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
