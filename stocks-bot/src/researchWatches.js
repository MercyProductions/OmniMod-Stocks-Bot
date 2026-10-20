export function buildResearchWatches(analysis, posted = [], confirmed = [], now = new Date()) {
  const postedSymbols = new Set(posted.map((row) => row.symbol));
  const confirmedSymbols = new Set(confirmed.map((row) => row.symbol));
  return [...(analysis.candidates || []), ...(analysis.watchCandidates || [])]
    .filter((asset) => !postedSymbols.has(asset.symbol))
    .map((asset) => {
      const upward = asset.ema9 > asset.ema21 && Number(asset.change1h) > 0 && Number(asset.changeDay) > 0;
      const price = Number(asset.price);
      // Early-watch levels are deliberately broad ATR references, not model-approved orders.
      const atrPct = Math.max(0.55, Math.min(2.6, Number(asset.atrPercent) > 0 ? Number(asset.atrPercent) * 0.38 : 0.75));
      return {
      symbol: asset.symbol, score: asset.model.score,
      reasons: asset.selectionTier === 'qualified'
        ? [confirmedSymbols.has(asset.symbol) ? 'model or portfolio approval pending' : 'needs another confirming scan']
        : asset.rejectionReasons,
      screen: asset.selectionTier === 'qualified' ? 'screen passed; model/portfolio pending' : 'screen developing',
      direction: upward ? 'UPWARD WATCH' : 'DIRECTION UNCLEAR',
      price: asset.price,
      changeDay: asset.changeDay,
      ...(upward && Number.isFinite(price) && price > 0 ? {
        referenceEntry: price,
        referenceTarget1: price * (1 + atrPct * 1.25 / 100),
        referenceInvalidation: price * (1 - atrPct / 100),
        referenceMovePct: atrPct * 1.25
      } : {}),
      change1h: asset.change1h, relativeVolume: asset.relativeVolume,
      dataQuality: asset.dataQuality, observedAt: asset.lastUpdated || now.toISOString()
    };
    })
    .sort((a, b) => Number(b.direction === 'UPWARD WATCH') - Number(a.direction === 'UPWARD WATCH')
      || Number(b.screen.startsWith('screen passed')) - Number(a.screen.startsWith('screen passed'))
      || b.score - a.score)
    .slice(0, 5);
}

const PREMARKET_CONTEXT = new Set(['SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLY','XLI','XLP','XLU','XLC','XLB','XLRE']);
const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const easternDateClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
});

function easternDate(timestamp) {
  const value = Date.parse(timestamp || '');
  return Number.isFinite(value) ? easternDateClock.format(new Date(value)) : '';
}

function easternMinute(timestamp) {
  const value = Date.parse(timestamp || '');
  if (!Number.isFinite(value)) return NaN;
  const parts = Object.fromEntries(easternClock.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

// This is a discovery-only path. It deliberately does not inherit regular-session
// momentum gates, model approval, or trade/risk approval; it only publishes a
// fresh, liquid, sufficiently large premarket break of the prior 20-session high.
export function analyzePremarketBreakoutWatches(assets = [], now = new Date(), options = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const minQuality = Number(options.minDataQuality ?? 60);
  const minPrice = Number(options.minPrice ?? 2);
  const minAverageVolume = Number(options.minAverageVolume ?? 500_000);
  const minMovePct = Number(options.minMovePct ?? 1);
  const minRangeMovePct = Number(options.minRangeMovePct ?? 0.5);
  const minPremarketRelativeVolume = Number(options.minPremarketRelativeVolume ?? 1.5);
  const diagnostics = { considered: 0, freshCrossProviderPrices: 0, stages: { inWindow: 0, fresh: 0, dataQuality: 0, priceAndLiquidity: 0, movement: 0, breakout: 0 }, rejectionCounts: {}, rejections: [] };
  if (!Number.isFinite(nowMs)) return { watches: [], diagnostics };
  const watches = [];
  for (const asset of assets) {
    if (!asset?.symbol || PREMARKET_CONTEXT.has(asset.symbol)) continue;
    diagnostics.considered += 1;
    const chartAt = Date.parse(asset?.lastUpdated || '');
    const liveAt = Date.parse(asset?.livePriceUpdatedAt || '');
    const livePrice = Number(asset?.livePrice);
    const useFreshLivePrice = Number.isFinite(livePrice) && livePrice > 0
      && Number.isFinite(liveAt) && liveAt > chartAt && nowMs - liveAt >= 0 && nowMs - liveAt <= 5 * 60_000
      && asset.livePriceProvider && asset.livePriceProvider !== asset.provider;
    if (useFreshLivePrice) diagnostics.freshCrossProviderPrices += 1;
    const observedAt = useFreshLivePrice ? asset.livePriceUpdatedAt : asset.lastUpdated;
    const price = useFreshLivePrice ? livePrice : Number(asset?.price);
    const previousClose = Number(asset?.previousClose);
    const movePct = useFreshLivePrice
      ? (previousClose > 0 ? (price / previousClose - 1) * 100 : NaN)
      : Number(asset?.changeDay);
    const priorHigh = Number(asset?.previous20High);
    const ageMs = nowMs - Date.parse(observedAt || '');
    const minute = useFreshLivePrice ? easternMinute(observedAt) : Number(asset?.marketMinute);
    const baseQuality = Number(asset?.dataQuality);
    // Remove only the stale-chart deduction when this scan has a newer, fresh trade.
    const quality = useFreshLivePrice && asset.freshness === 'stale' && Number.isFinite(baseQuality)
      ? Math.min(100, baseQuality + 30) : baseQuality;
    const averageVolume = Number(asset?.averageDailyVolume);
    const reject = (code) => {
      diagnostics.rejectionCounts[code] = (diagnostics.rejectionCounts[code] || 0) + 1;
      diagnostics.rejections.push({ symbol: asset.symbol, stage: 'premarket', reasonCode: code });
    };
    const observationDate = easternDate(observedAt);
    const chartPremarketDate = String(asset.premarketSessionDate || easternDate(asset.lastUpdated));
    const premarketBarsMatchObservation = chartPremarketDate === observationDate;
    const hasPremarketBars = premarketBarsMatchObservation && Number(asset.premarketBarCount) > 0;
    if (!Number.isFinite(minute) || minute < 240 || minute >= 570 || (!hasPremarketBars && !useFreshLivePrice)) { reject('no_current_premarket_observation'); continue; }
    diagnostics.stages.inWindow += 1;
    if ((!useFreshLivePrice && asset.freshness === 'stale') || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > (useFreshLivePrice ? 5 : 20) * 60_000) { reject('stale_or_old_observation'); continue; }
    diagnostics.stages.fresh += 1;
    if (!Number.isFinite(quality) || quality < minQuality) { reject('data_quality_below_floor'); continue; }
    diagnostics.stages.dataQuality += 1;
    if (!Number.isFinite(price) || price < minPrice || !Number.isFinite(averageVolume) || averageVolume < minAverageVolume) { reject('price_or_average_volume_below_floor'); continue; }
    diagnostics.stages.priceAndLiquidity += 1;
    if (!Number.isFinite(movePct)) { reject('day_move_unavailable'); continue; }
    diagnostics.stages.movement += 1;
    const breakoutTypes = [];
    if (Number.isFinite(priorHigh) && priorHigh > 0 && price > priorHigh && movePct >= minMovePct)
      breakoutTypes.push('prior_20_session_high');
    const rangeHigh = hasPremarketBars ? Number(asset.premarketRangeHigh) : NaN, relativeVolume = !hasPremarketBars || asset.premarketRelativeVolume === null
      || asset.premarketRelativeVolume === undefined ? NaN : Number(asset.premarketRelativeVolume);
    const priceClearedRange = Number.isFinite(rangeHigh) && rangeHigh > 0 && price > rangeHigh * 1.002 && movePct >= minRangeMovePct;
    const rangeBreakout = Number(asset.premarketBarCount) >= 4 && priceClearedRange
      && Number.isFinite(relativeVolume) && relativeVolume >= minPremarketRelativeVolume;
    if (rangeBreakout) breakoutTypes.push('premarket_range_high');
    if (!breakoutTypes.length) {
      reject(priceClearedRange && Number(asset.premarketBarCount) < 4 ? 'premarket_bars_insufficient'
        : priceClearedRange && (!Number.isFinite(relativeVolume) || relativeVolume < minPremarketRelativeVolume) ? 'premarket_relative_volume_unconfirmed'
          : 'no_breakout_level_cleared');
      continue;
    }
    diagnostics.stages.breakout += 1;
    const screen = breakoutTypes.length > 1 ? 'premarket range and 20-session high breakout'
      : breakoutTypes[0] === 'premarket_range_high' ? 'premarket range high cleared with volume confirmation'
        : 'premarket 20-session high breakout';
    watches.push({
      symbol: asset.symbol, score: Number(asset.model?.score) || 0, dataQuality: quality,
      direction: 'UPWARD WATCH', screen,
      reasons: ['Premarket discovery only; recheck regular-session liquidity, spread, and price before making any decision.'],
      price, changeDay: movePct, change1h: Number(asset.change1h) || 0,
      relativeVolume: Number(asset.relativeVolume) || 0, previous20High: priorHigh,
      premarketRangeHigh: rangeHigh > 0 ? rangeHigh : null, premarketRelativeVolume: Number.isFinite(relativeVolume) ? relativeVolume : null,
      breakoutTypes, premarketBreakout: true, session: 'pre_market', lastUpdated: observedAt,
      observedAt, priceSource: useFreshLivePrice ? asset.livePriceProvider : asset.provider
    });
  }
  watches.sort((a, b) => b.changeDay - a.changeDay || b.dataQuality - a.dataQuality);
  diagnostics.breakoutCandidates = watches.length;
  diagnostics.watchCapOmissions = Math.max(0, watches.length - 5);
  diagnostics.rejections = diagnostics.rejections.slice(0, 500);
  return { watches: watches.slice(0, 5), diagnostics };
}

export function buildPremarketBreakoutWatches(assets = [], now = new Date(), options = {}) {
  return analyzePremarketBreakoutWatches(assets, now, options).watches;
}

export function newResearchWatchUpdates(watches, previousDiscovery) {
  const announced = new Set(previousDiscovery?.watchNoticeSymbols || previousDiscovery?.watchOnly?.map((row) => row.symbol) || []);
  const priorRows = new Map((previousDiscovery?.watchOnly || []).map((row) => [row.symbol, row]));
  const announcedPremarket = new Set(previousDiscovery?.premarketWatchNoticeKeys || []);
  for (const row of previousDiscovery?.watchOnly || []) {
    if (row.session !== 'pre_market' || !row.premarketBreakout) continue;
    announcedPremarket.add(`${row.symbol}:${[...(row.breakoutTypes || ['prior_20_session_high'])].sort().join('+')}`);
  }
  return watches.filter((row) => row.direction === 'UPWARD WATCH'
    && (row.session === 'pre_market'
      ? Boolean(row.premarketBreakout) && !announcedPremarket.has(`${row.symbol}:${[...(row.breakoutTypes || [])].sort().join('+')}`)
      : (!announced.has(row.symbol) || priorRows.get(row.symbol)?.session === 'pre_market'
        || (priorRows.get(row.symbol)?.screen !== row.screen && row.screen.startsWith('screen passed')))))
    .slice(0, 5);
}

export function premarketWatchNoticeKey(row) {
  return `${row.symbol}:${[...(row.breakoutTypes || [])].sort().join('+')}`;
}
