import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { MODEL_FEATURE_NAMES, MODEL_FEATURE_VERSION, extractModelFeatures } from './modelFeatures.js';
import { paths, readJson, writeJson } from './storage.js';
import { readJsonLines, researchFiles } from './researchStore.js';
import { COUNTERFACTUAL_LABEL_VERSION } from './counterfactualLabels.js';
import { classifyStockResearchMetadata } from './researchTaxonomy.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sigmoid = (value) => value >= 0 ? 1 / (1 + Math.exp(-Math.min(40, value))) : Math.exp(Math.max(-40, value)) / (1 + Math.exp(Math.max(-40, value)));
const logit = (value) => Math.log(clamp(value, 1e-6, 1 - 1e-6) / (1 - clamp(value, 1e-6, 1 - 1e-6)));

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function regimeBucket(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('risk-on')) return 'risk_on';
  if (text.includes('risk-off')) return 'risk_off';
  if (text.includes('sideways')) return 'sideways';
  return 'mixed';
}

function featureValues(snapshot) {
  if (snapshot.features && typeof snapshot.features === 'object') {
    return MODEL_FEATURE_NAMES.map((name) => finite(snapshot.features[name]));
  }
  return extractModelFeatures(snapshot).values;
}

async function loadRows(kind, lookbackDays = config.modelLookbackDays, now = new Date()) {
  const cutoff = new Date(now.getTime() - Math.max(30, Number(lookbackDays) || config.modelLookbackDays) * 24 * 60 * 60_000)
    .toISOString().slice(0, 10);
  const files = (await researchFiles(kind)).filter((file) => {
    const dateKey = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1];
    return !dateKey || dateKey >= cutoff;
  });
  return (await Promise.all(files.map(readJsonLines))).flat();
}

export async function loadResearchExamples(guildId = '', options = {}) {
  const lookbackDays = Number(options.lookbackDays) || config.modelLookbackDays;
  const [snapshots, labels] = await Promise.all([loadRows('features', lookbackDays), loadRows('labels', lookbackDays)]);
  const byId = new Map(snapshots.filter((row) => row.snapshotId).map((row) => [row.snapshotId, row]));
  const horizons = new Set(options.horizons || [30, 90, 240]);
  return labels.filter((label) => label.labelVersion === COUNTERFACTUAL_LABEL_VERSION
    && label.realizedR !== null && label.realizedR !== undefined && Number.isFinite(Number(label.realizedR))
    && label.executable && horizons.has(Number(label.horizonMinutes)) && (!guildId || label.guildId === guildId))
    .map((label) => {
      const snapshot = byId.get(label.snapshotId);
      if (!snapshot) return null;
      const timestamp = snapshot.recordedAt || label.recordedAt;
      return {
        id: label.labelId,
        snapshotId: label.snapshotId,
        symbol: label.symbol,
        timestamp,
        startMs: Date.parse(timestamp),
        endMs: Date.parse(label.terminalAt),
        dateKey: String(timestamp).slice(0, 10),
        horizonMinutes: Number(label.horizonMinutes),
        regime: regimeBucket(snapshot.marketRegime || label.marketRegime),
        sessionBucket: label.sessionBucket || 'unknown',
        x: featureValues(snapshot),
        y: Number(label.realizedR) > 0 ? 1 : 0,
        realizedR: clamp(label.realizedR, -3, 5),
        classification: snapshot.classification || label.classification || 'unknown',
        ...classifyStockResearchMetadata(snapshot)
      };
    }).filter((row) => row && Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.x.every(Number.isFinite))
    .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index)
    .sort((left, right) => left.startMs - right.startMs);
}

function standardizer(rows) {
  const means = MODEL_FEATURE_NAMES.map((_, index) => mean(rows.map((row) => row.x[index])));
  const deviations = MODEL_FEATURE_NAMES.map((_, index) => Math.sqrt(mean(rows.map((row) => (row.x[index] - means[index]) ** 2))) || 1);
  return { means, deviations };
}

function transform(values, stats) {
  return values.map((value, index) => clamp((value - stats.means[index]) / stats.deviations[index], -8, 8));
}

function fitLogistic(rows, options = {}) {
  const weights = new Array(MODEL_FEATURE_NAMES.length).fill(0);
  const positives = rows.filter((row) => row.y).length;
  const prior = clamp((positives + 2) / (rows.length + 4), 0.03, 0.97);
  let bias = logit(prior);
  const positiveWeight = positives ? rows.length / (2 * positives) : 1;
  const negativeWeight = rows.length - positives ? rows.length / (2 * (rows.length - positives)) : 1;
  for (let epoch = 0; epoch < (options.epochs || 1000); epoch += 1) {
    const gradients = new Array(weights.length).fill(0); let biasGradient = 0;
    for (const row of rows) {
      const probability = sigmoid(bias + dot(weights, row.z));
      const error = (probability - row.y) * (row.y ? positiveWeight : negativeWeight);
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) gradients[index] += error * row.z[index];
    }
    const rate = 0.035 / Math.sqrt(1 + epoch / 180);
    bias -= rate * biasGradient / rows.length;
    for (let index = 0; index < weights.length; index += 1) weights[index] -= rate * (gradients[index] / rows.length + 0.014 * weights[index]);
  }
  return { algorithm: 'logistic', bias, weights };
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * probability)));
  return sorted[index];
}

function fitBoostedStumps(rows, options = {}) {
  const training = rows.length > 6000 ? rows.filter((_, index) => index % Math.ceil(rows.length / 6000) === 0) : rows;
  const prior = clamp(mean(training.map((row) => row.y)), 0.03, 0.97);
  const bias = logit(prior); const scores = new Array(training.length).fill(bias); const trees = [];
  const rate = options.learningRate || 0.12; const rounds = options.rounds || 36;
  const thresholds = MODEL_FEATURE_NAMES.map((_, feature) => [...new Set([0.1, 0.25, 0.4, 0.6, 0.75, 0.9].map((q) => quantile(training.map((row) => row.z[feature]), q)))].filter(Number.isFinite));
  for (let round = 0; round < rounds; round += 1) {
    const residuals = training.map((row, index) => row.y - sigmoid(scores[index]));
    let best = null;
    for (let feature = 0; feature < MODEL_FEATURE_NAMES.length; feature += 1) {
      for (const threshold of thresholds[feature]) {
        let leftSum = 0; let leftCount = 0; let rightSum = 0; let rightCount = 0;
        for (let index = 0; index < training.length; index += 1) {
          if (training[index].z[feature] <= threshold) { leftSum += residuals[index]; leftCount += 1; }
          else { rightSum += residuals[index]; rightCount += 1; }
        }
        if (leftCount < 5 || rightCount < 5) continue;
        const left = leftSum / leftCount; const right = rightSum / rightCount;
        let loss = 0;
        for (let index = 0; index < training.length; index += 1) loss += (residuals[index] - (training[index].z[feature] <= threshold ? left : right)) ** 2;
        if (!best || loss < best.loss) best = { feature, threshold, left: left * rate, right: right * rate, loss };
      }
    }
    if (!best) break;
    trees.push({ feature: best.feature, threshold: best.threshold, left: best.left, right: best.right });
    for (let index = 0; index < training.length; index += 1) scores[index] += training[index].z[best.feature] <= best.threshold ? best.left : best.right;
  }
  return { algorithm: 'boosted_stumps', bias, trees };
}

function rawProbability(model, z) {
  if (model.algorithm === 'logistic') return sigmoid(model.bias + dot(model.weights, z));
  let score = model.bias;
  for (const tree of model.trees || []) score += z[tree.feature] <= tree.threshold ? tree.left : tree.right;
  return sigmoid(score);
}

function fitPlatt(probabilities, labels) {
  if (probabilities.length < 10) return { slope: 1, intercept: 0 };
  const inputs = probabilities.map(logit); let slope = 1; let intercept = 0;
  for (let epoch = 0; epoch < 700; epoch += 1) {
    let ds = 0; let di = 0;
    for (let index = 0; index < inputs.length; index += 1) {
      const error = sigmoid(intercept + slope * inputs[index]) - labels[index];
      ds += error * inputs[index]; di += error;
    }
    const rate = 0.025 / Math.sqrt(1 + epoch / 100);
    slope -= rate * (ds / inputs.length + 0.002 * (slope - 1));
    intercept -= rate * di / inputs.length;
  }
  return { slope: clamp(slope, 0.05, 5), intercept: clamp(intercept, -5, 5) };
}

function calibratedProbability(fitted, x) {
  const z = transform(x, fitted.stats);
  const raw = rawProbability(fitted.core, z);
  return sigmoid(fitted.calibration.intercept + fitted.calibration.slope * logit(raw));
}

function uniqueDays(rows) {
  return [...new Set(rows.map((row) => row.dateKey))].sort();
}

function purgeBefore(rows, cutoffMs, embargoMinutes) {
  const embargoStart = cutoffMs - embargoMinutes * 60_000;
  return rows.filter((row) => row.endMs < embargoStart);
}

function fitCalibrated(rows, algorithm, embargoMinutes) {
  const days = uniqueDays(rows); const calibrationDayCount = Math.max(2, Math.floor(days.length * 0.18));
  const calibrationDays = new Set(days.slice(-calibrationDayCount));
  const calibrationRows = rows.filter((row) => calibrationDays.has(row.dateKey));
  const calibrationStart = Math.min(...calibrationRows.map((row) => row.startMs));
  const coreRows = purgeBefore(rows.filter((row) => !calibrationDays.has(row.dateKey)), calibrationStart, embargoMinutes);
  if (coreRows.length < 30 || calibrationRows.length < 10) return null;
  const stats = standardizer(coreRows);
  const transformed = coreRows.map((row) => ({ ...row, z: transform(row.x, stats) }));
  const core = algorithm === 'boosted_stumps' ? fitBoostedStumps(transformed) : fitLogistic(transformed);
  const raw = calibrationRows.map((row) => rawProbability(core, transform(row.x, stats)));
  const calibration = fitPlatt(raw, calibrationRows.map((row) => row.y));
  return { algorithm, stats, core, calibration, coreCount: coreRows.length, calibrationCount: calibrationRows.length };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
}

function bootstrapExpectancy(scored, threshold, samples) {
  const selected = scored.filter((row) => row.probability >= threshold);
  const byDay = new Map();
  for (const row of selected) { const current = byDay.get(row.dateKey) || []; current.push(row.realizedR); byDay.set(row.dateKey, current); }
  const days = [...byDay.keys()];
  if (days.length < 2) return { low: -Infinity, high: Infinity, samples: 0, days: days.length };
  const random = seeded(0x41555234); const values = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const returns = [];
    for (let index = 0; index < days.length; index += 1) returns.push(...byDay.get(days[Math.floor(random() * days.length)]));
    values.push(mean(returns));
  }
  values.sort((left, right) => left - right);
  return { low: quantile(values, 0.05), high: quantile(values, 0.95), samples, days: days.length };
}

function maxDrawdown(values) {
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const value of values) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return drawdown;
}

function metrics(scored, threshold, baselineProbability, bootstrapSamples) {
  const selected = scored.filter((row) => row.probability >= threshold);
  const selectedReturns = selected.map((row) => row.realizedR);
  const ece = [0, 0.2, 0.4, 0.6, 0.8].reduce((total, lower) => {
    const bucket = scored.filter((row) => row.probability >= lower && row.probability < lower + 0.2);
    return total + (bucket.length ? Math.abs(mean(bucket.map((row) => row.probability)) - mean(bucket.map((row) => row.y))) * bucket.length : 0);
  }, 0) / Math.max(1, scored.length);
  return {
    count: scored.length,
    days: uniqueDays(scored).length,
    brier: mean(scored.map((row) => (row.probability - row.y) ** 2)),
    baselineBrier: mean(scored.map((row) => (baselineProbability - row.y) ** 2)),
    calibrationError: ece,
    profitableRate: mean(scored.map((row) => row.y)),
    selectedCount: selected.length,
    selectedCoverage: selected.length / Math.max(1, scored.length),
    selectedProfitableRate: mean(selected.map((row) => row.y)),
    selectedExpectancyR: mean(selectedReturns),
    selectedNetR: selectedReturns.reduce((sum, value) => sum + value, 0),
    selectedMaxDrawdownR: maxDrawdown(selectedReturns),
    expectancyInterval: bootstrapExpectancy(scored, threshold, bootstrapSamples)
  };
}

function scoreRows(rows, fitted) {
  return rows.map((row) => ({ ...row, probability: calibratedProbability(fitted, row.x) }));
}

function walkForward(rows, algorithm, settings) {
  const days = uniqueDays(rows); const initialDays = Math.max(6, Math.floor(days.length * 0.45));
  const remaining = days.length - initialDays; const folds = remaining >= 9 ? 3 : remaining >= 4 ? 2 : 0;
  if (!folds) return { available: false, folds: 0, count: 0, reason: 'At least ten independent trading days are required.' };
  const foldSize = Math.floor(remaining / folds); const scored = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const startIndex = initialDays + fold * foldSize;
    const endIndex = fold === folds - 1 ? days.length : startIndex + foldSize;
    const testDays = new Set(days.slice(startIndex, endIndex));
    const test = rows.filter((row) => testDays.has(row.dateKey));
    const testStart = Math.min(...test.map((row) => row.startMs));
    const training = purgeBefore(rows.filter((row) => row.startMs < testStart), testStart, finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes));
    if (training.length < 40 || uniqueDays(training).length < 5) continue;
    const fitted = fitCalibrated(training, algorithm, finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes));
    if (!fitted) continue;
    scored.push(...scoreRows(test, fitted).map((row) => ({ ...row, fold: fold + 1 })));
  }
  if (!scored.length) return { available: false, folds: 0, count: 0, reason: 'Purging left too few independent observations.' };
  const prior = mean(rows.map((row) => row.y));
  return { available: true, folds, ...metrics(scored, finite(settings.ensembleBuyProbability, config.ensembleBuyProbability), prior, finite(settings.bootstrapSamples, config.bootstrapSamples)) };
}

function expertKey(horizonMinutes, regime = 'global') {
  return `h${horizonMinutes}:${regime}`;
}

export function trainResearchExpert(rows, settings = {}, metadata = {}) {
  const minimumSamples = metadata.minimumSamples || finite(settings.researchModelMinSamples, config.researchModelMinSamples);
  const days = uniqueDays(rows);
  if (rows.length < minimumSamples) return { accepted: false, sampleSize: rows.length, days: days.length, reason: `Need ${minimumSamples - rows.length} more labeled observations.` };
  if (days.length < 12) return { accepted: false, sampleSize: rows.length, days: days.length, reason: 'Need at least 12 independent trading days.' };
  const holdoutDayCount = Math.max(3, Math.floor(days.length * 0.25));
  const holdoutDays = new Set(days.slice(-holdoutDayCount));
  const holdout = rows.filter((row) => holdoutDays.has(row.dateKey));
  const holdoutStart = Math.min(...holdout.map((row) => row.startMs));
  const preHoldout = purgeBefore(rows.filter((row) => !holdoutDays.has(row.dateKey)), holdoutStart, finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes));
  const algorithms = ['logistic', 'boosted_stumps'];
  const walks = Object.fromEntries(algorithms.map((algorithm) => [algorithm, walkForward(preHoldout, algorithm, settings)]));
  const viable = algorithms.filter((algorithm) => walks[algorithm].available && walks[algorithm].selectedCount >= 5);
  if (!viable.length) return { accepted: false, sampleSize: rows.length, days: days.length, walks, reason: 'No algorithm produced enough purged walk-forward decisions.' };
  const selectedAlgorithm = viable.sort((left, right) => {
    const a = walks[left]; const b = walks[right];
    return (a.brier + Math.max(0, -a.selectedExpectancyR) * 0.2) - (b.brier + Math.max(0, -b.selectedExpectancyR) * 0.2);
  })[0];
  const fitted = fitCalibrated(preHoldout, selectedAlgorithm, finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes));
  if (!fitted) return { accepted: false, sampleSize: rows.length, days: days.length, walks, reason: 'Purging left too few independent rows for a separate calibration window.' };
  const prior = mean(preHoldout.map((row) => row.y));
  const holdoutMetrics = metrics(scoreRows(holdout, fitted), finite(settings.ensembleBuyProbability, config.ensembleBuyProbability), prior, finite(settings.bootstrapSamples, config.bootstrapSamples));
  const walk = walks[selectedAlgorithm]; const minimumSelected = Math.max(5, Math.floor(holdout.length * 0.08)); const failures = [];
  if (walk.brier > walk.baselineBrier) failures.push('walk-forward Brier score missed baseline');
  if (walk.selectedExpectancyR <= 0) failures.push('walk-forward selected expectancy was not positive');
  if (walk.selectedProfitableRate < 0.50) failures.push('walk-forward selected profitable rate was below 50%');
  if (holdoutMetrics.brier > holdoutMetrics.baselineBrier) failures.push('untouched holdout Brier score missed baseline');
  if (holdoutMetrics.selectedCount < minimumSelected) failures.push('too few untouched holdout BUY decisions');
  if (holdoutMetrics.selectedExpectancyR <= 0) failures.push('untouched holdout selected expectancy was not positive');
  if (holdoutMetrics.selectedProfitableRate < 0.50) failures.push('untouched holdout selected profitable rate was below 50%');
  if (holdoutMetrics.calibrationError > 0.20) failures.push('untouched holdout calibration error was too high');
  if (holdoutMetrics.expectancyInterval.low <= 0) failures.push('bootstrap expectancy lower bound was not positive');
  const wins = preHoldout.filter((row) => row.realizedR > 0).map((row) => row.realizedR);
  const losses = preHoldout.filter((row) => row.realizedR <= 0).map((row) => row.realizedR);
  return {
    accepted: failures.length === 0,
    sampleSize: rows.length,
    days: days.length,
    horizonMinutes: metadata.horizonMinutes,
    regime: metadata.regime || 'global',
    selectedAlgorithm,
    fitted,
    walks,
    holdout: holdoutMetrics,
    averageWinR: mean(wins) || 0.5,
    averageLossR: mean(losses) || -0.5,
    validation: { accepted: failures.length === 0, failures, purged: true, embargoMinutes: finite(settings.modelEmbargoMinutes, config.modelEmbargoMinutes), untouchedHoldoutDays: holdoutDayCount },
    reason: failures.length ? failures.join('; ') : 'Expert passed purged walk-forward, calibration, untouched holdout, and bootstrap gates.'
  };
}

export function trainResearchArtifact(examples, settings = {}, metadata = {}) {
  const experts = {};
  for (const horizonMinutes of [30, 90, 240]) {
    const horizonRows = examples.filter((row) => row.horizonMinutes === horizonMinutes);
    experts[expertKey(horizonMinutes)] = trainResearchExpert(horizonRows, settings, { horizonMinutes, regime: 'global', minimumSamples: finite(settings.researchModelMinSamples, config.researchModelMinSamples) });
    for (const regime of ['risk_on', 'mixed', 'sideways', 'risk_off']) {
      const rows = horizonRows.filter((row) => row.regime === regime);
      if (rows.length >= finite(settings.expertMinSamples, config.expertMinSamples)) experts[expertKey(horizonMinutes, regime)] = trainResearchExpert(rows, settings, { horizonMinutes, regime, minimumSamples: finite(settings.expertMinSamples, config.expertMinSamples) });
    }
  }
  const acceptedExperts = Object.entries(experts).filter(([, expert]) => expert.accepted).map(([key]) => key);
  const trainedAt = metadata.trainedAt || new Date().toISOString();
  const id = createHash('sha256').update(JSON.stringify({ guildId: metadata.guildId, trainedAt, acceptedExperts, samples: examples.length })).digest('hex').slice(0, 16);
  return {
    version: 1,
    modelFamily: 'auralith-research-v4',
    labelVersion: COUNTERFACTUAL_LABEL_VERSION,
    id,
    guildId: metadata.guildId || '',
    trainedAt,
    featureVersion: MODEL_FEATURE_VERSION,
    featureNames: [...MODEL_FEATURE_NAMES],
    sampleSize: examples.length,
    independentDays: uniqueDays(examples).length,
    experts,
    acceptedExperts,
    validation: {
      accepted: acceptedExperts.some((key) => key.endsWith(':global')),
      methodology: 'day-aware expanding walk-forward with overlapping-label purge, embargo, separate Platt calibration, untouched latest-day holdout, and day bootstrap'
    },
    thresholds: { buyProbability: finite(settings.ensembleBuyProbability, config.ensembleBuyProbability), watchProbability: finite(settings.ensembleWatchProbability, config.ensembleWatchProbability) }
  };
}

export async function trainResearchModel(guildId, settings = {}) {
  const examples = await loadResearchExamples(guildId, { lookbackDays: settings.modelLookbackDays });
  const artifact = trainResearchArtifact(examples, settings, { guildId });
  await writeJson(paths.researchChallenger(guildId), artifact);
  if (artifact.validation.accepted) await writeJson(paths.researchModel(guildId), artifact);
  return artifact;
}

export async function loadResearchModel(guildId) {
  const model = await readJson(paths.researchModel(guildId), null);
  return model?.validation?.accepted && model.labelVersion === COUNTERFACTUAL_LABEL_VERSION && model.featureVersion === MODEL_FEATURE_VERSION
    && model.featureNames?.length === MODEL_FEATURE_NAMES.length
    && model.featureNames?.every((name, index) => name === MODEL_FEATURE_NAMES[index]) ? model : null;
}

export async function loadResearchChallenger(guildId) {
  return readJson(paths.researchChallenger(guildId), null);
}

export async function maybeTrainResearchModel(guildId, settings = {}) {
  if (!config.modelAutoTrain) return { skipped: true, reason: 'Automatic model training is disabled.' };
  const examples = await loadResearchExamples(guildId, { lookbackDays: settings.modelLookbackDays });
  const challenger = await loadResearchChallenger(guildId);
  if (examples.length < finite(settings.researchModelMinSamples, config.researchModelMinSamples) * 3) return { skipped: true, reason: 'Insufficient multi-horizon research labels.', sampleSize: examples.length };
  if (examples.length < finite(challenger?.sampleSize) + 50) return { skipped: true, reason: 'Fewer than 50 new labels since the last v4 training attempt.', sampleSize: examples.length };
  return trainResearchModel(guildId, settings);
}

function inferredHorizon(asset) {
  const score = finite(asset.model?.score); const relativeVolume = finite(asset.relativeVolume); const change1h = finite(asset.change1h); const adx = finite(asset.adx14, 25);
  if (score >= 86 && relativeVolume >= 1.8 && change1h >= 0.8 && adx >= 22) return 30;
  if (score >= 76 && relativeVolume >= 1.05 && change1h >= 0.2) return 90;
  return 240;
}

export function researchModelHealth(model, history = [], now = new Date()) {
  if (!model) return { healthy: false, reason: 'No accepted v4 research champion is installed.' };
  if (model.labelVersion !== COUNTERFACTUAL_LABEL_VERSION) return { healthy: false, reason: 'Research champion uses legacy counterfactual labels; relabeling and retraining are required.' };
  const ageDays = (now - new Date(model.trainedAt)) / (24 * 60 * 60_000);
  if (!Number.isFinite(ageDays) || ageDays > 120) return { healthy: false, reason: 'The v4 champion is older than 120 days.' };
  const recent = history.filter((row) => (row.researchModelId === model.id || row.ensembleModelId === model.id)
    && ['loss', 'fell_short', 'target_hit', 'exceeded'].includes(row.status)
    && row.realizedR !== null && row.realizedR !== undefined && Number.isFinite(Number(row.realizedR))).slice(-25);
  if (recent.length >= 15) {
    const expectancyR = mean(recent.map((row) => Number(row.realizedR)));
    const drawdownR = maxDrawdown(recent.map((row) => Number(row.realizedR)));
    if (expectancyR < -0.05 || drawdownR > 4) return { healthy: false, reason: `Live kill switch: ${expectancyR.toFixed(2)}R expectancy and ${drawdownR.toFixed(2)}R drawdown.`, expectancyR, drawdownR, recent: recent.length };
  }
  return { healthy: true, ageDays, recent: recent.length };
}

export function predictResearchEnsemble(asset, model, settings = {}, history = []) {
  if (!model) return null;
  const health = researchModelHealth(model, history);
  if (!health.healthy) return { active: true, source: 'research_v4', decision: 'NO_EDGE', suspended: true, reason: health.reason, modelId: model.id };
  const horizonMinutes = inferredHorizon(asset); const regime = regimeBucket(asset.marketRegime);
  const exactKey = expertKey(horizonMinutes, regime); const globalKey = expertKey(horizonMinutes);
  const expertId = model.experts?.[exactKey]?.accepted ? exactKey : model.experts?.[globalKey]?.accepted ? globalKey : '';
  if (!expertId) return { active: true, source: 'research_v4', decision: 'NO_EDGE', reason: `No validated ${horizonMinutes}-minute expert is available.`, modelId: model.id };
  const expert = model.experts[expertId]; const extracted = extractModelFeatures(asset);
  const z = transform(extracted.values, expert.fitted.stats); const driftScore = z.filter((value) => Math.abs(value) > 4).length / z.length;
  if (driftScore >= 0.20) return { active: true, source: 'research_v4', decision: 'NO_EDGE', suspended: true, reason: `${(driftScore * 100).toFixed(0)}% of features are outside the expert training distribution.`, modelId: model.id, expertId, driftScore };
  const learned = calibratedProbability(expert.fitted, extracted.values);
  const rule = sigmoid((finite(asset.model?.score) - finite(settings.minScore, 68)) / 7);
  // The rule score is already a trained feature. Keep the deployed probability
  // identical to the model evaluated by walk-forward and holdout promotion.
  const probability = learned;
  const uncertainty = Math.max(0.03, finite(expert.holdout?.calibrationError), 1.645 * Math.sqrt(probability * (1 - probability) / Math.max(30, expert.holdout?.count || 30)));
  const low = clamp(probability - uncertainty, 0.01, 0.99); const high = clamp(probability + uncertainty, 0.01, 0.99);
  const expectedR = probability * expert.averageWinR + (1 - probability) * expert.averageLossR;
  const conservativeExpectedR = low * expert.averageWinR + (1 - low) * expert.averageLossR;
  const buyThreshold = finite(settings.ensembleBuyProbability, config.ensembleBuyProbability);
  const watchThreshold = Math.min(buyThreshold, finite(settings.ensembleWatchProbability, config.ensembleWatchProbability));
  const decision = probability >= buyThreshold && conservativeExpectedR > 0 ? 'BUY' : probability >= watchThreshold && expectedR > 0 ? 'WATCH' : 'NO_EDGE';
  return {
    active: true, source: 'research_v4', decision, modelId: model.id, expertId, algorithm: expert.selectedAlgorithm,
    horizonMinutes, regime, probability: probability * 100, probabilityLow: low * 100, probabilityHigh: high * 100,
    learnedProbability: learned * 100, ruleProbability: rule * 100, expectedR, conservativeExpectedR, driftScore,
    reason: decision === 'BUY' ? 'Purged research expert clears probability and conservative after-cost expectancy gates.'
      : decision === 'WATCH' ? 'Research edge is positive but below the conservative BUY gate.' : 'Research edge does not clear the after-cost abstention gate.'
  };
}
