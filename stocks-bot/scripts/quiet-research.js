import { getGuildSettings, providerKeys } from '../src/guildSettings.js';
import { readMarketSnapshot, paths, readJson, writeJson } from '../src/storage.js';
import { fetchMarketUniverse, analyzeMomentum, scoreAsset } from '../src/stocksData.js';
import { recordFeatureSnapshot } from '../src/researchStore.js';
import { marketSession } from '../src/time.js';
import fs from 'node:fs/promises';

// Explicit one-pass research process. Never import the Discord publisher or order/portfolio execution modules.
const guildId = process.env.STOCKS_QUIET_RESEARCH_GUILD;
if (!guildId) throw new Error('Set STOCKS_QUIET_RESEARCH_GUILD to the existing research guild ID');
const settings = await getGuildSettings(guildId), keys = providerKeys(settings);
if (!keys.alpaca_key_id || !keys.alpaca_secret_key) throw new Error('Authorized Alpaca data credentials required for quiet deep research');
const started = new Date();
if (marketSession(started).state !== 'regular') throw new Error('Quiet deep research requires the regular session');
const snapshot = await readMarketSnapshot(guildId);
const quiet = snapshot?.dynamicDiscovery?.quietResearch;
const age = started.getTime() - Date.parse(quiet?.observedAt);
if (!Number.isFinite(age) || age < 0 || age > 3 * 60000 || quiet.deferred) throw new Error('Fresh non-deferred quiet discovery required');
const stateFile = paths.marketSnapshot(`${guildId}-quiet-research-cursor`);
const lock = await fs.open(`${stateFile}.lock`, 'wx', 0o600);
try {
const last = await readJson(stateFile, {});
if (last.observedAt === quiet.observedAt) {
  console.log(JSON.stringify({ status: 'already_processed', productionOrders: 0, discordPosts: 0 }));
} else {
  const candidates = quiet.candidates.slice(0, 3);
  if (!candidates.length) console.log(JSON.stringify({ status: 'no_quiet_candidates', productionOrders: 0, discordPosts: 0 }));
  else {
    // Existing batched/context cache, provider gate, enrichment and technical analysis remain authoritative.
    // At most three quiet names plus the existing market-context set are deeply evaluated in this optional pass.
    const details = await fetchMarketUniverse(guildId, { settings: { ...settings, watchlist: candidates.map(row => row.symbol) },
      cacheKey: `${guildId}-quiet-research`, dynamicDiscovery: false, now: started, maxAgeMinutes: 2,
      crossCheck: true, prioritySymbols: candidates.map(row => row.symbol) });
    const symbols = new Map(candidates.map(row => [row.symbol, row]));
    const assets = details.assets.filter(asset => symbols.has(asset.symbol)).map(asset => ({ ...asset,
      model: scoreAsset(asset), quietDiscovery: symbols.get(asset.symbol) }));
    const analysis = analyzeMomentum(details, settings);
    const dispositions = new Map(assets.map(asset => [asset.symbol, {
      classification: 'quiet_market_shadow', lastPassedStage: 'discovery',
      stageRejections: [{ stage: 'research', reasonCode: 'shadow_only_not_production_approved', reason: 'Quiet discovery is a research track; no production entry has been approved.' }],
    }]));
    // Keep the existing guild's auto-trained production learner from silently absorbing this new strategy track.
    await recordFeatureSnapshot({ guildId: `${guildId}-quiet-shadow`, assets, analysis, dispositions, reason: 'quiet_market_shadow', now: started });
    await writeJson(stateFile, { observedAt: quiet.observedAt, persisted: assets.length });
    console.log(JSON.stringify({ status: 'shadow_recorded', candidates: candidates.length, analyzed: assets.length,
      technicalQualified: analysis.candidates.filter(asset => symbols.has(asset.symbol)).length,
      durationMs: Date.now() - started.getTime(), productionOrders: 0, discordPosts: 0 }));
  }
}
} finally { await lock.close(); await fs.unlink(`${stateFile}.lock`); }
