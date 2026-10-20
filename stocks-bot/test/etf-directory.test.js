import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getListedEtfUniverse, getStockDiscoveryOwnership } from '../src/etfDirectory.js';

const nasdaq = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'QQQ|Invesco QQQ Trust|Q|N|N|100|Y|N',
  'AAPL|Apple Inc|Q|N|N|100|N|N',
  'BAD|Test ETF|Q|Y|N|100|Y|N',
  'File Creation Time: 0929202615:45|||||||',
].join('\n');
const other = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'COMMON|Example Inc Common Stock|N|COMMON|N|100|N|COMMON',
  'FILE|Creation Marker|N||N|100|N|FILE',
  'File Creation Time: 0929202615:45|||||||',
].join('\n');

test('stock ETF classifier fetches official directories, caches ETF flags, and reuses a fresh cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stocks-etf-directory-'));
  try {
    const cachePath = join(directory, 'cache.json');
    const calls = [];
    const fetcher = async (url) => {
      calls.push(String(url));
      return new Response(String(url).includes('nasdaqlisted.txt') ? nasdaq : other, { status: 200 });
    };
    const now = Date.parse('2026-09-30T14:00:00.000Z');
    const first = await getListedEtfUniverse({ cachePath, fetcher, metrics: [], now, clock: () => now });
    assert.deepEqual(first.symbols, ['QQQ', 'SPY']);
    assert.equal(first.status, 'refreshed');
    assert.equal(calls.length, 2);
    const persisted = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(persisted.schemaVersion, 1);
    const second = await getListedEtfUniverse({ cachePath, fetcher, metrics: [], now: now + 60_000 });
    assert.equal(second.status, 'fresh_cache');
    assert.equal(calls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stock ETF classifier retries bounded 429 and uses only a bounded-age cache after permanent failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stocks-etf-directory-retry-'));
  try {
    const waits = [];
    const metrics = [];
    let calls = 0;
    const now = Date.parse('2026-09-30T14:00:00.000Z');
    const result = await getListedEtfUniverse({ cachePath: join(directory, 'cache.json'), metrics, now,
      clock: () => now, sleepFn: async (ms) => waits.push(ms),
      fetcher: async (url) => {
        calls += 1;
        if (String(url).includes('nasdaqlisted.txt') && calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
        return new Response(String(url).includes('nasdaqlisted.txt') ? nasdaq : other, { status: 200 });
      },
    });
    assert.equal(result.status, 'refreshed');
    assert.deepEqual(waits, [2_000]);
    assert.equal(metrics.filter((row) => row.status === 429).length, 1);
    const cached = { schemaVersion: 1, fetchedAt: new Date(now - 24 * 60 * 60_000).toISOString(), symbols: ['QQQ', 'SPY'] };
    const fallback = await getListedEtfUniverse({ cachePath: join(directory, 'cache.json'), cached, metrics: [], now: now + 24 * 60 * 60_000,
      fetcher: async () => new Response('', { status: 403 }), clock: () => now, sleepFn: async () => {} });
    assert.equal(fallback.status, 'stale_fallback');
    assert.deepEqual(fallback.symbols, ['QQQ', 'SPY']);
    assert.match(fallback.refreshError, /403/);
    await assert.rejects(getListedEtfUniverse({ cachePath: join(directory, 'cold.json'), metrics: [], now,
      fetcher: async () => new Response('', { status: 403 }), sleepFn: async () => {} }), /Nasdaq ETF directory unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Stocks discovery shares reviewed ETP ownership and withholds expired or invalid wrapper rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stocks-etp-owner-'));
  try {
    const classificationPath = join(directory, 'etp-classifications.json');
    const row = (symbol, reviewedAt, sourceUrl = 'https://issuer.example/product') => ({ symbol, productType: 'etn',
      exposureKey: 'SPY', leverage: 1, inverse: false, sourceUrl, reviewedAt });
    const now = new Date('2026-09-30T14:00:00.000Z');
    await writeFile(classificationPath, JSON.stringify([
      row('ETN1', '2026-09-29T00:00:00Z'), row('STALE', '2025-01-01T00:00:00Z'),
      row('BAD', '2026-09-29T00:00:00Z', 'http://untrusted.example/product'),
    ]));
    const official = { symbols: ['BND'], fetchedAt: '2026-09-30T12:00:00Z' };
    const first = await getStockDiscoveryOwnership({ directory: official, classificationPath, now });
    assert.deepEqual(first.ownedSymbols, ['BND', 'ETN1']);
    assert.deepEqual(first.blockedSymbols, ['BAD', 'STALE']);
    assert.deepEqual(first.excludedSymbols, ['BAD', 'BND', 'ETN1', 'STALE']);
    assert.equal(first.reviewedSupplementalCount, 1);
    await writeFile(classificationPath, JSON.stringify([row('ETN2', '2026-09-29T00:00:00Z')]));
    const second = await getStockDiscoveryOwnership({ directory: official, classificationPath, now });
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.ownedSymbols, ['BND', 'ETN2']);
    await assert.rejects(getStockDiscoveryOwnership({ directory: official, classificationPath: join(directory, 'missing.json'), now }),
      /classification registry invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
