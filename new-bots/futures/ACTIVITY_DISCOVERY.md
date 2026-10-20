# Broad Futures activity research — developer handoff, 2026-10-03

Follow-up: the H1 adapter now has [documented-format parsing and completed-hour caching](H1_DATA_INTEGRITY.md), and an optional [reviewed activity-to-analysis route](ACTIVITY_ANALYSIS_ROUTING.md) connects the shortlist to detailed provider data and the existing paper strategy/risk gates. The default remains the post-delivery research-only path described below. The integration is fixture-verified; account-backed operation and performance remain pending.

Implemented and verified locally as `futures-broad-minute-activity-v1`. Actual provider coverage, new-root strategy integration, forward/OOS performance and deployment remain unverified. No research candidate is an approved trade.

## Flow and ownership

Dataset-wide definitions → current-date publisher/instrument identity → one bounded `ALL_SYMBOLS` completed-minute request → per-contract data checks/features → recent-volume leaders per root → bounded research shortlist.

Configured context priorities do not restrict visibility. Default limits select at most 20 contracts overall and one per publisher/exchange/root after all returned eligible bars are screened. Lower-ranked expiries and other roots stay in the normalized archive with explicit deferral reasons. These are computational limits on follow-up research, not claims about profitability.

The current runner performs this optional research **after existing position monitoring, strategy processing and Discord delivery**, using only the remaining historical-data budget. Existing approved inputs, quote/event/risk controls and delivery timing are preserved. The next stage must connect reviewed new-root metadata and current quotes to bounded deep strategy analysis; this phase does not insert directory references into the trusted day-session file.

## Code map

- `src/futuresActivityScreen.js`: deterministic per-record/per-contract validation, cheap features, expiry/volume ordering and candidate selection.
- `src/futuresActivityDiscovery.js`: provider availability/cost, stream ingestion, raw archives, cache replay, limits and structured failures.
- `src/historicalCostBudget.js`: accepted directory/activity/context/H1 estimate reservations; interrupted downloads retain their allowance, while rejected over-cap estimates do not spend unused allowance. Invalid cost evidence blocks further requests. Estimates are not invoices or an account-wide daily limit.
- `src/index.js`: runs research after delivery, persists coverage/stage durations/configuration/source pointers, and exposes a compact sample plus complete console shortlist. Discord outages are recorded without discarding research diagnostics. Research never writes the production paper ledger.
- `scripts/probeActivity.js`: metadata/cost only; no paid download, cache mutation, message or trade.
- `src/datasetDirectoryCache.js`: rechecks on UTC-date changes. Provider availability unchanged from the cached interval does not trigger another paid directory download; prior-date IDs remain labelled prior-date.

## Inputs and measurements

The default window is the latest 30 minutes, clipped to the current UTC date and provider availability. Only completed minutes qualify. Fewer than two complete same-day minutes yields an explicit waiting state; availability older than the configured bar-age limit stops before downloading. Instrument IDs are not joined across dates.

Each bar must be OHLCV-1m (`rtype=33`), have exact publisher/instrument identity and a mapped raw symbol matching the definition. Requests explicitly enable ISO timestamps, decimal prices and symbol mapping; nested HTTP headers are supported. Finite numeric prices, valid OHLC bounds and positive safe-integer volume are required. Negative/zero prices remain visible research without implying production eligibility. Identical duplicate bars cannot inflate volume; conflicting revisions reject the contract. Data/identity/schema/time failures receive structured reasons.

Features: observed contract volume; absolute/percentage movement; range; crossing the prior observed high/low; direction; consecutive-minute acceleration. Last-minute volume divided by the mean of prior consecutive observed minutes requires at least four bars. Sparse intervals are not filled with invented prices, trades or zero volume; unsupported volume ratios/acceleration remain unknown. This is not session-seasonal relative volume, open interest, news/catalyst clearance or executable liquidity.

Ranking first chooses observed-window volume leaders within each root, then uses log-scaled volume, movement, range and recent-volume ratio to allocate the cross-root shortlist. The fixed formula and effective configuration hash are retained. Direction describes observed motion. Rank is neither an entry strategy nor calibrated confidence. Every row has `tradeEligible=false`, `contractSpecVerified=false`, `strategyQualified=false`, `quoteQuality=no_executable_quote` and unknown open interest.

The nearest expiry in the source directory can differ from the observed-volume leader. Neither proves broker active/front status. First notice, last trade, delivery, margin, current activity/OI, session, fees, exposure and risk checks remain prerequisites for a strategy input.

## Setup

From `new-bots/futures`:

```powershell
npm run probe:directory
npm run probe:activity
```

These probes inspect metadata/estimated cost only. Activity can be estimated before a directory is downloaded, but that is not a measured coverage count. The paid provider profile includes both research stages; existing environment files are not changed automatically.

```dotenv
FUTURES_CONTRACT_DISCOVERY_ENABLED=true
FUTURES_CONTRACT_DISCOVERY_SCOPE=dataset
FUTURES_ACTIVITY_DISCOVERY_ENABLED=true
FUTURES_ACTIVITY_DISCOVERY_CACHE=data/futures-activity-screen.json
FUTURES_ACTIVITY_MAX_CANDIDATES=20
FUTURES_ACTIVITY_MAX_CONTRACTS_PER_ROOT=1
FUTURES_ACTIVITY_LOOKBACK_MINUTES=30
FUTURES_ACTIVITY_MAX_BAR_AGE_MS=180000
FUTURES_MAX_SCAN_COST_USD=0
```

Privately configure an authorized Databento key/dataset and an explicit positive historical budget before downloads. Zero disables downloads. Overall candidates allow 1–100; per-root candidates 1–3; lookback 5–60 minutes; research bar age 60–300 seconds. These do not replace production quote freshness. No account/subscription is activated. No permanent free live Futures adapter is integrated; manual/offline data cannot represent current scanning.

## Bounds, caching and evidence

The default paid stream is bounded to one million records, 512 MiB uncompressed and 60 seconds. Library overrides are bounded to two million, 2 GiB and 120 seconds. There are no per-symbol requests in this stage. The dataset stream can include options/spreads; non-directory records are explicitly excluded. Real measurement must establish whether the all-symbol route is more efficient than alternative permitted batching for this account/host.

An exclusive file lock prevents concurrent paid refreshes. A durable attempt marker written before download prevents automatic retry for the same account/query after interruption. New windows may incur new charges under their own remaining per-scan cap. Cross-process/account daily spending limits are not implemented here. Locks left by a killed process require operator recovery; age alone does not remove them.

Complete source bytes are gzipped and SHA-256 pinned. Cache hits verify and replay those bytes against the current directory, time and settings. Candidate-budget or membership changes do not repurchase the same input query. Freshness/expiry are recalculated instead of trusting cached shortlist decisions. Corrupt, truncated, empty or resource-limited data produces no partial candidate set and leaves coverage unknown. HTTP/JSON/resource/cache failures have stable reason codes; arbitrary provider error text or credentials are not persisted.

Normalized `.screen.json.gz` files retain all contract dispositions and excluded record identities. Diagnostics record observed/missing, qualified/deferred/candidate counts, reasons, elapsed time, configuration hash and source pointers. Generated archives have 14-day retention while preserving the current input; separately retain evidence needed for longer validation. `/futures scanstats` separates directory, activity and actual strategy/risk counts. Existing embeds point to this administrative coverage so research does not delay entry delivery.

## Verification and remaining work

Seven pre-existing files and 24 passing baseline tests were preserved. A 601-contract fixture reached the final non-priority symbol: 601 observed/data-qualified, 2 candidates, 599 explicit budget deferrals. Further tests cover multiple expiries, sparse/stale/malformed/duplicate bars, identity/date boundaries, costs, cache replay/corruption and limits. A full-runner fixture finds an unconfigured root, preserves the production ledger, verifies fully intercepted mock embed delivery before research, and continues through a mocked Discord 503. No real Discord request is made.

Final full-suite results are recorded in `../IMPLEMENTATION_PHASES.md` and the phase checkpoint under `../../review-verification`. The actual metadata-only probe at **2026-10-03 07:30 UTC** returned `credentials_missing`: zero requests/downloads, unknown universe/observed counts. Fixtures prove software behavior, not entitlement, uptime, performance or profitability.

Remaining: authenticated full-size provider measurements; current executable quote/liquidity checks; OI/status where available; independently reviewed new-root contract/session/catalyst/exposure metadata; bounded full analysis and defined entry strategies; costed forward/OOS cohorts and promotion review; shared provider budgets; hosted rollout. Live orders remain disabled.

Provider references: [date-scoped IDs](https://databento.com/docs/standards-and-conventions/common-fields-enums-types), [OHLCV sparse-interval convention](https://databento.com/docs/examples/basics-historical/ohlcv-resampling), [schema definitions](https://databento.com/docs/knowledge-base), [Historical HTTP API](https://databento.com/docs/api-reference-historical?historical=http).
