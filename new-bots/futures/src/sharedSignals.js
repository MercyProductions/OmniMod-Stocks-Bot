import { canonicalEtfExposureKey } from '../../shared/exposureAliases.js';
import { isIntradayPrimaryResearch } from '../../shared/signalResearch.js';

const CONTEXT_OWNERS = new Set(['stocks', 'crypto', 'forex', 'options', 'etfs-etps']);

/** Match shared directional research to the contract's declared exposure identity.
 * Context is descriptive only and must never be passed to the strategy or risk gate.
 */
export function matchPrimaryResearchForFuture(dayTrade, records = []) {
  const exposure = String(dayTrade?.contract?.exposureKey ?? '').trim().toUpperCase();
  if (!exposure || !Array.isArray(records)) return [];
  let canonicalExposure;
  try { canonicalExposure = canonicalEtfExposureKey(exposure); }
  catch { return []; }
  const matched = records.filter((record) => {
    if (!CONTEXT_OWNERS.has(record?.owner) || record?.status !== 'active' || !isIntradayPrimaryResearch(record)
      || record.executable !== false || record.paperOnly !== true) return false;
    const symbol = String(record.symbol ?? '').trim().toUpperCase();
    const recordExposure = String(record.exposureKey ?? '').trim().toUpperCase();
    if (recordExposure && recordExposure === exposure) return true;
    for (const identity of [recordExposure, symbol].filter(Boolean)) {
      try { if (canonicalEtfExposureKey(identity) === canonicalExposure) return true; }
      catch { /* Try the other identity; pair/contract keys are not ETF ticker syntax. */ }
    }
    return false;
  });
  const latestBySource = new Map();
  for (const record of matched) {
    const key = `${record.owner}:${String(record.exposureKey || record.symbol).trim().toUpperCase()}`;
    const current = latestBySource.get(key);
    if (!current || Date.parse(record.observedAt) > Date.parse(current.observedAt)) latestBySource.set(key, record);
  }
  return [...latestBySource.values()].map((record) => ({
    id: record.id,
    owner: record.owner,
    symbol: String(record.symbol).toUpperCase(),
    direction: record.direction,
    observedAt: record.observedAt,
    strategyId: record.strategyId,
    catalystContextStatus: record.catalystContextStatus || 'unknown',
    catalystContext: (record.catalystContext || []).slice(0, 2),
    executable: false,
    paperOnly: true,
  }));
}
