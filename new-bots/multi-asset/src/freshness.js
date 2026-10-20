export function marketObservationAgeMinutes(row, now = Date.now()) {
  const observedAt = Date.parse(row?.observedAt);
  return Number.isFinite(observedAt) ? (now - observedAt) / 60_000 : NaN;
}

export function isMarketObservationFresh(row, now = Date.now(), defaultMaxAgeMinutes = 15) {
  const ageMinutes = marketObservationAgeMinutes(row, now);
  const configuredAge = Number(row?.maxAgeMinutes);
  const maxAge = Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : defaultMaxAgeMinutes;
  return Number.isFinite(ageMinutes) && ageMinutes >= -0.5 && ageMinutes <= maxAge;
}
