# Options original forecast and pending-entry lifetime

Verified locally on 2026-10-03. Provider authentication, real coverage and independent forward/OOS performance remain unverified. Live orders remain disabled.

## Defects reproduced

Initial Tradier acquisition defaulted to rebasing the underlying target by its percentage distance from the reference entry. For a $100 reference and $104 target, a fresh $100.50 quote silently moved the target to $104.52. A bearish $96 target similarly became $95.52 at $99.50. That changes the forecast and can admit strikes beyond its original target.

The reader/refresher checked the original signal's age, but the strategy received the refreshed quote timestamp and emitted no pending-entry deadline. Shared paper execution already supported `entryExpiresAt`; Options never supplied it. An unfilled reservation could therefore survive the source hypothesis. Source entry/exit deadlines were also dropped by the shared research handoff and journal.

Eight original failures and one already-correct filled-position case are preserved in `../../review-verification/options-hypothesis-baseline-reproduced-20261003.log`. Its isolated source tree uses the preserved originals; the working tree was not reverted to run the reproduction. Initial fixture errors were corrected before that reproduction.

## Current contract

`src/primaryHypothesis.js` captures the original symbol, direction, session, observation time, reference entry, absolute target, entry bounds, optional entry/exit deadlines and source identity. Initial acquisition and subsequent quote refresh preserve this snapshot. Fresh bid/ask prices and their native timestamps remain separate from original forecast time. Original inputs are not mutated.

The strategy checks snapshot agreement, current price within the original entry zone, target direction, and source lifetime. Invalid/conflicting metadata fails closed. `OPTIONS_PRIMARY_SIGNAL_MAX_AGE_MS` remains capped at 120,000 milliseconds and can be tightened. A new pending order expires at the earliest of:

- Original observation time plus the configured primary-signal lifetime.
- An explicit source `entryExpiresAt`.
- The earlier of the source `forceExitAt` and the Options session-close exit buffer.

Expiry is exclusive: an order cannot be reserved or filled at the deadline. Native quote freshness, synchronization, standard contract identity, liquidity, costs, catalyst/assignment checks and portfolio rules remain required. Refresh checks the source deadline before requesting data and again after the response. Reservation rechecks it with the current clock after acquiring the ledger lock.

The candidate stores `entryExpiresAt` and `option.primaryHypothesis`. Existing shared reservation persistence retains both, and existing execution/recovery cancels expired unfilled reservations even without a quote. Entry expiry does not liquidate a position already filled; its existing premium target, stop and force-exit rules continue. Existing ledgers were not rewritten or given invented historical source metadata.

The shared handoff and journal now retain optional source entry/exit deadlines. Malformed supplied deadlines are rejected instead of silently omitted. Records without those optional fields remain readable; new Options candidates still receive the bounded default lifetime.

## Versioning and replay

- Primary strategy/replay: `underlying-confirmed-debit-vertical-v2`.
- Primary forward shadows: `underlying-confirmed-debit-vertical-shadow-v5-frozen-hypothesis`.
- Independent ORB option research: `independent-orb-debit-vertical-v2`.
- Source snapshot schema: `option-primary-hypothesis-v1`.

This changes prospective strike selection and entry eligibility. Older performance is not validation of the corrected strategy. Existing shadow infrastructure continues monitoring prior experiment ledgers and blocks overlapping exposure; older results stay separate. Idempotency keys are unchanged so version changes cannot manufacture duplicate same-session orders.

Replay uses the same builder, snapshot and deadline. Supply `context.primarySignalObservedAt` when source and native quote times differ, or retain the acquired `context.signal.primaryHypothesis`. Without an explicit source snapshot/time, `signal.observedAt` is treated as the original hypothesis observation; callers must not relabel an old forecast with each quote's time. No historical signals or evidence were backfilled.

## Verification

- Focused Options plus shared signal/handoff suites: **202 passed**.
- Full `npm run verify:all` from `new-bots`: **1,777 passed** — 1,083 shared/new-market, 302 Stocks, 392 Crypto; configured syntax checks and nine Windows launcher checks passed.
- Sixteen added regressions cover long/short target preservation, shared deadline propagation, exact source expiry, malformed/conflicting metadata, entry-zone checks, tighter age configuration, expiry during quote acquisition and a real scanner's ledger read, persisted cancellation, quote-free restart recovery, continued filled-position monitoring, and chronological replay.
- Tests use synthetic provider responses, real child scanner processes and temporary ledgers. They do not establish real fills or strategy profitability.

At 18:26:30 UTC, a read-only local snapshot found Options still in manual mode with zero primary signals. The existing worker had loaded independent strategy v2. Tradier credentials/source mode, paper equity and explicit fees/slippage remain incomplete; independent discovery also lacks its required provider credentials. No `.env` change, explicit restart, remote upload, paid activation, Discord send or live order was performed in this phase.

## Next work

Audit pending Options fills against a contemporaneous underlying quote and catalyst state. The new deadline bounds age; an option-premium quote alone does not prove the underlying remains inside its entry zone throughout that window. Then verify licensed/authorized provider setup, full-universe coverage, observed latency/quota contention and independent-session after-cost forward/OOS results across the six bots. Do not promote the new cohorts using synthetic tests or old results.
