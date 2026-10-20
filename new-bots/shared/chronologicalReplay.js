import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, reservePaperCandidate, summarizePaperLedger } from './paperRisk.js';
import { executionCostsAt, validateExecutionCostSchedule } from './executionCostSchedule.js';
import { bootstrapSessionExpectancy } from './dayClusterBootstrap.js';

const timeOf = (value) => Date.parse(value);
const REGIME_KEYS = new Set(['risk_on', 'mixed', 'sideways', 'risk_off', 'high_volatility', 'low_volatility', 'unknown']);
const POINT_IN_TIME_KEYS = new Set(['asOf', 'observedAt', 'observationAt', 'updatedAt', 'reviewedAt', 'publishedAt',
  'receivedAt', 'timestamp', 'time', 'completedAt', 'quoteTime', 'sourceTime', 'providerTime']);

function stableSeed(text) {
  let hash = 2_166_136_261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return hash;
}

function futureContextTimestamp(value, cutoff, path = 'context', seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 64 || seen.has(value)) return null;
  seen.add(value);
  const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child]) : Object.entries(value);
  for (const [key, child] of entries) {
    const childPath = `${path}.${key}`;
    if (POINT_IN_TIME_KEYS.has(key) && typeof child === 'string') {
      const timestamp = Date.parse(child);
      if (Number.isFinite(timestamp) && timestamp > cutoff) return childPath;
    }
    if (child && typeof child === 'object') {
      const future = futureContextTimestamp(child, cutoff, childPath, seen, depth + 1);
      if (future) return future;
    }
  }
  return null;
}

function normalizeRegime(context) {
  const raw = String(context?.regimeKey ?? context?.marketRegime ?? context?.regime?.key ?? '').trim().toLowerCase()
    .replace(/[\s-]+/g, '_');
  return REGIME_KEYS.has(raw) ? raw : 'unknown';
}

function sessionDateOf(observation) {
  const context = observation?.context;
  const value = observation?.sessionDate ?? observation?.marketDate ?? context?.sessionDate
    ?? context?.signal?.sessionDate ?? context?.session?.marketDate;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function tailRisk(rows) {
  const returnsR = rows.filter((order) => Number(order.riskUsd) > 0 && Number.isFinite(Number(order.realizedPnlUsd)))
    .map((order) => Number(order.realizedPnlUsd) / Number(order.riskUsd)).sort((a, b) => a - b);
  if (!returnsR.length) return { sampleCount: 0, tailSampleCount: 0, expectedShortfall95R: null, fifthPercentileR: null, tailRiskConfidence: 'no valid risk-normalized outcomes' };
  const tailSampleCount = Math.max(1, Math.ceil(returnsR.length * 0.05));
  const tail = returnsR.slice(0, tailSampleCount);
  return {
    sampleCount: returnsR.length,
    tailSampleCount,
    expectedShortfall95R: Number((tail.reduce((sum, value) => sum + value, 0) / tail.length).toFixed(3)),
    fifthPercentileR: Number(returnsR[Math.max(0, Math.ceil(returnsR.length * 0.05) - 1)].toFixed(3)),
    tailRiskConfidence: returnsR.length < 30 ? 'descriptive only; fewer than 30 closed trades' : 'descriptive; validate on untouched holdout',
  };
}

function intervalSummary(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return { sampleCount: 0, medianMs: null, p95Ms: null, maxMs: null };
  const percentile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { sampleCount: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) };
}

function exposureStats(rows, throughTime) {
  const fills = rows.filter((order) => Number.isFinite(Date.parse(order.filledAt))
    && Number(order.notionalUsd) >= 0).map((order) => ({
    start: Date.parse(order.filledAt),
    end: Number.isFinite(Date.parse(order.closedAt)) ? Date.parse(order.closedAt) : throughTime,
    notional: Math.max(0, Number(order.notionalUsd) || 0),
  })).filter((order) => order.end >= order.start);
  const events = fills.flatMap((order) => [
    { at: order.start, delta: order.notional, order: 1 },
    { at: order.end, delta: -order.notional, order: 0 },
  ]).sort((a, b) => a.at - b.at || a.order - b.order);
  let open = 0, maximum = 0;
  for (const event of events) { open += event.delta; maximum = Math.max(maximum, open); }
  const closed = rows.filter((order) => Number.isFinite(Date.parse(order.filledAt)) && Number.isFinite(Date.parse(order.closedAt)));
  const holdingMinutes = closed.map((order) => (Date.parse(order.closedAt) - Date.parse(order.filledAt)) / 60_000);
  return {
    maxConcurrentExposureUsd: Number(maximum.toFixed(2)),
    turnoverNotionalUsd: Number(fills.reduce((sum, order) => sum + order.notional * 2, 0).toFixed(2)),
    averageHoldingMinutes: holdingMinutes.length ? Number((holdingMinutes.reduce((sum, value) => sum + value, 0) / holdingMinutes.length).toFixed(2)) : null,
    exposureSampleCount: fills.length,
    exposureMethodology: 'Peak concurrent gross filled notional; round-trip turnover counts entry plus exit notional. Reservations are excluded from filled exposure.',
  };
}

function executionOutcomes(orders) {
  const reservations = orders;
  const filled = reservations.filter((order) => Number.isFinite(Date.parse(order.filledAt)));
  const closed = orders.filter((order) => order.status === 'closed');
  // A reservation still pending at the replay boundary is right-censored, not a
  // failed fill. Only count unfilled attempts after the paper lifecycle terminates them.
  const unfilled = reservations.filter((order) => order.status === 'cancelled' && !Number.isFinite(Date.parse(order.filledAt)));
  const pendingEntries = reservations.filter((order) => order.status === 'reserved' && !Number.isFinite(Date.parse(order.filledAt)));
  const resolvedEntryAttempts = filled.length + unfilled.length;
  const target1Hits = closed.filter((order) => order.exitReason === 'target').length;
  const stopHits = closed.filter((order) => order.exitReason === 'stop').length;
  const timeExits = closed.filter((order) => order.exitReason === 'time_exit').length;
  const emergencyExits = closed.filter((order) => order.exitReason === 'emergency_stop').length;
  const riskNormalizedReturns = closed.filter((order) => Number(order.riskUsd) > 0)
    .map((order) => Number(order.realizedPnlUsd) / Number(order.riskUsd));
  const pct = (count, denominator) => denominator ? Number((count / denominator * 100).toFixed(2)) : null;
  return {
    reservationCount: reservations.length,
    fillCount: filled.length,
    resolvedEntryAttempts,
    pendingEntryCount: pendingEntries.length,
    reservationFillRatePct: pct(filled.length, resolvedEntryAttempts),
    unfilledCount: unfilled.length,
    notFilledRatePct: pct(unfilled.length, resolvedEntryAttempts),
    closedTradeCount: closed.length,
    target1Hits,
    target1HitRatePct: pct(target1Hits, closed.length),
    target2Hits: null,
    target2HitRatePct: null,
    target2Status: 'not defined by the current single-target strategies',
    stopHits,
    stopRatePct: pct(stopHits, closed.length),
    timeExits,
    emergencyExits,
    averageNetReturnR: riskNormalizedReturns.length
      ? Number((riskNormalizedReturns.reduce((sum, value) => sum + value, 0) / riskNormalizedReturns.length).toFixed(3)) : null,
    returnSampleCount: riskNormalizedReturns.length,
  };
}

function summarizeRegimeTrades(rows) {
  const wins = rows.filter((order) => Number(order.realizedPnlUsd) > 0);
  const losses = rows.filter((order) => Number(order.realizedPnlUsd) < 0);
  const net = rows.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0);
  const grossWins = wins.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0);
  const grossLosses = Math.abs(losses.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0));
  const curve = [...rows].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  let cumulative = 0, peak = 0, maxDrawdown = 0;
  for (const order of curve) {
    cumulative += Number(order.realizedPnlUsd);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const average = (sample) => sample.length
    ? Number((sample.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0) / sample.length).toFixed(2)) : null;
  const excursions = rows.filter((order) => order.maxFavorableExcursionUsd != null && order.maxAdverseExcursionUsd != null);
  return {
    closedTrades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length ? Number((wins.length / rows.length * 100).toFixed(2)) : null,
    netPnlUsd: Number(net.toFixed(2)),
    expectancyUsd: rows.length ? Number((net / rows.length).toFixed(2)) : null,
    averageWinUsd: average(wins),
    averageLossUsd: average(losses),
    profitFactor: grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(3)) : null,
    maxDrawdownUsd: Number(maxDrawdown.toFixed(2)),
    excursionSampleCount: excursions.length,
    averageMaxFavorableExcursionUsd: excursions.length
      ? Number((excursions.reduce((sum, order) => sum + Number(order.maxFavorableExcursionUsd), 0) / excursions.length).toFixed(2)) : null,
    averageMaxAdverseExcursionUsd: excursions.length
      ? Number((excursions.reduce((sum, order) => sum + Number(order.maxAdverseExcursionUsd), 0) / excursions.length).toFixed(2)) : null,
    ...tailRisk(rows),
    ...exposureStats(rows, Math.max(0, ...rows.map((order) => Date.parse(order.closedAt) || 0))),
  };
}

function performanceByExitReason(rows = []) {
  const grouped = new Map();
  for (const order of rows) {
    const reason = String(order.exitReason || 'unknown');
    if (!grouped.has(reason)) grouped.set(reason, []);
    grouped.get(reason).push(order);
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, trades]) => {
    const returnsR = trades.filter((order) => Number(order.riskUsd) > 0 && Number.isFinite(Number(order.realizedPnlUsd)))
      .map((order) => Number(order.realizedPnlUsd) / Number(order.riskUsd));
    return [reason, {
      ...summarizeRegimeTrades(trades),
      riskNormalizedSampleCount: returnsR.length,
      netR: returnsR.length ? Number(returnsR.reduce((sum, value) => sum + value, 0).toFixed(3)) : null,
      expectancyR: returnsR.length ? Number((returnsR.reduce((sum, value) => sum + value, 0) / returnsR.length).toFixed(3)) : null,
    }];
  }));
}

function validateInput({ owner, assetClass, instrumentKey, strategyId, observations, bars, evaluate, scoreFrom, scoreThrough }) {
  if (!['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'].includes(owner)) throw new Error('Unknown primary bot owner.');
  if (!['stock', 'crypto', 'forex', 'future', 'option', 'etf', 'etp'].includes(assetClass)) throw new Error('Unsupported replay asset class.');
  if (!instrumentKey || !strategyId || typeof evaluate !== 'function') throw new Error('Instrument, strategy id, and evaluator are required.');
  if (!Array.isArray(observations) || !observations.length || !Array.isArray(bars)) throw new Error('Chronological observations and bars are required.');
  let previous = -Infinity, previousQuote = -Infinity;
  for (const row of observations) {
    const at = timeOf(row?.asOf);
    if (!Number.isFinite(at) || at <= previous) throw new Error('Observation timestamps must be valid, unique, and strictly increasing.');
    previous = at;
    const quoteAt = timeOf(row.quote?.time);
    if (!Number.isFinite(quoteAt) || quoteAt > at || quoteAt <= previousQuote) throw new Error('Replay quotes must be valid and chronological, no later than their decision timestamp; future-dated quotes are rejected.');
    previousQuote = quoteAt;
  }
  previous = -Infinity;
  for (const bar of bars) {
    const completed = timeOf(bar?.completedAt);
    if (!Number.isFinite(completed) || completed <= previous) throw new Error('Bars must have strictly increasing completedAt timestamps.');
    previous = completed;
  }
  const start = scoreFrom == null ? -Infinity : timeOf(scoreFrom);
  if (scoreFrom != null && !Number.isFinite(start)) throw new Error('scoreFrom must be a valid timestamp.');
  const end = scoreThrough == null ? Infinity : timeOf(scoreThrough);
  if (scoreThrough != null && (!Number.isFinite(end) || end < start)) throw new Error('scoreThrough must be a valid timestamp no earlier than scoreFrom.');
  if (start > timeOf(observations.at(-1).asOf) || end < timeOf(observations[0].asOf))
    throw new Error('Scoring window contains no observations.');
  return { scoreFromMs: start, scoringEndMs: end };
}

/**
 * Replay one fixed strategy/instrument through supplied point-in-time observations.
 * No market data is downloaded and no parameter fitting is performed here.
 * Candidate creation uses the live paper risk gate; fills/exits use later executable quotes.
 */
export async function replayChronologicalPaper({
  owner, assetClass, instrumentKey, exposureKey = instrumentKey, strategyId,
  observations, bars, evaluate, scoreFrom = null, scoreThrough = null, accountEquityUsd,
  policy = {}, now = Date.now(), executionCostSchedule,
}) {
  const { scoreFromMs, scoringEndMs } = validateInput({ owner, assetClass, instrumentKey, strategyId, observations, bars, evaluate, scoreFrom, scoreThrough });
  if (!(Number(accountEquityUsd) > 0)) throw new Error('Positive paper equity is required for replay risk sizing.');
  const usesCostSchedule = executionCostSchedule !== undefined && executionCostSchedule !== null;
  const validatedCostSchedule = usesCostSchedule ? validateExecutionCostSchedule(executionCostSchedule) : null;
  const replayThroughMs = timeOf(observations.at(-1).asOf);
  const eligibleBars = bars.filter((bar) => timeOf(bar.completedAt) <= replayThroughMs);
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-chronological-replay-'));
  const statePath = join(dir, 'ledger.json');
  const rejections = new Map();
  const decisions = [];
  const regimeByOrderId = new Map();
  const sessionByOrderId = new Map();
  const activityByRegime = new Map();
  const sessionsByRegime = new Map();
  const activityFor = (regime) => {
    if (!activityByRegime.has(regime)) activityByRegime.set(regime, {
      scoredObservations: 0, noSetup: 0, candidates: 0, identityRejected: 0,
      riskRejected: 0, reservationsCreated: 0, rejectionReasons: {}, observationsMissingSessionDate: 0,
    });
    return activityByRegime.get(regime);
  };
  let candidatesConsidered = 0, reservationsCreated = 0, marksProcessed = 0, futureDatedContextObservations = 0;
  let appliedCostScheduleCandidates = 0, costScheduleGapObservations = 0;
  const quoteIntervalsMs = [];
  const openPositionMarkIntervalsMs = [];
  let previousObservationQuoteTime = -Infinity;
  try {
    for (const observation of observations) {
      const asOf = timeOf(observation.asOf);
      const quote = structuredClone(observation.quote);
      const quoteAt = timeOf(quote.time);
      if (Number.isFinite(previousObservationQuoteTime) && quoteAt > previousObservationQuoteTime)
        quoteIntervalsMs.push(quoteAt - previousObservationQuoteTime);
      previousObservationQuoteTime = quoteAt;
      const ledgerBeforeMark = await readPaperRiskLedger({ statePath });
      for (const order of ledgerBeforeMark.orders.filter((row) => ['reserved', 'filled', 'open'].includes(row.status))) {
        const lastMarkAt = timeOf(order.lastProcessedQuoteTime ?? order.filledAt);
        const result = await processPaperQuote(order.orderId, quote, {
          statePath, now: asOf, maxQuoteAgeMs: policy.maxQuoteAgeMs ?? 60_000,
          maxSpreadPct: policy.maxSpreadPct ?? 100, sessionOpen: observation.sessionOpen !== false,
          emergencyStop: false,
        });
        if (['filled', 'open'].includes(order.status) && ['open', 'closed'].includes(result.status)
          && Number.isFinite(lastMarkAt) && quoteAt > lastMarkAt) openPositionMarkIntervalsMs.push(quoteAt - lastMarkAt);
        if (['filled', 'open', 'closed', 'cancelled'].includes(result.status)) marksProcessed += 1;
      }
      if (asOf < scoreFromMs || asOf > scoringEndMs) continue;
      const futureContextPath = futureContextTimestamp(observation.context, asOf);
      if (futureContextPath) {
        const reason = 'future_dated_context_observation';
        futureDatedContextObservations += 1;
        const activity = activityFor('unknown');
        activity.scoredObservations += 1;
        activity.noSetup += 1;
        if (!sessionDateOf(observation)) activity.observationsMissingSessionDate += 1;
        activity.rejectionReasons[reason] = (activity.rejectionReasons[reason] || 0) + 1;
        rejections.set(reason, (rejections.get(reason) || 0) + 1);
        decisions.push({ at: new Date(asOf).toISOString(), status: 'no-setup', reasons: [reason], field: futureContextPath });
        continue;
      }
      const regime = normalizeRegime(observation.context);
      const activity = activityFor(regime);
      activity.scoredObservations += 1;
      const observedSessionDate = sessionDateOf(observation);
      if (observedSessionDate) {
        if (!sessionsByRegime.has(regime)) sessionsByRegime.set(regime, new Set());
        sessionsByRegime.get(regime).add(observedSessionDate);
      } else activity.observationsMissingSessionDate += 1;
      const executionCosts = usesCostSchedule ? executionCostsAt(validatedCostSchedule, asOf) : null;
      if (usesCostSchedule && !executionCosts) {
        const reason = 'execution_cost_schedule_unavailable';
        costScheduleGapObservations += 1;
        activity.noSetup += 1;
        rejections.set(reason, (rejections.get(reason) || 0) + 1);
        activity.rejectionReasons[reason] = (activity.rejectionReasons[reason] || 0) + 1;
        decisions.push({ at: new Date(asOf).toISOString(), status: 'no-setup', reasons: [reason] });
        continue;
      }
      const visibleBars = bars.filter((bar) => timeOf(bar.completedAt) <= asOf).map((bar) => structuredClone(bar));
      const proposed = await evaluate({ asOf: new Date(asOf).toISOString(), quote, bars: visibleBars,
        context: structuredClone(observation.context ?? null), sessionOpen: observation.sessionOpen !== false,
        executionCosts: executionCosts ? structuredClone(executionCosts) : null });
      let candidate = proposed?.candidate;
      if (proposed?.status !== 'candidate' || !candidate) {
        activity.noSetup += 1;
        for (const reason of proposed?.reasons || []) {
          rejections.set(reason, (rejections.get(reason) || 0) + 1);
          activity.rejectionReasons[reason] = (activity.rejectionReasons[reason] || 0) + 1;
        }
        continue;
      }
      candidatesConsidered += 1;
      activity.candidates += 1;
      const candidateQuoteAt = timeOf(candidate.quoteTime);
      if (candidate.owner !== owner || candidate.assetClass !== assetClass || String(candidate.instrumentKey).toUpperCase() !== String(instrumentKey).toUpperCase()
        || candidate.strategyId !== strategyId || candidateQuoteAt !== quoteAt
        || Number(candidate.bid) !== Number(quote.bid) || Number(candidate.ask) !== Number(quote.ask)) {
        rejections.set('candidate_identity_or_quote_mismatch', (rejections.get('candidate_identity_or_quote_mismatch') || 0) + 1);
        activity.identityRejected += 1;
        activity.rejectionReasons.candidate_identity_or_quote_mismatch = (activity.rejectionReasons.candidate_identity_or_quote_mismatch || 0) + 1;
        decisions.push({ at: new Date(asOf).toISOString(), status: 'rejected', reasons: ['candidate_identity_or_quote_mismatch'] });
        continue;
      }
      if (executionCosts) {
        candidate = { ...candidate, roundTripFeesPerUnit: executionCosts.roundTripFeesPerUnit,
          slippageReservePerUnit: executionCosts.slippageReservePerUnit, executionCostContext: executionCosts };
        appliedCostScheduleCandidates += 1;
      }
      const current = await readPaperRiskLedger({ statePath });
      const summary = summarizePaperLedger(current, { accountEquity: accountEquityUsd, sessionDate: candidate.sessionDate, now: asOf });
      const decision = evaluatePaperCandidate(candidate, {
        accountEquity: Number(accountEquityUsd), realizedPnlToday: summary.realizedPnlRiskDayUtcUsd,
        openPositions: current.orders.filter((row) => ['reserved', 'filled', 'open'].includes(row.status)),
        closedOrders: current.orders.filter((row) => row.status === 'closed'),
      }, { ...policy, now: asOf, emergencyStop: false, liveTradingEnabled: false });
      if (decision.status !== 'paper-approved') {
        activity.riskRejected += 1;
        for (const reason of decision.reasons || []) {
          rejections.set(reason, (rejections.get(reason) || 0) + 1);
          activity.rejectionReasons[reason] = (activity.rejectionReasons[reason] || 0) + 1;
        }
        decisions.push({ at: new Date(asOf).toISOString(), status: 'risk-rejected', reasons: decision.reasons });
        continue;
      }
      const reserved = await reservePaperCandidate(candidate, decision, { statePath, now: asOf, emergencyStop: false });
      if (reserved.status === 'reserved') {
        reservationsCreated += 1;
        activity.reservationsCreated += 1;
        regimeByOrderId.set(reserved.order.orderId, normalizeRegime(observation.context));
        sessionByOrderId.set(reserved.order.orderId, sessionDateOf(observation) || reserved.order.sessionDate || null);
      }
      else {
        const reason = reserved.reason || reserved.status;
        rejections.set(reason, (rejections.get(reason) || 0) + 1);
        activity.rejectionReasons[reason] = (activity.rejectionReasons[reason] || 0) + 1;
      }
      decisions.push({ at: new Date(asOf).toISOString(), status: reserved.status, orderId: reserved.order?.orderId || null });
    }
    const ledger = await readPaperRiskLedger({ statePath });
    const performance = summarizePaperLedger(ledger, { accountEquity: accountEquityUsd, now: replayThroughMs });
    const closed = ledger.orders.filter((order) => order.status === 'closed');
    const closedByRegime = Object.groupBy
      ? Object.groupBy(closed, (order) => regimeByOrderId.get(order.orderId) || 'unknown')
      : closed.reduce((groups, order) => ((groups[regimeByOrderId.get(order.orderId) || 'unknown'] ||= []).push(order), groups), {});
    const performanceByRegime = Object.fromEntries([...new Set([...activityByRegime.keys(), ...Object.keys(closedByRegime)])].map((regime) => {
      const rows = closedByRegime[regime] || [];
      const closedTradeSessions = new Set(rows.map((order) => sessionByOrderId.get(order.orderId) || order.sessionDate).filter(Boolean));
      return [regime, { ...activityFor(regime), scoredSessions: sessionsByRegime.get(regime)?.size || null,
        closedTradeSessions: closedTradeSessions.size || null, closedTrades: rows.length,
        outcomes: rows.length ? summarizeRegimeTrades(rows) : null,
        outcomesByExitReason: performanceByExitReason(rows) }];
    }));
    const unresolved = ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
    const validScores = observations.filter((row) => timeOf(row.asOf) >= scoreFromMs && timeOf(row.asOf) <= scoringEndMs);
    const tail = tailRisk(closed);
    const exposure = exposureStats(ledger.orders, replayThroughMs);
    const outcomes = executionOutcomes(ledger.orders);
    const marketSessionBootstrap = bootstrapSessionExpectancy(closed, { seed: stableSeed(`${owner}:${strategyId}:${scoreFromMs}`) });
    return {
      schemaVersion: 1, mode: 'chronological-paper-replay', owner, assetClass, instrumentKey, strategyId,
      executionCostSchedule: { mode: usesCostSchedule ? 'time-bounded-source-cited' : 'candidate-configured',
        rowCount: validatedCostSchedule?.length ?? 0, appliedCandidates: appliedCostScheduleCandidates,
        observationsOutsideSchedule: costScheduleGapObservations },
      scoreFrom: scoreFrom == null ? null : new Date(scoreFromMs).toISOString(),
      scoreThrough: validScores.at(-1)?.asOf || null,
      resolutionThrough: observations.at(-1)?.asOf || null,
      observations: observations.length, scoredObservations: validScores.length,
      resolutionObservations: observations.filter((row) => timeOf(row.asOf) > scoringEndMs).length,
      quoteSampling: { observationIntervals: intervalSummary(quoteIntervalsMs), openPositionMarkIntervals: intervalSummary(openPositionMarkIntervalsMs),
        note: 'Open-position intervals count only executable quotes accepted by the paper lifecycle; neither metric establishes feed completeness or reveals unsampled intrabar movement.' },
      completedBars: eligibleBars.length, futureBarsExcluded: bars.length - eligibleBars.length,
      candidatesConsidered, reservationsCreated, marksProcessed, futureDatedContextObservations,
      closedTrades: closed.length, unresolvedOrders: unresolved.length,
      marketSessionBootstrap,
      unresolvedIds: unresolved.map((order) => order.orderId),
      cancelled: ledger.orders.filter((order) => order.status === 'cancelled').length,
      realizedNetPnlUsd: performance.netPnlUsd, expectancyUsd: performance.expectancyUsd,
      winRatePct: performance.winRatePct, profitFactor: performance.profitFactor,
      maxDrawdownUsd: performance.maxDrawdownUsd,
      averageMaxFavorableExcursionUsd: performance.averageMaxFavorableExcursionUsd,
      averageMaxAdverseExcursionUsd: performance.averageMaxAdverseExcursionUsd,
      excursionSampleCount: performance.excursionSampleCount,
      executionOutcomes: outcomes,
      ...tail,
      ...exposure,
      feesUsd: Number(closed.reduce((sum, order) => sum + Number(order.feesUsd || 0), 0).toFixed(2)),
      slippageReserveUsd: Number(closed.reduce((sum, order) => sum + Number(order.slippageUsd || 0), 0).toFixed(2)),
      topRejectionReasons: Object.fromEntries([...rejections].sort((a, b) => b[1] - a[1]).slice(0, 12)),
      performanceByExitReason: performanceByExitReason(closed),
      trades: closed.map((order) => ({ strategyId: order.strategyId, direction: order.direction, sessionDate: order.sessionDate,
        closedSessionDate: order.closedSessionDate, reservedAt: order.reservedAt,
        reservationToFillMs: Number.isFinite(Date.parse(order.reservedAt)) && Number.isFinite(Date.parse(order.filledAt))
          ? Date.parse(order.filledAt) - Date.parse(order.reservedAt) : null,
        openedAt: order.filledAt,
        regime: regimeByOrderId.get(order.orderId) || 'unknown',
        closedAt: order.closedAt, exitReason: order.exitReason, grossPnlUsd: order.grossPnlUsd, feesUsd: order.feesUsd,
        slippageUsd: order.slippageUsd, realizedPnlUsd: order.realizedPnlUsd, riskUsd: order.riskUsd,
        notionalUsd: order.notionalUsd,
        realizedR: Number(order.riskUsd) > 0 ? Number((Number(order.realizedPnlUsd) / Number(order.riskUsd)).toFixed(3)) : null,
        maxFavorableExcursionUsd: order.maxFavorableExcursionUsd ?? null, maxAdverseExcursionUsd: order.maxAdverseExcursionUsd ?? null,
        ...(order.optionGreekContext ? { optionGreekContext: structuredClone(order.optionGreekContext) } : {}),
        ...(order.executionCostContext ? { executionCostContext: structuredClone(order.executionCostContext) } : {}) })),
      performanceByRegime,
      methodology: 'Sequential observations; evaluator receives only bars completed by decision time and observations with no recognized nested point-in-time context timestamp later than the decision; paper risk gate; later executable-quote fills; configured fees/slippage; no parameter fitting. When scoreThrough is set, later observations only mark/manage existing orders and cannot create candidates. Tail loss is the mean realized R-multiple of the worst 5% of closed trades (at least one); estimates below 30 trades are descriptive only. Turnover counts entry plus exit notional; peak exposure uses overlapping filled-position gross notional. Unresolved orders at resolution data boundary are not graded.',
      limitations: ['Replay quality is bounded by caller-supplied point-in-time bars/quotes, context metadata, costs, session flags, and strategy adapter.', 'Quote sampling cannot observe intrabar path; fees/slippage are configured reserves, not calibrated market impact.', 'A chronological result is not an untouched out-of-sample result unless scoreFrom and parameters were fixed before inspecting outcomes.'],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
