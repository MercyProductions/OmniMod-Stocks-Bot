export function isFreshClearCatalystReview(review, { now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  const reviewedAt = Number.isFinite(Number(review?.reviewedAt)) ? Number(review.reviewedAt) : Date.parse(review?.reviewedAt);
  return review?.status === 'clear'
    && typeof review.source === 'string' && review.source.trim().length >= 3
    && typeof review.summary === 'string' && review.summary.trim().length >= 5
    && Number.isFinite(reviewedAt) && reviewedAt <= now + 5_000 && now - reviewedAt <= maxAgeMs
    && Number.isFinite(maxAgeMs) && maxAgeMs > 0;
}
