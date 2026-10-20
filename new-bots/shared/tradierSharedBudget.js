import { resolve, join } from 'node:path';
import { getPaperLedgerWorkspaceRoot } from './paperStatePath.js';
import { createSharedRequestBudget, inspectSharedRequestBudget, namespaceRequestBudget, providerBudgetError } from './filesystemRequestBudget.js';

export const TRADIER_BUDGET_VERSION = 'tradier-shared-market-budget-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const environments = ['production', 'sandbox'];
const validateEnvironment = environment => { if (!environments.includes(environment)) fail('TRADIER_BUDGET_ENVIRONMENT_INVALID'); };

export function tradierBudgetConfiguration(env = process.env, root = getPaperLedgerWorkspaceRoot()) {
  const readLimit = (key, fallback, ceiling) => {
    const value = String(env[key] ?? '').trim(); const number = value ? Number(value) : fallback;
    if (!Number.isInteger(number) || number < 1 || number > ceiling) fail('TRADIER_BUDGET_CONFIG_INVALID');
    return number;
  };
  return { directory: resolve(root, String(env.TRADIER_SHARED_RATE_DIR || 'shared/data/provider-limits/tradier')),
    productionRequestsPerMinute: readLimit('TRADIER_PRODUCTION_REQUESTS_PER_MINUTE', 108, 120),
    sandboxRequestsPerMinute: readLimit('TRADIER_SANDBOX_REQUESTS_PER_MINUTE', 54, 60) };
}

export function readTradierRateLimit(headers) {
  const read = name => typeof headers?.get === 'function' ? headers.get(name)
    : headers?.[Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase())];
  const values = Object.fromEntries(Object.entries({ allowed: 'X-Ratelimit-Allowed', used: 'X-Ratelimit-Used',
    available: 'X-Ratelimit-Available', expiresAt: 'X-Ratelimit-Expiry' }).map(([key, name]) => {
    const raw = read(name), value = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
    return [key, Number.isSafeInteger(value) && value >= 0 ? value : null];
  }));
  return Object.values(values).some(value => value !== null) ? values : null;
}

function normalizedHeaders(headers) {
  const quota = readTradierRateLimit(headers), output = new Headers();
  if (quota) {
    if (quota.allowed > 0) output.set('X-RateLimit-Limit', quota.allowed);
    let available = quota.available;
    if (quota.allowed > 0 && quota.used !== null)
      available = Math.min(available ?? Infinity, Math.max(0, quota.allowed - quota.used));
    if (available !== null) output.set('X-RateLimit-Remaining', available);
    // Tradier supplies milliseconds; the common state engine accepts seconds.
    if (quota.expiresAt > 0) output.set('X-RateLimit-Reset', quota.expiresAt / 1000);
  }
  const retry = typeof headers?.get === 'function' ? headers.get('Retry-After')
    : headers?.[Object.keys(headers || {}).find(key => key.toLowerCase() === 'retry-after')];
  if (retry != null) output.set('Retry-After', retry);
  return output;
}

/** Market-data requests only. Each environment has its own per-token bucket. */
export function createSharedTradierRequestGate({ directory, productionRequestsPerMinute = 108, sandboxRequestsPerMinute = 54,
  now = Date.now, sleep } = {}) {
  if (!directory) fail('TRADIER_BUDGET_CONFIG_INVALID');
  const gates = new Map();
  for (const environment of environments) {
    try { gates.set(environment, namespaceRequestBudget(createSharedRequestBudget({ directory: join(directory, environment, 'market-data'),
      requestsPerMinute: environment === 'production' ? productionRequestsPerMinute : sandboxRequestsPerMinute,
      now, ...(sleep ? { sleep } : {}), version: TRADIER_BUDGET_VERSION }), 'TRADIER')); }
    catch (error) { throw providerBudgetError(error, 'TRADIER'); }
  }
  const gateFor = environment => { validateEnvironment(environment); return gates.get(environment); };
  const wait = async (token, environment = 'production', { maxWaitMs = 10000 } = {}) => {
    if (!(Number.isFinite(maxWaitMs) && maxWaitMs >= 0 || maxWaitMs === Infinity)) fail('TRADIER_BUDGET_WAIT_INVALID');
    const grant = await gateFor(environment)(token, { maxWaitMs: maxWaitMs === Infinity ? 10000 : Math.min(maxWaitMs, 10000) });
    return { ...grant, localQueueDelayMs: grant.cooldownDelayMs, scheduledStartAt: grant.sharedBudget.grantedAt };
  };
  wait.deferStarts = (token, environment, delayMs) => gateFor(environment).defer(token, delayMs);
  wait.observe = (token, environment, headers, details) => gateFor(environment).observe(token, normalizedHeaders(headers), details);
  return wait;
}

let configuredScope, configuredGate;
function runtimeGate() {
  const config = tradierBudgetConfiguration(), scope = JSON.stringify(config);
  if (scope !== configuredScope) { configuredGate = createSharedTradierRequestGate(config); configuredScope = scope; }
  return configuredGate;
}
export const waitForTradierStartSlot = (...args) => runtimeGate()(...args);
waitForTradierStartSlot.deferStarts = (...args) => runtimeGate().deferStarts(...args);
waitForTradierStartSlot.observe = (...args) => runtimeGate().observe(...args);

export async function inspectTradierSharedBudget({ directory = tradierBudgetConfiguration().directory, now = Date.now() } = {}) {
  const reports = {};
  for (const environment of environments) reports[environment] = await inspectSharedRequestBudget({
    directory: join(directory, environment, 'market-data'), now, version: TRADIER_BUDGET_VERSION });
  return { version: TRADIER_BUDGET_VERSION, status: Object.values(reports).some(row => row.status === 'observed') ? 'observed' : 'no_observations',
    scope: 'Market-data callers sharing this filesystem directory and token; separate production/sandbox buckets. No external applications, hosts or order routing are covered.', environments: reports };
}
