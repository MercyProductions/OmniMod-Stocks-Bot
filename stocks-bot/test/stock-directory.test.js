import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { classifyStockDirectory, stockDirectoryChanges } from '../src/stockDirectory.js';
import { fetchAlpacaWideDiscoverySymbols, rankAlpacaSnapshotCandidates, mergeDirectoryVerifiedDiscovery } from '../src/stocksData.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const asset = (symbol, overrides = {}) => ({ id: `id-${symbol}`, symbol, class: 'us_equity', exchange: 'NASDAQ', status: 'active', tradable: true, ...overrides });
const snapshot = (price = 11, time = NOW) => ({ latestTrade: { p: price, t: new Date(time).toISOString() },
  dailyBar: { c: price, v: 1000000, t: '2026-09-24T04:00:00Z' }, prevDailyBar: { c: 10, v: 1000000 } });
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const settings = () => ({ keys: { alpaca_key_id: `fixture-${randomUUID()}`, alpaca_secret_key: 'fixture-secret' }, cacheKey: randomUUID(), now: new Date(NOW) });

test('directory records every exclusion and includes supported listing venues without ticker-based type guesses', () => {
  const assets = ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'NYSEARCA', 'BATS'].map((exchange, i) => asset(`VENUE${i}`, { exchange }));
  assets.push(asset('BRK.B'), asset('OLD', { status: 'inactive' }), asset('FUND'), asset('PRIORITY'), asset('CONTEXT'),
    asset('OTC', { exchange: 'OTC' }), asset('NT', { tradable: false }), asset('CRYPTO', { class: 'crypto' }),
    asset('DUP', { id: 'dup1' }), asset('DUP', { id: 'dup2' }), asset('BAD', { id: '' }));
  const result = classifyStockDirectory(assets, { excludedSymbols: ['FUND'], configuredSymbols: ['PRIORITY'], contextSymbols: ['CONTEXT'] });
  assert.equal(result.eligible.length, 7);
  assert.equal(result.rows.length, assets.length);
  assert.equal(result.diagnostics.excludedRecords + result.eligible.length, assets.length);
  assert.equal(result.diagnostics.exclusionReasons.ambiguous_active_symbol, 2);
  assert.equal(result.diagnostics.exclusionReasons.etf_etp_primary_owner, 1);
  assert.equal(result.diagnostics.exclusionReasons.configured_for_deep_analysis, 1);
  assert.equal(result.diagnostics.eligibleStockInstruments, 8);
  assert.ok(result.eligible.some((row) => row.symbol === 'BRK.B'));
  assert.deepEqual(classifyStockDirectory([asset('ONE'), asset('TWO', { id: 'id-ONE' })]).eligible, []);
});

test('directory refresh distinguishes inactive transitions and ticker changes from unreported identities', () => {
  const before = [asset('OLD'), asset('GONE'), asset('RENAME')];
  const after = [asset('OLD', { status: 'inactive', tradable: false }), asset('NEW'), asset('RENAMED', { id: 'id-RENAME' })];
  const changes = stockDirectoryChanges(before, after);
  assert.deepEqual(changes.added.map((row) => row.symbol), ['NEW']);
  assert.deepEqual(changes.noLongerReported.map((row) => row.symbol), ['GONE']);
  assert.equal(changes.changed.find((row) => row.id === 'id-OLD').status, 'inactive');
  assert.equal(classifyStockDirectory(after).eligible.length, 2);
});

test('full directory reaches the last member before the deep cap and archives all exclusions and inputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stock-directory-'));
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const assets = Array.from({ length: 1201 }, (_, i) => asset(`S${String(i).padStart(4, '0')}`));
  assets.push(asset('OLD', { status: 'inactive' }));
  const calls = []; let time = NOW;
  const result = await fetchAlpacaWideDiscoverySymbols({ ...settings(), maxSymbols: 2, archiveDirectory: directory,
    clock: () => time, sleepFn: async (ms) => { time += ms; }, fetcher: async (target) => {
      const url = new URL(target); calls.push(url);
      if (url.pathname.endsWith('/assets')) { assert.equal(url.searchParams.has('status'), false); return response(assets); }
      const symbols = url.searchParams.get('symbols').split(',');
      return response(Object.fromEntries(symbols.map((symbol) => [symbol, snapshot(symbol === 'S1200' ? 15 : 11, time)])));
    } });
  assert.equal(result.diagnostics.providerInstruments, 1202);
  assert.equal(result.eligibleUniverseSize, 1201);
  assert.equal(result.diagnostics.attempted, 1201);
  assert.equal(result.snapshotSymbolsReturned, 1201);
  assert.equal(result.rows[0].symbol, 'S1200');
  assert.equal(result.capOmissions, 1199);
  assert.equal(calls.length, 5);
  assert.equal(result.diagnostics.stageDurationsMs.snapshots, 1050);
  const archive = JSON.parse(gunzipSync(await readFile(join(directory, result.archive.file))));
  assert.equal(archive.directory.length, 1202);
  assert.equal(Object.keys(archive.snapshots).length, 1201);
  assert.equal(archive.rejections.length, 1199);
  assert.doesNotMatch(JSON.stringify(archive), /fixture-secret/);
});

test('unknown credentials preserve null coverage and no provider requests', async () => {
  let calls = 0;
  const result = await fetchAlpacaWideDiscoverySymbols({ fetcher: async () => { calls++; } });
  assert.equal(result.eligibleUniverseSize, null);
  assert.equal(result.diagnostics.providerInstruments, null);
  assert.equal(result.candidateCount, null);
  assert.equal(calls, 0);
});

test('a supplementary screener cannot bypass directory identity or a deferred account scan', () => {
  const screened = { rows: [{ symbol: 'GOOD' }, { symbol: 'WRONG' }] };
  const wide = { eligibleSymbols: ['GOOD'], rows: [], diagnostics: { status: 'screen_complete' } };
  const accepted = mergeDirectoryVerifiedDiscovery(screened, wide);
  assert.deepEqual(accepted.symbols, ['GOOD']);
  assert.deepEqual(accepted.screenerDirectoryRejected, [{ symbol: 'WRONG', reasonCode: 'screener_identity_not_directory_eligible' }]);
  assert.deepEqual(mergeDirectoryVerifiedDiscovery(screened, { ...wide, diagnostics: { status: 'scan_deferred' } }).symbols, []);
  assert.deepEqual(mergeDirectoryVerifiedDiscovery(screened, {}).symbols, []);
});

test('quota or authorization failures stop remaining batches and cannot cache an empty successful universe', async () => {
  const assets = Array.from({ length: 801 }, (_, i) => asset(`S${String(i).padStart(4, '0')}`));
  const options = settings(); let denial = true, snapshots = 0;
  options.fetcher = async (target) => {
    const url = new URL(target);
    if (url.pathname.endsWith('/assets')) return response(assets);
    snapshots++;
    if (denial) return response({ message: 'forbidden' }, 403);
    return response(Object.fromEntries(url.searchParams.get('symbols').split(',').map((s) => [s, snapshot()])));
  };
  const failed = await fetchAlpacaWideDiscoverySymbols(options);
  assert.equal(failed.diagnostics.status, 'scan_deferred');
  assert.equal(failed.diagnostics.attempted, 400);
  assert.equal(failed.diagnostics.deferred, 401);
  assert.equal(snapshots, 1);
  assert.deepEqual(failed.symbols, []);
  denial = false;
  const recovered = await fetchAlpacaWideDiscoverySymbols(options);
  assert.equal(recovered.cached, false);
  assert.equal(recovered.diagnostics.attempted, 801);
  assert.equal(snapshots, 4);
});

test('quota headroom preserves partial observations but no deep shortlist; elapsed budget also bounds work', async () => {
  for (const mode of ['quota', 'deadline']) {
    const assets = Array.from({ length: 401 }, (_, i) => asset(`S${i}`)); let time = NOW, calls = 0;
    const result = await fetchAlpacaWideDiscoverySymbols({ ...settings(), budgetMs: 1000, clock: () => time,
      sleepFn: async (ms) => { time += ms; }, fetcher: async (target) => {
        const url = new URL(target); calls++;
        if (url.pathname.endsWith('/assets')) return response(assets);
        if (mode === 'deadline') time += 1100;
        return response(Object.fromEntries(url.searchParams.get('symbols').split(',').map((s) => [s, snapshot(11, time)])), 200,
          mode === 'quota' ? { 'X-RateLimit-Remaining': '5' } : {});
      } });
    assert.equal(calls, 2);
    assert.equal(result.diagnostics.deferred, 1);
    assert.equal(result.diagnostics.attempted, 400);
    assert.equal(result.snapshotSymbolsReturned, 400);
    assert.equal(result.diagnostics.status, 'scan_deferred');
    assert.deepEqual(result.symbols, []);
  }
});

test('malformed or unrequested snapshot payload is rejected and every missing row has a record', async () => {
  const assets = Array.from({ length: 150 }, (_, i) => asset(`S${i}`));
  const result = await fetchAlpacaWideDiscoverySymbols({ ...settings(), fetcher: async (url) => response(String(url).includes('/assets?') ? assets : { WRONG: snapshot() }) });
  assert.equal(result.diagnostics.providerFailures, 1);
  assert.equal(result.snapshotSymbolsReturned, 0);
  assert.equal(result.rejectionRecords.length, 150);
  assert.equal(result.rejectionSamples.length, 100);
  assert.equal(result.rejectionCounts.invalid_or_unrequested_snapshot_payload, 150);
});

test('fresh provider observations received after latency use the advanced clock and numeric data stays strict', async () => {
  let time = NOW;
  const result = await fetchAlpacaWideDiscoverySymbols({ ...settings(), clock: () => time, fetcher: async (url) => {
    time += 1000;
    return response(String(url).includes('/assets?') ? [asset('FRESH')] : { FRESH: snapshot(12, time) });
  } });
  assert.deepEqual(result.symbols, ['FRESH']);
  const invalid = snapshot(); invalid.prevDailyBar.c = true;
  assert.equal(rankAlpacaSnapshotCandidates({ FRESH: invalid }, [asset('FRESH')], { now: new Date(NOW) }).candidateCount, 0);
});
