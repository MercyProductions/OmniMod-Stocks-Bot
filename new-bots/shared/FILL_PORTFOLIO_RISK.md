# Shared portfolio revalidation at paper fill — 2026-10-03

Status: implementation and regression checks completed locally; provider-backed operation and strategy performance remain unverified. Final verification details are in `../../review-verification/fill-risk-checkpoint-20261003.json`.

## Confirmed gap

Reservation applied combined portfolio controls, but execution later checked only the queued order and quote. A loss recorded by another bot, a now-stale position mark, or a later reservation using more permissive limits did not prevent the older order filling. Four failing original-source cases are preserved in `../../review-verification/fill-risk-baseline-tests-20261003.log`.

## Current behavior

`paperRisk.js` persists `entryRiskPolicy` when creating a reservation. It contains the originally approved equity basis, position count, total risk, gross exposure, margin, daily loss and open-mark age limits, plus configured closed-trade loss-streak/drawdown limits. The fill path cannot replace this policy with monitor defaults or silently resize the order.

Immediately before a fill, under the shared ledger's existing exclusive lock, the executor checks:

- Valid, consistent equity/risk metadata across the active book.
- Closed-trade accounting and the current UTC portfolio risk day, independently of the original market session date.
- Configured closed-trade circuits and the latest realized/open P&L.
- Fresh marks and available P&L on existing filled/open positions.
- Duplicate/conflicting exposures and directional currency overlap.
- Position, combined reserved risk, gross notional and initial margin ceilings.
- The prospective fill's immediate liquidation loss, spread, and modeled round-trip fees/slippage against the daily loss ceiling.

The existing reservation is counted exactly once. Its reserved risk remains conservative when a limit fill improves. A better short fill can increase gross notional; that increase is checked and retained in the filled record. Other positions retain their existing recorded reservation-notional basis; this is not a new mark-to-market gross-exposure model.

A rejected fill remains reserved, can be retried with later valid evidence, and still expires or responds to the emergency stop. `lastFillRiskCheck` stores the latest check. `fill_risk_blocked` events record reason transitions without appending the same reason on every retry. A successful fill retains `fillRiskEvidence` in the order and event. The quote is not consumed as a fill merely because a risk check was attempted.

Old pending rows without a recorded policy cannot invent one. They can expire/cancel. Already-filled positions retain marking, stop, time and emergency exits without passing new-entry portfolio checks.

## Cross-bot and research integration

All six production owners use the same shared executor. The existing independent position monitor, Stocks/Crypto primary monitor, and Forex/Futures/ETF scanners now supply their real observation clock, complementing the Options clock already present. It is sampled after awaited ledger reads/lock acquisition so stale scan time cannot authorize a late fill. Chronological replay retains its explicit historical clock.

`forwardShadowPaper.js` records the external production-risk reference and mode when it reserves a research order. At subsequent fill attempts the executor reads the current external ledger even with no new shortlist. Mirrored experiments use the worse realized P&L of the two books and exclude their exact matching production order from duplicate active exposure. Independent experiments add their hypothetical realized P&L to production and include the combined closed-trade sequence. Existing active-book exposure checks remain conservative.

Production updates are atomic within their single shared file. A shadow fill uses a fresh external snapshot while holding its own ledger lock; it is not a two-ledger atomic transaction and does not write production. Missing/corrupt external state blocks a fill if that file existed at reservation. If production had never created a ledger at reservation, its absent file retains the existing empty-book convention. Absolute saved references must remain available when moving pending research records to another host; do not rewrite them to silently bypass risk.

Execution version is now `paper-quotes-v10-current-portfolio-risk`. Forward experiment hashes include this version, separating new prospective cohorts. Older records and completed results are preserved. General historical portfolio totals may still span versions; filter by the recorded execution version before interpreting strategy evidence for this change.

## Operator evidence

From `new-bots`, `npm run report:operator` now exposes `portfolio.pendingFillRisk` and corresponding per-bot fields. `policyUnavailable`, `checked`, `blocked` and `reasons` summarize saved pending-order checks. They describe the latest persisted observation, not a fresh risk evaluation or the number of opportunities in the market. Shared and forward-research performance summaries expose the same fields.

The read-only local report at 2026-10-03 19:41:19 UTC showed zero active shared orders and zero pending-risk checks. This cannot verify a real-market fill. Local authenticated provider setup remains incomplete: Alpaca keys for Stocks/ETFs and Options discovery; OANDA account/token; Databento key/entitlements; Tradier token/mode; and applicable paper equity/cost settings. Crypto's configured public fallback is reported separately from evidence of live operation.

## Verification and remaining work

Final `npm run verify:all` from `new-bots` passed **1,827 tests**: 1,133 shared/new-market, 302 Stocks and 392 Crypto. All configured syntax checks passed (350 shared/new-market JavaScript files), plus nine Windows launcher checks. Twenty-nine test cases were added. Focused shared/monitor, operator and Crypto monitor subsets passed 76, 57 and 18 tests respectively.

Tests cover original regressions, all six asset classes, new entry costs, stale/missing marks, close accounting, current UTC loss days, streak/drawdown circuits, tighter saved limits, notional/margin limits, conflicts, valid fills and retained evidence, legacy pending rows, exits, restart reads, external shadow losses/deletion, and operator diagnostics. Monitor tests use synthetic saved policy fixtures; strategy/reservation tests create real approvals and reservations. No provider orders, paid activation, `.env` edits, explicit restart, upload or Discord send occurred. Existing local workers can automatically load changed source.

Next: audit remaining instrument-specific mutable fill assumptions (especially Options Greeks/dividend clearance), preserve observable rejection reasons through deployment, measure entitled provider coverage/latency and collect independent-session after-cost forward/OOS evidence. Native venue margin changes, multi-host coordination and strategy profitability are not established by these local tests.
