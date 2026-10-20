import { observedNonNegativeNumber } from '../../shared/diagnosticNumbers.js';
import { OPTION_IDENTITY_VERSION } from '../../shared/optionContractIdentity.js';

function contractQualitySummary(rows) {
  const measured = rows.map((row) => row.chain?.identityDiagnostics).filter(Boolean);
  const reasons = {};
  for (const row of measured) for (const [reason, count] of Object.entries(row.rejectionReasons ?? {})) {
    const observed = observedNonNegativeNumber(count);
    if (observed !== null) reasons[reason] = (reasons[reason] || 0) + observed;
  }
  const sum = (field) => measured.length && measured.every((row) => observedNonNegativeNumber(row[field]) !== null)
    ? measured.reduce((total, row) => total + observedNonNegativeNumber(row[field]), 0) : null;
  return { version: OPTION_IDENTITY_VERSION, chainsMeasured: measured.length,
    contractsReturned: sum('contractsReturned'), verifiedIdentities: sum('verifiedIdentities'),
    identityRejected: sum('identityRejected'), validQuotes: sum('validQuotes'), rejectionReasons: reasons,
    basis: 'Returned contract rows from measured primary-signal chains; reason counts overlap. Independent discovery is reported separately. Unrequested or failed chains have unknown coverage.' };
}

function topReasons(rows, { signalMappingDiagnostics = {}, marketDataDiagnostics = {}, source = 'manual' } = {}) {
  const counts = {};
  for (const row of rows) {
    const reasons = new Set([...(row.reasons ?? []), ...(row.decision?.reasons ?? []), ...(row.reservation?.reasons ?? []), ...(row.reservation?.reason ? [row.reservation.reason] : [])]);
    for (const reason of reasons) counts[reason] = (counts[reason] || 0) + 1;
  }
  if (signalMappingDiagnostics.status === 'complete') {
    for (const [reason, count] of Object.entries(signalMappingDiagnostics.rejectionCounts ?? {})) {
      const observed = observedNonNegativeNumber(count);
      if (observed !== null && observed > 0) counts[`source_record:${reason}`] = observed;
    }
    const conflicts = observedNonNegativeNumber(signalMappingDiagnostics.directionConflicts);
    if (conflicts !== null && conflicts > 0) counts.primary_direction_conflict = conflicts;
  }
  if (source === 'tradier') {
    const capped = observedNonNegativeNumber(marketDataDiagnostics.cappedUnderlyings);
    if (capped !== null && capped > 0) counts.provider_request_symbol_cap = capped;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10));
}

function latencySummary(metrics) {
  const byOperation = {};
  for (const metric of metrics) {
    const operation = String(metric.operation || metric.provider || 'unknown');
    const entry = byOperation[operation] ??= { requests: 0, budgetDeferrals: 0, failures: 0, latencies: [], queueDelays: [], cooldownWaits: [], rateLimit: null };
    if (metric.requestAttempted === false) { entry.budgetDeferrals++; continue; }
    entry.requests++;
    if (metric.error || Number(metric.status) >= 400 || Number(metric.status) === 0) entry.failures++;
    const latency = observedNonNegativeNumber(metric.latencyMs);
    const queueDelay = observedNonNegativeNumber(metric.localQueueDelayMs);
    if (latency !== null) entry.latencies.push(latency);
    if (queueDelay !== null) entry.queueDelays.push(queueDelay);
    if (metric.cooldownDelayMs !== null && metric.cooldownDelayMs !== undefined && metric.cooldownDelayMs !== ''
      && Number.isFinite(Number(metric.cooldownDelayMs)) && Number(metric.cooldownDelayMs) >= 0) entry.cooldownWaits.push(Number(metric.cooldownDelayMs));
    if (metric.rateLimit && typeof metric.rateLimit === 'object') entry.rateLimit = metric.rateLimit;
  }
  for (const entry of Object.values(byOperation)) {
    entry.latencies.sort((a, b) => a - b);
    entry.averageLatencyMs = entry.latencies.length ? Number((entry.latencies.reduce((sum, n) => sum + n, 0) / entry.latencies.length).toFixed(1)) : null;
    entry.p95LatencyMs = entry.latencies.length ? entry.latencies[Math.min(entry.latencies.length - 1, Math.ceil(entry.latencies.length * 0.95) - 1)] : null;
    entry.averageLocalQueueDelayMs = entry.queueDelays.length ? Number((entry.queueDelays.reduce((sum, n) => sum + n, 0) / entry.queueDelays.length).toFixed(1)) : null;
    entry.p95LocalQueueDelayMs = entry.queueDelays.length ? entry.queueDelays[Math.min(entry.queueDelays.length - 1, Math.ceil(entry.queueDelays.length * 0.95) - 1)] : null;
    entry.cooldownWaits.sort((a, b) => a - b);
    entry.cooldownWaitSamples = entry.cooldownWaits.length;
    entry.averageCooldownWaitMs = entry.cooldownWaits.length ? Number((entry.cooldownWaits.reduce((sum, n) => sum + n, 0) / entry.cooldownWaits.length).toFixed(1)) : null;
    entry.p95CooldownWaitMs = entry.cooldownWaits.length ? entry.cooldownWaits[Math.min(entry.cooldownWaits.length - 1, Math.ceil(entry.cooldownWaits.length * 0.95) - 1)] : null;
    delete entry.latencies;
    delete entry.queueDelays;
    delete entry.cooldownWaits;
  }
  return byOperation;
}

function rateLimitSnapshot(metrics) {
  const latest = [...metrics].reverse().find((row) => Number.isFinite(Number(row.rateLimit?.allowed))
    && Number(row.rateLimit.allowed) > 0 && Number.isFinite(Number(row.rateLimit?.used)));
  if (!latest) return null;
  const { allowed, used, available, expiresAt } = latest.rateLimit;
  return {
    allowed: Number(allowed), used: Number(used),
    available: observedNonNegativeNumber(available),
    expiresAt: observedNonNegativeNumber(expiresAt),
    utilizationPct: Number((Number(used) / Number(allowed) * 100).toFixed(2)),
  };
}

export function summarizeOptionsScan({ signalRows = [], results = [], providerMetrics = [], source = 'manual', signalSource = 'manual',
  signalMappingDiagnostics = { status: 'manual-input' }, underlyingDiscovery = null, elapsedMs = null, stageDurationsMs = {} } = {}) {
  const candidates = results.filter((row) => row.candidate);
  const providerRejected = results.filter((row) => row.providerStatus && row.providerStatus !== 'ready');
  const marketDataStatuses = {};
  const assignmentReviewStatuses = {};
  for (const row of signalRows) {
    const status = String(row.marketDataStatus || (source === 'tradier' ? 'provider_status_missing' : 'manual_input'));
    marketDataStatuses[status] = (marketDataStatuses[status] || 0) + 1;
    const review = row.signal?.optionAssignmentReview;
    const reviewStatus = !review || review.status === 'missing' ? 'missing'
      : typeof review.status === 'string' ? review.status : 'invalid_status';
    assignmentReviewStatuses[reviewStatus] = (assignmentReviewStatuses[reviewStatus] || 0) + 1;
  }
  const upstream = signalRows.map((row) => row.marketDataDiagnostics).find(Boolean) || {};
  const rateLimit = rateLimitSnapshot(providerMetrics);
  const count = (value, fallback = null) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    source, signalSource, signalMapping: signalMappingDiagnostics,
    ...(underlyingDiscovery ? { universe: underlyingDiscovery } : {}),
    marketData: {
      inputSignals: count(upstream.inputSignals, signalRows.length),
      validSignals: count(upstream.validSignals, signalRows.length),
      distinctUnderlyings: count(upstream.distinctUnderlyings,
        new Set(signalRows.map((row) => String(row.signal?.underlyingSymbol || '').trim().toUpperCase()).filter(Boolean)).size),
      duplicateSignals: count(upstream.duplicateSignals),
      retainedUnderlyings: count(upstream.retainedUnderlyings, signalRows.length),
      maxSymbols: count(upstream.maxSymbols),
      cappedUnderlyings: count(upstream.cappedUnderlyings),
      cappedUnderlyingSymbols: Array.isArray(upstream.cappedUnderlyingSymbols) ? upstream.cappedUnderlyingSymbols : [],
      cappedRejectionReason: upstream.cappedRejectionReason || null,
      statusCounts: marketDataStatuses,
      callAssignmentReviewStatuses: assignmentReviewStatuses,
      contractQuality: contractQualitySummary(signalRows),
      statusSemantics: 'Status counts apply to retained underlyings; upstream input, duplicates, and symbols trimmed by the provider request cap are reported separately when available.',
    },
    funnel: {
      sourceInputRecords: signalMappingDiagnostics.status === 'complete' ? count(signalMappingDiagnostics.inputRecords) : null,
      sourceRejectedRecords: signalMappingDiagnostics.status === 'complete' ? count(signalMappingDiagnostics.rejectedRecordCount) : null,
      directionConflictUnderlyings: signalMappingDiagnostics.status === 'complete' ? count(signalMappingDiagnostics.directionConflicts) : null,
      providerCapUnderlyings: source === 'tradier' ? count(upstream.cappedUnderlyings) : null,
      primarySignals: signalRows.length,
      providerReady: source === 'tradier' ? results.filter((row) => row.providerStatus === 'ready').length : null,
      providerRejected: providerRejected.length,
      strategyCandidates: candidates.length,
      strategyRejected: results.filter((row) => row.status === 'no-setup').length,
      riskRejected: results.filter((row) => row.status === 'risk-blocked').length,
      reservationRejected: results.filter(row => row.reservation && !['reserved', 'duplicate'].includes(row.reservation.status)).length,
      paperReservations: results.filter((row) => row.status === 'reserved').length,
      duplicatesOrExposureConflicts: results.filter((row) => ['duplicate', 'exposure-conflict'].includes(row.status)).length,
    },
    provider: {
      requests: providerMetrics.filter((row) => row.requestAttempted !== false).length,
      budgetDeferrals: providerMetrics.filter((row) => row.requestAttempted === false).length,
      failures: providerMetrics.filter((row) => row.requestAttempted !== false && (row.error || Number(row.status) >= 400 || Number(row.status) === 0)).length,
      latencyByOperation: latencySummary(providerMetrics),
      rateLimitUtilization: rateLimit?.utilizationPct ?? null,
      rateLimit,
      rateLimitNote: rateLimit ? 'Latest observed Tradier market-data response headers; request usage may change between calls.' : 'No usable Tradier rate-limit headers were returned in this scan.',
    },
    elapsedMs: elapsedMs !== null && elapsedMs !== undefined && elapsedMs !== ''
      && Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) : null,
    performance: { stageDurationsMs: Object.fromEntries(Object.entries(stageDurationsMs).map(([stage, duration]) => [stage,
      duration !== null && duration !== '' && Number.isFinite(Number(duration)) && Number(duration) >= 0 ? Number(duration) : null])) },
    topRejectionReasons: topReasons(results, { signalMappingDiagnostics, marketDataDiagnostics: upstream, source }),
    topRejectionReasonBasis: 'source_record:* counts rejected source records; primary_direction_conflict and provider_request_symbol_cap count distinct underlyings; other reasons count retained result rows. Counts are stage-specific and must not be summed as unique opportunities.',
  };
}
