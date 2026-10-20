# ETF/ETP native quote evidence — 2026-10-03

Status: **verified locally; provider-backed operation and forward performance remain unverified.** This follows the Stocks decision-time refresh phase. The overall six-market goal is active. No strategy thresholds or portfolio limits were relaxed.

## Actual local operating state

Read-only inventory at 2026-10-03 14:50 UTC found `ETF_SOURCE=fixture`, IEX configured, Alpaca credentials missing, emergency stop on and independent monitor cadence 0. There were 404 retained scan-diagnostic rows. The latest saved scan, at 14:46:23 UTC, used `manual-fixture`: zero configured rows, zero strategy inputs and zero reservations. Provider-scanned and active/tradable counts were unknown. It had no native-evidence diagnostics.

These zero results do **not** establish that a live market scanner found no opportunities. This phase did not activate an authenticated scanner, change the actual environment, restart a service, upload files, send Discord messages, buy data or place live orders. Local source changes may be picked up by existing workers when they next load the files; no claim of a coordinated runtime rollout is made.

## Defects reproduced and fixed

Both detailed ETF analysis and independent owned-position monitoring discarded native quote sizes, feed, conditions, exchange codes and source evidence, retaining only bid/ask/time plus an executable label. The shared risk/execution code applied native evidence and displayed-liquidity checks to Stocks only. ETF/ETP callers could therefore approve price-only inputs and simulate full fills larger than the displayed side.

Four regression tests failed on the preserved original source. All now pass. The same `alpaca_stock_l1` schema used by Stocks now protects listed ETFs and ETPs through strategy qualification, shared risk, reservation, later fill, mark and exit. Shared class checks normalize spelling, so alternate capitalization cannot bypass evidence validation. Owner checks remain separate and authoritative.

## Implementation

- `src/alpacaMarketData.js`: detailed SIP snapshots are parsed through the shared native parser. Missing/invalid size, symbol mismatch, malformed fields and nonregular conditions reject the row with a structured reason. The quote retains native source, requested feed, original timestamp, prices, displayed share sizes, exchanges, tape and conditions. Normalized quote time is an ISO string; the existing strategy and shared consumers support it.
- Free IEX remains available for discovery and reference observations. Missing executable evidence does not remove otherwise usable IEX research rows. Valid IEX evidence retains single-venue scope and still has reference quality. IEX cannot become a SIP execution observation through relabeling.
- `src/strategies.js`: the existing opening-range breakout requires matching native SIP evidence before emitting a candidate. It retains normalized evidence and records the gate. Opening range, VWAP, relative volume, bars, catalyst requirements, classification, price geometry, costs and session rules are unchanged.
- `shared/stockQuoteEvidence.js` and `shared/paperRisk.js`: native validation applies to stock, ETF and ETP instruments. ETF/ETP execution requires SIP even for older orders without saved feed evidence. Reservations retain proof; later quotes are validated again. A failed mark cannot update the ledger or manufacture an outcome.
- Long fills require sufficient displayed ask shares; long marks/exits require bid shares. Short fills require bid shares; short marks/exits require ask shares. A full quantity larger than the relevant side is rejected. This remains a conservative full-fill-or-reject model, not a partial-fill or depth simulator.
- Independent owned-position monitoring calls the same parser and retains evidence. It still manages positions outside discovery/entry shortlists, validates regular sessions and quote age, batches at 100 symbols, and reports acquisition failures. Full scanner and older shadow books use this same path.
- Older filled orders can exit using new valid SIP evidence without rewriting their historical entry evidence or events. Prospective processing is stricter; old cohorts must not be treated as if they originally used this rule.

Current SIP sizes are kept 1:1 in shares, consistent with Alpaca's [CTA/UTP size change effective November 3, 2025](https://docs.alpaca.markets/us/v1.1/changelog/marketdata-bid-and-ask-size-display-change). Older size regimes remain unsupported by this native validator. The [snapshot API](https://docs.alpaca.markets/us/reference/stocksnapshots-1) distinguishes SIP, single-venue IEX and delayed SIP; feed choice does not establish entitlement. This phase adds no provider requests and does not activate or change a subscription. Only the already-reviewed regular `R` condition qualifies; other conditions are explicit rejections, not a claim that they are universally invalid market observations.

## Observability and versions

Detailed acquisition exposes `quoteEvidence` with scope, feed, native-verified, executable and reference-only counts plus per-symbol evidence rejection reasons. `rejectedRows` records rejected detailed data rows; `summarizeEtfScan` preserves them as `rejectedDataRows`. The top-level operator report retains native evidence diagnostics. Missing observations remain null, not an invented zero. These are detailed-candidate acquisition counts, not whole-market coverage or a guarantee that quotes remain current after subsequent work. Strategy/risk/execution recheck their clocks.

- Shared executor: `paper-quotes-v9-etp-quote-evidence`.
- ETF owned-position adapter: `etp-owned-quotes-v3-native-evidence`.
- Full-directory shadow cohort: `etp-opening-range-breakout-shadow-v5-native-evidence`.
- Legacy discovery comparison cohort: `etp-opening-range-breakout-shadow-v3-native-evidence`.

Existing saved experiments/history are not rewritten. Fixture/replay callers must now supply explicit synthetic evidence when testing execution, or real point-in-time provider evidence for research claims. Production never constructs synthetic evidence from price-only input.

## Verification

`npm run verify:all` from `new-bots`: **1,648 passed** — 956 shared/new-market, 300 Stocks, 392 Crypto — plus configured syntax and nine Windows launcher checks. A focused run passed **236** tests across ETF adapters/discovery/strategy/replay, common risk, quote integrity, monitoring, operator reporting and six-owner lifecycle integration.

New coverage includes the four original defects, source/size retention, exact symbols and timestamps, native conditions, SIP enforcement, long/short ETF and ETP lifecycle liquidity, immutable rejection, legacy exits without historical rewrites, structured scan/operator diagnostics and preserved IEX reference discovery. Existing synthetic fixtures were extended with explicit native-shaped evidence so original risk, concurrency, malformed-value, chronological replay and after-cost assertions still run. The native parser's existing tests cover stale/future/malformed prices, sizes and feed provenance.

The lifecycle tests use temporary ledgers and synthetic provider responses. They demonstrate implementation behavior, not real trades, profitability, full-market coverage, account access or forward validation. No authenticated provider probe ran because local credentials were absent.

Evidence files under `review-verification/`: `etf-quote-evidence-baseline-20261003/` (19 source originals and three document originals), four-failure baseline log, focused/full logs, source diff, redacted configuration inventory and structured checkpoint. Initial compatibility failures are retained separately; final verification is the authoritative pass.

## Remaining work

1. Configure legitimate provider access, validate the complete authenticated directory and feed entitlement, and run actual scans. Free discovery/reference data and execution-grade data remain distinct capabilities. The current empty fixture configuration cannot demonstrate either live scanning or executable opportunity coverage.
2. Coordinate account-wide provider budgets across processes. Existing per-process pacing does not prove account-wide compliance.
3. Measure ETF quote aging through deep history, optional volume profiles and downstream processing; add bounded refresh only if evidence supports the need. No stale source is renewed by relabeling it.
4. Complete ETP directory gaps, independent halt evidence, deeper liquidity/partial-fill modeling, source-cited product terms and automated catalyst coverage as separate work.
5. Activate controlled continuous paper operation and collect multi-session, after-cost, untouched/out-of-sample evidence before changing strategies or making performance claims.
