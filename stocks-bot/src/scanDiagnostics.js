const finite = (value, fallback = null) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

export function createProviderMetrics() {
  return { startedAt: new Date().toISOString(), requests: [] };
}

export function recordProviderRequest(metrics, provider, { latencyMs = null, cooldownDelayMs = null, status = 0, headers = null, retry = 0, error = '', requestAttempted = true } = {}) {
  if (!metrics) return;
  const limit = finite(header(headers, 'x-ratelimit-limit'));
  const remaining = finite(header(headers, 'x-ratelimit-remaining'));
  const reset = finite(header(headers, 'x-ratelimit-reset'));
  metrics.requests.push({
    requestAttempted: requestAttempted !== false,
    provider: String(provider || 'unknown'), latencyMs: finite(latencyMs) === null ? null : Math.max(0, finite(latencyMs)),
    cooldownDelayMs: finite(cooldownDelayMs) === null ? null : Math.max(0, finite(cooldownDelayMs)),
    status: finite(status, 0), retry: Math.max(0, finite(retry, 0)), error: String(error || '').slice(0, 180),
    rateLimit: limit !== null || remaining !== null || reset !== null
      ? { limit, remaining, reset, utilization: limit > 0 && remaining !== null ? Math.max(0, Math.min(1, (limit - remaining) / limit)) : null }
      : null
  });
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function summarizeProviderMetrics(metrics) {
  const groups = new Map();
  for (const request of metrics?.requests || []) {
    const group = groups.get(request.provider) || { provider: request.provider, requests: 0, budgetDeferrals: 0, failures: 0, rateLimits: 0, retries: 0, latencies: [], cooldownWaits: [], latestRateLimit: null };
    if (request.requestAttempted === false) {
      group.budgetDeferrals++;
      groups.set(request.provider, group);
      continue;
    }
    group.requests += 1;
    if (request.status >= 400 || request.error) group.failures += 1;
    if (request.status === 429) group.rateLimits += 1;
    group.retries += request.retry;
    const latency = finite(request.latencyMs);
    if (latency !== null && latency >= 0) group.latencies.push(latency);
    const cooldownDelay = finite(request.cooldownDelayMs);
    if (cooldownDelay !== null && cooldownDelay >= 0) group.cooldownWaits.push(cooldownDelay);
    if (request.rateLimit) group.latestRateLimit = request.rateLimit;
    groups.set(request.provider, group);
  }
  return [...groups.values()].map(({ latencies, cooldownWaits, ...group }) => ({
    ...group,
    latencySamples: latencies.length,
    averageLatencyMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null,
    p95LatencyMs: percentile(latencies, 0.95),
    cooldownWaitSamples: cooldownWaits.length,
    averageCooldownWaitMs: cooldownWaits.length ? cooldownWaits.reduce((sum, value) => sum + value, 0) / cooldownWaits.length : null,
    p95CooldownWaitMs: percentile(cooldownWaits, 0.95),
    rateLimitUtilization: group.latestRateLimit?.utilization ?? null,
    rateLimitRemaining: group.latestRateLimit?.remaining ?? null,
    rateLimitCapacity: group.latestRateLimit?.limit ?? null,
    rateLimitReset: group.latestRateLimit?.reset ?? null,
    rateLimitStatus: group.latestRateLimit ? 'reported by provider headers' : 'unknown; no quota headers received'
  }));
}

export function summarizeScanDiagnostics(rows = [], limit = 100) {
  const selected = rows.slice(-Math.max(1, Math.min(500, Number(limit) || 100)));
  const latest = selected.at(-1) || null;
  const durations = selected.map((row) => finite(row.durationMs)).filter((value) => value !== null);
  const reasons = new Map();
  const providers = new Map();
  for (const row of selected) {
    for (const [reason, count] of Object.entries(row.topRejectionReasons || {})) reasons.set(reason, (reasons.get(reason) || 0) + finite(count, 0));
    for (const item of row.providers || []) {
      const current = providers.get(item.provider) || { provider: item.provider, requests: 0, budgetDeferrals: 0, failures: 0, rateLimits: 0, retries: 0, weightedLatency: 0, latencySamples: 0,
        weightedCooldownWait: 0, cooldownWaitSamples: 0, latestRateLimit: null };
      current.requests += finite(item.requests, 0);
      current.budgetDeferrals += finite(item.budgetDeferrals, 0);
      current.failures += finite(item.failures, 0);
      current.rateLimits += finite(item.rateLimits, 0);
      current.retries += finite(item.retries, 0);
      if (finite(item.averageLatencyMs) !== null && item.averageLatencyMs >= 0) {
        // New scan records preserve measured sample counts. Older persisted rows
        // predate that field, so their request count remains the best available denominator.
        const samples = Number.isSafeInteger(item.latencySamples) && item.latencySamples >= 0
          ? item.latencySamples : finite(item.requests, 0);
        current.weightedLatency += item.averageLatencyMs * samples;
        current.latencySamples += samples;
      }
      if (finite(item.averageCooldownWaitMs) !== null && item.averageCooldownWaitMs >= 0) {
        const samples = Number.isSafeInteger(item.cooldownWaitSamples) && item.cooldownWaitSamples >= 0
          ? item.cooldownWaitSamples : 0;
        current.weightedCooldownWait += item.averageCooldownWaitMs * samples;
        current.cooldownWaitSamples += samples;
      }
      if (item.latestRateLimit) current.latestRateLimit = item.latestRateLimit;
      providers.set(item.provider, current);
    }
  }
  const topRejectionReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count }));
  const providerSummary = [...providers.values()].map(({ weightedLatency, latencySamples, weightedCooldownWait, cooldownWaitSamples, ...row }) => ({
    ...row,
    latencySamples,
    averageLatencyMs: latencySamples ? weightedLatency / latencySamples : null,
    cooldownWaitSamples,
    averageCooldownWaitMs: cooldownWaitSamples ? weightedCooldownWait / cooldownWaitSamples : null,
    rateLimitUtilization: row.latestRateLimit?.utilization ?? null,
    rateLimitStatus: row.latestRateLimit ? 'reported by provider headers' : 'unknown; no quota headers received'
  }));
  return {
    scansIncluded: selected.length,
    averageScanDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    latest,
    topRejectionReasons,
    providers: providerSummary
  };
}

export function countStaleRejections({ technical = [], wideDiscovery = {}, premarket = {} } = {}) {
  const technicalCount = technical.filter((row) => row.reasonCodes?.some((code) => ['stale_data', 'stale_live_quote'].includes(code))).length;
  const wideCount = Math.max(0, finite(wideDiscovery.rejectionCounts?.latest_trade_stale_or_future, 0));
  const premarketCount = Math.max(0, finite(premarket.rejectionCounts?.stale_or_old_observation, 0));
  return { technical: technicalCount, wideDiscovery: wideCount, premarket: premarketCount,
    totalGateRejections: technicalCount + wideCount + premarketCount, countsMayOverlap: true };
}
