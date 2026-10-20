# Stocks decision-time quote refresh — 2026-10-03

Status: **verified locally; not activated or deployed.** The preceding native-evidence phase made progress. This phase fixes a separate execution-data bottleneck without loosening strategy, model or risk requirements. The six-market objective remains active; continuous provider-backed operation and forward performance are not established.

## Observed causes

`runGuildScan` collected quotes with the initial market snapshot. Portfolio selection then used the scan-start clock after model work. An otherwise fresh quote acquired more than five seconds after that start could look future-dated to `executionEvidence`. Conversely, an early quote could expire during analysis. Shared reservation subsequently reused the same observations after shadow processing and feature persistence.

These are reproducible code paths, not a measured attribution of past missed trades. The current resolved local data directory has zero scan-diagnostic files; credential resolution reports `credentials_missing`. No percentage of historical opportunity loss is claimed.

Regression examples show both causes: a two-minute-old quote fails the existing portfolio gate until a new native observation is fetched; a quote acquired eighty seconds after scan start fails when judged against the start clock but passes the same gate against its actual approval-time clock. These are synthetic fixtures, not actual market opportunities.

## Implemented flow

1. Preserve market discovery, deep data, technical qualification, model decisions and confirmation requirements. After those stages, consider model-approved candidates first, followed by existing model-advisory and confirmation-advisory research candidates. The latter remain shadow inputs and cannot become production approvals through this refresh.
2. Call `refreshStockPaperQuotes` for that qualified pool. Reuse an existing quote only if its native evidence, configured feed, timestamp, symbol and quote conditions pass current validation. Missing, invalid or aged quotes are fetched through Alpaca's batched latest-quote endpoint. Do not download charts, indicators, news or instrument directories in this pass.
3. Reapply the existing research-data freshness rule against the current clock. A fresh order quote cannot renew an expired chart, future-dated chart timestamp, model input or stale marker. Preserve underlying research prices, indicators, model results and their original timestamps; only execution fields are refreshed on immutable copies.
4. Select the portfolio using the current approval-time clock and refreshed spread. Existing model expectancy, cost stress, correlation, sector, capacity, loss and other portfolio rules remain authoritative.
5. Supply refreshed quotes to forward shadows. Keep unrelated active-position quotes from the initial map, but explicitly remove any requested symbol whose refresh failed. This preserves monitoring coverage without allowing a failed refresh to revive an old cached quote.
6. After shadow work and persistence, refresh the production shortlist again only where its quote is no longer valid. Reapply the complete local portfolio selector with current spreads/time before building the frozen plans and requesting shared reservation. Entry windows, reference levels and deadlines retain their existing scan-based construction; neither a new quote nor a retry extends them. Shared approval and later execution independently recheck current data, ownership and risk.
7. Journal the original research observation time separately from the execution quote time. Record acquisition and final-decision ages, both refresh passes, provider telemetry and structured rejection reasons.

The two passes run during the current regular session when shared paper infrastructure is configured. Premarket research, existing session restrictions and the independent owned-position monitor are preserved. A session can close or a quote can age between steps; final approval still rejects it. No promise of atomic market data or guaranteed fills follows from an HTTP response.

## Bounds and provider handling

The [Alpaca latest-quotes endpoint](https://docs.alpaca.markets/us/reference/stocklatestquotes-1) accepts multiple symbols, explicit feed and currency. The implementation requests USD and the configured `iex` or `sip` feed. It never upgrades a subscription or substitutes a different feed after failure. The preceding [native-evidence handoff](STOCK_QUOTE_EXECUTION_EVIDENCE.md) describes single-venue IEX scope, conservative IEX sizes, current SIP share units and condition checks.

- At most 100 symbols per request, sequential batches, no total-symbol slice. A fixture with 250 eligible symbols requests 100 + 100 + 50. These are qualified-candidate counts, not full-universe coverage.
- Eight-second collection budget per pass, up to five seconds per HTTP request within the remaining budget, and up to two seconds waiting for the existing Stocks process-local cooldown gate. There can be two passes; these budgets do not describe total scan duration.
- One attempt per batch. HTTP 401, 403 or 429 stops remaining batches. A 429 defers the same Stocks cooldown gate used by other requests in this process. No immediate retry loop.
- Provider-reported remaining quota of five or less defers later batches in that pass. Missing headers remain unknown. Account-wide quotas across different processes are still unfinished.
- A failed independent batch does not erase another successful batch. Budget, quota, cooldown, missing-symbol and malformed-data deferrals remain explicit. There is no stale-cache fallback after an attempted refresh fails.
- At collection completion, recheck early batches, reused quotes and research-data age. Discard observations that aged out while other requests were running. Timeouts rely on the runtime's abort handling; late results are checked again rather than assumed timely.
- No candidates or a fully current pool cause zero provider calls. Missing credentials prevent new acquisition while already-valid native observations can remain usable until their original expiry.

This adds bounded quote traffic, not a full-market rescan. It does not solve account credentials, cross-process budgets, other provider entitlements, exchange trading permission, complete market coverage or strategy calibration.

## Diagnostics and research versions

`sharedPaperQuoteRefresh` is saved in scan diagnostics, failed-scan context and the daily discovery diagnostics. It contains separate `qualification` and `entry` records plus entry-risk rejections and final decision observations. Each pass reports input rows, unique symbols, refresh need, attempted symbols, request batches, refreshed/reused/current quotes, unavailable symbols, duration, budget, quota remaining and per-symbol reasons. Prior quote age and research-data age remain separate from refreshed quote age.

Refresh failures enter the ordinary structured rejection journal with stage names; final portfolio rejections use `entry_risk_recheck`. The same symbol can legitimately appear at multiple gates. Counts represent gate events, not mutually exclusive whole-market rejection totals.

The Stocks administrator diagnostics embed adds an execution-quote field showing current/refreshed/reused counts, requests and final quote age. The shared operator report retains both passes per instance. No actual Discord message was sent during verification.

Timing now separates model/confirmation and qualification refresh from the remaining portfolio/shadow work. Entry refresh is reported separately; those new intervals are not double-counted in residual persistence time.

- Refresh version: `stock-decision-quotes-v1-batched`.
- Prospective Stocks shadow strategy: `stocks-intraday-paper-v5-decision-quote-refresh`.
- The refresh version is included in frozen shadow configuration. Existing histories remain unchanged.
- Shared executor stays `paper-quotes-v8-stock-quote-evidence`; the independent Stocks adapter stays v2.

Refresh timing can change which real quotes a paper strategy sees, so forward validation is required. Shadow profiles still make their own decisions from the first pass; the production shortlist receives a later recheck. A shadow observation is not proof that an identical production order was posted or filled.

## Verification and limitations

**1,632 tests passed** through `npm run verify:all` from `new-bots`: 940 shared/new-market, 300 Stocks, 392 Crypto, plus all configured syntax checks and nine Windows launcher checks. Focused logs record 37 Stocks tests and 38 shared tests; the additional scan-start/current-clock regression passed in the final full suite.

Coverage includes fresh reuse, two-pass aging, complete batching, clock mismatch, strict native evidence, IEX feed preservation, missing credentials, duplicates, halts, research-data expiry, quota/cooldown/authentication failures, malformed responses, partial batch failure, immutable inputs, no stale fallback, unchanged risk filters, no extended deadlines or chasing, operator reporting and quote-refresh → portfolio → shared reservation → later native-shaped fill/after-cost exit. The integrated lifecycle uses a temporary ledger and synthetic provider responses. It is not a provider-backed forward result or full Discord scanner runtime test.

Read-only actual configuration at 2026-10-03 14:21 UTC: credentials missing, IEX configured, emergency stop true, independent monitor interval 0, no local scan-diagnostic history. No authenticated probe or scan ran. No `.env`, service, deployment, paid activation, Discord post or live order changed.

Evidence: `review-verification/stock-quote-refresh-*`, including four hashed source originals, focused/full logs, source diff, configuration inventory and structured checkpoint.

Next priorities: ETF/ETP native quote-size review; account-wide provider budgets; permitted credential/entitlement and native-feed validation; then controlled continuous paper operation and multi-session after-cost/out-of-sample evidence. Profitability and comprehensive live coverage remain unverified.
