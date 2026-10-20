export const FUTURES_ESTIMATE_OPERATIONS = new Set(['estimated-scan-cost', 'estimated-contract-discovery-cost',
  'estimated-activity-discovery-cost', 'estimated-h1-cost', 'estimated-active-contract-discovery-cost']);

const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Reserve accepted historical estimates, including requests interrupted after their paid stream starts. */
export function summarizeFuturesHistoricalBudget(metrics = []) {
  let reserved = 0, estimates = 0, invalid = false;
  const byOperation = {};
  for (const row of metrics) {
    if (!FUTURES_ESTIMATE_OPERATIONS.has(row.operation)) continue;
    estimates++;
    const cost = amount(row.estimatedCostUsd), cap = amount(row.configuredCapUsd);
    if (cost === null) { invalid = true; continue; }
    byOperation[row.operation] = (byOperation[row.operation] || 0) + cost;
    // Legacy adapters emit an estimate before rejecting over-cap downloads.
    if (row.budgetReserved === false || (cap !== null && cost > cap)) continue;
    reserved += cost;
  }
  return { estimates, invalid, reservedUsd: invalid || !Number.isFinite(reserved) ? null : reserved, byOperation };
}

export function remainingFuturesHistoricalBudget(cap, metrics = []) {
  if (!(typeof cap === 'number' && Number.isFinite(cap) && cap > 0)) return 0;
  const report = summarizeFuturesHistoricalBudget(metrics);
  // Remove arithmetic dust (e.g. 0.3 - 0.1), not meaningful fractions of the user's cap.
  return report.reservedUsd === null ? 0 : Number(Math.max(0, cap - report.reservedUsd).toPrecision(15));
}
