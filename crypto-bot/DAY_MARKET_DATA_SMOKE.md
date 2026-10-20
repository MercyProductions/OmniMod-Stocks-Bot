# Crypto day-market data smoke test

PASS_PROVIDER_PLUMBING_ONLY. This result is limited to one read-only public-data observation; it does not verify sustained availability, provider entitlements, feed licensing, order fills, or strategy performance. No Discord message, paper reservation, or order was created.

```json
{
  "checkedAt": "2026-09-30T22:31:59.864Z",
  "status": "PASS_PROVIDER_PLUMBING_ONLY",
  "purpose": "BTC/ETH public exchange quote and BTC candle-path smoke test; not a strategy, signal, execution, or profitability test.",
  "checks": {
    "requestedSymbols": 2,
    "missingSymbols": [],
    "duplicateSymbols": [],
    "symbolsWithAtLeastTwoFreshExecutableExchangeQuotes": 2,
    "symbolsWithQuoteDisagreement": [],
    "historicalCandleSourceAvailable": true,
    "elapsedMs": 1658
  },
  "report": [
    {
      "symbol": "BTC",
      "quoteProviders": [
        {
          "provider": "Binance",
          "pair": "BTCUSDT",
          "bid": 83840.97,
          "ask": 83840.98,
          "spreadPct": 0.000011927342203214253,
          "observedAt": "2026-09-30T22:31:59.009Z",
          "timestampBasis": "provider timestamp"
        },
        {
          "provider": "Coinbase",
          "pair": "BTC-USD",
          "bid": 83780.14,
          "ask": 83780.15,
          "spreadPct": 0.000011936002252993608,
          "observedAt": "2026-09-30T22:31:57.286248804Z",
          "timestampBasis": "provider timestamp"
        }
      ],
      "receiptTimestampOnlyObservations": [
        {
          "provider": "Kraken",
          "pair": "XBTUSD",
          "bid": 83784.7,
          "ask": 83784.8,
          "receivedAt": "2026-09-30T22:31:59.458Z",
          "status": "diagnostic-only; excluded from fresh provider confirmation"
        }
      ],
      "exchangeProviderCount": 2,
      "consensusPrice": 83810.56,
      "priceDispersionPct": 0.07259228431357159,
      "medianSpreadPct": 0.00001193167222810393,
      "conflicted": false,
      "staleOrInvalidQuotes": 0,
      "quoteRejectionCounts": {
        "receipt_time_only": 1
      },
      "historicalCandles": {
        "provider": "Binance",
        "pair": "BTCUSDT",
        "count": 299,
        "errors": []
      },
      "providerErrors": []
    },
    {
      "symbol": "ETH",
      "quoteProviders": [
        {
          "provider": "Binance",
          "pair": "ETHUSDT",
          "bid": 2689.14,
          "ask": 2689.15,
          "spreadPct": 0.00037186540704269494,
          "observedAt": "2026-09-30T22:31:59.004Z",
          "timestampBasis": "provider timestamp"
        },
        {
          "provider": "Coinbase",
          "pair": "ETH-USD",
          "bid": 2687.41,
          "ask": 2687.42,
          "spreadPct": 0.00037210479215968794,
          "observedAt": "2026-09-30T22:31:58.180654414Z",
          "timestampBasis": "provider timestamp"
        }
      ],
      "receiptTimestampOnlyObservations": [
        {
          "provider": "Kraken",
          "pair": "ETHUSD",
          "bid": 2687.83,
          "ask": 2687.84,
          "receivedAt": "2026-09-30T22:31:59.525Z",
          "status": "diagnostic-only; excluded from fresh provider confirmation"
        }
      ],
      "exchangeProviderCount": 2,
      "consensusPrice": 2688.355,
      "priceDispersionPct": 0.059143974661089976,
      "medianSpreadPct": 0.00037198509960119147,
      "conflicted": false,
      "staleOrInvalidQuotes": 0,
      "quoteRejectionCounts": {
        "receipt_time_only": 1
      },
      "historicalCandles": {
        "requested": false,
        "note": "Smoke intentionally validates live exchange quotes for ETH and historical trend bars only for BTC."
      },
      "providerErrors": []
    }
  ],
  "globalProviderErrors": [],
  "historyJournal": "data/market-data-smoke-history.ndjson"
}
```
