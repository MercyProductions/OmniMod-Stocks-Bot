import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLabeledObservations, summarizeResearchStatusRows, summarizeVenueResearchRows } from '../src/researchStore.js';

const now = Date.parse('2026-10-03T09:00:00Z');
const createdAt = '2026-10-02T12:00:00.000Z';
function observation(id = 'one') {
  return { type: 'shadow_created', version: 3, observationId: id, researchCohort: 'full-venue-discovery-v1',
    excludedFromProductionLearning: true, createdAt, deadlineAt: '2026-10-02T16:00:00Z',
    assetId: 'fixture', symbol: 'FIX', candleProvider: 'Binance', candlePair: 'FIXUSDT',
    entryEvidenceVersion: 1, entryQuoteBasis: 'same_source_ask', entryQuoteProvider: 'Binance', entryQuotePair: 'FIXUSDT',
    entryQuoteAsk: 100, entryQuoteAgeMs: 0, entryQuoteObservedAt: createdAt,
    entryPrice: 100, stopPrice: 98, partialTargetPrice: 102, targetPrice: 104, estimatedCostPct: 0.2,
    resolution: { type: 'shadow_resolved', version: 3, timestamp: '2026-10-03T08:00:00Z',
      candleProvider: 'Binance', candlePair: 'FIXUSDT', reason: 'candle_stop_first', priceBasis: 'completed_source_candles',
      realizedR: -1.1, estimatedCostPct: 0.2, timeToEventMinutes: 30, label: 0, targetLabel: 0,
      maxFavorableExcursionR: 0.4, maxAdverseExcursionR: -1.4, currentPrice: 98 } };
}
const report = (rows) => summarizeVenueResearchRows(rows, { now });

test('routing revisions retain separate outcome counts without relabeling older observations', () => {
  const legacy = observation('legacy');
  const current = { ...observation('current'), pairRoutingVersion: 'verified-spot-pair-routing-v1' };
  const invalid = { ...observation('invalid'), pairRoutingVersion: current.pairRoutingVersion, estimatedCostPct: null };
  const pending = { ...current, observationId: 'pending', resolution: null };
  const result = report([legacy, current, invalid, pending]);
  const before = result.byPairRoutingVersion.find(row => row.version === 'legacy_or_unrecorded');
  const after = result.byPairRoutingVersion.find(row => row.version === current.pairRoutingVersion);
  assert.equal(before.observed, 1); assert.equal(before.exactCandleOutcomes.sampleSize, 1);
  assert.equal(after.observed, 3); assert.equal(after.pending, 1); assert.equal(after.excludedResolved, 1);
  assert.equal(after.exactCandleOutcomes.sampleSize, 1); assert.equal(after.exactCandleOutcomes.meanModeledNetR, -1.1);
  assert.equal(legacy.pairRoutingVersion, undefined);
  assert.equal(result.strategyPromotionEligible, false);
});

test('one real-shaped stopped observation shows modeled costs and sample size without inventing fills', () => {
  const row = observation(), before = JSON.stringify(row), result = report([row]);
  assert.equal(result.observed, 1); assert.equal(result.resolved, 1); assert.equal(result.pending, 0);
  assert.equal(result.exactCandleOutcomes.sampleSize, 1);
  assert.equal(result.exactCandleOutcomes.meanModeledNetR, -1.1);
  assert.equal(result.exactCandleOutcomes.meanModeledNetReturnPct, -2.2);
  assert.equal(result.exactCandleOutcomes.meanModeledGrossReturnPct, -2);
  assert.equal(result.exactCandleOutcomes.meanFrozenCostPct, 0.2);
  assert.equal(result.exactCandleOutcomes.worstObservedMaeR, -1.4);
  assert.equal(result.exactCandleOutcomes.entryUtcDays, 1);
  assert.equal(result.fillRate, null); assert.equal(result.target1HitRate, null); assert.equal(result.tradingPnlUsd, null);
  assert.equal(result.strategyPromotionEligible, false); assert.equal(result.trainingEligible, false);
  assert.equal(JSON.stringify(row), before, 'report must not rewrite immutable observations');
});

test('no observations means unknown means, not zero return or a profitable empty strategy', () => {
  const result = report([]);
  assert.equal(result.exactCandleOutcomes.sampleSize, 0);
  assert.equal(result.exactCandleOutcomes.meanModeledNetR, null);
  assert.equal(result.approximateDeadlineAudits.meanModeledNetReturnPct, null);
  assert.equal(result.nextFutureDeadlineAt, null);
  assert.equal(result.status, 'descriptive_candle_research_only');
});

test('unresolved and malformed-deadline observations never become losses', () => {
  const past = { ...observation('past'), resolution: null };
  const future = { ...observation('future'), resolution: null, deadlineAt: '2026-10-03T10:00:00Z' };
  const invalid = { ...observation('invalid'), resolution: null, deadlineAt: null };
  const result = report([past, future, invalid]);
  assert.equal(result.pending, 3); assert.equal(result.due, 1); assert.equal(result.pendingWithoutValidDeadline, 1);
  assert.equal(result.nextFutureDeadlineAt, '2026-10-03T10:00:00.000Z');
  assert.equal(result.exactCandleOutcomes.negativeModeledOutcomes, 0);
});

test('early deadline approximations remain separate from source-validated barrier outcomes', () => {
  const approximate = observation('approximate');
  Object.assign(approximate.resolution, { reason: 'deadline_last_closed_candle', currentPrice: 101, realizedR: 0.4, label: 1,
    timeToEventMinutes: 225, maxFavorableExcursionR: 0.8 });
  const result = report([observation(), approximate]);
  assert.equal(result.exactCandleOutcomes.sampleSize, 1);
  assert.equal(result.exactCandleOutcomes.meanModeledNetR, -1.1);
  assert.equal(result.approximateDeadlineAudits.sampleSize, 1);
  assert.equal(result.approximateDeadlineAudits.meanModeledNetReturnPct, 0.8);
});

test('partial profit and final target outcome reconciles without pretending the full size hit target', () => {
  const row = observation();
  Object.assign(row.resolution, { reason: 'candle_target', currentPrice: 104, realizedR: 1.4, label: 1, targetLabel: 1,
    maxFavorableExcursionR: 2.2 });
  const result = report([row]);
  assert.equal(result.exactCandleOutcomes.sampleSize, 1);
  assert.equal(result.exactCandleOutcomes.meanModeledNetReturnPct, 2.8);
  assert.equal(result.exactCandleOutcomes.meanModeledGrossReturnPct, 3);
  assert.equal(result.target1HitRate, null, 'legacy records do not explicitly retain every partial-target decision');
});

test('cost omissions, changed frozen costs, bad numeric values and incompatible labels exclude resolved rows', () => {
  for (const mutate of [
    (row) => { row.estimatedCostPct = null; }, (row) => { row.resolution.estimatedCostPct = 0.3; },
    (row) => { row.resolution.realizedR = true; }, (row) => { row.resolution.maxAdverseExcursionR = 1; },
    (row) => { row.resolution.estimatedCostPct = ' '; }, (row) => { row.resolution.label = 1; },
  ]) {
    const row = observation(); mutate(row);
    const result = report([row]);
    assert.equal(result.exactCandleOutcomes.sampleSize, 0);
    assert.equal(result.exclusionReasons.invalid_cost_or_outcome_values, 1);
  }
});

test('unreconciled modeled returns and impossible partial-profit claims are not pooled', () => {
  for (const fields of [{ realizedR: -0.1 }, { currentPrice: 104, realizedR: 1.4, label: 1 }]) {
    const row = observation(); Object.assign(row.resolution, fields);
    const result = report([row]);
    assert.equal(result.excludedResolved, 1);
    assert.equal(result.exclusionReasons.modeled_return_does_not_reconcile, 1);
  }
});

test('source, entry evidence, timestamp and label-version problems have distinct exclusions', () => {
  for (const [mutate, reason] of [
    [(row) => { row.resolution.candlePair = 'OTHERUSDT'; }, 'source_or_outcome_basis_unverified'],
    [(row) => { row.resolution.reason = 'snapshot_target'; }, 'source_or_outcome_basis_unverified'],
    [(row) => { row.entryQuoteBasis = 'snapshot'; }, 'entry_quote_evidence_missing'],
    [(row) => { row.resolution.timestamp = '2027-01-01T00:00:00Z'; }, 'invalid_observation_timing'],
    [(row) => { row.resolution.timeToEventMinutes = 500; }, 'invalid_observation_timing'],
    [(row) => { row.resolution.version = 2; }, 'unsupported_label_version'],
  ]) {
    const row = observation(); mutate(row);
    const result = report([row]); assert.equal(result.excludedResolved, 1); assert.equal(result.exclusionReasons[reason], 1);
  }
});

test('production cohorts and orphan resolution records do not enter the independent summary or training', () => {
  const row = observation();
  const result = report([row, { ...observation('production'), researchCohort: undefined },
    { type: 'shadow_resolved', researchCohort: 'full-venue-discovery-v1', resolution: row.resolution }]);
  assert.equal(result.observed, 1);
  assert.deepEqual(normalizeLabeledObservations([row]), []);
  assert.equal(summarizeResearchStatusRows([row]).venueResearch.exactCandleOutcomes.sampleSize, 1);
});

test('multiple observations on the same UTC date remain one entry date and invalid report time is rejected', () => {
  assert.equal(report([observation('a'), observation('b')]).exactCandleOutcomes.entryUtcDays, 1);
  assert.throws(() => summarizeVenueResearchRows([], { now: NaN }), /finite/);
});
