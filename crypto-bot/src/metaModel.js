import { FEATURE_NAMES, vectorFromFeatures } from './modelFeatures.js';
import { loadLabeledObservations } from './researchStore.js';
import { paths, readJson, writeJson } from './storage.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));
const logit = (value) => Math.log(clamp(value, 0.001, 0.999) / (1 - clamp(value, 0.001, 0.999)));
const validBinaryLabel = (value) => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean'
  && Number.isFinite(Number(value)) && (Number(value) === 0 || Number(value) === 1);

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
}

function featureStats(rows) {
  return FEATURE_NAMES.map((name) => {
    const values = rows.map((row) => Number(row.features?.[name]) || 0);
    const mean = average(values);
    const variance = average(values.map((value) => (value - mean) ** 2));
    return { name, mean, scale: Math.max(Math.sqrt(variance), 1e-6) };
  });
}

function standardizedVectors(rows, stats) {
  return rows.map((row) => stats.map((stat) => ((Number(row.features?.[stat.name]) || 0) - stat.mean) / stat.scale));
}

function fitStumps(rows, options = {}) {
  const learningRate = clamp(options.learningRate ?? 0.12, 0.02, 0.5);
  const rounds = Math.max(5, Math.min(120, Number(options.rounds) || 48));
  const stats = featureStats(rows);
  const vectors = standardizedVectors(rows, stats);
  const labels = rows.map((row) => Number(row.label) > 0 ? 1 : 0);
  const prior = clamp(average(labels), 0.05, 0.95);
  const scores = labels.map(() => logit(prior));
  const stumps = [];

  for (let round = 0; round < rounds; round += 1) {
    const residuals = labels.map((label, index) => label - sigmoid(scores[index]));
    let best = null;
    for (let featureIndex = 0; featureIndex < FEATURE_NAMES.length; featureIndex += 1) {
      const sorted = vectors.map((row) => row[featureIndex]).sort((a, b) => a - b);
      const thresholds = [...new Set([0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9].map((q) => quantile(sorted, q)))];
      for (const threshold of thresholds) {
        const left = [];
        const right = [];
        for (let index = 0; index < vectors.length; index += 1) {
          (vectors[index][featureIndex] <= threshold ? left : right).push(residuals[index]);
        }
        if (left.length < 5 || right.length < 5) continue;
        const leftValue = clamp(average(left), -1, 1);
        const rightValue = clamp(average(right), -1, 1);
        let error = 0;
        for (let index = 0; index < vectors.length; index += 1) {
          const fitted = vectors[index][featureIndex] <= threshold ? leftValue : rightValue;
          error += (residuals[index] - fitted) ** 2;
        }
        if (!best || error < best.error) best = { featureIndex, threshold, leftValue, rightValue, error };
      }
    }
    if (!best) break;
    const stump = { ...best, leftValue: best.leftValue * learningRate, rightValue: best.rightValue * learningRate };
    delete stump.error;
    stumps.push(stump);
    for (let index = 0; index < vectors.length; index += 1) {
      scores[index] += vectors[index][stump.featureIndex] <= stump.threshold ? stump.leftValue : stump.rightValue;
    }
  }
  return { prior, baseScore: logit(prior), stats, stumps, learningRate, rounds: stumps.length };
}

export function predictBoostedModel(model, features = {}) {
  if (!model?.stats || !Array.isArray(model.stumps)) return null;
  const raw = vectorFromFeatures(features);
  const vector = model.stats.map((stat, index) => (raw[index] - stat.mean) / Math.max(stat.scale, 1e-6));
  let score = Number(model.baseScore) || 0;
  for (const stump of model.stumps) {
    score += vector[stump.featureIndex] <= stump.threshold ? stump.leftValue : stump.rightValue;
  }
  return sigmoid(score);
}

export function classificationMetrics(rows, probabilities) {
  if (!rows.length) return { samples: 0, wins: 0, winRate: 0, brier: 1, logLoss: Infinity, auc: 0.5 };
  const labels = rows.map((row) => Number(row.label) > 0 ? 1 : 0);
  const probs = probabilities.map((value) => clamp(value, 0.001, 0.999));
  const wins = labels.reduce((sum, value) => sum + value, 0);
  const brier = average(labels.map((label, index) => (probs[index] - label) ** 2));
  const logLoss = -average(labels.map((label, index) => label * Math.log(probs[index]) + (1 - label) * Math.log(1 - probs[index])));
  const negatives = labels.length - wins;
  const ranked = probs.map((probability, index) => ({ probability, label: labels[index] })).sort((a, b) => a.probability - b.probability);
  let positiveRankSum = 0;
  let cursor = 0;
  while (cursor < ranked.length) {
    let end = cursor + 1;
    while (end < ranked.length && ranked[end].probability === ranked[cursor].probability) end += 1;
    const averageRank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) if (ranked[index].label) positiveRankSum += averageRank;
    cursor = end;
  }
  const auc = wins > 0 && negatives > 0 ? (positiveRankSum - wins * (wins + 1) / 2) / (wins * negatives) : 0.5;
  return { samples: rows.length, wins, winRate: wins / rows.length, brier, logLoss, auc };
}

export function chronologicalSplit(rows = [], options = {}) {
  const sorted = [...rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const holdoutFraction = clamp(options.holdoutFraction ?? 0.25, 0.15, 0.4);
  const splitIndex = Math.max(1, Math.floor(sorted.length * (1 - holdoutFraction)));
  const holdout = sorted.slice(splitIndex);
  const holdoutStart = new Date(holdout[0]?.createdAt || 0).getTime();
  const purgeMs = Math.max(0, Number(options.purgeMinutes ?? 360)) * 60_000;
  const training = sorted.slice(0, splitIndex).filter((row) => {
    const deadline = labelAvailableAt(row);
    return deadline + purgeMs < holdoutStart;
  });
  return { training, holdout, purged: splitIndex - training.length, holdoutStart: holdout[0]?.createdAt || '' };
}

function labelAvailableAt(row) {
  return Math.max(Date.parse(row.deadlineAt || row.createdAt), Date.parse(row.resolvedAt || row.deadlineAt || row.createdAt));
}

export function purgedWalkForwardSplits(rows = [], options = {}) {
  const sorted = [...rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const blindFraction = clamp(options.blindHoldoutFraction ?? 0.15, 0.1, 0.3);
  const blindCount = Math.max(20, Math.floor(sorted.length * blindFraction));
  const development = sorted.slice(0, Math.max(1, sorted.length - blindCount));
  const blind = sorted.slice(development.length);
  const requestedFolds = Math.max(3, Math.min(8, Number(options.validationFolds) || 4));
  const minimumTrain = Math.max(40, Math.floor(development.length * 0.4));
  const testSize = Math.max(10, Math.floor((development.length - minimumTrain) / requestedFolds));
  const purgeMs = Math.max(0, Number(options.purgeMinutes ?? 360)) * 60_000;
  const folds = [];
  for (let index = 0; index < requestedFolds; index += 1) {
    const testStartIndex = minimumTrain + index * testSize;
    const testEndIndex = index === requestedFolds - 1 ? development.length : Math.min(development.length, testStartIndex + testSize);
    const test = development.slice(testStartIndex, testEndIndex);
    if (test.length < 10) continue;
    const testStart = new Date(test[0].createdAt).getTime();
    const rawTraining = development.slice(0, testStartIndex);
    const training = rawTraining.filter((row) => labelAvailableAt(row) + purgeMs < testStart);
    if (training.length < 30) continue;
    folds.push({ index, training, test, purged: rawTraining.length - training.length });
  }
  const blindStart = new Date(blind[0]?.createdAt || 0).getTime();
  const finalTraining = development.filter((row) => labelAvailableAt(row) + purgeMs < blindStart);
  return { sorted, development, blind, finalTraining, folds, blindStart: blind[0]?.createdAt || '' };
}

function distinctUtcDays(rows = []) {
  return new Set(rows.map((row) => {
    const timestamp = Date.parse(row?.createdAt);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
  }).filter(Boolean)).size;
}

export function hasAdequateValidationDayCoverage(model) {
  const coverage = model?.dayCoverage;
  const minimum = Math.max(5, Number(coverage?.minimumDaysPerPeriod) || 5);
  return Number(coverage?.blindDays) >= minimum
    && Array.isArray(coverage?.foldDays) && coverage.foldDays.length >= 3
    && coverage.foldDays.every((days) => Number(days) >= minimum);
}

function conformalCalibration(rows, probabilities, alpha = 0.2) {
  const scores = rows.map((row, index) => Number(row.label) > 0 ? 1 - probabilities[index] : probabilities[index]).sort((a, b) => a - b);
  const rank = Math.min(scores.length - 1, Math.max(0, Math.ceil((scores.length + 1) * (1 - alpha)) - 1));
  return { alpha, threshold: scores[rank] ?? 1, samples: scores.length };
}

export function trainBoostedModel(observations = [], options = {}) {
  const minimumSamples = Math.max(40, Number(options.minimumSamples) || 200);
  const clean = observations.filter((row) => row?.features && validBinaryLabel(row.label)
    && Number.isFinite(Date.parse(row.createdAt || '')));
  if (clean.length < minimumSamples) {
    return { accepted: false, active: false, reason: `Need ${minimumSamples} labeled observations; have ${clean.length}.`, samples: clean.length };
  }
  const validation = purgedWalkForwardSplits(clean, options);
  const minimumValidationDays = Math.max(5, Number(options.minimumValidationDays) || 5);
  const foldDayCoverage = validation.folds.map((fold) => distinctUtcDays(fold.test));
  const blindDayCoverage = distinctUtcDays(validation.blind);
  const dayCoverage = { minimumDaysPerPeriod: minimumValidationDays, foldDays: foldDayCoverage, blindDays: blindDayCoverage };
  if (foldDayCoverage.length >= 3 && (foldDayCoverage.some((days) => days < minimumValidationDays) || blindDayCoverage < minimumValidationDays)) {
    return { accepted: false, active: false, samples: clean.length, dayCoverage,
      reason: `Validation and blind periods each need at least ${minimumValidationDays} distinct UTC days; folds=${foldDayCoverage.join(',') || 'none'}, blind=${blindDayCoverage}.` };
  }
  const minimumHoldout = Math.max(20, Math.floor(minimumSamples * 0.1));
  if (validation.folds.length < 3 || validation.finalTraining.length < Math.floor(minimumSamples * 0.5) || validation.blind.length < minimumHoldout) {
    return { accepted: false, active: false, reason: 'Repeated chronological folds or blind holdout are too small after purging.', samples: clean.length, dayCoverage };
  }
  const candidates = Array.isArray(options.roundCandidates) ? options.roundCandidates : [24, 36, Number(options.rounds) || 48];
  const candidateReports = candidates.map((rounds) => {
    const folds = validation.folds.map((fold) => {
      const model = fitStumps(fold.training, { ...options, rounds });
      const probabilities = fold.test.map((row) => predictBoostedModel(model, row.features));
      const metrics = classificationMetrics(fold.test, probabilities);
      const baselineMetrics = classificationMetrics(fold.test, fold.test.map(() => model.prior));
      return { index: fold.index, trainingSamples: fold.training.length, testSamples: fold.test.length, purgedSamples: fold.purged, metrics, baselineMetrics };
    });
    return {
      rounds, folds,
      meanBrier: average(folds.map((fold) => fold.metrics.brier)),
      meanBaselineBrier: average(folds.map((fold) => fold.baselineMetrics.brier)),
      meanAuc: average(folds.map((fold) => fold.metrics.auc)),
      worstBrier: Math.max(...folds.map((fold) => fold.metrics.brier))
    };
  }).sort((a, b) => a.meanBrier - b.meanBrier);
  const selected = candidateReports[0];
  const fitted = fitStumps(validation.finalTraining, { ...options, rounds: selected.rounds });
  const probabilities = validation.blind.map((row) => predictBoostedModel(fitted, row.features));
  const metrics = classificationMetrics(validation.blind, probabilities);
  const baselineMetrics = classificationMetrics(validation.blind, validation.blind.map(() => fitted.prior));
  const multipleTestingPenalty = Math.sqrt(Math.log(Math.max(2, candidateReports.length)) / Math.max(20, validation.blind.length)) * 0.02;
  const requiredImprovement = (Number(options.minimumBrierImprovement) || 0.002) + multipleTestingPenalty;
  const accepted = selected.meanAuc >= (Number(options.minimumAuc) || 0.52)
    && selected.meanBrier <= selected.meanBaselineBrier - requiredImprovement
    && metrics.auc >= (Number(options.minimumAuc) || 0.52)
    && metrics.brier <= baselineMetrics.brier - requiredImprovement;
  const conformal = conformalCalibration(validation.blind, probabilities, clamp(options.conformalAlpha ?? 0.2, 0.05, 0.4));
  return {
    ...fitted, version: 2, active: accepted, accepted, samples: clean.length,
    trainingSamples: validation.finalTraining.length, holdoutSamples: validation.blind.length,
    purgedSamples: validation.development.length - validation.finalTraining.length,
    trainedAt: new Date().toISOString(), trainingCutoff: validation.development.at(-1)?.createdAt || '',
    holdoutStart: validation.blindStart, metrics, baselineMetrics, validationFolds: selected.folds,
    candidateReports, selectedRounds: selected.rounds, multipleTestingPenalty, requiredImprovement, conformal,
    dayCoverage,
    reason: accepted ? 'Passed repeated purged walk-forward folds and the untouched blind holdout.'
      : `Rejected: folds AUC ${selected.meanAuc.toFixed(3)}, blind AUC ${metrics.auc.toFixed(3)}, blind Brier ${metrics.brier.toFixed(3)} vs ${baselineMetrics.brier.toFixed(3)}.`
  };
}

function contextGroups(rows) {
  const groups = new Map([['global', rows]]);
  for (const row of rows) {
    for (const key of [
      `horizon:${row.horizonKey || 'unknown'}`,
      `asset:${row.assetClass || 'unknown'}`,
      `regime:${row.regimeKey || 'unknown'}`,
      `horizon:${row.horizonKey || 'unknown'}|asset:${row.assetClass || 'unknown'}|regime:${row.regimeKey || 'unknown'}`
    ]) groups.set(key, [...(groups.get(key) || []), row]);
  }
  return groups;
}

export function trainMetaModelBundle(observations = [], options = {}) {
  const minimumSamples = Math.max(80, Number(options.minimumSamples) || 200);
  const models = {};
  for (const [key, rows] of contextGroups(observations)) {
    const groupMinimum = key === 'global' ? minimumSamples : Math.max(80, Math.ceil(minimumSamples * 0.55));
    if (rows.length < groupMinimum) continue;
    models[key] = trainBoostedModel(rows, { ...options, minimumSamples: groupMinimum });
  }
  return {
    version: 1, trainedAt: new Date().toISOString(), labeledSamples: observations.length,
    activeModels: Object.values(models).filter((model) => model.active).length, models
  };
}

export function predictMetaProbability(bundle, features, context = {}) {
  if (!bundle?.models) return { active: false, probability: null, models: [] };
  const keys = [
    `horizon:${context.horizonKey || 'unknown'}|asset:${context.assetClass || 'unknown'}|regime:${context.regimeKey || 'unknown'}`,
    `horizon:${context.horizonKey || 'unknown'}`, `asset:${context.assetClass || 'unknown'}`,
    `regime:${context.regimeKey || 'unknown'}`, 'global'
  ];
  const predictions = [];
  const inadequateCoverage = [];
  for (const key of keys) {
    const model = bundle.models[key];
    if (!model?.active) continue;
    if (!hasAdequateValidationDayCoverage(model)) {
      inadequateCoverage.push(key);
      continue;
    }
    const probability = predictBoostedModel(model, features);
    if (probability != null) {
      const vector = model.stats.map((stat) => Math.abs(((Number(features?.[stat.name]) || 0) - stat.mean) / Math.max(stat.scale, 1e-6)));
      predictions.push({
        key, probability, weight: Math.sqrt(model.trainingSamples || 1),
        oodScore: vector.length ? Math.max(...vector) : 0,
        conformalThreshold: Number(model.conformal?.threshold) || 1
      });
    }
  }
  if (!predictions.length) return { active: false, probability: null, models: [],
    reason: inadequateCoverage.length ? `Model validation day coverage is missing or below five distinct UTC days for: ${inadequateCoverage.join(', ')}.` : '' };
  const weight = predictions.reduce((sum, item) => sum + item.weight, 0);
  const probability = predictions.reduce((sum, item) => sum + item.probability * item.weight, 0) / weight;
  const conformalThreshold = Math.max(...predictions.map((item) => item.conformalThreshold));
  const predictionSet = [];
  if (probability <= conformalThreshold) predictionSet.push(0);
  if (1 - probability <= conformalThreshold) predictionSet.push(1);
  const oodScore = Math.max(...predictions.map((item) => item.oodScore));
  const abstain = oodScore > (Number(context.maxOodScore) || 4) || predictionSet.length !== 1 || predictionSet[0] !== 1;
  return {
    active: true, probability, conformalThreshold, predictionSet, oodScore, abstain,
    abstainReason: oodScore > (Number(context.maxOodScore) || 4) ? `Feature shift ${oodScore.toFixed(1)}σ exceeds the limit.`
      : abstain ? 'Conformal prediction set is not uniquely profitable.' : '',
    models: predictions.map(({ key, probability }) => ({ key, probability }))
  };
}

export async function readMetaModelBundle() {
  return readJson(paths.metaModel(), null);
}

export async function trainAndSaveMetaModels(settings = {}, options = {}) {
  const observations = options.observations || await loadLabeledObservations({ months: 24 });
  const bundle = trainMetaModelBundle(observations, {
    minimumSamples: Number(settings.metaMinSamples) || 200, rounds: Number(options.rounds) || 48,
    purgeMinutes: 360, minimumAuc: 0.52, minimumBrierImprovement: 0.002,
    validationFolds: Number(settings.validationFolds) || 4,
    blindHoldoutFraction: Number(settings.blindHoldoutFraction) || 0.15,
    conformalAlpha: Number(settings.conformalAlpha) || 0.2
  });
  await writeJson(paths.metaModel(), bundle);
  return bundle;
}

export async function maybeRetrainMetaModels(settings = {}, now = new Date()) {
  const current = await readMetaModelBundle();
  const ageMs = current?.trainedAt ? new Date(now).getTime() - new Date(current.trainedAt).getTime() : Infinity;
  if (ageMs < Math.max(1, Number(settings.metaRetrainHours) || 24) * 3_600_000) return current;
  return trainAndSaveMetaModels(settings);
}
