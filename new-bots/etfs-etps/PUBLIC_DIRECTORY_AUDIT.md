# Public ETF directory measurement and audited listing support

Verified locally and against the two public Nasdaq Trader directory endpoints on 2026-10-03. Account-backed quotes, strategy readiness, deployment and forward performance remain unverified. This phase continues the existing six-market goal.

## What changed

The ETF probe previously stopped before measuring any public directory when Alpaca credentials were absent. `npm run probe:directory --prefix etfs-etps` now performs two unauthenticated directory GETs and preserves a compressed immutable artifact containing the source text, full row dispositions, counts and hashes. It does not load `.env`, query accounts/prices, modify production caches, invoke strategy/paper execution or send Discord messages. Optional `-- --output-dir <directory>` chooses the evidence folder. The existing `probe:universe` remains the account-backed directory/snapshot probe.

The shared parser now records provider row counts, classifications, excluded rows, exchange codes, duplicate identities and terminal-marker completeness. Exact duplicate rows are counted once. Conflicting identities, malformed security rows, a missing/invalid terminal marker, or ambiguous cross-file ETF symbols fail the production parser. A public probe with partial or malformed sources retains the observed rows while leaving complete-universe counts unknown. Its two requests are concurrent, each bounded by 20 seconds and a 10 MiB decoded-body ceiling; it does not retry. Quota utilization is not established by these requests.

The first live run exposed a real `otherlisted.txt` trailer variant: the final delimiter for its Nasdaq Symbol column is absent. That specific observed format is accepted; security-row width is still checked. Source timestamps now preserve the provider's local clock text with unknown timezone. The prior fabricated UTC `createdAt` fields become null; no downstream freshness calculation depended on them. Existing cached records are not rewritten and retain the normal six-hour refresh / bounded stale fallback behavior.

The first measurement also identified five ETF rows using code `F`, which the old static exchange map silently discarded. TXSE's official SIP specification identifies its exchange as F, and its issuer/listing evidence corroborates the directory records. The parser now recognizes TXSE and the ETF account-master filter accepts an active, tradable TXSE asset. This is a listing-coverage correction, not entry approval. All existing product classification, fresh quote, catalyst, strategy, costs, shared risk and emergency-stop gates remain. Stocks receives the same newly recognized ETF identities for ownership exclusion; it does not take them over as stock candidates.

New ETF discovery uses `etf-full-directory-v2-audited-listings`, and the forward shadow experiment uses `etp-opening-range-breakout-shadow-v4-audited-listings`. Earlier observations are unchanged. The five additions and new parser behavior require prospective evaluation; no performance promotion is justified by directory size.

## Measured result

At 2026-10-03 10:20:39 UTC, both endpoints returned HTTP 200. Total elapsed time was 889 ms; Nasdaq took 655 ms and other-listed took 861 ms. Both files reported `2026-10-02T21:31:00` with no source timezone supplied. This is a point-in-time file inventory, not proof of current market/session eligibility.

| Measurement | Observed |
| --- | ---: |
| Nasdaq security rows | 5,634 |
| Other-listed security rows | 7,661 |
| Total unique security rows | 13,295 |
| ETF-flagged rows, including test issues | 5,760 |
| Accepted non-test ETF-flagged listings | 5,758 |
| Non-ETF-flagged rows | 7,500 |
| Test-issue rows across both files | 37 |
| Conflicting identities | 0 |
| Price/technical analyses, paper orders, Discord posts | 0 |

The same archived source files produced 5,753 accepted listings under the untouched baseline parser and 5,758 under the new parser. Exactly CTAG, ILS, OILT, PWRX and TXS were added; none were removed. Raw source and artifact hashes were verified. This comparison involves no extra network requests and no historical trading outcome selection.

The directory flag alone does not determine product wrapper risk, current activity, broker support, executable prices or strategy suitability. Unflagged ETNs/ETVs still require authoritative supplemental discovery/classification. IEX/unknown exchange codes and unsupported symbol formats are explicit exclusions rather than invisible drops. No such non-test ETF exclusions remained in the final measured files. Account eligibility remains unknown because Alpaca credentials are absent.

## Files and verification

- `shared/nasdaqEtfDirectory.js`: shared detailed inspection, strict production merge, TXSE mapping and source-clock provenance.
- `etfs-etps/src/publicDirectoryProbe.js` and `scripts/probe-public-directory.js`: public probe and immutable evidence writer.
- `etfs-etps/src/alpacaMarketData.js`: inspection diagnostics and account-confirmed TXSE support.
- `stocks-bot/src/etfDirectory.js` (sibling project): retains inspection metadata in the shared ETF ownership cache.
- `etfs-etps/src/fullMarketDiscovery.js` and `src/index.js`: distinct discovery and forward experiment revisions.

Baseline: 24 tests passed, original files/hashes preserved. Focused command `node --test etfs-etps/test/publicDirectoryProbe.test.js etfs-etps/test/universe.test.js etfs-etps/test/fullMarketDiscovery.test.js` passed **35 tests**. New checks cover malformed/truncated sources, timezone ambiguity, duplicate conflicts, exact public request scope, partial failures, size limits, source archives, the actual footer form, TXSE discovery and retained catalyst/inactive-listing vetoes.

`npm run verify:all` passed **1,466 tests**: 849 shared/new-market, 268 Stocks, 349 Crypto. All configured syntax checks passed, including 291 shared/new-market JavaScript files, plus nine Windows launcher checks. Full results are in `../review-verification/etf-public-directory-six-market-20261003.log`. Evidence and the original first-run incomplete diagnostic are retained under `../review-verification/etf-public-directory-*`.

## Next work

Verify account-supported listings and quotes using the separately configured Alpaca profile, preserving unknown entitlement/coverage until measured. Confirm the revised listing population in provider-backed scans and collect forward evidence under its new version. Keep wrapper review, catalyst and execution requirements intact. No live order route, paid activation, production environment change, upload or restart occurred in this phase. Missing provider credentials remain a user setup dependency; safe engineering on the other market integrations can continue.

## Authoritative references

- [Nasdaq directory definitions](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs) define ETF/test flags and the terminal file-generation marker; the documented timestamp supplies no explicit offset.
- [TXSE activation specification](https://www.txse.com/alerts/txse-production-launch-and-market-activation) identifies F across SIP feeds. Applying F to this directory is corroborated by the captured listing rows and exchange evidence, rather than by the older directory-definition page's incomplete exchange table.
- [TXSE primary-listing announcement](https://www.txse.com/press/texas-stock-exchange-celebrates-transfer-of-texas-capital-s-txs-and-oilt-exchange-traded-funds) independently confirms TXS and OILT transferred to TXSE.
