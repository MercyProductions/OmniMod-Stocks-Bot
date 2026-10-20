import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { discoverDatabentoActiveFuturesContracts } from '../src/databentoContractDiscovery.js';
import { buildFuturesDiscoveryReview } from '../src/futuresDiscoveryReview.js';
import { validateFuturesUniverse } from '../src/universe.js';

const env = (key, fallback = '') => process.env[key] ?? fallback;
const universePath = resolve(process.cwd(), env('FUTURES_FILE', 'examples/futures.json'));
const products = validateFuturesUniverse(JSON.parse(await readFile(universePath, 'utf8')));
const metrics = [];
const discovery = await discoverDatabentoActiveFuturesContracts(products, {
  apiKey: env('DATABENTO_API_KEY'),
  dataset: env('DATABENTO_DATASET', 'GLBX.MDP3'),
  maxScanCostUsd: Number(env('FUTURES_MAX_SCAN_COST_USD', 0)),
  metrics,
});
const report = buildFuturesDiscoveryReview(discovery, products);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.reviewDraft.partial) {
  process.stderr.write(`Review required: ${report.reviewDraft.rejectedDefinitions.length} discovered row(s) were rejected from draft preparation. Inspect reviewDraft.rejectedDefinitions.\n`);
  process.exitCode = 2;
}
