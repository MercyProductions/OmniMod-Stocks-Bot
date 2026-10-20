# Futures provider-directory handoff — 2026-10-03

Follow-up: [completed-minute activity research](ACTIVITY_DISCOVERY.md) is now implemented locally. Broad executable liquidity, verified new-root strategy integration and account-backed validation remain pending; the original directory phase below remains its reference boundary.

Status: implemented locally as `databento-dataset-definitions-v1`. Authenticated coverage, hosted operation and broad live opportunity screening remain unverified. Definitions do not approve trades.

## What was limiting discovery

The existing runner loaded 36 continuous research products, bounded by `MAX_FUTURES`. Dated discovery requested only their `.FUT` parents; the review-draft helper requested their `.v.0` mappings. Both could omit every root outside that configuration. Those helpers remain available for focused review, but they no longer define the dataset directory.

The separate new path requests Databento's `ALL_SYMBOLS` definition stream. Configured products only annotate priority/name matches. It can discover previously unknown roots without changing `examples/futures.json`. Coverage is confined to the configured dataset and account entitlement: a GLBX dataset is not every worldwide futures exchange.

## Files and flow

1. `src/databentoDatasetDirectory.js` asks `metadata.get_dataset_range` for definition-schema availability, selects the latest available UTC date (end bounded by the observation clock), and requests `metadata.get_cost` for the identical query. No future end time is requested. Unavailable or more-than-seven-day-old availability fails closed.
2. A positive configured cap is mandatory for downloads, including a provider estimate of zero. Over-cap estimates stop before downloading. `scripts/probeDirectory.js` performs only metadata/estimate requests and cannot download definitions. An estimate is not an invoice or account-wide spending limit.
3. The paid `timeseries.get_range` POST uses `symbols=ALL_SYMBOLS`, `stype_in=raw_symbol`, `schema=definition`, JSONL, ISO timestamps and explicit fixed-point price encoding. No symbol list or server-side record truncation limits visibility. The paid stream is never automatically retried. Free metadata retains the existing bounded retry policy.
4. A streaming parser writes the exact source bytes to gzip while classifying records. Limits are 2 million records, 2 GiB uncompressed bytes and 120 seconds by default; the library accepts bounded overrides. A resource limit, malformed row, missing stream, unterminated final record or empty stream returns incomplete/unknown coverage, no accepted directory and no replacement of a valid cache. These limits bound work; a source exceeding them needs a separately reviewed larger-cap or partitioned implementation.
5. Identities are dataset + source UTC date + publisher ID + instrument ID. Latest revisions supersede earlier ones. Deletions, expiry, future activation, non-outright classes, missing identity/root/symbol, unsupported updates, conflicting equal-time revisions and invalid timestamps receive structured dispositions. An unorderable update cannot resurrect an older contract. No ticker-prefix inference supplies a missing root.
6. Outright reference rows retain raw symbol, root, exchange, expiry/activation, currency/unit and explicitly unverified provider terms. Dataset-mode tick size uses the requested 1e-9 encoding; raw tick amount/display factor are retained separately. `providerTickValue` stays unknown because fractional-price and source inconsistencies need independent verification. No multiplier or margin is guessed into strategy-trusted fields.
7. `src/datasetDirectoryCache.js` writes a digest-checked cache tied to dataset, provider credential fingerprint, version and priority annotations. It prevents concurrent refreshes using an exclusive lock, persists a one-hour minimum attempt interval across restarts, and caches only successful streams. A failed refresh may display an explicitly stale reference cache. Every cache read removes now-expired references and reports both original source counts and currently unexpired counts. Changing account/dataset cannot reuse another scope's cache.
8. The main runner persists compact coverage diagnostics, includes source/reference counts in its embed, and exposes them in `/futures scanstats`. Console samples are capped at 40; the complete normalized directory and exclusions are archived. Configured context products are counted as observed only when they have an actual price and timestamp. Exhausting the historical context allowance keeps the directory report available and labels context unavailable instead of reusing example prices.

## Configuration and commands

Run commands from `new-bots/futures` so its `.env` is selected:

```powershell
npm run probe:directory
npm run discover:contracts
```

`probe:directory` is the first account check; it never downloads paid data. `discover:contracts` can download data only after the configured cap passes. Do not enable it until account access and cost policy have been reviewed.

```dotenv
FUTURES_CONTRACT_DISCOVERY_ENABLED=true
FUTURES_CONTRACT_DISCOVERY_SCOPE=dataset
FUTURES_CONTRACT_DISCOVERY_CACHE=data/futures-contract-discovery.json
FUTURES_CONTRACT_DISCOVERY_CACHE_MINUTES=360
DATABENTO_DATASET=GLBX.MDP3
# Set DATABENTO_API_KEY privately and choose an explicit positive cost cap.
FUTURES_MAX_SCAN_COST_USD=0
```

Zero keeps downloads disabled. The positive cap is shared with the existing context/H1 historical requests in each scanner run; estimated download cost stays reserved even if the stream fails. Other processes, CLI commands, live licenses and earlier scans have no aggregate daily budget here. No account or subscription is created by these settings. `FUTURES_CONTRACT_DISCOVERY_SCOPE=configured_roots` retains the older limited reference path when explicitly desired. The separate `discover:day-session-draft` command remains a curated-priority helper.

The default scheduled definition refresh is six hours, independent of the strategy scan cadence. A durable `.attempt.json` limits retries to hourly even after failure; a `.lock` prevents concurrent refresh. A lock left by a killed process requires checking for an active writer and operator recovery; age alone does not delete it.

Archives live under `<cachePath>.archives`: raw `.ndjson.gz`, normalized `.directory.json.gz` with all per-identity exclusions, and sanitized `.failure.json` for incomplete streams. Completed source bytes have a SHA-256. Generated regular archive files older than 14 days are pruned on a successful refresh, except the current snapshot. Preserve evidence needed for longer research before retention expires. Cache hashes detect accidental changes; they are not tamper-proof external attestations.

## Coverage and remaining work

The actual local probe at 2026-10-03 06:56 UTC reported `credentials_missing`, zero requests, zero paid downloads and unknown identities/contracts. The 36 configured products are priorities/context, not measured provider coverage. No environment secrets, stop setting, server process, Discord channel or live-trading setting changed in this phase.

Verification: `npm run verify:all` from `new-bots` passed 1,362 tests, the configured syntax checks and nine Windows launcher checks. Final focused coverage passed 56 tests. Tests include a 6,001-root streamed fixture reaching its last unconfigured root, strict lifecycle/identity cases, cost/resource failures, cache expiry/scope/locking/backoff, persisted archives, admin formatting and a complete isolated runner. The runner fixture consumed its historical budget on discovery, still saved coverage, marked context unavailable and left the production paper ledger byte-for-byte unchanged. Synthetic success is not provider entitlement, uptime, market completeness or performance evidence.

`streamComplete` means the requested historical response was fully consumed. It does not attest source completeness, live listing activity or an exchange-wide current tradable count. Provider definition count estimates are only exact on discrete 24-hour ranges; this implementation does not equate an estimate with exact current-day completeness.

Remaining phases: authenticate and measure an authorized account/dataset; exercise realistic directory size/latency on the deployment host; add bounded broad volume/OI/activity screening and selection of active/front/deferred contracts; map independently verified specs, margin, session, settlement, exposure and catalyst inputs for new roots; add entitled current quotes; validate resulting strategy populations with costed forward/OOS cohorts; deploy after verification. The existing strategy still evaluates reviewed day-session inputs. `prepare:day-session` intentionally rejects roots absent from its reviewed registry until those terms are supplied. Broad discovery alone creates no watch, reservation, fill, recommendation or order.

## Provider references checked

- [Databento all dataset symbols](https://databento.com/docs/examples/symbology/all-dataset-symbols): historical `ALL_SYMBOLS` definitions and separately licensed live discovery.
- [Historical HTTP API](https://databento.com/docs/api-reference-historical?historical=http): metadata availability/cost, streaming fields, explicit price/timestamp encodings.
- [Requesting many symbols](https://databento.com/docs/examples/basics-historical/requesting): broad dataset requests and client-side filtering.
- [Tick value and notional](https://databento.com/docs/examples/instrument-definitions/contract-notional): tick amount/display factor, fractional quotation and independently verified contract terms.
- [Record-count metadata](https://databento.com/docs/api-reference-historical?historical=http): definition estimates are exact only on discrete 24-hour ranges.
