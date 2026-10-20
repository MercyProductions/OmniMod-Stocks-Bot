import { normalizeCryptoInstrumentRules } from '../../new-bots/shared/cryptoInstrumentRules.js';
const alias = part => ({ XBT: 'BTC', XDG: 'DOGE' })[part] ?? part;
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function normalized(row) {
  const rules = normalizeCryptoInstrumentRules(row);
  if (!rules) fail('crypto_product_metadata_invalid');
  return rules;
}
export function parseCoinbaseProduct(raw, pair, observedAt) {
  if (!raw || raw.id !== pair || pair !== `${raw.base_currency}-${raw.quote_currency}`
    || !['online', 'offline', 'internal', 'delisted'].includes(raw.status)
    || !['post_only', 'limit_only', 'cancel_only', 'auction_mode', 'trading_disabled'].every(key => typeof raw[key] === 'boolean'))
    fail('coinbase_product_identity_or_status_invalid');
  const tradingState = raw.status !== 'online' ? 'offline' : raw.trading_disabled ? 'disabled'
    : raw.auction_mode ? 'auction' : raw.cancel_only ? 'cancel_only' : raw.post_only ? 'post_only' : raw.limit_only ? 'limit_only' : 'online';
  // Coinbase removed legacy base_min_size/base_max_size/max_market_funds.
  // min_market_funds is now the limit-order notional minimum.
  return normalized({ version: 1, provider: 'Coinbase', pair, base: raw.base_currency, quoteCurrency: raw.quote_currency,
    quantityIncrement: raw.base_increment, priceIncrement: raw.quote_increment, minQuantity: raw.base_increment,
    minNotional: raw.min_market_funds, tradingState, source: 'coinbase_product', observedAt });
}
export function parseKrakenProduct(raw, pair, observedAt) {
  const parts = typeof raw?.wsname === 'string' ? raw.wsname.split('/') : [];
  if (raw?.altname !== pair || parts.length !== 2 || raw.lot !== 'unit' || raw.lot_multiplier !== 1
    || !Number.isInteger(raw.lot_decimals) || raw.lot_decimals < 0 || raw.lot_decimals > 18
    || !['online', 'cancel_only', 'post_only', 'limit_only', 'offline'].includes(raw.status)) fail('kraken_product_identity_or_status_invalid');
  const increment = raw.lot_decimals === 0 ? '1' : `0.${'0'.repeat(raw.lot_decimals - 1)}1`;
  return normalized({ version: 1, provider: 'Kraken', pair, base: alias(parts[0]), quoteCurrency: alias(parts[1]),
    quantityIncrement: increment, priceIncrement: raw.tick_size, minQuantity: raw.ordermin, minNotional: raw.costmin,
    tradingState: raw.status, source: 'kraken_asset_pairs', observedAt });
}
