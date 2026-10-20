import { isIntradayPrimaryResearch } from '../../shared/signalResearch.js';

const SOURCE_PRIORITY = ['stocks', 'etfs-etps'];

function isPositiveNumeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  if (typeof value === 'string' && !value.trim()) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isSessionDate(value) {
  const date = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function rejectionReasons(record) {
  const reasons = [];
  if (!SOURCE_PRIORITY.includes(record?.owner)) reasons.push('unsupported_source_owner');
  if (record?.status !== 'active') reasons.push('source_status_not_active');
  if (!isIntradayPrimaryResearch(record)) reasons.push('strategy_not_intraday_day_trade');
  if (!['long', 'short'].includes(record?.direction)) reasons.push('direction_invalid_or_missing');
  if (typeof record?.symbol !== 'string' || !record.symbol.trim()) reasons.push('symbol_missing');
  if (!isPositiveNumeric(record?.entryPrice)) reasons.push('entry_price_invalid');
  if (!isPositiveNumeric(record?.targetPrice)) reasons.push('target_price_invalid');
  if (!Number.isFinite(Date.parse(record?.observedAt))) reasons.push('observation_time_invalid');
  if (!isSessionDate(record?.sessionDate)) reasons.push('session_date_invalid');
  return reasons;
}

function rejectionDetail(record, reasons) {
  const field = (value, limit = 100) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit) || null;
  return { recordId: field(record?.id ?? record?.signalId), owner: field(record?.owner, 30),
    symbol: field(record?.symbol, 32)?.toUpperCase() ?? null, reasons };
}

/** Map fresh delivered Stocks/ETF paper signals, withholding cross-source direction conflicts per underlying. */
export function resolveOptionSignalsFromShared(records, reviewFile) {
  if (!Array.isArray(records)) throw new TypeError('Shared primary signals must be an array.');
  if (!reviewFile || !Array.isArray(reviewFile.reviews)
    || reviewFile.assignmentReviews !== undefined && !Array.isArray(reviewFile.assignmentReviews)) {
    throw new TypeError('Options review file must contain reviews and an optional assignmentReviews array.');
  }
  const reviews = new Map();
  for (const review of reviewFile.reviews) {
    const symbol = String(review?.symbol ?? '').trim().toUpperCase();
    if (symbol) reviews.set(symbol, review);
  }
  const assignmentReviews = new Map();
  for (const review of reviewFile.assignmentReviews ?? []) {
    const symbol = String(review?.symbol ?? '').trim().toUpperCase();
    if (symbol) assignmentReviews.set(symbol, review);
  }
  const grouped = new Map();
  const rejectedRecords = [];
  const rejectionCounts = {};
  let eligibleRecords = 0;
  for (const record of records) {
    const reasons = rejectionReasons(record);
    if (reasons.length) {
      rejectedRecords.push(rejectionDetail(record, reasons));
      for (const reason of reasons) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      continue;
    }
    eligibleRecords += 1;
    const symbol = String(record.symbol).trim().toUpperCase();
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol).push(record);
  }
  const conflicts = [];
  const selected = [];
  for (const [symbol, rows] of grouped) {
    const directions = [...new Set(rows.map((row) => row.direction))].sort();
    if (directions.length > 1) {
      conflicts.push({ symbol, directions,
        owners: [...new Set(rows.map((row) => row.owner))].sort((a, b) => SOURCE_PRIORITY.indexOf(a) - SOURCE_PRIORITY.indexOf(b)) });
      continue;
    }
    const sorted = [...rows].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
      || SOURCE_PRIORITY.indexOf(a.owner) - SOURCE_PRIORITY.indexOf(b.owner));
    selected.push({ record: sorted[0], sourceOwners: [...new Set(rows.map((row) => row.owner))]
      .sort((a, b) => SOURCE_PRIORITY.indexOf(a) - SOURCE_PRIORITY.indexOf(b)), sourceSignalIds: [...new Set(rows.map((row) => row.id ?? row.signalId).filter(Boolean))] });
  }
  selected.sort((a, b) => Date.parse(b.record.observedAt) - Date.parse(a.record.observedAt)
    || a.record.symbol.localeCompare(b.record.symbol));
  const rows = selected.map(({ record, sourceOwners, sourceSignalIds }) => ({ signal: {
      underlyingSymbol: String(record.symbol).toUpperCase(), sessionDate: record.sessionDate, direction: record.direction,
      underlyingPrice: Number(record.entryPrice), underlyingTarget: Number(record.targetPrice),
      underlyingStop: record.stopPrice ?? null,
      entryLow: record.entryLow, entryHigh: record.entryHigh, observedAt: record.observedAt,
      entryExpiresAt: record.entryExpiresAt ?? null, forceExitAt: record.forceExitAt ?? null,
      signalId: record.signalId, primarySignalId: record.id, primarySignalOwner: record.owner,
      primarySignalOwners: sourceOwners, primarySignalIds: sourceSignalIds, sessionOpen: false, sessionClose: null,
      catalystContextStatus: record.catalystContextStatus || 'unknown',
      catalystContext: (record.catalystContext || []).slice(0, 2),
      catalystReview: reviews.get(String(record.symbol).toUpperCase()) ?? { status: 'missing' },
      optionAssignmentReview: assignmentReviews.get(String(record.symbol).toUpperCase()) ?? { status: 'missing' },
    } }));
  const sourceCounts = Object.fromEntries(SOURCE_PRIORITY.map((owner) => [owner, records.filter((record) => record?.owner === owner).length]));
  return { rows, diagnostics: { status: 'complete', sourceOwners: SOURCE_PRIORITY, sourceCounts,
    inputRecords: records.length, eligibleRecords, rejectedRecordCount: rejectedRecords.length,
    rejectionCounts, rejectedRecords,
    mappedUnderlyings: rows.length, directionConflicts: conflicts.length, conflicts } };
}

/** Compatibility helper returning only mapped rows for existing callers. */
export function buildOptionSignalsFromShared(records, reviewFile) {
  return resolveOptionSignalsFromShared(records, reviewFile).rows;
}
