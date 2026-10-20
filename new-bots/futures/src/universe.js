const PROVIDER_SYMBOL_PATTERN = /^[A-Z0-9.^=!-]{1,24}$/i;

/** Parse a verified futures expiry; date-only values use UTC midnight conservatively. */
export function parseFuturesExpiry(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!match) return NaN;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return NaN;
  return Date.parse(match[4] ? text : `${text}T00:00:00.000Z`);
}

export function validateFuturesUniverse(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Futures universe must be a non-empty JSON array');
  const seen = new Set();
  return rows.map((row, index) => {
    const symbol = String(row?.symbol ?? '').trim();
    const providerSymbol = String(row?.providerSymbol ?? '').trim();
    const assetClass = String(row?.assetClass ?? '').trim();
    if (!symbol || symbol.length > 80 || !PROVIDER_SYMBOL_PATTERN.test(providerSymbol) || !assetClass) {
      throw new Error(`Invalid futures universe row ${index + 1}`);
    }
    const key = symbol.toUpperCase();
    if (seen.has(key)) throw new Error(`Duplicate futures symbol: ${key}`);
    seen.add(key);
    const normalized = {
      symbol,
      providerSymbol,
      assetClass,
      underlying: String(row.underlying ?? symbol),
      contractMode: 'continuous-proxy',
      contractSpecVerified: false,
    };
    if (row.contractId != null || row.contractSpecVerified === true) return validateActiveFutureContract({ ...row, symbol, providerSymbol, assetClass });
    return normalized;
  });
}

/** Structured active-contract gate shared by strategy and provider adapters. */
export function inspectActiveFutureContract(row, { now = Date.now(), maxSpecAgeDays = 90 } = {}) {
  const symbol = String(row?.symbol ?? '').trim();
  const providerSymbol = String(row?.providerSymbol ?? '').trim();
  const providerRawSymbol = String(row?.providerRawSymbol ?? '').trim().toUpperCase();
  const contractId = String(row?.contractId ?? '').trim();
  const exposureKey = String(row?.exposureKey ?? '').trim();
  const expiry = String(row?.expiry ?? '').trim();
  const specSource = String(row?.specSource ?? '').trim();
  const specVerifiedAtText = String(row?.specVerifiedAt ?? '').trim();
  const specVerifiedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(specVerifiedAtText)
    ? Date.parse(specVerifiedAtText) : NaN;
  const multiplier = Number(row?.multiplier);
  const tickSize = Number(row?.tickSize);
  const tickValueUsd = Number(row?.tickValueUsd);
  const initialMarginUsd = Number(row?.initialMarginUsd);
  const maintenanceMarginUsd = Number(row?.maintenanceMarginUsd);
  const expiryAt = parseFuturesExpiry(row?.expiryAt ?? expiry);
  const reasons = [];
  if (!Number.isFinite(now) || !Number.isFinite(maxSpecAgeDays) || maxSpecAgeDays <= 0) reasons.push('contract_validation_policy_invalid');
  if (!symbol || symbol.length > 80) reasons.push('contract_symbol_missing_or_invalid');
  if (!PROVIDER_SYMBOL_PATTERN.test(providerSymbol)) reasons.push('provider_symbol_missing_or_invalid');
  if (!/^[A-Z0-9]{2,16}$/.test(providerRawSymbol)) reasons.push('provider_raw_symbol_missing_or_invalid');
  if (!contractId) reasons.push('contract_id_missing');
  if (!exposureKey) reasons.push('exposure_key_missing');
  let sourceValid = false;
  try { const url = new URL(specSource); sourceValid = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { /* invalid source */ }
  if (!sourceValid) reasons.push('contract_spec_source_not_verified_https');
  if (row?.activeContract !== true) reasons.push('active_contract_not_confirmed');
  if (row?.contractSpecVerified !== true) reasons.push('contract_spec_not_verified');
  if (!expiry || !Number.isFinite(expiryAt)) reasons.push('contract_expiry_missing_or_invalid');
  else if (Number.isFinite(now) && expiryAt <= now) reasons.push('contract_expired');
  if (!Number.isFinite(specVerifiedAt)) reasons.push('contract_spec_verified_at_missing_or_invalid');
  else if (Number.isFinite(now) && specVerifiedAt > now) reasons.push('contract_spec_verified_at_in_future');
  else if (Number.isFinite(now) && Number.isFinite(maxSpecAgeDays) && maxSpecAgeDays > 0 && now - specVerifiedAt > maxSpecAgeDays * 86_400_000) reasons.push('contract_spec_stale');
  if (!(multiplier > 0) || !(tickSize > 0) || !(tickValueUsd > 0)) reasons.push('contract_tick_or_multiplier_invalid');
  else if (Math.abs(tickValueUsd - multiplier * tickSize) > Math.max(0.01, tickValueUsd * 0.001)) reasons.push('contract_tick_value_inconsistent');
  if (!(initialMarginUsd > 0)) reasons.push('contract_initial_margin_invalid');
  if (!(maintenanceMarginUsd > 0) || (initialMarginUsd > 0 && maintenanceMarginUsd > initialMarginUsd)) reasons.push('contract_maintenance_margin_invalid');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** A proxy series is never promoted to an active listed contract implicitly. */
export function validateActiveFutureContract(row, options = {}) {
  const { now = Date.now(), maxSpecAgeDays = 90 } = options;
  const inspected = inspectActiveFutureContract(row, { now, maxSpecAgeDays });
  if (!inspected.valid) {
    const error = new Error(`Invalid or stale active futures contract metadata: ${String(row?.symbol ?? 'unknown')}`);
    error.reasons = inspected.reasons;
    throw error;
  }
  const symbol = String(row.symbol).trim();
  const providerSymbol = String(row.providerSymbol).trim();
  const providerRawSymbol = String(row.providerRawSymbol).trim().toUpperCase();
  const contractId = String(row.contractId).trim();
  const exposureKey = String(row.exposureKey).trim();
  const expiry = String(row.expiry).trim();
  const specSource = String(row.specSource).trim();
  const specVerifiedAt = Date.parse(row.specVerifiedAt);
  const multiplier = Number(row.multiplier);
  const tickSize = Number(row.tickSize);
  const tickValueUsd = Number(row.tickValueUsd);
  const initialMarginUsd = Number(row.initialMarginUsd);
  const maintenanceMarginUsd = Number(row.maintenanceMarginUsd);
  const expiryAt = parseFuturesExpiry(row.expiryAt ?? expiry);
  return {
    ...row, symbol, providerSymbol, providerRawSymbol,
    contractId, exposureKey: exposureKey.toUpperCase(), expiry, specSource, specVerifiedAt: new Date(specVerifiedAt).toISOString(),
    multiplier, tickSize, tickValueUsd, initialMarginUsd, maintenanceMarginUsd, expiryAt: new Date(expiryAt).toISOString(),
    contractMode: 'active-contract', contractSpecVerified: true,
  };
}
