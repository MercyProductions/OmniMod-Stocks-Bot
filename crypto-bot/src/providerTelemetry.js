import { AsyncLocalStorage } from 'node:async_hooks';

const scanContext = new AsyncLocalStorage();
const processProviders = new Map();

function headerNumber(headers, name) {
  const value = headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function update(stats, { latencyMs = null, status = null, headers = null, error = '', deferred = false } = {}) {
  if (deferred) {
    stats.cooldownDeferrals += 1;
    if (error) stats.lastError = String(error).slice(0, 180);
    stats.lastRequestAt = new Date().toISOString();
    return;
  }
  stats.requests += 1;
  const latency = latencyMs === null || latencyMs === undefined || latencyMs === '' ? null : Number(latencyMs);
  if (Number.isFinite(latency) && latency >= 0) {
    stats.latencySamples += 1;
    stats.latencyMsTotal += latency;
    stats.latencyMsMax = Math.max(stats.latencyMsMax, latency);
  }
  if (!error && Number(status) >= 200 && Number(status) < 400) stats.successes += 1;
  else stats.failures += 1;
  if (Number(status) === 429) stats.rateLimits += 1;
  stats.lastStatus = Number(status) || null;
  const limit = headerNumber(headers, 'x-ratelimit-limit');
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const usedWeight = headerNumber(headers, 'x-mbx-used-weight-1m');
  if (limit !== null) stats.rateLimit = { limit, remaining, utilizationPct: remaining === null || limit <= 0 ? null : Math.round((limit - remaining) / limit * 1000) / 10 };
  if (usedWeight !== null) stats.usedWeightLastMinute = usedWeight;
  if (error) stats.lastError = String(error).slice(0, 180);
  else if (Number(status) >= 400) stats.lastError = `HTTP ${Number(status)}`;
  stats.lastRequestAt = new Date().toISOString();
}

function cleanStats(stats) {
  return {
    requests: stats.requests, successes: stats.successes, failures: stats.failures, rateLimits: stats.rateLimits,
    cooldownDeferrals: stats.cooldownDeferrals,
    latencySamples: stats.latencySamples,
    totalLatencyMs: stats.latencyMsTotal,
    averageLatencyMs: stats.latencySamples ? Math.round(stats.latencyMsTotal / stats.latencySamples) : null,
    maxLatencyMs: stats.latencySamples ? Math.round(stats.latencyMsMax) : null, lastStatus: stats.lastStatus,
    rateLimit: stats.rateLimit || null, usedWeightLastMinute: stats.usedWeightLastMinute ?? null,
    lastError: stats.lastError || '', lastRequestAt: stats.lastRequestAt || ''
  };
}

function getRow(map, provider) {
  const key = String(provider || 'unknown').slice(0, 60);
  if (!map.has(key)) map.set(key, { requests: 0, successes: 0, failures: 0, rateLimits: 0, cooldownDeferrals: 0, latencySamples: 0, latencyMsTotal: 0, latencyMsMax: 0 });
  return map.get(key);
}

export function recordProviderRequest(provider, detail = {}) {
  update(getRow(processProviders, provider), detail);
  const scoped = scanContext.getStore();
  if (scoped) update(getRow(scoped.providers, provider), detail);
}

export async function withProviderTelemetry(work) {
  const scope = { providers: new Map() };
  const snapshot = () => Object.fromEntries([...scope.providers].map(([name, stats]) => [name, cleanStats(stats)]));
  try {
    const result = await scanContext.run(scope, work);
    return { result, providers: snapshot() };
  } catch (error) {
    if (error && typeof error === 'object') {
      try { Object.defineProperty(error, 'providerTelemetry', { value: snapshot(), configurable: true }); } catch { /* Keep the original provider failure intact. */ }
    }
    throw error;
  }
}

export function getProviderTelemetry() {
  return Object.fromEntries([...processProviders].map(([name, stats]) => [name, cleanStats(stats)]));
}
