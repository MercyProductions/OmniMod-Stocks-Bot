import { validateStrategy } from './backtest.js';
import { assessStrategyValidation } from './cryptoData.js';

const observed = (value, trades) => Number.isInteger(trades) && trades > 0 && Number.isFinite(value) ? value : null;

function segment(validation, name) {
  const row = validation?.[name];
  return {
    trades: Number.isInteger(row?.trades) ? row.trades : null,
    expectancyR: observed(row?.expectancyR, row?.trades),
    profitFactor: observed(row?.profitFactor, row?.trades),
    signalDays: validation?.coverage?.[name]?.signalDays ?? null,
  };
}

// Research only: one current quote-cost estimate is replayed over earlier candles.
// This is not a point-in-time historical cost series or a production approval gate.
export function compareCurrentQuoteCost({ candles = [], baseline = null, execution = null,
  providerCount = 0, conflicted = false, minimumScore = 64, rewardRisk = 1.7 } = {}) {
  const unavailable = (reason) => ({ status: 'unavailable', reason });
  if (!baseline || !Array.isArray(candles) || candles.length < 100) return unavailable('missing_historical_validation');
  if (baseline.dataQuality?.contiguous !== true) return unavailable('incomplete_historical_candle_path');
  if (providerCount < 2 || conflicted) return unavailable('executable_quote_consensus_unavailable');
  const baselineCostBps = baseline.costModel?.roundTripBps;
  const quoteCostBps = execution?.estimatedRoundTripBps;
  if (!Number.isFinite(baselineCostBps) || !Number.isFinite(quoteCostBps)
    || baselineCostBps < 0 || baselineCostBps > 200 || quoteCostBps < 0 || quoteCostBps > 200)
    return unavailable('cost_outside_replay_range');
  const scenario = validateStrategy(candles, { minimumScore, rewardRisk, roundTripFeeBps: quoteCostBps });
  const baselineAssessment = assessStrategyValidation(baseline);
  const scenarioAssessment = assessStrategyValidation(scenario);
  return {
    status: 'compared', basis: 'current_quote_cost_applied_to_prior_candles',
    costQuality: execution.quality || 'unknown', baselineCostBps, quoteCostBps,
    baselinePassed: baselineAssessment.passed, quoteScenarioPassed: scenarioAssessment.passed,
    baselineReasons: baselineAssessment.reasons, quoteScenarioReasons: scenarioAssessment.reasons,
    baseline: { recent: segment(baseline, 'recent'), overall: segment(baseline, 'overall') },
    quoteScenario: { recent: segment(scenario, 'recent'), overall: segment(scenario, 'overall') },
  };
}
