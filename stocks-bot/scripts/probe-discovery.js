import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, dataDir } from '../src/config.js';
import { providerKeys, getGuildSettings } from '../src/guildSettings.js';
import { getListedEtfUniverse, getStockDiscoveryOwnership } from '../src/etfDirectory.js';
import { fetchAlpacaWideDiscoverySymbols } from '../src/stocksData.js';
import { createProviderMetrics, summarizeProviderMetrics } from '../src/scanDiagnostics.js';
import { marketSession } from '../src/time.js';

// Read-only provider requests and local diagnostic archives. No Discord, paper strategy or orders.
export async function probeStockDiscovery({ now = new Date(), guildId = config.guildId, fetcher = fetch } = {}) {
  const settings = guildId ? await getGuildSettings(guildId) : {};
  const keys = providerKeys(settings), metrics = createProviderMetrics(), session = marketSession(now);
  let ownership = null;
  if (keys.alpaca_key_id && keys.alpaca_secret_key) {
    const directory = await getListedEtfUniverse({ cachePath: join(dataDir, 'etf-directory-cache.json'), now, fetcher, metrics: metrics.requests });
    ownership = await getStockDiscoveryOwnership({ directory, now });
  }
  const result = await fetchAlpacaWideDiscoverySymbols({ keys, metrics, now, feed: config.alpacaDataFeed,
    session: session.state === 'pre_market' ? 'pre_market' : 'regular', existingSymbols: settings.watchlist || [],
    excludedSymbols: ownership?.excludedSymbols || [], exclusionRevision: ownership?.revision || '',
    cacheKey: `read-only-${guildId || 'local'}`, fetcher, archiveDirectory: join(dataDir, 'research', 'discovery') });
  return { capturedAt: new Date().toISOString(), session, configuredPriorityCount: settings.watchlist?.length ?? 0,
    directory: result.diagnostics ?? null, eligibleUniverseSize: result.eligibleUniverseSize, shortlisted: result.symbols,
    candidateCount: result.candidateCount, snapshotSymbolsReturned: result.snapshotSymbolsReturned ?? null,
    rejectionCounts: result.rejectionCounts || {}, archive: result.archive || null, error: result.error,
    providerRequests: metrics.requests.length, providerMetrics: summarizeProviderMetrics(metrics),
    paperOrders: 0, discordPosts: 0, productionStrategyInvoked: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await probeStockDiscovery(); console.log(JSON.stringify(report, null, 2));
    if (!['credentials_missing', 'screen_complete'].includes(report.directory?.status)) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ status: 'probe_failed', reason: 'Directory, ownership or local configuration unavailable; coverage unknown.',
      paperOrders: 0, discordPosts: 0, productionStrategyInvoked: false })); process.exitCode = 1;
  }
}
