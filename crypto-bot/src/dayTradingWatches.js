import { selectSourcePinnedEntryQuote } from './researchStore.js';

/** Input is the existing confirmation screen's validation-advisory cohort, never raw discovery rows. */
export function buildDayTradingWatches(candidates = [], posted = [], now = new Date()) {
  const postedIds = new Set(posted.map(row => row.assetId));
  return candidates.filter(asset => !postedIds.has(asset.id) && asset.model?.technicallyConfirmed
    && !asset.model.dataConflict && !asset.model.executionBlocked && !asset.model.eventBlocked
    && !asset.model.derivativesBlocked && asset.model.regime?.allowNewLongs !== false)
    .map(asset => ({ asset, quote: selectSourcePinnedEntryQuote(asset, now) }))
    .filter(row => row.quote)
    .sort((a, b) => b.asset.model.score - a.asset.model.score)
    .slice(0, 5).map(({ asset, quote }) => ({
      assetId: asset.id, symbol: String(asset.symbol).toUpperCase(), score: asset.model.score,
      price: quote.ask, observedAt: quote.observedAt, source: quote.provider,
      change1h: asset.marketData?.technicals?.return1h ?? asset.change1h,
      providerCount: asset.model.providerCount,
      validationPassed: asset.model.validationPassed === true,
      reason: asset.model.validationPassed === true ? 'Final model, position and risk approval pending' : 'Forward strategy validation incomplete; not an approved entry',
      noticeKey: `${asset.id}:${asset.model.validationPassed === true ? 'validated-screen' : 'validation-pending'}`,
    }));
}

export function unannouncedDayTradingWatches(watches, noticeState, dateKey) {
  const prior = noticeState?.dateKey === dateKey ? new Set(noticeState.keys || []) : new Set();
  return watches.filter(row => !prior.has(row.noticeKey));
}

export function recordDayTradingWatchDelivery(noticeState, rows, dateKey) {
  const prior = noticeState?.dateKey === dateKey ? noticeState.keys || [] : [];
  return { dateKey, keys: [...new Set([...prior, ...rows.map(row => row.noticeKey)])] };
}
