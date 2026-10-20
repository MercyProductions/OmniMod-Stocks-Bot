# Native Crypto product rules and fractional paper sizing — 2026-10-03

Implemented locally for the currently supported USD spot execution routes: Coinbase and Kraken. Public product-rule responses for BTC and ETH were validated on both venues. This is not evidence of continuous operation, account trading permission, full market coverage or profitability. No running service, hosted deployment, actual environment file or live-order setting was changed.

## Observed bottleneck

The previous primary candidate always assigned `lotSize: 1`. Shared sizing also clamped the increment to at least one unit. Two additional integer-only checks in reservation and persisted-order execution prevented a fractional quantity from surviving the lifecycle. Changing only the candidate field would therefore have been insufficient.

Four new regression tests failed on the baseline. A controlled example demonstrates the effect: $10,000 paper equity, 0.25% trade-risk budget ($25), $100,000 entry, 1% stop distance, $20 round-trip fee reserve per BTC and $10 slippage reserve per BTC. Per-unit modeled risk is $1,030. Whole-unit sizing returned zero; exchange-grid sizing returns **0.02427184 BTC**, with modeled risk **$24.9999952**. These are test assumptions, not current prices, recommended capital, or the bot's actual account fee schedule.

## Implementation

### Authoritative metadata

`src/cryptoProductMetadata.js` normalizes the venue's actual precision, minimums and trading state. `fetchCryptoInstrumentRules` in `src/marketProviders.js` obtains fresh metadata separately from the long-lived research directory caches:

| Venue | Metadata endpoint | Normalized rules |
| --- | --- | --- |
| Coinbase | `/products/{exact-pair}` | `base_increment`, `quote_increment`, `min_market_funds`, explicit trading flags and status |
| Kraken | `/0/public/AssetPairs` | `lot_decimals`, `lot_multiplier`, `tick_size`, `ordermin`, `costmin`, status and exact native aliases |

Coinbase's [product API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-single-product) defines product precision and status. Its [channel documentation](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels) records removal of legacy size-limit fields and the use of `min_market_funds` as a limit-order notional minimum. Kraken's [AssetPairs API](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs) exposes lot precision, tick size, quantity/cost minimums and status. The parser preserves Kraken's native pair (`XBTUSD`) while matching normalized base identity (`BTC`).

Successful metadata is cached for 30 seconds; concurrent requests share the in-flight fetch. Multiple Kraken routes share one directory response. The shared boundary accepts metadata only within 60 seconds of retrieval, with the existing 5-second future-clock tolerance. `observedAt` here is **local metadata retrieval time**, not an exchange quote event time. Market quote timestamps remain separate. Failed expired refreshes cannot fall back to older product rules.

The parser retains restricted states. Offline, disabled, auction, cancel-only, post-only and limit-only products cannot enter this normal-trading simulation. Missing or malformed limits/flags and unsupported Kraken lot semantics are explicit failures. The implementation requires Kraken's `lot: unit` and `lot_multiplier: 1`; another lot type needs a validated adapter rather than a guessed multiplier.

### Discovery and quotes

`src/paperQuoteRefresh.js` retrieves rules only for exact, unambiguous USD routes already available from bounded analysis. Coinbase then receives the existing fresh L1 book request. Kraken retains its provider-timestamped stream quote; product retrieval does not make that quote newer. The builder rechecks both quote and metadata age after collection.

The refresh's version-2 diagnostics include requested routes, rules ready, Coinbase books received, failures, duration and concurrency. Metadata failures have their own `shared_product_rules` stage. Existing per-provider request telemetry and the top-level operator report expose these values. A discovery failure and a product-rules rejection remain different events.

### Quantity and price handling

`shared/cryptoInstrumentRules.js` validates rule identity and age at candidate, risk and execution boundaries. `shared/decimalQuantity.js` floors quantities using decimal integer arithmetic rather than repeated binary-float division. Non-power-of-ten increments are supported. The final serialized quantity must remain on the venue grid and within the unchanged risk budget. More than `Number.MAX_SAFE_INTEGER` individual steps are allowed when the resulting quantity itself safely round-trips; the step count is a BigInt.

Primary Crypto candidates derive `lotSize` from verified rules. Their long stop is rounded down to a valid price and target rounded up before risk sizing; the small price-grid adjustment is recorded through the resulting plan. The shared evaluator checks price grids, quantity minimum and notional minimum without increasing size to force a minimum order. The remaining model, risk/reward, spread, liquidity, daily-loss, concentration and emergency-stop gates remain in force.

Reservations preserve the rule snapshot and increment. Later quotes must supply current matching rules. Entry and exit checks reject quantities that no longer satisfy a venue increment or minimum. Fractional Crypto quantities can pass persisted-order validation only with the required rule provenance. Other asset classes retain their existing integer-unit requirements.

The existing later-quote fill/exit and cost model now handles fractional units. Coinbase's displayed-liquidity restriction remains. A halt, expired metadata, changed minimum, or inadequate displayed quantity cannot create an invented fill or completed result. A known-source legacy integer position can receive current metadata. A legacy fractional position without quantity-rule provenance remains unresolved; pending reservations can still expire or be cancelled by the stop mechanism without quotes.

Historical records are not rewritten. For an old off-grid target, its original trigger remains; the modeled target exit rounds conservatively to a current valid price. New plans already use valid ticks. New version labels are `paper-quotes-v6-native-crypto-sizing` and `crypto-intraday-paper-v6-native-sizing`.

## Verification

- Baseline: four new regressions failed (`review-verification/crypto-fractional-sizing-baseline-tests-20261003.log`).
- Shared focused suite: **109 passed**, including fractional reserve/fill/target/stop paths, changing venue rules, 100 risk-budget/grid combinations, malformed prices and preserved cross-market controls (`crypto-fractional-sizing-focused-20261003.log`).
- Provider/routing/retry suite: **36 passed**, including both native parsers, restricted modes, invalid metadata, deduplicated requests, cache expiry, refresh failures and Kraken timestamp preservation (`crypto-fractional-sizing-provider-tests-20261003.log`).
- Final `npm run verify:all`: **1,542 passed** (907 shared/new-market, 268 Stocks, 367 Crypto), configured syntax checks and nine Windows launcher checks (`crypto-fractional-sizing-six-market-final-20261003.log`).

Public read-only probe on **2026-10-03 at 11:53:47–48 UTC** made three GETs; all returned HTTP 200:

| Product | Quantity increment | Price increment | Quantity minimum | Notional minimum | State |
| --- | --- | --- | --- | --- | --- |
| Coinbase BTC-USD | 0.00000001 BTC | $0.01 | 0.00000001 BTC | $1 | online |
| Coinbase ETH-USD | 0.00000001 ETH | $0.01 | 0.00000001 ETH | $1 | online |
| Kraken XBTUSD | 0.00000001 BTC | $0.10 | 0.00005 BTC | $0.50 | online |
| Kraken ETHUSD | 0.00000001 ETH | $0.01 | 0.001 ETH | $0.50 | online |

Coinbase latencies were 210ms and 72ms; the Kraken request returning two records took 280ms. Exact public payloads, response hashes and normalized rules are in `review-verification/crypto-product-metadata-public-probe-20261003.json`. Its adjacent probe script performs no account authentication, CoinGecko identity verification, paper reservation or order submission. Evidence paths are relative to the workspace root.

## Remaining work

- Native USDT and other non-USD accounting still require a real conversion route with venue, bid/ask, timestamp, balance and cost evidence. Stablecoins are not assumed to equal dollars. Binance's existing USDT routes remain research inputs until that dependency is implemented.
- Crypto's independent monitor remains pending. Stocks gained a locally verified opt-in worker in the subsequent `../stocks-bot/INDEPENDENT_POSITION_MONITORING.md` phase. This Crypto refresh still depends on full analysis and available verified routes. Metadata requests cannot replace a current Kraken stream or monitor assets absent from the analysis pool.
- Public product availability is not account or jurisdiction eligibility. Reviewed account costs, entitlements, appropriate provider accounts and hosted activation remain separate dependencies. No paid API was activated by this change.
- The metadata cache has a bounded status-observation delay. Missing required fields or precision below the supported decimal representation are reported rather than guessed. The Coinbase parser intentionally requires explicit status flags.
- Full/failed fills are modeled; partial fills, queue priority, deeper liquidity and account-specific dust liquidation are not reproduced. Positions below a current venue minimum can remain unresolved rather than receive a fictional exit.
- Execution and price-grid changes need new multi-session forward evidence. Prior backtests or earlier paper cohorts do not validate this version. The overall six-market goal remains active.
