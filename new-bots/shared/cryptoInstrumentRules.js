import { normalizePositiveDecimal, isIncrementMultiple, decimalProductAtLeast } from './decimalQuantity.js';
export const CRYPTO_INSTRUMENT_MAX_AGE_MS = 60000;
const sources = { Coinbase: 'coinbase_product', Kraken: 'kraken_asset_pairs' };
const states = new Set(['online', 'offline', 'cancel_only', 'post_only', 'limit_only', 'auction', 'disabled']);

export function normalizeCryptoInstrumentRules(value) {
  if (!value || value.version !== 1 || !sources[value.provider] || value.source !== sources[value.provider]
    || typeof value.pair !== 'string' || !/^[A-Z0-9/._-]{2,70}$/.test(value.pair)
    || ![value.base, value.quoteCurrency].every(part => typeof part === 'string' && /^[A-Z0-9]{1,32}$/.test(part))
    || !states.has(value.tradingState) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return null;
  const amounts = Object.fromEntries(['quantityIncrement', 'priceIncrement', 'minQuantity', 'minNotional']
    .map(key => [key, normalizePositiveDecimal(value[key])]));
  if (Object.values(amounts).some(v => v === null) || Number(amounts.quantityIncrement) < 1e-18
    || Number(amounts.priceIncrement) < 1e-18 || Number(amounts.minQuantity) < Number(amounts.quantityIncrement)
    || (value.provider === 'Coinbase' && value.pair !== `${value.base}-${value.quoteCurrency}`)) return null;
  return { version: 1, provider: value.provider, pair: value.pair, base: value.base, quoteCurrency: value.quoteCurrency,
    ...amounts, tradingState: value.tradingState, source: value.source, observedAt: value.observedAt };
}

export function cryptoInstrumentRulesRejection(value, identity, now) {
  const rules = normalizeCryptoInstrumentRules(value);
  if (!rules) return 'crypto_instrument_rules_required';
  if (!identity || ['provider', 'pair', 'base', 'quoteCurrency'].some(key => rules[key] !== identity[key]))
    return 'crypto_instrument_rules_identity_mismatch';
  const age = now - Date.parse(rules.observedAt);
  if (!Number.isFinite(age) || age < -5000 || age > CRYPTO_INSTRUMENT_MAX_AGE_MS) return 'crypto_instrument_rules_stale_or_future';
  if (rules.tradingState !== 'online') return 'crypto_product_not_in_normal_trading';
  return null;
}

export function cryptoOrderSizeRejection(rulesValue, units, price) {
  const rules = normalizeCryptoInstrumentRules(rulesValue);
  if (!rules) return 'crypto_instrument_rules_required';
  if (!isIncrementMultiple(units, rules.quantityIncrement)) return 'crypto_quantity_increment_mismatch';
  if (Number(units) < Number(rules.minQuantity)) return 'crypto_quantity_below_venue_minimum';
  if (!decimalProductAtLeast(units, price, rules.minNotional)) return 'crypto_notional_below_venue_minimum';
  return null;
}

export function cryptoPriceGridRejection(rules, bid, ask) {
  return isIncrementMultiple(bid, rules?.priceIncrement) && isIncrementMultiple(ask, rules?.priceIncrement)
    ? null : 'crypto_price_increment_mismatch';
}
