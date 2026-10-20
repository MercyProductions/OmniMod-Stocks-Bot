export const MODEL_FEATURE_VERSION = 2;

export const MODEL_FEATURE_NAMES = Object.freeze([
  'ruleScore', 'trendFactor', 'momentumFactor', 'volumeFactor', 'breakoutFactor', 'vwapFactor',
  'relativeStrengthFactor', 'sectorFactor', 'regimeFactor', 'providerFactor',
  'change1h', 'changeDay', 'change5d', 'change20d', 'relativeVolume', 'rsi14', 'dailyRsi14',
  'macdHistogramBps', 'vwapDistancePct', 'adx14', 'dailyAtrPercent', 'intradayAtrPercent',
  'relativeStrengthDay', 'relativeStrength5d', 'sectorRelativeStrength', 'marketMove',
  'marketBreadth', 'advancingBreadth', 'providerAgreement', 'spreadBps', 'quoteImbalance',
  'dataQuality', 'minutesFromOpen',
  'spreadMean1m', 'spreadMean5m', 'spreadMean15m', 'spreadPercentile15m', 'spreadAcceleration',
  'quoteImbalance1m', 'quoteImbalance5m', 'quoteImbalance15m',
  'tradeFlow1m', 'tradeFlow5m', 'tradeFlow15m', 'quoteAgeSeconds', 'tradeAgeSeconds',
  'luldDistanceBps', 'halted',
  'secFilingAgeHours', 'secFilingRisk', 'revenueGrowthYoY', 'netIncomeGrowthYoY', 'sharesGrowthYoY',
  'daysToCorporateAction', 'corporateActionRisk', 'vix', 'yieldCurve10y2y', 'creditSpread', 'macroStress'
]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function extractModelFeatures(record = {}) {
  const factors = record.factors || record.model || {};
  const price = Math.max(0.0001, finite(record.price, record.entryPrice || record.currentPrice || 1));
  const marketMinute = finite(record.marketMinute, 570);
  const values = [
    finite(record.model?.score, record.score),
    finite(factors.trend),
    finite(factors.momentum, factors.oscillator),
    finite(factors.volume),
    finite(factors.breakout),
    finite(factors.vwap),
    finite(factors.relativeStrength),
    finite(factors.sector),
    finite(factors.regime),
    finite(factors.provider, 50),
    finite(record.change1h),
    finite(record.changeDay),
    finite(record.change5d),
    finite(record.change20d),
    finite(record.relativeVolume, 1),
    finite(record.rsi14, 50),
    finite(record.dailyRsi14, 50),
    finite(record.macdHistogram) / price * 10_000,
    finite(record.vwapDistancePct),
    finite(record.adx14),
    finite(record.dailyAtrPercent, record.atrPercent),
    finite(record.intradayAtrPercent),
    finite(record.relativeStrengthDay),
    finite(record.relativeStrength5d),
    finite(record.sectorRelativeStrength),
    finite(record.marketMove),
    finite(record.marketBreadth, 50),
    finite(record.advancingBreadth, 50),
    finite(record.providerAgreement, 50),
    finite(record.spreadBps),
    finite(record.quoteImbalance),
    finite(record.dataQuality, 60),
    Math.max(0, marketMinute - 570),
    finite(record.spreadMean1m, record.spreadBps),
    finite(record.spreadMean5m, record.spreadBps),
    finite(record.spreadMean15m, record.spreadBps),
    finite(record.spreadPercentile15m, 0.5),
    finite(record.spreadAcceleration),
    finite(record.quoteImbalance1m, record.quoteImbalance),
    finite(record.quoteImbalance5m, record.quoteImbalance),
    finite(record.quoteImbalance15m, record.quoteImbalance),
    finite(record.tradeFlow1m),
    finite(record.tradeFlow5m),
    finite(record.tradeFlow15m),
    finite(record.quoteAgeSeconds, 90),
    finite(record.tradeAgeSeconds, 90),
    finite(record.luldDistanceBps, 10000),
    record.halted ? 1 : 0,
    finite(record.secFilingAgeHours, 9999),
    finite(record.secFilingRisk),
    finite(record.revenueGrowthYoY),
    finite(record.netIncomeGrowthYoY),
    finite(record.sharesGrowthYoY),
    finite(record.daysToCorporateAction, 9999),
    finite(record.corporateActionRisk),
    finite(record.vix),
    finite(record.yieldCurve10y2y),
    finite(record.creditSpread),
    finite(record.macroStress)
  ].map((value) => Number.isFinite(value) ? value : 0);
  return { version: MODEL_FEATURE_VERSION, names: MODEL_FEATURE_NAMES, values };
}

export function featureObject(record = {}) {
  const extracted = extractModelFeatures(record);
  return Object.fromEntries(extracted.names.map((name, index) => [name, extracted.values[index]]));
}

export function featureSchemaMatches(model) {
  return Number(model?.featureVersion) === MODEL_FEATURE_VERSION
    && Array.isArray(model?.featureNames)
    && model.featureNames.length === MODEL_FEATURE_NAMES.length
    && model.featureNames.every((name, index) => name === MODEL_FEATURE_NAMES[index]);
}
