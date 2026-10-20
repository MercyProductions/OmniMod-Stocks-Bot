/** Source-reviewed supplemental ETP wrappers shared by the Stocks and ETF/ETP scanners. */
export function parseSupplementalEtpRegistry(value, { now = new Date(), maxReviewAgeDays = 180 } = {}) {
  return parseSupplementalEtpRegistryDetailed(value, { now, maxReviewAgeDays }).entries;
}

export function parseSupplementalEtpRegistryDetailed(value, { now = new Date(), maxReviewAgeDays = 180 } = {}) {
  if (!Array.isArray(value)) throw new Error('Supplemental ETP registry must be a JSON array.');
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const reviewAgeDays = Number(maxReviewAgeDays);
  if (!Number.isFinite(nowMs) || !Number.isFinite(reviewAgeDays) || reviewAgeDays <= 0) {
    throw new TypeError('Supplemental ETP review time and maximum age must be finite and positive.');
  }
  const maxAgeMs = reviewAgeDays * 86_400_000;
  const entries = new Map();
  const blockedSymbols = new Set();
  for (const row of value) {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const productType = String(row?.productType || '').trim().toLowerCase();
    const sourceUrl = String(row?.sourceUrl || row?.classificationSourceUrl || '').trim();
    const reviewedAt = Date.parse(row?.reviewedAt || row?.classificationReviewedAt || '');
    const exposureKey = String(row?.exposureKey || '').trim().toUpperCase();
    const leverage = Number(row?.leverage ?? 1);
    const inverse = row?.inverse === true;
    const hasWrapperIntent = /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)
      && ['etn', 'etv', 'commodity_pool', 'leveraged_etf', 'inverse_etf'].includes(productType);
    if (!hasWrapperIntent) continue;
    if (!/^https:\/\//i.test(sourceUrl) || !Number.isFinite(reviewedAt) || reviewedAt > nowMs + 5_000 || nowMs - reviewedAt > maxAgeMs
      || !/^[A-Z][A-Z0-9._-]{0,19}$/.test(exposureKey) || !Number.isFinite(leverage) || leverage < -5 || leverage > 5 || leverage === 0
      || inverse !== (leverage < 0) || (productType === 'inverse_etf' && !inverse) || (productType === 'leveraged_etf' && inverse)) {
      blockedSymbols.add(symbol);
      continue;
    }
    entries.set(symbol, { symbol, name: String(row.name || '').trim().slice(0, 120), exchange: String(row.exchange || '').toUpperCase(),
      instrumentType: 'etp', productType, exposureKey, leverage, inverse,
      classificationSourceUrl: sourceUrl, classificationReviewedAt: new Date(reviewedAt).toISOString(), source: 'supplemental-reviewed' });
  }
  return { entries: [...entries.values()], blockedSymbols: [...blockedSymbols] };
}
