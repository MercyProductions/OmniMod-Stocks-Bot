# Six-market day-trading implementation checklist

Latest checkpoint — Operator scan-data locations, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Determine whether local primary scan records exist | verified complete locally | Neither Stocks nor Crypto default data folder contains scan journals; remote host not inspected |
| Reproduce configured-directory reporting defect | verified complete locally | Original-source regression returned no-scan-data despite populated files |
| Match expected runtime data locations | verified complete locally | Local/process/argument precedence, Windows/Linux defaults, call-time resolution |
| Keep heartbeat, scan and monitor reads aligned | verified complete locally | Integration regression reads all three from the same configured directory |
| Preserve redaction and missing-data semantics | verified complete locally | No secret/path fields, no stale alternate-folder fallback, filesystem failures remain visible |
| Full regression verification | verified complete locally | 1,834 tests, syntax checks and nine Windows launcher checks passed |
| Authenticated market scans and paper assumptions | blocked | Existing account/entitlement, equity and cost setup remains incomplete |
| Separate Stocks/Crypto production deployment verification | pending | Local scan absence does not establish remote state |
| Independent forward/OOS performance | pending | Real provider-backed, after-cost observations still required |

Handoff: `shared/OPERATOR_DATA_LOCATIONS.md`. Checkpoint: `../review-verification/operator-data-path-checkpoint-20261003.json`. Earlier checkpoints remain historical. Goal active; verified progress this turn.

Latest checkpoint — Shared portfolio controls at fill, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce missing risk recheck | verified complete locally | Four failures against preserved original sources |
| Freeze and enforce reservation limits at fill | verified complete locally | Current equity, losses, circuits, fresh marks, conflicts, counts, risk, gross notional and margin |
| Account for prospective entry costs and short-fill notional | verified complete locally | New entry cannot cross the daily loss/gross ceiling; reservation counted once |
| Apply shared checks to all six owners | verified complete locally | Six explicit asset-class regressions plus current production callers |
| Recheck production risk in isolated research | verified complete locally | Mirror/independent modes, empty shortlist and missing external ledger covered; snapshot scope explicit |
| Preserve exits and cancellation for old records | verified complete locally | Missing pending policy blocks new fills; existing open positions retain normal exits |
| Persist fill rejection evidence and expose operator counts | verified complete locally | Saved checks, reason transitions, successful evidence, overall/per-bot diagnostics |
| Full regression verification | verified complete locally | 1,827 tests, configured syntax and nine launcher checks; focused 76/57/18 subsets also pass |
| Authenticated market scans | blocked | Existing credentials, entitlements, paper equity and costs still incomplete |
| Instrument-specific mutable entry checks | pending | Options Greeks/dividend review; native margin changes and deployment assumptions |
| Six-market forward/OOS strategy evidence | pending | Real coverage/latency measurements and independent after-cost sessions required |

Handoff: `shared/FILL_PORTFOLIO_RISK.md`. Checkpoint: `../review-verification/fill-risk-checkpoint-20261003.json`. Earlier checkpoints are historical where superseded. Progress was made; the goal remains active.

Latest checkpoint — Options fill-time evidence, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce premium-only fill gap | verified complete locally | Four original-source failures preserved |
| Freeze fill policy and source invalidation | verified complete locally | Shared source contract; v3 strategies and v6 primary shadow cohort |
| Validate current underlying, exact legs and catalyst before fill | verified complete locally | Native side times, identity, session, liquidity, composite arithmetic and source levels/age |
| Reread review without a current shortlist | verified complete locally | Current manual file/session; bounded Finnhub/Alpaca checks; independent empty-shortlist regression |
| Recheck time after execution lock and preserve fill evidence | verified complete locally | Child scanner/temporary ledger tests cover expiry, stale quotes and successful evidence retention |
| Retain legacy filled-position exit management | verified complete locally | Fresh marks and exits do not require entry clearance; legacy pending policy absence blocks new fills |
| Full regression verification | verified complete locally | 1,798 tests, syntax checks and nine Windows launcher checks; 30 focused integrations |
| Investigate remaining fill-time assumptions | pending | Greeks/dividend controls and portfolio/loss changes between reservation and fill |
| Authenticated Options operation | blocked | Local Tradier credential/mode, equity and costs remain incomplete |
| Six-market real coverage and forward/OOS validation | pending | Current feeds, latency, account entitlement, independent after-cost sessions and controlled rollout |

Handoff: `options/FILL_EVIDENCE.md`. Checkpoint: `../review-verification/options-fill-evidence-checkpoint-20261003.json`. Earlier checkpoints below are historical where superseded. Progress was made; the goal remains active.

Latest checkpoint — Options original forecast and entry lifetime, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce target shifting and lost source lifetime | verified complete locally | Eight original failures in isolated preserved sources; existing filled-position behavior retained |
| Preserve immutable original forecast through quote acquisition | verified complete locally | Long/short targets, original observation time, source identity, zone and conflict checks |
| Carry optional source deadlines through shared handoff/journal | verified complete locally | Journal-to-Options regression, malformed/numeric deadlines and legacy records covered |
| Bound new pending Options reservations | verified complete locally | Exact expiry, current post-lock clock, persisted cancellation and quote-free restart |
| Continue managing positions filled before entry expiry | verified complete locally | Fresh mark and scheduled exit after the entry window |
| Version prospective strategy/replay and independent research | verified complete locally | v2 builders, v5 primary shadow version; old records and idempotency preserved |
| Regression verification | verified complete locally | 202 focused and 1,777 full-suite tests; syntax and nine launcher checks passed |
| Pending-fill underlying and catalyst revalidation | pending | Premium marks alone do not establish continuing underlying entry eligibility |
| Authenticated Options scans | blocked | Missing provider credentials/modes, equity and explicit costs; local manual mode remains |
| Six-market coverage, controlled rollout and forward/OOS evidence | pending | Requires real data quality/latency/coverage measurements and independent after-cost sessions |

Handoff: `options/PRIMARY_HYPOTHESIS.md`. Checkpoint: `../review-verification/options-hypothesis-checkpoint-20261003.json`. Earlier checkpoints below are historical where superseded. This phase made progress; the goal remains active.

Latest checkpoint — Options decision-time quotes, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce chain-delay and locked-ledger aging defects | verified complete | Two original actual-runner failures retained |
| Prioritize existing-position monitoring | verified complete locally | Fifteen-second delayed native-mark runner test |
| Refresh selected contracts without repeating expensive discovery/history | verified complete locally | Native quote batching, original identities, shared quota/window bounds |
| Preserve strategy and risk checks after refresh | verified complete locally | Current portfolio, post-lock clock, immutable input target/zone, liquidity, catalyst and expiry checks |
| Share fresh observations across separate shadow profiles | verified complete locally | One attempt per input; new prospective primary shadow version |
| Diagnose refresh work and reservation rejections | verified complete locally | Saved operator propagation, source ages, actual HTTP versus local deferrals |
| Full regression verification | verified complete | 1,761 tests, configured syntax checks and nine launcher checks; 19 new behavioral cases |
| Authenticated Options scanning | blocked | Local manual mode; missing token, paper equity/costs and Tradier production source setup |
| Initial primary-hypothesis level/expiry preservation | pending | Initial adapter rebasing and pending-order hypothesis lifetime need a separate audit |
| Controlled rollout and six-market forward/OOS evidence | pending | Real provider coverage, freshness, fills and multi-session after-cost performance |

Handoff: `options/DECISION_QUOTE_REFRESH.md`. Earlier checkpoints are historical where superseded. Implementation progress was made; the goal remains active.

Latest checkpoint — Futures decision timing and Options research clock, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce old comparison times and missing entry cutoff | verified complete | Two original Futures failures retained |
| Monitor existing positions before entry collection | verified complete locally | Actual child runner with delayed synthetic Live protocol |
| Current strategy/risk/reservation clocks | verified complete locally | Delayed ledger and source-age mismatch regression; post-lock clock enforced |
| Persist the existing session entry cutoff | verified complete locally | Late pending fill cancels in actual temporary ledger |
| Report decision ages and reservation failures | verified complete locally | Operator propagation, reason deduplication and final mark freshness tests |
| Repair Options independent-research observation time | verified complete locally | Deterministic one-millisecond offset; invalid clocks and future quotes remain blocked |
| Separate prospective execution cohorts | verified complete locally | Futures shadow version change; Options experiment definition clock version |
| Six-market regression verification | verified complete | 1,742 tests passed; configured syntax checks; nine Windows launcher checks |
| Authenticated data and complete paper settings | blocked | Local Forex disabled; Futures/Options/ETF manual sources; missing provider/equity/cost settings |
| Databento persistent connection and shared connection control | pending | Not added; measure actual contention before implementation |
| Controlled rollout and six-market forward/OOS performance | pending | Real provider freshness/coverage, costed paper lifecycle and independent-session evidence |

Handoff: `futures/DECISION_TIMING.md`. Earlier checkpoints are historical where superseded. Progress made; the six-market goal remains active and profitability unverified.

Latest checkpoint — Forex decision-time quotes, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce slow-history quote aging and inherited cooldown wait | verified complete | Two original failures preserved; child runner and deterministic clock |
| Refresh primary/conversion prices after histories | verified complete locally | Quote-only paired request, recent reuse, provider timestamp/identity checks, no stale fallback |
| Bound waits and distinguish actual requests from local deferrals | verified complete locally | Cooldown extension/overshoot checks; single-attempt decision pricing; honest HTTP/latency counts |
| Enforce current-clock entry and conversion expiry | verified complete locally | Reservation-time validation; original session cutoff; stale conversions and histories remain blocked |
| Keep shadow research fresh and separately versioned | verified complete locally | Shared per-observation refresh; async risk/journal clock update; old ledgers retained |
| Expose Forex refresh diagnostics in operator report | verified complete locally | Saved-scan propagation regression passes; unknown runtime observations remain unknown |
| Six-market regression verification | verified complete | Focused Forex/shadow 111 passed; final full run 1,735 passed; configured syntax checks and nine Windows launcher checks |
| Authenticated Forex and Futures scanning | blocked | Local feed/credential/equity/cost configuration remains incomplete |
| Continuous six-market forward/OOS evidence and rollout | pending | Actual provider coverage, freshness, paper fills, costs and independent-session evidence |

Handoff: `forex/DECISION_QUOTE_REFRESH.md`. Prior entries are historical where superseded. This is implementation progress; the goal remains active and profitability is unverified.


Latest checkpoint — shared Tradier market-data budget, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce lost cross-process cooldowns and missing request accounting | verified complete | Four original failing regressions preserved |
| Reuse durable budget infrastructure without changing Alpaca state | verified complete locally | Extracted shared engine; existing Alpaca concurrency/header/state tests still pass |
| Token/environment Tradier market-data budgets | verified complete locally | Native millisecond expiry, conservative quota observation, bounded waits, 108/54 defaults with 120/60 runtime ceilings |
| Coordinate retry, input, chain, clock and position-monitor paths | verified complete locally | Shared read-only request transport; fresh-process cooldown and real three-process grant tests; direct legacy routes covered |
| Preserve truthful attempt and deferral counts | verified complete locally | Gate rejections make zero HTTP requests; nested calls and interrupted retry sleeps do not double-count |
| Expose budget state to the operator | verified complete locally | Separate Tradier report, no credentials or directory paths exposed |
| Regression verification | verified complete | 1,720 tests; configured syntax checks; nine Windows launcher checks |
| Authenticated Tradier operation | blocked | Local Options scan is still manual; token, paper equity, costs and source/mode remain incomplete |
| Reserved monitoring capacity and other provider budgets | pending | Measure real contention; other services require their own quota models |
| Continuous six-market forward/OOS validation and rollout | pending | Real provider coverage, freshness, quotas, risk-approved paper lifecycle and after-cost multi-session evidence |

Handoff: `shared/TRADIER_SHARED_BUDGET.md`; checkpoint: `../review-verification/tradier-shared-budget-checkpoint-20261003.json`. Progress made in this phase; the goal remains active. Prior tables are historical and superseded where applicable. Tests use synthetic market responses and do not prove profitability or account entitlement.

Latest checkpoint — ETF/ETP decision-time quotes, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce acquisition aging, missing entry expiry and post-lock age gap | verified complete | Three original failures preserved |
| Preserve reviewed ETP classification through acquisition | verified complete locally | Additional source-URL failure reproduced and fixed; incomplete/stale classification still blocks |
| Refresh selected ETF inputs without repeating history | verified complete locally | Quote-only batching, shared Alpaca gate, cumulative work budget, current row/entry decisions, no stale fallback |
| Preserve strategy, native data evidence and shared risk controls | verified complete locally | Full re-evaluation after refresh; free IEX stays reference-only; costs, loss and emergency stop checks remain |
| Check approval age after ledger lock and persist existing entry cutoff | verified complete locally | Contended-lock tests; invalid clocks blocked; later fills and exits require native quotes; expired reservations cancel |
| Expose collection/decision ages and reservation rejections | verified complete locally | Per-symbol reasons, timings and request counts; operator propagation assertions |
| Distinguish prospective forward experiments | verified complete locally | ETF shadow v6 full-market / v4 baseline; old histories retained |
| Regression verification | verified complete | 1,701 tests; configured syntax; nine Windows launcher checks; synthetic market responses |
| Authenticated ETF setup / real market measurement | blocked | Actual local scan remains an empty fixture; Alpaca credentials, equity/costs and source/feed settings incomplete |
| Other provider shared budgets | pending | Alpaca coordinator does not cover every source or external application |
| Continuous six-market evidence and controlled rollout | pending | Provider-backed coverage, entitlements, real funnel counts and after-cost multi-session forward/OOS evidence |

Handoff: `etfs-etps/DECISION_QUOTE_REFRESH.md`; checkpoint: `../review-verification/etf-decision-quotes-checkpoint-20261003.json`. The current phase made progress; the goal remains active. Earlier tables are historical and superseded where applicable. No profit claim or authenticated coverage claim is made.

Latest checkpoint — shared Alpaca REST request budget, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce uncoordinated defaults and skipped retry acquisition | verified complete | Two baseline regressions; hashed originals retained |
| Shared filesystem pacing, rolling budget and cooldown | verified complete locally | Cross-process grants, optional multi-key group, conservative headers, bounded waits; corrupt/abandoned state fails closed |
| Integrate all inspected Alpaca REST routes | verified complete locally | Stocks directory/history/backfill/events/news, ETF data/quotes, Options discovery/history/dividends/news; each retry obtains a new grant |
| Honest quota/request diagnostics | verified complete locally | Local deferrals separated from HTTP attempts/failures; operator report shows grants, cooldowns, locks and unknown quota |
| Timing and news-collector regressions | verified complete locally | Options current observation clock preserves unchanged freshness checks; Stocks news works with object-shaped metrics |
| Regression verification | verified complete | 1,674 tests; syntax checks; nine Windows launcher checks; synthetic responses and real local child-process concurrency |
| Authenticated Alpaca operation and complete local paper setup | blocked | Local readiness still lacks credentials, equity/cost settings; zero observed actual budget buckets |
| ETF decision-time quote ages and other provider budgets | pending | Measure age through analysis; coordinate non-Alpaca limits separately |
| Continuous market coverage / performance validation | pending | Entitlements, controlled activation, real scan counts and multi-session after-cost/forward/out-of-sample evidence |

Handoff: `shared/ALPACA_SHARED_BUDGET.md`; checkpoint: `../review-verification/alpaca-shared-budget-checkpoint-20261003.json`. Prior turn and this phase made progress; the goal remains active. All earlier tables are historical and superseded where applicable. No authenticated provider coverage or profitable strategy is claimed.

Latest checkpoint — ETF/ETP native quote evidence, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce missing ETF/ETP native evidence and size guards | verified complete | Four failures against preserved originals; acquisition discarded proof and shared executor checked Stocks only |
| Detailed scan / strategy / shared risk / reservation | verified complete locally | Native SIP proof retained and checked; exact symbol/time/feed; IEX remains reference-only |
| Later fills, marks, exits and independent monitoring | verified complete locally | Displayed side limits for ETF/ETP longs and shorts; legacy history preserved; prospective versions updated |
| Scan and operator diagnostics | verified complete locally | Native-verified/reference/executable counts, per-symbol reasons, unknown stays unknown |
| Regression verification | verified complete | 236 focused; 1,648 full six-market tests; syntax and nine launcher checks |
| Actual provider-backed ETF operation | blocked | Local source is empty fixture, Alpaca credentials absent; latest saved scan has zero inputs and unknown provider coverage |
| Cross-process provider budgets / ETF quote-aging measurement | pending | Coordinate account quotas and measure downstream age before adding refresh work |
| Continuous research and performance validation | pending | Access/entitlements, controlled activation, multi-session after-cost and untouched/out-of-sample evidence |

Handoff: `etfs-etps/NATIVE_QUOTE_EVIDENCE.md`; checkpoint: `../review-verification/etf-quote-evidence-checkpoint-20261003.json`. The prior turn made progress; the goal remains active. Local fixture scans and synthetic tests are not provider-backed market observations. Earlier tables are historical and superseded where applicable.

Latest checkpoint — Stocks decision-time quote refresh, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Identify quote aging and portfolio clock mismatch | verified complete locally | Regression cases reproduce stale early quotes and fresh later quotes rejected against scan-start time; historical impact is unmeasured |
| Bounded qualification and pre-reservation refresh | verified complete locally | Native Alpaca batches of 100; eight-second pass budget; fresh reuse; current clocks; no stale fallback |
| Preserve research data and approval rules | verified complete locally | Original research prices/times/deadlines retained; chart freshness and full portfolio controls rechecked |
| Structured acquisition and decision diagnostics | verified complete locally | Per-symbol ages/reasons, stage timing, provider telemetry, administrator and operator summaries |
| Regression verification | verified complete | 1,632 six-market tests (940 shared/new-market, 300 Stocks, 392 Crypto); syntax and nine launcher checks |
| Authenticated Stocks observation and historical attribution | blocked | Resolved credentials missing; zero local scan diagnostic files; no native request or real scanner run |
| ETF/ETP quote evidence / account-wide budgets | pending | Review native source/size semantics and coordinate quotas across processes |
| Continuous forward operation and performance evidence | pending | Provider access, entitlement checks, activation and multi-session after-cost/out-of-sample validation |

Handoff: `../stocks-bot/DECISION_QUOTE_REFRESH.md`; checkpoint: `../review-verification/stock-quote-refresh-checkpoint-20261003.json`. Goal remains active. Local synthetic lifecycle verification is not provider-backed performance evidence. Earlier tables are historical and superseded where applicable.

Latest checkpoint — Stocks native quote evidence, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce missing stock quote evidence / size guards | verified complete | Three baseline failures; 17 hashed source originals |
| Native source, feed, timestamp and displayed-size contract | verified complete locally | SIP shares; conservative IEX size; explicit condition and evidence rejection |
| Scanner / independent monitor / shared executor integration | verified complete locally | Evidence retained through risk, reservation, later fill/mark/exit; feed pinned; prior histories preserved |
| Structured scanner and operator diagnostics | verified complete locally | Counts and per-symbol reasons; missing fields remain unknown |
| Regression verification | verified complete | 1,610 six-market tests; syntax and nine launcher checks |
| Authenticated Alpaca native observations | blocked | Resolved local credentials missing; no provider request; actual feed IEX, stop true, cadence 0 |
| Post-analysis Stocks quote refresh / ETF evidence review | pending | Bounded acquisition and age measurement; apply source checks without changing strategy thresholds |
| Account-wide budgets / continuous forward operation | pending | Cross-process quotas, access/entitlement validation, activation and multi-session after-cost outcomes |

Handoff: `../stocks-bot/STOCK_QUOTE_EXECUTION_EVIDENCE.md`; checkpoint: `../review-verification/stock-quote-evidence-checkpoint-20261003.json`. Goal remains active. No actual configuration, deployment, service, paid entitlement or live order changed. Earlier tables are historical and superseded where applicable.

Latest checkpoint — Kraken shared execution evidence, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce missing Kraken book guards | verified complete | Four baseline failures; 14 hashed source originals |
| Shared evidence and locked liquidity checks | verified complete locally | Candidate, risk, reservation, fill, later mark and exit; long/short sides; history retained |
| Full-scanner native Kraken refresh | verified complete locally | One bounded session after metadata; exact routes; no cached fallback after failure |
| Independent monitor compatibility and cohorts | verified complete locally | Shared evidence carried end to end; versioned prospective execution/monitor/strategy profiles |
| Regression verification | verified complete | 75 focused; 1,595 six-market tests; syntax and nine launcher checks |
| Public native evidence | verified complete for tested snapshots | BTC/USD and ETH/USD; 478 ms; both fresh, acknowledged and schema-valid |
| Stock quote provenance / displayed size | pending | Shared equity executor still needs equivalent native evidence review |
| Provider quotas and continuous forward operation | pending | Account-wide budgets, permitted identity/access checks, activation and multi-session outcomes |

Handoff: `../crypto-bot/KRAKEN_ORDER_BOOK_EVIDENCE.md`; checkpoint: `../review-verification/kraken-book-evidence-checkpoint-20261003.json`. No actual configuration, service, deployment, paid entitlement or live order changed. Earlier phases remain historical.

Latest checkpoint — Independent Crypto position monitor, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Crypto owned production/older shadow inventory | verified complete locally | Exact book/order routing; no discovery or new reservations |
| Exact identity refresh and persistent cache | verified complete with mocked providers | No ticker fallback or evidence retimestamping; actual CoinGecko refresh unverified |
| Coinbase/Kraken native quote worker | verified complete locally | Fresh metadata/quotes, partial failures, current displayed sizes; broader Kraken executor depth pending |
| Public Kraken feed snapshot | verified complete for two tested symbols | BTC/USD and ETH/USD, one session, two fresh timestamped quotes; not full-market/account verification |
| Independent supervisor and research profiles | verified complete locally | Disabled by default; real isolated child; six-owner operator reports; frozen prospective cadence |
| Automated verification | verified complete | 77 focused; 1,582 six-market tests; syntax and nine Windows launcher checks |
| Actual local one-shot monitor | verified complete for idle state only | Zero active positions/requests; public mode, interval 0, stop on |
| Continuous provider-backed monitoring | pending | Safe identity access, authenticated feeds, rate budgets and activation still needed |
| Realistic six-market forward evidence | pending | No performance conclusion; multi-session after-cost outcomes required |

Handoff: `../crypto-bot/INDEPENDENT_POSITION_MONITORING.md`; checkpoint: `../review-verification/crypto-position-monitor-checkpoint-20261003.json`. No actual environment, service, deployment, paid access or live-order change. Earlier phase tables are historical and are superseded by this checkpoint where applicable.

Latest checkpoint — Independent Stocks position monitor, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Stocks owned-position inventory and quote worker | verified complete locally | Production and older shadow books; no watchlist limit, history or new reservations |
| Alpaca batch quotes and session checks | verified complete with native-shaped fixtures | IEX scope disclosed; optional SIP; stale/delayed data rejected; account access unverified |
| Independent scheduling/shutdown | verified complete locally | Opt-in 60–900 seconds; supervised child; pinned configuration; default 0 |
| Operator visibility and frozen forward profiles | verified complete locally | Separate report/heartbeat; cadence/feed distinguish cohorts |
| Automated verification | verified complete | 95 focused; 1,561 six-market; syntax and nine Windows launcher checks |
| Actual one-shot monitor | verified complete for idle state only | Zero active orders/requests; stop on; no ledger mutation |
| Authenticated Stocks quotes | blocked | No Alpaca credentials in effective local or configured saved settings |
| Crypto independent monitoring | pending | Current venue identity and timestamped native quotes need a discovery-independent path |
| Continuous paper operation and validation | pending | Provider access, cadence activation, hosted operation and multi-session evidence |

Handoff: `../stocks-bot/INDEPENDENT_POSITION_MONITORING.md`; checkpoint: `../review-verification/stocks-position-monitor-checkpoint-20261003.json`. No model/risk thresholds, actual configuration, services or hosted files changed. Earlier tables describe their own phases.

Latest checkpoint — Native Crypto product rules and fractional sizing, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Authoritative Coinbase/Kraken product rules | verified complete locally | Exact pair, base/quote, increments, minimums, status; 30-second caches; no stale fallback |
| Fractional Crypto lifecycle | verified complete locally | Candidate, sizing, reservation and later execution; decimal grid arithmetic; no increased risk budgets |
| Price grids and changed venue restrictions | verified complete locally | Planned prices quantized; invalid fills/exits blocked without inventing outcomes |
| Full six-market verification | verified complete | 1,542 tests; configured syntax; nine Windows launcher checks; 109 shared and 36 provider focused tests |
| Public native metadata snapshot | verified complete for tested products | Three HTTP 200 GETs; four BTC/ETH product records; no account permission or coverage claim |
| Native non-USD conversion | pending | USDT remains excluded from shared USD accounting; both venues and costs must be modeled |
| Independent primary position monitors | pending | Current refresh still depends on full scan and available verified routes |
| Continuous operation and forward validation | pending | Provider accounts/entitlements, hosted activation and multi-session evidence remain |

Handoff: `../crypto-bot/NATIVE_PRODUCT_SIZING.md`. Model/risk limits remain intact; no actual service or configuration changed.

Latest checkpoint — Coinbase paper order-book evidence, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Coinbase book acquisition and post-analysis refresh | verified complete locally | Exact verified USD routes; L1 only; at most three concurrent jobs; 150ms REST gate; end-of-collection freshness |
| Shared evidence and displayed-quantity checks | verified complete locally | Four demonstrated baseline failures fixed; reservation/fill/exit evidence persisted; 101 focused tests |
| Six-market regression and syntax verification | verified complete | 1,526 tests passed; configured syntax; nine Windows launcher checks; 28 focused provider/routing/retry tests |
| Public book endpoint measurement | verified complete for one snapshot | Two public GETs; both HTTP 200; book age 2,846ms; no new identity verification or account/paper execution claim |
| Quote currency conversion | pending | Native USDT remains excluded from USD accounting; cross-venue funding and conversion cannot be assumed |
| Product metadata and fractional Crypto sizing | pending | Primary lotSize remains 1; measured Coinbase BTC-USD base increment is 0.00000001; authoritative integration needed |
| Independent primary position monitoring | pending | Refresh still occurs after full scan and depends on its available identities |
| Provider-backed continuous operation and performance | pending | Missing credentials/entitlements, hosted activation and multi-session evidence remain |

Handoff: `../crypto-bot/PAPER_ORDER_BOOK_EVIDENCE.md`. No strategy thresholds, stop flags, real configuration or deployments changed.

Latest checkpoint — Crypto shared execution identity, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce ticker/source and native-currency defects | verified complete locally | Four failing baseline regressions; source originals retained |
| Complete identity through quote, candidate and order | verified complete locally | Durable asset ID, verified exact venue/pair, currency and evidence time; duplicate/conflicting-source quarantine |
| Production and forward-shadow quote routing | verified complete locally | Matching-source fill/exit, alternate-source refusal, no ticker fallback; legacy identities remain unresolved |
| Cross-market exposure and operator diagnostics | verified complete locally | Known BTC/ETH/SOL/XRP overlap preserved, unrelated IDs separated; readiness/rejection counts exposed |
| Regression | verified complete locally | Full 1,510 tests plus syntax/nine launcher checks; subsequent 143 focused covers final exposure aliases; 50 mocked-provider tests |
| Native non-USD accounting/conversion | pending | Pairs remain discoverable research; shared USD entries need executable conversion evidence and costs |
| Independent Crypto/Stocks quote monitoring | pending | Current primary scan dependency remains; recorded Crypto source can now support safe routing |
| Authenticated operation and hosting | pending | No actual configuration, deployment, provider request or live order in this phase |

Handoff: `../crypto-bot/SHARED_EXECUTION_IDENTITY.md`. Execution cohort version advances; no historical results are promoted. The full goal remains active.

Latest checkpoint — Owner recovery and decision clocks, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Establish cross-bot recovery and quote-clock defects | verified complete locally | Six baseline regressions failed; source originals and log retained |
| Owner-scoped scanner recovery | verified complete locally | All six callers; explicit portfolio recovery retained; real Stocks/Crypto entry-point tests preserve unrelated orders |
| Atomic quote identity guard | verified complete locally | Ambiguous IDs and wrong owners cannot cancel/fill/mark/close through shared quote executor |
| Current primary decision and session time | verified complete locally | Stocks/Crypto marks and approvals; shadow observation clock; stale/deadline limits retained |
| Regression and execution cohort version | verified complete locally | 116 focused and 1,501 full-suite tests; configured syntax and nine Windows launcher checks |
| Independent primary-bot quote monitoring and durable Crypto bridge identity | pending | Full-scan dependency and ticker-keyed shared bridge remain; exact-pair research path is separate |
| Authenticated feeds, hosted activation and multi-session results | pending | No configuration/deployment/data purchase/live order changes; absent credentials remain a dependency |

Handoff: `shared/OWNER_RECOVERY_AND_DECISION_TIME.md`. No strategy/risk threshold was lowered. The six-market goal remains active.

Latest checkpoint — Independent position monitoring, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Quotes-only owned-position worker | verified complete locally | Existing production and old/independent shadow books; no discovery, history, new reservations or posts |
| Independent scheduler and shutdown | verified complete locally | Real idle monitor child completes while mock application's scan child stays busy; both shut down |
| ETF and Futures adapter integration | verified complete locally | ISO ETF times/collection freshness; Futures pending entries require persisted reviewed session |
| Identity, stop and unavailable-price handling | verified complete locally | Cross-book routing, ambiguous-ID guard, missing/stale/duplicate quotes, owned-only cancellation and exits |
| Research cohort and operator visibility | verified complete locally | Cadence/revision in frozen fingerprints; separate latest report and scheduler heartbeat |
| Regression | verified complete locally | Full suite 1,493 tests, 296 shared syntax files, configured legacy syntax and nine launcher checks; final focused 101 after identity guard |
| Real local worker invocation | verified complete for idle state only | Four one-shot commands: zero active orders and requests; no paper ledger created |
| Scheduled provider-backed operation | pending | Default remains off; feed credentials/entitlements and real current positions/quotes unverified |
| Hosted deployment and multi-session performance | pending | No upload/restart, live order, data purchase or profitability claim |

Handoff: `shared/POSITION_MONITORING.md`. The six-market goal remains active. Current free/account-included and optional paid provider setup is still required.

Latest checkpoint — Shared paper quote integrity, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce quote and fill-policy defects | verified complete locally | Three regressions: null option close, wider-spread fill, stale fill |
| Strict numeric data and persistent entry limits | verified complete locally | Invalid values cannot mutate results; current/approved limits use the stricter value |
| Legacy records and emergency handling | verified complete locally | Unknown old entry limits block fills; cancellations and valid open-position exits retained |
| Separate execution research cohort | verified complete locally | Execution version included in frozen manifest and experiment fingerprint |
| Six-market regression | verified complete locally | 1,476 tests, configured syntax checks and nine launcher checks |
| Authenticated market operation | pending | Four local applications still report unconfigured feeds and zero requests; missing accounts/entitlements |
| Realistic multi-session performance and hosting | pending | No new actual paper fills, deployment or profitability evidence |

Handoff: `shared/PAPER_QUOTE_INTEGRITY.md`. Goal remains active; this phase strengthens execution integrity without loosening discovery, strategy or risk gates.

Latest checkpoint — Public ETF directory and TXSE coverage, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Credential-free directory preflight | verified complete | Two official public GETs, full hashed source/row artifacts; no account or price claims |
| Full row accounting and integrity | verified complete locally | Exclusion reconciliation; malformed/truncated/duplicate/cross-file safeguards; local source time retained |
| Measured public listing coverage | verified complete for this capture | 13,295 security rows → 5,758 non-test ETF-flagged listings |
| Recover legitimate listings omitted by old table | verified complete for directory coverage | Same-source baseline comparison adds five TXSE ETFs, removes none |
| Existing strategy/account controls | verified complete locally | Account identity/status, catalyst and other gates retained; new discovery/shadow version |
| Regression and evidence handoff | verified complete locally | 35 focused and 1,466 full-suite tests; syntax and nine launcher checks |
| Actual broker/feed/price coverage | pending | Alpaca credential/entitlement validation still absent; no quote scan in public probe |
| Hosted activation and multi-session results | pending | No deployment; six-market goal remains active |

Details: `etfs-etps/PUBLIC_DIRECTORY_AUDIT.md`. ETF flags are discovery evidence, not product-risk review or trading approval.

Latest checkpoint — Crypto exact verified-pair routing, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce alternate-pair loss | verified complete locally | New regression failed on baseline: verified Coinbase USDT queried as unlisted USD |
| Cheap coverage and bounded exact routing | verified complete locally | Active USDT products retained; only verified routes queried; conflicts rejected |
| Quote/history/outcome source continuity | verified complete locally | Exact native pairs, asset/pair cache separation, strict enrichment and monitor regression |
| Existing safety gates | verified complete locally | Stale and receipt-time quotes, single-provider data and mismatched sources stay rejected |
| Separate research revisions | verified complete locally | Stored routing version; legacy/current costed outcome groups remain separate and training-ineligible |
| Forex telemetry regression correction | verified complete locally | No cooldown claimed when gate did not sleep; eight focused tests passed |
| Full regression and handoff | verified complete locally | 1,455 tests, configured syntax checks and nine launcher checks |
| Current real-symbol impact | pending | Public probe rejected by automatic review; QNT/JST causes and live coverage remain unverified |
| Deployment and forward/OOS performance | pending | No upload/restart/configuration change; broader six-market goal remains active |

Details: `../crypto-bot/EXACT_PAIR_ROUTING.md`. This fixes data routing; it does not lower strategy or risk thresholds.

Latest checkpoint — Futures activity-to-analysis routing, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Preserve default behavior and baseline | verified complete locally | Seven files and 14 focused baseline tests; default delivery order retained |
| Dynamic shortlist into bounded deep analysis | verified complete locally | Exact current definitions, reviewed metadata and no copied manual prices |
| Contract/data/strategy/risk protections | verified complete locally | Stale/duplicate/missing/ambiguous metadata, session, settlement, costs, H1/live failure and stop cases |
| Provenance and duplicate reservation protection | verified complete locally | Isolated runner reservation retains discovery hashes; repeat creates no duplicate |
| Diagnostics and separate forward cohort | verified complete locally | Structured routing/downstream reasons, admin counts, separate experiment version |
| Regression and developer handoff | verified complete locally | 39 focused tests; latest total 1,440 tests, syntax and nine launcher checks |
| Provider-backed Futures coverage | pending | 09:29 UTC preflight: no credential, zero requests, unknown universe |
| Broader reviewed contract metadata | pending | Newly discovered roots require verified terms/session/catalyst/accounting; review pool is not automatic clearance |
| Forward/OOS comparison and hosted activation | pending | No profitability evidence; opt-in remains disabled in actual configuration |

Details: `futures/ACTIVITY_ANALYSIS_ROUTING.md`. Same six-market goal; live orders remain disabled.

Latest checkpoint — Crypto free-provider follow-through, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Current free-provider discovery/deep measurement | verified complete for this run | 3,720 checked → 30 initial pairs → 28 mapped assets → 8 shortlisted → 2 detail attempts → 0 observations |
| Explain missing detail/outcomes using measured gates | verified complete for this run | Current QNT identity unavailable; JST one provider/404; thresholds retained |
| Resolve original prospective observation | verified complete for this observation | SKY stop-first outcome; one request; 17 matching candles reproduce stored resolution |
| Preserve original forward evaluation evidence | verified complete locally | Three copied event/candle files with hashes and replay evidence |
| Local no-network status and separate outcome accounting | verified complete locally | Missing cost/source/timing checks, approximate audits separated, zero guarded network attempts |
| Research command presentation and JSON | verified complete locally | Embed size limiter and full cohort attachment; hosted delivery pending |
| Six-market regression | verified complete locally | 1,427 tests, configured syntax and nine launcher checks |
| Profitable or reliable strategy performance | pending | One modeled loss/date; no measured execution or sufficient independent sample |
| Broader venues, account-backed scanners and hosting | in progress | Credentials/entitlements and remaining integration/forward evidence still needed |

Details: `../crypto-bot/VENUE_FORWARD_EVIDENCE.md`. This phase leaves trading controls intact and live orders disabled.

Latest checkpoint — Futures live-gateway integrity, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce mapped-record failure and preserve baseline | verified complete locally | Two fresh mapped records timed out; seven files and 15 baseline tests retained |
| Shared nested-header and interval symbol resolution | verified complete locally | Exact nanoseconds, schema IDs, symbol/publisher conflicts and unmapped counters |
| Quote quality, ordering and completion-time validation | verified complete locally | Freshness/depth/tick/flags checks; second-symbol delay and expiry/session-close fixtures |
| Replay/duplicate/error integrity and honest failure coverage | verified complete locally | Partial replay and conflicting bars reject; failed live input clears old quotes/bars |
| Entry and position-monitor integration | verified complete locally | Mock runner strategy still blocked by emergency stop; isolated position marks exercised |
| Final six-market regression | verified complete locally | 34 focused; 1,417 total tests; 285 shared JS syntax files; nine launcher checks |
| Real gateway entitlement, transport and market coverage | pending | Latest probe: no Databento key; no authenticated stream measured |
| Broad shortlist to reviewed detailed analysis | pending | Discovery references still do not automatically become approved contracts |
| Multi-session costed forward/OOS evidence and hosting | pending | No profitability or deployment verification |

Details: `futures/LIVE_PROTOCOL_INTEGRITY.md` and `../review-verification/futures-live-protocol-checkpoint-20261003.json`. Live orders remain disabled. Prior phase tables below are historical checkpoints; the gateway parser review is now locally verified.

Latest checkpoint — Futures H1 data integrity, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Reproduce deep-analysis source-format failure | verified complete locally | Same 52 bars: flat baseline passed; documented nested header discarded |
| Explicit H1 wire formatting and identity/data checks | verified complete locally | Nested/flat header, date identity, scale, conflicts, duplicates and sparse-data tests |
| Completed-hour caching, costs and bounded stream failures | verified complete locally | Current-time revalidation; account/query separation; failed-attempt persistence |
| Unchanged strategy and risk integration | verified complete locally | 60 mock H1 bars → 1 strategy candidate → emergency-stop block; unchanged ledger |
| Repeated-scan efficiency | verified complete locally | Second identical query: 0 HTTP and no new historical cost estimate |
| Final six-market regression | verified complete locally | 1,398 tests, configured syntax checks, nine Windows launcher checks |
| Actual H1 entitlement, availability and transport | pending | Latest 08:08 UTC probe: missing Databento key; zero requests |
| Live gateway protocol and broad-candidate deep routing | pending | Review nested headers/symbol mapping; supply verified contract metadata and quotes |
| Multi-session costed forward/OOS evidence and hosting | pending | No real profitability or deployment verification |

Latest checkpoint — Broad Futures activity research, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Inspect discovery/strategy boundary and preserve baseline | verified complete locally | Seven files and 24 baseline tests |
| Whole-directory cheap activity before candidate caps | verified complete locally | 601 observed/data-qualified; 2 selected; 599 deferred in fixture |
| Date-scoped identity, schema, freshness and sparse-data handling | verified complete locally | Publisher/raw/date agreement; completed minutes; no invented volume |
| Volume leader versus source expiry order | verified complete locally | Multi-expiry fixtures; all research rows remain trade-ineligible |
| Cost bounds, raw archives and replayed cache | verified complete locally | No paid retry for the same query; corrupt/partial responses yield no candidate set |
| Preserve existing delivery/monitoring/risk workflow | verified complete locally | Mock delivery order/outage and unchanged production-ledger verification |
| Final six-market regression | verified complete locally | 1,385 tests; configured syntax checks; nine Windows launcher checks |
| Authenticated discovery size, latency and entitlements | pending | 07:30 UTC probe: no key, zero requests, unknown coverage |
| New-root executable data and reviewed strategy integration | pending | Activity is research; no new contract auto-approved |
| Costed forward/OOS evidence and hosting | pending | No profitability/deployment claim; live trading disabled |

See `futures/ACTIVITY_DISCOVERY.md` for architecture, settings, limits and remaining work.

Latest checkpoint — Futures dataset-wide reference discovery, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Inspect curated-root limitation and preserve baseline | verified complete locally | Eight baseline files; 21 existing focused tests |
| Independent whole-dataset definition enumeration | verified complete locally | `ALL_SYMBOLS`; 6,001-root streaming fixture reaches last unconfigured root |
| Identity, revisions, lifecycle and full dispositions | verified complete locally | Publisher/day scope; deleted/conflicting/expired/non-outright rows accounted for and archived |
| Cost/resource limits, caching and durable refresh coordination | verified complete locally | No paid stream retry; incomplete streams rejected; cache scope/expiry; lock and hourly attempt journal |
| Scanner/admin integration and source-vs-strategy counts | verified complete locally | Isolated full runner preserves ledger; missing prices no longer counted as observed |
| Final regression and identity-audit review | verified complete locally | 1,362 full tests; 56 final focused; configured syntax checks and nine launcher checks |
| Actual account-backed directory size and entitlement | pending | 06:56 UTC probe: no Databento key, zero requests, unknown coverage |
| Broad live activity screen and reviewed new-root strategy inputs | pending | Historical definitions are not live quotes, front-month selection or approved contracts |
| Forward/OOS performance and hosted deployment | pending | No performance, deployment or profitability claim |

Details: `futures/DATASET_DIRECTORY.md` and the latest implementation phase. Live orders remain disabled.

Latest checkpoint — Stocks directory and discovery integrity, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Inspect existing broad scanner and preserve baseline | verified complete locally | Existing broad snapshot path retained; six source files and 19 baseline tests saved |
| Full directory dispositions and supported listing venues | verified complete locally | All-status records, IDs, duplicate symbols, tradability, ETF/ETP ownership and explicit exclusions |
| Bounded full eligible-universe snapshots before deep cap | verified complete locally | 1,201-member fixture reaches final symbol; time/quota/auth deferrals measured; no relaxed rank/risk thresholds |
| Prevent screener bypass and inaccurate cache/coverage claims | verified complete locally | Directory intersection, no failed-result cache, null unknown counts, observation-clock correction |
| Durable scan inputs, rejection evidence and cohort tags | verified complete locally | Full gzip archives; compact journals; dynamic version stored with research/predictions; 14-day archive retention disclosed |
| Read-only provider diagnostic | verified complete locally | `npm run probe:discovery`; actual invocation makes zero requests when credentials are absent |
| Regression validation | verified complete locally | 1,346 full tests; 30 final focused tests; configured syntax checks and nine launcher checks |
| Actual account market coverage and entitlements | pending | 49 configured priorities are not a market universe; actual Alpaca scope remains unknown |
| Forward/OOS comparison of changed candidate population | pending | Venue/identity changes are not validated strategy improvements; no promotion/profit claim |
| Complete security subtypes, shared provider quotas and hosting | in progress | Remaining six-market objective active; no deployment or live orders |

Details: latest phase and `../review-verification/stocks-discovery-integrity-checkpoint-20261003.json`. Earlier Stocks notes are superseded by this inspection: broad cheap scanning existed and was hardened, not newly invented.

Latest checkpoint — Options independent costed forward-paper research, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Retain production baseline and strategy gates | verified complete locally | Source snapshot, 52 baseline tests; existing formulas/gates remain; timing validation corrected |
| Independent hypothesis to option-spread research | verified complete locally | Fixed underlying levels; existing contract/data/event/cost checks; no primary-signal requirement |
| Isolated manifests, ledger and persistent inputs | verified complete locally | Freeze before reservations; full underlying input copies and chain journals; separate version/hash cohorts |
| Later-quote monitoring and after-cost outcomes | verified complete locally | Synthetic reservation/fill/close lifecycle; stale marks unresolved; no duplicate reservations |
| Shared exposure/loss checks and paper stop | verified complete locally | Reads production book; independent losses summed; stop and duplicate exposure tests; no production writes |
| Real runner and administrator separation | verified complete locally | Synthetic independent reservation with zero production candidates/reservations or posts; no truncated admin funnel |
| Full regression verification | verified complete locally | 1,336 tests, 267 shared JS syntax checks, configured Stocks/Crypto checks, nine Windows launcher checks |
| Authenticated provider coverage and entitlements | pending | Actual 06:04 UTC probe: no local credentials, zero requests, unknown coverage |
| Multi-session forward/OOS performance and promotion | pending | No real forward evidence, calibrated fill claim or production promotion |
| Continuous monitoring and assignment/expiry modeling | pending | Existing limitations remain; unresolved positions are not invented closes |
| Remaining six-market discovery and deployment | in progress | Broader objective active; no upload, paid activation or live trading |

Details: latest phase and `../review-verification/options-independent-paper-checkpoint-20261003.json`. Historical checkpoints below describe their then-current scope; this phase supersedes the independent costed-research infrastructure gaps.

Latest checkpoint — Options independent intraday research, 2026-10-03:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Preserve existing production behavior/baseline | verified complete locally | Source snapshot and 28 passing baseline tests; production strategy and risk unchanged |
| Independently analyze the dynamic Options shortlist | verified complete locally | Fixed version/hash; long/short opening-range hypothesis; no primary-signal prerequisite |
| Complete bounded bars, fresh quotes, timing and provider controls | verified complete locally | Pagination, identity, missing minutes, frozen cutoff, stale/future quotes, quotas and deadlines tested |
| Separate upstream conflicts and research/production counts | verified complete locally | Share-class conflict tests, compact admin view; child runner produces one research watch and zero approved setups/reservations |
| Store point-in-time research inputs and rejection records | verified complete locally | Gzip archives retain bars/quotes/rules/context; 14-day operational retention, not a long-term outcome dataset |
| Full regression verification | verified complete locally | 1,321 tests; configured syntax checks; nine Windows launcher checks |
| Authenticated provider universe and feed coverage | pending | Actual 2026-10-03 05:21 UTC preflight: credentials missing, zero requests, coverage unknown |
| Independent option strategy through costs/catalysts/evidence/shared risk | pending | Underlying reference levels are not option-premium forecasts; research cannot reserve orders |
| Persistent costed outcome cohort and untouched/OOS/forward validation | pending | No profitability or validated strategy claim; no promotion |
| Remaining six-market discovery and hosted deployment | in progress | Broader objective active; no deployment/live-order change in this phase |

Details and next steps: latest phase below and `../review-verification/options-intraday-checkpoint-20261003.json`.

Latest checkpoint — Options contract identity and paper-result integrity, 2026-10-02:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Preserve and reproduce pre-change behavior | verified complete locally | Source snapshot, 51 baseline tests; synthetic before/after parser report |
| Shared identity checks across inventory, legacy chains and strategy | verified complete locally | OCC/provider/expiry/strike/multiplier/duplicate checks; valid control preserved |
| Protect position marks and replay fills/exits | verified complete locally | Invalid later contracts cannot create fills/profits; actual underlying remains distinct from risk alias |
| Contract diagnostics and research cohort separation | verified complete locally | Structured reasons; identity version and new forward experiment version |
| Full regression verification | verified complete locally | 1,299 tests, 259 shared JS syntax checks, Stocks/Crypto checks and 9 launcher checks |
| Authenticated account coverage and entitlements | pending | Local Alpaca/Tradier keys unavailable; fixtures are not provider-backed evidence |
| Independent intraday strategy and costed forward/OOS comparison | pending | Inventory remains research-only; no strategy promoted |
| Remaining six-market discovery and hosted deployment | pending | Broader goal remains active; no upload or live trading |

Latest checkpoint — Options independent contract inventory, 2026-10-02:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Complete returned expiration metadata; bounded independent chain retrieval | verified complete locally | Cache/rotation/round-robin tests; no production-signal dependency |
| OCC/provider identity, quote labels and membership changes | verified complete locally | All 1,200 fixture contracts retained; rejects mismatches/duplicates/unknown deliverables |
| Provider pacing, headroom and research deferrals | verified complete locally | Deadline/429/busy-token tests; existing pacer behavior preserved |
| Deliver qualified results before research; avoid duplicate messages/journals | verified complete locally | Child-runner test: one mocked Discord POST before discovery; zero independent paper reservations |
| Full six-market verification | verified complete locally | 1,282 tests, 256 shared JS syntax checks, Stocks/Crypto checks, 9 launcher checks |
| Real provider account/chain coverage | pending | Local preflight has no Alpaca/Tradier credentials; actual coverage unknown |
| Legacy chain-identity hardening | verified complete locally | Superseded by the identity phase above; independent strategy approval remains pending |
| Hosted deployment and forward/OOS performance | pending | No upload/order/real Discord post; no performance claim |

Latest checkpoint — Options independent underlying discovery, 2026-10-02:

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Independent provider directory and full eligible-universe cheap screen | verified complete locally | 1,001-member fixture reaches final member before shortlist cap |
| Identity, cache refresh, membership changes and explicit coverage gaps | verified complete locally | Duplicate/inactive/feed/missing/stale/quota/session tests |
| Runner, archives, Discord coverage and operator diagnostics integration | verified complete locally | Isolated runner with zero primary signals; no approved candidates/reservations |
| Free IEX / paid SIP research setup profiles and read-only probe | verified complete locally | Selector-preservation checks; actual preflight reports missing credentials |
| Full six-market regression verification | verified complete locally | 1,260 tests, 252 shared JS syntax checks, Stocks/Crypto checks and 9 Windows launcher checks |
| Authenticated account universe and feed coverage | pending | No Alpaca credentials in local Options environment; measured coverage unknown |
| Independent Options contract hierarchy, strategy and forward cohort | pending | Production still uses upstream/manual directional signals |
| Hosted release and six-market forward/OOS performance | pending | No upload, paper deployment or performance claim from this phase |

Current checkpoint (2026-10-02): **ETF whole eligible-directory cheap screening implemented and verified locally. Authenticated provider coverage, complete ETP identity coverage, deployment and forward validation remain unfinished.**

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Replace curated/mover-only ETF candidate discovery | verified complete locally | Default full-market path; priority list no longer defines the universe |
| Batch every eligible member before the history/news cap | verified complete locally | 1,001-symbol fixture: 11 requests, all 1,001 screened, two shortlisted |
| Record identity, quote-quality, provider and budget exclusions | verified complete locally | Compressed full-row archives, compact operator counts, 14-day retention |
| Track directory additions/removals and fix long-scan quote timing | verified complete locally | Refresh and later-quote regression tests pass |
| Follow deep-history pagination and retain discovery cohort | verified complete locally | Repeated-page rejection; ledger persistence; distinct shadow version |
| Real Alpaca account/universe validation | pending | Read-only preflight found missing credentials; requests zero, actual universe unknown |
| Non-ETF-flagged ETP metadata and remaining listing exclusions | pending | Current source is exchange ETF flags plus reviewed supplemental identities |
| Cross-process shared-provider request budgets | pending | Existing gate is process-local; broad batches pace their own requests |
| Deployment and after-cost forward comparison | pending | Baseline retained; this code is not yet uploaded; no profits claimed |

Verification: full **1,243 tests passed**, configured syntax and nine Windows launcher checks. Final reporting corrections: **67 focused tests**, plus **246 JavaScript syntax checks**, passed. See the latest phase, ETF README and `../review-verification/etf-full-directory-checkpoint-20261002.json`.

Prior checkpoint (2026-10-02): **Scanner readiness and free/paid setup infrastructure verified locally; actual account setup, full-market coverage and deployment remain unfinished.**

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Distinguish unconfigured/manual scans from zero-opportunity scans | verified complete locally | All four isolated runners, status-card and admin/operator tests pass |
| Audit and preview implemented free/paid provider profiles safely | verified complete locally | `npm run data:setup -- --audit`; credential names only; no provider calls |
| Preserve risk flags, credentials and explicit cost authorization | verified complete locally | Profile tests; no actual `.env` profile applied |
| Free/practice accounts and provider credentials | pending | User preference requested; OANDA, Tradier, Alpaca and Databento credentials currently missing |
| Real-feed coverage, entitlement and fallback verification | pending | Manual/disabled fixtures are not market coverage; permanent free live Futures adapter unavailable |
| Complete broad discovery across all six markets | in progress | Stocks/ETF cheap screening, independent Options and full Futures definitions remain incomplete |
| Deploy this scanner-readiness phase | pending | Local code verified; not uploaded to cPanel |
| Forward strategy performance and out-of-sample validation | pending | Infrastructure tests are not profitability evidence |

Verification: full suite **1,229 passed**, configured syntax and nine Windows launcher checks; final admin-readiness patch **44/44 focused tests passed**. See `DATA_PROVIDER_SETUP.md` and `IMPLEMENTATION_PHASES.md` for the exact scope and free-feed limitations.

Prior Phase 2 checkpoint (2026-10-02): **Forex full account FX discovery and independent position monitoring implemented locally. Provider verification and deployment pending; six-market goal remains in progress.**

| Item | State | Evidence / remaining work |
| --- | --- | --- |
| Remove G10-only membership and screen all account FX cheaply | verified complete locally | Full-directory, non-G10, cap, stale/spread and identity fixtures pass |
| Cache directory and record membership changes | verified complete locally | Account scoping, refresh, removal/change deltas, corruption and failed-refresh tests pass |
| Discover directory-backed USD crosses; correct gain/loss sides | verified complete locally | Direct/inverse unit tests plus four long/short target/stop lifecycles reconcile after costs |
| Monitor owned positions independently of shortlist/history | verified complete locally | Runner fixture checks off-shortlist marks through history and directory failures |
| Full six-market regression verification | verified complete | Final 1,223 tests, all configured syntax checks and nine Windows launcher checks pass; see final Forex verification log |
| Authenticate and measure actual OANDA universe | pending | Local account ID/token absent; zero provider requests, count unknown |
| Broader-discovery and conversion-model forward/holdout validation | pending | New strategy v2/shadow v3; synthetic tests provide no profitability evidence |
| Deploy this local phase | pending | No uploads, restarts, live orders or real Discord posts in this phase |

Prior Phase 2 checkpoint (2026-10-02 14:50 UTC): **Crypto whole-venue cheap screening now feeds isolated, identity-verified detailed research. Not deployed; the full six-market goal remains in progress.**

- **Verified locally:** complete native pair enumeration, membership/status deltas, structured all-pair screening, resumable identity paging, cache/429 recovery, shared public research pacing, conservative Demo request planning, strict asset-ID verification, bounded deep research, separate training eligibility, original-source forward monitoring and administrator/operator diagnostics. Fourteen-day compressed screen history is implemented.
- **Provider verified:** 3,720 directory pairs / 1,372 active spot / 97 preliminary pairs / 79 mapped asset IDs / eight shortlisted / two detailed requests / one technical analysis / one research observation. Fourteen identity pages reached a terminal page. The final paced run had no CoinGecko rate limits. Zero approved setups, fills or Discord posts. A later source refresh succeeded; the observation remains unresolved.
- **Verified tests:** final full six-market **1,208 tests** (625 shared/new-bot, 258 Stocks, 325 Crypto), configured syntax checks and nine Windows checks passed. Final focused 65 also passed. Log: `../review-verification/venue-discovery-verification-final-20261002.log`.
- **Pending:** forward/OOS evidence, execution-quote timestamp audit, production-baseline strategy comparisons, account/entitlement validation, account-wide quotas, additional venue coverage and reviewed deployment. All other market/provider and cross-host coordination work remains open.

Previous checkpoint (historical):

Current Phase 2 checkpoint (2026-10-02 14:00 UTC): **Crypto broad-directory research verified locally; full-market day-trading discovery remains in progress.** This checkpoint does not replace the deployment evidence below.

- **Verified complete locally:** `crypto-bot/src/broadDiscovery.js` enumerates the complete active CoinGecko directory, retains durable IDs/network/contracts and ticker ambiguity, refreshes daily with failure/stale handling, detects membership/metadata changes, and rotates bounded cheap ID-price batches across all directory IDs. Full dated directory/price observations are archived separately from current caches; per-row price-quality and preliminary liquidity/activity reasons are recorded. No production rank, score, model, risk, alert or paper-order approval was relaxed.
- **Verified complete locally:** Diagnostics/operator reports distinguish provider membership from production price coverage, cached/failed/unchecked batches and preliminary research candidates. Duplicate guild directories are not summed as unique assets. Missing provider quota headers remain unknown. The hard environment disable overrides guild enables. Demo planning reserves existing worst-case scheduled identity traffic and defers additional collection when there is no allowance; a true account-wide quota controller is still pending.
- **Verified provider observation:** The public directory returned **21,782 IDs**, **2,541 ambiguous ticker strings**, **four blank tickers**. A 50-ID batch returned 50 rows: **30 fresh at observation, 18 stale, two invalid/missing prices**; no trading or Discord posting occurred. The separate production baseline price snapshot contained 348 assets. A larger 250-ID query returned HTTP 403; the cause is unconfirmed. Evidence: `../review-verification/crypto-broad-directory-20261002.json`.
- **Verified checks:** `npm run verify:all` passed **625 shared/new-bots + 258 Stocks + 311 Crypto = 1,194 tests**, configured syntax checks and nine Windows launcher checks. A subsequent cache-status clarification passed the 13 focused broad-discovery tests. Log: `../review-verification/broad-discovery-verification-20261002.log`.
- **In progress:** Current public request envelope implies at least **109 hours** per price sweep at 15-minute cadence. This is inadequate for full-market intraday screening. Implement/measure a legitimate bulk venue-price route or validated higher-throughput provider plan; retain stable identity and complete coverage accounting.
- **Pending:** Broad-candidate venue/pair verification, bounded detailed forward research, replacement/validation of legacy rank-based strategy constraints, authenticated-provider observations, history retention, and compatible production deployment. Other markets' full-universe gaps (especially independent optionable-underlying discovery, futures definitions and non-G10 Forex visibility) remain open. The six-bot goal is not complete.

Current checkpoint (2026-10-02 07:51 UTC): **verified complete for embedded messages and independent Stocks/Crypto hosting**. All six distinct bot identities are connected. Stocks/Crypto run separately on cPanel; Forex/Futures/Options/ETFs run as separate Windows tasks. The active cPanel root is `/home/omniaeyu/crypto-bot`; FTP targets `/home/omniaeyu/public_html`. Always distinguish the active source from website copies.

- **Verified complete:** Shared embed transport for the four new bots, embedded admin/test replies, per-market scan coverage and separate watch/reservation fields; exact displayed handoff rows retained. Stocks watch updates now use individual symbol fields. Crypto opening embeds separate long-hold research and explain the shortlist is only a subset; an independent intraday watch publisher uses the existing validation-advisory technical cohort plus a fresh source-pinned quote, with daily delivery dedupe. No production strategy threshold or risk approval was relaxed.
- **Verified complete:** Full suite: 623 shared/new-bots + 258 Stocks + 296 Crypto = 1,177 tests, configured syntax checks and nine Windows checks. Follow-up targeted presentation and independent-host tests passed. All six identities posted one real embedded connection test; Discord acknowledged one embed and zero plain text for each. Four local gateways restarted ready with paper stops active/live disabled. Evidence: `../review-verification/day-trading-embeds-verification-20261002.log`, `day-trading-embed-runtime-20261002.json`, `day-trading-embed-delivery-20261002.json`, `discord-embedded-message-20261002.png`.
- **Verified complete on Node 20/Linux:** Actual source backed up; narrow 22-file compatible release deployed. Eight host compatibility/format tests and 19 changed-JavaScript syntax checks passed sequentially. Active-directory preflight passed process identity, duplicate lock, PID reuse, graceful stop and lock release. Stocks-only restart kept Crypto PID 191514 alive; rollback drained both workers and restored a ready legacy process; reactivation returned distinct ready Crypto PID 218805 / Stocks PID 218807 (historical observations; revalidate before acting). Evidence: `../review-verification/cpanel-*.json`.
- **Verified live:** Crypto posted three real developing watches (PUMP, AAVE, ETH) at 02:45 Chicago from 250 screened assets, with timestamped prices, ranks, pending validation and no approved-entry claim. Screenshot: `../review-verification/crypto-live-watch-embed-20261002.png`. This verifies watch delivery, not subsequent performance. Local inverse-fund direction/options-premium regression and bounded opening-card checks also passed.
- **Deployment scope:** The server release ports presentation/watch support onto the actual deployed source; it does not replace the entire server with the newer local strategy/research tree. Reproducible builder: `../tools/build_embed_host_release.py`; retained bundle/manifest: `../review-verification/embeds-host-20261002`. Existing production qualification and risk rules remain unchanged. Separate review/deployment is still needed for other local infrastructure/model changes.
- **Pending:** Four live-data provider setups, server hosting for the four local apps, cross-host portfolio coordination, and forward/out-of-sample performance evidence. Embed delivery does not establish trading readiness or profitability.

Latest Windows lifecycle phase (2026-10-02 06:17 UTC): **verified complete** for four separate limited-user Windows sign-in tasks, real task launches, per-bot graceful shutdown/restart, duplicate-launcher exclusion and a Forex-only restart preserving the other three processes. All four gateways are ready with scan exit zero, one shared ledger fingerprint, paper stops active and live trading false. `npm run verify:all` passed 1,168 JavaScript tests (620 shared/new-bots, 256 Stocks, 292 Crypto), configured syntax checks and nine Windows launcher checks including a real nonzero child exit. **Pending:** a real OS logoff/reboot recovery exercise and unattended server hosting; same-boot crashed locks deliberately need manual inspection. **In progress:** Stocks/Crypto independent-host deployment remains waiting on cPanel access/path verification. See `DISCORD_APPLICATION_MIGRATION.md` and `../review-verification/windows-discord-task-checkpoint-20261002.json`.

Latest deployment/coordination checkpoint (2026-10-02 05:56 UTC): **verified complete locally** for 18 independent-host unit checks, correction of the Forex/Futures template ledger mismatch, and fresh ready heartbeats for four distinct Windows bot processes sharing one ledger fingerprint. Full six-market verification passed 1,162 tests (614 shared/new-bots, 256 Stocks, 292 Crypto), and all eight hosting JavaScript files passed syntax checks. **In progress:** Stocks/Crypto independent Linux hosting adapter; uploaded hold staging did not reach the observed Passenger process, so the FTP entry/launcher were restored and verified. Production remains on its healthy legacy combined worker. **Pending:** cPanel directory/restart verification, actual Linux preflight, controlled split, single-bot restart/rollback validation, Windows reboot recovery, cross-host coordination and provider-backed paper evidence. No strategy/risk threshold or live-trading setting changed. See `DISCORD_APPLICATION_MIGRATION.md` and `../review-verification/discord-independent-host-checkpoint-20261002.json`.

Latest Discord architecture phase (2026-10-02): **verified complete** for six separate application identities, secure local configuration, server installation, six correct-channel test posts, and four new independent Windows gateway processes. All four operational status commands were exercised through Discord and returned ephemeral state. **Verified locally** for an independent Crypto `npm start` path (real gateway smoke, zero scans, no Stocks runtime) and 1,143 six-market tests plus syntax checks. **In progress** for deployment isolation: the website still runs Stocks/Crypto in a legacy shared process. **Pending** for durable hosting/reboot recovery of the four new apps and provider-backed market readiness/forward validation. Existing strategy/risk gates and live-trading disablement were preserved. See `DISCORD_APPLICATION_MIGRATION.md` and the secret-free `review-verification/discord-six-apps-20261002.json` evidence under the parent workspace.


Latest ETF wrapper safeguard (2026-10-02): public ETF-flagged listing names exposed unreviewed inverse 1X, ProShares Ultra/Short and ETN products outside the earlier name screen. The active-asset gate now withholds those explicit names before catalyst/news/quote requests; reviewed classifications still govern admission. **Status: focused 33/33 and full six-market verification passed (602 shared, 216 syntax, 256 Stocks, 272 Crypto); live account-backed classification audit pending.** This is reject-only and does not change strategy/risk thresholds or prove complete wrapper coverage. See `IMPLEMENTATION_PHASES.md`.

Latest ETF public listing-source audit (2026-10-02): two source-dated Nasdaq Trader directories returned 5,751 distinct ETF-flagged rows; 36 supplemental wrappers currently pass review validation, and all 79 curated seeds have listing or reviewed classification. **Status: public source observation verified; account-backed active/tradable, SIP, catalyst and strategy funnel counts pending.** The 200 deep-scan cap is unchanged. See `UNIVERSE_COVERAGE_AUDIT.md`.

Latest Crypto cohort coverage (2026-10-02): the isolated public `--status` now counts entry UTC days and rows per day. The current 15 observations, including nine audit-resolved and six pending, all originated on **one** UTC date; repeated assets/horizons are correlated. **Status: focused 8/8, real read-only status and full six-market verification passed; independent-day forward evidence pending.** No production model, alert or risk rule changed.

Latest ETF quota attribution (2026-10-02): headline Alpaca utilization now excludes Finnhub calendar headers, while the Finnhub endpoint metric remains visible separately. **Status: focused 54/54 and full six-market verification passed; authenticated headers pending.** No strategy or risk rule changed.

Latest upstream reporting and Forex rate-estimate correction (2026-10-02): the operator/dashboard now carry new-bot universe and Options pre-chain counts beside downstream gates. OANDA's scan-local request estimate ignores missing request starts and Finnhub traffic/quota headers. **Status: focused 47/47 and full six-market verification passed; read-only dashboard run passed; authenticated scans pending.** Strategy and risk behavior did not change.

Latest Options pre-chain funnel attribution (2026-10-01): source-record rejection, conflicting source directions, and underlyings omitted by the Tradier shortlist cap now appear in persisted funnel counts and ranked rejection reasons with their counting units labeled. **Status: focused 34/34 and full six-market verification passed; authenticated scans pending.** No option selection, strategy, risk or delivery gate changed.

Latest four-market provider telemetry correction (2026-10-01): Options, ETF/ETP, Futures and Forex diagnostics now distinguish absent provider latency from a measured 0 ms. Options queue delay and Tradier available/reset quota fields, plus Futures estimated scan costs and cap, use the same explicit measurement boundary. **Status: focused 38/38 and full six-market verification passed; actual authenticated provider timing/cost data remain pending.** Strategy and risk behavior did not change.

Latest Stocks funnel accounting (2026-10-01): diagnostics now separate distinct requested and available market-context ETFs from non-context symbols, then show stock-owned seeds only after ETF/ETP ownership filtering. Unavailable requested charts and unexpected returns are explicit. A pre-ownership scan failure leaves stock seeds unknown. The shared operator report carries these counts; older scans leave them unavailable. **Status: focused Stocks 45/45, operator 26/26 and full six-market verification passed; authenticated Alpaca scans and actual provider universe remain pending.** No strategy, model, risk or alert gate changed.

Latest Crypto deadline audit (2026-10-01 23:26 UTC): the opt-in public probe now shares a two-request Binance 1-second cap between entry clearance and unaligned deadline coverage. Complete same-pair seconds replay stop-first/partial/target rules through the last fully completed second before the frozen deadline; missing or invalid finer evidence withholds the opt-in outcome. A distinct audit price basis excludes these labels from production model training. AAVE and NIGHT each received 659 complete deadline seconds with a 543 ms unobserved tail: modeled +0.854 R and -0.218 R, both approximate audits rather than executable returns. The cohort is now 15 created, nine audit-resolved (five coarse early-close marks, two subsecond deadline marks, two source-candle stops), six pending. **Status: focused 45/45 and full six-market verification passed; independent sessions, verified public ticker identity and executable-cost evidence remain pending.** No strategy or risk approval changed.

Latest Crypto public entry audit (2026-10-01 23:10 UTC): an opt-in, two-request-capped Binance 1-second path now tests the otherwise ambiguous entry-containing 15-minute bar for a complete same-pair sequence with no post-observation barrier. Invalid, gapped, mismatched or barrier-crossing paths stay unresolved; successful paths are cached as isolated write-once research evidence and remain outside production model training. The real SUPER path cleared 337 seconds, then its later completed source candle recorded a conservative stop (-1.333 modeled R). The cohort is 15 created, seven audit-resolved (five approximate deadlines, two stops), eight pending and none due at that time. **Status: focused 5/5 and full six-market verification passed; executable fills, independent sessions, provider identity and performance validation remain pending.** No strategy, model, risk or order gate changed.

Latest Crypto forward-data quality fix (2026-10-01): source-pinned 15-minute resolution now identifies an ambiguous entry-containing candle separately. The public resolver reuses stored source/pair bars to skip repeating an identical history request for that unresolved row; `--status` reports due rows needing finer data separately from due rows retryable with current bars, plus the next future deadline. Actual SUPER follow-up selected/fetched zero providers and kept its outcome unknown. **Status: focused 39/39 and full six-market verification passed; finer point-in-time data and independent forward evidence pending.** No model, alert or risk gate changed.

Latest isolated Crypto outcome follow-up (2026-10-01 22:25 UTC): three due pinned Binance histories were fetched without provider failure; AAVE (+0.337 modeled R) and NIGHT (-0.296 R) received early completed-candle deadline marks and remain audit-only. SUPER is still due/unresolved because its containing 15-minute bar crossed the stop but cannot reveal whether that happened before the 20:24 entry observation. The cohort is 15 created, six audit-resolved (five approximate and one exact stop), nine pending including one due. **Status: forward audit collection in progress, no production or executable-fill performance conclusion.**

Latest keyed-Demo request accounting (2026-10-01): the Crypto discovery planner still caps only bulk market pages. It now also displays illustrative total loads for repeated and fully rotating deep shortlists, plus instrumented identity API attempts from the latest scan. At the defaults, 5,760 projected bulk calls become up to 11,580 with the same eight IDs or 28,860 with eight new IDs each discovery, including exchange-directory refreshes. These are scenario calculations, **not** an account-wide quota guard or measured usage; monitoring, commands, retries, other guilds and clients can add calls. `/crypto status` now labels keyed Demo exact-pair verification correctly. **Status: focused and full six-market verification passed; provider-backed Demo quota and sustained usage pending.** No entry or risk threshold changed.

Latest Crypto public follow-up (2026-10-01 22:11 UTC): one due `TRAC-USD` observation resolved against its pinned Coinbase candles without a provider failure, but the 22:00 close preceded the 22:10:59 deadline by about 11 minutes. Its modeled -0.118 R remains audit-only and cannot train the model. The isolated same-day cohort stands at 15 created, four audit-resolved (three approximate), 11 pending, none due; the next deadline is 22:24:23 UTC. **Status: forward collection in progress; no independent-day or executable-fill performance evidence.**

Latest Crypto free-key identity check (2026-10-01): a configured CoinGecko Demo key now performs exact coin-ID/venue-pair verification using documented Demo ticker and exchange-list endpoints, with fail-closed identity errors and tier-scoped caches. Keyless public mode remains explicitly ticker-only. The displayed monthly request projection is clarified as bulk discovery only; Demo identity calls add to quota use. **Status: focused tests verified, provider-backed Demo behavior and quota measurement pending.** See `IMPLEMENTATION_PHASES.md`.

Latest normal-scan Crypto cost diagnostic (2026-10-01): deep enrichment now records a research-only fixed-historical-cost versus current-quote-cost replay for eligible contiguous histories with two nonconflicting venues. It records per-asset availability reasons and pass/fail transitions in scan diagnostics and shows the aggregate in `/crypto diagnostics`; approval/risk behavior is unchanged. **Status: verified locally by focused and full six-market tests; pending for an authenticated worker scan, dated cost observations and independent forward outcomes.** See `IMPLEMENTATION_PHASES.md`.

Latest Crypto cost-sensitivity research (2026-10-01): a frozen 20-bps historical replay was compared with each asset's current quote-time modeled round-trip cost, after exact provider/pair and candle-window reproduction. Seven histories qualified; the eighth had gaps. All seven current cost estimates were higher, and NIGHT changed from a passing 20-bps historical gate to failing the quote-cost scenario. **Status: verified for local sensitivity mechanics; pending for point-in-time execution costs and independent forward paper.** This is not a strategy gate or proof of historical fills. See `../crypto-bot/PUBLIC_COST_SENSITIVITY.md`.

Latest Crypto zero-trade evidence correction (2026-10-01): a second public snapshot found 352 unique assets, 23 discovery candidates, 19 directory-qualified, eight deep-selected/two-venue-confirmed and zero strict qualifiers. One validation-rejected asset had an incomplete candle path and no historical trades; its placeholder zeros are now reported as missing expectancy/profit-factor evidence, while six other validation-rejected assets had measured nonpositive historical metrics. Seven research-only observations were frozen, bringing the cohort to 15 created, three audit-resolved and 12 pending. **Status: verified in focused and full six-market tests for diagnostics; independent-day outcomes, authenticated workers and executable fills remain pending.** No strategy or risk threshold changed.

Latest Crypto deadline evidence boundary (2026-10-01): three source-pinned public observations reached their first deadline and were resolved from completed candles, but two used a close about nine minutes before the deadline. Those approximate losses are now audit-only and excluded from training and liquidity-shadow comparisons; the third was a conservative stop. Stored models lacking outcome-evidence policy version 1 are disabled. **Status: verified in focused and full six-market tests; in progress for 12 pending forward observations, independent-day coverage and executable-fill evidence.** Production alert thresholds and shared risk did not change.

Latest Crypto forward-resolution diagnostics (2026-10-01): due public observations now retain structured unresolved counts for provider identity, empty/failing history, local storage, request caps, and insufficient completed candle/deadline paths. **Status: verified locally for attribution; in progress for remaining due outcomes and independent-day evidence.** No trade or model gate changed.

Latest dashboard setup comparison (2026-10-01): the read-only report can order highest/lowest observed after-cost expectancy R only between at least two bot-scoped setup cohorts with 30 reconciled closed trades each, five UTC entry dates, positive initial risk and unique close chronology. It withholds a ranking on sparse or incomplete evidence. **Status: verified locally for reporting mechanics; pending for real qualifying cohorts and forward validation.** No strategy or risk gate changed.

Latest Crypto forward-cohort visibility (2026-10-01): `--status` reads the isolated public research journal without provider requests and distinguishes the current 12 pending observations from three audit-resolved outcomes; the next recorded deadline was 22:10:59 UTC at 21:26 UTC. It preserves overlapping frozen rejection-code counts for later outcome comparison. **Status: verified locally for read-only cohort accounting; in progress for actual source-pinned forward outcomes and after-cost validation.** No production strategy, model, risk or delivery gate changed.

Latest Crypto entry-evidence correction (2026-10-01): production shadow observations now use a fresh provider-event ask from the exact venue/pair supplying outcome candles. Cross-venue-consensus entry rows and older learned bundles without entry-evidence policy version 1 are excluded from active model training, while old version-3 rows remain resolvable for audit. Binance/Coinbase missing provider timestamps no longer become local receipt timestamps. Funnel diagnostics now distinguish missing candle provenance from missing entry-quote provenance. **Status: verified locally for provenance and abstention; in progress for authenticated worker counts, forward labels and costed execution evidence.** Focused tests passed 82/82; full verification is recorded in `IMPLEMENTATION_PHASES.md`. Strategy alert thresholds and shared risk gates did not change.

Latest prospective Crypto research step (2026-10-01): the opt-in public deep probe now freezes isolated, source/pair-pinned observations from a <=30-second quote on the same candle venue, with production stop/targets/deadline and modeled cost reserve. A bounded `--resolve` command follows due rows using completed same-source candles; missing or mismatched data remains unresolved. Eight research-only rows were recorded from a fresh 20:24 UTC snapshot (351 unique assets, 28 discovery, 19 directory-qualified, eight deep/quote-confirmed, zero strict candidates). The first follow-up yielded three audit outcomes (one conservative stop and two approximate early-close marks); five first-snapshot rows and seven second-snapshot rows were pending at 21:26 UTC. **Status: verified locally for capture/resolution mechanics; in progress for actual forward outcomes, independent-day coverage and executable-fill validation.** Rows cannot train the production model and no approval or risk gate changed. See `IMPLEMENTATION_PHASES.md` and `../crypto-bot/README.md`.

Latest shared risk-day cost check (2026-10-01): the shared ledger now withholds same-session/UTC-day and lifetime after-cost totals when required closed-trade gross, fee, slippage and net fields do not reconcile. A stale preflight cannot bypass this: the atomic reservation lock blocks a same-day or undated unreconciled close; optional loss-streak/drawdown circuits treat any unreconciled historical close as incomplete. The operator report follows the same total-coverage rule. **Status: verified complete locally for fail-closed paper accounting; pending for account-backed cost/fill evidence and multi-session risk-policy evaluation.** Focused tests passed 103/103; full `npm run verify:all` passed (shared 588, Stocks 255, Crypto 253, 214 syntax files). Strategy thresholds and live-trading disablement are unchanged.

Modeled-cost reporting check (2026-10-01): post-trade reviews, the dashboard, operator performance and forward-shadow summaries share a gross-minus-fees-minus-slippage reconciliation boundary. A finite net-only or contradictory closed record remains observable but cannot make a whole cohort appear to have complete after-cost expectancy, profit factor or drawdown evidence; incomplete accounting is surfaced for review. **Status: verified complete locally for aggregate report integrity; provider-backed real costs/fills remain pending.** The subsequent shared risk-day audit is recorded above. At this stage focused tests passed 49/49 and full `npm run verify:all` passed (shared 586, Stocks 255, Crypto 253, 214 syntax files). Production strategy thresholds and live-trading disablement were unchanged.

Latest portfolio-evidence integrity check (2026-10-01): missing closed/open P&L or an undated close no longer appears as a complete zero or partial total in the shared ledger/operator summaries. The research dashboard now withholds whole-cohort net metrics on incomplete close coverage. Unknown UTC-day P&L blocks new paper approval, including forward shadows that compare against the shared portfolio. A `null` close timestamp no longer parses as 1970-01-01. **Status: verified complete locally for fail-closed accounting; pending for complete provider-backed forward records.** Focused tests passed 104/104; full `npm run verify:all` passed (shared 582, Stocks 255, Crypto 253, 214 syntax files). Existing strategy/risk thresholds and live-trading disablement are unchanged.

Latest paper-execution measurement check (2026-10-01): the first fill mark now uses the liquidatable bid/ask, including entry spread in unrealized P&L and sampled MAE. The shared ledger saves the executable exit quote on closed paper trades, and the dashboard reports exit-spread coverage plus a midpoint-based crossing amount for complete sampled side exits. Target-limit exits, mismatched execution prices and incomplete/legacy quote rows abstain from that estimate. The amount is already reflected in execution-price gross P&L and is **never deducted again**. A valid 0 x 0 worthless option-spread quote can now close at zero. **Status: verified complete locally for capture/accounting semantics; pending for real venue fills and multi-session cost validation.** Focused tests passed 83/83 and full `npm run verify:all` passed (shared 580; Stocks 255; Crypto 253; 214 syntax files).

Latest local shared-risk control (2026-10-01): optional `OMNIMOD_MAX_CONSECUTIVE_LOSSES` and `OMNIMOD_MAX_CLOSED_DRAWDOWN_PCT` can now block new paper reservations across all six bots at the atomic ledger boundary. Incomplete closed-trade chronology fails closed when enabled, and the first configured reservation anchors identical settings for subsequent bot processes. Both limits remain **unset by default** because no local forward cohort justifies numeric policy values. **Status: verified complete locally for the opt-in control; pending for operator threshold selection and forward-paper impact measurement.** Focused tests and full `npm run verify:all` passed. Existing emergency stop, daily loss and open-risk limits remain active.

Latest local Crypto horizon study (2026-10-01): a frozen 45/120/240/360-minute comparison on checksum-pinned BTC/SOL/XRP/BNB/ADA candles now reports earlier/recent after-cost outcomes, signal-day counts, exit reasons and clustered intervals at modeled 20 bp costs. All four cross-assets had negative earlier and recent expectancy at every window; all recent interval upper bounds were below zero. **Status: verified complete for this exploratory fixed-rule comparison; pending for untouched production-strategy data and forward paper.** No production gate or horizon was changed. The study and full `npm run verify:all` passed. See `../crypto-bot/HORIZON_SENSITIVITY_2026-10-01.md`.

Latest local Crypto replay check (2026-10-01): historical validation now censors signals whose future 15-minute outcome path skips a candle and withholds approval when the supplied history has a missing or irregular interval. The explicit rejection code is `incomplete_historical_candle_path`. **Status: verified complete locally for path integrity; pending for provider-backed validation and forward expectancy.** The focused regression and full `npm run verify:all` passed (Crypto 252 tests); strategy thresholds were not relaxed.

Latest local forward-shadow measurement check (2026-10-01): malformed realized P&L is excluded rather than coerced to zero; ungraded closes and missing return/R/excursion coverage are reported, and a day-cluster expectancy interval is withheld for incomplete sessions or outcomes. **Status: verified complete locally for summary integrity; pending for actual multi-session forward paper evidence.** Focused and full six-market tests passed; no approval rule changed.

Latest local shared-risk measurement check (2026-10-01): the ledger, operator report and dashboard now use one complete-chronology inspector for maximum/current closed-trade drawdown and consecutive-loss streaks. Missing P&L/timestamps or tied close times make these metrics unavailable rather than understating a partial sequence. **Status: verified complete locally for measurement; pending for data-backed maximum-drawdown and loss-streak risk-policy thresholds.** Focused tests and `npm run verify:all` passed; paper approval behavior is unchanged.

Latest local research-capture check (2026-10-01): Crypto scan diagnostics separate deep candidates, missing candle provenance, source-pinned eligible rows, newly recorded versus existing rows, and write failures. The admin view identifies version-3 labels. **Status: verified complete locally for observability; in progress for actual provider-backed funnel counts and forward labels.** Focused tests and full `npm run verify:all` passed without changing entry or risk gates.

Latest local integrity check (2026-10-01): Crypto shadow-label version 3 is source/pair pinned; mixed-source inputs and conflicting same-time source bars abstain. A file-backed observation-to-label test and the full `npm run verify:all` suite pass. **Status: verified complete for local label-provenance enforcement; in progress for provider-backed label coverage and forward performance.** No production strategy or risk threshold changed. See `IMPLEMENTATION_PHASES.md`.

Latest Crypto evidence-quality finding (2026-10-01): The public deep probe and production scan journal now preserve candle provider, completed-candle coverage/gaps, fixed historical cost assumption and recent/overall signal-day coverage. On the 18:04 UTC snapshot, the eight selected assets used a fixed 20 bp round-trip historical assumption; seven had 599 contiguous Binance candles and one had 299 Coinbase candles with one missing interval. Recent validation signals covered only two or three UTC days, and overall signals three to six days. The current `validation.sufficient` predicate counts trades (recent >=5, overall >=10), not independent days. These counts show why the historical gate is weak evidence of durable expectancy even when it passes; no approval behavior changed. Full `npm run verify:all` passed after the diagnostic edit.

Latest validation diagnosis (2026-10-01): Crypto now retains structured subreasons for each production `strategy_validation` rejection, a per-scan count by subreason, and an administrator diagnostic summary; the bounded public `--deep` probe reports the same exact predicate, recent/overall profit factors and subreasons. On a **new** 18:04 UTC CoinGecko snapshot, 350 unique assets yielded 52 preliminary candidates and 42 directory-qualified candidates. The existing deep cap selected eight, omitting 34; all eight met the two-venue quote threshold but zero passed strict technical/validation screening. All eight failed historical validation: seven had non-positive recent and overall after-cost expectancy plus profit factor at or below one; one lacked sufficient historical sample. Counts overlap; this one snapshot is not a trade outcome or a representative market period, and omitted assets were not deeply evaluated. Approval thresholds are unchanged. The full `npm run verify:all` passed after the final code edit.

Latest public technical-gate evidence (2026-10-01): The opt-in Crypto `probe:public-funnel -- --deep` analyzed five candidates from one fresh public CoinGecko snapshot after all five had the two-venue quote threshold. Zero passed its strict technical/validation screen; four had a historical strategy-validation rejection, and four would survive that one gate in an advisory **research-only** view on the latest repeated observation. Other rejection codes overlapped (minimum score one, trend continuation one). Four of five had some derivatives context, but provider errors remained. No learned model, manual events, portfolio/shared risk, Discord delivery or paper outcome was evaluated. The diagnostic history records snapshot timestamps so these repeat checks are not counted as independent market sessions. No production gate was changed.

Latest incremental evidence (2026-10-01): `../crypto-bot/npm run probe:public-funnel` is a repeatable bounded public-only discovery-to-quote diagnostic. One fresh CoinGecko snapshot returned 352 unique assets from 500 rows; 8 passed preliminary discovery and 4 passed the exchange-directory preflight. A REST-only quote check found 2/4 with two source-timestamped venues; when the probe also obtained Kraken WebSocket source timestamps, all 4/4 reached that venue threshold. Four excluded candidates were sampled; none reached it. The production scanner had started its Kraken subscription only after confirmation, so it now starts before enrichment and waits at most three seconds for listed candidates that need Kraken as a second venue. Final freshness, identity, strategy, model and risk gates are unchanged. The latest probe is in `../crypto-bot/PUBLIC_FUNNEL_PROBE.md`. This is one market snapshot, not a full strategy scan, paper trade, or evidence of expectancy.

Latest phase (2026-09-30): Read-only Crypto public-data smoke passed for BTC/ETH with two fresh executable exchange quotes each, 299 BTC candles, no disagreement, and no provider errors; Kraken REST receipt-time-only observations remained excluded. The operator report at 22:31 UTC found no retained Stocks/Crypto scans or known active worker heartbeats; other four scans were stale (~14h), and provider/paper configuration remains missing. No bot login, Discord post, paper reservation, or order was made. See `IMPLEMENTATION_PHASES.md` and `PROVIDER_SETUP_CHECKLIST.md`.

Updated: 2026-09-30. This checklist tracks the six primary day-trading bots requested for OmniMod. Status describes the strongest evidence available locally; passing fixture tests does not verify an external provider account or trading performance. Latest `npm run verify:all` passed after Crypto full-gate rejection instrumentation: shared/new-bots 552, syntax 199, Futures 126, Stocks 247, Crypto 239, ETF/ETP 65, plus all configured remaining checks. Forex tests passed 67/67. Stocks `npm test` passed 247/247 and `npm run check` passed. Forex/Futures/Options/ETFs-ETPs replay CLI tests preserve frozen strategy inputs across disjoint holdout windows; provider-backed point-in-time datasets are still missing for genuine OOS evaluation. Options, Forex, Futures, and ETFs/ETPs retain accepted, stale, malformed/untrusted/future and duplicate source-row counts in scan context; their source-rejection details remain bounded, and all shared signals remain paper-only advisory context. Forex configured pairs retain priority, fresh quote-screened G10 pairs are capped at 20 total by default, and discovery quotes are reused in deeper analysis. Futures review templates remain draft-fingerprint bound and do not invent quotes or bars. Stocks SEC requests serialize actual starts against a monotonic clock and retain SEC SIC industry labels on candidates with available submission data, while unknown sector ETF proxies remain neutral. Stocks/Crypto retry bounded transient transport errors; Stocks historical Alpaca backfill honors bounded Retry-After/reset waits, validates cross-page candle continuity, tracks per-symbol row coverage, validates checkpoint identity/counters, serializes market-bar file writes and identical query backfills across processes, persists retry bars idempotently, exposes a read-only bar/checkpoint lock inspector with same-host PID/manual recovery guidance, and fails closed on malformed pages or repeated pagination tokens; Stocks asset-master refresh retries transient failures while preserving its complete-snapshot validation, and optional Finnhub Crypto news records attempts and honors same-host cooldown on 429. Futures cost-estimate metadata callers use bounded retries while ambiguous paid-stream failures are not repeated. Crypto public BTC/ETH plumbing, the live public-universe funnel, and multi-reason strict-gate diagnostics were checked at 21:41–21:47 UTC; the strict gates rejected all eight deep-analysis candidates without any threshold change. Full-universe performance remains unverified. See the phase log.

Status meanings: **verified complete** means the implementation is present and the named local checks pass; **in progress** means implementation exists but the requested evidence or coverage is incomplete; **pending** means work has not started; **blocked** means an external account, entitlement, dataset, or operator-supplied value is required before the item can be completed.

## Shared workflow and controls

| Requirement | Status | Current evidence / remaining work |
|---|---|---|
| Shared asset-class and long/short exposure visibility | verified complete for local read-only reporting; portfolio validation pending | The operator report now partitions active reservations/positions by declared instrument class and effective underlying direction, including inverse ETF/ETP and option-underlying direction. It reports gross risk/notional and missing-metadata counts, retains unclassified/unknown rows, and withholds incomplete subtotals. This is nominal ledger accounting, not a weighted sector/factor, delta, correlation, or hedge model; no current local ledger positions exist and no approval limit changed. |
| Unified read-only research dashboard | in progress | `npm run report:research` combines the shared costed paper ledger with latest scan diagnostics in JSON or self-contained HTML. It shows open risk/notional and asset-class/effective-direction exposure with missing metadata, plus bot/strategy/instrument/hour/weekday closed-trade cohorts, expectancy, profit factor, R coverage, closed-trade drawdown, sampled MAE/MFE, costs, durations and rejection details. A missing ledger makes open exposure unavailable rather than zero. Prospective setup/regime cohorts use timestamped issuance metadata when present; unavailable labels remain unknown. The ledger currently has no real open or closed cohort, so portfolio patterns, statistical performance measures and provider-backed forward evidence remain unavailable. See the 2026-10-01 phase entries. |
| Post-trade observation and failure-review queue | in progress | Every closed shared-paper order receives a read-only review projection with planned/fill/exit levels, net/gross/cost reconciliation, R, quote-path coverage, exit reason, valid issuance features, and observed flags. New reservations retain a bounded shared-risk approval snapshot, raw source score/confidence/probability values, and a timestamped, source-reported partial market-gate trace from each of six production candidate paths. The trace validates owner, strategy, time, token format and uniqueness; it does not prove every upstream provider/model decision. Shadow variants omit production assertions, and legacy rows stay unavailable. A separate append-only operator-review journal binds manual thesis and loss-cause assessments to the exact closed record. No closed local paper trades exist, so there are no actual reviews or multi-session failure patterns; catalyst/correlation attribution and forward validation remain missing. |
| Prospective issuance-time research context | in progress | Each of six primary candidates now provides bounded setup/feature context to the shared paper ledger. Stocks/Crypto also provide existing market-regime labels; the other four leave regime unknown. The ledger sanitizes labels, finite feature values and timestamps without changing approval. The dashboard can group future closed trades by known setup/regime labels. No full market-specific regime classifier, historical backfill, independent sample or forward result is established. |
| Frozen forward-shadow experiment cohorts | in progress | All six owners declare a version, hypothesis, change and reason. A write-once manifest freezes a 60-day forward window only after paper equity, emergency-stop, session and observation readiness; creating-scan and pre-freeze candidates are excluded. Changed/malformed/expired manifests and unmanifested legacy cohorts fail closed for new shadow entries while prior positions remain monitored. Hashes still isolate version/base/override changes, and six owner versions were bumped for the new boundary. Historical and walk-forward results remain explicitly unavailable; meaningful multi-session forward outcomes and an operator promotion decision are missing. Source-code semantic changes still require an intentional version bump. |
| Distinct primary owner and market-specific intraday strategy per bot | verified complete | Six dedicated runner/strategy paths. Test coverage exercises individual strategies and replays. |
| Primary bot versus supplemental research project map | verified complete (documentation/source audit) | `README.md` distinguishes six primary paper bots from four supplemental read-only projects. Multi-Asset is manual-input only with Yahoo discovery disabled; source search found no shared reservation or order-submission APIs in the four supplemental projects. This documents code shape; no external service was exercised. See the latest phase entry in `IMPLEMENTATION_PHASES.md`. |
| Stocks/Crypto separate tactical trading from longer-horizon investment research | verified complete in architecture and presentation; performance unverified | Tactical prediction/outcome pipelines and longer-horizon research/journals are separate, with explicit short-term alert labels. Longer-horizon ranks remain technical research; Stocks SEC facts are dated/descriptive, and Crypto supply/protocol context is incomplete and not a valuation model. See `STOCKS_CRYPTO_STRATEGY_AUDIT.md`. |
| Defined scanning, entry, stop/target, time exit, sizing, and costs | verified complete | Market-specific rule evaluators feed the shared paper-risk contract; fees, spread, slippage reserves and instrument multipliers are validated before reservation. |
| Fresh, executable quote and stale/future timestamp rejection | verified complete | Shared risk gate plus provider adapter tests. Crypto now supplies the source-timestamped Kraken Spot WebSocket quote to the executable quote aggregator when cached; REST remains receipt-time-only and excluded. Existing stale/future/crossed quote rejection and Pro exact-pair identity gates remain. One live public smoke passed through the full three-venue aggregator for BTC/ETH; sustained runtime operation remains unverified. See the latest phase entry in `IMPLEMENTATION_PHASES.md`. |
| Bounded provider retries, host cooldowns, and request telemetry | in progress | Shared wrappers cover major Crypto market-data and derivatives adapters; optional Finnhub crypto headlines use bounded transient retries, same-host 429 cooldown, and per-attempt telemetry; ETF/ETP directory refresh now retries bounded transient failures; Tradier 429 responses impose a per-token pacer cooldown across queued Options requests; Stocks and ETF/ETP Alpaca adapters defer later same-key calls after 429 based on Retry-After/reset headers; Options records the consumed Tradier retry cooldown separately from request latency and local queue delay. These gates are process-local. Fixture tests pass. Yahoo FX public-chart observation now uses one bounded transient retry with a two-second wait cap under the existing permission attestation; runner access remains disabled. Forex REST applies an in-process provider cooldown after HTTP 429 and exposes measured wait duration per operation; it does not coordinate separate processes or shared-IP callers. Other direct provider calls still require review; credentials and authenticated provider behavior remain unverified. |
| Catalyst/news and market-session gates | in progress | Market-specific calendar/news and review gates exist. Event coverage and account-specific calendar/feed behavior remain unverified. |
| Shared portfolio risk, duplicate/conflict prevention, and combined exposure limits | verified complete for configured aggregate limits and identity collisions | Common atomic paper ledger; canonical exposure aliases, directional inverse/option handling, FX currency overlap, aggregate open-risk/gross-exposure/position/margin limits, and cross-process reservation tests. Stocks and Crypto use the same reservation path. This does not measure statistical correlation, sector-factor overlap, or stress correlations; see the pending research item below and the 2026-09-30 audit in `IMPLEMENTATION_PHASES.md`. |
| Data-backed sector/correlation concentration diagnostics and shadow policy evaluation | in progress | The read-only operator portfolio report aggregates active/reserved notional and risk by primary canonical exposure identity and now lists mapped secondary-overlap identities (for example, a broad commodity basket's possible oil/metals sleeves) without assigning component weights or summing notional into those aliases. Known directional amounts remain descriptive, with incomplete values unknown and no hedge credit. It does not estimate correlations or sectors or alter production approvals. Stocks has a stock-only pairwise-return selector and Crypto exposes an audit-only correlation estimate; neither supplies synchronized, point-in-time cross-market factor data to the shared risk gate. Broader sector/factor classifications, aligned returns, and shadow-only portfolio policy comparisons remain pending. |
| Emergency stop and live order routing disabled | verified complete | Emergency stop defaults active; code and readiness report reject live mode. No broker order path is present. |
| Position monitoring and performance records | in progress | Quote-sampled paper lifecycle records fills/exits/costs and descriptive metrics. Closed positions now report accepted quote sample count and largest observed quote gap alongside gross sampled MAE/MFE, globally and per bot/strategy. Sampling cannot observe between-scan movement and is not a calibrated fill model; provider cadence and forward-paper coverage remain unverified. |
| Share relevant peer-bot research | verified complete | Each of six owners now publishes up to three displayed reserved paper setups only after Discord delivery; rows retain instrument/exposure identity, normalize inverse-wrapper and option-underlying direction, and remain non-executable. Forex, Futures and ETFs/ETPs consume fresh peer context by exposure. Options entry consumes Stocks and ETF/ETP primary signals while retaining independent session, catalyst, quote, assignment, and portfolio risk gates. Conflicting source directions are withheld. |
| Coordinate cross-market commodity and Treasury exposure | verified complete | Shared aliases connect listed gold, oil, and Treasury Futures roots with mapped ETF/ETP wrappers and risk buckets; regression tests cover the broad commodity basket and rates exposure. This is conservative identity-based overlap, not a correlation/weight model. |
| Isolated shadow strategy tracks | verified complete | Each owner has distinct profile configuration and state; results remain shadow/paper-only. Reports now include a deterministic 95% percentile interval for cost-adjusted expectancy in R using whole entry-session clusters, capped to 60 recent sessions and unavailable until two sessions exist; the operator-report fixture verifies the interval is carried into admin diagnostics. Options' three production-data tracks now activate on the adapter's valid `TRADIER_ENV=production`, including the allowlisted complete-Greeks boolean gate; its integration test verifies track emission. Promotion criteria still require forward evidence. |
| Provider-authenticated operation and common paper account configuration | blocked | Fresh read-only operator report at 2026-09-30 22:03:14 UTC: Stocks/Crypto have no retained scan data; Forex/Futures/Options/ETFs-ETPs scans are stale (last recorded about 13h49m earlier), and no bot heartbeat/process is known. Shared paper ledger is absent. Crypto public market fallback is available, but paper equity is missing; Stocks is missing Alpaca credentials, consolidated SIP mode, paper equity and fee reserve. Forex is missing OANDA Practice credentials/modes, paper equity, and fee/slippage reserves; Futures is missing Databento key/dataset/feed modes, paper equity, and fee/slippage reserves; Options is missing Tradier token/production mode, paper equity, and fee/slippage reserves; ETFs/ETPs is missing Alpaca credentials/SIP, paper equity, and fee/slippage reserves. Report confirms emergency stops active by default and live trading disabled by code. No provider authentication or Discord delivery was attempted. See `PROVIDER_SETUP_CHECKLIST.md`; no account or worker is assumed operational from credential presence alone. |
| Exact configured market universe and scan caps documented | verified complete | `UNIVERSE_COVERAGE_AUDIT.md` distinguishes each default and runtime cap. Stocks dynamic broad discovery excludes Nasdaq Trader ETF-flagged listings plus currently source-reviewed ETNs/ETPs; invalid or expired wrapper rows are held pending review. The directory is cached 6h with 48h stale fallback, while supplemental reviews are re-read each scan; user-configured symbols remain explicit operator inputs. Forex has two configured fallback pairs, but OANDA practice mode dynamically screens the account directory and may select fresh/tradeable G10 pairs up to 20 total; current runtime source is disabled and account-supported counts remain unknown without credentials. Stocks default max 75 configured + 15 dynamic discoveries, Crypto rank cap 250/deep-provider cap 8, Futures 36 curated roots, Options 12 underlying signals, ETFs/ETPs 200 hard cap. Live directory/provider-returned counts remain unknown until authorized sources run. |
| Per-run observed universe, stage duration, and discovery/cap diagnostics for all six bots | in progress | Stage durations are recorded for all six, and compact stage timings are included in Forex, Futures, Options, and ETFs/ETPs Discord reports; Stocks/Crypto expose timing in administrator diagnostics. Forex now records account-supported, G10-eligible, discovered quote-qualified, selected, stale/missing quote, and cap-omission counts before deeper candle analysis. Crypto persists failed scans with provider telemetry and unknown downstream funnel counts when market discovery and fallback throw, records missing-symbol rows as structured identity rejections, and has synthetic conservation coverage through the local discovery funnel. Stocks measures universe maintenance, market data, candidate approval and persistence/post residual; Crypto measures snapshot, discovery, calendar/news, enrichment, and model/risk; Futures measures input, discovery, context, H1, calendar, live session, marks, strategy/risk and shadow; Options measures signal mapping, catalysts/news, Tradier data, dividend review, marks, strategy/risk and shadow; ETFs/ETPs measures universe/provider, catalysts, marks, shared research, strategy/risk and shadow. Other funnel counts and cap omissions still vary by bot/source; live scans remain unavailable for most providers. See `UNIVERSE_COVERAGE_AUDIT.md`. |
| Rejection reason counts reconcile to unique candidates and include production gates | in progress | Forex counts each reason once per currency pair across observation and paper-approval records; Futures counts a reason once per verified contract ID/raw symbol across duplicate input rows; Options deduplicates within each option-result row and retains one provider row per underlying; ETF upstream rejection stages are sequentially disjoint and strategy results count once per row; Stocks includes candidates pending consecutive-scan confirmation in reason totals. Crypto carries provider asset IDs through discovery, model, portfolio, shared-ledger, capacity, and delivery rejections; its top totals count each asset once per code while retaining all stage rows. Provider-backed diagnostics and any still-unverified downstream risk/delivery reconciliation remain. |
| Futures discovered-contract reconciliation | verified complete for read-only identity/spec comparison | Optional Databento dated definitions are reconciled against configured raw contract, expiry, tick size/value, and multiplier. Missing definitions, expiry changes, provider spec mismatches, and absent comparison values are distinct. Definition cache is scoped by dataset plus products; cross-dataset stale definitions are rejected. Discord reports a compact summary; structured output carries bounded definition details. Provider definitions never establish active status, broker margin, session, settlement, liquidity, or trade eligibility. Fixture coverage: `futures/test/contract-discovery-audit.test.js` and `futures/test/contract-discovery-cache.test.js`; real provider coverage remains unavailable. |
| Futures day-scan readiness reporting | in progress; prior-session volume-ranked candidates now discoverable for review, strategy-eligible active universe still pending | The runner distinguishes configured day-strategy inputs, empty day inputs, discovery-only contracts, provider discovery failure, and draft-only inputs. Exact `draft_requires_manual_review` rows are skipped before day-session, H1, and calendar provider calls; mixed files report skipped-draft counts and structured `contract_review_required` rejection totals while processing other rows. `npm run discover:day-session-draft --prefix futures` requests Databento continuous `v.0` definitions and narrows its review worksheet to the prior trading session's volume-ranked expiry per configured product after the cost estimate passes the configured cap. New `template:day-session-review` and `compile:day-session-review` commands bind an operator-reviewed input file to the exact draft fingerprint and validate cited contract/session/settlement/catalyst/cost metadata before writing a separate paper-input file. Bars and quotes remain absent and still require entitled current data. Unit tests cover mapping, review compilation, fingerprint changes, invalid/stale review rejection, cost requirements, and fail-closed eligibility. Real Databento access and strategy candidates remain unverified. |
| Futures dated-contract review worksheet | verified complete as a non-eligible draft generator | `npm run prepare:day-session -- <definitions.json> > <draft.json>` creates a separate review draft only from unexpired definitions with a valid provider timestamp no more than 24 hours old. Missing, malformed, future, and stale provider timestamps are structured rejections. Provider tick/multiplier facts remain unverified references; active/broker ID, trusted specs, margin, settlement, exposure, session, catalyst, executable data, fees, and slippage remain unset. No input is overwritten and the result fails contract approval until independently completed. The combined `discover:day-session-draft` command still requires manual active-contract selection. `npm test` in Futures passed 126/126 after this change; see the latest phase entry. |
| User-facing diagnostic output preserves unknown versus observed zero | verified complete | Shared formatter and market-specific Discord status lines now render nullable scan, quote-mark, catalyst, discovery, cap, duration, calibration, and provider-latency counters as `unknown`; explicit zero remains `0`. Stocks and Crypto provider latency now averages only measured network requests; unmeasured durations remain unknown, not zero. |
| Provider rate limits and retry behavior audited against current official documentation | in progress | Updated Databento historical limits and Futures retry policy from vendor documentation. Futures, Stocks, ETFs/ETPs, Forex, the shared Finnhub calendar, and Options honor bounded retries for eligible requests and fail closed when required waits exceed configured limits. Stocks uses bounded exponential backoff when the header is absent, paces SEC requests to <=10 starts/second per process, and now retries the daily Alpaca all-status asset-master request on transient transport/429/selected 5xx failures. Crypto derivatives share bounded retries and host cooldowns; same-asset derivatives, identical historical candle pulls, and simultaneous same-asset quote sets coalesce in-process. Optional Crypto CoinGecko Pro identity validation adds one request per uncached candidate and fails closed on lookup failure; free/demo remains ticker-only. Options retries preserve per-token request pacing and record every actual attempt. Other market adapters and shared-IP coordination still need provider-specific review. |

## Primary bot-specific readiness

| Bot | Strategy / market handling | Status | External validation still needed |
|---|---|---|---|
| Stocks | Dynamic active-equity/screener discovery, premarket breakout research, bounded deep analysis, existing technical/model/risk pipeline | in progress | Target-hit calibration now rejects duplicate, unidentified, invalid-time, and post-forecast outcomes. Current local readiness lacks Alpaca credentials and SIP mode, explicit round-trip fee reserve and paper equity; then verify provider coverage, deployed funnel/model state, point-in-time OOS and forward paper results. |
| Crypto | Multi-provider spot/derivatives confirmation, continuous-market intraday research, separate long-horizon research; duplicate current-universe tickers are rejected before CEX enrichment; optional Pro mode verifies exact CoinGecko asset ID/venue pair identity | in progress | Strict correlation diagnostics compare legacy gate estimates with equal-length, no-gap sparkline pairs, count legacy flags on unavailable data and estimate disagreements, and remain audit-only. Normalization preserves invalid source sample slots. These provider sparklines have no per-point timestamps and are not calibrated cross-asset risk data; the legacy approval gate remains unchanged. Optional headlines receive a conservative display/research-only topic tag; event truth, event timing, market impact and news-based approval remain unknown. No worker is configured, so runtime coverage is unknown. Read-only public-data smokes at 2026-09-30 21:30 UTC passed for BTC/ETH: Binance/Coinbase supplied fresh timestamped executable quotes, Binance returned 299 BTC candles, and Kraken WebSocket source-timestamped quotes were accepted as a third venue for both symbols; REST receipt-time-only observations remain excluded. This does not validate sustained uptime, full scan, signal quality or performance. Public/Demo modes remain ticker-based; Pro mode blocks quotes without exact, non-stale, non-anomalous ID/pair matches. Costed fixed-rule Crypto replays remain negative on recent cross-asset samples and are not production-ensemble/OOS validation; do not promote the rule. See Crypto `MODEL_AUDIT.md`, cross-asset validation reports, and the latest phase entry. |
| Forex | OANDA-only executable quote/candle day-breakout paper path, account-supported G10 discovery, currency conversion and economic-event gates | blocked | Current local readiness lacks OANDA Practice token/account, Practice mode, paper equity, explicit round-trip fee/slippage reserves; verify dynamic universe counts, pair coverage, session behavior, conversion freshness, and forward paper cohort. |
| Futures | Opening-range/H1 trend paper path across index, metals, energy, rates, FX, and agriculture contracts; contract identity/specification, margin and top-of-book gates | blocked | The 36-row configured universe drives continuous-proxy context; the manual day-session example remains empty. New cost-capped Databento `[ROOT].v.0` discovery can produce a prior-session volume-ranked review draft per product but does not enter `dayTrades` or strategy approval. Current-session liquidity, independently verified contract specs/margins/sessions, quotes, and external readiness remain unverified. The runner reports `no_configured_day_contracts` until reviewed inputs exist. External readiness still lacks Databento credentials/dataset/feed modes, a positive scan-cost cap, paper equity, and explicit fee/slippage reserves. |
| Options | Underlying-confirmed debit verticals, synchronized leg quotes, liquidity/expiry/catalyst/assignment checks, paper monitoring | blocked | Current local readiness lacks a Tradier token, production-data mode, paper equity, and explicit per-contract fee/slippage reserves; validate option fill/IV behavior and lifecycle/assignment handling. Sandbox quotes are intentionally rejected for entry/marks. |
| ETFs & ETPs | Opening-range/VWAP/relative-volume strategy, listing/product classification, leveraged/inverse/commodity/bond exposure normalization | blocked | Current local readiness lacks Alpaca credentials, SIP mode, paper equity and explicit per-unit fee/slippage assumptions; validate complete exchange coverage, wrapper terms, distributions/corporate actions, and forward paper costs. |

## Strategy evidence gates

| Evidence | Status | Acceptance evidence required |
|---|---|---|
| Automated tests and syntax checks across all six bot projects | verified complete | Latest `npm run verify:all` passed after the Forex 429 cooldown gate: shared/new-bots suite (552 tests), syntax checks for 199 JavaScript files, Futures (126 tests), Stocks (247 tests), Crypto (238 tests), ETF/ETP (65 tests), and all configured remaining checks. Forex tests passed 67/67. Existing tests cover provider cooldown waits, separate-process paper reservations, shadow expectancy, and explicit unknown handling. Market data still needs provider-backed point-in-time histories for genuine OOS results. |
| Provider plumbing smoke checks | in progress | Rechecked at 2026-09-30 21:30 UTC using existing public read-only scripts. Binance/Coinbase supplied fresh timestamped executable BTC/ETH quotes with no disagreement/provider error; Binance returned 299 BTC candles. Kraken Spot WebSocket v2 quotes with source timestamps were accepted as a third venue for BTC/ETH, with no conflict/provider errors. Kraken REST remained receipt-time-only and excluded. The quote/candle smoke completed in 1.7 seconds and WebSocket aggregation in 2.7 seconds; sanitized append-only histories were updated. These single observations do not establish sustained uptime, licensing, strategy, or execution readiness; no strategy, signal, reservation, Discord post, or order was generated. |
| Historical replay using synthetic fixtures | verified complete | Strategy adapters, later-quote lifecycle, cost inputs and chronological guards are covered by tests/replay tooling. ETF/ETP, Forex, Futures, and Options CLI tests verify disjoint holdout windows with frozen strategy inputs. This is harness/implementation evidence only, not market-performance validation. |
| Costed Crypto fixed-rule cross-asset and regime replay | in progress | Replayed five checksum-pinned Binance 15m datasets and three modeled round-trip cost tiers. The report now retains BTC-regime outcomes and signal-day coverage. At 20 bp the four recent cross-asset means and day-cluster intervals are negative; populated regime cells are also negative. This is not a blind test, uses modeled costs/OHLCV fills, and is not production-ensemble validation. Keep the rule out of production promotion. See `../crypto-bot/CROSS_ASSET_FIXED_RULE_VALIDATION_2026-09-30.md` and `.json`. |
| Frozen, point-in-time out-of-sample evaluation for every production day strategy | pending | Local data audit found only five checksum-verified Crypto 15-minute OHLCV histories for the fixed-rule exploratory study; Stocks retains two stale Yahoo diagnostic snapshots (2026-07-29), not replayable history, and Forex/Futures/Options/ETFs&ETPs retain diagnostics/tracker/configuration files but no point-in-time market-bar datasets. Crypto replay is not blinded and uses OHLCV rather than executable quotes. All six production-day strategies still need appropriate licensed, survivorship/roll/calendar-aware data, verified spread/fees/slippage, pre-registered cohorts, regime/setup segmentation and drawdown/expectancy reports. |
| Multi-session forward paper validation across all six primary bots | pending | Common reviewed paper equity, credentials/entitlements, costs, workers, provider marks, and enough separate market sessions; report fill/not-filled, target/stop, expectancy, MAE/MFE, costs, drawdown and sample size. |
| Confidence calibration and any strategy promotion | pending | Sufficient untouched outcomes, independent-day samples, calibration/error analysis and operator review. No current profitability claim is supported. |

## Current phase and next work

- **Crypto discovery/gate audit and diagnostics refinement (2026-09-30 21:41–21:47 UTC):** Fresh public CoinGecko discovery returned 352 unique assets from 500 overlapping rows across two pages, while the provider reported 17,932 assets. Of 352, 332 passed source freshness; 240 passed rank, 169 liquidity, 63 the preliminary score, and 49 the preliminary trend screen. The configured deep-analysis cap selected 8 and omitted 41 otherwise-qualified assets. Public provider enrichment returned data for the eight; strict final confirmation approved zero. In this sample the top rejection reasons were score (8), regime (8), strategy validation (8), trend (4), provider confirmation (3), and technical data (2). The score/risk/strategy gates were not changed. Added an opt-in full-rejection audit mode used by production diagnostics; candidate eligibility remains identical, verified by test and a public-data comparison. Added test-only legacy-cache migration isolation after these live snapshots exposed fixture pollution. Crypto test suite passed 239/239 and `npm run check` passed; full six-market `npm run verify:all` passed (shared 552, JS syntax 199, Stocks 247, Crypto 239, and all remaining configured checks). Public quote/WebSocket smokes passed for BTC/ETH; no paper reservation, Discord post, or order was produced. Data coverage remains one live sample; strategy performance and full-universe confirmation remain unverified.

- **Latest read-only readiness observation (2026-09-30 21:38 UTC):** `npm run report:operator` found no retained scan data for Stocks or Crypto; the most recent Forex, Futures, Options, and ETFs/ETPs scan records were about 13.4 hours old. No current process heartbeat evidence was available (process state is unknown). Forex's recorded source was disabled and had zero provider requests. Futures had 36/36 stale continuous-context rows, zero configured day-trade inputs, and contract discovery disabled; its last scan reported emergency stop active, live trading disabled, and no order route. Options had no primary signals or provider requests. The shared paper ledger did not exist. Provider-presence diagnostics found Stocks incomplete (Alpaca credentials and SIP mode), Crypto public fallback available but no scan record, and Forex/Futures/Options/ETFs-ETPs missing their required account/data modes; paper equity is missing for Forex/Futures/Options/ETFs-ETPs and explicit round-trip cost reserves are missing for these four webhook bots. No secret values were emitted. This is local configuration/report evidence, not proof of external provider outage or worker termination.

- **Latest read-only readiness observation (2026-09-30 21:38 UTC):** `npm run report:operator` found no retained scan data for Stocks or Crypto; the most recent Forex, Futures, Options, and ETFs/ETPs scan records were about 13.4 hours old. No current process heartbeat evidence was available (process state is unknown). Forex's recorded source was disabled and had zero provider requests. Futures had 36/36 stale continuous-context rows, zero configured day-trade inputs, and contract discovery disabled; its last scan reported emergency stop active, live trading disabled, and no order route. Options had no primary signals or provider requests. The shared paper ledger did not exist. This is an observation of local state, not proof of external provider outage or worker termination. See the latest phase entry.

- **Latest implementation:** ETF/ETP exchange-directory refresh now retries transient 429/5xx/network failures up to three attempts with bounded Retry-After/backoff and per-attempt telemetry; permanent 4xx errors stay fail-closed and existing fresh/stale cache policy is unchanged. Shared Discord readiness now matches actual transports: Stocks/Crypto report application-token presence; Forex/Futures/Options/ETPs report webhook presence. Reports never expose secret values and label presence as unverified. Forward-shadow reports also add a day-clustered 95% interval for cost-adjusted expectancy (R), using at most the latest 60 entry sessions; fewer than two sessions yields an explicit unavailable interval. Stocks Alpaca all-status asset-master refresh retries bounded transient failures; Finnhub Crypto news uses bounded retries, host cooldown, and per-attempt telemetry. `npm run verify:all` passed after directory retry changes: shared/new-bots 546 tests, 197 syntax checks, Futures 126, Stocks 228, Crypto 238, ETF/ETP 63, and all configured remaining checks. Public Crypto provider smokes were rerun at 19:46 UTC: Binance/Coinbase timestamped BTC/ETH quotes and 299 BTC candles passed; timestamped Kraken WebSocket quotes were accepted as the third provider for BTC/ETH. No authenticated provider-backed scan has been run. Latest read-only operator report (2026-09-30 19:44:47 UTC) confirms no shared ledger/open paper positions, no fresh Stocks/Crypto scans, stale scans for Forex/Futures/Options/ETPs, and no known active worker heartbeats. Provider-specific missing configuration is itemized in `PROVIDER_SETUP_CHECKLIST.md`. These observations do not establish trading performance, and live trading remains disabled.
- **Latest incremental verification (2026-09-30):** Yahoo FX observation retries one transient response within a 2-second wait cap while its permission gate and observation-only status remain. Forex suite passed 66/66; `npm run check` passed 199 files; full `npm run verify:all` passed (shared/new-bots 551, Futures 126, Stocks 247, Crypto 238, ETF/ETP 65). No authenticated provider request was made.\n- **Latest incremental verification (2026-09-30):** Forex in-process provider cooldown after 429 is covered by deterministic sibling-request and wait-telemetry tests. Forex suite passed 67/67; root syntax check passed 199 files; full `npm run verify:all` passed (shared/new-bots 552, Futures 126, Stocks 247, Crypto 238, ETF/ETP 65). No live provider request was made.\n- **Latest public-data observation (2026-09-30 21:30 UTC):** Crypto read-only BTC/ETH smoke passed with two fresh timestamped executable exchange quotes per asset, 299 BTC Binance candles, and Kraken WebSocket source timestamps accepted as a third venue for both. No disagreement or provider error was observed. This verifies plumbing for one sample only, not paid provider access, sustained uptime, strategy quality, or profitability.\n- **Implementation phase log:** see `IMPLEMENTATION_PHASES.md` for dated findings, changes, checks, limitations and next steps.
- **Next phase:** use authorized provider accounts to run the new Futures review workflow, obtain current Futures live/H1 data, and complete provider-backed scans for all six categories. Expand concentration reporting from primary identities to independently weighted broad-basket/factor exposures only when trustworthy mappings/weights and aligned timestamps are available. Collect multi-session, venue-costed forward-shadow outcomes and point-in-time OOS datasets. Do not promote the examined Crypto fixed rule: its cross-asset costed replay is negative. Longer-horizon fundamental/tokenomic completeness and production-strategy performance remain unverified; live trading stays disabled.

### Audit provider throttling and retry behavior — 2026-09-30

- **Status:** Verified complete for the Databento Futures historical HTTP adapter; cross-provider audit remains in progress.
- **Finding:** Databento documents a `Retry-After` header for HTTP 429, but the Futures historical cost-estimate and bar requests previously failed immediately without honoring it. Current vendor documentation specifies independent historical and live quotas, so those limits must not be conflated.
- **What changed:** The Futures adapter now retries one 429 exactly once only when a valid `Retry-After` delay is present and at most 10 seconds. It never guesses a delay or loops. The provider matrix now records the documented historical and live quotas and distinguishes metered history/licensing from live entitlement.
- **Verification:** Added a deterministic test proving a two-second provider delay is honored, no duplicate bar requests occur, and a 429 with no retry header fails closed. `npm test` in `futures` passed 78/78. `npm run verify:all` passed: shared workspace 458 tests, syntax checks for 174 JavaScript files, Stocks 218 tests, Crypto 209 tests, and all remaining configured six-market checks.
- **Remaining:** No credentials or entitlements are configured here; this test does not validate real Databento access. Review retry/backoff behavior and current rate limits for the other adapters, especially OANDA and Tradier, without treating their limits as shared across providers.
- **Next:** Continue the per-provider retry/backoff audit and collect authenticated read-only health observations as account access becomes available.











- **Latest incremental verification (2026-09-30):** ETF/ETP universe now source-classifies 12 curated futures-backed commodity products (USCF: USO, USL, BNO, UNG, UNL, UGA, USCI, CPER; Invesco: DBA, DBC, PDBC, PDBA) with explicit commodity exposure keys. This lets the existing product-risk path attach the futures-roll-risk-not-modeled notice and coordinate commodity exposure across bots. Added them to the curated discovery seeds; they remain subject to active listing, live quote, catalyst, strategy and shared-risk gates. Focused ETF/ETP suite passed 65/65. Full `npm run verify:all` passed all configured six-market test and syntax-check commands (552 shared, 199 JS syntax files, and all market suites). No live provider scan, paper order or Discord post was run; no performance claim is made. Provider-backed readiness and strategy validation remain blocked on credentials, entitlements, paper account assumptions and forward/OOS data.

- **Latest incremental verification (2026-09-30 22:43 UTC):** Databento Futures H1-history and outright contract-definition downloads now honor a single explicit `Retry-After` only for HTTP 429, bounded to 10 seconds; no generic transport/server retry was added to data streams. Each retried 429 is recorded with its wait and quota telemetry, followed by the final response metric. Focused Futures adapter tests passed 29/29 and the full Futures suite passed 128/128. Full `npm run verify:all` passed all six-market tests and syntax checks (shared 554, syntax 199; all configured market suites passed). Policy follows Databento's official [historical API guidance](https://databento.com/docs/api-reference-historical/timeseries/timeseries-get-range/parameters?historical=python&live=python), which documents 429 and Retry-After. No provider credential was used; live entitlement, quota behavior, and request charges remain unverified. Live trading stays disabled.

- **Latest incremental verification (2026-09-30 22:46 UTC):** Cross-market exposure aliases were extended for the newly reviewed commodity ETPs: oil (USL/BNO), natural gas (UNL), gasoline (UGA), copper (CPER), broad futures baskets (USCI), and agriculture (PDBA). CME product roots RB and HG now normalize to gasoline and copper so shared paper-risk checks can detect those overlaps. USCI remains a broad basket with secondary sleeves and no assumed weights. Focused exposure tests passed 10/10; full shared suite passed 554/554; full six-market `npm run verify:all` passed after the changes. Mapping evidence: [USCF USCI](https://www.uscfinvestments.com/usci), [Invesco PDBA](https://www.invesco.com/us/en/financial-products/etfs/invesco-agriculture-commodity-strategy-no-k-1-etf.html), [CME copper code HG](https://www.cmegroup.com/trading/metals/files/copper-futures-and-options.pdf), and [CME gasoline code RB](https://www.cmegroup.com/markets/energy/refined-products/rbob-gasoline.quotes.html). Static identity overlaps do not estimate correlation or current composition; shared portfolio risk stays conservative and no hedge credit is introduced.

- **Latest incremental verification (2026-09-30 22:53 UTC):** The Stocks long-horizon `/invest` historical-bars adapter now honors Alpaca's shared process-local credential cooldown and performs at most three attempts for 429, selected transient 5xx, and transport errors. HTTP 429 uses bounded `Retry-After`/reset delay, deferred waits remain capped at 10 seconds, and permanent 4xx/invalid payloads fail immediately. `/invest` output now summarizes request count, retries, failed attempts, average latency, and peak reported quota use; internal per-attempt diagnostics preserve observed zeros and omit request URLs/secrets. Focused investment tests passed 20/20; Stocks suite passed 249/249; full `npm run verify:all` passed all configured six-market test and syntax-check commands (shared 554, syntax 199). This path is long-horizon research data, not trading approval; no provider account was configured or called.

- **Latest incremental verification (2026-09-30):** Corrected Forex universe documentation: account-supported G10 discovery is already enabled by default in OANDA practice mode, quote-screened in batches, and capped at 20 deeper analyses; actual account size is unknown while source remains disabled and credentials are absent. Forex suite passed 67/67. No strategy behavior changed. See the latest phase entry.

- **Latest incremental verification (2026-09-30 23:14 UTC):** Stocks broad discovery now excludes symbols positively flagged as ETFs in Nasdaq Trader’s official directories. The shared parser is used by ETF/ETP and Stocks; Stocks directory cache refreshes every 6 hours, retries transient errors, and falls back up to 48 hours before withholding broad discovery (configured scans remain available). Stocks suite passed 252/252; full `npm run verify:all` passed all configured six-market tests/syntax checks (shared 554; syntax 200; all configured market suites passed). ETNs/other unflagged ETPs and live provider coverage remain unverified; no strategy threshold changed. See phase log.

- **Latest incremental verification (2026-09-30 23:28 UTC):** [Verified complete locally] Shared supplemental ETP classification now excludes reviewed ETNs/other wrappers from Stocks broad snapshots and screener candidates, while expired/invalid wrapper rows are held out for review. ETF/ETP re-reads review records each scan even with a cached exchange directory; a changed exclusion fingerprint invalidates Stocks wide-discovery and market-snapshot caches. Focused Stocks tests passed 15/15 plus the cached-snapshot test 1/1, ETF/ETP universe tests 9/9, and full `npm run verify:all` passed after the final code change (shared 554 tests; 201 JavaScript syntax files; all configured market suites). [In progress] Provider-backed ownership counts, unknown-wrapper classification, and configured-watchlist ownership still need verification. [Blocked] Authenticated paper scans and forward/OOS performance require provider entitlements, cost/equity assumptions and point-in-time data. Live trading remains disabled. See the phase log.
