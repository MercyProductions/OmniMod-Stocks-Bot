import { waitForTradierStartSlot, readTradierRateLimit as readRateLimitHeaders } from './tradierSharedBudget.js';
import { createHash } from 'node:crypto';

export function tradierEndpointName(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('/clock')) return 'market-clock';
  if (path.endsWith('/quotes')) return 'underlying-quotes';
  if (path.endsWith('/expirations')) return 'option-expirations';
  if (path.endsWith('/chains')) return 'option-chains';
  return 'market-data';
}

function retryDelayMs(headers, now, attempt, random) {
  const read = (name) => headers?.get?.(name) ?? null;
  const retryAfter = read('Retry-After');
  if (retryAfter != null && String(retryAfter).trim()) {
    const seconds = Number(retryAfter), date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const expiry = Number(read('X-Ratelimit-Expiry'));
  if (Number.isFinite(expiry) && expiry > 0) return Math.max(0, expiry - now) + Math.floor(random() * 250);
  return Math.min(500 * (2 ** attempt), 8_000) + Math.floor(random() * 250);
}

export async function requestTradierWithRetry(args, { fetchImpl = fetch, token, environment = 'production', operation = tradierEndpointName(args[0]), providerMetrics = [],
  clockNow = Date.now, retrySleep = ms => new Promise(done => setTimeout(done, ms)), random = Math.random,
  maxAttempts = 3, maxRetryWaitMs = 10000, onRequest = () => {}, startPacer = waitForTradierStartSlot, deadline = Infinity } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0
    || !Array.isArray(providerMetrics) || typeof token !== 'string' || !token.trim()) throw new RangeError('Tradier request settings are invalid.');
  const url = new URL(args[0]);
  const authorization = new Headers(args[1]?.headers).get('Authorization');
  if (!['production', 'sandbox'].includes(environment) || url.protocol !== 'https:' || url.username || url.password || url.port
    || url.hostname !== (environment === 'production' ? 'api.tradier.com' : 'sandbox.tradier.com')
    || !url.pathname.startsWith('/v1/markets/') || String(args[1]?.method || 'GET').toUpperCase() !== 'GET'
    || authorization !== `Bearer ${token}`)
    throw Object.assign(new Error('Only read-only Tradier market-data requests are supported.'), { code: 'TRADIER_MARKET_REQUEST_INVALID' });
  const effectiveWaitLimit = Math.min(maxRetryWaitMs, operation.includes('market-clock') ? 5000 : 10000);
  let retryCooldownDelayMs = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let paced, response, attemptMetric, requestAttempted = false, startedAt = clockNow();
    const cooldownDelayMs = retryCooldownDelayMs; retryCooldownDelayMs = 0;
    try {
      if (clockNow() >= deadline) throw Object.assign(new Error('Tradier research time budget reached.'), { code: 'TRADIER_RESEARCH_DEADLINE' });
      paced = await startPacer(token, environment, { maxWaitMs: Math.max(0, Math.min(10000, deadline - clockNow())) });
      if (clockNow() >= deadline) throw Object.assign(new Error('Tradier research time budget reached.'), { code: 'TRADIER_RESEARCH_DEADLINE' });
      onRequest(); startedAt = clockNow(); requestAttempted = true;
      response = await fetchImpl(...args);
      await startPacer.observe?.(token, environment, response.headers, { reservationId: paced.reservationId, status: response.status });
      const status = Number(response.status) || 0;
      const throttleDelay = status === 429 ? retryDelayMs(response.headers, clockNow(), attempt, random) : null;
      if (throttleDelay !== null) await startPacer.deferStarts?.(token, environment, throttleDelay);
      let delayMs = null, deferred = false;
      if ((status === 429 || status >= 500) && attempt + 1 < maxAttempts) {
        delayMs = throttleDelay ?? retryDelayMs(response.headers, clockNow(), attempt, random);
        if (delayMs > effectiveWaitLimit || clockNow() + delayMs >= deadline) { delayMs = null; deferred = true; }
      }
      attemptMetric = { provider: 'Tradier', operation, status, latencyMs: Math.max(0, clockNow() - startedAt),
        localQueueDelayMs: paced.localQueueDelayMs, cooldownDelayMs, rateLimit: readRateLimitHeaders(response.headers), attempt: attempt + 1,
        ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), ...(deferred ? { retryDeferred: true } : {}),
        ...(!response.ok ? { error: `HTTP ${status}${deferred ? '; retry deferred beyond local wait limit' : ''}` } : {}) };
      providerMetrics.push(attemptMetric);
      if (delayMs === null) return response;
      const waitStartedAt = clockNow(); await retrySleep(delayMs); retryCooldownDelayMs = Math.max(0, clockNow() - waitStartedAt);
    } catch (error) {
      const message = String(error.message || error).replaceAll(token, '[redacted]').replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
      if (attemptMetric) {
        attemptMetric.retryInterrupted = true;
        throw Object.assign(new Error(message, { cause: error }), { ...(error.code ? { code: error.code } : {}), status: Number(response?.status || error.status) || 0 });
      }
      let delayMs = null, deferred = false;
      if (requestAttempted && !response && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) && attempt + 1 < maxAttempts) {
        delayMs = retryDelayMs(null, clockNow(), attempt, random);
        if (delayMs > effectiveWaitLimit || clockNow() + delayMs >= deadline) { delayMs = null; deferred = true; }
      }
      providerMetrics.push({ provider: 'Tradier', operation, status: Number(response?.status || error.status) || 0,
        latencyMs: Math.max(0, clockNow() - startedAt), localQueueDelayMs: paced?.localQueueDelayMs ?? null, cooldownDelayMs,
        rateLimit: readRateLimitHeaders(response?.headers), attempt: attempt + 1,
        ...(!requestAttempted ? { requestAttempted: false, budgetRejection: error.code || 'TRADIER_BUDGET_UNAVAILABLE' } : {}),
        ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), ...(deferred ? { retryDeferred: true } : {}), error: message });
      if (delayMs === null) throw Object.assign(new Error(message, { cause: error }), { ...(error.code ? { code: error.code } : {}), status: Number(response?.status || error.status) || 0 });
      const waitStartedAt = clockNow(); await retrySleep(delayMs); retryCooldownDelayMs = Math.max(0, clockNow() - waitStartedAt);
    }
  }
  throw new Error(`Tradier ${operation} failed after bounded retries.`);
}

const managedFetches = new WeakMap();
/** One transport boundary even when a high-level input reader calls a chain reader. */
export function createTradierMarketFetch({ fetchImpl = fetch, token, environment = 'production', operation, ...options } = {}) {
  const scope = createHash('sha256').update(`${environment}:${token}`).digest('hex');
  if (managedFetches.get(fetchImpl) === scope) return fetchImpl;
  if (managedFetches.has(fetchImpl)) throw new Error('Tradier managed transport credential/environment mismatch.');
  const wrapped = (...args) => requestTradierWithRetry(args, { ...options, token, environment, fetchImpl,
    operation: typeof operation === 'function' ? operation(args) : operation ?? tradierEndpointName(args[0]) });
  managedFetches.set(wrapped, scope);
  return wrapped;
}

