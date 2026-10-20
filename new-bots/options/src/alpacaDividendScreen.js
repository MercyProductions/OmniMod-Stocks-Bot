import { readProviderRateLimit } from '../../shared/providerRateLimit.js';
import { waitForAlpacaRequest } from '../../shared/alpacaRequestGate.js';

const ROOT = 'https://data.alpaca.markets/v1/corporate-actions';

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function retryDelayMs(headers, now, attempt, random) {
  const read = (name) => headers?.get?.(name) ?? null;
  const reset = Number(read('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + Math.floor(random() * 250);
  const retryAfter = read('Retry-After');
  if (retryAfter != null && String(retryAfter).trim()) {
    const seconds = Number(retryAfter), date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(500 * (2 ** attempt), 4_000) + Math.floor(random() * 250);
}

/**
 * Look for known cash-dividend ex-dates as a positive-only call-spread veto.
 * This is not a clearance feed: provider omissions/delays mean an empty result
 * must never replace the operator's fresh, cited assignment review.
 */
export async function fetchAlpacaCallDividendScreen(rows, {
  key, secret, fetcher = fetch, metrics = [], maxPages = 5,
  maxAttempts = 3, maxRetryWaitMs = 10_000, retrySleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now, random = Math.random, requestGate = waitForAlpacaRequest,
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(metrics)) throw new TypeError('Dividend screen rows and metrics must be arrays.');
  const targets = rows.filter((row) => row?.signal?.direction === 'long' && row?.chain?.expiry)
    .map((row) => ({ row, symbol: String(row.signal.underlyingSymbol ?? '').trim().toUpperCase(),
      start: row.signal.sessionDate, expiry: String(row.chain.expiry) }));
  if (!targets.length) return { rows, diagnostics: { status: 'no_call_candidates', requested: 0, pages: 0, matches: 0 } };
  if (!key || !secret) return { rows: rows.map((row) => row.signal?.direction === 'long'
    ? { ...row, assignmentDataStatus: 'credentials_missing', signal: { ...row.signal, corporateActionScreenStatus: 'credentials_missing' } } : row),
  diagnostics: { status: 'credentials_missing', requested: targets.length, pages: 0, matches: 0 } };
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new RangeError('Dividend screen maxPages must be from 1 to 20.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0) {
    throw new RangeError('Dividend screen retry settings are invalid.');
  }
  if (targets.some(({ symbol, start, expiry }) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)
    || !validDate(start) || !validDate(expiry) || expiry < start)) {
    return { rows: rows.map((row) => row.signal?.direction === 'long' ? { ...row, assignmentDataStatus: 'invalid_window', signal: { ...row.signal, corporateActionScreenStatus: 'invalid_window' } } : row),
      diagnostics: { status: 'invalid_window', requested: targets.length, pages: 0, matches: 0 } };
  }
  const symbols = [...new Set(targets.map((target) => target.symbol))];
  if (symbols.length > 12) throw new RangeError('Dividend screen is capped at 12 underlyings per scan.');
  const start = new Date(Math.min(...targets.map(({ start }) => Date.parse(`${start}T00:00:00Z`)))-365*86_400_000).toISOString().slice(0, 10);
  const end = targets.map((target) => target.expiry).sort().at(-1);
  const dividends = [];
  const incompleteSymbols = new Set();
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  let token = '', pages = 0, complete = false;
  do {
    const params = new URLSearchParams({ symbols: symbols.join(','), types: 'cash_dividend', start, end, limit: '1000', data_quality: 'all' });
    if (token) params.set('page_token', token);
    let payload;
    let pageSucceeded = false;
    for (let attempt = 0; attempt < maxAttempts && !pageSucceeded; attempt += 1) {
      let startedAt = clock(), requestAttempted = false;
      let response;
      try {
        const grant = await requestGate(key);
        startedAt = clock(); requestAttempted = true;
        response = await fetcher(`${ROOT}?${params}`, { headers, signal: AbortSignal.timeout(10_000) });
        await requestGate.observe?.(key, response.headers, { reservationId: grant?.reservationId, status: response.status });
        const status = Number(response.status) || 0;
        if (!response.ok) {
          const error = new Error(`HTTP ${status}`);
          error.status = status;
          throw error;
        }
        payload = await response.json();
        metrics.push({ provider: 'Alpaca', operation: 'corporate-actions-cash-dividends', status,
          latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1,
          ...(readProviderRateLimit(response.headers) ? { rateLimit: readProviderRateLimit(response.headers) } : {}) });
        pageSucceeded = true;
      } catch (error) {
        const status = Number(error.status || response?.status) || 0;
        const retryable = status === 429 || status >= 500 || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
        const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
        let delayMs = null;
        let deferred = false;
        if (retryable && attempt + 1 < maxAttempts) {
          delayMs = retryDelayMs(response?.headers, clock(), attempt, random);
          if (delayMs > maxRetryWaitMs) { delayMs = null; deferred = true; }
        }
        metrics.push({ provider: 'Alpaca', operation: 'corporate-actions-cash-dividends', status,
          ...(requestAttempted ? {} : { requestAttempted: false, budgetRejection: error.code || 'ALPACA_BUDGET_UNAVAILABLE' }),
          latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1,
          ...(readProviderRateLimit(response?.headers) ? { rateLimit: readProviderRateLimit(response?.headers) } : {}),
          ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), ...(deferred ? { retryDeferred: true } : {}), error: message });
        if (status === 429) await requestGate.defer?.(key, retryDelayMs(response?.headers, clock(), attempt, random));
        if (delayMs !== null) { await retrySleep(delayMs); continue; }
        return { rows: rows.map((row) => row.signal?.direction === 'long' ? { ...row, assignmentDataStatus: 'provider_error', signal: { ...row.signal, corporateActionScreenStatus: 'provider_error' } } : row),
          diagnostics: { status: 'provider_error', requested: targets.length, pages, matches: 0 } };
      }
    }
    if (!pageSucceeded) return { rows: rows.map((row) => row.signal?.direction === 'long' ? { ...row, assignmentDataStatus: 'provider_error', signal: { ...row.signal, corporateActionScreenStatus: 'provider_error' } } : row),
      diagnostics: { status: 'provider_error', requested: targets.length, pages, matches: 0 } };
    try {
      if (!Array.isArray(payload?.cash_dividends)) throw new Error('Corporate-actions response missing cash_dividends array.');
      for (const item of payload.cash_dividends) {
        const symbol = String(item?.symbol ?? '').trim().toUpperCase();
        if (!symbols.includes(symbol) || !validDate(item?.ex_date)) incompleteSymbols.add(symbols.includes(symbol) ? symbol : '*');
        else dividends.push(item);
      }
      token = String(payload.next_page_token || '');
      pages++;
    } catch (error) {
      metrics.push({ provider: 'Alpaca', operation: 'corporate-actions-cash-dividends', status: 200,
        latencyMs: 0, error: String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180) });
      return { rows: rows.map((row) => row.signal?.direction === 'long' ? { ...row, assignmentDataStatus: 'provider_error', signal: { ...row.signal, corporateActionScreenStatus: 'provider_error' } } : row),
        diagnostics: { status: 'provider_error', requested: targets.length, pages, matches: 0 } };
    }
  } while (token && pages < maxPages);
  complete = !token;
  const matches = [];
  const screened = rows.map((row) => {
    if (row.signal?.direction !== 'long') return row;
    const symbol = String(row.signal.underlyingSymbol ?? '').trim().toUpperCase();
    const target = targets.find((entry) => entry.row === row);
    if (!target) return { ...row, assignmentDataStatus: 'invalid_window' };
    if (incompleteSymbols.has('*') || incompleteSymbols.has(symbol)) return { ...row, assignmentDataStatus: 'incomplete_records',
      signal: { ...row.signal, corporateActionScreenStatus: 'incomplete_records' } };
    const event = dividends.find((item) => String(item?.symbol ?? '').trim().toUpperCase() === symbol
      && validDate(item?.ex_date) && item.ex_date >= target.start && item.ex_date <= target.expiry);
    if (event) {
      matches.push({ symbol, exDate: event.ex_date });
      return { ...row, assignmentDataStatus: 'event_detected', signal: { ...row.signal, corporateActionScreenStatus: 'pagination_complete',
        corporateActionDividendVeto: { provider: 'Alpaca', eventType: 'cash_dividend', exDate: event.ex_date } } };
    }
    return { ...row, assignmentDataStatus: complete ? 'no_event_returned_not_clearance' : 'pagination_incomplete',
      signal: { ...row.signal, corporateActionScreenStatus: complete ? 'pagination_complete' : 'pagination_incomplete' } };
  });
  return { rows: screened, diagnostics: { status: complete ? 'screened_positive_only' : 'pagination_incomplete',
    requested: targets.length, pages, matches: matches.length, matchedSymbols: matches, completePagination: complete,
    note: 'No event returned is not dividend clearance; provider processing delays are documented.' } };
}
