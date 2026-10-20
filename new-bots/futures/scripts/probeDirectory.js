import { discoverDatabentoDatasetDirectory } from '../src/databentoDatasetDirectory.js';

// Metadata/cost only. No paid download, trading, Discord delivery, cache mutation or credential output.
try {
  const result = await discoverDatabentoDatasetDirectory({ apiKey: process.env.DATABENTO_API_KEY || '',
    dataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3', maxScanCostUsd: Number(process.env.FUTURES_MAX_SCAN_COST_USD || 0), planOnly: true });
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), status: result.status, directory: result.diagnostics,
    plan: result.plan || null, providerRequests: result.metrics.length, paidDownloads: 0, liveOrders: false }, null, 2));
} catch {
  console.log(JSON.stringify({ status: 'provider_metadata_unavailable', universe: null, paidDownloads: 0,
    message: 'Check Databento credentials, dataset access and schema availability. No definition download was attempted.' }));
  process.exitCode = 1;
}
