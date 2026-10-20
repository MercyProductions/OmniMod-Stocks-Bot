export function conservativeApyRate(pool) {
  if (pool?.apy == null || pool?.apyMean30d == null) return Number.NEGATIVE_INFINITY;
  const current = Number(pool.apy), mean = Number(pool.apyMean30d);
  if (!Number.isFinite(current) || !Number.isFinite(mean) || current <= 0 || mean <= 0) return Number.NEGATIVE_INFINITY;
  return Math.min(current, mean);
}

export function poolTimestampStatus(pool, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000) {
  if (pool?.timestamp == null || pool.timestamp === '') return { eligible: true, upstreamAgeMinutes: null, status: 'upstream timestamp unavailable' };
  const timestamp = Date.parse(pool.timestamp);
  if (!Number.isFinite(timestamp)) return { eligible: false, upstreamAgeMinutes: null, status: 'invalid upstream timestamp' };
  const ageMinutes = (now - timestamp) / 60000;
  if (ageMinutes < -1) return { eligible: false, upstreamAgeMinutes: Number(ageMinutes.toFixed(1)), status: 'future upstream timestamp' };
  if (ageMinutes * 60000 > maxAgeMs) return { eligible: false, upstreamAgeMinutes: Number(ageMinutes.toFixed(1)), status: 'stale upstream timestamp' };
  return { eligible: true, upstreamAgeMinutes: Number(Math.max(0, ageMinutes).toFixed(1)), status: 'upstream timestamp available' };
}

export function rankPoolsByConservativeApy(pools, assumptions = {}) {
  const score = (pool) => {
    const apy = conservativeApyRate(pool);
    if (!Number.isFinite(apy)) return Number.NEGATIVE_INFINITY;
    if (!(Number(assumptions.principal) > 0) || !(Number(assumptions.holdDays) > 0) || !Number.isFinite(Number(assumptions.roundTripCost))) return apy;
    return Number(assumptions.principal) * ((1 + apy / 100) ** (Number(assumptions.holdDays) / 365) - 1) - Number(assumptions.roundTripCost);
  };
  return [...pools].sort((a, b) => score(b) - score(a));
}
