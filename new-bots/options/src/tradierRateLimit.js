import { createHash } from 'node:crypto';

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Serialize request starts per access token and leave headroom below Tradier's published minute limits. */
export function createTradierStartPacer({ productionIntervalMs = 550, sandboxIntervalMs = 1_100, now = Date.now, sleep = defaultSleep } = {}) {
  for (const [environment, interval] of [['production', productionIntervalMs], ['sandbox', sandboxIntervalMs]]) {
    if (!Number.isFinite(interval) || interval <= 0) throw new RangeError(`${environment} start interval must be positive.`);
  }
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new TypeError('Pacer clock and sleep must be functions.');
  const nextAllowedAt = new Map();
  const queues = new Map();
  const keyFor = (token, environment) => {
    if (!['production', 'sandbox'].includes(environment)) throw new Error('Tradier pacing environment is unsupported.');
    const secret = String(token || '');
    if (!secret) throw new Error('Tradier pacing requires an access token.');
    return `${environment}:${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`;
  };
  const waitForStartSlot = async function waitForStartSlot(token, environment = 'production', { maxWaitMs = Infinity } = {}) {
    const key = keyFor(token, environment);
    if (!(Number.isFinite(maxWaitMs) && maxWaitMs >= 0 || maxWaitMs === Infinity)) throw new RangeError('Tradier maximum queue wait is invalid.');
    const deferred = () => Object.assign(new Error('Tradier research request deferred by pacing budget.'), { code: 'TRADIER_PACING_DEFERRED' });
    // Bounded research must not queue behind another caller indefinitely. Existing callers retain normal serialization.
    if (Number.isFinite(maxWaitMs) && queues.has(key)) throw deferred();
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    queues.set(key, current);
    await previous.catch(() => {});
    const queuedAt = now();
    try {
      const interval = environment === 'production' ? productionIntervalMs : sandboxIntervalMs;
      const waitMs = Math.max(0, (nextAllowedAt.get(key) || 0) - queuedAt);
      if (waitMs > maxWaitMs) throw deferred();
      if (waitMs > 0) await sleep(waitMs);
      const startedAt = now();
      nextAllowedAt.set(key, startedAt + interval);
      return { localQueueDelayMs: Math.max(0, startedAt - queuedAt), scheduledStartAt: startedAt };
    } finally {
      release();
      if (queues.get(key) === current) queues.delete(key);
    }
  };
  waitForStartSlot.deferStarts = (token, environment, delayMs) => {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('Tradier cooldown must be a finite non-negative duration.');
    const key = keyFor(token, environment);
    const deferredUntil = now() + delayMs;
    nextAllowedAt.set(key, Math.max(nextAllowedAt.get(key) || 0, deferredUntil));
    return deferredUntil;
  };
  return waitForStartSlot;
}

// The local factory is retained for explicitly injected tests/comparisons.
export { waitForTradierStartSlot } from '../../shared/tradierSharedBudget.js';
