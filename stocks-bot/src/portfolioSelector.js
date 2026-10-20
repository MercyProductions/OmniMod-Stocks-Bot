import { config } from './config.js';
import { localDateKey } from './time.js';
import { buildPrediction } from './predictionEngine.js';

const finite = (v, fallback = null) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TERMINAL = new Set(['loss', 'fell_short', 'target_hit', 'exceeded']);
const isActive = (r) => !TERMINAL.has(r.status) && r.status !== 'not_filled';
const riskSize = (r) => clamp(finite(r.paperRiskMultiplier, 1), 0.1, 1);
function dayAt(timestamp, fallback = '') {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? localDateKey(new Date(ms), config.marketTimezone) : fallback;
}
function returnsByInterval(asset) {
  if (Array.isArray(asset.correlationSeries)) {
    const rows = asset.correlationSeries
      .filter((r) => Array.isArray(r) && finite(r[0]) !== null && finite(r[1]) !== null)
      .sort((a, b) => a[0] - b[0]);
    const gaps = rows
      .slice(1)
      .map((r, i) => r[0] - rows[i][0])
      .filter((v) => v > 0);
    if (!gaps.length) return new Map();
    const interval = Math.min(...gaps);
    return new Map(rows.map((r) => [`${finite(r[2], r[0] - interval)}:${r[0]}`, Number(r[1])]));
  }
  const bars = [...(asset.recentBars || [])].sort((a, b) => a.timestamp - b.timestamp).slice(-100);
  const values = new Map();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1],
      b = bars[i];
    if (finite(a.close, 0) > 0 && finite(b.close, 0) > 0 && b.timestamp > a.timestamp && b.timestamp - a.timestamp <= 900)
      values.set(`${a.timestamp}:${b.timestamp}`, Math.log(b.close / a.close));
  }
  return values;
}
export function correlationEvidence(left, right) {
  const a = returnsByInterval(left),
    b = returnsByInterval(right);
  const keys = [...a.keys()].filter((k) => b.has(k));
  if (keys.length < 12) return { correlation: null, samples: keys.length, reason: 'fewer than 12 matching return intervals' };
  const av = keys.map((k) => a.get(k)),
    bv = keys.map((k) => b.get(k));
  const am = av.reduce((s, v) => s + v, 0) / av.length,
    bm = bv.reduce((s, v) => s + v, 0) / bv.length;
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < av.length; i++) {
    const x = av[i] - am,
      y = bv[i] - bm;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0
    ? { correlation: clamp(ab / Math.sqrt(aa * bb), -1, 1), samples: keys.length, reason: '' }
    : { correlation: null, samples: keys.length, reason: 'constant return series' };
}
export function returnCorrelation(a, b) {
  return correlationEvidence(a, b).correlation;
}
function circuitBreaker(predictions, dateKey, settings) {
  const closed = predictions.filter((r) => TERMINAL.has(r.status) && finite(r.realizedR) !== null);
  const dailyR = closed
    .filter((r) => dayAt(r.completedAt || r.updatedAt, r.dateKey) === dateKey)
    .reduce((s, r) => s + Number(r.realizedR) * riskSize(r), 0);
  let consecutiveLosses = 0;
  for (const r of [...closed].sort((a, b) =>
    String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)),
  )) {
    if (Number(r.realizedR) < 0) consecutiveLosses++;
    else break;
  }
  const invalidOutcomes = predictions.filter(
    (r) =>
      r.accountingVersion === 2 &&
      TERMINAL.has(r.status) &&
      (finite(r.realizedR) === null || !Number.isFinite(Date.parse(r.completedAt))),
  ).length;
  const reason = invalidOutcomes
    ? `${invalidOutcomes} outcome(s) need repair before adding exposure.`
    : dailyR <= -finite(settings.dailyLossLimitR, 3)
      ? `Daily paper loss limit reached (${dailyR.toFixed(2)} risk units realized today).`
      : consecutiveLosses >= finite(settings.consecutiveLossLimit, 3)
        ? `${consecutiveLosses} consecutive paper losses triggered the circuit breaker.`
        : '';
  return {
    triggered: Boolean(reason),
    dailyR,
    consecutiveLosses,
    invalidOutcomes,
    dateKey,
    timezone: config.marketTimezone,
    reason,
  };
}
export function executionEvidence(asset, settings = {}, now = new Date()) {
  const bid = finite(asset.bidPrice, 0),
    ask = finite(asset.askPrice, 0),
    age = (now - Date.parse(asset.quoteUpdatedAt)) / 1000;
  const valid = bid > 0 && ask >= bid && Number.isFinite(age) && age >= -5 && age <= 60;
  const spreadBps = valid ? ((ask - bid) / ((ask + bid) / 2)) * 10000 : null;
  const reason = asset.halted
    ? 'Trading halt.'
    : asset.freshness === 'stale'
      ? 'Stale chart data.'
      : !valid
        ? 'Need a valid bid/ask quote timestamped within 60 seconds.'
        : spreadBps > finite(settings.maxSpreadBps, 35)
          ? `Executable spread ${spreadBps.toFixed(1)} bps exceeds the limit.`
          : '';
  const expectedR = asset.ensemble?.active ? finite(asset.ensemble.expectedR) : null;
  const conservativeExpectedR = asset.ensemble?.active ? finite(asset.ensemble.conservativeExpectedR) : null;
  const stopPct = valid ? buildPrediction(asset, settings, 'execution-check', now).stopPct : null;
  // EV is already after modeled costs. Charge the current spread AGAIN plus an
  // adverse-cost reserve as a conservative robustness check, not a cost forecast.
  const costReserveBps = spreadBps === null ? null : spreadBps + finite(settings.executionStressBps, 10);
  const costReserveR = stopPct > 0 && costReserveBps !== null ? costReserveBps / 100 / stopPct : null;
  return {
    ready: !reason,
    reason,
    quoteAgeSeconds: Number.isFinite(age) ? age : null,
    spreadBps,
    expectedR,
    conservativeExpectedR,
    stopPct,
    costReserveBps,
    costReserveR,
    stressedExpectedR: conservativeExpectedR !== null && costReserveR !== null ? conservativeExpectedR - costReserveR : null,
  };
}
export function selectPortfolioCandidates(candidates = [], predictions = [], settings = {}, dateKey = '', options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const day = dateKey || localDateKey(now, config.marketTimezone),
    breaker = circuitBreaker(predictions, day, settings);
  const active = predictions.filter(isActive),
    maxOpenPositions = Math.max(1, finite(settings.maxOpenPositions, 3)),
    maxOpenRiskR = Math.max(0.1, finite(settings.maxOpenRiskR, 2));
  const dailyEntries = predictions.filter((r) => dayAt(r.createdAt, r.dateKey) === day).length,
    dailyLimit = Math.max(1, finite(settings.maxSignals, 5));
  let openRiskR = active.reduce((s, r) => s + riskSize(r), 0);
  const initialOpenRiskR = openRiskR;
  const selected = [],
    rejected = [],
    correlations = [],
    sectorCounts = new Map();
  for (const r of active) sectorCounts.set(r.sector || 'unknown', (sectorCounts.get(r.sector || 'unknown') || 0) + 1);
  const ranked = candidates
    .map((asset) => ({ asset, execution: executionEvidence(asset, settings, now) }))
    .sort(
      (a, b) =>
        (b.execution.stressedExpectedR ?? -Infinity) - (a.execution.stressedExpectedR ?? -Infinity) ||
        finite(b.asset.model?.score, 0) - finite(a.asset.model?.score, 0),
    );
  for (const { asset, execution } of ranked) {
    const reject = (reason) => rejected.push({ symbol: asset.symbol, reason, execution });
    if (breaker.triggered) {
      reject(breaker.reason);
      continue;
    }
    if ([...active, ...selected].some((r) => r.symbol === asset.symbol)) {
      reject('Symbol already has an active or selected paper setup.');
      continue;
    }
    if (active.length + selected.length >= maxOpenPositions) {
      reject(`Open-position limit (${maxOpenPositions}) reached, including pending entries.`);
      continue;
    }
    if (dailyEntries + selected.length >= dailyLimit) {
      reject(`Daily entry limit (${dailyLimit}) reached.`);
      continue;
    }
    if (!execution.ready) {
      reject(execution.reason);
      continue;
    }
    const ruleOnly = asset.ensemble?.decision === 'RULE_ONLY' && settings.allowRuleOnlySignals === true;
    if (
      !ruleOnly &&
      (asset.ensemble?.decision !== 'BUY' || execution.expectedR === null || execution.stressedExpectedR === null)
    ) {
      reject('No validated BUY decision with finite expectancy and a conservative estimate.');
      continue;
    }
    if (!ruleOnly && execution.stressedExpectedR < Math.max(0, finite(settings.minPortfolioExpectedR, 0.05))) {
      reject(
        `After spread/cost stress, conservative edge is ${execution.stressedExpectedR.toFixed(2)}R; below the required threshold.`,
      );
      continue;
    }
    const sector = asset.sector || 'unknown';
    if ((sectorCounts.get(sector) || 0) >= finite(settings.maxSectorSignals, 2)) {
      reject(`Sector exposure limit reached for ${sector}.`);
      continue;
    }
    let blocked = '';
    for (const chosen of [...active, ...selected]) {
      const evidence = correlationEvidence(asset, chosen);
      correlations.push({ left: asset.symbol, right: chosen.symbol, ...evidence, active: active.includes(chosen) });
      if (evidence.correlation === null) {
        blocked = `Unknown correlation with ${chosen.symbol}: ${evidence.reason}.`;
        break;
      }
      if (evidence.correlation >= finite(settings.maxPairCorrelation, 0.85)) {
        blocked = `${evidence.correlation.toFixed(2)} return correlation with selected ${chosen.symbol}.`;
        break;
      }
    }
    if (blocked) {
      reject(blocked);
      continue;
    }
    const width =
      finite(asset.ensemble?.probabilityHigh) !== null && finite(asset.ensemble?.probabilityLow) !== null
        ? Math.max(0, asset.ensemble.probabilityHigh - asset.ensemble.probabilityLow)
        : 100;
    const multiplier = ruleOnly ? 0.25 : clamp(1 - width / 100, 0.25, 1) * clamp(1 - finite(asset.macroStress, 0) / 150, 0.35, 1);
    if (openRiskR + multiplier > maxOpenRiskR + 1e-9) {
      reject(`Aggregate planned risk would exceed ${maxOpenRiskR.toFixed(2)} paper risk units.`);
      continue;
    }
    selected.push({
      ...asset,
      portfolioExpectedR: execution.expectedR,
      portfolioUtilityR: execution.stressedExpectedR,
      executionEvidence: execution,
      paperRiskMultiplier: multiplier,
      selectionEvidence: ruleOnly
        ? 'Unvalidated rule-only research; expected return unknown.'
        : 'Validated model, current quote and conservative cost stress passed.',
    });
    openRiskR += multiplier;
    sectorCounts.set(sector, (sectorCounts.get(sector) || 0) + 1);
  }
  return {
    selected,
    rejected,
    breaker,
    correlations,
    exposure: {
      activePositions: active.length,
      selectedPositions: selected.length,
      maxOpenPositions,
      initialOpenRiskR,
      projectedOpenRiskR: openRiskR,
      maxOpenRiskR,
      dailyEntries,
      dailyLimit,
    },
    readiness: {
      executableCandidates: ranked.filter((r) => r.execution.ready).length,
      candidates: candidates.length,
      unknownCorrelations: correlations.filter((r) => r.correlation === null).length,
      selected: selected.length,
      blocked: rejected.length,
      collectionContinues: true,
    },
  };
}
export function portfolioReadinessText(p) {
  if (!p?.exposure) return 'No portfolio scan yet. Research collection continues.';
  const e = p.exposure;
  const lines = [
    `${e.selectedPositions} selected | ${e.activePositions}/${e.maxOpenPositions} already open | planned risk ${e.projectedOpenRiskR.toFixed(2)}/${e.maxOpenRiskR.toFixed(2)} units`,
    `${e.dailyEntries}/${e.dailyLimit} entries today (Eastern); ${p.readiness?.executableCandidates || 0} candidate(s) with current executable quotes.`,
  ];
  for (const r of (p.rejected || []).slice(0, 3)) lines.push(`${r.symbol}: ${r.reason}`);
  if (!e.selectedPositions) lines.push('No new exposure approved; research collection continues.');
  return lines.join('\n').slice(0, 1024);
}
