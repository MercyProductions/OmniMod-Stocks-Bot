import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { appendScanDiagnostic, readScanDiagnosticRows } from '../scanDiagnosticsJournal.js';
import { createRunnerHeartbeat, readRunnerHeartbeatStatus, runnerHeartbeatPath } from '../runnerHeartbeat.js';
import { buildOperatorReport, collectOperatorReport, summarizeLedgerCoordination, summarizeSharedPaperPortfolio } from '../operatorReport.js';
import { inspectProviderReadiness } from '../providerReadiness.js';
import { alpacaBudgetConfiguration, createSharedAlpacaRequestGate } from '../alpacaSharedBudget.js';

test('operator report exposes actual shared-budget counters without keys or secret paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'operator-alpaca-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.ALPACA_SHARED_RATE_DIR;
  process.env.ALPACA_SHARED_RATE_DIR = join(root, 'private-budget-path');
  try {
    const now = Date.parse('2026-10-03T16:00:00Z');
    const gate = createSharedAlpacaRequestGate({ ...alpacaBudgetConfiguration(process.env, root), now: () => now });
    await gate('fixture-private-key'); await gate.defer('fixture-private-key', 60000);
    await assert.rejects(gate('fixture-private-key'), { code: 'ALPACA_PACING_DEFERRED' });
    const report = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks'), cryptoDataDir: join(root, 'crypto'),
      ledgerPath: join(root, 'missing.json'), now });
    const budget = report.alpacaRequestBudget;
    assert.equal(budget.status, 'observed'); assert.equal(budget.buckets.length, 1);
    assert.equal(budget.buckets[0].grantsTotal, 1); assert.equal(budget.buckets[0].deferredTotal, 1);
    assert.equal(budget.buckets[0].providerQuota, null);
    assert.doesNotMatch(JSON.stringify(budget), /fixture-private-key|private-budget-path/);
    process.env.ALPACA_SHARED_RATE_DIR = join(root, 'missing-budget');
    const absent = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks'), cryptoDataDir: join(root, 'crypto'),
      ledgerPath: join(root, 'missing.json'), now });
    assert.equal(absent.alpacaRequestBudget.status, 'no_observations');
  } finally {
    if (before === undefined) delete process.env.ALPACA_SHARED_RATE_DIR; else process.env.ALPACA_SHARED_RATE_DIR = before;
  }
});

test('Stocks operator report preserves both decision quote-refresh passes and final ages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-refresh-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stocks = join(root, 'stocks'), directory = join(stocks, 'research', 'diagnostics');
  await mkdir(directory, { recursive: true });
  const now = Date.parse('2026-10-02T15:00:00Z');
  const refresh = { qualification: { uniqueSymbols: 3, executableQuotes: 2, batchRequests: 1 },
    entry: { uniqueSymbols: 1, executableQuotes: 1, batchRequests: 0, reusedFresh: 1 },
    decisions: [{ symbol: 'AAPL', quoteAgeMs: 1500 }], entryRiskRejected: [] };
  await writeFile(join(directory, '2026-10-02.jsonl'), JSON.stringify({ recordType: 'scan_diagnostic', guildId: 'fixture',
    startedAt: new Date(now).toISOString(), sharedPaperQuoteRefresh: refresh }) + '\n');
  const report = await collectOperatorReport({ rootDir: root, stocksDataDir: stocks, cryptoDataDir: join(root, 'crypto'),
    ledgerPath: join(root, 'missing-ledger.json'), now });
  assert.deepEqual(report.bots.stocks.sharedPaperQuoteRefresh, [refresh]);
});

test('Crypto operator coverage preserves per-guild directories without multiplying the unique universe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-operator-universe-'));
  const crypto = join(root, 'crypto');
  const now = Date.parse('2026-10-02T14:00:00Z');
  const coverage = { assetsReturned: 348, broadDiscovery: { status: 'updated', mode: 'discovery_research',
    directory: { assetCount: 21782, enumeration: 'complete_active_endpoint_response' },
    prices: { checkedLast24h: 50, uncheckedLast24h: 21732 } } };
  try {
    await mkdir(crypto);
    for (const guildId of ['one', 'two']) await writeFile(join(crypto, `scan-diagnostic-${guildId}.json`), JSON.stringify({
        guildId, generatedAt: new Date(now).toISOString(), funnel: { universe: 348 }, universeCoverage: coverage,
        venueResearch: { deepRequested: 2, approvedSetups: 0, excludedFromProductionLearning: true },
        diagnostics: { sharedPaperQuoteIdentity: { exactQuotesReady: 2, assetsWithEntryQuote: 1,
          rejectionCounts: { crypto_quote_currency_conversion_required: 1 } },
          sharedPaperMarkDiagnostics: { quoteRejected: 1, rejectionReasons: { legacy_crypto_execution_identity_unavailable: 1 } } },
    }));
    const report = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks'), cryptoDataDir: crypto,
      ledgerPath: join(root, 'missing-ledger.json'), now });
    assert.equal(report.bots.crypto.instances, 2);
    assert.deepEqual(report.bots.crypto.universeCoverage, [coverage, coverage]);
    assert.equal(report.bots.crypto.universeCoverage[0].broadDiscovery.directory.assetCount, 21782);
    assert.equal(report.bots.crypto.venueResearch[0].deepRequested, 2);
    assert.equal(report.bots.crypto.sharedPaperQuoteIdentity[0].exactQuotesReady, 2);
    assert.equal(report.bots.crypto.sharedPaperQuoteIdentity[0].rejectionCounts.crypto_quote_currency_conversion_required, 1);
    assert.equal(report.bots.crypto.sharedPaperMarkDiagnostics[0].rejectionReasons.legacy_crypto_execution_identity_unavailable, 1);
    assert.equal(report.bots.crypto.venueResearch[1].approvedSetups, 0);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
});

test('scan diagnostics sidecar validates owner and ignores malformed rows while preserving good history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-scan-journal-'));
  try {
    const written = await appendScanDiagnostic('forex', { funnel: { setups: 2 } }, { directory, now: Date.parse('2026-09-29T15:00:00Z') });
    await assert.rejects(appendScanDiagnostic('../secret', {}, { directory }), /Unknown primary bot/);
    await writeFile(written.file, `${JSON.stringify({ broken: true })}\nnot-json\n`, { flag: 'a' });
    const rows = await readScanDiagnosticRows(written.file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bot, 'forex');
    assert.deepEqual(rows[0].diagnostics, { funnel: { setups: 2 } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('aggregates shared portfolio by primary bot without exposing order rows', () => {
  const now = Date.parse('2026-09-29T15:00:00Z');
  const summary = summarizeSharedPaperPortfolio({ schemaVersion: 1, orders: [
    { owner: 'stocks', status: 'reserved', riskUsd: 20, notionalUsd: 500, entryExpiresAt: new Date(now - 1).toISOString() },
    { owner: 'options', status: 'open', riskUsd: 30, notionalUsd: 300, unrealizedPnlUsd: -5, forceExitAt: new Date(now - 1).toISOString() },
    { owner: 'crypto', status: 'closed', closedAt: '2026-09-29T14:59:00Z', closedSessionDate: '2026-09-29', realizedPnlUsd: 12, grossPnlUsd: 12, feesUsd: 0, slippageUsd: 0, maxFavorableExcursionUsd: 18, maxAdverseExcursionUsd: 4,
      positionQuoteSampleCount: 5, maxPositionQuoteGapMs: 30_000 },
    { owner: 'futures', status: 'closed', closedAt: '2026-09-28T14:58:00Z', closedPortfolioRiskDateUtc: '2026-09-28', realizedPnlUsd: -4, grossPnlUsd: -4, feesUsd: 0, slippageUsd: 0 },
    { owner: 'stocks', status: 'cancelled', cancelReason: 'entry_window_expired' },
    { owner: 'stocks', status: 'cancelled', cancelReason: 'time_exit_before_fill' },
    { owner: 'forex', status: 'cancelled', cancelReason: 'emergency_stop_active' },
  ] }, { now });
  assert.equal(summary.activeOrders, 2);
  assert.equal(summary.openRiskUsd, 50);
  assert.equal(summary.unrealizedPnlUsd, -5);
  assert.equal(summary.staleOrUnmarkedPositions, 1);
  assert.equal(summary.byBot.options.staleOrUnmarkedPositions, 1);
  assert.equal(summary.realizedPnlUsd, 8);
  assert.equal(summary.riskDayUtc, '2026-09-29');
  assert.equal(summary.realizedPnlRiskDayUtcUsd, 12);
  assert.equal(summary.unclassifiedClosedTrades, 0);
  assert.equal(summary.excursionSampleCount, 1);
  assert.equal(summary.averageMaxFavorableExcursionUsd, 18);
  assert.equal(summary.byBot.crypto.averageMaxAdverseExcursionUsd, 4);
  assert.equal(summary.performance.sampleSize, 2);
  assert.equal(summary.performance.expectancyUsd, 4);
  assert.equal(summary.performance.averageRealizedR, null, 'missing initial-risk metadata is not fabricated');
  assert.equal(summary.performance.profitFactor, 3);
  assert.equal(summary.performance.tradeSequenceDrawdownUsd, 4);
  assert.equal(summary.performance.maximumConsecutiveLosses, 1);
  assert.equal(summary.performance.currentConsecutiveLosses, 0);
  assert.equal(summary.performance.positionQuoteCoverageCount, 1);
  assert.equal(summary.performance.averagePositionQuoteSamples, 5);
  assert.equal(summary.performance.averageMaxPositionQuoteGapMs, 30_000);
  assert.equal(summary.byBot.crypto.performance.averagePositionQuoteSamples, 5);
  assert.equal(summary.byBot.crypto.performance.status, 'descriptive_small_sample');
  assert.equal(summary.overdueExitPositions, 1);
  assert.equal(summary.expiredUnfilledReservations, 1);
  assert.equal(summary.byBot.options.overdueExitPositions, 1);
  assert.equal(summary.byBot.stocks.expiredUnfilledReservations, 1);
  assert.equal(summary.expiredReservationCancellations, 2);
  assert.equal(summary.emergencyStopReservationCancellations, 1);
  assert.equal(summary.byBot.forex.emergencyStopReservationCancellations, 1);
  assert.deepEqual(summary.byBot.stocks, {
    orders: 3, active: 1, reserved: 1, filledOrOpen: 0, staleOrUnmarkedPositions: 0, openPositionsMissingPnl: 0,
    activeRiskMetadataMissing: 0, activeNotionalMetadataMissing: 0, activeMarginMetadataMissing: 0,
    overdueExitPositions: 0, expiredUnfilledReservations: 1,
    expiredReservationCancellations: 2, emergencyStopReservationCancellations: 0, closed: 0,
    closedTradesMissingRealizedPnl: 0, closedTradesUnreconciledCostAccounting: 0,
    pendingFillRisk: { policyUnavailable: 1, checked: 0, blocked: 0, reasons: {},
      scope: 'Latest persisted check per pending order; not a new check or a market opportunity count.' },
    performance: { sampleSize: 0, reconciledAfterCostCount: 0, missingCostBreakdownCount: 0,
      pnlAccountingMismatchCount: 0, costAccountingStatus: 'no_closed_sample',
      wins: 0, losses: 0, breakeven: 0, winRatePct: null, averageWinUsd: null, averageLossUsd: null,
      netPnlUsd: 0, expectancyUsd: null, profitFactor: null, profitFactorStatus: 'no_closed_sample', averageRealizedR: null,
      realizedRSampleSize: 0, tradeSequenceDrawdownUsd: null, currentClosedTradeDrawdownUsd: null,
      maximumConsecutiveLosses: null, currentConsecutiveLosses: null, drawdownObservationCount: 0,
      closeSequenceStatus: 'no_closed_trades',
      drawdownBasis: 'complete uniquely ordered closed-trade net P&L; excludes open and intratrade drawdown',
      positionQuoteCoverageCount: 0, averagePositionQuoteSamples: null, averageMaxPositionQuoteGapMs: null,
      status: 'descriptive_small_sample' },
    openRiskUsd: 20, openNotionalUsd: 500, openInitialMarginUsd: 0, unrealizedPnlUsd: 0, realizedPnlUsd: 0,
    excursionSampleCount: 0, averageMaxFavorableExcursionUsd: null, averageMaxAdverseExcursionUsd: null,
  });
  assert.equal(JSON.stringify(summary).includes('instrumentKey'), false);
});

test('operator report exposes the anchored closed-trade circuit and its breach', () => {
  const summary = summarizeSharedPaperPortfolio({ schemaVersion: 1, accountEquityUsd: 10_000,
    closedTradeCircuit: { maxConsecutiveLosses: 3, maxClosedDrawdownPct: 2 }, orders: [
      { status: 'closed', realizedPnlUsd: -120, grossPnlUsd: -120, feesUsd: 0, slippageUsd: 0,
        closedAt: '2026-09-25T15:00:00.000Z' },
      { status: 'closed', realizedPnlUsd: -100, grossPnlUsd: -100, feesUsd: 0, slippageUsd: 0,
        closedAt: '2026-09-26T15:00:00.000Z' },
    ] });
  assert.deepEqual(summary.closedTradeCircuit, {
    status: 'maximum_closed_drawdown_limit', maxConsecutiveLosses: 3,
    maxClosedDrawdownPct: 2, sequenceStatus: 'complete',
  });
  assert.equal(summarizeSharedPaperPortfolio({ schemaVersion: 1, orders: [] }).closedTradeCircuit.status,
    'not_configured');
});

test('operator groups mapped stock and futures positions by underlying exposure without hedge credit', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY', direction: 'long', status: 'open', riskUsd: 20, notionalUsd: 1_000 },
    { owner: 'futures', assetClass: 'future', instrumentKey: 'CME_ES', future: { providerRawSymbol: 'ESH6' }, direction: 'short', status: 'reserved', riskUsd: 10, notionalUsd: 500 },
    { owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'DBC', direction: 'long', status: 'open', riskUsd: 8, notionalUsd: 400 },
    { owner: 'stocks', assetClass: 'stock', instrumentKey: 'NVDA', direction: 'long', status: 'open', riskUsd: 5, notionalUsd: 200 },
  ] });
  const spy = summary.exposureConcentration.groups.find((row) => row.exposureKey === 'SPY');
  assert.equal(summary.exposureConcentration.status, 'available');
  assert.equal(summary.exposureConcentration.basis, 'primary canonical exposure identity; gross notional is summed without correlation or hedge credit');
  assert.equal(spy.activeOrders, 2);
  assert.equal(spy.reservedOrders, 1);
  assert.equal(spy.openPositions, 1);
  assert.deepEqual(spy.owners, ['etfs-etps', 'futures']);
  assert.equal(spy.grossNotionalUsd, 1_500);
  assert.equal(spy.longNotionalUsd, 1_000);
  assert.equal(spy.shortNotionalUsd, 500);
  assert.equal(spy.netDirectionalNotionalUsd, 500);
  const commodityBasket = summary.exposureConcentration.groups.find((row) => row.exposureKey === 'DBC');
  assert.ok(commodityBasket.overlapExposureKeys.includes('OIL'));
  assert.ok(commodityBasket.overlapExposureKeys.includes('GLD'));
  assert.equal(commodityBasket.grossNotionalUsd, 400, 'secondary overlap identities are disclosed but component notional is not fabricated');
  assert.equal(summary.exposureConcentration.groups[0].exposureKey, 'SPY', 'groups sort by known gross notional');
});

test('portfolio concentration reports asset-class risk and effective long/short direction without hedge credit', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'stocks', assetClass: 'stock', instrumentKey: 'NVDA', direction: 'long', status: 'open', riskUsd: 10, notionalUsd: 1_000 },
    { owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPXU', direction: 'long', inverse: true, status: 'reserved', riskUsd: 8, notionalUsd: 200 },
    { owner: 'options', assetClass: 'option', instrumentKey: 'SPY-PUT-VERTICAL', exposureKey: 'SPY', direction: 'long', underlyingDirection: 'short', status: 'open', riskUsd: 20, notionalUsd: 100 },
  ] });
  assert.equal(summary.assetClassConcentration.status, 'available');
  assert.equal(summary.assetClassConcentration.groups.length, 3);
  assert.deepEqual(summary.assetClassConcentration.groups.find((row) => row.assetClass === 'etf'), {
    assetClass: 'etf', activeOrders: 1, reservedOrders: 1, filledOrOpenOrders: 0,
    riskMetadataMissing: 0, notionalMetadataMissing: 0, openRiskUsd: 8, grossNotionalUsd: 200,
  });
  assert.equal(summary.directionalConcentration.status, 'available');
  assert.deepEqual(summary.directionalConcentration.groups.map((row) => [row.direction, row.openRiskUsd, row.grossNotionalUsd]),
    [['long', 10, 1_000], ['short', 28, 300]]);
  assert.equal(summary.openRiskUsd, 38, 'asset and direction views do not change the shared risk total');
});

test('portfolio concentration retains unclassified rows and withholds incomplete group totals', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'crypto', assetClass: 'crypto', instrumentKey: 'BTC', direction: 'long', status: 'open', riskUsd: 5, notionalUsd: 100 },
    { owner: 'futures', assetClass: 'unknown_class', instrumentKey: 'MYSTERY', direction: 'sideways', status: 'reserved', riskUsd: null, notionalUsd: '' },
    { owner: 'options', assetClass: 'option', instrumentKey: 'SPY-VERTICAL', direction: 'long', status: 'open', riskUsd: 4, notionalUsd: 20 },
  ] });
  assert.equal(summary.assetClassConcentration.status, 'unclassified_asset_class');
  const unclassified = summary.assetClassConcentration.groups.find((row) => row.assetClass === 'unclassified');
  assert.equal(unclassified.activeOrders, 1);
  assert.equal(unclassified.riskMetadataMissing, 1);
  assert.equal(unclassified.notionalMetadataMissing, 1);
  assert.equal(unclassified.openRiskUsd, null);
  assert.equal(unclassified.grossNotionalUsd, null);
  assert.equal(summary.directionalConcentration.status, 'unknown_underlying_direction');
  assert.equal(summary.directionalConcentration.groups.find((row) => row.direction === 'unknown').activeOrders, 2,
    'a purchased option spread without its underlying direction is not presented as bullish');
  assert.equal(summary.directionalConcentration.groups.find((row) => row.direction === 'unknown').openRiskUsd, null);
  assert.equal(summary.openRiskUsd, null, 'an incomplete active row never becomes zero portfolio risk');
});

test('concentration totals remain unknown when active notional or exposure direction is missing', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'crypto', assetClass: 'crypto', instrumentKey: 'BTC', direction: 'long', status: 'open', riskUsd: 5, notionalUsd: 100 },
    { owner: 'futures', assetClass: 'future', instrumentKey: 'unknown-future', direction: 'sideways', status: 'open', riskUsd: 5 },
  ] });
  const btc = summary.exposureConcentration.groups.find((row) => row.exposureKey === 'BTC');
  const unknown = summary.exposureConcentration.groups.find((row) => row.exposureKey === 'UNKNOWN-FUTURE');
  assert.equal(btc.grossNotionalUsd, 100);
  assert.equal(btc.longNotionalUsd, 100);
  assert.equal(unknown.grossNotionalUsd, null);
  assert.equal(unknown.openRiskUsd, 5);
  assert.equal(unknown.longNotionalUsd, null);
  assert.equal(unknown.directionUnknown, 1);
  assert.equal(unknown.notionalMetadataMissing, 1);
});

test('performance report keeps no-loss profit factor undefined and labels invalid close-time drawdown coverage', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'crypto', status: 'closed', closedAt: '2026-09-29T14:00:00Z', realizedPnlUsd: 5,
      grossPnlUsd: 5, feesUsd: 0, slippageUsd: 0, riskUsd: 10 },
    { owner: 'crypto', status: 'closed', realizedPnlUsd: 3,
      grossPnlUsd: 3, feesUsd: 0, slippageUsd: 0, riskUsd: 10 },
    { owner: 'crypto', status: 'closed', closedAt: '2026-09-29T14:02:00Z', realizedPnlUsd: null, riskUsd: 10 },
  ] });
  assert.equal(summary.performance.sampleSize, 2);
  assert.equal(summary.closedTradesMissingRealizedPnl, 1);
  assert.equal(summary.realizedPnlUsd, null, 'a partial closed subtotal is not a complete portfolio result');
  assert.equal(summary.byBot.crypto.realizedPnlUsd, null);
  assert.equal(summary.realizedPnlRiskDayUtcUsd, null, 'an undated close may belong to the current risk day');
  assert.equal(summary.performance.profitFactor, null);
  assert.equal(summary.performance.profitFactorStatus, 'incomplete_cost_accounting');
  assert.equal(summary.performance.averageRealizedR, null);
  assert.equal(summary.performance.drawdownObservationCount, 1);
  assert.equal(summary.performance.tradeSequenceDrawdownUsd, null);
  assert.equal(summary.performance.maximumConsecutiveLosses, null);
  assert.equal(summary.performance.closeSequenceStatus, 'incomplete_close_sequence');
  assert.equal(summary.performance.status, 'descriptive_small_sample');
});

test('operator performance does not claim reconciled after-cost expectancy from net-only or mismatched closes', () => {
  const rows = [
    { owner: 'stocks', status: 'closed', closedAt: '2026-09-29T14:00:00Z',
      realizedPnlUsd: 8, grossPnlUsd: 10, feesUsd: 1, slippageUsd: 1, riskUsd: 10 },
    { owner: 'crypto', status: 'closed', closedAt: '2026-09-29T14:01:00Z',
      realizedPnlUsd: 7, grossPnlUsd: 10, feesUsd: 1, slippageUsd: 1, riskUsd: 10 },
  ];
  const summary = summarizeSharedPaperPortfolio({ orders: rows }, { now: Date.parse('2026-09-29T18:00:00Z') });
  assert.equal(summary.performance.sampleSize, 2);
  assert.equal(summary.performance.reconciledAfterCostCount, 1);
  assert.equal(summary.performance.pnlAccountingMismatchCount, 1);
  assert.equal(summary.performance.costAccountingStatus, 'pnl_accounting_mismatch');
  assert.equal(summary.performance.netPnlUsd, null);
  assert.equal(summary.performance.expectancyUsd, null);
  assert.equal(summary.performance.tradeSequenceDrawdownUsd, null);
  assert.equal(summary.realizedPnlUsd, null);
  assert.equal(summary.realizedPnlRiskDayUtcUsd, null);
  assert.equal(summary.closedTradesUnreconciledCostAccounting, 1);
  const nextDay = summarizeSharedPaperPortfolio({ orders: rows }, { now: Date.parse('2026-09-30T18:00:00Z') });
  assert.equal(nextDay.realizedPnlRiskDayUtcUsd, 0, 'a dated prior-day gap does not erase today\'s known zero');
  const missing = summarizeSharedPaperPortfolio({ orders: [{ ...rows[0], feesUsd: null }] });
  assert.equal(missing.performance.costAccountingStatus, 'incomplete_cost_breakdown');
  assert.equal(missing.performance.netPnlUsd, null);
});

test('operator portfolio reports malformed open P&L as unavailable instead of coercing booleans', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'forex', status: 'open', riskUsd: 10, notionalUsd: 100, unrealizedPnlUsd: true },
  ] });
  assert.equal(summary.openPositionsMissingPnl, 1);
  assert.equal(summary.unrealizedPnlUsd, null);
  assert.equal(summary.byBot.forex.openPositionsMissingPnl, 1);
  assert.equal(summary.byBot.forex.unrealizedPnlUsd, null);
});

test('operator portfolio marks exposure totals incomplete when active risk metadata is malformed', () => {
  const summary = summarizeSharedPaperPortfolio({ orders: [
    { owner: 'stocks', assetClass: 'stock', status: 'reserved', riskUsd: true, notionalUsd: '', marginRequirementUsd: 0 },
    { owner: 'futures', assetClass: 'future', status: 'open', riskUsd: 5, notionalUsd: 50, marginRequirementUsd: true, unrealizedPnlUsd: 0 },
  ] });
  assert.equal(summary.activeRiskMetadataMissing, 1);
  assert.equal(summary.activeNotionalMetadataMissing, 1);
  assert.equal(summary.activeMarginMetadataMissing, 1);
  assert.equal(summary.openRiskUsd, null);
  assert.equal(summary.openNotionalUsd, null);
  assert.equal(summary.openInitialMarginUsd, null);
  assert.equal(summary.byBot.stocks.openRiskUsd, null);
  assert.equal(summary.byBot.stocks.openNotionalUsd, null);
  assert.equal(summary.byBot.stocks.activeRiskMetadataMissing, 1);
  assert.equal(summary.byBot.futures.openInitialMarginUsd, null);
  assert.equal(summary.byBot.futures.activeMarginMetadataMissing, 1);
});

test('collects latest diagnostics from all six bot stores without exposing guild identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-operator-'));
  const stocks = join(root, 'stocks'); const crypto = join(root, 'crypto');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    const forexData = join(root, 'forex', 'data');
    await appendScanDiagnostic('forex', { universe: { configured: 2 }, funnel: { paperSetupsReserved: 0 }, provider: { requests: 2, failures: 0,
      rateLimitEstimate: { peakRequestsPerSecond: 2, documentedRequestsPerSecondLimit: 120, utilizationPct: 1.67 } }, safety: { emergencyStopActive: true, liveTradingEnabled: false } }, { directory: forexData, now: now - 60_000 });
    await appendScanDiagnostic('forex', { universe: { configured: 2 }, funnel: { paperSetupsReserved: 1 }, provider: { requests: 3, failures: 0,
      rateLimitEstimate: { peakRequestsPerSecond: 3, documentedRequestsPerSecondLimit: 120, utilizationPct: 2.5 } },
      safety: { emergencyStopActive: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false } }, { directory: forexData, now });
    await appendScanDiagnostic('futures', { contextUniverse: { universe: 5 }, dayTrade: { reservationsCreated: 0 }, provider: { failures: 1 },
      contractLifecycleDiagnostics: { expiredPositions: 1, staleSettlementReviews: 2, semantics: 'attention only' },
      safety: { emergencyStopActive: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false },
      forwardShadow: [{ id: 'higher-relative-volume', counts: { observations: 5, reservations: 1 }, topRejectionReasons: { stale_quote: 2 }, performance: { closedCount: 2, netPnlUsd: -3.5,
        recentSessionExpectancyBootstrap: { trades: 3, sessionDays: 2, lower95R: -0.2, upper95R: 0.7, replicates: 1_000 } } }] }, { directory: join(root, 'futures', 'data'), now });
    const optionsData = join(root, 'options', 'data');
    await appendScanDiagnostic('options', { funnel: { strategyCandidates: 1 }, provider: { requests: 1, failures: 0,
      rateLimitUtilization: 20, rateLimit: { allowed: 120, used: 24, available: 96, expiresAt: now + 60_000, utilizationPct: 20 } } }, { directory: optionsData, now: now - 60_000 });
    await appendScanDiagnostic('options', { source: 'tradier', signalMapping: { status: 'complete', sourceCounts: { stocks: 2, 'etfs-etps': 1 }, mappedUnderlyings: 2, directionConflicts: 1 }, optionExpiryDiagnostics: { pastExpiryPositions: 1, expiryTodayPositions: 2, semantics: 'attention only' }, marketData: { inputSignals: 3, distinctUnderlyings: 3,
      statusCounts: { ready: 1, catalyst_review_required: 1, chain_unavailable: 1 },
      cappedUnderlyings: 2, cappedUnderlyingSymbols: ['T12', 'T13'], cappedRejectionReason: 'provider_request_symbol_cap' },
      marketDataReadiness: { status: 'research_only', automatedScanRan: true, label: 'Delayed research data observed' },
      funnel: { strategyCandidates: 1, paperReservations: 0 }, safety: { emergencyStopActive: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false }, provider: { requests: 2, failures: 0,
      rateLimitUtilization: 60, rateLimit: { allowed: 120, used: 72, available: 48, expiresAt: now + 60_000, utilizationPct: 60 } } }, { directory: optionsData, now });
    const etfData = join(root, 'etfs-etps', 'data');
    await appendScanDiagnostic('etfs-etps', { universe: { configured: 20, providerScanned: 12 }, funnel: { strategyCandidates: 0 }, safety: { emergencyStopActive: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false }, provider: { failures: 0,
      byEndpoint: { 'Alpaca ETF snapshots': { requests: 1, failures: 0, latestRateLimit: { limit: 200, remaining: 180, reset: now, utilizationPct: 10 } } } } }, { directory: etfData, now: now - 60_000 });
    await appendScanDiagnostic('etfs-etps', { universe: { configured: 20, providerScanned: 12 }, funnel: { strategyCandidates: 0 }, safety: { emergencyStopActive: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false }, provider: { failures: 0,
      byEndpoint: { 'Alpaca ETF snapshots': { requests: 1, failures: 0, latestRateLimit: { limit: 200, remaining: 0, reset: now, utilizationPct: 100 } } } } }, { directory: etfData, now });
    const stockDiagnostics = join(stocks, 'research', 'diagnostics');
    await mkdir(stockDiagnostics, { recursive: true });
    await writeFile(join(stockDiagnostics, '2026-09-29.jsonl'), `${JSON.stringify({ recordType: 'scan_diagnostic', guildId: 'secret-guild-id', completedAt: new Date(now).toISOString(), universeSize: 100, requestedMarketContext: 15, requestedNonContext: 85, successfullyScanned: 98, scannedMarketContext: 15, scannedNonContext: 83, missingMarketContext: 0, missingNonContext: 2, unexpectedReturned: 0, skipped: 2, discoveryCandidates: 80, ownershipExcluded: 3, setups: 2, sharedPaperEmergencyStop: true, liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false, topRejectionReasons: { stale_quote: 3 }, forwardShadow: [{ id: 'wider-target', counts: { strategyQualified: 1 }, topRejectionReasons: { no_setup: 1 }, performance: { sampleSize: 1 } }], providers: [{ provider: 'Alpaca', requests: 4, failures: 0, latestRateLimit: { limit: 200, remaining: 100, utilization: 0.5 } }] })}\n`);
    await mkdir(crypto, { recursive: true });
    await writeFile(join(crypto, 'scan-diagnostic-guild-private-1.json'), JSON.stringify({ guildId: 'guild-private', generatedAt: new Date(now).toISOString(), totalDurationMs: 50, diagnostics: { sharedPaperStatus: 'configured; emergency stop active', liveTradingEnabled: false, liveTradingRequested: true, orderRoutingAvailable: false, portfolioCorrelation: { status: 'partial_or_complete', comparablePairs: 3, unavailablePairs: 2, usedForApproval: false }, forwardShadow: [{ id: 'tighter-stop', counts: { strategyQualified: 2 }, topRejectionReasons: { no_setup: 2 }, performance: { sampleSize: 1 } }] }, funnel: { universe: 30, setupsPosted: 1, topRejectionReasons: { low_score: 4 } }, providers: { Binance: { requests: 2, failures: 0, rateLimit: { limit: 2400, remaining: 1800, utilizationPct: 25 } } } }));
    const report = await collectOperatorReport({ rootDir: root, stocksDataDir: stocks, cryptoDataDir: crypto, ledgerPath: join(root, 'missing-ledger.json'), now });
    assert.deepEqual(Object.keys(report.bots).sort(), ['crypto', 'etfs-etps', 'forex', 'futures', 'options', 'stocks']);
    assert.equal(report.bots.stocks.status, 'fresh');
    assert.equal(report.bots.stocks.funnel.universeSize, 100);
    assert.equal(report.bots.stocks.funnel.requestedNonContext, 85);
    assert.equal(report.bots.stocks.funnel.scannedMarketContext, 15);
    assert.equal(report.bots.stocks.funnel.missingNonContext, 2);
    assert.equal(report.bots.stocks.funnel.ownershipExcluded, 3);
    assert.equal(report.bots.stocks.funnel.discoveryCandidates, 80);
    assert.equal(report.bots.stocks.funnel.technicalQualified, null, 'missing funnel counters remain unknown');
    assert.equal(report.bots.stocks.funnel.setups, 2);
    assert.equal(report.bots.stocks.averageDurationMs, null, 'missing scan timing is not rendered as zero');
    assert.equal(report.bots.stocks.durationSamples, 0);
    assert.equal(report.bots.crypto.funnel.setupsPosted, 1);
    assert.equal(report.bots.crypto.averageDurationMs, 50);
    assert.equal(report.bots.crypto.durationSamples, 1);
    assert.deepEqual(report.bots.stocks.forwardShadow, [[{ id: 'wider-target', counts: { strategyQualified: 1 }, topRejectionReasons: { no_setup: 1 }, performance: { sampleSize: 1 } }]]);
    assert.deepEqual(report.bots.crypto.forwardShadow, [[{ id: 'tighter-stop', counts: { strategyQualified: 2 }, topRejectionReasons: { no_setup: 2 }, performance: { sampleSize: 1 } }]]);
    assert.deepEqual(report.bots.crypto.portfolioCorrelation, [{ status: 'partial_or_complete', comparablePairs: 3, unavailablePairs: 2, usedForApproval: false }]);
    assert.equal(report.bots.crypto.providerQuotaHistory.Binance.latestUtilizationPct, 25);
    assert.equal(report.bots.stocks.providerQuotaHistory.Alpaca.averageUtilizationPct, 50);
    assert.equal(report.bots.forex.funnel.paperSetupsReserved, 1);
    assert.deepEqual(report.bots.forex.universe, { configured: 2 });
    assert.deepEqual(report.bots.forex.providerQuotaHistory['OANDA practice'], {
      scanSamples: 2, quotaSamples: 2, averageUtilizationPct: 2.08, peakUtilizationPct: 2.5,
      latestUtilizationPct: 2.5, latestAt: new Date(now).toISOString(),
      latestQuota: { utilizationPct: 2.5, peakRequestsPerSecond: 3, documentedRequestsPerSecondLimit: 120 },
    });
    assert.equal(report.bots.futures.funnel.dayTrade.reservationsCreated, 0);
    assert.deepEqual(report.bots.futures.universe, { universe: 5 });
    assert.deepEqual(report.bots.futures.lifecycle, { expiredPositions: 1, staleSettlementReviews: 2, semantics: 'attention only' });
    assert.deepEqual(report.bots.futures.forwardShadow, [{ id: 'higher-relative-volume', counts: { observations: 5, reservations: 1 }, topRejectionReasons: { stale_quote: 2 }, performance: { closedCount: 2, netPnlUsd: -3.5,
      recentSessionExpectancyBootstrap: { trades: 3, sessionDays: 2, lower95R: -0.2, upper95R: 0.7, replicates: 1_000 } } }]);
    assert.equal(report.bots.options.funnel.strategyCandidates, 1);
    assert.equal(report.bots.options.source, 'tradier');
    assert.deepEqual(report.bots.options.marketDataReadiness, { status: 'research_only', automatedScanRan: true, label: 'Delayed research data observed' });
    assert.equal(report.bots.forex.marketDataReadiness, null, 'legacy scan data must not imply provider readiness');
    assert.deepEqual(report.bots.options.signalMapping, { status: 'complete', sourceCounts: { stocks: 2, 'etfs-etps': 1 }, mappedUnderlyings: 2, directionConflicts: 1 });
    assert.deepEqual(report.bots.options.lifecycle, { pastExpiryPositions: 1, expiryTodayPositions: 2, semantics: 'attention only' });
    assert.deepEqual(report.bots.options.marketData, { inputSignals: 3, distinctUnderlyings: 3,
      statusCounts: { ready: 1, catalyst_review_required: 1, chain_unavailable: 1 },
      cappedUnderlyings: 2, cappedUnderlyingSymbols: ['T12', 'T13'], cappedRejectionReason: 'provider_request_symbol_cap' });
    assert.deepEqual(report.bots.options.providerQuotaHistory.Tradier, {
      scanSamples: 2, quotaSamples: 2, averageUtilizationPct: 40, peakUtilizationPct: 60,
      latestUtilizationPct: 60, latestAt: new Date(now).toISOString(),
      latestQuota: { allowed: 120, used: 72, available: 48, expiresAt: now + 60_000, utilizationPct: 60 },
    });
    assert.deepEqual(report.bots['etfs-etps'].providerQuotaHistory['Alpaca ETF snapshots'], {
      scanSamples: 2, quotaSamples: 2, averageUtilizationPct: 55, peakUtilizationPct: 100,
      latestUtilizationPct: 100, latestAt: new Date(now).toISOString(),
      latestQuota: { limit: 200, remaining: 0, reset: now, utilizationPct: 100 },
    });
    assert.equal(report.bots['etfs-etps'].status, 'fresh');
    assert.deepEqual(report.bots['etfs-etps'].universe, { configured: 20, providerScanned: 12 });
    assert.equal(report.bots.stocks.lastScanSafety.emergencyStop, 'active');
    assert.equal(report.bots.crypto.lastScanSafety.emergencyStop, 'active');
    assert.equal(report.bots.forex.lastScanSafety.emergencyStop, 'active');
    assert.equal(report.bots.stocks.lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots.crypto.lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots.forex.lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots.futures.lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots.options.lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots['etfs-etps'].lastScanSafety.liveTradingRequest, 'requested-but-blocked');
    assert.equal(report.bots.forex.lastScanSafety.liveTrading, 'disabled');
    assert.equal(report.bots['etfs-etps'].lastScanSafety.emergencyStop, 'active');
    assert.equal(report.ledger.exists, false);
    assert.equal(report.ledger.lock.classification, 'unlocked');
    assert.equal(JSON.stringify(report).includes('secret-guild-id'), false);
    assert.match(report.safety.emergencyStopRuntimeState, /last-scan observations/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('operator report surfaces stale ledger locks as manual-review-required without changing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-operator-lock-'));
  const ledgerPath = join(root, 'ledger.json');
  const lockPath = `${ledgerPath}.lock`;
  try {
    const lockText = JSON.stringify({ pid: 999999999, hostname: hostname(), operation: 'process-paper-quote', startedAt: '2026-09-29T14:00:00Z' });
    await writeFile(lockPath, lockText);
    const report = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks'), cryptoDataDir: join(root, 'crypto'), ledgerPath,
      now: Date.parse('2026-09-29T15:00:00Z') });
    assert.equal(report.ledger.lock.classification, 'owner-process-absent');
    assert.equal(report.ledger.lock.recovery, 'manual-review-required; lock was not modified');
    assert.equal(Object.hasOwn(report.ledger.lock, 'ledgerPath'), false);
    assert.equal(Object.hasOwn(report.ledger.lock, 'lockPath'), false);
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(await readFile(lockPath, 'utf8'), lockText);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('operator report supplies explicit missing-bot states rather than implying healthy scans', () => {
  const report = buildOperatorReport({ ledger: { orders: [] }, now: Date.parse('2026-09-29T15:00:00Z') });
  assert.equal(report.bots.stocks.status, 'no-scan-data');
  assert.equal(report.bots.stocks.scanStatus, 'no-scan-data');
  assert.equal(report.bots.forex.status, 'no-scan-data');
  assert.equal(report.bots.forex.runtime.status, 'unknown');
  assert.equal(report.bots.forex.runtime.discord, 'unknown');
  assert.equal(report.bots.forex.lastScanSafety.emergencyStop, 'unknown');
  assert.equal(report.portfolio.activeOrders, 0);
  assert.equal(report.safety.ledgerCoordination.status, 'unobserved');
});

test('operator report compares the shared ledger equity anchor to six configured paper accounts without exposing values', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-ledger-equity-report-'));
  const root = join(base, 'new-bots');
  const ledgerPath = join(root, 'shared', 'ledger.json');
  const configs = [
    ['../stocks-bot/.env', 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'],
    ['../crypto-bot/.env', 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'],
    ['forex/.env', 'PAPER_ACCOUNT_EQUITY_USD'], ['futures/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
    ['options/.env', 'PAPER_ACCOUNT_EQUITY_USD'], ['etfs-etps/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
  ];
  try {
    for (const [relativePath, key] of configs) {
      const path = resolve(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${key}=30000\n`);
    }
    await mkdir(dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, JSON.stringify({ schemaVersion: 1, accountEquityUsd: 25_000, orders: [], events: [] }));
    const report = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks-data'), cryptoDataDir: join(root, 'crypto-data'), ledgerPath });
    assert.equal(report.providerReadiness.accountEquity.status, 'consistent');
    assert.equal(report.providerReadiness.paperEquityAnchor.status, 'mismatch');
    assert.deepEqual(report.providerReadiness.paperEquityAnchor.mismatchedBotIds, ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);
    assert.equal(report.providerReadiness.paperEquityAnchor.valuesExposed, false);
    assert.equal(JSON.stringify(report).includes('30000'), false);
    assert.equal(JSON.stringify(report).includes('25000'), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('operator report separates a fresh scan from stopped or ready runner heartbeats', () => {
  const report = buildOperatorReport({ ledger: { orders: [] }, bots: {
    crypto: { status: 'fresh', latestAt: '2026-09-29T14:59:00.000Z', process: { status: 'stopped', activeProcesses: 0,
      processes: [{ status: 'stopped', heartbeatAt: '2026-09-29T15:00:00.000Z', discordReady: false, schedulerRunning: false, lastScanExitCode: 0 }] } },
    futures: { status: 'stale', latestAt: '2026-09-29T14:00:00.000Z', process: { status: 'running', activeProcesses: 1,
      processes: [{ status: 'running', heartbeatAt: '2026-09-29T15:00:00.000Z', discordReady: true, schedulerRunning: true, lastScanFinishedAt: '2026-09-29T14:59:30.000Z', lastScanExitCode: 0 }] } },
  } });
  assert.equal(report.bots.crypto.status, 'fresh', 'legacy status continues to mean scan freshness');
  assert.equal(report.bots.crypto.scanStatus, 'fresh');
  assert.equal(report.bots.crypto.runtime.status, 'stopped');
  assert.equal(report.bots.crypto.runtime.discord, 'unknown', 'a stopped process is not a current Discord connection');
  assert.equal(report.bots.futures.scanStatus, 'stale');
  assert.equal(report.bots.futures.runtime.status, 'running');
  assert.equal(report.bots.futures.runtime.discord, 'ready');
  assert.match(report.bots.futures.runtime.scope, /does not verify webhook delivery/);
});

test('provider readiness reports missing configuration without returning secret values or claiming entitlement', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-provider-readiness-'));
  const root = join(base, 'new-bots');
  const secret = 'sentinel-token-value-must-not-appear';
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, 'forex'), { recursive: true });
    await writeFile(join(root, 'forex', '.env'), `FOREX_SOURCE=oanda-practice\nOANDA_ENV=practice\nOANDA_API_TOKEN=${secret}\nPAPER_ACCOUNT_EQUITY_USD=2500\n`);
    await mkdir(join(base, 'stocks-bot'), { recursive: true });
    await writeFile(join(base, 'stocks-bot', '.env'), `ALPACA_API_KEY_ID=${secret}\nALPACA_API_SECRET_KEY=${secret}\nALPACA_DATA_FEED=sip\nOMNIMOD_PAPER_ACCOUNT_EQUITY_USD=5000\nSTOCKS_ROUND_TRIP_FEES_PER_SHARE=0\n`);
    const readiness = await inspectProviderReadiness({ rootDir: root });
    assert.equal(readiness.bots.forex.status, 'incomplete');
    assert.deepEqual(readiness.bots.forex.missingRequiredKeys, ['OANDA_ACCOUNT_ID']);
    assert.equal(readiness.bots.forex.paperEquityConfigured, true);
    assert.equal(readiness.bots.forex.paperEquityKey, 'PAPER_ACCOUNT_EQUITY_USD');
    assert.equal(readiness.bots.forex.paperRiskStatus, 'incomplete-cost-assumptions');
    assert.deepEqual(readiness.bots.forex.missingPaperCostSettings, ['FOREX_ROUND_TRIP_FEES_PER_UNIT', 'FOREX_SLIPPAGE_RESERVE_PER_UNIT']);
    assert.equal(readiness.bots.forex.emergencyStop, 'active-by-default');
    assert.equal(readiness.bots.forex.liveTrading, 'disabled-by-code');
    assert.match(readiness.bots.forex.verification, /authentication, entitlement/);
    assert.equal(readiness.bots.crypto.status, 'public-fallback-available');
    assert.deepEqual(readiness.bots.crypto.providerModes.coinGecko,
      { keyConfigured: false, requestedTier: 'demo', effectiveMode: 'public', tierSettingRecognized: true });
    assert.equal(readiness.bots.crypto.providerModes.freeFallback.available, true);
    assert.equal(JSON.stringify(readiness).includes(secret), false);
    assert.equal(readiness.bots.stocks.status, 'configured-unverified');
    assert.equal(readiness.bots.stocks.paperEquityConfigured, true);
    assert.equal(readiness.bots.stocks.paperEquityKey, 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD');
    assert.equal(readiness.bots.stocks.paperRiskStatus, 'configured-unverified');
    assert.deepEqual(readiness.bots.stocks.paperCostAssumptions, [
      { key: 'STOCKS_ROUND_TRIP_FEES_PER_SHARE', status: 'environment' },
      { key: 'STOCKS_ASSUMED_SLIPPAGE_BPS', status: 'runtime-default' },
    ]);
    assert.equal(JSON.stringify(readiness).includes(secret), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('crypto provider readiness reports the effective free/demo/pro mode without revealing credentials', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-crypto-provider-mode-'));
  const root = join(base, 'new-bots');
  const key = 'never-return-this-provider-key';
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(base, 'crypto-bot'), { recursive: true });
    const envPath = join(base, 'crypto-bot', '.env');
    await writeFile(envPath, `COINGECKO_API_KEY=${key}\nCOINGECKO_API_TIER=pro\n`);
    let report = await inspectProviderReadiness({ rootDir: root });
    assert.deepEqual(report.bots.crypto.providerModes.coinGecko,
      { keyConfigured: true, requestedTier: 'pro', effectiveMode: 'pro', tierSettingRecognized: true });
    assert.equal(JSON.stringify(report).includes(key), false);

    await writeFile(envPath, `COINGECKO_API_KEY=${key}\nCOINGECKO_API_TIER=unexpected-tier\n`);
    report = await inspectProviderReadiness({ rootDir: root });
    assert.deepEqual(report.bots.crypto.providerModes.coinGecko,
      { keyConfigured: true, requestedTier: 'unexpected-tier', effectiveMode: 'demo', tierSettingRecognized: false });
    assert.equal(JSON.stringify(report).includes(key), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('provider readiness matches each bot Discord transport without exposing credentials', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-discord-readiness-'));
  const root = join(base, 'new-bots');
  const webhookSecret = 'discord-webhook-secret-sentinel';
  const tokenSecret = 'discord-token-secret-sentinel';
  try {
    await mkdir(join(base, 'stocks-bot'), { recursive: true });
    await mkdir(join(root, 'forex'), { recursive: true });
    await writeFile(join(root, 'forex', '.env'), `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/${webhookSecret}\n`);
    await writeFile(join(base, 'stocks-bot', '.env'), `DISCORD_TOKEN=${tokenSecret}\nDISCORD_CLIENT_ID=123456\n`);
    const readiness = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.deepEqual(readiness.bots.forex.discord, {
      deliveryMethod: 'application', tokenConfigured: false, clientIdConfigured: false, guildIdConfigured: false,
      channelIdConfigured: false, destinationRequired: true,
      webhookConfigured: true, status: 'missing-application-credentials', secretsExposed: false,
    });
    assert.equal(readiness.bots.futures.discord.status, 'missing-application-credentials');
    assert.equal(readiness.bots.stocks.discord.deliveryMethod, 'application');
    assert.equal(readiness.bots.stocks.discord.status, 'application-credentials-present-unverified');
    assert.equal(readiness.bots.stocks.discord.webhookConfigured, false);
    assert.equal(JSON.stringify(readiness).includes(webhookSecret), false);
    assert.equal(JSON.stringify(readiness).includes(tokenSecret), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('provider readiness merges process environment with runtime precedence without exposing secret values', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-provider-process-env-'));
  const root = join(base, 'new-bots');
  const secret = 'process-env-secret-sentinel';
  try {
    await mkdir(join(base, 'stocks-bot'), { recursive: true });
    await writeFile(join(base, 'stocks-bot', '.env'), 'ALPACA_DATA_FEED=iex\nOMNIMOD_PAPER_ACCOUNT_EQUITY_USD=2500\n');
    const readiness = await inspectProviderReadiness({ rootDir: root, processEnv: {
      ALPACA_API_KEY_ID: secret,
      ALPACA_API_SECRET_KEY: secret,
      ALPACA_DATA_FEED: 'sip',
      OMNIMOD_PAPER_ACCOUNT_EQUITY_USD: '7500',
      STOCKS_ROUND_TRIP_FEES_PER_SHARE: '0.01',
    } });
    assert.equal(readiness.bots.stocks.status, 'configured-unverified');
    assert.deepEqual(readiness.bots.stocks.missingRequiredKeys, []);
    assert.deepEqual(readiness.bots.stocks.missingRequiredModes, []);
    assert.equal(readiness.bots.stocks.paperEquityConfigured, true);
    assert.deepEqual(readiness.bots.stocks.settingSources, {
      ALPACA_API_KEY_ID: 'process-environment',
      ALPACA_API_SECRET_KEY: 'process-environment',
      ALPACA_DATA_FEED: 'process-environment',
    });
    assert.equal(JSON.stringify(readiness).includes(secret), false);
    assert.equal(JSON.stringify(readiness).includes('7500'), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('provider readiness recognizes process-environment setup across all six paper bots without disclosing secrets or equity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-six-bot-process-env-'));
  const root = join(base, 'new-bots');
  const secret = 'six-bot-process-secret-sentinel';
  const processEnv = {
    ALPACA_API_KEY_ID: secret, ALPACA_API_SECRET_KEY: secret, ALPACA_DATA_FEED: 'sip', ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'sip',
    OMNIMOD_PAPER_ACCOUNT_EQUITY_USD: '50000', STOCKS_ROUND_TRIP_FEES_PER_SHARE: '0',
    PAPER_ACCOUNT_EQUITY_USD: '50000', OANDA_API_TOKEN: secret, OANDA_ACCOUNT_ID: 'practice-account',
    FOREX_SOURCE: 'oanda-practice', OANDA_ENV: 'practice', FOREX_ROUND_TRIP_FEES_PER_UNIT: '0', FOREX_SLIPPAGE_RESERVE_PER_UNIT: '0',
    DATABENTO_API_KEY: secret, DATABENTO_DATASET: 'GLBX.MDP3', FUTURES_DAY_DATA_SOURCE: 'databento-live',
    FUTURES_TREND_DATA_SOURCE: 'databento-historical', FUTURES_MAX_SCAN_COST_USD: '5',
    FUTURES_ROUND_TRIP_FEES_PER_CONTRACT: '0', FUTURES_SLIPPAGE_RESERVE_PER_CONTRACT: '0',
    TRADIER_TOKEN: secret, OPTIONS_SOURCE: 'tradier', TRADIER_ENV: 'production',
    OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP: '0', OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT: '0',
    ETF_ROUND_TRIP_FEES_PER_UNIT: '0', ETF_SLIPPAGE_RESERVE_PER_UNIT: '0',
  };
  try {
    const readiness = await inspectProviderReadiness({ rootDir: root, processEnv });
    assert.equal(readiness.accountEquity.status, 'consistent');
    assert.deepEqual(readiness.accountEquity.configuredBotIds, ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);
    for (const bot of ['stocks', 'forex', 'futures', 'options', 'etfs-etps']) {
      assert.equal(readiness.bots[bot].status, 'configured-unverified', bot);
      assert.equal(readiness.bots[bot].paperEquityConfigured, true, bot);
      assert.equal(readiness.bots[bot].paperRiskStatus, 'configured-unverified', bot);
      assert.ok(Object.values(readiness.bots[bot].settingSources).every((source) => source === 'process-environment'), bot);
    }
    assert.equal(readiness.bots.crypto.paperEquityConfigured, true);
    assert.equal(readiness.bots.crypto.paperRiskStatus, 'configured-unverified');
    assert.ok(Object.values(readiness.bots).every((bot) => bot.liveTrading === 'disabled-by-code'));
    assert.equal(JSON.stringify(readiness).includes(secret), false);
    assert.equal(JSON.stringify(readiness).includes('50000'), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('provider readiness detects incomplete, invalid, and mismatched paper equity without exposing values', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-paper-equity-consistency-'));
  const root = join(base, 'new-bots');
  const configs = [
    ['stocks', '../stocks-bot/.env', 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'],
    ['crypto', '../crypto-bot/.env', 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'],
    ['forex', 'forex/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
    ['futures', 'futures/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
    ['options', 'options/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
    ['etfs-etps', 'etfs-etps/.env', 'PAPER_ACCOUNT_EQUITY_USD'],
  ];
  try {
    for (const [, relativePath, key] of configs) {
      const path = resolve(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${key}=12500\n`);
    }
    let readiness = await inspectProviderReadiness({ rootDir: root });
    assert.deepEqual(readiness.accountEquity, {
      status: 'consistent', configuredBotIds: ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'],
      missingBotIds: [], invalidBotIds: [], mismatchedBotIds: [], valuesExposed: false,
    });
    assert.equal(readiness.paperEquityAnchor.status, 'not_checked');
    assert.equal(JSON.stringify(readiness).includes('12500'), false);
    readiness = await inspectProviderReadiness({ rootDir: root, ledgerEquityAnchor: { status: 'anchored', value: 12_500 } });
    assert.deepEqual(readiness.paperEquityAnchor, { status: 'aligned', mismatchedBotIds: [], valuesExposed: false });

    const optionsPath = resolve(root, 'options/.env');
    await writeFile(optionsPath, 'PAPER_ACCOUNT_EQUITY_USD=15000\n');
    readiness = await inspectProviderReadiness({ rootDir: root });
    assert.equal(readiness.accountEquity.status, 'mismatch');
    assert.deepEqual(readiness.accountEquity.mismatchedBotIds, ['options']);
    readiness = await inspectProviderReadiness({ rootDir: root, ledgerEquityAnchor: { status: 'anchored', value: 12_500 } });
    assert.deepEqual(readiness.paperEquityAnchor, { status: 'configuration_mismatch', mismatchedBotIds: ['options'], valuesExposed: false });
    assert.equal(JSON.stringify(readiness.accountEquity).includes('15000'), false);
    assert.equal(JSON.stringify(readiness.paperEquityAnchor).includes('12500'), false);

    for (const [, relativePath, key] of configs) {
      const path = resolve(root, relativePath);
      await writeFile(path, `${key}=15000\n`);
    }
    readiness = await inspectProviderReadiness({ rootDir: root, ledgerEquityAnchor: { status: 'anchored', value: 12_500 } });
    assert.equal(readiness.accountEquity.status, 'consistent', 'the six bots agree with each other');
    assert.deepEqual(readiness.paperEquityAnchor, {
      status: 'mismatch', mismatchedBotIds: ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'], valuesExposed: false,
    }, 'the six bots still cannot silently disagree with the already-anchored ledger');

    const forexPath = resolve(root, 'forex/.env');
    await writeFile(forexPath, 'PAPER_ACCOUNT_EQUITY_USD=-1\n');
    readiness = await inspectProviderReadiness({ rootDir: root });
    assert.equal(readiness.accountEquity.status, 'invalid');
    assert.deepEqual(readiness.accountEquity.invalidBotIds, ['forex']);
    assert.equal(readiness.bots.forex.paperEquityStatus, 'invalid-positive-dollar-amount-required');

    await writeFile(forexPath, '');
    readiness = await inspectProviderReadiness({ rootDir: root });
    assert.equal(readiness.accountEquity.status, 'partial');
    assert.deepEqual(readiness.accountEquity.missingBotIds, ['forex']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('static provider readiness compares effective six-bot ledger paths without exposing paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-paper-ledger-paths-'));
  const root = join(base, 'new-bots');
  try {
    const defaults = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.equal(defaults.paperLedger.status, 'consistent');
    assert.deepEqual(defaults.paperLedger.mismatchedBotIds, []);
    const optionsPath = resolve(root, 'options/.env');
    await mkdir(dirname(optionsPath), { recursive: true });
    await writeFile(optionsPath, 'TRADING_RISK_STATE_PATH=custom/options-ledger.json\n');

    const mismatch = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.equal(mismatch.paperLedger.status, 'mismatch');
    assert.deepEqual(mismatch.paperLedger.mismatchedBotIds, ['options']);
    assert.equal(JSON.stringify(mismatch).includes('custom/options-ledger.json'), false);

    const processOverride = await inspectProviderReadiness({ rootDir: root, processEnv: { TRADING_RISK_STATE_PATH: 'shared/account-ledger.json' } });
    assert.equal(processOverride.paperLedger.status, 'consistent', 'the process environment wins over each dotenv file for every runner');
    assert.ok(Object.values(processOverride.bots).every((row) => row.paperLedgerSettingSource === 'process-environment'));
    assert.equal(JSON.stringify(processOverride).includes('shared/account-ledger.json'), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('stocks shared-paper readiness requires an explicit all-in round-trip fee per share', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omnimod-stocks-paper-costs-'));
  const root = join(base, 'new-bots');
  const stocksEnv = resolve(root, '../stocks-bot/.env');
  try {
    await mkdir(dirname(stocksEnv), { recursive: true });
    await writeFile(stocksEnv, 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD=12500\nSTOCKS_ROUND_TRIP_FEES_PER_SHARE=0\n');
    let readiness = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.equal(readiness.bots.stocks.paperRiskStatus, 'configured-unverified');
    assert.deepEqual(readiness.bots.stocks.missingPaperCostSettings, []);
    assert.equal(readiness.bots.stocks.paperCostAssumptions.find((row) => row.key === 'STOCKS_ROUND_TRIP_FEES_PER_SHARE').status, 'environment');
    await writeFile(stocksEnv, 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD=12500\nSTOCKS_ROUND_TRIP_FEES_PER_SHARE=not-a-number\n');
    readiness = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.equal(readiness.bots.stocks.paperRiskStatus, 'incomplete-cost-assumptions');
    assert.deepEqual(readiness.bots.stocks.missingPaperCostSettings, ['STOCKS_ROUND_TRIP_FEES_PER_SHARE']);
    await writeFile(stocksEnv, 'OMNIMOD_PAPER_ACCOUNT_EQUITY_USD=12500\nSTOCKS_ROUND_TRIP_FEES_PER_SHARE=10.01\n');
    readiness = await inspectProviderReadiness({ rootDir: root, processEnv: {} });
    assert.deepEqual(readiness.bots.stocks.missingPaperCostSettings, ['STOCKS_ROUND_TRIP_FEES_PER_SHARE']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('ledger coordination diagnoses worker path mismatch, incomplete coverage and full alignment', () => {
  const bots = Object.fromEntries(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'].map((bot) => [bot,
    { process: { processes: [{ status: 'running', ledgerFingerprint: '0123456789abcdef' }] } }]));
  assert.equal(summarizeLedgerCoordination(bots, '0123456789abcdef').status, 'aligned');
  bots.options.process.processes[0].ledgerFingerprint = 'fedcba9876543210';
  const mismatch = summarizeLedgerCoordination(bots, '0123456789abcdef');
  assert.equal(mismatch.status, 'mismatch');
  assert.deepEqual(mismatch.mismatchedBotIds, ['options']);
  delete bots.options;
  const partial = summarizeLedgerCoordination(bots, '0123456789abcdef');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingActiveBotIds, ['options']);
});

test('runner heartbeat expires after missed pulses and records graceful stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-heartbeat-'));
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    const activePath = runnerHeartbeatPath('stocks', { directory, pid: 12345, host: 'test-host' });
    await writeFile(activePath, JSON.stringify({ schemaVersion: 1, bot: 'stocks', role: 'service', pid: 12345, host: 'test-host',
      startedAt: new Date(now - 60_000).toISOString(), heartbeatAt: new Date(now - 10_000).toISOString(), processState: 'running',
      emergencyStopActive: true, liveTradingEnabled: false, childPid: 54321, nextScanAt: new Date(now + 30_000).toISOString() }));
    const live = await readRunnerHeartbeatStatus('stocks', { directory, now });
    assert.equal(live.status, 'running');
    assert.equal(live.activeProcesses, 1);
    assert.equal(live.processes[0].emergencyStopActive, true);
    assert.equal(live.processes[0].childPid, 54321);
    assert.ok(live.processes[0].nextScanAt);

    const expired = await readRunnerHeartbeatStatus('stocks', { directory, now: now + 60_000 });
    assert.equal(expired.status, 'stale');
    assert.equal(expired.activeProcesses, 0);
    assert.equal(expired.staleProcesses, 1);

    const heartbeat = createRunnerHeartbeat({ bot: 'forex', directory, role: 'test', intervalMs: 60_000,
      getState: () => ({ emergencyStopActive: true, liveTradingEnabled: false, ledgerFingerprint: '0123456789abcdef', state: 'ready' }) });
    heartbeat.start();
    await heartbeat.update({ state: 'ready' });
    const running = await readRunnerHeartbeatStatus('forex', { directory });
    assert.equal(running.status, 'running');
    await heartbeat.stop();
    const stopped = await readRunnerHeartbeatStatus('forex', { directory });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.processes[0].liveTradingEnabled, false);
    assert.equal(stopped.processes[0].ledgerFingerprint, '0123456789abcdef');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('ETF operator report retains the native evidence scope and rejection details', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-etf-evidence-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'etfs-etps', 'data'); await mkdir(directory, { recursive: true });
  const now = Date.parse('2026-10-02T15:00:00Z');
  const quoteEvidence = { scope: 'detailed_candidate_quotes', feed: 'sip', nativeVerified: 2, executable: 2,
    referenceOnly: 0, evidenceRejections: [{ symbol: 'SPY', reason: 'stock_quote_condition_not_regular' }] };
  const decisionQuotes = { qualification: { inputRows: 2, refreshed: 1, rejected: 1 }, decisions: [{ symbol: 'QQQ', quoteAgeMs: 200 }] };
  const quoteCollectionAges = { afterDetailedData: [{ symbol: 'QQQ', quoteAgeMs: 20100 }] };
  await writeFile(join(directory, 'etfs-etps-scan-diagnostics.jsonl'), JSON.stringify({
    schemaVersion: 1, bot: 'etfs-etps', capturedAt: new Date(now).toISOString(), diagnostics: { quoteEvidence, decisionQuotes, quoteCollectionAges } }) + '\n');
  const report = await collectOperatorReport({ rootDir: root, stocksDataDir: join(root, 'stocks'), cryptoDataDir: join(root, 'crypto'),
    ledgerPath: join(root, 'missing.json'), now });
  assert.deepEqual(report.bots['etfs-etps'].quoteEvidence, quoteEvidence);
  assert.deepEqual(report.bots['etfs-etps'].decisionQuotes, decisionQuotes);
  assert.deepEqual(report.bots['etfs-etps'].quoteCollectionAges, quoteCollectionAges);
});
