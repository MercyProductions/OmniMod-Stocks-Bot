import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const safeCount = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const safeName = (value, maxLength = 48) => String(value ?? '').trim().replace(/[^A-Za-z0-9._ -]/g, '').slice(0, maxLength);

/** Keep a compact, secret-free summary of one public market-data smoke observation. */
export function buildDayMarketDataHistoryRow(payload = {}) {
  const checkedAt = Date.parse(payload.checkedAt ?? '');
  if (!Number.isFinite(checkedAt) || !['PASS_PROVIDER_PLUMBING_ONLY', 'INCOMPLETE'].includes(payload.status)
    || !Array.isArray(payload.report) || !payload.checks || typeof payload.checks !== 'object') {
    throw new TypeError('A valid provider-smoke observation is required.');
  }
  const symbols = payload.report.map((row) => ({
    symbol: safeName(row?.symbol, 16).toUpperCase(),
    providers: [...new Set((Array.isArray(row?.quoteProviders) ? row.quoteProviders : [])
      .map((quote) => safeName(quote?.provider)).filter(Boolean))].sort(),
    quoteDisagreement: row?.conflicted === true,
    staleOrInvalidQuotes: safeCount(row?.staleOrInvalidQuotes),
    quoteRejectionCounts: Object.fromEntries(Object.entries(row?.quoteRejectionCounts || {})
      .map(([reason, count]) => [safeName(reason, 64), safeCount(count)])
      .filter(([reason, count]) => reason && count > 0).sort((a, b) => a[0].localeCompare(b[0]))),
    providerErrorCount: safeCount(row?.providerErrors?.length),
    candleCount: safeCount(row?.historicalCandles?.count),
  })).filter((row) => row.symbol);
  return {
    schemaVersion: 1,
    checkedAt: new Date(checkedAt).toISOString(),
    status: payload.status,
    elapsedMs: safeCount(payload.checks.elapsedMs),
    requestedSymbols: safeCount(payload.checks.requestedSymbols),
    symbolsWithTwoFreshQuotes: safeCount(payload.checks.symbolsWithAtLeastTwoFreshExecutableExchangeQuotes),
    symbolsWithQuoteDisagreement: safeCount(payload.checks.symbolsWithQuoteDisagreement?.length),
    historicalCandleSourceAvailable: payload.checks.historicalCandleSourceAvailable === true,
    globalProviderErrorCount: safeCount(payload.globalProviderErrors?.length),
    symbols,
  };
}

export async function appendDayMarketDataHistory(row, { path } = {}) {
  if (!path || row?.schemaVersion !== 1 || !Number.isFinite(Date.parse(row.checkedAt))) {
    throw new TypeError('A history path and validated smoke row are required.');
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  return path;
}
