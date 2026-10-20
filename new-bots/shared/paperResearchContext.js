const TOKEN = /^[a-z0-9][a-z0-9_:.\/-]{0,79}$/i;
const FEATURE_KEY = /^[a-z][a-z0-9_]{0,39}$/i;

function label(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : '';
  return TOKEN.test(normalized) ? normalized : 'unknown';
}

function observedAt(value, quoteTime) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  const quote = typeof quoteTime === 'string' ? Date.parse(quoteTime) : NaN;
  return Number.isFinite(parsed) && Number.isFinite(quote) && parsed <= quote + 5_000
    ? new Date(parsed).toISOString() : null;
}

/** Preserve a bounded issuance-time snapshot without giving it approval authority. */
export function normalizePaperResearchContext(value, quoteTime) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {
    schemaVersion: 1, status: 'unavailable', setupType: 'unknown', marketRegime: 'unknown',
    volatilityRegime: 'unknown', regimeSource: 'unknown', observedAt: null, features: {},
  };
  const entries = value.features && typeof value.features === 'object' && !Array.isArray(value.features)
    ? Object.entries(value.features).filter(([key, number]) => FEATURE_KEY.test(key)
      && number !== null && number !== undefined && number !== '' && typeof number !== 'boolean'
      && Number.isFinite(Number(number))).slice(0, 24) : [];
  return {
    schemaVersion: 1, status: 'captured', setupType: label(value.setupType),
    marketRegime: label(value.marketRegime), volatilityRegime: label(value.volatilityRegime),
    regimeSource: label(value.regimeSource), observedAt: observedAt(value.observedAt, quoteTime),
    ...(value.discoveryVersion != null ? { discoveryVersion: label(value.discoveryVersion) } : {}),
    features: Object.fromEntries(entries.map(([key, number]) => [key, Number(number)])),
    semantics: 'Issuance-time descriptive research only; labels/scores do not approve or size paper trades.',
  };
}
