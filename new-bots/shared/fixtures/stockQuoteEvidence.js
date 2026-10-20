// Explicit synthetic native evidence for provider-free regression tests only.
export function stockQuoteEvidence(symbol, { bid, ask, time }, { feed = 'sip', bidSize = 100000, askSize = 100000, source = 'latest' } = {}) {
  return { version: 1, kind: 'alpaca_stock_l1', symbol, provider: 'Alpaca', feed,
    coverage: feed === 'sip' ? 'consolidated' : 'single_venue', currency: 'USD', source, time, rawTimestamp: time,
    bid, ask, reportedBidSize: bidSize, reportedAskSize: askSize, bidSizeShares: bidSize, askSizeShares: askSize,
    sizeBasis: feed === 'sip' ? 'sip_shares_since_2025_11_03' : 'iex_reported_size_conservative_shares',
    bidExchange: feed === 'iex' ? 'V' : 'Q', askExchange: feed === 'iex' ? 'V' : 'Q', tape: 'C', conditions: ['R'] };
}

export function stockQuote(symbol, quote, options) {
  return { ...quote, stockQuoteEvidence: stockQuoteEvidence(symbol, quote, options) };
}

// Synthetic candidate adapter for existing risk tests. Explicit evidence overrides
// remain intact so corrupt-evidence cases are never repaired by this fixture.
export function withStockCandidateEvidence(candidate) {
  if (!['stock', 'etf', 'etp'].includes(String(candidate.assetClass).toLowerCase())) return candidate;
  return { stockQuoteEvidence: stockQuoteEvidence(candidate.instrumentKey,
    { bid: candidate.bid, ask: candidate.ask, time: candidate.quoteTime }), ...candidate };
}
