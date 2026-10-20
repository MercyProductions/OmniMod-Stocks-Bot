# Public Crypto forward-observation follow-up — 2026-10-01

This is an isolated, ticker-only research cohort captured at **20:24:23 UTC** by the optional public funnel probe. It never posted to Discord, reserved shared paper risk, placed an order, or entered production model training. It uses a source-timestamped ask from the same venue/pair as its follow-up 15-minute candles, plus a modeled cost reserve. Candle OHLC and modeled costs are **not executable fills**.

The capture snapshot found 351 unique public assets, 28 discovery candidates, 19 directory-qualified assets, eight deep-selected/two-venue-confirmed assets, and zero strict screen qualifiers. Eight research observations were frozen. Rejection reasons overlap across assets.

At **21:09 UTC**, three observations became due. `npm run probe:public-funnel -- --resolve` selected and fetched all three exact venue/pair histories, appended nine completed bars, and resolved all three; no provider, source-identity or history-gap failure was reported. The read-only status at 21:16 UTC showed five pending observations, none then due, with the next deadline at **22:24:23 UTC**.

| Asset | Frozen strict rejection | Venue/pair | Audit result | Evidence quality |
| --- | --- | --- | --- | --- |
| PUMP | Historical strategy validation | Binance PUMPUSDT | `deadline_last_closed_candle`; modeled R -0.048 | **Approximate.** The 21:00 UTC candle close preceded the 21:09:23 deadline by about 9.4 minutes. Excluded from model and liquidity-shadow return evidence. |
| ZRO | Historical strategy validation | Binance ZROUSDT | `deadline_last_closed_candle`; modeled R -0.430 | **Approximate**, with the same early-close limitation and exclusion. |
| GRASS | Minimum score and historical strategy validation | Coinbase GRASS-USD | `candle_stop_first`; modeled R -1.273 | Conservative source-candle stop observation; no executable stop fill or within-bar price path was observed. |

The PUMP and ZRO rows originally carried `deadline_loss` in their raw audit events. The status command now groups them as `approximate_deadline_audit` so its outcome summary does not present them as exact 45-minute losses. Both remain in the append-only journal. Production model training and liquidity-shadow comparisons accept only recognized exact source-candle barrier outcomes or a candle close aligned exactly with the deadline. Stored models without outcome-evidence policy version 1 are disabled.

**Interpretation:** One exact candle stop from one sampled session cannot establish whether a rejection gate helps or hurts expectancy. The two early-close marks cannot establish their promised time-horizon return. All eight rows came from a single public discovery snapshot, ticker-to-coin identity is not independently verified in this public mode, and the remaining five have no outcome yet. Continue source-pinned follow-up across independent days and obtain finer point-in-time venue quotes or minute data before using unaligned deadline returns as training labels. Do not change production thresholds from this cohort.

## Second same-day snapshot — 21:25 UTC

A fresh, bounded CoinGecko snapshot returned **352 unique assets → 23 preliminary candidates → 19 directory-qualified → eight deep-selected and two-venue-confirmed → zero strict qualifiers**. One deep-selected asset was not captured because its execution check blocked source-pinned entry evidence. Seven new isolated observations were frozen: AAVE, NIGHT, AVAX, TRAC, SAND, BNB, and SYRUP. The public cohort then contained 15 created rows, three audit-resolved rows, and 12 pending. The next frozen deadline was 22:10:59 UTC. No Discord alert, paper reservation, model training, or order was created.

Seven of eight deep-selected assets failed historical strategy validation. Six had measured nonpositive recent and overall modeled expectancy and profit factor at or below one; **TRAC had zero historical trades**, because its Coinbase history contained missing intervals. Its placeholder numeric zeros had previously been counted as negative measured performance. The validation diagnostic now reports those metrics as missing when a segment has no observed trades; insufficient sample and incomplete candle path still reject TRAC. Rejection categories overlap with minimum-score, trend, and execution-cost checks.

These are two observations about an hour apart on **the same UTC day**, with overlapping assets and historical windows. Treat them as correlated diagnostics, not independent strategy trials or evidence of a profitable (or unprofitable) forward edge. The seven new rows remain ticker-only, use modeled rather than observed fills, and cannot train production models.

## First second-snapshot deadline — 22:10:59 UTC

At 22:11 UTC, one frozen second-snapshot observation was due. The bounded resolver fetched its exact Coinbase `TRAC-USD` source (one selected/fetched source, no failure or cap), appended two completed bars, and wrote one audit resolution. The TRAC observation received `deadline_last_closed_candle`: the available 22:00 UTC candle close was about **11 minutes before** its 22:10:59 deadline; its nominal 45-minute horizon had only about 34 minutes of observed close-time coverage. The recorded modeled result was -0.118 R. This is an **approximate early-close audit mark**, not a measured 45-minute return, fill or model-eligible label. TRAC's earlier 599-candle historical validation path was also incomplete, a separate quality problem. The status after follow-up showed **15 created, four audit-resolved (one exact barrier, three approximate deadline marks), 11 pending, none due**, with the next deadline at 22:24:23 UTC. The added observation does not support a strategy-performance conclusion or a production threshold change.

## First-snapshot 22:24:23 UTC deadline

At 22:25 UTC, the bounded resolver selected and fetched all three due Binance source/pair histories, appended 14 completed bars, and reported no provider, pair-identity or request-cap failure. AAVE and NIGHT received `deadline_last_closed_candle` audit marks from the **22:15 UTC** completed close, about 9.4 minutes before their frozen 22:24:23 deadline: modeled **+0.337 R** and **-0.296 R**, respectively. Both are approximate time exits, excluded from model training and liquidity-shadow return comparisons. They are not observed fills or full-horizon results.

SUPER remained due and unresolved with `candle_path_or_deadline_unavailable`. The source-matched Binance `SUPERUSDT` 20:15–20:30 candle contained its **20:24** entry observation and had a low of 0.2183, below its frozen 0.219029 stop. OHLC does not say whether that low happened before or after the observation. The resolver correctly refused to assign a stop or a clean miss; later bars cannot repair the missing first-bar order. Keep the row pending unless finer, source-matched, point-in-time evidence becomes available.

The read-only status at 22:26 UTC showed **15 created, six audit-resolved (five approximate deadline marks and one exact conservative stop), nine pending including one due**. All rows were captured on one day from two correlated public snapshots with unverified ticker-to-coin identity and modeled costs. Neither the positive AAVE audit mark nor the negative marks establish gate quality, expectancy, or a reason to change production approval.

At 22:34 UTC, the revised resolver identified SUPER's stored exact-source first-bar ambiguity before any network request. It selected and fetched **zero** sources, reported `entry_containing_candle_ambiguous: 1`, and left the row unresolved. The request-free status reported **one due row needing finer data, zero due rows retryable with current 15-minute bars**, and the next future deadline at **23:25:59 UTC**. This prevents a futile repeated 15-minute request; it does not resolve SUPER or turn its unknown outcome into a win or loss.

## Bounded finer-source follow-up — 23:10 UTC

The opt-in `--resolve-finer` probe requested Binance `SUPERUSDT` 1-second candles only from SUPER's observation-containing second at 20:24:23 UTC through the 20:15–20:30 candle's end. It received a complete **337-second** same-pair sequence. No frozen stop or first target was crossed in the containing second or in the subsequent observed seconds, so the 15-minute candle's earlier stop crossing could be excluded from the post-observation path. The probe cached this narrower evidence as a write-once research sidecar, then fetched one pinned Binance 15-minute history, appended three completed bars, and resolved the later source-candle stop as `candle_stop_first`, modeled **-1.333 R**. The recorded price basis is `completed_source_candles_with_second_entry_clearance`; it is intentionally ineligible for production model training.

Read-only status afterward showed **15 created, seven audit-resolved (five approximate deadline marks and two source-candle stops), eight pending, none due**. The next deadline was **23:25:59 UTC**. These are candle-path audit outcomes with a modeled fee reserve, not executed entries or stop fills. The public ticker-to-coin match is still unverified; all observations came from one UTC day and two correlated snapshots. No production strategy, model, risk threshold, Discord alert, paper reservation, or order changed.

## Two unaligned 23:25:59 UTC deadlines

At 23:26 UTC, the opt-in bounded `--resolve-finer` probe selected and fetched the exact Binance 15-minute histories for the second-snapshot AAVE and NIGHT rows, and made two 1-second requests for their final partial deadline windows. Each returned a complete, same-pair sequence of **659 seconds** from 23:15:00 through 23:25:58. The last completed second ended at 23:25:59, **543 ms before** the frozen 23:25:59.543 deadline. Neither path crossed the modeled stop or targets in that observed terminal segment, so the resolver used the last completed second rather than the 23:15 close that would have been about 11 minutes early.

| Asset | Frozen strict rejection | Audit result | Evidence quality |
| --- | --- | --- | --- |
| AAVE | Historical strategy validation | `deadline_last_completed_second`; modeled **+0.854 R** | Complete pinned second path through 543 ms before deadline; still an approximate, modeled-cost mark. |
| NIGHT | Minimum score and trend continuation | `deadline_last_completed_second`; modeled **-0.218 R** | Same 543 ms remaining gap and approximate evidence boundary. |

The run reported two histories selected/fetched, two finer deadline requests/paths, eight completed 15-minute bars appended, two newly resolved rows, and no provider failure, request cap or unresolved due row. Subsequent request-free status showed **15 created, nine audit-resolved, six pending, none due**, with five coarse early-close marks, two subsecond deadline marks and two source-candle stops. The next deadline is **2026-10-02 00:24:23 UTC**. These outcomes cannot train production models, establish executable fills, or prove that the sampled rejection gates help or hurt performance. No production strategy, model, alert, paper reservation or order changed.
