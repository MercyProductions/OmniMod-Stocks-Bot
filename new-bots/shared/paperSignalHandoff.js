import { publishPrimaryResearchSignals } from './signalResearch.js';
import { effectiveExposureDirection } from './exposureAliases.js';

const PRIMARY_OWNERS = new Set(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);

/** Select a small, explicit set of reserved paper setups for the delivered cross-bot advisory line. */
export function buildPaperResearchHandoffRows(owner, results = [], { limit = 3 } = {}) {
  if (!PRIMARY_OWNERS.has(owner)) throw new TypeError('Unknown primary paper-signal owner.');
  if (!Array.isArray(results) || !Number.isInteger(limit) || limit < 0 || limit > 10) {
    throw new TypeError('Paper research results and a limit from 0 to 10 are required.');
  }
  if (limit === 0) return [];
  const rows = [];
  const seen = new Set();
  for (const result of results) {
    const strategyResult = result?.strategy && typeof result.strategy === 'object' ? result.strategy : result;
    if (strategyResult?.status !== 'reserved') continue;
    const order = strategyResult?.reservation?.order;
    const candidate = strategyResult?.candidate ?? result?.candidate;
    const researchSignal = candidate?.researchSignal ?? candidate?.signal ?? order?.researchSignal ?? {};
    const direction = candidate?.underlyingDirection ?? researchSignal.direction
      ?? effectiveExposureDirection({ ...order, ...candidate });
    if (!order || order.paperOnly !== true || !['long', 'short'].includes(direction)) continue;
    const identity = String(order.orderId ?? order.idempotencyKey ?? '').trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const symbol = String(researchSignal.underlyingSymbol ?? researchSignal.symbol ?? candidate?.exposureKey ?? order.exposureKey ?? order.instrumentKey ?? '').trim().toUpperCase();
    const exposureKey = String(candidate?.exposureKey ?? order.exposureKey ?? symbol).trim().toUpperCase();
    const observedAt = order.reservedAt ?? result?.observedAt ?? '';
    if (!symbol || !exposureKey || !Number.isFinite(Date.parse(observedAt))) continue;
    rows.push({
      id: identity,
      signalId: identity,
      symbol,
      instrumentKey: String(order.instrumentKey ?? symbol).toUpperCase(),
      exposureKey,
      direction,
      action: direction,
      strategyFamily: 'intraday_day_trade',
      strategyId: String(order.strategyId ?? 'intraday-paper').slice(0, 100),
      sessionDate: String(candidate?.sessionDate ?? order.sessionDate ?? researchSignal.sessionDate ?? ''),
      observedAt,
      entryExpiresAt: order.entryExpiresAt ?? candidate?.entryExpiresAt ?? null,
      forceExitAt: order.forceExitAt ?? candidate?.forceExitAt ?? null,
      entryPrice: Number(researchSignal.underlyingPrice ?? researchSignal.currentPrice ?? candidate?.underlyingPrice ?? order.entryPrice),
      entryLow: Number.isFinite(Number(researchSignal.entryLow)) ? Number(researchSignal.entryLow) : null,
      entryHigh: Number.isFinite(Number(researchSignal.entryHigh)) ? Number(researchSignal.entryHigh) : null,
      stopPrice: Number(researchSignal.underlyingStop ?? researchSignal.stopPrice ?? candidate?.underlyingStop ?? order.stopPrice),
      targetPrice: Number(researchSignal.underlyingTarget ?? researchSignal.targetPrice ?? candidate?.underlyingTarget ?? order.targetPrice),
      status: 'active',
      paperOnly: true,
      executable: false,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export function formatPaperResearchHandoff(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return 'Cross-bot paper context: no reserved setup selected.';
  const compact = (value) => Number.isFinite(Number(value)) ? Number(value).toPrecision(6) : 'n/a';
  return `Cross-bot paper context (advisory only): ${rows.map((row) =>
    `${row.symbol} ${row.direction.toUpperCase()} · entry ${compact(row.entryPrice)} · stop ${compact(row.stopPrice)} · target ${compact(row.targetPrice)}`
  ).join(' | ')}`;
}

/** Publish only after the matching Discord summary was accepted by the webhook. */
export async function publishDeliveredPaperResearch(owner, rows, delivery, options = {}) {
  if (!delivery?.posted) return { status: 'not-delivered', rowsWritten: 0, rowsRejected: 0 };
  try {
    const handoff = await publishPrimaryResearchSignals(owner, rows, options);
    return { status: 'published', rowsWritten: handoff.rowsWritten, rowsRejected: handoff.rowsRejected,
      rejectionCounts: handoff.rejectionCounts };
  } catch (error) {
    return { status: 'journal_error', rowsWritten: 0, rowsRejected: rows.length,
      error: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 160) };
  }
}
