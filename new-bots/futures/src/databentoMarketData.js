import { readProviderRateLimit } from '../../shared/providerRateLimit.js';

const HISTORICAL_API = 'https://hist.databento.com/v0';

function cleanError(error) {
  return String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[provider-url]').slice(0, 180);
}

function authHeaders(apiKey) {
  return { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json, application/x-ndjson' };
}

function retryAfterMs(headers, now = Date.now()) {
  const raw = headers?.get?.('Retry-After');
  if (raw == null || String(raw).trim() === '') return null;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

export async function fetchWithRateLimitRetry(fetcher, url, options, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now, onRetry = () => {} } = {}) {
  const startedAt = clock();
  const response = await fetcher(url, options);
  if (response.status !== 429) return response;
  const delayMs = retryAfterMs(response.headers, clock());
  // Honor explicit provider backoff once. Never spin on rate limits or guess a delay.
  if (delayMs === null || delayMs > 10_000) return response;
  onRetry({ status: response.status, headers: response.headers, delayMs, latencyMs: Math.max(0, clock() - startedAt) });
  await sleep(delayMs);
  return fetcher(url, options);
}

// Cost-estimate metadata is free and read-only. It can be retried on transient
// transport/server failures; paid timeseries downloads deliberately cannot,
// because repeating a partially delivered stream may incur another charge.
export async function fetchDatabentoCostEstimate(fetcher, url, options, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now, onAttempt = () => {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = clock();
    let response;
    try {
      response = await fetcher(url, options);
      onAttempt({ status: response.status, headers: response.headers, latencyMs: Math.max(0, clock() - startedAt), attempt });
      const retryAfter = response.status === 429 ? retryAfterMs(response.headers, clock()) : null;
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryable || attempt === 2) return response;
      const delayMs = response.status === 429 ? retryAfter : Math.min(5_000, 1_000 * 2 ** attempt);
      if (!Number.isFinite(delayMs) || delayMs > 10_000) return response;
      await sleep(delayMs);
    } catch (error) {
      onAttempt({ status: Number(response?.status) || 0, headers: response?.headers, latencyMs: Math.max(0, clock() - startedAt), attempt,
        error: cleanError(error) });
      lastError = error;
      if (!['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name) || attempt === 2) throw error;
      await sleep(Math.min(5_000, 1_000 * 2 ** attempt));
    }
  }
  throw lastError || new Error('Databento cost estimate failed after bounded retries.');
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Databento range contains an invalid timestamp.');
  return date.toISOString();
}

export function parseDatabentoJsonLines(body) {
  return String(body).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Databento returned malformed JSON record ${index + 1}.`); }
  });
}

export function normalizeDatabentoFutures(universe, intradayRecords, dailyRecords, { now = Date.now(), maxAgeSeconds = 180 } = {}) {
  const requested = universe.map((row) => ({ ...row, continuousSymbol: String(row.providerSymbol || '').trim().toUpperCase() }))
    .sort((a, b) => b.continuousSymbol.split('.')[0].length - a.continuousSymbol.split('.')[0].length);
  const rootFor = (record) => {
    const mapped = String(record.symbol || record.raw_symbol || '').trim().toUpperCase();
    return requested.find((row) => mapped.startsWith(row.continuousSymbol.split('.')[0])) || null;
  };
  const barFrom = (record) => {
    const time = record.ts_event || record.ts_recv || record.hd?.ts_event;
    const timestamp = Date.parse(time);
    const bar = { timestamp, open: Number(record.open), high: Number(record.high), low: Number(record.low), close: Number(record.close), volume: Number(record.volume) };
    if (!Number.isFinite(timestamp) || ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
      || bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0
      || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) return null;
    return { ...bar, mappedSymbol: String(record.symbol || record.raw_symbol || '').trim(), instrumentId: record.instrument_id ?? record.hd?.instrument_id ?? null };
  };
  const intradayByRoot = new Map(), dailyByRoot = new Map();
  for (const [records, target] of [[intradayRecords, intradayByRoot], [dailyRecords, dailyByRoot]]) for (const record of records) {
    const row = rootFor(record), bar = barFrom(record);
    if (!row || !bar) continue;
    const key = row.symbol.toUpperCase(), values = target.get(key) || [];
    values.push(bar); target.set(key, values);
  }
  return requested.map((row) => {
    const intraday = (intradayByRoot.get(row.symbol.toUpperCase()) || []).sort((a, b) => a.timestamp - b.timestamp);
    const daily = (dailyByRoot.get(row.symbol.toUpperCase()) || []).sort((a, b) => a.timestamp - b.timestamp);
    const latest = intraday.at(-1), priorDay = daily.at(-2), lastDay = daily.at(-1);
    const ageSeconds = latest ? (now - latest.timestamp) / 1000 : Infinity;
    const futureDated = ageSeconds < -60;
    if (!latest || !lastDay) return { ...row, source: 'Databento GLBX.MDP3', providerStatus: 'no-usable-bars', providerError: 'No valid mapped intraday and daily bars were returned.', observedAt: null, stale: true, contractMode: 'continuous-proxy', contractSpecVerified: false };
    return {
      ...row,
      providerSymbol: latest.mappedSymbol || row.continuousSymbol,
      requestedContinuousSymbol: row.continuousSymbol,
      providerInstrumentId: String(latest.instrumentId ?? ''),
      price: latest.close,
      return1dPct: priorDay?.close > 0 ? Number(((lastDay.close / priorDay.close - 1) * 100).toFixed(4)) : null,
      return5dPct: daily.length >= 6 ? Number(((daily.at(-1).close / daily.at(-6).close - 1) * 100).toFixed(4)) : null,
      volatility20dPct: daily.length >= 21 ? Number((Math.sqrt(daily.slice(-20).reduce((sum, bar, index, slice) => {
        if (!index) return sum;
        const move = Math.log(bar.close / slice[index - 1].close);
        return sum + move * move;
      }, 0) / 19) * Math.sqrt(252) * 100).toFixed(4)) : null,
      observedAt: new Date(latest.timestamp).toISOString(),
      providerAgeSeconds: ageSeconds < 0 ? null : Number(ageSeconds.toFixed(1)), stale: futureDated || ageSeconds > maxAgeSeconds,
      source: 'Databento GLBX.MDP3 historical API polling', delayed: false,
      contractMode: 'continuous-proxy', contractSpecVerified: false,
      intradayBarCount: intraday.length, dailyBarCount: daily.length,
      dataNote: futureDated ? 'Latest provider bar is future-dated; observation rejected as stale.' : 'Continuous-symbol observations are research context; they do not verify tradable contract specs, executable bid/ask, or broker margin.'
    };
  });
}

async function requestCost({ apiKey, dataset, symbols, schema, start, end, fetcher, metrics, clock, sleep }) {
  const query = new URLSearchParams({ dataset, symbols: symbols.join(','), stype_in: 'continuous', schema, start: asIso(start), end: asIso(end) });
  const startedAt = clock();
  let response, body;
  try {
    response = await fetchDatabentoCostEstimate(fetcher, `${HISTORICAL_API}/metadata.get_cost?${query}`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(12_000) }, {
      sleep, clock, onAttempt: ({ status, headers, latencyMs, attempt, error }) => {
        const rateLimit = readProviderRateLimit(headers);
        metrics.push({ provider: 'Databento', operation: `cost-${schema}`, status, latencyMs,
          ...(attempt ? { retry: true, attempt: attempt + 1 } : {}), ...(rateLimit ? { rateLimit } : {}), ...(error ? { error } : {}) });
      }
    });
    body = await response.text();
  } catch (error) {
    const message = cleanError(error);
    if (response) metrics.push({ provider: 'Databento', operation: `cost-${schema}-body`, status: 0, latencyMs: Math.max(0, clock() - startedAt), error: message });
    throw new Error(`Databento cost estimate request failed: ${message}`);
  }
  const rateLimit = readProviderRateLimit(response.headers);
  if (!response.ok) throw new Error(`Databento cost estimate HTTP ${response.status}: ${cleanError(body).slice(0, 100)}`);
  const costUsd = Number(body.trim());
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('Databento returned an invalid cost estimate.');
  return costUsd;
}

async function requestBars({ apiKey, dataset, symbols, schema, start, end, fetcher, metrics, clock, sleep }) {
  const fields = new URLSearchParams({ dataset, symbols: symbols.join(','), stype_in: 'continuous', schema, start: asIso(start), end: asIso(end), encoding: 'json', pretty_px: 'true', pretty_ts: 'true', map_symbols: 'true' });
  const startedAt = clock();
  let response, body;
  try {
    response = await fetchWithRateLimitRetry(fetcher, `${HISTORICAL_API}/timeseries.get_range`, { method: 'POST', headers: { ...authHeaders(apiKey), 'content-type': 'application/x-www-form-urlencoded' }, body: fields, signal: AbortSignal.timeout(20_000) }, { sleep, clock });
    body = await response.text();
  } catch (error) {
    const message = cleanError(error);
    metrics.push({ provider: 'Databento', operation: `bars-${schema}`, status: 0, latencyMs: Math.max(0, clock() - startedAt), records: null, error: message });
    throw new Error(`Databento ${schema} request failed: ${message}`);
  }
  const rateLimit = readProviderRateLimit(response.headers);
  metrics.push({ provider: 'Databento', operation: `bars-${schema}`, status: response.status, latencyMs: Math.max(0, clock() - startedAt), records: response.ok ? body.split(/\r?\n/).filter(Boolean).length : null, ...(rateLimit ? { rateLimit } : {}) });
  if (!response.ok) throw new Error(`Databento ${schema} HTTP ${response.status}: ${cleanError(body).slice(0, 140)}`);
  return parseDatabentoJsonLines(body);
}

export async function fetchDatabentoUniverse(universe, {
  apiKey = '', dataset = 'GLBX.MDP3', maxScanCostUsd = 0, maxAgeSeconds = 180,
  now = Date.now(), fetcher = fetch, metrics = [], clock = Date.now, sleep
} = {}) {
  if (!Array.isArray(universe) || !universe.length) return [];
  if (!apiKey) throw new Error('DATABENTO_API_KEY is required for Databento Futures data.');
  if (!(Number.isFinite(Number(maxScanCostUsd)) && Number(maxScanCostUsd) > 0)) throw new Error('FUTURES_MAX_SCAN_COST_USD must be greater than zero; data downloads are disabled without an explicit scan cap.');
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new Error('Invalid Databento dataset code.');
  const symbols = [...new Set(universe.map((row) => String(row.providerSymbol || '').trim()).filter((symbol) => /^[A-Z0-9]+\.[cnv]\.\d{1,2}$/.test(symbol)))];
  if (!symbols.length || symbols.length !== universe.length) throw new Error('Futures providerSymbol values must use Databento continuous symbology such as ES.v.0.');
  const end = new Date(now), startIntraday = new Date(end.getTime() - 2 * 86_400_000), startDaily = new Date(end.getTime() - 35 * 86_400_000);
  const call = { apiKey, dataset, symbols, fetcher, metrics, clock, sleep };
  const costs = await Promise.all([
    requestCost({ ...call, schema: 'ohlcv-1m', start: startIntraday, end }),
    requestCost({ ...call, schema: 'ohlcv-1d', start: startDaily, end })
  ]);
  const estimatedCostUsd = costs.reduce((sum, value) => sum + value, 0);
  metrics.push({ provider: 'Databento', operation: 'estimated-scan-cost', status: 200, latencyMs: 0, estimatedCostUsd, configuredCapUsd: Number(maxScanCostUsd) });
  if (estimatedCostUsd > maxScanCostUsd) throw new Error(`Databento scan blocked: estimated $${estimatedCostUsd.toFixed(6)} exceeds configured cap $${Number(maxScanCostUsd).toFixed(6)}.`);
  const [intraday, daily] = await Promise.all([
    requestBars({ ...call, schema: 'ohlcv-1m', start: startIntraday, end }),
    requestBars({ ...call, schema: 'ohlcv-1d', start: startDaily, end })
  ]);
  const observations = normalizeDatabentoFutures(universe, intraday, daily, { now, maxAgeSeconds });
  return observations;
}
