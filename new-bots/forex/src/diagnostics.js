import { observedNonNegativeNumber } from '../../shared/diagnosticNumbers.js';

const rankedCounts = (counts) => Object.fromEntries(
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10),
);

function oandaScanRateEstimate(providerMetrics) {
  const starts = providerMetrics
    .filter((row) => row.requestAttempted !== false && (!row.provider || row.provider === 'OANDA practice'))
    .map((row) => observedNonNegativeNumber(row.requestStartedAt))
    .filter((value) => value !== null);
  if (!starts.length) return null;
  const perSecond = new Map();
  for (const startedAt of starts) {
    const bucket = Math.floor(startedAt / 1000);
    perSecond.set(bucket, (perSecond.get(bucket) || 0) + 1);
  }
  const peakRequestsPerSecond = Math.max(...perSecond.values());
  const documentedRequestsPerSecondLimit = 120;
  return {
    basis: 'observed request starts in this runner scan only; shared-IP traffic is not visible',
    peakRequestsPerSecond,
    documentedRequestsPerSecondLimit,
    utilizationPct: Number((peakRequestsPerSecond / documentedRequestsPerSecondLimit * 100).toFixed(2)),
  };
}

export function formatForexObservationLines(observations, dataLabel) {
  return observations.flatMap((row) => [
    `${row.instrument} | combined ${row.bias}${row.providerOperation ? ` (${row.providerOperation} failed)` : ''} | session ${row.marketDate ?? 'unknown'} ${row.marketTimeZone ?? 'unknown'} (${row.marketSchedule ?? 'unknown'}; ${row.marketSessionOpen ? 'open' : 'closed'})${row.nzdMaintenanceBreak ? ', NZD maintenance break' : ''} | ${row.source || dataLabel} | reference ${row.quoteMid ?? 'n/a'} | spread/ATR ${row.spreadToFastAtr ?? 'unknown'} | day strategy ${row.dayStrategy?.status ?? 'unavailable'}${row.dayStrategy?.reasons?.length ? ` (${row.dayStrategy.reasons.join(',')})` : ''}`,
    ...(row.primaryResearch ?? []).slice(0, 4).map((signal) => `  Shared research (unscored; paper-only): ${signal.owner}/${signal.symbol} native ${signal.direction} · ${signal.strategyId} · ${signal.observedAt}; not translated into ${row.instrument} direction${signal.catalystContext?.[0]?.headline ? ` · headline: ${signal.catalystContext[0].headline}` : ''}`),
    ...(row.frameWatches ?? []).filter((watch) => watch.bias !== 'NO SETUP').map((watch) => `  ${watch.granularity} ${watch.bias} | ${watch.quoteSide ? 'last-close reference' : 'quote-side'} entry ${watch.entryReference} | target ${watch.targetPrice} | invalidation ${watch.invalidationPrice}`),
  ]);
}

export function summarizeForexScan({ instruments = [], observations = [], paperResults = [], providerMetrics = [], source = 'unknown', maxQuoteAgeSeconds = null, scanDurationMs = null, stageDurationsMs = {}, universeDiscovery = null } = {}) {
  const strategies = paperResults.map((row) => row.strategy).filter(Boolean);
  const candidateStatuses = new Set(['reserved', 'duplicate', 'exposure-conflict', 'risk-blocked']);
  const directionalBias = (bias) => /UPWARD WATCH|DOWNWARD WATCH/.test(String(bias));
  const rejectionCounts = {};
  const reasonsByInstrument = new Map();
  const addReason = (reason, instrument) => {
    if (!reason) return;
    const key = String(reason);
    const instrumentKey = String(instrument || '').trim().toUpperCase();
    if (instrumentKey) {
      const seen = reasonsByInstrument.get(instrumentKey) ?? new Set();
      if (seen.has(key)) return;
      seen.add(key);
      reasonsByInstrument.set(instrumentKey, seen);
    }
    rejectionCounts[key] = (rejectionCounts[key] || 0) + 1;
  };
  for (const row of observations) {
    addReason(row.reason, row.instrument);
    for (const reason of row.dayStrategy?.reasons ?? []) addReason(reason, row.instrument);
    for (const rejected of row.decisionQuotes?.rejections ?? []) addReason(rejected.reason, row.instrument);
  }
  for (const row of paperResults) {
    for (const reason of row.strategy?.decision?.reasons ?? []) addReason(reason, row.instrument);
    for (const reason of row.strategy?.reservation?.reasons ?? []) addReason(reason, row.instrument);
    addReason(row.strategy?.reservation?.reason, row.instrument);
  }
  for (const row of universeDiscovery?.diagnostics?.rejected ?? []) addReason(row.reason, row.instrument);
  if (universeDiscovery?.status === 'provider_error') addReason('instrument_universe_discovery_failed');
  const byOperation = {};
  const failuresByInstrument = {};
  let unattributedProviderFailures = 0;
  for (const metric of providerMetrics) {
    const op = String(metric.operation || 'unknown');
    const operation = byOperation[op] ??= { requests: 0, failures: 0, averageLatencyMs: null, p95LatencyMs: null };
    if (metric.requestAttempted === false) { operation.localDeferrals = (operation.localDeferrals ?? 0) + 1; continue; }
    operation.requests++;
    const failed = Boolean(metric.error) || Number(metric.status) >= 400 || Number(metric.status) === 0;
    if (failed) {
      byOperation[op].failures++;
      const primaryInstrument = metric.relatedInstrument ?? metric.instrument;
      const subjects = [...new Set([primaryInstrument, ...(Array.isArray(metric.instruments) ? metric.instruments : [])]
        .map((value) => String(value ?? '').trim().toUpperCase()).filter((value) => /^[A-Z]{3}_[A-Z]{3}$/.test(value)))];
      if (!subjects.length) unattributedProviderFailures++;
      for (const pair of subjects) {
        const item = failuresByInstrument[pair] ||= { failures: 0, byOperation: {} };
        item.failures++;
        item.byOperation[op] = (item.byOperation[op] || 0) + 1;
      }
    }
    const latency = observedNonNegativeNumber(metric.latencyMs);
    if (latency === null) continue;
    const item = byOperation[op];
    (item.latencies ??= []).push(latency);
    const cooldown = Number(metric.cooldownDelayMs);
    if (metric.cooldownDelayMs !== null && metric.cooldownDelayMs !== undefined && Number.isFinite(cooldown) && cooldown >= 0) {
      (item.cooldownWaits ??= []).push(cooldown);
    }
  }
  for (const item of Object.values(byOperation)) {
    const values = (item.latencies ?? []).sort((a, b) => a - b);
    item.averageLatencyMs = values.length ? Number((values.reduce((sum, x) => sum + x, 0) / values.length).toFixed(1)) : null;
    item.p95LatencyMs = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] : null;
    delete item.latencies;
    if (item.cooldownWaits) {
      const waits = item.cooldownWaits.sort((a, b) => a - b);
      item.cooldownWaitSamples = waits.length;
      item.averageCooldownWaitMs = Number((waits.reduce((sum, value) => sum + value, 0) / waits.length).toFixed(1));
      item.p95CooldownWaitMs = waits[Math.min(waits.length - 1, Math.ceil(waits.length * 0.95) - 1)];
      delete item.cooldownWaits;
    }
  }
  const referenceRows = observations.filter((row) => Number(row.quoteMid) > 0 && row.quoteTime);
  const executableQuotes = observations.filter((row) => Number(row.bid) > 0 && Number(row.ask) >= Number(row.bid) && row.quoteTime);
  const stale = observations.filter((row) => /STALE/.test(String(row.bias)) || Number(row.quoteAgeSeconds) > maxQuoteAgeSeconds
    || row.decisionQuotes?.rejections?.some(rejected => rejected.reason === 'stale_or_invalid_quote'));
  const qualified = strategies.filter((row) => candidateStatuses.has(row.status));
  const riskRejected = strategies.filter((row) => row.status === 'risk-blocked');
  const currencyExposureConflicts = paperResults.flatMap((row) => (row.strategy?.decision?.currencyExposureConflicts || []).map((conflict) => ({
    instrument: String(row.instrument || '').slice(0, 20), ...conflict,
  }))).slice(0, 20);
  const setups = strategies.filter((row) => row.status === 'reserved');
  const oandaRateEstimate = source === 'oanda-practice' ? oandaScanRateEstimate(providerMetrics) : null;
  const observedRateLimit = [...providerMetrics].reverse().find((row) => (!row.provider || row.provider === 'OANDA practice')
    && row.rateLimit && typeof row.rateLimit === 'object')?.rateLimit ?? null;
  const observedUtilization = typeof observedRateLimit?.utilizationPct === 'number' && Number.isFinite(observedRateLimit.utilizationPct)
    ? observedRateLimit.utilizationPct : null;
  return {
    source,
    universe: { configured: universeDiscovery?.diagnostics?.configuredInstruments ?? instruments.length,
      configuredSupported: universeDiscovery?.diagnostics?.configuredSupported ?? null,
      selected: instruments.length, observed: observations.length, missing: Math.max(0, instruments.length - observations.length),
      discoveryStatus: universeDiscovery?.status ?? 'disabled',
      accountCurrencyInstruments: universeDiscovery?.diagnostics?.accountCurrencyInstruments ?? null,
      providerInstruments: universeDiscovery?.diagnostics?.providerInstruments ?? null,
      nonG10Instruments: universeDiscovery?.diagnostics?.nonG10Instruments ?? null,
      cheaplyScreened: universeDiscovery?.diagnostics?.cheaplyScreened ?? null,
      quoteQualified: universeDiscovery?.diagnostics?.quoteQualified ?? null,
      eligibleG10Instruments: universeDiscovery?.diagnostics?.eligibleG10Instruments ?? null,
      discoveryEligibleInstruments: universeDiscovery?.diagnostics?.discoveryEligibleInstruments ?? null,
      discoveredQuoteQualified: universeDiscovery?.diagnostics?.discoveredQuoteQualified ?? null,
      selectedDiscovered: universeDiscovery?.diagnostics?.selectedDiscovered ?? null,
      capOmissions: universeDiscovery?.diagnostics?.capOmissions ?? null,
      quoteRejected: universeDiscovery?.diagnostics?.quoteRejected ?? null },
    discovery: universeDiscovery?.diagnostics ?? null,
    directory: universeDiscovery?.directory ?? null,
    discoveryScreen: universeDiscovery?.screenRows ?? [],
    rejectionsByInstrument: Object.fromEntries([...reasonsByInstrument].map(([instrument, reasons]) => [instrument, [...reasons]])),
    provider: {
      requests: providerMetrics.filter((row) => row.requestAttempted !== false).length,
      localDeferrals: providerMetrics.filter((row) => row.requestAttempted === false).length,
      failures: providerMetrics.filter((row) => row.requestAttempted !== false && (row.error || Number(row.status) >= 400 || Number(row.status) === 0)).length,
      failuresByInstrument,
      unattributedFailures: unattributedProviderFailures,
      latencyByOperation: byOperation,
      rateLimitUtilization: observedUtilization ?? oandaRateEstimate?.utilizationPct ?? null,
      rateLimitObserved: observedRateLimit,
      rateLimitEstimate: oandaRateEstimate,
      rateLimitNote: observedUtilization !== null ? 'Latest provider-supplied response headers; actual limits may be scoped by account, endpoint, or shared traffic.'
        : oandaRateEstimate ? 'Scan-local estimate against OANDA’s documented 120 REST requests/second per-IP ceiling; other processes sharing the IP are not included.'
        : source === 'oanda-practice' ? 'No timestamped OANDA requests were observed in this scan.' : 'Public Yahoo request utilization is not measured.',
    },
    scanDurationMs: scanDurationMs !== null && scanDurationMs !== undefined && scanDurationMs !== ''
      && Number.isFinite(Number(scanDurationMs)) ? Math.max(0, Number(scanDurationMs)) : null,
    performance: { stageDurationsMs: Object.fromEntries(Object.entries(stageDurationsMs).map(([stage, duration]) => [stage,
      duration !== null && duration !== '' && Number.isFinite(Number(duration)) && Number(duration) >= 0 ? Number(duration) : null])) },
    funnel: {
      accountFxUniverse: universeDiscovery?.diagnostics?.accountCurrencyInstruments ?? null,
      cheaplyScreened: universeDiscovery?.diagnostics?.cheaplyScreened ?? null,
      quoteQualified: universeDiscovery?.diagnostics?.quoteQualified ?? null,
      deepAnalysisSelected: instruments.length,
      referencePriceAvailable: referenceRows.length,
      executableBidAskAvailable: executableQuotes.length,
      quoteMissingOrFailed: Math.max(0, instruments.length - referenceRows.length),
      directionalMultiTimeframeWatch: observations.filter((row) => directionalBias(row.bias)).length,
      dayStrategyQualified: qualified.length,
      riskRejected: riskRejected.length,
      paperSetupsReserved: setups.length,
    },
    staleDataRejections: new Set([...stale.map((row) => row.instrument),
      ...(universeDiscovery?.diagnostics?.rejected ?? []).filter((row) => row.reason === 'stale_or_invalid_quote').map((row) => row.instrument)]).size,
    providerFailureRows: paperResults.filter((row) => row.status === 'provider-error').length,
    currencyExposureConflicts,
    topRejectionReasons: rankedCounts(rejectionCounts),
    dayTradeApprovalAvailable: source === 'oanda-practice',
    limitations: source === 'yahoo-chart'
      ? ['Public chart feed has no executable bid/ask; Forex day-trade approval is unavailable in this mode.']
      : ['The OANDA 429 cooldown and request-rate estimate are process-local; other workers and traffic sharing the public IP are not coordinated or visible.',
        universeDiscovery?.status === 'complete'
          ? 'Discovery screens all account-listed currency pairs. Non-currency CFDs/metals are excluded; the full-analysis cap and existing strategy/risk gates still apply.'
          : 'Dynamic account-supported discovery was not completed; account universe counts are unknown.',
        'FX USD conversion factors are frozen at paper proposal. Future conversion-rate movement and broker conversion charges are not modeled.'],
  };
}
