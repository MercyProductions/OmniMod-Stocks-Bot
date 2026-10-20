# Stocks native quote evidence — 2026-10-03

Follow-up: [Stocks decision-time quote refresh](DECISION_QUOTE_REFRESH.md) completes the bounded post-analysis refresh and age diagnostics locally. The pending-refresh statements below describe this earlier phase; authenticated operation, ETF/ETP review, account-wide budgets and forward validation remain unfinished.

Status: **verified locally; not deployed or activated.** This continues the six-market project after the Kraken execution-evidence phase. The overall goal remains active. Authenticated Stocks observations and continuous after-cost forward performance remain unverified.

## Defect and result

The Stocks scanner constructed three generic `{bid, ask, time, quality: 'executable'}` maps from provider labels. Native feed, quote conditions, exchanges and displayed sizes were discarded. The independent position adapter also discarded sizes. Shared risk and execution accepted these labels without native evidence and could model a full fill larger than displayed liquidity.

Three regression tests failed against the preserved baseline. The replacement requires native evidence through acquisition, scanner quote construction, candidate approval, shared risk approval, reservation and later execution. No strategy/model threshold or portfolio limit was lowered. Quote validity is distinct from signal strength and profitability.

## Data contract and paths

- `new-bots/shared/stockQuoteEvidence.js` parses Alpaca native quotes and validates the bounded `alpaca_stock_l1` version-1 schema. It retains symbol, requested feed, coverage, provider, USD currency, acquisition source, native timestamp, normalized time, bid/ask, reported and normalized sizes, exchanges, tape and conditions. It rejects mismatched symbols/prices/times/feeds, unsupported feeds, invalid or missing sizes, malformed fields, stale/future input and nonregular conditions. Unknown fields are discarded.
- `stocks-bot/src/alpacaStream.js` retains evidence from actual quote messages, separately from later trade prices. `src/stocksData.js` does the same for snapshot quotes. Consensus copies only the selected microstructure observation's evidence and clears stale evidence when the selected source lacks it. Research price sources remain usable as research.
- `src/paperExecutionQuotes.js` creates one validated map for scanner marks, forward shadow tracks and production candidate construction. It checks configured feed, current age, known halt status and duplicate symbols. It records evaluated/accepted/rejected counts, per-symbol reasons and aggregate reasons. Later shared approval/execution rechecks freshness at its own clock; a frozen map cannot renew its timestamps.
- `new-bots/shared/stockPositionQuotes.js` retains native evidence through independent owned-position monitoring, including positions outside the discovery shortlist and older shadow books. Existing batched acquisition, calendar, session, freshness, ownership and routing checks remain intact.
- `shared/primarySignal.js` and `paperRisk.js` validate the same contract. Reservations retain original evidence. Later accepted marks and lifecycle events retain the observation used. A new reservation's feed is pinned; changing a monitor from IEX to SIP cannot silently change that order's execution source.
- `shared/operatorReport.js` exposes Stocks `sharedPaperQuoteEvidence` and `sharedPaperMarkDiagnostics` per instance. Existing absent fields report null, not invented zero coverage.

Long entries require sufficient displayed ask size; long liquidation requires sufficient bid size. Shorts use the opposite sides. Insufficient size cannot produce a full fill, later executable mark or exit, and that rejected attempt does not alter the ledger. This is a conservative full-fill-or-reject simulation, not a partial-fill or depth model. Entry-time unrealized accounting remains a top-of-book estimate including costs, not a guaranteed immediate liquidation. Separate shadow books do not consume one another's displayed liquidity.

Older filled orders can exit with fresh valid evidence without backfilling their historical entry evidence or rewriting past events. Their existing execution version remains intact. Installing this change affects their future processing and must be noted when evaluating historical cohorts.

## Size units, conditions and free/paid feeds

Alpaca's [October 2025 change notice](https://docs.alpaca.markets/us/v1.1/changelog/marketdata-bid-and-ask-size-display-change) states that CTA/UTP quote sizes use shares from November 3, 2025. The current adapter preserves SIP sizes 1:1 as shares. It rejects older observations rather than applying today's unit interpretation to older data.

The [stream schema](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) still describes integer sizes as round lots. The CTA/UTP announcement does not settle the IEX-specific interpretation. For current IEX, the adapter conservatively treats the raw count as a share lower bound, tagged `iex_reported_size_conservative_shares`; it never multiplies by an assumed 100. This can understate usable liquidity. Account/provider confirmation of IEX units remains necessary before changing that interpretation.

Only the reviewed regular two-sided `R` condition is allowed for paper execution. [NYSE Daily TAQ v4.3](https://www.nyse.com/publicdocs/nyse/data/Daily_TAQ_Client_Spec_v4.3.pdf), quote condition tables, identifies `R` for CTA and UTP. Other conditions receive an explicit rejection; this is a conservative policy, not a claim that every other condition is invalid in the market. This policy alone does not establish independent halt-state verification.

`ALPACA_DATA_FEED=iex` retains the single-venue path; `sip` retains the opt-in entitled consolidated path. `delayed_sip`, overnight and unknown feeds cannot supply current paper execution. The [latest-quote API](https://docs.alpaca.markets/us/reference/stocklatestquotes-1) documents these distinct feed scopes. Alpaca's [FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) describes free IEX access and separate SIP entitlement. Free access still requires valid credentials. No subscription, paid activation or account permission is inferred from configuration.

This phase adds no provider requests. It preserves the existing scanner stream/snapshot sources and independent monitor batching. It does not refresh scanner quotes after expensive analysis, coordinate provider quotas across processes, or add a second executable stock provider. Those remain separate work; a research fallback cannot be relabeled as executable data.

## Versions and verification

- Shared executor: `paper-quotes-v8-stock-quote-evidence`.
- Stocks monitor adapter: `stock-owned-quotes-v2-native-evidence`.
- Stocks shadow strategy: `stocks-intraday-paper-v4-native-evidence`.

The global executor version participates in every owner's prospective experiment hash. New shadow cohorts are separated for all six owners even where market-specific behavior did not change; existing cohorts and histories are preserved.

Verification on October 3, 2026:

| Check | Result |
| --- | --- |
| Baseline | 3 failures demonstrate missing evidence and liquidity protection; 17 hashed source originals preserved |
| Shared focused tests | 101 passed |
| Stocks scanner/accuracy tests | 25 passed |
| Replay, recovery, malformed quote and monitor compatibility tests | 43 passed; overlaps the focused monitor tests, not an additional unique total |
| `npm run verify:all` from `new-bots` | 1,610 passed: 939 shared/new-market, 279 Stocks, 392 Crypto |
| Syntax and Windows launchers | All configured syntax checks and 9 launcher checks passed |
| Local credential resolution | `credentials_missing`, including configured saved guild settings; no secrets printed |
| Actual configuration | IEX, emergency stop true, independent monitor interval 0 |
| Authenticated native probe | Not run; no credentials, zero provider requests in the configuration check |

Tests cover native parser semantics, symbol/feed/price/time binding, nanosecond timestamp retention, stale trade versus quote timestamps, missing/nonregular conditions, no silent size multiplication, duplicate/halted scanner symbols, long/short size gates, immutable rejected attempts, original-feed pinning, legacy exits, after-cost outcomes, owner isolation, replay chronology and operator diagnostics. Acquisition and execution tests use explicit synthetic native-shaped fixtures. These are not observed market fills, forward samples or profitability evidence. An initial full run found eight older fixtures missing the new contract; those fixtures were updated without adding a production bypass, then the complete suite passed.

Logs and machine-readable evidence live under `review-verification/stock-quote-evidence-*`, including baseline, focused, compatibility and full runs, source diff, configuration status and checkpoint. No actual `.env`, service, deployment, Discord message, paid entitlement or live order was changed in this phase.

## Next engineering work

1. Refresh only qualified Stocks candidates with bounded current native quotes after expensive analysis; measure acquisition age and final decision age separately. Keep strategy gates and the new source contract intact.
2. Review equivalent ETF/ETP displayed-size provenance and independent-monitor execution.
3. Coordinate provider budgets across scanner/monitor processes before enabling continuous collection.
4. Validate permitted authenticated feeds, complete universe/entitlement coverage and actual native message semantics; measure IEX limitations rather than assuming consolidated coverage.
5. Activate verified paper monitoring with an explicit operating configuration, retain old histories, and accumulate multi-session after-cost and untouched out-of-sample evidence. No strategy promotion follows from these regression results.
