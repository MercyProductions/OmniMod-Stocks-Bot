import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { discoverDatabentoFuturesContracts } from '../src/databentoContractDiscovery.js';
import { validateFuturesUniverse } from '../src/universe.js';
import { loadDatasetDirectory } from '../src/datasetDirectoryCache.js';

const env = (key, fallback = '') => process.env[key] ?? fallback;
const universePath = resolve(process.cwd(), env('FUTURES_FILE', 'examples/futures.json'));
const products = validateFuturesUniverse(JSON.parse(await readFile(universePath, 'utf8')));
const metrics = [];
const scope = env('FUTURES_CONTRACT_DISCOVERY_SCOPE', 'dataset');
if (!['dataset', 'configured_roots'].includes(scope)) throw new Error('FUTURES_CONTRACT_DISCOVERY_SCOPE must be dataset or configured_roots.');
const settings = {
  apiKey: env('DATABENTO_API_KEY'),
  dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'),
  maxScanCostUsd: Number(env('FUTURES_MAX_SCAN_COST_USD', 0)),
  metrics,
};
const result = scope === 'dataset' ? await loadDatasetDirectory({ ...settings, products,
  cachePath: env('FUTURES_CONTRACT_DISCOVERY_CACHE', 'data/futures-contract-discovery.json'),
  maxAgeMs: Math.max(15, Math.min(1440, Number(env('FUTURES_CONTRACT_DISCOVERY_CACHE_MINUTES', 360)))) * 60_000 })
  : await discoverDatabentoFuturesContracts(products, settings);
process.stdout.write(`${JSON.stringify({ providerMetrics: metrics, ...result }, null, 2)}\n`);
