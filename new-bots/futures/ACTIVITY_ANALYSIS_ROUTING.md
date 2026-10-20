# Futures activity-to-analysis routing — developer handoff, 2026-10-03

This phase connects broad activity discovery to bounded detailed analysis. It is opt-in and has been exercised with fully intercepted provider transports. Actual account-backed operation, market coverage, forward performance and deployment remain unverified. Nothing in this phase enables live orders or purchases data access.

## The observed bottleneck

The directory and minute-bar activity screen could discover a contract outside the 36 configured context priorities, but `src/index.js` passed only `FUTURES_DAY_SESSION_FILE.dayTrades` into H1/live data and the opening-range strategy. Broad activity ran after Discord delivery and could never generate an additional strategy input.

The default behavior is preserved. `FUTURES_ACTIVITY_ANALYSIS_ENABLED=false` still runs optional broad research after monitoring/strategy/delivery. With the flag explicitly enabled, broad research runs after directory/context and before H1/live analysis. This changes candidate selection, request timing and budget allocation; it requires forward paper comparison before wider use.

## Implemented flow

Current complete dataset directory → completed-minute broad screen → dynamic shortlist → exact reviewed-metadata join → bounded H1 history → live session replay and executable quote → existing ORB strategy → existing shared paper risk → reservation/delivery/monitoring.

`activityAnalysisRouting.js` joins dataset, publisher, instrument ID and exact raw symbol, then checks root, exchange and expiry against the current directory. IDs are not borrowed from a previous date. It requires operator-reviewed active-contract metadata, a current sourced session, reviewed settlement/first-notice terms and entry buffer, explicit costs, and positive consistent tick/multiplier/margin values. Provider tick/multiplier values must agree with reviewed values. Unknown or non-USD provider currency is rejected because this paper adapter accounts in USD; discovery still records those contracts.

The review pool supplies **metadata eligibility**, not the scan universe. Only contracts selected by the current activity screen can be added. Missing reviews, identity conflicts, stale observations, capacity deferrals and downstream failures remain visible. Review files cannot supply prices, bars, provider success flags or looser strategy parameters. Only explicit cost reserves are carried into the added row's configuration. The H1 and live adapters must fetch and validate the market data. Added rows without complete H1 input skip the live session request.

Existing configured day inputs retain their order. A discovered raw symbol already present there is counted as already configured; it is not inserted twice. Ambiguous directory symbols, duplicate review keys/contract IDs and conflicting configured IDs are rejected. Added rows default to at most ten, with a hard ceiling of 100 combined inputs matching the live adapter. This bounds detailed work after discovery; it does not hide additional references or claim they were deeply analyzed.

All original strategy thresholds, fees, quote checks, depth/sizing checks, exposure limits, loss limits, duplicate protection and emergency stop remain in force. Routing is not approval. A strategy candidate is not a fill. The live order route remains absent.

## Configuration and review format

From the Futures project, use the existing provider setup and review workflows described in its README. Required routing settings:

```dotenv
FUTURES_CONTRACT_DISCOVERY_ENABLED=true
FUTURES_CONTRACT_DISCOVERY_SCOPE=dataset
FUTURES_ACTIVITY_DISCOVERY_ENABLED=true
FUTURES_ACTIVITY_ANALYSIS_ENABLED=false
FUTURES_ACTIVITY_REVIEW_FILE=
FUTURES_ACTIVITY_MAX_ANALYSIS=10
FUTURES_TREND_DATA_SOURCE=databento-historical
FUTURES_DAY_DATA_SOURCE=databento-live
FUTURES_MAX_SCAN_COST_USD=0
OMNIMOD_EMERGENCY_STOP=true
OMNIMOD_LIVE_TRADING_ENABLED=false
```

These examples remain disabled. An authorized credential/entitlement, explicit positive download allowance and completed reviews are prerequisites. No real `.env` was changed. The existing paid profile does not silently opt into this behavior change.

The review file uses the existing compiled day-session shape: `schemaVersion: 1`, `sessionDate`, and `dayTrades`. Each eligible row has `preparationStatus: "operator_reviewed_paper_input"`, `contract`, `session`, `catalystReview`, and `config` with both cost reserves. Contract identity must include `providerDataset`, `providerRoot`, `providerPublisherId`, `providerInstrumentId`, `providerRawSymbol` and `providerExchange`. New draft/compiler output preserves dataset/root from provider definitions and prevents the approval object from overriding them. Old review files lacking these fields cannot silently match.

The existing draft tool still requires product metadata in its review registry. Unknown-root metadata preparation is not automated by this phase. A reviewed pool can cover additional roots without adding them to the context priority list or hardcoding scanner symbols. Every newly discovered contract lacking this review remains in the broad archive and is explicitly rejected at routing. Session and catalyst reviews expire; a one-time static file is not permanent clearance.

Review loading is bounded to 8 MiB and 10,000 records, with schema validation and a content SHA-256. Missing, unreadable, malformed and oversized files produce explicit blocked routing. No review file is executed. Unrelated configured inputs continue through their original path.

## Evidence and observability

`funnel.activityAnalysis` records shortlist, pool, configured-input, metadata-ready, selected, rejected, deferred, detailed-input, data-ready, strategy-qualified, risk-approved and reservation counts. Per-candidate routing decisions and downstream reasons are retained in scan diagnostics. `/futures scanstats` includes compact routing counts/reasons alongside the broad directory and activity counts. Public embeds describe how many activity candidates reached analysis; they do not label raw activity as profitable or approved.

Each selected input carries the exact date-scoped identity, routing version/cohort, rank/time, directory fingerprint, activity source/configuration hashes, activity archive path, review-file hash and reviewed-metadata hash. Day results retain this provenance. Candidates carry it under `future.discovery`; the paper ledger's existing future-metadata copy preserves it on reservation. `researchContext.discoveryVersion` supports cohort labels through the existing context normalizer. Full review contents are not copied into public messages. Retain the source review files and provider archives alongside long-term evidence; hashes alone cannot reconstruct deleted inputs.

When enabled, forward comparisons use the separate `future-session-orb-h1-broad-activity-shadow-v1` experiment version and a hash incorporating discovery capacity/window settings. Disabled scans retain the prior experiment version/configuration. Use `OMNIMOD_FORWARD_SHADOW_STATE_DIR` to isolate evaluation state. The actual paper strategy ID and idempotency key are unchanged so discovery cannot bypass duplicate-position protection.

The single existing historical cost allowance is shared across directory, context, activity and H1. A remaining zero allowance can reuse a valid H1 cache, but cannot authorize a new download. Activity can now consume allowance before H1 when opted in. This is an estimate cap, not an account-wide spending limit or invoice. Stage timings and provider counters remain recorded.

## Verification and limits

Seven original files and 14 passing baseline tests were preserved under `../../review-verification/futures-activity-routing-baseline-20261003`. Focused tests cover unchanged default delivery order, new-root routing, identities, stale data, missing/duplicate reviews, contract terms, session/catalyst/cost checks, review-file limits and capacity.

The full-runner fixture has two non-priority roots and no configured day trades. It observes and shortlists both, routes the one reviewed contract, records the other as missing review, requests only the selected symbol's H1/live data, and reaches the unchanged ORB strategy. The emergency stop rejects its reservation and leaves the isolated ledger unchanged. Live failure and historical budget exhaustion also prevent strategy approval. In a separate fully intercepted fixture state with sufficient simulated equity, one paper reservation persists the provenance and a repeat scan creates no duplicate. These are software tests, not real trades or market observations.

A real read-only preflight at **2026-10-03 09:29:55 UTC** returned `credentials_missing`: zero provider requests, zero paid downloads, unknown coverage. There is no integrated permanent free live Futures feed. Offline/manual fixtures cannot establish operational live coverage. Final verification: 39 focused tests; latest suite totals 1,440 tests (837 shared/new-market, 268 Stocks, 335 Crypto), configured syntax checks and nine Windows launcher checks. The full all-bot command passed before an additional compiler identity regression; the final workspace suite and focused checks then passed with that regression included.

Remaining: authenticated directory/activity/history/live measurements; review of newly discovered roots and broker terms; non-USD accounting/conversion where needed; measured provider cost/latency at scale; independently scheduled position monitoring; preserved multi-session forward/OOS evidence; hosted deployment. The opt-in adds a bounded activity request before existing monitoring/delivery, so its latency must be measured before routine operation. No profitability claim or strategy promotion is supported by these fixtures.
