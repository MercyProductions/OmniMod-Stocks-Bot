// Diagnostic intervals, not guarantees: UTC-day clustering reduces intraday
// pseudoreplication but still assumes independent day clusters and stable returns.
export function numericValue(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function tCritical(df) {
  const table = [[1,12.707],[2,4.303],[3,3.183],[4,2.777],[5,2.571],[6,2.447],[7,2.365],[8,2.307],[9,2.263],
    [10,2.229],[12,2.179],[15,2.132],[20,2.086],[30,2.043],[60,2.001],[120,1.98]];
  return table.filter(([degrees]) => degrees <= df).at(-1)?.[1] ?? 12.707;
}

export function summarizeEdgeEvidence(rows = [], options = {}) {
  const minimumSamples = Math.max(10, Number(options.minimumSamples) || 20);
  const minimumDays = Math.max(5, Number(options.minimumDays) || 5);
  const now = new Date(options.now ?? Date.now()).getTime();
  const seen = new Set();
  const valid = rows.filter((row) => {
    const value = numericValue(row.realizedR);
    const time = new Date(row.completedAt || row.resolvedAt || row.exitTime).getTime();
    const id = row.observationId || row.id;
    if (value === null || !Number.isFinite(time) || time > now || (id && seen.has(id))) return false;
    if (id) seen.add(id);
    return true;
  });
  const n = valid.length;
  const mean = n ? valid.reduce((sum, row) => sum + Number(row.realizedR), 0) / n : null;
  const days = new Map();
  for (const row of valid) {
    const date = new Date(row.completedAt || row.resolvedAt || row.exitTime).toISOString().slice(0, 10);
    days.set(date, (days.get(date) || 0) + Number(row.realizedR) - mean);
  }
  const clusters = days.size;
  const enough = n >= minimumSamples && clusters >= minimumDays;
  const variance = clusters > 1 ? clusters / (clusters - 1) * [...days.values()].reduce((sum, value) => sum + value ** 2, 0) / n ** 2 : null;
  // Constant samples provide no estimate of unobserved tail risk; never certify them.
  const estimable = enough && variance > Number.EPSILON;
  const margin = estimable ? tCritical(clusters - 1) * Math.sqrt(variance) : null;
  const lower = margin === null ? null : mean - margin;
  const upper = margin === null ? null : mean + margin;
  return {
    samples: n, excluded: rows.length - n, independentDayClusters: clusters, minimumSamples, minimumDays,
    expectancyR: mean, lower95R: lower, upper95R: upper,
    status: !enough || !estimable ? 'insufficient_evidence' : lower > 0 ? 'positive_estimate' : upper < 0 ? 'negative_estimate' : 'inconclusive',
    method: 'Approximate 95% Student-t interval with UTC-day cluster-robust standard error; descriptive, not multiplicity-adjusted.',
    limitation: 'Same-day dependence is grouped; dependence across days, nonstationarity, and unobserved tail losses can invalidate this interval.'
  };
}

export function segmentEdgeEvidence(rows = [], options = {}) {
  return ['horizonKey', 'regimeKey', 'setupFamily', 'timeBucketUtc', 'reportedTurnoverCohort', 'manualEventStatus',
    'manualCatalystType', 'manualCatalystDirection', 'manualCatalystExpectedness', 'manualCatalystHorizon', 'manualCatalystImpact'].flatMap((dimension) => {
    const legacyDimension = ['horizonKey', 'regimeKey'].includes(dimension);
    const keys = [...new Set(rows
      .filter((row) => legacyDimension || (row[dimension] !== null && row[dimension] !== undefined && row[dimension] !== ''))
      .map((row) => String(row[dimension] || (legacyDimension ? 'unknown' : ''))))].filter(Boolean);
    return keys.map((key) => ({ dimension, key, ...summarizeEdgeEvidence(rows.filter((row) => String(row[dimension] || 'unknown') === key), options) }));
  });
}

export function summarizeProbabilityEvidence(rows = [], options = {}) {
  const minimumSamples = Math.max(10, Number(options.minimumSamples) || 20);
  const minimumDays = Math.max(5, Number(options.minimumDays) || 5);
  const now = new Date(options.now ?? Date.now()).getTime();
  const seen = new Set();
  const valid = rows.filter((row) => {
    const predicted = numericValue(row.probability);
    const outcome = numericValue(row.realizedR);
    const completedAt = new Date(row.completedAt || '').getTime();
    const key = row.observationId || row.id;
    if (predicted === null || predicted < 0 || predicted > 1 || outcome === null
      || !Number.isFinite(completedAt) || completedAt > now || (key && seen.has(key))) return false;
    if (key) seen.add(key);
    return true;
  });
  const outcomes = valid.map((row) => ({ probability: Number(row.probability), event: Number(row.realizedR) > 0 ? 1 : 0,
    day: new Date(row.completedAt).toISOString().slice(0, 10) }));
  const n = outcomes.length;
  const observedRate = n ? outcomes.reduce((sum, row) => sum + row.event, 0) / n : null;
  const meanProbability = n ? outcomes.reduce((sum, row) => sum + row.probability, 0) / n : null;
  const brier = n ? outcomes.reduce((sum, row) => sum + (row.probability - row.event) ** 2, 0) / n : null;
  const baselineBrier = n ? outcomes.reduce((sum, row) => sum + ((observedRate || 0) - row.event) ** 2, 0) / n : null;
  const days = new Set(outcomes.map((row) => row.day)).size;
  return { samples: n, independentDayClusters: days, minimumSamples, minimumDays, meanProbability,
    observedPositiveRate: observedRate, absoluteCalibrationGap: n ? Math.abs(meanProbability - observedRate) : null,
    brier, sameSampleBaseRateBrier: baselineBrier,
    brierSkillVsSameSampleBaseRate: baselineBrier > 0 ? 1 - brier / baselineBrier : null,
    status: n < minimumSamples || days < minimumDays ? 'insufficient_evidence' : 'descriptive_only',
    method: 'Brier and forecast-vs-observed summaries on stored prediction-time probabilities; same-sample base-rate comparator is descriptive, not a calibration certification or independent strategy holdout.' };
}

export function segmentProbabilityEvidence(rows = [], options = {}) {
  return ['horizonKey', 'assetClass', 'regimeKey'].flatMap((dimension) => {
    const keys = [...new Set(rows.map((row) => String(row[dimension] || 'unknown')))];
    return keys.map((key) => ({ dimension, key,
      ...summarizeProbabilityEvidence(rows.filter((row) => String(row[dimension] || 'unknown') === key), options) }));
  });
}

export function formatEdgeEvidence(evidence) {
  if (!evidence || !evidence.samples) return 'Collecting only: no eligible realized net outcomes; no estimated edge.';
  const interval = evidence.lower95R === null ? 'interval unavailable' : `approx. 95% range ${evidence.lower95R.toFixed(2)} to ${evidence.upper95R.toFixed(2)}R`;
  return `${evidence.status.replaceAll('_', ' ')} | ${evidence.samples} outcomes / ${evidence.independentDayClusters} UTC days | mean ${evidence.expectancyR.toFixed(2)}R | ${interval}`;
}
