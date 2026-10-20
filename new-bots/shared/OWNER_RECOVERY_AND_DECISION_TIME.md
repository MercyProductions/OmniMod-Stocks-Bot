# Owner-scoped recovery and current decision clocks

Verified locally on 2026-10-03. The six-market goal remains active. This phase changes execution correctness; it does not establish provider readiness or strategy profitability.

## Defects established

All six scanners called `recoverPaperOrders` without an owner. That function inspected all active orders in the shared portfolio. Consequently, starting a bot with its local emergency stop enabled could cancel pending entries owned by another bot. It also performed expiration recovery for other owners. This is unintended interference between independently configured processes.

Stocks and Crypto supplied the scan-start timestamp to shared position marking and candidate approval after potentially lengthy data collection and analysis. A quote fetched more than five seconds after that timestamp could be rejected as future-dated even though it was current. Conversely, an early quote could be considered fresh after it had aged during the scan. Stocks also reused the session state from scan start for paper fills.

The shared quote executor selected the first order matching an ID. A malformed/imported ledger containing duplicate IDs could route a mutation to the wrong row. Existing caller-side checks could not protect every path under the ledger lock.

Six new regression scenarios failed on the previous implementation. The baseline, source originals and logs are retained under `../../review-verification/owner-recovery-baseline-20261003` and `owner-recovery-baseline-tests-20261003.log`.

## Implemented behavior

- `recoverPaperOrders({ owner })` validates the owner and inspects only that owner's active orders. All six scanner entry points, primary quote marking, and forward-shadow recovery now pass it. The returned report identifies `scope`, scoped `activeOrders` and `blockedOrders`.
- Omitting `owner` preserves portfolio-wide recovery. The existing operator `recover:paper` command retains its lock check and explicit operator confirmation. A process-local stop is not a substitute for this portfolio-wide operation or enabling the stop in every bot configuration.
- `processPaperQuote` rejects missing/ambiguous IDs and supports `expectedOwner`. These checks execute after acquiring the ledger lock and before cancellation, fill, mark or close. All six scanner quote paths, the separate four-market monitor and the shared shadow runner supply their owner. A manually supplied quote targeting another bot cannot modify that order through these paths.
- `markSharedPaperOrders` reads the current clock for recovery, each quote and final freshness diagnostics. An explicit `now` still supplies deterministic replay/test behavior; an injected `clock` takes precedence. Stocks supplies a session callback evaluated at processing time. Closed-session entries wait; valid open-position exits still follow existing executor rules.
- Stocks/Crypto production candidate creation and reservation use decision time rather than scan start. Their shadow runner uses its existing monotonic observation clock, including the evaluation callback's decision timestamp. Stocks rechecks the session for these candidate decisions.
- Original research feature timestamps, signal levels and entry/exit deadlines are retained. Freshness limits, entry-chase limits, cost assumptions, model gates and portfolio limits remain enforced. A corrected clock can either admit a formerly misclassified current quote or reject one that actually became stale.
- `PAPER_EXECUTION_VERSION` is now `paper-quotes-v3-owner-scoped-recovery`. Existing frozen research machinery separates new prospective cohorts by execution version. No historical results are relabeled as evidence for this change.

## Verification

Focused command from `new-bots`:

```powershell
node --test --test-reporter=tap shared/test/ownerRecovery.test.js shared/test/primarySignal.test.js shared/test/paperPositionMonitor.test.js shared/test/primaryServiceRecovery.integration.test.js shared/test/sixMarketPortfolioLifecycle.integration.test.js shared/test/forwardShadowPaper.test.js shared/test/paperRisk.test.js
```

116 tests passed. Coverage includes all six owner scopes, explicit global stop, byte-preserving rejection of ambiguous IDs, unrelated-order preservation, stale/fresh quote handling after a simulated 80-second scan, session checks, normal paper lifecycles, and real Stocks/Crypto scan entry points in child processes with Discord disabled and provider network deliberately blocked. The latter verifies that restart recovery preserves unrelated pending orders even when market data fails.

`npm run verify:all` passed 1,501 tests: 884 shared/new-market, 268 Stocks and 349 Crypto. All configured syntax checks and nine Windows launcher checks also passed. Evidence: `../../review-verification/owner-recovery-focused-20261003.log` and `owner-recovery-six-market-20261003.log`.

One intermediate focused run had a test expecting a closed-session entry to count as a rejected quote. The executor correctly returns a waiting entry; the assertion was corrected, retaining the check that no fill occurs. No production rule was changed to satisfy that assertion.

## Remaining work

Provider-authenticated operation and account entitlements remain unverified where credentials are absent. Actual `.env` files, running services and hosted deployment were not changed in this phase. No Discord messages, market-data purchases or live orders were sent.

Stocks/Crypto still obtain their shared-ledger position quotes through the full scanner; extending independent quotes-only monitoring remains pending. Crypto's primary shared-ledger bridge still keys its quote map by ticker, unlike the newer exact-pair research path. It needs a separate durable asset/venue/pair audit before independent monitoring is connected. No historical ticker-only record should be silently assigned a venue.

These regressions prove incorrect mechanisms existed, not how many real alerts they suppressed or paper orders they affected. That impact requires source-backed runtime traces and forward observations. The latest four-market idle monitoring results are still zero active positions and zero provider requests; they do not validate feed access.
