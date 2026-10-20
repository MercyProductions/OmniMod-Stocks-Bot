const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));

// Bump when the meaning or scaling of any model feature changes.
export const FEATURE_SCHEMA_VERSION = 3;

export const FEATURE_NAMES = Object.freeze([
  'score', 'snapshotScore', 'technicalScore', 'burst', 'liquidity', 'relativeVolume',
  'trendConsistency', 'rsi14', 'adx14', 'atrPct', 'volumeZScore', 'return15m',
  'return1h', 'return4h', 'candleConsistency', 'providerQuality', 'providerCount',
  'priceDispersionPct', 'spreadPct', 'orderBookImbalance', 'regimeScore',
  'validationExpectancyR', 'validationOverallExpectancyR', 'fundingAnnualizedPct',
  'openInterestChangePct', 'longShortRatio', 'longShortRatioAvailable',
  'takerBuySellRatio', 'takerBuySellRatioAvailable', 'basisPct',
  'derivativesScore', 'change1h', 'change24h', 'change7d', 'volumeToMarketCap',
  'logMarketRank', 'hourSin', 'hourCos', 'microSpreadBps', 'quoteVolatilityBps',
  'depthImbalance', 'orderFlowImbalance', 'aggressorBuyRatio', 'logDepthUsd1Pct',
  'tradesPerMinute', 'priceImpactBpsPerMillion', 'executionCostBps', 'dvol',
  'dvolChangePct', 'putCallSkewIv', 'ivTermStructure', 'putCallOpenInterestRatio',
  'logLiquidationUsd1h', 'liquidationImbalance', 'eventCaution'
]);

export function classifyAsset(asset = {}) {
  const rank = Math.max(1, finite(asset.rank, 9999));
  if (rank <= 10) return 'core';
  if (rank <= 50) return 'large';
  if (rank <= 150) return 'mid';
  return 'small';
}

export function extractModelFeatures(asset = {}, now = new Date()) {
  const model = asset.model || {};
  const market = asset.marketData || {};
  const technicals = market.technicals || {};
  const derivatives = market.derivatives || {};
  const options = derivatives.options || {};
  const micro = market.microstructure || {};
  const execution = market.execution || {};
  const hour = new Date(now).getUTCHours() + new Date(now).getUTCMinutes() / 60;
  const angle = hour / 24 * Math.PI * 2;
  return {
    score: clamp(model.score, 0, 100), snapshotScore: clamp(model.snapshotScore, 0, 100),
    technicalScore: clamp(model.technicalScore ?? technicals.technicalScore, 0, 100),
    burst: clamp(model.burst, 0, 100), liquidity: clamp(model.liquidity, 0, 100),
    relativeVolume: clamp(model.relativeVolume, 0, 100), trendConsistency: clamp(model.trendConsistency, 0, 100),
    rsi14: clamp(model.rsi14 ?? technicals.rsi14, 0, 100), adx14: clamp(model.adx14 ?? technicals.adx14, 0, 100),
    atrPct: clamp(model.atrPct ?? technicals.atrPct, 0, 30), volumeZScore: clamp(model.volumeZScore ?? technicals.volumeZScore, -10, 10),
    return15m: clamp(technicals.return15m, -30, 30), return1h: clamp(technicals.return1h, -50, 50),
    return4h: clamp(technicals.return4h, -80, 80), candleConsistency: clamp(technicals.candleConsistency, 0, 100),
    providerQuality: clamp(model.providerQuality ?? market.coverageScore, 0, 100),
    providerCount: clamp(model.providerCount ?? market.providerCount, 0, 8),
    priceDispersionPct: clamp(model.priceDispersionPct ?? market.priceDispersionPct, 0, 20),
    spreadPct: clamp(model.medianSpreadPct ?? market.medianSpreadPct, 0, 10),
    orderBookImbalance: clamp(model.orderBookImbalance ?? market.orderBook?.imbalance, -1, 1),
    regimeScore: clamp(model.regime?.score ?? market.regime?.score, 0, 100),
    validationExpectancyR: clamp(model.validationExpectancyR, -10, 10),
    validationOverallExpectancyR: clamp(model.validationOverallExpectancyR, -10, 10),
    fundingAnnualizedPct: clamp(derivatives.fundingAnnualizedPct, -200, 200),
    openInterestChangePct: clamp(derivatives.openInterestChangePct, -100, 100),
    longShortRatio: clamp(derivatives.longShortRatio, 0, 10),
    longShortRatioAvailable: derivatives.longShortRatioAvailable === true ? 1 : 0,
    takerBuySellRatio: clamp(derivatives.takerBuySellRatio, 0, 10),
    takerBuySellRatioAvailable: derivatives.takerBuySellRatioAvailable === true ? 1 : 0,
    basisPct: clamp(derivatives.basisPct, -20, 20), derivativesScore: clamp(derivatives.score, 0, 100),
    change1h: clamp(asset.change1h, -50, 50), change24h: clamp(asset.change24h, -100, 100),
    change7d: clamp(asset.change7d, -200, 200), volumeToMarketCap: clamp(asset.volumeToMarketCap, 0, 10),
    logMarketRank: Math.log10(Math.max(1, finite(asset.rank, 9999))),
    hourSin: Math.sin(angle), hourCos: Math.cos(angle),
    microSpreadBps: clamp(micro.spreadBps, 0, 500), quoteVolatilityBps: clamp(micro.quoteVolatilityBps, 0, 500),
    depthImbalance: clamp(micro.depthImbalance, -1, 1), orderFlowImbalance: clamp(micro.orderFlowImbalance, -1, 1),
    aggressorBuyRatio: clamp(micro.aggressorBuyRatio, 0, 1),
    logDepthUsd1Pct: Math.log10(Math.max(1, finite(micro.depthUsd1Pct))),
    tradesPerMinute: clamp(micro.tradesPerMinute, 0, 100_000),
    priceImpactBpsPerMillion: clamp(micro.priceImpactBpsPerMillion, 0, 10_000),
    executionCostBps: clamp(execution.estimatedRoundTripBps, 0, 1000),
    dvol: clamp(options.dvol, 0, 300), dvolChangePct: clamp(options.dvolChangePct, -100, 300),
    putCallSkewIv: clamp(options.putCallSkewIv, -100, 100), ivTermStructure: clamp(options.ivTermStructure, -100, 100),
    putCallOpenInterestRatio: clamp(options.putCallOpenInterestRatio, 0, 20),
    logLiquidationUsd1h: Math.log10(Math.max(1, finite(options.liquidationUsd1h))),
    liquidationImbalance: clamp(options.liquidationImbalance, -1, 1),
    eventCaution: market.eventRisk?.caution ? 1 : 0
  };
}

export function vectorFromFeatures(features = {}) {
  return FEATURE_NAMES.map((name) => finite(features[name]));
}

export function observationContext(asset = {}, horizonKey = 'session') {
  return {
    horizonKey: String(horizonKey || 'session'), assetClass: classifyAsset(asset),
    regimeKey: String(asset.marketData?.regime?.key || asset.model?.regime?.key || 'unknown')
  };
}
