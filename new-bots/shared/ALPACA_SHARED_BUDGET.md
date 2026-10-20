# Alpaca REST request coordination — 2026-10-03

Status: **verified locally; authenticated operation and performance validation pending**. Version: `alpaca-shared-rest-budget-v1`. The six-market goal remains active.

## What was wrong

Stocks and the newer bots had separate in-memory cooldown gates. Restarting a process erased its cooldown, other processes could not see it, and certain retries skipped the gate after sleeping. Historical backfills, the Stocks asset-history directory, corporate actions, company news and the Options dividend screen also had direct HTTP paths. A final 429 could return without retaining its cooldown. The investment-history path could shorten a provider delay to its local retry budget.

Two initial regression tests failed against preserved originals. Inspection and later route tests established the additional bypasses. These findings demonstrate implementation gaps; missing authenticated scan history prevents attributing a specific number of lost opportunities to them.

## Current implementation

`alpacaSharedBudget.js` coordinates REST request starts through a shared filesystem directory. `alpacaRequestGate.js` supplies the runtime default and retains the old process-local factory for explicitly injected tests. Stocks re-exports the common default through its historical import path. Every retry obtains a new grant. Responses update the shared quota/cooldown before further work.

| Path | Coverage |
| --- | --- |
| Stocks `stocksData.js` | Movers, actives, broad snapshots, per-symbol snapshots, daily/intraday bars |
| Stocks `universeStore.js` | Point-in-time all-status asset directory, including retries |
| Stocks `eventIntelligence.js` | Corporate actions and shared company-news requests |
| Stocks `investmentResearch.js`, `alpacaBackfillRequest.js` | Existing historical research and backfill requests; final 429 cooldown retained |
| Shared `alpacaHttp.js` | ETF directory/clock/calendar/snapshot/bar/quote/news paths, Options underlying discovery/analysis, Stocks quote refresh and owned-position quote collection |
| Shared `alpacaCatalystNews.js` | Stocks and Options paginated/batched company news |
| Options `alpacaDividendScreen.js` | Cash-dividend screen, each attempt and final 429 |

The asset directory, company news and market-data hosts use one deliberately conservative local bucket per credential/group. Their true entitlement buckets can differ. This implementation does not infer account entitlements from provider names or claim that all endpoints share a provider-side quota.

## Configuration and scope

These settings are read from the **worker process environment**, lazily on the first request. Use a consistent service environment for all participating bots; changing the directory or group while workers are active splits their state. Restart/reconfigure the participating services deliberately after reviewing settings. No actual service configuration was changed in this phase.

| Setting | Default | Contract |
| --- | --- | --- |
| `ALPACA_REQUESTS_PER_MINUTE` | `180` | Integer 1–10,000. Local aggregate start limit, not proof of account quota. A slower recent worker constrains the group until its recorded starts age out. |
| `ALPACA_SHARED_RATE_DIR` | `new-bots/shared/data/provider-limits/alpaca` | Same writable directory for all cooperating processes. Relative values resolve from the `new-bots` root, independently of working directory. |
| `ALPACA_RATE_LIMIT_GROUP` | blank | Optional shared nonsecret alias for multiple keys belonging to the same quota group; letters, digits, period, underscore, hyphen, maximum 100 characters. Blank uses a SHA-256 credential-key fingerprint. |

An example environment file is `alpaca-budget.env.example`. Load it using the service environment or Node's `--env-file` option along with the bot's existing configuration. In particular, merely adding these fields to Stocks' application-parsed `.env` does **not** export them to `process.env`. Do not assume that application-specific parsers load shared infrastructure settings. `npm run report:operator` must receive the same environment to inspect the same budget.

Alpaca's published individual-account table lists IEX coverage and 200 historical requests/minute for Basic, and broader coverage and 10,000 historical requests/minute for Plus. Those figures do not authorize automatically raising every endpoint's request budget. The default 180 is our conservative local policy. Authentication/feed entitlement still need verification before changing a paid profile. [Official market-data plans](https://docs.alpaca.markets/us/docs/about-market-data-api).

The latest-quote reference documents explicit feed selection, HTTP 429 and quota headers. The bot retains the selected feed and existing data-quality gates; a higher request setting does not purchase data or turn IEX into SIP. [Official latest-quotes reference](https://docs.alpaca.markets/us/reference/stocklatestquotes-1).

## Budget and failure semantics

- Request starts are paced and counted in a rolling minute. Grants are conservative reservations, not proof an HTTP request completed. A crash between grant and fetch consumes that reservation until it ages out.
- Atomic exclusive lock files serialize transactions. A synced temporary state file is renamed into place. Credentials, secrets, URLs and response bodies are not persisted in the bucket files.
- Valid provider limit/remaining/reset observations can further constrain requests. In-flight local reservations are deducted conservatively, and late responses cannot replenish the same reset window. Missing quota headers remain unknown.
- HTTP 429 honors `Retry-After` or a valid reset. Missing usable timing imposes a local minute cooldown. An exhausted remaining count without a usable reset also imposes a local minute cooldown. This is labeled local behavior, not a measured provider reset.
- Default queued-wait allowance is ten seconds; optional discovery/quote callers preserve their shorter bounds. Locks are released while waiting. A zero allowance permits an immediately available grant but never queues behind a held lock or known pacing delay. Filesystem operation time is not a hard realtime deadline.
- Corrupt state, inaccessible storage, excessive clock rollback, invalid configuration and lock timeout fail closed. There is no automatic stale-lock stealing. A crash can therefore require operator recovery. First verify the recorded owner is gone and no worker can write that bucket; preserve the state and inspect the lock before removing only the abandoned lock. Never erase quota state to escape an active cooldown.
- Scope is only processes sharing the directory and credential/group. Other hosts, other ungrouped keys, external applications, WebSocket subscription/connection limits, and non-Alpaca providers are outside this coordinator. It has no priority queue reserving capacity for exits over research. Quote freshness and paper risk checks still reject data that ages while waiting.

## Diagnostics and related fixes

Stocks, Options, ETFs and the independent position monitor distinguish `budgetDeferrals` from provider HTTP attempts, failures and measured response latency. Per-request records carry `requestAttempted: false` and a structured budget reason when acquisition fails before the fetch. Broad discovery stops scheduling later batches after a local budget failure rather than reporting the rest as fresh market misses.

`npm run report:operator` includes `alpacaRequestBudget`: configured local RPM, group-presence flag, hashed bucket IDs, recorded grants/deferrals, rolling requests, cooldowns, observed provider quota and lock count. Missing files report `no_observations`. Unknown quota is never rendered as zero remaining.

Stocks' news adapter previously passed its object-shaped metrics collector to a function expecting an array. The integration now translates the returned news metrics into Stocks' collector; the route regression checks that valid news remains available instead of silently becoming partial.

The Options runner tests also exposed an old observation-clock offset: nested discovery/analysis stages could compare a newly obtained quote against an earlier scan anchor. Production Options discovery and deep research now pass the current observation clock through. Deterministic tests show that a valid newly observed quote is accepted while future and stale quotes still fail the unchanged rules. This is a timing correction, not a lowered strategy threshold.

## Verification and current operation

- Baseline: **2 failures**, establishing separate default gates and skipped retry acquisition.
- Focused shared/market run: **105 passes**; Stocks focused run: **16 passes**. These were followed by **9 catalyst/runner** and **4 auxiliary/clock** passes, plus the updated Stocks route regression. The final suite also verifies one-attempt accounting for malformed news and preservation of an observed 429 when cooldown storage fails.
- Final command from `new-bots`: `npm run verify:all` — **1,674 tests passed**: 980 shared/new-market, 302 Stocks, 392 Crypto. All configured syntax checks passed, including 318 shared/new-market JavaScript files, and **nine Windows launcher checks**.
- Four real Node child processes, alternating Stocks/shared import paths, produced sixteen unique serial grants in one temporary bucket with the required spacing. This tests local coordination, not authenticated provider traffic.
- Test preloading creates isolated temporary budgets per test file and uses a high synthetic request limit. Child runner fixtures inherit those directories; coordinator tests separately verify real limiting with explicit clocks/configurations. Runtime defaults are not disabled for production.

Logs are in `../../review-verification/alpaca-shared-budget-*.log`. Originals and SHA-256 hashes are in `../../review-verification/alpaca-shared-budget-baseline-20261003/manifest.json`; the final checkpoint is `../../review-verification/alpaca-shared-budget-checkpoint-20261003.json`. The first broad runs contain failures corrected by the final run; they are retained as evidence.

Read-only operator snapshot at **2026-10-03 15:40 UTC**: local budget has **no observations**, default **180** RPM, no group alias. Stocks/ETF Alpaca credentials and Options Tradier credentials remain missing in local readiness; paper equity/cost configuration is also incomplete. This phase made no authenticated provider requests, changed no actual `.env`, did not restart services or deploy, posted no Discord messages, and enabled no paid subscription or live orders. Existing local workers may load source edits on subsequent runs; a coordinated rollout was not verified.

Next: measure ETF quote ages through expensive analysis and preserve freshness at decision time; validate account/feed entitlements when credentials exist; observe real per-stage coverage and quota behavior; coordinate other providers where needed; collect multi-session after-cost, forward and untouched/out-of-sample evidence. Passing these tests does not establish profitability or complete live market coverage.
