import { marketDateAt } from '../../shared/marketDate.js';

const ACTIVE_STATUSES = new Set(['reserved', 'filled', 'open']);
const POSITION_STATUSES = new Set(['filled', 'open']);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function dateDistanceDays(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * Report option orders that need lifecycle attention without guessing settlement,
 * exercise, assignment, or post-expiry value.
 */
export function summarizeOptionExpiryLifecycle(orders, now = Date.now(), timeZone = 'America/New_York') {
  if (!Array.isArray(orders)) throw new TypeError('Option expiry lifecycle needs an orders array.');
  if (!Number.isFinite(now)) throw new TypeError('Option expiry lifecycle needs a finite timestamp.');
  const today = marketDateAt(now, timeZone);
  const active = orders.filter((order) => order?.owner === 'options' && order?.assetClass === 'option'
    && ACTIVE_STATUSES.has(String(order?.status ?? '').toLowerCase()));
  const positions = active.filter((order) => POSITION_STATUSES.has(String(order?.status ?? '').toLowerCase()));
  let pastExpiryPositions = 0;
  let pastExpiryReservations = 0;
  let expiryTodayPositions = 0;
  let expiryTodayReservations = 0;
  let expiryWithinThreeDaysPositions = 0;
  let missingOrInvalidExpiry = 0;
  for (const order of active) {
    const expiry = String(order?.option?.expiry ?? order?.expiry ?? '');
    if (!validDate(expiry)) {
      missingOrInvalidExpiry += 1;
      continue;
    }
    const days = dateDistanceDays(today, expiry);
    const isPosition = POSITION_STATUSES.has(String(order.status).toLowerCase());
    if (days < 0) {
      if (isPosition) pastExpiryPositions += 1;
      else pastExpiryReservations += 1;
    } else if (days === 0) {
      if (isPosition) expiryTodayPositions += 1;
      else expiryTodayReservations += 1;
    }
    else if (isPosition && days <= 3) expiryWithinThreeDaysPositions += 1;
  }
  return {
    status: pastExpiryPositions || pastExpiryReservations || expiryTodayPositions || expiryTodayReservations || missingOrInvalidExpiry
      ? 'attention_required' : 'clear',
    marketDate: today,
    activeOrders: active.length,
    openPositions: positions.length,
    pastExpiryPositions,
    pastExpiryReservations,
    expiryTodayPositions,
    expiryTodayReservations,
    expiryWithinThreeDaysPositions,
    missingOrInvalidExpiry,
    semantics: 'Calendar-date alert only. No option settlement, exercise, assignment, or expiry value is inferred; verify and resolve flagged paper records manually.',
  };
}
