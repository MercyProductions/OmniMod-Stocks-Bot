# Independent Stocks paper-position monitoring — 2026-10-03

Updated by [Stocks native quote evidence](STOCK_QUOTE_EXECUTION_EVIDENCE.md): displayed-size/source checks now apply to the independent adapter and common executor; monitor version is v2. The remainder records the earlier monitor phase.

Status: **verified locally; opt-in, not activated or deployed.** The six-market goal remains active. Observation cadence changes when enabled and requires fresh forward evidence. This phase makes no profitability or full-market coverage claim.

## Observed bottleneck and implementation

`src/index.js` previously built shared execution quotes from `scored` assets inside `runGuildScan`, after acquisition and scoring. Its active-tracker scheduler calls that same scan and obeys the same per-guild running lock. Slow scans delay observations; orders absent from the asset pool receive no mark. Older shadow profiles can also outlive the current shortlist.

Stocks now reuses the four newer bots' owned-ledger worker and executor, with a separate Stocks adapter/supervisor. Three baseline regressions failed because the worker did not support Stocks. The implemented flow:

1. Read the common production ledger and matching `stocks-…-<16 hex>.json` shadow books in both default/configured folders. Inventory all active owned stock orders, independent of watchlists or ranking. Empty books cause no provider work or ledger creation.
2. Cancel owned expired reservations and reservations under the existing emergency stop. Preserve other owners and open positions requiring valid exit prices. Ambiguous order IDs are quarantined before mutation.
3. Use complete bot-level Alpaca credentials; otherwise resolve one unambiguous complete pair from configured guilds. Incomplete/conflicting saved credentials are reported, never guessed. Legacy orders lack an account-routing key. Reports never print credential values.
4. Fetch the provider clock/current U.S. calendar, then current bid/ask quotes for deduplicated symbols in sequential batches of at most 100. Process every batch; 100 is request size, not a total-position cap. No directories, histories, indicators, news or broker order endpoints run.
5. Reject absent/malformed/crossed prices, stale/future observations, wrong market dates and invalid/stale session evidence. Recheck marks after collection. Count failed batches while retaining independent successful ones. Ignore unrequested symbols.
6. Route quotes to their exact book/order through `processPaperQuote`. Existing locking, ownership, duplicate/out-of-order checks, costs, risk and later-quote execution remain authoritative. A copied UUID cannot redirect another book's mark. Recheck regular-session entry permission at processing time.

Already-filled positions retain the existing Stocks ability to use fresh same-day bid/ask exits outside the regular session. Delayed quotes, last trades and cached closing prices cannot supply an exit. Missing/invalid calendar evidence leaves positions unresolved. This does not independently prove halt status or executable size.

## Free / paid data

Preserves `ALPACA_DATA_FEED`: current `iex` or entitled `sip`; rejects `delayed_sip` and unsupported feeds. IEX is explicitly `single_venue`, SIP `consolidated`. No silent paid upgrade or Yahoo-to-executable conversion occurs. ETFs retain their separate SIP requirement.

Alpaca's [latest-quotes endpoint](https://docs.alpaca.markets/us/reference/stocklatestquotes-1) documents batched bid/ask and feed selection. Its [FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) distinguishes free IEX from entitled current consolidated data. This adapter retains the repository's v2 session APIs, documented for [clock](https://docs.alpaca.markets/us/v1.1/reference/getclock-1) and [calendar](https://docs.alpaca.markets/us/v1.4.2/reference/getcalendar-1), including early closes. Documentation is not evidence of this account's access.

Existing `shared/alpacaHttp.js` supplies retries, 429 cooldowns and per-attempt telemetry. Its gate is process-local, not an account-wide quota guarantee. One quote batch without retries costs three requests; an idle pass costs zero. The separate worker adds traffic and has a 60-second deadline, not a guaranteed market latency.

## Operation

From `stocks-bot`, run `npm run monitor:paper`. This is an actual local paper-lifecycle pass, not a dry-run or broker order. It saves `paper-position-monitor.json` in the configured Stocks data directory. Exit codes: 0 complete/idle, 2 degraded, 1 configuration/integrity failure. Idle means only that the worker ran.

Optional ignored `.env` setting: `PAPER_MONITOR_INTERVAL_SECONDS=60`. Default 0 disables scheduling; enabled values are integers 60–900. Existing Stocks precedence also accepts the `STOCKS_PAPER_MONITOR_INTERVAL_SECONDS` process override. Restart Stocks after configuration changes.

On Discord readiness, the supervisor starts a separate child and schedules another pass after completion plus the interval. It cannot overlap its own monitor; shutdown waits for it. App policy, feed, bot credentials, data directory and cadence are pinned into the child environment, rather than silently reloading changed settings each pass.

The worker creates no signals, reservations, experiments, Discord messages or models. It does not write the legacy tracker; normal scan reconciliation updates that later, so Discord outcomes can still wait for a scan. It handles shared production/forward-shadow books, not legacy counterfactual/investment journals. The scanner still performs its existing marks; timestamp/ledger guards handle overlapping observations.

`npm run report:operator` from `new-bots` shows Stocks monitoring separately from discovery: positions, missing/duplicate/processed quotes, fills, closes, cancellations, provider requests/failures/latency, rejection reasons and feed scope. Heartbeats include the monitor child/scheduler. An idle monitor is not counted as a working scanner.

## Research and files

Stocks shadow version: `stocks-intraday-paper-v3-owned-monitor`. Experiment manifests receive resolved local cadence explicitly, use adapter `stock-owned-quotes-v1-batched-native`, and hash the execution feed. Changing cadence/feed creates a new prospective cohort. Existing orders still receive new observations without rewriting earlier fills. Activation can affect old open cohorts; record activation/manual runs and do not treat those cohorts as untouched comparisons.

- `stocks-bot/src/paperPositionMonitor.js`: credential resolution, effective configuration, wrapper and supervisor.
- `stocks-bot/scripts/monitor-paper.js`: one-shot entry point.
- `new-bots/shared/stockPositionQuotes.js`: current quotes/session checks.
- `shared/paperPositionMonitor.js`, `marketPositionQuotes.js`: owned-book routing and limits.
- Stocks `config.js`/`index.js`, shared monitor profile/forward tracker/operator report: integration.

## Verification and actual local state

- Baseline: **3 regressions failed**; preserved originals in `review-verification/stocks-position-monitor-baseline-20261003`.
- Focused: **95 passed** across adapter, lifecycle, primary recovery, supervisory runtime, forward profiles and reporting.
- `npm run verify:all`: **1,561 passed** (920 shared/new-market, 274 Stocks, 367 Crypto), configured syntax checks and **nine Windows launcher checks**.
- Cases include 205 distinct symbols without truncation, old books/repeated symbols, missing credentials, delayed feeds, slow batches, 403s, invalid prices, session close, emergency stops and ownership. The real child test uses isolated temporary ledgers/shadow folders, completes an idle pass and stops without Discord or network access.
- Actual local `npm run monitor:paper`: **idle; one production path checked; zero active orders, requests, fills, closes or cancellations**. Emergency stop remained on.
- Read-only readiness: **Alpaca credentials missing; feed IEX; monitor interval 0; emergency stop true**. Authenticated quotes could not be verified. No service restart, hosted upload, actual `.env` change, paid activation, Discord message or live order occurred.

Logs under `review-verification`: `stocks-position-monitor-baseline-tests-20261003.log`, `stocks-position-monitor-focused-20261003.log`, `stocks-position-monitor-six-market-20261003.log`, and `stocks-position-monitor-local-idle-20261003.json`/`.log`. The structured checkpoint retains source hashes and remaining work.

## Remaining limitations

Authenticated data/session access, account-wide request budgeting, hosted supervision and multi-session forward outcomes remain unverified. IEX does not establish consolidated availability, depth or achievable fills. The inherited stock fill model lacks partial fills, queue priority, displayed-size constraints and calibrated market impact. Polling cannot recover unseen intrapoll target/stop order. Shared ledger events do not preserve all stock quote provenance; stronger evidence is still needed for performance comparisons.

Crypto's independent monitor still needs refreshed venue identity and timestamped Kraken quotes. Native non-USD conversion remains pending. The four newer bots still need provider credentials/entitlements and continuous forward validation. No strategy or risk thresholds were loosened here.
