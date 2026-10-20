import { replayChronologicalPaper } from '../../shared/chronologicalReplay.js';
import { replayWithShadowConfigs } from '../../shared/shadowReplay.js';
import { evaluateForexDayBreakout } from './dayStrategy.js';

export const FOREX_DAY_STRATEGY_ID = 'forex-m15-range-breakout-h1-trend-v2';

/** Replay the unchanged Forex day strategy from timestamped M15 bars, H1 context and executable quotes. */
export async function replayForexDayBreakout({ instrument, observations, m15Bars, accountEquityUsd,
  policy = {}, config = {}, scoreFrom = null, shadowConfigs = [], executionCostSchedule }) {
  if (!/^[A-Z]{3}_[A-Z]{3}$/.test(String(instrument ?? ''))) throw new Error('A single normalized Forex instrument such as EUR_USD is required.');
  const normalized = String(instrument).toUpperCase();
  const evaluateForConfig = (strategyConfig) => ({ asOf, quote, bars, context, executionCosts }) => evaluateForexDayBreakout({
    instrument: normalized, quote, m15: bars, h1: context?.h1Bars, now: Date.parse(asOf),
    sessionDate: context?.sessionDate, catalystReview: context?.catalystReview,
    config: executionCosts ? { ...strategyConfig, roundTripFeesPerUnit: executionCosts.roundTripFeesPerUnit,
      slippageReservePerUnit: executionCosts.slippageReservePerUnit } : strategyConfig,
  });
  const baseOptions = { owner: 'forex', assetClass: 'forex', instrumentKey: normalized,
    exposureKey: normalized, strategyId: FOREX_DAY_STRATEGY_ID, observations, bars: m15Bars,
    scoreFrom, accountEquityUsd, policy, executionCostSchedule };
  if (!shadowConfigs.length) return replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(config) });
  return replayWithShadowConfigs({ baseOptions, baseConfig: config, shadowConfigs,
    allowedOverrides: ['breakoutBars', 'breakoutBufferAtr'], evaluateForConfig });
}
