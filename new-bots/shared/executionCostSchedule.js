const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new TypeError(`${name} must be a UTC ISO timestamp ending in Z.`);
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== new Date(value).toISOString()) {
    throw new TypeError(`${name} must be a valid UTC ISO timestamp.`);
  }
  return result;
}

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 500) throw new TypeError('Cost schedule source must be a credential-free HTTPS URL.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Cost schedule source must be a credential-free HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Cost schedule source must be a credential-free HTTPS URL without query or fragment.');
  }
  return parsed.toString();
}

/** Validate one replay's time-bounded fees/slippage table; schedule gaps are intentional blocks. */
export function validateExecutionCostSchedule(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10_000) {
    throw new TypeError('Execution cost schedule must be an array with 1 to 10,000 rows.');
  }
  const ids = new Set();
  const normalized = rows.map((row) => {
    const id = String(row?.id ?? '').trim();
    if (!SAFE_ID.test(id) || ids.has(id)) throw new TypeError('Execution cost schedule row IDs must be unique safe labels.');
    ids.add(id);
    const validFromMs = timestamp(row.validFrom, `${id}.validFrom`);
    const validUntilMs = timestamp(row.validUntil, `${id}.validUntil`);
    const roundTripFeesPerUnit = Number(row.roundTripFeesPerUnit);
    const slippageReservePerUnit = Number(row.slippageReservePerUnit);
    if (validUntilMs <= validFromMs || !Number.isFinite(roundTripFeesPerUnit) || roundTripFeesPerUnit < 0
      || !Number.isFinite(slippageReservePerUnit) || slippageReservePerUnit < 0) {
      throw new TypeError(`Execution cost schedule row ${id} has an invalid time range or nonnegative cost value.`);
    }
    return { id, validFrom: new Date(validFromMs).toISOString(), validUntil: new Date(validUntilMs).toISOString(),
      validFromMs, validUntilMs, roundTripFeesPerUnit, slippageReservePerUnit, source: sourceUrl(row.source) };
  }).sort((left, right) => left.validFromMs - right.validFromMs);
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].validFromMs < normalized[i - 1].validUntilMs) {
      throw new TypeError(`Execution cost schedule rows ${normalized[i - 1].id} and ${normalized[i].id} overlap.`);
    }
  }
  return normalized;
}

export function executionCostsAt(schedule, at) {
  if (!Array.isArray(schedule)) throw new TypeError('Validated execution cost schedule is required.');
  const timestampMs = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(timestampMs)) throw new TypeError('Execution cost lookup requires a valid timestamp.');
  let low = 0, high = schedule.length - 1, row = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = schedule[middle];
    if (timestampMs < item.validFromMs) high = middle - 1;
    else if (timestampMs >= item.validUntilMs) low = middle + 1;
    else { row = item; break; }
  }
  if (!row) return null;
  return { id: row.id, validFrom: row.validFrom, validUntil: row.validUntil,
    roundTripFeesPerUnit: row.roundTripFeesPerUnit, slippageReservePerUnit: row.slippageReservePerUnit, source: row.source };
}
