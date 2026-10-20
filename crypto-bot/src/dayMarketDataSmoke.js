export function assessDayMarketDataSmoke(report, { requestedSymbols, historicalCandleSourceAvailable, elapsedMs }) {
  if (!Array.isArray(report) || !Array.isArray(requestedSymbols) || !requestedSymbols.length
    || requestedSymbols.some((symbol) => typeof symbol !== 'string' || !symbol.trim())
    || new Set(requestedSymbols.map((symbol) => symbol.trim().toUpperCase())).size !== requestedSymbols.length)
    throw new TypeError('A report and unique requested symbol list are required.');
  const expectedSymbols = requestedSymbols.map((symbol) => symbol.trim().toUpperCase());
  const observedSymbols = report.map((row) => String(row.symbol || '').trim().toUpperCase());
  const observedSet = new Set(observedSymbols);
  const distinctProviders = (row) => new Set((Array.isArray(row.quoteProviders) ? row.quoteProviders : [])
    .map((quote) => String(quote.provider || '').trim()).filter(Boolean)).size;
  const checks = {
    requestedSymbols: expectedSymbols.length,
    missingSymbols: expectedSymbols.filter((symbol) => !observedSet.has(symbol)),
    duplicateSymbols: [...new Set(observedSymbols.filter((symbol, index) => observedSymbols.indexOf(symbol) !== index))],
    symbolsWithAtLeastTwoFreshExecutableExchangeQuotes: report.filter((row) => distinctProviders(row) >= 2
      && row.staleOrInvalidQuotes === 0).length,
    symbolsWithQuoteDisagreement: report.filter((row) => row.conflicted === true).map((row) => row.symbol),
    historicalCandleSourceAvailable: historicalCandleSourceAvailable === true,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
  };
  const completeCoverage = report.length === expectedSymbols.length
    && checks.missingSymbols.length === 0 && checks.duplicateSymbols.length === 0
    && checks.symbolsWithAtLeastTwoFreshExecutableExchangeQuotes === expectedSymbols.length;
  const status = completeCoverage && checks.historicalCandleSourceAvailable
    && checks.symbolsWithQuoteDisagreement.length === 0 ? 'PASS_PROVIDER_PLUMBING_ONLY' : 'INCOMPLETE';
  return { status, checks };
}
