import { waitForAlpacaRequest } from './alpacaRequestGate.js';
const defaultAlpacaSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMs(headers, now, attempt, random) {
  const read = (name) => typeof headers?.get === 'function' ? headers.get(name) : null;
  const reset = Number(read('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + Math.floor(random() * 250);
  const retryAfter = read('Retry-After');
  if (retryAfter != null && String(retryAfter).trim() !== '') {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(500 * (2 ** attempt), 8_000) + Math.floor(random() * 250);
}

export function retryableAlpacaError(error, response) {
  const status = Number(response?.status || error?.status) || 0;
  return status === 429 || status >= 500 || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
}

export async function requestAlpacaJson(url, headers, fetcher, metrics, provider, {
  maxAttempts = 3, maxRetryWaitMs = 10_000,
  sleep = defaultAlpacaSleep,
  clock = Date.now, random = Math.random, requestGate = null,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError('Alpaca maxAttempts must be from 1 to 5.');
  if (!Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) throw new RangeError('Alpaca retry wait limit must be non-negative.');
  const headerKey = Object.keys(headers || {}).find((name) => name.toLowerCase() === 'apca-api-key-id');
  const credentialKey = headerKey ? headers[headerKey] : null;
  const gate = requestGate ?? (sleep === defaultAlpacaSleep && clock === Date.now ? waitForAlpacaRequest : null);
  let retryCooldownDelayMs = 0;
  let lastFailure;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let cooldownDelayMs = retryCooldownDelayMs;
    retryCooldownDelayMs = 0;
    let gateResult;
    let startedAt = clock();
    let requestAttempted = false;
    let response;
    try {
      if (credentialKey && gate) {
        gateResult = await gate(credentialKey);
        cooldownDelayMs += Number.isFinite(Number(gateResult?.cooldownDelayMs)) ? Math.max(0, Number(gateResult.cooldownDelayMs)) : 0;
      }
      startedAt = clock();
      requestAttempted = true;
      response = await fetcher(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (credentialKey) await gate?.observe?.(credentialKey, response.headers, { reservationId: gateResult?.reservationId, status: response.status });
      if (!response.ok) {
        const error = new Error(`${provider} returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      metrics.push({ provider, latencyMs: Math.max(0, clock() - startedAt), status: response.status,
        cooldownDelayMs, rateLimit: alpacaRateLimit(response.headers), attempt: attempt + 1 });
      return payload;
    } catch (error) {
      const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
      const status = Number(response?.status || error?.status) || 0;
      lastFailure = new Error(message, { cause: error });
      lastFailure.status = status;
      if (error.code) lastFailure.code = error.code;
      lastFailure.providerOperation = provider;
      const throttleDelay = status === 429 ? retryAfterMs(response?.headers, clock(), attempt, random) : null;
      let delayMs = null;
      if (attempt + 1 < maxAttempts && retryableAlpacaError(error, response)) {
        delayMs = throttleDelay ?? retryAfterMs(response?.headers, clock(), attempt, random);
        if (delayMs > maxRetryWaitMs) {
          lastFailure.message = `${message} Retry deferred until the rate window resets; required wait ${Math.ceil(delayMs)}ms exceeds the local retry limit.`;
          delayMs = null;
        }
      }
      metrics.push({ provider, latencyMs: Math.max(0, clock() - startedAt), status,
        cooldownDelayMs, rateLimit: alpacaRateLimit(response?.headers), attempt: attempt + 1,
        ...(requestAttempted ? {} : { requestAttempted: false, budgetRejection: error.code || 'ALPACA_BUDGET_UNAVAILABLE' }),
        ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), error: lastFailure.message });
      if (throttleDelay !== null && credentialKey) await gate?.defer?.(credentialKey, throttleDelay);
      if (delayMs === null) throw lastFailure;
      await sleep(delayMs);
      if (status === 429 && credentialKey && gate) retryCooldownDelayMs = delayMs;
    }
  }
  throw lastFailure;
}

export function alpacaRateLimit(headers) {
  const read = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : null;
  };
  const number = (name) => {
    const raw = read(name);
    const value = raw == null || String(raw).trim() === '' ? null : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const limit = number('X-RateLimit-Limit');
  const remaining = number('X-RateLimit-Remaining');
  const reset = number('X-RateLimit-Reset');
  if (limit === null && remaining === null && reset === null) return null;
  return { limit, remaining, reset,
    utilizationPct: limit > 0 && remaining !== null ? Number(Math.max(0, (limit - remaining) / limit * 100).toFixed(2)) : null };
}

