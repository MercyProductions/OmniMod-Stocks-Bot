# Crypto cross-asset fixed-rule replay — 2026-09-30

## Purpose and method

This is a frozen cross-symbol check of the existing Crypto fixed 15-minute rule strategy. BTC-derived settings were applied without tuning to BTC, ETH, SOL, BNB, XRP, and ADA. Each Binance Spot dataset covers 2026-04-01 00:00 UTC to the fixed 2026-09-29 17:00 UTC cutoff and contains 17,444 completed bars. The chronological recent segment is the last 64 candle-days (about 63 independent UTC signal-day clusters).

Every run used the same explicit modeled round-trip cost: 5 bp fee per side, 6 bp full spread, and 2 bp slippage per side (20 bp total). Costs are assumptions, not observed historical fees, synchronized executable spreads, or calibrated market impact. Run from `crypto-bot` with:

```powershell
node scripts/backtest-historical.js --data=data/research/historical/<SYMBOL>-15m-2026-04-01_to_2026-09-29-17Z.ndjson --asOf=2026-09-29T17:00:00Z --feeBpsPerSide=5 --quotedSpreadBps=6 --slippageBpsPerSide=2
```

BTC's existing file is named `BTCUSDT-15m-2026-04-01_to_2026-09-29.ndjson`; use that filename in the same command. Each local file hash was checked while replaying. Research datasets are git-ignored.

## Recent chronological segment

| Asset | Trades | Expectancy (R) | Profit factor | Net (R) | Max drawdown (R) | Approx. clustered 95% expectancy interval (R) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC | 251 | -0.253202 | 0.402524 | -63.55 | 64.00 | [-0.345991, -0.160412] |
| ETH | 258 | -0.241879 | 0.461597 | -62.40 | 63.42 | [-0.345441, -0.138316] |
| SOL | 284 | -0.232839 | 0.546228 | -66.13 | 68.68 | [-0.354141, -0.111537] |
| BNB | 250 | -0.177754 | 0.560635 | -44.44 | 44.44 | [-0.282068, -0.073440] |
| XRP | 291 | -0.249155 | 0.536152 | -72.50 | 75.51 | [-0.357154, -0.141156] |
| ADA | 367 | -0.269243 | 0.528033 | -98.81 | 102.18 | [-0.383722, -0.154763] |

All six intervals are below zero under this approximate day-cluster method. It groups same-day trades, but not dependence across days, and is descriptive rather than multiplicity-adjusted. It cannot capture unmodeled tail loss or establish a future edge.

## Frozen source identity

| Asset | Completed bars | SHA-256 |
| --- | ---: | --- |
| BTC | 17,444 | `7e2f3997f112afbe8b36a8e1da2e8a6cccb4ff9e5a61de9e5413e89e16bc61c0` |
| ETH | 17,444 | `6d09c3ec841e7802f6c0e7de35974570a8ace751de8ec57cdd3a742910d2cc5f` |
| SOL | 17,444 | `1936f6808b8a2b74673b4ca6ddb1a4ec10e33734253a4ae27b83373583aad768` |
| BNB | 17,444 | `235125fb0f6f313d1e803fd1bf3fe0d2c7a551a4fd410ef71f544fd815dabde5` |
| XRP | 17,444 | `aa12d87e718efb65fa22533c099a36b6bfbe862461153824fa1dea7ec339e66f` |
| ADA | 17,444 | `44effe7c8043f9db2d1551922afe7d990442fee673516ca9b8bfbd919500fa26` |

## Interpretation and limits

This adds cross-asset evidence against assuming the fixed rule generalizes positively beyond its originating asset. It does not establish that every Crypto strategy is unprofitable. The strategy was already known, so this is not a blinded holdout; assets were selected from currently tracked liquid names; all observations come from one venue; candles do not reveal intrabar bid/ask, depth, queue position, or executable fills. The replay does not run Crypto's production provider-consensus, ensemble, event, or portfolio gates, and is not validation for any of the other five market bots.

No strategy threshold, production approval rule, position sizing, risk control, alert, paper ledger, Discord post, or order route changed. Do not promote this fixed rule based on activity or win rate. A genuinely untouched future cohort and licensed, timestamped execution inputs followed by forward paper are still needed. Live trading remains disabled.
