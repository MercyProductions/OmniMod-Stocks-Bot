# Shared Tradier market-data budget — 2026-10-03

Status: verified locally; all 1,720 tests, configured syntax checks and nine Windows launcher checks passed. Authentication, entitlement, observed market coverage and forward performance remain unverified. The six-market goal remains active.

## Findings

The Options start pacer was an in-memory map. It could not coordinate the main scanner, independent contract research, shadow monitoring and a separate position-monitor process, and a restart erased its cooldown. Successful response quota headers were logged but did not constrain that map. Pacing failures occurred before transport metrics were recorded. The final 429 path did not await a future asynchronous cooldown writer. Direct calls to the legacy chain reader and exported market-clock helper also lacked the common request boundary.

Four regressions reproduced the first four issues before editing (0/4 passed). Read-only inspection identified the direct-call gaps. Missing authenticated history prevents quantifying lost real opportunities; no profitability inference follows from this repair.

Tradier documents per-access-token market-data windows, production 120 requests/minute and sandbox 60 requests/minute, with Allowed/Used/Available/Expiry response headers. Expiry is represented in milliseconds in its example. These provider rules were checked against the [official rate-limiting documentation](https://docs.tradier.com/docs/rate-limiting) on 2026-10-03. The implementation keeps production and sandbox separate and does not include account/trading endpoints in this market-data budget.

## Architecture

- `filesystemRequestBudget.js` contains the established filesystem lock, atomic state write, rolling-minute grants, pacing, cooldown, conservative header observation and read-only inspection engine extracted from Alpaca. Its internal canonical quota headers use reset epoch seconds. It stores only hashed bucket identities and accounting metadata, never tokens or response bodies.
- `alpacaSharedBudget.js` retains its existing exports, state format, path/key derivation, version and public error codes as an adapter. Existing persisted Alpaca state is compatible; no migration or reset was performed.
- `tradierSharedBudget.js` adapts native Tradier headers, including millisecond expiry. When Used and Available disagree, the smaller remaining allowance wins. Late responses cannot replenish tokens spent by later grants. Reported zero with unusable quota metadata, or a headerless 429, produces a disclosed local cooldown rather than invented provider quota.
- `tradierHttp.js` is the common read-only request boundary. Every retry obtains a grant; responses update persistent accounting before returning; final 429 responses await cooldown persistence. GET requests must target the matching production/sandbox `/v1/markets/` origin and use the token whose bucket was granted. No order routing is implemented.
- `createTradierMarketFetch` recognizes its own wrapped functions by a private in-process map. Nested chain/clock readers reuse the existing boundary, avoiding double grants, double retries and duplicate request counts. Mismatched credentials/environments cannot reuse a wrapper.
- `options/src/tradierRateLimit.js` retains its explicitly injectable process-local factory for deterministic legacy tests. Its runtime default now re-exports the shared gate.

## Integrated paths

| Path | Behavior |
| --- | --- |
| Options production input reader | Clock, underlying quotes, expiration/chain selection and optional underlying refresh all share accounting |
| Options position marks | Market clock and later option-leg quotes share the same token budget, including calls from independent position monitors |
| Independent contract discovery | Existing request helper re-export points to common transport; local budget/storage failures stop further enumeration and retain unfinished records |
| Independent paper research | Bounded pacer forwards both asynchronous cooldown and successful quota observations |
| Legacy multi-asset chain reader | Direct calls use the shared transport; nested main-reader calls do not double-charge |
| Exported market-clock reader | Direct calls acquire a grant; already-managed calls reuse it |
| Operator report | Separate `tradierRequestBudget` with environment buckets, counts, cooldowns, observed quota, unknown state and lock counts |

A local pacing refusal is recorded as `requestAttempted: false` with `budgetRejection`, using the existing Options deferral counters. HTTP failures remain actual attempts. Failed header persistence records the completed HTTP attempt and fails closed instead of silently retrying. An interrupted retry sleep cannot count one response twice.

## Configuration

These are process environment variables, also documented in `options/.env.example`. The launcher must load the intended `.env`; the operator command only reports the environment in which it runs, not proof of every worker's settings.

| Key | Default | Bounds / interpretation |
| --- | --- | --- |
| `TRADIER_SHARED_RATE_DIR` | `shared/data/provider-limits/tradier`, relative to `new-bots` | Use the same absolute or resolved directory in all cooperating workers |
| `TRADIER_PRODUCTION_REQUESTS_PER_MINUTE` | 108 | Integer 1–120 |
| `TRADIER_SANDBOX_REQUESTS_PER_MINUTE` | 54 | Integer 1–60 |

Budgets are stored below `<directory>/<environment>/market-data/`. Each token has a separate SHA-256-derived bucket. Runtime settings cannot raise a budget above the documented provider ceiling. Per-request waits are bounded at ten seconds and research callers can impose smaller deadlines. Exhaustion or a long reset may defer research; it does not relax freshness or strategy requirements.

No exit-priority reservation has been implemented. A scan can consume budget that later monitoring needs, so callers must expose deferrals and stale-position gates must remain enabled. A crashed process's lock is not silently stolen. Corrupt state, incompatible clocks, unavailable storage and abandoned locks fail closed and require operator investigation. Do not delete budget state or locks simply to evade a provider cooldown.

Scope is cooperating callers on the same filesystem and token. External applications, different hosts/directories, streaming subscriptions, other provider services and different tokens are not globally coordinated. Rolling local grants are deliberately more conservative than a provider's precise window. Header accounting can defer legitimate work when concurrent response ordering is ambiguous.

## Verification

- Four original regressions: failed before edits, passed after integration.
- Focused selection: 89/89 passed before the final interrupted-retry case was added.
- Additional shared-budget and actual Options-runner integration selection: 16/16 passed, including the added case.
- Tests cover native millisecond headers, contradictory remaining counts, out-of-order responses, token/environment isolation, configured ceilings, corruption, 429 fallback cooldowns, expired request deadlines, read-only route restrictions, and real separate process serialization.
- Direct legacy chain/clock calls demonstrate one grant per actual request. Existing acquisition, expiration enumeration, contract identity, quote freshness and strategy tests remain intact.
- Older fake-token data tests now inject isolated pacers; they no longer share deliberately synthetic cooldown state across unrelated cases. The two-scan runner fixture starts the second simulated process after the previous frozen manifest time, avoiding a clock rewind after newly paced requests. The existing independent-research reservation and no-approved-Discord assertions remain enforced.
- Final `npm run verify:all`: 1,720 passed (1,026 shared/new-market, 302 Stocks, 392 Crypto), configured syntax checks and nine Windows launcher checks. The earlier full-run failure is preserved; it identified the synthetic inter-process clock rewind corrected above. Tests use synthetic market responses; real child processes and filesystem locking are exercised.

## Current measured operating state

At 2026-10-03 16:42:52 UTC, the read-only local report found no actual Tradier budget observations. Default budgets were 108/54. The latest Options scan (16:42:30 UTC) still used `manual` input. Tradier token, paper equity, cost assumptions, Tradier source and production-data mode remain incomplete. This is not proof of a full-market Options scan finding no opportunities, and it does not establish authentication or entitlement.

No actual `.env`, service restart, remote deployment, Discord message, paid activation or live order was performed in this phase. Existing workers may pick up edited source on later scans; no coordinated rollout is established.

## Remaining work

1. Local implementation, final workspace verification and hash checkpoint are complete; authenticated verification remains pending.
2. Obtain/configure legitimately available Tradier access and verify entitlement, returned contracts, timestamps, quotas and freshness; do not purchase or activate automatically.
3. Measure real scan/monitor contention and decide from evidence whether monitoring needs reserved capacity or independent stream support.
4. Extend provider-specific coordination where needed (for example OANDA/Finnhub/crypto venues); do not assume all providers share this REST model.
5. Run controlled continuous paper operation with explicit equity/cost assumptions and unchanged risk gates. Accumulate after-cost multi-session forward and untouched out-of-sample evidence before changing strategy or claiming expectancy.

Artifacts: `../../review-verification/tradier-shared-budget-checkpoint-20261003.json`, preserved originals in `tradier-shared-budget-baseline-20261003/`, failing baseline/first-run logs, final verification log and local readiness snapshot in that review directory.
