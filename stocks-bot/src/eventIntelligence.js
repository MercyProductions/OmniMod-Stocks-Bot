import { config } from './config.js';
import { recordIntelligenceRows } from './researchStore.js';
import { recordProviderRequest } from './scanDiagnostics.js';
import { normalizeSecAnnualFundamentals } from './secFundamentals.js';
import { fetchAlpacaCatalystNews } from '../../new-bots/shared/alpacaCatalystNews.js';
import { classifyStockHeadline } from './stockHeadlineClassifier.js';
import { performance } from 'node:perf_hooks';
import { waitForAlpacaRequest } from './alpacaRequestGate.js';

const cache = new Map();
const inFlight = new Map();
let nextSecRequestAt = 0;
let secRequestQueue = Promise.resolve();
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startSecPacedRequest(url, startRequest) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname !== 'sec.gov' && !hostname.endsWith('.sec.gov')) return startRequest();
  let release;
  const previous = secRequestQueue;
  secRequestQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = nextSecRequestAt - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    // Reserve the next interval from the real start time, not an old scheduled
    // slot. After a process/event-loop pause, overdue requests must not bunch.
    const request = startRequest();
    nextSecRequestAt = performance.now() + 100;
    return request;
  } finally {
    release();
  }
}

async function cachedJson(key, url, requestOptions = {}, ttlMs = config.eventCacheMinutes * 60_000, metrics) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const { fetcher = fetch, ...options } = requestOptions;
    const credential = Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === 'apca-api-key-id')?.[1];
    let grant;
    if (credential) try { grant = await waitForAlpacaRequest(credential); }
    catch (error) {
      recordProviderRequest(metrics, options.provider, { requestAttempted: false, error: error.code || 'ALPACA_BUDGET_UNAVAILABLE' });
      throw error;
    }
    const startedAt = Date.now();
    let response;
    let recorded = false;
    try {
      response = await startSecPacedRequest(url, () => fetcher(url, {
        headers: { accept: 'application/json', ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 20_000)
      }));
      if (credential) await waitForAlpacaRequest.observe(credential, response.headers, { reservationId: grant?.reservationId, status: response.status });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${options.provider || 'Event provider'} returned HTTP ${response.status}: ${text.slice(0, 180)}`);
        recordProviderRequest(metrics, options.provider, { latencyMs: Date.now() - startedAt, status: response.status, headers: response.headers, error: error.message });
        recorded = true;
        throw error;
      }
      const value = JSON.parse(text);
      recordProviderRequest(metrics, options.provider, { latencyMs: Date.now() - startedAt, status: response.status, headers: response.headers });
      recorded = true;
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (error) {
      if (!recorded) recordProviderRequest(metrics, options.provider, { latencyMs: Date.now() - startedAt, status: response?.status || 0, headers: response?.headers, error: error?.message || String(error) });
      throw error;
    }
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

function parseSecTimestamp(value) {
  const text = String(value || '');
  if (/^\d{14}$/.test(text)) return new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function secTickerMap(metrics, fetcher = fetch) {
  if (!config.secUserAgent || !/@/.test(config.secUserAgent)) return null;
  const data = await cachedJson('sec-tickers', 'https://www.sec.gov/files/company_tickers.json', {
    provider: 'SEC ticker map', headers: { 'user-agent': config.secUserAgent }, fetcher
  }, 24 * 60 * 60_000, metrics);
  return new Map(Object.values(data || {}).map((row) => [String(row.ticker || '').toUpperCase(), String(row.cik_str || '').padStart(10, '0')]));
}

export async function fetchIssuerAnnualFundamentals(symbols = [], now = new Date(), metrics, fetcher = fetch) {
  const requested = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))].slice(0, 5);
  if (!config.secUserAgent || !/@/.test(config.secUserAgent))
    return requested.map((symbol) => ({ symbol, status: 'unavailable', reason: 'SEC_USER_AGENT must identify the project and include a contact email.' }));
  let tickerMap;
  try { tickerMap = await secTickerMap(metrics, fetcher); }
  catch (error) { return requested.map((symbol) => ({ symbol, status: 'unavailable', reason: `SEC ticker map: ${String(error.message || error).slice(0, 140)}` })); }
  return mapLimited(requested, 2, async (symbol) => {
    const cik = tickerMap.get(symbol);
    if (!cik) return { symbol, status: 'unavailable', reason: 'SEC ticker map has no exact symbol-to-CIK association.' };
    try {
      const headers = { 'user-agent': config.secUserAgent };
      const [submissions, facts] = await Promise.all([
        cachedJson(`sec-submissions-${cik}`, `https://data.sec.gov/submissions/CIK${cik}.json`, { provider: 'SEC submissions', headers, fetcher }, 15 * 60_000, metrics),
        cachedJson(`sec-facts-${cik}`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { provider: 'SEC company facts', headers, fetcher }, 6 * 60 * 60_000, metrics)
      ]);
      return normalizeSecAnnualFundamentals(symbol, cik, submissions, facts, now);
    } catch (error) {
      return { symbol, status: 'unavailable', reason: `SEC companyfacts: ${String(error.message || error).slice(0, 140)}` };
    }
  });
}

function recentFilings(submissions, now) {
  const recent = submissions?.filings?.recent || {};
  const length = recent.form?.length || 0;
  return Array.from({ length }, (_, index) => ({
    form: String(recent.form?.[index] || ''),
    filedAt: parseSecTimestamp(recent.acceptanceDateTime?.[index]) || parseSecTimestamp(recent.filingDate?.[index]),
    accessionNumber: String(recent.accessionNumber?.[index] || ''),
    primaryDocument: String(recent.primaryDocument?.[index] || '')
  })).filter((row) => row.filedAt && row.filedAt <= now).sort((left, right) => right.filedAt - left.filedAt);
}

export function secIssuerIndustryMetadata(submissions = {}) {
  const sic = String(submissions?.sic || '');
  const description = String(submissions?.sicDescription || '').trim();
  return /^\d{4}$/.test(sic) && description ? { secSic: sic, secSicDescription: description } : { secSic: '', secSicDescription: '' };
}

function latestGrowth(companyFacts, tags, unit, now) {
  const fact = tags.map((tag) => companyFacts?.facts?.['us-gaap']?.[tag]).find(Boolean);
  const values = (fact?.units?.[unit] || []).filter((row) => ['10-Q', '10-K'].includes(row.form) && new Date(row.filed) <= now && Number.isFinite(Number(row.val)))
    .sort((left, right) => String(right.filed).localeCompare(String(left.filed)));
  const latest = values[0];
  if (!latest) return null;
  const latestEnd = new Date(latest.end).getTime();
  const previous = values.find((row) => {
    const days = (latestEnd - new Date(row.end).getTime()) / (24 * 60 * 60_000);
    return days >= 300 && days <= 430 && row.fp === latest.fp;
  });
  return previous?.val ? (Number(latest.val) / Number(previous.val) - 1) * 100 : null;
}

async function secIntelligence(symbol, cik, now, metrics) {
  if (!cik) return { secDataStatus: 'symbol_unmapped' };
  const headers = { 'user-agent': config.secUserAgent };
  const [submissions, facts] = await Promise.all([
    cachedJson(`sec-submissions-${cik}`, `https://data.sec.gov/submissions/CIK${cik}.json`, { provider: 'SEC submissions', headers }, 15 * 60_000, metrics),
    cachedJson(`sec-facts-${cik}`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { provider: 'SEC company facts', headers }, 6 * 60 * 60_000, metrics)
  ]);
  const filing = recentFilings(submissions, now)[0];
  const ageHours = filing ? (now.getTime() - filing.filedAt.getTime()) / (60 * 60_000) : null;
  const dilution = /^(S-1|S-3|424B|POS AM|EFFECT)/.test(filing?.form || '');
  const highImpact = /^(8-K|10-Q|10-K|6-K|20-F)/.test(filing?.form || '');
  const secFilingRisk = filing && ageHours <= 48 ? (dilution ? 100 : highImpact ? clamp(75 - ageHours, 20, 75) : 20) : 0;
  return {
    secDataStatus: 'available',
    cik,
    // Retain the SEC industry label, but do not infer a sector ETF from SIC ranges.
    ...secIssuerIndustryMetadata(submissions),
    recentSecForm: filing?.form || '',
    recentSecFiledAt: filing?.filedAt?.toISOString() || '',
    recentSecAccession: filing?.accessionNumber || '',
    secFilingAgeHours: ageHours,
    secFilingRisk,
    revenueGrowthYoY: latestGrowth(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'], 'USD', now),
    netIncomeGrowthYoY: latestGrowth(facts, ['NetIncomeLoss', 'ProfitLoss'], 'USD', now),
    sharesGrowthYoY: latestGrowth(facts, ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding'], 'shares', now)
  };
}

function flattenCorporateActions(data) {
  return Object.entries(data || {}).flatMap(([type, values]) => Array.isArray(values) ? values.map((row) => ({ ...row, actionType: type })) : []);
}

async function corporateActions(symbols, keys, now, metrics) {
  if (!keys.alpaca_key_id || !keys.alpaca_secret_key) return { bySymbol: new Map(), status: 'credentials_missing', error: '' };
  if (!symbols.length) return { bySymbol: new Map(), status: 'not_requested', error: '' };
  const start = new Date(now.getTime() - 5 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const query = new URLSearchParams({ symbols: symbols.join(','), start, end, limit: '1000', sort: 'asc' });
  let data;
  try {
    data = await cachedJson(`alpaca-ca-${symbols.sort().join(',')}-${start}`, `https://data.alpaca.markets/v1/corporate-actions?${query}`, {
      provider: 'Alpaca corporate actions', headers: { 'APCA-API-KEY-ID': keys.alpaca_key_id, 'APCA-API-SECRET-KEY': keys.alpaca_secret_key }
    }, 60 * 60_000, metrics);
  } catch (error) { return { bySymbol: new Map(), status: 'provider_error', error: String(error.message || error).slice(0, 180) }; }
  const bySymbol = new Map();
  for (const row of flattenCorporateActions(data?.corporate_actions || data)) {
    const symbol = String(row.symbol || row.initiating_symbol || '').toUpperCase();
    const date = row.ex_date || row.process_date || row.declaration_date || row.payable_date;
    if (!symbol || !date) continue;
    const eventAt = new Date(`${date}T13:30:00Z`);
    const days = (eventAt.getTime() - now.getTime()) / (24 * 60 * 60_000);
    const current = bySymbol.get(symbol);
    if (!current || Math.abs(days) < Math.abs(current.daysToCorporateAction)) bySymbol.set(symbol, {
      corporateActionType: row.actionType || row.type || 'corporate_action', corporateActionDate: date,
      daysToCorporateAction: days, corporateActionRisk: Math.abs(days) <= 2 ? 90 : Math.abs(days) <= 7 ? 45 : 15
    });
  }
  return { bySymbol, status: 'available', error: '' };
}

async function fredObservation(seriesId, apiKey, now, metrics) {
  const date = now.toISOString().slice(0, 10);
  const query = new URLSearchParams({
    series_id: seriesId, api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: '10',
    realtime_start: date, realtime_end: date
  });
  const data = await cachedJson(`fred-${seriesId}-${date}`, `https://api.stlouisfed.org/fred/series/observations?${query}`, { provider: `FRED ${seriesId}` }, 60 * 60_000, metrics);
  const row = (data.observations || []).find((item) => Number.isFinite(Number(item.value)));
  return row ? Number(row.value) : null;
}

async function macroIntelligence(keys, now, metrics) {
  if (!keys.fred) return { macroDataStatus: 'credentials_missing' };
  const [vix, tenYear, twoYear, creditSpread] = await Promise.all([
    fredObservation('VIXCLS', keys.fred, now, metrics), fredObservation('DGS10', keys.fred, now, metrics),
    fredObservation('DGS2', keys.fred, now, metrics), fredObservation('BAMLH0A0HYM2', keys.fred, now, metrics)
  ]);
  const curve = Number.isFinite(tenYear) && Number.isFinite(twoYear) ? tenYear - twoYear : null;
  const components = [Number.isFinite(vix), Number.isFinite(curve), Number.isFinite(creditSpread)].filter(Boolean).length;
  const macroStress = components ? clamp(
    (Number.isFinite(vix) ? (vix - 15) * 2.5 : 0)
      + (Number.isFinite(curve) ? Math.max(0, -curve) * 20 : 0)
      + (Number.isFinite(creditSpread) ? Math.max(0, creditSpread - 3) * 12 : 0), 0, 100
  ) : null;
  return { vix, yield10y: tenYear, yield2y: twoYear, yieldCurve10y2y: curve, creditSpread, macroStress,
    macroDataStatus: components === 3 ? 'available' : components ? 'partial' : 'unavailable',
    macroComponentsAvailable: components, macroComponentsExpected: 3, macroObservedAt: now.toISOString() };
}

async function mapLimited(values, limit, mapper) {
  const results = new Array(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; try { results[index] = await mapper(values[index]); } catch (error) { results[index] = { secDataStatus: 'provider_error', secDataError: String(error.message || error).slice(0, 180) }; } }
  }));
  return results;
}

export async function enrichAssetsWithIntelligence(assets = [], keys = {}, settings = {}, now = new Date(), metrics) {
  const symbols = [...new Set(assets.map((asset) => asset.symbol).filter(Boolean))];
  const newsMetrics = [];
  const [tickerMapResult, actionResult, macroResult, newsResult] = await Promise.all([
    secTickerMap(metrics).then((tickerMap) => ({ tickerMap, status: tickerMap ? 'available' : 'credentials_missing', error: '' }))
      .catch((error) => ({ tickerMap: null, status: 'provider_error', error: String(error.message || error).slice(0, 180) })),
    corporateActions(symbols, keys, now, metrics),
    macroIntelligence(keys, now, metrics).catch((error) => ({ macroDataStatus: 'provider_error', macroDataError: String(error.message || error).slice(0, 180) })),
    config.alpacaNewsEnabled && keys.alpaca_key_id && keys.alpaca_secret_key && symbols.length
      ? fetchAlpacaCatalystNews(symbols, { key: keys.alpaca_key_id, secret: keys.alpaca_secret_key,
        now: now.getTime(), reviewWindowMs: 24 * 60 * 60_000, batchSize: 10, maxPages: 2, concurrency: 2, metrics: newsMetrics })
        .catch((error) => ({ bySymbol: new Map(), incomplete: new Set(symbols), diagnostics: { status: 'provider_error', error: String(error.message || error).slice(0, 180) } }))
      : Promise.resolve({ bySymbol: new Map(), incomplete: new Set(), diagnostics: { status: config.alpacaNewsEnabled ? 'credentials_missing' : 'disabled' } })
  ]);
  for (const row of newsMetrics) recordProviderRequest(metrics, 'Alpaca news', { ...row,
    headers: row.rateLimit ? Object.fromEntries(['limit', 'remaining', 'reset'].filter(key => row.rateLimit[key] !== null)
      .map(key => [`X-RateLimit-${key}`, String(row.rateLimit[key])])) : null });
  const tickerMap = tickerMapResult.tickerMap;
  const secRows = tickerMap ? await mapLimited(assets, 2, (asset) => secIntelligence(asset.symbol, tickerMap.get(asset.symbol), now, metrics))
    : assets.map(() => ({ secDataStatus: tickerMapResult.status, secDataError: tickerMapResult.error }));
  const enriched = assets.map((asset, index) => ({ ...asset, ...macroResult, ...(secRows[index] || {}),
    corporateActionDataStatus: actionResult.status, corporateActionDataError: actionResult.error,
    recentNewsStatus: newsResult.diagnostics.status === 'provider_error' ? 'provider_error'
      : newsResult.diagnostics.status === 'credentials_missing' ? 'credentials_missing'
        : newsResult.diagnostics.status === 'disabled' ? 'disabled'
          : newsResult.incomplete.has(asset.symbol) ? 'partial' : 'available',
    recentNews: (newsResult.bySymbol.get(asset.symbol) || []).sort((a, b) => b.activityAt - a.activityAt).slice(0, 3).map((article) => ({
      provider: article.provider, publisher: article.publisher, headline: article.headline,
      ...classifyStockHeadline(article.headline), sourceUrl: article.sourceUrl || '',
      createdAt: new Date(article.createdAt).toISOString(), updatedAt: new Date(article.updatedAt).toISOString(),
      activityAt: new Date(article.activityAt).toISOString()
    })),
    ...(actionResult.bySymbol.get(asset.symbol) || {}) }));
  await recordIntelligenceRows(enriched.map((asset) => ({
    schemaVersion: 2, recordType: 'point_in_time_intelligence', recordedAt: now.toISOString(), symbol: asset.symbol,
    secDataStatus: asset.secDataStatus || 'unknown', corporateActionDataStatus: asset.corporateActionDataStatus || 'unknown',
    secSic: asset.secSic || '', secSicDescription: asset.secSicDescription || '',
    macroDataStatus: asset.macroDataStatus || 'unknown', macroComponentsAvailable: asset.macroComponentsAvailable ?? null,
    recentSecForm: asset.recentSecForm || '', recentSecFiledAt: asset.recentSecFiledAt || '', secFilingAgeHours: asset.secFilingAgeHours ?? null,
    secFilingRisk: asset.secFilingRisk || 0, revenueGrowthYoY: asset.revenueGrowthYoY ?? null,
    netIncomeGrowthYoY: asset.netIncomeGrowthYoY ?? null, sharesGrowthYoY: asset.sharesGrowthYoY ?? null,
    corporateActionType: asset.corporateActionType || '', corporateActionDate: asset.corporateActionDate || '',
    daysToCorporateAction: asset.daysToCorporateAction ?? null, corporateActionRisk: asset.corporateActionRisk || 0,
    vix: asset.vix ?? null, yieldCurve10y2y: asset.yieldCurve10y2y ?? null, creditSpread: asset.creditSpread ?? null,
    macroStress: asset.macroStress ?? null, macroObservedAt: asset.macroObservedAt || '',
    secDataError: asset.secDataError || '', corporateActionDataError: asset.corporateActionDataError || '',
    macroDataError: asset.macroDataError || '', intelligenceError: asset.intelligenceError || '',
    recentNewsStatus: asset.recentNewsStatus || 'unknown', recentNewsCount: asset.recentNews?.length || 0
  })));
  return { assets: enriched, macro: macroResult, report: { secEnabled: Boolean(tickerMap), secStatus: tickerMapResult.status,
    corporateActionsEnabled: actionResult.status === 'available', corporateActionsStatus: actionResult.status,
    macroEnabled: macroResult.macroDataStatus === 'available' || macroResult.macroDataStatus === 'partial', macroStatus: macroResult.macroDataStatus,
    recentNewsEnabled: config.alpacaNewsEnabled, recentNewsStatus: newsResult.diagnostics.status } };
}
