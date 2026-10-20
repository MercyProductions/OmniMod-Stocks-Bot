import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPaperRiskLock, readPaperRiskLedger, summarizeClosedTradeCircuit, summarizePendingFillRisk } from './paperRisk.js';
import { readScanDiagnosticRows } from './scanDiagnosticsJournal.js';
import { readRunnerHeartbeatStatus } from './runnerHeartbeat.js';
import { paperLedgerFingerprint, resolvePaperLedgerPath } from './paperStatePath.js';
import { inspectProviderReadiness } from './providerReadiness.js';
import { alpacaBudgetConfiguration, inspectAlpacaSharedBudget } from './alpacaSharedBudget.js';
import { tradierBudgetConfiguration, inspectTradierSharedBudget } from './tradierSharedBudget.js';
import { canonicalExposureKey, canonicalExposureKeys, effectiveExposureDirection } from './exposureAliases.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';
import { inspectClosedTradeSequence } from './closedTradeSequence.js';
import { inspectClosedPaperAccounting } from './postTradeReview.js';
import { readPaperPositionMonitorReport } from './paperPositionMonitor.js';
import { resolveOperatorDataLocations } from './operatorDataPaths.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BOT_IDS = ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'];
const DEFAULT_OPEN_MARK_MAX_AGE_MS = 5 * 60_000;

async function readLines(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* Skip torn or malformed rows. */ }
  }
  return rows;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readStockRows(dataDir) {
  const directory = join(dataDir, 'research', 'diagnostics');
  const files = (await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-45);
  const rows = [];
  for (const name of files) rows.push(...(await readLines(join(directory, name))).filter((row) => row.recordType === 'scan_diagnostic'));
  return rows;
}

async function readCryptoRows(dataDir) {
  const names = (await readdir(dataDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith('scan-diagnostic-') && name.endsWith('.json')).sort().slice(-500);
  const rows = [];
  for (const name of names) {
    const row = await readJson(join(dataDir, name));
    if (row) rows.push(row);
  }
  return rows;
}

function latestPerInstance(rows, timestampOf) {
  const latest = new Map();
  for (const row of rows) {
    const instance = String(row.guildId || row.instanceId || 'default');
    const time = Date.parse(timestampOf(row) || '');
    if (!Number.isFinite(time)) continue;
    if (!latest.has(instance) || time > Date.parse(timestampOf(latest.get(instance)))) latest.set(instance, row);
  }
  return [...latest.values()];
}

function summarizeLedgerEquityAnchor(ledger = {}) {
  const valid = (value) => hasExplicitPositiveFiniteAmount(value);
  const differs = (left, right) => Math.abs(left - right) > Math.max(0.01, Math.max(left, right) * 1e-9);
  if (Object.hasOwn(ledger, 'accountEquityUsd')) return valid(ledger.accountEquityUsd)
    ? { status: 'anchored', value: Number(ledger.accountEquityUsd) } : { status: 'invalid_anchor' };
  const values = (ledger.orders || []).map((order) => order?.accountEquityUsd).filter(valid).map(Number);
  if (!values.length) return { status: 'unanchored' };
  if (values.some((value) => differs(values[0], value))) return { status: 'history_conflict' };
  return { status: 'legacy_inferred', value: values[0] };
}

function sumFields(rows, fields) {
  return Object.fromEntries(fields.map((key) => {
    const values = rows.map((row) => row?.[key]);
    const observed = values.filter((value) => value !== null && value !== undefined && value !== ''
      && Number.isFinite(Number(value)) && Number(value) >= 0).map(Number);
    return [key, observed.length === rows.length && rows.length > 0 ? observed.reduce((sum, value) => sum + value, 0) : null];
  }));
}

function averageObservedDuration(rows, key) {
  const values = rows.map((row) => row?.[key]).filter((value) => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0).map(Number);
  return { averageDurationMs: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null,
    durationSamples: values.length };
}

function mergeCounts(rows) {
  const result = {};
  for (const row of rows) for (const [key, count] of Object.entries(row || {})) result[key] = (result[key] || 0) + (Number(count) || 0);
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10));
}

function mergeProviderRows(rows) {
  const result = new Map();
  for (const row of rows) for (const provider of Array.isArray(row) ? row
    : Object.entries(row || {}).map(([name, metrics]) => ({ provider: name, ...metrics }))) {
    const current = result.get(provider.provider) || { requests: 0, failures: 0, rateLimits: 0, retries: 0, weightedLatencyMs: 0, latencyRequests: 0, rateLimitUtilization: null };
    const requests = Number(provider.requests) || 0;
    current.requests += requests;
    current.failures += Number(provider.failures) || 0;
    current.rateLimits += Number(provider.rateLimits) || 0;
    current.retries += Number(provider.retries) || 0;
    if (Number.isFinite(Number(provider.averageLatencyMs)) && requests > 0) {
      current.weightedLatencyMs += Number(provider.averageLatencyMs) * requests;
      current.latencyRequests += requests;
    }
    if (provider.rateLimitUtilization != null) current.rateLimitUtilization = Number(provider.rateLimitUtilization);
    result.set(provider.provider, current);
  }
  return [...result.entries()].map(([provider, row]) => ({ provider, ...row,
    averageLatencyMs: row.latencyRequests ? Number((row.weightedLatencyMs / row.latencyRequests).toFixed(1)) : null,
    rateLimitStatus: row.rateLimitUtilization == null ? 'unknown' : 'reported by provider',
  })).map(({ weightedLatencyMs, latencyRequests, ...row }) => row);
}

function scanQuotaEntries(bot, row) {
  if (bot === 'stocks') return (row.providers || []).flatMap((provider) => provider.latestRateLimit
    ? [{ name: provider.provider, quota: provider.latestRateLimit, requests: provider.requests, failures: provider.failures }]
    : []);
  if (bot === 'crypto') return Object.entries(row.providers || {}).flatMap(([name, provider]) => provider.rateLimit
    ? [{ name, quota: provider.rateLimit, requests: provider.requests, failures: provider.failures }]
    : []);
  const provider = row.diagnostics?.provider;
  if (bot === 'forex' && provider?.rateLimitEstimate) return [{ name: 'OANDA practice', quota: {
    utilizationPct: provider.rateLimitEstimate.utilizationPct,
    peakRequestsPerSecond: provider.rateLimitEstimate.peakRequestsPerSecond,
    documentedRequestsPerSecondLimit: provider.rateLimitEstimate.documentedRequestsPerSecondLimit,
  }, requests: provider.requests, failures: provider.failures }];
  if (bot === 'options' && provider?.rateLimit) return [{ name: 'Tradier', quota: provider.rateLimit, requests: provider.requests, failures: provider.failures }];
  if (bot === 'etfs-etps') return Object.entries(provider?.byEndpoint || {}).flatMap(([name, endpoint]) => endpoint.latestRateLimit
    ? [{ name, quota: endpoint.latestRateLimit, requests: endpoint.requests, failures: endpoint.failures }]
    : []);
  return [];
}

function summarizeProviderQuotaHistory(bot, rows, timestampOf) {
  const groups = new Map();
  for (const row of rows) {
    const capturedAt = timestampOf(row) || null;
    for (const item of scanQuotaEntries(bot, row)) {
      const group = groups.get(item.name) || { scanSamples: 0, quotaSamples: 0, utilizationTotal: 0,
        peakUtilizationPct: null, latestUtilizationPct: null, latestAt: null, latestQuota: null };
      group.scanSamples += 1;
      const quota = item.quota || {};
      const rawUtilization = quota.utilizationPct ?? quota.utilization;
      const value = Number(rawUtilization);
      const utilizationPct = Number.isFinite(value) ? (quota.utilizationPct == null && value <= 1 ? value * 100 : value) : null;
      if (utilizationPct !== null) {
        group.quotaSamples += 1;
        group.utilizationTotal += utilizationPct;
        group.peakUtilizationPct = group.peakUtilizationPct === null ? utilizationPct : Math.max(group.peakUtilizationPct, utilizationPct);
      }
      if (!group.latestAt || Date.parse(capturedAt || '') >= Date.parse(group.latestAt)) {
        group.latestAt = capturedAt;
        group.latestUtilizationPct = utilizationPct;
        group.latestQuota = quota;
      }
      groups.set(item.name, group);
    }
  }
  return Object.fromEntries([...groups].map(([name, group]) => [name, {
    scanSamples: group.scanSamples, quotaSamples: group.quotaSamples,
    averageUtilizationPct: group.quotaSamples ? Number((group.utilizationTotal / group.quotaSamples).toFixed(2)) : null,
    peakUtilizationPct: group.peakUtilizationPct,
    latestUtilizationPct: group.latestUtilizationPct,
    latestAt: group.latestAt, latestQuota: group.latestQuota,
  }]));
}

function reportedSafety(bot, rows, observedAt) {
  const states = rows.map((row) => {
    if (bot === 'stocks') return row.sharedPaperEmergencyStop;
    if (bot === 'crypto') {
      const status = String(row.diagnostics?.sharedPaperStatus || '');
      if (/emergency stop active/i.test(status)) return true;
      if (/paper monitoring active/i.test(status)) return false;
      return null;
    }
    return row.diagnostics?.safety?.emergencyStopActive;
  }).filter((value) => typeof value === 'boolean');
  const distinct = [...new Set(states)];
  const emergencyStop = distinct.length > 1 ? 'mixed' : distinct.length === 1 ? (distinct[0] ? 'active' : 'inactive') : 'unknown';
  const liveStates = rows.map((row) => bot === 'stocks' || bot === 'crypto'
    ? false : row.diagnostics?.safety?.liveTradingEnabled).filter((value) => typeof value === 'boolean');
  const liveTrading = liveStates.length && liveStates.every((value) => value === false) ? 'disabled'
    : liveStates.some(Boolean) ? 'enabled (unexpected; inspect runner)' : 'unknown';
  const liveRequests = rows.map((row) => bot === 'stocks' ? row.liveTradingRequested
    : bot === 'crypto' ? row.diagnostics?.liveTradingRequested
      : row.diagnostics?.safety?.liveTradingRequested).filter((value) => typeof value === 'boolean');
  const liveTradingRequest = !liveRequests.length ? 'unknown'
    : liveRequests.some(Boolean) ? 'requested-but-blocked' : 'not-requested';
  return { emergencyStop, liveTrading, liveTradingRequest, scansReportingEmergencyStop: states.length, observedAt,
    scope: 'last scan observation; not a live process heartbeat' };
}

function summarizeByBot(bot, rows, { now, staleAfterMs }) {
  const timeOf = (row) => bot === 'stocks' ? row.completedAt || row.startedAt
    : bot === 'crypto' ? row.generatedAt
      : row.capturedAt;
  const latest = latestPerInstance(rows, timeOf);
  const providerQuotaHistory = summarizeProviderQuotaHistory(bot, rows, timeOf);
  if (!latest.length) return { status: 'no-scan-data', instances: 0, scansRetained: rows.length, latestAt: null, ageMs: null, providerQuotaHistory,
    lastScanSafety: { emergencyStop: 'unknown', liveTrading: 'unknown', liveTradingRequest: 'unknown', scansReportingEmergencyStop: 0, observedAt: null, scope: 'no scan observation available' } };
  const at = latest.map((row) => timeOf(row)).filter(Boolean).sort().at(-1);
  const ageMs = Math.max(0, now - Date.parse(at));
  if (bot === 'stocks') {
    return {
      status: ageMs <= staleAfterMs ? 'fresh' : 'stale', instances: latest.length, scansRetained: rows.length, latestAt: at, ageMs,
      lastScanSafety: reportedSafety(bot, latest, at),
      funnel: {
        ...sumFields(latest, ['universeSize', 'requestedMarketContext', 'requestedNonContext', 'successfullyScanned', 'scannedMarketContext', 'scannedNonContext', 'missingMarketContext', 'missingNonContext', 'unexpectedReturned', 'skipped', 'discoveryCandidates', 'ownershipExcluded', 'candidateFilterPassed', 'technicalQualified', 'confirmed', 'pendingConfirmation', 'modelApproved', 'riskRejected', 'setups', 'staleRejections', 'providerFailures']),
      },
      ...averageObservedDuration(latest, 'durationMs'),
      providers: mergeProviderRows(latest.map((row) => row.providers)),
      providerQuotaHistory,
      topRejectionReasons: mergeCounts(latest.map((row) => row.topRejectionReasons)),
      sharedPaperQuoteEvidence: latest.map((row) => row.sharedPaperQuoteEvidence || null),
      sharedPaperQuoteRefresh: latest.map((row) => row.sharedPaperQuoteRefresh || null),
      sharedPaperMarkDiagnostics: latest.map((row) => row.sharedPaperMarkDiagnostics || null),
      forwardShadow: latest.map((row) => row.forwardShadow || []).filter((rows) => rows.length),
    };
  }
  if (bot === 'crypto') {
    const funnels = latest.map((row) => row.funnel || {});
    const fields = ['universe', 'nonStable', 'rankPassed', 'liquidityPassed', 'scorePassed', 'trendPassed', 'discoveryQualified', 'deepAnalysisCap', 'deepAnalysisSymbols', 'confirmationPassed', 'modelApproved', 'riskSelected', 'setupsProposed', 'setupsPosted', 'deliveryFailures', 'riskRejections', 'dailyCapacityRejections'];
    return {
      status: ageMs <= staleAfterMs ? 'fresh' : 'stale', instances: latest.length, scansRetained: rows.length, latestAt: at, ageMs,
      lastScanSafety: reportedSafety(bot, latest, at),
      funnel: sumFields(funnels, fields),
      // Keep provider membership per instance. Summing identical directories
      // across guilds would falsely multiply the unique asset universe.
      universeCoverage: latest.map((row) => row.universeCoverage || null),
      venueResearch: latest.map((row) => row.venueResearch || null),
      sharedPaperQuoteIdentity: latest.map((row) => row.diagnostics?.sharedPaperQuoteIdentity || null),
      sharedPaperMarkDiagnostics: latest.map((row) => row.diagnostics?.sharedPaperMarkDiagnostics || null),
      ...averageObservedDuration(latest, 'totalDurationMs'),
      providers: mergeProviderRows(latest.map((row) => row.providers)),
      providerQuotaHistory,
      topRejectionReasons: mergeCounts(funnels.map((row) => row.topRejectionReasons)),
      portfolioCorrelation: latest.map((row) => row.diagnostics?.portfolioCorrelation || null).filter(Boolean),
      forwardShadow: latest.map((row) => row.diagnostics?.forwardShadow || []).filter((rows) => rows.length),
    };
  }
  const latestRow = latest.sort((a, b) => Date.parse(timeOf(a)) - Date.parse(timeOf(b))).at(-1);
  const diagnostics = latestRow.diagnostics || {};
  const nested = diagnostics.funnel || diagnostics;
  return {
    status: ageMs <= staleAfterMs ? 'fresh' : 'stale', instances: latest.length, scansRetained: rows.length, latestAt: at, ageMs,
    lastScanSafety: reportedSafety(bot, latest, at),
    source: diagnostics.source ?? null,
    universe: diagnostics.universe ?? nested.universe ?? nested.contextUniverse ?? null,
    marketData: diagnostics.marketData ?? nested.marketData ?? null,
    marketDataReadiness: diagnostics.marketDataReadiness ?? nested.marketDataReadiness ?? null,
    signalMapping: bot === 'options' ? diagnostics.signalMapping ?? nested.signalMapping ?? null : null,
    quoteEvidence: bot === 'etfs-etps' ? diagnostics.quoteEvidence ?? nested.quoteEvidence ?? null : null,
    decisionQuotes: ['etfs-etps', 'forex', 'options'].includes(bot) ? diagnostics.decisionQuotes ?? nested.decisionQuotes ?? null : null,
    decisionTiming: bot === 'futures' ? diagnostics.decisionTiming ?? nested.decisionTiming ?? null : null,
    quoteCollectionAges: bot === 'etfs-etps' ? diagnostics.quoteCollectionAges ?? nested.quoteCollectionAges ?? null : null,
    funnel: nested,
    lifecycle: bot === 'futures'
      ? diagnostics.contractLifecycleDiagnostics ?? nested.contractLifecycleDiagnostics ?? null
      : bot === 'options' ? diagnostics.optionExpiryDiagnostics ?? nested.optionExpiryDiagnostics ?? null : null,
    provider: diagnostics.provider || nested.provider || null,
    providerQuotaHistory,
    topRejectionReasons: diagnostics.topRejectionReasons || nested.topRejectionReasons || {},
    forwardShadow: diagnostics.forwardShadow ?? nested.forwardShadow ?? [],
    elapsedMs: diagnostics.elapsedMs ?? diagnostics.scanDurationMs ?? null,
  };
}

function summarizeClosedPerformance(rows) {
  const allClosed = rows.filter((row) => row?.status === 'closed');
  const accounting = allClosed.map(inspectClosedPaperAccounting);
  const reconciledCount = accounting.filter((row) => row.status === 'reconciled').length;
  const missingBreakdownCount = accounting.filter((row) => row.status === 'missing_breakdown').length;
  const mismatchCount = accounting.filter((row) => row.status === 'mismatch').length;
  const completeAfterCostSample = reconciledCount === allClosed.length;
  const sequence = inspectClosedTradeSequence(allClosed.map((row, index) =>
    accounting[index].status === 'reconciled' ? row : { ...row, realizedPnlUsd: null }));
  const closed = rows.filter((row) => row?.status === 'closed' && hasExplicitFiniteAmount(row.realizedPnlUsd));
  const wins = closed.filter((row) => Number(row.realizedPnlUsd) > 0);
  const losses = closed.filter((row) => Number(row.realizedPnlUsd) < 0);
  const grossWins = wins.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const grossLosses = Math.abs(losses.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0));
  const net = closed.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const average = (group) => group.length ? Number((group.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0) / group.length).toFixed(2)) : null;
  const withQuoteCoverage = closed.filter((row) => Number.isSafeInteger(Number(row.positionQuoteSampleCount))
    && Number(row.positionQuoteSampleCount) > 0 && Number.isFinite(Number(row.maxPositionQuoteGapMs)) && Number(row.maxPositionQuoteGapMs) >= 0);
  const averageField = (group, key) => group.length ? Number((group.reduce((sum, row) => sum + Number(row[key]), 0) / group.length).toFixed(2)) : null;
  const riskNormalized = closed.filter((row) => Number.isFinite(Number(row.riskUsd)) && Number(row.riskUsd) > 0)
    .map((row) => Number(row.realizedPnlUsd) / Number(row.riskUsd));
  return {
    sampleSize: closed.length,
    reconciledAfterCostCount: reconciledCount, missingCostBreakdownCount: missingBreakdownCount,
    pnlAccountingMismatchCount: mismatchCount,
    costAccountingStatus: !allClosed.length ? 'no_closed_sample' : completeAfterCostSample
      ? 'reconciled_after_cost_sample' : mismatchCount ? 'pnl_accounting_mismatch' : 'incomplete_cost_breakdown',
    wins: wins.length,
    losses: losses.length,
    breakeven: closed.length - wins.length - losses.length,
    winRatePct: completeAfterCostSample && closed.length ? Number((wins.length / closed.length * 100).toFixed(2)) : null,
    averageWinUsd: completeAfterCostSample ? average(wins) : null,
    averageLossUsd: completeAfterCostSample ? average(losses) : null,
    netPnlUsd: completeAfterCostSample ? Number(net.toFixed(2)) : null,
    expectancyUsd: completeAfterCostSample && closed.length ? Number((net / closed.length).toFixed(2)) : null,
    profitFactor: completeAfterCostSample && grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(3)) : null,
    profitFactorStatus: !closed.length ? 'no_closed_sample' : !completeAfterCostSample ? 'incomplete_cost_accounting'
      : grossLosses > 0 ? 'computed' : 'no_losses_observed',
    averageRealizedR: completeAfterCostSample && riskNormalized.length
      ? Number((riskNormalized.reduce((sum, value) => sum + value, 0) / riskNormalized.length).toFixed(3)) : null,
    realizedRSampleSize: riskNormalized.length,
    tradeSequenceDrawdownUsd: sequence.maximumDrawdownUsd,
    currentClosedTradeDrawdownUsd: sequence.currentDrawdownUsd,
    maximumConsecutiveLosses: sequence.maximumConsecutiveLosses,
    currentConsecutiveLosses: sequence.currentConsecutiveLosses,
    drawdownObservationCount: sequence.observationCount,
    closeSequenceStatus: sequence.status,
    drawdownBasis: 'complete uniquely ordered closed-trade net P&L; excludes open and intratrade drawdown',
    positionQuoteCoverageCount: withQuoteCoverage.length,
    averagePositionQuoteSamples: averageField(withQuoteCoverage, 'positionQuoteSampleCount'),
    averageMaxPositionQuoteGapMs: averageField(withQuoteCoverage, 'maxPositionQuoteGapMs'),
    status: closed.length < 30 ? 'descriptive_small_sample' : 'descriptive_sample_only',
  };
}

export function summarizeSharedPaperPortfolio(ledger = {}, { now = Date.now() } = {}) {
  const orders = Array.isArray(ledger.orders) ? ledger.orders : [];
  const active = orders.filter((row) => ['reserved', 'filled', 'open'].includes(row.status));
  const reportedUnderlyingDirection = (row) => {
    if (String(row.assetClass ?? '').trim().toLowerCase() === 'option') {
      const underlying = String(row.underlyingDirection ?? row.researchSignal?.direction ?? '').trim().toLowerCase();
      if (!['long', 'short'].includes(underlying)) return null;
    }
    return effectiveExposureDirection(row);
  };
  const concentrationAmounts = (rows) => ({
    activeOrders: rows.length,
    reservedOrders: rows.filter((row) => row.status === 'reserved').length,
    filledOrOpenOrders: rows.filter((row) => ['filled', 'open'].includes(row.status)).length,
    riskMetadataMissing: rows.filter((row) => !hasExplicitPositiveFiniteAmount(row.riskUsd)).length,
    notionalMetadataMissing: rows.filter((row) => !hasExplicitPositiveFiniteAmount(row.notionalUsd)).length,
    openRiskUsd: rows.every((row) => hasExplicitPositiveFiniteAmount(row.riskUsd))
      ? Number(rows.reduce((sum, row) => sum + Number(row.riskUsd), 0).toFixed(2)) : null,
    grossNotionalUsd: rows.every((row) => hasExplicitPositiveFiniteAmount(row.notionalUsd))
      ? Number(rows.reduce((sum, row) => sum + Number(row.notionalUsd), 0).toFixed(2)) : null,
  });
  const recognizedClasses = new Set(['stock', 'crypto', 'forex', 'future', 'option', 'etf', 'etp']);
  const byAssetClass = new Map();
  const byDirection = new Map();
  for (const row of active) {
    const declaredClass = String(row.assetClass ?? '').trim().toLowerCase();
    const assetClass = recognizedClasses.has(declaredClass) ? declaredClass : 'unclassified';
    const direction = reportedUnderlyingDirection(row) ?? 'unknown';
    if (!byAssetClass.has(assetClass)) byAssetClass.set(assetClass, []);
    if (!byDirection.has(direction)) byDirection.set(direction, []);
    byAssetClass.get(assetClass).push(row);
    byDirection.get(direction).push(row);
  }
  const assetClassConcentration = {
    status: !active.length ? 'no_active_positions' : byAssetClass.has('unclassified') ? 'unclassified_asset_class' : 'available',
    basis: 'declared instrument class; gross ledger risk and notional without hedge or correlation credit',
    groups: [...byAssetClass.entries()].map(([assetClass, rows]) => ({ assetClass, ...concentrationAmounts(rows) }))
      .sort((a, b) => a.assetClass.localeCompare(b.assetClass)),
  };
  const directionalConcentration = {
    status: !active.length ? 'no_active_positions' : byDirection.has('unknown') ? 'unknown_underlying_direction' : 'available',
    basis: 'effective underlying direction for inverse ETFs/ETPs and options when recorded; gross ledger risk/notional is not delta-adjusted or hedge-netted',
    groups: ['long', 'short', 'unknown'].filter((direction) => byDirection.has(direction))
      .map((direction) => ({ direction, ...concentrationAmounts(byDirection.get(direction)) })),
  };
  const byPrimaryExposure = new Map();
  for (const row of active) {
    const exposureKey = canonicalExposureKey(row);
    if (!exposureKey) continue;
    if (!byPrimaryExposure.has(exposureKey)) byPrimaryExposure.set(exposureKey, []);
    byPrimaryExposure.get(exposureKey).push(row);
  }
  const exposureConcentration = [...byPrimaryExposure.entries()].map(([exposureKey, rows]) => {
    const notionalsComplete = rows.every((row) => hasExplicitPositiveFiniteAmount(row.notionalUsd));
    const risksComplete = rows.every((row) => hasExplicitPositiveFiniteAmount(row.riskUsd));
    const directionalRows = rows.map((row) => ({ row, direction: reportedUnderlyingDirection(row) }));
    const directionKnown = directionalRows.every(({ direction }) => direction === 'long' || direction === 'short');
    const grossNotionalUsd = notionalsComplete ? Number(rows.reduce((sum, row) => sum + Number(row.notionalUsd), 0).toFixed(2)) : null;
    const overlapExposureKeys = [...new Set(rows.flatMap((row) => canonicalExposureKeys(row).filter((key) => key !== exposureKey)))].sort();
    const longNotionalUsd = notionalsComplete && directionKnown
      ? Number(directionalRows.filter(({ direction }) => direction === 'long').reduce((sum, { row }) => sum + Number(row.notionalUsd), 0).toFixed(2)) : null;
    const shortNotionalUsd = notionalsComplete && directionKnown
      ? Number(directionalRows.filter(({ direction }) => direction === 'short').reduce((sum, { row }) => sum + Number(row.notionalUsd), 0).toFixed(2)) : null;
    return { exposureKey, activeOrders: rows.length, reservedOrders: rows.filter((row) => row.status === 'reserved').length,
      openPositions: rows.filter((row) => ['filled', 'open'].includes(row.status)).length,
      owners: [...new Set(rows.map((row) => row.owner).filter(Boolean))].sort(),
      overlapExposureKeys,
      grossNotionalUsd, openRiskUsd: risksComplete ? Number(rows.reduce((sum, row) => sum + Number(row.riskUsd), 0).toFixed(2)) : null,
      longNotionalUsd, shortNotionalUsd,
      netDirectionalNotionalUsd: longNotionalUsd === null ? null : Number((longNotionalUsd - shortNotionalUsd).toFixed(2)),
      directionUnknown: directionalRows.filter(({ direction }) => direction !== 'long' && direction !== 'short').length,
      notionalMetadataMissing: notionalsComplete ? 0 : rows.filter((row) => !hasExplicitPositiveFiniteAmount(row.notionalUsd)).length,
      riskMetadataMissing: risksComplete ? 0 : rows.filter((row) => !hasExplicitPositiveFiniteAmount(row.riskUsd)).length,
    };
  }).sort((a, b) => (b.grossNotionalUsd ?? -1) - (a.grossNotionalUsd ?? -1) || a.exposureKey.localeCompare(b.exposureKey));
  const closed = orders.filter((row) => row.status === 'closed');
  const riskDayUtc = new Date(now).toISOString().slice(0, 10);
  const closedRiskDate = (row) => {
    const closeTime = Date.parse(row.closedAt || '');
    if (Number.isFinite(closeTime)) return new Date(closeTime).toISOString().slice(0, 10);
    const stored = String(row.closedPortfolioRiskDateUtc || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(stored) && Date.parse(`${stored}T00:00:00.000Z`) && new Date(`${stored}T00:00:00.000Z`).toISOString().slice(0, 10) === stored
      ? stored : null;
  };
  const realizedRows = closed.filter((row) => hasExplicitFiniteAmount(row.realizedPnlUsd));
  const closedTradesMissingRealizedPnl = closed.filter((row) => !hasExplicitFiniteAmount(row.realizedPnlUsd)).length;
  const closedTradesUnreconciledCostAccounting = closed.filter((row) =>
    inspectClosedPaperAccounting(row).status !== 'reconciled').length;
  const unclassifiedClosedTrades = realizedRows.filter((row) => !closedRiskDate(row)).length;
  const riskDayPnlIncomplete = closed.some((row) => !closedRiskDate(row)
    || closedRiskDate(row) === riskDayUtc && inspectClosedPaperAccounting(row).status !== 'reconciled');
  const realizedPnlRiskDayUtcUsd = realizedRows.filter((row) => closedRiskDate(row) === riskDayUtc)
    .reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0);
  const activeWithPnl = active.filter((row) => ['filled', 'open'].includes(row.status));
  const openPositionsMissingPnl = activeWithPnl.filter((row) => !hasExplicitFiniteAmount(row.unrealizedPnlUsd)).length;
  const activeRiskMetadataMissing = active.filter((row) => !hasExplicitPositiveFiniteAmount(row.riskUsd)).length;
  const activeNotionalMetadataMissing = active.filter((row) => !hasExplicitPositiveFiniteAmount(row.notionalUsd)).length;
  const activeFutures = active.filter((row) => String(row.assetClass).toLowerCase() === 'future');
  const activeMarginMetadataMissing = activeFutures.filter((row) => !hasExplicitNonNegativeFiniteAmount(row.marginRequirementUsd)).length;
  const sumActiveField = (rows, key, valid) => rows.every((row) => valid(row[key]))
    ? Number(rows.reduce((sum, row) => sum + Number(row[key]), 0).toFixed(2)) : null;
  const averageExcursion = (rows, key) => {
    const valid = rows.filter((row) => row[key] != null && Number.isFinite(Number(row[key])));
    return valid.length ? Number((valid.reduce((sum, row) => sum + Number(row[key]), 0) / valid.length).toFixed(2)) : null;
  };
  const staleMarkCount = (rows) => rows.filter((row) => ['filled', 'open'].includes(row.status)).filter((row) => {
    const markedAt = Date.parse(row.markedAt ?? row.lastProcessedQuoteTime ?? row.filledAt ?? '');
    const maxAge = Number.isFinite(Number(row.maxOpenMarkAgeMs)) ? Number(row.maxOpenMarkAgeMs) : DEFAULT_OPEN_MARK_MAX_AGE_MS;
    return !Number.isFinite(markedAt) || markedAt > now + 5_000 || now - markedAt > maxAge;
  }).length;
  const byBot = {};
  for (const owner of BOT_IDS) {
    const owned = orders.filter((row) => row.owner === owner);
    const activeOwned = owned.filter((row) => ['reserved', 'filled', 'open'].includes(row.status));
    const openOwnedWithPnl = activeOwned.filter((row) => ['filled', 'open'].includes(row.status));
    const riskIncomplete = activeOwned.some((row) => !hasExplicitPositiveFiniteAmount(row.riskUsd));
    const notionalIncomplete = activeOwned.some((row) => !hasExplicitPositiveFiniteAmount(row.notionalUsd));
    const ownedFutures = activeOwned.filter((row) => String(row.assetClass).toLowerCase() === 'future');
    const marginIncomplete = ownedFutures.some((row) => !hasExplicitNonNegativeFiniteAmount(row.marginRequirementUsd));
    const closedOwned = owned.filter((row) => row.status === 'closed');
    const recoveryCancelledOwned = owned.filter((row) => row.status === 'cancelled');
    const overdueOwned = activeOwned.filter((row) => ['filled', 'open'].includes(row.status)
      && Number.isFinite(Date.parse(row.forceExitAt)) && Date.parse(row.forceExitAt) <= now);
    const expiredReservations = activeOwned.filter((row) => row.status === 'reserved'
      && [row.entryExpiresAt, row.forceExitAt].some((deadline) => Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= now));
    byBot[owner] = {
      orders: owned.length, active: activeOwned.length,
      reserved: activeOwned.filter((row) => row.status === 'reserved').length,
      filledOrOpen: activeOwned.filter((row) => ['filled', 'open'].includes(row.status)).length,
      staleOrUnmarkedPositions: staleMarkCount(activeOwned),
      openPositionsMissingPnl: openOwnedWithPnl.filter((row) => !hasExplicitFiniteAmount(row.unrealizedPnlUsd)).length,
      activeRiskMetadataMissing: activeOwned.filter((row) => !hasExplicitPositiveFiniteAmount(row.riskUsd)).length,
      activeNotionalMetadataMissing: activeOwned.filter((row) => !hasExplicitPositiveFiniteAmount(row.notionalUsd)).length,
      activeMarginMetadataMissing: ownedFutures.filter((row) => !hasExplicitNonNegativeFiniteAmount(row.marginRequirementUsd)).length,
      overdueExitPositions: overdueOwned.length, expiredUnfilledReservations: expiredReservations.length,
      expiredReservationCancellations: recoveryCancelledOwned.filter((row) => ['entry_window_expired', 'time_exit_before_fill'].includes(row.cancelReason)).length,
      emergencyStopReservationCancellations: recoveryCancelledOwned.filter((row) => row.cancelReason === 'emergency_stop_active').length,
      closed: closedOwned.length,
      closedTradesMissingRealizedPnl: closedOwned.filter((row) => !hasExplicitFiniteAmount(row.realizedPnlUsd)).length,
      closedTradesUnreconciledCostAccounting: closedOwned.filter((row) =>
        inspectClosedPaperAccounting(row).status !== 'reconciled').length,
      pendingFillRisk: summarizePendingFillRisk(activeOwned),
      performance: summarizeClosedPerformance(closedOwned),
      openRiskUsd: riskIncomplete ? null : sumActiveField(activeOwned, 'riskUsd', hasExplicitPositiveFiniteAmount),
      openNotionalUsd: notionalIncomplete ? null : sumActiveField(activeOwned, 'notionalUsd', hasExplicitPositiveFiniteAmount),
      openInitialMarginUsd: marginIncomplete ? null : sumActiveField(ownedFutures, 'marginRequirementUsd', hasExplicitNonNegativeFiniteAmount),
      unrealizedPnlUsd: openOwnedWithPnl.every((row) => hasExplicitFiniteAmount(row.unrealizedPnlUsd))
        ? Number(openOwnedWithPnl.reduce((sum, row) => sum + Number(row.unrealizedPnlUsd), 0).toFixed(2)) : null,
      realizedPnlUsd: closedOwned.every((row) => inspectClosedPaperAccounting(row).status === 'reconciled')
        ? Number(closedOwned.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0).toFixed(2)) : null,
      excursionSampleCount: closedOwned.filter((row) => row.maxFavorableExcursionUsd != null && row.maxAdverseExcursionUsd != null).length,
      averageMaxFavorableExcursionUsd: averageExcursion(closedOwned, 'maxFavorableExcursionUsd'),
      averageMaxAdverseExcursionUsd: averageExcursion(closedOwned, 'maxAdverseExcursionUsd'),
    };
  }
  const overdue = active.filter((row) => ['filled', 'open'].includes(row.status)
    && Number.isFinite(Date.parse(row.forceExitAt)) && Date.parse(row.forceExitAt) <= now);
  const expiredReservations = active.filter((row) => row.status === 'reserved'
    && [row.entryExpiresAt, row.forceExitAt].some((deadline) => Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= now));
  const cancelled = orders.filter((row) => row.status === 'cancelled');
  return {
    schemaVersion: ledger.schemaVersion ?? null,
    activeOrders: active.length, reservedOrders: active.filter((row) => row.status === 'reserved').length,
    assetClassConcentration, directionalConcentration,
    exposureConcentration: { status: active.length ? 'available' : 'no_active_positions', basis: 'primary canonical exposure identity; gross notional is summed without correlation or hedge credit', groups: exposureConcentration },
    filledOrOpenOrders: active.filter((row) => ['filled', 'open'].includes(row.status)).length,
    staleOrUnmarkedPositions: staleMarkCount(active),
    openPositionsMissingPnl,
    activeRiskMetadataMissing,
    activeNotionalMetadataMissing,
    activeMarginMetadataMissing,
    closedOrders: closed.length,
    overdueExitPositions: overdue.length, expiredUnfilledReservations: expiredReservations.length,
    expiredReservationCancellations: cancelled.filter((row) => ['entry_window_expired', 'time_exit_before_fill'].includes(row.cancelReason)).length,
    emergencyStopReservationCancellations: cancelled.filter((row) => row.cancelReason === 'emergency_stop_active').length,
    openRiskUsd: activeRiskMetadataMissing ? null : sumActiveField(active, 'riskUsd', hasExplicitPositiveFiniteAmount),
    openNotionalUsd: activeNotionalMetadataMissing ? null : sumActiveField(active, 'notionalUsd', hasExplicitPositiveFiniteAmount),
    openInitialMarginUsd: activeMarginMetadataMissing ? null : sumActiveField(activeFutures, 'marginRequirementUsd', hasExplicitNonNegativeFiniteAmount),
    unrealizedPnlUsd: openPositionsMissingPnl ? null
      : Number(activeWithPnl.reduce((sum, row) => sum + Number(row.unrealizedPnlUsd), 0).toFixed(2)),
    realizedPnlUsd: closedTradesUnreconciledCostAccounting ? null
      : Number(closed.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0).toFixed(2)),
    pendingFillRisk: summarizePendingFillRisk(orders),
    performance: summarizeClosedPerformance(orders),
    closedTradeCircuit: summarizeClosedTradeCircuit(ledger),
    riskDayUtc, realizedPnlRiskDayUtcUsd: riskDayPnlIncomplete ? null
      : Number(realizedPnlRiskDayUtcUsd.toFixed(2)), unclassifiedClosedTrades, closedTradesMissingRealizedPnl,
    closedTradesUnreconciledCostAccounting,
    excursionSampleCount: closed.filter((row) => row.maxFavorableExcursionUsd != null && row.maxAdverseExcursionUsd != null).length,
    averageMaxFavorableExcursionUsd: averageExcursion(closed, 'maxFavorableExcursionUsd'),
    averageMaxAdverseExcursionUsd: averageExcursion(closed, 'maxAdverseExcursionUsd'),
    byBot,
  };
}

export function summarizeLedgerCoordination(bots = {}, expectedFingerprint = '') {
  const rows = Object.entries(bots).flatMap(([bot, entry]) => (entry?.process?.processes || [])
    .filter((process) => process.status === 'running').map((process) => ({ bot, fingerprint: process.ledgerFingerprint || null })));
  const activeBotIds = [...new Set(rows.map((row) => row.bot))].sort();
  const mismatchedBotIds = [...new Set(rows.filter((row) => row.fingerprint && row.fingerprint !== expectedFingerprint).map((row) => row.bot))].sort();
  const missingFingerprintBots = [...new Set(rows.filter((row) => !row.fingerprint).map((row) => row.bot))].sort();
  const missingActiveBotIds = BOT_IDS.filter((bot) => !activeBotIds.includes(bot));
  const status = !rows.length ? 'unobserved' : mismatchedBotIds.length ? 'mismatch'
    : missingFingerprintBots.length || missingActiveBotIds.length || !expectedFingerprint ? 'partial' : 'aligned';
  return { status, activeProcesses: rows.length, activeBotIds, missingActiveBotIds, mismatchedBotIds, missingFingerprintBots };
}

function runtimeSummary(entry = {}) {
  const process = entry.process || {};
  const active = (process.processes || []).filter((row) => row.status === 'running');
  const latest = [...(process.processes || [])].sort((a, b) => Date.parse(b.heartbeatAt || '') - Date.parse(a.heartbeatAt || ''))[0] || null;
  const state = (key) => active.some((row) => row[key] === true) ? 'ready'
    : active.some((row) => row[key] === false) ? 'not_ready' : 'unknown';
  return {
    status: process.status || 'unknown', activeProcesses: Number(process.activeProcesses) || 0,
    discord: state('discordReady'), scheduler: state('schedulerRunning'),
    lastScanFinishedAt: latest?.lastScanFinishedAt || null, lastScanExitCode: latest?.lastScanExitCode ?? null,
    positionMonitor: latest?.positionMonitor ?? null,
    scope: 'heartbeat evidence only; Discord readiness does not verify webhook delivery or channel posting',
  };
}

export function buildOperatorReport({ ledger, bots, expectedLedgerFingerprint = '', generatedAt = new Date().toISOString(), now = Date.now(), staleAfterMs = 30 * 60_000 } = {}) {
  const known = Object.fromEntries(BOT_IDS.map((id) => {
    const row = bots?.[id] || { status: 'no-scan-data', instances: 0, scansRetained: 0, latestAt: null, ageMs: null,
      lastScanSafety: { emergencyStop: 'unknown', liveTrading: 'unknown', liveTradingRequest: 'unknown', scansReportingEmergencyStop: 0, observedAt: null, scope: 'no scan observation available' } };
    return [id, { ...row, scanStatus: row.status, runtime: runtimeSummary(row) }];
  }));
  return {
    generatedAt,
    diagnosticsWindowMs: staleAfterMs,
    bots: known,
    portfolio: summarizeSharedPaperPortfolio(ledger, { now }),
    safety: {
      orderRouting: 'not implemented in these research bots; report is read-only',
      liveTradingAuthorization: 'disabled',
      emergencyStopRuntimeState: 'per-bot expiring process heartbeats are shown when available; otherwise only last-scan observations are available',
      ledgerCoordination: summarizeLedgerCoordination(known, expectedLedgerFingerprint),
    },
    limitations: ['Per-bot scan data may be absent or stale; each bot reports its own last successful scan separately.', 'Stocks/Crypto scan diagnostics aggregate the latest scan per configured guild without exposing guild identifiers.', 'Shared JSON ledger only coordinates processes on the same filesystem/host.'],
  };
}

export async function collectOperatorReport({ rootDir = ROOT, ledgerPath, stocksDataDir, cryptoDataDir, now = Date.now(), staleAfterMs = 30 * 60_000 } = {}) {
  const locations = await resolveOperatorDataLocations({ rootDir, overrides: { stocks: stocksDataDir, crypto: cryptoDataDir } });
  stocksDataDir = locations.stocks.directory;
  cryptoDataDir = locations.crypto.directory;
  const resolvedLedger = resolvePaperLedgerPath(ledgerPath || process.env.TRADING_RISK_STATE_PATH || '');
  const ledger = await readPaperRiskLedger({ statePath: resolvedLedger });
  const ledgerLock = await inspectPaperRiskLock({ statePath: resolvedLedger, now });
  const reportBots = {};
  for (const id of ['forex', 'futures', 'options', 'etfs-etps']) {
    const rows = await readScanDiagnosticRows(join(rootDir, id === 'etfs-etps' ? id : id, 'data', `${id}-scan-diagnostics.jsonl`));
    reportBots[id] = summarizeByBot(id, rows, { now, staleAfterMs });
  }
  const stockRows = await readStockRows(stocksDataDir);
  const cryptoRows = await readCryptoRows(cryptoDataDir);
  reportBots.stocks = summarizeByBot('stocks', stockRows, { now, staleAfterMs });
  reportBots.crypto = summarizeByBot('crypto', cryptoRows, { now, staleAfterMs });
  for (const id of ['stocks', 'crypto']) reportBots[id].dataLocation = locations[id].diagnostic;
  const heartbeatDirs = { ...Object.fromEntries(['forex', 'futures', 'options', 'etfs-etps'].map((id) => [id, join(rootDir, id, 'data')])),
    stocks: stocksDataDir, crypto: cryptoDataDir };
  for (const id of BOT_IDS) {
    reportBots[id].process = await readRunnerHeartbeatStatus(id, { directory: heartbeatDirs[id], now });
    if (['crypto', 'stocks', 'forex', 'futures', 'options', 'etfs-etps'].includes(id))
      reportBots[id].positionMonitor = await readPaperPositionMonitorReport(id, heartbeatDirs[id], now);
  }
  const ledgerStats = await stat(resolvedLedger).then((row) => ({ exists: true, modifiedAt: row.mtime.toISOString() })).catch((error) => error.code === 'ENOENT' ? { exists: false, modifiedAt: null } : Promise.reject(error));
  const { ledgerPath: _ledgerPath, lockPath: _lockPath, ...shareableLockStatus } = ledgerLock;
  const providerReadiness = await inspectProviderReadiness({ rootDir, ledgerEquityAnchor: summarizeLedgerEquityAnchor(ledger) });
  let alpacaRequestBudget;
  try {
    const config = alpacaBudgetConfiguration(process.env, rootDir);
    alpacaRequestBudget = { ...await inspectAlpacaSharedBudget({ directory: config.directory, now }),
      configuredRequestsPerMinute: config.requestsPerMinute, groupConfigured: Boolean(config.group) };
  } catch { alpacaRequestBudget = { status: 'unavailable', reason: 'budget_configuration_or_storage_unavailable' }; }
  let tradierRequestBudget;
  try {
    const config = tradierBudgetConfiguration(process.env, rootDir);
    tradierRequestBudget = { ...await inspectTradierSharedBudget({ directory: config.directory, now }),
      configuredRequestsPerMinute: { production: config.productionRequestsPerMinute, sandbox: config.sandboxRequestsPerMinute } };
  } catch { tradierRequestBudget = { status: 'unavailable', reason: 'budget_configuration_or_storage_unavailable' }; }
  return { ...buildOperatorReport({ ledger, bots: reportBots, expectedLedgerFingerprint: paperLedgerFingerprint(resolvedLedger), now }),
    providerReadiness,
    alpacaRequestBudget,
    tradierRequestBudget,
    ledger: { ...ledgerStats, lock: shareableLockStatus } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await collectOperatorReport({ ledgerPath: process.argv[2] }), null, 2)); }
  catch (error) { console.error(`Operator report failed: ${error.message}`); process.exitCode = 1; }
}
