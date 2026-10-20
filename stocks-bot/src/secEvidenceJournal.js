import path from 'node:path';
import { dataDir } from './config.js';
import { readJson, writeJson } from './storage.js';

const FILE = 'sec-fundamental-evidence.json';
const locks = new Map();
const ALLOWED_METRICS = new Set([
  'revenue', 'grossProfit', 'netIncome', 'operatingIncome', 'operatingCashFlow', 'operatingCashConversion', 'capitalExpenditure', 'cashDividendsPerShare', 'cashDividendsPaid', 'commonStockRepurchases',
  'weightedAverageDilutedShares', 'dilutedEps', 'totalAssets', 'stockholdersEquity', 'returnOnEquityPct', 'returnOnAssetsPct',
  'currentAssets', 'currentLiabilities', 'accountsReceivable', 'inventory', 'receivablesRevenueGrowthGapPp', 'workingCapital', 'currentRatio',
  'cash', 'longTermDebtCurrent', 'longTermDebtNoncurrent',
  'debtMaturityNext12Months', 'debtMaturityYearTwo', 'debtMaturityYearThree', 'debtMaturityYearFour', 'debtMaturityYearFive', 'debtMaturityAfterYearFive',
  'sharesOutstanding', 'freeCashFlow', 'grossMarginPct', 'operatingMarginPct', 'netMarginPct',
  'freeCashFlowMarginPct', 'cashLessLongTermDebt'
]);

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
}

function snapshotMetric(metric = {}) {
  const history = Array.isArray(metric.history) ? metric.history.slice(0, 5).flatMap((row) => {
    const value = finiteOrNull(row.value);
    return value === null ? [] : [{ periodStart: String(row.periodStart || ''), periodEnd: String(row.periodEnd || ''), value }];
  }) : [];
  return {
    value: finiteOrNull(metric.value), priorValue: finiteOrNull(metric.priorValue), growthPct: finiteOrNull(metric.growthPct),
    unit: /^[A-Za-z/_]+$/.test(String(metric.unit || '')) ? String(metric.unit) : '',
    tag: /^[A-Za-z0-9]+$/.test(String(metric.tag || '')) ? String(metric.tag) : '',
    periodStart: String(metric.periodStart || ''), periodEnd: String(metric.periodEnd || ''), history
  };
}

export function createSecFundamentalCapture(row, observedAt = new Date()) {
  const fundamentals = row?.annualFundamentals;
  const filing = fundamentals?.filing;
  const capturedAt = observedAt instanceof Date ? observedAt.toISOString() : new Date(observedAt).toISOString();
  const symbol = String(row?.symbol || '').toUpperCase();
  const accession = String(filing?.accession || '').replaceAll('-', '');
  const priceDate = String(row?.asOf || '');
  if (!/^[A-Z0-9.^_-]{1,24}$/.test(symbol) || !/^[0-9]{18}$/.test(accession)
    || !/^(10-K|20-F|40-F)$/.test(String(filing?.form || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(priceDate)
    || !['partial'].includes(fundamentals.status)) return null;

  const metrics = Object.fromEntries(Object.entries(fundamentals.metrics || {})
    .filter(([key]) => ALLOWED_METRICS.has(key)).map(([key, metric]) => [key, snapshotMetric(metric)]));
  if (!Object.values(metrics).some((metric) => metric.value !== null)) return null;
  const valuation = row.annualValuation || {};
  return {
    version: 1, symbol, cik: String(fundamentals.cik || ''), source: 'SEC EDGAR companyfacts',
    observedAt: capturedAt,
    filing: { form: filing.form, filedAt: String(filing.filedAt || ''), periodEnd: String(filing.periodEnd || ''),
      accession: String(filing.accession), url: String(filing.url || '') },
    price: { provider: 'Yahoo daily chart (public/unofficial)', asOf: priceDate, rawClose: finiteOrNull(row.rawClose) },
    valuation: { status: String(valuation.status || ''), marketCapEstimate: finiteOrNull(valuation.marketCapEstimate),
      priceToSales: finiteOrNull(valuation.priceToSales), priceToEarnings: finiteOrNull(valuation.priceToEarnings),
      priceToFreeCashFlow: finiteOrNull(valuation.priceToFreeCashFlow), freeCashFlowYieldPct: finiteOrNull(valuation.freeCashFlowYieldPct) },
    coverage: { status: fundamentals.status, metrics: Object.keys(metrics).length,
      unavailable: Object.entries(metrics).filter(([, metric]) => metric.value === null).map(([key]) => key) },
    metrics
  };
}

async function appendLocked(captures, directory) {
  const file = path.join(directory, FILE);
  const journal = await readJson(file, { version: 1, captures: [], updatedAt: '' });
  if (journal?.version !== 1 || !Array.isArray(journal.captures))
    throw new Error('SEC fundamental evidence journal schema is invalid; repair it before writing more captures.');
  const existing = new Set(journal.captures.map((row) => `${row.symbol}|${row.filing?.accession}|${row.price?.asOf}`));
  const added = captures.filter((row) => {
    const key = `${row.symbol}|${row.filing.accession}|${row.price.asOf}`;
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  if (!added.length) return { added: 0, total: journal.captures.length };
  const merged = [...journal.captures, ...added].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  await writeJson(file, { version: 1, captures: merged, updatedAt: new Date().toISOString() });
  return { added: added.length, total: merged.length };
}

export async function appendSecFundamentalEvidence(rows = [], { directory = dataDir, observedAt = new Date() } = {}) {
  const captures = rows.map((row) => createSecFundamentalCapture(row, observedAt)).filter(Boolean);
  if (!captures.length) return { added: 0, total: null };
  const key = path.resolve(directory, FILE);
  const previous = locks.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => appendLocked(captures, directory));
  locks.set(key, task);
  try { return await task; }
  finally { if (locks.get(key) === task) locks.delete(key); }
}

export async function readSecFundamentalEvidence({ directory = dataDir } = {}) {
  const journal = await readJson(path.join(directory, FILE), { version: 1, captures: [], updatedAt: '' });
  if (journal?.version !== 1 || !Array.isArray(journal.captures))
    throw new Error('SEC fundamental evidence journal schema is invalid.');
  return journal;
}
