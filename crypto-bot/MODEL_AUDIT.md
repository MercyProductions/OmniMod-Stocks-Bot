# OmniMod Crypto model audit

## October 2026 entry/outcome provenance correction

The first source-pinned shadow labels used completed candles from one exact venue/pair, but their entry could still be the multi-venue consensus price. That mixes price bases when calculating stop, target, and realized R. New production shadow observations require a <=30-second source-timestamped ask from the same venue/pair as the future candles; entry, stop, target, deadline and conservative modeled cost are frozen from that ask. Missing, conflicting, execution-blocked or mismatched quotes do not enter the training journal. Older version-3 observations remain resolvable for audit, but are excluded from current model training unless they carry the new entry-evidence fields. Stored learned bundles lacking entry-evidence policy version 1 are disabled on load; the deterministic safety gates remain in force. This is a label-integrity change, not a demonstrated improvement in trading performance. Public ticker-only identity and candle OHLC rather than executable exit quotes remain limitations.

## September 2026 corrective audit

The earlier audit overestimated the protection provided by some checks. A new regression suite now covers holdout exit leakage, incomplete bars, stop fees and gaps, final limit fills, net outcome labels, delayed-label availability, deadline look-ahead, provider validation, and duplicate worker credentials. See README's accuracy corrections for the changed behavior. Historical pre-correction results are not evidence for this version; older learned models and labels are excluded from active training/deployment.

Public 15-minute history does not establish execution accuracy. An unaligned deadline can leave an audit mark from an earlier completed close, but that approximation is excluded from the current model-training and liquidity-shadow evidence loaders. Exact barrier touches or a candle closing exactly at the deadline remain eligible subject to the other source/entry/cost gates. Missing intervals stay unresolved, and initial partial candles cannot recover price order. Signal expectancy deliberately becomes more conservative when observed payoff data is sparse. No claim of an economically profitable edge follows from passing automated tests.

## Audit conclusion

The original bot was a momentum screener, not a validated predictive system. Version 4 now has the forward data, outcome definitions, validation barriers, execution model, and deployment controls needed to test whether an edge exists. It still cannot eliminate losses or guarantee profit.

## Version 3 to version 4

| Area | Version 3 behavior | Version 4 behavior |
|---|---|---|
| Market microstructure | Top-of-book and one REST depth snapshot | Live Level-2 books and aggressive trades; spread, depth, CVD, flow, intensity, volatility, impact |
| Outcome label | Positive/non-positive at target, stop, or deadline | Target-before-stop class, competing outcome, time-to-event, realized R, MFE, and MAE |
| Validation | One purged chronological train/blind split | Repeated purged forward folds, blind quarantine, multiple-testing penalty, conformal calibration, cost stress |
| Model deployment | Latest accepted model becomes active | Champion/challenger; promotion requires performance on labels created after staging |
| Uncertainty | Bounded probability and holdout gate | Conformal prediction set plus feature-level out-of-distribution abstention |
| Execution | Configured fee/slippage constant | Paper order size, spread, depth impact, latency volatility, adverse flow, and 3x cost stress |
| Derivatives | Funding, OI, positioning, basis | Adds BTC/ETH DVOL, options skew/term structure, OI ratio, and observed liquidations |
| Events | Provider/regime failures only | Audited symbol or market-wide block/caution windows for crypto-specific events |
| Licensed data | Forward public collection only | Idempotent normalized NDJSON import path without vendor lock-in |

## Accuracy safeguards

1. No signal is posted from the broad snapshot alone.
2. Provider disagreement, a risk-off BTC regime, insufficient candles, or technical disagreement blocks the call.
3. Recent and overall chronological validation must have positive expectancy and profit factor above 1.
4. Same-candle target/stop ambiguity is scored stop-first.
5. Rejected setups remain in the shadow dataset to avoid selection bias.
6. Learned models must improve repeated purged forward folds and a later blind segment after a multiple-testing penalty.
7. Target-before-stop, event-time, realized-return, MFE, and MAE models activate only after their own blind validation.
8. Ambiguous conformal output or material feature-distribution shift forces abstention.
9. Thin depth, wide spreads, high latency risk, adverse flow, or stressed negative expectancy blocks the call.
10. Extreme futures/options/liquidation conditions can veto but never generate leveraged instructions.
11. A challenger cannot be promoted on training data; only later-created labels count.
12. Rolling expectancy, drawdown, Brier score, calibration drift, and provider conflict can pause new calls.
13. Highly correlated or over-cap concurrent exposure is rejected after individual qualification.
14. Crypto event windows can block token-specific or market-wide exposure without stopping monitoring of open calls.

## Recommended production acceptance test

Collect at least 200 labeled shadow observations for initial training, at least 50 genuinely later observations for a challenger comparison, and at least 100 closed published paper signals without changing thresholds mid-sample. Require positive stress-adjusted expectancy, profit factor above 1, acceptable drawdown, repeated-fold stability, blind improvement, and successful fresh-data promotion. If any condition fails, keep the bot in paper mode.

## Remaining external-data work

- Acquire licensed multi-year Level-2, liquidation, and options history so the new forward features can be tested across past regimes.
- Run delisting-aware, point-in-time, multi-asset replay; public forward collection cannot reconstruct assets that disappeared.
- Add contract-address identity mapping and chain-aware liquidity/flow data for symbols that collide across chains.
- Move monthly NDJSON into an analytical database when volume outgrows local storage.
- Add automatic token-unlock and chain-incident calendars only when a reliable timestamped source and revision history are available.

## Follow-up: risk evidence and daily investment research

Corrected risk guards now exclude missing/future results, compare calibration on the same eligible probability subset, and enforce drawdown, trailing loss, concurrent count and aggregate planned-risk caps without waiting for a minimum sample. Outcome evidence is isolated to corrected accounting-version records. Confidence intervals are descriptive UTC-day-cluster diagnostics, with explicit minimum samples/day coverage; they are not a certificate of independent or stationary returns. Segment outputs carry the same caveat.

A separate `/crypto invest` command uses verified public daily-candle schemas and BTC-aligned comparisons for longer-hold research. It reports observed trend, relative strength, volatility, drawdown and liquidity. Its forward-history table is a fixed trend/relative-strength rule with separate 5/20/60-day windows, next-open entry and stated costs. The table does not validate the richer current ranking score and has no untouched strategy-selection holdout. No daily rank is represented as a probability or buy recommendation.

The capped live public-data smoke test retrieved 719 completed daily bars each for BTC and ETH with no provider errors at the recorded time. The 20/60-day history contained only 8/3 BTC windows and 6/2 ETH windows, too few to establish long-horizon expectancy. No Discord client, order route, or API credential setup was exercised. Exact evidence is in DAILY_DATA_SMOKE.md. Point-in-time multi-year histories, longer forward paper collection, realistic venue-specific costs, token identity verification and allocation constraints remain needed before using these signals as an investing process.

## Frozen prospective daily observations

The existing once-daily opening discovery and `/crypto invest` now write a private forward journal. First observed decisions, including unavailable/null scores with a valid as-of bar, cannot be revised by later calls. Costs, model version, observation time, and venue/pair identities are frozen. The shared pure resolver grades only future aligned 5/20/60-session exposures and never executes a trade. Provider switches and missing sessions remain pending.

Forward means use a greedily selected non-overlapping window subset for each symbol/horizon, with the matching window count displayed. These are still descriptive, cross-asset-correlated hypothetical exposures across all research decisions. The current eight-asset universe plus at most two daily-rotating removed symbols is refreshed; overdue unresolved outcomes visibly flag an incomplete cohort so surviving available symbols cannot silently imply a validated edge. Actual prospective evidence starts at zero on a new deployment and requires elapsed time.

## Cross-asset regime-report follow-up — 2026-09-30

The fixed-rule 15-minute study was rerun from five checksum-pinned Binance Spot datasets (17,444 candles each, 2026-04-01 through 2026-09-29 17:00 UTC). At the 20 bp modeled round-trip cost tier, the four cross-asset recent segments were negative: ADA -0.269R (n=367; day-cluster 95% interval -0.377 to -0.169), BNB -0.178R (n=250; -0.273 to -0.086), SOL -0.233R (n=284; -0.337 to -0.131), and XRP -0.249R (n=291; -0.356 to -0.153). The BTC-developed rule remains exploratory and is not the production ensemble; no thresholds were changed and the result is not a blind validation.

The replay engine already computed cost-tier results by point-in-time BTC regime, but the cross-asset command discarded those results from its saved JSON and Markdown. The report now includes regime-level trade count, UTC signal-day coverage, win rate, expectancy, profit factor, net R, and drawdown for recent and earlier periods at every cost tier. Recent 20 bp mean R was negative for every tested asset/regime cell with trades. Neutral regimes were generally less negative, but subgroup results are descriptive, sparse in some cells, overlapping across assets, and not multiplicity-adjusted. They do not justify a regime-specific production rule.

The replay remains limited by OHLCV-based fills, assumed rather than observed costs, asset survivorship, and BTC-derived parameters previously examined on BTC. See `CROSS_ASSET_FIXED_RULE_VALIDATION_2026-09-30.md` and `.json` for the per-regime tables and machine-readable summaries. This adds measurable context but does not establish production-strategy performance or profitability.
