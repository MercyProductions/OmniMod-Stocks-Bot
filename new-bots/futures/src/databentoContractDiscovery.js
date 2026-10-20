import { readProviderRateLimit } from '../../shared/providerRateLimit.js';
import { fetchWithRateLimitRetry } from './databentoMarketData.js';
import { fetchDatabentoCostEstimate } from './databentoMarketData.js';

const HISTORICAL_API = 'https://hist.databento.com/v0';

function authHeaders(apiKey) {
  return { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json, application/x-ndjson' };
}

function parseTime(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) {
    const numeric = Number(value);
    return numeric > 1e15 ? numeric / 1e6 : numeric;
  }
  return Date.parse(value);
}

function parseJsonLines(body) {
  return String(body).split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Databento returned malformed definition ${index + 1}.`); }
  });
}

/**
 * Keep Databento's continuous volume-rank v.0 mapping as a discovery hint only.
 * Databento defines this roll as the previous trading day's highest-volume
 * expiry; it does not establish today's live liquidity, margin, or eligibility.
 */
export function normalizeDatabentoActiveContractDefinitions(products, records, { now = Date.now() } = {}) {
  if (!Array.isArray(products) || !Array.isArray(records)) throw new TypeError('Products and active contract definition records must be arrays.');
  const roots = products.map((product) => ({ ...product, root: String(product.providerSymbol || '').split('.')[0].toUpperCase() }));
  const selected = new Map();
  for (const record of records) {
    if (!['F', 'FUT', 'FUTURE'].includes(String(record.instrument_class || record.security_type || '').toUpperCase())) continue;
    const root = String(record.asset || '').trim().toUpperCase();
    const product = roots.find((row) => row.root === root);
    if (!product) continue;
    const time = parseTime(record.ts_recv ?? record.ts_event ?? 0);
    const prior = selected.get(product.symbol);
    if (prior && (!Number.isFinite(time) || time < prior.time)) continue;
    selected.set(product.symbol, { record, time });
  }
  const discoveredAt = new Date(now).toISOString();
  const contracts = [];
  for (const product of roots) {
    const match = selected.get(product.symbol);
    if (!match) continue;
    const record = match.record;
    if (String(record.security_update_action || '').toUpperCase() === 'D') continue;
    const rawSymbol = String(record.raw_symbol || '').trim().toUpperCase();
    const instrumentId = String(record.instrument_id ?? '').trim();
    const expiryMs = parseTime(record.expiration);
    if (!rawSymbol || !instrumentId || !Number.isFinite(expiryMs) || expiryMs <= now) continue;
    contracts.push({
      product: product.symbol,
      providerSymbol: product.providerSymbol,
      providerRawSymbol: String(record.raw_symbol).trim().toUpperCase(),
      providerInstrumentId: String(record.instrument_id),
      providerPublisherId: record.publisher_id == null ? null : String(record.publisher_id),
      providerExchange: String(record.exchange || '').trim() || null,
      expiry: new Date(expiryMs).toISOString(),
      providerTickSize: Number.isFinite(Number(record.min_price_increment)) && Number(record.min_price_increment) > 0
        && Number.isFinite(Number(record.display_factor)) && Number(record.display_factor) > 0
        ? Number((Number(record.min_price_increment) / Number(record.display_factor)).toPrecision(12)) : null,
      providerTickValue: Number.isFinite(Number(record.min_price_increment_amount)) && Number(record.min_price_increment_amount) > 0
        ? Number((Number(record.min_price_increment_amount) / 1e9).toPrecision(12)) : null,
      providerContractMultiplier: Number.isFinite(Number(record.contract_multiplier)) && Number(record.contract_multiplier) > 0
        ? Number(record.contract_multiplier) : null,
      definitionTimestamp: Number.isFinite(match.time) ? new Date(match.time).toISOString() : null,
      definitionSource: 'Databento continuous volume-rank v.0 definition mapping',
      volumeRankRule: 'previous-trading-session-highest-volume',
      discoveredAt,
      contractState: 'volume_ranked_definition_only',
      contractSpecVerified: false,
      tradeEligible: false,
      unverifiedFields: ['current-session liquidity', 'broker-verified tick value and contract multiplier', 'initial margin', 'maintenance margin', 'session calendar', 'executable quote and liquidity'],
    });
  }
  contracts.sort((a, b) => a.product.localeCompare(b.product));
  const resolved = new Set(contracts.map((row) => row.product));
  return { contracts, mappingStatus: roots.map((product) => ({ product: product.symbol, providerSymbol: product.providerSymbol,
    status: resolved.has(product.symbol) ? 'resolved' : 'no_current_mapping' })) };
}

/** Resolve the configured volume-ranked continuous roots to provider definitions, behind the existing scan-cost cap. */
export async function discoverDatabentoActiveFuturesContracts(products, {
  apiKey = '', dataset = 'GLBX.MDP3', maxScanCostUsd = 0, now = Date.now(),
  fetcher = fetch, metrics = [], clock = Date.now, sleep,
} = {}) {
  if (!Array.isArray(products) || !products.length) return { contracts: [], mappingStatus: [], metrics };
  if (!apiKey) throw new Error('DATABENTO_API_KEY is required for Futures active-contract discovery.');
  if (!Number.isFinite(Number(maxScanCostUsd)) || Number(maxScanCostUsd) <= 0) throw new Error('A positive FUTURES_MAX_SCAN_COST_USD is required for Futures active-contract discovery.');
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new Error('Invalid Databento dataset code for Futures active-contract discovery.');
  const symbols = [...new Set(products.map((row) => String(row.providerSymbol || '').trim()))];
  if (symbols.some((symbol) => !/^[A-Z0-9]{1,8}\.v\.0$/i.test(symbol))) throw new Error('Active Futures discovery requires volume-ranked [ROOT].v.0 symbols.');
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const start = day.toISOString(), end = new Date(day.getTime() + 86_400_000).toISOString();
  const params = { dataset, symbols: symbols.join(','), stype_in: 'continuous', schema: 'definition', start, end };
  const costStartedAt = clock();
  let response, text;
  try {
    response = await fetchDatabentoCostEstimate(fetcher, `https://hist.databento.com/v0/metadata.get_cost?${new URLSearchParams(params)}`,
      { headers: authHeaders(apiKey), signal: AbortSignal.timeout(12_000) }, {
        sleep, clock, onAttempt: ({ status, headers, latencyMs, attempt, error }) => {
          const rateLimit = readProviderRateLimit(headers);
          metrics.push({ provider: 'Databento', operation: 'active-contract-definition-cost', status, latencyMs,
            ...(attempt ? { retry: true, attempt: attempt + 1 } : {}), ...(rateLimit ? { rateLimit } : {}), ...(error ? { error } : {}) });
        },
      });
    text = await response.text();
  } catch (error) {
    if (response) metrics.push({ provider: 'Databento', operation: 'active-contract-definition-cost-body', status: 0,
      latencyMs: Math.max(0, clock() - costStartedAt), error: String(error.message || error).slice(0, 150) });
    throw new Error(`Databento active-contract cost request failed: ${String(error.message || error).slice(0, 150)}`);
  }
  if (!response.ok) throw new Error(`Databento active-contract cost HTTP ${response.status}: ${text.slice(0, 150)}`);
  const estimatedCostUsd = Number(text.trim());
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('Databento returned an invalid active-contract cost estimate.');
  metrics.push({ provider: 'Databento', operation: 'estimated-active-contract-discovery-cost', status: 200, latencyMs: 0,
    estimatedCostUsd, configuredCapUsd: Number(maxScanCostUsd) });
  if (estimatedCostUsd > Number(maxScanCostUsd)) throw new Error(`Databento active-contract discovery blocked: estimated $${estimatedCostUsd.toFixed(6)} exceeds configured cap $${Number(maxScanCostUsd).toFixed(6)}.`);

  const body = new URLSearchParams({ ...params, encoding: 'json', pretty_ts: 'true' });
  const definitionsStartedAt = clock();
  try {
    response = await fetchWithRateLimitRetry(fetcher, 'https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST', headers: { ...authHeaders(apiKey), 'content-type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(20_000),
    }, { sleep, clock, onRetry: ({ status, headers, delayMs, latencyMs }) => metrics.push({ provider: 'Databento', operation: 'active-volume-ranked-definitions', status,
      latencyMs, retry: true, attempt: 1, retryDelayMs: delayMs, ...(readProviderRateLimit(headers) ? { rateLimit: readProviderRateLimit(headers) } : {}) }) });
    text = await response.text();
  } catch (error) {
    metrics.push({ provider: 'Databento', operation: 'active-volume-ranked-definitions', status: 0,
      latencyMs: Math.max(0, clock() - definitionsStartedAt), error: String(error.message || error).slice(0, 150) });
    throw new Error(`Databento active-contract definitions request failed: ${String(error.message || error).slice(0, 150)}`);
  }
  const rateLimit = readProviderRateLimit(response.headers);
  metrics.push({ provider: 'Databento', operation: 'active-volume-ranked-definitions', status: response.status,
    latencyMs: Math.max(0, clock() - definitionsStartedAt), records: response.ok ? text.split(/\r?\n/).filter(Boolean).length : null,
    ...(rateLimit ? { rateLimit } : {}) });
  if (!response.ok) throw new Error(`Databento active-contract definitions HTTP ${response.status}: ${text.slice(0, 150)}`);
  return { ...normalizeDatabentoActiveContractDefinitions(products, parseJsonLines(text), { now }), metrics };
}

/**
 * Resolve dated Databento parent-symbol definitions to unexpired outright
 * contracts. This is a discovery result only: it never verifies margin,
 * multiplier, quote freshness/liquidity, exchange session, or trade approval.
 */
export function normalizeDatabentoContractDefinitions(products, records, { now = Date.now() } = {}) {
  if (!Array.isArray(products) || !Array.isArray(records)) throw new TypeError('Products and definition records must be arrays.');
  const roots = products.map((product) => ({ ...product, root: String(product.providerSymbol || '').split('.')[0].toUpperCase() }));
  const latestByInstrument = new Map();
  for (const record of records) {
    // Databento instrument IDs are publisher-scoped and are not globally unique.
    const instrumentId = `${String(record.publisher_id ?? 'unknown').trim()}:${String(record.instrument_id ?? '').trim()}`;
    const rawSymbol = String(record.raw_symbol ?? '').trim().toUpperCase();
    if (instrumentId.endsWith(':') || !rawSymbol) continue;
    const prior = latestByInstrument.get(instrumentId);
    const time = parseTime(record.ts_recv ?? record.ts_event ?? 0);
    const priorTime = prior ? parseTime(prior.ts_recv ?? prior.ts_event ?? 0) : -Infinity;
    if (!prior || (Number.isFinite(time) && time >= priorTime)) latestByInstrument.set(instrumentId, record);
  }
  const discoveredAt = new Date(now).toISOString();
  const contracts = [];
  for (const record of latestByInstrument.values()) {
    if (String(record.security_update_action || '').toUpperCase() === 'D') continue;
    if (!['F', 'FUT', 'FUTURE'].includes(String(record.instrument_class || record.security_type || '').toUpperCase())) continue;
    const rawSymbol = String(record.raw_symbol).trim().toUpperCase();
    const root = String(record.asset || '').trim().toUpperCase();
    const product = roots.find((row) => (root && row.root === root) || (!root && rawSymbol.startsWith(row.root)));
    if (!product) continue;
    const expiryMs = parseTime(record.expiration);
    if (!Number.isFinite(expiryMs) || expiryMs <= now) continue;
    contracts.push({
      product: product.symbol,
      providerSymbol: product.providerSymbol,
      providerRawSymbol: rawSymbol,
      providerInstrumentId: String(record.instrument_id),
      providerPublisherId: record.publisher_id == null ? null : String(record.publisher_id),
      providerExchange: String(record.exchange || '').trim() || null,
      expiry: new Date(expiryMs).toISOString(),
      providerActivationAt: Number.isFinite(parseTime(record.activation)) ? new Date(parseTime(record.activation)).toISOString() : null,
      providerTickSize: Number.isFinite(Number(record.min_price_increment)) && Number(record.min_price_increment) > 0
        && Number.isFinite(Number(record.display_factor)) && Number(record.display_factor) > 0
        ? Number((Number(record.min_price_increment) / Number(record.display_factor)).toPrecision(12)) : null,
      providerTickValue: Number.isFinite(Number(record.min_price_increment_amount)) && Number(record.min_price_increment_amount) > 0
        ? Number((Number(record.min_price_increment_amount) / 1e9).toPrecision(12)) : null,
      providerContractMultiplier: Number.isFinite(Number(record.contract_multiplier)) && Number(record.contract_multiplier) > 0
        ? Number(record.contract_multiplier) : null,
      providerContractSize: Number.isFinite(Number(record.unit_of_measure_qty)) && Number(record.unit_of_measure_qty) > 0
        ? Number((Number(record.unit_of_measure_qty) / 1e9).toPrecision(12)) : null,
      providerUnitOfMeasure: String(record.unit_of_measure || '').trim() || null,
      providerCurrency: String(record.currency || '').trim() || null,
      providerSecurityType: String(record.security_type || '').trim() || null,
      providerInstrumentClass: String(record.instrument_class || '').trim() || null,
      definitionTimestamp: Number.isFinite(parseTime(record.ts_recv ?? record.ts_event))
        ? new Date(parseTime(record.ts_recv ?? record.ts_event)).toISOString() : null,
      definitionSource: 'Databento GLBX.MDP3 definition schema',
      discoveredAt,
      contractState: 'unexpired_definition_only',
      contractSpecVerified: false,
      tradeEligible: false,
      unverifiedFields: ['current active trading status', 'broker-verified tick value and contract multiplier', 'initial margin', 'maintenance margin', 'session calendar', 'executable quote and liquidity'],
    });
  }
  contracts.sort((a, b) => a.product.localeCompare(b.product) || Date.parse(a.expiry) - Date.parse(b.expiry) || a.providerRawSymbol.localeCompare(b.providerRawSymbol));
  return contracts;
}

export async function discoverDatabentoFuturesContracts(products, {
  apiKey = '', dataset = 'GLBX.MDP3', maxScanCostUsd = 0, now = Date.now(),
  fetcher = fetch, metrics = [], clock = Date.now, sleep,
} = {}) {
  if (!Array.isArray(products) || !products.length) return { contracts: [], metrics };
  if (!apiKey) throw new Error('DATABENTO_API_KEY is required for Futures contract discovery.');
  if (!Number.isFinite(Number(maxScanCostUsd)) || Number(maxScanCostUsd) <= 0) throw new Error('A positive FUTURES_MAX_SCAN_COST_USD is required for Databento contract discovery.');
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new Error('Invalid Databento dataset code.');
  const parents = [...new Set(products.map((row) => `${String(row.providerSymbol || '').split('.')[0].toUpperCase()}.FUT`))];
  if (parents.some((symbol) => !/^[A-Z0-9]{1,8}\.FUT$/.test(symbol))) throw new Error('Futures products must have a valid Databento root symbol.');
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const start = day.toISOString(), end = new Date(day.getTime() + 86_400_000).toISOString();
  const query = new URLSearchParams({ dataset, symbols: parents.join(','), stype_in: 'parent', schema: 'definition', start, end });
  const startAt = clock();
  let response, text;
  try {
    response = await fetchDatabentoCostEstimate(fetcher, `${HISTORICAL_API}/metadata.get_cost?${query}`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(12_000) }, {
      sleep, clock, onAttempt: ({ status, headers, latencyMs, attempt, error }) => {
        const rateLimit = readProviderRateLimit(headers);
        metrics.push({ provider: 'Databento', operation: 'contract-definition-cost', status, latencyMs,
          ...(attempt ? { retry: true, attempt: attempt + 1 } : {}), ...(rateLimit ? { rateLimit } : {}), ...(error ? { error } : {}) });
      }
    });
    text = await response.text();
  } catch (error) {
    if (response) metrics.push({ provider: 'Databento', operation: 'contract-definition-cost-body', status: 0, latencyMs: Math.max(0, clock() - startAt), error: String(error.message || error).slice(0, 150) });
    throw new Error(`Databento contract definition cost request failed: ${String(error.message || error).slice(0, 150)}`);
  }
  if (!response.ok) throw new Error(`Databento definition cost HTTP ${response.status}: ${text.slice(0, 150)}`);
  const estimatedCostUsd = Number(text.trim());
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('Databento returned an invalid contract-definition cost estimate.');
  metrics.push({ provider: 'Databento', operation: 'estimated-contract-discovery-cost', status: 200, latencyMs: 0, estimatedCostUsd, configuredCapUsd: Number(maxScanCostUsd) });
  if (estimatedCostUsd > Number(maxScanCostUsd)) throw new Error(`Databento contract discovery blocked: estimated $${estimatedCostUsd.toFixed(6)} exceeds configured cap $${Number(maxScanCostUsd).toFixed(6)}.`);

  const body = new URLSearchParams({ dataset, symbols: parents.join(','), stype_in: 'parent', schema: 'definition', start, end, encoding: 'json', pretty_ts: 'true' });
  const dataStart = clock();
  try {
    response = await fetchWithRateLimitRetry(fetcher, `${HISTORICAL_API}/timeseries.get_range`, { method: 'POST', headers: { ...authHeaders(apiKey), 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) },
      { sleep, clock, onRetry: ({ status, headers, delayMs, latencyMs }) => metrics.push({ provider: 'Databento', operation: 'contract-definitions', status,
        latencyMs, retry: true, attempt: 1, retryDelayMs: delayMs, ...(readProviderRateLimit(headers) ? { rateLimit: readProviderRateLimit(headers) } : {}) }) });
    text = await response.text();
  } catch (error) {
    metrics.push({ provider: 'Databento', operation: 'contract-definitions', status: 0, latencyMs: Math.max(0, clock() - dataStart), error: String(error.message || error).slice(0, 150) });
    throw new Error(`Databento contract definitions request failed: ${String(error.message || error).slice(0, 150)}`);
  }
  const definitionsRateLimit = readProviderRateLimit(response.headers);
  metrics.push({ provider: 'Databento', operation: 'contract-definitions', status: response.status, latencyMs: Math.max(0, clock() - dataStart), records: response.ok ? text.split(/\r?\n/).filter(Boolean).length : null, ...(definitionsRateLimit ? { rateLimit: definitionsRateLimit } : {}) });
  if (!response.ok) throw new Error(`Databento definitions HTTP ${response.status}: ${text.slice(0, 150)}`);
  return { contracts: normalizeDatabentoContractDefinitions(products, parseJsonLines(text), { now }), metrics };
}
