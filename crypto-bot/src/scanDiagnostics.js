export function createFailedScanDiagnostic({ generatedAt = new Date().toISOString(), failureStage = 'scan_execution', failure = '',
  durationMs = null, providers = {} } = {}) {
  const safeFailure = String(failure || 'Unknown scan failure.').replace(/[\r\n\t]+/g, ' ').slice(0, 700);
  const stage = String(failureStage || 'scan_execution').slice(0, 80);
  const totalDurationMs = durationMs !== null && durationMs !== undefined && durationMs !== ''
    && Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0 ? Number(durationMs) : null;
  return {
    generatedAt, failed: true, failureStage: stage, failure: safeFailure, providerError: safeFailure,
    totalDurationMs, stageDurationsMs: {}, providers,
    funnel: { universe: null, successfullyScanned: null, discoveryQualified: null,
      topRejectionReasons: { scan_failed: 1 },
      rejections: [{ stage, code: 'scan_failed', reason: safeFailure }] },
  };
}

export function summarizeScanDiagnostics(rows = []) {
  const scans = rows.filter((row) => row && row.funnel).slice(0, 100);
  const latest = scans[0] || null;
  const measuredDurations = scans.map((row) => row.totalDurationMs)
    .filter((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(Number);
  const averageDurationMs = measuredDurations.length
    ? Math.round(measuredDurations.reduce((sum, value) => sum + value, 0) / measuredDurations.length) : null;
  const rejectionCounts = new Map();
  const durationTotals = new Map();
  for (const row of scans) for (const [reason, count] of Object.entries(row.funnel.topRejectionReasons || {})) {
    rejectionCounts.set(reason, (rejectionCounts.get(reason) || 0) + Number(count || 0));
  }
  for (const row of scans) for (const [stage, duration] of Object.entries(row.stageDurationsMs || {})) {
    if (duration === null || duration === undefined || duration === '' || !Number.isFinite(Number(duration)) || Number(duration) < 0) continue;
    const total = durationTotals.get(stage) || { total: 0, scans: 0 };
    total.total += Number(duration); total.scans += 1;
    durationTotals.set(stage, total);
  }
  const providerCounts = new Map();
  for (const row of scans) for (const [name, provider] of Object.entries(row.providers || {})) {
    const target = providerCounts.get(name) || { requests: 0, successes: 0, failures: 0, rateLimits: 0, cooldownDeferrals: 0, latencyWeighted: 0, latencySamples: 0, limit: null, remaining: null, utilizationPct: null, usedWeightLastMinute: null };
    target.requests += provider.requests || 0; target.successes += provider.successes || 0;
    target.failures += provider.failures || 0; target.rateLimits += provider.rateLimits || 0;
    target.cooldownDeferrals += provider.cooldownDeferrals || 0;
    const averageLatencyMs = provider.averageLatencyMs === null || provider.averageLatencyMs === undefined || provider.averageLatencyMs === ''
      ? null : Number(provider.averageLatencyMs);
    if (Number.isFinite(averageLatencyMs) && averageLatencyMs >= 0) {
      const latencySamples = Number.isSafeInteger(provider.latencySamples) && provider.latencySamples >= 0
        ? provider.latencySamples : Number(provider.requests) || 0;
      target.latencyWeighted += averageLatencyMs * latencySamples;
      target.latencySamples += latencySamples;
    }
    if (provider.rateLimit && target.limit === null) Object.assign(target, provider.rateLimit);
    if (provider.usedWeightLastMinute !== null && provider.usedWeightLastMinute !== undefined && target.usedWeightLastMinute === null) target.usedWeightLastMinute = provider.usedWeightLastMinute;
    providerCounts.set(name, target);
  }
  const providers = Object.fromEntries([...providerCounts].map(([name, row]) => [name, {
    ...row, averageLatencyMs: row.latencySamples ? Math.round(row.latencyWeighted / row.latencySamples) : null
  }]));
  return {
    scans: scans.length, latest, averageDurationMs,
    topRejectionReasons: [...rejectionCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    averageStageDurationsMs: Object.fromEntries([...durationTotals].map(([stage, row]) => [stage, Math.round(row.total / row.scans)])),
    providers
  };
}

export function summarizeShadowResearchRecording(rows = [], recorded = null, { enabled = true, writeFailed = false } = {}) {
  if (!enabled) return { status: 'disabled', deepCandidates: null, sourcePinnedEligible: null,
    missingCandleProvenance: null, missingEntryQuoteProvenance: null,
    newlyRecorded: null, existingOrDuplicate: null };
  const candlePinned = rows.filter((row) => Boolean(row?.candleProvider && row?.candlePair));
  const eligible = candlePinned.filter((row) => row.entryQuoteBasis === 'same_source_ask'
    && row.entryQuoteProvider === row.candleProvider && row.entryQuotePair === row.candlePair).length;
  const newlyRecorded = !writeFailed && Number.isSafeInteger(recorded) && recorded >= 0 && recorded <= eligible
    ? recorded : null;
  return {
    status: writeFailed ? 'write_failed' : eligible ? 'recorded_or_existing' : 'no_source_pinned_candidates',
    deepCandidates: rows.length, sourcePinnedEligible: eligible,
    missingCandleProvenance: rows.length - candlePinned.length,
    missingEntryQuoteProvenance: candlePinned.length - eligible,
    newlyRecorded, existingOrDuplicate: newlyRecorded === null ? null : eligible - newlyRecorded,
  };
}

export function countRiskRejections(portfolioRejected = [], guardPaused = false, modelApproved = []) {
  const symbols = new Set(portfolioRejected.map((row) => String(row?.asset?.symbol || '')).filter(Boolean));
  if (guardPaused) modelApproved.forEach((row) => { if (row?.symbol) symbols.add(String(row.symbol)); });
  return symbols.size;
}

// Count each distinct candidate at most once per rejection code, even when the
// same code is recorded at multiple pipeline stages. Keep the detailed rows
// untouched so operators can still inspect where the candidate was rejected.
export function countUniqueRejectionReasons(rejections = []) {
  const seen = new Set();
  const counts = new Map();
  for (const [index, row] of rejections.entries()) {
    const code = String(row?.code || '').trim();
    if (!code) continue;
    const assetId = String(row?.assetId || '').trim().toLowerCase();
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const identity = assetId ? `id:${assetId}` : symbol ? `symbol:${symbol}` : `unidentified:${index}`;
    const key = `${identity}\u0000${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function countValidationFailureReasons(rejections = []) {
  const counts = new Map();
  const seen = new Set();
  for (const [index, row] of rejections.entries()) {
    if (row?.code !== 'strategy_validation') continue;
    const asset = String(row.assetId || row.symbol || `row-${index}`).trim().toLowerCase();
    for (const code of row.detailCodes || []) {
      if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(code)) continue;
      const key = `${asset}\u0000${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function summarizeValidationCostSensitivity(assets = []) {
  const rows = assets.map((asset) => ({
    assetId: String(asset?.id || ''), symbol: String(asset?.symbol || ''),
    comparison: asset?.marketData?.validationCostSensitivity || { status: 'unavailable', reason: 'not_deep_analyzed' },
  }));
  const compared = rows.filter((row) => row.comparison.status === 'compared');
  const unavailableByReason = {};
  for (const row of rows) if (row.comparison.status !== 'compared') {
    const reason = String(row.comparison.reason || 'unknown');
    unavailableByReason[reason] = (unavailableByReason[reason] || 0) + 1;
  }
  return {
    status: compared.length ? 'research_only_sensitivity' : 'no_comparable_deep_histories',
    deepAssets: rows.length, compared: compared.length, unavailableByReason,
    baselinePassing: compared.filter((row) => row.comparison.baselinePassed).length,
    quoteScenarioPassing: compared.filter((row) => row.comparison.quoteScenarioPassed).length,
    passedToFailed: compared.filter((row) => row.comparison.baselinePassed && !row.comparison.quoteScenarioPassed).length,
    failedToPassed: compared.filter((row) => !row.comparison.baselinePassed && row.comparison.quoteScenarioPassed).length,
    assets: rows.map((row) => ({ assetId: row.assetId, symbol: row.symbol, ...row.comparison })),
    interpretation: 'Research only: a current estimated quote cost is applied uniformly to earlier candles. It is not a point-in-time cost series, executable-fill evidence, an independent holdout, or a production gate.',
  };
}

export function dailyCapacityRejections(candidates = [], availableSlots = 0) {
  const slots = Math.max(0, Number(availableSlots) || 0);
  return candidates.slice(slots).map((asset) => ({ symbol: asset.symbol, assetId: String(asset.id || '').slice(0, 120) || null,
    stage: 'daily_capacity', code: 'daily_signal_cap' }));
}

export function summarizeUniverseCoverage(snapshot = {}, settings = {}) {
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
  const source = String(snapshot.source || 'unknown');
  const nonNegativeCount = (value, fallback = null) => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const pageSize = Math.max(1, Number(snapshot.providerPageSize) || 250);
  const providerReportedTotal = Number.isSafeInteger(Number(snapshot.providerReportedTotal)) && Number(snapshot.providerReportedTotal) > 0 ? Number(snapshot.providerReportedTotal) : null;
  const providerRowsReturned = nonNegativeCount(snapshot.providerRowsReturned, assets.length);
  const marketRankCap = Math.max(1, Number(snapshot.marketCapRankCapRequested) || Number(settings.maxMarketRank) || 250);
  const discoveryMinutes = Math.max(5, Number(snapshot.discoveryIntervalMinutes) || Number(settings.discoveryMinutes) || 15);
  const coingecko = /coingecko/i.test(source);
  const pagesFetched = coingecko ? nonNegativeCount(snapshot.discoveryPages) : null;
  const pagesNeededForRequestedDepth = Math.ceil(marketRankCap / pageSize);
  const marketCapPagesFetched = coingecko ? nonNegativeCount(snapshot.marketCapPagesFetched) : null;
  const marketCapPagesRequested = coingecko ? Math.max(pagesNeededForRequestedDepth, Number(snapshot.marketCapPagesRequested) || 0) : null;
  const estimatedCallsPerRefresh = coingecko ? pagesFetched : null;
  const refreshesPer30Days = Math.ceil(30 * 24 * 60 / discoveryMinutes);
  return {
    provider: coingecko ? 'CoinGecko' : source,
    assetsReturned: assets.length,
    providerRowsReturned,
    providerReportedTotal,
    providerCoveragePct: providerReportedTotal ? Math.min(100, assets.length / providerReportedTotal * 100) : null,
    marketRankCap,
    pageSize,
    pagesFetched,
    pagesNeededForRequestedDepth: coingecko ? pagesNeededForRequestedDepth : null,
    marketCapPagesFetched,
    marketCapPagesRequested,
    estimatedCallsPerRefresh,
    estimatedCallsPer30Days: coingecko ? nonNegativeCount(snapshot.estimatedCallsPer30Days,
      Number.isFinite(estimatedCallsPerRefresh) ? estimatedCallsPerRefresh * refreshesPer30Days : null) : null,
    discoveryMinutes,
    discoveryBudget: snapshot.discoveryBudget || null,
    pointInTimeMembership: snapshot.universeJournal || null,
    broadDiscovery: snapshot.broadDiscovery || null,
    venueDiscovery: snapshot.venueDiscovery || null,
    coverageLimited: coingecko && Number.isFinite(marketCapPagesFetched) && Number.isFinite(marketCapPagesRequested)
      ? marketCapPagesFetched < marketCapPagesRequested : null,
    order: coingecko ? String(snapshot.queryOrder || 'volume_desc') : 'provider-defined'
  };
}
// Discord applies the 6,000-character limit across an entire message's embeds.
// Keep the full diagnostic JSON alongside the compact operator-facing embed.
export function fitDiagnosticEmbed(embed, budget = 5900) {
  const trim = (value, limit) => String(value || '').length > limit ? `${String(value).slice(0, Math.max(0, limit - 1))}…` : String(value || '');
  const result = { ...embed, title: trim(embed.title, 256), description: trim(embed.description, 800),
    author: embed.author ? { ...embed.author, name: trim(embed.author.name, 128) } : undefined,
    footer: embed.footer ? { ...embed.footer, text: trim(embed.footer.text, 400) } : undefined };
  const fields = (embed.fields || []).slice(0, 25).map((field) => ({ ...field, name: trim(field.name, 80) }));
  const fixed = result.title.length + result.description.length + (result.footer?.text.length || 0)
    + (result.author?.name?.length || 0) + fields.reduce((sum, field) => sum + field.name.length, 0);
  const limit = Math.max(1, Math.min(1024, Math.floor((budget - fixed) / Math.max(1, fields.length))));
  result.fields = fields.map((field) => ({ ...field, value: trim(field.value || 'Unavailable', limit) }));
  return result;
}

