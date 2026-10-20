import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverDatabentoFuturesContracts } from './databentoContractDiscovery.js';
import { loadDatasetDirectory } from './datasetDirectoryCache.js';

const rootsFor = (products) => [...new Set(products.map((row) => String(row.providerSymbol || '').split('.')[0].toUpperCase()))].sort();
const cleanError = (error) => String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[provider-url]').slice(0, 180);
const definitionsOnly = (contracts) => contracts.map((row) => ({ ...row, contractState: 'unexpired_definition_only',
  contractSpecVerified: false, tradeEligible: false }));

async function readCache(path, products, dataset, now) {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8'));
    const fetchedAt = Date.parse(cache.fetchedAt);
    if (cache.schemaVersion !== 2 || cache.dataset !== dataset || !Number.isFinite(fetchedAt) || fetchedAt > now + 60_000
      || JSON.stringify(cache.roots) !== JSON.stringify(rootsFor(products)) || !Array.isArray(cache.contracts)) return null;
    return { ...cache, ageMs: Math.max(0, now - fetchedAt) };
  } catch { return null; }
}

/** Refresh provider contract identities for diagnostics only; this never promotes a definition to trade eligibility. */
export async function loadOrDiscoverFuturesContracts({ enabled = false, products = [], cachePath,
  maxAgeMs = 60 * 60_000, apiKey = '', dataset = 'GLBX.MDP3', maxScanCostUsd = 0,
  now = Date.now(), fetcher = fetch, metrics = [], clock = Date.now, scope = 'configured_roots' } = {}) {
  if (!enabled) return { status: 'disabled', contracts: [], cached: false, ageMs: null, metrics };
  if (!['configured_roots', 'dataset'].includes(scope)) throw new TypeError('Futures discovery scope must be dataset or configured_roots.');
  if (scope === 'dataset') return loadDatasetDirectory({ products, cachePath, maxAgeMs, apiKey, dataset, maxScanCostUsd, now, fetcher, metrics, clock });
  if (!products.length) return { status: 'no_products', contracts: [], cached: false, ageMs: null, metrics };
  if (!(Number.isFinite(maxAgeMs) && maxAgeMs > 0)) throw new TypeError('Contract discovery cache age must be positive.');
  dataset = String(dataset ?? '').trim();
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid Databento dataset code for Futures contract discovery.');
  const path = resolve(cachePath || 'data/futures-contract-discovery.json');
  const cached = await readCache(path, products, dataset, now);
  if (cached && cached.ageMs <= maxAgeMs) return { status: 'cached', contracts: definitionsOnly(cached.contracts), cached: true, ageMs: cached.ageMs, metrics };
  try {
    const result = await discoverDatabentoFuturesContracts(products, { apiKey, dataset, maxScanCostUsd, now, fetcher, metrics, clock });
    const cache = { schemaVersion: 2, dataset, roots: rootsFor(products), fetchedAt: new Date(now).toISOString(), contracts: result.contracts };
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(cache)}\n`, 'utf8');
    await rename(tempPath, path);
    return { status: 'refreshed', contracts: definitionsOnly(result.contracts), cached: false, ageMs: 0, metrics };
  } catch (error) {
    const failure = cleanError(error);
    return cached
      ? { status: 'stale_cache_after_provider_error', contracts: definitionsOnly(cached.contracts), cached: true, ageMs: cached.ageMs, providerError: failure, metrics }
      : { status: 'provider_error', contracts: [], cached: false, ageMs: null, providerError: failure, metrics };
  }
}
