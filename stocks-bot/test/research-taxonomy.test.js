import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelFeatures } from '../src/modelFeatures.js';
import { classifyStockResearchMetadata, summarizeStockResearchSegments, formatStockResearchSegment } from '../src/researchTaxonomy.js';
import { labelCounterfactualSnapshot } from '../src/counterfactualLabels.js';

test('stock shadow taxonomy derives descriptive cohorts from as-of snapshot only', () => {
  const snapshot = {
    marketMinute: 585, marketRegime: 'risk-on trend', averageDailyVolume: 2_000_000,
    livePrice: 10, spreadBps: 8, modelVersion: 'stocks-v4-test',
    eventRisk: { daysToEarnings: 20, secDataStatus: 'available', corporateActionDataStatus: 'available', manualCatalysts: [
      { eventType: 'earnings', direction: 'unknown', expectedness: 'scheduled', horizon: 'intraday', impact: 'high' }
    ] },
    macro: { status: 'partial', componentsAvailable: 2 },
    features: { breakoutFactor: 75, trendFactor: 60, momentumFactor: 62, relativeVolume: 2 }
  };
  const before = extractModelFeatures(snapshot);
  const metadata = classifyStockResearchMetadata(snapshot);
  assert.equal(metadata.setupFamily, 'breakout_led');
  assert.equal(metadata.sessionBucket, 'opening_30m');
  assert.equal(metadata.marketRegime, 'risk-on trend');
  assert.equal(metadata.dollarVolumeCohort, '10m_to_100m_usd');
  assert.equal(metadata.spreadCohort, 'tight_le_10bps');
  assert.equal(metadata.eventStatus, 'event_checked_no_near_risk');
  assert.equal(metadata.eventCoverage, 'complete');
  assert.equal(metadata.macroCoverage, 'partial_2_of_3');
  assert.equal(metadata.manualCatalystType, 'earnings');
  assert.equal(metadata.manualCatalystDirection, 'unknown');
  assert.equal(metadata.modelVersion, 'stocks-v4-test');
  assert.deepEqual(extractModelFeatures(snapshot), before);
});

test('stock shadow taxonomy preserves unknowns and classifies extended sessions', () => {
  assert.equal(classifyStockResearchMetadata({ marketMinute: 510 }).sessionBucket, 'premarket');
  assert.equal(classifyStockResearchMetadata({ marketMinute: 1000 }).sessionBucket, 'after_hours');
  assert.equal(classifyStockResearchMetadata({ marketMinute: null, spreadBps: null }).spreadCohort, 'unknown');
  assert.equal(classifyStockResearchMetadata({}).eventStatus, 'unknown');
  assert.equal(classifyStockResearchMetadata({}).eventCoverage, 'unknown');
  assert.equal(classifyStockResearchMetadata({ macroDataStatus: 'credentials_missing' }).macroCoverage, 'credentials_missing');
  assert.equal(classifyStockResearchMetadata({}).manualCatalystType, 'none');
  assert.equal(classifyStockResearchMetadata({}).setupFamily, 'unknown');
  assert.equal(classifyStockResearchMetadata({ averageDailyVolume: 0, price: 5 }).dollarVolumeCohort, 'under_1m_usd');
  assert.equal(classifyStockResearchMetadata({ eventRisk: { daysToEarnings: 2 } }).eventStatus, 'known_event_risk');
});

test('counterfactual outcomes carry taxonomy as metadata without changing outcome arithmetic', () => {
  const start = Math.floor(new Date('2026-07-21T15:00:00.000Z').getTime() / 1000);
  const snapshot = {
    snapshotId: 'taxonomy-snapshot', guildId: 'guild', symbol: 'XYZ', recordedAt: new Date(start * 1000).toISOString(),
    price: 100, livePrice: 100, bidPrice: 99.98, askPrice: 100.02, spreadBps: 4, halted: false,
    marketMinute: 600, averageDailyVolume: 1_000_000, marketRegime: 'mixed', modelVersion: 'stocks-v4',
    features: { dailyAtrPercent: 2, intradayAtrPercent: 0.4, breakoutFactor: 75 }
  };
  const bars = Array.from({ length: 31 }, (_, index) => ({ timestamp: start + index * 60,
    open: 100.05, high: 100.3, low: 99.9, close: 100.1, volume: 1000 }));
  const [label] = labelCounterfactualSnapshot(snapshot, bars, { horizons: [30] });
  assert.equal(label.setupFamily, 'breakout_led');
  assert.equal(label.sessionBucket, 'morning');
  assert.equal(label.marketRegime, 'mixed');
  assert.equal(label.modelVersion, 'stocks-v4');
  assert.equal(label.taxonomyVersion, 'stocks-shadow-taxonomy-v3');
  const [withoutTaxonomyFactors] = labelCounterfactualSnapshot({ ...snapshot, marketMinute: undefined,
    marketRegime: undefined, modelVersion: undefined, averageDailyVolume: undefined,
    features: { dailyAtrPercent: 2, intradayAtrPercent: 0.4 } }, bars, { horizons: [30] });
  assert.equal(label.entryPrice, withoutTaxonomyFactors.entryPrice);
  assert.equal(label.realizedR, withoutTaxonomyFactors.realizedR);
});

test('multiple manual catalyst tags remain multiple and produce separate outcome segments', () => {
  const metadata = classifyStockResearchMetadata({ eventRisk: { manualCatalysts: [
    { eventType: 'earnings', direction: 'positive', expectedness: 'scheduled', horizon: 'intraday', impact: 'high' },
    { eventType: 'sec_filing', direction: 'negative', expectedness: 'unexpected', horizon: 'swing', impact: 'medium' }
  ] } });
  assert.equal(metadata.manualCatalystType, 'multiple');
  assert.equal(metadata.manualCatalystDirection, 'multiple');
  const rows = [
    { manualCatalystType: 'earnings', manualCatalystDirection: 'positive', horizonMinutes: 30, realizedR: 0.4, terminalAt: '2026-07-21T15:30:00Z' },
    { manualCatalystType: 'multiple', manualCatalystDirection: 'multiple', horizonMinutes: 30, realizedR: -0.2, terminalAt: '2026-07-22T15:30:00Z' }
  ];
  const segments = summarizeStockResearchSegments(rows);
  assert.equal(segments.find((row) => row.dimension === 'manualCatalystType' && row.cohort === 'multiple').meanRealizedR, -0.2);
  assert.equal(segments.find((row) => row.dimension === 'manualCatalystDirection' && row.cohort === 'positive').samples, 1);
});

test('shadow outcomes segment feed coverage separately from observed event risk', () => {
  const rows = [
    { eventStatus: 'event_checked_no_near_risk', eventCoverage: 'complete', macroCoverage: 'complete_3_of_3', horizonMinutes: 30, realizedR: 0.4, terminalAt: '2026-07-21T15:30:00Z' },
    { eventStatus: 'event_checked_no_near_risk', eventCoverage: 'partial', macroCoverage: 'credentials_missing', horizonMinutes: 30, realizedR: -0.2, terminalAt: '2026-07-22T15:30:00Z' }
  ];
  const segments = summarizeStockResearchSegments(rows);
  assert.equal(segments.find((row) => row.dimension === 'eventCoverage' && row.cohort === 'complete').samples, 1);
  assert.equal(segments.find((row) => row.dimension === 'eventCoverage' && row.cohort === 'partial').meanRealizedR, -0.2);
  assert.equal(segments.find((row) => row.dimension === 'macroCoverage' && row.cohort === 'credentials_missing').samples, 1);
  assert.equal(segments.find((row) => row.dimension === 'macroCoverage' && row.cohort === 'complete_3_of_3').meanRealizedR, 0.4);
});

test('segment summaries require minimum sample and outcome-day counts before interval estimates', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ setupFamily: 'breakout_led', horizonMinutes: 30,
    realizedR: index % 2 ? 0.4 : -0.2, terminalAt: new Date(Date.UTC(2026, 0, 2 + index % 4, 2)).toISOString() }));
  let summary = summarizeStockResearchSegments(rows).find((row) => row.dimension === 'setupFamily');
  assert.equal(summary.samples, 20);
  assert.equal(summary.independentDayClusters, 4);
  assert.equal(summary.status, 'insufficient_evidence');
  assert.match(formatStockResearchSegment(summary), /interval unavailable/);
  rows.push({ ...rows[0], terminalAt: new Date('2026-01-06T02:00:00Z').toISOString() });
  rows[1] = { ...rows[1], terminalAt: new Date('2026-01-07T02:00:00Z').toISOString() };
  rows[2] = { ...rows[2], terminalAt: new Date('2026-01-08T02:00:00Z').toISOString() };
  summary = summarizeStockResearchSegments(rows).find((row) => row.dimension === 'setupFamily');
  assert.equal(summary.independentDayClusters, 7);
  assert.notEqual(summary.lower95R, null);
  assert.ok(['positive_estimate', 'negative_estimate', 'inconclusive'].includes(summary.status));

  const otherHorizon = Array.from({ length: 20 }, (_, index) => ({ setupFamily: 'breakout_led', horizonMinutes: 90,
    realizedR: index % 2 ? 0.3 : -0.1, terminalAt: new Date(Date.UTC(2026, 0, 2 + index % 7, 16)).toISOString() }));
  const setupSegments = summarizeStockResearchSegments([...rows, ...otherHorizon]).filter((row) => row.dimension === 'setupFamily');
  assert.deepEqual(setupSegments.map((row) => row.horizonMinutes).sort(), [30, 90]);
  assert.deepEqual(setupSegments.map((row) => row.samples).sort((a, b) => a - b), [20, 21]);
});
