# BTC/ETH regime attribution replay — 2026-09-29

This is a descriptive regrouping of the existing fixed-strategy, matched-window historical replay. It does not tune or change the strategy. The run combined the same-provider, date-matched BTC and ETH 15-minute Binance Spot files so ETH trades could use contemporaneously available BTC regime data.

- As-of: 2026-09-29 17:00 UTC; 17,444 completed bars per symbol (2026-04-01 00:00 through 2026-09-29 16:45 UTC).
- Inputs: `data/research/historical/BTCUSDT-15m-2026-04-01_to_2026-09-29.ndjson` (SHA-256 `7e2f3997f112afbe8b36a8e1da2e8a6cccb4ff9e5a61de9e5413e89e16bc61c0`) and `data/research/historical/ETHUSDT-15m-2026-04-01_to_2026-09-29-17Z.ndjson` (SHA-256 `6d09c3ec841e7802f6c0e7de35974570a8ace751de8ec57cdd3a742910d2cc5f`).
- Regime: existing Crypto BTC EMA9/21/50, MACD, 4-hour return and RSI heuristic. Each signal uses BTC candles completed at or before the signal candle close; same-provider matching is required. The benchmark's price-only label is not a macro or volatility regime.
- Costs: unchanged legacy all-in round-trip assumptions of 10, 20, and 40 basis points. These are scenarios, not historical executable spreads, venue fee records, or calibrated impact.

## Recent chronological segment

Each cell shows trades / expectancy in R. Overall outcomes stayed negative in every cost scenario; the small risk-off BTC cohort does not support a separate edge claim.

| Instrument / round-trip cost | Risk-on | Neutral | Risk-off | Unknown |
|---|---:|---:|---:|---:|
| BTC / 10 bp | 243 / -0.138 | 10 / -0.229 | 0 | 0 |
| BTC / 20 bp | 241 / -0.250 | 10 / -0.340 | 0 | 0 |
| BTC / 40 bp | 230 / -0.336 | 9 / -0.501 | 0 | 0 |
| ETH / 10 bp | 192 / -0.146 | 42 / -0.148 | 25 / -0.021 | 0 |
| ETH / 20 bp | 191 / -0.254 | 42 / -0.255 | 25 / -0.129 | 0 |
| ETH / 40 bp | 179 / -0.338 | 42 / -0.398 | 24 / -0.343 | 0 |

At 20 bp, BTC recent expectancy was -0.253R overall and ETH was -0.242R overall. Regime grouping does not reveal a profitable cohort in this sample. The BTC risk-off bucket is empty because this strategy's signals did not occur in that regime; it is not evidence that risk-off performance is zero.

## Limits

These are exploratory, same-sample cohorts with potentially correlated trades and a heuristic regime definition. Public OHLCV does not model executable quotes, latency, depth, or precise fills. The cross-asset replay is not a blind parameter-selection holdout, does not demonstrate future performance, and is not a profitability claim. No strategy or risk gate was changed based on this view.
