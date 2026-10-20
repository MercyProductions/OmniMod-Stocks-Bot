import { randomUUID } from 'node:crypto';
import {
  classificationMetrics, hasAdequateValidationDayCoverage, predictBoostedModel, trainMetaModelBundle
} from './metaModel.js';
import { predictOutcomeDistribution, trainOutcomeModelBundle } from './outcomeModels.js';
import { loadLabeledObservations, RESEARCH_LABEL_VERSION, RESEARCH_ENTRY_EVIDENCE_VERSION,
  RESEARCH_OUTCOME_EVIDENCE_VERSION } from './researchStore.js';
import { paths, readJson, writeJson } from './storage.js';
import { monteCarloCostStress } from './executionSimulator.js';
import { FEATURE_SCHEMA_VERSION } from './modelFeatures.js';

export function resolveModelCostStressSettings(settings = {}) {
  const configured = settings.estimatedRoundTripBps;
  const baseCostBps = configured === undefined || configured === null ? 20 : Number(configured);
  return { baseCostBps: Number.isFinite(baseCostBps) && baseCostBps >= 0 ? baseCostBps : 20,
    stressMultiplier: 3, iterations: 1500 };
}

function candidateBundle(observations, settings) {
  const options = {
    minimumSamples: Number(settings.metaMinSamples) || 200,
    validationFolds: Number(settings.validationFolds) || 4,
    blindHoldoutFraction: Number(settings.blindHoldoutFraction) || 0.15,
    conformalAlpha: Number(settings.conformalAlpha) || 0.2,
    purgeMinutes: 360, minimumAuc: 0.52, minimumBrierImprovement: 0.002
  };
  const costStress = monteCarloCostStress(observations, resolveModelCostStressSettings(settings));
  return {
    id: randomUUID(), labelVersion: RESEARCH_LABEL_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    outcomeEvidenceVersion: RESEARCH_OUTCOME_EVIDENCE_VERSION,
    trainedAt: new Date().toISOString(), trainingSamples: observations.length,
    meta: trainMetaModelBundle(observations, options),
    outcomes: trainOutcomeModelBundle(observations, options), costStress
  };
}

function active(bundle) {
  return Boolean(bundle?.labelVersion === RESEARCH_LABEL_VERSION && bundle?.featureSchemaVersion === FEATURE_SCHEMA_VERSION
    && bundle?.entryEvidenceVersion === RESEARCH_ENTRY_EVIDENCE_VERSION
    && bundle?.outcomeEvidenceVersion === RESEARCH_OUTCOME_EVIDENCE_VERSION
    && bundle?.meta?.activeModels > 0 && bundle?.meta?.models?.global?.active
    && hasAdequateValidationDayCoverage(bundle.meta.models.global) && bundle?.costStress?.passed);
}

export function normalizeModelBundle(bundle) {
  if (!bundle) return bundle;
  if (bundle.labelVersion !== RESEARCH_LABEL_VERSION) {
    const reason = 'Disabled on load: model labels predate source-pinned completed-candle outcomes; retrain from current research labels.';
    const models = Object.fromEntries(Object.entries(bundle.meta?.models || {}).map(([key, model]) => [key,
      { ...model, active: false, accepted: false, reason }]));
    return { ...bundle, labelSchemaCompatible: false,
      meta: bundle.meta ? { ...bundle.meta, models, activeModels: 0 } : bundle.meta,
      outcomes: bundle.outcomes ? { ...bundle.outcomes, active: false, accepted: false, reason } : bundle.outcomes };
  }
  if (bundle.entryEvidenceVersion !== RESEARCH_ENTRY_EVIDENCE_VERSION) {
    const reason = 'Disabled on load: model labels lack a fresh same-source ask entry matching their completed-candle outcome venue; retrain from current entry-evidence observations.';
    const models = Object.fromEntries(Object.entries(bundle.meta?.models || {}).map(([key, model]) => [key,
      { ...model, active: false, accepted: false, reason }]));
    return { ...bundle, entryEvidenceCompatible: false,
      meta: bundle.meta ? { ...bundle.meta, models, activeModels: 0 } : bundle.meta,
      outcomes: bundle.outcomes ? { ...bundle.outcomes, active: false, accepted: false, reason } : bundle.outcomes };
  }
  if (bundle.outcomeEvidenceVersion !== RESEARCH_OUTCOME_EVIDENCE_VERSION) {
    const reason = 'Disabled on load: model labels may include a pre-deadline candle-close approximation; retrain using exact barrier or aligned-deadline outcomes.';
    const models = Object.fromEntries(Object.entries(bundle.meta?.models || {}).map(([key, model]) => [key,
      { ...model, active: false, accepted: false, reason }]));
    return { ...bundle, outcomeEvidenceCompatible: false,
      meta: bundle.meta ? { ...bundle.meta, models, activeModels: 0 } : bundle.meta,
      outcomes: bundle.outcomes ? { ...bundle.outcomes, active: false, accepted: false, reason } : bundle.outcomes };
  }
  if (bundle.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
    const reason = 'Disabled on load: model feature semantics do not match the current feature schema; retrain only from current-schema observations.';
    const models = Object.fromEntries(Object.entries(bundle.meta?.models || {}).map(([key, model]) => [key,
      { ...model, active: false, accepted: false, reason }]));
    return {
      ...bundle,
      featureSchemaCompatible: false,
      meta: bundle.meta ? { ...bundle.meta, models,
        activeModels: 0, featureSchemaVersion: bundle.meta.featureSchemaVersion ?? null } : bundle.meta,
      outcomes: bundle.outcomes ? { ...bundle.outcomes, active: false, accepted: false, reason } : bundle.outcomes,
    };
  }
  if (!bundle?.meta?.models) return { ...bundle, featureSchemaCompatible: true,
    entryEvidenceCompatible: true, outcomeEvidenceCompatible: true };
  const models = Object.fromEntries(Object.entries(bundle.meta.models).map(([key, model]) => {
    if (!model?.active || hasAdequateValidationDayCoverage(model)) return [key, model];
    return [key, { ...model, active: false, accepted: false,
      reason: 'Disabled on load: stored model predates validation coverage requirements or its fold/blind UTC-day coverage is insufficient.' }];
  }));
  return { ...bundle, featureSchemaCompatible: true, entryEvidenceCompatible: true,
    outcomeEvidenceCompatible: true, meta: { ...bundle.meta, models,
    activeModels: Object.values(models).filter((model) => model.active).length } };
}

export function summarizeModelReadiness(registry = {}, research = {}, settings = {}) {
  const production = registry.production;
  const productionSchema = Number.isInteger(production?.featureSchemaVersion) ? production.featureSchemaVersion : null;
  const productionEntryEvidence = Number.isInteger(production?.entryEvidenceVersion)
    ? production.entryEvidenceVersion : null;
  const productionOutcomeEvidence = Number.isInteger(production?.outcomeEvidenceVersion)
    ? production.outcomeEvidenceVersion : null;
  const minimumSamples = Math.max(1, Number(settings.metaMinSamples) || 200);
  const eligibleSamples = Math.max(0, Number(research.eligibleLabeled) || 0);
  return {
    currentFeatureSchema: FEATURE_SCHEMA_VERSION,
    currentEntryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    currentOutcomeEvidenceVersion: RESEARCH_OUTCOME_EVIDENCE_VERSION,
    productionFeatureSchema: productionSchema,
    productionEntryEvidenceVersion: productionEntryEvidence,
    productionOutcomeEvidenceVersion: productionOutcomeEvidence,
    schemaCompatible: production ? productionSchema === FEATURE_SCHEMA_VERSION
      && productionEntryEvidence === RESEARCH_ENTRY_EVIDENCE_VERSION
      && productionOutcomeEvidence === RESEARCH_OUTCOME_EVIDENCE_VERSION : null,
    eligibleSamples,
    minimumSamples,
    canMeetMinimumSamples: eligibleSamples >= minimumSamples
  };
}

export async function readModelRegistry() {
  const stored = await readJson(paths.modelRegistry(), null);
  if (stored?.version === 1) return {
    ...stored,
    production: stored.production?.labelVersion === RESEARCH_LABEL_VERSION ? normalizeModelBundle(stored.production) : null,
    challenger: stored.challenger?.labelVersion === RESEARCH_LABEL_VERSION ? normalizeModelBundle(stored.challenger) : null,
    latestRejected: stored.latestRejected?.labelVersion === RESEARCH_LABEL_VERSION ? normalizeModelBundle(stored.latestRejected) : null
  };
  return {
    version: 1, production: null,
    challenger: null, latestRejected: null, promotions: [], updatedAt: ''
  };
}

export async function readProductionModels() {
  const registry = await readModelRegistry();
  return { registry, meta: registry.production?.meta || null, outcomes: registry.production?.outcomes || null };
}

export function compareBundles(production, challenger, rows, settings) {
  const productionModel = production?.meta?.models?.global;
  const challengerModel = challenger?.meta?.models?.global;
  if (!productionModel?.active || !challengerModel?.active || !rows.length) return null;
  const productionProbabilities = rows.map((row) => predictBoostedModel(productionModel, row.features));
  const challengerProbabilities = rows.map((row) => predictBoostedModel(challengerModel, row.features));
  const productionMetrics = classificationMetrics(rows, productionProbabilities);
  const challengerMetrics = classificationMetrics(rows, challengerProbabilities);
  const required = Number(settings.challengerBrierImprovement) || 0.005;
  const promoted = challengerMetrics.brier <= productionMetrics.brier - required
    && challengerMetrics.auc >= productionMetrics.auc - 0.01;
  return { samples: rows.length, productionMetrics, challengerMetrics, requiredBrierImprovement: required, promoted };
}

export async function trainAndStageModels(settings = {}, options = {}) {
  const observations = options.observations || await loadLabeledObservations({ months: 24 });
  const registry = await readModelRegistry();
  const minimumPromotion = Math.max(30, Number(settings.challengerMinSamples) || 50);

  if (registry.challenger) {
    const future = observations.filter((row) => new Date(row.createdAt).getTime() > new Date(registry.challenger.stagedAt || registry.challenger.trainedAt).getTime());
    if (future.length >= minimumPromotion) {
      const comparison = compareBundles(registry.production, registry.challenger, future, settings);
      registry.lastComparison = { ...comparison, comparedAt: new Date().toISOString(), challengerId: registry.challenger.id };
      if (comparison?.promoted) {
        registry.promotions = [...(registry.promotions || []), {
          at: new Date().toISOString(), from: registry.production?.id || '', to: registry.challenger.id, comparison
        }].slice(-50);
        registry.production = registry.challenger;
      } else registry.latestRejected = { ...registry.challenger, rejectedAt: new Date().toISOString(), comparison };
      registry.challenger = null;
    }
  }

  if (!registry.challenger) {
    const candidate = candidateBundle(observations, settings);
    if (!active(registry.production) && active(candidate)) {
      registry.promotions = [...(registry.promotions || []), { at: new Date().toISOString(), from: registry.production?.id || '', to: candidate.id, reason: 'First holdout-qualified production model.' }].slice(-50);
      registry.production = candidate;
    } else if (active(candidate)) registry.challenger = { ...candidate, stagedAt: new Date().toISOString() };
    else registry.latestRejected = { ...candidate, rejectedAt: new Date().toISOString() };
  }

  registry.version = 1;
  registry.costStress = registry.production?.costStress || registry.challenger?.costStress || registry.latestRejected?.costStress || null;
  registry.updatedAt = new Date().toISOString();
  await writeJson(paths.modelRegistry(), registry);
  await writeJson(paths.validationReport(), {
    updatedAt: registry.updatedAt, productionId: registry.production?.id || '', challengerId: registry.challenger?.id || '',
    costStress: registry.costStress, lastComparison: registry.lastComparison || null
  });
  if (registry.production?.meta) await writeJson(paths.metaModel(), registry.production.meta);
  return registry;
}

export async function maybeTrainAndStageModels(settings = {}, now = new Date()) {
  const registry = await readModelRegistry();
  const latest = registry.challenger?.trainedAt || registry.latestRejected?.trainedAt || registry.production?.trainedAt;
  const ageMs = latest ? new Date(now).getTime() - new Date(latest).getTime() : Infinity;
  if (ageMs < Math.max(1, Number(settings.metaRetrainHours) || 24) * 3_600_000) return registry;
  return trainAndStageModels(settings);
}

export function predictProductionOutcome(models, features) {
  return predictOutcomeDistribution(models?.outcomes, features);
}
