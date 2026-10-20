import { prepareFuturesDaySessionDraft } from './prepareDaySessionDraft.js';

/** Combine provider discovery with the existing fail-closed contract review draft. */
export function buildFuturesDiscoveryReview(discovery, products, { now = Date.now() } = {}) {
  if (!discovery || typeof discovery !== 'object' || !Array.isArray(discovery.contracts)) {
    throw new TypeError('Futures contract discovery result must include a contracts array.');
  }
  const reviewDraft = prepareFuturesDaySessionDraft(discovery.contracts, products, { now });
  const metrics = Array.isArray(discovery.metrics) ? discovery.metrics : [];
  const estimatedCost = metrics.find((row) => ['estimated-contract-discovery-cost', 'estimated-active-contract-discovery-cost'].includes(row?.operation));
  return {
    schemaVersion: 1,
    status: reviewDraft.draftedDefinitions ? 'review_required' : 'no_review_rows',
    provider: 'Databento',
    definitionsReceived: discovery.contracts.length,
    reviewRowsCreated: reviewDraft.draftedDefinitions,
    providerEstimatedCostUsd: Number.isFinite(Number(estimatedCost?.estimatedCostUsd))
      ? Number(estimatedCost.estimatedCostUsd) : null,
    volumeRankMappings: Array.isArray(discovery.mappingStatus) ? discovery.mappingStatus : null,
    volumeRankSelection: Array.isArray(discovery.mappingStatus)
      ? 'Databento continuous v.0 definition mapping (previous trading session volume rank); current-session liquidity remains unverified'
      : null,
    tradeEligibleContracts: 0,
    configuredDaySessionChanged: false,
    providerMetrics: metrics,
    reviewDraft,
    note: Array.isArray(discovery.mappingStatus)
      ? 'Provider volume-ranked v.0 definitions narrow the review worksheet to one prior-session highest-volume expiry per configured root. This is not proof of current-session liquidity or broker-verified contract specs, and it does not approve a day strategy, change the configured session file, or create a paper trade.'
      : 'Discovery output is only an unverified review worksheet. It does not select active/liquid contracts, approve a day strategy, change the configured session file, or create a paper trade.',
  };
}
