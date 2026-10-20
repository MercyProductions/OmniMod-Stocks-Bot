import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const safeName = (value, maxLength = 40) => String(value ?? '').trim().replace(/[^A-Za-z0-9._ -]/g, '').slice(0, maxLength);
const safeCount = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

/** Retain timestamped feed-health evidence without quote prices or raw error text. */
export function buildKrakenWebsocketSmokeHistoryRow(payload = {}) {
  const checkedAt = Date.parse(payload.checkedAt ?? '');
  if (!Number.isFinite(checkedAt) || !['PASS_PROVIDER_AGGREGATION_ONLY', 'FAIL_OR_INCOMPLETE'].includes(payload.status)
    || !Array.isArray(payload.observations)) throw new TypeError('A valid Kraken WebSocket smoke observation is required.');
  const symbols = payload.observations.map((row) => {
    const ageMs = Number(row?.ageMs);
    const rejections = Object.fromEntries(Object.entries(row?.rejectionCounts || {})
      .map(([reason, count]) => [safeName(reason, 64), safeCount(count)])
      .filter(([reason, count]) => reason && count > 0).sort((a, b) => a[0].localeCompare(b[0])));
    return {
      symbol: safeName(row?.symbol, 16).toUpperCase(),
      providerTimestampPresent: row?.providerTimestampPresent === true,
      quoteValid: row?.quoteValid === true,
      ageMs: Number.isFinite(ageMs) && Math.abs(ageMs) <= 300_000 ? Math.round(ageMs) : null,
      acceptedProviders: [...new Set((Array.isArray(row?.acceptedProviders) ? row.acceptedProviders : [])
        .map((provider) => safeName(provider)).filter(Boolean))].sort(),
      providerCount: safeCount(row?.providerCount),
      krakenAccepted: row?.krakenAccepted === true,
      conflicted: row?.conflicted === true,
      rejectionCounts: rejections,
      providerErrorCount: safeCount(row?.providerErrorNames?.length),
    };
  }).filter((row) => row.symbol);
  return {
    schemaVersion: 1,
    checkedAt: new Date(checkedAt).toISOString(),
    status: payload.status,
    elapsedMs: safeCount(payload.elapsedMs),
    symbols,
  };
}

export async function appendKrakenWebsocketSmokeHistory(row, { path } = {}) {
  if (!path || row?.schemaVersion !== 1 || !Number.isFinite(Date.parse(row.checkedAt))) {
    throw new TypeError('A history path and validated Kraken WebSocket smoke row are required.');
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  return path;
}
