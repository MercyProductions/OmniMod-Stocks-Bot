import test from 'node:test';
import assert from 'node:assert/strict';
import { modelHealth, predictEnsemble, trainingExamples, trainValidatedExamples } from '../src/ensembleModel.js';
import { MODEL_FEATURE_NAMES, MODEL_FEATURE_VERSION, extractModelFeatures, featureSchemaMatches } from '../src/modelFeatures.js';

function asset(overrides = {}) {
  return {
    symbol: 'NVDA', price: 150, entryPrice: 150, marketMinute: 650,
    model: { score: 82, trend: 78, momentum: 76, volume: 72, breakout: 70, vwap: 73, relativeStrength: 77, sector: 65, regime: 68, provider: 88 },
    change1h: 1.1, changeDay: 2, change5d: 5, change20d: 9, relativeVolume: 1.6,
    rsi14: 64, dailyRsi14: 61, macdHistogram: 0.25, vwapDistancePct: 0.4,
    adx14: 26, dailyAtrPercent: 2.1, intradayAtrPercent: 0.7, relativeStrengthDay: 1.2,
    relativeStrength5d: 2.4, sectorRelativeStrength: 0.9, marketMove: 0.6,
    marketBreadth: 63, advancingBreadth: 58, providerAgreement: 98, spreadBps: 8,
    quoteImbalance: 0.12, dataQuality: 86, ...overrides
  };
}

function champion(row, overrides = {}) {
  const features = extractModelFeatures(row);
  return {
    version: 1, id: 'champion-test', trainedAt: new Date().toISOString(),
    featureVersion: MODEL_FEATURE_VERSION, featureNames: [...MODEL_FEATURE_NAMES],
    means: [...features.values], deviations: new Array(features.values.length).fill(1),
    weights: new Array(features.values.length).fill(0), bias: 2,
    averageWinR: 1, averageLossR: -0.5,
    holdout: { count: 100, calibrationError: 0.02 },
    outcomeVersion: 2, validation: { accepted: true, purged: true }, sampleSize: 120, ...overrides
  };
}

test('model feature schema is deterministic and versioned', () => {
  const features = extractModelFeatures(asset());
  assert.equal(features.version, MODEL_FEATURE_VERSION);
  assert.deepEqual(features.names, MODEL_FEATURE_NAMES);
  assert.equal(features.values.length, MODEL_FEATURE_NAMES.length);
  assert.ok(features.values.every(Number.isFinite));
  assert.equal(featureSchemaMatches(champion(asset())), true);
});

test('validated champion produces BUY only when conservative expectancy clears the threshold', () => {
  const row = asset();
  const decision = predictEnsemble(row, champion(row), { minScore: 68, ensembleBuyProbability: 0.62, ensembleWatchProbability: 0.54 }, []);
  assert.equal(decision.decision, 'BUY');
  assert.ok(decision.probabilityLow > 62);
  assert.ok(decision.conservativeExpectedR > 0);
});

test('no champion remains explicit rule-only and distribution drift forces abstention', () => {
  const row = asset();
  assert.equal(predictEnsemble(row, null, {}, []).decision, 'RULE_ONLY');
  const drifted = champion(row, {
    means: new Array(MODEL_FEATURE_NAMES.length).fill(0),
    deviations: new Array(MODEL_FEATURE_NAMES.length).fill(1)
  });
  const decision = predictEnsemble(row, drifted, {}, []);
  assert.equal(decision.decision, 'NO_EDGE');
  assert.equal(decision.suspended, true);
  assert.match(decision.reason, /drift/i);
});

test('recent negative model expectancy triggers the automatic kill switch', () => {
  const row = asset(); const model = champion(row);
  const history = Array.from({ length: 15 }, (_, index) => ({
    id: `loss-${index}`, status: 'loss', ensembleModelId: model.id, realizedR: -0.2
  }));
  const health = modelHealth(model, history);
  assert.equal(health.healthy, false);
  assert.match(health.reason, /kill switch/i);
  assert.equal(predictEnsemble(row, model, {}, history).decision, 'NO_EDGE');
});

test('training examples use after-cost realized R and ignore ungraded or duplicate rows', () => {
  const row = asset(); const features = extractModelFeatures(row);
  const examples = trainingExamples([
    { id: 'a', status: 'target_hit', createdAt: '2026-01-01T00:00:00Z', realizedR: 0.8, modelFeatures: features },
    { id: 'a', status: 'loss', createdAt: '2026-01-02T00:00:00Z', realizedR: -1, modelFeatures: features },
    { id: 'b', status: 'fell_short', createdAt: '2026-01-03T00:00:00Z', realizedR: -0.1, modelFeatures: features },
    { id: 'c', status: 'tracking', createdAt: '2026-01-04T00:00:00Z', realizedR: 1, modelFeatures: features }
  ].map((prediction) => ({ ...prediction, accountingVersion: 2 })));
  assert.equal(examples.length, 2);
  assert.deepEqual(examples.map((example) => example.y), [1, 0]);
});

test('trainer promotes only after expanding walk-forward and untouched holdout validation', () => {
  const examples = Array.from({ length: 120 }, (_, index) => {
    const y = index % 2;
    const x = new Array(MODEL_FEATURE_NAMES.length).fill(0);
    x[0] = y ? 2 : -2;
    x[1] = (index % 5) / 10;
    return { id: `example-${index}`, timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), x, y, realizedR: y ? 1 : -1 };
  });
  const artifact = trainValidatedExamples(examples, { modelMinSamples: 80, ensembleBuyProbability: 0.62, ensembleWatchProbability: 0.54 }, { guildId: 'test', attemptedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(artifact.accepted, true);
  assert.ok(artifact.walkForward.folds >= 2);
  assert.ok(artifact.walkForward.selectedExpectancyR > 0);
  assert.ok(artifact.holdout.selectedExpectancyR > 0);
  assert.equal(artifact.validation.failures.length, 0);
});
