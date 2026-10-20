// Asset identity and native quote units must survive every paper lifecycle step.
export const CRYPTO_EXECUTION_IDENTITY_VERSION = 1;
export const CRYPTO_IDENTITY_MAX_AGE_MS = 65 * 60_000; // Existing directory evidence cache is one hour.
const venues = new Set(['Binance', 'Coinbase', 'Kraken']);
const symbolPart = value => typeof value === 'string' && /^[A-Z0-9]{1,32}$/.test(value);

export function normalizeCryptoExecutionIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.namespace !== 'coingecko' || typeof value.assetId !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{0,159}$/.test(value.assetId) || !venues.has(value.provider)
    || !symbolPart(value.base) || !symbolPart(value.quoteCurrency)
    || typeof value.pair !== 'string' || !/^[A-Z0-9/._-]{2,70}$/.test(value.pair)
    || value.verificationSource !== 'coingecko_tickers_complete'
    || typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) return null;
  if (value.provider === 'Coinbase' && value.pair !== `${value.base}-${value.quoteCurrency}`) return null;
  if (value.provider === 'Binance' && value.pair !== `${value.base}${value.quoteCurrency}`) return null;
  return { version: 1, namespace: 'coingecko', assetId: value.assetId, provider: value.provider,
    pair: value.pair, base: value.base, quoteCurrency: value.quoteCurrency,
    verificationSource: value.verificationSource, verifiedAt: value.verifiedAt };
}

export function cryptoExecutionIdentityKey(value) {
  const id = normalizeCryptoExecutionIdentity(value);
  return id ? JSON.stringify([id.namespace, id.assetId, id.provider, id.pair, id.base, id.quoteCurrency]) : null;
}

export function cryptoIdentityRejection(value, now) {
  const id = normalizeCryptoExecutionIdentity(value);
  if (!id) return 'crypto_execution_identity_required';
  const age = now - Date.parse(id.verifiedAt);
  if (!Number.isFinite(age) || age < -5000 || age > CRYPTO_IDENTITY_MAX_AGE_MS) return 'crypto_identity_evidence_stale_or_future';
  // The portfolio and its costs are denominated in USD. A stablecoin ticker is
  // not a conversion rate. Native non-USD routes remain discoverable research.
  if (id.quoteCurrency !== 'USD') return 'crypto_quote_currency_conversion_required';
  return null;
}

export function paperQuoteLookupKey(row = {}) {
  return row.assetClass === 'crypto' || row.owner === 'crypto'
    ? cryptoExecutionIdentityKey(row.cryptoIdentity)
    : String(row.instrumentKey ?? '').toUpperCase();
}

export function cryptoExposureKey(value) {
  const id = normalizeCryptoExecutionIdentity(value);
  if (!id) return null;
  // Durable IDs, not a colliding symbol, establish the known wrapper overlap.
  return ({ bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP' })[id.assetId]
    ?? `CRYPTO:COINGECKO:${id.assetId.toUpperCase()}`;
}
