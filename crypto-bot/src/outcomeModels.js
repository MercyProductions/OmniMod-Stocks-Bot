import { FEATURE_NAMES, vectorFromFeatures } from './modelFeatures.js';
import { predictBoostedModel, purgedWalkForwardSplits, trainBoostedModel } from './metaModel.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value)));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function quantile(values, q) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * (position - lower);
}

function regressionStats(rows) {
  return FEATURE_NAMES.map((name) => {
    const values = rows.map((row) => finite(row.features?.[name]));
    const mean = average(values);
    const scale = Math.max(1e-6, Math.sqrt(average(values.map((value) => (value - mean) ** 2))));
    return { name, mean, scale };
  });
}

function fitRegression(rows, target, options = {}) {
  const stats = regressionStats(rows);
  const vectors = rows.map((row) => stats.map((stat) => (finite(row.features?.[stat.name]) - stat.mean) / stat.scale));
  const targets = rows.map((row) => target(row));
  const baseValue = average(targets);
  const scores = targets.map(() => baseValue);
  const stumps = [];
  const rounds = Math.max(8, Math.min(80, Number(options.rounds) || 36));
  const learningRate = clamp(options.learningRate ?? 0.1, 0.02, 0.4);
  for (let round = 0; round < rounds; round += 1) {
    const residuals = targets.map((value, index) => value - scores[index]);
    let best = null;
    for (let featureIndex = 0; featureIndex < FEATURE_NAMES.length; featureIndex += 1) {
      const values = vectors.map((row) => row[featureIndex]);
      const thresholds = [...new Set([0.15, 0.3, 0.5, 0.7, 0.85].map((q) => quantile(values, q)))];
      for (const threshold of thresholds) {
        const leftIndexes = [];
        const rightIndexes = [];
        for (let index = 0; index < vectors.length; index += 1) (vectors[index][featureIndex] <= threshold ? leftIndexes : rightIndexes).push(index);
        if (leftIndexes.length < 5 || rightIndexes.length < 5) continue;
        const leftValue = average(leftIndexes.map((index) => residuals[index]));
        const rightValue = average(rightIndexes.map((index) => residuals[index]));
        const error = leftIndexes.reduce((sum, index) => sum + (residuals[index] - leftValue) ** 2, 0)
          + rightIndexes.reduce((sum, index) => sum + (residuals[index] - rightValue) ** 2, 0);
        if (!best || error < best.error) best = { featureIndex, threshold, leftValue, rightValue, error };
      }
    }
    if (!best) break;
    const stump = { featureIndex: best.featureIndex, threshold: best.threshold, leftValue: best.leftValue * learningRate, rightValue: best.rightValue * learningRate };
    stumps.push(stump);
    for (let index = 0; index < vectors.length; index += 1) scores[index] += vectors[index][stump.featureIndex] <= stump.threshold ? stump.leftValue : stump.rightValue;
  }
  return { stats, baseValue, stumps, rounds: stumps.length, learningRate };
}

export function predictRegression(model, features = {}) {
  if (!model?.stats || !Array.isArray(model.stumps)) return null;
  const raw = vectorFromFeatures(features);
  const vector = model.stats.map((stat, index) => (raw[index] - stat.mean) / Math.max(stat.scale, 1e-6));
  let value = finite(model.baseValue);
  for (const stump of model.stumps) value += vector[stump.featureIndex] <= stump.threshold ? stump.leftValue : stump.rightValue;
  return value;
}

function regressionMetrics(rows, predictions, target) {
  const actual = rows.map(target);
  const errors = actual.map((value, index) => predictions[index] - value);
  return {
    samples: rows.length, mae: average(errors.map(Math.abs)),
    rmse: Math.sqrt(average(errors.map((value) => value ** 2))),
    bias: average(errors), baselineMae: average(actual.map((value) => Math.abs(value - average(actual))))
  };
}

function trainValidatedRegression(rows, target, options = {}) {
  const minimumSamples = Math.max(80, Number(options.minimumSamples) || 200);
  if (rows.length < minimumSamples) return { active: false, accepted: false, samples: rows.length, reason: `Need ${minimumSamples} outcomes; have ${rows.length}.` };
  const validation = purgedWalkForwardSplits(rows, options);
  if (validation.folds.length < 3 || validation.blind.length < 20) return { active: false, accepted: false, samples: rows.length, reason: 'Insufficient purged folds or blind outcomes.' };
  const folds = validation.folds.map((fold) => {
    const model = fitRegression(fold.training, target, options);
    return regressionMetrics(fold.test, fold.test.map((row) => predictRegression(model, row.features)), target);
  });
  const model = fitRegression(validation.finalTraining, target, options);
  const blindPredictions = validation.blind.map((row) => predictRegression(model, row.features));
  const metrics = regressionMetrics(validation.blind, blindPredictions, target);
  const residuals = validation.blind.map((row, index) => target(row) - blindPredictions[index]);
  const foldMae = average(folds.map((fold) => fold.mae));
  const foldBaselineMae = average(folds.map((fold) => fold.baselineMae));
  const accepted = foldMae <= foldBaselineMae * 0.98 && metrics.mae <= metrics.baselineMae * 0.98;
  return {
    ...model, version: 1, active: accepted, accepted, samples: rows.length,
    trainingSamples: validation.finalTraining.length, holdoutSamples: validation.blind.length,
    metrics, folds, residualQuantiles: { q10: quantile(residuals, 0.1), q50: quantile(residuals, 0.5), q90: quantile(residuals, 0.9) },
    reason: accepted ? 'Improved MAE in repeated folds and blind holdout.'
      : `Rejected: blind MAE ${metrics.mae.toFixed(3)} vs baseline ${metrics.baselineMae.toFixed(3)}.`
  };
}

export function trainOutcomeModelBundle(observations = [], options = {}) {
  const hasFiniteValue = (value) => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
  const rows = observations.filter((row) => row?.features
    && hasFiniteValue(row.realizedR)
    && hasFiniteValue(row.targetLabel) && [0, 1].includes(Number(row.targetLabel))
    && hasFiniteValue(row.timeToEventMinutes) && Number(row.timeToEventMinutes) > 0
    && hasFiniteValue(row.maxFavorableExcursionR) && Number(row.maxFavorableExcursionR) >= 0
    && hasFiniteValue(row.maxAdverseExcursionR) && Number(row.maxAdverseExcursionR) <= 0
    && Number.isFinite(Date.parse(row.createdAt || '')));
  const common = {
    minimumSamples: Number(options.minimumSamples) || 200, validationFolds: Number(options.validationFolds) || 4,
    blindHoldoutFraction: Number(options.blindHoldoutFraction) || 0.15, purgeMinutes: 360, rounds: 36,
    conformalAlpha: Number(options.conformalAlpha) || 0.2
  };
  const targetModel = trainBoostedModel(rows.map((row) => ({ ...row, label: Number(row.targetLabel) || 0 })), common);
  const timeModel = trainValidatedRegression(rows, (row) => Math.log1p(clamp(row.timeToEventMinutes, 1, 1440)), common);
  const returnModel = trainValidatedRegression(rows, (row) => clamp(row.realizedR, -3, 6), common);
  const favorableModel = trainValidatedRegression(rows, (row) => clamp(row.maxFavorableExcursionR, 0, 10), common);
  const adverseModel = trainValidatedRegression(rows, (row) => clamp(row.maxAdverseExcursionR, -10, 0), common);
  return {
    version: 1, trainedAt: new Date().toISOString(), samples: rows.length,
    active: targetModel.active && returnModel.active,
    targetModel, timeModel, returnModel, favorableModel, adverseModel
  };
}

function predictionWithResiduals(model, features) {
  if (!model?.active) return null;
  const center = predictRegression(model, features);
  return {
    q10: center + finite(model.residualQuantiles?.q10), median: center + finite(model.residualQuantiles?.q50),
    q90: center + finite(model.residualQuantiles?.q90)
  };
}

export function predictOutcomeDistribution(bundle, features = {}) {
  if (!bundle?.active) return { active: false };
  const targetProbability = predictBoostedModel(bundle.targetModel, features);
  const timeLog = predictionWithResiduals(bundle.timeModel, features);
  const returns = predictionWithResiduals(bundle.returnModel, features);
  const favorable = predictionWithResiduals(bundle.favorableModel, features);
  const adverse = predictionWithResiduals(bundle.adverseModel, features);
  return {
    active: true, targetProbability,
    timeMinutes: timeLog ? { q10: Math.expm1(timeLog.q10), median: Math.expm1(timeLog.median), q90: Math.expm1(timeLog.q90) } : null,
    returnR: returns, favorableR: favorable, adverseR: adverse
  };
}
