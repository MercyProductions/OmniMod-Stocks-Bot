import { readMarketSnapshot, writeMarketSnapshot } from './storage.js';
import { appendCandleBatch, materializeObservations, readResearchEvents } from './researchStore.js';
import { fetchHistoricalCandles } from './marketProviders.js';

// Keep source-pinned observations monitored after they leave today's shortlist.
// Two source pulls per pass, round-robin by last attempt, never synthetic marks.
export async function refreshVenueResearchOutcomes({ now = Date.now(), maxSources = 2,
  fetchCandles = fetchHistoricalCandles, observations, appendCandles = appendCandleBatch } = {}) {
  const started = performance.now();
  const rows = observations || materializeObservations(await readResearchEvents({ months: 3 }));
  const pending = rows.filter((row) => row.researchCohort === 'full-venue-discovery-v1' && !row.resolution);
  const state = await readMarketSnapshot('venue-research-monitor') || { attempts: {} };
  const groups = new Map(), rejections = [];
  for (const row of pending) {
    const created = Date.parse(row.createdAt || '');
    if (!row.assetId || !row.symbol || !row.candleProvider || !row.candlePair || !Number.isFinite(created)
      || created > now || now - created > 6 * 86_400_000) {
      rejections.push({ observationId: row.observationId, code: 'invalid_identity_or_outside_recent_history_window' }); continue;
    }
    const key = JSON.stringify([row.candleProvider, row.candlePair]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const due = [...groups.entries()].filter(([key]) => now - (state.attempts[key] || 0) >= 15 * 60_000)
    .sort(([a], [b]) => (state.attempts[a] || 0) - (state.attempts[b] || 0) || a.localeCompare(b));
  let updated = 0, failed = 0, attempted = 0;
  for (const [key, group] of due.slice(0, Math.max(0, Math.min(4, maxSources)))) {
    const row = group[0];
    state.attempts[key] = now;
    if (new Set(group.map((item) => item.assetId)).size > 1) {
      rejections.push({ source: key, code: 'conflicting_asset_ids_for_source_pair' }); continue;
    }
    attempted += 1;
    try {
      const history = await fetchCandles({ id: row.assetId, symbol: row.symbol }, {
        providers: [row.candleProvider], sourcePairs: { [row.candleProvider]: row.candlePair }, limit: 600,
      });
      if (history.provider !== row.candleProvider || history.pair !== row.candlePair || !history.candles?.length) {
        throw new Error('exact_source_history_unavailable');
      }
      await appendCandles(row.symbol, history.provider, history.candles, history.pair);
      updated += 1;
    } catch {
      failed += 1;
      rejections.push({ source: key, code: 'exact_source_history_unavailable' });
    }
  }
  // Drop scheduling metadata for sources with no remaining observations.
  state.attempts = Object.fromEntries(Object.entries(state.attempts).filter(([key]) => groups.has(key)));
  await writeMarketSnapshot('venue-research-monitor', state);
  return { pending: pending.length, sources: groups.size, due: due.length, attempted, updated, failed,
    deferred: Math.max(0, due.length - Math.max(0, Math.min(4, maxSources))), rejections,
    durationMs: Math.round(performance.now() - started), priceBasis: 'same_source_completed_candles' };
}
