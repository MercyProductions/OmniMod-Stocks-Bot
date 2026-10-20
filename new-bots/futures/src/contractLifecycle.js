const ACTIVE_STATUSES = new Set(['reserved', 'filled', 'open']);
const POSITION_STATUSES = new Set(['filled', 'open']);
const SETTLEMENT_TYPES = new Set(['cash_settled', 'physical_delivery']);
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value) {
  if (typeof value !== 'string' || !ZONED_INSTANT.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : NaN;
}

function hasSafeHttpsSource(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Surface open Futures contract lifecycle deadlines without estimating settlement
 * prices, exchange calendars, or broker liquidation behavior.
 */
export function summarizeFuturesContractLifecycle(orders, now = Date.now(), warningWindowMs = 24 * 60 * 60_000) {
  if (!Array.isArray(orders)) throw new TypeError('Futures contract lifecycle needs an orders array.');
  if (!Number.isFinite(now) || !Number.isFinite(warningWindowMs) || warningWindowMs <= 0 || warningWindowMs > 30 * 24 * 60 * 60_000) {
    throw new TypeError('Futures contract lifecycle needs a finite timestamp and a warning window from 0 to 30 days.');
  }
  const active = orders.filter((order) => order?.owner === 'futures' && order?.assetClass === 'future'
    && ACTIVE_STATUSES.has(String(order?.status ?? '').toLowerCase()));
  const positions = active.filter((order) => POSITION_STATUSES.has(String(order.status).toLowerCase()));
  let expiredPositions = 0;
  let pastSettlementCutoffPositions = 0;
  let pastSettlementCutoffReservations = 0;
  let physicalFirstNoticePassedPositions = 0;
  let settlementCutoffWithinWindowPositions = 0;
  let missingOrInvalidMetadata = 0;
  let staleContractSpecs = 0;
  let staleSettlementReviews = 0;
  for (const order of active) {
    const future = order.future;
    const expiryAt = parseInstant(future?.expiryAt);
    const specVerifiedAt = parseInstant(future?.specVerifiedAt);
    const terms = future?.settlementReview;
    const settlementType = String(terms?.settlementType ?? '');
    const cutoffAt = parseInstant(terms?.entryCutoffAt);
    const lastTradeAt = parseInstant(terms?.lastTradeAt);
    const firstNoticeAt = terms?.firstNoticeAt == null ? NaN : parseInstant(terms.firstNoticeAt);
    const reviewedAt = parseInstant(terms?.reviewedAt);
    const hasValidTerms = SETTLEMENT_TYPES.has(settlementType)
      && Number.isFinite(cutoffAt) && Number.isFinite(lastTradeAt)
      && (settlementType !== 'physical_delivery' || Number.isFinite(firstNoticeAt));
    if (!future?.contractId || future?.contractMode !== 'active-contract' || future?.activeContract !== true
      || future?.contractSpecVerified !== true || !hasSafeHttpsSource(future?.specSource)
      || !Number.isFinite(expiryAt) || !hasValidTerms) missingOrInvalidMetadata += 1;
    if (!Number.isFinite(specVerifiedAt) || specVerifiedAt > now || now - specVerifiedAt > 90 * 24 * 60 * 60_000) staleContractSpecs += 1;
    if (!Number.isFinite(reviewedAt) || reviewedAt > now || now - reviewedAt > 90 * 24 * 60 * 60_000) staleSettlementReviews += 1;
    const isPosition = POSITION_STATUSES.has(String(order.status).toLowerCase());
    if (isPosition && Number.isFinite(expiryAt) && expiryAt <= now) expiredPositions += 1;
    if (Number.isFinite(cutoffAt) && cutoffAt <= now) {
      if (isPosition) pastSettlementCutoffPositions += 1;
      else pastSettlementCutoffReservations += 1;
    } else if (isPosition && Number.isFinite(cutoffAt) && cutoffAt - now <= warningWindowMs) {
      settlementCutoffWithinWindowPositions += 1;
    }
    if (isPosition && settlementType === 'physical_delivery' && Number.isFinite(firstNoticeAt) && firstNoticeAt <= now) {
      physicalFirstNoticePassedPositions += 1;
    }
  }
  const attention = expiredPositions + pastSettlementCutoffPositions + pastSettlementCutoffReservations
    + physicalFirstNoticePassedPositions + missingOrInvalidMetadata + staleContractSpecs + staleSettlementReviews > 0;
  return {
    status: attention ? 'attention_required' : settlementCutoffWithinWindowPositions ? 'approaching_cutoff' : 'clear',
    activeOrders: active.length,
    openPositions: positions.length,
    expiredPositions,
    pastSettlementCutoffPositions,
    pastSettlementCutoffReservations,
    physicalFirstNoticePassedPositions,
    settlementCutoffWithinWindowPositions,
    missingOrInvalidMetadata,
    staleContractSpecs,
    staleSettlementReviews,
    semantics: 'Contract-deadline warning only. No exchange session, settlement price, delivery, liquidation, or post-expiry P&L is inferred; resolve flagged positions against current exchange and broker rules.',
  };
}
