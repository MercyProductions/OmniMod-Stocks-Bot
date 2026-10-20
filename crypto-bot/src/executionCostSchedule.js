const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function parseUtc(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new TypeError(`${label} must be a UTC ISO timestamp ending in Z.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== new Date(value).toISOString()) throw new TypeError(`${label} must be a valid UTC ISO timestamp.`);
  return time;
}

function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Execution cost source must be a credential-free HTTPS URL.'); }
  if (typeof value !== 'string' || value.length > 500 || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) throw new TypeError('Execution cost source must be HTTPS and contain no credentials, query, or fragment.');
  return url.toString();
}

/** Validate explicitly supplied per-side fee/slippage assumptions for offline crypto replay. */
export function validateExecutionCostSchedule(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10_000) throw new TypeError('Cost schedule must contain 1 to 10,000 rows.');
  const ids = new Set();
  const normalized = rows.map((row) => {
    const id = String(row?.id ?? '').trim();
    if (!SAFE_ID.test(id) || ids.has(id)) throw new TypeError('Cost schedule row IDs must be unique safe labels.');
    ids.add(id);
    const validFrom = parseUtc(row.validFrom, `${id}.validFrom`), validUntil = parseUtc(row.validUntil, `${id}.validUntil`);
    const feeBpsPerSide = Number(row.feeBpsPerSide), slippageBpsPerSide = Number(row.slippageBpsPerSide);
    const quotedSpreadBps = row.quotedSpreadBps === undefined ? null : Number(row.quotedSpreadBps);
    if (validUntil <= validFrom || !Number.isFinite(feeBpsPerSide) || feeBpsPerSide < 0 || feeBpsPerSide > 100 || !Number.isFinite(slippageBpsPerSide) || slippageBpsPerSide < 0 || slippageBpsPerSide > 100) throw new RangeError(`Cost schedule row ${id} has an invalid interval or cost; each per-side value must be 0–100 bps.`);
    if (quotedSpreadBps !== null && (!Number.isFinite(quotedSpreadBps) || quotedSpreadBps < 0 || quotedSpreadBps > 200)) throw new RangeError(`Cost schedule row ${id} quotedSpreadBps must be from 0 through 200.`);
    return { id, validFrom: new Date(validFrom).toISOString(), validUntil: new Date(validUntil).toISOString(), validFromMs: validFrom, validUntilMs: validUntil, feeBpsPerSide, slippageBpsPerSide, quotedSpreadBps, source: sourceUrl(row.source) };
  }).sort((a, b) => a.validFromMs - b.validFromMs);
  for (let index = 1; index < normalized.length; index += 1) if (normalized[index].validFromMs < normalized[index - 1].validUntilMs) throw new TypeError(`Cost schedule rows ${normalized[index - 1].id} and ${normalized[index].id} overlap.`);
  return normalized;
}

export function executionCostsAt(schedule, timestamp) {
  const at = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(at)) throw new TypeError('Cost schedule lookup requires a valid timestamp.');
  let low = 0, high = schedule.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, item = schedule[middle];
    if (at < item.validFromMs) high = middle - 1;
    else if (at >= item.validUntilMs) low = middle + 1;
    else return { id: item.id, validFrom: item.validFrom, validUntil: item.validUntil, feeBpsPerSide: item.feeBpsPerSide, slippageBpsPerSide: item.slippageBpsPerSide, quotedSpreadBps: item.quotedSpreadBps, source: item.source };
  }
  return null;
}

export function scheduledCryptoCostModelAt(schedule, timestamp, fallbackQuotedSpreadBps = 0) {
  const row = executionCostsAt(schedule, timestamp);
  if (!row) return null;
  const fallback = Number(fallbackQuotedSpreadBps);
  if (!Number.isFinite(fallback) || fallback < 0 || fallback > 200) throw new RangeError('Fallback quoted spread must be from 0 through 200 bps.');
  const quotedSpreadBps = row.quotedSpreadBps ?? fallback;
  const roundTripBps = 2 * row.feeBpsPerSide + quotedSpreadBps + 2 * row.slippageBpsPerSide;
  if (roundTripBps > 200) throw new RangeError(`Scheduled costs for ${row.id} exceed the 200 bps replay limit.`);
  return { mode: 'dated_schedule', scheduleRowId: row.id, source: row.source, validFrom: row.validFrom,
    validUntil: row.validUntil, feeBpsPerSide: row.feeBpsPerSide, quotedSpreadBps,
    slippageBpsPerSide: row.slippageBpsPerSide, roundTripBps };
}
