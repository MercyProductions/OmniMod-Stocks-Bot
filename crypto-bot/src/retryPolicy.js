/** Build a bounded retry plan while never retrying before a valid Retry-After. */
export function retryPlan(retryAfterHeader, attempt, {
  now = Date.now(), serverDateHeader = null, baseDelayMs = 500, maxRetryDelayMs = 5_000,
} = {}) {
  if (!Number.isInteger(attempt) || attempt < 0 || !Number.isFinite(now)
    || !Number.isFinite(baseDelayMs) || baseDelayMs < 0
    || !Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < 0)
    throw new RangeError('Retry policy inputs are invalid.');

  const raw = String(retryAfterHeader ?? '').trim();
  let requestedDelayMs = null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) requestedDelayMs = Number(raw) * 1000;
  else if (raw) {
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      const serverNow = Date.parse(String(serverDateHeader || ''));
      requestedDelayMs = Math.max(0, retryAt - (Number.isFinite(serverNow) ? serverNow : now));
    }
  }

  const fromHeader = Number.isFinite(requestedDelayMs);
  const delayMs = fromHeader ? Math.ceil(requestedDelayMs)
    : Math.min(maxRetryDelayMs, baseDelayMs * (2 ** attempt));
  return { delayMs, source: fromHeader ? 'retry-after' : 'exponential-backoff',
    retry: delayMs <= maxRetryDelayMs };
}

/** Retry provider throttles, server errors, and transient fetch transport failures only. */
export function isRetryableProviderFailure(error) {
  const status = Number(error?.status);
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)
    || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
}
