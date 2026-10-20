import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_LABEL_VERSION, RESEARCH_ENTRY_EVIDENCE_VERSION,
  summarizeLiquidityShadowCohorts, summarizeResearchStatusRows } from '../src/researchStore.js';
import { FEATURE_SCHEMA_VERSION } from '../src/modelFeatures.js';

function pinned(row) {
  return { ...row, version: RESEARCH_LABEL_VERSION, candleProvider: 'Binance', candlePair: 'BTCUSDT',
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION, entryQuoteBasis: 'same_source_ask',
    entryQuoteProvider: 'Binance', entryQuotePair: 'BTCUSDT',
    entryQuoteObservedAt: row.createdAt || null, entryQuoteAgeMs: 0, entryQuoteAsk: 100, entryPrice: 100,
    ...(row.resolution ? { resolution: { ...row.resolution, version: RESEARCH_LABEL_VERSION,
      candleProvider: 'Binance', candlePair: 'BTCUSDT', priceBasis: 'completed_source_candles',
      reason: row.resolution.reason || 'candle_target' } } : {}) };
}

function resolvedRows(perHalf = 20) {
  return Array.from({ length: perHalf * 2 }, (_, index) => {
    const lowScore = index < perHalf;
    const day = index % 5;
    const realizedR = lowScore ? (day % 2 ? -0.2 : -0.1) : (day % 2 ? 0.2 : 0.1);
    return pinned({
      observationId: `shadow-${index}`,
      createdAt: `2026-09-${String(1 + day).padStart(2, '0')}T12:00:00.000Z`,
      counterfactuals: { version: 'execution-liquidity-v1', score: index },
      resolution: { version: 2, realizedR, timestamp: `2026-09-25T12:00:00.000Z` }
    });
  });
}

test('execution-liquidity shadow withholds score-half comparison below minimum outcomes or days', () => {
  const sparse = [
    { observationId: 'a', createdAt: '2026-09-01T12:00:00Z', counterfactuals: { version: 'execution-liquidity-v1', score: 20 }, resolution: { version: 2, realizedR: -2 } },
    { observationId: 'b', createdAt: '2026-09-02T12:00:00Z', counterfactuals: { version: 'execution-liquidity-v1', score: 30 }, resolution: { version: 2, realizedR: 0 } },
    { observationId: 'c', createdAt: '2026-09-03T12:00:00Z', counterfactuals: { version: 'execution-liquidity-v1', score: 70 }, resolution: { version: 2, realizedR: 1 } },
    { observationId: 'd', createdAt: '2026-09-04T12:00:00Z', counterfactuals: { version: 'execution-liquidity-v1', score: 80 }, resolution: { version: 2, realizedR: 3 } },
    { observationId: 'pending', counterfactuals: { version: 'execution-liquidity-v1', score: 90 } },
    { observationId: 'null-score', counterfactuals: { version: 'execution-liquidity-v1', score: null }, resolution: { version: 2, realizedR: 5 } },
    { observationId: 'null-outcome', createdAt: '2026-09-05T12:00:00Z', counterfactuals: { version: 'execution-liquidity-v1', score: 95 }, resolution: { version: 2, realizedR: null } },
    { counterfactuals: { version: 'other', score: 100 }, resolution: { version: 2, realizedR: 99 } }
  ];
  const result = summarizeLiquidityShadowCohorts(sparse.map(pinned));
  assert.equal(result.observed, 6);
  assert.equal(result.resolved, 4);
  assert.equal(result.pending, 1);
  assert.equal(result.unusableResolved, 1);
  assert.equal(result.lowerHalf.n, 2);
  assert.equal(result.upperHalf.n, 2);
  assert.equal(result.lowerHalf.status, 'insufficient_evidence');
  assert.equal(result.lowerHalf.lower95R, null);
});

test('Crypto research status reports only training-valid source-pinned outcomes as eligible', () => {
  const completeResolution = { version: 2, label: 1, targetLabel: 1, realizedR: 0.5, estimatedCostPct: 0.1,
    timeToEventMinutes: 15, maxFavorableExcursionR: 1, maxAdverseExcursionR: -0.2, timestamp: '2026-09-01T00:15:00Z' };
  const rows = [
    pinned({ observationId: 'valid', createdAt: '2026-09-01T00:00:00Z', featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: {}, resolution: completeResolution }),
    pinned({ observationId: 'malformed', createdAt: '2026-09-01T00:00:00Z', features: {}, resolution: { ...completeResolution, realizedR: null } }),
    { observationId: 'legacy', createdAt: '2026-09-01T00:00:00Z', features: {}, resolution: { version: 1, label: 0 } },
    { observationId: 'pending', createdAt: '2026-09-01T00:00:00Z', features: {} },
  ];
  const report = summarizeResearchStatusRows(rows);
  assert.equal(report.eligibleLabeled, 1);
  assert.equal(report.malformedResolved, 1);
  assert.equal(report.legacyLabeled, 1);
  assert.equal(report.labeled, 3);
  assert.equal(report.pending, 1);
  assert.equal(report.evidence.samples, 1);
});

test('execution-liquidity shadow reports clustered score-half intervals only after minimum sample and day coverage', () => {
  const result = summarizeLiquidityShadowCohorts(resolvedRows());
  assert.equal(result.observed, 40);
  assert.equal(result.resolved, 40);
  assert.equal(result.lowerHalf.n, 20);
  assert.equal(result.upperHalf.n, 20);
  assert.equal(result.lowerHalf.observationDays, 5);
  assert.equal(result.upperHalf.observationDays, 5);
  assert.notEqual(result.lowerHalf.lower95R, null);
  assert.notEqual(result.upperHalf.lower95R, null);
  assert.equal(result.lowerHalf.status, 'negative_estimate');
  assert.equal(result.upperHalf.status, 'positive_estimate');
});

test('approximate deadline marks are auditable but excluded from training and liquidity comparisons', () => {
  const rows = resolvedRows(20);
  rows[0].resolution.reason = 'deadline_last_closed_candle';
  const liquidity = summarizeLiquidityShadowCohorts(rows);
  assert.equal(liquidity.resolved, 39);
  assert.equal(liquidity.unusableResolved, 1);
  const status = summarizeResearchStatusRows(rows);
  assert.equal(status.approximateDeadlineExcludedResolved, 1);
});

test('execution-liquidity shadow withholds intervals when observations cluster on too few days', () => {
  const rows = resolvedRows();
  for (const row of rows) {
    row.createdAt = '2026-09-01T12:00:00.000Z';
    row.entryQuoteObservedAt = row.createdAt;
  }
  const result = summarizeLiquidityShadowCohorts(rows);
  assert.equal(result.lowerHalf.n, 20);
  assert.equal(result.lowerHalf.observationDays, 1);
  assert.equal(result.lowerHalf.status, 'insufficient_evidence');
  assert.equal(result.lowerHalf.lower95R, null);
});
