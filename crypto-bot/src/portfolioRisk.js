const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function priceReturns(prices = []) {
  const rows = prices.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const returns = [];
  for (let index = 1; index < rows.length; index += 1) returns.push(rows[index] / rows[index - 1] - 1);
  return returns;
}

export function pearsonCorrelation(first = [], second = []) {
  const count = Math.min(first.length, second.length);
  if (count < 12) return null;
  const a = first.slice(-count);
  const b = second.slice(-count);
  const meanA = a.reduce((sum, value) => sum + value, 0) / count;
  const meanB = b.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < count; index += 1) {
    const deltaA = a[index] - meanA;
    const deltaB = b[index] - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }
  return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

export function assetCorrelation(first, second) {
  return pearsonCorrelation(priceReturns(first?.sparkline), priceReturns(second?.sparkline));
}

/**
 * Strict, diagnostics-only correlation estimate for CoinGecko 7-day sparklines.
 * The endpoint provides ordered prices without per-point timestamps, so this
 * estimate is usable only when both arrays have the same complete index grid.
 * It must not be treated as a calibrated cross-asset risk model.
 */
export function diagnoseAssetCorrelation(first, second) {
  const a = first?.sparkline;
  const b = second?.sparkline;
  const unavailable = (reason, sampleCount = 0) => ({ status: 'unavailable', reason, correlation: null, sampleCount,
    method: 'coingecko_7d_sparkline_index_grid', timestamped: false });
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return unavailable('missing_sparkline');
  if (a.length !== b.length) return unavailable('unaligned_sparkline_length');
  if (![...a, ...b].every((value) => Number.isFinite(value) && value > 0)) return unavailable('invalid_or_gapped_sparkline');
  if (a.length < 13) return unavailable('insufficient_sparkline_history', Math.max(0, a.length - 1));
  const correlation = pearsonCorrelation(priceReturns(a), priceReturns(b));
  if (correlation === null) return unavailable('constant_or_invalid_returns', a.length - 1);
  return { status: 'available', reason: null, correlation, sampleCount: a.length - 1,
    method: 'coingecko_7d_sparkline_index_grid', timestamped: false };
}

function summarizeCorrelationCoverage(pairs, threshold) {
  const rows = [];
  const unavailableReasons = {};
  let approvalFlagsOnUnavailableData = 0;
  let approvalDiagnosticDisagreements = 0;
  for (const { candidate, existing } of pairs) {
    const diagnostic = diagnoseAssetCorrelation(candidate, existing);
    const approvalCorrelation = assetCorrelation(candidate, existing);
    const approvalWouldFlag = approvalCorrelation !== null && approvalCorrelation >= threshold;
    const diagnosticWouldFlag = diagnostic.status === 'available' && diagnostic.correlation >= threshold;
    if (diagnostic.status === 'available') {
      if (approvalWouldFlag !== diagnosticWouldFlag) approvalDiagnosticDisagreements += 1;
      rows.push({ candidate: String(candidate.symbol).slice(0, 20), existing: String(existing.symbol).slice(0, 20),
        correlation: Number(diagnostic.correlation.toFixed(4)), approvalCorrelation: Number(approvalCorrelation.toFixed(4)),
        sampleCount: diagnostic.sampleCount, aboveConfiguredThreshold: diagnosticWouldFlag,
        approvalGateWouldFlag: approvalWouldFlag, estimatesAgree: approvalWouldFlag === diagnosticWouldFlag });
    } else {
      unavailableReasons[diagnostic.reason] = (unavailableReasons[diagnostic.reason] || 0) + 1;
      if (approvalWouldFlag) approvalFlagsOnUnavailableData += 1;
    }
  }
  const maxCorrelation = rows.length ? Math.max(...rows.map((row) => row.correlation)) : null;
  return { status: rows.length ? 'partial_or_complete' : 'unavailable', method: 'coingecko_7d_sparkline_index_grid',
    timestamped: false, usedForApproval: false, comparedPairs: rows.length + Object.values(unavailableReasons).reduce((sum, count) => sum + count, 0),
    comparablePairs: rows.length, unavailablePairs: Object.values(unavailableReasons).reduce((sum, count) => sum + count, 0),
    unavailableReasons, aboveConfiguredThreshold: rows.filter((row) => row.aboveConfiguredThreshold).length,
    approvalFlagsOnUnavailableData, approvalDiagnosticDisagreements,
    maximumObservedCorrelation: maxCorrelation, comparisons: rows.slice(0, 20),
    note: 'Ordered 7-day provider samples have no per-point timestamps; strict length/gap checks apply. Diagnostic only; not a calibrated portfolio model.' };
}

export function applyPortfolioRisk(candidates = [], openPredictions = [], universe = [], settings = {}) {
  const maximum = Math.max(1, Number(settings.maxConcurrentSignals) || 3);
  const correlationLimit = Math.max(0.4, Math.min(0.99, Number(settings.maxSignalCorrelation) || 0.82));
  const active = openPredictions.filter((prediction) => ['tracking', 'target_tracking'].includes(prediction.status));
  const bySymbol = new Map(universe.map((asset) => [String(asset.symbol).toUpperCase(), asset]));
  const exposures = active.map((prediction) => bySymbol.get(String(prediction.symbol).toUpperCase())).filter(Boolean);
  const maximumRiskPct = Math.max(.1, Number(settings.maxOpenRiskPct) || 1.5);
  const candidateRiskPct = Math.max(.1, Number(settings.accountRiskPct) || .5);
  let plannedRiskPct = active.reduce((sum, prediction) => sum + Math.max(.1, Number(prediction.accountRiskPct) || candidateRiskPct), 0);
  const symbols = new Set(active.map((row) => String(row.symbol).toUpperCase()));
  const selected = [];
  const rejected = [];
  const correlationPairs = [];
  for (const candidate of candidates) {
    const symbol = String(candidate.symbol).toUpperCase();
    for (const existing of [...exposures, ...selected]) {
      if (String(candidate.symbol).toUpperCase() !== String(existing.symbol).toUpperCase()) correlationPairs.push({ candidate, existing });
    }
    if (symbols.has(symbol)) { rejected.push({ asset: candidate, reason: `${symbol} already has an open or selected position.` }); continue; }
    if (plannedRiskPct + candidateRiskPct > maximumRiskPct + 1e-10) {
      rejected.push({ asset: candidate, reason: `Planned portfolio risk would exceed ${maximumRiskPct.toFixed(2)}%.` }); continue;
    }
    if (active.length + selected.length >= maximum) {
      rejected.push({ asset: candidate, reason: `Maximum ${maximum} concurrent signals reached.` });
      continue;
    }
    let conflict = null;
    for (const existing of [...exposures, ...selected]) {
      const correlation = assetCorrelation(candidate, existing);
      if (correlation != null && correlation >= correlationLimit) {
        conflict = { symbol: existing.symbol, correlation };
        break;
      }
    }
    if (conflict) rejected.push({ asset: candidate, reason: `${candidate.symbol}/${conflict.symbol} correlation ${conflict.correlation.toFixed(2)} exceeds ${correlationLimit.toFixed(2)}.` });
    else { selected.push(candidate); symbols.add(symbol); plannedRiskPct += candidateRiskPct; }
  }
  const correlationDiagnostics = summarizeCorrelationCoverage(correlationPairs, correlationLimit);
  return { selected, rejected, activeCount: active.length, maximum, correlationLimit, maximumRiskPct, plannedRiskPct, correlationDiagnostics };
}
