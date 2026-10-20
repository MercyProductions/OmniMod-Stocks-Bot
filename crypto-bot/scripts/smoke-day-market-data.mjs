import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { enrichMarketAssets } from '../src/marketProviders.js';
import { assessDayMarketDataSmoke } from '../src/dayMarketDataSmoke.js';
import { appendDayMarketDataHistory, buildDayMarketDataHistoryRow } from '../src/dayMarketDataHistory.js';

// Bounded public-data plumbing check only. No bot login, Discord call, strategy,
// risk approval, paper reservation, broker request, or order is made.
const assets = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price: 0, change24h: 0, volume24h: 0 },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', price: 0, change24h: 0, volume24h: 0 },
];
const startedAt = Date.now();
const result = await enrichMarketAssets(assets, { bitcoinAsset: assets[0], technicalAssetIds: [],
  concurrency: 2, derivativesEnabled: false });
const checkedAt = new Date().toISOString();
const report = result.assets.map((asset) => {
  const marketData = asset.marketData || {};
  const quotes = (marketData.quotes || []).filter((quote) => quote.provider !== 'CoinGecko/CoinPaprika');
  const receiptTimeQuotes = marketData.unconfirmedQuotes || [];
  const exchangeProviderCount = quotes.length;
  const staleOrInvalid = quotes.filter((quote) => {
    const age = Date.parse(checkedAt) - Date.parse(quote.observedAt || '');
    return !Number.isFinite(age) || age < -60_000 || age > 5 * 60_000
      || !(Number(quote.bid) > 0 && Number(quote.ask) >= Number(quote.bid));
  }).length;
  return {
    symbol: asset.symbol, quoteProviders: quotes.map((quote) => ({ provider: quote.provider, pair: quote.pair,
      bid: quote.bid, ask: quote.ask, spreadPct: quote.spreadPct, observedAt: quote.observedAt,
      timestampBasis: 'provider timestamp' })),
    receiptTimestampOnlyObservations: receiptTimeQuotes.map((quote) => ({ provider: quote.provider, pair: quote.pair,
      bid: quote.bid, ask: quote.ask, spreadPct: quote.spreadPct, receivedAt: quote.observedAt,
      status: 'diagnostic-only; excluded from fresh provider confirmation' })),
    exchangeProviderCount, consensusPrice: marketData.consensusPrice,
    priceDispersionPct: marketData.priceDispersionPct, medianSpreadPct: marketData.medianSpreadPct,
    conflicted: marketData.conflicted, staleOrInvalidQuotes: staleOrInvalid,
    quoteRejectionCounts: marketData.rejectionCounts || {},
    historicalCandles: asset.symbol === 'BTC' ? { provider: result.bitcoinHistory?.provider || null,
      pair: result.bitcoinHistory?.pair || null, count: Number(result.bitcoinHistory?.candleCount) || 0,
      errors: result.bitcoinHistory?.errors || [] } : { requested: false, note: 'Smoke intentionally validates live exchange quotes for ETH and historical trend bars only for BTC.' },
    providerErrors: marketData.errors || [],
  };
});
const { checks, status } = assessDayMarketDataSmoke(report, {
  requestedSymbols: assets.map((asset) => asset.symbol),
  historicalCandleSourceAvailable: Number(result.bitcoinHistory?.candleCount) > 0,
  elapsedMs: Date.now() - startedAt,
});
const payload = { checkedAt, status, purpose: 'BTC/ETH public exchange quote and BTC candle-path smoke test; not a strategy, signal, execution, or profitability test.', checks, report,
  globalProviderErrors: result.providerErrors || [] };
const historyPath = fileURLToPath(new URL('../data/market-data-smoke-history.ndjson', import.meta.url));
await appendDayMarketDataHistory(buildDayMarketDataHistoryRow(payload), { path: historyPath });
payload.historyJournal = 'data/market-data-smoke-history.ndjson';
await writeFile(new URL('../DAY_MARKET_DATA_SMOKE.md', import.meta.url), `# Crypto day-market data smoke test\n\n${status}. This result is limited to one read-only public-data observation; it does not verify sustained availability, provider entitlements, feed licensing, order fills, or strategy performance. No Discord message, paper reservation, or order was created.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);
console.log(JSON.stringify(payload, null, 2));
if (status !== 'PASS_PROVIDER_PLUMBING_ONLY') process.exitCode = 2;
