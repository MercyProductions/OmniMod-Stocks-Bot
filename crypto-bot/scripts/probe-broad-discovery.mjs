import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Public, read-only provider calls. Isolated caches; no Discord client, strategy
// approval, order reservation or production .env credential is used.
const outputDir = fileURLToPath(new URL('../data/broad-discovery-probe/', import.meta.url));
process.env.OMNIMOD_CRYPTO_DATA_DIR = outputDir;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
if (process.argv.length > 2) throw new Error('No arguments supported; repeated runs honor the persisted refresh interval.');
const { fetchMarketUniverse } = await import('../src/cryptoData.js');
const { getProviderTelemetry } = await import('../src/providerTelemetry.js');
const started = performance.now();
const snapshot = await fetchMarketUniverse('broad-public-probe', { settings: {
  coingeckoApiKey: '', coingeckoApiTier: 'public', maxMarketRank: 250,
  discoveryMinutes: 15, broadDiscoveryEnabled: true, maxDiscoveryAssetAgeMinutes: 30,
} });
const report = { generatedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  baseline: { source: snapshot.source, assetsReturned: snapshot.assets.length, stale: snapshot.stale === true },
  broadDiscovery: snapshot.broadDiscovery, providers: getProviderTelemetry(),
  liveTrading: false, discordPosts: 0, reservations: 0 };
await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}/latest-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (['error', 'directory_unavailable'].includes(report.broadDiscovery?.status)) process.exitCode = 1;
