export function reviewMarketMappings(mappings, { now = Date.now(), maxAgeDays = 30 } = {}) {
  const confirmed = [], expired = [], unreviewed = [];
  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const hasIds = typeof mapping?.polymarketSlug === 'string' && mapping.polymarketSlug.trim()
      && typeof mapping?.kalshiTicker === 'string' && mapping.kalshiTicker.trim()
      && !/^(replace|todo|example)[-_]/i.test(mapping.kalshiTicker.trim())
      && !/^(replace|todo|example)[-_]/i.test(mapping.polymarketSlug.trim());
    const reviewedAt = Date.parse(mapping?.reviewedAt);
    if (mapping?.rulesReviewed !== true || !hasIds) {
      unreviewed.push(mapping);
      continue;
    }
    if (!Number.isFinite(reviewedAt) || reviewedAt > now || now - reviewedAt > maxAgeDays * 86_400_000) {
      expired.push(mapping);
      continue;
    }
    confirmed.push(mapping);
  }
  return { confirmed, expired, unreviewed };
}
