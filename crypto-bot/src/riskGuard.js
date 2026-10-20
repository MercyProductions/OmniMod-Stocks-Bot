import { paths, readJson, writeJson } from './storage.js';

import { numericValue, summarizeEdgeEvidence, segmentEdgeEvidence, summarizeProbabilityEvidence, segmentProbabilityEvidence } from './edgeEvidence.js';

const CLOSED = new Set(['loss', 'fell_short', 'target_hit', 'exceeded']);
const ACTIVE = new Set(['tracking', 'target_tracking']);
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, numericValue(value) ?? fallback));
function probability(row) {
  const direct = numericValue(row.probability);
  const confidence = numericValue(row.confidence);
  const value = direct ?? (confidence === null ? null : confidence / 100);
  return value !== null && value >= 0 && value <= 1 ? value : null;
}
function drawdown(results) {
  let equity = 0, peak = 0, maximum = 0;
  for (const value of results) { equity += value; peak = Math.max(peak, equity); maximum = Math.max(maximum, peak - equity); }
  return maximum;
}

export function calculateGuardMetrics(predictions = [], settings = {}, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - bounded(settings.guardLookbackHours, 168, 24, 720) * 3_600_000;
  const closedAll = predictions.filter((row) => CLOSED.has(row.status))
    .filter((row) => {
      const time = Date.parse(row.completedAt);
      return Number.isFinite(time) && time >= cutoff && time <= nowMs;
    });
  const eligible = closedAll.filter((row) => numericValue(row.realizedR) !== null)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const closed = eligible.slice(-bounded(settings.guardRollingWindow, 30, 10, 200));
  const results = closed.map((row) => Number(row.realizedR));
  const calibrated = closed.filter((row) => row.accountingVersion >= 2 && probability(row) !== null);
  const probabilityRows = calibrated.map((row) => ({ ...row, probability: probability(row) }));
  const probabilityEvidence = summarizeProbabilityEvidence(probabilityRows, { now });
  const probabilitySegments = segmentProbabilityEvidence(probabilityRows, { now });
  const probabilitySamples = probabilityEvidence.samples;
  const brier = probabilityEvidence.brier;
  const averageProbability = probabilityEvidence.meanProbability;
  const calibratedWinRate = probabilityEvidence.observedPositiveRate;
  const evidenceRows = closed.filter((row) => row.accountingVersion >= 2);
  const evidenceOptions = { minimumSamples: settings.guardMinOutcomes, now };
  const daily = eligible.filter((row) => Date.parse(row.completedAt) >= nowMs - 24 * 3_600_000);
  const active = predictions.filter((row) => ACTIVE.has(row.status));
  const defaultRisk = bounded(settings.accountRiskPct, .5, .1, 1);
  return {
    samples: closed.length, missingResults: closedAll.length - eligible.length,
    expectancyR: results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : null,
    maxDrawdownR: drawdown(results), hardDrawdownR: drawdown(eligible.map((row) => Number(row.realizedR))),
    dailyLossR: -daily.reduce((sum, row) => sum + Math.min(0, Number(row.realizedR)), 0),
    activeCount: active.length, openRiskPct: active.reduce((sum, row) => sum + bounded(row.accountRiskPct, defaultRisk, .1, 100), 0),
    probabilitySamples, brier, averageProbability, calibratedWinRate,
    probabilityEvidence, probabilitySegments,
    winRate: results.length ? results.filter((value) => value > 0).length / results.length : null,
    calibrationDrift: calibrated.length ? Math.abs(averageProbability - calibratedWinRate) : null,
    providerConflictRate: closed.length ? closed.filter((row) => row.dataConflict || Number(row.priceDispersionPct) > .8).length / closed.length : null,
    evidence: summarizeEdgeEvidence(evidenceRows, evidenceOptions), segments: segmentEdgeEvidence(evidenceRows, evidenceOptions)
  };
}

export function evaluateRiskGuard(predictions = [], settings = {}, state = {}, now = new Date()) {
  const metrics = calculateGuardMetrics(predictions, settings, now);
  const minimum = bounded(settings.guardMinOutcomes, 20, 10, 100);
  const reasons = [];
  const hardReasons = [];
  if (state.manualPaused) reasons.push(`Manually paused${state.pauseReason ? `: ${state.pauseReason}` : '.'}`);
  if (metrics.hardDrawdownR >= bounded(settings.guardMaxDrawdownR, 5, 1, 25)) hardReasons.push(`Lookback drawdown ${metrics.hardDrawdownR.toFixed(2)}R reached the hard limit.`);
  if (metrics.dailyLossR >= bounded(settings.guardMaxDailyLossR, 3, .5, 25)) hardReasons.push(`Trailing 24h gross losses ${metrics.dailyLossR.toFixed(2)}R reached the hard limit.`);
  if (metrics.activeCount >= bounded(settings.maxConcurrentSignals, 3, 1, 12)) hardReasons.push('Concurrent paper-position limit reached.');
  if (metrics.openRiskPct >= bounded(settings.maxOpenRiskPct, 1.5, .1, 10)) hardReasons.push(`Open planned risk ${metrics.openRiskPct.toFixed(2)}% reached the portfolio cap.`);
  if (metrics.samples >= minimum) {
    if (metrics.expectancyR <= bounded(settings.guardMinExpectancyR, 0, -.5, .5)) reasons.push(`Rolling expectancy ${metrics.expectancyR.toFixed(2)}R is below the required edge.`);
    if (metrics.providerConflictRate >= .25) reasons.push('Provider-conflict rate is abnormally high.');
  }
  if (metrics.probabilitySamples >= minimum) {
    if (metrics.brier >= bounded(settings.guardMaxBrier, .28, .15, .5)) reasons.push(`Probability Brier score ${metrics.brier.toFixed(3)} exceeded the drift limit.`);
    if (metrics.calibrationDrift >= .2) reasons.push(`Predicted and realized win rates diverged by ${(metrics.calibrationDrift * 100).toFixed(1)} points.`);
  }
  reasons.unshift(...hardReasons);
  return {
    allowNewSignals: reasons.length === 0, paused: reasons.length > 0, reasons, hardReasons, metrics,
    evidenceStatus: metrics.evidence.status,
    operatingMode: reasons.length ? 'collect_only_paused' : metrics.evidence.status === 'positive_estimate' ? 'paper_with_positive_evidence' : 'paper_collecting_evidence',
    evaluatedAt: new Date(now).toISOString(), manualPaused: Boolean(state.manualPaused),
    pauseReason: String(state.pauseReason || ''), minimumOutcomes: minimum
  };
}

export async function getRiskGuard(guildId, predictions = [], settings = {}, now = new Date()) {
  const state = await readJson(paths.guardState(guildId), {});
  const guard = evaluateRiskGuard(predictions, settings, state, now);
  await writeJson(paths.guardState(guildId), { ...state, ...guard });
  return guard;
}

export async function setRiskGuardPause(guildId, paused, reason = '') {
  const current = await readJson(paths.guardState(guildId), {});
  const next = {
    ...current, manualPaused: Boolean(paused), pauseReason: paused ? String(reason || 'Paused by an administrator.') : '',
    manualChangedAt: new Date().toISOString()
  };
  await writeJson(paths.guardState(guildId), next);
  return next;
}
