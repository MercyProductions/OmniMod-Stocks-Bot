import { retryPlan } from './retryPolicy.js';

const cooldownUntilByOrigin = new Map();

function originOf(url) {
  try { return new URL(String(url)).origin; }
  catch { throw new TypeError('Provider cooldown requires an absolute request URL.'); }
}

/** Record a process-local provider-host cooldown after a 429 response. */
export function recordProviderCooldown(url, retryAfter, attempt, { now = Date.now(), serverDateHeader = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Provider cooldown timestamp must be finite.');
  const origin = originOf(url);
  // Preserve long Retry-After instructions even when the request itself will
  // not wait/retry for that long. Invalid/missing headers use bounded backoff.
  const plan = retryPlan(retryAfter, attempt, { now, serverDateHeader, maxRetryDelayMs: Number.MAX_SAFE_INTEGER });
  if (plan.delayMs <= 0) return { origin, until: now, delayMs: 0, source: plan.source };
  const until = Math.max(cooldownUntilByOrigin.get(origin) || 0, now + plan.delayMs);
  cooldownUntilByOrigin.set(origin, until);
  return { origin, until, delayMs: Math.max(0, until - now), source: plan.source };
}

export function providerCooldownStatus(url, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Provider cooldown timestamp must be finite.');
  const origin = originOf(url);
  const until = cooldownUntilByOrigin.get(origin) || 0;
  if (until <= now) {
    cooldownUntilByOrigin.delete(origin);
    return { origin, coolingDown: false, until: null, remainingMs: 0 };
  }
  return { origin, coolingDown: true, until, remainingMs: until - now };
}

function cooldownError(status) {
  const error = new Error(`Provider host is cooling down for ${status.remainingMs}ms after rate limiting.`);
  error.name = 'ProviderCooldownError';
  error.code = 'PROVIDER_COOLDOWN_ACTIVE';
  const retryDate = new Date(status.until);
  error.retryAt = Number.isFinite(retryDate.getTime()) ? retryDate.toISOString() : null;
  error.remainingMs = status.remainingMs;
  return error;
}

export function assertProviderAvailable(url, now = Date.now()) {
  const status = providerCooldownStatus(url, now);
  if (status.coolingDown) throw cooldownError(status);
  return status;
}

/** Wait only when continuing the same bounded retry sequence. New requests fail fast. */
export async function waitForProviderCooldown(url, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 5_000 } = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function' || !Number.isFinite(maxWaitMs) || maxWaitMs < 0)
    throw new TypeError('Provider cooldown wait callbacks or limit are invalid.');
  for (;;) {
    const status = providerCooldownStatus(url, now());
    if (!status.coolingDown) return status;
    if (status.remainingMs > maxWaitMs) throw cooldownError(status);
    await sleep(status.remainingMs);
  }
}
