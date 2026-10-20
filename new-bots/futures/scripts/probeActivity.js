import { discoverFuturesActivity } from '../src/futuresActivityDiscovery.js';

// Free metadata/cost estimation only: no bar download, cache mutation, Discord message or trade.
try {
  const result = await discoverFuturesActivity({ enabled: true, planOnly: true,
    apiKey: process.env.DATABENTO_API_KEY || '', dataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
    maxScanCostUsd: Number(process.env.FUTURES_MAX_SCAN_COST_USD || 0),
    lookbackMinutes: Number(process.env.FUTURES_ACTIVITY_LOOKBACK_MINUTES || 30),
    maxBarAgeMs: Number(process.env.FUTURES_ACTIVITY_MAX_BAR_AGE_MS || 180000) });
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), status: result.status, plan: result.plan || null,
    coverage: result.diagnostics, providerRequests: result.metrics.length, paidDownloads: 0, liveOrders: false }, null, 2));
} catch {
  console.log(JSON.stringify({ status: 'invalid_probe_configuration', actualCoverage: null, paidDownloads: 0,
    message: 'Check dataset and activity configuration; no data download is performed by this probe.' }));
  process.exitCode = 1;
}
