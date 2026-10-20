# Options pending-entry evidence — 2026-10-03

Status: verified locally; authenticated provider operation and forward/OOS validation remain pending. This phase changes prospective paper-fill eligibility. It is not evidence of profitability or a reason to enable live trading.

## Problem and change

A pending debit vertical previously filled from its premium bid/ask alone. The underlying could have crossed its original target or invalidation, or a catalyst review could have been revoked since reservation. Four original-source failures are recorded in `../../review-verification/options-fill-evidence-baseline-tests-20261003.log`.

New reservations freeze an `option.entryValidation` policy alongside the original `primaryHypothesis`. At fill time the shared executor requires contemporaneous evidence for the same underlying and the same two OCC contracts. It checks native bid/ask timestamps for all three instruments, synchronized prices, leg liquidity/spreads, composite arithmetic, session, original source age/entry zone, and current configured catalyst clearance. Underlying target/invalidation crossings cancel the pending order when supported by valid evidence. Independent ORB research additionally requires the frozen opening-range and VWAP condition to remain intact. No replacement contract or shifted target is selected.

The current clock is checked again after acquiring the paper-ledger lock. A quote that aged or an entry window that expired while waiting cannot become a fill using the earlier scan time. Successful fills persist their exact evidence in the order and fill event.

## Code and flow

- `../shared/optionHypothesis.js` owns the immutable source contract. `src/primaryHypothesis.js` preserves the prior import contract through a re-export.
- `src/strategies.js` freezes entry rules; `src/signalSources.js` preserves the underlying invalidation where supplied.
- `src/pendingEntryReviews.js` rereads current reviews for pending orders independently of the current shortlist. Manual primary mode can reread the input session file. Independent research rereads `OPTIONS_CATALYST_REVIEW_FILE` (default `examples/catalyst-reviews.json`), even when discovery supplied no new candidates.
- Finnhub, Alpaca and combined catalyst modes reuse their existing read-only adapters. Failed, missing, expired or duplicate clearance never falls back to the reserved review. Requests are bounded by an eight-second review budget and existing rate coordination. Reopening a manual review file does not renew its original `reviewedAt`.
- `src/tradierMarketData.js` adds the underlying to batched pending-spread quotes and attaches native leg evidence. Filled positions need only their existing exit marks. Reviews precede quote acquisition so waiting for a review does not age an already collected entry quote.
- `../shared/optionEntryEvidence.js` performs the shared pure fill checks. `../shared/paperRisk.js` applies them only to pending Options entries; `../shared/forwardShadowPaper.js` carries the post-lock clock into research execution.
- `src/index.js`, `src/independentPaperResearch.js` and `src/replay.js` use the same entry-evidence contract. Replay requires native side timestamps in supplied snapshots; it does not manufacture them from receipt time.

## Compatibility and operations

Primary/replay strategy is `underlying-confirmed-debit-vertical-v3`; independent research is `independent-orb-debit-vertical-v3`; primary shadow cohorts use `underlying-confirmed-debit-vertical-shadow-v6-entry-evidence`. Entry evidence is `option-entry-evidence-v1`. Prior records remain distinct and preserved.

Old pending records without a frozen entry policy cannot newly fill. They can expire or be cancelled by the emergency stop. Already-filled positions retain quote-based marking and exits without new-entry catalyst/underlying evidence. The monitoring adapter exposes `pendingEntryChecks`, `pendingEntryReady` and `pendingEntryRejections`; provider-ready evidence is not itself a fill or risk approval.

All six native quote sides must be at or after reservation and clearance-check time. The source entry window remains at most 120 seconds. Infrequent quotes or scheduler intervals longer than that window can legitimately leave an order unfilled. This phase does not relax those controls. A mixed batch of pending and filled orders can incur up to the bounded review wait before its marks are fetched; real latency has not been measured.

## Verification and limits

Final `npm run verify:all` from `new-bots` passed 1,798 tests: 1,104 shared/new-market, 302 Stocks and 392 Crypto. All configured syntax checks passed (348 shared/new-market JavaScript files), plus nine Windows launcher checks. Thirty focused integration tests passed after the final changes. There are 21 additional test cases compared with the previous full baseline.

Tests include actual child scanners, temporary persisted ledgers, quote refresh after source acquisition, lock delays, review revocation, target/stop crossings, underlying identity/quote failures, successful retained fill evidence, independent monitoring without a shortlist, chronological replay and six-owner recovery. They use synthetic responses and perform no broker orders. Older shared fixtures now use actual strategy-produced Options candidates and full quote evidence. An initial concurrent request-budget test failed once with storage unavailable; isolated and both later full-suite executions passed that test. The underlying transient storage cause was not established and no rate-control bypass was added.

Read-only local inspection at 2026-10-03 19:12:13 UTC found Options still in manual mode with zero primary signals, missing Tradier token/mode, paper equity and explicit costs. No authenticated provider probe, real configuration change, explicit restart, deployment, paid activation, Discord send or live order was performed. Existing local scheduled workers can load edited source automatically.

Next engineering audit: assess whether other reservation assumptions require fresh fill-time evidence, particularly configured Greeks/dividend controls and intervening portfolio/loss changes. This phase does not claim every original strategy/risk gate is re-evaluated at fill. Account entitlement, real coverage, quote latency and independent-session after-cost forward/OOS evidence across all six bots remain unverified.

Checkpoint: `../../review-verification/options-fill-evidence-checkpoint-20261003.json`.
