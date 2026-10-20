// Pure identity validation shared by discovery, strategies, and position marks.
// Contract identity is necessary, but never sufficient, for an executable quote.
export const OPTION_IDENTITY_VERSION = 'standard-listed-option-v1';
export const optionNumber = (value) => (typeof value === 'number' || typeof value === 'string' && value.trim())
  && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, limit = 40) => typeof value === 'string' && value.length <= limit ? value.trim() : '';
export const validOptionDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
export function tradierUnderlyingSymbol(symbol) {
  const value = text(symbol, 16).toUpperCase();
  return /^[A-Z][A-Z0-9./-]{0,15}$/.test(value) ? value.replaceAll('.', '/') : null;
}
export function parseOccSymbol(value) {
  const match = /^([A-Z0-9.]{1,6}) *(\d{6})([CP])(\d{8})$/.exec(text(value));
  if (!match) return null;
  const expiry = `20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`;
  if (!validOptionDate(expiry) || Number(match[4]) <= 0) return null;
  return { root: match[1], expiry, type: match[3] === 'C' ? 'call' : 'put', strike: Number(match[4]) / 1000,
    canonical: match[1] + match[2] + match[3] + match[4] };
}
export function optionIdentityOccurrences(rows) {
  const occurrences = new Map();
  for (const row of rows) {
    const key = parseOccSymbol(row?.symbol)?.canonical;
    if (key) occurrences.set(key, (occurrences.get(key) || 0) + 1);
  }
  return occurrences;
}

/** Normalized fields must be explicit; no requested-underlying or 100-share defaults. */
export function validateStandardOptionIdentity(row, { underlying, expiry, occurrences } = {}) {
  const occ = parseOccSymbol(row?.symbol), reasons = [];
  const requested = tradierUnderlyingSymbol(underlying), observed = tradierUnderlyingSymbol(row?.underlying);
  const type = text(row?.type, 10).toLowerCase(), strike = optionNumber(row?.strike), multiplier = optionNumber(row?.multiplier);
  if (!occ) reasons.push('invalid_occ_identity');
  if (row?.instrumentType != null && row.instrumentType !== 'option') reasons.push('instrument_type_mismatch');
  if (!requested || !observed || observed !== requested) reasons.push('underlying_identity_mismatch');
  if (!validOptionDate(expiry) || row?.expiry !== expiry || occ && occ.expiry !== expiry) reasons.push('expiration_identity_mismatch');
  if (!['call', 'put'].includes(type) || occ && occ.type !== type) reasons.push('option_type_mismatch');
  if (!(strike > 0) || occ && Math.abs(occ.strike - strike) > 0.0000001) reasons.push('strike_identity_mismatch');
  if (occ && occurrences?.get(occ.canonical) > 1) reasons.push('duplicate_contract_identity');
  if (occ && row?.root != null && row.root !== occ.root) reasons.push('root_identity_mismatch');
  if (occ && occ.root !== requested?.replaceAll('/', '.')) reasons.push('adjusted_root_unverified');
  if (multiplier !== 100) reasons.push('contract_deliverable_unverified');
  return { valid: reasons.length === 0, status: reasons.length ? 'unverified' : 'verified_standard_contract', reasons,
    symbol: occ?.canonical || text(row?.symbol) || null, underlying: observed, expiry: row?.expiry ?? null,
    root: occ?.root || null, type: ['call', 'put'].includes(type) ? type : null, strike, multiplier };
}
export function tradierContractIdentity(row, context) {
  return validateStandardOptionIdentity({ symbol: row?.symbol, underlying: row?.underlying, expiry: row?.expiration_date,
    type: row?.option_type, strike: row?.strike, multiplier: row?.contract_size, root: row?.root_symbol, instrumentType: row?.type }, context);
}
