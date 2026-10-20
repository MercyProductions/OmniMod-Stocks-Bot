# ETF/ETP decision-time quotes — 2026-10-03

Status: implementation verified locally; all 1,701 workspace tests, configured syntax checks and nine Windows launcher checks passed. Authenticated operation and forward performance validation remain pending. The six-market goal remains active.

## Observed causes

1. The adapter acquired snapshots concurrently with history, but validated the quote timestamp only after all historical bars had downloaded. A quote valid at receipt could expire during the download and disappear before strategy evaluation. Optional time-of-day volume history could age it further.
2. The runner reused one decision timestamp across candidates and awaited reservations. Shared reservation checked freshness before acquiring its ledger lock, allowing an approved quote to age while waiting.
3. ORB rejected new decisions during the final 30 minutes of a session, but its candidates did not carry an entry expiry. A previously reserved order could consequently fill after that cutoff.
4. The adapter omitted reviewed ETP classification URL and timestamp when constructing strategy inputs. The strategy correctly rejected those incomplete inputs even when discovery had accepted the source review.

Three original regression failures and a separate classification-propagation failure are saved under `../../review-verification/`. These demonstrate software defects. They do not establish how many real opportunities were missed, or whether additional entries would have been profitable.

## Changed path

| Component | Responsibility |
| --- | --- |
| `src/alpacaMarketData.js` | Timestamp snapshot receipt; retain only quotes valid at receipt as dated research inputs; pass a current observation clock into broad screening; preserve ETP classification evidence; expose ages after detailed data and optional volume-profile work |
| `src/decisionQuotes.js` | Reuse fresh native quotes or fetch quote-only updates for the already selected pool; retain original bars, reviews, classification and timestamps |
| `src/entryWorkflow.js` | Refresh before qualification, recheck each row after earlier reservation waits, re-evaluate the full strategy and risk decision before reserving |
| `../shared/paperRisk.js` | Optional `observationClock` rechecks quote, entry/exit deadlines and applicable crypto metadata after acquiring the ledger lock and reading current portfolio state |
| `../shared/forwardShadowPaper.js` | Forward an explicitly supplied current clock into reservation; preserve a singular reservation rejection reason in research diagnostics |
| `src/strategies.js` | Carry the existing session close-minus-entry-buffer rule into `entryExpiresAt` |
| Scan/operator diagnostics | Preserve collection ages, refresh requests, refresh/reuse/rejection counts, per-symbol reasons, current decision ages and reservation failures |

A fresh quote cannot renew historical bars or catalyst/classification reviews. Stale completed bars, ambiguous symbols, missing/malformed native evidence, wrong feeds, closed sessions and provider failures still block. The full opening-range/VWAP/volume logic, costs, stop distance, spread, concentration, shared exposure, stale-position marks and loss controls still apply. A price change causes full strategy and sizing/risk recomputation; the code does not edit an already-approved candidate in place.

## Bounded provider work

The adapter uses Alpaca's documented latest bid/ask endpoint with explicit `feed` and USD. The comma-separated symbol parameter supports batching; 100 symbols per local batch is an engineering choice, not a claim of an API maximum. No history is downloaded by the refresher. [Official latest-quotes reference, checked 2026-10-03](https://docs.alpaca.markets/us/reference/stocklatestquotes-1).

The workflow permits at most eight seconds of cumulative quote-refresh work by default, excluding unrelated ledger waits; a stricter injected test policy is supported. Each call uses the remaining budget, a maximum two-second shared-budget wait, a five-second-or-smaller HTTP timeout, and one attempt per batch. Every request uses the existing shared Alpaca REST gate. Provider errors stop later batches; unsuccessful rows are not retried individually in the same workflow. Reported remaining quota of five or less defers subsequent batches. Exhausting this local budget can leave candidates unresolved; it never permits old-quote fallback.

Fresh rows can still be reused with zero remaining request budget. Prior fresh quotes that age while another reservation waits are checked again. Entry reservation can still fail if a quote expires during its own ledger wait; this is now an explicit rejection, not an assumed fill.

`ETF_ALPACA_FEED=iex` remains reference research and cannot become an executable ETF/ETP quote. `delayed_sip` cannot satisfy the entry path. SIP execution requires legitimate authentication and entitlement. No subscription, entitlement or configured feed was changed by this phase.

## Evidence separation

Prospective forward-shadow versions are now `etp-opening-range-breakout-shadow-v6-decision-quotes` for full-market inputs and `etp-opening-range-breakout-shadow-v4-decision-quotes` for the comparison baseline. Earlier ledgers and histories remain intact. Shadow decisions use the current clock; they do not acquire a new quote separately for every alternative configuration. Later profiles can legitimately reject data that has aged.

`OMNIMOD_FORWARD_SHADOW_STATE_DIR` is now honored by the ETF runner, matching Options. The default is unchanged; isolated integration tests override every writable ledger, shadow, signal and journal path and provide no Discord credentials.

A reservation is still unfilled. Tests exercise a distinct later quote for fill, another later quote for exit, positive fees and slippage, and reconciliation of net versus gross P&L. These synthetic paths verify mechanics, not strategy expectancy.

## Verification and present operating state

- Original baseline: 0/3 passed, with the expected acquisition, entry-expiry and post-lock freshness failures.
- Additional source-classification case failed with a missing source URL before propagation was fixed.
- Focused selection: 65/65 passed, including 26 new behavioral regressions, ETF diagnostics and existing operator tests.
- Full workspace run: `npm run verify:all` passed 1,701 tests (1,007 shared/new-market, 302 Stocks, 392 Crypto), configured syntax checks and nine Windows launcher checks. The Node total includes automatic discovery of the new fixture helper module. The initial full run exposed an integration-test scheduling race and a diagnostics expectation that omitted the new counter; the fixture now synchronizes snapshot receipt explicitly and the assertion includes the field. Earlier failing logs remain preserved.
- All market responses in these new tests are synthetic. The actual runner is exercised as a separate process; no external Discord delivery or broker order occurs.
- Read-only operator snapshot at 2026-10-03 16:13:44 UTC: the latest local ETF scan (16:11:29 UTC) is **manual-fixture**, with 0 configured symbols, 0 usable inputs and 0 reservations. Emergency stop is active. This zero is not evidence of a full-market scan finding no opportunities.
- Local ETF setup still lacks Alpaca credentials, paper equity and explicit ETF fee/slippage reserves. Alpaca source/SIP mode are not configured. The actual shared budget has no observations. This check measured local presence/settings, not provider authentication, entitlement, production-host state or market coverage.

No actual `.env` change, explicit service restart, remote deployment, Discord post, paid activation or live order was performed in this phase. Existing workers can load edited source; the latest local fixture scan already contains the new diagnostics. That does not establish a coordinated rollout.

## Remaining work

1. Local implementation, workspace verification and checkpoint hashes are complete; authenticated runtime verification remains pending.
2. Configure legitimately available provider access and explicit paper-equity/cost assumptions through the existing setup flow; verify account entitlement without purchasing automatically.
3. Run controlled authenticated scans and measure real per-stage universe/candidate survival, ages, latency, quota deferrals and failures. Confirm whether quote aging is materially costly in that environment.
4. Continue shared-budget coordination for other providers. The Alpaca coordinator alone does not coordinate every service or external application.
5. Collect multi-session after-cost forward/out-of-sample evidence before making a performance claim or promoting strategy experiments. Quote refresh and ETP metadata recovery may admit previously lost candidates; the tighter cutoff/locked-time check may reject others.

Checkpoint: `../../review-verification/etf-decision-quotes-checkpoint-20261003.json`. Preserved originals: `../../review-verification/etf-decision-quotes-baseline-20261003/manifest.json`.
