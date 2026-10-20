import { observedNonNegativeNumber } from '../../shared/diagnosticNumbers.js';

function mergeReasons(target, rows) {
  for (const [reason, count] of Object.entries(rows ?? {})) target[reason] = (target[reason] || 0) + Number(count || 0);
}

function rankedReasons(counts) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12));
}

function providerSummary(metrics) {
  const grouped = {};
  for (const row of metrics) {
    const name = String(row.provider || 'unknown');
    const group = grouped[name] ??= { requests: 0, budgetDeferrals: 0, failures: 0, latencies: [], cooldownWaits: [], latestRateLimit: null };
    if (row.requestAttempted === false) { group.budgetDeferrals++; continue; }
    group.requests++;
    if (row.error || Number(row.status) >= 400 || Number(row.status) === 0) group.failures++;
    const latency = observedNonNegativeNumber(row.latencyMs);
    if (latency !== null) group.latencies.push(latency);
    if (row.cooldownDelayMs !== null && row.cooldownDelayMs !== undefined && row.cooldownDelayMs !== ''
      && Number.isFinite(Number(row.cooldownDelayMs)) && Number(row.cooldownDelayMs) >= 0) group.cooldownWaits.push(Number(row.cooldownDelayMs));
    if (row.rateLimit && typeof row.rateLimit === 'object') group.latestRateLimit = row.rateLimit;
  }
  for (const group of Object.values(grouped)) {
    group.latencies.sort((a, b) => a - b);
    group.averageLatencyMs = group.latencies.length ? Number((group.latencies.reduce((sum, x) => sum + x, 0) / group.latencies.length).toFixed(1)) : null;
    group.p95LatencyMs = group.latencies.length ? group.latencies[Math.min(group.latencies.length - 1, Math.ceil(group.latencies.length * 0.95) - 1)] : null;
    group.cooldownWaits.sort((a, b) => a - b);
    group.cooldownWaitSamples = group.cooldownWaits.length;
    group.averageCooldownWaitMs = group.cooldownWaits.length
      ? Number((group.cooldownWaits.reduce((sum, x) => sum + x, 0) / group.cooldownWaits.length).toFixed(1)) : null;
    group.p95CooldownWaitMs = group.cooldownWaits.length
      ? group.cooldownWaits[Math.min(group.cooldownWaits.length - 1, Math.ceil(group.cooldownWaits.length * 0.95) - 1)] : null;
    group.rateLimitUtilizationPct = group.latestRateLimit?.utilizationPct ?? null;
    delete group.latencies;
    delete group.cooldownWaits;
  }
  return grouped;
}

export function summarizeEtfScan({ sessionInput = {}, trades = [], results = [], providerMetrics = [], elapsedMs = null, stageDurationsMs = {} } = {}) {
  const source = sessionInput.diagnostics ?? {};
  const reasons = {};
  const latestRateLimit = [...providerMetrics].reverse().find((row) => /^Alpaca(?: |$)/.test(String(row.provider || ''))
    && row.rateLimit)?.rateLimit ?? null;
  mergeReasons(reasons, source.rejectedAssets);
  mergeReasons(reasons, source.rejectedDiscovery);
  if (!source.rejectedDiscovery) mergeReasons(reasons, source.discovery?.rejectedDiscovery);
  mergeReasons(reasons, source.discovery?.cheapScreen?.rejectionReasons);
  mergeReasons(reasons, source.rejectedCatalysts);
  mergeReasons(reasons, source.rejected);
  if (source.providerError) reasons.provider_request_failed = (reasons.provider_request_failed || 0) + 1;
  const count = (value, fallback = null) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  for (const result of results) {
    const candidateReasons = new Set([...(result.reasons ?? []), ...(result.decision?.reasons ?? []),
      ...(result.reservation?.reason ? [result.reservation.reason] : [])]);
    for (const reason of candidateReasons) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    source: sessionInput.source ?? 'unspecified',
    quoteEvidence: source.quoteEvidence ?? null,
    quoteCollectionAges: source.quoteCollectionAges ?? null,
    rejectedDataRows: source.rejectedRows ?? [],
    universe: {
      configured: count(source.universeSize, source.providerError || source.discovery?.mode === 'full-market-directory' ? null : trades.length),
      discovery: source.discovery ?? null,
      activeTradable: count(source.activeTradable),
      catalystCleared: count(source.catalystCleared),
      providerScanned: count(source.scanned),
      withUsableMarketData: count(source.rowsWithUsableData, source.providerError ? null : trades.length),
      strategyInputs: trades.length,
    },
    funnel: {
      strategyCandidates: results.filter((row) => Boolean(row.candidate)).length,
      strategyRejected: results.filter((row) => row.status === 'no-setup').length,
      riskRejected: results.filter((row) => row.status === 'risk-blocked').length,
      reservationRejected: results.filter((row) => row.reservation?.status === 'blocked').length,
      paperReservations: results.filter((row) => row.status === 'reserved').length,
      duplicateOrExposureConflicts: results.filter((row) => ['duplicate', 'exposure-conflict'].includes(row.status)).length,
      unavailableRows: results.filter((row) => ['provider-error', 'unavailable', 'provider-data-unavailable'].includes(row.status)).length,
    },
    provider: {
      requests: providerMetrics.filter((row) => row.requestAttempted !== false).length,
      budgetDeferrals: providerMetrics.filter((row) => row.requestAttempted === false).length,
      failures: providerMetrics.filter((row) => row.requestAttempted !== false && (row.error || Number(row.status) >= 400 || Number(row.status) === 0)).length,
      byEndpoint: providerSummary(providerMetrics),
      rateLimitUtilizationPct: latestRateLimit?.utilizationPct ?? null,
      latestRateLimit,
      rateLimitNote: latestRateLimit ? 'Latest observed Alpaca response headers; limits may vary by endpoint and account.' : 'No usable Alpaca rate-limit headers were returned in this scan.',
    },
    elapsedMs: elapsedMs !== null && elapsedMs !== undefined && elapsedMs !== ''
      && Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : null,
    performance: { stageDurationsMs: Object.fromEntries(Object.entries(stageDurationsMs).map(([stage, duration]) => [stage,
      duration !== null && duration !== '' && Number.isFinite(Number(duration)) && Number(duration) >= 0 ? Number(duration) : null])) },
    topRejectionReasons: rankedReasons(reasons),
  };
}
