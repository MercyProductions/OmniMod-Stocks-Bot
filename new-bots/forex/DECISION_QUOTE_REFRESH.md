# Forex decision-time quotes — 2026-10-03

## Status

Implemented and locally verified with synthetic provider responses, real child-process scanner runs and isolated paper ledgers. Authenticated OANDA coverage, sustained runtime behavior and forward profitability remain unverified. No live orders are available or enabled by this change.

## Reproduced causes

The runner previously retained full-universe discovery prices while it downloaded four history timeframes for each selected pair. Primary prices and USD conversion prices could expire before later pairs reached strategy evaluation. Its conversion cache never refreshed within a scan. A deterministic child-process test advanced the clock during history downloads: both selected pairs became stale, despite the fixture provider being able to supply current prices.

A separate regression showed a provider cooldown of 60 seconds could delay a later request past its intended two-second waiting limit. The retry limit applied only to the request that received the 429; subsequent requests inherited an unbounded wait.

These are data-acquisition problems, not evidence that the strategy thresholds should be lowered. The two original failures are preserved in `../../review-verification/forex-decision-quotes-baseline-tests-20261003.log`.

## Implementation

- `src/decisionQuotes.js` checks cached pair and conversion prices after the expensive histories return. It reuses prices only within the lesser of 30 seconds or half the configured maximum quote age. Otherwise it retrieves the primary pair and required USD cross together, deduplicating a cross that is also the primary instrument. It does not redownload candles. This is a refresh trigger, not a changed approval threshold.
- OANDA's account [pricing endpoint](https://developer.oanda.com/rest-live-v20/pricing-ep/) accepts a list of instruments and returns source-stamped prices. Source time is retained; response receipt does not make an old quote fresh. The existing account directory determines supported conversion crosses.
- Missing, duplicate, crossed, stale, future-dated and non-tradeable prices cannot authorize an entry. Failed refreshes invalidate the affected cached prices. Unsupported conversion currencies remain blocked. A new quote does not rehabilitate stale history, an expired catalyst review or a failed strategy/risk check.
- Decision-pricing calls have one HTTP attempt, a two-second maximum cooldown wait and a five-second HTTP timeout. A scan has at most one production refresh batch per selected pair, plus at most one additional batch per observation for shadow research. These are per-call bounds, not a whole-scan latency guarantee.
- Shadow profiles share their observation's refreshed data and do not independently repeat failed calls. Each profile reruns the existing strategy at the current clock. Old completed candles retain their original timestamps. The new cohort version is `forex-m15-range-breakout-h1-trend-shadow-v4-decision-quotes`; historical ledgers remain available to the existing monitoring/research machinery.
- `src/providerRequest.js` bounds inherited cooldowns, rechecks extensions after sleeping and fails closed for a stalled clock. It remains an in-process cooldown, not a durable cross-process request budget or a persistent pricing stream. No OANDA quota increase or concurrency increase was introduced.
- Production risk evaluation uses current time. Reservation uses the shared ledger's current-clock check after acquiring its lock. Candidates now retain the existing session entry cutoff. When a provider-stamped conversion price is supplied, the pending-entry deadline is additionally bounded by that conversion's freshness window. Filled positions still use frozen conversion factors; FX conversion movement and broker conversion charges remain an existing modeling limitation.
- `shared/forwardShadowPaper.js` advances its optional observation clock again after asynchronous evaluation, so quote acquisition cannot leave risk evaluation or journals at a pre-request timestamp. Existing historical callers without that optional clock retain their explicit time.

## Diagnostics

Saved scans and `npm run report:operator` expose `bots.forex.decisionQuotes`, with separate production/shadow totals: observations, reused, refreshed, failed, pricing batches requested, cumulative quote-work duration, rejection counts and each pair's before/after source age. Actual HTTP request/error counts exclude local cooldown deferrals; `provider.localDeferrals` records those separately. Structured failures remain in provider telemetry and per-candidate rejection reasons. A successful refresh count does not imply a qualified setup or a simulated fill.

## Verification

`npm run verify:all` passed **1,735 tests** (1,041 shared/new-market, 302 Stocks, 392 Crypto), configured syntax checks and nine Windows launcher checks. The focused `node --test forex/test/*.test.js shared/test/forwardShadow*.test.js` suite passed 111 tests. Fifteen new behavioral regressions were added. Final log: `../../review-verification/forex-decision-quotes-verification-20261003.log`. New checks cover recent-cache reuse; slow-history runner recovery; conversion-side valuation and expiry; missing, duplicate and invalid quotes; source aging during request latency; no stale fallback; bounded/extended cooldowns; no phantom HTTP counts; actual ledger reservation expiry; asynchronous shadow risk/journal time; and top-level operator propagation.

One legacy Yahoo adapter test used a frozen fake clock while simulating sleep. Its fixture now advances time with its fake sleep; permission and retry assertions are preserved. The first focused run stalled on that fixture and was stopped; its partial log is retained. This does not enable automated Yahoo access: the production Forex source still accepts only disabled or OANDA practice modes.

## Local readiness and remaining work

The read-only local snapshot at 2026-10-03 17:10:26 UTC showed Forex's latest saved scan using `disabled` and Futures using `manual/manual`. Forex still lacks OANDA account/token, practice source selection, paper equity and explicit fees/slippage. Futures still lacks Databento credentials, live/history feed modes, approved history cost cap, paper equity and costs. Credential presence was inspected without revealing values; no authentication or entitlement was tested.

No real `.env` was changed, service explicitly restarted, remote package deployed, paid feed activated or Discord message sent during this phase. Existing workers can load edited local source; a controlled rollout is still unverified.

Next: continue reviewing Futures decision/monitor timestamps and data contention; complete legitimate provider setup when credentials are available; measure actual account coverage, latency and freshness through market sessions; collect untouched forward/OOS after-cost evidence. Do not promote any strategy or claim profitability from these infrastructure tests.
