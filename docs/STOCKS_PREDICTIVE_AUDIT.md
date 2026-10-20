# Stocks predictive intelligence audit — 2026-10-20

## Scope and preserved baseline

Baseline commit: `0787c785769eea037fa5751349f5bf657129890d`.
Tag: `baseline/pre-stocks-predictive-2026-10-20`. A separate private Git bundle also preserves the repository. Development branch: `feat/stocks-predictive-intelligence-2026-10-20`. No production deployment, broker connection, token modification, or live-order enablement was performed.

This report distinguishes source inspection and local tests from deployed behavior. The source audit covers discovery, data construction, models, event enrichment, portfolio approval, persistence and evaluation. Production hosting, actual provider entitlements, historical accuracy and notification timing were not measured. The older `OPPORTUNITY_DISCOVERY_AUDIT.md` contains explicitly historical sections; its Yahoo/static-watchlist description is **not the current data path**.

## 1. Effective universe and discovery bottleneck

Measured from current defaults: **49 configured watchlist symbols**, **52 unique requested symbols including context**, **37 non-context symbols before ownership and quality exclusions**. Dynamic discovery defaults on but requires Alpaca credentials. It can add at most **15** deep-analysis names per refresh by default, configurable up to 30. These are code counts, not a claim of 52 successful live downloads.

The wide path queries an all-status Alpaca US-equity directory, records dispositions and membership changes, excludes inactive/nontradable/unsupported identities and instruments owned by the ETF/ETP bot, then batches current snapshots. Recognized listing exchanges include NASDAQ, NYSE, AMEX, ARCA, BATS and NYSEARCA. OTC is excluded. Common/ADR/preferred/warrant subtypes cannot be established merely from `us_equity`; the existing directory diagnostics correctly disclose that limitation. Listing names are not authoritative security-type classifiers.

**The exact current provider-wide eligible count is unavailable:** neither the reviewed clone nor the inspected local environment has Alpaca key/secret values, and no locally saved encrypted provider fields or research JSONL history were found. The production host was not accessed. Publishing a made-up 6,000-stock count would be misleading.

Confirmed early-detection limitation: `rankAlpacaSnapshotCandidates` rejects non-positive session moves and ranks survivors by `2 * changePct + log10(dollarVolume)`. This rewards movement already in progress; it does not detect volume acceleration before price expansion. The screener combination and 15-name cap can exclude quieter names. A 15-minute discovery cache and 15-minute default discovery cadence further limit lead time. These controls are unchanged in this infrastructure phase; replacing the production ranking requires a separately tracked forward experiment.

## 2. Actual scan architecture

`index.js` performs universe maintenance/labeling on opening or manual scans, resolves session eligibility, updates subscriptions and calls `fetchMarketUniverse`. Wide discovery uses cached membership, batched snapshots, bounded concurrency, request budgets, quota headroom and archived complete screens/rejections. Configured/context names plus selected dynamic names then receive full chart analysis.

**The current deep provider is Alpaca**, via `fetchAlpacaSymbol`: seven calendar days of five-minute bars and approximately a year of daily history, with daily cache reuse. Missing credentials do not constitute a functional free anonymous scanner. A free account and its own keys are necessary for this adapter. No anonymous or unsupported Yahoo scraping fallback was added.

The following stages remain: market/sector context → Auralith v4 technical scoring → quality/technical rules → consecutive confirmation → v4 research model or v3 fallback decision → executable quote refresh → portfolio approval → paper reservation/publication → quote/path monitoring → final grading. Separate premarket research watches already exist; regular-session entry eligibility is not silently expanded.

## 3. Provider capabilities and limits

Checked against official material on 2026-10-20; account entitlements still require a successful authenticated probe.

| Provider | Source behavior and useful capabilities | Limits and decision |
|---|---|---|
| Alpaca | Existing assets, snapshots, screeners, five-minute/daily historical bars, streaming quotes/trades/minute bars, paper quote refresh and licensed backfill | Basic real-time feed is IEX, a **single venue**, not consolidated volume. Official documentation lists 200 historical calls/minute and limited Basic stream symbols. SIP history older than 15 minutes can be available without real-time SIP entitlement; that is research data, not live executable evidence. Keep actual configured request budget and account restrictions. |
| Massive / existing Polygon adapter | Existing independent quote/trade/context integration can be supplemented by entitled history, corporate actions and reference data | Basic documentation describes end-of-day availability and limited history; minute aggregates available after the day are not real-time minute data. Current adapter uses the established Polygon interface; a host migration was not assumed. No paid plan purchased or unlicensed redistribution enabled. |
| Finnhub | Existing quote cross-check, earnings and event interfaces | Its public pricing page could not be read as structured text in this session. Candle/news/redistribution entitlement therefore remains unverified. A last price is not an executable NBBO. No claim that free candles or commercial redistribution are included. |
| SEC EDGAR | Existing submission/company-fact enrichment, accession/fundamental evidence journal and paced identified requests | Public filings/facts, not a live price feed. Acceptance/publication timestamps matter; filing dates alone cannot prove intraday availability. Existing filing timestamp fallback and historical revised facts need further point-in-time review before new predictive use. |
| Nasdaq Data Link | Official catalog includes separate datasets and exchange information | Dataset access/license varies; documentation access was incomplete. No blanket free intraday entitlement or adapter was invented. |
| Stooq | Potential historical research source | Permitted automated use, adjustment semantics and redistribution were not verified from accessible authoritative terms. No scraping/downloading adapter added. Daily history cannot validate 5-minute signals. |

References: [Alpaca plans/data](https://docs.alpaca.markets/us/docs/about-market-data-api), [Alpaca feed/history FAQ](https://docs.alpaca.markets/us/docs/market-data-faq), [Massive stock pricing](https://massive.com/pricing?product=stocks), [Massive historical availability](https://massive.com/knowledge-base/article/how-quickly-can-i-access-massives-market-date), [Finnhub pricing](https://finnhub.io/pricing), [SEC public APIs](https://data.sec.gov/), [Nasdaq dataset documentation](https://data.nasdaq.com/databases/NB/documentation?anchor=nasdaq-cloud-data-service-api).

## 4. Funnel survival and rejection evidence

Existing `scanDiagnostics.js`/research JSONL already retain stage counts, technical/confirmation/model/risk reasons, failed symbols, durations, provider latency, retries, 429s and reported quotas. The complete wide snapshot archive retains cheap-screen data and rejection records for 14 days. Deep feature rows include unsuccessful names, not only trades.

There are **zero local research JSONL files** in the inspected original Stocks `data` directory. Production survival counts, top rejection reason frequencies, provider latency and scan duration are therefore **unknown**, not zero. Default thresholds are not empirical rejection frequencies. Use administrator `/stocks diagnostics` on the real running instance and preserve its history before drawing conclusions.

## 5. Model and cold-start status

The current bot already contains genuine logistic/boosted-stump learning; it is not accurate to call all existing models fake AI. Auralith's deterministic score is a separate feature/ranking system. v3 requires completed production paper outcomes (default 80); disabling rule-only entries with no champion can create a cold-start loop. v4 is designed to escape it by learning from all-screen counterfactual outcomes, including rejected candidates. Its default retraining trigger requires at least 720 total labels across the configured three horizons, then independent-day, purging, calibration and expectancy requirements apply.

Minute-bar streaming is necessary for complete path labels. Default cap is 30 symbols; configured/context subscription ordering can leave many equities without complete paths. IEX missing minutes must not be filled with fabricated candles. Dynamic discoveries appended after configured names may receive no stream slot. Neither a deployed champion nor its actual readiness was verified here.

Existing v4 counterfactuals can shorten horizons at the session close; the new challenger explicitly refuses to call a short late-session path a full 240-minute forecast. Existing research example loading uses terminal time for purging, although labels require complete paths and may be collected later. The new engine purges by both **full horizon end and actual label availability**. The old trainer is preserved pending a versioned regression/forward comparison; it was not silently replaced.

## 6. Implemented infrastructure

Every newly persisted deep feature snapshot now embeds `predictiveObservation`: original scan start, actual observation availability, native price timestamp, separate feature timestamp, schema, provider/coverage, missingness, time-valid manual catalysts, pre-observation movement and six explicit horizon contracts. New fields do not replace legacy features. Missing flow/spread is retained as null instead of legacy zero defaults.

The new SQLite research warehouse freezes observations, forecasts, version IDs, costs, path hashes and outcomes; refuses conflicting IDs; and ingests complete JSONL records with transactional offsets. It does not backdate inference or label availability. Historical expired observations abstain at inference. No untrained probability is displayed.

A separate authenticated Python service and bounded Node worker connect these records to actual LightGBM classification/regression code. Direction, target-before-stop and return regression are distinct targets. Model selection, Platt calibration and final holdout use distinct chronological day blocks; full-path/availability purging applies. Training priors and no-information/no-change baselines are reported. Artifacts use native model text and integrity hashes, not pickle. All candidates remain research-only. Chronos-Bolt-Tiny is an explicit optional, revision-pinned CLI challenger with same-session, gap and adjustment checks; its stock skill and raw range calibration are unverified.

Five intraday horizons are implemented. **Next-session forecasting explicitly abstains** until verified exchange calendars, corporate-action handling and appropriate next-session targets are supplied. Premarket is recorded but the new supervised trainer does not pretend that regular-session calibration transfers to it. The production premarket watch path remains intact.

## 7. Performance and reliability

No extra market-provider requests are added by the new snapshot writer. The inference worker is a separate one-pass process, capped at 250 observations or 45 seconds; it never posts to Discord or calls an order API. Service failure cannot block the main scanner. Retrying an observation returns the original frozen result. Body sizes, timeouts, redirects, external HTTPS and dedicated-token requirements are enforced.

Baseline deep request cost remains roughly one intraday request per selected symbol plus one uncached daily series, with paging possible; up to six symbol tasks run concurrently. Daily caching, the shared Alpaca request gate and wide discovery budgets already exist. No claim of thousands of serial deep downloads is supported. Main remaining bottlenecks: selection cache/cadence, limited deep slots, minute-label subscription coverage, incomplete venue volume, event/quote enrichment costs and missing research samples. Real stage timing requires the running host.

## 8. Behavior changes requiring forward validation

Not implemented as production changes: quiet-market discovery ranking, changing confirmation/scanning cadence, earlier alerts, adding short signals, changing feed, promoting LightGBM/Chronos, next-session forecasts, premarket execution, new news features, or any risk threshold modification. None is justified by a synthetic test or increased alert count.

Still required: lawful historical intraday/quote/action data; full Auralith replay and matched simple baselines; expanding purged walk-forward studies; independent untouched holdout; regime/liquidity/market-cap breakdowns; selection-bias controls; after-cost portfolio replay; measured Discord/executable-entry lead time; forward research and promotion policy; controlled deployment/host inspection. These are tracked individually in `STOCKS_PREDICTIVE_PHASES.json`.

## 9. Evidence and conclusions

Baseline: 302/302 Node tests. Current implementation adds contract, timestamp, calendar, missingness, auth, immutable warehouse, gap/feed/cost, calibration/serialization and real loopback HTTP tests. See `STOCKS_PREDICTIVE_SETUP.md` for exact commands and `STOCKS_PREDICTIVE_RESULTS.json` for final recorded results.

No real Stocks model has been trained, validated, promoted or deployed in this phase: suitable historical data/access was absent. The synthetic LightGBM fixture demonstrates that fitting, calibration, serialization and inference execute; it is **not market-performance evidence**. Prediction quality, profitability and earlier actionable detection remain unproved.

## Quiet-market and walk-forward continuation

The continuation adds a separate quiet-market shadow rank, bounded deep research, expanding purged walk-forward evaluation and a limited private study using official free historical demos. See [STOCKS_QUIET_WALKFORWARD.md](STOCKS_QUIET_WALKFORWARD.md) and the updated phase checklist. Earlier initial-phase statements about absent historical studies are superseded by this follow-up; no production validation or promotion is implied.
