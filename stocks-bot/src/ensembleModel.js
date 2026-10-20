import { createHash } from 'node:crypto';
import { config } from './config.js';
import { MODEL_FEATURE_NAMES, MODEL_FEATURE_VERSION, extractModelFeatures, featureSchemaMatches } from './modelFeatures.js';
import { paths, readJson, writeJson } from './storage.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const sigmoid = (value) => value >= 0 ? 1 / (1 + Math.exp(-Math.min(40, value))) : Math.exp(Math.max(-40, value)) / (1 + Math.exp(Math.max(-40, value)));
const TERMINAL = new Set(['loss', 'fell_short', 'target_hit', 'exceeded']);

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardizer(rows) {
  const means = MODEL_FEATURE_NAMES.map((_, index) => mean(rows.map((row) => row.x[index])));
  const deviations = MODEL_FEATURE_NAMES.map((_, index) => {
    const variance = mean(rows.map((row) => (row.x[index] - means[index]) ** 2));
    return Math.sqrt(variance) || 1;
  });
  return { means, deviations };
}

function transform(values, stats) {
  return values.map((value, index) => clamp((value - stats.means[index]) / stats.deviations[index], -8, 8));
}

function outcomeR(prediction) {
  if (prediction.realizedR !== null && prediction.realizedR !== undefined && prediction.realizedR !== '' && Number.isFinite(Number(prediction.realizedR))) return clamp(prediction.realizedR, -3, 5);
  const net = prediction.netReturnPct === null || prediction.netReturnPct === undefined || prediction.netReturnPct === '' ? NaN : Number(prediction.netReturnPct);
  return Number.isFinite(net) && prediction.stopPct ? clamp(net / Math.max(0.01, Number(prediction.stopPct)), -3, 5) : null;
}

export function trainingExamples(predictions = []) {
  return predictions.filter((prediction) => TERMINAL.has(prediction.status) && prediction.accountingVersion === 2).map((prediction) => {
    const realizedR = outcomeR(prediction);
    if (!Number.isFinite(realizedR)) return null;
    const extracted = prediction.modelFeatures?.version === MODEL_FEATURE_VERSION
      && Array.isArray(prediction.modelFeatures.values)
      && prediction.modelFeatures.values.length === MODEL_FEATURE_NAMES.length
      ? prediction.modelFeatures
      : extractModelFeatures(prediction);
    return {
      id: prediction.id,
      timestamp: prediction.entryFilledAt || prediction.createdAt || '',
      completedAt: prediction.completedAt || prediction.followThroughDeadlineAt || prediction.deadlineAt || '',
      x: extracted.values.map(Number),
      y: realizedR > 0 ? 1 : 0,
      realizedR
    };
  }).filter((row) => row && row.x.every(Number.isFinite))
    .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function fitLogistic(rows, options = {}) {
  const stats = standardizer(rows);
  const standardized = rows.map((row) => ({ ...row, z: transform(row.x, stats) }));
  const positives = standardized.filter((row) => row.y === 1).length;
  const negatives = standardized.length - positives;
  const prior = clamp((positives + 2) / (standardized.length + 4), 0.05, 0.95);
  const positiveWeight = positives ? standardized.length / (2 * positives) : 1;
  const negativeWeight = negatives ? standardized.length / (2 * negatives) : 1;
  const weights = new Array(MODEL_FEATURE_NAMES.length).fill(0);
  let bias = Math.log(prior / (1 - prior));
  const epochs = options.epochs || 1400;
  const l2 = options.l2 ?? 0.012;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradients = new Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const row of standardized) {
      const probability = sigmoid(bias + dot(weights, row.z));
      const sampleWeight = row.y ? positiveWeight : negativeWeight;
      const error = (probability - row.y) * sampleWeight;
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) gradients[index] += error * row.z[index];
    }
    const learningRate = 0.035 / Math.sqrt(1 + epoch / 180);
    bias -= learningRate * biasGradient / standardized.length;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradients[index] / standardized.length + l2 * weights[index]);
    }
  }
  return { stats, weights, bias, prior };
}

function probabilityFor(row, fitted) {
  return sigmoid(fitted.bias + dot(fitted.weights, transform(row.x, fitted.stats)));
}

function maxDrawdown(values) {
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function evaluateScored(scored, threshold) {
  const brier = mean(scored.map((row) => (row.probability - row.y) ** 2));
  const logLoss = -mean(scored.map((row) => row.y * Math.log(Math.max(1e-9, row.probability)) + (1 - row.y) * Math.log(Math.max(1e-9, 1 - row.probability))));
  const selected = scored.filter((row) => row.probability >= threshold);
  const selectedReturns = selected.map((row) => row.realizedR);
  const calibrationError = [0, 0.2, 0.4, 0.6, 0.8].reduce((total, lower) => {
    const bucket = scored.filter((row) => row.probability >= lower && row.probability < lower + 0.2);
    return total + (bucket.length ? Math.abs(mean(bucket.map((row) => row.probability)) - mean(bucket.map((row) => row.y))) * bucket.length : 0);
  }, 0) / Math.max(1, scored.length);
  return {
    count: scored.length,
    brier,
    logLoss,
    calibrationError,
    profitableRate: scored.length ? mean(scored.map((row) => row.y)) : 0,
    selectedCount: selected.length,
    selectedCoverage: scored.length ? selected.length / scored.length : 0,
    selectedProfitableRate: selected.length ? mean(selected.map((row) => row.y)) : 0,
    selectedExpectancyR: mean(selectedReturns),
    selectedNetR: selectedReturns.reduce((sum, value) => sum + value, 0),
    selectedMaxDrawdownR: maxDrawdown(selectedReturns)
  };
}

function evaluate(rows, fitted, threshold) {
  return evaluateScored(rows.map((row) => ({ ...row, probability: probabilityFor(row, fitted) })), threshold);
}

export function purgeOutcomeOverlap(rows, testTimestamp, embargoMinutes = config.modelEmbargoMinutes) {
  const boundary = Date.parse(testTimestamp) - Math.max(0, embargoMinutes) * 60_000;
  return rows.filter((row) => {
    const start = Date.parse(row.timestamp);
    // Older exports without a completion time get a conservative one-session horizon.
    const end = row.completedAt ? Date.parse(row.completedAt) : start + 8 * 60 * 60_000;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start && end < boundary;
  });
}

function expandingWalkForward(rows, threshold, embargoMinutes) {
  const initialTrainingSize = Math.max(30, Math.floor(rows.length * 0.55));
  const remaining = rows.length - initialTrainingSize;
  const foldCount = remaining >= 30 ? 3 : remaining >= 16 ? 2 : 1;
  const foldSize = Math.floor(remaining / foldCount);
  if (foldCount < 2 || foldSize < 8) return { available: false, folds: 0, count: 0, reason: 'Too few observations for at least two expanding-window folds.' };
  const scored = [];
  const baselines = [];
  for (let fold = 0; fold < foldCount; fold += 1) {
    const testStart = initialTrainingSize + fold * foldSize;
    const testEnd = fold === foldCount - 1 ? rows.length : testStart + foldSize;
    const testing = rows.slice(testStart, testEnd);
    const training = purgeOutcomeOverlap(rows.slice(0, testStart), testing[0].timestamp, embargoMinutes);
    if (training.length < 30) continue;
    const fitted = fitLogistic(training, { epochs: 800 });
    const prior = mean(training.map((row) => row.y));
    for (const row of testing) {
      scored.push({ ...row, fold: fold + 1, probability: probabilityFor(row, fitted) });
      baselines.push((prior - row.y) ** 2);
    }
  }
  return {
    available: new Set(scored.map((row) => row.fold)).size >= 2,
    folds: new Set(scored.map((row) => row.fold)).size,
    initialTrainingSize,
    ...evaluateScored(scored, threshold),
    baselineBrier: mean(baselines)
  };
}

export async function loadGuildModel(guildId) {
  const model = await readJson(paths.model(guildId), null);
  return featureSchemaMatches(model) && model?.validation?.accepted && model.outcomeVersion === 2 && model.validation.purged === true ? model : null;
}

export async function loadChallenger(guildId) {
  return readJson(paths.challenger(guildId), null);
}

export function modelHealth(model, predictions = [], now = new Date()) {
  if (!model) return { healthy: false, reason: 'No accepted champion model is installed.' };
  if (model.outcomeVersion !== 2 || model.validation?.purged !== true) return { healthy: false, reason: 'Champion uses legacy outcome accounting or unpurged validation; retraining is required.' };
  if (!featureSchemaMatches(model)) return { healthy: false, reason: 'Champion feature schema is incompatible with this bot version.' };
  const ageDays = (now.getTime() - new Date(model.trainedAt).getTime()) / (24 * 60 * 60_000);
  if (!Number.isFinite(ageDays) || ageDays > 120) return { healthy: false, reason: 'Champion model is older than 120 days and requires retraining.', ageDays };
  const recent = predictions.filter((row) => row.ensembleModelId === model.id && TERMINAL.has(row.status) && row.realizedR !== null && row.realizedR !== undefined && Number.isFinite(Number(row.realizedR))).slice(-20);
  if (recent.length >= 15) {
    const expectancyR = mean(recent.map((row) => Number(row.realizedR)));
    const drawdownR = maxDrawdown(recent.map((row) => Number(row.realizedR)));
    if (expectancyR < -0.05 || drawdownR > 4) return { healthy: false, reason: `Recent champion outcomes triggered the automatic kill switch (${expectancyR.toFixed(2)}R expectancy; ${drawdownR.toFixed(2)}R drawdown).`, recent: recent.length, expectancyR, drawdownR };
    return { healthy: true, recent: recent.length, expectancyR, drawdownR, ageDays };
  }
  return { healthy: true, recent: recent.length, ageDays };
}

export function predictEnsemble(asset, model, settings = {}, history = []) {
  if (!model) return { active: false, decision: 'RULE_ONLY', reason: 'No validated champion; using the deterministic quality gates.', modelId: '' };
  const health = modelHealth(model, history);
  if (!health.healthy) return { active: true, decision: 'NO_EDGE', reason: health.reason, modelId: model.id, suspended: true };
  const extracted = extractModelFeatures(asset);
  const z = transform(extracted.values, { means: model.means, deviations: model.deviations });
  const extremeFeatures = z.filter((value) => Math.abs(value) > 4).length;
  const driftScore = extremeFeatures / z.length;
  if (driftScore >= 0.25) return { active: true, decision: 'NO_EDGE', reason: `Feature drift is outside the champion training distribution (${(driftScore * 100).toFixed(0)}% extreme features).`, modelId: model.id, driftScore, suspended: true };
  const modelProbability = sigmoid(model.bias + dot(model.weights, z));
  const ruleProbability = sigmoid((finite(asset.model?.score, asset.score) - finite(settings.minScore, 68)) / 7);
  // Rule score is part of the fitted feature vector; an extra post-validation
  // blend would deploy a different model than the promoted challenger.
  const probability = modelProbability;
  const uncertainty = Math.max(0.03, finite(model.holdout?.calibrationError), 1.645 * Math.sqrt(probability * (1 - probability) / Math.max(20, model.holdout?.count || 20)));
  const probabilityLow = clamp(probability - uncertainty, 0.01, 0.99);
  const probabilityHigh = clamp(probability + uncertainty, 0.01, 0.99);
  const expectedR = probability * model.averageWinR + (1 - probability) * model.averageLossR;
  const conservativeExpectedR = probabilityLow * model.averageWinR + (1 - probabilityLow) * model.averageLossR;
  const buyThreshold = finite(settings.ensembleBuyProbability, config.ensembleBuyProbability);
  const watchThreshold = Math.min(buyThreshold, finite(settings.ensembleWatchProbability, config.ensembleWatchProbability));
  const decision = probability >= buyThreshold && conservativeExpectedR > 0 ? 'BUY'
    : probability >= watchThreshold && expectedR > 0 ? 'WATCH' : 'NO_EDGE';
  return {
    active: true,
    decision,
    modelId: model.id,
    probability: probability * 100,
    probabilityLow: probabilityLow * 100,
    probabilityHigh: probabilityHigh * 100,
    modelProbability: modelProbability * 100,
    ruleProbability: ruleProbability * 100,
    expectedR,
    conservativeExpectedR,
    driftScore,
    reason: decision === 'BUY' ? 'Validated champion clears the conservative after-cost expectancy gate.'
      : decision === 'WATCH' ? 'Estimated edge is positive but below the conservative buy threshold.'
        : 'Estimated edge does not clear the after-cost abstention threshold.'
  };
}

export function trainValidatedExamples(inputExamples = [], settings = {}, metadata = {}) {
  const examples = [...inputExamples].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  const guildId = metadata.guildId || 'offline';
  const minimumSamples = Math.max(40, finite(settings.modelMinSamples, config.modelMinSamples));
  const minimumHoldout = Math.max(10, config.modelMinHoldout);
  const buyThreshold = finite(settings.ensembleBuyProbability, config.ensembleBuyProbability);
  const attemptedAt = metadata.attemptedAt || new Date().toISOString();
  const baseReport = { version: 1, guildId, attemptedAt, sampleSize: examples.length, minimumSamples, minimumHoldout };
  if (examples.length < minimumSamples) {
    return { ...baseReport, accepted: false, reason: `Need ${minimumSamples - examples.length} more graded paper outcomes before training.` };
  }
  const holdoutCount = Math.max(minimumHoldout, Math.floor(examples.length * 0.25));
  const holdout = examples.slice(-holdoutCount);
  const embargoMinutes = finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes);
  const training = purgeOutcomeOverlap(examples.slice(0, -holdoutCount), holdout[0].timestamp, embargoMinutes);
  if (training.length < 30 || holdout.length < minimumHoldout) {
    return { ...baseReport, accepted: false, reason: 'Chronological training/holdout split is too small.' };
  }
  const fitted = fitLogistic(training);
  const trainingMetrics = evaluate(training, fitted, buyThreshold);
  const holdoutMetrics = evaluate(holdout, fitted, buyThreshold);
  const walkForwardMetrics = expandingWalkForward(training, buyThreshold, embargoMinutes);
  const baselineProbability = mean(training.map((row) => row.y));
  const baselineBrier = mean(holdout.map((row) => (baselineProbability - row.y) ** 2));
  const averageWinR = mean(training.filter((row) => row.realizedR > 0).map((row) => row.realizedR)) || 0.5;
  const averageLossR = mean(training.filter((row) => row.realizedR <= 0).map((row) => row.realizedR)) || -0.5;
  const minimumSelected = Math.max(5, Math.floor(holdout.length * 0.15));
  const failures = [];
  if (holdoutMetrics.brier > baselineBrier * 1.05) failures.push('holdout Brier score did not beat the prior baseline');
  if (holdoutMetrics.selectedCount < minimumSelected) failures.push('too few holdout BUY decisions');
  if (holdoutMetrics.selectedExpectancyR <= 0) failures.push('holdout BUY expectancy was not positive');
  if (holdoutMetrics.selectedProfitableRate < 0.50) failures.push('holdout BUY profitable rate was below 50%');
  if (holdoutMetrics.calibrationError > 0.25) failures.push('holdout probabilities were poorly calibrated');
  if (!walkForwardMetrics.available) failures.push('not enough pre-holdout data for expanding walk-forward validation');
  else {
    const minimumWalkSelected = Math.max(5, Math.floor(walkForwardMetrics.count * 0.15));
    if (walkForwardMetrics.brier > walkForwardMetrics.baselineBrier * 1.05) failures.push('walk-forward Brier score did not beat the prior baseline');
    if (walkForwardMetrics.selectedCount < minimumWalkSelected) failures.push('too few walk-forward BUY decisions');
    if (walkForwardMetrics.selectedExpectancyR <= 0) failures.push('walk-forward BUY expectancy was not positive');
    if (walkForwardMetrics.selectedProfitableRate < 0.50) failures.push('walk-forward BUY profitable rate was below 50%');
  }
  const accepted = failures.length === 0;
  const trainedAt = attemptedAt;
  const id = createHash('sha256').update(JSON.stringify({ guildId, trainedAt, weights: fitted.weights })).digest('hex').slice(0, 16);
  const artifact = {
    version: 1,
    outcomeVersion: 2,
    id,
    guildId,
    trainedAt,
    featureVersion: MODEL_FEATURE_VERSION,
    featureNames: [...MODEL_FEATURE_NAMES],
    means: fitted.stats.means,
    deviations: fitted.stats.deviations,
    weights: fitted.weights,
    bias: fitted.bias,
    averageWinR,
    averageLossR,
    training: trainingMetrics,
    walkForward: walkForwardMetrics,
    holdout: { ...holdoutMetrics, baselineBrier },
    thresholds: { buyProbability: buyThreshold, watchProbability: finite(settings.ensembleWatchProbability, config.ensembleWatchProbability) },
    validation: { accepted, failures, purged: true, embargoMinutes, methodology: 'expanding-window walk-forward and chronological 25% holdout with outcome-overlap purge and embargo; after-cost realized-R labels' },
    sampleSize: examples.length
  };
  return { ...artifact, accepted, reason: accepted ? 'Challenger passed every promotion gate.' : `Challenger rejected: ${failures.join('; ')}.` };
}

export async function trainGuildModel(guildId, predictions = [], settings = {}, options = {}) {
  const artifact = trainValidatedExamples(trainingExamples(predictions), settings, { guildId });
  await writeJson(paths.challenger(guildId), artifact);
  if ((artifact.accepted || options.forceAccept === true) && artifact.id) {
    await writeJson(paths.model(guildId), { ...artifact, validation: { ...artifact.validation, accepted: true, forced: !artifact.accepted } });
  }
  return artifact.accepted ? { ...artifact, reason: 'Challenger passed every promotion gate and is now champion.' } : artifact;
}

export async function maybeTrainGuildModel(guildId, predictions = [], settings = {}) {
  if (!config.modelAutoTrain) return { skipped: true, reason: 'Automatic training is disabled.' };
  const examples = trainingExamples(predictions);
  const challenger = await loadChallenger(guildId);
  if (examples.length < Math.max(40, finite(settings.modelMinSamples, config.modelMinSamples))) return { skipped: true, reason: 'Insufficient graded outcomes.', sampleSize: examples.length };
  if (examples.length < finite(challenger?.sampleSize) + 10) return { skipped: true, reason: 'Fewer than 10 new outcomes since the last training attempt.', sampleSize: examples.length };
  return trainGuildModel(guildId, predictions, settings);
}
