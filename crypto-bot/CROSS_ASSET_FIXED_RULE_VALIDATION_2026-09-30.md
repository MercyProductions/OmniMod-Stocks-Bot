# Crypto fixed-rule cross-asset replay — 2026-09-30

As-of: 2026-09-29T17:00:00.000Z. Strategy: unchanged Crypto fixed-rule 15-minute strategy; BTC-derived parameters; no tuning in this study.

## Dataset integrity

| Asset | Bars | SHA-256 |
|---|---:|---|
| BTC | 17444 | `7e2f3997f112afbe8b36a8e1da2e8a6cccb4ff9e5a61de9e5413e89e16bc61c0` |
| SOL | 17444 | `1936f6808b8a2b74673b4ca6ddb1a4ec10e33734253a4ae27b83373583aad768` |
| XRP | 17444 | `aa12d87e718efb65fa22533c099a36b6bfbe862461153824fa1dea7ec339e66f` |
| BNB | 17444 | `235125fb0f6f313d1e803fd1bf3fe0d2c7a551a4fd410ef71f544fd815dabde5` |
| ADA | 17444 | `44effe7c8043f9db2d1551922afe7d990442fee673516ca9b8bfbd919500fa26` |

All datasets are Binance Spot 15-minute OHLCV for 2026-04-01 through 2026-09-29 17:00 UTC, with 17,444 completed bars and zero declared missing slots. The validator recomputes each file SHA-256 against its saved manifest. BTC bars are used for time-matched regime classification.

## Results

The rule and parameters are unchanged. Results are exploratory: BTC-derived parameters were previously examined, costs are modeled scenarios rather than observed charges/fills, and candle bars are not executable quotes.

### 10 bp modeled round-trip cost

| Asset | Recent n/days | Recent expectancy (R) | Cluster 95% interval (R) | Recent PF | Recent net (R) | Recent max DD (R) | Earlier n/days | Earlier expectancy (R) | Earlier cluster 95% interval (R) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ADA | 369/63 | -0.171 | [-0.276, -0.073] | 0.668 | -63.2 | 68.0 | 516/115 | -0.162 | [-0.247, -0.079] |
| BNB | 253/64 | -0.065 | [-0.157, 0.027] | 0.812 | -16.4 | 17.1 | 450/118 | -0.129 | [-0.202, -0.060] |
| SOL | 290/63 | -0.131 | [-0.239, -0.031] | 0.712 | -38.0 | 40.5 | 495/115 | -0.156 | [-0.221, -0.094] |
| XRP | 292/62 | -0.150 | [-0.251, -0.057] | 0.687 | -43.7 | 47.3 | 439/116 | -0.168 | [-0.243, -0.097] |

#### 10 bp: descriptive performance by BTC regime at signal time

| Asset | Segment | BTC regime | Trades / signal days | Win rate | Expectancy (R) | Profit factor | Net (R) | Max DD (R) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| ADA | recent | risk_on | 249/60 | 46.6% | -0.202 | 0.614 | -50.4 | 54.5 |
| ADA | recent | neutral | 64/40 | 62.5% | 0.094 | 1.226 | 6.0 | 5.4 |
| ADA | recent | risk_off | 56/29 | 41.1% | -0.335 | 0.433 | -18.8 | 20.5 |
| ADA | recent | unknown | 0/0 | —% | — | — | — | — |
| ADA | earlier | risk_on | 371/103 | 47.2% | -0.156 | 0.684 | -58.0 | 64.4 |
| ADA | earlier | neutral | 65/47 | 43.1% | -0.271 | 0.482 | -17.6 | 19.9 |
| ADA | earlier | risk_off | 80/48 | 48.8% | -0.098 | 0.768 | -7.8 | 17.0 |
| ADA | earlier | unknown | 0/0 | —% | — | — | — | — |
| BNB | recent | risk_on | 171/59 | 42.1% | -0.081 | 0.771 | -13.9 | 16.1 |
| BNB | recent | neutral | 36/27 | 44.4% | 0.077 | 1.309 | 2.8 | 2.7 |
| BNB | recent | risk_off | 46/31 | 47.8% | -0.113 | 0.700 | -5.2 | 7.8 |
| BNB | recent | unknown | 0/0 | —% | — | — | — | — |
| BNB | earlier | risk_on | 319/110 | 37.6% | -0.159 | 0.569 | -50.7 | 52.2 |
| BNB | earlier | neutral | 51/44 | 47.1% | -0.032 | 0.893 | -1.6 | 9.5 |
| BNB | earlier | risk_off | 80/54 | 50.0% | -0.070 | 0.817 | -5.6 | 8.1 |
| BNB | earlier | unknown | 0/0 | —% | — | — | — | — |
| SOL | recent | risk_on | 219/58 | 42.9% | -0.162 | 0.666 | -35.5 | 37.6 |
| SOL | recent | neutral | 40/31 | 55.0% | 0.023 | 1.065 | 0.9 | 4.4 |
| SOL | recent | risk_off | 31/22 | 45.2% | -0.109 | 0.707 | -3.4 | 7.2 |
| SOL | recent | unknown | 0/0 | —% | — | — | — | — |
| SOL | earlier | risk_on | 369/109 | 43.4% | -0.196 | 0.562 | -72.2 | 76.5 |
| SOL | earlier | neutral | 70/52 | 60.0% | 0.044 | 1.150 | 3.1 | 8.4 |
| SOL | earlier | risk_off | 56/40 | 41.1% | -0.150 | 0.681 | -8.4 | 13.4 |
| SOL | earlier | unknown | 0/0 | —% | — | — | — | — |
| XRP | recent | risk_on | 233/61 | 45.9% | -0.114 | 0.754 | -26.5 | 29.9 |
| XRP | recent | neutral | 31/23 | 38.7% | -0.360 | 0.376 | -11.2 | 12.1 |
| XRP | recent | risk_off | 28/21 | 39.3% | -0.214 | 0.563 | -6.0 | 7.3 |
| XRP | recent | unknown | 0/0 | —% | — | — | — | — |
| XRP | earlier | risk_on | 324/107 | 38.9% | -0.192 | 0.559 | -62.3 | 64.8 |
| XRP | earlier | neutral | 67/56 | 46.3% | -0.059 | 0.847 | -4.0 | 11.0 |
| XRP | earlier | risk_off | 48/35 | 37.5% | -0.154 | 0.628 | -7.4 | 8.1 |
| XRP | earlier | unknown | 0/0 | —% | — | — | — | — |

Regime rows are descriptive, overlapping across assets and subject to the same OHLCV fill assumptions; do not infer a strategy gate from sparse regime samples.

### 20 bp modeled round-trip cost

| Asset | Recent n/days | Recent expectancy (R) | Cluster 95% interval (R) | Recent PF | Recent net (R) | Recent max DD (R) | Earlier n/days | Earlier expectancy (R) | Earlier cluster 95% interval (R) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ADA | 367/63 | -0.269 | [-0.377, -0.169] | 0.528 | -98.8 | 102.2 | 512/115 | -0.270 | [-0.358, -0.187] |
| BNB | 250/64 | -0.178 | [-0.273, -0.086] | 0.561 | -44.4 | 44.4 | 449/118 | -0.238 | [-0.309, -0.172] |
| SOL | 284/63 | -0.233 | [-0.337, -0.131] | 0.546 | -66.1 | 68.7 | 491/115 | -0.268 | [-0.332, -0.207] |
| XRP | 291/62 | -0.249 | [-0.356, -0.153] | 0.536 | -72.5 | 75.5 | 437/116 | -0.278 | [-0.350, -0.204] |

#### 20 bp: descriptive performance by BTC regime at signal time

| Asset | Segment | BTC regime | Trades / signal days | Win rate | Expectancy (R) | Profit factor | Net (R) | Max DD (R) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| ADA | recent | risk_on | 247/60 | 44.9% | -0.298 | 0.487 | -73.6 | 76.1 |
| ADA | recent | neutral | 64/40 | 62.5% | -0.015 | 0.967 | -1.0 | 6.3 |
| ADA | recent | risk_off | 56/29 | 41.1% | -0.432 | 0.337 | -24.2 | 25.7 |
| ADA | recent | unknown | 0/0 | —% | — | — | — | — |
| ADA | earlier | risk_on | 367/103 | 45.8% | -0.267 | 0.516 | -97.9 | 99.0 |
| ADA | earlier | neutral | 65/47 | 41.5% | -0.373 | 0.360 | -24.3 | 26.4 |
| ADA | earlier | risk_off | 80/48 | 45.0% | -0.200 | 0.582 | -16.0 | 21.5 |
| ADA | earlier | unknown | 0/0 | —% | — | — | — | — |
| BNB | recent | risk_on | 168/59 | 35.1% | -0.193 | 0.537 | -32.4 | 32.4 |
| BNB | recent | neutral | 36/27 | 41.7% | -0.053 | 0.829 | -1.9 | 6.1 |
| BNB | recent | risk_off | 46/31 | 45.7% | -0.220 | 0.495 | -10.1 | 10.5 |
| BNB | recent | unknown | 0/0 | —% | — | — | — | — |
| BNB | earlier | risk_on | 318/110 | 32.4% | -0.268 | 0.389 | -85.3 | 85.8 |
| BNB | earlier | neutral | 51/44 | 47.1% | -0.147 | 0.593 | -7.5 | 11.5 |
| BNB | earlier | risk_off | 80/54 | 42.5% | -0.177 | 0.593 | -14.2 | 14.2 |
| BNB | earlier | unknown | 0/0 | —% | — | — | — | — |
| SOL | recent | risk_on | 216/58 | 39.8% | -0.270 | 0.509 | -58.2 | 60.5 |
| SOL | recent | neutral | 38/31 | 50.0% | -0.058 | 0.854 | -2.2 | 6.9 |
| SOL | recent | risk_off | 30/22 | 40.0% | -0.190 | 0.531 | -5.7 | 8.5 |
| SOL | recent | unknown | 0/0 | —% | — | — | — | — |
| SOL | earlier | risk_on | 366/109 | 37.7% | -0.308 | 0.399 | -112.9 | 114.5 |
| SOL | earlier | neutral | 70/52 | 54.3% | -0.059 | 0.826 | -4.1 | 10.2 |
| SOL | earlier | risk_off | 55/40 | 38.2% | -0.265 | 0.513 | -14.6 | 18.0 |
| SOL | earlier | unknown | 0/0 | —% | — | — | — | — |
| XRP | recent | risk_on | 233/61 | 43.3% | -0.213 | 0.593 | -49.6 | 52.0 |
| XRP | recent | neutral | 30/23 | 36.7% | -0.472 | 0.248 | -14.2 | 15.0 |
| XRP | recent | risk_off | 28/21 | 35.7% | -0.311 | 0.435 | -8.7 | 9.9 |
| XRP | recent | unknown | 0/0 | —% | — | — | — | — |
| XRP | earlier | risk_on | 323/107 | 36.8% | -0.300 | 0.397 | -97.0 | 97.9 |
| XRP | earlier | neutral | 67/56 | 40.3% | -0.177 | 0.603 | -11.9 | 14.4 |
| XRP | earlier | risk_off | 47/35 | 34.0% | -0.270 | 0.451 | -12.7 | 12.8 |
| XRP | earlier | unknown | 0/0 | —% | — | — | — | — |

Regime rows are descriptive, overlapping across assets and subject to the same OHLCV fill assumptions; do not infer a strategy gate from sparse regime samples.

### 40 bp modeled round-trip cost

| Asset | Recent n/days | Recent expectancy (R) | Cluster 95% interval (R) | Recent PF | Recent net (R) | Recent max DD (R) | Earlier n/days | Earlier expectancy (R) | Earlier cluster 95% interval (R) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ADA | 306/63 | -0.377 | [-0.480, -0.287] | 0.380 | -115.5 | 117.5 | 442/115 | -0.363 | [-0.447, -0.282] |
| BNB | 243/64 | -0.285 | [-0.369, -0.194] | 0.325 | -69.3 | 69.3 | 437/118 | -0.359 | [-0.420, -0.299] |
| SOL | 260/63 | -0.336 | [-0.434, -0.242] | 0.367 | -87.5 | 89.0 | 433/115 | -0.375 | [-0.438, -0.314] |
| XRP | 260/62 | -0.309 | [-0.416, -0.199] | 0.423 | -80.3 | 82.2 | 409/116 | -0.384 | [-0.448, -0.326] |

#### 40 bp: descriptive performance by BTC regime at signal time

| Asset | Segment | BTC regime | Trades / signal days | Win rate | Expectancy (R) | Profit factor | Net (R) | Max DD (R) |
|---|---|---|---:|---:|---:|---:|---:|---:|
| ADA | recent | risk_on | 200/61 | 40.5% | -0.389 | 0.363 | -77.9 | 81.0 |
| ADA | recent | neutral | 59/36 | 49.2% | -0.155 | 0.675 | -9.1 | 9.6 |
| ADA | recent | risk_off | 47/28 | 34.0% | -0.606 | 0.205 | -28.5 | 28.5 |
| ADA | recent | unknown | 0/0 | —% | — | — | — | — |
| ADA | earlier | risk_on | 312/103 | 39.4% | -0.355 | 0.359 | -110.7 | 112.1 |
| ADA | earlier | neutral | 56/46 | 35.7% | -0.432 | 0.261 | -24.2 | 24.8 |
| ADA | earlier | risk_off | 74/48 | 33.8% | -0.345 | 0.359 | -25.5 | 26.7 |
| ADA | earlier | unknown | 0/0 | —% | — | — | — | — |
| BNB | recent | risk_on | 163/59 | 28.2% | -0.301 | 0.314 | -49.0 | 49.0 |
| BNB | recent | neutral | 35/27 | 31.4% | -0.189 | 0.417 | -6.6 | 8.0 |
| BNB | recent | risk_off | 45/31 | 28.9% | -0.306 | 0.311 | -13.8 | 13.8 |
| BNB | recent | unknown | 0/0 | —% | — | — | — | — |
| BNB | earlier | risk_on | 309/110 | 21.0% | -0.379 | 0.198 | -117.0 | 117.1 |
| BNB | earlier | neutral | 53/46 | 22.6% | -0.339 | 0.209 | -18.0 | 18.0 |
| BNB | earlier | risk_off | 75/53 | 29.3% | -0.292 | 0.346 | -21.9 | 21.9 |
| BNB | earlier | unknown | 0/0 | —% | — | — | — | — |
| SOL | recent | risk_on | 195/58 | 32.8% | -0.330 | 0.388 | -64.3 | 65.7 |
| SOL | recent | neutral | 36/30 | 30.6% | -0.338 | 0.357 | -12.2 | 13.2 |
| SOL | recent | risk_off | 29/22 | 31.0% | -0.378 | 0.220 | -10.9 | 12.2 |
| SOL | recent | unknown | 0/0 | —% | — | — | — | — |
| SOL | earlier | risk_on | 314/108 | 26.4% | -0.402 | 0.252 | -126.4 | 126.8 |
| SOL | earlier | neutral | 65/53 | 38.5% | -0.233 | 0.443 | -15.2 | 15.2 |
| SOL | earlier | risk_off | 54/39 | 31.5% | -0.383 | 0.370 | -20.7 | 22.4 |
| SOL | earlier | unknown | 0/0 | —% | — | — | — | — |
| XRP | recent | risk_on | 206/61 | 38.3% | -0.290 | 0.452 | -59.8 | 61.0 |
| XRP | recent | neutral | 27/22 | 37.0% | -0.333 | 0.386 | -9.0 | 11.0 |
| XRP | recent | risk_off | 27/22 | 22.2% | -0.423 | 0.249 | -11.4 | 12.6 |
| XRP | recent | unknown | 0/0 | —% | — | — | — | — |
| XRP | earlier | risk_on | 302/107 | 26.8% | -0.420 | 0.204 | -126.7 | 127.3 |
| XRP | earlier | neutral | 63/56 | 34.9% | -0.195 | 0.511 | -12.3 | 13.7 |
| XRP | earlier | risk_off | 44/34 | 22.7% | -0.406 | 0.273 | -17.9 | 17.9 |
| XRP | earlier | unknown | 0/0 | —% | — | — | — | — |

Regime rows are descriptive, overlapping across assets and subject to the same OHLCV fill assumptions; do not infer a strategy gate from sparse regime samples.

## Limitations

- OHLCV bars are not executable quotes or observed fills.
- Fee, spread and slippage tiers are scenarios, not verified historical provider/broker costs.
- BTC-derived parameters were previously examined on BTC; the cross-asset check is not a blinded test.
- This does not validate the production ensemble, signal model, actual fill quality, market impact, funding, or commercial data entitlements.
- Regime-stratified rows are descriptive, may be sparse, overlap across assets, and are not multiplicity-adjusted.
- Universe survivorship and dependence across assets/regimes remain; results are exploratory and do not establish profitability.

