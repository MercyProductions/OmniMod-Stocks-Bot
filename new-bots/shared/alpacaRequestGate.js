import { createHash } from 'node:crypto';
import { alpacaBudgetConfiguration, createSharedAlpacaRequestGate } from './alpacaSharedBudget.js';

function keyFor(credentialKey) {
  const value = String(credentialKey ?? '').trim();
  if (!value) throw new TypeError('Alpaca cooldown requires a credential identifier.');
  return createHash('sha256').update(value).digest('hex');
}

/** Process-local 429 gate. It coordinates concurrent scans within one Node process without logging credentials. */
export function createAlpacaRequestGate({ now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new TypeError('Alpaca gate clock and sleep must be functions.');
  const cooldownUntil = new Map();
  const queues = new Map();

  async function wait(credentialKey, { maxWaitMs = Infinity } = {}) {
    if (maxWaitMs !== Infinity && (!Number.isFinite(maxWaitMs) || maxWaitMs < 0)) throw new RangeError('Alpaca wait budget must be non-negative.');
    const key = keyFor(credentialKey);
    const deferred = () => Object.assign(new Error('Alpaca cooldown or queue exceeds the optional research wait budget.'), { code: 'ALPACA_PACING_DEFERRED' });
    // Optional research must not queue behind an unbounded production wait.
    if (maxWaitMs !== Infinity && queues.has(key)) throw deferred();
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    queues.set(key, current);
    await previous.catch(() => {});
    const queuedAt = now();
    try {
      const delayMs = Math.max(0, (cooldownUntil.get(key) || 0) - queuedAt);
      if (delayMs > maxWaitMs) throw deferred();
      if (delayMs > 0) await sleep(delayMs);
      return { cooldownDelayMs: Math.max(0, now() - queuedAt) };
    } finally {
      release();
      if (queues.get(key) === current) queues.delete(key);
    }
  }

  wait.defer = (credentialKey, delayMs) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('Alpaca cooldown must be a finite non-negative duration.');
    const key = keyFor(credentialKey);
    const until = now() + delayMs;
    cooldownUntil.set(key, Math.max(cooldownUntil.get(key) || 0, until));
    return cooldownUntil.get(key);
  };
  return wait;
}

// Resolve after launchers load their environment, not at module evaluation.
// Reporting remains available even when operator configuration is invalid.
let configuredGate, configuredScope;
function runtimeGate() {
  const config = alpacaBudgetConfiguration(), scope = JSON.stringify(config);
  if (scope !== configuredScope) {
    configuredGate = createSharedAlpacaRequestGate(config);
    configuredScope = scope;
  }
  return configuredGate;
}
export const waitForAlpacaRequest = (...args) => runtimeGate()(...args);
waitForAlpacaRequest.defer = (...args) => runtimeGate().defer(...args);
waitForAlpacaRequest.observe = (...args) => runtimeGate().observe(...args);

/** Convert Alpaca's reset epoch (seconds) or standard Retry-After into milliseconds. */
export function alpacaThrottleDelayMs(headers, now = Date.now(), fallbackMs = 1_000) {
  const read = (name) => typeof headers?.get === 'function' ? headers.get(name) : null;
  const retryAfter = String(read('Retry-After') ?? '').trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(read('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1_000 - now);
  return Math.max(0, fallbackMs);
}
