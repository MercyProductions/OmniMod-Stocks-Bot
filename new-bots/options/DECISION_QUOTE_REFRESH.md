# Options decision-time quotes

Status on 2026-10-03: **verified locally; provider authentication, market coverage and forward performance remain unverified.** This phase repairs timing and stale-data handling in the primary-signal Options path. It does not relax strategy, identity, spread, liquidity, catalyst, cost or portfolio requirements.

## What was wrong

The primary runner fetched underlying quotes, then option expirations/chains, dividend data and existing-position marks. A valid underlying quote could expire before strategy evaluation, or no longer be synchronized with the later option legs. Source inspection also found that reservation used a time captured before awaiting the shared ledger; it did not supply the shared executor's optional current observation clock. Diagnostics omitted reservation-stage rejection reasons.

Two actual-runner baseline tests reproduced the consequences: a 15-second chain fetch rejected an otherwise qualifying setup as a stale underlying, and a quote that expired while reading the locked ledger still produced a reservation. The original failing log and original files are preserved in `../../review-verification/options-decision-quotes-baseline-20261003` and `options-decision-quotes-baseline-tests-20261003.log`.

## Current flow

1. Load/map the existing primary signals and monitor owned paper positions before collecting new entry data.
2. Collect the existing catalyst, chain and dividend evidence. Independent broad underlying/contract discovery remains separate and later in the runner.
3. `src/decisionQuotes.js` reuses very recent synchronized quotes; otherwise it refreshes the underlying and already-downloaded standard contracts of the appropriate call/put type. It does not request new expirations, repeat full chains or download history.
4. Run the complete existing option strategy at current time. Read the current shared portfolio again, apply risk rules and reserve with a clock checked after the ledger lock.
5. Reuse the same refresh for shadow profiles, which each rerun their full configuration at current time. Provider errors are not retried independently for every profile. Native marks for existing shadow positions continue through their existing separate path.
6. Reassess position freshness/expiry at report time and persist collection/decision diagnostics.

The refresh uses the documented read-only [Tradier quotes endpoint](https://docs.tradier.com/reference/brokerage-api-markets-get-quotes). Each request contains up to 39 contracts plus its underlying, preserving URL bounds without a hidden total-contract truncation. All requests use the shared Tradier budget. There is one refresh attempt per input per scan, one eight-second refresh window shared across production/shadows, bounded two-second pacing waits and up to five seconds per underlying HTTP fetch, clipped to remaining time. Request pacing or slow collection can legitimately exhaust the window and reject the input. These bounds do not imply a whole-run latency guarantee.

## Evidence that remains mandatory

Every returned option must match its exact OCC identity, underlying, expiry, type, strike and standard multiplier. Missing/duplicate/conflicting identities cannot inherit the old quote. Current volume and open interest must be present; old liquidity values are not substituted. Native bid/ask times, side skew, cross-leg skew and quote age remain authoritative. Earlier batches are rechecked after later batches complete. Failed requests, local deferrals and stale results cannot fall back to old executable data.

The refresh retains the input's target and entry zone; a moved price must still pass the full strategy. It also preserves the upstream observation time and enforces at most the existing default two-minute primary-signal window, including during shadow reuse. Missing required dividend coverage skips refresh spending and remains a strategy rejection. Sandbox/manual data cannot become executable production quotes through this helper.

Execution timing changes can change the resulting sample even though thresholds were not loosened. The prospective primary shadow cohort is now `underlying-confirmed-debit-vertical-shadow-v4-decision-quotes`. Prior histories remain intact. Independent Options research retains its separately versioned experiment from the preceding phase.

## Diagnostics and verification

Saved scans and `npm run report:operator` expose `bots.options.decisionQuotes`: observed/reused/refreshed/rejected/skipped inputs, requested quote batches/contracts, refresh duration, per-underlying source ages, contract rejection details and structured failure reasons. Requested batches are distinct from actual HTTP attempts: the normal provider telemetry reports actual requests and local budget deferrals. The funnel now includes `reservationRejected`, and top reasons include reservation errors. Position reports include `assessedAt`.

`npm run verify:all` from `new-bots` passed **1,761 tests**: 1,067 shared/new-market tests, 302 Stocks and 392 Crypto. All configured syntax checks passed, including 340 new-bots JavaScript files, and all nine Windows launcher checks passed. The initial focused Options suite passed 168 tests; two more direction/session regressions were then added and included in the final full run. The final focused new-behavior suite passed **19 tests**.

Coverage includes actual runner subprocesses with controlled provider delay, delayed locked-ledger reads and existing-position monitoring order; quote reuse; 80-contract batching; expiration during collection; deadline and quota failures; contract identity mismatches; unavailable liquidity; target/zone preservation; bearish puts; session changes; source-signal/catalyst age; invalid clocks; required dividend blocks; and saved-diagnostic propagation to the operator command. All market responses are synthetic. An older integration fixture now supplies option quotes as well as underlying quotes for the added request path; its dividend and Greek rejection assertions remain enforced.

Logs: `../../review-verification/options-decision-quotes-focused-20261003.log`, `options-decision-quotes-behavior-20261003.log` and `options-decision-quotes-verification-20261003.log`. The earlier failed focused run is retained separately. Originals, changed-file hashes and the patch are indexed by `options-decision-quotes-checkpoint-20261003.json`.

## Actual operation and remaining work

The read-only local snapshot at 18:03:26 UTC found a latest Options scan at 18:02:43 UTC using `manual`, with zero refresh observations. The existing worker had loaded the new diagnostic fields. `TRADIER_TOKEN`, paper equity, explicit fees/slippage, Tradier source selection and production market-data mode remain incomplete. No authenticated request or entitlement was tested. A zero-result manual scan is not evidence that the options market has no opportunities.

No real environment file, entitlement or broker setting was changed. No explicit restart, remote deployment, Discord message or live order was initiated in this phase. Local workers can reload source; coordinated deployment remains unverified.

Remaining work includes legitimate provider setup, authenticated coverage/freshness/latency measurements, and continuous after-cost forward/OOS evidence. The initial acquisition adapter still has its pre-existing target-rebasing behavior; this new refresh does not rebase again. Audit that behavior and persistence of original primary-hypothesis expiration into pending orders separately. This phase does not add a streaming service, contract-depth fill model, whole-account external-application quota coordination or a validated profitable strategy. The six-market goal remains active.
