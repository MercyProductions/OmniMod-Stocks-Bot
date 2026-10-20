# Crypto BTC historical replay — 2026-09-29

## Purpose and scope

This records an exploratory run of Crypto's existing fixed 15-minute rule-strategy historical validator. It does **not** replay the current production scanner, market-provider ensemble, model approval, derivatives gates, or paper portfolio workflow. It is not a recommendation, a profitability claim, or evidence that the production bot is validated.

## Pinned dataset

- Market: BTCUSDT (Binance Spot public market data)
- Interval: 15 minutes, UTC
- Requested range: 2026-04-01 00:00 UTC through (exclusive) 2026-09-29 17:00 UTC
- Completed bars returned: 17,444 / 17,444 expected; 0 missing time slots
- Requests: 18 successful public REST responses
- As-of replay cutoff: 2026-09-29 17:00 UTC
- Dataset: `crypto-bot/data/research/historical/BTCUSDT-15m-2026-04-01_to_2026-09-29.ndjson` (local ignored research data)
- SHA-256: `7e2f3997f112afbe8b36a8e1da2e8a6cccb4ff9e5a61de9e5413e89e16bc61c0`
- Machine-readable fetch metadata: adjacent `.manifest.json` file

The official Binance Spot Kline endpoint defines each bar by open time and supports `startTime`, `endTime`, and up to 1,000 rows per request. The importer used the public market-data host, with no credentials or account endpoints. See [Binance Spot Kline/Candlestick documentation](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#kline-candlestick-data).

## Results

Each replay uses the same strategy and dataset. Only the legacy configured **all-in round-trip cost proxy** changes; the old parameter does not identify its fee, spread, and slippage components separately. The recent segment is the validator's later chronological holdout; after viewing these results it is consumed and cannot be treated as an untouched holdout for parameter selection.

| Assumed all-in round-trip cost proxy | Recent holdout trades | Recent expectancy | Recent profit factor | Recent net R | Recent max drawdown | Day-clustered 95% interval for expectancy |
|---:|---:|---:|---:|---:|---:|---:|
| 10 bps | 253 | -0.142R | 0.601 | -35.87R | 36.54R | [-0.237R, -0.046R] |
| 20 bps | 251 | -0.253R | 0.403 | -63.55R | 64.00R | [-0.346R, -0.160R] |
| 40 bps | 239 | -0.342R | 0.237 | -81.72R | 81.85R | [-0.422R, -0.262R] |

At the 20 bps assumption, the earlier segment had 438 trades, -0.277R expectancy, 0.361 profit factor, and -121.35R net; the combined run had 689 trades, -0.268R expectancy, 0.376 profit factor, and -184.90R net. The test returned `sufficient: true` for this validator's own sample threshold, but its warning is that recent holdout expectancy is not positive. This is negative evidence for the fixed rule under the tested assumptions.

### Recent BTC exit-path attribution at 20 bps

The offline report now groups those same recent trades by their recorded exit path. This is descriptive attribution of one fixed strategy, not a separate strategy comparison.

| Exit reason | Trades | Share | Expectancy (R) | Net (R) |
| --- | ---: | ---: | ---: | ---: |
| Deadline | 177 | 70.5% | -0.120 | -21.27 |
| Stop | 49 | 19.5% | -1.221 | -59.80 |
| Protected exit | 14 | 5.6% | +0.278 | +3.89 |
| Final target | 11 | 4.4% | +1.239 | +13.63 |

The main measured drags are stop exits and the much larger group of deadline exits. Do not infer that moving stops or extending the horizon will help; that would change strategy behavior and requires a new, predeclared training/validation design plus a genuinely future holdout. Candle OHLC path assumptions remain a material limitation.

## Limits and interpretation

- These are historical 15-minute candles, not executable bid/ask quotes, order-book depth, or observed fills. Fixed bps costs are scenarios, not a calibrated fill model.
- This is one asset on one venue, so it does not validate cross-venue differences, costs on altcoins, current-universe selection, or the production ensemble/model.
- The strategy can incur worse realized losses than candle-based stop handling or fixed costs imply. Venue outages, spread widening, market impact, and other tail risks are not represented here.
- The recent holdout has been inspected; do not optimize on it or call it an untouched future test. Require a fresh, predeclared forward-paper cohort and independent data before promotion.
- No bot process, Discord delivery, exchange account, paper reservation, or live order was used in this work.
