import { replayChronologicalPaper } from '../../shared/chronologicalReplay.js';
import { replayWithShadowConfigs } from '../../shared/shadowReplay.js';
import { evaluateFuturesOpeningRange } from './dayStrategy.js';
import { validateActiveFutureContract } from './universe.js';

export const FUTURES_ORB_STRATEGY_ID = 'future-session-orb-h1-v1';

/** Run the unchanged Futures opening-range strategy over point-in-time supplied data. */
export async function replayFuturesOpeningRange({ contract, observations, fiveMinuteBars, accountEquityUsd, policy = {}, config = {}, scoreFrom = null, shadowConfigs = [], executionCostSchedule }) {
  if (!contract?.contractId) throw new Error('A single verified listed futures contract is required for this replay.');
  const evaluateForConfig = (strategyConfig) => ({ asOf, quote, bars, context, executionCosts }) => {
    const now = Date.parse(asOf);
    let historicalContract;
    try {
      historicalContract = validateActiveFutureContract(context?.contract || contract, {
        now, maxSpecAgeDays: Number(strategyConfig.maxSpecAgeDays ?? 90),
      });
    } catch {
      return { status: 'no-setup', strategy: FUTURES_ORB_STRATEGY_ID, reasons: ['historical_contract_metadata_not_valid_as_of_decision'] };
    }
    return evaluateFuturesOpeningRange({
      contract: historicalContract, bars, trendBars: context?.trendBars, quote,
      session: context?.session, now, catalystReview: context?.catalystReview,
      accountEquityUsd, config: executionCosts ? { ...strategyConfig,
        roundTripFeesPerContract: executionCosts.roundTripFeesPerUnit,
        slippageReservePerContract: executionCosts.slippageReservePerUnit } : strategyConfig,
    });
  };
  const baseOptions = {
    owner: 'futures', assetClass: 'future', instrumentKey: contract.contractId,
    exposureKey: contract.exposureKey || contract.contractId,
    strategyId: FUTURES_ORB_STRATEGY_ID, observations, bars: fiveMinuteBars,
    scoreFrom, accountEquityUsd, policy, executionCostSchedule,
  };
  if (!shadowConfigs.length) return replayChronologicalPaper({ ...baseOptions, evaluate: evaluateForConfig(config) });
  return replayWithShadowConfigs({ baseOptions, baseConfig: config, shadowConfigs,
    allowedOverrides: ['rangeBars', 'minRelativeVolume', 'breakoutBufferAtr'], evaluateForConfig });
}
