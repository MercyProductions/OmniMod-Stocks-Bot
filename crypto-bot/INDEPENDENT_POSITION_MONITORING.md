# Independent Crypto paper-position monitoring — 2026-10-03

Subsequent update: [Kraken shared execution evidence](KRAKEN_ORDER_BOOK_EVIDENCE.md) closes the monitor-only liquidity/evidence gap described below and advances the execution/monitor/strategy versions. The verification figures below record this earlier phase.

Status: **verified locally; opt-in, not activated or deployed.** This completes the local independent-monitor integration for the six market owners. It does not establish continuous operation, complete provider coverage or profitable strategies. The overall goal remains active.

## Bottleneck and implemented flow

Crypto previously marked shared paper orders from assets available during its full discovery/analysis scan. A slow scan, a changed shortlist or an expired asset-to-venue identity could leave an existing position without a usable observation. The new worker inventories persisted orders rather than relying on the current shortlist.

1. Read active Crypto orders from the common production ledger and matching older Crypto shadow books in the default and configured shadow directories. Include reserved, filled and open orders. An empty inventory makes no provider requests or ledger file.
2. Recover only owned expired or emergency-stopped reservations. Preserve other owners and open positions that lack a valid exit price. Route each returned quote to its exact book/order, including when two books contain the same UUID.
3. Deduplicate exact saved identities: CoinGecko asset ID, native provider, native pair, base and quote currency. Conflicting asset IDs claiming one venue pair are rejected before requests. Legacy records without identity cannot fall back to ticker matching.
4. Use current saved identity evidence, then an exact-key persistent cache, then the existing complete CoinGecko ticker verification. Refresh must prove the same asset/venue/base/quote association; native product metadata checks the exact native alias separately. Cached evidence keeps its original verification time. Invalid, future, changed or unavailable evidence cannot invent an identity.
5. Fetch current Coinbase/Kraken native product rules using the existing short metadata caches and at most three concurrent jobs. Retain increments, minimum quantities/notionals, active status and freshness checks.
6. Fetch Coinbase timestamped L1 books through the existing paced REST adapter. For Kraken, use one bounded public WebSocket v2 connection with BBO-triggered ticker subscriptions, in batches of 50. Every requested batch is processed; 50 is not a total-position limit. Require an online exchange, exact subscription acknowledgment, bid/ask, positive displayed sizes and a provider timestamp. Recheck freshness after collection and close the connection.
7. Build exact-source executable marks and pass them through the existing locked paper executor. Costs, fractional quantity rules, ownership, later-quote execution, duplicate/out-of-order handling, spread checks and stop/target behavior remain authoritative. Missing prices leave positions unresolved.

Kraken's monitor additionally requires the relevant displayed side to cover the full position quantity: ask for a pending long or open short; bid for a pending short or open long. It rejects insufficient size instead of manufacturing a partial fill. This guard is currently at the independent-monitor boundary. The older full-scan Kraken execution path does not yet persist/enforce equivalent depth evidence; that is remaining work, not a verified universal property.

Only Coinbase/Kraken **USD** routes can reach this shared USD paper accounting. Other assets and currencies may remain discoverable research. USDT is not treated as USD, and funds cannot be assumed to move costlessly between venues.

## Provider behavior and limits

The Kraken collector uses the official [ticker interface](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker), selecting BBO-triggered updates and retaining native price, size and timestamp fields. Subscription acknowledgment time is not a quote timestamp. Its [status channel](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/status) supplies exchange availability. These interface documents do not establish account trading permission or liquidity beyond an observed snapshot.

CoinGecko identity settings support public, Demo and Pro modes. An explicit public selection uses no key. Otherwise the worker uses configured bot credentials or one unambiguous saved configuration. Conflicting saved keys fail explicitly; Pro without a key remains unavailable. An unkeyed Demo configuration can use the existing public fallback. Credentials are resolved only when identity refresh is actually needed and are never printed in diagnostics.

Identity evidence is valid for the existing 65-minute policy and cached under `paper-position-identities/<exact-key hash>.json` in the Crypto data directory. The cache is trusted local provider evidence, not a cryptographically signed directory. Public identity requests retain the existing 20-second pacing and bounded pagination; missing terminal-page evidence fails closed. There is a 90-second budget checked between identity refreshes, with minute-rotated priority so a bad route cannot permanently monopolize the first slot. Cached/current routes still proceed after the budget. An already-started request may exceed that budget; the supervisor has a 240-second hard child deadline.

HTTP attempt/failure/latency counts come from actual provider telemetry; Kraken collection contributes one observed WebSocket session. Latency is summed request/session time, not wall-clock scan time. Process-local pacing does **not** coordinate quotas across discovery workers, monitor children, guilds or external account clients. Account-wide budgeting remains pending.

## Operation and research

From `crypto-bot`, `npm run monitor:paper` runs one actual local paper-lifecycle pass. It saves `paper-position-monitor.json` in the effective Crypto data directory. Exit codes: 0 complete/idle, 2 degraded, 1 configuration/integrity failure. This is not a dry run; valid active paper orders can advance. It never submits broker/exchange orders.

Optional configuration: `PAPER_MONITOR_INTERVAL_SECONDS=60`; default **0** disables scheduling. Enabled values are integers 60–900. The Discord-ready supervisor launches a separate child immediately, then waits for completion plus the configured interval before another pass. It does not overlap its own child and waits for shutdown. Effective ledger, emergency stop, quote/spread limits, provider selection, data directory and cadence are pinned into the child.

The worker does no market discovery, history downloads, indicators, model training, new reservations or Discord posting. It handles shared production/forward-shadow books, not legacy counterfactual, venue-research or longer-term investment journals. Existing scan reconciliation still updates the legacy tracker and Discord; those messages may wait for a scan. The scanner's own marking remains enabled and is protected by existing timestamps and ledger locking.

All six owners now expose independent position-monitor reports through `npm run report:operator` in `new-bots`. Crypto heartbeats include the separate child/scheduler. The report distinguishes idle/complete/degraded state and reports missing quotes, fills, exits, cancellations, rejected marks, provider failures and structured identity/quote rejection reasons. A successful monitor is not proof of a successful discovery scan.

New Crypto shadow experiments use `crypto-intraday-paper-v7-owned-monitor` and adapter `crypto-owned-quotes-v1-native-identity`. Their manifests hash the explicitly resolved monitoring cadence. Changing cadence creates a new prospective cohort. Older open cohorts also receive subsequent observations; record activation/manual runs and do not treat such cohorts as untouched comparisons. Prior fills and outcomes are not rewritten.

## Verified evidence

- Three baseline shared regressions failed because Crypto was not an admitted monitor owner. Originals and failing log are retained.
- **77 focused tests passed**: 18 Crypto and 59 shared. Cases include exact venue routing, cache expiry/mismatch, refresh deferral, outages, stale quotes, liquidity, 103 subscription symbols without truncation, partial failures, production/older shadow books, emergency-stop ownership, actual adapter-to-ledger fill/later after-cost exit, operator output and prospective profile separation.
- A new regression caught `complete` being reported after final freshness checks discarded quotes. The corrected collector reports partial and keeps those quotes rejected.
- An isolated real supervisor child completed an idle run and stopped without real ledgers, market requests, Discord or credentials.
- `npm run verify:all`: **1,582 tests passed** — 923 shared/new-market, 274 Stocks and 385 Crypto. Configured syntax checks and **nine Windows launcher checks** passed.
- Public native Kraken probe, 2026-10-03 12:58 UTC: one connection, two requested/acknowledged/quoted symbols, zero subscription failures, 2,473 ms collection. ETH/USD and BTC/USD quotes were respectively 1,152 and 1,695 ms old at completion and had positive displayed sizes. This demonstrates the tested native feed snapshot only; no new CoinGecko identity, account entitlement, paper fill or market-wide coverage was established.
- Actual local `npm run monitor:paper`: **idle**, one production path checked, zero active positions/requests/fills/exits/cancellations, 3 ms worker time. The absent ledger stayed absent. Effective public identity mode, no key, interval 0, emergency stop true, live trading not requested.

No real `.env` edit, service restart, hosted upload, paid activation, Discord post or live order occurred. An earlier CoinGecko public probe was rejected by automatic approval review with only “blocked by policy”; this phase did not retry it. The identity refresh implementation is verified with mocked complete provider responses, not a new live CoinGecko refresh.

## Files and next steps

New Crypto modules: `src/paperIdentityCache.js`, `src/krakenPositionQuotes.js`, `src/positionQuotes.js`, `src/paperPositionMonitor.js`; CLI: `scripts/monitor-paper.js`. Existing provider/config/index/telemetry files integrate them. Shared owner routing, monitor profile and operator reporting are extended; no model/risk threshold is lowered. Tests: `crypto-bot/test/position-monitor.test.js` and `new-bots/shared/test/cryptoPositionMonitor.test.js`.

Evidence is under `review-verification/crypto-position-monitor-*`: baseline originals/tests, stale-status regression, focused/full logs, public native probe, local readiness/idle report, source diff and structured checkpoint.

Next: persist and enforce Kraken book evidence throughout the shared executor; strengthen stock quote provenance/depth; coordinate provider budgets across workers; verify allowed identity refresh and authenticated feeds; review runtime activation and hosting; collect multi-session after-cost forward outcomes. Polling cannot reconstruct unseen intrapoll stop/target order, queue priority or actual fills. Strategies remain unproven.
