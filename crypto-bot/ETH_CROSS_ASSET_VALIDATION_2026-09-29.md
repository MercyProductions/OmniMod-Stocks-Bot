# ETH cross-asset replay — 2026-09-29

## Frozen evaluation

This replay applies Crypto's existing fixed 15-minute rule strategy and default parameters to ETHUSDT without tuning. BTC parameters were selected before ETH was tested, so this adds cross-asset evidence; it is not a fully blinded test because the strategy and its parameters were already known. No production strategy, thresholds, alerts, or risk controls changed as a result.

- Source: Binance Spot public Kline REST endpoint (`https://data-api.binance.vision/api/v3/klines`), 15-minute ETHUSDT candles.
- Requested interval and fixed as-of cutoff: 2026-04-01 00:00 UTC through 2026-09-29 17:00 UTC (exclusive).
- Completed bars: 17,444 expected / 17,444 returned; zero missing slots. The replay excluded zero incomplete/future, malformed, or duplicate bars.
- Fetch: 18 successful HTTP 200 page responses.
- Dataset SHA-256: `6d09c3ec841e7802f6c0e7de35974570a8ace751de8ec57cdd3a742910d2cc5f` (verified against the local file).
- Dataset and machine-readable manifest: `data/research/historical/ETHUSDT-15m-2026-04-01_to_2026-09-29-17Z.ndjson` and adjacent `.manifest.json`. Research data may be git-ignored.
- Chronological split: 119 earlier candle days and 64 recent candle days; recent results span 63 UTC signal-day clusters.

## Cost sensitivity

Costs are explicit scenarios, not observed Binance fees, historical executable spreads, or calibrated market impact. The model assumes one full quoted spread crossed and per-side fee/slippage on entry and exit.

| Assumed round-trip costs | Recent trades | Wins / small moves / losses | Recent expectancy | Profit factor | Net R | Max drawdown |
|---:|---:|---:|---:|---:|---:|---:|
| 10 bp (2.5 fee/side + 2 spread + 1.5 slippage/side) | 259 | 107 / 16 / 136 | -0.134R | 0.650 | -34.69R | 35.93R |
| 20 bp (5 fee/side + 6 spread + 2 slippage/side) | 258 | 97 / 9 / 152 | -0.242R | 0.462 | -62.40R | 63.42R |
| 40 bp (10 fee/side + 10 spread + 5 slippage/side) | 245 | 65 / 11 / 169 | -0.349R | 0.274 | -85.50R | 86.18R |

At 20 bp, the earlier segment had 467 trades, -0.279R expectancy, 0.417 profit factor, -130.20R net, and 130.48R maximum drawdown. The full period had 725 trades, -0.266R expectancy, 0.433 profit factor, -192.61R net, and 193.90R maximum drawdown. The 20 bp recent expectancy's approximate day-clustered 95% interval was [-0.345R, -0.138R], from 258 trades over 63 UTC-day clusters. It is descriptive, not multiplicity-adjusted; cross-day dependence, nonstationarity, and unobserved tail losses can invalidate it.

Using identical explicit cost components, the same-date BTC replay also had negative recent expectancy at each tier:

| Round-trip cost | BTC recent expectancy | BTC recent PF | BTC recent max DD | ETH recent expectancy | ETH recent PF | ETH recent max DD |
|---:|---:|---:|---:|---:|---:|---:|
| 10 bp | -0.142R | 0.601 | 36.54R | -0.134R | 0.650 | 35.93R |
| 20 bp | -0.253R | 0.403 | 64.00R | -0.242R | 0.462 | 63.42R |
| 40 bp | -0.342R | 0.237 | 81.85R | -0.349R | 0.274 | 86.18R |

At the 20 bp tier, BTC had 251 recent trades and a day-clustered 95% interval of [-0.346R, -0.160R]. ETH had 258 trades and [-0.345R, -0.138R]. Both intervals are below zero for this sample and method. This matched-window comparison shows that the negative result was not confined to BTC, but it still covers only two assets on one venue and assumes costs/fills.

## Interpretation and limits

This evidence argues against treating the fixed rule as validated for BTC or ETH and against relaxing approval gates to increase trade count. Preserve production behavior: this replay evaluates only the fixed-rule research validator, not the production scanner/ensemble/model. OHLCV is not synchronized executable bid/ask or depth, and the cost inputs are assumptions. One venue and current-asset selection also leave venue and survivorship bias. This does not validate Stocks, Forex, Futures, Options, ETFs/ETPs, or actual Crypto fills. No authenticated account, order, Discord post, or exchange connection was used.

The replay reports `smallMoves` explicitly; wins, small-move outcomes (absolute realized result at most 0.05R), and losses sum to the complete trade count.
