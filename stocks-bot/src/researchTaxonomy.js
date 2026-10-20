import { config } from './config.js';
import { localDateKey } from './time.js';

const finite = (value, fallback = null) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;

function score(snapshot, key) {
  return finite(snapshot.features?.[key], null);
}

// Descriptive labels only: never append these values to feature vectors or
// use them to decide whether a production candidate can be approved.
export function classifyStockResearchMetadata(snapshot = {}) {
  const breakout = score(snapshot, 'breakoutFactor');
  const trend = score(snapshot, 'trendFactor');
  const momentum = score(snapshot, 'momentumFactor');
  const relativeVolume = score(snapshot, 'relativeVolume');
  const setupFamily = breakout !== null && breakout >= 70 ? 'breakout_led'
    : relativeVolume !== null && relativeVolume >= 1.5 && momentum !== null && momentum >= 60 ? 'volume_momentum'
      : trend !== null && trend >= 65 && momentum !== null && momentum >= 60 ? 'trend_momentum'
        : breakout === null && trend === null && momentum === null ? 'unknown' : 'other_screened';

  const minute = finite(snapshot.marketMinute, null);
  const sessionBucket = minute === null ? 'unknown'
    : minute < 240 ? 'overnight'
      : minute >= 240 && minute < 570 ? 'premarket'
      : minute >= 570 && minute < 600 ? 'opening_30m'
        : minute < 720 ? 'morning'
          : minute < 840 ? 'midday'
            : minute < 960 ? 'late_session'
              : minute < 1200 ? 'after_hours' : 'outside_regular_extended';

  const averageDailyVolume = finite(snapshot.averageDailyVolume, null);
  const referencePrice = finite(snapshot.livePrice, finite(snapshot.price, null));
  const averageDollarVolumeEstimate = averageDailyVolume !== null && referencePrice !== null
    ? Math.max(0, averageDailyVolume * referencePrice) : null;
  const dollarVolumeCohort = averageDollarVolumeEstimate === null ? 'unknown'
    : averageDollarVolumeEstimate < 1_000_000 ? 'under_1m_usd'
      : averageDollarVolumeEstimate < 10_000_000 ? '1m_to_10m_usd'
        : averageDollarVolumeEstimate < 100_000_000 ? '10m_to_100m_usd' : '100m_plus_usd';

  const spreadBps = finite(snapshot.spreadBps, null);
  const spreadCohort = spreadBps === null ? 'unknown'
    : spreadBps <= 10 ? 'tight_le_10bps'
      : spreadBps <= 35 ? 'moderate_11_to_35bps'
        : spreadBps <= 100 ? 'wide_36_to_100bps' : 'very_wide_gt_100bps';
  const eventRisk = snapshot.eventRisk || {};
  const eventStatus = Number(eventRisk.secFilingRisk || 0) > 0 || Number(eventRisk.corporateActionRisk || 0) > 0
    || (finite(eventRisk.daysToEarnings, null) !== null && Number(eventRisk.daysToEarnings) >= 0 && Number(eventRisk.daysToEarnings) <= 2)
    ? 'known_event_risk'
    : ['secFilingAgeHours', 'daysToCorporateAction', 'daysToEarnings'].some((key) => finite(eventRisk[key], null) !== null)
    ? 'event_checked_no_near_risk' : 'unknown';
  const secStatus = String(eventRisk.secDataStatus || snapshot.secDataStatus || 'unknown');
  const corporateStatus = String(eventRisk.corporateActionDataStatus || snapshot.corporateActionDataStatus || 'unknown');
  const knownEventStatuses = [secStatus, corporateStatus].filter((status) => status !== 'unknown');
  const eventCoverage = knownEventStatuses.length === 0 ? 'unknown'
    : knownEventStatuses.every((status) => status === 'available') ? 'complete'
      : knownEventStatuses.some((status) => status === 'available') ? 'partial'
        : knownEventStatuses.map((status) => status.replace(/[^a-z0-9]+/gi, '_').toLowerCase()).sort().join('+');
  const macro = snapshot.macro || {};
  const macroStatus = String(snapshot.macroDataStatus || macro.status || 'unknown');
  const macroCount = finite(snapshot.macroComponentsAvailable ?? macro.componentsAvailable, null);
  const macroCoverage = macroStatus === 'available' ? 'complete_3_of_3'
    : macroStatus === 'partial' ? `partial_${macroCount === null ? 'unknown' : macroCount}_of_3`
      : macroStatus.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const catalysts = Array.isArray(eventRisk.manualCatalysts) ? eventRisk.manualCatalysts : Array.isArray(snapshot.manualCatalysts) ? snapshot.manualCatalysts : [];
  const catalystTag = (key) => {
    const values = [...new Set(catalysts.map((row) => String(row?.[key] || 'unknown')).filter(Boolean))].sort();
    return values.length === 0 ? 'none' : values.length === 1 ? values[0] : 'multiple';
  };

  return {
    setupFamily,
    sessionBucket,
    marketRegime: String(snapshot.marketRegime || 'unknown'),
    averageDollarVolumeEstimate,
    dollarVolumeCohort,
    spreadCohort,
    eventStatus,
    eventCoverage,
    macroCoverage,
    manualCatalystType: catalystTag('eventType'),
    manualCatalystDirection: catalystTag('direction'),
    manualCatalystExpectedness: catalystTag('expectedness'),
    manualCatalystHorizon: catalystTag('horizon'),
    manualCatalystImpact: catalystTag('impact'),
    modelVersion: String(snapshot.modelVersion || snapshot.ensemble?.modelId || snapshot.ensemble?.expertId || snapshot.ensemble?.source || 'unknown'),
    taxonomyVersion: 'stocks-shadow-taxonomy-v3'
  };
}

function criticalT(df) {
  const table = [[1,12.707],[2,4.303],[3,3.183],[4,2.777],[5,2.571],[6,2.447],[7,2.365],[8,2.306],[9,2.262],[10,2.228],[12,2.179],[15,2.131],[20,2.086],[30,2.042],[60,2.000],[120,1.980]];
  return table.filter(([degrees]) => degrees <= df).at(-1)?.[1] ?? 12.707;
}

export function summarizeStockResearchSegments(rows = [], options = {}) {
  const minimumSamples = Math.max(10, Number(options.minimumSamples) || 20);
  const minimumDays = Math.max(5, Number(options.minimumDays) || 5);
  const dimensions = ['setupFamily', 'sessionBucket', 'marketRegime', 'dollarVolumeCohort', 'spreadCohort', 'eventStatus', 'eventCoverage', 'macroCoverage',
    'manualCatalystType', 'manualCatalystDirection', 'manualCatalystExpectedness', 'manualCatalystHorizon', 'manualCatalystImpact', 'horizonMinutes', 'modelVersion'];
  return dimensions.flatMap((dimension) => {
    const groups = new Map();
    for (const row of rows) {
      const value = row[dimension];
      if (value === null || value === undefined || value === '') continue;
      const cohort = String(value);
      const horizonMinutes = finite(row.horizonMinutes, null);
      const groupId = dimension === 'horizonMinutes' ? cohort : `${horizonMinutes ?? 'unknown'}|${cohort}`;
      const group = groups.get(groupId) || { cohort, horizonMinutes, rows: [] };
      group.rows.push(row); groups.set(groupId, group);
    }
    return [...groups.values()].map(({ cohort, horizonMinutes, rows: group }) => {
      const values = group.map((row) => finite(row.realizedR, null)).filter((value) => value !== null);
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const days = new Map();
      for (const row of group) {
        const value = finite(row.realizedR, null);
        const timestamp = Date.parse(row.terminalAt || row.labeledAt || '');
        if (value === null || !Number.isFinite(timestamp)) continue;
        const day = localDateKey(new Date(timestamp), config.marketTimezone);
        days.set(day, (days.get(day) || 0) + value - mean);
      }
      const n = values.length; const clusters = days.size;
      const variance = clusters > 1 ? clusters / (clusters - 1) * [...days.values()].reduce((sum, value) => sum + value ** 2, 0) / n ** 2 : null;
      const estimable = n >= minimumSamples && clusters >= minimumDays && variance > Number.EPSILON;
      const margin = estimable ? criticalT(clusters - 1) * Math.sqrt(variance) : null;
      const key = dimension === 'horizonMinutes' ? cohort : `${horizonMinutes ?? 'unknown'}m | ${cohort}`;
      return { dimension, key, cohort, horizonMinutes, samples: n, independentDayClusters: clusters, meanRealizedR: mean,
        lower95R: margin === null ? null : mean - margin, upper95R: margin === null ? null : mean + margin,
        status: !estimable ? 'insufficient_evidence' : mean - margin > 0 ? 'positive_estimate' : mean + margin < 0 ? 'negative_estimate' : 'inconclusive' };
    }).sort((left, right) => right.samples - left.samples || left.key.localeCompare(right.key));
  });
}

export function formatStockResearchSegment(row) {
  if (!row.samples) return `${row.key}: no resolved outcomes`;
  const interval = row.lower95R === null ? 'interval unavailable' : `approx. 95% range ${row.lower95R.toFixed(2)} to ${row.upper95R.toFixed(2)}R`;
  return `${row.key}: ${row.status.replaceAll('_', ' ')} | n=${row.samples}, ${row.independentDayClusters} outcome days | mean ${row.meanRealizedR.toFixed(2)}R | ${interval}`;
}
