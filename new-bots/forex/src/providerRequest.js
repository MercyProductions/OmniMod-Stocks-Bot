import { readProviderRateLimit } from '../../shared/providerRateLimit.js';

function retryDelayMs(headers, now, attempt, random) {
  const get = (name) => headers?.get?.(name) ?? null;
  const resetValue = Number(get('X-RateLimit-Reset') ?? get('RateLimit-Reset'));
  if (Number.isFinite(resetValue) && resetValue > 0) return Math.max(0, resetValue * 1000 - now) + Math.floor(random() * 250);
  const retryAfter = get('Retry-After');
  if (retryAfter != null && String(retryAfter).trim()) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(500 * (2 ** attempt), 4_000) + Math.floor(random() * 250);
}

function isRetryable(error, status) {
  return status === 429 || status >= 500 || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
}

/** Provider-scoped in-process cooldown shared by concurrent Forex REST calls. */
export function createForexRequestGate({ now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new TypeError('Forex gate clock and sleep must be functions.');
  const cooldownUntil = new Map();
  async function wait(provider, { maxWaitMs = 10_000 } = {}) {
    const key = String(provider || '').trim();
    if (!key) throw new TypeError('Forex request gate requires a provider identity.');
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new RangeError('Forex gate wait limit must be finite and non-negative.');
    const startedAt = now();
    let waited = false;
    // No slots are reserved here: concurrent readers may all proceed when the
    // provider cooldown expires. Recheck after every sleep in case it extended.
    for (;;) {
      const current = now();
      const delayMs = Math.max(0, (cooldownUntil.get(key) || 0) - current);
      if (!Number.isFinite(current) || current < startedAt || current + delayMs > startedAt + maxWaitMs) {
        const error = new Error('Forex provider cooldown exceeds the local wait limit.');
        error.code = 'FOREX_COOLDOWN_DEFERRED';
        error.cooldownDelayMs = Math.max(0, current - startedAt);
        throw error;
      }
      if (delayMs === 0) return { cooldownDelayMs: waited ? Math.max(0, current - startedAt) : 0 };
      await sleep(delayMs);
      if (now() <= current) {
        const error = new Error('Forex request-gate clock did not advance during cooldown.');
        error.code = 'FOREX_GATE_CLOCK_STALLED';
        throw error;
      }
      waited = true;
    }
  }
  wait.defer = (provider, delayMs) => {
    const key = String(provider || '').trim();
    if (!key) throw new TypeError('Forex request gate requires a provider identity.');
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError('Forex cooldown must be a finite non-negative duration.');
    const until = now() + delayMs;
    cooldownUntil.set(key, Math.max(cooldownUntil.get(key) || 0, until));
    return cooldownUntil.get(key);
  };
  return wait;
}

const defaultForexRequestGate = createForexRequestGate();

export async function requestForexJson(url, {
  fetcher = fetch, headers = {}, metrics = [], operation = 'market-data',
  timeoutMs = 12_000, clock = Date.now, provider = 'OANDA practice', instrument = null, relatedInstrument = null, instruments = [],
  maxAttempts = 3, maxRetryWaitMs = 10_000, maxGateWaitMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
  requestGate = defaultForexRequestGate,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError('Forex maxAttempts must be from 1 to 5.');
  if (!Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) throw new RangeError('Forex retry wait limit must be non-negative.');
  if (requestGate !== null && (typeof requestGate !== 'function' || typeof requestGate.defer !== 'function')) {
    throw new TypeError('Forex request gate must be a callable gate with a defer method.');
  }
  if (!Number.isFinite(maxGateWaitMs) || maxGateWaitMs < 0) throw new RangeError('Forex gate wait limit must be finite and non-negative.');
  const safePair = (value) => typeof value === 'string' && /^[A-Z]{3}_[A-Z]{3}$/i.test(value) ? value.toUpperCase() : null;
  const requestContext = {
    ...(safePair(instrument) ? { instrument: safePair(instrument) } : {}),
    ...(safePair(relatedInstrument) ? { relatedInstrument: safePair(relatedInstrument) } : {}),
    ...(Array.isArray(instruments) && instruments.length ? { instruments: [...new Set(instruments.map(safePair).filter(Boolean))].slice(0, 50) } : {}),
  };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let gateWait;
    try { gateWait = requestGate ? await requestGate(provider, { maxWaitMs: maxGateWaitMs }) : { cooldownDelayMs: 0 }; }
    catch (error) {
      const failure = new Error('Forex provider request deferred by the local request gate.');
      failure.code = error.code === 'FOREX_COOLDOWN_DEFERRED' ? error.code : 'FOREX_GATE_FAILED';
      failure.providerOperation = operation;
      if (requestContext.instrument) failure.providerInstrument = requestContext.instrument;
      if (requestContext.relatedInstrument) failure.providerRelatedInstrument = requestContext.relatedInstrument;
      metrics.push({ provider, operation, ...requestContext, status: 0, requestAttempted: false,
        latencyMs: 0, attempt: attempt + 1, cooldownDelayMs: error.cooldownDelayMs ?? 0,
        code: failure.code, error: failure.message });
      throw failure;
    }
    const startedAt = clock();
    let response;
    try {
      response = await fetcher(url, { headers: { ...headers, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      const status = Number(response.status) || 0;
      const rateLimit = readProviderRateLimit(response.headers);
      if (!response.ok) {
        const error = new Error(`${provider} ${operation} returned HTTP ${status}.`);
        error.status = status;
        throw error;
      }
      const payload = await response.json();
      metrics.push({ provider, operation, ...requestContext, status, requestStartedAt: startedAt,
        latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1,
        cooldownDelayMs: gateWait.cooldownDelayMs, ...(rateLimit ? { rateLimit } : {}) });
      return payload;
    } catch (error) {
      const status = Number(response?.status || error.status) || 0;
      const rateLimit = readProviderRateLimit(response?.headers);
      const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
      const failure = new Error(message, { cause: error });
      failure.status = status || undefined;
      failure.providerOperation = operation;
      if (requestContext.instrument) failure.providerInstrument = requestContext.instrument;
      if (requestContext.relatedInstrument) failure.providerRelatedInstrument = requestContext.relatedInstrument;
      let delayMs = null;
      let cooldownMs = null;
      if (status === 429 && requestGate) {
        cooldownMs = retryDelayMs(response?.headers, clock(), attempt, random);
        requestGate.defer(provider, cooldownMs);
      }
      if (attempt + 1 < maxAttempts && isRetryable(error, status)) {
        delayMs = cooldownMs ?? retryDelayMs(response?.headers, clock(), attempt, random);
        if (delayMs > maxRetryWaitMs) {
          failure.message = `${message} Retry deferred because the required wait exceeds the local retry limit.`;
          delayMs = null;
        }
      }
      metrics.push({ provider, operation, ...requestContext, status, requestStartedAt: startedAt,
        latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1,
        cooldownDelayMs: gateWait.cooldownDelayMs,
        ...(rateLimit ? { rateLimit } : {}), ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), error: failure.message });
      if (delayMs === null) throw failure;
      if (!(status === 429 && requestGate)) await sleep(delayMs);
    }
  }
  throw new Error(`${provider} ${operation} failed after bounded retries.`);
}
