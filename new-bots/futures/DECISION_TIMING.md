# Futures decision timing and quote freshness

Status on 2026-10-03: **verified locally; authenticated data, rollout and forward performance remain unverified.** This phase fixes when existing rules are evaluated. It does not lower the breakout, volume, trend, catalyst, contract, liquidity, cost, margin or portfolio requirements.

## Reproduced defects

The runner captured its decision time before awaited provider work. Fresh native quotes received later could look future-dated. It also collected entry quotes before requesting marks for already-owned positions, so an eight-second monitoring request could consume the entry strategy's five-second quote window. Risk approval and reservation reused earlier times across ledger reads. Finally, the strategy refused new entries in the last 30 minutes of its reviewed session, but its candidate did not persist that cutoff; an earlier pending reservation could therefore fill later than the strategy intended.

Two baseline Futures regressions failed before changes. The full workspace run also exposed an Options research clock defect: anchoring elapsed time to a separately captured start could leave its comparison time one millisecond behind a fresh provider timestamp. This was reproduced deterministically rather than dismissed as a flaky test.

## Implementation

- `src/index.js` monitors owned positions first, then performs discovery, history, catalyst work and entry-feed collection. It obtains current times at provider boundaries, each strategy decision and each post-ledger-read risk decision. Shared reservation receives `observationClock: Date.now`, including its check after acquiring the ledger lock.
- Entry risk quote age remains at most the strategy's five-second limit, even if a source configuration allows a longer collection age. A quote expiring while a ledger read waits is rejected. Reordering does not retimestamp quotes, repair incomplete bars or introduce additional provider requests.
- `src/dayStrategy.js` persists the existing session entry cutoff as `entryExpiresAt`. Pending reservations cancel after it; session exit timing remains separate.
- Shadow decisions use the current clock. New cohorts are `future-session-orb-h1-shadow-v3-decision-clock` and `future-session-orb-h1-broad-activity-shadow-v2-decision-clock`. Existing histories remain intact and prior ledgers remain available to the shared monitoring machinery.
- Position coverage is reassessed at reporting time. An accepted mark earlier in a long scan can be correctly reported as stale by the end; acceptance is not a permanent freshness claim.
- The Options runner supplies an explicit current observation clock to independent paper research. Invalid/backward clocks fail closed. Strict rejection of truly future-dated underlying quotes remains. `independentDefinition.decisionClockVersion` changes the prospective experiment configuration hash without mixing the new observations into the prior frozen cohort.

## Diagnostics

Saved Futures diagnostics and `npm run report:operator` expose `bots.futures.decisionTiming`: position-monitor start/end, entry-feed start/end, per-contract decision time, native quote time/age, post-ledger risk time/age, and reservation status/time when attempted. Unknown quote timestamps remain null. `dayTrade.reservationRejected` and structured reservation reasons distinguish a qualified strategy from a later ledger/risk rejection. `positionMarkDiagnostics.assessedAt` identifies the time used for final freshness coverage.

The timestamps diagnose work ordering and aging; they do not prove account entitlement, exchange coverage or execution quality. Native provider evidence and all existing quote checks remain authoritative.

## Verification

From `new-bots`, `npm run verify:all` passed **1,742 tests**: 1,048 shared/new-market tests, 302 Stocks and 392 Crypto. All configured syntax checks passed, including 337 new-bots JavaScript files, and all nine Windows launcher checks passed. Focused Futures tests: **215 passed**. Focused Options independent research/runner tests: **14 passed**. Seven behavioral test cases were added across this phase.

The actual Futures runner is exercised as a child process with synthetic Databento protocol messages and controlled time. Scenarios cover an eight-second position-feed delay, calendar latency before entry acquisition, a quote expiring during a ledger read despite a longer source-age setting, and a successful mark becoming stale during a long scan. Real temporary ledgers verify reservation-time freshness and cancellation after the entry cutoff. Operator propagation and reservation rejection accounting are tested. Options tests reproduce the one-millisecond clock offset, retain future-quote rejection, and exercise freeze followed by a later independent reservation without production writes or Discord publication.

Evidence in `../../review-verification`:

- `futures-decision-timing-baseline-20261003/manifest.json`: preserved originals and SHA-256 hashes.
- `futures-decision-timing-baseline-tests-20261003.log`: original Futures failures.
- `options-observation-clock-baseline-20261003.log`: original deterministic Options failures.
- `futures-decision-timing-verification-initial-20261003.log`: full run exposing the Options defect.
- `futures-decision-timing-focused-20261003.log` and `options-observation-clock-focused-20261003.log`: focused passing suites.
- `futures-decision-timing-verification-20261003.log`: final passing full verification.
- `futures-decision-timing-local-readiness-20261003.json`: read-only local configuration and saved-scan snapshot.
- `futures-decision-timing-checkpoint-20261003.json`: changed-file hashes, results and next steps.

## Actual readiness and remaining work

At 17:37:49 UTC, saved local scans still showed Forex `disabled`, Futures `manual/manual`, Options `manual`, and ETFs/ETPs `manual-fixture`. Their required credentials, paper equity and explicit costs were incomplete. Futures additionally needs selected Live/Historical feed modes and an approved historical cost limit. Stocks had no local saved scan in the report and lacked Alpaca credentials/SIP configuration. Crypto's public fallback was available by configuration, but this report contained no local saved Crypto scan. These are local observations, not a claim about remote deployment or authenticated provider health.

No real environment file, paid entitlement or broker setting was changed, and no explicit restart, remote upload, Discord send or live order was performed in this phase. Existing local workers may load edited source; coordinated rollout remains unverified.

This change does not provide a persistent Databento connection, shared connection coordinator or quote-only refresh after a long shadow pass. Quotes that expire during subsequent work continue to reject. Review observed feed latency and connection contention before adding reconnects: [Databento Live API](https://databento.com/docs/api-reference-live?live=raw) and [connection limits](https://databento.com/docs/api-reference-live/basics/connection-limits?historical=rust&live=rust). No new subscription or connection quota is assumed.

Next work is to verify permitted provider access and precise coverage, finish explicit paper configuration, measure real scan and monitor freshness, and collect independent-session after-cost forward/out-of-sample evidence. Broader engineering work remains possible while credentials are absent. The six-market goal remains active; no profitability claim is supported by these synthetic tests.
