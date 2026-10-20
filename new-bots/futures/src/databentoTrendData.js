import { readProviderRateLimit } from '../../shared/providerRateLimit.js';
import { fetchDatabentoCostEstimate, fetchWithRateLimitRetry } from './databentoMarketData.js';
import { FUTURES_H1_VERSION, HOUR_MS, inspectH1Contract, normalizeH1History, validateH1Policy } from './databentoH1Normalization.js';
import { h1Fingerprint, withDatabentoH1Cache } from './databentoH1Cache.js';

const API = 'https://hist.databento.com/v0';
const provider = 'Databento Historical';
const iso = (at) => new Date(at).toISOString();

export function normalizeDatabentoH1TrendBars(dayTrades, records, options = {}) {
  return normalizeH1History(dayTrades, records, options).rows;
}

function parseRecords(body, maxRecords) {
  const lines = body.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > maxRecords) throw new Error('Databento H1 record limit exceeded.');
  if (!lines.length) throw new Error('Databento H1 response is empty.');
  return lines.map((line) => {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      return row;
    } catch { throw new Error('Databento returned malformed H1 bar.'); }
  });
}

async function readBoundedBody(response, { maxBytes, maxRecords, started, clock, timeoutMs }) {
  let body = '', bytes = 0, lines = 0;
  const check = () => {
    if (bytes > maxBytes) throw new Error('Databento H1 byte limit exceeded.');
    if (lines > maxRecords + 1) throw new Error('Databento H1 record limit exceeded.');
    if (clock() - started >= timeoutMs) throw new Error('Databento H1 download timed out.');
  };
  try {
    if (response.body?.[Symbol.asyncIterator]) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of response.body) {
        bytes += chunk.byteLength; check();
        const text = decoder.decode(chunk, { stream: true });
        lines += (text.match(/\n/g) || []).length; check(); body += text;
      }
      body += decoder.decode();
    } else { // Minimal injected test transports; production fetch always supplies a stream.
      body = await response.text(); bytes = Buffer.byteLength(body); lines = (body.match(/\n/g) || []).length;
    }
    check();
    parseRecords(body, maxRecords);
    return body;
  } catch (error) { await response.body?.cancel?.().catch(() => {}); throw error; }
}

/** Exact, verified raw-contract H1 history. Fixed hour windows are reused; approval gates are unchanged. */
export async function fetchDatabentoFuturesH1Trend(dayTrades, {
  apiKey = '', dataset = 'GLBX.MDP3', now = Date.now(), maxScanCostUsd = 0,
  lookbackDays = 7, minBars = 50, maxBars = 200, fetcher = fetch, metrics = [], clock = Date.now, sleep,
  cachePath = null, maxBytes = 64 * 1024 ** 2, maxRecords = 100_000, timeoutMs = 20_000,
} = {}) {
  if (!Array.isArray(dayTrades)) throw new TypeError('Futures day-trade rows must be an array.');
  if (!Array.isArray(metrics)) throw new TypeError('Provider metrics must be an array.');
  validateH1Policy({ now, minBars, maxBars });
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid Databento dataset identifier.');
  if (!Number.isInteger(lookbackDays) || lookbackDays < 3 || lookbackDays > 30
    || typeof maxScanCostUsd !== 'number' || !Number.isFinite(maxScanCostUsd) || maxScanCostUsd < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 ** 2
    || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100_000
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new RangeError('Invalid bounded H1 history policy.');
  const scanStarted = clock(), observedNow = () => now + Math.max(0, clock() - scanStarted);
  const inspections = dayTrades.map((row) => inspectH1Contract(row, { now, dataset }));
  const eligible = dayTrades.filter((_, i) => inspections[i].valid), preflightRejectionReasons = {};
  for (const inspection of inspections.filter((x) => !x.valid)) for (const reason of ['verified_active_contract_metadata_invalid', ...inspection.reasons])
    preflightRejectionReasons[reason] = (preflightRejectionReasons[reason] || 0) + 1;
  const symbols = [...new Set(eligible.map((row) => row.contract.providerRawSymbol.trim().toUpperCase()))].sort();
  const base = { version: FUTURES_H1_VERSION, requested: dayTrades.length, eligible: eligible.length,
    metadataRejected: dayTrades.length - eligible.length, preflightRejectionReasons, symbols: symbols.length, complete: 0 };
  if (!dayTrades.length) return { rows: [], diagnostics: { ...base, status: 'no_day_trades' } };
  if (!symbols.length) return { rows: dayTrades.map((row) => ({ ...row, trendBars: [], trendDataStatus: 'contract_metadata_unavailable', trendDataReasons: ['verified_active_contract_metadata_invalid'] })),
    diagnostics: { ...base, status: 'contract_metadata_unavailable' } };
  if (!apiKey) return { rows: dayTrades.map((row) => ({ ...row, trendBars: [], trendDataStatus: 'credentials_missing', trendDataReasons: ['databento_credentials_missing'] })),
    diagnostics: { ...base, status: 'credentials_missing' } };
  if (symbols.length > 100) throw new RangeError('Databento H1 history is capped at 100 distinct active-contract symbols per scan.');
  const end = iso(Math.floor(now / HOUR_MS) * HOUR_MS), start = iso(Date.parse(end) - lookbackDays * 86_400_000);
  const params = { dataset, symbols: symbols.join(','), stype_in: 'raw_symbol', schema: 'ohlcv-1h', start, end };
  const headers = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json, application/x-ndjson' };
  const key = h1Fingerprint(JSON.stringify([FUTURES_H1_VERSION, apiKey, params]));
  const fetched = await withDatabentoH1Cache({ cachePath, key, maxBytes, now: observedNow }, async (markAttempt) => {
    // A valid cached response is free to reuse even if earlier stages exhausted this scan's allowance.
    if (!(typeof maxScanCostUsd === 'number' && Number.isFinite(maxScanCostUsd) && maxScanCostUsd > 0)) throw new RangeError('H1 history requires a positive remaining cost cap.');
    let estimate, estimatedCostUsd;
    try {
      estimate = await fetchDatabentoCostEstimate(fetcher, `${API}/metadata.get_cost?${new URLSearchParams(params)}`,
        { headers, signal: AbortSignal.timeout(12_000) }, { sleep, clock, onAttempt: ({ status, headers: h, latencyMs, attempt }) => {
          metrics.push({ provider, operation: 'h1-cost-estimate', status, latencyMs,
            ...(attempt ? { retry: true, attempt: attempt + 1 } : {}), ...(readProviderRateLimit(h) ? { rateLimit: readProviderRateLimit(h) } : {}) });
        } });
      if (!estimate.ok) throw new Error();
      const body = (await estimate.text()).trim();
      estimatedCostUsd = body && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(body) ? Number(body) : NaN;
    } catch { throw new Error('Databento H1 cost estimate failed.'); }
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('Databento returned an invalid H1 cost estimate.');
    const estimatedMetric = { provider, operation: 'estimated-h1-cost', status: 200, latencyMs: 0,
      estimatedCostUsd, configuredCapUsd: maxScanCostUsd, budgetReserved: false };
    metrics.push(estimatedMetric);
    if (estimatedCostUsd > maxScanCostUsd) throw new Error('Databento H1 estimate exceeds remaining scan cap.');
    await markAttempt();
    estimatedMetric.budgetReserved = true;
    const form = new URLSearchParams({ ...params, encoding: 'json', compression: 'none',
      pretty_px: 'true', pretty_ts: 'true', map_symbols: 'true' });
    const downloadStarted = clock();
    let response;
    try {
      // Preserve one explicit, bounded 429 backoff. Transport/partial stream failures are never retried.
      response = await fetchWithRateLimitRetry(fetcher, `${API}/timeseries.get_range`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(timeoutMs) },
      { clock, sleep, onRetry: ({ status, headers: h, delayMs, latencyMs }) => metrics.push({ provider,
        operation: 'h1-bars', status, latencyMs, retry: true, retryDelayMs: delayMs,
        ...(readProviderRateLimit(h) ? { rateLimit: readProviderRateLimit(h) } : {}) }) });
      if (!response.ok) throw new Error(`Databento H1 HTTP ${response.status}.`);
      const body = await readBoundedBody(response, { maxBytes, maxRecords, started: downloadStarted, clock, timeoutMs });
      metrics.push({ provider, operation: 'h1-bars', status: response.status, latencyMs: Math.max(0, clock() - downloadStarted),
        records: parseRecords(body, maxRecords).length, ...(readProviderRateLimit(response.headers) ? { rateLimit: readProviderRateLimit(response.headers) } : {}) });
      return { body, sourceEstimatedCostUsd: estimatedCostUsd };
    } catch (error) {
      await response?.body?.cancel?.().catch(() => {});
      const safe = /^(?:Databento H1 (?:HTTP \d+|byte limit exceeded|record limit exceeded|download timed out|response is empty)\.|Databento returned malformed H1 bar\.)$/.test(error.message)
        ? error.message : 'Databento H1 stream failed.';
      metrics.push({ provider, operation: 'h1-bars', status: response?.ok ? 0 : response?.status || 0,
        latencyMs: Math.max(0, clock() - downloadStarted), error: safe,
        ...(readProviderRateLimit(response?.headers) ? { rateLimit: readProviderRateLimit(response.headers) } : {}) });
      throw new Error(safe);
    }
  });
  const normalized = normalizeH1History(dayTrades, parseRecords(fetched.body, maxRecords), { now: observedNow(), minBars, maxBars, dataset, start, end });
  const complete = normalized.rows.filter((row) => row.trendDataStatus === 'complete').length;
  return { rows: normalized.rows, metrics, diagnostics: { ...base, ...normalized.diagnostics, status: complete === dayTrades.length ? 'complete' : 'partial', complete,
    estimatedCostUsd: fetched.cached ? 0 : fetched.sourceEstimatedCostUsd, sourceEstimatedCostUsd: fetched.sourceEstimatedCostUsd,
    remainingScanCostCapUsd: maxScanCostUsd, start, end, evaluatedAt: iso(observedNow()),
    cache: { enabled: fetched.cacheEnabled, hit: fetched.cached, sha256: fetched.sha256 || h1Fingerprint(fetched.body), capturedAt: fetched.capturedAt || iso(observedNow()) } } };
}
