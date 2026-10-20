import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectOperatorReport, summarizeSharedPaperPortfolio } from './operatorReport.js';
import { readPaperRiskLedger } from './paperRisk.js';
import { resolvePaperLedgerPath } from './paperStatePath.js';
import { hasExplicitFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';
import { buildPostTradeReview, inspectClosedPaperAccounting, inspectQuotedCrossing } from './postTradeReview.js';
import { readPaperTradeReviews, resolvePaperTradeReviewPath } from './paperTradeReviewJournal.js';
import { inspectClosedTradeSequence } from './closedTradeSequence.js';

const BOT_IDS = ['stocks', 'crypto', 'futures', 'forex', 'etfs-etps', 'options'];
const round = (value, digits = 2) => Number(value.toFixed(digits));
const numeric = (value) => hasExplicitFiniteAmount(value) ? Number(value) : null;
const positive = (value) => hasExplicitPositiveFiniteAmount(value) ? Number(value) : null;
const safeTime = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => [key, summarizeTrades(group)]));
}

function compareSetupCohorts(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const context = row.researchContext;
    if (context?.status !== 'captured' || safeTime(context.observedAt) === null
      || !context.setupType || context.setupType === 'unknown') continue;
    const key = `${row.owner || 'unknown'}:${context.setupType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const eligible = [];
  const unranked = [];
  for (const [key, trades] of groups) {
    const summary = summarizeTrades(trades);
    const sessions = new Set(trades.map((row) => safeTime(row.filledAt))
      .filter((time) => time !== null).map((time) => new Date(time).toISOString().slice(0, 10))).size;
    const reasons = [];
    if (trades.length < 30) reasons.push('fewer_than_30_closed_trades');
    if (sessions < 5) reasons.push('fewer_than_5_entry_sessions');
    if (trades.some((row) => safeTime(row.filledAt) === null
      || safeTime(row.researchContext?.observedAt) === null
      || safeTime(row.researchContext.observedAt) > safeTime(row.filledAt)))
      reasons.push('missing_or_post_fill_entry_context');
    if (summary.costedTrades !== trades.length || summary.riskNormalizedTrades !== trades.length
      || summary.netPerformanceStatus !== 'reconciled_after_cost_sample') reasons.push('incomplete_cost_or_risk_evidence');
    if (summary.closeSequenceStatus !== 'complete') reasons.push('incomplete_close_chronology');
    const record = { key, closedTrades: trades.length, entrySessions: sessions,
      expectancyR: summary.expectancyR, maximumClosedTradeDrawdownUsd: summary.maximumClosedTradeDrawdownUsd };
    if (reasons.length) unranked.push({ ...record, reasons });
    else eligible.push(record);
  }
  eligible.sort((a, b) => b.expectancyR - a.expectancyR || a.key.localeCompare(b.key));
  return { status: eligible.length >= 2 ? 'descriptive' : 'insufficient_comparable_cohorts',
    eligibleCohorts: eligible.length, unrankedCohorts: unranked,
    highestObservedExpectancy: eligible.length >= 2 ? eligible[0] : null,
    lowestObservedExpectancy: eligible.length >= 2 ? eligible.at(-1) : null,
    basis: 'Modeled after-cost mean realized R among complete setup cohorts with at least 30 closed trades, five distinct UTC entry dates, point-in-time entry context, explicit risk, and unique close chronology. Descriptive only; no significance, correlation adjustment, or promotion decision.',
  };
}

export function summarizeTrades(rows = []) {
  const trades = rows.filter((row) => row?.status === 'closed');
  const accounting = trades.map(inspectClosedPaperAccounting);
  const costed = trades.filter((_, index) => accounting[index].status === 'reconciled');
  const observedNetCount = trades.filter((row) => numeric(row.realizedPnlUsd) !== null).length;
  const missingBreakdownCount = accounting.filter((row) => row.status === 'missing_breakdown').length;
  const mismatchCount = accounting.filter((row) => row.status === 'mismatch').length;
  const sequence = inspectClosedTradeSequence(trades.map((row, index) =>
    accounting[index].status === 'reconciled' ? row : { ...row, realizedPnlUsd: null }));
  const wins = costed.filter((row) => Number(row.realizedPnlUsd) > 0);
  const losses = costed.filter((row) => Number(row.realizedPnlUsd) < 0);
  const completeNetSample = trades.length > 0 && costed.length === trades.length;
  const netPerformanceStatus = !trades.length ? 'no_closed_sample'
    : observedNetCount !== trades.length ? 'incomplete_net_pnl'
      : mismatchCount ? 'pnl_accounting_mismatch'
        : missingBreakdownCount ? 'incomplete_cost_breakdown' : 'reconciled_after_cost_sample';
  const net = costed.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const grossWin = wins.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const grossLoss = -losses.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const risked = costed.filter((row) => positive(row.riskUsd) !== null);
  const rValues = risked.map((row) => Number(row.realizedPnlUsd) / Number(row.riskUsd));
  const completeSum = (key) => completeNetSample && costed.every((row) => numeric(row[key]) !== null)
    ? round(costed.reduce((sum, row) => sum + Number(row[key]), 0)) : null;
  const averageObserved = (values, digits = 2) => values.length
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length, digits) : null;
  const excursions = costed.filter((row) => numeric(row.maxFavorableExcursionUsd) !== null
    && numeric(row.maxAdverseExcursionUsd) !== null);
  const fillSpreads = costed.map((row) => numeric(row.fillQuote?.spreadPct)).filter((value) => value !== null);
  const exitSpreads = costed.map((row) => numeric(row.exitQuote?.spreadPct)).filter((value) => value !== null);
  const quoteCrossings = costed.map(inspectQuotedCrossing).filter((row) => row.status === 'observed_side_quotes');
  const durations = costed.map((row) => {
    const filled = safeTime(row.filledAt), closed = safeTime(row.closedAt);
    return filled !== null && closed !== null && closed >= filled ? (closed - filled) / 60_000 : null;
  }).filter((value) => value !== null);
  return {
    closedTrades: trades.length, costedTrades: costed.length, netObservedTrades: observedNetCount,
    missingNetPnl: trades.length - observedNetCount, missingCostBreakdown: missingBreakdownCount,
    pnlAccountingMismatches: mismatchCount,
    wins: wins.length, losses: losses.length, scratches: costed.length - wins.length - losses.length,
    winRatePct: completeNetSample ? round(100 * wins.length / costed.length) : null,
    netPnlUsd: completeNetSample ? round(net) : null,
    grossPnlUsd: completeSum('grossPnlUsd'), feesUsd: completeSum('feesUsd'), slippageReserveUsd: completeSum('slippageUsd'),
    netR: completeNetSample && risked.length === costed.length ? round(rValues.reduce((sum, value) => sum + value, 0), 3) : null,
    riskNormalizedTrades: risked.length,
    expectancyUsd: completeNetSample ? round(net / costed.length) : null,
    expectancyR: completeNetSample && risked.length === costed.length ? averageObserved(rValues, 3) : null,
    profitFactor: completeNetSample && grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    profitFactorStatus: !trades.length ? 'no_closed_sample' : !completeNetSample ? netPerformanceStatus
      : grossLoss > 0 ? 'computed' : 'no_losses_observed',
    netPerformanceStatus,
    averageWinnerUsd: completeNetSample ? averageObserved(wins.map((row) => Number(row.realizedPnlUsd))) : null,
    averageLoserUsd: completeNetSample ? averageObserved(losses.map((row) => Number(row.realizedPnlUsd))) : null,
    maximumClosedTradeDrawdownUsd: sequence.maximumDrawdownUsd,
    currentClosedTradeDrawdownUsd: sequence.currentDrawdownUsd,
    maximumConsecutiveLosses: sequence.maximumConsecutiveLosses,
    currentConsecutiveLosses: sequence.currentConsecutiveLosses,
    closeSequenceStatus: sequence.status,
    drawdownTimestampCoverage: sequence.observationCount,
    averageMfeUsd: averageObserved(excursions.map((row) => Number(row.maxFavorableExcursionUsd))),
    averageMaeUsd: averageObserved(excursions.map((row) => Number(row.maxAdverseExcursionUsd))),
    excursionSampleCount: excursions.length,
    averageFillSpreadPct: averageObserved(fillSpreads, 4), fillSpreadSampleCount: fillSpreads.length,
    averageExitSpreadPct: averageObserved(exitSpreads, 4), exitSpreadSampleCount: exitSpreads.length,
    observedQuoteCrossingCostUsd: quoteCrossings.length
      ? round(quoteCrossings.reduce((sum, row) => sum + row.costUsd, 0)) : null,
    quoteCrossingSampleCount: quoteCrossings.length,
    averageTimeInTradeMinutes: averageObserved(durations), durationSampleCount: durations.length,
    exitReasons: Object.fromEntries([...new Set(trades.map((row) => String(row.exitReason || 'unknown')))].sort()
      .map((reason) => [reason, trades.filter((row) => String(row.exitReason || 'unknown') === reason).length])),
    interpretation: 'Descriptive, quote-sampled paper outcomes only; whole-cohort after-cost metrics require every close to have reconciled gross P&L, fees, slippage and net P&L. No statistical significance or live-fill claim.',
  };
}

export function buildResearchDashboard({ ledger = {}, operatorReport = {}, reviewJournal = {}, generatedAt = new Date().toISOString() } = {}) {
  const orders = Array.isArray(ledger.orders) ? ledger.orders : [];
  const portfolio = operatorReport.ledger?.exists === false ? null : summarizeSharedPaperPortfolio(ledger);
  const closed = orders.filter((row) => row?.status === 'closed');
  const entryTime = (row) => safeTime(row?.filledAt);
  const cohort = (row, part) => {
    const time = entryTime(row);
    if (time === null) return 'unknown';
    const date = new Date(time);
    return part === 'hour' ? `${String(date.getUTCHours()).padStart(2, '0')}:00 UTC`
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  };
  const researchCohort = (field) => {
    const hasLabel = (row) => row.researchContext?.status === 'captured'
      && safeTime(row.researchContext.observedAt) !== null
      && typeof row.researchContext[field] === 'string' && row.researchContext[field] !== 'unknown';
    const known = closed.filter(hasLabel);
    return { status: known.length ? 'descriptive' : 'unavailable', knownTradeCount: known.length,
      unknownTradeCount: closed.length - known.length,
      groups: known.length ? groupBy(closed, (row) => hasLabel(row)
        ? `${row.owner || 'unknown'}:${row.researchContext[field]}` : 'unknown') : {},
      basis: 'persisted issuance-time research labels, grouped by primary bot; descriptive and not an approval signal',
    };
  };
  const botRows = Object.fromEntries(BOT_IDS.map((id) => {
    const source = operatorReport.bots?.[id] || {};
    return [id, {
      scanStatus: source.scanStatus || source.status || 'unknown', latestScanAt: source.latestAt || null,
      universe: source.universe || null, marketData: source.marketData || null,
      signalMapping: source.signalMapping || null,
      funnel: source.funnel || null, topRejectionReasons: source.topRejectionReasons || {},
      rejectionScope: 'latest retained scan/instance diagnostic; may not cover all historical candidates',
      performance: summarizeTrades(closed.filter((row) => row.owner === id)),
    }];
  }));
  const postTradeReview = buildPostTradeReview(closed, reviewJournal);
  return {
    schemaVersion: 1, generatedAt, source: 'local shared paper ledger plus latest retained operator scan diagnostics',
    ledgerStatus: operatorReport.ledger?.exists === true ? 'present' : operatorReport.ledger?.exists === false ? 'missing' : 'unverified',
    caveats: [
      'No current account-authenticated market-data or execution verification is implied.',
      'Closed-trade drawdown excludes open-position and between-quote movement.',
      'Whole-cohort net P&L, win rate, expectancy and profit factor are unavailable if any closed order lacks explicit net P&L; observed counts remain visible.',
      'Gross P&L uses sampled fill/exit prices and already includes bid/ask crossing; quoted crossing cost is a midpoint comparison for side exits only and is never deducted again. Target-limit exits have no side-crossing estimate.',
      'Drawdown and loss streaks are unavailable if any closed trade lacks net P&L or a unique close timestamp.',
      'Entry hour and weekday use UTC fill timestamps; rows without them are unknown.',
      'Regime and setup cohorts use labels captured at reservation with a valid candidate timestamp; underlying feature freshness remains each scanner’s responsibility.',
      'Post-trade flags describe ledger observations. Any recorded loss cause is a cited operator assessment, not a proven cause or automatic strategy change.',
      ...(postTradeReview.reviewJournalIssues > 0 ? ['The review journal has invalid, broken or stale records; inspect those rows before relying on review coverage.'] : []),
      'Sharpe, Sortino, market impact, and strategy promotion require sufficiently sampled, timestamped equity and execution data.',
    ],
    workflow: { recordedOrders: orders.length, reserved: orders.filter((row) => row.status === 'reserved').length,
      filledOrOpen: orders.filter((row) => ['filled', 'open'].includes(row.status)).length,
      closed: closed.length, cancelledBeforeFill: orders.filter((row) => row.status === 'cancelled').length },
    openExposure: portfolio ? {
      status: portfolio.activeOrders ? 'descriptive' : 'no_active_positions',
      activeOrders: portfolio.activeOrders, openRiskUsd: portfolio.openRiskUsd,
      openNotionalUsd: portfolio.openNotionalUsd,
      assetClassConcentration: portfolio.assetClassConcentration,
      directionalConcentration: portfolio.directionalConcentration,
    } : { status: 'ledger_missing', activeOrders: null, openRiskUsd: null, openNotionalUsd: null,
      assetClassConcentration: { status: 'ledger_missing', groups: [] },
      directionalConcentration: { status: 'ledger_missing', groups: [] } },
    overall: summarizeTrades(closed), byBot: botRows,
    byStrategy: groupBy(closed, (row) => `${row.owner || 'unknown'}:${row.strategyId || 'unknown'}`),
    byInstrument: groupBy(closed, (row) => `${row.owner || 'unknown'}:${row.instrumentKey || 'unknown'}`),
    byEntryHourUtc: groupBy(closed, (row) => cohort(row, 'hour')),
    byEntryWeekdayUtc: groupBy(closed, (row) => cohort(row, 'weekday')),
    bySetupType: researchCohort('setupType'),
    setupComparison: compareSetupCohorts(closed),
    byMarketRegime: researchCohort('marketRegime'),
    byVolatilityRegime: researchCohort('volatilityRegime'),
    postTradeReview,
  };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const display = (value) => value === null || value === undefined ? 'Unavailable' : String(value);
const cell = (value) => `<td>${escapeHtml(display(value))}</td>`;

export function renderResearchDashboardHtml(report) {
  const metrics = [
    ['Open paper risk (USD)', report.openExposure?.openRiskUsd],
    ['Open ledger notional (USD)', report.openExposure?.openNotionalUsd],
    ['Closed trades', report.overall.closedTrades], ['Gross P&L after quote crossing (USD)', report.overall.grossPnlUsd],
    ['Net P&L (USD)', report.overall.netPnlUsd], ['Net evidence status', report.overall.netPerformanceStatus],
    ['Net R', report.overall.netR], ['Win rate (%)', report.overall.winRatePct],
    ['Expectancy (USD)', report.overall.expectancyUsd], ['Profit factor', report.overall.profitFactor],
    ['Max closed-trade drawdown (USD)', report.overall.maximumClosedTradeDrawdownUsd],
    ['Current closed-trade drawdown (USD)', report.overall.currentClosedTradeDrawdownUsd],
    ['Maximum consecutive losses', report.overall.maximumConsecutiveLosses],
    ['Current consecutive losses', report.overall.currentConsecutiveLosses],
    ['Close-sequence status', report.overall.closeSequenceStatus],
    ['Average winner (USD)', report.overall.averageWinnerUsd], ['Average loser (USD)', report.overall.averageLoserUsd],
    ['Average sampled MFE (USD)', report.overall.averageMfeUsd], ['Average sampled MAE (USD)', report.overall.averageMaeUsd],
    ['Fees (USD)', report.overall.feesUsd], ['Slippage reserve (USD)', report.overall.slippageReserveUsd],
    ['Average fill spread (%)', report.overall.averageFillSpreadPct],
    ['Average exit spread (%)', report.overall.averageExitSpreadPct],
    ['Observed quote crossing (USD; side exits only)', report.overall.observedQuoteCrossingCostUsd],
    ['Quote crossing sample', report.overall.quoteCrossingSampleCount],
    ['Average time in trade (min)', report.overall.averageTimeInTradeMinutes],
    ['Thesis reviews recorded', report.postTradeReview.thesisReviewsCompleted],
    ['Review journal issues', report.postTradeReview.reviewJournalIssues],
    ['Unresolved loss causes', report.postTradeReview.unresolvedLossCauses],
    ['Cost-reversed gross gains', report.postTradeReview.observedFlagCounts.costs_reversed_positive_gross ?? 0],
  ];
  const table = (title, entries) => `<section><h2>${escapeHtml(title)}</h2><div class="table-wrap"><table><thead><tr><th>Group</th><th>Trades</th><th>Net USD</th><th>Expectancy USD</th><th>Win %</th><th>Profit factor</th><th>Max DD USD</th></tr></thead><tbody>${Object.entries(entries).map(([key, row]) => `<tr><th>${escapeHtml(key)}</th>${cell(row.closedTrades)}${cell(row.netPnlUsd)}${cell(row.expectancyUsd)}${cell(row.winRatePct)}${cell(row.profitFactor)}${cell(row.maximumClosedTradeDrawdownUsd)}</tr>`).join('') || '<tr><td colspan="7">No closed paper trades</td></tr>'}</tbody></table></div></section>`;
  const cohortTable = (title, cohort) => cohort.status === 'unavailable'
    ? `<section><h2>${escapeHtml(title)}</h2><p>Unavailable: no closed trade has a timestamped issuance-time label.</p></section>`
    : `${table(title, cohort.groups)}<p>${escapeHtml(cohort.knownTradeCount)} labeled; ${escapeHtml(cohort.unknownTradeCount)} unknown. Descriptive only.</p>`;
  const funnelCounts = (value, prefix = '') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([key, entry]) => {
      const label = prefix ? `${prefix}.${key}` : key;
      if (entry !== null && typeof entry === 'number' && Number.isFinite(entry)) return [`${label}: ${entry}`];
      return prefix.split('.').length < 4 ? funnelCounts(entry, label) : [];
    });
  };
  const byBot = Object.fromEntries(BOT_IDS.map((id) => [id, report.byBot[id].performance]));
  const gateRows = BOT_IDS.map((id) => {
    const row = report.byBot[id];
    const reasons = Object.entries(row.topRejectionReasons).map(([key, count]) => `${key}: ${count}`);
    const funnel = [
      ...funnelCounts(row.universe, 'universe'),
      ...funnelCounts(row.signalMapping, 'signalMapping'),
      ...funnelCounts(row.marketData, 'marketData'),
      ...funnelCounts(row.funnel, 'funnel'),
    ];
    return `<tr><th>${escapeHtml(id)}</th>${cell(row.scanStatus)}${cell(row.latestScanAt)}<td>${escapeHtml(reasons.join(' · ') || 'Unavailable')}</td><td>${funnel.length ? `<details><summary>${funnel.length} observed fields</summary>${funnel.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}</details>` : 'Unavailable'}</td></tr>`;
  }).join('');
  const reviewRows = report.postTradeReview.reviewQueue.slice(0, 50).map((row) => `<tr><th>${escapeHtml(row.owner)} · ${escapeHtml(row.instrumentKey)}</th>${cell(row.orderId)}${cell(row.closedAt)}${cell(row.netPnlUsd)}${cell(row.netR)}${cell(row.exitReason)}${cell(row.reviewPriority)}<td>${escapeHtml(row.flags.join(' · ') || 'None')}</td><td>${escapeHtml(row.lossCause)}</td></tr>`).join('');
  const reviewSection = `<section><h2>Post-trade review queue</h2><p>${escapeHtml(report.postTradeReview.reviewQueue.length)} closed paper records still need review or carry an unresolved finding; showing up to 50 latest. Full price levels, issuance features and cited operator assessments are in the JSON report. Observed flags are not causal findings.</p><div class="table-wrap"><table><thead><tr><th>Bot · Instrument</th><th>Order ID</th><th>Closed</th><th>Net USD</th><th>Net R</th><th>Exit</th><th>Priority</th><th>Observed flags</th><th>Cause / operator assessment</th></tr></thead><tbody>${reviewRows || '<tr><td colspan="9">No review records</td></tr>'}</tbody></table></div></section>`;
  const reviewCohortRows = Object.entries(report.postTradeReview.byBotSetup).map(([name, row]) => `<tr><th>${escapeHtml(name)}</th>${cell(row.closedTrades)}${cell(row.losses)}${cell(row.ungraded)}${cell(row.costReversals)}${cell(row.sparseQuotePaths)}${cell(row.accountingMismatches)}</tr>`).join('');
  const reviewCohorts = `<section><h2>Observed review flags by bot and setup</h2><p>Descriptive counts only; small samples cannot establish a setup effect or failure cause.</p><div class="table-wrap"><table><thead><tr><th>Bot · Setup</th><th>Closed</th><th>Losses</th><th>Ungraded</th><th>Cost reversals</th><th>Sparse quote paths</th><th>P&L mismatches</th></tr></thead><tbody>${reviewCohortRows || '<tr><td colspan="7">No closed paper trades</td></tr>'}</tbody></table></div></section>`;
  const setupComparison = report.setupComparison.status === 'descriptive'
    ? `<section><h2>Observed setup expectancy</h2><p>Highest: ${escapeHtml(report.setupComparison.highestObservedExpectancy.key)} (${escapeHtml(report.setupComparison.highestObservedExpectancy.expectancyR)} R, ${escapeHtml(report.setupComparison.highestObservedExpectancy.closedTrades)} trades). Lowest: ${escapeHtml(report.setupComparison.lowestObservedExpectancy.key)} (${escapeHtml(report.setupComparison.lowestObservedExpectancy.expectancyR)} R, ${escapeHtml(report.setupComparison.lowestObservedExpectancy.closedTrades)} trades). ${escapeHtml(report.setupComparison.basis)}</p></section>`
    : `<section><h2>Observed setup expectancy</h2><p>Unavailable: fewer than two complete setup cohorts meet the minimum observation coverage. ${escapeHtml(report.setupComparison.basis)}</p></section>`;
  const openExposureTable = (title, concentration, groupKey) => {
    const rows = concentration?.groups || [];
    return `<section><h2>${escapeHtml(title)}</h2><p>Status: ${escapeHtml(concentration?.status || 'unavailable')}. ${escapeHtml(concentration?.basis || 'No ledger evidence available.')}</p><div class="table-wrap"><table><thead><tr><th>Group</th><th>Active</th><th>Reserved</th><th>Open / filled</th><th>Risk USD</th><th>Ledger notional USD</th><th>Missing risk</th><th>Missing notional</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${escapeHtml(row[groupKey])}</th>${cell(row.activeOrders)}${cell(row.reservedOrders)}${cell(row.filledOrOpenOrders)}${cell(row.openRiskUsd)}${cell(row.grossNotionalUsd)}${cell(row.riskMetadataMissing)}${cell(row.notionalMetadataMissing)}</tr>`).join('') || '<tr><td colspan="8">No active paper positions with verified ledger evidence</td></tr>'}</tbody></table></div></section>`;
  };
  const openExposureSection = `<section><h2>Open paper exposure</h2><p>Status: ${escapeHtml(report.openExposure?.status || 'unavailable')}. Active reservations and positions: ${escapeHtml(display(report.openExposure?.activeOrders))}. Totals are gross and never receive hedge, delta, or correlation credit.</p></section>${openExposureTable('Risk by asset class', report.openExposure?.assetClassConcentration, 'assetClass')}${openExposureTable('Underlying long / short concentration', report.openExposure?.directionalConcentration, 'direction')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OmniMod paper research dashboard</title><style>
  body{margin:0;background:#10121b;color:#eef0fa;font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1250px;margin:auto;padding:38px 22px 80px}h1{font-size:clamp(28px,4vw,48px);margin:0}h2{margin:38px 0 12px;font-size:21px}p{color:#b8bfd2}.eyebrow{color:#a48cff;text-transform:uppercase;letter-spacing:.18em;font-size:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:28px 0}.card{padding:18px;background:#1c2030;border:1px solid #333a53;border-radius:12px}.card span{display:block;color:#b8bfd2;font-size:12px}.card strong{display:block;font-size:25px;margin-top:7px}.table-wrap{overflow-x:auto;border:1px solid #333a53;border-radius:12px}table{border-collapse:collapse;min-width:730px;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #30364a;vertical-align:top}thead{background:#20263a}tbody tr:nth-child(even){background:#171c2b}ul{padding-left:20px;color:#c8cde0}.warning{background:#302619;border-left:4px solid #e2a84e;padding:13px 18px;border-radius:8px}details div{font:12px/1.5 ui-monospace,monospace;white-space:nowrap}
  </style></head><body><main><div class="eyebrow">Local paper research · ${escapeHtml(report.generatedAt)}</div><h1>OmniMod research dashboard</h1><p class="warning">This is descriptive paper evidence, not a live execution record or profitability claim. Ledger: ${escapeHtml(report.ledgerStatus)}. Missing fields remain unavailable.</p><div class="cards">${metrics.map(([name, value]) => `<div class="card"><span>${escapeHtml(name)}</span><strong>${escapeHtml(display(value))}</strong></div>`).join('')}</div><p>Workflow: ${escapeHtml(report.workflow.recordedOrders)} recorded orders · ${escapeHtml(report.workflow.reserved)} reserved · ${escapeHtml(report.workflow.filledOrOpen)} open/filled · ${escapeHtml(report.workflow.closed)} closed · ${escapeHtml(report.workflow.cancelledBeforeFill)} cancelled before fill.</p>${openExposureSection}${table('By bot', byBot)}${table('By strategy', report.byStrategy)}${table('By instrument', report.byInstrument)}${table('By entry hour (UTC)', report.byEntryHourUtc)}${table('By entry weekday (UTC)', report.byEntryWeekdayUtc)}${cohortTable('By setup type', report.bySetupType)}${setupComparison}${cohortTable('By market regime', report.byMarketRegime)}${cohortTable('By volatility regime', report.byVolatilityRegime)}${reviewCohorts}${reviewSection}<section><h2>Latest scan gates</h2><div class="table-wrap"><table><thead><tr><th>Bot</th><th>Scan status</th><th>Latest scan</th><th>Top rejection reasons</th><th>Observed scan fields</th></tr></thead><tbody>${gateRows}</tbody></table></div><p>Counts describe the latest retained scan diagnostics, including upstream discovery when present; they are not full-history totals or additive unique-opportunity counts.</p></section><section><h2>Evidence limits</h2><ul>${report.caveats.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section></main></body></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = process.argv[2] ? resolve(process.argv[2]) : null;
    const ledgerPath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || '');
    const [ledger, operatorReport] = await Promise.all([
      readPaperRiskLedger({ statePath: ledgerPath }), collectOperatorReport({ ledgerPath }),
    ]);
    const reviewJournal = await readPaperTradeReviews({
      journalPath: resolvePaperTradeReviewPath(ledgerPath), orders: ledger.orders,
    });
    const report = buildResearchDashboard({ ledger, operatorReport, reviewJournal });
    if (target) {
      await writeFile(target, renderResearchDashboardHtml(report), 'utf8');
      console.log(`Wrote read-only paper research dashboard: ${target}`);
    } else console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`Research dashboard failed: ${error.message}`); process.exitCode = 1; }
}
