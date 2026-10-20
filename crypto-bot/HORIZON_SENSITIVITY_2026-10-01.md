# Crypto fixed-rule horizon sensitivity — 2026-10-01

Frozen comparison of 45, 120, 240 and 360-minute holding windows using the five checksum-pinned Binance 15-minute datasets ending 2026-09-29 17:00 UTC. All variants keep the same entry rule, stop, reward/risk and modeled 20 bp round-trip cost. BTC was previously used to examine parameters and is displayed as context; the other four assets are cross-asset exploration. These datasets were previously examined, so this is **not a blind holdout**.

Each row uses the existing chronological 65% earlier / 35% recent split. The interval resamples entire UTC signal days; it is descriptive and does not account for multiple horizons or correlated assets. Net R and expectancy are after modeled costs.

| Asset | Window | Recent trades/days | Recent expectancy R | Day-cluster 95% interval | Recent PF | Recent net R | Recent max DD R | Earlier trades/days | Earlier expectancy R |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BTC | 45m | 752/64 | -0.236 | [-0.261, -0.211] | 0.155 | -177.2 | 177.2 | 1320/116 | -0.245 |
| BTC | 120m | 401/64 | -0.249 | [-0.308, -0.192] | 0.288 | -100.0 | 100.3 | 696/116 | -0.268 |
| BTC | 240m | 251/62 | -0.253 | [-0.345, -0.164] | 0.403 | -63.6 | 64.0 | 438/115 | -0.277 |
| BTC | 360m | 198/63 | -0.229 | [-0.325, -0.133] | 0.497 | -45.4 | 46.3 | 350/116 | -0.282 |
| SOL | 45m | 754/64 | -0.218 | [-0.254, -0.179] | 0.324 | -164.5 | 164.7 | 1307/115 | -0.249 |
| SOL | 120m | 400/64 | -0.209 | [-0.291, -0.129] | 0.501 | -83.6 | 84.2 | 707/115 | -0.256 |
| SOL | 240m | 284/63 | -0.233 | [-0.335, -0.135] | 0.546 | -66.1 | 68.7 | 491/115 | -0.268 |
| SOL | 360m | 241/63 | -0.250 | [-0.362, -0.140] | 0.555 | -60.2 | 63.0 | 416/115 | -0.252 |
| XRP | 45m | 682/62 | -0.219 | [-0.262, -0.179] | 0.339 | -149.5 | 149.5 | 1222/116 | -0.240 |
| XRP | 120m | 397/62 | -0.229 | [-0.317, -0.141] | 0.498 | -91.0 | 93.3 | 660/116 | -0.242 |
| XRP | 240m | 291/62 | -0.249 | [-0.358, -0.147] | 0.536 | -72.5 | 75.5 | 437/116 | -0.278 |
| XRP | 360m | 259/62 | -0.217 | [-0.348, -0.098] | 0.603 | -56.2 | 58.9 | 376/116 | -0.283 |
| BNB | 45m | 779/64 | -0.207 | [-0.235, -0.178] | 0.221 | -161.2 | 161.2 | 1364/118 | -0.238 |
| BNB | 120m | 409/64 | -0.223 | [-0.284, -0.164] | 0.382 | -91.3 | 91.3 | 702/118 | -0.230 |
| BNB | 240m | 250/64 | -0.178 | [-0.277, -0.083] | 0.561 | -44.4 | 44.4 | 449/118 | -0.238 |
| BNB | 360m | 206/64 | -0.193 | [-0.315, -0.074] | 0.587 | -39.8 | 41.0 | 351/118 | -0.242 |
| ADA | 45m | 725/64 | -0.262 | [-0.319, -0.207] | 0.360 | -189.9 | 190.5 | 1200/116 | -0.249 |
| ADA | 120m | 452/64 | -0.285 | [-0.369, -0.210] | 0.461 | -128.8 | 131.6 | 685/115 | -0.271 |
| ADA | 240m | 367/63 | -0.269 | [-0.376, -0.165] | 0.528 | -98.8 | 102.2 | 512/115 | -0.270 |
| ADA | 360m | 343/63 | -0.260 | [-0.378, -0.150] | 0.550 | -89.3 | 93.6 | 459/115 | -0.269 |

## Interpretation

All four cross-assets have negative earlier and recent after-cost expectancy at every tested horizon; every recent day-cluster interval has an upper bound below zero. No tested horizon rescues this fixed rule under the modeled 20 bp costs.

Compare the entire cross-asset and earlier/recent pattern, not the best single cell. These horizons represent different trade lifetimes and can change the later opportunity sequence. No horizon is selected or promoted by this report. The JSON companion retains exit-reason counts, average bars held, dataset hashes, and all modeled metrics.

## Limitations

- The pinned Binance OHLCV assets and 240-minute fixed rule were previously examined; no horizon here is an untouched blind test.
- The fixed rule is not the complete production Crypto ensemble or provider/portfolio approval path.
- Cost components are one 20 bp round-trip scenario, not observed fills, spread history, market impact or funding.
- Different exits can change subsequent non-overlapping entry opportunities; rows are strategy-level comparisons, not matched entry outcomes.
- Assets, adjacent horizons and signal days are dependent; the displayed day-cluster intervals have no multiple-comparison correction.
- A favorable horizon in this study cannot be promoted without later untouched data and multi-session forward paper evidence.

