import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBacktestUniverse } from '../src/backtestData.js';
import { assessBacktestManifest, backtestDatasetSha256 } from '../src/backtestManifest.js';

const bar = (timestamp, open = 100) => ({ timestamp, open, high: open + 2, low: open - 2, close: open + 1, volume: 1_000 });
const dateKey = (timestamp) => new Date(timestamp * 1_000).toISOString().slice(0, 10);
const marketMinute = (timestamp) => {
  const date = new Date(timestamp * 1_000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
};
const manifestBase = { schemaVersion: 1, provider: 'fixture', datasetId: 'test-bars', retrievedAt: '2026-09-30T12:00:00Z',
  timezone: 'America/New_York', timestampSemantics: 'bar_open', universeCoverage: 'historical_point_in_time',
  corporateActions: 'split_adjusted', licenseStatus: 'authorized', licenseReference: 'fixture-only' };

test('stock backtest manifest distinguishes complete declarations from independently verified provenance', () => {
  const dataset = { schemaVersion: 1, symbols: { SPY: { daily: [] } } };
  const manifest = { ...manifestBase, contentSha256: backtestDatasetSha256(dataset) };
  const assessed = assessBacktestManifest(manifest, dataset);
  assert.equal(assessed.metadataSupportsOosReview, true);
  const unknowns = assessBacktestManifest({ ...manifest, universeCoverage: 'unknown', licenseStatus: 'unknown' }, dataset);
  assert.equal(unknowns.metadataSupportsOosReview, false);
  assert.throws(() => assessBacktestManifest({ ...manifest, retrievedAt: 'not-a-date' }, dataset), /retrievedAt must be a timestamp/);
  assert.throws(() => assessBacktestManifest({ ...manifest, timestampSemantics: 'guessed' }, dataset), /timestampSemantics must be one of/);
  assert.throws(() => assessBacktestManifest(manifest, { ...dataset, symbols: { SPY: { daily: [bar(1)] } } }), /SHA-256 does not match/);
  assert.equal(backtestDatasetSha256({ a: 1, b: 2 }), backtestDatasetSha256({ b: 2, a: 1 }));
});

test('pinned stock backtest dataset loads without invoking the network provider and normalizes the shared universe', async () => {
  const localData = { schemaVersion: 1, symbols: {
    AAPL: { intraday: [bar(Date.parse('2026-09-29T14:30:00Z') / 1_000)], daily: [bar(1), bar(2)] },
    SPY: { intraday: [bar(Date.parse('2026-09-29T14:30:00Z') / 1_000)], daily: [bar(1), bar(2)] },
    QQQ: { intraday: [bar(Date.parse('2026-09-29T14:30:00Z') / 1_000)], daily: [bar(1), bar(2)] },
  } };
  let providerCalls = 0;
  const loaded = await loadBacktestUniverse(['aapl', 'SPY', 'QQQ'], { localData,
    fetchSymbol: async () => { providerCalls += 1; throw new Error('local replay must not fetch'); }, dateKey, marketMinute });
  assert.equal(providerCalls, 0);
  assert.deepEqual([...loaded.keys()], ['AAPL', 'SPY', 'QQQ']);
  assert.equal(loaded.get('AAPL').intraday.length, 1);
  assert.equal(loaded.get('AAPL').daily.length, 2);
});

test('local stock backtest rejects missing benchmarks, malformed bars, and out-of-order history', async () => {
  const series = { intraday: [bar(100)], daily: [bar(1), bar(2)] };
  await assert.rejects(loadBacktestUniverse(['SPY'], { localData: { symbols: {} }, dateKey, marketMinute }), /SPY dataset is missing/);
  await assert.rejects(loadBacktestUniverse(['SPY'], { localData: { symbols: { SPY: { ...series, intraday: [{ ...bar(1), high: 90 }] } } }, dateKey, marketMinute }), /malformed or out of chronological order/);
  await assert.rejects(loadBacktestUniverse(['SPY'], { localData: { symbols: { SPY: { ...series, daily: [bar(2), bar(1)] } } }, dateKey, marketMinute }), /malformed or out of chronological order/);
});

test('stock backtest CLI runs against local data when fetch is disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stock-cli-'));
  const dataFile = join(directory, 'dataset.json');
  const denyNetwork = join(directory, 'deny-network.mjs');
  const timestamp = Date.parse('2026-09-29T14:30:00Z') / 1_000;
  const series = { intraday: [bar(timestamp)], daily: [bar(timestamp - 86_400), bar(timestamp)] };
  try {
    const dataset = { schemaVersion: 1, symbols: { AAPL: series, SPY: series, QQQ: series } };
    dataset.manifest = { ...manifestBase, universeCoverage: 'unknown', licenseStatus: 'unknown', contentSha256: backtestDatasetSha256(dataset) };
    await writeFile(dataFile, JSON.stringify(dataset));
    await writeFile(denyNetwork, "globalThis.fetch = () => { throw new Error('offline test forbids network'); };\n");
    const script = fileURLToPath(new URL('../scripts/backtest.js', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(denyNetwork).href, script, `--data=${dataFile}`], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /local point-in-time dataset/);
    assert.match(result.stdout, /no graded trades; estimates unavailable/);
    assert.match(result.stdout, /point-in-time membership, data vendor\/licensing, delay, and timestamp quality are not verified/);
    assert.match(result.stdout, /Execution costs are modeled assumptions, not broker fills/);
    assert.match(result.stdout, /Manifest supports point-in-time OOS review: no/);
    assert.match(result.stdout, /license=unknown \(fixture-only\)/);
    assert.match(result.stdout, /Manifest values are user-supplied declarations, not independently verified/);
    assert.doesNotMatch(result.stdout, /delayed public chart data/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manifest writer adds a payload fingerprint to a separate output without overwriting source or existing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stock-manifest-'));
  const dataFile = join(directory, 'dataset.json');
  const outputFile = join(directory, 'dataset-manifest.json');
  const dataset = { schemaVersion: 1, symbols: { SPY: { intraday: [], daily: [] } } };
  const writer = fileURLToPath(new URL('../scripts/create-backtest-manifest.js', import.meta.url));
  const options = ['--provider=fixture', '--datasetId=manifest-test', '--retrievedAt=2026-09-30T12:00:00Z',
    '--timezone=America/New_York', '--timestampSemantics=unknown', '--universeCoverage=unknown',
    '--corporateActions=unknown', '--licenseStatus=unknown', '--licenseReference=test-fixture'];
  try {
    await writeFile(dataFile, JSON.stringify(dataset));
    const args = [writer, `--data=${dataFile}`, `--out=${outputFile}`, ...options];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(await readFile(outputFile, 'utf8'));
    assert.equal(output.manifest.contentSha256, backtestDatasetSha256(dataset));
    assert.deepEqual(JSON.parse(await readFile(dataFile, 'utf8')), dataset);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(second.status, 0, 'must not overwrite an existing manifest output');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
