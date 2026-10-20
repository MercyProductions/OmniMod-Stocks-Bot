import { summarizePerformance } from './predictionEngine.js';

/** Format a stock replay segment without presenting empty samples as zero-return evidence. */
export function formatBacktestSegment(predictions = []) {
  const result = summarizePerformance(predictions);
  const hasGradedTrades = result.closed > 0;
  const signalSessions = new Set(predictions.map((row) => row.dateKey).filter(Boolean)).size;
  const gradedRows = predictions.filter((row) => ['loss', 'fell_short', 'target_hit', 'exceeded'].includes(row.status));
  const gradedSessions = new Set(gradedRows.map((row) => row.dateKey).filter(Boolean)).size;
  const outcomeStatuses = ['loss', 'fell_short', 'target_hit', 'exceeded', 'not_filled'];
  const performanceByOutcome = Object.fromEntries(outcomeStatuses.map((status) => {
    const rows = predictions.filter((row) => row.status === status);
    const metrics = summarizePerformance(rows);
    const hasGradedRows = metrics.closed > 0;
    return [status, {
      count: rows.length,
      graded: metrics.closed,
      netR: hasGradedRows ? Number(metrics.netR.toFixed(3)) : null,
      expectancyR: hasGradedRows ? Number(metrics.expectancyR.toFixed(3)) : null,
      profitFactor: !hasGradedRows ? null
        : Number.isFinite(metrics.profitFactor) ? Number(metrics.profitFactor.toFixed(3)) : 'Infinity',
      maxDrawdownR: hasGradedRows ? Number(metrics.maxDrawdownR.toFixed(3)) : null,
    }];
  }));
  return {
    signals: result.total,
    graded: result.closed,
    signalSessions,
    gradedSessions,
    performanceStatus: hasGradedTrades ? 'descriptive only; inspect trade and session sample sizes' : 'no graded trades; estimates unavailable',
    targetHitRate: hasGradedTrades ? `${result.winRate.toFixed(1)}%` : null,
    profitableRate: hasGradedTrades ? `${result.profitableRate.toFixed(1)}%` : null,
    expectancyR: hasGradedTrades ? Number(result.expectancyR.toFixed(3)) : null,
    profitFactor: !hasGradedTrades ? null
      : Number.isFinite(result.profitFactor) ? Number(result.profitFactor.toFixed(3)) : 'Infinity',
    maxDrawdownR: hasGradedTrades ? Number(result.maxDrawdownR.toFixed(3)) : null,
    netR: hasGradedTrades ? Number(result.netR.toFixed(3)) : null,
    performanceByOutcome,
  };
}
