import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchDashboard, renderResearchDashboardHtml, summarizeTrades } from '../researchDashboard.js';

const closed = ({ owner = 'stocks', instrumentKey = 'AAPL', strategyId = 'opening_range', net, risk,
  filledAt = '2026-09-29T14:00:00.000Z', closedAt = '2026-09-29T14:30:00.000Z', ...rest } = {}) => ({
  owner, instrumentKey, strategyId, status: 'closed', realizedPnlUsd: net, riskUsd: risk,
  filledAt, closedAt, ...rest,
});

test('costed paper outcomes retain gross/net separation, R coverage and UTC cohorts', () => {
  const ledger = { orders: [
    closed({ net: 8, risk: 10, grossPnlUsd: 10, feesUsd: 1, slippageUsd: 1,
      maxFavorableExcursionUsd: 12, maxAdverseExcursionUsd: 3, fillQuote: { spreadPct: 0.12 }, exitReason: 'target' }),
    closed({ owner: 'forex', instrumentKey: 'EUR_USD', strategyId: 'range_breakout', net: -4, risk: 10,
      filledAt: '2026-09-30T15:00:00.000Z', closedAt: '2026-09-30T15:45:00.000Z',
      grossPnlUsd: -3, feesUsd: 0.5, slippageUsd: 0.5, maxFavorableExcursionUsd: 1,
      maxAdverseExcursionUsd: 6, fillQuote: { spreadPct: 0.08 }, exitReason: 'stop' }),
    { owner: 'crypto', status: 'reserved' },
  ] };
  const report = buildResearchDashboard({ ledger, operatorReport: { ledger: { exists: true },
    bots: { stocks: { scanStatus: 'fresh', latestAt: '2026-09-30T15:00:00Z', topRejectionReasons: { stale_quote: 2 } } } } });
  assert.equal(report.overall.closedTrades, 2);
  assert.equal(report.overall.grossPnlUsd, 7);
  assert.equal(report.overall.netPnlUsd, 4);
  assert.equal(report.overall.feesUsd, 1.5);
  assert.equal(report.overall.slippageReserveUsd, 1.5);
  assert.equal(report.overall.netR, 0.4);
  assert.equal(report.overall.expectancyR, 0.2);
  assert.equal(report.overall.profitFactor, 2);
  assert.equal(report.overall.maximumClosedTradeDrawdownUsd, 4);
  assert.equal(report.overall.currentClosedTradeDrawdownUsd, 4);
  assert.equal(report.overall.maximumConsecutiveLosses, 1);
  assert.equal(report.overall.currentConsecutiveLosses, 1);
  assert.equal(report.overall.averageTimeInTradeMinutes, 37.5);
  assert.equal(report.workflow.recordedOrders, 3);
  assert.equal(report.byBot.stocks.performance.netPnlUsd, 8);
  assert.equal(report.byEntryHourUtc['14:00 UTC'].closedTrades, 1);
  assert.equal(report.byEntryWeekdayUtc.Tue.closedTrades, 1);
  assert.equal(report.byMarketRegime.status, 'unavailable');
  assert.equal(report.byBot.stocks.topRejectionReasons.stale_quote, 2);
  assert.equal(report.byBot.options.performance.expectancyUsd, null);
});

test('dashboard shows open risk by asset class and recorded underlying direction', () => {
  const report = buildResearchDashboard({ ledger: { orders: [
    { owner: 'stocks', assetClass: 'stock', instrumentKey: 'NVDA', direction: 'long', status: 'open', riskUsd: 10, notionalUsd: 1_000 },
    { owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPXU', direction: 'long', inverse: true, status: 'reserved', riskUsd: 8, notionalUsd: 200 },
    { owner: 'options', assetClass: 'option', instrumentKey: 'SPY-PUT', direction: 'long', underlyingDirection: 'short', status: 'open', riskUsd: 20, notionalUsd: 100 },
  ] }, operatorReport: { ledger: { exists: true } } });
  assert.equal(report.openExposure.status, 'descriptive');
  assert.equal(report.openExposure.openRiskUsd, 38);
  assert.equal(report.openExposure.assetClassConcentration.groups.find((row) => row.assetClass === 'option').openRiskUsd, 20);
  assert.equal(report.openExposure.directionalConcentration.groups.find((row) => row.direction === 'short').openRiskUsd, 28);
  const html = renderResearchDashboardHtml(report);
  assert.match(html, /Risk by asset class/);
  assert.match(html, /Underlying long \/ short concentration/);
  assert.match(html, /Open paper risk \(USD\)/);
  const absent = buildResearchDashboard({ ledger: { orders: [] }, operatorReport: { ledger: { exists: false } } });
  assert.equal(absent.openExposure.status, 'ledger_missing');
  assert.equal(absent.openExposure.openRiskUsd, null, 'a missing ledger is not displayed as proven zero exposure');
  assert.match(renderResearchDashboardHtml(absent), /ledger_missing/);
});

test('dashboard retains upstream discovery counts beside downstream scan gates', () => {
  const report = buildResearchDashboard({ ledger: { orders: [] }, operatorReport: { ledger: { exists: false }, bots: {
    forex: { status: 'fresh', universe: { accountCurrencyInstruments: 76, capOmissions: 4 },
      funnel: { paperSetupsReserved: 0 } },
    'etfs-etps': { status: 'fresh', universe: { configured: 200, providerScanned: 30 },
      funnel: { strategyCandidates: 1 } },
    options: { status: 'fresh', signalMapping: { inputRecords: 12, rejectedRecordCount: 3 },
      marketData: { cappedUnderlyings: 2 }, funnel: { strategyCandidates: 0 } },
  } } });
  assert.equal(report.byBot.forex.universe.accountCurrencyInstruments, 76);
  assert.equal(report.byBot['etfs-etps'].universe.providerScanned, 30);
  assert.equal(report.byBot.options.signalMapping.rejectedRecordCount, 3);
  const html = renderResearchDashboardHtml(report);
  assert.match(html, /universe\.accountCurrencyInstruments: 76/);
  assert.match(html, /universe\.providerScanned: 30/);
  assert.match(html, /signalMapping\.rejectedRecordCount: 3/);
  assert.match(html, /marketData\.cappedUnderlyings: 2/);
  assert.match(html, /funnel\.strategyCandidates: 0/);
});

test('missing cost/risk/timestamps remain unavailable instead of becoming zero or a fabricated cohort', () => {
  const summary = summarizeTrades([
    closed({ net: 2, risk: null, filledAt: '', closedAt: '', grossPnlUsd: null, feesUsd: null, slippageUsd: null }),
    closed({ net: null, risk: 10 }),
  ]);
  assert.equal(summary.closedTrades, 2);
  assert.equal(summary.costedTrades, 0);
  assert.equal(summary.netObservedTrades, 1);
  assert.equal(summary.missingNetPnl, 1);
  assert.equal(summary.missingCostBreakdown, 2);
  assert.equal(summary.netPnlUsd, null);
  assert.equal(summary.expectancyUsd, null);
  assert.equal(summary.winRatePct, null);
  assert.equal(summary.netR, null);
  assert.equal(summary.grossPnlUsd, null);
  assert.equal(summary.feesUsd, null);
  assert.equal(summary.slippageReserveUsd, null);
  assert.equal(summary.maximumClosedTradeDrawdownUsd, null);
  assert.equal(summary.closeSequenceStatus, 'incomplete_close_sequence');
  assert.equal(summary.averageTimeInTradeMinutes, null);
  assert.equal(summary.profitFactor, null);
  assert.equal(summary.profitFactorStatus, 'incomplete_net_pnl');
  assert.equal(summary.netPerformanceStatus, 'incomplete_net_pnl');
});

test('dashboard separates observed exit spread and side-exit crossing from explicit cost deductions', () => {
  const summary = summarizeTrades([
    closed({ net: -12, risk: 20, grossPnlUsd: -10, feesUsd: 1, slippageUsd: 1,
      units: 10, multiplier: 1, direction: 'long', fillPrice: 100, exitPrice: 99, exitReason: 'stop',
      fillQuote: { bid: 99.9, ask: 100, spreadPct: 0.10005 },
      exitQuote: { bid: 99, ask: 99.2, spreadPct: 0.20182 } }),
    closed({ net: 8, risk: 20, grossPnlUsd: 10, feesUsd: 1, slippageUsd: 1,
      units: 10, multiplier: 1, exitReason: 'target',
      fillQuote: { bid: 100, ask: 100.1, spreadPct: 0.09995 },
      exitQuote: { bid: 101.2, ask: 101.3, spreadPct: 0.09877 } }),
  ]);
  assert.equal(summary.grossPnlUsd, 0);
  assert.equal(summary.netPnlUsd, -4);
  assert.equal(summary.averageExitSpreadPct, 0.1503);
  assert.equal(summary.exitSpreadSampleCount, 2);
  assert.equal(summary.observedQuoteCrossingCostUsd, 1.5);
  assert.equal(summary.quoteCrossingSampleCount, 1, 'target limit exit is not a side-crossing estimate');
  const html = renderResearchDashboardHtml(buildResearchDashboard({ ledger: { orders: [] } }));
  assert.match(html, /Gross P&amp;L after quote crossing/);
  assert.match(html, /Observed quote crossing/);
});

test('rendered dashboard escapes untrusted instrument and rejection labels', () => {
  const report = buildResearchDashboard({ ledger: { orders: [closed({ instrumentKey: '<script>alert(1)</script>', net: 1, risk: 1 })] },
    operatorReport: { ledger: { exists: true }, bots: { stocks: { topRejectionReasons: { '<img src=x>': 1 } } } } });
  const html = renderResearchDashboardHtml(report);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /This is descriptive paper evidence/);
});

test('prospective issuance-time labels create bot-scoped cohorts while legacy rows stay unknown', () => {
  const report = buildResearchDashboard({ ledger: { orders: [
    closed({ net: 3, risk: 5, grossPnlUsd: 3, feesUsd: 0, slippageUsd: 0,
      researchContext: { status: 'captured', observedAt: '2026-09-29T13:59:00Z',
      setupType: 'opening_range_breakout', marketRegime: 'risk_on', volatilityRegime: 'unknown' } }),
    closed({ net: -1, risk: 5, grossPnlUsd: -1, feesUsd: 0, slippageUsd: 0 }),
  ] } });
  assert.equal(report.bySetupType.status, 'descriptive');
  assert.equal(report.bySetupType.groups['stocks:opening_range_breakout'].closedTrades, 1);
  assert.equal(report.bySetupType.groups.unknown.closedTrades, 1);
  assert.equal(report.byMarketRegime.groups['stocks:risk_on'].netPnlUsd, 3);
  assert.equal(report.byMarketRegime.unknownTradeCount, 1);
  assert.equal(report.byVolatilityRegime.status, 'unavailable');
  assert.match(renderResearchDashboardHtml(report), /By market regime/);
});

test('setup comparison ranks only complete multi-session after-cost R cohorts', () => {
  const cohort = (setupType, net) => Array.from({ length: 30 }, (_, index) => {
    const filledAt = new Date(Date.UTC(2026, 8, 1 + Math.floor(index / 6), 14,
      (index % 6) * 5)).toISOString();
    const closedAt = new Date(Date.parse(filledAt) + 60_000).toISOString();
    return closed({ net, risk: 10, filledAt, closedAt, grossPnlUsd: net,
      feesUsd: 0, slippageUsd: 0, researchContext: { status: 'captured',
        observedAt: filledAt, setupType } });
  });
  const strong = cohort('breakout', 2);
  const weak = cohort('retest', -1);
  const report = buildResearchDashboard({ ledger: { orders: [...strong, ...weak] } });
  assert.equal(report.setupComparison.status, 'descriptive');
  assert.equal(report.setupComparison.highestObservedExpectancy.key, 'stocks:breakout');
  assert.equal(report.setupComparison.highestObservedExpectancy.expectancyR, 0.2);
  assert.equal(report.setupComparison.lowestObservedExpectancy.key, 'stocks:retest');
  assert.equal(report.setupComparison.lowestObservedExpectancy.expectancyR, -0.1);
  assert.match(renderResearchDashboardHtml(report), /Highest: stocks:breakout/);

  weak[0] = { ...weak[0], feesUsd: null };
  const incomplete = buildResearchDashboard({ ledger: { orders: [...strong, ...weak] } });
  assert.equal(incomplete.setupComparison.status, 'insufficient_comparable_cohorts');
  assert.equal(incomplete.setupComparison.highestObservedExpectancy, null);
  assert.ok(incomplete.setupComparison.unrankedCohorts.some((row) =>
    row.key === 'stocks:retest' && row.reasons.includes('incomplete_cost_or_risk_evidence')));

  const lateContext = [...cohort('retest', -1)];
  lateContext[0] = { ...lateContext[0], researchContext: { ...lateContext[0].researchContext,
    observedAt: new Date(Date.parse(lateContext[0].filledAt) + 60_000).toISOString() } };
  const lateReport = buildResearchDashboard({ ledger: { orders: [...strong, ...lateContext] } });
  assert.equal(lateReport.setupComparison.status, 'insufficient_comparable_cohorts');
  assert.ok(lateReport.setupComparison.unrankedCohorts.some((row) =>
    row.key === 'stocks:retest' && row.reasons.includes('missing_or_post_fill_entry_context')));
});

test('net-only and mismatched closes never form a complete modeled after-cost cohort', () => {
  const summary = summarizeTrades([
    closed({ net: 9, risk: 10, grossPnlUsd: 10, feesUsd: 1, slippageUsd: 0 }),
    closed({ net: 4, risk: 10, grossPnlUsd: 5, feesUsd: null, slippageUsd: 0 }),
  ]);
  assert.equal(summary.costedTrades, 1);
  assert.equal(summary.netObservedTrades, 2);
  assert.equal(summary.missingNetPnl, 0);
  assert.equal(summary.missingCostBreakdown, 1);
  assert.equal(summary.netPnlUsd, null);
  assert.equal(summary.netPerformanceStatus, 'incomplete_cost_breakdown');
  assert.equal(summary.maximumClosedTradeDrawdownUsd, null);

  const mismatch = summarizeTrades([closed({ net: 9, risk: 10, grossPnlUsd: 10, feesUsd: 2, slippageUsd: 0 })]);
  assert.equal(mismatch.pnlAccountingMismatches, 1);
  assert.equal(mismatch.netPerformanceStatus, 'pnl_accounting_mismatch');
  assert.equal(mismatch.expectancyUsd, null);
  assert.equal(mismatch.profitFactor, null);
});
