export const SPOT_PAIR_ROUTING_VERSION = 'verified-spot-pair-routing-v1';
export const spotSymbol = (value) => {
  const v = String(value ?? '').trim().toUpperCase();
  return ({ XBT: 'BTC', XDG: 'DOGE' })[v] || v;
};
const part = (value) => /^[A-Z0-9]{1,32}$/.test(spotSymbol(value)) ? spotSymbol(value) : null;
const providers = ['Binance', 'Coinbase', 'Kraken'];

/** Structured identity evidence, including conflicts that must not become an allowlist. */
export function inspectCoinGeckoPairEvidence(asset, payload, exchangeIds, { strict = false } = {}) {
  const id = String(asset?.id || '').trim().toLowerCase();
  const providerById = new Map(Object.entries(exchangeIds || {}).map(([provider, exchange]) => [String(exchange).toLowerCase(), provider]));
  const verifiedPairs = new Set(), reasons = {}, idsByPair = new Map();
  const count = key => { reasons[key] = (reasons[key] || 0) + 1; };
  for (const row of payload?.tickers || []) {
    const provider = providerById.get(String(row?.market?.identifier || '').toLowerCase());
    const coin = String(row?.coin_id || '').trim().toLowerCase();
    const base = part(row?.base), target = part(row?.target);
    const reason = !provider ? 'unrecognized_venue' : !coin ? 'missing_coin_id'
      : !base || !target ? 'invalid_pair_identity'
        : strict ? row.is_stale !== false || row.is_anomaly !== false ? 'unclean_or_missing_quality_flags' : null
          : row.is_stale === true || row.is_anomaly === true ? 'unclean_quality_flags' : null;
    if (reason) { count(reason); continue; }
    const key = `${provider.toLowerCase()}:${base}:${target}`;
    const ids = idsByPair.get(key) || new Set(); ids.add(coin); idsByPair.set(key, ids);
    if (!id || coin !== id) { count('coin_id_mismatch'); continue; }
    verifiedPairs.add(key);
  }
  for (const [key, ids] of idsByPair) if (ids.size > 1) {
    verifiedPairs.delete(key); count('conflicting_coin_ids_for_pair');
  }
  return { verifiedPairs, rejectionReasons: reasons };
}

/** Current detailed adapters support USD and USDT only; other denominations remain visible exclusions. */
export function planVerifiedSpotRoutes(asset, verifiedPairs) {
  const base = part(asset?.symbol), routes = {}, rejections = [];
  for (const provider of providers) {
    const targets = provider === 'Binance' ? ['USDT', 'USD'] : ['USD', 'USDT'];
    const target = base && targets.find(q => verifiedPairs?.has(`${provider.toLowerCase()}:${base}:${q}`));
    if (!target) { rejections.push({ provider, code: 'no_supported_verified_pair' }); continue; }
    routes[provider] = { provider, base, target,
      pair: provider === 'Binance' ? `${base}${target}` : provider === 'Coinbase' ? `${base}-${target}` : null };
  }
  const unsupportedPairs = [...(verifiedPairs || [])].filter(key => {
    const [provider, b, q] = key.split(':');
    return !providers.some(p => p.toLowerCase() === provider) || b !== base || !['USD', 'USDT'].includes(q);
  });
  return { version: SPOT_PAIR_ROUTING_VERSION, routes, rejections, unsupportedPairs };
}

/** Exact persisted sources cannot quietly revert to a provider's preferred market. */
export function inspectPinnedSpotPair(asset, provider, pair) {
  const symbol = part(asset?.symbol);
  if (!symbol || typeof pair !== 'string' || !pair || pair.length > 70) return null;
  if (provider === 'Kraken') return /^[A-Z0-9/]{2,64}$/.test(pair) ? { pair, base: symbol, target: null } : null;
  if (!['Binance', 'Coinbase'].includes(provider)) return null;
  const target = ['USD', 'USDT'].find(q => pair === (provider === 'Binance' ? `${symbol}${q}` : `${symbol}-${q}`));
  return target ? { provider, pair, base: symbol, target } : null;
}
