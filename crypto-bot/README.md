## Native venue discovery and isolated detailed research

Latest measured follow-through (2026-10-03): [free-provider scan and forward evidence](VENUE_FORWARD_EVIDENCE.md) records 3,720 checked Binance pairs, eight shortlisted assets, two detailed attempts and zero new observations after identity/confirmation checks. One earlier observation resolved as a modeled stop loss; it is not a measured trade. `npm run probe:venue-discovery -- --status` now reports local cohort outcomes without network requests, and `/crypto research` includes this separate cohort in its embed and JSON attachment. The newer code remains locally verified, not deployed.

The newer local tree adds `CRYPTO_VENUE_DISCOVERY_ENABLED=true` and `CRYPTO_VENUE_RESEARCH_CANDIDATES=2` (0–4). It screens the full Binance native instrument/ticker response, maps exact CoinGecko asset IDs, then sends a bounded additional pool into detailed research. The production price array, rank/score/model/risk approval and alerts remain separate. Required identities never fall back to ticker-only matching; research records cannot train production models automatically.

Native metadata refreshes hourly; cheap tickers cache for two minutes; identity pages refresh daily with resumable progress and strict completion; shortlist metadata respects the configured discovery cadence. Extra public CoinGecko calls share 20-second pacing. Failed identity paging persists rate-limit backoff. These controls are per-process research planning, not account-wide credit enforcement. Demo collection defers when its conservative projection lacks allowance.

Pending observations continue bounded original-pair history collection even after leaving discovery. Full cheap-screen rows/reasons are compressed under `research/venue-discovery-history` for 14 days. `/crypto diagnostics` shows coverage and separate research counts in an embed plus full JSON; the six-bot operator report retains per-instance counts.

Read-only isolated commands (no paid keys, Discord posts or reservations):

```powershell
npm run probe:venue-discovery -- --prime-identity --deep
npm run probe:venue-discovery -- --deep
npm run probe:venue-discovery -- --resolve
npm run probe:venue-discovery -- --status
```

Initial complete identity paging can take minutes; repeated runs use persisted caches/backoff. The probe stores dated reports and research under `data/venue-discovery-probe`. On 2026-10-02 the paced provider run observed 3,720 pairs, 1,372 active spot pairs, 97 preliminary pairs, 79 mapped IDs, eight shortlisted, two detail requests and one separately recorded research observation. Production approved zero setups; the observation has no completed outcome. This is one-venue discovery, not verified whole-ecosystem coverage or profitable execution. See `../new-bots/IMPLEMENTATION_PHASES.md` for evidence and open limitations. This newer code has not been deployed to cPanel.

> Deployment update (2026-10-02): Stocks/Crypto independent cPanel workers were verified with an isolated restart and rollback exercise. Follow `../new-bots/DISCORD_APPLICATION_MIGRATION.md` and the parent reviewed deployment notes. The narrow deployed embed/hosting release does **not** contain the whole newer local research tree.

`npm start` launches `standalone.js`: one independently locked Crypto worker with its own gateway, scanner and heartbeat. It does not import or start Stocks. The older combined supervisor remains a rollback path; do not run it beside separate workers with the same tokens. On 2026-10-02 the active cPanel adapter was verified launching distinct workers, restarting Stocks without interrupting Crypto, and restoring the legacy supervisor during a controlled rollback before reactivating independent mode.


# OmniMod Crypto Discord Bot

## Broad directory research — local implementation, not yet deployed

`CRYPTO_BROAD_DISCOVERY_ENABLED=true` defaults on in this local tree. The existing ranked price/strategy cohort stays unchanged while `src/broadDiscovery.js` independently collects the entire CoinGecko active directory and rotates cheap ID-based price requests. Setting the environment flag to `false` disables this additional collection even if a guild saved `true`. This phase does **not** remove the production rank gate or publish extra watches/approved setups.

- Directory: `/coins/list?include_platform=true`, daily refresh, no pagination, provider IDs plus network/contract metadata. Duplicate tickers remain distinct. Blank tickers are explicit metadata gaps. Complete refreshes record additions, active-directory absences and identity metadata changes; absence is not treated as proof of exchange delisting. Failed/malformed responses retain the prior directory; after 48 hours it cannot drive new price batches.
- Prices: durable ID cursor; at most 50 IDs and 1,500 encoded ID characters per request, no sparkline/history downloads. A public 250-ID request returned 403 while 50-ID requests succeeded; the underlying rejection cause is unconfirmed. Missing/stale/invalid rows and cheap snapshot liquidity/activity rejections are stored separately. No rank ceiling applies to this research collector. Production score/model/quote/risk controls remain unchanged.
- Cache/recovery: shared by credential identity across guilds; persisted refresh backoff and cursor; in-process duplicate-call exclusion. Compressed dated directory and price observations live under `data/broad-discovery-history`; current caches are `market-broad-*.json`. The history is currently append-only: archive/retention policy remains pending. Directory metadata does not establish a venue pair or executable price.
- Diagnostics: `/crypto diagnostics` and `npm run report:operator` in `../new-bots` expose directory and rolling-price coverage separately from the production universe. Per-guild universes are not summed into a fictitious unique market count. Missing quota headers remain unknown. Demo planning reserves the existing worst-case scheduled identity-call estimate when a key is configured and defers broad collection when that leaves no allowance. It is **not** account-wide quota enforcement; monitoring, retry and other-client traffic is excluded.

Run `npm run probe:broad-discovery` for a public, read-only probe using isolated `data/broad-discovery-probe` caches. It does not use paid keys, post to Discord or reserve trades. Repeated runs respect its persisted cadence. Evidence on 2026-10-02: **21,782 active IDs**, 2,541 ambiguous ticker strings, four blank tickers; first successful rotating batch returned 50 prices, 30 fresh at observation, 18 stale and two invalid/missing prices. Production baseline snapshot contained 348 assets. At the observed 50-ID/15-minute envelope, a sweep takes at least **109 hours**, excluding errors/URL constraints. This is a coverage audit and research foundation, **not adequate current full-market intraday screening**. A legitimate bulk venue feed, verified larger licensed batches or another measured throughput design is still required, followed by identity-safe detailed analysis and forward validation.

Provider contracts: [CoinGecko active directory](https://docs.coingecko.com/demo/reference/coins-list), [CoinGecko market data and ID limits](https://docs.coingecko.com/demo/reference/coins-markets). Exact observed evidence: `../review-verification/crypto-broad-directory-20261002.json`.

Crypto-only, long-side market research, selective paper signals, continuous monitoring, and outcome calibration. Version 4 adds Level-2/trade microstructure, execution simulation, target-before-stop outcome distributions, repeated purged validation, conformal abstention, options/liquidation context, event vetoes, and fresh-data champion/challenger promotion.

## Important boundary

- No model can promise only wins or guaranteed profit. Crypto can gap through any modeled stop.
- The bot performs probabilistic research and paper tracking. It does not connect to wallets, hold funds, or place orders.
- Never give the bot a seed phrase, wallet private key, exchange secret, password, or withdrawal credential.
- Paper-test across a meaningful number of signals and market regimes before considering any real-money decision.

## What version 4 changes

The original implementation ranked a CoinGecko snapshot with manually weighted momentum inputs and displayed that score as confidence. That was useful screening, but it was not a calibrated probability and had no independent execution-market confirmation.

Version 4 retains every deterministic v3 safety gate and adds:

- CoinGecko broad-market discovery with automatic CoinPaprika discovery failover.
- Discovery freshness gate: new candidates require a valid provider `last_updated` no older than `CRYPTO_MAX_DISCOVERY_ASSET_AGE_MINUTES` (default 30). A stale shared-cache snapshot cannot create new candidates, and each rejection is recorded as a freshness reason in scan diagnostics. Missing timestamps remain visible as an explicit rejection rather than being treated as current. This guards discovery only; it does not prevent existing paper positions from being monitored. CoinGecko documents the `/coins/markets` `last_updated` field; the age limit is this bot's conservative configurable policy, not a provider guarantee. See [CoinGecko API changelog](https://docs.coingecko.com/changelog/10122018).
- Binance, Coinbase, and Kraken public-market confirmation. No exchange API key is requested.
- Process-local provider-host cooldowns honor `Retry-After` across the exchange-market and CoinGecko request wrappers: new requests to a throttled host are deferred without sending, bounded same-request retries wait only within their retry budget, and other hosts remain available for fallback. Calls already in flight when the throttle response arrives may finish; cooldown state is not shared across separate processes or hosts.
- Exchange confirmation requires an explicit market-observation timestamp, rejects receipt-time-only Kraken tickers from consensus, and accepts no quote more than five seconds ahead of the scan clock or older than five minutes. Rejection counts are preserved with each asset's market data; the age and clock-skew bounds are policy settings, not provider guarantees.
- Robust median price consensus, bid/ask spread checks, price-dispersion rejection, and best-available order-book imbalance.
- 15-minute candle analysis using EMA 9/21/50, RSI 14, MACD, ADX, ATR, volume z-score, 1h/4h return, and candle consistency.
- A BTC risk-on/neutral/risk-off regime gate. Risk-off conditions block new long signals.
- Separately cached CoinGecko global context: total market cap/volume, BTC/ETH dominance, and 24-hour global market-cap/volume changes. It refreshes at most hourly via the public `/global` endpoint, is marked stale when its provider timestamp exceeds six hours, validates provider timestamps and field plausibility (missing activity remains unavailable rather than zero; aggregate totals cannot be negative), and is display/diagnostic context only; it does not change the existing BTC gate, scores, or approvals. A failed/missing global response leaves the BTC-only regime path intact. See [CoinGecko global market data](https://www.coingecko.com/en/api) and [public API rate limits](https://support.coingecko.com/hc/en-us/articles/4538771776153-What-is-the-rate-limit-for-CoinGecko-API-public-plan).
- A conservative chronological walk-forward check; ambiguous same-candle target/stop crossings are graded stop-first.
- ATR- and spread-sized stops, fee/slippage-aware reward/risk, and cost-adjusted expected value.
- A two-stage exit: take 50% paper profit at 1R, move the remaining stop to break-even, then target the final objective.
- Bayesian probability calibration against comparable stored paper outcomes. Empirical estimates and approximate lower bounds are withheld until the cohort has at least 30 outcomes across five distinct UTC days; model-status diagnostics report holdout and validation-fold day coverage. The message shows the method and sample/day counts.
- Performance in R units, including expectancy, profit factor, net R, and maximum drawdown. Win rate alone is not treated as proof of profitability.
- Append-only features and outcomes for every screened setup, including rejected/no-trade candidates, plus monthly 15-minute candle storage for replay.
- Conservative shadow labels: a candle stop is checked before its target when one OHLC bar touches both.
- A gradient-boosted decision-stump meta-model with chronological training, outcome-overlap purging, an untouched later holdout, and at least five distinct UTC days in every validation fold and the blind holdout.
- Hard activation rules: the learned model cannot affect signals unless holdout AUC is at least 0.52 and Brier score improves over the training prior.
- Context models and Bayesian calibration segmented by trade horizon, market-cap class, and BTC regime.
- Kraken Futures, Deribit, and best-effort Binance Futures funding, basis, open interest, positioning, and taker-flow confirmation. Extreme long crowding blocks a call.
- Binance, Coinbase, and Kraken public WebSockets. A material move can request an early REST recheck but cannot bypass any signal gate.
- Automatic shutdown for non-positive rolling expectancy, excess R drawdown, poor probability Brier/forecast-versus-outcome fit, or abnormal provider conflict. Probability guard inputs are stored v2 forecast/outcome pairs; some score-prior forecasts may be withheld from public cards until evidence matures, so a Brier-triggered pause is a conservative safety action, not proof of calibrated odds.
- A concurrent-signal cap and seven-day return-correlation gate to avoid presenting duplicate crypto exposure as diversification.
- Forward collection of Coinbase/Kraken Level-2 books and aggressive trades, with Binance depth/trades when location eligibility permits. Five-minute aggregates store spread, depth, CVD, order-flow imbalance, aggressor ratio, intensity, volatility, and price impact.
- Separate learned outputs for final-target-before-stop probability, event time, realized R, maximum favorable excursion, and maximum adverse excursion.
- Repeated purged walk-forward folds followed by a permanently later blind holdout. Testing several model sizes adds an explicit multiple-testing penalty.
- Conformal prediction sets and standardized feature-shift detection. Ambiguous or out-of-distribution learned outputs force `WAIT / NO TRADE`.
- A latency/depth/spread/adverse-flow execution simulator and 1,500-run cost stress test. Models and individual calls fail closed when stressed costs erase the edge.
- Deribit DVOL, put/call IV skew, IV term structure, open-interest ratio, and observed liquidation context for BTC/ETH.
- Champion/challenger deployment: a validated candidate is staged and can replace production only after outperforming it on observations created after staging.
- Manually classified `/crypto event` records with direction, event type, scheduled/unexpected status, expected horizon, impact, optional HTTPS source, future start time, and block/caution/observe behavior. With `CRYPTO_EVENT_VETO_ENABLED` on, **block** vetoes new approvals, **caution** sets the `eventCaution` feature supplied to the learned model (it is not a deterministic penalty or gate by itself), and **observe** is context only. With the setting off, active event records are not supplied to the scan. Tags are operator supplied and unvalidated; they do not constitute an automated catalyst feed. Other frozen catalyst tags are copied to shadow observations and `/crypto research` can summarize outcomes by tag as exploratory attribution, not causal evidence or model input.
- Optional `CRYPTO_CATALYST_SOURCE=finnhub` adds a scheduled US macro-event blackout through the shared Finnhub Economic Calendar adapter. Optional `news` or `finnhub+news` also fetches the official Finnhub Market News crypto category and displays up to five recent headlines on qualified short-term alert cards. Headlines are market-wide context and may not mention the alerted token; they are not sentiment-scored, are not classified as catalysts, and do not change model scores, approval, or risk controls. The news request runs only when discovery candidates exist, caches/coalesces reads for three minutes, rejects future, older-than-six-hour, and explicitly out-of-category items; preserves Finnhub provider/category/publication time/related entities, validated article URLs, and publisher certainty, visibly marking missing publisher attribution. It reports missing credentials/provider failures without changing approval. Macro remains off by default (`manual`); its medium/high US releases in a conservative three-date window veto new candidate approvals and missing credentials/provider failures fail closed. Macro calendar cache behavior remains 15 minutes on success and 30 seconds on failure. Finnhub entitlement, plan limits, account access, and news relevance/completeness are unverified. Configure `FINNHUB_API_KEY` only in the local environment; no scraping or external order route is used.
- An idempotent normalized NDJSON importer for licensed point-in-time candles, observations, and microstructure exports.

The stricter model may produce no signal. That is intentional: `WAIT / NO TRADE` is better than forcing a weak setup.

## Signal decision flow

1. Discover liquid, non-stablecoin assets inside the configured rank and volume limits.
2. Pre-screen broad momentum so exchange requests are limited to the strongest candidates.
3. Confirm the asset with independent public providers.
4. Reject stale/conflicted prices, wide spreads, insufficient candle/validation history, or a risk-off BTC regime.
5. Score market structure, technical trend, provider quality, order-book balance, market regime, derivatives confirmation, and recent chronological validation.
6. Apply the rolling risk guard, concurrent-position cap, and return-correlation gate.
7. When enough clean labels exist, require the holdout-qualified meta-model probability gate; otherwise leave that layer inactive.
8. Require the configured minimum score, provider count, reward/risk, and positive cost-adjusted expected value.
9. Post only qualified paper-long signals and monitor them continuously.

## Reading a signal

- **BUY ZONE / PAPER LONG**: enter only inside the displayed zone. Do not chase above it.
- **Take profit 1**: at 1R, bank 50% of the paper position and move the remaining stop to break-even.
- **Final target**: close or trail the remainder according to the message.
- **Hard invalidation**: exit the paper thesis. Never widen the stop or average down.
- **Risk sizing**: the maximum allocation is derived from the configured account-risk cap and the stop distance, then capped at 25%.
- **Probability evidence**: the event is after-cost paper realized R above zero; it is not the ensemble score, certainty, or the probability of reaching the final target before a stop. The alert shows a percentage only for a non-abstaining holdout-qualified model estimate or a historical score-band estimate after at least 30 comparable outcomes across five distinct UTC completion days. That score-band estimate blends outcomes with a score-derived prior; it has not passed an independent calibration test. Otherwise the percentage is withheld and the card says the prior is not a measured probability. The internal modeled-EV gate still uses that prior while evidence is collecting, so a paper setup can qualify without a displayed historical probability; independent model, provider, execution, regime, and portfolio-risk gates still apply. Any displayed model or historical estimate is not a guarantee or proof of profitability. The five-day rule reduces same-session clustering but does not establish independent samples or validate profitability.
- **Expected value**: estimated average R per similar opportunity after configured round-trip cost.

Outcome colors:

- Green: partial/final target or a protected positive exit.
- Blue: price exceeded the final target threshold.
- Yellow: the setup expired near break-even or did not qualify.
- Orange: risk-budget warning; do not widen the stop or add.
- Red: initial stop or negative cost-adjusted timed result.

## Commands

- `/crypto help`
- `/crypto setup`
- `/crypto configure`
- `/crypto api-key`
- `/crypto scan`
- `/crypto momentum`
- `/crypto asset`
- `/crypto tracker`
- `/crypto history`
- `/crypto performance`
- `/crypto validate`
- `/crypto model`
- `/crypto research`
- `/crypto train`
- `/crypto guard`
- `/crypto event`
- `/crypto import-data`
- `/crypto status`
- `/crypto diagnostics`
- `/crypto role`

Setup, configuration, provider-key, scan, validation, training, guard, event, import, and role commands require Discord `Manage Server`. `/crypto validate` requests up to 1,000 recent 15-minute candles and reports the earlier segment, recent holdout segment, total walk-forward behavior, and execution-cost stress. A small or positive sample is not proof of future profit.

`/crypto diagnostics` shows retained scan-funnel counts, structured gate rejections, stage timing, provider latency/quota telemetry, and proposed versus successfully delivered signals. Provider cooldown deferrals are reported separately from upstream requests, failures, and HTTP 429 responses; deferred calls do not inflate request counts or latency averages. Signal sends are isolated per candidate so one Discord error does not prevent other candidates from posting. Closed-outcome notifications are saved to a bounded retry outbox before delivery; failed sends remain pending and are retried on a later scan. Network timeouts are ambiguous: Discord may have accepted a message even when the client reports failure, so a retry can duplicate that one notification. These diagnostics describe scanner operations; they do not validate strategy performance.

## Local setup

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm test
npm start
```

Required:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`

Recommended:

- `DISCORD_GUILD_ID` for immediate guild command registration during testing.
- `OMNIMOD_CRYPTO_DATA_DIR` for an explicit durable data path.
- `COINGECKO_API_KEY` and `COINGECKO_API_TIER=demo|pro` for more reliable broad discovery. Keyless public mode remains supported.
- `CRYPTO_MONITOR_MINUTES=5` for open-signal observations.
- `CRYPTO_DISCOVERY_MINUTES=15` for new opportunity discovery.
- `CRYPTO_MIN_PROVIDER_CONFIRMATIONS=2` (broad snapshot plus at least one live exchange by default).
- `CRYPTO_MAX_PROVIDER_CANDIDATES=8` to bound exchange request volume.
- `CRYPTO_MIN_RISK_REWARD=1.7`.
- `CRYPTO_ACCOUNT_RISK_PCT=0.5`; accepted range is 0.10%-1.00%.
- `CRYPTO_ROUND_TRIP_FEE_BPS=20`; set this to a realistic entry+exit fee/slippage estimate for the intended venue.
- `CRYPTO_MAX_CONCURRENT_SIGNALS=3` and `CRYPTO_MAX_SIGNAL_CORRELATION=0.82` bound portfolio concentration.
- `CRYPTO_META_MIN_SAMPLES=200`, `CRYPTO_META_RETRAIN_HOURS=24`, and `CRYPTO_MIN_META_PROBABILITY=0.56` control learned-model activation and gating.
- `CRYPTO_RESEARCH_RETENTION_DAYS=730` controls append-only observation/candle retention.
- `CRYPTO_GUARD_*` variables control rolling sample, expectancy, drawdown, Brier, and lookback shutdown thresholds.
- `CRYPTO_DERIVATIVES_ENABLED=true` and `CRYPTO_REALTIME_ENABLED=true` enable public futures confirmation and spot WebSocket triggers.
- `CRYPTO_MICROSTRUCTURE_ENABLED=true` and `CRYPTO_MICROSTRUCTURE_FLUSH_SECONDS=300` enable five-minute Level-2/trade research aggregates.
- `CRYPTO_SIMULATED_ORDER_USD=1000`, `CRYPTO_EXECUTION_LATENCY_MS=750`, and `CRYPTO_MAX_EXECUTION_SLIPPAGE_BPS=35` configure the paper execution model.
- `CRYPTO_VALIDATION_FOLDS=4`, `CRYPTO_BLIND_HOLDOUT_FRACTION=0.15`, and `CRYPTO_CONFORMAL_ALPHA=0.20` configure validation and uncertainty.
- `CRYPTO_MAX_OOD_SCORE=4`, `CRYPTO_CHALLENGER_MIN_SAMPLES=50`, and `CRYPTO_CHALLENGER_BRIER_IMPROVEMENT=0.005` configure abstention and promotion.
- `CRYPTO_EVENT_VETO_ENABLED=true` enables active event block/caution windows.
- `CRYPTO_HISTORICAL_IMPORT_DIR` optionally points to a normalized licensed-data staging directory.

Run `/crypto configure` to change the main risk and provider gates for one server without editing environment variables.

## Licensed-history import contract

`/crypto import-data` reads only `.ndjson` files from `CRYPTO_HISTORICAL_IMPORT_DIR` and records a size/mtime manifest so unchanged files are not duplicated.

- `candles-*.ndjson`: one JSON object per line with `symbol`, `provider`, `time`, `open`, `high`, `low`, `close`, and `volume`.
- `observations-*.ndjson`: the bot's `shadow_created`/`shadow_resolved` event contract, including `observationId`, `timestamp`, and feature/outcome fields.
- `micro-*.ndjson`: normalized five-minute feature samples matching `MicrostructureAccumulator.snapshot()`, including `symbol`, `observedAt`, and `available`.

Vendor-specific parsing must happen before import. Rejecting an unfamiliar schema is safer than silently misreading side, units, timestamps, or contract multipliers.

For a reproducible offline rule-strategy run directly against a pinned importer-format dataset, use `npm run backtest:historical -- --data=path/to/candles.ndjson --asOf=2026-09-29T23:59:00Z --roundTripFeeBps=20`. This legacy option is one combined round-trip cost proxy. Prefer explicit components when assumptions are available, for example `--feeBpsPerSide=10 --quotedSpreadBps=4 --slippageBpsPerSide=2`; these total 28 bps per round trip (two fees, one full quoted spread, two slippage reserves). Do not combine the legacy option with component inputs. The report records its cost model. JSON arrays and `{ "candles": [...] }` files are also accepted. `--asOf` is mandatory; candles whose 15-minute interval was not complete by that instant are excluded, and rows are evaluated separately by symbol and provider. The report includes earlier/recent/overall performance, sample coverage, performance by BTC market regime, and outcome counts/expectancy/profit factor/net R/max drawdown by exit reason (`stop`, `deadline`, `protected_exit`, `final_target`). Exit-reason groups are descriptive diagnostics, not independent strategy comparisons. This path reads the file directly, does not mutate bot storage or query providers, and uses the existing fixed rule strategy; parameter changes on a repeatedly inspected holdout invalidate that holdout. Imported data can still contain survivorship, venue, adjustment, and coverage bias.

To use explicitly supplied point-in-time execution assumptions, pass `--costSchedule=path/to/costs.json` instead of static fee/slippage assumptions. The file is either an array or `{ "rows": [...] }`; each row has a unique `id`, UTC `validFrom`/`validUntil`, `feeBpsPerSide`, `slippageBpsPerSide`, and credential-free HTTPS `source`, plus optional `quotedSpreadBps` for a date-specific full spread. Rows are half-open intervals; overlaps are rejected and strategy-qualified candidates in schedule gaps are skipped and counted. `--quotedSpreadBps` supplies a fallback full-spread assumption only when the matching row omits `quotedSpreadBps`. Total cost is two scheduled fees + effective full spread + twice scheduled slippage. The report shows applied schedule IDs, cost breakdown/provenance, and gap counts by walk-forward segment. URL shape is validated, but source authenticity and actual fills are not. The schedule is local operator input, not fetched/verified broker fees.

To acquire a bounded public BTC Spot candle dataset for exploratory replay, run `npm run fetch:historical -- --symbol=BTCUSDT --start=2026-04-01T00:00:00Z --end=2026-09-29T17:00:00Z --maxBars=18000 --out=data/research/historical/BTCUSDT-15m-2026-04-01_to_2026-09-29.ndjson`. The importer uses Binance's public Spot `/api/v3/klines` endpoint in UTC, one symbol and 15-minute bars, at most 1,000 rows per request, a bounded retry policy, a short inter-page delay, and an explicit maximum of 20,000 expected bars. It excludes incomplete bars, writes a SHA-256/provenance sidecar manifest, refuses to overwrite existing output, and reports missing bar slots; a dataset with gaps is marked incomplete and the CLI exits nonzero. It never uses authenticated endpoints. Pair the output with `npm run backtest:historical -- --data=<path> --asOf=<end-time> --roundTripFeeBps=<assumption>`. OHLCV is not executable bid/ask or actual fills; the fixed fee assumption does not independently model spread, market impact, venue outages, or actual slippage. This workflow is for personal exploratory validation only and does not verify redistribution rights, entitlement, or profitability. See [Binance Spot Kline/Candlestick docs](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#kline-candlestick-data).

For the pinned BTC-derived fixed-rule comparison on SOL, XRP, BNB, and ADA, run `npm run backtest:cross-asset`. It checks the five local 15-minute BTC/SOL/XRP/BNB/ADA dataset hashes against their sidecar manifests, enforces the shared 2026-04-01 through 2026-09-29 17:00 UTC window, uses BTC only for timestamp-matched regime labels, and applies unchanged strategy parameters at modeled 10/20/40 bp round-trip costs. It writes `CROSS_ASSET_FIXED_RULE_VALIDATION_2026-09-30.json` and `.md`, including deterministic UTC-day-cluster bootstrap intervals. The data are OHLCV rather than executable quotes, the cost tiers are assumptions, and the BTC-derived rule was previously examined; this is exploratory cross-asset evidence, not a blinded test or evidence of profitability. The current results are negative across the four evaluation assets, so this rule is not promoted.

## Provider behavior

Broad discovery uses a cached bulk market request. If CoinGecko fails, the worker tries CoinPaprika before using a stale local snapshot. New candidates and open-signal observations use best-available public Binance, Coinbase, and Kraken data. Individual exchange failures are recorded and do not crash the full scan.

With a configured CoinGecko **Demo or Pro** key, deep quote confirmation now requests CoinGecko's coin-ID ticker page and active exchange-ID directory, then admits only matching Binance/Coinbase/Kraken base/quote pairs for that exact coin ID. A failed identity request or fewer than the required verified venue pairs withholds a new setup; one volume-sorted ticker page is inspected, so omitted later-page pairs can cause a false negative. The exchange directory is cached for 12 hours and each coin-ID allowlist for one hour. Keyless public/CoinPaprika fallback remains available for research but is explicitly `ticker_only_unverified`; matching symbols across venues alone do not establish coin identity. CoinGecko documents both [Demo coin tickers by ID](https://docs.coingecko.com/demo/reference/coins-id-tickers) and the [Demo exchange list](https://docs.coingecko.com/demo/reference/exchanges-list).

`/crypto diagnostics` separates the bulk-discovery page projection from two illustrative keyed-Demo identity loads: a repeated deep shortlist using the one-hour coin-ID cache, and a fully rotating shortlist that needs a new ticker lookup each discovery. At the default 15-minute schedule and eight-candidate cap, the existing bulk-page projection is 5,760 calls per 30 days; the two combined scenarios are up to 11,580 and 28,860 including 12-hour exchange-directory refreshes. These are **not** an account-wide quota guard or a forecast of actual usage. Monitoring open positions, manual commands, retries, other guilds, other API clients, and varying candidate counts are outside the scenarios. The latest scan's instrumented identity-request attempts appear alongside them; monitor actual provider usage and 429 responses before relying on a Demo key. No strategy or risk gate changes with this projection.

Historical candles are tried in provider order with a five-minute in-process cache and persisted under the data directory for research replay. Coinbase and Kraken naturally return shorter histories than Binance; the validation output always shows the actual provider and candle count.

Derivatives data uses public Kraken Futures and Deribit summaries plus Binance Futures when the deployment location is eligible. A restricted or unavailable provider is logged and excluded; it never counts as confirmation. These inputs are low-weight confirmation/crowding features and are never used to recommend leverage.

BTC and ETH also use the live Deribit options surface. Put/call skew, front/back IV, DVOL movement, and observed liquidations are confirmation or veto features only. They do not create leveraged trade instructions.

## Continuous monitoring

The scheduler wakes every minute, while public WebSockets watch the active candidate set between scheduled scans:

- When paper signals are open, consensus price monitoring becomes due at `CRYPTO_MONITOR_MINUTES`.
- New discovery becomes due at `CRYPTO_DISCOVERY_MINUTES`.
- At 65% of the initial loss budget, the bot emits a one-time risk warning.
- At 1R, it records the partial target and moves the effective paper stop to break-even.
- Final target, exceeded threshold, protected exit, stop, or deadline closes the result.
- A sufficiently large WebSocket move requests an early full recheck, throttled per server. Scheduled REST consensus remains authoritative.
- The risk guard is recomputed after outcomes and pauses only new signals; open paper calls continue to be monitored.
- Level-2 and trade streams update execution features in memory continuously; compact research samples are persisted every five minutes to control disk growth.

This remains a research monitor, not an execution engine. WebSocket quotes reduce detection latency but do not recreate exchange fills, queue position, taxes, or gap slippage.

## cPanel deployment

1. Create a Node.js 20 production application.
2. Use application root `crypto-bot` and startup file `app.cjs` (the Passenger-compatible launcher).
3. Upload all files except local `node_modules`, `.env`, and runtime `data`.
4. Do not overwrite cPanel's generated `.htaccess`.
5. Run NPM Install. If cPanel rejects an existing physical `node_modules` directory, activate the app Node environment and run `npm ci --omit=dev` from the app root.
6. Add required environment variables in cPanel.
7. Set a durable `OMNIMOD_CRYPTO_DATA_DIR` outside the replaced app root.
8. Save and restart the application.
9. Open `/crypto-bot/health` and confirm `state` is `running` and both `worker.discordReady` and `stocks.discordReady` are true. Stocks runs in the combined service; leave the separate Stocks cPanel app stopped to avoid duplicate sessions.
10. In Discord, run `/crypto setup`, `/crypto configure`, `/crypto scan`, and then `/crypto validate query:BTC`.

JSON writes are atomic. Shared provider-window claim files reduce duplicate broad-market requests during simultaneous Passenger restarts.

## Validation policy

- Do not tune thresholds against a handful of winning calls.
- Evaluate positive rate together with expectancy, profit factor, net R, drawdown, and sample size.
- Keep fees/slippage realistic and re-run validation after changing risk/reward settings.
- Treat fewer than 30 comparable closed signals across at least five distinct UTC outcome days as an early calibration sample; same-day clustering can overstate evidence.
- Do not lower `CRYPTO_META_MIN_SAMPLES` merely to activate the learned model. Rejected models remain visible through `/crypto model`.
- Use `/crypto research` to verify rejected setups are being labeled; training only on published wins creates selection bias.
- A candidate must improve repeated purged folds, a blind segment, and stressed execution expectancy. Once staged, promotion requires at least `CRYPTO_CHALLENGER_MIN_SAMPLES` genuinely newer labels.
- Keep licensed vendor transformations outside the bot and import only the normalized contract below; this prevents silent provider-schema drift.
- New signals require sufficient walk-forward trades plus positive recent and overall expectancy with profit factor above 1; otherwise the decision is no trade.
- Compare performance across trending, range-bound, and risk-off periods.
- Retire or tighten a configuration when recent holdout expectancy is non-positive; do not hide losing periods.

## Known limitations

- Public provider histories are short and may omit low-activity intervals.
- Symbol-only exchange mapping can be ambiguous for unusual assets; provider disagreement blocks a call but cannot solve every token-identity collision.
- Order-book imbalance is a transient snapshot and can be spoofed; it has deliberately low ensemble weight.
- The model is long-only. It uses derivatives market data only as confirmation/crowding context, does not issue leveraged shorts, and never recommends leverage.
- Open-interest deltas are scan-to-scan estimates for providers that do not expose the same historical interval; a restart makes that feature neutral until a prior observation exists.
- Public WebSockets and futures endpoints can be geo-restricted or intermittently unavailable. Scheduled multi-provider REST checks remain the decision source.
- The boosted model intentionally begins inactive and may remain inactive if future holdout performance does not beat the baseline.
- Level-2 features begin unavailable after restart and become usable only after live books/trades accumulate. Their absence is neutral; stale data never counts as confirmation.
- Manual event/catalyst records are only as complete and accurate as operator entries; classifications are not model-verified. Observe-only events do not change gates; caution and block severities retain their existing behavior. These records supplement provider health and market-risk gates and do not replace an automated sourced catalyst feed.
- Backtests are a diagnostic, not evidence of live fills. They charge configured costs and gap-through stops, but exclude taxes, venue outages, liquidation, and unobserved intrabar execution.
- Past paper outcomes and calibrated probabilities can stop working when market structure changes.

## Token security

Discord bot tokens and client secrets are credentials. Rotate any token pasted into chat or another temporary surface before deployment. The bot never needs exchange trading or withdrawal credentials.

## September 2026 accuracy corrections

- Backtest exits stay inside their chronological partition; incomplete horizons are not scored. Entries use the next candle open. Fees and gap-through stops apply to losses as well as winners.
- Signal EV uses observed net payoff averages when enough comparable winners and losers exist, or a conservative 1R partial-profit/protected-exit scenario. Final-target probability is kept separate from positive-return probability. Position sizing includes estimated costs.
- The strategy banks half at 1R and closes the remainder at its final target. No later follow-through is counted as additional profit. Stop exits use the observed price, so gaps can lose more than 1R.
- Only completed, recent candles are accepted, and the last 80 technical-analysis bars must be contiguous 15-minute intervals. Invalid, crossed, stale, and duplicate exchange quotes do not confirm a signal.
- Current research outcomes use version-3 source/pair-pinned completed-candle labels. Model training additionally requires a fresh source-timestamped ask from that exact venue/pair at observation creation, with entry levels and modeled costs frozen then. Earlier version-3 consensus-entry rows can still resolve for audit but are excluded from training; stored models without the entry-evidence policy version are inactive until retrained. This may substantially reduce the eligible sample and alerts.
- Shadow resolution uses completed bars entirely inside the observation window, with adverse-first ordering when a bar touches multiple barriers. Missing intervals remain unresolved. For an unaligned deadline, the journal may record its latest earlier candle close, at most 15 minutes early, with reason `deadline_last_closed_candle`; a later market quote never substitutes for that deadline. **That early-close result is an approximate audit mark, excluded from model training and liquidity-shadow performance comparisons.** The partial first candle and intrabar order remain unobservable with 15-minute data. Stored model bundles lacking outcome-evidence policy version 1 are disabled on load.
- Persistent-worker deployment fingerprints cover both workers' runtime files and package manifests. The combined host rejects missing or identical Crypto/Stocks tokens before connecting either Discord client.

Run `npm test` and `npm run check` before upload. These checks validate implementation and regressions; they do not establish profitability or exercise live Discord/trading connections.

## Intraday trades versus longer holdings

Use /crypto momentum and /crypto asset for the existing 15-minute paper-trade setup. Use /crypto invest for separate swing-horizon daily price-trend research, or /crypto invest query:ETH for one asset. It uses completed daily candles, never a stretched intraday target. The 5/20/60-calendar-day views are not an actionable swing entry/exit system or forecast. It also reports 90/180/365/540/730-day historical price returns versus BTC when the provider supplies complete aligned bars; this context does not change the daily rank, candidate selection, or approval gates, and unavailable history stays explicit. It screens up to 12 currently liquid assets across a market-cap core, weekly-momentum discoveries, and relative-turnover discoveries, using at most two concurrent candle-history fetches. It requests up to 1,000 daily bars; effective history is provider-dependent (Binance max 1,000, Kraken max 720, Coinbase max 300 in this adapter). It displays the top three research results. This broadens the candidate sample without changing the daily technical gates or score; selection-track results require prospective forward comparison before judging the new pool. For a multi-year human-authored thesis, use /crypto thesis instead; it does not create a signal or assess whether a thesis is correct.

The BTC context separately shows trend, annualized 20-consecutive-day volatility relative to up to 252 recent rolling windows, and drawdown from its 252-day peak. Frozen daily and monthly long-window observations retain the volatility bucket and can be summarized by horizon. A missing daily-candle date resets Crypto's volatility history; older journal records stay in an unknown cohort. These are price-only descriptive cohorts, not macro/stress detection, crash predictors, or strategy inputs.

A stale, future-dated, missing, or more-than-one-hour-old liquidity snapshot blocks the daily ranking. The command shows its liquidity timestamp, BTC source and historical fee assumption. The daily rank checks 200 days of aligned history, 50/200-day trend, trend persistence, 20/60-day strength relative to BTC, 60-day annualized daily volatility, 90-day drawdown and current dollar volume. The additional 90/180/365/540/730-day comparisons are separate historical price context, not features in that rank. A favorable result says **DAILY TREND WATCH**. Its ordinal score is not a probability, intrinsic valuation, expected return, or instruction to allocate money. Weak trend, benchmark lag, extreme volatility or drawdown produces WAIT / HIGH RISK. Incomplete, stale, gapped or benchmark-misaligned data receives no rank.

`/crypto thesis action:add` stores your own asset thesis, thesis type, horizon, planned review date, assumptions, base/bull/bear cases, invalidation evidence, catalysts, and at least one (up to five) HTTPS source URL. The bot checks HTTPS syntax only; it does not verify source quality. Optionally supply `protocol_slug` as the exact DeFiLlama project slug (not the token ticker), and `github_repo` as an exact public GitHub `owner/repo` mapping that you have verified manually. The bot never guesses a repository from a token ticker. `list` shows the latest revision by asset; `show` displays that revision. `due` is a date reminder; `review` captures a fresh provider market/supply snapshot against the latest saved revision when the exact asset is present. It also appends the provider-reported supply snapshot to the existing per-server history, then shows same-provider circulating/total supply changes against the nearest available 30/90/365-day observation; missing history stays unavailable. When a same-provider 365-day comparison spans at least 180 days, it also reports the exact-time annualized equivalent of the observed net supply change. This is historical description, not an inflation forecast or unlock schedule. For a mapped GitHub repo, manual review requests the public REST commit list for the previous 180 days (up to five pages of 100), and reports commit and identified-contributor counts for the latest and prior 90-day windows. If the page cap is reached, counts are marked lower bounds; unknown GitHub author accounts are excluded from contributor totals. Optional `GITHUB_TOKEN` uses the public REST API authenticated for higher request quota; it is only sent to `api.github.com`. Without it, unauthenticated public API access is attempted. HTTP/rate-limit failures remain explicit unavailable statuses. This describes repository activity only; it is not a code-quality, independent-maintenance, security, or value-capture measure. `/crypto thesis action:coverage` shows each evidence domain's latest numeric fact date and its age relative to the saved capture when a period date exists, plus per-field source where available. This is descriptive recency, not a universal stale-data threshold; market snapshots, on-chain aggregates, and financial statements have different update cadences. If a protocol slug is saved, manual review requests public DeFiLlama protocol TVL history. Set optional `DEFILLAMA_API_KEY` locally to additionally query the paid protocol financial statement, emission/unlock, active-user, and transaction-metric endpoints. Without a key, or if paid endpoints fail, public TVL is still attempted. No paid endpoints run during scheduled scans. Paid responses can have incomplete or project-specific coverage; the bot records supported financial line items, reported supply metrics, activity aggregates, current allocation percentages, and up to three upcoming dated unlock events when present. For each same-asset, same-slug activity metric and unit, review summarizes up to four of the latest dated captures and reports first-to-last change plus rising/falling/flat steps. It requires at least two captures, omits percentage change for a zero baseline, and labels these small irregular samples as directional description rather than sustained adoption. User/transaction totals are provider-reported activity aggregates; they do not verify unique human users, economic value, token value capture, or protocol claims. Unknown fields remain unavailable. TVL may move because asset prices changed, not only because deposits or usage changed. Security, decentralization, ownership concentration and intrinsic value remain unmeasured. Captures are private, append-only and dated. Each add appends a revision. Replies are ephemeral, and the journal is stored locally per Discord user in the bot's private data directory. Keep that directory during deployment if you want to retain your notes. Do not put secrets or sensitive account details in thesis text.

A separate, fixed daily trend/relative-strength rule reports realized 5-, 20-, and 60-calendar-day holding windows. Each horizon uses non-overlapping windows, next-open entry, completed-close exit, explicit round-trip costs and matching BTC dates. Once per unique symbol per UTC month, the forward journal also freezes the daily 200-session screen into 90-, 180-, and 365-day long-window shadow paths when the selected venue has enough contiguous daily history. These shadow results require a unique ticker in the current snapshot plus the same provider and quote currency for the asset and BTC. Ambiguous duplicate tickers are skipped. The implemented Coinbase daily fetch cap of 300 bars permits 90/180-day capture but not 365-day capture; 365-day rows require at least 365 contiguous candles from the selected source. Forward observations now also freeze CoinGecko global-context values/status at issuance, independently of the BTC technical trend/volatility regime. `/crypto invest` reports fresh/stale/unavailable/missing context coverage by unique asset capture. This is attribution data only; no dominance or total-market cohort edge is claimed, and it does not affect selection or score. The /crypto invest and opening research views show separate pending/resolved counts, non-overlapping outcomes, and BTC-regime summaries. These are technical-screen follow-through studies, not tokenomics/fundamental holder recommendations. They add no alerts or provider requests. The historical 5/20/60 rule is deliberately simpler than the current watchlist score; its numbers do not validate that score or constitute an untouched strategy-selection holdout. Windows across different horizons overlap and must not be pooled. Fewer than 20 windows is marked insufficient. Public daily data is short, the universe contains current survivors, and costs/taxes/venue outages can change real outcomes. A longer holding period does not make crypto low risk.

Current provider contracts: [Binance daily klines](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market), [Coinbase daily candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles), [Kraken OHLC](https://docs.kraken.com/api-reference/market-data/get-ohlc-data). Binance uses interval `1d`, Coinbase granularity `86400`, and Kraken interval `1440`. The current incomplete bar is removed. Provider cache keys distinguish daily from 15-minute series. See [DAILY_DATA_SMOKE.md](DAILY_DATA_SMOKE.md) for the public-only BTC/ETH daily-history check; reproduce with `node scripts/smoke-daily-research.mjs`. `npm run smoke:day-market-data` separately checks live BTC/ETH exchange quotes and the BTC historical-candle context path, writes the latest [DAY_MARKET_DATA_SMOKE.md](DAY_MARKET_DATA_SMOKE.md), and appends a sanitized summary to `data/market-data-smoke-history.ndjson`. It makes no trade, Discord post, or strategy decision; the journal omits bid/ask prices and raw provider error text.

## Long-term protocol incident context

Private thesis reviews optionally query DeFiLlama's Pro `/api/hacks` endpoint when both `DEFILLAMA_API_KEY` and `DEFILLAMA_HACKS_ENABLED=true` are set. It uses the public `/protocol/{slug}` response's exact protocol `id`, then includes only incident rows whose `defillamaId` exactly matches. It does not fuzzy-match display names. The call is disabled by default; it is separate from enabling the existing paid financial, activity, and emissions fields. The provider currently documents Pro as a paid plan (the documentation lists $300/month; verify current price and endpoint access before subscribing). The source is a curated historical incident database, not a security audit or complete incident registry; an empty match does not establish that a project is safe. The free TVL path continues to work without this setting. See [DeFiLlama Pro API documentation](https://github.com/DefiLlama/api-docs/blob/main/llms-pro.txt).

## Evidence and hard risk limits

### Bounded public discovery probe

Run `npm run probe:public-funnel` to inspect the public CoinGecko/CoinPaprika discovery snapshot, the existing Binance/Coinbase/Kraken spot-directory preflight, and fresh quote coverage for at most the configured deep-analysis cap plus four directory exclusions. It forces public CoinGecko settings, isolates its local cache under `data/public-funnel-probe/`, and writes a sanitized latest snapshot to [PUBLIC_FUNNEL_PROBE.md](PUBLIC_FUNNEL_PROBE.md). The report includes stage counts, rejection codes, timing, provider request/failure/quota telemetry, and whether sampled directory exclusions would have met the source-timestamped venue threshold. It neither runs the deep trading strategy nor logs into Discord, reserves paper risk, or sends an order. A quote threshold match is not an approved setup, and four sampled exclusions cannot establish full-directory recall.

The probe separately attempts source-timestamped Kraken Spot WebSocket v2 quotes with a six-second observation cap. The normal scanner starts its realtime subscriptions before provider enrichment and waits at most three seconds only for selected assets whose directory coverage needs Kraken to reach the existing minimum. A missing or late WebSocket quote remains unavailable; Kraken REST receipt time never substitutes for a provider observation timestamp. The wait duration and ready count appear in the scan's provider-coverage diagnostics.

Use `npm run probe:public-funnel -- --deep` for an opt-in, capped public history/technical/strategy-validation diagnostic on the selected assets. It uses the existing strict screen and separately counts candidates that would remain if historical strategy validation were advisory for **research only**. It records every measured rejection code per selected asset, plus source coverage, timing and sanitized provider-error categories. The latest result overwrites `PUBLIC_FUNNEL_PROBE.md`; compact run summaries append to ignored `data/public-funnel-probe/probe-history.ndjson`, including the discovery snapshot timestamp so repeated checks of one cached snapshot are not mistaken for independent sessions. This mode does not run the learned model, manual catalyst review, portfolio guard, shared risk or delivery and cannot approve or post a setup. It may make more public provider requests than the quote-only mode; its analysis cap remains `CRYPTO_MAX_PROVIDER_CANDIDATES`.

Historical validation reports expectancy and profit-factor failure codes only for a segment with at least one observed trade. Zero-trade numeric placeholders are diagnosed as **missing evidence**, alongside insufficient sample or candle-path failures, rather than as a measured losing strategy. This does not let an insufficient sample pass approval.

Run `npm run study:public-cost-sensitivity` after a deep public probe to produce [PUBLIC_COST_SENSITIVITY.md](PUBLIC_COST_SENSITIVITY.md) without any network, Discord, model training, paper reservation, or order action. It reproduces each asset's frozen exact-provider/pair candle window and the reported fixed-cost replay before applying that asset's **current quote-time estimated all-in cost** as a separate scenario. It refuses incomplete/mismatched source windows and costs outside the replay's supported range. The newer quote cost is applied retrospectively to older candles, so the comparison is a sensitivity analysis rather than point-in-time execution history, forward validation, or a strategy promotion gate. A cost change also changes modeled stop/target geometry and possibly the trade set; do not read a higher scenario mean as proof of better trading.

Normal deep scans now record the same kind of **research-only** sensitivity in `funnel.validationCostSensitivity`: fixed historical validation cost versus the current quote-time estimated round-trip cost on the same completed candles. A comparison needs contiguous history and two nonconflicting quote venues; unavailable reasons remain explicit. `/crypto diagnostics` reports how many deep assets could be compared and how many historical pass/fail classifications changed. These observations never change strict eligibility, model approval, portfolio selection, paper risk, or alert delivery. They do not reconstruct earlier spreads, depth, fees or fills.

Add `--capture` to the deep probe to freeze prospective, research-only observations for selected assets with adequate technical history, two fresh venues, and a fresh quote from the **same provider and exact pair** as their saved candles: `npm run probe:public-funnel -- --deep --capture`. The isolated journal is under `data/public-funnel-probe/research/`; the report counts eligible, newly recorded, and duplicate observations. Repeating the command within an asset/horizon/hour bucket does not add another observation. After those observations' deadlines, run `npm run probe:public-funnel -- --resolve` to request at most 12 pinned provider/pair histories and resolve outcomes only from completed, contiguous 15-minute candles. Unavailable or insufficient histories stay unresolved; the result groups unresolved due rows by source cap, provider/pair mismatch, empty history, provider or local-store failure, incomplete candle/deadline path, or an entry-containing candle whose stop/partial-target crossing cannot be ordered relative to the entry quote. Once that last ambiguity is established in stored exact-source bars, later probe runs skip the identical 15-minute history request and keep the result unknown. No snapshot price is substituted. The public ticker-to-coin identity remains unverified, candle OHLC is not an executable bid/ask path, and modeled costs are only a reserve. These rows intentionally have no model features and cannot enter production model training, Discord alerts, or the shared paper ledger. This is a prospective diagnostic cohort, not evidence of profitable fills; run it across multiple independent sessions before judging a hypothesis.

Run `npm run probe:public-funnel -- --status` to inspect that isolated cohort without a provider request. It reports created, pending, due, resolved and invalid-deadline counts, due rows requiring finer entry-bar evidence, due rows retryable with current 15-minute bars, the earliest pending deadline and the next *future* deadline, plus evidence-qualified outcome buckets. Early deadline marks appear as `approximate_deadline_audit`, not as exact wins or losses; each frozen rejection code separately counts exact and approximate resolutions. Code counts overlap when one asset fails multiple gates. A pending row is not a loss, and an outcome count alone does not establish after-cost expectancy or a reliable fill.

The offline intraday historical replay (`node scripts/backtest-historical.js`) also reports cost-adjusted outcomes by BTC risk-on/neutral/risk-off regime for each chronological segment. The regime is classified using the existing BTC EMA/MACD/RSI/4-hour-return rule, from contiguous, completed 15-minute BTC candles on the same provider as the asset; at a signal, only candles completed by the signal candle's close are eligible. BTC can benchmark itself. If same-provider BTC history is absent or insufficient, the regime is `unknown`; another provider's BTC feed is never substituted. Empty cohorts report a zero trade count and `null` performance metrics, not a measured zero-return result. These cohorts are descriptive, may be small/correlated, and do not change strategy qualification or establish a validated edge.

`/crypto guard`, `/crypto research`, and `/crypto validate` now show net-return evidence separately from point estimates. There is no inferred result for a missing/null realized return, no future outcome leakage, and probability drift compares predictions against the same subset of outcomes with valid probabilities. New paper predictions are stamped `accountingVersion: 2`; prior tracker records remain visible for conservative loss controls but cannot establish corrected-model evidence or calibrate its probabilities.

Net expectancy reports include a descriptive approximate 95% interval with UTC-day clustering, only after at least 20 observations and five distinct days with measurable variance. Same-day correlated outcomes do not masquerade as independent samples. These intervals assume independent day clusters and stable distributions; they do not cover unobserved tail losses, regime shifts, or repeated subgroup testing. Horizon and regime slices are exploratory, not separate validated strategies. No sample means **collecting evidence**, never �validated edge.� An interval above zero is called a positive estimate, not proof of profitability. The intraday short-history backtest remains a research gate, not investment validation.

The guard also reports prediction-time probability reliability for closed, corrected-accounting paper predictions: mean forecast probability versus the observed share of positive after-cost R outcomes, their gap, Brier score, and comparison to the same-sample base-rate Brier score. It summarizes the overall cohort and exploratory horizon, asset-class, and market-regime cohorts. This answers whether forecasts have tracked outcomes descriptively; it is not independent calibration certification, and the same-sample baseline is not a holdout. Cohorts below 30 outcomes or five UTC-day clusters remain insufficient; larger cohorts are still labeled descriptive only. The descriptive segmented summaries do not affect signals. Separately, the aggregate Brier score and forecast/outcome gap are existing risk-guard inputs: once at least `guardMinOutcomes` (default 20) unique eligible v2 probability/outcome pairs exist in the rolling window, they can pause new signals at configured limits. This safety pause uses the saved model/prior values even when a public card withheld the probability for immature calibration evidence, and does not require five separate outcome days; it is a conservative safeguard, not an assertion that the estimate is calibrated. A correction now makes the pause floor use the same validated, deduplicated probability/outcome pairs as the displayed Brier score, so duplicate IDs cannot satisfy the floor. Segmented descriptive metrics still do not feed signal selection.

Hard controls apply **before** the statistical sample minimum:

- `CRYPTO_GUARD_MAX_DRAWDOWN_R` (default 5R) applies to the complete configured lookback, not only the smaller statistics window.
- `CRYPTO_GUARD_MAX_DAILY_LOSS_R` (default 3R) caps gross paper losses over the trailing 24 hours, so intervening wins cannot hide the loss budget.
- `CRYPTO_MAX_OPEN_RISK_PCT` (default 1.5%) caps summed planned paper-account risk; the existing concurrent-position cap also applies. New candidates cannot exceed the projected aggregate cap, and an already open symbol cannot be selected again even if its correlation data is missing. Gaps can exceed planned stop risk.

A pause stops new published paper signals while monitoring and shadow collection continue. Empty/small datasets do not permanently halt collection; they remain explicitly unvalidated. Hard automatic limits cannot be bypassed by the manual �resume� action. They clear when the underlying exposure or configured lookback condition clears.

## Optional finer public-probe entry and deadline audits

When an exact-source 15-minute entry-containing candle is ambiguous, `npm run probe:public-funnel -- --resolve-finer` can make at most two additional public Binance Spot 1-second history requests for due, pinned `SYMBOLUSDT` rows. It requires every second from the observation's containing second through that 15-minute bar's end, from the same pair, and withholds a row if the containing second crossed a barrier, a later second crossed a barrier, or any second is absent or invalid. A complete barrier-free path can clear the first-bar ambiguity; the normal completed 15-minute resolver then handles later outcomes. Successful finer paths are cached under the isolated probe's research directory and reused by ordinary `--resolve` without a repeat 1-second request. These extra audit outcomes retain a distinct price basis and remain excluded from production model training. This does not turn candle extremes into executable fills or verify public ticker identity. The endpoint and 1-second interval are documented in Binance's [Spot market-data reference](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market).

The same two-request cap also covers an unaligned deadline's final partial 15-minute bar. For a due Binance row, the probe can require every 1-second candle from the last completed 15-minute boundary through the last **fully completed second before the frozen deadline**. It replays stop-first, partial-target, and final-target rules on that continuous path. If no barrier is observed, the terminal mark remains an `approximate_deadline_audit` with its remaining subsecond gap stated; it is not a full-horizon executable return. Missing, mismatched or invalid seconds withhold the opt-in finer result rather than silently falling back to a coarse early close. Deadline segments are cached separately and, like entry-cleared outcomes, cannot train the production model. Plain `--resolve` retains the older completed-15-minute behavior when no finer segment is cached.

The request-free `--status` count separates `coarseDeadlineResolved` from `subsecondDeadlineResolved` while retaining their combined `approximateDeadlineResolved` total. A finer mark is still approximate because the last fraction of a second and executable bid/ask fill are not observed.

## Prospective daily journal

The existing once-daily opening discovery now also runs the capped daily research path and includes a compact daily trend watchlist in its existing opening summary. It does not increase intraday polling or create a new message channel. `/crypto invest` can refresh the same path on demand.

Each eligible symbol/day captures an immutable first-seen decision, rank score, as-of bar, actual capture timestamp, source venues, model version and costs, with separate 5/20/60-session observations in the private `investment-journal-GUILD.json`. Repeated calls cannot rewrite the first decision. Outcomes are resolved only from aligned sessions whose entry opens at or after the actual capture time. They are **hypothetical future-open exposures for every captured research decision**, including WAIT, not executed trades or claimed investment returns.

The view distinguishes this frozen forward evidence from backfilled rule diagnostics. Pending observations have no result. Fees are frozen at capture. Missing bars, changed provider/pair, or unavailable future prices leave the record pending. Daily snapshots overlap; both resolved snapshot counts and separate-window counts are shown, and cross-asset correlation still prevents interpreting the latter as fully independent evidence. Scores and averages do not become trustworthy merely because an outcome has resolved.

Automatic resolution covers the capped current research universe plus at most two due symbols that left it, with daily retry rotation. Unrefreshed overdue snapshots flag an incomplete forward cohort. Symbols with unavailable or incompatible venue data remain pending; `/crypto invest query:SYMBOL` can also refresh them. They are not assigned made-up exits. Forward return averages use the same non-overlapping subset whose window count is displayed, not all overlapping snapshots. Unavailable/rejected daily rows with a valid as-of bar retain their decision and null score in the journal. Running this on a new deployment starts with zero prospective outcomes, and longer horizons need real elapsed time. Retain the private journal across deployments. Failure to load/save the journal makes the investment view unavailable while the intraday scheduler continues normally.
