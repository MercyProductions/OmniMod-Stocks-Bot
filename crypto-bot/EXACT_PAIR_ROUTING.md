# Crypto exact verified spot-pair routing

Status: implementation, focused verification and full six-market regression complete locally. Public-provider remeasurement, hosted activation and forward performance remain pending. Updated 2026-10-03.

## Failure reproduced

The required-identity discovery path verified CoinGecko asset IDs and venue pairs, but the detail adapters still constructed fixed preferred symbols. A controlled candidate verified on Binance `PAIRFIX/USDT` and Coinbase `PAIRFIX/USDT` requested the nonexistent Coinbase `PAIRFIX-USD` ticker, received 404, and retained only one fresh venue. The baseline regression failed before the fix. The cheap Coinbase directory filter also discarded USDT products despite the downstream coverage check explicitly supporting them.

The previous real QNT/JST scan prompted this investigation. These fixtures establish a code defect, not the cause of every earlier 404 or QNT identity exclusion. No current real-symbol result is claimed in this phase.

## Changes and execution path

1. Native cheap coverage now retains active Coinbase USD and USDT products. This remains preliminary symbol coverage, not proof of asset identity or executable liquidity.
2. `src/spotPairRouting.js` parses required per-coin identity evidence, rejects conflicting coin IDs and malformed pairs, and plans only explicitly verified USD/USDT routes. Unsupported quote currencies remain explicit exclusions. Binance prefers USDT; Coinbase/Kraken prefer USD, then USDT. One selected route per venue keeps request volume bounded; a failed preferred route does not trigger exhaustive alternative-market retries.
3. Required-identity quotes use the selected pair. Unverified venues incur no native quote request. Binance response symbols are checked. Kraken routes must match its native AssetPairs identity and online status; timestamped stream pairs are canonicalized to the native alternate name. Exact Kraken ticker/history response keys are checked rather than taking an unrelated first result.
4. Detailed history uses only source pairs belonging to fresh, non-conflicting quote consensus. Its cache and in-flight key include asset ID, provider order and exact pairs. Missing or malformed source mappings cannot revert to guessed defaults. The existing minimum bar count, completion/freshness checks, historical validation and costs remain in place.
5. `src/venueResearch.js` requests the observation's original provider and pair even after the asset leaves the shortlist. A mismatched/unavailable source remains unresolved. New strict BTC histories are persisted separately from the legacy BTC context history.
6. Strict observations retain `pairRoutingVersion=verified-spot-pair-routing-v1`. Administrator JSON includes separate counts, valid costed outcomes and approximate deadline audits by routing version. Older observations stay `legacy_or_unrecorded`; none are rewritten or promoted into production training. The probe now retains `candlePair` alongside its provider.

`src/marketProviders.js` owns network adaptation, consensus, history and enrichment. `src/index.js` records the version for production-hosted shadow research; `scripts/probe-venue-discovery.mjs` records it for isolated public research. `src/researchStore.js` adds descriptive grouping without changing outcome resolution, training eligibility or approval.

## Verification

- Baseline: 51 existing focused tests passed; the new alternate-pair reproduction then failed as expected.
- Current focused command: `node --test test/exact-pair-routing.test.js test/accuracy-integrity.test.js test/venue-discovery.test.js test/venue-research-report.test.js` — 75 passed.
- Thirteen new routing tests cover the directory screen, alternate Coinbase quotes/history, a full enrichment-to-monitoring path, cache separation, identity conflicts, unsupported denominations, wrong responses, canonical Kraken sources and stale/receipt-time rejection. A separate new report test verifies routing-version separation and invalid-cost exclusion.
- All routing HTTP is intercepted by fixtures; filesystem-writing integration checks use a temporary isolated data directory. No test creates an approved production setup, Discord post or broker order.
- Full regression: `npm run verify:all` passed **1,455 tests** (838 shared/new-market, 268 Stocks, 349 Crypto), all configured syntax checks and nine Windows launcher checks. Final log: `../review-verification/crypto-exact-pair-six-market-final-20261003.log`. The first-run failure and its diagnostic correction are retained separately.

## Regression follow-up: Forex telemetry

The first full run found an intermittent pre-existing OANDA cooldown diagnostic failure: an idle gate could measure one millisecond of ordinary clock/bookkeeping time as a cooldown despite never sleeping. `forex/src/providerRequest.js` now reports zero when no cooldown was requested; actual waited durations and queue/defer behavior remain unchanged. The new deterministic advancing-clock regression and all eight Forex provider-request tests pass. This is a diagnostic correction, not a rate-limit or trading-policy change. Baselines and both full-run logs are preserved.

## Limits and next steps

This correction can change which candidates reach analysis and which source history is used. New observations require forward evaluation by routing version; no strategy was validated or made profitable by this change. Provider-count, freshness, confirmation, strategy, portfolio and loss gates were not lowered. Live trading stays disabled. This phase did not restart or upload bots, alter credentials, subscribe to paid services or edit production configuration.

The strict routing path applies to assets marked `requiresVerifiedIdentity`; existing legacy baseline lookup preferences remain. Free public and configured CoinGecko Demo/Pro verification share this path and their existing pacing. Native APIs still have geographic/availability limits. USD/USDT support retains the existing unit treatment; it is not a new currency-conversion or stablecoin-depeg model. Other denominations are unsupported. A complete Kraken directory can be cached for six hours and native status may change before expiry. The broader discovery shortlist still requires fresh independent identity evidence.

A proposed two-request public-data probe was rejected by automatic approval review with `blocked by policy` and no additional reason. It was not retried through another tool. Current live pair availability and the QNT/JST causes remain unverified. Continue with an allowed, bounded provider measurement when available, preserving exact request outcomes, identity reasons, latency and source-pinned observations. Keep free access and optional paid configuration distinct; no paid key is required by these local tests.

Baseline copies, SHA-256 manifests and logs: `../review-verification/crypto-exact-pair-*`. The checkpoint records the final verification results and source hashes. Broader six-market provider setup, hosted verification and costed multi-session forward/OOS evidence remain in progress.

## Protocol references

- [CoinGecko per-coin tickers](https://docs.coingecko.com/reference/coins-id-tickers): paged exact coin/venue/pair evidence and quality flags.
- [CoinGecko exchange directory](https://docs.coingecko.com/reference/exchanges-list): venue identifiers.
- [Kraken AssetPairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs): native key, alternate/WebSocket names, base/quote identity and status.
