# Kraken evidence across shared paper execution — 2026-10-03

Status: **verified locally; not deployed or activated.** The preceding independent-monitor phase made progress. This phase closes its remaining Kraken evidence gap across scanner, candidate, reservation, later fill, mark and exit. The six-market goal remains active; reliable continuous operation and profitable performance are not established.

## Observed defect

`shared/cryptoQuoteEvidence.js` only required evidence for Coinbase. The primary candidate, ledger writer and later executor also retained book evidence only for Coinbase. The independent Kraken monitor checked displayed size locally, but the full scanner reused earlier event prices without a common size/provenance requirement. Consequently, a caller could advance a Kraken paper order through the shared executor without the same protection.

Four new baseline tests failed against preserved originals: missing Kraken evidence was accepted as a source/candidate; valid Kraken evidence had no supported schema; an approved reservation could fill from later prices without book evidence; and the order writer dropped evidence. These are execution-integrity defects, not a justification to relax strategy gates.

## Current implementation

`normalizeCryptoQuoteEvidence` now accepts two explicit native forms: existing `coinbase_l1_book` and `kraken_l1_bbo`. Kraken evidence includes the WebSocket symbol, native timestamp, bid/ask, displayed base-unit sizes, BBO event selection, observed online status and exact subscription acknowledgment. Prices, time and symbol must match the quote and verified identity. The native pair remains in `cryptoIdentity` and is independently checked against current native product rules; `BTC/USD` stream naming does not rewrite the saved `XBTUSD` pair.

Only the bounded Kraken collector attaches subscription/status evidence after checking its actual protocol messages. Its bare ticker parser cannot create that evidence. `parseKrakenPaperBook` then binds the collected observation to an already verified USD route, rejecting absent, mismatched, stale or future observations. Public prices cannot establish a new CoinGecko identity.

The full scanner's post-analysis refresh now:

1. Retains existing exact identity, duplicate/conflict and USD eligibility checks.
2. Loads fresh product rules with at most three concurrent jobs.
3. Collects one bounded Kraken BBO session for all eligible stream symbols while Coinbase books use up to three concurrent, paced REST jobs. Subscription batches retain every requested symbol. Ambiguous mappings to the same stream symbol are rejected.
4. Rechecks book and metadata freshness after collection. A failed collection invalidates that route for the pass, even when its earlier cached book looked fresh. Independent successful routes remain usable.
5. Returns the shared quote map without mutating research snapshots. Refresh diagnostics include requested routes, ready rules, received Coinbase/Kraken books, Kraken session state and structured failure reasons.

The same evidence validator now runs at quote construction, primary candidate creation, shared risk approval and every later Crypto execution attempt. Candidates and orders retain it; later fill/mark/exit records preserve the corresponding observation. An insufficient displayed entry side cannot fill; an insufficient liquidation side cannot create a later executable mark or exit. Long entries use asks and exits use bids; shorts use the reverse. Costs, native fractional increments, minimums, duplicate timestamps, emergency-stop behavior and portfolio controls remain intact. No risk/model threshold was lowered.

This is a conservative full-fill-or-reject model. No partial fill or deeper-book liquidity is invented. Entry-time unrealized accounting remains a modeled top-of-book estimate after costs; it is not a guaranteed liquidation. A snapshot cannot prove queue position, liquidity persistence or actual fills, and separate shadow books are independent simulations rather than simultaneous orders consuming one live book.

Older open orders with known identity may exit on new valid evidence. Their entry evidence, fill, accounting history and recorded execution version are not backfilled or relabeled. Unknown identity still remains unresolved.

## Cohorts, operation and provider documentation

- Shared execution version: `paper-quotes-v7-native-crypto-book-evidence`.
- Crypto monitor adapter: `crypto-owned-quotes-v2-native-book-evidence`.
- Crypto shadow strategy cohort: `crypto-intraday-paper-v8-native-book-evidence`.

The shared execution version participates in every owner's experiment hash, so prospective shadow experiments are separated even for markets whose execution logic did not otherwise change. Existing cohorts are retained. Activation can change future outcomes of older open positions; record that intervention when comparing cohorts.

The new acquisition follows Kraken's official [ticker specification](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker): BBO-triggered subscriptions provide native timestamps and best-price sizes. Its [status channel](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/status) reports exchange availability. Subscription receipt/acknowledgment timestamps do not substitute for market timestamps. This feed is public and needs no account credential. Account trading eligibility and asset identity remain separate requirements.

This adds at most one bounded Kraken connection per eligible scanner refresh; idle or rejected routes create none. The independent monitor uses the same collector. Quotas across processes are still not coordinated. Existing public/Demo/Pro identity configuration, opt-in monitor cadence and emergency-stop settings are unchanged. No actual environment file or hosted service was changed.

## Verification

- **4 baseline failures**, retained in `review-verification/kraken-book-evidence-baseline-tests-20261003.log`; 14 source originals hashed and preserved.
- **75 focused passes**: 32 shared and 43 Crypto. Coverage includes missing/mismatched evidence, exact routing, full-size long/short lifecycle, thin entry/exit/mark rejection without ledger mutation, legacy positions, later after-cost outcomes, protocol acknowledgment, one-session multiple-route refresh, outages with no cached fallback, partial venue failures, ambiguous aliases, stale quotes and metadata, and preserved Coinbase behavior.
- `npm run verify:all`: **1,595 passed** — 929 shared/new-market, 274 Stocks, 392 Crypto — plus configured syntax and **nine Windows launcher checks**.
- Public native probe at 2026-10-03 13:20 UTC: **one session, two symbols acknowledged/quoted, zero missing/subscription failures, 478 ms**. ETH/USD and BTC/USD evidence passed the shared schema; quote ages were 1,105 and 1,495 ms. This confirms those public snapshots, not fresh CoinGecko identity, account permission, full-market coverage or paper profitability.

No Discord post, broker order, service restart, deployment or paid activation occurred. CoinGecko identity was not re-probed; its previously rejected public request remains unverified externally. Synthetic regression results are not trading performance.

## Developer entry points and remaining work

- `new-bots/shared/cryptoQuoteEvidence.js`: discriminated native evidence and quote/identity binding.
- `shared/primarySignal.js`, `paperRisk.js`: retained candidate/order evidence and locked lifecycle checks.
- `crypto-bot/src/krakenPositionQuotes.js`, `krakenPaperBook.js`: protocol observation and exact-route binding.
- `src/paperQuoteRefresh.js`, `paperExecutionQuotes.js`, `positionQuotes.js`: scanner and independent-monitor integration.
- New tests: `crypto-bot/test/kraken-paper-book.test.js`, `new-bots/shared/test/krakenPaperBook.test.js`.
- Evidence: `review-verification/kraken-book-evidence-*`, including source diff and structured checkpoint.

Next priorities are stock quote provenance/displayed-size handling, cross-process provider budgets, permitted provider/identity verification and runtime activation, followed by multi-session after-cost forward evaluation. Native non-USD conversion, calibrated slippage, deeper liquidity/partial fills and unseen intrapoll barrier order remain limitations.
