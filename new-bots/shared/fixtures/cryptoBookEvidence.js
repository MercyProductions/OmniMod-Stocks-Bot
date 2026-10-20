// Fixture-only order-book observation; never imported by production code.
export const coinbaseBookEvidence = ({ pair = 'BTC-USD', bid, ask, time, quoteTime }) => ({
  version: 1, kind: 'coinbase_l1_book', pair, sequence: 12345,
  time: new Date(time ?? quoteTime).toISOString(), bid: Number(bid), ask: Number(ask),
  bidSize: 1000000, askSize: 1000000, auctionMode: false,
});

export const krakenBookEvidence = ({ symbol = 'BTC/USD', bid, ask, time, quoteTime, bidSize = 1000000, askSize = 1000000 }) => ({
  version: 1, kind: 'kraken_l1_bbo', symbol, time: new Date(time ?? quoteTime).toISOString(),
  bid: Number(bid), ask: Number(ask), bidSize, askSize,
  eventTrigger: 'bbo', systemStatus: 'online', subscriptionAcknowledged: true,
});

export const cryptoRulesFixture = ({ provider = 'Coinbase', pair = 'BTC-USD', base = 'BTC', quoteCurrency = 'USD', time, quoteTime }) => ({
  version: 1, provider, pair, base, quoteCurrency, quantityIncrement: '0.00000001', priceIncrement: '0.01',
  minQuantity: '0.00000001', minNotional: '1', tradingState: 'online',
  source: provider === 'Kraken' ? 'kraken_asset_pairs' : 'coinbase_product', observedAt: new Date(time ?? quoteTime).toISOString(),
});
