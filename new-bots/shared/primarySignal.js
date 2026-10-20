import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger } from './paperRisk.js';
import { hasExplicitNonNegativeFiniteAmount } from './strategyConfig.js';
import { cryptoIdentityRejection, normalizeCryptoExecutionIdentity, paperQuoteLookupKey, cryptoExecutionIdentityKey, cryptoExposureKey } from './cryptoExecutionIdentity.js';

import { cryptoQuoteEvidenceRejection, normalizeCryptoQuoteEvidence } from './cryptoQuoteEvidence.js';
import { stockQuoteEvidenceRejection, normalizeStockQuoteEvidence } from './stockQuoteEvidence.js';

import { normalizeCryptoInstrumentRules, cryptoInstrumentRulesRejection } from './cryptoInstrumentRules.js';

import { roundPriceIncrement } from './decimalQuantity.js';

const asTime = (value) => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);
const roundMoney = (value) => Number(value.toFixed(2));

export function sharedPaperPolicy(config = {}, now = Date.now()) {
  return {
    now,
    maxQuoteAgeMs: Number(config.sharedPaperMaxQuoteAgeMs ?? 15_000),
    maxOpenMarkAgeMs: Number(config.sharedPaperMaxOpenMarkAgeMs ?? 5 * 60_000),
    maxOpenPositions: Number(config.sharedPaperMaxOpenPositions ?? 5),
    maxTradeRiskPct: Number(config.sharedPaperMaxTradeRiskPct ?? 0.25),
    maxTotalOpenRiskPct: Number(config.sharedPaperMaxTotalOpenRiskPct ?? 1),
    maxGrossExposurePct: Number(config.sharedPaperMaxGrossExposurePct ?? 150),
    maxInitialMarginPct: Number(config.sharedPaperMaxInitialMarginPct ?? 50),
    maxDailyLossPct: Number(config.sharedPaperMaxDailyLossPct ?? 1),
    maxSpreadPct: Number(config.sharedPaperMaxSpreadPct ?? 0.5),
    minRewardRisk: Number(config.sharedPaperMinRewardRisk ?? 1.25),
    emergencyStop: config.sharedPaperEmergencyStop !== false,
    liveTradingEnabled: false,
  };
}

export function isSharedPaperConfigured(config = {}) {
  return Number.isFinite(Number(config.sharedPaperAccountEquity)) && Number(config.sharedPaperAccountEquity) > 0
    && Boolean(config.sharedPaperStatePath) && config.sharedPaperCostAssumptionsConfigured !== false;
}

export async function reserveSharedPaperCandidate(candidate, config = {}, now = Date.now()) {
  if (!isSharedPaperConfigured(config)) return { status: 'not-configured' };
  const statePath = config.sharedPaperStatePath;
  const ledger = await readPaperRiskLedger({ statePath });
  const summary = summarizePaperLedger(ledger, {
    accountEquity: config.sharedPaperAccountEquity,
    sessionDate: candidate.sessionDate,
    now,
  });
  const portfolio = {
    accountEquity: Number(config.sharedPaperAccountEquity),
    realizedPnlToday: summary.realizedPnlRiskDayUtcUsd,
    openPositions: ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status)),
    closedOrders: ledger.orders.filter((order) => order.status === 'closed'),
  };
  const policy = sharedPaperPolicy(config, now);
  const decision = evaluatePaperCandidate(candidate, portfolio, policy);
  if (decision.status !== 'paper-approved') return { status: 'blocked', reasons: decision.reasons, decision };
  const reservation = await reservePaperCandidate(candidate, decision, {
    statePath, now, emergencyStop: policy.emergencyStop,
  });
  return { ...reservation, decision };
}

export async function markSharedPaperOrders({ owner, quotesBySymbol, config = {}, now, clock = now === undefined ? Date.now : () => now, sessionOpen = true }) {
  if (!['stocks', 'crypto'].includes(owner)) throw new TypeError('Unknown primary paper owner.');
  if (!config.sharedPaperStatePath) return { status: 'not-configured', processed: 0, expectedPositions: 0, quotesProvided: 0, quoteMissing: 0, quoteRejected: 0, staleOrUnmarkedPositions: 0 };
  const recovery = await recoverPaperOrders({ owner, statePath: config.sharedPaperStatePath, now: clock(), emergencyStop: config.sharedPaperEmergencyStop !== false });
  const ledger = await readPaperRiskLedger({ statePath: config.sharedPaperStatePath });
  const active = ledger.orders.filter((order) => order.owner === owner && ['reserved', 'filled', 'open'].includes(order.status));
  const monitored = active.filter((order) => ['filled', 'open'].includes(order.status));
  let processed = 0, quotesProvided = 0, quoteMissing = 0, quoteRejected = 0;
  const rejectionReasons = {};
  for (const order of active) {
    const key = paperQuoteLookupKey(order);
    if (owner === 'crypto' && !key) {
      quoteRejected++;
      rejectionReasons.legacy_crypto_execution_identity_unavailable = (rejectionReasons.legacy_crypto_execution_identity_unavailable || 0) + 1;
      continue;
    }
    const quote = quotesBySymbol.get(key);
    if (!quote) { if (['filled', 'open'].includes(order.status)) quoteMissing++; continue; }
    quotesProvided++;
    let result;
    try {
      const at = clock();
      result = await processPaperQuote(order.orderId, quote, {
        statePath: config.sharedPaperStatePath, now: at, observationClock: clock, expectedOwner: owner, maxQuoteAgeMs: config.sharedPaperMaxQuoteAgeMs,
        maxSpreadPct: config.sharedPaperMaxSpreadPct, sessionOpen: typeof sessionOpen === 'function' ? sessionOpen(at) : sessionOpen,
        emergencyStop: config.sharedPaperEmergencyStop !== false,
      });
    } catch (error) {
      quoteRejected++;
      const code = String(error.code || error.message || 'mark_error').slice(0, 80);
      rejectionReasons[code] = (rejectionReasons[code] || 0) + 1;
      continue;
    }
    if (['blocked', 'duplicate_or_out_of_order_quote'].includes(result.status)) {
      quoteRejected++;
      rejectionReasons[result.reason || result.status] = (rejectionReasons[result.reason || result.status] || 0) + 1;
    }
    processed += 1;
  }
  const after = await readPaperRiskLedger({ statePath: config.sharedPaperStatePath });
  const completedAt = clock();
  const stillOpen = after.orders.filter((order) => order.owner === owner && ['filled', 'open'].includes(order.status));
  const maxAgeMs = Number(config.sharedPaperMaxOpenMarkAgeMs ?? 5 * 60_000);
  const staleOrUnmarkedPositions = stillOpen.filter((order) => {
    const markAt = Date.parse(order.markedAt ?? order.lastProcessedQuoteTime ?? order.filledAt ?? '');
    const age = Number.isFinite(markAt) ? completedAt - markAt : Infinity;
    const effectiveMaxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 1_000 && maxAgeMs <= 24 * 60 * 60_000
      ? Math.min(maxAgeMs, Number(order.maxOpenMarkAgeMs) || maxAgeMs) : 0;
    return !Number.isFinite(markAt) || markAt > completedAt + 5_000 || age > effectiveMaxAge;
  }).length;
  return { status: 'processed', processed, expectedPositions: monitored.length, quotesProvided, quoteMissing, quoteRejected,
    rejectionReasons, freshPositions: stillOpen.length - staleOrUnmarkedPositions, staleOrUnmarkedPositions, recovery };
}

/** Copy the paper ledger's lifecycle status onto matching primary-bot tracker rows. */
export async function reconcileSharedPaperOrders({ owner, predictions = [], config = {}, now = Date.now(), activeStatuses = ['pending_entry', 'tracking', 'target_tracking'] } = {}) {
  if (!config.sharedPaperStatePath) return { status: 'not-configured', predictions, linked: 0, missing: 0, ownerMismatch: 0, activeDivergence: 0, statusChanges: 0 };
  if (!['stocks', 'crypto'].includes(owner)) throw new Error('Shared tracker reconciliation is only supported for primary signal owners.');
  if (!Array.isArray(predictions) || !Array.isArray(activeStatuses) || !Number.isFinite(now)) throw new TypeError('Tracker reconciliation input is invalid.');
  const ledger = await readPaperRiskLedger({ statePath: config.sharedPaperStatePath });
  const byId = new Map(ledger.orders.map((order) => [String(order.orderId), order]));
  const activeLocal = new Set(activeStatuses.map((status) => String(status)));
  const optionalNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  let linked = 0, missing = 0, ownerMismatch = 0, activeDivergence = 0, statusChanges = 0;
  const synced = predictions.map((prediction) => {
    const orderId = String(prediction?.sharedPaperOrderId ?? '');
    if (!orderId) return prediction;
    const order = byId.get(orderId);
    if (!order) {
      missing++;
      const changed = prediction.sharedPaperStatus !== 'ledger_record_missing';
      if (changed) statusChanges++;
      return { ...prediction, sharedPaperStatus: 'ledger_record_missing', ...(changed ? { sharedPaperStatusChangedAt: new Date(now).toISOString() } : {}) };
    }
    if (order.owner !== owner) {
      ownerMismatch++;
      const changed = prediction.sharedPaperStatus !== 'ledger_owner_mismatch';
      if (changed) statusChanges++;
      return { ...prediction, sharedPaperStatus: 'ledger_owner_mismatch', ...(changed ? { sharedPaperStatusChangedAt: new Date(now).toISOString() } : {}) };
    }
    linked++;
    const localIsActive = activeLocal.has(String(prediction.status));
    const ledgerIsActive = ['reserved', 'filled', 'open'].includes(order.status);
    if (localIsActive !== ledgerIsActive) activeDivergence++;
    const changed = prediction.sharedPaperStatus !== order.status;
    if (changed) statusChanges++;
    return {
      ...prediction,
      sharedPaperStatus: order.status,
      sharedPaperLedgerCheckedAt: new Date(now).toISOString(),
      sharedPaperOrderUpdatedAt: order.updatedAt || order.lastProcessedQuoteTime || order.closedAt || order.filledAt || order.reservedAt || null,
      sharedPaperFillPrice: optionalNumber(order.fillPrice),
      sharedPaperExitReason: order.exitReason || order.cancelReason || null,
      sharedPaperRealizedPnlUsd: optionalNumber(order.realizedPnlUsd),
      sharedPaperUnrealizedPnlUsd: optionalNumber(order.unrealizedPnlUsd),
      sharedPaperMarkPrice: optionalNumber(order.markPrice),
      ...(changed ? { sharedPaperStatusChangedAt: new Date(now).toISOString() } : {}),
    };
  });
  return { status: 'available', predictions: synced, linked, missing, ownerMismatch, activeDivergence, statusChanges };
}

export async function getSharedPaperDiagnostics(config = {}, { sessionDate, now = Date.now() } = {}) {
  if (!Boolean(config.sharedPaperStatePath) || !Number.isFinite(Number(config.sharedPaperAccountEquity)) || Number(config.sharedPaperAccountEquity) <= 0)
    return { status: 'not_configured', emergencyStop: true };
  try {
    const ledger = await readPaperRiskLedger({ statePath: config.sharedPaperStatePath });
    const active = ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status));
    const summary = summarizePaperLedger(ledger, { accountEquity: config.sharedPaperAccountEquity, sessionDate, now });
    const staleMarkCutoffMs = Number(config.sharedPaperMaxQuoteAgeMs) * 4;
    const unmarked = active.filter((order) => {
      const last = Date.parse(order.lastProcessedQuoteTime || order.filledAt || order.reservedAt || order.quoteTime);
      return !Number.isFinite(last) || now - last > staleMarkCutoffMs;
    }).length;
    const byBot = {};
    for (const order of active) {
      const item = byBot[order.owner] ||= { active: 0, reserved: 0, filled: 0, openRiskUsd: 0, notionalUsd: 0, unrealizedPnlUsd: 0 };
      item.active += 1;
      if (order.status === 'reserved') item.reserved += 1; else item.filled += 1;
      item.openRiskUsd += Number(order.riskUsd) || 0;
      item.notionalUsd += Number(order.notionalUsd) || 0;
      item.unrealizedPnlUsd += Number(order.unrealizedPnlUsd) || 0;
    }
    for (const item of Object.values(byBot)) for (const key of ['openRiskUsd', 'notionalUsd', 'unrealizedPnlUsd']) item[key] = roundMoney(item[key]);
    return {
      status: 'available', emergencyStop: config.sharedPaperEmergencyStop !== false,
      newReservationReadiness: config.sharedPaperCostAssumptionsConfigured === false ? 'blocked_missing_stock_fee_assumption' : 'cost_configuration_ready',
      generatedAt: new Date(now).toISOString(), activeOrders: active.length,
      activeReservations: summary.activeReservationCount, filledOpen: summary.filledOpenCount,
      openRiskUsd: summary.openRiskUsd, openNotionalUsd: summary.openNotionalUsd,
      unrealizedPnlUsd: summary.unrealizedPnlUsd, realizedPnlTodayUsd: summary.realizedPnlTodayUsd,
      riskDayUtc: summary.riskDayUtc, realizedPnlRiskDayUtcUsd: summary.realizedPnlRiskDayUtcUsd,
      staleOrUnmarked: unmarked, closedTrades: summary.closedCount, netPnlUsd: summary.netPnlUsd,
      expectancyUsd: summary.expectancyUsd, profitFactor: summary.profitFactor, maxDrawdownUsd: summary.maxDrawdownUsd,
      byBot,
    };
  } catch (error) {
    return { status: 'unavailable', emergencyStop: config.sharedPaperEmergencyStop !== false,
      error: String(error?.message || error).slice(0, 160) };
  }
}

/** Convert an existing qualified long signal and its executable quote to the shared paper schema. */
export function buildPrimarySignalCandidate({
  owner, assetClass, symbol, exposureKey = symbol, strategyId, signalId, sessionDate,
  sessionTimeZone = 'UTC',
  quote, now = Date.now(), entryLow = null, entryHigh = null, stopPct, targetPct,
  forceExitAt, entryExpiresAt = null, maxQuoteAgeMs = 15_000, sessionOpen = false,
  roundTripFeesPerUnit, slippageReservePerUnit, signal = {}, researchContext = null, marketGateTrace = null,
}) {
  const reasons = [];
  if (owner === 'stocks') {
    const reason = stockQuoteEvidenceRejection(String(symbol || '').trim().toUpperCase(), quote?.stockQuoteEvidence, quote);
    if (reason) reasons.push(reason);
  }
  const cryptoRules = owner === 'crypto' ? normalizeCryptoInstrumentRules(quote?.cryptoInstrumentRules) : null;
  const cryptoIdentity = owner === 'crypto' ? normalizeCryptoExecutionIdentity(quote?.cryptoIdentity) : null;
  if (owner === 'crypto') {
    const identityReason = cryptoIdentityRejection(cryptoIdentity, now);
    if (identityReason) reasons.push(identityReason);
    const rulesReason = cryptoInstrumentRulesRejection(cryptoRules, cryptoIdentity, now);
    if (rulesReason) reasons.push(rulesReason);
    const evidenceReason = cryptoQuoteEvidenceRejection(cryptoIdentity, quote?.cryptoQuoteEvidence, quote);
    if (evidenceReason) reasons.push(evidenceReason);
    if (signal.assetId && signal.assetId !== cryptoIdentity?.assetId) reasons.push('crypto_signal_asset_identity_mismatch');
  }
  const bid = Number(quote?.bid), ask = Number(quote?.ask), quoteTime = asTime(quote?.time);
  if (!['stocks', 'crypto'].includes(owner) || !['stock', 'crypto'].includes(assetClass)) reasons.push('invalid_primary_signal_owner_or_asset_class');
  if (!symbol || !exposureKey || !strategyId || !signalId) reasons.push('missing_signal_identity');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate ?? ''))) reasons.push('invalid_session_date');
  if (quote?.quality !== 'executable' || !(bid > 0) || !(ask >= bid)) reasons.push('fresh_executable_bid_ask_required');
  if (!Number.isFinite(quoteTime) || quoteTime > now + 5_000 || now - quoteTime > maxQuoteAgeMs) reasons.push('stale_or_future_quote');
  if (!(Number(stopPct) > 0) || !(Number(targetPct) > 0) || !Number.isFinite(Number(stopPct)) || !Number.isFinite(Number(targetPct))) reasons.push('invalid_signal_levels');
  if (!hasExplicitNonNegativeFiniteAmount(roundTripFeesPerUnit)
    || !hasExplicitNonNegativeFiniteAmount(slippageReservePerUnit)) reasons.push('execution_cost_reserve_missing');
  const entryPrice = ask;
  if (entryLow != null && Number.isFinite(Number(entryLow)) && entryPrice < Number(entryLow)) reasons.push('quote_below_signal_entry_zone');
  if (entryHigh != null && Number.isFinite(Number(entryHigh)) && entryPrice > Number(entryHigh)) reasons.push('quote_above_signal_chase_limit');
  const exitTime = asTime(forceExitAt);
  const entryExpiry = entryExpiresAt == null ? NaN : asTime(entryExpiresAt);
  if (!Number.isFinite(exitTime) || exitTime <= now) reasons.push('invalid_or_expired_time_exit');
  if (Number.isFinite(entryExpiry) && entryExpiry <= now) reasons.push('entry_window_expired');
  if (Number.isFinite(entryExpiry) && Number.isFinite(exitTime) && entryExpiry > exitTime) reasons.push('entry_window_exceeds_time_exit');
  if (sessionOpen !== true) reasons.push('outside_configured_session');
  if (reasons.length) return { status: 'rejected', reasons: [...new Set(reasons)] };

  const normalizedSymbol = String(symbol).trim().toUpperCase();
  const normalizedExposure = cryptoIdentity ? cryptoExposureKey(cryptoIdentity) : String(exposureKey).trim().toUpperCase();
  const rawStop = entryPrice * (1 - Number(stopPct) / 100), rawTarget = entryPrice * (1 + Number(targetPct) / 100);
  const stopPrice = cryptoRules ? roundPriceIncrement(rawStop, cryptoRules.priceIncrement, 'down') : rawStop;
  const targetPrice = cryptoRules ? roundPriceIncrement(rawTarget, cryptoRules.priceIncrement, 'up') : rawTarget;
  if (cryptoRules && (!(stopPrice > 0 && stopPrice < entryPrice) || !(targetPrice > entryPrice)))
    return { status: 'rejected', reasons: ['crypto_price_grid_invalid_geometry'] };
  const candidate = {
    mode: 'paper', owner, assetClass, instrumentKey: normalizedSymbol, exposureKey: normalizedExposure,
    strategyId, sessionDate, sessionTimeZone, idempotencyKey: `${cryptoIdentity ? cryptoExecutionIdentityKey(cryptoIdentity) : normalizedSymbol}:${sessionDate}:${strategyId}:${signalId}`,
    direction: 'long', bid, ask, entryPrice, stopPrice, targetPrice,
    quoteTime: new Date(quoteTime).toISOString(), quoteQuality: 'executable', sessionOpen: true,
    multiplier: 1, lotSize: cryptoRules ? Number(cryptoRules.quantityIncrement) : 1, roundTripFeesPerUnit: Number(roundTripFeesPerUnit),
    slippageReservePerUnit: Number(slippageReservePerUnit), forceExitAt: new Date(exitTime).toISOString(),
    ...(Number.isFinite(entryExpiry) ? { entryExpiresAt: new Date(entryExpiry).toISOString() } : {}),
    signal: { ...signal, strategy: strategyId, signalId, sessionDate },
    ...(owner === 'stocks' ? { stockQuoteEvidence: normalizeStockQuoteEvidence(quote.stockQuoteEvidence) } : {}),
    ...(cryptoIdentity ? { cryptoIdentity, cryptoInstrumentRules: cryptoRules,
      cryptoQuoteEvidence: normalizeCryptoQuoteEvidence(quote.cryptoQuoteEvidence) } : {}),
    ...(researchContext ? { researchContext } : {}),
    ...(marketGateTrace ? { marketGateTrace } : {}),
  };
  return { status: 'candidate', candidate };
}
