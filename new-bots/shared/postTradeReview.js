import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';

const number = (value) => hasExplicitFiniteAmount(value) ? Number(value) : null;
const nonnegative = (value) => hasExplicitNonNegativeFiniteAmount(value) ? Number(value) : null;
const positive = (value) => hasExplicitPositiveFiniteAmount(value) ? Number(value) : null;
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const round = (value, digits = 2) => Number(value.toFixed(digits));

/** Validate modeled after-cost P&L without treating a net-only legacy row as cost evidence. */
export function inspectClosedPaperAccounting(order) {
  const net = number(order?.realizedPnlUsd), gross = number(order?.grossPnlUsd);
  const fees = nonnegative(order?.feesUsd), slippage = nonnegative(order?.slippageUsd);
  const complete = [net, gross, fees, slippage].every((value) => value !== null);
  const accountedNet = complete ? round(gross - fees - slippage) : null;
  const matches = complete ? Math.abs(accountedNet - net) <= 0.02 : null;
  return { status: !complete ? 'missing_breakdown' : matches ? 'reconciled' : 'mismatch',
    costBreakdownComplete: complete, accountingMatches: matches, accountedNetPnlUsd: accountedNet };
}

/** Midpoint-to-executable-side cost observed at both sampled quotes, not an extra P&L deduction. */
export function inspectQuotedCrossing(order) {
  if (!['stop', 'time_exit', 'emergency_stop'].includes(order?.exitReason))
    return { status: 'exit_not_executable_side', costUsd: null };
  const fillBid = nonnegative(order.fillQuote?.bid), fillAsk = nonnegative(order.fillQuote?.ask);
  const exitBid = nonnegative(order.exitQuote?.bid), exitAsk = nonnegative(order.exitQuote?.ask);
  const units = positive(order.units), multiplier = positive(order.multiplier);
  const fillPrice = positive(order.fillPrice), exitPrice = nonnegative(order.exitPrice);
  if ([fillBid, fillAsk, exitBid, exitAsk, units, multiplier, fillPrice, exitPrice].some((value) => value === null)
    || fillAsk < fillBid || exitAsk < exitBid)
    return { status: 'quote_or_size_unavailable', costUsd: null };
  if (!['long', 'short'].includes(order.direction))
    return { status: 'quote_or_size_unavailable', costUsd: null };
  const expectedFill = order.direction === 'long' ? fillAsk : fillBid;
  const expectedExit = order.direction === 'long' ? exitBid : exitAsk;
  const matches = (actual, expected) => Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-9);
  if (!matches(fillPrice, expectedFill) || !matches(exitPrice, expectedExit))
    return { status: 'execution_quote_mismatch', costUsd: null };
  return { status: 'observed_side_quotes',
    costUsd: round(((fillAsk - fillBid) + (exitAsk - exitBid)) * units * multiplier / 2) };
}

/** Describe what a closed paper record proves without assigning a speculative loss cause. */
export function inspectClosedPaperTrade(order) {
  if (order?.status !== 'closed') throw new TypeError('Post-trade review requires a closed paper order.');
  const net = number(order.realizedPnlUsd), gross = number(order.grossPnlUsd);
  const fees = nonnegative(order.feesUsd), slippage = nonnegative(order.slippageUsd);
  const risk = positive(order.riskUsd);
  const accounting = inspectClosedPaperAccounting(order);
  const { costBreakdownComplete, accountingMatches } = accounting;
  const closedAt = time(order.closedAt), filledAt = time(order.filledAt);
  const contextAt = time(order.researchContext?.observedAt);
  const quoteAt = time(order.quoteTime);
  const issuanceContextValid = order.researchContext?.status === 'captured'
    && contextAt !== null && quoteAt !== null && contextAt <= quoteAt + 5_000;
  const features = issuanceContextValid && order.researchContext?.features
    && typeof order.researchContext.features === 'object' && !Array.isArray(order.researchContext.features)
    ? Object.fromEntries(Object.entries(order.researchContext.features)
      .filter(([key, value]) => /^[a-z][a-z0-9_]{0,39}$/i.test(key) && number(value) !== null)
      .slice(0, 24).map(([key, value]) => [key, Number(value)])) : {};
  const quoteSamples = Number.isSafeInteger(order.positionQuoteSampleCount)
    && order.positionQuoteSampleCount > 0 ? order.positionQuoteSampleCount : null;
  const quoteGapMs = nonnegative(order.maxPositionQuoteGapMs);
  const crossing = inspectQuotedCrossing(order);
  const flags = [];
  if (net === null) flags.push('net_result_unavailable');
  else if (net < 0) flags.push('negative_net_result');
  if (!costBreakdownComplete) flags.push('cost_breakdown_incomplete');
  if (accountingMatches === false) flags.push('pnl_accounting_mismatch');
  if (costBreakdownComplete && accountingMatches && gross > 0 && net <= 0) flags.push('costs_reversed_positive_gross');
  if (order.exitReason === 'stop') flags.push('modeled_stop_exit');
  if (order.exitReason === 'time_exit') flags.push('modeled_time_exit');
  if (quoteSamples === null || quoteSamples < 2) flags.push('quote_path_insufficient');
  if (!issuanceContextValid) flags.push('issuance_context_unavailable');
  if (filledAt === null || closedAt === null || closedAt < filledAt) flags.push('trade_timestamps_invalid_or_missing');
  return {
    orderId: String(order.orderId ?? '').slice(0, 80) || null,
    owner: String(order.owner ?? 'unknown').slice(0, 40),
    instrumentKey: String(order.instrumentKey ?? 'unknown').slice(0, 80),
    strategyId: String(order.strategyId ?? 'unknown').slice(0, 100),
    direction: ['long', 'short'].includes(order.direction) ? order.direction : 'unknown',
    closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
    plannedEntryPrice: positive(order.entryPrice), fillPrice: positive(order.fillPrice),
    plannedStopPrice: positive(order.stopPrice), plannedTargetPrice: positive(order.targetPrice),
    exitPrice: number(order.exitPrice),
    timeInTradeMinutes: filledAt !== null && closedAt !== null && closedAt >= filledAt
      ? round((closedAt - filledAt) / 60_000) : null,
    outcome: net === null ? 'ungraded' : net > 0 ? 'win' : net < 0 ? 'loss' : 'scratch',
    netPnlUsd: net, grossPnlUsd: gross, feesUsd: fees, slippageReserveUsd: slippage,
    totalModeledCostsUsd: fees !== null && slippage !== null ? round(fees + slippage) : null,
    netR: net !== null && risk !== null ? round(net / risk, 4) : null,
    exitReason: String(order.exitReason ?? 'unknown').slice(0, 80),
    fillSpreadPct: nonnegative(order.fillQuote?.spreadPct),
    exitSpreadPct: nonnegative(order.exitQuote?.spreadPct),
    observedQuoteCrossingCostUsd: crossing.costUsd,
    quoteCrossingStatus: crossing.status,
    executionPnlBasis: 'Entry and side exits use sampled executable bid/ask; gross P&L already includes quote crossing. Quoted crossing is descriptive and must not be deducted again. Target-limit exits have no side-execution crossing estimate.',
    maxFavorableExcursionUsd: number(order.maxFavorableExcursionUsd),
    maxAdverseExcursionUsd: number(order.maxAdverseExcursionUsd),
    positionQuoteSampleCount: quoteSamples, maxPositionQuoteGapMs: quoteGapMs,
    setupType: issuanceContextValid ? String(order.researchContext.setupType ?? 'unknown').slice(0, 80) : 'unknown',
    marketRegime: issuanceContextValid ? String(order.researchContext.marketRegime ?? 'unknown').slice(0, 80) : 'unknown',
    volatilityRegime: issuanceContextValid ? String(order.researchContext.volatilityRegime ?? 'unknown').slice(0, 80) : 'unknown',
    issuanceContextAt: issuanceContextValid ? new Date(contextAt).toISOString() : null,
    issuanceFeatures: features,
    sourceModelValues: order.approvalEvidence?.sourceValues ?? null,
    modelValuesStatus: order.approvalEvidence?.sourceValuesStatus ?? 'unavailable_in_shared_ledger',
    approvalGateRecordStatus: order.approvalEvidence?.scope === 'shared_paper_risk_gate_only'
      ? 'shared_paper_gate_only' : 'unavailable_in_shared_ledger',
    sharedApprovalEvidence: order.approvalEvidence?.scope === 'shared_paper_risk_gate_only'
      ? order.approvalEvidence : null,
    marketGateTrace: order.approvalEvidence?.marketGateTrace ?? null,
    marketGateTraceStatus: order.approvalEvidence?.marketStrategyGateRecordStatus ?? 'unavailable_in_shared_ledger',
    costBreakdownComplete, accountingMatches, accountingStatus: accounting.status, flags,
    thesisValidity: 'unreviewed', lossCause: net < 0 ? 'unresolved' : 'not_applicable',
    reviewPriority: net === null || net < 0 || accounting.status !== 'reconciled' ? 'high' : 'routine',
    interpretation: 'Flags identify observed paper-record conditions, not the cause of a price move or proof of executable fills.',
  };
}

export function buildPostTradeReview(orders = [], { latestByOrder = {}, diagnostics = null } = {}) {
  const closed = orders.filter((order) => order?.status === 'closed');
  const reviews = closed.map((order) => {
    const observed = inspectClosedPaperTrade(order);
    const assessment = Object.hasOwn(latestByOrder, order.orderId) ? latestByOrder[order.orderId] : null;
    if (!assessment) return observed;
    return { ...observed, reviewId: assessment.reviewId, reviewedAt: assessment.reviewedAt,
      reviewer: assessment.reviewer, thesisValidity: assessment.thesisValidity,
      lossCause: assessment.lossCause, reviewEvidenceBasis: assessment.evidenceBasis,
      reviewEvidenceAsOf: assessment.evidenceAsOf, reviewSourceUrl: assessment.sourceUrl,
      reviewSummary: assessment.summary,
      lossCauseBasis: observed.outcome === 'loss' ? 'manual_operator_assessment' : 'not_applicable' };
  });
  const counts = Object.fromEntries([...new Set(reviews.flatMap((row) => row.flags))].sort()
    .map((flag) => [flag, reviews.filter((row) => row.flags.includes(flag)).length]));
  const needsReview = reviews.filter((row) => !row.reviewId || row.thesisValidity === 'uncertain'
    || row.lossCause === 'undetermined' || row.flags.includes('pnl_accounting_mismatch'));
  needsReview.sort((a, b) => (time(b.closedAt) ?? -Infinity) - (time(a.closedAt) ?? -Infinity));
  const cohorts = new Map();
  for (const row of reviews) {
    const key = `${row.owner}:${row.setupType}`;
    if (!cohorts.has(key)) cohorts.set(key, { closedTrades: 0, losses: 0,
      ungraded: 0, costReversals: 0, sparseQuotePaths: 0, accountingMismatches: 0 });
    const group = cohorts.get(key);
    group.closedTrades++;
    if (row.outcome === 'loss') group.losses++;
    if (row.outcome === 'ungraded') group.ungraded++;
    if (row.flags.includes('costs_reversed_positive_gross')) group.costReversals++;
    if (row.flags.includes('quote_path_insufficient')) group.sparseQuotePaths++;
    if (row.flags.includes('pnl_accounting_mismatch')) group.accountingMismatches++;
  }
  const reviewJournalIssues = diagnostics
    ? Number(diagnostics.invalid || 0) + Number(diagnostics.missingOrChangedOrder || 0)
      + Number(diagnostics.brokenRevisionChain || 0) : null;
  return {
    closedTrades: reviews.length,
    lossCount: reviews.filter((row) => row.outcome === 'loss').length,
    ungradedCount: reviews.filter((row) => row.outcome === 'ungraded').length,
    thesisReviewsCompleted: reviews.filter((row) => Boolean(row.reviewId)).length,
    unresolvedLossCauses: reviews.filter((row) => row.outcome === 'loss'
      && ['unresolved', 'undetermined'].includes(row.lossCause)).length,
    reviewJournalDiagnostics: diagnostics,
    reviewJournalIssues,
    reviewJournalStatus: diagnostics === null ? 'not_loaded'
      : reviewJournalIssues > 0 ? 'needs_attention' : 'read_cleanly',
    observedFlagCounts: counts,
    byBotSetup: Object.fromEntries([...cohorts].sort(([left], [right]) => left.localeCompare(right))),
    reviewQueue: needsReview,
    status: reviews.length ? 'observational_review_needed' : 'no_closed_paper_trades',
    limitation: 'Operator review classifications are attributed assessments, not independently proven causes. The ledger alone cannot establish catalyst shocks, correlated moves, or strategy bugs.',
  };
}
