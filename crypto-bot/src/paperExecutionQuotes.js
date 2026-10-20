import { cryptoExecutionIdentityKey, cryptoIdentityRejection, normalizeCryptoExecutionIdentity } from '../../new-bots/shared/cryptoExecutionIdentity.js';
import { cryptoQuoteEvidenceRejection, normalizeCryptoQuoteEvidence } from '../../new-bots/shared/cryptoQuoteEvidence.js';
import { normalizeCryptoInstrumentRules, cryptoInstrumentRulesRejection, cryptoPriceGridRejection } from '../../new-bots/shared/cryptoInstrumentRules.js';
import { hasExplicitFiniteAmount } from '../../new-bots/shared/strategyConfig.js';

/** No ticker fallback: an old prediction without a durable ID stays unresolved. */
export function resolveCryptoAsset(prediction, assetsById) {
  return typeof prediction?.assetId === 'string' && prediction.assetId
    ? assetsById.get(prediction.assetId) ?? null : null;
}

/** Retain every exact source for existing orders; select one source only for a new candidate. */
export function buildCryptoPaperQuotes(assets, { now = Date.now(), maxQuoteAgeMs = 15000 } = {}) {
  if (!Array.isArray(assets) || !Number.isFinite(now) || !Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0)
    throw new TypeError('Crypto paper quote inputs require a finite current time and positive freshness limit.');
  const quotesByKey = new Map(), entryByAssetId = new Map(), rejections = [], ambiguous = new Set();
  const reject = (asset, code, quote = {}) => rejections.push({ assetId: asset?.id ?? null, symbol: asset?.symbol ?? null,
    provider: quote.provider ?? null, pair: quote.pair ?? null, stage: 'shared_quote_identity', code });
  const idCounts = new Map();
  for (const asset of assets) idCounts.set(asset?.id, (idCounts.get(asset?.id) || 0) + 1);
  const claims = new Map();
  const nativeKey = id => JSON.stringify([id.provider, id.pair, id.base, id.quoteCurrency]);
  for (const asset of assets) for (const quote of asset?.marketData?.quotes ?? []) {
    const identity = normalizeCryptoExecutionIdentity(quote.cryptoIdentity);
    if (!identity || identity.assetId !== asset?.id) continue;
    const key = nativeKey(identity), ids = claims.get(key) ?? new Set();
    ids.add(identity.assetId); claims.set(key, ids);
  }
  for (const asset of assets) {
    if (!asset?.id || idCounts.get(asset.id) !== 1) { reject(asset, 'ambiguous_asset_id'); continue; }
    for (const quote of asset.marketData?.quotes ?? []) {
      const identity = normalizeCryptoExecutionIdentity(quote.cryptoIdentity);
      const reason = cryptoIdentityRejection(identity, now);
      if (reason) { reject(asset, reason, quote); continue; }
      if (identity.assetId !== asset.id || identity.provider !== quote.provider || identity.pair !== quote.pair
        || identity.base !== quote.base || identity.quoteCurrency !== quote.target) { reject(asset, 'crypto_quote_identity_mismatch', quote); continue; }
      if (claims.get(nativeKey(identity))?.size > 1) { reject(asset, 'conflicting_asset_ids_for_native_pair', quote); continue; }
      const age = now - Date.parse(quote.observedAt);
      if (![identity.provider === 'Coinbase' ? 'provider_order_book' : 'provider_event'].includes(quote.timestampBasis) || !Number.isFinite(age) || age < -5000 || age > maxQuoteAgeMs
        || ![quote.bid, quote.ask].every(hasExplicitFiniteAmount) || !(Number(quote.bid) > 0 && Number(quote.ask) >= Number(quote.bid))) {
        reject(asset, 'crypto_quote_not_current_and_executable', quote); continue;
      }
      const evidenceReason = cryptoQuoteEvidenceRejection(identity, quote.cryptoQuoteEvidence, { bid: quote.bid, ask: quote.ask, time: quote.observedAt });
      if (evidenceReason) { reject(asset, evidenceReason, quote); continue; }
      const rules = normalizeCryptoInstrumentRules(quote.cryptoInstrumentRules);
      const rulesReason = cryptoInstrumentRulesRejection(rules, identity, now) || cryptoPriceGridRejection(rules, quote.bid, quote.ask);
      if (rulesReason) { reject(asset, rulesReason, quote); continue; }
      const key = cryptoExecutionIdentityKey(identity);
      if (quotesByKey.has(key) || ambiguous.has(key)) {
        quotesByKey.delete(key); ambiguous.add(key); reject(asset, 'duplicate_exact_source_quote', quote); continue;
      }
      quotesByKey.set(key, { bid: Number(quote.bid), ask: Number(quote.ask), time: quote.observedAt,
        quality: 'executable', cryptoIdentity: identity, cryptoInstrumentRules: rules,
        cryptoQuoteEvidence: normalizeCryptoQuoteEvidence(quote.cryptoQuoteEvidence) });
    }
  }
  // New candidates may choose the freshest supported USD source; an existing
  // order always uses its persisted exact key, even if another venue is fresher.
  for (const quote of quotesByKey.values()) {
    const id = quote.cryptoIdentity.assetId, previous = entryByAssetId.get(id);
    if (!previous || Date.parse(quote.time) > Date.parse(previous.time)) entryByAssetId.set(id, quote);
  }
  const rejectionCounts = {};
  for (const row of rejections) rejectionCounts[row.code] = (rejectionCounts[row.code] || 0) + 1;
  return { quotesByKey, entryByAssetId, rejections,
    diagnostics: { version: 1, assetsConsidered: assets.length, exactQuotesReady: quotesByKey.size,
      assetsWithEntryQuote: entryByAssetId.size, rejectionCounts } };
}
