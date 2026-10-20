import { alpacaThrottleDelayMs, waitForAlpacaRequest } from './alpacaRequestGate.js';

/** Bounded GET helper for historical Alpaca backfills. Secrets stay in headers and out of errors. */
export async function requestAlpacaBackfillJson(url, {
  fetchImpl = fetch, keyId, secretKey,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now, maxAttempts = 5, maxRetryWaitMs = 30_000, requestGate = waitForAlpacaRequest,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function') {
    throw new TypeError('Alpaca backfill request dependencies must be functions.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5
    || !Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) throw new RangeError('Alpaca backfill retry policy is invalid.');
  if (!keyId || !secretKey) throw new Error('Alpaca backfill credentials are required.');

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    const grant = await requestGate?.(keyId);
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
        signal: AbortSignal.timeout(30_000),
      });
      await requestGate?.observe?.(keyId, response.headers, { reservationId: grant?.reservationId, status: response.status });
      if (!response.ok) {
        const error = new Error(`Alpaca historical endpoint returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || response?.status) || 0;
      const retryable = status === 429 || status >= 500
        || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
      const providerDelay = status === 429 ? alpacaThrottleDelayMs(response?.headers, now(), 1_000) : null;
      if (providerDelay !== null) await requestGate?.defer?.(keyId, providerDelay);
      if (!retryable || attempt + 1 >= maxAttempts) break;
      const delayMs = providerDelay ?? (1_000 * (2 ** attempt));
      if (delayMs > maxRetryWaitMs) break;
      await sleep(delayMs);
    }
  }
  throw lastError;
}
