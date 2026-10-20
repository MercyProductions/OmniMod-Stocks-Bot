import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_FEATURE_NAMES } from '../src/modelFeatures.js';
import { trainResearchExpert } from '../src/researchModel.js';

test('research expert passes purged day-aware validation on stable learnable data', () => {
  const rows = Array.from({ length: 360 }, (_, index) => {
    const day = Math.floor(index / 12);
    const y = index % 2;
    const startMs = Date.UTC(2026, 0, day + 1, 15, (index % 12) * 5);
    const x = new Array(MODEL_FEATURE_NAMES.length).fill(0);
    x[0] = y ? 2 : -2; x[1] = (index % 7) / 10;
    return {
      id: `row-${index}`, symbol: `S${index % 6}`, timestamp: new Date(startMs).toISOString(),
      startMs, endMs: startMs + 30 * 60_000, dateKey: new Date(startMs).toISOString().slice(0, 10),
      horizonMinutes: 30, regime: 'risk_on', sessionBucket: 'open', x, y, realizedR: y ? 1 : -1
    };
  });
  const expert = trainResearchExpert(rows, { researchModelMinSamples: 200, modelEmbargoMinutes: 30, ensembleBuyProbability: 0.62, bootstrapSamples: 100 }, { horizonMinutes: 30, regime: 'global', minimumSamples: 200 });
  assert.equal(expert.accepted, true);
  assert.equal(expert.validation.purged, true);
  assert.ok(expert.walks[expert.selectedAlgorithm].folds >= 2);
  assert.ok(expert.holdout.selectedExpectancyR > 0);
  assert.ok(expert.holdout.expectancyInterval.low > 0);
});

