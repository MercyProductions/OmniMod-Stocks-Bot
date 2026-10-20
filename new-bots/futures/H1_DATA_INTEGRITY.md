# Futures hourly-data integrity — developer handoff, 2026-10-03

This phase fixes the existing deep-analysis hourly feed. It does not finish new-root routing, validate real provider coverage, or change the opening-range strategy. Implementation version: `databento-h1-wire-v2`.

## Observed failure

The old H1 adapter read flat `ts_event`, omitted explicit `map_symbols` and inferred fixed-point price units from magnitude. Its eight tests used flat headers and invented `pretty_*` aliases. A saved reproduction passed 52 flat bars but discarded the same 52 bars with the provider's nested `hd` header, producing insufficient/stale history. This can prevent otherwise legitimate candidates from reaching strategy evaluation.

The provider documents a nested JSON record header, explicit pretty-price/time and symbol-mapping options. OHLCV timestamps identify the beginning of the period, and periods with no trades can be absent. See [JSON encoding](https://databento.com/docs/api-reference-historical/basics/encodings), [OHLCV fields](https://databento.com/docs/schemas-and-data-formats/ohlcv) and [date-scoped identifiers](https://databento.com/docs/standards-and-conventions/common-fields-enums-types).

## Changed path

- `src/databentoTrendData.js` explicitly requests raw contract symbols, `ohlcv-1h`, JSON, no compression, `pretty_px=true`, `pretty_ts=true`, and `map_symbols=true`. Query end is the last completed UTC hour; default history remains seven days.
- `src/databentoH1Normalization.js` checks nested or flat headers against schema 34, publisher/instrument identity, exact mapped symbol and aligned timestamps. Pretty values are parsed as display prices without a magnitude heuristic. Unattributable corrupt rows cannot silently disappear into a successful history result.
- Identity is date scoped: numeric instrument IDs may change across UTC dates. Same-day symbol/identity collisions, publisher changes, conflicting headers and duplicate revisions block affected rows. Optional reviewed publisher/dataset metadata must agree. Identical duplicates count once.
- Numeric coercions, malformed OHLCV and unsafe/nonpositive volume are rejected. Nonpositive historical prices remain ineligible for the existing ORB strategy; the broad discovery layer still retains them. No safety threshold was loosened.
- At least 50 completed bars and the existing 65-minute latest-close freshness rule remain required. At most 200 bars are retained by default. Missing intervals are reported and never zero-filled; session closures are not inferred. Contract and freshness checks use completion time, including fetch latency.
- `src/index.js` enables the H1 cache for the historical adapter and persists its diagnostics in the scan journal. Existing contract, catalyst, session, executable-quote, strategy, cost and portfolio gates still run.

## Request bounds, cache and cost

The adapter accepts at most 100 exact verified raw symbols for detailed analysis; this is not a cap on market discovery. Streams default to 64 MiB, 100,000 records and 20 seconds. Library ceilings are 128 MiB, 100,000 records and 60 seconds. Malformed, empty, interrupted, oversized or timed-out downloads supply no history.

`FUTURES_H1_CACHE` defaults to `data/futures-h1-history.json` in the runner. The library can omit caching for isolated callers. Cache keys contain a digest of adapter version, account credential and exact query. Tokens are not written. Complete raw JSONL is stored with a SHA-256, then revalidated on each use against current metadata, settings and time. Repeating the same completed-hour query can make zero HTTP requests. Raising the minimum bar requirement or changing contract review fields does not trust previous approval decisions.

Only the current query is cached; this is not a permanent research archive or an incremental history database. Changing the symbol set/account/dataset/hour can fetch a different query. Retaining older cohorts and reducing repeated history across changing shortlists remain future work.

A positive remaining historical budget is required for new requests, including zero-price estimates. Blank/invalid estimates are not interpreted as free. Valid cached inputs can be read with zero remaining budget. Cost estimates remain reserved if a paid request fails after starting; estimates exceeding the cap do not reserve unused allowance. This is per-scan estimated spending, not a billing guarantee or account-wide daily cap.

Free cost metadata retains bounded retries. The existing single explicit HTTP 429 `Retry-After` backoff is preserved; transport failures, partial streams and ambiguous outcomes are not retried. Cache locking prevents overlapping refreshes. A durable journal of unsuccessful query keys blocks automatic repurchase even if another symbol set is scanned in between. Successful cached writes clear their pending key. Corrupt cache/journal files and leftover locks require operator inspection; nothing deletes locks based on age. The failure journal is bounded and requires maintenance after 5,000 pending queries.

## Verification and remaining work

Four original files and eight baseline tests were preserved under `../../review-verification/futures-h1-integrity-baseline-20261003`. The saved wire-format reproduction is separate from the corrected tests. The focused suite covers source shape/identity, low and large display prices, sparse bars, invalid fields, collisions, conflicts, costs, current-time freshness, bounds, cache isolation, corruption and failed-attempt persistence.

A fully mocked runner supplies 60 documented-format hourly bars plus independently valid session/quote fixtures. One breakout reaches the unchanged strategy, the emergency stop blocks it at risk approval, and the shared ledger remains unchanged. Its second scan uses the cache with zero HTTP requests. No real provider or Discord delivery is implied by this fixture.

Final verification counts and hashes are in `../../review-verification/futures-h1-integrity-checkpoint-20261003.json`. A real metadata-only probe at 08:08 UTC found no local Databento key and made zero requests. Entitlements, actual provider response coverage/latency and paid operation remain unverified. No environment, subscription, hosted process or live order was changed.

Next: verify actual H1 availability and transport against an authorized account; connect the broad activity shortlist to bounded detailed analysis with reviewed contract metadata and current quotes; retain costed multi-session forward/OOS cohorts. This parser repair is not evidence of strategy profitability.
