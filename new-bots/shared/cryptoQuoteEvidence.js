// A trade timestamp does not establish when the best bid/ask was observed.
// Executable evidence must identify the native book source and displayed sizes.
export function normalizeCryptoQuoteEvidence(value) {
  if (!value || value.version !== 1
    || typeof value.time !== 'string' || !Number.isFinite(Date.parse(value.time))
    || ![value.bid, value.ask, value.bidSize, value.askSize].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    || value.ask < value.bid) return null;
  const common = { version: 1, kind: value.kind, time: value.time, bid: value.bid, ask: value.ask, bidSize: value.bidSize, askSize: value.askSize };
  if (value.kind === 'coinbase_l1_book') {
    if (typeof value.pair !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(value.pair)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.auctionMode !== false) return null;
    return { ...common, pair: value.pair, sequence: value.sequence, auctionMode: false };
  }
  if (value.kind === 'kraken_l1_bbo') {
    if (typeof value.symbol !== 'string' || !/^[A-Z0-9]{1,32}\/[A-Z0-9]{1,32}$/.test(value.symbol)
      || value.eventTrigger !== 'bbo' || value.systemStatus !== 'online' || value.subscriptionAcknowledged !== true) return null;
    return { ...common, symbol: value.symbol, eventTrigger: 'bbo', systemStatus: 'online', subscriptionAcknowledged: true };
  }
  return null;
}

export function cryptoQuoteEvidenceRejection(identity, value, quote) {
  if (!['Coinbase', 'Kraken'].includes(identity?.provider)) return null;
  const evidence = normalizeCryptoQuoteEvidence(value);
  if (!evidence) return 'crypto_order_book_evidence_required';
  const routeMatches = identity.provider === 'Coinbase'
    ? evidence.kind === 'coinbase_l1_book' && evidence.pair === identity.pair
    : evidence.kind === 'kraken_l1_bbo' && evidence.symbol === `${identity.base}/${identity.quoteCurrency}`;
  if (!routeMatches || evidence.bid !== Number(quote?.bid)
    || evidence.ask !== Number(quote?.ask) || Date.parse(evidence.time) !== Date.parse(quote?.time))
    return 'crypto_order_book_evidence_mismatch';
  return null;
}
