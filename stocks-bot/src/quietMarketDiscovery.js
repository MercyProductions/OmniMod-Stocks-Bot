import { localDateKey, localParts, marketCloseMinute, marketSession } from './time.js';

const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
export const QUIET_DISCOVERY_VERSION = 'quiet-market-shadow-v1';

export function summarizeQuietResearch(track) {
  return { status: !track ? 'unavailable' : track.deferred ? 'deferred' : 'recorded',
    observedAt: track?.observedAt || null, productionApproval: false,
    universe: track?.diagnostics?.universe ?? null, qualified: track?.diagnostics?.qualified ?? null,
    selected: track?.diagnostics?.selected ?? null, capOmissions: track?.diagnostics?.capOmissions ?? null,
    rejectionCounts: track?.diagnostics?.rejectionCounts || {} };
}

/** Same-feed snapshots only. Scores are research ranks, never probabilities or approvals. */
export function rankQuietMarketSnapshots(snapshots, directory, {
  now = new Date(), feed = 'iex', previous = {}, limit = 5,
} = {}) {
  const observed = new Date(now), at = observed.getTime(), date = localDateKey(observed, 'America/New_York');
  const rejections = [], candidates = [], next = {};
  // Thousands of instruments usually share only a handful of candle timestamps.
  // Format each distinct exchange-local timestamp once per scan.
  const localCache = new Map(), durationCache = new Map();
  const local = ms => {
    if (!localCache.has(ms)) {
      const p = localParts(new Date(ms), 'America/New_York');
      localCache.set(ms, { date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`, minute: p.hour * 60 + p.minute });
    }
    return localCache.get(ms);
  };
  const reject = (symbol, reasonCode) => rejections.push({ symbol, stage: 'quiet_shadow', reasonCode });
  const validSession = marketSession(observed).state === 'regular';
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError('Quiet research cap must be 1–10');
  for (const asset of directory) {
    const symbol = asset.symbol, snapshot = snapshots[symbol];
    // The caller supplies the verified eligible directory, never raw unverified screener names.
    if (!validSession) { reject(symbol, 'regular_session_required'); continue; }
    if (!snapshot) { reject(symbol, 'snapshot_missing'); continue; }
    const trade = snapshot.latestTrade, bar = snapshot.minuteBar, day = snapshot.dailyBar, prior = snapshot.prevDailyBar;
    const sourceMs = Date.parse(trade?.t), barMs = Date.parse(bar?.t);
    const dayMs = Date.parse(day?.t), priorMs = Date.parse(prior?.t);
    const price = number(trade?.p), priorClose = number(prior?.c), priorVolume = number(prior?.v);
    if (!Number.isFinite(sourceMs) || at - sourceMs < 0 || at - sourceMs > 90000) { reject(symbol, 'trade_stale_or_future'); continue; }
    if (!Number.isFinite(barMs) || at - barMs < 60000 || at - barMs > 180000
      || local(barMs).date !== date || local(barMs).minute < 570) {
      reject(symbol, 'completed_regular_minute_required'); continue;
    }
    if (!(price >= 2 && priorClose > 0 && priorVolume > 0 && number(bar.v) > 0 && number(day?.v) > 0)
      || !Number.isFinite(dayMs) || !Number.isFinite(priorMs)
      || local(dayMs).date !== date
      || local(priorMs).date >= date) {
      reject(symbol, 'invalid_price_volume_or_daily_reference'); continue;
    }
    if (![bar.o, bar.h, bar.l, bar.c, day.h].every(x => number(x) > 0)
      || bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l > bar.h || day.h < price) {
      reject(symbol, 'invalid_ohlc'); continue;
    }
    const changeDay = (price / priorClose - 1) * 100;
    const rangePct = (bar.h - bar.l) / bar.c * 100;
    const distanceToHighPct = (day.h / price - 1) * 100;
    if (!durationCache.has(priorMs)) durationCache.set(priorMs, marketCloseMinute(new Date(priorMs)) - 570);
    const expectedMinuteVolume = priorVolume / durationCache.get(priorMs);
    const activityRatio = bar.v / expectedMinuteVolume;
    const priorSample = previous[symbol];
    const comparable = priorSample?.id === asset.id && priorSample.feed === feed && priorSample.date === date
      && priorSample.barMs < barMs && barMs - priorSample.barMs <= 30 * 60000;
    const sampledVolumeRatio = comparable && priorSample.volume > 0 ? bar.v / priorSample.volume : null;
    next[symbol] = { id: asset.id, feed, date, barMs, volume: bar.v };
    // Flat and modestly negative names remain eligible. Already-expanded moves are excluded from this track only.
    if (Math.abs(changeDay) > 1.5) { reject(symbol, 'move_already_expanded'); continue; }
    if (price * priorVolume < 250000) { reject(symbol, 'insufficient_reference_turnover'); continue; }
    if (activityRatio < 1.5 && !(sampledVolumeRatio >= 2)) { reject(symbol, 'no_unusual_activity'); continue; }
    if (rangePct > .35) { reject(symbol, 'minute_range_already_expanded'); continue; }
    if (distanceToHighPct > .3) { reject(symbol, 'not_near_session_high'); continue; }
    candidates.push({ symbol, assetId: asset.id, observedAt: observed.toISOString(), sourceAt: trade.t,
      price, changeDay, minuteRangePct: rangePct, distanceToSessionHighPct: distanceToHighPct,
      activityRatio, sampledVolumeRatio, feed, coverage: feed === 'iex' ? 'single_venue' : 'entitlement_dependent',
      score: Math.min(activityRatio, 10) + Math.min(sampledVolumeRatio || 0, 5) + (1 - rangePct / .35),
      version: QUIET_DISCOVERY_VERSION, track: 'quiet_market_shadow', productionApproval: false,
      evidence: ['unusual_activity', 'tight_observed_minute', 'near_observed_session_high'],
      limitations: ['Activity ratio uses prior-session average minute volume, not a time-of-day RVOL curve.',
        'Sampled volume ratio compares distinct snapshots; it is not continuous order flow.', 'No predictive or profitability evidence.'] });
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const counts = {};
  for (const row of rejections) counts[row.reasonCode] = (counts[row.reasonCode] || 0) + 1;
  return { version: QUIET_DISCOVERY_VERSION, track: 'quiet_market_shadow', observedAt: observed.toISOString(),
    productionApproval: false, candidates: candidates.slice(0, limit), next,
    diagnostics: { universe: directory.length, returnedSnapshots: directory.filter(a => snapshots[a.symbol]).length,
      qualified: candidates.length, selected: Math.min(candidates.length, limit), capOmissions: Math.max(0, candidates.length - limit),
      rejections, rejectionCounts: counts } };
}
