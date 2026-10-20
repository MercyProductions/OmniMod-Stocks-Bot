# Independent paper-position monitoring

Follow-up 2026-10-03: Stocks now reuses this worker with its own quote adapter and supervisor. See `../../stocks-bot/INDEPENDENT_POSITION_MONITORING.md` for verified scope and pending provider validation. Crypto remains pending. Details below describe the original four-market phase.

Implemented 2026-10-03 for Forex, Futures, Options and ETFs/ETPs. The six-market goal remains active. This monitoring path uses existing market-specific quote adapters and the existing shared paper executor. It creates no candidates, reservations, experiments, Discord messages or broker orders.

## Why this was needed

The four newer runners previously monitored positions inside complete discovery scans. Their example scan intervals range from two to fifteen minutes, and some scanners fetch history before monitoring positions. A wide universe scan could therefore delay a paper stop or exit. Faster polling of every indicator would be wasteful.

The new worker reads only active owned paper orders, retrieves their current quotes, then fills, marks or closes them through `processPaperQuote`. It independently monitors production and persisted shadow books, including older profile files and Options' `options-independent` folder. Instruments remain monitored after leaving discovery shortlists. The shared ledger lock and quote timestamps prevent duplicate/out-of-order transitions when scanner and monitor overlap.

## Operator commands

From each of the four bot directories:

```powershell
npm run monitor:paper
```

This is an actual paper-lifecycle pass, not a dry-run. With no active positions it performs no provider work and creates no paper ledger. With an active stop it cancels only that bot's pending reservations and continues to request valid quotes to close its filled positions. A missing feed leaves a filled position unresolved; it does not invent an exit price.

Optional scheduling in that bot's ignored `.env`:

```dotenv
PAPER_MONITOR_INTERVAL_SECONDS=60
```

Default `0` retains scan-only monitoring. Enabled values are integers from 60 through 900. Restart the affected Discord application to load a changed value. No actual environment was enabled in this phase. Configure the authorized market feed and validate it first; account/paid entitlements are not purchased or activated by this setting.

The application supervises one separate monitor child alongside its scanner. A monitor runs at startup and again after each completion plus the configured interval. It cannot overlap another scheduled monitor from the same application. Its 60-second deadline uses the existing graceful/forced child-stop handling; shutdown waits for both children. A stuck or failed scan does not prevent this separate child from running. Polling is not streaming and this is not a maximum-latency guarantee.

## Provider boundaries

| Bot | Required mark source | What is fetched |
| --- | --- | --- |
| Forex | Existing OANDA practice source/account/token | Owned currency pairs through batched account pricing; existing session checks |
| Futures | `FUTURES_POSITION_MARK_SOURCE=databento-live` with licensed credentials | Verified dated contracts through the existing MBP-1 collection; metadata, depth, tick, freshness and transport checks |
| Options | Production Tradier token and primary or independent paper source | Market clock and synchronized option-leg quotes, including descriptive Greeks |
| ETFs/ETPs | `ETF_SOURCE=alpaca`, entitled SIP | Market clock/calendar and bounded snapshots for owned symbols |

No full directories, historical bars, new chains, discovery indicators, catalyst downloads or paid historical queries run in this worker. Existing provider retries and rate-limit handling remain; the monitor adds quote traffic to the account's existing workload. It is a separate process, so process-local pacing is not an account-wide quota guarantee. Provider errors and missing marks remain visible. Sandbox, IEX-only and missing-credential paths cannot become executable fill sources.

## Integration corrections

ETF marks previously returned epoch numbers while the paper lifecycle parses ISO timestamp strings. The new adapter-to-ledger integration test demonstrates a reservation filling and later closing from native-shaped mocked responses. Marks now use ISO times, reject boolean/malformed prices, and recheck quote/session freshness after collection.

Futures marks previously always set `sessionOpen: false`. Newly emitted candidates now retain their already-validated exchange-session window/source/review time in `future.entrySession`. A later mark permits a pending fill only while that same reviewed session and quote are still within its window. Legacy missing, invalid, stale or closed session reviews do not authorize entries; valid quotes can still liquidate filled legacy positions. A session review is not independent proof of a live exchange calendar, and this phase does not replace contract/settlement/catalyst validation.

## Files, ownership and diagnostics

- `shared/marketPositionQuotes.js`: adapter dispatch and common monitoring limits.
- `shared/paperPositionMonitor.js`: owned ledger inventory, recovery, quote routing, transitions and saved report.
- `shared/paperMonitorConfig.js`: bounded opt-in profile and adapter revision.
- `shared/marketDiscordApplication.js`, `marketBotRuntime.js`: separate supervised child.
- `shared/runnerHeartbeat.js`, `operatorReport.js`: monitor runtime and result visibility.

Only the shared production ledger and matching owned shadow ledger files are read. Nonregular matching shadow files are rejected; malformed books and ambiguous owned order IDs are reported without mutation. The existing default shadow folder and configured override are both checked to avoid abandoning old books. Provider IDs are remapped per ledger so an imported UUID cannot direct a quote into another book. Duplicate/unrequested provider marks are quarantined.

`data/paper-position-monitor.json` records the latest pass: owner, timing, active positions, missing/processed quotes, fills, closes, cancellations, rejections, observed request attempts/latency, errors and mark freshness. It contains no token or account identifier. `npm run report:operator` from `new-bots` includes that report separately from scan diagnostics. A fresh idle report is not evidence of functioning market data. Reports older than five minutes are labeled stale; for slower configured intervals interpret that age alongside the scheduler's next-run time.

Forward experiment fingerprints/manifests include the adapter revision and configured monitoring cadence. Changing the cadence starts a new frozen experiment instead of silently pooling future entries with earlier results. Existing positions continue to be monitored; their earlier fills are not rewritten. Manual one-shot calls also affect quote observations, so retain operator logs when assessing monitoring conditions.

## Verification and present limits

Focused verification covers native-shaped ETF and OANDA responses, provider outages, stale quotes, source restrictions, production/shadow isolation, expired/stop recovery, ambiguous IDs, Futures entry-session review and runtime concurrency/shutdown. The application test uses a mocked Discord connection with real child processes; a monitor completes while a scanner remains busy. This is not a hosted or real-market execution test.

Four actual local one-shot invocations on 2026-10-03 all reported **idle, zero active orders, zero provider requests**, with one production-ledger path checked per bot. No ledger was created. The operator report still shows unconfigured scanners. Provider authentication, entitlements, realistic fill calibration, continuous licensed data, multi-session after-cost evidence and hosted deployment remain pending. Stocks/Crypto retain their existing separate monitoring systems; this phase does not replace those paths.

Polling cannot establish intrapoll stop/target ordering, queue priority, partial fills or market impact. A sampled target hit is not a verified real fill. Raw quotes and paper outcomes remain subject to their existing research limitations; no profitability claim follows from these tests.

Verification commands and exact results are recorded in `../IMPLEMENTATION_CHECKLIST.md` and `../../review-verification/position-monitor-checkpoint-20261003.json`. Baseline source copies, focused/full-suite logs and real idle reports use the `position-monitor-*` prefix in that evidence folder.
