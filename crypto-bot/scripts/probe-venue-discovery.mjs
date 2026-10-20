import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const outputDir = fileURLToPath(new URL('../data/venue-discovery-probe/', import.meta.url));
process.env.OMNIMOD_CRYPTO_DATA_DIR = outputDir;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => !['--prime-identity', '--deep', '--resolve', '--status'].includes(arg))) throw new Error('Use --prime-identity and/or --deep, or --resolve or --status separately.');
if ((args.has('--resolve') || args.has('--status')) && args.size !== 1) throw new Error('--resolve and --status must each run separately.');
const { fetchMarketUniverse, screenMomentumDetailed, scoreAsset } = await import('../src/cryptoData.js');
const { selectVenueResearchAssets } = await import('../src/venueDiscovery.js');
const { getProviderTelemetry } = await import('../src/providerTelemetry.js');
const { getGuildSettings } = await import('../src/guildSettings.js');
const { enrichMarketAssets } = await import('../src/marketProviders.js');
const { makePublicProbeObservation } = await import('./public-probe-research.mjs');
const { recordShadowCandidates, materializeObservations, readResearchEvents, resolvePendingObservations, summarizeVenueResearchRows } = await import('../src/researchStore.js');
const { refreshVenueResearchOutcomes } = await import('../src/venueResearch.js');
const started = performance.now();
const settings = { ...await getGuildSettings('venue-public-probe'), coingeckoApiKey: '', coingeckoApiTier: 'public',
  venueDiscoveryEnabled: true, venueResearchCandidates: 2, broadDiscoveryEnabled: false };
let report;
if (args.has('--status')) {
  report = { mode: 'local_status', providerRequests: 0 };
} else if (args.has('--resolve')) {
  const monitoring = await refreshVenueResearchOutcomes();
  const resolved = await resolvePendingObservations([], new Date());
  const rows = materializeObservations(await readResearchEvents({ months: 3 })).filter((row) => row.researchCohort === 'full-venue-discovery-v1');
  report = { monitoring, newResolved: resolved.length, observations: rows.length, pending: rows.filter((row) => !row.resolution).length };
} else {
  const snapshot = await fetchMarketUniverse('venue-public-probe', { settings, primeVenueIdentity: args.has('--prime-identity') });
  const selected = selectVenueResearchAssets(snapshot, [], settings);
  const baselineIds = new Set(snapshot.assets.map((asset) => asset.id));
  report = { baseline: { assets: snapshot.assets.length, stale: Boolean(snapshot.stale) }, venue: snapshot.venueDiscovery,
    selected: selected.assets.map((asset) => ({ id: asset.id, symbol: asset.symbol, rank: asset.rank, inBaselinePages: baselineIds.has(asset.id), identity: asset.venueDiscovery })),
    selectionRejections: selected.rejections, deep: { requested: 0, analyzed: 0, sourcePinned: 0, newlyRecorded: 0 } };
  if (args.has('--deep') && selected.assets.length) {
    const deepStarted = performance.now();
    const confirmation = await enrichMarketAssets(selected.assets, { settings, technicalAssetIds: new Set(selected.assets.map((asset) => asset.id)),
      bitcoinAsset: snapshot.assets.find((asset) => asset.id === 'bitcoin'), concurrency: 1,
      minimumScore: settings.minScore, rewardRisk: settings.minRiskReward, roundTripFeeBps: settings.estimatedRoundTripBps,
      derivativesEnabled: settings.derivativesEnabled, clock: Date.now });
    const screen = screenMomentumDetailed({ assets: confirmation.assets }, settings,
      { now: new Date(), requireConfirmation: true, collectAllRejections: true, requireDiscoveryTimestamp: true });
    const observations = confirmation.assets.map((asset) => {
      const row = makePublicProbeObservation({ ...asset, model: scoreAsset(asset) }, settings, new Date(),
        screen.rejections.filter((item) => item.assetId === asset.id).map((item) => item.code));
      return row ? { ...row, researchCohort: 'full-venue-discovery-v1', excludedFromProductionLearning: true,
        pairRoutingVersion: asset.marketData?.assetIdentity?.pairRouting?.version || null,
        identityBasis: 'verified_coingecko_venue_pairs', discoveryEvidence: asset.venueDiscovery } : null;
    }).filter(Boolean);
    report.deep = { requested: selected.assets.length, analyzed: confirmation.assets.filter((asset) => asset.marketData?.technicals?.dataSufficient).length,
      sourcePinned: observations.length, newlyRecorded: await recordShadowCandidates(observations),
      durationMs: Math.round(performance.now() - deepStarted), rejections: screen.rejections,
      assets: confirmation.assets.map((asset) => ({ id: asset.id, symbol: asset.symbol, rank: asset.rank,
        identity: asset.marketData.assetIdentity, providerCount: asset.marketData.providerCount,
        candleProvider: asset.marketData.candleProvider, candlePair: asset.marketData.candlePair, candleCount: asset.marketData.candleCount,
        errors: asset.marketData.errors, score: scoreAsset(asset).score })) };
  }
}
const outcomeSummary = summarizeVenueResearchRows(materializeObservations(await readResearchEvents({ months: 24 })));
report = { generatedAt: new Date().toISOString(), ...report, outcomeSummary, elapsedMs: Math.round(performance.now() - started),
  providers: getProviderTelemetry(), liveTrading: false, discordPosts: 0, reservations: 0, approvedSetups: 0,
  interpretation: 'Isolated discovery research. No strategy promotion, simulated fill or profitability claim.' };
await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}/latest-report.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${outputDir}/report-${Date.now()}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (['failed', 'degraded'].includes(report.venue?.status)) process.exitCode = 1;
