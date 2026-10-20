import { replayChronologicalPaper } from '../../shared/chronologicalReplay.js';
import { replayWithShadowConfigs } from '../../shared/shadowReplay.js';
import { resolveEtfExposureKey } from './exposure.js';
import { evaluateOpeningRangeBreakout } from './strategies.js';

export const ETF_ORB_STRATEGY_ID = 'etp-opening-range-breakout-v1';

/** Replay the unchanged ETF/ETP ORB against point-in-time bars, quotes, sessions and catalyst reviews. */
export async function replayEtfOpeningRange({ symbol, exposureKey, assetClass = 'etf', observations, fiveMinuteBars,
  accountEquityUsd, policy = {}, config = {}, scoreFrom = null, shadowConfigs = [], executionCostSchedule }) {
  if (!symbol) throw new Error('A single ETF/ETP symbol is required for replay.');
  if (!['etf', 'etp'].includes(String(assetClass).toLowerCase())) throw new Error('Replay instrument must be an ETF or ETP.');
  const normalized = String(symbol).trim().toUpperCase();
  const canonicalExposure = resolveEtfExposureKey(normalized, exposureKey);
  const evaluateForConfig = (strategyConfig) => ({ asOf, quote, bars, context, executionCosts }) => evaluateOpeningRangeBreakout({
    symbol: normalized, exposureKey: canonicalExposure, assetClass, bars, quote,
    session: context?.session, now: Date.parse(asOf),
    config: executionCosts ? { ...strategyConfig, roundTripFeesPerUnit: executionCosts.roundTripFeesPerUnit,
      slippageReservePerUnit: executionCosts.slippageReservePerUnit } : strategyConfig,
  });
  const baseOptions = { owner: 'etfs-etps', assetClass: String(assetClass).toLowerCase(), instrumentKey: normalized,
    exposureKey: canonicalExposure, strategyId: ETF_ORB_STRATEGY_ID, observations, bars: fiveMinuteBars,
    scoreFrom, accountEquityUsd, policy, executionCostSchedule };
  if (!shadowConfigs.length) return replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(config) });
  return replayWithShadowConfigs({ baseOptions, baseConfig: config, shadowConfigs,
    allowedOverrides: ['rangeBars', 'minRelativeVolume', 'breakoutBufferAtr', 'breakoutBufferBps'], evaluateForConfig });
}
