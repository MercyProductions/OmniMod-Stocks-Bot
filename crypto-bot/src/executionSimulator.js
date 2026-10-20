const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));

export function estimateExecutionCost(asset = {}, settings = {}) {
  const market = asset.marketData || {};
  const micro = market.microstructure || {};
  const orderUsd = Math.max(100, finite(settings.simulatedOrderUsd, 1000));
  const latencyMs = Math.max(50, finite(settings.executionLatencyMs, 750));
  const feeBps = clamp(settings.estimatedRoundTripBps ?? 20, 0, 300);
  const spreadBps = micro.available ? clamp(micro.spreadBps, 0, 500)
    : clamp(finite(market.medianSpreadPct) * 100, 0, 500);
  const depthUsd = Math.max(0, finite(micro.depthUsd1Pct));
  const depthImpactBps = depthUsd > 0 ? clamp(orderUsd / depthUsd * 1500, 0, 300) : spreadBps * 0.5;
  const atrPct = finite(market.technicals?.atrPct);
  const latencyVolatilityBps = clamp(
    micro.available ? finite(micro.quoteVolatilityBps) * Math.sqrt(Math.max(1, latencyMs / 1000))
      : atrPct * 100 * Math.sqrt(latencyMs / 900_000),
    0, 300
  );
  const adverseFlowBps = micro.available
    ? clamp(Math.max(0, -finite(micro.orderFlowImbalance)) * 12 + Math.max(0, -finite(micro.depthImbalance)) * 8, 0, 30) : 0;
  const oneWaySlippageBps = spreadBps / 2 + depthImpactBps + latencyVolatilityBps + adverseFlowBps;
  const roundTripSlippageBps = oneWaySlippageBps * 2;
  const estimatedRoundTripBps = feeBps + roundTripSlippageBps;
  const stressedRoundTripBps = feeBps + roundTripSlippageBps * 2.5;
  const maximum = Math.max(5, finite(settings.maxExecutionSlippageBps, 35));
  const blockTrade = oneWaySlippageBps > maximum
    || (micro.available && depthUsd > 0 && orderUsd > depthUsd * 0.1)
    || (micro.available && micro.adverseLiquidity && spreadBps > maximum * 0.6);
  return {
    available: Boolean(micro.available), orderUsd, latencyMs, feeBps, spreadBps, depthUsd,
    depthImpactBps, latencyVolatilityBps, adverseFlowBps, oneWaySlippageBps,
    roundTripSlippageBps, estimatedRoundTripBps, stressedRoundTripBps, maximumOneWaySlippageBps: maximum,
    blockTrade, quality: micro.available ? 'live microstructure' : 'REST/ATR fallback',
    reason: blockTrade ? `Estimated one-way execution cost ${oneWaySlippageBps.toFixed(1)} bps exceeds liquidity tolerance.` : ''
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function monteCarloCostStress(outcomes = [], options = {}) {
  const iterations = Math.max(100, Math.min(10_000, Number(options.iterations) || 1000));
  const random = seededRandom(Number(options.seed) || 94721);
  const baseCostBps = Math.max(0, finite(options.baseCostBps, 20));
  const stressMultiplier = Math.max(1, finite(options.stressMultiplier, 3));
  const results = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (const row of outcomes) {
      const stopPct = Math.max(0.2, finite(row.stopPct, 2.5));
      const stressedCostBps = baseCostBps * (1 + random() * (stressMultiplier - 1));
      const bookedCostBps = Math.max(0, finite(row.estimatedCostPct)) * 100;
      const costR = Math.max(0, stressedCostBps - bookedCostBps) / 10_000 / (stopPct / 100);
      const realizedR = finite(row.realizedR);
      sum += realizedR - costR;
    }
    results.push(outcomes.length ? sum / outcomes.length : 0);
  }
  results.sort((a, b) => a - b);
  return {
    iterations, samples: outcomes.length, baseCostBps, stressMultiplier,
    medianExpectancyR: results[Math.floor(results.length * 0.5)] || 0,
    p05ExpectancyR: results[Math.floor(results.length * 0.05)] || 0,
    probabilityPositive: results.filter((value) => value > 0).length / results.length,
    passed: results[Math.floor(results.length * 0.05)] > 0
  };
}
