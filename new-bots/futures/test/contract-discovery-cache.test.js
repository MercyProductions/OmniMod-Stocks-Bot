import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrDiscoverFuturesContracts } from '../src/contractDiscoveryCache.js';

const now = Date.parse('2026-09-29T16:00:00.000Z');
const products = [{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0' }];
const definition = { publisher_id: 1, instrument_id: 20, raw_symbol: 'ESZ6', asset: 'ES', instrument_class: 'F',
  expiration: '2026-12-18T14:30:00.000Z', ts_recv: '2026-09-29T15:00:00.000Z' };

test('scheduled Futures contract discovery caches read-only definitions without promoting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-contract-cache-'));
  const cachePath = join(directory, 'contracts.json');
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return { ok: true, status: 200, headers: new Headers(), text: async () => url.includes('metadata.get_cost') ? '0.01' : `${JSON.stringify(definition)}\n` };
  };
  try {
    const fresh = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, apiKey: 'fixture-key', maxScanCostUsd: 1, now, fetcher });
    assert.equal(fresh.status, 'refreshed');
    assert.equal(fresh.contracts[0].providerRawSymbol, 'ESZ6');
    assert.equal(fresh.contracts[0].tradeEligible, false);
    assert.equal(fresh.contracts[0].contractSpecVerified, false);
    const cached = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, apiKey: '', maxScanCostUsd: 0, now: now + 5_000,
      fetcher: async () => { throw new Error('cache should avoid network'); } });
    assert.equal(cached.status, 'cached');
    assert.equal(cached.contracts.length, 1);
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(JSON.parse(await readFile(cachePath, 'utf8'))).includes('fixture-key'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Futures contract discovery uses a stale cache only as labeled diagnostics after refresh failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-contract-cache-stale-'));
  const cachePath = join(directory, 'contracts.json');
  try {
    await writeFile(cachePath, JSON.stringify({ schemaVersion: 2, dataset: 'GLBX.MDP3', roots: ['ES'], fetchedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      contracts: [{ providerRawSymbol: 'ESZ6', tradeEligible: true, contractSpecVerified: true }] }));
    const result = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, maxAgeMs: 60 * 60_000,
      apiKey: '', now, fetcher: async () => { throw new Error('must not call without credentials'); } });
    assert.equal(result.status, 'stale_cache_after_provider_error');
    assert.equal(result.ageMs, 2 * 60 * 60_000);
    assert.equal(result.contracts[0].tradeEligible, false);
    assert.match(result.providerError, /API_KEY is required/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Futures dated-definition cache is isolated by Databento dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-contract-dataset-'));
  const cachePath = join(directory, 'contracts.json');
  const datasets = [];
  const fetcher = async (url, options = {}) => {
    const query = url.includes('metadata.get_cost') ? new URL(url).searchParams : new URLSearchParams(options.body);
    datasets.push(query.get('dataset'));
    return { ok: true, status: 200, headers: new Headers(), text: async () => url.includes('metadata.get_cost') ? '0.01' : `${JSON.stringify(definition)}\n` };
  };
  try {
    const first = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, dataset: 'GLBX.MDP3', apiKey: 'fixture-key', maxScanCostUsd: 1, now, fetcher });
    assert.equal(first.status, 'refreshed');
    const second = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, dataset: 'OTHER.MDP3', apiKey: 'fixture-key', maxScanCostUsd: 1, now: now + 5_000, fetcher });
    assert.equal(second.status, 'refreshed', 'a cache from another dataset must not satisfy this request');
    assert.deepEqual(datasets, ['GLBX.MDP3', 'GLBX.MDP3', 'OTHER.MDP3', 'OTHER.MDP3']);
    assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).dataset, 'OTHER.MDP3');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Futures refresh failure cannot relabel a different-dataset cache as current diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-contract-dataset-stale-'));
  const cachePath = join(directory, 'contracts.json');
  try {
    await writeFile(cachePath, JSON.stringify({ schemaVersion: 2, dataset: 'OTHER.MDP3', roots: ['ES'], fetchedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      contracts: [{ providerRawSymbol: 'ESZ6', tradeEligible: false }] }));
    const result = await loadOrDiscoverFuturesContracts({ enabled: true, products, cachePath, dataset: 'GLBX.MDP3', maxAgeMs: 60 * 60_000,
      apiKey: '', now, fetcher: async () => { throw new Error('must not call without credentials'); } });
    assert.equal(result.status, 'provider_error');
    assert.deepEqual(result.contracts, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disabled Futures contract discovery makes no requests and returns no candidate contracts', async () => {
  let calls = 0;
  const result = await loadOrDiscoverFuturesContracts({ products, fetcher: async () => { calls++; } });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.contracts, []);
  assert.equal(calls, 0);
});
