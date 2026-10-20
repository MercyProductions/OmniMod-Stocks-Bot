import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalExposureKey, canonicalExposureKeys, directionalCurrencyOverlap, effectiveExposureDirection, sharesDirectionalCurrencyExposure } from './exposureAliases.js';
import { resolvePaperLedgerPath } from './paperStatePath.js';
import { normalizePaperResearchContext } from './paperResearchContext.js';
import { paperApprovalEvidence } from './paperApprovalEvidence.js';
import { hasExplicitFiniteAmount, hasExplicitNonNegativeFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';
import { inspectClosedTradeSequence } from './closedTradeSequence.js';
import { inspectClosedPaperAccounting } from './postTradeReview.js';
import { normalizeCryptoInstrumentRules, cryptoInstrumentRulesRejection, cryptoOrderSizeRejection, cryptoPriceGridRejection } from './cryptoInstrumentRules.js';
import { floorRiskQuantity, isIncrementMultiple, roundPriceIncrement } from './decimalQuantity.js';
import { cryptoQuoteEvidenceRejection, normalizeCryptoQuoteEvidence } from './cryptoQuoteEvidence.js';
import { stockQuoteEvidenceRejection, normalizeStockQuoteEvidence, isStockQuoteInstrument, requiredStockQuoteFeed } from './stockQuoteEvidence.js';
import { cryptoExecutionIdentityKey, cryptoIdentityRejection, normalizeCryptoExecutionIdentity } from './cryptoExecutionIdentity.js';
import { assessOptionEntryEvidence } from './optionEntryEvidence.js';

const OWNER_BY_CLASS = Object.freeze({
  stock: 'stocks', crypto: 'crypto', forex: 'forex', future: 'futures',
  option: 'options', etf: 'etfs-etps', etp: 'etfs-etps',
});

export const PAPER_EXECUTION_VERSION = 'paper-quotes-v10-current-portfolio-risk';

const finitePositive = hasExplicitPositiveFiniteAmount;
const finiteValue = (value, fallback) => hasExplicitFiniteAmount(value) ? Number(value) : fallback;
const roundMoney = (value) => Number(value.toFixed(2));
const DEFAULT_MAX_OPEN_MARK_AGE_MS = 5 * 60_000;
const MAX_QUOTE_FUTURE_SKEW_MS = 5_000;
const LEDGER_ORDER_STATUSES = new Set(['reserved', 'filled', 'open', 'closed', 'cancelled']);
function optionalClosedCircuitLimit(value, maximum, integer = false) {
  if (value === undefined) return null;
  if (!hasExplicitFiniteAmount(value)) return NaN;
  const number = Number(value);
  return number > 0 && number <= maximum && (!integer || Number.isInteger(number)) ? number : NaN;
}
function closedCircuitFromPolicy(policy = {}) {
  const losses = Object.hasOwn(policy, 'maxConsecutiveLosses') ? policy.maxConsecutiveLosses
    : process.env.OMNIMOD_MAX_CONSECUTIVE_LOSSES;
  const drawdown = Object.hasOwn(policy, 'maxClosedDrawdownPct') ? policy.maxClosedDrawdownPct
    : process.env.OMNIMOD_MAX_CLOSED_DRAWDOWN_PCT;
  const maxConsecutiveLosses = optionalClosedCircuitLimit(losses, 1_000, true);
  const maxClosedDrawdownPct = optionalClosedCircuitLimit(drawdown, 100);
  return { maxConsecutiveLosses, maxClosedDrawdownPct,
    valid: !Number.isNaN(maxConsecutiveLosses) && !Number.isNaN(maxClosedDrawdownPct),
    enabled: maxConsecutiveLosses !== null || maxClosedDrawdownPct !== null };
}
function validStoredClosedCircuit(circuit) {
  return circuit && typeof circuit === 'object' && !Array.isArray(circuit)
    && Object.hasOwn(circuit, 'maxConsecutiveLosses') && Object.hasOwn(circuit, 'maxClosedDrawdownPct')
    && (circuit.maxConsecutiveLosses === null || (Number.isInteger(circuit.maxConsecutiveLosses)
      && circuit.maxConsecutiveLosses > 0 && circuit.maxConsecutiveLosses <= 1_000))
    && (circuit.maxClosedDrawdownPct === null || (typeof circuit.maxClosedDrawdownPct === 'number'
      && Number.isFinite(circuit.maxClosedDrawdownPct) && circuit.maxClosedDrawdownPct > 0
      && circuit.maxClosedDrawdownPct <= 100));
}
function closedCircuitReason(sequence, circuit, equity, suffix = '') {
  if (!circuit.maxConsecutiveLosses && !circuit.maxClosedDrawdownPct) return null;
  if (!['complete', 'no_closed_trades'].includes(sequence.status)) return `closed_trade_sequence_unavailable${suffix}`;
  if (sequence.status === 'no_closed_trades') return null;
  if (circuit.maxConsecutiveLosses && sequence.currentConsecutiveLosses >= circuit.maxConsecutiveLosses)
    return `consecutive_loss_limit${suffix}`;
  if (circuit.maxClosedDrawdownPct && sequence.maximumDrawdownUsd >= equity * circuit.maxClosedDrawdownPct / 100)
    return `maximum_closed_drawdown_limit${suffix}`;
  return null;
}
/** Read-only status of the policy anchored to a local paper ledger. */
export function summarizeClosedTradeCircuit(ledger = {}, accountEquity = ledger?.accountEquityUsd) {
  const circuit = ledger?.closedTradeCircuit;
  if (circuit == null) return { status: 'not_configured', maxConsecutiveLosses: null,
    maxClosedDrawdownPct: null, sequenceStatus: null };
  if (!validStoredClosedCircuit(circuit) || !finitePositive(accountEquity))
    return { status: 'invalid_policy_or_equity', maxConsecutiveLosses: null,
      maxClosedDrawdownPct: null, sequenceStatus: null };
  const sequence = inspectClosedTradeSequence(withholdUnreconciledClosePnl(Array.isArray(ledger.orders) ? ledger.orders : []));
  const reason = closedCircuitReason(sequence, circuit, Number(accountEquity));
  return { status: reason ?? 'clear', maxConsecutiveLosses: circuit.maxConsecutiveLosses,
    maxClosedDrawdownPct: circuit.maxClosedDrawdownPct, sequenceStatus: sequence.status };
}
function sharedEquityBasis(ledger, proposed) {
  const differs = (left, right) => Math.abs(left - right) > Math.max(0.01, Math.max(left, right) * 1e-9);
  if (Object.hasOwn(ledger, 'accountEquityUsd')) {
    if (!finitePositive(ledger.accountEquityUsd)) return { reason: 'shared_account_equity_anchor_invalid' };
    const anchor = Number(ledger.accountEquityUsd);
    return differs(anchor, proposed) ? { reason: 'shared_account_equity_mismatch' } : { accountEquityUsd: anchor };
  }
  // Legacy closed rows can lack this metadata without affecting active risk.
  // Active rows are separately required to have complete risk metadata.
  const values = (ledger.orders || []).map((order) => order.accountEquityUsd)
    .filter(finitePositive).map(Number);
  const anchor = values[0];
  if (values.some((value) => differs(anchor, value))) return { reason: 'shared_account_equity_history_mismatch' };
  if (anchor != null && differs(anchor, proposed)) return { reason: 'shared_account_equity_mismatch' };
  return { accountEquityUsd: anchor ?? proposed };
}
function inspectOpenPositionMarks(positions, now, maxAgeMs) {
  const marked = positions.filter((position) => ['filled', 'open'].includes(position?.status));
  const rows = marked.map((position) => {
    const markAt = position.markedAt ?? position.lastProcessedQuoteTime ?? position.filledAt;
    const markTime = Date.parse(markAt ?? '');
    const ageMs = Number.isFinite(markTime) ? now - markTime : null;
    const persistedMaxAge = finitePositive(position.maxOpenMarkAgeMs) ? Number(position.maxOpenMarkAgeMs) : maxAgeMs;
    const effectiveMaxAge = Math.min(maxAgeMs, persistedMaxAge);
    const fresh = Number.isFinite(markTime) && markTime <= now + 5_000 && ageMs <= effectiveMaxAge;
    return { instrumentKey: String(position.instrumentKey ?? '').slice(0, 80), status: position.status,
      ageMs: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null, fresh };
  });
  return { rows, staleCount: rows.filter((row) => !row.fresh).length };
}
function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, stableJsonValue(value[key])]));
  return value;
}
function approvalFingerprint(candidate, decision) {
  const snapshot = stableJsonValue({ candidate, decision: {
    status: decision.status, owner: decision.owner, riskLimits: decision.riskLimits, sizing: decision.sizing,
  } });
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
function sessionDateAt(value, timeZone, fallback) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return fallback; }
}

function utcRiskDateAt(value) {
  const time = typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function storedUtcRiskDate(order) {
  const value = String(order.closedPortfolioRiskDateUtc ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && utcRiskDateAt(`${value}T00:00:00.000Z`) === value ? value : null;
}

function closedOrderUtcRiskDate(order) {
  return utcRiskDateAt(order.closedAt) || storedUtcRiskDate(order);
}

function realizedPnlForUtcDay(orders, riskDateUtc) {
  if (!riskDateUtc) return 0;
  return orders.filter((order) => order.status === 'closed' && hasExplicitFiniteAmount(order.realizedPnlUsd)
      && closedOrderUtcRiskDate(order) === riskDateUtc)
    .reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0);
}

function closedOrdersMissingRiskDate(orders) {
  return orders.filter((order) => order.status === 'closed' && hasExplicitFiniteAmount(order.realizedPnlUsd)
    && !closedOrderUtcRiskDate(order));
}

function closedOrdersMissingRiskDayPnl(orders, riskDateUtc) {
  return orders.filter((order) => order.status === 'closed' && !hasExplicitFiniteAmount(order.realizedPnlUsd)
    && (!closedOrderUtcRiskDate(order) || closedOrderUtcRiskDate(order) === riskDateUtc));
}

function closedOrdersUnreconciledRiskDayPnl(orders, riskDateUtc) {
  return orders.filter((order) => order.status === 'closed' && hasExplicitFiniteAmount(order.realizedPnlUsd)
    && inspectClosedPaperAccounting(order).status !== 'reconciled'
    && (!closedOrderUtcRiskDate(order) || closedOrderUtcRiskDate(order) === riskDateUtc));
}

function withholdUnreconciledClosePnl(orders) {
  return orders.map((order) => order?.status === 'closed'
    && inspectClosedPaperAccounting(order).status !== 'reconciled'
    ? { ...order, realizedPnlUsd: null } : order);
}

function hasValidActiveOrderRiskMetadata(order) {
  return hasExplicitPositiveFiniteAmount(order?.riskUsd) && hasExplicitPositiveFiniteAmount(order?.notionalUsd)
    && hasExplicitNonNegativeFiniteAmount(order?.marginRequirementUsd);
}

/** Optional side-specific FX conversion. Existing single-multiplier orders retain their recorded model. */
function modeledPaperGross(order, price, sign = order.direction === 'long' ? 1 : -1) {
  const pricePnl = (price - Number(order.fillPrice)) * sign;
  const factor = pricePnl > 0 ? Number(order.gainMultiplier ?? order.multiplier ?? 1) : Number(order.multiplier ?? 1);
  return pricePnl * Number(order.units) * factor;
}

function hasValidActiveOrderExecutionState(order) {
  const positiveFields = ['units', 'entryPrice', 'stopPrice', 'targetPrice', 'multiplier'];
  if (!positiveFields.every((key) => hasExplicitPositiveFiniteAmount(order?.[key]))) return false;
  if (order.gainMultiplier != null && (!hasExplicitPositiveFiniteAmount(order.gainMultiplier) || Number(order.gainMultiplier) > Number(order.multiplier))) return false;
  if (!['long', 'short'].includes(order.direction)) return false;
  if (order.assetClass === 'crypto' && order.cryptoInstrumentRules != null) {
    const rules = normalizeCryptoInstrumentRules(order.cryptoInstrumentRules);
    if (!rules || !isIncrementMultiple(order.units, rules.quantityIncrement) || Number(order.multiplier) !== 1
      || ['provider', 'pair', 'base', 'quoteCurrency'].some(key => rules[key] !== order.cryptoIdentity?.[key])) return false;
  } else if (!Number.isInteger(Number(order.units))) return false;
  if (!hasExplicitNonNegativeFiniteAmount(order.roundTripFeesPerUnit)
    || !hasExplicitNonNegativeFiniteAmount(order.slippageReservePerUnit)) return false;
  if (!Number.isFinite(Date.parse(order.forceExitAt ?? '')) || !Number.isFinite(Date.parse(order.quoteTime ?? ''))) return false;
  if (order.status === 'reserved') return true;
  return hasExplicitPositiveFiniteAmount(order.fillPrice) && Number.isFinite(Date.parse(order.filledAt ?? ''));
}

const FILL_RISK_VERSION = 'paper-fill-risk-v1';
const FILL_LIMIT_FIELDS = ['accountEquity', 'maxOpenPositions', 'maxTotalOpenRiskUsd', 'maxGrossExposureUsd',
  'maxInitialMarginUsd', 'maxDailyLossUsd', 'maxOpenMarkAgeMs'];
function validExternalRisk(source) {
  return source && typeof source === 'object' && !Array.isArray(source)
    && typeof source.ledgerPath === 'string' && isAbsolute(source.ledgerPath)
    && ['mirror', 'independent'].includes(source.mode)
    && typeof source.sourceIdempotencyKey === 'string' && typeof source.requireExisting === 'boolean';
}
function validFillRiskPolicy(p) {
  return p?.version === FILL_RISK_VERSION && ['accountEquity', 'maxOpenPositions', 'maxOpenMarkAgeMs'].every(key => finitePositive(p[key]))
    && ['maxTotalOpenRiskUsd', 'maxGrossExposureUsd', 'maxInitialMarginUsd', 'maxDailyLossUsd'].every(key => hasExplicitNonNegativeFiniteAmount(p[key]))
    && Number.isInteger(p.maxOpenPositions) && p.maxOpenMarkAgeMs <= 86400000
    && validStoredClosedCircuit(p.closedTradeCircuit)
    && (p.externalPortfolio === null || validExternalRisk(p.externalPortfolio));
}

/** Latest saved entry checks, not a fresh risk evaluation. */
export function summarizePendingFillRisk(orders = []) {
  const reservedOrders = orders.filter(order => order.status === 'reserved');
  return {
      policyUnavailable: reservedOrders.filter(order => !validFillRiskPolicy(order.entryRiskPolicy)).length,
      checked: reservedOrders.filter(order => order.lastFillRiskCheck?.version === FILL_RISK_VERSION).length,
      blocked: reservedOrders.filter(order => order.lastFillRiskCheck?.status === 'blocked').length,
      reasons: Object.fromEntries([...new Set(reservedOrders.map(order => order.lastFillRiskCheck?.reason).filter(Boolean))]
        .map(reason => [reason, reservedOrders.filter(order => order.lastFillRiskCheck?.reason === reason).length])),
      scope: 'Latest persisted check per pending order; not a new check or a market opportunity count.',
  };
}

/** Use the reserved size once; never resize a queued order or replace its approval policy. */
function assessFillPortfolio(order, ledger, externalLedger, loadError, now, fillPrice, markPrice) {
  const p = order.entryRiskPolicy;
  const evidence = { version: FILL_RISK_VERSION, checkedAt: new Date(now).toISOString(), riskDayUtc: utcRiskDateAt(now),
    scope: p?.externalPortfolio ? 'local_locked_ledger_and_external_snapshot' : 'local_locked_ledger' };
  const reject = reason => ({ ...evidence, status: 'blocked', reason });
  if (!validFillRiskPolicy(p)) return reject('entry_risk_policy_unavailable');
  if (loadError) return reject(loadError);
  const books = [ledger, ...(externalLedger ? [externalLedger] : [])];
  for (const book of books) {
    const basis = sharedEquityBasis(book, Number(p.accountEquity));
    if (basis.reason) return reject(`${basis.reason}_at_fill`);
    if (book.closedTradeCircuit != null && !validStoredClosedCircuit(book.closedTradeCircuit)) return reject('closed_trade_circuit_policy_invalid_at_fill');
    if (closedOrdersMissingRiskDayPnl(book.orders, evidence.riskDayUtc).length) return reject('closed_trade_realized_pnl_unknown_at_fill');
    if (closedOrdersMissingRiskDate(book.orders).length) return reject('closed_trade_risk_day_unknown_at_fill');
    if (closedOrdersUnreconciledRiskDayPnl(book.orders, evidence.riskDayUtc).length) return reject('closed_trade_cost_accounting_unavailable_at_fill');
    if (book.closedTradeCircuit) {
      const reason = closedCircuitReason(inspectClosedTradeSequence(withholdUnreconciledClosePnl(book.orders)), book.closedTradeCircuit, Number(p.accountEquity), '_at_fill');
      if (reason) return reject(reason);
    }
  }
  const closedRows = p.externalPortfolio?.mode === 'independent' ? books.flatMap(book => book.orders) : ledger.orders;
  const circuitReason = closedCircuitReason(inspectClosedTradeSequence(withholdUnreconciledClosePnl(closedRows)), p.closedTradeCircuit, Number(p.accountEquity), '_at_fill');
  if (circuitReason) return reject(circuitReason);
  const externalActive = externalLedger?.orders.filter(row => ['reserved', 'filled', 'open'].includes(row.status)
    && (!p.externalPortfolio.sourceIdempotencyKey || row.idempotencyKey !== p.externalPortfolio.sourceIdempotencyKey)) ?? [];
  const active = [...ledger.orders.filter(row => ['reserved', 'filled', 'open'].includes(row.status)), ...externalActive];
  if (active.some(row => !hasValidActiveOrderRiskMetadata(row))) return reject('active_order_risk_metadata_invalid_at_fill');
  if (active.some(row => !finitePositive(row.accountEquityUsd)
    || Math.abs(Number(row.accountEquityUsd) - Number(p.accountEquity)) > Math.max(0.01, Number(p.accountEquity) * 1e-9))) return reject('shared_account_equity_mismatch_at_fill');
  const others = active.filter(row => row !== order);
  const keys = canonicalExposureKeys(order);
  const conflict = others.find(row => row.instrumentKey === order.instrumentKey || canonicalExposureKeys(row).some(key => keys.includes(key)));
  if (conflict) return reject(effectiveExposureDirection(conflict) === effectiveExposureDirection(order) ? 'duplicate_open_exposure_at_fill' : 'conflicting_open_exposure_at_fill');
  if (others.some(row => sharesDirectionalCurrencyExposure(order, row))) return reject('concentrated_currency_exposure_at_fill');
  const marked = active.filter(row => ['filled', 'open'].includes(row.status));
  const marks = inspectOpenPositionMarks(marked, now, Number(p.maxOpenMarkAgeMs));
  if (marks.staleCount) return reject('open_position_mark_stale_or_unavailable_at_fill');
  if (marked.some(row => !hasExplicitFiniteAmount(row.unrealizedPnlUsd))) return reject('open_position_pnl_unavailable_at_fill');
  const realized = books.map(book => realizedPnlForUtcDay(book.orders, evidence.riskDayUtc));
  evidence.realizedPnlRiskDayUtcUsd = p.externalPortfolio?.mode === 'independent' ? realized.reduce((a,b) => a+b, 0) : Math.min(...realized);
  evidence.unrealizedOpenPnlUsd = marked.reduce((sum,row) => sum + Number(row.unrealizedPnlUsd), 0);
  evidence.entryLiquidationPnlUsd = roundMoney(modeledPaperGross({ ...order, fillPrice }, markPrice)
    - (Number(order.roundTripFeesPerUnit) + Number(order.slippageReservePerUnit)) * Number(order.units));
  evidence.dailyPnlAfterFillUsd = roundMoney(evidence.realizedPnlRiskDayUtcUsd + evidence.unrealizedOpenPnlUsd + evidence.entryLiquidationPnlUsd);
  evidence.activeOrdersIncludingReservation = active.length;
  evidence.combinedRiskUsd = roundMoney(active.reduce((sum,row) => sum + Number(row.riskUsd), 0));
  // Existing rows retain their recorded reservation basis; a better short fill can
  // increase this order's notional and must not bypass the frozen gross limit.
  evidence.fillNotionalUsd = roundMoney(Number(order.units) * fillPrice * Number(order.multiplier) * Number(order.exposureMultiplier ?? 1));
  if (!finitePositive(evidence.fillNotionalUsd)) return reject('fill_notional_unavailable');
  evidence.combinedNotionalUsd = roundMoney(others.reduce((sum,row) => sum + Number(row.notionalUsd), 0) + Math.max(Number(order.notionalUsd), evidence.fillNotionalUsd));
  evidence.combinedInitialMarginUsd = roundMoney(active.reduce((sum,row) => sum + Number(row.marginRequirementUsd), 0));
  if (evidence.dailyPnlAfterFillUsd <= -Number(p.maxDailyLossUsd)) return reject('daily_loss_limit_at_fill');
  if (active.length > Number(p.maxOpenPositions)) return reject('open_position_limit_at_fill');
  if (evidence.combinedRiskUsd > Number(p.maxTotalOpenRiskUsd)) return reject('combined_open_risk_limit_at_fill');
  if (evidence.combinedNotionalUsd > Number(p.maxGrossExposureUsd)) return reject('gross_exposure_limit_at_fill');
  if (evidence.combinedInitialMarginUsd > Number(p.maxInitialMarginUsd)) return reject('initial_margin_exposure_limit_at_fill');
  return { ...evidence, status: 'approved', reason: null };
}

/** Validate an executable-quote day-trade proposal. This authorizes paper research only. */
export function evaluatePaperCandidate(candidate, portfolio = {}, policy = {}) {
  const cryptoRules = candidate?.assetClass === 'crypto' ? normalizeCryptoInstrumentRules(candidate.cryptoInstrumentRules) : null;
  const reasons = [];
  const closedCircuit = closedCircuitFromPolicy(policy);
  const now = finiteValue(policy.now ?? Date.now(), NaN);
  const assetClass = String(candidate?.assetClass ?? '').toLowerCase();
  const owner = OWNER_BY_CLASS[assetClass];
  const direction = String(candidate?.direction ?? '').toLowerCase();
  const bid = finiteValue(candidate?.bid, NaN), ask = finiteValue(candidate?.ask, NaN);
  const entry = finiteValue(candidate?.entryPrice, NaN), stop = finiteValue(candidate?.stopPrice, NaN), target = finiteValue(candidate?.targetPrice, NaN);
  const quoteTime = Date.parse(candidate?.quoteTime);
  const forceExitAt = Date.parse(candidate?.forceExitAt);
  const entryExpiresAt = candidate?.entryExpiresAt == null ? NaN : Date.parse(candidate.entryExpiresAt);
  const sessionDate = String(candidate?.sessionDate ?? candidate?.signal?.marketDate ?? '');
  const configuredQuoteAgeMs = finiteValue(policy.maxQuoteAgeMs ?? 60_000, NaN);
  const maxQuoteAgeMs = Number.isFinite(configuredQuoteAgeMs) ? Math.max(1_000, configuredQuoteAgeMs) : 0;
  const equity = finiteValue(portfolio.accountEquity, NaN);
  const openPositions = Array.isArray(portfolio.openPositions) ? portfolio.openPositions : [];
  const rawMaxPositions = finiteValue(policy.maxOpenPositions ?? 5, NaN);
  const rawMaxTradeRiskPct = finiteValue(policy.maxTradeRiskPct ?? 0.25, NaN);
  const rawMaxTotalRiskPct = finiteValue(policy.maxTotalOpenRiskPct ?? 1, NaN);
  const rawMaxGrossExposurePct = finiteValue(policy.maxGrossExposurePct ?? 200, NaN);
  const rawMaxInitialMarginPct = finiteValue(policy.maxInitialMarginPct ?? 100, NaN);
  const rawDailyLossLimitPct = finiteValue(policy.maxDailyLossPct ?? 1, NaN);
  const rawMaxOpenMarkAgeMs = finiteValue(policy.maxOpenMarkAgeMs ?? DEFAULT_MAX_OPEN_MARK_AGE_MS, NaN);
  const rawMaxSpreadPct = finiteValue(policy.maxSpreadPct ?? 0.5, NaN);
  const rawMinRewardRisk = finiteValue(policy.minRewardRisk ?? 1.25, NaN);
  const maxPositions = Number.isFinite(rawMaxPositions) ? Math.max(1, Math.floor(rawMaxPositions)) : 0;
  const maxTradeRiskPct = Number.isFinite(rawMaxTradeRiskPct) ? Math.max(0, rawMaxTradeRiskPct) : 0;
  const maxTotalRiskPct = Number.isFinite(rawMaxTotalRiskPct) ? Math.max(0, rawMaxTotalRiskPct) : 0;
  const maxGrossExposurePct = Number.isFinite(rawMaxGrossExposurePct) ? Math.max(0, rawMaxGrossExposurePct) : 0;
  const dailyLossLimitPct = Number.isFinite(rawDailyLossLimitPct) ? Math.max(0, rawDailyLossLimitPct) : 0;
  const maxSpreadPct = Number.isFinite(rawMaxSpreadPct) ? Math.max(0, rawMaxSpreadPct) : 0;
  const minRewardRisk = Number.isFinite(rawMinRewardRisk) ? Math.max(0, rawMinRewardRisk) : 0;
  // An explicitly unavailable daily total must not be interpreted as flat P&L.
  const dailyLoss = Object.hasOwn(portfolio, 'realizedPnlToday')
    ? finiteValue(portfolio.realizedPnlToday, NaN) : 0;
  const activePositions = openPositions.filter((position) => ['reserved', 'filled', 'open'].includes(position?.status));
  const openMarkDiagnostics = inspectOpenPositionMarks(activePositions, now, rawMaxOpenMarkAgeMs);
  const markedPositions = activePositions.filter((position) => ['filled', 'open'].includes(position?.status));
  const missingOpenPnl = markedPositions.some((position) => !hasExplicitFiniteAmount(position.unrealizedPnlUsd));
  const unrealizedPnl = markedPositions.reduce((sum, position) => sum + (hasExplicitFiniteAmount(position.unrealizedPnlUsd) ? Number(position.unrealizedPnlUsd) : 0), 0);
  const dailyPnl = dailyLoss + unrealizedPnl;
  const invalidRiskPolicy = !closedCircuit.valid || !Number.isFinite(now) || !Number.isFinite(rawMaxPositions) || rawMaxPositions < 1
    || !Number.isFinite(configuredQuoteAgeMs) || configuredQuoteAgeMs <= 0
    || ![rawMaxTradeRiskPct, rawMaxTotalRiskPct, rawMaxGrossExposurePct, rawDailyLossLimitPct, rawMaxSpreadPct, rawMinRewardRisk, dailyLoss].every(Number.isFinite)
    || rawMaxTradeRiskPct < 0 || rawMaxTradeRiskPct > 100
    || rawMaxTotalRiskPct < 0 || rawMaxTotalRiskPct > 100
    || rawDailyLossLimitPct < 0 || rawDailyLossLimitPct > 100
    || !Number.isFinite(rawMaxInitialMarginPct) || rawMaxInitialMarginPct < 0 || rawMaxInitialMarginPct > 100
    || !Number.isFinite(rawMaxOpenMarkAgeMs) || rawMaxOpenMarkAgeMs < 1_000 || rawMaxOpenMarkAgeMs > 24 * 60 * 60_000
    || rawMinRewardRisk < 1
    || activePositions.some((position) => !finitePositive(position.riskUsd) || !finitePositive(position.notionalUsd)
      || (String(position.assetClass).toLowerCase() === 'future' && !finitePositive(position.marginRequirementUsd)));

  if (policy.liveTradingEnabled === true || String(candidate?.mode ?? '').toLowerCase() !== 'paper') reasons.push('live_trading_disabled');
  if (policy.emergencyStop === true) reasons.push('emergency_stop_active');
  if (invalidRiskPolicy) reasons.push('invalid_risk_policy_or_daily_pnl');
  if (closedCircuit.valid && closedCircuit.enabled && Array.isArray(portfolio.closedOrders)) {
    const reason = closedCircuitReason(inspectClosedTradeSequence(withholdUnreconciledClosePnl(portfolio.closedOrders)), closedCircuit, equity);
    if (reason) reasons.push(reason);
  }
  if (openMarkDiagnostics.staleCount > 0) reasons.push('open_position_mark_stale_or_unavailable');
  if (missingOpenPnl) reasons.push('open_position_pnl_unavailable');
  if (!owner || candidate?.owner !== owner) reasons.push('primary_bot_owner_mismatch');
  const sessionMidnight = Date.parse(`${sessionDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || !Number.isFinite(sessionMidnight) || new Date(sessionMidnight).toISOString().slice(0, 10) !== sessionDate) reasons.push('invalid_or_missing_session_date');
  if (!candidate?.instrumentKey || !candidate?.idempotencyKey) reasons.push('missing_instrument_or_idempotency_key');
  if (!['long', 'short'].includes(direction)) reasons.push('invalid_direction');
  if (candidate?.quoteQuality !== 'executable') reasons.push('quote_not_executable');
  if (assetClass === 'crypto') {
    const rulesReason = cryptoInstrumentRulesRejection(cryptoRules, candidate.cryptoIdentity, now);
    if (rulesReason) reasons.push(rulesReason);
    if (cryptoRules && (Number(candidate.lotSize) !== Number(cryptoRules.quantityIncrement) || Number(candidate.multiplier) !== 1))
      reasons.push('crypto_contract_size_metadata_mismatch');
    const gridReason = cryptoRules ? cryptoPriceGridRejection(cryptoRules, bid, ask) : null;
    if (gridReason) reasons.push(gridReason);
    if (cryptoRules && ![entry, stop, target].every(price => isIncrementMultiple(price, cryptoRules.priceIncrement)))
      reasons.push('crypto_plan_price_increment_mismatch');
    const identityReason = cryptoIdentityRejection(candidate.cryptoIdentity, now);
    if (identityReason) reasons.push(identityReason);
    const evidenceReason = cryptoQuoteEvidenceRejection(candidate.cryptoIdentity, candidate.cryptoQuoteEvidence, { bid, ask, time: candidate.quoteTime });
    if (evidenceReason) reasons.push(evidenceReason);
  }
  if (!finitePositive(bid) || !finitePositive(ask) || ask < bid) reasons.push('invalid_bid_ask');
  if (isStockQuoteInstrument(candidate.assetClass)) {
    const reason = stockQuoteEvidenceRejection(candidate.instrumentKey, candidate.stockQuoteEvidence, { bid, ask, time: candidate.quoteTime }, requiredStockQuoteFeed(candidate));
    if (reason) reasons.push(reason);
  }
  if (!Number.isFinite(quoteTime) || quoteTime > now + MAX_QUOTE_FUTURE_SKEW_MS || now - quoteTime > maxQuoteAgeMs) reasons.push('stale_or_future_quote');
  if (!Number.isFinite(forceExitAt) || forceExitAt <= now) reasons.push('invalid_or_expired_time_exit');
  if (candidate?.entryExpiresAt != null && (!Number.isFinite(entryExpiresAt) || entryExpiresAt <= now || entryExpiresAt > forceExitAt))
    reasons.push('invalid_or_expired_entry_window');
  if (Number.isFinite(entryExpiresAt) && entryExpiresAt <= now) reasons.push('entry_window_expired');
  if (!finitePositive(entry) || !finitePositive(stop) || !finitePositive(target)) reasons.push('invalid_price_levels');
  if (direction === 'long' && !(stop < entry && target > entry)) reasons.push('invalid_long_geometry');
  if (direction === 'short' && !(target < entry && stop > entry)) reasons.push('invalid_short_geometry');
  if (direction === 'long' && finitePositive(ask) && entry < ask) reasons.push('entry_below_executable_ask');
  if (direction === 'short' && finitePositive(bid) && entry > bid) reasons.push('entry_above_executable_bid');
  if (!finitePositive(equity)) reasons.push('invalid_account_equity');
  if (candidate?.sessionOpen !== true) reasons.push('outside_configured_session');
  if (!finitePositive(candidate?.multiplier ?? 1) || !finitePositive(candidate?.lotSize ?? 1)) reasons.push('invalid_contract_multiplier_or_lot_size');
  if (candidate?.gainMultiplier != null && (!hasExplicitPositiveFiniteAmount(candidate.gainMultiplier)
    || Number(candidate.gainMultiplier) > Number(candidate.multiplier ?? 1))) reasons.push('invalid_gain_multiplier');
  const exposureMultiplier = finiteValue(candidate?.exposureMultiplier ?? 1, NaN);
  if (!finitePositive(exposureMultiplier) || exposureMultiplier > 10) reasons.push('invalid_notional_exposure_multiplier');
  if (assetClass === 'future' && (!finitePositive(candidate?.initialMarginUsd) || !finitePositive(candidate?.maintenanceMarginUsd)
    || Number(candidate.maintenanceMarginUsd) > Number(candidate.initialMarginUsd))) reasons.push('invalid_futures_margin_metadata');
  if (![candidate?.roundTripFeesPerUnit, candidate?.slippageReservePerUnit].every(hasExplicitNonNegativeFiniteAmount)) reasons.push('cost_reserve_missing_or_invalid');

  const spreadPct = finitePositive(bid) && finitePositive(ask) && (ask + bid) > 0
    ? ((ask - bid) / ((ask + bid) / 2)) * 100 : Infinity;
  if (!Number.isFinite(spreadPct) || spreadPct > maxSpreadPct) reasons.push('spread_limit');

  const exposureKeys = canonicalExposureKeys(candidate);
  const duplicate = openPositions.find((position) => position?.status !== 'closed' && position?.status !== 'cancelled'
    && (position.instrumentKey === candidate?.instrumentKey
      || canonicalExposureKeys(position).some((key) => exposureKeys.includes(key))));
  if (duplicate) reasons.push(effectiveExposureDirection(duplicate) === effectiveExposureDirection(candidate)
    ? 'duplicate_open_exposure' : 'conflicting_open_exposure');
  const currencyConflict = duplicate ? null : openPositions.find((position) => ['reserved', 'filled', 'open'].includes(position?.status)
    && sharesDirectionalCurrencyExposure(candidate, position));
  const currencyConflictDetails = currencyConflict ? directionalCurrencyOverlap(candidate, currencyConflict).map((row) => ({
    currency: row.currency, direction: row.direction,
    existingInstrument: String(currencyConflict.instrumentKey || '').slice(0, 80),
    existingOwner: String(currencyConflict.owner || '').slice(0, 40),
  })) : [];
  if (currencyConflict) reasons.push('concentrated_currency_exposure');
  if (activePositions.length >= maxPositions) reasons.push('open_position_limit');

  if (equity > 0 && dailyPnl <= -(equity * dailyLossLimitPct / 100)) reasons.push('daily_loss_limit');

  const multiplier = finiteValue(candidate?.multiplier ?? 1, 1);
  const gainMultiplier = finiteValue(candidate?.gainMultiplier ?? multiplier, NaN);
  const lotSize = finiteValue(candidate?.lotSize ?? 1, 1);
  const safeEntry = finiteValue(entry, 0), safeStop = finiteValue(stop, 0), safeEquity = finiteValue(equity, 0);
  const feeReserve = Math.max(0, Number(candidate?.roundTripFeesPerUnit) || 0);
  const slippageReserve = Math.max(0, Number(candidate?.slippageReservePerUnit) || 0);
  const maxLossPrice = finitePositive(candidate?.maxLossPerUnit)
    ? Number(candidate.maxLossPerUnit) : Math.abs(safeEntry - safeStop);
  const perUnitRisk = maxLossPrice * multiplier + feeReserve + slippageReserve;
  const riskBudget = safeEquity > 0 ? safeEquity * maxTradeRiskPct / 100 : 0;
  const riskPerLot = perUnitRisk * Math.max(1, lotSize);
  const units = assetClass === 'crypto' ? floorRiskQuantity(riskBudget, perUnitRisk, cryptoRules?.quantityIncrement)
    : riskPerLot > 0 ? Math.floor(riskBudget / riskPerLot) * Math.max(1, lotSize) : 0;
  if (assetClass === 'crypto' && units > 0) {
    const sizeReason = cryptoOrderSizeRejection(cryptoRules, units, safeEntry);
    if (sizeReason) reasons.push(sizeReason);
  }
  const proposedRiskUsd = units * perUnitRisk;
  // Some listed wrappers (for example a 3x ETF) represent more underlying
  // exposure than their market-value notional. Keep P&L/share sizing tied to
  // the instrument itself, but use the declared exposure factor for the
  // portfolio gross-exposure circuit breaker.
  const proposedNotionalUsd = units * safeEntry * multiplier * (finitePositive(exposureMultiplier) ? exposureMultiplier : 1);
  const proposedInitialMarginUsd = assetClass === 'future' && finitePositive(candidate?.initialMarginUsd)
    ? units * Number(candidate.initialMarginUsd) : 0;
  const openInitialMargin = activePositions.reduce((sum, position) => sum + Math.max(0, Number(position.marginRequirementUsd) || 0), 0);
  const openRisk = openPositions.filter((x) => ['reserved', 'filled', 'open'].includes(x?.status)).reduce((sum, x) => sum + Math.max(0, Number(x.riskUsd) || 0), 0);
  const openNotional = openPositions.filter((x) => ['reserved', 'filled', 'open'].includes(x?.status)).reduce((sum, x) => sum + Math.max(0, Number(x.notionalUsd) || 0), 0);
  if (!(units > 0)) reasons.push('risk_budget_below_minimum_size');
  if (safeEquity > 0 && openRisk + proposedRiskUsd > safeEquity * maxTotalRiskPct / 100) reasons.push('combined_open_risk_limit');
  if (safeEquity > 0 && openNotional + proposedNotionalUsd > safeEquity * maxGrossExposurePct / 100) reasons.push('gross_exposure_limit');
  if (safeEquity > 0 && openInitialMargin + proposedInitialMarginUsd > safeEquity * rawMaxInitialMarginPct / 100) reasons.push('initial_margin_exposure_limit');

  const grossReward = direction === 'long' && target > entry ? (target - entry) * gainMultiplier
    : direction === 'short' && target < entry ? (entry - target) * gainMultiplier : NaN;
  const grossStopRisk = direction === 'long' && entry > stop ? (entry - stop) * multiplier
    : direction === 'short' && stop > entry ? (stop - entry) * multiplier : NaN;
  const roundTripCostReserve = feeReserve + slippageReserve;
  const netReward = Number.isFinite(grossReward) ? grossReward - roundTripCostReserve : NaN;
  const netStopRisk = Number.isFinite(grossStopRisk) ? grossStopRisk + roundTripCostReserve : NaN;
  const grossRewardRisk = grossReward / grossStopRisk;
  const riskReward = netStopRisk > 0 ? netReward / netStopRisk : NaN;
  if (!Number.isFinite(riskReward) || riskReward < minRewardRisk) reasons.push('reward_risk_below_minimum');

  const decision = {
    status: reasons.length ? 'blocked' : 'paper-approved',
    reasons: [...new Set(reasons)],
    paperOnly: true,
    owner: owner ?? null,
    ...(currencyConflictDetails.length ? { currencyExposureConflicts: currencyConflictDetails } : {}),
    riskLimits: {
      accountEquity: safeEquity,
      maxOpenPositions: maxPositions,
      maxTotalOpenRiskUsd: roundMoney(safeEquity * maxTotalRiskPct / 100),
      maxGrossExposureUsd: roundMoney(safeEquity * maxGrossExposurePct / 100),
      maxInitialMarginUsd: roundMoney(safeEquity * rawMaxInitialMarginPct / 100),
      maxDailyLossUsd: roundMoney(safeEquity * dailyLossLimitPct / 100),
      closedTradeCircuit: { maxConsecutiveLosses: closedCircuit.maxConsecutiveLosses,
        maxClosedDrawdownPct: closedCircuit.maxClosedDrawdownPct },
      maxOpenMarkAgeMs: rawMaxOpenMarkAgeMs,
      openPositionMarks: openMarkDiagnostics,
      realizedPnlTodayUsd: roundMoney(dailyLoss),
      unrealizedOpenPnlUsd: roundMoney(unrealizedPnl),
      dailyPnlUsd: roundMoney(dailyPnl),
      sessionDate,
      maxQuoteAgeMs,
      maxSpreadPct,
    },
    sizing: { units, riskBudgetUsd: roundMoney(riskBudget), proposedRiskUsd: roundMoney(proposedRiskUsd), proposedNotionalUsd: roundMoney(proposedNotionalUsd), notionalExposureMultiplier: Number.isFinite(exposureMultiplier) ? exposureMultiplier : null, proposedInitialMarginUsd: roundMoney(proposedInitialMarginUsd), spreadPct: Number.isFinite(spreadPct) ? Number(spreadPct.toFixed(4)) : null, rewardRisk: Number.isFinite(riskReward) ? Number(riskReward.toFixed(3)) : null, grossRewardRisk: Number.isFinite(grossRewardRisk) ? Number(grossRewardRisk.toFixed(3)) : null, estimatedNetRewardPerUnitUsd: Number.isFinite(netReward) ? roundMoney(netReward) : null, estimatedNetStopRiskPerUnitUsd: Number.isFinite(netStopRisk) ? roundMoney(netStopRisk) : null, roundTripCostReservePerUnitUsd: roundMoney(roundTripCostReserve) },
  };
  decision.approvalFingerprint = approvalFingerprint(candidate, decision);
  return decision;
}

async function acquireLock(lockPath, timeoutMs, operation = 'ledger-update') {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), operation, startedAt: new Date().toISOString() }));
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // Windows can report an exclusive-create collision as EPERM/EACCES.
        // Treat it as lock contention only when the lock path exists; genuine
        // access failures still propagate and fail closed.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
        try { await stat(lockPath); }
        catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error('Paper risk ledger is locked; no reservation was written.');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

function probePid(pid) {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}

/** Read-only lock diagnostics. Age alone never authorizes deleting a lock. */
export async function inspectPaperRiskLock({
  statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''),
  now = Date.now(), staleAfterMs = 60_000, host = hostname(), pidStatus = probePid,
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError('Lock inspection time and threshold must be valid.');
  const ledgerPath = resolve(statePath), lockPath = `${ledgerPath}.lock`;
  let details;
  try {
    const [file, raw] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8')]);
    let metadata;
    try { metadata = JSON.parse(raw); } catch { metadata = null; }
    const ageMs = Math.max(0, now - file.mtimeMs);
    const hasOwner = Number.isInteger(metadata?.pid) && metadata.pid > 0 && typeof metadata.hostname === 'string'
      && Number.isFinite(Date.parse(metadata.startedAt));
    const ownerProcess = !hasOwner ? 'unknown' : metadata.hostname !== host ? 'remote-unverifiable' : pidStatus(metadata.pid);
    details = {
      exists: true, ledgerPath, lockPath, ageMs: Math.round(ageMs), staleThresholdMs: staleAfterMs,
      olderThanThreshold: ageMs >= staleAfterMs,
      owner: hasOwner ? { pid: metadata.pid, hostname: metadata.hostname, operation: String(metadata.operation || 'unknown'), startedAt: metadata.startedAt } : null,
      ownerProcess,
      classification: !hasOwner ? 'metadata-missing-or-invalid'
        : ownerProcess === 'present' ? 'owner-process-present'
          : ownerProcess === 'absent' ? 'owner-process-absent'
            : ownerProcess === 'remote-unverifiable' ? 'owner-host-is-remote'
              : 'owner-process-unverifiable',
      recovery: 'manual-review-required; lock was not modified',
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, ledgerPath, lockPath, classification: 'unlocked' };
    throw error;
  }
  return details;
}

async function readLedger(path, { allowMissing = true } = {}) {
  try {
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.orders)
      || ledger.orders.some((order) => !order || typeof order !== 'object' || Array.isArray(order)
        || !LEDGER_ORDER_STATUSES.has(order.status)))
      throw new Error('Invalid paper risk ledger schema.');
    if (ledger.events == null) ledger.events = [];
    if (!Array.isArray(ledger.events) || ledger.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)))
      throw new Error('Invalid paper risk ledger events.');
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return { schemaVersion: 1, orders: [], events: [] };
    throw error;
  }
}

async function writeLedger(path, ledger) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, path);
}

export async function readPaperRiskLedger({ statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || '') } = {}) {
  const ledger = await readLedger(resolve(statePath));
  return structuredClone(ledger);
}

/** Persist a paper reservation atomically to coordinate bot processes sharing one local ledger. */
export async function reservePaperCandidate(candidate, decision, {
  statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''), lockTimeoutMs = 3_000,
  now = Date.now(), emergencyStop = process.env.OMNIMOD_EMERGENCY_STOP !== 'false', observationClock = null, externalRiskContext = null,
} = {}) {
  if (decision?.status !== 'paper-approved' || candidate?.mode !== 'paper') return { status: 'blocked', reason: 'paper_approval_required' };
  if (emergencyStop) return { status: 'blocked', reason: 'emergency_stop_active' };
  if (process.env.OMNIMOD_LIVE_TRADING_ENABLED === 'true') return { status: 'blocked', reason: 'live_trading_is_not_implemented' };
  if (!/^[a-f0-9]{64}$/.test(String(decision.approvalFingerprint ?? ''))
    || decision.approvalFingerprint !== approvalFingerprint(candidate, decision))
    return { status: 'blocked', reason: 'approval_candidate_mismatch' };
  if (!candidate?.instrumentKey || !candidate?.idempotencyKey || !decision.riskLimits
    || !finitePositive(decision.riskLimits.accountEquity) || !finitePositive(decision.riskLimits.maxQuoteAgeMs)
    || !hasExplicitNonNegativeFiniteAmount(decision.riskLimits.maxSpreadPct)
    || !Number.isInteger(decision.riskLimits.maxOpenPositions) || decision.riskLimits.maxOpenPositions < 1
    || !Number.isFinite(decision.riskLimits.maxTotalOpenRiskUsd) || decision.riskLimits.maxTotalOpenRiskUsd < 0
    || !Number.isFinite(decision.riskLimits.maxGrossExposureUsd) || decision.riskLimits.maxGrossExposureUsd < 0
    || !Number.isFinite(decision.riskLimits.maxInitialMarginUsd) || decision.riskLimits.maxInitialMarginUsd < 0
    || !Number.isFinite(decision.riskLimits.maxDailyLossUsd) || decision.riskLimits.maxDailyLossUsd < 0
    || !validStoredClosedCircuit(decision.riskLimits.closedTradeCircuit)
    || !finitePositive(decision.riskLimits.maxOpenMarkAgeMs) || decision.riskLimits.maxOpenMarkAgeMs > 24 * 60 * 60_000
    || decision.riskLimits.sessionDate !== (candidate.sessionDate ?? candidate.signal?.marketDate)
    || !(candidate.assetClass === 'crypto'
      ? cryptoOrderSizeRejection(candidate.cryptoInstrumentRules, decision.sizing?.units, candidate.entryPrice) === null
      : Number.isInteger(decision.sizing?.units)) || !(decision.sizing?.units > 0)
    || !Number.isFinite(Number(decision.sizing?.proposedRiskUsd)) || Number(decision.sizing.proposedRiskUsd) < 0
    || !Number.isFinite(Number(decision.sizing?.proposedNotionalUsd)) || Number(decision.sizing.proposedNotionalUsd) < 0
    || !Number.isFinite(Number(decision.sizing?.proposedInitialMarginUsd)) || Number(decision.sizing.proposedInitialMarginUsd) < 0) {
    return { status: 'blocked', reason: 'invalid_or_incomplete_approval' };
  }
  if (candidate.assetClass === 'crypto') {
    const reason = cryptoInstrumentRulesRejection(candidate.cryptoInstrumentRules, candidate.cryptoIdentity, now);
    if (reason) return { status: 'blocked', reason };
  }
  const quoteTime = Date.parse(candidate?.quoteTime);
  const forceExitAt = Date.parse(candidate?.forceExitAt);
  if (!Number.isFinite(forceExitAt) || forceExitAt <= now) return { status: 'blocked', reason: 'invalid_or_expired_time_exit' };
  const entryExpiresAt = candidate?.entryExpiresAt == null ? NaN : Date.parse(candidate.entryExpiresAt);
  if (candidate?.entryExpiresAt != null && (!Number.isFinite(entryExpiresAt) || entryExpiresAt <= now || entryExpiresAt > forceExitAt))
    return { status: 'blocked', reason: 'invalid_or_expired_entry_window' };
  if (!Number.isFinite(quoteTime) || quoteTime > now + MAX_QUOTE_FUTURE_SKEW_MS || now - quoteTime > Number(decision.riskLimits?.maxQuoteAgeMs)) {
    return { status: 'blocked', reason: 'quote_expired_before_reservation' };
  }
  const path = resolve(statePath), lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(lockPath, lockTimeoutMs, 'reserve-candidate');
  try {
    const ledger = await readLedger(path);
    let externalPortfolio = null;
    if (externalRiskContext !== null) {
      const externalPath = typeof externalRiskContext?.statePath === 'string' && externalRiskContext.statePath.trim() ? resolve(externalRiskContext.statePath) : null;
      if (!externalPath || externalPath === path || !['mirror', 'independent'].includes(externalRiskContext.mode)
        || typeof externalRiskContext.sourceIdempotencyKey !== 'string') return { status: 'blocked', reason: 'invalid_external_fill_risk_context' };
      const exists = await stat(externalPath).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      externalPortfolio = { ledgerPath: externalPath, mode: externalRiskContext.mode,
        sourceIdempotencyKey: externalRiskContext.sourceIdempotencyKey, requireExisting: exists };
    }
    // An approval made before an awaited ledger lock is not a fresh approval.
    // Historical fixtures keep their explicit time unless a clock is supplied.
    if (observationClock !== null) {
      let current;
      try { current = typeof observationClock === 'function' ? observationClock() : NaN; } catch { current = NaN; }
      if (!Number.isFinite(current) || !Number.isFinite(now) || current < now)
        return { status: 'blocked', reason: 'invalid_reservation_observation_clock' };
      now = current;
      if (forceExitAt <= now) return { status: 'blocked', reason: 'invalid_or_expired_time_exit' };
      if (Number.isFinite(entryExpiresAt) && entryExpiresAt <= now)
        return { status: 'blocked', reason: 'invalid_or_expired_entry_window' };
      if (quoteTime > now + MAX_QUOTE_FUTURE_SKEW_MS || now - quoteTime > Number(decision.riskLimits.maxQuoteAgeMs))
        return { status: 'blocked', reason: 'quote_expired_before_reservation' };
      if (candidate.assetClass === 'crypto') {
        const reason = cryptoInstrumentRulesRejection(candidate.cryptoInstrumentRules, candidate.cryptoIdentity, now);
        if (reason) return { status: 'blocked', reason };
      }
    }
    const existingKey = ledger.orders.find((order) => order.idempotencyKey === candidate.idempotencyKey);
    if (existingKey) return { status: 'duplicate', order: existingKey };
    const proposedAccountEquity = Number(decision.riskLimits.accountEquity);
    const closedCircuit = decision.riskLimits.closedTradeCircuit;
    const circuitEnabled = closedCircuit.maxConsecutiveLosses !== null || closedCircuit.maxClosedDrawdownPct !== null;
    if (ledger.closedTradeCircuit != null && !validStoredClosedCircuit(ledger.closedTradeCircuit))
      return { status: 'blocked', reason: 'closed_trade_circuit_policy_invalid_at_reservation' };
    if (ledger.closedTradeCircuit != null
      && (ledger.closedTradeCircuit.maxConsecutiveLosses !== closedCircuit.maxConsecutiveLosses
        || ledger.closedTradeCircuit.maxClosedDrawdownPct !== closedCircuit.maxClosedDrawdownPct))
      return { status: 'blocked', reason: 'closed_trade_circuit_policy_mismatch_at_reservation' };
    if (circuitEnabled) {
      const reason = closedCircuitReason(inspectClosedTradeSequence(withholdUnreconciledClosePnl(ledger.orders)), closedCircuit,
        proposedAccountEquity, '_at_reservation');
      if (reason) return { status: 'blocked', reason };
    }
    const exposureKey = canonicalExposureKey(candidate);
    const exposureKeys = canonicalExposureKeys(candidate);
    const activeExposure = ledger.orders.find((order) => ['reserved', 'filled', 'open'].includes(order.status)
      && (order.instrumentKey === candidate.instrumentKey
        || canonicalExposureKeys(order).some((key) => exposureKeys.includes(key))));
    if (activeExposure) return { status: 'exposure-conflict',
      reason: effectiveExposureDirection(activeExposure) === effectiveExposureDirection(candidate)
        ? 'duplicate_open_exposure_at_reservation' : 'conflicting_open_exposure_at_reservation',
      order: activeExposure };
    const active = ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
    if (active.some((order) => !hasValidActiveOrderRiskMetadata(order))) return {
      status: 'blocked', reason: 'active_order_risk_metadata_invalid_at_reservation',
      invalidActiveOrders: active.filter((order) => !hasValidActiveOrderRiskMetadata(order)).length,
    };
    const currencyExposure = active.find((order) => sharesDirectionalCurrencyExposure(candidate, order));
    if (currencyExposure) return { status: 'exposure-conflict', reason: 'concentrated_currency_exposure_at_reservation',
      conflictingCurrencies: directionalCurrencyOverlap(candidate, currencyExposure).map((row) => row.currency), order: currencyExposure };
    if (active.some((order) => !finitePositive(order.accountEquityUsd)
      || Math.abs(Number(order.accountEquityUsd) - proposedAccountEquity) > Math.max(0.01, proposedAccountEquity * 1e-9))) {
      return { status: 'blocked', reason: 'shared_account_equity_mismatch' };
    }
    const currentRisk = active.reduce((sum, order) => sum + Math.max(0, Number(order.riskUsd) || 0), 0);
    const currentNotional = active.reduce((sum, order) => sum + Math.max(0, Number(order.notionalUsd) || 0), 0);
    const currentInitialMargin = active.reduce((sum, order) => sum + Math.max(0, Number(order.marginRequirementUsd) || 0), 0);
    const currentRiskDateUtc = utcRiskDateAt(now);
    const missingRealizedPnlRows = closedOrdersMissingRiskDayPnl(ledger.orders, currentRiskDateUtc);
    if (missingRealizedPnlRows.length) return { status: 'blocked', reason: 'closed_trade_realized_pnl_unknown_at_reservation',
      unclassifiedClosedTrades: missingRealizedPnlRows.length };
    const missingRiskDateRows = closedOrdersMissingRiskDate(ledger.orders);
    if (missingRiskDateRows.length) return { status: 'blocked', reason: 'closed_trade_risk_day_unknown_at_reservation',
      unclassifiedClosedTrades: missingRiskDateRows.length };
    const unreconciledCostRows = closedOrdersUnreconciledRiskDayPnl(ledger.orders, currentRiskDateUtc);
    if (unreconciledCostRows.length) return { status: 'blocked', reason: 'closed_trade_cost_accounting_unavailable_at_reservation',
      unreconciledClosedTrades: unreconciledCostRows.length };
    const equityBasis = sharedEquityBasis(ledger, proposedAccountEquity);
    if (equityBasis.reason) return { status: 'blocked', reason: equityBasis.reason };
    const realizedToday = realizedPnlForUtcDay(ledger.orders, currentRiskDateUtc);
    const activeMarked = active.filter((order) => ['filled', 'open'].includes(order.status));
    const openMarkDiagnostics = inspectOpenPositionMarks(activeMarked, now, Number(decision.riskLimits.maxOpenMarkAgeMs));
    if (openMarkDiagnostics.staleCount > 0) return {
      status: 'blocked', reason: 'open_position_mark_stale_or_unavailable_at_reservation',
      openPositionMarks: openMarkDiagnostics,
    };
    if (activeMarked.some((order) => !hasExplicitFiniteAmount(order.unrealizedPnlUsd))) {
      return { status: 'blocked', reason: 'open_position_pnl_unavailable_at_reservation' };
    }
    const unrealizedOpen = activeMarked.reduce((sum, order) => sum + Number(order.unrealizedPnlUsd), 0);
    const dailyPnl = realizedToday + unrealizedOpen;
    if (dailyPnl <= -Number(decision.riskLimits.maxDailyLossUsd)) return {
      status: 'blocked', reason: 'daily_loss_limit_at_reservation',
      realizedPnlRiskDayUtcUsd: roundMoney(realizedToday), riskDayUtc: utcRiskDateAt(now),
      unrealizedOpenPnlUsd: roundMoney(unrealizedOpen), dailyPnlUsd: roundMoney(dailyPnl),
    };
    if (active.length >= Number(decision.riskLimits?.maxOpenPositions)) return { status: 'blocked', reason: 'open_position_limit_at_reservation' };
    if (currentRisk + Number(decision.sizing?.proposedRiskUsd) > Number(decision.riskLimits?.maxTotalOpenRiskUsd)) return { status: 'blocked', reason: 'combined_open_risk_limit_at_reservation' };
    if (currentNotional + Number(decision.sizing?.proposedNotionalUsd) > Number(decision.riskLimits?.maxGrossExposureUsd)) return { status: 'blocked', reason: 'gross_exposure_limit_at_reservation' };
    if (currentInitialMargin + Number(decision.sizing?.proposedInitialMarginUsd ?? 0) > Number(decision.riskLimits?.maxInitialMarginUsd)) return { status: 'blocked', reason: 'initial_margin_exposure_limit_at_reservation' };
    const entryRiskPolicy = { version: FILL_RISK_VERSION,
      ...Object.fromEntries(FILL_LIMIT_FIELDS.map(key => [key, Number(decision.riskLimits[key])])),
      closedTradeCircuit: { ...closedCircuit }, externalPortfolio };
    const reservedAt = new Date(now).toISOString();
    const order = {
      orderId: randomUUID(), idempotencyKey: candidate.idempotencyKey,
      owner: decision.owner, assetClass: candidate.assetClass, instrumentKey: candidate.instrumentKey,
      strategyId: candidate.strategyId ?? candidate.signal?.strategy ?? candidate.option?.strategy ?? 'unspecified',
      sessionDate: candidate.sessionDate ?? candidate.signal?.marketDate,
      sessionTimeZone: candidate.sessionTimeZone || 'UTC',
      exposureKey, exposureKeys, direction: candidate.direction, units: decision.sizing.units,
      entryPrice: Number(candidate.entryPrice), stopPrice: Number(candidate.stopPrice), targetPrice: Number(candidate.targetPrice),
      multiplier: Number(candidate.multiplier ?? 1),
      ...(candidate.gainMultiplier != null ? { gainMultiplier: Number(candidate.gainMultiplier) } : {}),
      exposureMultiplier: Number(candidate.exposureMultiplier ?? 1),
      initialMarginUsd: Number(candidate.initialMarginUsd ?? 0),
      maintenanceMarginUsd: Number(candidate.maintenanceMarginUsd ?? 0),
      marginRequirementUsd: Number(decision.sizing.proposedInitialMarginUsd ?? 0),
      roundTripFeesPerUnit: Number(candidate.roundTripFeesPerUnit),
      slippageReservePerUnit: Number(candidate.slippageReservePerUnit),
      forceExitAt: candidate.forceExitAt ?? null,
      entryExpiresAt: candidate.entryExpiresAt ?? null,
      riskUsd: decision.sizing.proposedRiskUsd, notionalUsd: decision.sizing.proposedNotionalUsd,
      accountEquityUsd: proposedAccountEquity,
      maxOpenMarkAgeMs: Number(decision.riskLimits.maxOpenMarkAgeMs),
      paperExecutionVersion: PAPER_EXECUTION_VERSION, entryRiskPolicy,
      entryQuotePolicy: { maxQuoteAgeMs: Number(decision.riskLimits.maxQuoteAgeMs),
        maxSpreadPct: Number(decision.riskLimits.maxSpreadPct) },
      quoteTime: candidate.quoteTime, status: 'reserved', paperOnly: true,
      ...(isStockQuoteInstrument(candidate.assetClass)
        ? { stockQuoteEvidence: normalizeStockQuoteEvidence(candidate.stockQuoteEvidence) } : {}),
      ...(candidate.assetClass === 'crypto' ? { cryptoIdentity: normalizeCryptoExecutionIdentity(candidate.cryptoIdentity),
        lotSize: Number(candidate.lotSize), cryptoInstrumentRules: normalizeCryptoInstrumentRules(candidate.cryptoInstrumentRules),
        cryptoQuoteEvidence: normalizeCryptoQuoteEvidence(candidate.cryptoQuoteEvidence) } : {}),
      ...(typeof candidate.experimentFingerprint === 'string' && /^[a-f0-9]{16}$/.test(candidate.experimentFingerprint)
        ? { experimentFingerprint: candidate.experimentFingerprint } : {}),
      researchContext: normalizePaperResearchContext(candidate.researchContext, candidate.quoteTime),
      approvalEvidence: paperApprovalEvidence(candidate, decision, reservedAt),
      ...(candidate.assetClass === 'option' && ['long', 'short'].includes(String(candidate.underlyingDirection || '').toLowerCase())
        ? { underlyingDirection: String(candidate.underlyingDirection).toLowerCase() } : {}),
      ...(candidate.assetClass === 'option' && candidate.optionGreekContext && typeof candidate.optionGreekContext === 'object'
        ? { optionGreekContext: structuredClone(candidate.optionGreekContext) } : {}),
      ...(candidate.assetClass === 'option' && candidate.option && typeof candidate.option === 'object'
        ? { option: structuredClone(candidate.option) } : {}),
      ...(candidate.assetClass === 'future' && candidate.future && typeof candidate.future === 'object'
        ? { future: structuredClone(candidate.future) } : {}),
      ...(candidate.executionCostContext && typeof candidate.executionCostContext === 'object'
        ? { executionCostContext: structuredClone(candidate.executionCostContext) } : {}),
      ...(['etf', 'etp'].includes(String(candidate.assetClass).toLowerCase()) && candidate.instrumentMetadata && typeof candidate.instrumentMetadata === 'object'
        ? { instrumentMetadata: structuredClone(candidate.instrumentMetadata) } : {}),
      reservedAt,
    };
    ledger.orders.push(order);
    ledger.accountEquityUsd = equityBasis.accountEquityUsd;
    if (circuitEnabled && ledger.closedTradeCircuit == null) ledger.closedTradeCircuit = { ...closedCircuit };
    ledger.events.push({ eventId: randomUUID(), orderId: order.orderId, type: 'reserved', at: order.reservedAt, idempotencyKey: order.idempotencyKey });
    await writeLedger(path, ledger);
    return { status: 'reserved', order };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

export async function transitionPaperOrder(orderId, nextStatus, { statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''), lockTimeoutMs = 3_000 } = {}) {
  const path = resolve(statePath), lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(lockPath, lockTimeoutMs, 'transition-order');
  try {
    const ledger = await readLedger(path);
    const order = ledger.orders.find((entry) => entry.orderId === orderId);
    if (!order) return { status: 'not-found' };
    if (order.status !== 'reserved' || nextStatus !== 'cancelled') return { status: 'invalid-transition', currentStatus: order.status, requestedStatus: nextStatus, reason: 'fills, exits, and open-position cancellations require a timestamped executable quote through processPaperQuote' };
    order.status = nextStatus;
    order.updatedAt = new Date().toISOString();
    ledger.events.push({ eventId: randomUUID(), orderId: order.orderId, type: nextStatus, at: order.updatedAt });
    await writeLedger(path, ledger);
    return { status: 'updated', order: structuredClone(order) };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

export const paperOrderTransitions = Object.freeze({
  reserved: ['filled', 'cancelled'], filled: ['closed', 'cancelled'], open: ['closed', 'cancelled'], closed: [], cancelled: [],
});

/** Apply one later executable quote to a paper order. Repeated/out-of-order marks are idempotently ignored. */
export async function processPaperQuote(orderId, quote, {
  statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''),
  now = Date.now(), maxQuoteAgeMs = 15_000, maxSpreadPct = 0.5,
  sessionOpen = true, emergencyStop = process.env.OMNIMOD_EMERGENCY_STOP !== 'false', expectedOwner, observationClock = null,
} = {}) {
  const path = resolve(statePath), lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(lockPath, 3_000, 'process-paper-quote');
  try {
    const ledger = await readLedger(path);
    if (typeof orderId !== 'string' || !orderId.trim()) return { status: 'blocked', reason: 'invalid_order_identity' };
    const matches = ledger.orders.filter((entry) => entry.orderId === orderId);
    if (matches.length > 1) return { status: 'blocked', reason: 'ambiguous_order_identity' };
    const order = matches[0];
    if (!order) return { status: 'not-found' };
    if (expectedOwner !== undefined && (!Object.values(OWNER_BY_CLASS).includes(expectedOwner) || order.owner !== expectedOwner))
      return { status: 'blocked', reason: 'order_owner_mismatch' };
    if (!['reserved', 'filled', 'open'].includes(order.status)) return { status: 'terminal', order: structuredClone(order) };
    let externalLedger = null, externalRiskLoadError = null;
    const external = order.entryRiskPolicy?.externalPortfolio;
    if (order.status === 'reserved' && external != null && !emergencyStop && validExternalRisk(external)) {
      try {
        if (resolve(external.ledgerPath) === path) throw new Error('Self-referencing external ledger.');
        externalLedger = await readLedger(resolve(external.ledgerPath), { allowMissing: !external.requireExisting });
      } catch { externalRiskLoadError = 'external_portfolio_risk_unavailable_at_fill'; }
    }
    if (observationClock !== null) {
      let current;
      try { current = typeof observationClock === 'function' ? observationClock() : NaN; } catch { current = NaN; }
      if (!Number.isFinite(current) || !Number.isFinite(now) || current < now) return { status: 'blocked', reason: 'invalid_execution_observation_clock' };
      now = current;
    }
    if (order.status === 'reserved' && emergencyStop) {
      order.status = 'cancelled'; order.cancelReason = 'emergency_stop_active'; order.cancelledAt = new Date(now).toISOString();
      ledger.events.push({ eventId: randomUUID(), orderId, type: 'cancelled', at: order.cancelledAt, reason: order.cancelReason });
      await writeLedger(path, ledger);
      return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
    }
    if (order.status === 'reserved' && order.entryExpiresAt && now >= Date.parse(order.entryExpiresAt)) {
      order.status = 'cancelled'; order.cancelReason = 'entry_window_expired'; order.cancelledAt = new Date(now).toISOString();
      ledger.events.push({ eventId: randomUUID(), orderId, type: 'cancelled', at: order.cancelledAt, reason: order.cancelReason });
      await writeLedger(path, ledger);
      return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
    }
    if (order.status === 'reserved' && order.forceExitAt && now >= Date.parse(order.forceExitAt)) {
      order.status = 'cancelled'; order.cancelReason = 'time_exit_before_fill'; order.cancelledAt = new Date(now).toISOString();
      ledger.events.push({ eventId: randomUUID(), orderId, type: 'cancelled', at: order.cancelledAt, reason: order.cancelReason });
      await writeLedger(path, ledger);
      return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
    }
    if (!hasValidActiveOrderRiskMetadata(order) || !hasValidActiveOrderExecutionState(order))
      return { status: 'blocked', reason: 'active_order_execution_metadata_invalid' };
    if (order.assetClass === 'crypto') {
      const storedKey = cryptoExecutionIdentityKey(order.cryptoIdentity);
      if (!storedKey) return { status: 'blocked', reason: 'legacy_crypto_execution_identity_unavailable' };
      const identityReason = cryptoIdentityRejection(quote?.cryptoIdentity, now);
      if (identityReason) return { status: 'blocked', reason: identityReason };
      if (storedKey !== cryptoExecutionIdentityKey(quote.cryptoIdentity)) return { status: 'blocked', reason: 'crypto_quote_identity_mismatch' };
    }
    if (!Number.isFinite(now) || !finitePositive(maxQuoteAgeMs) || !hasExplicitNonNegativeFiniteAmount(maxSpreadPct)) return { status: 'blocked', reason: 'invalid_quote_policy' };
    // Approval limits must survive restarts and a monitor with broader defaults.
    // Legacy reservations have no recorded limits: they may expire/cancel above,
    // but must not invent approval policy to fill. Legacy open positions can exit.
    const entryPolicy = order.entryQuotePolicy;
    if (order.status === 'reserved' && (!entryPolicy || Array.isArray(entryPolicy)
      || !finitePositive(entryPolicy.maxQuoteAgeMs) || !hasExplicitNonNegativeFiniteAmount(entryPolicy.maxSpreadPct))) {
      return { status: 'blocked', reason: 'entry_quote_policy_unavailable' };
    }
    const effectiveMaxQuoteAgeMs = order.status === 'reserved'
      ? Math.min(Number(maxQuoteAgeMs), Number(entryPolicy.maxQuoteAgeMs)) : Number(maxQuoteAgeMs);
    const effectiveMaxSpreadPct = order.status === 'reserved'
      ? Math.min(Number(maxSpreadPct), Number(entryPolicy.maxSpreadPct)) : Number(maxSpreadPct);
    const bid = finiteValue(quote?.bid, NaN), ask = finiteValue(quote?.ask, NaN);
    const quoteTime = Date.parse(typeof quote?.time === 'string' ? quote.time : '');
    // A vertical option spread has a zero lower bound, so its synchronized
    // liquidation quote may validly be 0 x 0 (or 0 x positive) when worthless.
    // Other asset classes still require a strictly positive bid.
    const validPrices = order.assetClass === 'option' ? bid >= 0 && ask >= bid : bid > 0 && ask >= bid;
    if (quote?.quality !== 'executable' || !validPrices || !Number.isFinite(quoteTime)
      || quoteTime > now + 5_000 || now - quoteTime > effectiveMaxQuoteAgeMs) return { status: 'blocked', reason: 'quote_not_current_and_executable' };
    if (order.status === 'reserved' && order.entryExpiresAt && quoteTime >= Date.parse(order.entryExpiresAt)) {
      order.status = 'cancelled'; order.cancelReason = 'entry_window_expired'; order.cancelledAt = new Date(quoteTime).toISOString();
      ledger.events.push({ eventId: randomUUID(), orderId, type: 'cancelled', at: order.cancelledAt, reason: order.cancelReason });
      await writeLedger(path, ledger);
      return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
    }
    if (order.status === 'reserved' && order.forceExitAt && quoteTime >= Date.parse(order.forceExitAt)) {
      order.status = 'cancelled'; order.cancelReason = 'time_exit_before_fill'; order.cancelledAt = new Date(quoteTime).toISOString();
      ledger.events.push({ eventId: randomUUID(), orderId, type: 'cancelled', at: order.cancelledAt, reason: order.cancelReason });
      await writeLedger(path, ledger);
      return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
    }
    if (order.assetClass === 'crypto') {
      const rulesReason = cryptoInstrumentRulesRejection(quote.cryptoInstrumentRules, order.cryptoIdentity, now)
        || cryptoPriceGridRejection(quote.cryptoInstrumentRules, bid, ask);
      if (rulesReason) return { status: 'blocked', reason: rulesReason };
      const evidenceReason = cryptoQuoteEvidenceRejection(order.cryptoIdentity, quote.cryptoQuoteEvidence, quote);
      if (evidenceReason) return { status: 'blocked', reason: evidenceReason };
    }
    const stockQuoteEvidence = isStockQuoteInstrument(order.assetClass)
      ? normalizeStockQuoteEvidence(quote.stockQuoteEvidence) : null;
    if (isStockQuoteInstrument(order.assetClass)) {
      const reason = stockQuoteEvidenceRejection(order.instrumentKey, quote.stockQuoteEvidence, quote, requiredStockQuoteFeed(order));
      if (reason) return { status: 'blocked', reason };
    }
    // A worthless option vertical can have a valid 0 x 0 liquidation quote.
    // Its absolute spread is zero; avoid turning 0 / 0 into a rejected mark.
    const spreadPct = bid === 0 && ask === 0 ? 0 : ((ask - bid) / ((ask + bid) / 2)) * 100;
    if (!Number.isFinite(spreadPct) || (order.status === 'reserved' && spreadPct > effectiveMaxSpreadPct)) return { status: 'blocked', reason: 'spread_limit' };
    const lastTime = Date.parse(order.lastProcessedQuoteTime ?? (order.status === 'filled' || order.status === 'open' ? order.filledAt : order.quoteTime));
    if (!Number.isFinite(lastTime) || quoteTime <= lastTime) return { status: 'duplicate_or_out_of_order_quote' };
    const currentDate = new Date(quoteTime).toISOString();
    const cryptoInstrumentRules = order.assetClass === 'crypto' ? normalizeCryptoInstrumentRules(quote.cryptoInstrumentRules) : null;
    const cryptoQuoteEvidence = order.assetClass === 'crypto'
      ? normalizeCryptoQuoteEvidence(quote.cryptoQuoteEvidence) : null;
    const addEvent = (type, details = {}) => {
      if (stockQuoteEvidence) order.lastStockQuoteEvidence = stockQuoteEvidence;
      if (cryptoQuoteEvidence) order.lastCryptoQuoteEvidence = cryptoQuoteEvidence;
      if (cryptoInstrumentRules) order.lastCryptoInstrumentRules = cryptoInstrumentRules;
      ledger.events.push({ eventId: randomUUID(), orderId, type, at: currentDate, ...details,
        ...(stockQuoteEvidence ? { stockQuoteEvidence } : {}),
        ...(cryptoQuoteEvidence ? { cryptoQuoteEvidence } : {}), ...(cryptoInstrumentRules ? { cryptoInstrumentRules } : {}) });
    };
    const updateMark = () => {
      if (stockQuoteEvidence) order.lastStockQuoteEvidence = stockQuoteEvidence;
      order.lastProcessedQuoteTime = currentDate;
      if (cryptoQuoteEvidence) order.lastCryptoQuoteEvidence = cryptoQuoteEvidence;
      if (cryptoInstrumentRules) order.lastCryptoInstrumentRules = cryptoInstrumentRules;
      const priorSamples = Number(order.positionQuoteSampleCount);
      order.positionQuoteSampleCount = (Number.isSafeInteger(priorSamples) && priorSamples > 0 ? priorSamples : 1) + 1;
      const priorGap = Number(order.maxPositionQuoteGapMs);
      order.maxPositionQuoteGapMs = Math.max(Number.isFinite(priorGap) && priorGap >= 0 ? priorGap : 0, quoteTime - lastTime);
    };
    const enoughDisplayedLiquidity = entry => !cryptoQuoteEvidence || Number(order.units) <=
      ((entry === (order.direction === 'long')) ? cryptoQuoteEvidence.askSize : cryptoQuoteEvidence.bidSize);
    const enoughStockLiquidity = entry => !stockQuoteEvidence || Number(order.units) <=
      ((entry === (order.direction === 'long')) ? stockQuoteEvidence.askSizeShares : stockQuoteEvidence.bidSizeShares);
    const fillOrClose = async (reason, price) => {
      const sizeReason = cryptoInstrumentRules ? cryptoOrderSizeRejection(cryptoInstrumentRules, order.units, price) : null;
      if (sizeReason) return { status: 'blocked', reason: sizeReason };
      if (!enoughDisplayedLiquidity(false)) return { status: 'blocked', reason: 'insufficient_displayed_crypto_liquidity' };
      if (!enoughStockLiquidity(false)) return { status: 'blocked', reason: 'insufficient_displayed_stock_liquidity' };
      const sign = order.direction === 'long' ? 1 : -1;
      const gross = modeledPaperGross(order, price, sign);
      const fees = Number(order.roundTripFeesPerUnit ?? 0) * Number(order.units);
      const slippage = Number(order.slippageReservePerUnit ?? 0) * Number(order.units);
      order.status = 'closed'; order.exitReason = reason; order.exitPrice = Number(price);
      order.exitQuote = { bid, ask, spreadPct };
      order.closedAt = currentDate; order.closedSessionDate = sessionDateAt(quoteTime, order.sessionTimeZone, order.sessionDate);
      order.closedPortfolioRiskDateUtc = utcRiskDateAt(quoteTime);
      order.grossPnlUsd = roundMoney(gross); order.feesUsd = roundMoney(fees);
      order.slippageUsd = roundMoney(slippage); order.realizedPnlUsd = roundMoney(gross - fees - slippage);
      addEvent('closed', { reason, exitPrice: order.exitPrice, realizedPnlUsd: order.realizedPnlUsd });
      await writeLedger(path, ledger);
      return { status: 'closed', order: structuredClone(order) };
    };

    if (order.status === 'reserved') {
      if (!sessionOpen) return { status: 'waiting', reason: 'entry_session_closed' };
      if (order.assetClass === 'option') {
        const entry = assessOptionEntryEvidence(order, quote, now, effectiveMaxQuoteAgeMs);
        if (!entry.valid) {
          if (!entry.cancel) return { status: 'blocked', reason: entry.reason };
          order.status = 'cancelled'; order.cancelReason = entry.reason; order.cancelledAt = currentDate;
          addEvent('cancelled', { reason: entry.reason, optionEntryEvidence: quote.optionEntryEvidence });
          await writeLedger(path, ledger);
          return { status: 'cancelled', reason: entry.reason, order: structuredClone(order) };
        }
      }
      const invalidated = order.direction === 'long' ? bid <= Number(order.stopPrice) : ask >= Number(order.stopPrice);
      const missed = order.direction === 'long' ? ask >= Number(order.targetPrice) : bid <= Number(order.targetPrice);
      if (invalidated || missed) {
        order.status = 'cancelled'; order.cancelReason = invalidated ? 'invalidated_before_fill' : 'target_passed_before_fill'; order.cancelledAt = currentDate;
        addEvent('cancelled', { reason: order.cancelReason }); await writeLedger(path, ledger);
        return { status: 'cancelled', reason: order.cancelReason, order: structuredClone(order) };
      }
      const fillable = order.direction === 'long' ? ask <= Number(order.entryPrice) : bid >= Number(order.entryPrice);
      if (!fillable) return { status: 'waiting', reason: 'limit_not_reached' };
      const sizeReason = cryptoInstrumentRules ? cryptoOrderSizeRejection(cryptoInstrumentRules, order.units, order.direction === 'long' ? ask : bid) : null;
      if (sizeReason) return { status: 'blocked', reason: sizeReason };
      if (!enoughDisplayedLiquidity(true)) return { status: 'blocked', reason: 'insufficient_displayed_crypto_liquidity' };
      if (!enoughStockLiquidity(true)) return { status: 'blocked', reason: 'insufficient_displayed_stock_liquidity' };
      const fillRisk = assessFillPortfolio(order, ledger, externalLedger, externalRiskLoadError, now,
        order.direction === 'long' ? ask : bid, order.direction === 'long' ? bid : ask);
      const priorRiskReason = order.lastFillRiskCheck?.reason;
      order.lastFillRiskCheck = fillRisk;
      if (fillRisk.status !== 'approved') {
        if (priorRiskReason !== fillRisk.reason) addEvent('fill_risk_blocked', { reason: fillRisk.reason, fillRisk });
        await writeLedger(path, ledger);
        return { status: 'blocked', reason: fillRisk.reason, fillRisk };
      }
      order.fillRiskEvidence = fillRisk;
      order.notionalUsd = Math.max(Number(order.notionalUsd), fillRisk.fillNotionalUsd);
      order.status = 'filled'; order.fillPrice = order.direction === 'long' ? ask : bid;
      if (order.assetClass === 'option') order.optionEntryEvidence = structuredClone(quote.optionEntryEvidence);
      order.filledAt = currentDate; order.fillQuote = { bid, ask, spreadPct };
      const immediateMarkPrice = order.direction === 'long' ? bid : ask;
      const immediateGross = modeledPaperGross(order, immediateMarkPrice);
      order.lastProcessedQuoteTime = currentDate;
      if (cryptoQuoteEvidence) order.lastCryptoQuoteEvidence = cryptoQuoteEvidence;
      if (cryptoInstrumentRules) order.lastCryptoInstrumentRules = cryptoInstrumentRules;
      order.markedAt = currentDate; order.markPrice = immediateMarkPrice;
      // The first sampled liquidation side already includes the entry spread.
      // Unsampled intrabar movement and real fill depth remain unknown.
      order.maxFavorableExcursionUsd = 0;
      order.maxAdverseExcursionUsd = roundMoney(Math.max(0, -immediateGross));
      order.positionQuoteSampleCount = 1;
      order.maxPositionQuoteGapMs = 0;
      order.unrealizedPnlUsd = roundMoney(immediateGross
        - (Number(order.roundTripFeesPerUnit) + Number(order.slippageReservePerUnit)) * Number(order.units));
      addEvent('filled', { fillPrice: order.fillPrice, units: order.units, spreadPct, fillRisk: order.fillRiskEvidence,
        ...(order.optionEntryEvidence ? { optionEntryEvidence: order.optionEntryEvidence } : {}) });
      await writeLedger(path, ledger);
      return { status: 'filled', order: structuredClone(order) };
    }

    if (!enoughDisplayedLiquidity(false)) return { status: 'blocked', reason: 'insufficient_displayed_crypto_liquidity' };
    if (!enoughStockLiquidity(false)) return { status: 'blocked', reason: 'insufficient_displayed_stock_liquidity' };
    updateMark();
    const greekContext = quote.optionGreekContext;
    if (order.assetClass === 'option' && greekContext && typeof greekContext === 'object') {
      const previousAsOf = Date.parse(order.latestOptionGreekContext?.asOf ?? '');
      const nextAsOf = Date.parse(greekContext.asOf ?? '');
      const previousIsUsable = Number.isFinite(previousAsOf) && previousAsOf <= now;
      const nextIsUsable = Number.isFinite(nextAsOf) && nextAsOf <= now;
      const firstUnknownSnapshot = !order.latestOptionGreekContext && !Number.isFinite(nextAsOf);
      if (firstUnknownSnapshot || (nextIsUsable && (!previousIsUsable || nextAsOf > previousAsOf))) {
        order.latestOptionGreekContext = structuredClone(greekContext);
        addEvent('option_greeks_marked', { asOf: greekContext.asOf ?? null, freshness: greekContext.freshness ?? 'unknown' });
      }
    }
    const markPrice = order.direction === 'long' ? bid : ask;
    const markGross = modeledPaperGross(order, markPrice);
    order.maxFavorableExcursionUsd = roundMoney(Math.max(Number(order.maxFavorableExcursionUsd) || 0, markGross, 0));
    order.maxAdverseExcursionUsd = roundMoney(Math.max(Number(order.maxAdverseExcursionUsd) || 0, -markGross, 0));
    order.markPrice = markPrice;
    order.markedAt = currentDate;
    order.unrealizedPnlUsd = roundMoney(markGross - (Number(order.roundTripFeesPerUnit) + Number(order.slippageReservePerUnit)) * Number(order.units));
    const stopHit = order.direction === 'long' ? bid <= Number(order.stopPrice) : ask >= Number(order.stopPrice);
    const targetHit = order.direction === 'long' ? bid >= Number(order.targetPrice) : ask <= Number(order.targetPrice);
    // A scan running after the deadline must not backdate a scheduled exit to a
    // quote captured before it. Wait for the first executable post-deadline quote.
    const forced = emergencyStop || (order.forceExitAt && quoteTime >= Date.parse(order.forceExitAt));
    if (stopHit) return await fillOrClose('stop', order.direction === 'long' ? bid : ask);
    if (forced) return await fillOrClose(emergencyStop ? 'emergency_stop' : 'time_exit', order.direction === 'long' ? bid : ask);
    if (targetHit) {
      // Legacy pre-grid targets keep their trigger; conservatively round the
      // modeled exit to a valid price without claiming a better historical fill.
      const price = cryptoInstrumentRules ? roundPriceIncrement(Number(order.targetPrice), cryptoInstrumentRules.priceIncrement, order.direction === 'long' ? 'down' : 'up') : Number(order.targetPrice);
      return await fillOrClose('target', price);
    }
    addEvent('marked', { markPrice, unrealizedPnlUsd: order.unrealizedPnlUsd });
    await writeLedger(path, ledger);
    return { status: 'open', order: structuredClone(order) };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Reconcile persisted paper rows when a runner starts again. This can cancel only
 * reservations whose entry/time window has elapsed (or all unfilled reservations
 * when the emergency stop is active). Open positions are deliberately left open
 * until a fresh executable quote is supplied through processPaperQuote.
 */
export async function recoverPaperOrders({
  statePath = resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''),
  now = Date.now(), emergencyStop = process.env.OMNIMOD_EMERGENCY_STOP !== 'false', owner,
} = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Recovery time must be finite.');
  if (owner !== undefined && !Object.values(OWNER_BY_CLASS).includes(owner)) throw new TypeError('Unknown paper recovery owner.');
  // Scanner callers always specify their owner. Omission preserves the explicit
  // operator recovery command's portfolio-wide emergency-stop behavior.
  const inScope = (order) => owner === undefined || order.owner === owner;
  const ledger = await readPaperRiskLedger({ statePath });
  const active = ledger.orders.filter((order) => inScope(order) && ['reserved', 'filled', 'open'].includes(order.status));
  const outcomes = [];
  for (const order of active) {
    if (order.status !== 'reserved') {
      const exitDue = Number.isFinite(Date.parse(order.forceExitAt)) && now >= Date.parse(order.forceExitAt);
      const reason = emergencyStop ? 'emergency_stop_waiting_for_fresh_executable_quote'
        : exitDue ? 'time_exit_waiting_for_fresh_executable_quote' : 'open_position_waiting_for_fresh_executable_quote';
      outcomes.push({ orderId: order.orderId, status: 'awaiting_fresh_executable_quote', priorStatus: order.status, reason });
      continue;
    }
    const expired = Number.isFinite(Date.parse(order.entryExpiresAt)) && now >= Date.parse(order.entryExpiresAt)
      || Number.isFinite(Date.parse(order.forceExitAt)) && now >= Date.parse(order.forceExitAt);
    if (!emergencyStop && !expired) {
      outcomes.push({ orderId: order.orderId, status: 'reservation_still_valid' });
      continue;
    }
    const result = await processPaperQuote(order.orderId, null, { statePath, now, emergencyStop, expectedOwner: owner });
    outcomes.push({ orderId: order.orderId, status: result.status, reason: result.reason || null });
  }
  const after = await readPaperRiskLedger({ statePath });
  return {
    at: new Date(now).toISOString(), emergencyStop, scope: owner ?? 'portfolio',
    cancelledReservations: outcomes.filter((row) => row.status === 'cancelled').length,
    awaitingFreshQuote: outcomes.filter((row) => row.status === 'awaiting_fresh_executable_quote').length,
    stillValidReservations: outcomes.filter((row) => row.status === 'reservation_still_valid').length,
    blockedOrders: outcomes.filter((row) => row.status === 'blocked').length,
    activeOrders: after.orders.filter((order) => inScope(order) && ['reserved', 'filled', 'open'].includes(order.status)).length,
    outcomes,
  };
}

export function summarizePaperLedger(ledger, { accountEquity = 0, sessionDate = null, now = Date.now() } = {}) {
  const orders = Array.isArray(ledger?.orders) ? ledger.orders : [];
  const closeSequence = inspectClosedTradeSequence(withholdUnreconciledClosePnl(orders));
  const allClosed = orders.filter((order) => order.status === 'closed');
  const closed = orders.filter((order) => order.status === 'closed' && hasExplicitFiniteAmount(order.realizedPnlUsd));
  const missingRealizedPnl = allClosed.length - closed.length;
  const unreconciledClosed = allClosed.filter((order) => inspectClosedPaperAccounting(order).status !== 'reconciled');
  const completeAfterCostSample = unreconciledClosed.length === 0;
  const accountingMismatchCount = allClosed.filter((order) => inspectClosedPaperAccounting(order).status === 'mismatch').length;
  const missingSessionPnl = allClosed.some((order) => !order.closedSessionDate
    || order.closedSessionDate === sessionDate && inspectClosedPaperAccounting(order).status !== 'reconciled');
  const today = closed.filter((order) => order.closedSessionDate === sessionDate);
  const realizedPnlToday = today.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0);
  const riskDateUtc = utcRiskDateAt(now);
  const realizedPnlRiskDayUtc = realizedPnlForUtcDay(orders, riskDateUtc);
  const missingRiskDayPnl = closedOrdersMissingRiskDayPnl(orders, riskDateUtc).length > 0
    || closedOrdersUnreconciledRiskDayPnl(orders, riskDateUtc).length > 0
    || closedOrdersMissingRiskDate(orders).length > 0;
  const unclassifiedClosedTrades = closedOrdersMissingRiskDate(orders).length;
  const wins = closed.filter((order) => Number(order.realizedPnlUsd) > 0);
  const losses = closed.filter((order) => Number(order.realizedPnlUsd) < 0);
  const grossProfit = wins.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0);
  const grossLoss = Math.abs(losses.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0));
  const openOrders = orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
  const reservedOrders = openOrders.filter((order) => order.status === 'reserved');
  const filledOrders = openOrders.filter((order) => ['filled', 'open'].includes(order.status));
  const missingOpenPnl = filledOrders.some((order) => !hasExplicitFiniteAmount(order.unrealizedPnlUsd));
  const grouped = Object.groupBy ? Object.groupBy(closed, (order) => `${order.owner}:${order.strategyId}`)
    : closed.reduce((groups, order) => ((groups[`${order.owner}:${order.strategyId}`] ||= []).push(order), groups), {});
  const average = (rows) => rows.length ? roundMoney(rows.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0) / rows.length) : null;
  return {
    accountEquity: Number(accountEquity), realizedPnlTodayUsd: missingSessionPnl ? null : roundMoney(realizedPnlToday),
    riskDayUtc: riskDateUtc, realizedPnlRiskDayUtcUsd: missingRiskDayPnl ? null : roundMoney(realizedPnlRiskDayUtc), unclassifiedClosedTrades, closedTradesMissingRealizedPnl: missingRealizedPnl,
    closedTradesUnreconciledCostAccounting: unreconciledClosed.length,
    afterCostEvidenceStatus: !allClosed.length ? 'no_closed_sample' : completeAfterCostSample
      ? 'reconciled_after_cost_sample' : missingRealizedPnl ? 'incomplete_net_pnl'
        : accountingMismatchCount ? 'pnl_accounting_mismatch' : 'incomplete_cost_breakdown',
    pendingFillRisk: summarizePendingFillRisk(reservedOrders),
    openCount: openOrders.length, activeReservationCount: reservedOrders.length, filledOpenCount: filledOrders.length,
    openRiskUsd: roundMoney(openOrders.reduce((sum, order) => sum + Number(order.riskUsd || 0), 0)),
    openNotionalUsd: roundMoney(openOrders.reduce((sum, order) => sum + Number(order.notionalUsd || 0), 0)),
    unrealizedPnlUsd: missingOpenPnl ? null : roundMoney(filledOrders.reduce((sum, order) => sum + Number(order.unrealizedPnlUsd), 0)),
    openInitialMarginUsd: roundMoney(openOrders.reduce((sum, order) => sum + Number(order.marginRequirementUsd || 0), 0)),
    closedCount: closed.length, wins: wins.length, losses: losses.length,
    winRatePct: completeAfterCostSample && closed.length ? Number((wins.length / closed.length * 100).toFixed(2)) : null,
    averageWinUsd: completeAfterCostSample ? average(wins) : null,
    averageLossUsd: completeAfterCostSample ? average(losses) : null,
    netPnlUsd: completeAfterCostSample ? roundMoney(closed.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0)) : null,
    expectancyUsd: completeAfterCostSample && closed.length
      ? roundMoney(closed.reduce((sum, order) => sum + Number(order.realizedPnlUsd), 0) / closed.length) : null,
    exits: {
      target: closed.filter((order) => order.exitReason === 'target').length,
      stop: closed.filter((order) => order.exitReason === 'stop').length,
      time: closed.filter((order) => order.exitReason === 'time_exit').length,
      emergency: closed.filter((order) => order.exitReason === 'emergency_stop').length,
    },
    profitFactor: grossLoss > 0 && completeAfterCostSample ? Number((grossProfit / grossLoss).toFixed(3)) : null,
    maxDrawdownUsd: closeSequence.maximumDrawdownUsd,
    currentDrawdownUsd: closeSequence.currentDrawdownUsd,
    maximumConsecutiveLosses: closeSequence.maximumConsecutiveLosses,
    currentConsecutiveLosses: closeSequence.currentConsecutiveLosses,
    closeSequenceStatus: closeSequence.status,
    closeSequenceObservationCount: closeSequence.observationCount,
    closedTradeCircuit: summarizeClosedTradeCircuit(ledger, accountEquity || ledger?.accountEquityUsd),
    excursionSampleCount: closed.filter((order) => order.maxFavorableExcursionUsd != null && order.maxAdverseExcursionUsd != null
      && Number.isFinite(Number(order.maxFavorableExcursionUsd)) && Number.isFinite(Number(order.maxAdverseExcursionUsd))).length,
    averageMaxFavorableExcursionUsd: averageMetric(closed, 'maxFavorableExcursionUsd'),
    averageMaxAdverseExcursionUsd: averageMetric(closed, 'maxAdverseExcursionUsd'),
    positionQuoteCoverageCount: closed.filter(hasPositionQuoteCoverage).length,
    averagePositionQuoteSamples: averageMetric(closed.filter(hasPositionQuoteCoverage), 'positionQuoteSampleCount'),
    averageMaxPositionQuoteGapMs: averageMetric(closed.filter(hasPositionQuoteCoverage), 'maxPositionQuoteGapMs'),
    byBotAndStrategy: Object.fromEntries(Object.entries(grouped).map(([key, rows]) => {
      const groupWins = rows.filter((order) => Number(order.realizedPnlUsd) > 0);
      const groupLosses = rows.filter((order) => Number(order.realizedPnlUsd) < 0);
      const completeGroup = allClosed.filter((order) => `${order.owner}:${order.strategyId}` === key)
        .every((order) => inspectClosedPaperAccounting(order).status === 'reconciled');
      return [key, { closedCount: rows.length,
        netPnlUsd: completeGroup ? roundMoney(rows.reduce((sum, row) => sum + Number(row.realizedPnlUsd), 0)) : null,
        averageWinUsd: completeGroup ? average(groupWins) : null, averageLossUsd: completeGroup ? average(groupLosses) : null,
        excursionSampleCount: rows.filter((order) => order.maxFavorableExcursionUsd != null && order.maxAdverseExcursionUsd != null
          && Number.isFinite(Number(order.maxFavorableExcursionUsd)) && Number.isFinite(Number(order.maxAdverseExcursionUsd))).length,
        averageMaxFavorableExcursionUsd: averageMetric(rows, 'maxFavorableExcursionUsd'), averageMaxAdverseExcursionUsd: averageMetric(rows, 'maxAdverseExcursionUsd'),
        positionQuoteCoverageCount: rows.filter(hasPositionQuoteCoverage).length,
        averagePositionQuoteSamples: averageMetric(rows.filter(hasPositionQuoteCoverage), 'positionQuoteSampleCount'),
        averageMaxPositionQuoteGapMs: averageMetric(rows.filter(hasPositionQuoteCoverage), 'maxPositionQuoteGapMs') }];
    })),
  };
}

function averageMetric(rows, key) {
  const available = rows.filter((row) => row[key] != null && Number.isFinite(Number(row[key])));
  return available.length ? roundMoney(available.reduce((sum, row) => sum + Number(row[key]), 0) / available.length) : null;
}

function hasPositionQuoteCoverage(order) {
  return Number.isSafeInteger(Number(order.positionQuoteSampleCount)) && Number(order.positionQuoteSampleCount) > 0
    && Number.isFinite(Number(order.maxPositionQuoteGapMs)) && Number(order.maxPositionQuoteGapMs) >= 0;
}
