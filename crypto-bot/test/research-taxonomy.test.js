import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentEdgeEvidence } from '../src/edgeEvidence.js';
import { classifyResearchMetadata } from '../src/researchTaxonomy.js';

test('research taxonomy captures descriptive setup, UTC time, turnover proxy, event-veto state, and model versions', () => {
  const asset = {
    symbol: 'BTC', volume24h: 20_000_000,
    marketData: { providerCount: 4, technicals: { dataSufficient: true, ema9: 102, ema21: 100, return1h: 1.1 }, eventRisk: { caution: true,
      events: [{ eventType: 'token_unlock', direction: 'negative', expectedness: 'scheduled', horizon: 'swing', impact: 'high' }] } }
  };
  const before = JSON.stringify(asset);
  const labels = classifyResearchMetadata(asset, new Date('2026-09-24T13:00:00Z'), { eventVetoEnabled: true }, {
    production: { id: 'bundle-7', meta: { id: 'meta-3' }, outcomes: { id: 'outcome-2' } }
  });
  assert.equal(labels.setupFamily, 'confirmed_trend_continuation');
  assert.equal(labels.timeBucketUtc, '12-17');
  assert.equal(labels.reportedTurnoverCohort, '10m_to_100m_usd');
  assert.equal(labels.manualEventStatus, 'active_caution');
  assert.deepEqual([labels.manualCatalystType, labels.manualCatalystDirection, labels.manualCatalystExpectedness, labels.manualCatalystHorizon, labels.manualCatalystImpact],
    ['token_unlock', 'negative', 'scheduled', 'swing', 'high']);
  assert.equal(labels.productionBundleId, 'bundle-7');
  assert.equal(labels.metaModelId, 'meta-3');
  assert.equal(JSON.stringify(asset), before);

  const mixedContext = classifyResearchMetadata({ marketData: { eventRisk: { observe: true, events: [
    { eventType: 'token_unlock', direction: 'negative', expectedness: 'scheduled', horizon: 'swing', impact: 'high' },
    { eventType: 'exchange_listing', direction: 'positive', expectedness: 'unexpected', horizon: 'intraday', impact: 'medium' }
  ] } } }, new Date('2026-09-24T13:00:00Z'), { eventVetoEnabled: true });
  assert.equal(mixedContext.manualEventStatus, 'active_observe');
  assert.deepEqual([mixedContext.manualCatalystType, mixedContext.manualCatalystDirection, mixedContext.manualCatalystExpectedness,
    mixedContext.manualCatalystHorizon, mixedContext.manualCatalystImpact], ['multiple', 'multiple', 'multiple', 'multiple', 'multiple']);

  const snapshotOnly = classifyResearchMetadata({ volume24h: 500_000 }, new Date('2026-09-24T23:59:00Z'), { eventVetoEnabled: false });
  assert.equal(snapshotOnly.setupFamily, 'snapshot_momentum');
  assert.equal(snapshotOnly.timeBucketUtc, '18-23');
  assert.equal(snapshotOnly.reportedTurnoverCohort, 'under_1m_usd');
  assert.equal(snapshotOnly.manualEventStatus, 'disabled');
  assert.equal(snapshotOnly.productionBundleId, 'deterministic_only');
  const unknownProviders = classifyResearchMetadata({ marketData: { providerCount: null } });
  assert.equal(unknownProviders.providerCountAtObservation, null);
  assert.equal(classifyResearchMetadata({ marketData: { providerCount: 0 } }).providerCountAtObservation, 0);
});

test('outcome evidence can be segmented by stored taxonomy without changing outcomes', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    observationId: `obs-${index}`, realizedR: index % 2 ? 0.7 : -0.3,
    completedAt: new Date(Date.parse('2026-08-01T00:00:00Z') + index * 86_400_000).toISOString(),
    horizonKey: 'rapid', regimeKey: 'risk_on', setupFamily: index % 2 ? 'confirmed_trend_continuation' : 'snapshot_momentum',
    timeBucketUtc: '12-17', reportedTurnoverCohort: '10m_to_100m_usd', manualEventStatus: 'no_active_manual_event',
    manualCatalystType: index % 2 ? 'token_unlock' : 'exchange_listing', manualCatalystDirection: index % 2 ? 'negative' : 'positive',
    manualCatalystExpectedness: 'scheduled', manualCatalystHorizon: index % 2 ? 'swing' : 'intraday', manualCatalystImpact: 'medium'
  }));
  const segments = segmentEdgeEvidence(rows, { now: new Date('2026-09-24T00:00:00Z') });
  assert.equal(segments.filter((row) => row.dimension === 'setupFamily').length, 2);
  assert.equal(segments.find((row) => row.dimension === 'setupFamily' && row.key === 'snapshot_momentum').samples, 15);
  assert.equal(segments.filter((row) => row.dimension === 'timeBucketUtc').length, 1);
  assert.equal(segments.filter((row) => row.dimension === 'horizonKey').length, 1);
  assert.equal(segments.filter((row) => row.dimension === 'manualCatalystType').length, 2);
  assert.equal(segments.find((row) => row.dimension === 'manualCatalystDirection' && row.key === 'positive').samples, 15);
});
