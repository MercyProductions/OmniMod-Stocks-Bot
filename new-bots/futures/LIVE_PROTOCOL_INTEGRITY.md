# Futures live-feed protocol repair — 2026-10-03

Local protocol and runner verification is complete for this phase. Actual gateway authentication, entitlements, transport, exchange coverage and forward results remain unverified. The latest metadata-only probe at 08:08 UTC found no Databento key and made zero requests. No subscription, real environment, deployment or live trading setting was changed.

## Reproduced bottleneck

The old entry-data and paper-position adapters expected a symbol directly on each market record. The gateway instead supplies instrument identities and separate symbol mappings. A preserved two-record reproduction (mapping plus a fresh nested-header MBP-1 quote without an embedded symbol) timed out in the old position adapter. Tests had used simplified records with embedded symbols; session fixtures also used incorrect minute-bar and quote record types. Passing those fixtures did not establish gateway compatibility.

This affects usable day-strategy input and marking existing paper positions. It is separate from missing credentials, absent reviewed contracts, strategy rejection, or an empty market.

## Implementation

- `src/databentoLiveProtocol.js` is shared by both adapters. It resolves nested/flat headers and interval-specific raw-symbol mappings at nanosecond precision. Intervals are start-inclusive/end-exclusive. Ambiguous symbols, overlapping identities, explicit-symbol disagreement, conflicting reviewed publishers and changing publishers reject the affected symbol. Unsupported/unmapped records have separate counters.
- Only MBP-1 and completed OHLCV-1m records enter these paths. Explicit display prices replace scale guessing. Minute alignment is checked before millisecond conversion can hide fractional timestamps. Pretty prices/timestamps and gateway-send timestamps are requested; missing fields are not invented.
- Executable quotes require valid receive/send age, transport lag, book sizes, spread direction and book flags. Snapshot/bad-book/bad-receive flags are excluded. Older receive timestamps and lower same-time sequences cannot replace newer observations. Contract tick alignment and aggregate position-depth checks remain mandatory.
- `src/databentoLiveSession.js` deduplicates identical minutes, rejects conflicting duplicates, requires replay completion and retains five-consecutive-minute aggregation. Partial replay cannot become complete input. Quotes, contract validity and session close are rechecked at collection completion.
- `src/databentoLiveMarks.js` rechecks freshness and expiry at collection completion, including when a second symbol arrives later. Marks remain for paper positions only. Metrics distinguish received records from fresh mapped symbols; neither means a fill.
- Both collectors drain complete records already in a packet before accepting results. Trailing errors cannot be hidden by an earlier quote. Error codes are interpreted by record type; provider errors and slow-reader warnings fail collection with sanitized messages. Byte/record/time bounds remain explicit. No automatic reconnect was added.
- `src/index.js` clears old/manual quotes and bars after a failed live fetch and saves live-session diagnostics in the funnel. Failed collection cannot make old inputs appear provider-ready.

Authentication, `start_session=0`, subscriptions, strategy thresholds, shared risk and the emergency stop are preserved. The published Raw API ignores the value of `start_session`; changing it was unnecessary.

## Controls and limits

No new environment key is required. Existing `FUTURES_DAY_DATA_SOURCE=databento-live` and `FUTURES_POSITION_MARK_SOURCE=databento-live` select these adapters. They require a legitimate `DATABENTO_API_KEY`, dataset and reviewed active-contract metadata. Optional `providerDataset` and `providerPublisherId` must agree with the feed; conflicting supplied publishers for one raw symbol reject before connection. Dataset/raw-symbol selection does not verify contract specifications or entitlements.

The deep collector has a 100-symbol cap, separate from broad discovery. Entry collection is bounded by 128 MiB total / 32 MiB buffered text / 250,000 records; position quotes by 32 MiB total / 8 MiB buffered text / 100,000 records. Existing timeouts remain configurable through callers. High-volume feeds can exceed these limits and must be reported as incomplete. Negative-price contracts, symbols outside the current outright identity grammar and nonpositive-volume minute bars remain unsupported strategy input. Sparse minutes are not fabricated. No complete-market claim follows.

## Verification

Seven original files and hashes are preserved in `../../review-verification/futures-live-protocol-baseline-20261003/`; 15 baseline tests passed. The old timeout is recorded in `futures-live-protocol-reproduction-20261003.json` beside that directory.

From `new-bots`, the focused command is:

```powershell
node --test futures/test/databento-live-protocol.test.js futures/test/databento-live-marks.test.js futures/test/databento-live-session.test.js futures/test/dayData.integration.test.js futures/test/livePositionMarks.integration.test.js
```

All 34 tests passed. Coverage includes interval boundaries, identity conflicts, nanosecond alignment, explicit price scales, book-quality failures, stale multi-symbol collection, session close/expiry, interrupted replay, fragmented packets, duplicate/conflicting bars, trailing errors and both full runner integrations. The entry runner still reaches its strategy and respects the emergency stop; the position-monitor fixture applies a later quote to an isolated paper ledger. These are mocked streams, not real account or profitability evidence.

`npm run verify:all` passed 1,417 tests (824 shared/new-market, 268 Stocks, 325 Crypto), 285 shared/new-market syntax checks, configured Stocks/Crypto checks and nine Windows launcher checks. Final counts, logs and file hashes are in `../../review-verification/futures-live-protocol-checkpoint-20261003.json`.

## Remaining work

Measure a real entitled gateway session without orders: mappings, flags, replay, coverage, latency and bounds. Connect the broad historical activity shortlist to bounded deep analysis only after contract/settlement/margin/session metadata is reviewed. Retain costed multi-session forward cohorts and untouched evaluations. This repair lets valid input reach existing rules; it does not validate returns or automatically expand strategy-approved contracts.

Primary references: [Raw Live API](https://databento.com/docs/api-reference-live?live=raw), [symbol mappings](https://databento.com/docs/standards-and-conventions), [MBP-1](https://databento.com/docs/schemas-and-data-formats/mbp-1), [OHLCV](https://databento.com/docs/schemas-and-data-formats/ohlcv), and [fields and flags](https://databento.com/docs/standards-and-conventions/common-fields-enums-types). Inspected 2026-10-03; account behavior remains to be measured.
