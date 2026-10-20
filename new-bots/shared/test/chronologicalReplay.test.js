import { stockQuote } from '../fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayChronologicalPaper } from '../chronologicalReplay.js';

const base = Date.parse('2026-09-29T14:00:00Z');
const quote = (minute, bid, ask) => stockQuote('TEST', { bid, ask, time: new Date(base + minute * 60_000).toISOString(), quality: 'executable' });

test('chronological replay hides future bars, fills only on a later quote, and applies costs before scoring', async () => {
  const observations = [
    { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1), context: { regimeKey: 'risk-on' } },
    { asOf: new Date(base + 60_000).toISOString(), sessionDate: '2026-09-29', quote: quote(1, 100.05, 100.1) },
    { asOf: new Date(base + 120_000).toISOString(), sessionDate: '2026-09-29', quote: quote(2, 102.2, 102.25) },
  ];
  const bars = [
    { completedAt: new Date(base - 60_000).toISOString(), close: 99.5 },
    { completedAt: new Date(base + 60_000).toISOString(), close: 101 },
    { completedAt: new Date(base + 180_000).toISOString(), close: 999 },
  ];
  const visibleAt = [];
  let proposed = false;
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'test-orb-v1',
    observations, bars, accountEquityUsd: 10_000,
    policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 1, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 2,
      maxGrossExposurePct: 300, maxDailyLossPct: 5, minRewardRisk: 1, maxOpenPositions: 5 },
    evaluate: ({ asOf, quote: current, bars: visible }) => {
      visibleAt.push({ asOf, completed: visible.map((bar) => bar.completedAt) });
      if (proposed || Date.parse(asOf) !== base) return { status: 'no-setup', reasons: ['no-new-signal'] };
      proposed = true;
      return { status: 'candidate', candidate: { mode: 'paper', owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', exposureKey: 'TEST',
        strategyId: 'test-orb-v1', sessionDate: '2026-09-29', sessionTimeZone: 'UTC', idempotencyKey: 'TEST:2026-09-29:test-orb-v1:one',
        direction: 'long', bid: current.bid, ask: current.ask, entryPrice: current.ask, stopPrice: 99.1, targetPrice: 102.1,
        stockQuoteEvidence: current.stockQuoteEvidence, quoteTime: current.time, quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
        roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01, forceExitAt: new Date(base + 10 * 60_000).toISOString() } };
    } });

  assert.equal(visibleAt.length, 3);
  assert.deepEqual(visibleAt[0].completed, [bars[0].completedAt]);
  assert.deepEqual(visibleAt[1].completed, [bars[0].completedAt, bars[1].completedAt]);
  assert.equal(visibleAt[2].completed.includes(bars[2].completedAt), false);
  assert.equal(report.candidatesConsidered, 1);
  assert.equal(report.completedBars, 2);
  assert.equal(report.futureBarsExcluded, 1);
  assert.equal(report.quoteSampling.observationIntervals.sampleCount, 2);
  assert.equal(report.quoteSampling.observationIntervals.maxMs, 60_000);
  assert.equal(report.quoteSampling.openPositionMarkIntervals.sampleCount, 1);
  assert.equal(report.quoteSampling.openPositionMarkIntervals.maxMs, 60_000);
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.unresolvedOrders, 0);
  assert.equal(report.executionOutcomes.reservationCount, 1);
  assert.equal(report.executionOutcomes.fillCount, 1);
  assert.equal(report.executionOutcomes.reservationFillRatePct, 100);
  assert.equal(report.executionOutcomes.notFilledRatePct, 0);
  assert.equal(report.executionOutcomes.target1Hits, 1);
  assert.equal(report.executionOutcomes.target1HitRatePct, 100);
  assert.equal(report.executionOutcomes.target2Hits, null);
  assert.match(report.executionOutcomes.target2Status, /not defined/);
  assert.equal(report.executionOutcomes.stopHits, 0);
  assert.equal(report.executionOutcomes.returnSampleCount, 1);
  assert.equal(report.executionOutcomes.averageNetReturnR, report.trades[0].realizedR);
  assert.equal(report.marketSessionBootstrap.trades, 1);
  assert.equal(report.marketSessionBootstrap.sessionDays, 1);
  assert.equal(report.marketSessionBootstrap.lower95R, null);
  assert.equal(report.trades[0].exitReason, 'target');
  assert.equal(report.trades[0].reservedAt, new Date(base).toISOString());
  assert.equal(report.trades[0].reservationToFillMs, 60_000);
  assert.ok(report.trades[0].realizedPnlUsd < report.trades[0].grossPnlUsd);
  assert.ok(report.feesUsd > 0);
  assert.ok(report.slippageReserveUsd > 0);
  assert.equal(report.trades[0].regime, 'risk_on');
  assert.ok(report.trades[0].riskUsd > 0);
  assert.ok(report.trades[0].notionalUsd > 0);
  assert.ok(Number.isFinite(report.trades[0].realizedR));
  assert.equal(report.tailSampleCount, 1);
  assert.equal(report.expectedShortfall95R, report.trades[0].realizedR);
  assert.equal(report.fifthPercentileR, report.trades[0].realizedR);
  assert.match(report.tailRiskConfidence, /fewer than 30/);
  assert.equal(report.maxConcurrentExposureUsd, report.trades[0].notionalUsd);
  assert.equal(report.turnoverNotionalUsd, Number((report.trades[0].notionalUsd * 2).toFixed(2)));
  assert.equal(report.averageHoldingMinutes, 1);
  assert.equal(report.performanceByRegime.risk_on.scoredObservations, 1);
  assert.equal(report.performanceByRegime.risk_on.scoredSessions, 1);
  assert.equal(report.performanceByRegime.risk_on.closedTradeSessions, 1);
  assert.equal(report.performanceByRegime.risk_on.candidates, 1);
  assert.equal(report.performanceByRegime.risk_on.reservationsCreated, 1);
  assert.equal(report.performanceByRegime.risk_on.closedTrades, 1);
  assert.equal(report.performanceByRegime.risk_on.outcomes.expectancyUsd, report.trades[0].realizedPnlUsd);
  assert.equal(report.performanceByRegime.risk_on.outcomes.expectedShortfall95R, report.trades[0].realizedR);
  assert.equal(report.performanceByRegime.risk_on.outcomes.excursionSampleCount, 1);
  assert.equal(report.performanceByExitReason.target.closedTrades, 1);
  assert.equal(report.performanceByExitReason.target.netR, report.trades[0].realizedR);
  assert.equal(report.performanceByExitReason.target.expectancyR, report.trades[0].realizedR);
  assert.equal(report.performanceByExitReason.target.riskNormalizedSampleCount, 1);
  assert.equal(report.performanceByRegime.risk_on.outcomesByExitReason.target.closedTrades, 1);
  assert.equal(report.performanceByRegime.risk_on.outcomesByExitReason.target.expectancyR, report.trades[0].realizedR);
  assert.equal(report.performanceByRegime.unknown.scoredObservations, 2);
  assert.equal(report.performanceByRegime.unknown.scoredSessions, 1);
  assert.equal(report.performanceByRegime.unknown.observationsMissingSessionDate, 0);
  assert.equal(report.performanceByRegime.unknown.noSetup, 2);
  assert.equal(report.performanceByRegime.unknown.closedTrades, 0);
  assert.equal(report.performanceByRegime.unknown.outcomes, null);
  assert.deepEqual(report.performanceByRegime.unknown.outcomesByExitReason, {});
});

test('replay fill rates exclude unresolved pending entries and include terminal unfilled cancellations', async () => {
  const evaluate = ({ asOf, quote: current }) => {
    if (Date.parse(asOf) !== base) return { status: 'no-setup' };
    return { status: 'candidate', candidate: { mode: 'paper', owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', exposureKey: 'TEST',
      strategyId: 'fill-censor-test', sessionDate: '2026-09-29', sessionTimeZone: 'UTC', idempotencyKey: 'TEST:fill-censor-test',
      direction: 'long', bid: current.bid, ask: current.ask, entryPrice: current.ask, stopPrice: 99, targetPrice: 102,
      stockQuoteEvidence: current.stockQuoteEvidence, quoteTime: current.time, quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
      roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01,
      entryExpiresAt: new Date(base + 30_000).toISOString(), forceExitAt: new Date(base + 10 * 60_000).toISOString() } };
  };
  const args = { owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'fill-censor-test',
    accountEquityUsd: 10_000, policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 1, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 2,
      maxGrossExposurePct: 300, maxDailyLossPct: 5, minRewardRisk: 1, maxOpenPositions: 5 }, evaluate };
  const pending = await replayChronologicalPaper({ ...args,
    observations: [{ asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1) }], bars: [] });
  assert.equal(pending.unresolvedOrders, 1);
  assert.equal(pending.executionOutcomes.reservationCount, 1);
  assert.equal(pending.executionOutcomes.pendingEntryCount, 1);
  assert.equal(pending.executionOutcomes.resolvedEntryAttempts, 0);
  assert.equal(pending.executionOutcomes.reservationFillRatePct, null);
  assert.equal(pending.executionOutcomes.unfilledCount, 0);
  assert.equal(pending.executionOutcomes.notFilledRatePct, null);

  const expired = await replayChronologicalPaper({ ...args,
    observations: [
      { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1) },
      { asOf: new Date(base + 60_000).toISOString(), sessionDate: '2026-09-29', quote: quote(1, 100, 100.1) },
    ], bars: [] });
  assert.equal(expired.unresolvedOrders, 0);
  assert.equal(expired.executionOutcomes.pendingEntryCount, 0);
  assert.equal(expired.executionOutcomes.resolvedEntryAttempts, 1);
  assert.equal(expired.executionOutcomes.fillCount, 0);
  assert.equal(expired.executionOutcomes.unfilledCount, 1);
  assert.equal(expired.executionOutcomes.reservationFillRatePct, 0);
  assert.equal(expired.executionOutcomes.notFilledRatePct, 100);
});

test('chronological replay rejects even slightly future-dated quotes at the decision boundary', async () => {
  const observation = { asOf: new Date(base).toISOString(), quote: { ...quote(0, 100, 100.1), time: new Date(base + 1).toISOString() } };
  await assert.rejects(replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'strict-point-in-time',
    observations: [observation], bars: [], accountEquityUsd: 10_000, evaluate: () => ({ status: 'no-setup' }) }), /future-dated quotes are rejected/);
});

test('chronological replay rejects future-dated nested bars and research reviews before strategy evaluation', async () => {
  let evaluations = 0;
  const future = new Date(base + 60_000).toISOString();
  const report = await replayChronologicalPaper({ owner: 'futures', assetClass: 'future', instrumentKey: 'ESZ6', strategyId: 'nested-context-time-check',
    observations: [{ asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1),
      context: { trendBars: [{ time: future }], catalystReview: { status: 'clear', reviewedAt: future } } }],
    bars: [], accountEquityUsd: 10_000,
    evaluate: () => { evaluations += 1; return { status: 'no-setup' }; } });
  assert.equal(evaluations, 0);
  assert.equal(report.futureDatedContextObservations, 1);
  assert.equal(report.topRejectionReasons.future_dated_context_observation, 1);
  assert.equal(report.performanceByRegime.unknown.noSetup, 1);
});

test('point-in-time context gate does not reject future contract expiry or scheduled session close fields', async () => {
  let evaluations = 0;
  const report = await replayChronologicalPaper({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY', strategyId: 'future-event-time-check',
    observations: [{ asOf: new Date(base).toISOString(), quote: quote(0, 100, 100.1), context: {
      contract: { expiry: '2026-10-02T20:00:00.000Z' }, session: { closeTime: new Date(base + 60 * 60_000).toISOString() },
      assignmentReview: { reviewedThrough: '2026-10-02' },
    } }], bars: [], accountEquityUsd: 10_000,
    evaluate: () => { evaluations += 1; return { status: 'no-setup' }; } });
  assert.equal(evaluations, 1);
  assert.equal(report.futureDatedContextObservations, 0);
});

test('chronological replay rejects score windows that do not overlap any observations', async () => {
  const observation = { asOf: new Date(base).toISOString(), quote: quote(0, 100, 100.1) };
  const common = { owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'empty-score-window',
    observations: [observation], bars: [], accountEquityUsd: 10_000, evaluate: () => ({ status: 'no-setup' }) };
  await assert.rejects(replayChronologicalPaper({ ...common, scoreFrom: new Date(base + 1).toISOString() }), /contains no observations/);
  await assert.rejects(replayChronologicalPaper({ ...common, scoreThrough: new Date(base - 1).toISOString() }), /contains no observations/);
});

test('post-score resolution quotes manage existing paper orders without generating new decisions', async () => {
  const observations = [
    { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1) },
    { asOf: new Date(base + 60_000).toISOString(), sessionDate: '2026-09-29', quote: quote(1, 100.05, 100.1) },
    { asOf: new Date(base + 120_000).toISOString(), sessionDate: '2026-09-29', quote: quote(2, 102.2, 102.25) },
  ];
  let evaluations = 0;
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'resolution-buffer-test',
    observations, bars: [], scoreFrom: observations[0].asOf, scoreThrough: observations[1].asOf,
    accountEquityUsd: 10_000,
    policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 1, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 2,
      maxGrossExposurePct: 300, maxDailyLossPct: 5, minRewardRisk: 1, maxOpenPositions: 5 },
    evaluate: ({ asOf, quote: current }) => {
      evaluations += 1;
      if (asOf !== observations[0].asOf) return { status: 'no-setup' };
      return { status: 'candidate', candidate: { mode: 'paper', owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', exposureKey: 'TEST',
        strategyId: 'resolution-buffer-test', sessionDate: '2026-09-29', sessionTimeZone: 'UTC', idempotencyKey: 'TEST:resolution-buffer',
        direction: 'long', bid: current.bid, ask: current.ask, entryPrice: current.ask, stopPrice: 99.1, targetPrice: 102.1,
        stockQuoteEvidence: current.stockQuoteEvidence, quoteTime: current.time, quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
        roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01, forceExitAt: new Date(base + 10 * 60_000).toISOString() } };
    } });
  assert.equal(evaluations, 2);
  assert.equal(report.scoredObservations, 2);
  assert.equal(report.resolutionObservations, 1);
  assert.equal(report.scoreThrough, observations[1].asOf);
  assert.equal(report.resolutionThrough, observations[2].asOf);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.trades[0].exitReason, 'target');
});

test('time-bounded source-cited cost schedules override strategy estimates and persist on closed trades', async () => {
  const observations = [
    { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1) },
    { asOf: new Date(base + 60_000).toISOString(), sessionDate: '2026-09-29', quote: quote(1, 100.05, 100.1) },
    { asOf: new Date(base + 120_000).toISOString(), sessionDate: '2026-09-29', quote: quote(2, 102.2, 102.25) },
  ];
  const schedule = [
    { id: 'morning-fees', validFrom: new Date(base - 60_000).toISOString(), validUntil: new Date(base + 90_000).toISOString(),
      roundTripFeesPerUnit: 0.05, slippageReservePerUnit: 0.02, source: 'https://data.example.com/fees' },
    { id: 'later-fees', validFrom: new Date(base + 90_000).toISOString(), validUntil: new Date(base + 180_000).toISOString(),
      roundTripFeesPerUnit: 0.08, slippageReservePerUnit: 0.03, source: 'https://data.example.com/fees' },
  ];
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'scheduled-cost-test',
    observations, bars: [], accountEquityUsd: 10_000, executionCostSchedule: schedule,
    policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 1, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 2,
      maxGrossExposurePct: 300, maxDailyLossPct: 5, minRewardRisk: 1 },
    evaluate: ({ asOf, quote: current, executionCosts }) => Date.parse(asOf) !== base ? { status: 'no-setup' } : {
      status: 'candidate', candidate: { mode: 'paper', owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', exposureKey: 'TEST',
        strategyId: 'scheduled-cost-test', sessionDate: '2026-09-29', sessionTimeZone: 'UTC', idempotencyKey: 'TEST:scheduled-cost-test',
        direction: 'long', bid: current.bid, ask: current.ask, entryPrice: current.ask, stopPrice: 99.1, targetPrice: 102.1,
        stockQuoteEvidence: current.stockQuoteEvidence, quoteTime: current.time, quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
        roundTripFeesPerUnit: executionCosts.roundTripFeesPerUnit, slippageReservePerUnit: executionCosts.slippageReservePerUnit,
        forceExitAt: new Date(base + 10 * 60_000).toISOString() },
    } });
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.executionCostSchedule.mode, 'time-bounded-source-cited');
  assert.equal(report.executionCostSchedule.appliedCandidates, 1);
  assert.equal(report.trades[0].executionCostContext.id, 'morning-fees');
  assert.equal(report.trades[0].executionCostContext.roundTripFeesPerUnit, 0.05);
  assert.equal(report.feesUsd, Number((report.trades[0].notionalUsd > 0 ? report.trades[0].feesUsd : 0).toFixed(2)));
});

test('cost schedule gaps block evaluation and overlapping or unsafe cost rows are rejected', async () => {
  let evaluated = false;
  const observation = { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1) };
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'gap-test',
    observations: [observation], bars: [], accountEquityUsd: 10_000,
    executionCostSchedule: [{ id: 'future-only', validFrom: new Date(base + 1).toISOString(), validUntil: new Date(base + 60_000).toISOString(),
      roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01, source: 'https://data.example.com/fees' }],
    evaluate: () => { evaluated = true; return { status: 'no-setup' }; } });
  assert.equal(evaluated, false);
  assert.equal(report.executionCostSchedule.observationsOutsideSchedule, 1);
  assert.equal(report.topRejectionReasons.execution_cost_schedule_unavailable, 1);
  const invalid = [{ id: 'bad', validFrom: new Date(base).toISOString(), validUntil: new Date(base + 60_000).toISOString(),
    roundTripFeesPerUnit: 0, slippageReservePerUnit: 0, source: 'https://data.example.com/fees?token=secret' }];
  await assert.rejects(replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'invalid-costs',
    observations: [observation], bars: [], accountEquityUsd: 10_000, executionCostSchedule: invalid, evaluate: () => ({ status: 'no-setup' }) }), /without query or fragment/);
  const overlapping = [
    { ...invalid[0], id: 'first', source: 'https://data.example.com/fees', validFrom: new Date(base - 1).toISOString(), validUntil: new Date(base + 60_000).toISOString() },
    { ...invalid[0], id: 'second', source: 'https://data.example.com/fees', validFrom: new Date(base + 30_000).toISOString(), validUntil: new Date(base + 90_000).toISOString() },
  ];
  await assert.rejects(replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'overlap-costs',
    observations: [observation], bars: [], accountEquityUsd: 10_000, executionCostSchedule: overlapping, evaluate: () => ({ status: 'no-setup' }) }), /overlap/);
});

test('replay counts distinct explicit market sessions per regime and exposes missing session labels', async () => {
  const day2 = base + 86_400_000;
  const observations = [
    { asOf: new Date(base).toISOString(), sessionDate: '2026-09-29', quote: quote(0, 100, 100.1), context: { regimeKey: 'risk-off' } },
    { asOf: new Date(day2 + 60_000).toISOString(), sessionDate: 'not-a-date', quote: { bid: 100, ask: 100.1,
      time: new Date(day2 + 60_000).toISOString(), quality: 'executable' }, context: { regimeKey: 'risk-off' } },
    { asOf: new Date(day2 + 120_000).toISOString(), sessionDate: '2026-09-30', quote: { bid: 100, ask: 100.1,
      time: new Date(day2 + 120_000).toISOString(), quality: 'executable' }, context: { regimeKey: 'risk-off' } },
  ];
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'no-entry',
    observations, bars: [], accountEquityUsd: 10_000,
    evaluate: () => ({ status: 'no-setup', reasons: ['fixture_no_setup'] }) });
  assert.equal(report.performanceByRegime.risk_off.scoredObservations, 3);
  assert.equal(report.performanceByRegime.risk_off.scoredSessions, 2);
  assert.equal(report.performanceByRegime.risk_off.observationsMissingSessionDate, 1);
  assert.equal(report.performanceByRegime.risk_off.closedTradeSessions, null);
});

test('replay rejects unordered or future-dated observations before invoking strategy code', async () => {
  const evaluate = () => { throw new Error('must not be called'); };
  await assert.rejects(replayChronologicalPaper({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', strategyId: 'x',
    observations: [{ asOf: new Date(base).toISOString(), quote: quote(1, 1, 1.001) }], bars: [], evaluate, accountEquityUsd: 1_000 }), /future/);
  await assert.rejects(replayChronologicalPaper({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', strategyId: 'x',
    observations: [{ asOf: new Date(base + 60_000).toISOString(), quote: quote(1, 1, 1.001) }, { asOf: new Date(base).toISOString(), quote: quote(2, 1, 1.001) }],
    bars: [], evaluate, accountEquityUsd: 1_000 }), /strictly increasing/);
});

test('replay blocks a strategy adapter from returning a different instrument or mismatched quote', async () => {
  const current = quote(0, 100, 100.1);
  const report = await replayChronologicalPaper({ owner: 'stocks', assetClass: 'stock', instrumentKey: 'TEST', strategyId: 'fixed',
    observations: [{ asOf: current.time, quote: current }], bars: [], accountEquityUsd: 10_000,
    evaluate: () => ({ status: 'candidate', candidate: { owner: 'stocks', assetClass: 'stock', instrumentKey: 'OTHER', strategyId: 'fixed', quoteTime: current.time, bid: 100, ask: 100.1 } }) });
  assert.equal(report.reservationsCreated, 0);
  assert.equal(report.topRejectionReasons.candidate_identity_or_quote_mismatch, 1);
});
