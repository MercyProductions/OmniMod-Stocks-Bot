import { observedNonNegativeNumber } from '../../shared/diagnosticNumbers.js';
import { FUTURES_ESTIMATE_OPERATIONS, summarizeFuturesHistoricalBudget } from './historicalCostBudget.js';

const candidateStatuses = new Set(['risk-blocked', 'reserved', 'duplicate', 'exposure-conflict']);

/** Stage counts describe the supplied day-trade rows; continuous proxy context is counted separately. */
export function summarizeFuturesFunnel(rows = [], { universe = 0, observed = 0, stale = 0, providerErrors = 0, providerMetrics = [], elapsedMs = null, stageDurationsMs = null, source = 'unknown' } = {}) {
  const rejected = new Map();
  const seenContractReasons = new Set();
  for (const [index, row] of rows.entries()) {
    const identity = [row.contractId, row.contract?.contractId, row.contract?.providerRawSymbol,
      row.contract?.symbol, row.symbol].map((value) => String(value ?? '').trim()).find(Boolean)?.toUpperCase() || `unidentified:${index}`;
    const reasons = [...(Array.isArray(row.reasons) ? row.reasons : []), ...(Array.isArray(row.decision?.reasons) ? row.decision.reasons : []),
      ...(Array.isArray(row.reservation?.reasons) ? row.reservation.reasons : []), ...(row.reservation?.reason ? [row.reservation.reason] : [])];
    for (const raw of new Set(reasons)) {
      const reason = String(raw || '').trim();
      if (!reason) continue;
      const key = `${identity}\u0000${reason}`;
      if (seenContractReasons.has(key)) continue;
      seenContractReasons.add(key);
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    }
    if (!reasons.length && row.status && !candidateStatuses.has(row.status)) {
      const key = `${identity}\u0000${row.status}`;
      if (!seenContractReasons.has(key)) {
        seenContractReasons.add(key);
        rejected.set(row.status, (rejected.get(row.status) ?? 0) + 1);
      }
    }
  }
  const provider = { requests: 0, failures: 0, latencyByOperation: {}, rateLimitUtilization: null,
    rateLimitNote: 'Provider quota headers/utilization are not currently available; null means unknown.',
    estimatedScanCostUsd: null, estimatedContractDiscoveryCostUsd: null, estimatedActivityDiscoveryCostUsd: null, estimatedH1CostUsd: null,
    estimatedTotalCostUsd: null, configuredScanCostCapUsd: null };
  const observedRateLimits = [];
  for (const metric of providerMetrics) {
    const operation = String(metric.operation || 'unknown');
    if (FUTURES_ESTIMATE_OPERATIONS.has(operation)) {
      const cost = observedNonNegativeNumber(metric.estimatedCostUsd);
      if (operation === 'estimated-scan-cost') provider.estimatedScanCostUsd = cost;
      else if (operation === 'estimated-contract-discovery-cost') provider.estimatedContractDiscoveryCostUsd = cost;
      else if (operation === 'estimated-activity-discovery-cost') provider.estimatedActivityDiscoveryCostUsd = cost;
      else if (operation === 'estimated-h1-cost') provider.estimatedH1CostUsd = cost;
      const cap = observedNonNegativeNumber(metric.configuredCapUsd);
      if (cap !== null) provider.configuredScanCostCapUsd = Math.max(provider.configuredScanCostCapUsd || 0, cap);
      continue;
    }
    provider.requests++;
    if (metric.rateLimit && typeof metric.rateLimit === 'object') observedRateLimits.push(metric.rateLimit);
    const group = provider.latencyByOperation[operation] ??= { requests: 0, failures: 0, latencies: [] };
    group.requests++;
    if (metric.error || Number(metric.status) >= 400 || Number(metric.status) === 0) { group.failures++; provider.failures++; }
    const latency = observedNonNegativeNumber(metric.latencyMs);
    if (latency !== null) group.latencies.push(latency);
  }
  const latestRateLimit = observedRateLimits.at(-1) ?? null;
  if (latestRateLimit) {
    provider.rateLimit = latestRateLimit;
    provider.rateLimitUtilization = typeof latestRateLimit.utilizationPct === 'number' && Number.isFinite(latestRateLimit.utilizationPct)
      ? latestRateLimit.utilizationPct : null;
    provider.rateLimitNote = 'Latest provider-supplied rate-limit headers; actual limits may be scoped by account, endpoint, or shared traffic.';
  }
  for (const group of Object.values(provider.latencyByOperation)) {
    group.latencies.sort((a, b) => a - b);
    group.averageLatencyMs = group.latencies.length ? Number((group.latencies.reduce((sum, value) => sum + value, 0) / group.latencies.length).toFixed(1)) : null;
    group.p95LatencyMs = group.latencies.length ? group.latencies[Math.min(group.latencies.length - 1, Math.ceil(group.latencies.length * 0.95) - 1)] : null;
    delete group.latencies;
  }
  const budget = summarizeFuturesHistoricalBudget(providerMetrics);
  provider.estimatedTotalCostUsd = budget.estimates && budget.reservedUsd !== null ? Number(budget.reservedUsd.toFixed(6)) : null;
  provider.costEstimateIntegrity = budget.invalid ? 'invalid_estimate_blocks_further_downloads' : 'observed_estimates_only';
  const observedStageDurationsMs = stageDurationsMs && typeof stageDurationsMs === 'object' && !Array.isArray(stageDurationsMs)
    ? Object.fromEntries(Object.entries(stageDurationsMs).map(([name, value]) => [String(name).slice(0, 64),
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
        ? Number(Number(value).toFixed(2)) : null])) : null;
  return {
    source,
    contextUniverse: { universe, observed, skipped: Math.max(0, universe - observed), stale, providerErrors },
    provider,
    elapsedMs: elapsedMs !== null && elapsedMs !== undefined && elapsedMs !== ''
      && Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : null,
    performance: { stageDurationsMs: observedStageDurationsMs },
    dayTrade: {
      inputs: rows.length,
      contractValidated: rows.filter((row) => row.status !== 'contract-rejected').length,
      strategyQualified: rows.filter((row) => candidateStatuses.has(row.status) || row.candidate).length,
      riskApproved: rows.filter((row) => row.decision?.status === 'paper-approved').length,
      reservationsCreated: rows.filter((row) => row.status === 'reserved').length,
      duplicateOrConflict: rows.filter((row) => ['duplicate', 'exposure-conflict'].includes(row.status)).length,
      riskRejected: rows.filter((row) => row.status === 'risk-blocked').length,
      reservationRejected: rows.filter((row) => row.reservation && !['reserved', 'duplicate'].includes(row.reservation.status)).length,
      strategyRejected: rows.filter((row) => row.status === 'no-setup').length,
      contractRejected: rows.filter((row) => row.status === 'contract-rejected').length,
      currencyExposureConflicts: rows.flatMap((row) => (row.decision?.currencyExposureConflicts || []).map((conflict) => ({
        symbol: String(row.symbol || row.contractId || '').slice(0, 40), ...conflict,
      }))).slice(0, 20),
      topRejectionReasons: [...rejected].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 10),
    },
  };
}
