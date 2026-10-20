const ACTIVE = new Set(['reserved', 'filled', 'open']);
const MARKED = new Set(['filled', 'open']);
const REJECTED = new Set(['blocked', 'duplicate_or_out_of_order_quote', 'error']);

/** Summarize quote coverage and post-scan freshness without exposing order identities. */
export function summarizePositionMarkCoverage({
  owner, beforeOrders = [], afterOrders = [], availableMarks = [], attempts = [], now = Date.now(), maxAgeMs = 5 * 60_000,
} = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Mark diagnostic clock must be valid.');
  const validAgePolicy = Number.isFinite(maxAgeMs) && maxAgeMs >= 1_000 && maxAgeMs <= 24 * 60 * 60_000;
  const effectiveScanMaxAge = validAgePolicy ? maxAgeMs : 0;
  const before = beforeOrders.filter((row) => row.owner === owner && MARKED.has(row.status));
  const after = afterOrders.filter((row) => row.owner === owner && MARKED.has(row.status));
  const expectedIds = new Set(before.map((row) => String(row.orderId)));
  const availableIds = new Set(availableMarks.filter((row) => row?.orderId && expectedIds.has(String(row.orderId))).map((row) => String(row.orderId)));
  const attemptedById = new Map(attempts.filter((row) => row?.orderId && expectedIds.has(String(row.orderId)))
    .map((row) => [String(row.orderId), row]));
  const reasons = {};
  let quoteRejected = 0, accepted = 0;
  for (const [orderId, row] of attemptedById) {
    const status = String(row.status || row.result?.status || 'unknown');
    if (REJECTED.has(status)) {
      quoteRejected++;
      const reason = String(row.reason || row.result?.reason || status).slice(0, 80);
      reasons[reason] = (reasons[reason] || 0) + 1;
    } else if (['open', 'filled', 'closed'].includes(status)) accepted++;
  }
  let staleOrUnmarkedPositions = 0;
  for (const order of after) {
    const markedAt = Date.parse(order.markedAt ?? order.lastProcessedQuoteTime ?? order.filledAt ?? '');
    const ageMs = Number.isFinite(markedAt) ? now - markedAt : Infinity;
    const savedLimit = Number(order.maxOpenMarkAgeMs);
    const limit = Number.isFinite(savedLimit) && savedLimit > 0 ? Math.min(effectiveScanMaxAge, savedLimit) : effectiveScanMaxAge;
    if (!validAgePolicy || !Number.isFinite(markedAt) || markedAt > now + 5_000 || ageMs > limit) staleOrUnmarkedPositions++;
  }
  return {
    expectedPositions: before.length,
    quotesProvided: availableIds.size,
    quoteMissing: Math.max(0, before.length - availableIds.size),
    quoteAttempts: attemptedById.size,
    quoteAccepted: accepted,
    quoteRejected,
    rejectionReasons: reasons,
    freshPositions: after.length - staleOrUnmarkedPositions,
    staleOrUnmarkedPositions,
    maximumMarkAgeMs: validAgePolicy ? maxAgeMs : null,
    markAgePolicyValid: validAgePolicy,
  };
}
