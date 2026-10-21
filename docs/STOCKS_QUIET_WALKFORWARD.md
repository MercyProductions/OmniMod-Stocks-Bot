# Quiet-market discovery and walk-forward continuation

Starting commit: `4c254acca34040f965239a0cd241304f721718ab`. The original baseline tag remains preserved; a private pre-phase Git bundle also captures this starting version. This work extends the existing development PR. No deployment, production model promotion, credential changes or live-order enablement occurred.

## Quiet-market research discovery

`quietMarketDiscovery.js` ranks the **same already-fetched, directory-verified snapshots** alongside the existing broad-discovery ranking. It makes no additional provider requests and does not modify the production shortlist. Both flat and modestly negative daily moves can qualify.

The initial, explicitly experimental research criteria are:

- Regular cash session; price at least $2, fresh trade within 90 seconds, and a completed same-session minute bar within three minutes.
- Valid same-feed OHLC and previous-session reference volume, with at least $250,000 reference turnover.
- Absolute daily move at most 1.5%, observed minute range at most 0.35%, and price within 0.3% of the observed session high.
- Minute volume at least 1.5 times prior-session mean minute volume **or** at least twice a valid previously sampled minute's volume.

These criteria define a research sample, not a validated trading strategy. Prior-session average volume is not a time-of-day volume curve. A comparison between snapshots 15 minutes apart is not continuous volume acceleration or order flow. IEX observations remain single-venue data. A tight observed minute is not proof of statistically significant volatility compression.

The rank freezes at most five research highlights per broad refresh, together with source/observation timestamps, feed, identity, evidence, limitations, rejected counts and cap omissions. The full discovery archive contains the quiet track; the normal market snapshot retains bounded rejection samples. Cached snapshots cannot masquerade as new independent volume observations. Identity/date/feed changes invalidate sampled comparisons. Research errors are isolated from the production ranking.

Administrator `/stocks diagnostics` now reports separate quiet-research coverage and counts. Missing coverage is **unknown**, not zero. None of these counts contributes to approved setup counts. The original broad refresh interval, confirmation requirements, model checks and risk limits are unchanged. Consequently lead time remains bounded by the existing discovery cadence; this is not a claim of continuous full-market monitoring.

### Bounded deep research

With an authorized Alpaca account configured on a research instance, set `STOCKS_QUIET_RESEARCH_GUILD` to that instance's existing guild ID and run:

```powershell
npm --prefix stocks-bot run research:quiet
```

This explicit, separate one-pass worker requires fresh non-deferred quiet highlights, deeply analyzes at most **three** quiet names using the existing data/context/enrichment pipeline, and persists observations for the isolated forecasting worker. The existing 15 market-context symbols can also require data; this is not a claim of only three HTTP calls. Daily caching, request pacing, quota controls and data checks remain in force.

The worker never calls the Discord publisher or an order API. It records under a separate `-quiet-shadow` research guild identity so the existing guild's automatic production learner does not silently consume a new strategy track. A lock and successful-pass cursor prevent ordinary concurrent/repeated passes. After an abnormal exit, confirm the worker is stopped before removing a stale lock. An interrupted pass may be retried; timestamped observations remain research samples, not additional independent trading days.

The existing `research:predictive` worker can subsequently submit these persisted observations to the isolated Python research service. Streaming subscriptions and automatic production promotion are not expanded. Live provider/deep-worker runtime remains unverified without account credentials; unit/integration tests use controlled provider responses.

## Walk-forward evaluator

`forecasting/walkforward.py` implements expanding, nested chronological evaluation:

1. Reserve the last **20% of global observation dates** as final holdout before any folds.
2. Use three expanding development folds. Earlier fold test dates may become legitimate training history in later folds; the final holdout never does.
3. Within each fold's past, use disjoint 60/20/20% training/selection/calibration date blocks.
4. Purge using both full outcome-horizon end and actual label availability, plus a five-minute embargo at every boundary.
5. Select 30/60 LightGBM rounds only on the inner selection block; fit Platt calibration only on calibration data. Direction, target-before-stop and expected return are separate targets.
6. Fit the final candidate from development data only, then evaluate the reserved final dates. No model promotion or inference artifact installation follows.

The suite explicitly changes final-holdout outcomes and verifies that both fold and final model fit hashes remain identical. It also tests delayed-label purging, missing class diversity, small-sample abstention and read-only database evaluation. Minimum study size remains 200 labels across 24 dates; the limit was not reduced to accommodate demo data.

Reports include accuracy, precision/recall, Brier score, log loss, calibration bins, return error, training-prior/no-information/no-change baselines, an explicitly heuristic momentum baseline, regime groups when available, and paired **day-clustered** Brier-difference bootstrap intervals. Intervals are descriptive and unadjusted for multiple horizon/model experiments; they are not promotion evidence.

The fixed research paper policy allows one global position at a time, with no leverage. It uses the frozen cost/latency labels and does not count unfilled observations as realized returns. Returns, profit factor, expectancy and drawdown remain null when no research trades qualify. This policy is not the full Auralith production strategy or its risk approval process. Full matched Auralith comparison still needs historical champions, market/sector/event context and executable quotes; comparing only its technical score would misrepresent that strategy.

Evaluate an existing research database **read-only**:

```powershell
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/walkforward.py --db stocks-bot/data/predictive.sqlite --horizon 15 --output stocks-bot/artifacts/forward-study-001.json
```

Missing databases are not created. Existing output files are not overwritten. Preserve experiment configuration and all results, including failed candidates; do not repeatedly tune against the final holdout.

## Authorized free historical data

The implemented bounded downloader uses **two exact IBM demo examples published by Alpha Vantage**. It does not enumerate undocumented demo endpoints, impersonate a subscriber or bypass a paid history gate. Requests are bounded, cached and SHA-256 fingerprinted; entitlement/error responses stop visibly. No paid API was purchased or invoked.

[Official examples and adjustment semantics](https://www.alphavantage.co/documentation/) and [provider terms](https://www.alphavantage.co/terms_of_service/) were reviewed. The demo is used for private individual research/testing. Raw responses, data-derived weights, row-level forecasts and study metrics are kept out of this public repository. Commercial/public signal use requires the appropriate provider rights; a public source-code license does not redistribute market-data rights.

Example private workflow:

```powershell
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/historical.py --demo recent --output stocks-bot/datasets/official-demo/ibm-recent.json
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/historical.py --demo 2009-01 --output stocks-bot/datasets/official-demo/ibm-200901.json
```

Create an ignored `stocks-bot/datasets/official-demo/study.json` containing:

```json
{"schema":"alpha-official-demo-study-v1","files":["ibm-200901.json","ibm-recent.json"]}
```

Then run, choosing a new output path for each predefined horizon:

```powershell
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/walkforward.py --dataset stocks-bot/datasets/official-demo/study.json --horizon 15 --output stocks-bot/artifacts/private-demo-h15.json
```

Supported research horizons are 5, 15, 30, 90 and 240 minutes. These are actual **five-minute** source bars; no one-minute path is synthesized. Complete same-session paths are required. The feature builder uses only earlier completed bars and earlier sessions' same-clock volume; stale activity baselines do not bridge the long gap between demo periods. The existing cash calendar handles regular holidays, DST and recurring early closes; extraordinary historical closures remain unverified.

The retrospective study assumes data available at bar close, while explicitly marking historical availability **unverified**. Provider default historical prices are split/dividend adjusted and may be corrected after the fact. The study is kept outside the immutable prospective warehouse; reconstructed timestamps cannot become purportedly live forecasts.

Simulation assumes a full five-minute bar of entry latency, 20-bp round-trip costs, gap-through-stop handling and stop-first ambiguity. At a five-minute horizon, that latency leaves no executable trade path: direction forecasts can still be evaluated, but no filled paper trade is invented. This is a conservative methodology check, not validated execution modeling.

All five requested intraday horizon studies were executed privately. This does **not** establish broad-market, quiet-discovery, executable-trading or production-model validity. The study is one surviving stock, two widely separated sample periods, corrected/adjusted prices and no historical NBBO/news/sector data. Private evidence was preserved for the owner; no production candidate was promoted.

Other sources: [Alpaca](https://docs.alpaca.markets/us/docs/market-data-faq) documents free-account IEX data and older SIP history subject to account/feed access; broader research still requires the user's own authorized credentials. HF Data Library was evaluated but its [stated terms](https://hfdatalibrary.com/) restrict use to academic research rather than trading, so it was not downloaded or integrated into this trading project. Unknown licensing was not treated as permission.

## Verification and remaining work

The evidence/checklist files record final commands and counts. Tests cover quiet discovery, original-shortlist preservation, no extra discovery API calls, archived quiet records, missing-coverage diagnostics, global date purging, untouched holdout and read-only CLI behavior. The quiet rank also processed a 6,000-symbol **synthetic CPU fixture** in approximately 27 ms with zero provider requests; this is not a measured live market scan.

Still open: live entitled broad-market coverage, live quiet deep-worker runtime, independent minute-path/quote evidence, actual alert-to-executable-entry lead time, quiet-track forward outcomes, full Auralith replay, corporate-action vintage verification and any production deployment. Live trading remains disabled.
