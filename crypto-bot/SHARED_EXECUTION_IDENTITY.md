# Crypto shared paper-execution identity

Current follow-up: [Coinbase paper order-book evidence](PAPER_ORDER_BOOK_EVIDENCE.md) adds timestamped L1 refresh, persisted quote evidence and displayed-quantity checks. Non-USD conversion remains pending.

Local phase verified on 2026-10-03. This addresses the primary Crypto bot's shared portfolio and forward-shadow books. The broader six-market goal is still active.

## Findings

The primary bridge previously built an executable-quote map keyed only by ticker. Duplicate symbols could overwrite each other, and a later scan could pick a different venue because its quote was newer. Although the newer venue-research path already preserved exact pairs, the shared paper order did not retain that provenance. Legacy tracker lookup also fell back from a missing asset ID to ticker matching.

The portfolio accounts in USD. Native USDT quote amounts previously had no explicit conversion into that accounting currency. A stablecoin symbol alone does not establish an executable conversion rate or dollar P&L.

Four regression tests failed against the original source: accepting identity-less candidates, dropping identity during reservation, using a different asset/venue to fill, and treating native USDT as USD. Original files, hashes and failing output are retained in `../review-verification/crypto-execution-identity-baseline-20261003` and `crypto-execution-identity-baseline-tests-20261003.log`.

## Implementation

1. The existing bounded deep-enrichment pool now requires complete CoinGecko asset-ID/pair verification, using its existing pagination checks, public/Demo/Pro selection, request pacing and one-hour identity cache. Only verified native quotes receive the structured identity envelope. Ticker-only and incomplete identity responses cannot acquire it. Cheap broad discovery is unchanged.
2. `src/paperExecutionQuotes.js` keeps quote keys containing provider namespace, durable asset ID, venue, exact native pair, base and quote currency. It retains every usable exact source for later position marks, while selecting a fresh USD source per asset for new candidate evaluation. Conflicting claims for one native pair and duplicate exact-source rows are quarantined. Provider-event timestamps, numeric bid/ask validation and the configured freshness limit remain required.
3. `new-bots/shared/cryptoExecutionIdentity.js` defines and validates the stored envelope. Its evidence-age limit is 65 minutes, matching the existing one-hour provider cache plus a small collection allowance. Schema validation is not independent proof that a provider's upstream asset mapping is correct.
4. Primary candidate creation persists the envelope and incorporates the exact identity into idempotency. Reservations retain it. The shared executor checks both stored identity and the current quote's identity before a fill, mark or exit. A different asset, venue or pair cannot update that position, even if its price is newer or would produce a favorable result.
5. Primary and shared-shadow monitoring use the recorded exact key. The shadow lifecycle is verified after a candidate leaves the shortlist: alternate-source quotes do nothing; later matching quotes can fill and close the recorded position. Legacy cancellation on stop/expiry still works. An open legacy record without provenance is left unresolved; no venue, fill or exit is invented.
6. Tracker asset resolution and the Bitcoin benchmark selection use durable IDs. Ticker fallback is removed from these primary paths. Historical research remains distinguishable from executable shared-ledger outcomes.
7. Portfolio exposure uses durable identity for new Crypto rows. The established Bitcoin/BTC, Ethereum/ETH, Solana/SOL and XRP/XRP overlaps are retained using CoinGecko IDs `bitcoin`, `ethereum`, `solana` and `ripple`. Other IDs use a namespaced exposure key. An unrelated token using one of those tickers does not become the benchmark asset. Legacy exposure metadata remains conservative.
8. The scan stores `sharedPaperQuoteIdentity` counts/reasons and shared mark diagnostics. The top-level operator report exposes these per instance without multiplying unique coverage across guilds. Native non-USD quotes report `crypto_quote_currency_conversion_required`; absent legacy provenance reports `legacy_crypto_execution_identity_unavailable`.

The execution version is now `paper-quotes-v4-crypto-source-identity`; the Crypto shadow strategy version is `crypto-intraday-paper-v4-exact-source`. New frozen cohorts remain separate from results produced under the old routing rules. No historical performance is promoted or relabeled.

## Verification

From `new-bots`, the final focused suite covering identity, primary integration, portfolio risk, six-market lifecycle, shadow lifecycle, recovery, malformed quotes and operator reporting passed **143 tests**. From `crypto-bot`, `node --test --test-reporter=tap test/exact-pair-routing.test.js test/accuracy-integrity.test.js` passed **50 tests**, with provider calls mocked. The native-shaped responses verify that the provider adapter attaches the exact asset, pair and verification timestamp without changing USDT into USD.

Full `npm run verify:all` passed **1,510 tests**: 893 shared/new-market, 268 Stocks and 349 Crypto, plus all configured syntax and nine Windows launcher checks. The final SOL/XRP exposure-alias addition was made after that full run started and is covered by the subsequent 143-test focused pass; do not treat the full-run log as proof of its timing. An earlier full run exposed one obsolete malformed-quote fixture lacking Crypto identity; it was updated to carry valid identity so all 420 malformed-value cases still exercise price validation.

Logs in `../review-verification`:

- `crypto-execution-identity-focused-20261003.log`
- `crypto-execution-identity-provider-tests-20261003.log`
- `crypto-execution-identity-six-market-final-20261003.log`
- `crypto-execution-identity-source-20261003.diff`

## Remaining work and operating limits

This phase made no provider requests, service restart, hosted upload, `.env` change, Discord post, paid activation or live order. Tests establish local behavior, not current feed access, completeness, profitable strategies or actual paper performance.

Native non-USD pairs remain visible to discovery and existing source-pinned research. The shared USD portfolio now withholds their entries until a tested conversion path exists. That path must use timestamped executable conversion bid/ask, preserve both market and conversion provenance, and account for conversion spread/cost. Do not restore a hardcoded USDT=USD assumption merely to generate entries.

Complete identity verification adds requests within the existing bounded enrichment pool. Actual public-feed latency and quotas need provider-backed measurement. Public, Demo and Pro configurations remain supported; a failed paid/verified source must not silently become a ticker-only executable quote.

The primary scanner still fetches and marks its shared positions through the full scan. Dedicated quote-only Crypto monitoring, including positions absent from the current ranking pool, is the next integration task. Legacy active records without exact provenance need an evidence-backed reconciliation workflow; automatically selecting today's pair would rewrite history. Stocks' independent monitoring and the outstanding authenticated feeds/entitlements for other markets remain separate pending work.
