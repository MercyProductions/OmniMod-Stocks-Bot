# Free venue research: measured follow-through — 2026-10-03

The isolated free-provider research path was exercised against real public APIs. It discovered current pairs, attempted bounded detail checks and resolved its previously recorded observation. This is provider-backed research evidence, not validated trading performance, account tradability, deployment or whole-ecosystem coverage.

## Measured scan

The 08:47:55 UTC report came from `npm run probe:venue-discovery -- --deep`:

| Stage | Measured result |
| --- | --- |
| Binance directory pairs | 3,720 |
| Active spot pairs | 1,372 |
| Pairs cheaply checked | 3,720 |
| Bulk ticker rows | 3,723; three unmatched to the directory |
| Initial positive-activity/liquidity pairs | 30 |
| Distinct initial base assets | 28 |
| Assets matched to cached venue identity | 28 |
| Shortlist | 8; 20 deferred by deep-analysis budget |
| Additional detailed-data requests | 2 |
| Technically analyzed / newly recorded observations | 0 / 0 |
| Discord posts / reservations / approved setups | 0 / 0 / 0 |

Both selected assets were also in the 350-asset baseline snapshot. This run therefore does not independently prove selection beyond the baseline, although the cheap directory covered all returned pairs before filtering. The directory and bulk snapshots were newly fetched. Venue identity reused its completed 14-page mapping from 2026-10-02 14:39 UTC, within the existing daily cache policy.

Detailed QNT checking found zero currently verified venue pairs despite the cached directory mapping. JST had one accepted provider, insufficient for the existing two-provider condition; its Coinbase request returned HTTP 404. Therefore technical history/strategy validation did not run for either asset. Reported `technical_data` and `strategy_validation` rejections are unmet dependencies here, not failed independent backtests. JST also missed the existing score requirement. No gate was reduced to force an observation.

Elapsed time was 87.56 seconds, with 63.805 seconds in the detailed path, including deliberately paced public identity calls. Telemetry recorded 17 requests, 16 successes, one failure and no 429 events. Binance directory/bulk used-weight snapshots were 22/102; these are snapshots, not summed utilization. CoinGecko remaining credits and rate-limit utilization were not supplied and remain unknown. Real latency values are in the archived report; cached identity can lag a fresh per-asset check and must not override it.

## Forward outcome

`npm run probe:venue-discovery -- --resolve` at 08:46 UTC made one successful Binance history request and resolved the single pending SKY observation captured on 2026-10-02 at 14:46:42 UTC. Its frozen source was Binance `SKYUSDT`; the horizon ended at 18:46:42 UTC that day.

Seventeen matching source candles reproduced the stored `candle_stop_first` resolution exactly. Modeled net result: **-1.232621R**, or **-2.622145%** relative to the observation entry price, including its frozen **0.494853%** estimated round-trip cost. These are candle-model quantities. There was no measured fill, order, account P&L or new position. One outcome from one entry date cannot establish expectancy, profitability or a reliable loss rate.

The original observation and both relevant monthly normalized-candle files are copied and SHA-256 pinned under `../review-verification/crypto-venue-followthrough-evidence-20261003/`. `evidence.json` records the replay and summary. Operational retention will not silently replace this saved evaluation input. Source bars are normalized stored provider data, not a full raw HTTP capture or executable bid/ask path.

## New reporting

From `crypto-bot`:

```powershell
npm run probe:venue-discovery -- --status
```

This reads local research and writes the usual dated report without market-data requests. A fetch/HTTP/socket guard verified **zero network attempts**. `--status` and `--resolve` each run separately from discovery flags.

`summarizeVenueResearchRows` reports recorded/pending/due observations, exact source-candle outcomes, separate approximate deadline audits, unusable resolutions and their reasons. It checks versions, source pair, original entry-quote evidence, chronology, numeric fields and frozen cost agreement, then reconciles net R to the recorded exit and supported full/partial-exit arithmetic. Missing costs are not zero. Unknown fills, original partial-target histories and dollar P&L remain null. Means are descriptive, with explicit sample size and UTC entry-date counts. Overlapping observations are not claimed to be independent.

The existing `/crypto research` implementation now includes a separate venue-cohort embed field plus a full JSON attachment. Its embed uses the existing size limiter. This handler is locally syntax/regression checked; delivery of this change on the hosted bot has not been exercised. The cohort remains excluded from production training and strategy promotion.

## Verification and next steps

Four original files and 23 baseline tests were preserved. Focused suite: 33 passing tests. Full `npm run verify:all`: 1,427 tests (824 shared/new-market, 268 Stocks, 335 Crypto), configured syntax checks and nine Windows launcher checks. Tests cover absent/malformed evidence, pending rows, partial exits, source conflicts, approximate deadlines, cost reconciliation and exclusion from training. Read-only source replay matched the actual stored outcome. No strategy thresholds, credentials, subscriptions, production ledger or hosted code changed.

Continue multi-session prospective collection, measure identity disagreements and data/confirmation losses, and keep original source evidence. Expand legitimate venue coverage with stable identity and explicit account/feed limitations. Finer execution data is required before interpreting candle research as fill performance. Paid profiles remain optional; no paid service was enabled by these commands. The separate Futures detailed-routing and remaining account-backed scanner checks are still pending.

Provider contract: Binance documents the unauthenticated directory, ticker and kline endpoints on its [market-data-only service](https://developers.binance.com/en/docs/products/spot/faqs/market_data_only). The run used that public data route, not an authenticated trading account.
