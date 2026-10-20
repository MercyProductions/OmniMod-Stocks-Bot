// Synthetic frozen approval limits for monitor fixtures that seed persisted orders.
// Strategy/reservation tests obtain this record through the real approval path.
export const fillRiskPolicyFixture = () => ({ version: 'paper-fill-risk-v1', accountEquity: 10000,
  maxOpenPositions: 8, maxTotalOpenRiskUsd: 1000, maxGrossExposureUsd: 100000,
  maxInitialMarginUsd: 10000, maxDailyLossUsd: 100, maxOpenMarkAgeMs: 300000,
  closedTradeCircuit: { maxConsecutiveLosses: null, maxClosedDrawdownPct: null }, externalPortfolio: null });
