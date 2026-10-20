import { createHash } from 'node:crypto';
import { marketDateAt } from '../../shared/marketDate.js';
import { tradierUnderlyingSymbol } from '../../shared/optionContractIdentity.js';

// A preregistered research hypothesis, never an approved option trade or profit probability.
export const UNDERLYING_RESEARCH_VERSION = 'options-underlying-orb-research-v1';
export const UNDERLYING_RESEARCH_RULES = Object.freeze({
  timeframeMs: 60_000, openingRangeBars: 15, minBars: 24, volumeLookback: 20, atrLookback: 14,
  crossLookback: 2, minRelativeVolume: 1.5, bufferAtrFraction: 0.05, bufferPriceFraction: 0.0005,
  maxQuoteAgeMs: 15_000, maxBarAgeMs: 90_000, maxSpreadPct: 0.2, maxQuoteDriftPct: 0.5,
  maxStopPct: 1.25, referenceTargetR: 2, entryCloseBufferMs: 30 * 60_000, primarySignalMaxAgeMs: 120_000,
});
export const UNDERLYING_RESEARCH_HASH = createHash('sha256')
  .update(JSON.stringify({ version: UNDERLYING_RESEARCH_VERSION, rules: UNDERLYING_RESEARCH_RULES })).digest('hex');
const R = UNDERLYING_RESEARCH_RULES;
const number = (value) => typeof value === 'number' && Number.isFinite(value);
const positive = (value) => number(value) && value > 0;
const timestamp = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

/** Complete regular-session minute bars only. Missing minutes are not invented or forward-filled. */
export function evaluateUnderlyingResearch({ symbol, assetId, bars, quote, sessionOpen, sessionClose, now, feed } = {}) {
  const result = { symbol, assetId, version: UNDERLYING_RESEARCH_VERSION, configHash: UNDERLYING_RESEARCH_HASH,
    cohort: `${UNDERLYING_RESEARCH_VERSION}:${feed}`, observedAt: number(now) ? new Date(now).toISOString() : null,
    feed, researchOnly: true, eligibleForPaper: false, dataReady: false, status: 'data_rejected', reasons: [],
    direction: null, referenceLevels: null, metrics: null };
  const reject = (reason, status = 'data_rejected') => ({ ...result, status, reasons: [reason] });
  if (!tradierUnderlyingSymbol(symbol) || typeof assetId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(assetId)) return reject('invalid_underlying_identity');
  if (!['iex', 'sip'].includes(feed)) return reject('unsupported_research_feed');
  const open = timestamp(sessionOpen), close = timestamp(sessionClose);
  if (![now, open, close].every(number) || open % R.timeframeMs || close % R.timeframeMs
    || close <= open || close - open > 390 * R.timeframeMs
    || marketDateAt(open, 'America/New_York') !== marketDateAt(now, 'America/New_York')) return reject('invalid_session');
  if (now < open || now >= close) return reject('outside_regular_session');
  result.sessionDate = marketDateAt(now, 'America/New_York');
  result.sessionOpen = sessionOpen; result.sessionClose = sessionClose;
  if (!Array.isArray(bars) || !bars.length) return reject('bars_missing');
  if (bars.length > 390) return reject('bars_exceed_session');
  const normalized = [];
  for (const [i, bar] of bars.entries()) {
    const time = timestamp(bar?.t);
    if (!number(time) || time % R.timeframeMs || time < open || time + R.timeframeMs > now || time >= close) return reject('invalid_or_incomplete_bar_time');
    if (time !== open + i * R.timeframeMs) return reject('missing_duplicate_or_unordered_minutes');
    if (!['o', 'h', 'l', 'c', 'v', 'vw'].every((key) => positive(bar[key]))
      || bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l > bar.h
      || bar.vw < bar.l - 1e-7 || bar.vw > bar.h + 1e-7) return reject('invalid_bar_values');
    normalized.push({ ...bar, time });
  }
  const last = normalized.at(-1), lastEnd = last.time + R.timeframeMs;
  if (now - lastEnd > R.maxBarAgeMs) return reject('stale_bars');
  const quoteTime = timestamp(quote?.t);
  if (!number(quoteTime) || quoteTime > now || quoteTime < open || now - quoteTime > R.maxQuoteAgeMs
    || quoteTime < lastEnd || quoteTime - lastEnd > R.maxBarAgeMs) return reject('stale_future_or_unsynchronized_quote');
  if (!['bp', 'ap', 'bs', 'as'].every((key) => positive(quote?.[key])) || quote.ap < quote.bp) return reject('invalid_quote_values');
  const mid = (quote.bp + quote.ap) / 2, spreadPct = (quote.ap - quote.bp) / mid * 100;
  if (spreadPct > R.maxSpreadPct) return reject('underlying_spread_too_wide');
  if (Math.abs(mid / last.c - 1) * 100 > R.maxQuoteDriftPct) return reject('quote_moved_from_completed_bar');
  result.dataReady = true;
  if (normalized.length < R.minBars) return reject('insufficient_completed_minutes', 'strategy_rejected');
  if (now >= close - R.entryCloseBufferMs) return reject('late_session', 'strategy_rejected');
  const opening = normalized.slice(0, R.openingRangeBars);
  const rangeHigh = Math.max(...opening.map((bar) => bar.h)), rangeLow = Math.min(...opening.map((bar) => bar.l));
  const volume = normalized.reduce((sum, bar) => sum + bar.v, 0);
  const vwap = normalized.reduce((sum, bar) => sum + bar.vw * bar.v, 0) / volume;
  const stop = (rangeHigh + rangeLow) / 2;
  // The two-minute observation window fits the existing two-minute scheduler. It is not a claim to catch every breakout.
  let crossing = null;
  for (let i = normalized.length - R.crossLookback; i < normalized.length; i++) {
    const bar = normalized[i], previous = normalized[i - 1];
    const prior = normalized.slice(i - R.atrLookback, i);
    const atr = prior.reduce((sum, item, offset) => {
      const previousClose = normalized[i - R.atrLookback + offset - 1].c;
      return sum + Math.max(item.h - item.l, Math.abs(item.h - previousClose), Math.abs(item.l - previousClose));
    }, 0) / R.atrLookback;
    const buffer = Math.max(atr * R.bufferAtrFraction, bar.c * R.bufferPriceFraction);
    const direction = previous.c <= rangeHigh + buffer && bar.c > rangeHigh + buffer ? 'long'
      : previous.c >= rangeLow - buffer && bar.c < rangeLow - buffer ? 'short' : null;
    if (direction) {
      const meanVolume = normalized.slice(i - R.volumeLookback, i).reduce((sum, item) => sum + item.v, 0) / R.volumeLookback;
      crossing = { direction, time: bar.time, atr, buffer, relativeVolume: bar.v / meanVolume };
    }
  }
  result.metrics = { completedMinutes: normalized.length, rangeHigh, rangeLow, sessionVwap: vwap, spreadPct,
    lastClose: last.c, quoteAt: quote.t, volumeBasis: 'crossing minute / previous 20 completed minutes, same feed; not time-of-day adjusted',
    ...(crossing ? { crossingAt: new Date(crossing.time).toISOString(), atrBeforeCross: crossing.atr, breakoutBuffer: crossing.buffer, relativeVolume: crossing.relativeVolume } : {}) };
  if (!crossing) return reject('no_recent_opening_range_cross', 'strategy_rejected');
  const { direction, buffer, relativeVolume } = crossing;
  result.direction = direction;
  const held = direction === 'long' ? last.c > rangeHigh + buffer && quote.bp > rangeHigh + buffer && mid > vwap
    : last.c < rangeLow - buffer && quote.ap < rangeLow - buffer && mid < vwap;
  if (!held) return reject('breakout_not_held_or_vwap_disagrees', 'strategy_rejected');
  if (relativeVolume < R.minRelativeVolume) return reject('relative_volume_below_research_rule', 'strategy_rejected');
  const entryReference = direction === 'long' ? quote.ap : quote.bp;
  const distance = direction === 'long' ? entryReference - stop : stop - entryReference;
  if (!(distance > 0) || distance / entryReference * 100 > R.maxStopPct) return reject('invalidation_too_far', 'strategy_rejected');
  result.referenceLevels = { basis: 'underlying only; not option premium, fill or projected option return',
    entry: entryReference, invalidation: stop, target: entryReference + (direction === 'long' ? 1 : -1) * R.referenceTargetR * distance,
    referenceRewardRisk: R.referenceTargetR };
  result.remainingGates = ['catalyst_and_news_review', 'entitled_fresh_option_chain', 'defined_risk_spread_and_costs',
    'model_and_strategy_evidence', 'shared_portfolio_risk', 'untouched_and_forward_validation'];
  return { ...result, status: 'technical_watch' };
}

/** Upstream agreement is context, never a prerequisite for independent research or a trade approval. */
export function reconcileUnderlyingResearch(result, { signalRows = [], signalMappingDiagnostics = {}, now } = {}) {
  const key = tradierUnderlyingSymbol(result.symbol);
  const relevant = signalRows.map((row) => row.signal).filter((signal) => signal
    && tradierUnderlyingSymbol(signal.underlyingSymbol) === key && ['long', 'short'].includes(signal.direction)
    && ['stocks', 'etfs-etps'].includes(signal.primarySignalOwner) && signal.sessionDate === result.sessionDate
    && number(timestamp(signal.observedAt)) && timestamp(signal.observedAt) <= now
    && now - timestamp(signal.observedAt) <= R.primarySignalMaxAgeMs);
  // The mapping conflict is conservative: its source records were already freshness-filtered upstream.
  const mappedConflict = signalMappingDiagnostics.conflicts?.some((row) => tradierUnderlyingSymbol(row.symbol) === key) === true;
  const opposing = relevant.filter((signal) => result.direction && signal.direction !== result.direction);
  const conflict = mappedConflict || opposing.length > 0;
  const context = { status: conflict ? 'conflict' : relevant.length ? 'aligned' : signalMappingDiagnostics.status === 'complete' ? 'no_fresh_primary_context' : 'context_not_verified',
    freshPrimarySignals: relevant.length, owners: [...new Set(relevant.map((row) => row.primarySignalOwner))], mappingConflict: mappedConflict };
  return { ...result, primaryContext: context, ...(conflict && result.status === 'technical_watch'
    ? { status: 'withheld_for_conflict', reasons: [...result.reasons, 'opposing_primary_direction'] } : {}) };
}
