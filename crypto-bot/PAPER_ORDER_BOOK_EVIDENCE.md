# Crypto paper order-book evidence — 2026-10-03

Current follow-up: [Native product rules and fractional sizing](NATIVE_PRODUCT_SIZING.md) resolves this phase's product-metadata and whole-coin sizing dependencies for Coinbase/Kraken USD routes. Conversion and independent primary monitoring remain pending.

This phase is implemented locally. The public Coinbase BTC-USD product and L1 book endpoints were read successfully once each. This does not establish continuous operation, full Crypto coverage, account trading permissions, CoinGecko identity verification, or strategy profitability. No service was restarted and no hosted files or real configuration were changed.

## Why this became the next dependency

Currency conversion was the intended next task. Inspection showed that the Coinbase research adapter dated its bid/ask using the ticker payload's last-trade observation. The shared execution bridge then accepted that as executable quote evidence. Four regressions demonstrated that ticker data could enter the candidate builder, pass shared approval with inconsistent book evidence, and fill a reservation without a book snapshot.

Coinbase documents its [ticker endpoint](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker) as a snapshot of the last trade, bid/ask and volume. Its [book endpoint](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book) supplies timestamped L1 prices and aggregated quantities. Auction quotes can be indicative. The implementation uses L1 for execution and preserves the existing research ticker/history paths.

## Implemented flow

1. Existing bounded analysis supplies verified asset IDs and exact native pairs. Discovery itself is unchanged.
2. `src/paperQuoteRefresh.js` selects unambiguous, current, verified Coinbase USD routes. Non-USD quotes still require conversion and are not requested by this refresh. Duplicate asset records, duplicate exact routes and conflicting coin-ID claims cannot create requests.
3. `fetchCoinbasePaperBook` in `src/marketProviders.js` requests only `/products/{exact-pair}/book?level=1`. It does not perform identity discovery, history downloads or order submission. Up to three refresh jobs run concurrently. The shared Coinbase REST request path spaces starts by 150ms, including retries, and respects existing host cooldowns.
4. `src/coinbasePaperBook.js` validates L1 shape, explicit positive prices/quantities, an integer sequence, non-crossed prices, absence of auction evidence, verified identity age and source timestamp freshness. Local receipt time and HTTP Date never replace missing market time. Native quote units are preserved.
5. All collected quotes pass freshness checks again after collection. The existing research objects are not mutated. The primary scanner uses these fresh execution quotes for its shared production and forward-shadow paper paths.
6. `shared/cryptoQuoteEvidence.js`, the primary candidate builder and shared risk/execution boundaries require Coinbase book evidence matching the exact pair, bid, ask and time. A later ticker cannot fill, mark or close an approved Coinbase position.
7. Reservations preserve entry evidence. Fill/close events and the latest position mark preserve subsequent evidence, including source time, sequence and displayed sizes. The existing full-fill model blocks a Coinbase fill or exit if its quantity exceeds the displayed size on the relevant side. It does not fabricate partial fills or deeper liquidity.

Native Kraken stream behavior is unchanged. Binance USDT remains excluded from the USD shared ledger until a valid conversion/accounting path exists. Historical records are not rewritten. A legacy order with a known source can receive new verified book evidence; missing source identity is still blocked.

The top-level operator report already includes `sharedPaperQuoteIdentity`; its `refresh` object now reports requested routes, books received, failures, elapsed time and maximum configured concurrency. Provider request telemetry continues recording HTTP latency, errors and rate-limit information. Structured rejection rows include refresh failures and quote-evidence failures.

New cohort identifiers: `paper-quotes-v5-coinbase-book-evidence` and `crypto-intraday-paper-v5-coinbase-book`. Model thresholds, signal rules, loss limits, emergency stops and production approval requirements were not loosened. Changing execution evidence and liquidity assumptions requires new forward evidence; old performance cannot validate this version.

## Verification and evidence

- Four new regressions failed on preserved baseline source, then passed after implementation: `review-verification/crypto-paper-book-baseline-tests-20261003.log`.
- Shared focused suite: **101 passed**, including exact source routing, paper lifecycle, malformed numeric inputs, insufficient displayed quantity, persisted evidence and six-market shared risk: `crypto-paper-book-focused-20261003.log`.
- Provider/refresh/routing/retry suite: **28 passed**. Includes malformed books, stale identities, zero-request rejection paths, native USDT preservation, failed requests without ticker fallback, collection-age checks, concurrency and paced request starts: `crypto-paper-book-provider-tests-20261003.log`.
- Final `npm run verify:all` passed **1,526 tests** (899 shared/new-market, 268 Stocks, 359 Crypto), configured syntax checks and nine Windows launcher checks: `crypto-paper-book-six-market-final-20261003.log`. An earlier full run passed 1,524 before two additional request-gate tests were added.

Read-only public probe at **2026-10-03 11:32:33 UTC**:

| Request | Result | Latency |
| --- | --- | --- |
| Coinbase product BTC-USD | HTTP 200; online; trading-disabled, cancel-only, limit-only, post-only and auction flags false | 226ms |
| Coinbase BTC-USD L1 book | HTTP 200; valid normalized evidence; source age 2,846ms at receipt | 68ms |

Raw book, selected product fields, response hashes, timestamps and probe limitations are saved in `review-verification/crypto-paper-book-public-probe-20261003.json`. The probe deliberately does not manufacture fresh CoinGecko verification or create a paper order. Its source is `probe-coinbase-book-20261003.mjs` in the same evidence directory. All paths above are relative to the bot workspace root except source paths under this Crypto project.

## Remaining work and practical limits

- **Pending: currency conversion.** Native USDT is not USD. Do not multiply a Binance quote by a Coinbase conversion quote and label it a directly executable same-venue route. The conversion design must address balances/venue, both bid/ask spreads, source times, route persistence, costs and subsequent valuation. This phase deliberately leaves that guard intact.
- **Pending: fractional Crypto sizing.** Inspection found the primary shared candidate still sets `lotSize: 1`. The measured BTC-USD product advertises `base_increment: 0.00000001`, `quote_increment: 0.01`, and `min_market_funds: 1`. An authoritative product-metadata path and market-specific sizing rules are needed; merely replacing the constant with an arbitrary small increment would be insufficient. This is another real source of missed eligibility, separate from model thresholds.
- **Pending: independent Stocks/Crypto position monitoring.** Refresh is after full analysis and only sees its available verified routes. A position outside that pool still needs a separate quotes-only monitor. Four newer-market monitor implementations exist separately.
- **Pending: product status/size metadata in the recurring acquisition path.** The public probe checked BTC-USD status, but the new per-scan book loader does not separately refresh product trading flags, base increment or minimum order value. That belongs with the sizing dependency above. Book evidence alone is not account eligibility.
- **Pending: continuous forward operation and financial validation.** A fresh snapshot and fixture tests are not multi-session results. Provider credentials/entitlements, reviewed costs and hosting activation remain tracked separately.
- L1 quantity is one observation, not a fill guarantee. Existing fee/slippage reserves remain modeled assumptions. Queue priority, disappearing liquidity, deeper books, partial fills and latency between observation and execution are not reproduced.
- Sequence is preserved and type-validated; current lifecycle ordering still uses source timestamps, not a sequence-recovery protocol.
- Coinbase's [public REST limit is per IP](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits). The new gate coordinates this process only. Multiple processes sharing an IP still need a shared quota budget.

No Discord messages, live orders, paid activations, real `.env` edits, deployments or ledger migrations occurred in this phase. The six-market goal remains active.
