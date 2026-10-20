import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPostTradeReview, inspectClosedPaperAccounting, inspectClosedPaperTrade, inspectQuotedCrossing } from '../postTradeReview.js';
import { buildResearchDashboard, renderResearchDashboardHtml } from '../researchDashboard.js';

const base = { status: 'closed', orderId: 'paper-1', owner: 'stocks', instrumentKey: 'AAPL',
  strategyId: 'opening_range', filledAt: '2026-09-29T14:00:00Z', closedAt: '2026-09-29T14:30:00Z',
  quoteTime: '2026-09-29T13:59:30Z', riskUsd: 10, fillQuote: { spreadPct: 0.1 },
  entryPrice: 100, fillPrice: 100, stopPrice: 98, targetPrice: 104, exitPrice: 100.02,
  positionQuoteSampleCount: 5, maxPositionQuoteGapMs: 90_000,
  researchContext: { status: 'captured', observedAt: '2026-09-29T13:59:00Z',
    setupType: 'opening_range_breakout', marketRegime: 'risk_on', volatilityRegime: 'unknown',
    features: { relative_volume: 2.4, invalid: 'not-a-number' } } };

test('modeled cost reconciliation distinguishes complete, legacy and contradictory closes', () => {
  assert.equal(inspectClosedPaperAccounting({ realizedPnlUsd: 8, grossPnlUsd: 10,
    feesUsd: 1, slippageUsd: 1 }).status, 'reconciled');
  assert.equal(inspectClosedPaperAccounting({ realizedPnlUsd: 8, grossPnlUsd: 10,
    feesUsd: null, slippageUsd: 1 }).status, 'missing_breakdown');
  assert.equal(inspectClosedPaperAccounting({ realizedPnlUsd: 8, grossPnlUsd: 10,
    feesUsd: -1, slippageUsd: 1 }).status, 'missing_breakdown');
  assert.equal(inspectClosedPaperAccounting({ realizedPnlUsd: 8, grossPnlUsd: 10,
    feesUsd: 0.5, slippageUsd: 0.5 }).status, 'mismatch');
  const review = inspectClosedPaperTrade({ ...base, realizedPnlUsd: 8, grossPnlUsd: 10,
    feesUsd: null, slippageUsd: 1 });
  assert.equal(review.reviewPriority, 'high');
  assert.equal(review.accountingStatus, 'missing_breakdown');
});

test('cost reversal is an observed accounting fact, while the underlying loss cause remains unresolved', () => {
  const trade = inspectClosedPaperTrade({ ...base, grossPnlUsd: 2, feesUsd: 1,
    slippageUsd: 2, realizedPnlUsd: -1, exitReason: 'time_exit',
    maxFavorableExcursionUsd: 8, maxAdverseExcursionUsd: 4 });
  assert.equal(trade.outcome, 'loss');
  assert.equal(trade.netR, -0.1);
  assert.equal(trade.totalModeledCostsUsd, 3);
  assert.equal(trade.accountingMatches, true);
  assert.ok(trade.flags.includes('costs_reversed_positive_gross'));
  assert.equal(trade.lossCause, 'unresolved');
  assert.equal(trade.thesisValidity, 'unreviewed');
  assert.equal(trade.setupType, 'opening_range_breakout');
  assert.equal(trade.plannedStopPrice, 98);
  assert.equal(trade.timeInTradeMinutes, 30);
  assert.deepEqual(trade.issuanceFeatures, { relative_volume: 2.4 });
  assert.equal(trade.modelValuesStatus, 'unavailable_in_shared_ledger');
});

test('quoted crossing is reported only for sampled side exits and is already embedded in gross P&L', () => {
  const row = { ...base, direction: 'long', exitReason: 'stop', units: 10, multiplier: 1, exitPrice: 99,
    fillQuote: { bid: 99.9, ask: 100, spreadPct: 0.10005 },
    exitQuote: { bid: 99, ask: 99.2, spreadPct: 0.20182 } };
  assert.deepEqual(inspectQuotedCrossing(row), { status: 'observed_side_quotes', costUsd: 1.5 });
  const review = inspectClosedPaperTrade({ ...row, grossPnlUsd: -10, feesUsd: 1,
    slippageUsd: 1, realizedPnlUsd: -12 });
  assert.equal(review.observedQuoteCrossingCostUsd, 1.5);
  assert.equal(review.exitSpreadPct, 0.20182);
  assert.match(review.executionPnlBasis, /must not be deducted again/);
  assert.deepEqual(inspectQuotedCrossing({ ...row, exitReason: 'target' }),
    { status: 'exit_not_executable_side', costUsd: null });
  assert.deepEqual(inspectQuotedCrossing({ ...row, exitQuote: null }),
    { status: 'quote_or_size_unavailable', costUsd: null });
  assert.deepEqual(inspectQuotedCrossing({ ...row, exitPrice: 99.1 }),
    { status: 'execution_quote_mismatch', costUsd: null });
  assert.deepEqual(inspectQuotedCrossing({ ...row, direction: 'short', fillPrice: 99.9,
    exitPrice: 99.2 }), { status: 'observed_side_quotes', costUsd: 1.5 });
});

test('a stop exit and sparse quotes do not assert a false breakout, bad stop, or strategy bug', () => {
  const lossOrder = { ...base, grossPnlUsd: -5, feesUsd: null,
    slippageUsd: null, realizedPnlUsd: -5, exitReason: 'stop',
    positionQuoteSampleCount: 1, researchContext: null };
  const row = inspectClosedPaperTrade(lossOrder);
  assert.ok(row.flags.includes('modeled_stop_exit'));
  assert.ok(row.flags.includes('cost_breakdown_incomplete'));
  assert.ok(row.flags.includes('quote_path_insufficient'));
  assert.ok(row.flags.includes('issuance_context_unavailable'));
  assert.equal(row.costBreakdownComplete, false);
  assert.equal(row.accountingMatches, null);
  assert.equal(row.lossCause, 'unresolved');
  assert.equal(row.flags.includes('false_breakout'), false);
  assert.equal(row.flags.includes('strategy_bug'), false);
  const summary = buildPostTradeReview([lossOrder, { ...base, realizedPnlUsd: 1, grossPnlUsd: 2,
    feesUsd: 0.5, slippageUsd: 0.5 }]);
  assert.equal(summary.lossCount, 1);
  assert.equal(summary.unresolvedLossCauses, 1);
  assert.equal(summary.reviewQueue.length, 2, 'winning trades also need thesis review');
});

test('dashboard queues losses and escapes instrument and flag labels in HTML', () => {
  const orders = [{ ...base, instrumentKey: '<img src=x>', realizedPnlUsd: -5,
    grossPnlUsd: -4, feesUsd: 0.5, slippageUsd: 0.5, exitReason: 'stop' },
  { ...base, orderId: 'paper-2', realizedPnlUsd: 3, grossPnlUsd: 4,
    feesUsd: 0.5, slippageUsd: 0.5, exitReason: 'target' }];
  const report = buildResearchDashboard({ ledger: { orders } });
  assert.equal(report.postTradeReview.closedTrades, 2);
  assert.equal(report.postTradeReview.unresolvedLossCauses, 1);
  assert.equal(report.postTradeReview.reviewQueue.length, 2);
  assert.equal(report.postTradeReview.observedFlagCounts.modeled_stop_exit, 1);
  assert.deepEqual(report.postTradeReview.byBotSetup['stocks:opening_range_breakout'], {
    closedTrades: 2, losses: 1, ungraded: 0, costReversals: 0,
    sparseQuotePaths: 0, accountingMismatches: 0,
  });
  const html = renderResearchDashboardHtml(report);
  assert.match(html, /Post-trade review queue/);
  assert.match(html, /Observed review flags by bot and setup/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /Observed flags are not causal findings/);
});
