> Deployment update: follow REVIEWED_DEPLOYMENT.md in the parent upload folder (also included in reviewed archives). It supersedes older hosting steps below; the Crypto host runs both Crypto and Stocks.

# OmniMod Stocks Discord Bot

## Directory and discovery integrity update — 2026-10-03

The scanner already had a broad discovery stage: an Alpaca asset directory, bulk snapshots, a ranked dynamic shortlist, then expensive analysis alongside configured priorities. This update repairs that stage rather than replacing it with a second scanner. The local read-only preflight found **49 configured priority symbols and no Alpaca credentials**. The account-visible directory and current market-wide scan size are therefore **unknown**, not zero and not 49. Run `npm run probe:discovery` here to measure this path without invoking strategies, sending messages or reserving orders. It uses local configuration and may write directory/coverage archives; never paste credentials into chat.

The scanner now requests the documented all-status US-equity directory and classifies every returned record before screening. It recognizes Alpaca's AMEX, ARCA, BATS, NYSE, NASDAQ and NYSEARCA listing codes. Identity, duplicate ID/active symbol, inactive status, unsupported class/exchange, account tradability, context ownership and ETF/ETP ownership exclusions each have a structured reason. OTC remains excluded because the configured IEX/SIP path does not supply its separate feed. Common-share/ADR/preferred/warrant subtype coverage is not inferred from a ticker or product name; detailed classification remains incomplete. Existing Nasdaq ETF flags and reviewed supplemental ETP identities continue to assign wrapper ownership to the ETF/ETP bot.

Configured symbols already receiving deep analysis are counted separately from the dynamic snapshot pool. The full eligible dynamic pool is requested in batches of up to 400 symbols before applying the unchanged dynamic cap (default 15, maximum 30). Requests have 350ms minimum spacing, a 45-second discovery budget, existing account cooldown handling, five-request quota headroom and bounded waits. Authentication/quota/time-budget stops expose attempted, returned and deferred counts and suppress a partial deep shortlist. Failed scans are not cached as successful empty markets. Screeners must match the eligible account directory; they cannot bypass those checks. Separate account-wide/cross-process quota coordination remains unfinished.

The existing positive-move, price (at least $2), dollar-volume ($250,000), prior-close and freshness ranking filters remain. Premarket ranking still compares a fresh trade with the prior close and can use prior volume; it does not require a new regular-session daily bar. Discovery ranking is an allocation of analysis effort, not a profit probability. New listings with no prior close and lower-priced instruments can be visible in the directory but rejected by these explicit existing filters. The score, confirmation, model, event, execution-cost and portfolio approval rules were not loosened.

Directory metadata refreshes after six hours; in-memory membership changes distinguish inactive transitions and renames from identities no longer reported. Absence is not automatically labelled a delisting. The existing daily point-in-time universe history is retained. Snapshot cache keys include session date, feed, exclusions and priorities; caches from the older discovery version are invalidated. Cached observations retain their original timestamp and expose age. Freshness is checked against time after requests, avoiding the old false future-quote rejection during slow scans.

Full directory dispositions, snapshots, selected rows and every cheap-screen/cap rejection are stored in content-addressed gzip archives under the configured data directory's `research/discovery` folder (14-day operational retention). Administrator and scan diagnostics include directory size, active records, attempts, deferrals, failures, timings and the archive reference. Only display samples are capped at 100; the archive is complete. Preserve a frozen copy before longer validation. Dynamic observations/predictions carry `stocks-directory-integrity-v2`; configured/legacy observations remain separately labelled for future comparison.

Local synthetic tests exercise 1,202 directory records → 1,201 eligible/screened → two deep selections, including the last directory member. This is test coverage, not an observed provider market. Broader eligible venues and stricter identity checks can change the candidate population; they require forward comparison against the preserved baseline. Real coverage/entitlement, deployment and after-cost forward/OOS performance remain unverified. See `../new-bots/IMPLEMENTATION_CHECKLIST.md` and `../review-verification/stocks-discovery-integrity-checkpoint-20261003.json`.

API contracts checked: [Alpaca asset directory](https://docs.alpaca.markets/us/reference/get-v2-assets-1), [bulk snapshots and explicit feed selection](https://docs.alpaca.markets/us/reference/stocksnapshots-1). The directory endpoint documents an array without pagination parameters; snapshot omission is explicitly recorded rather than assumed to represent a zero-opportunity market. IEX is single-venue research; a SIP entitlement failure does not silently switch feeds.

Stocks-only market research, conditional buy/sell signal generation, continued monitoring, and paper outcome tracking for Discord. Auralith v4 labels every point-in-time screen, trains horizon/regime experts with leakage-resistant validation, models live execution and event risk, and selects a correlation-aware portfolio. It abstains when it cannot demonstrate a conservative after-cost edge.

## Important boundary

- Research and paper tracking only. The bot never connects to a brokerage or places an order.
- No model can guarantee profit or eliminate losses. Empty signal slates are expected and preferable to low-quality calls.
- Outputs are general, not personalized financial advice. Market data can be delayed, incomplete, revised, or subject to provider-plan limits.
- Paper results include modeled slippage but are not audited executions and do not establish future performance.

## Auralith v4 signal system

The score combines independent evidence instead of presenting one indicator as a prediction:

- multi-timeframe trend: 20%
- RSI/MACD momentum quality: 15%
- time-adjusted relative volume: 12%
- daily and opening-range breakout structure: 12%
- VWAP/EMA price quality: 10%
- strength versus SPY and the stock's sector: 12%
- sector context: 7%
- broad-market trend and breadth: 8%
- cross-provider quote and execution quality: 4%

Penalties cover late chasing, stale data, extreme volatility, poor data quality, near-term earnings, fresh SEC filings, nearby corporate actions, and macro stress. Hard gates also reject stale data, provider disagreement, weak liquidity, an unconfirmed EMA/VWAP trend, an unsuitable RSI range, absent follow-through, late-session entries, long momentum entries during sideways or risk-off regimes, wide spreads, stale quotes, trading halts, and entries close to a LULD band.

The numeric rule score is not a probability. A historical target-hit estimate is shown only with at least 20 completed outcomes across five distinct outcome days in the same ten-point score band, short-term horizon, and market regime. Sparse or unknown-date outcomes are withheld, and regimes are not pooled. Its normal-approximation interval is descriptive and is not independent validation or a calibrated forecast.

### Full-coverage counterfactual labels

Every screened stock, not only alerts, is stored at the instant the decision is made. Once sufficient future one-minute bars exist, the snapshot receives independent 30-, 90-, and 240-minute counterfactual labels. Labels use the observed offer for entry, spread plus configured slippage for executable costs, market-close-truncated horizons, and conservative stop-first ordering when a bar touches both stop and target. A missing bid/ask remains auditable but is excluded from training.

The `/stocks model action:status` shadow-attribution view also segments matured outcomes by the SEC/corporate-action feed coverage state and macro coverage (`complete`, `partial`, or unavailable status), separately from observed event risk. These are as-of diagnostic labels only: they are not model inputs, confidence multipliers, gates, or proof that missing coverage caused an outcome. Each segment requires at least 20 outcomes across five outcome days before an exploratory interval is shown; sparse cohorts remain explicitly insufficient.

Admins can use `/stocks catalyst` to add/list/clear manually classified catalyst notes with event type, direction, scheduled/unexpected status, relevance horizon, impact, time window, and an optional HTTPS source. These operator-entered tags are shown on relevant short-term analysis, retained on the point-in-time research snapshot, and segmented in model-status diagnostics. They are not independently verified and do not change scores or approval gates. Confirm linked sources and dates before relying on the context; sparse outcome segments remain exploratory.

This avoids the selection bias caused by training only on trades the old strategy chose. It does not make historical fills exact: quote depth, latency, partial fills, and within-bar ordering are still approximations.

### Validated horizon and regime experts

The learned v4 layer is intentionally dormant until enough counterfactual labels and independent trading days exist. It trains separate global experts for 30, 90, and 240 minutes, then optional risk-on, mixed, sideways, and risk-off specialists. A regularized logistic model competes with a nonlinear boosted-stump challenger.

All selection and promotion rules are fixed in code:

- trading-day splits keep overlapping screens from straddling train and test;
- labels whose outcomes overlap a validation boundary are purged, followed by a configurable embargo;
- probability calibration uses a later, separate slice and cannot fall back to its training rows;
- algorithm selection uses expanding walk-forward folds;
- the latest 25% of days stays untouched until the final promotion decision;
- probability error, calibration, selected coverage, profitable rate, after-cost expectancy, and a day-block bootstrap interval must all pass;
- a failed challenger never replaces the current champion.

A promoted expert returns one of:

- `BUY`: probability and conservative after-cost expectancy both clear the gate.
- `WATCH`: estimated edge is positive but not strong enough to open a setup.
- `NO_EDGE`: edge, model coverage, confidence, distribution, or health is inadequate.
- `RULE_ONLY`: no accepted v4 or legacy champion is installed; by default this collects research but cannot create a BUY alert.

Out-of-distribution inputs force `NO_EDGE`. A champion is also suspended if recent model-tagged paper outcomes fall below -0.05R expectancy or exceed 4R drawdown. These controls reduce avoidable false confidence; they cannot guarantee profitable future performance.

### Legacy trade-outcome ensemble

The earlier trade-only ensemble remains a fallback while no v4 champion exists. It stays dormant until the server has at least `STOCKS_MODEL_MIN_SAMPLES` after-cost, graded paper outcomes and uses the exact point-in-time features saved with each signal. Because an unvalidated rule screen has not passed the v4 promotion gates, `STOCKS_ALLOW_RULE_ONLY_SIGNALS=false` is the safe default; an admin can explicitly override it, but doing so is not evidence-backed.

It also uses chronological walk-forward and holdout checks, but it is more selection-biased than the full-coverage v4 research model. Automatic retraining waits for new outcomes, and a failed challenger never replaces its champion.

## Signal lifecycle

1. During the regular U.S. session, the full watchlist is screened with one year of daily context, five days of intraday bars, live microstructure when available, and point-in-time event/macro context.
2. A candidate must pass the quality gates on consecutive scans (`STOCKS_CONFIRMATION_SCANS=2` by default).
3. A validated model must approve the candidate as `BUY` when one is active; `WATCH` and `NO_EDGE` cannot create alerts.
4. Approved names are ranked by conservative utility after spread, uncertainty, and data quality. Sector caps, correlations with active and newly selected setups, daily loss limits, and consecutive-loss limits can reject or pause them.
5. If price is extended above VWAP, the bot publishes a pullback entry and waits up to 45 minutes. If the zone never trades, the setup is recorded as **not filled**, not a loss.
6. Once filled, the alert gives an explicit conditional buy zone, do-not-chase price, structural/volatility stop, target 1, target 2, monitoring cadence, and a paper-risk multiplier reduced by uncertainty or macro stress.
7. At +0.50R favorable movement, the paper risk floor moves to approximately breakeven after modeled slippage.
8. At target 1, the alert says to take partial paper profit and trails the remainder. Target 2 or the trailing floor closes it.
9. A loss of VWAP and EMA21 combined with material score deterioration triggers a sell/reduce review before the hard stop.
10. Periodic grading uses the observed OHLC bar path. When one bar touches both stop and target and order is unknowable, the stop is recorded first to avoid overstating results.

From 4:00–9:30 a.m. Eastern, scheduled scans now use the full configured watchlist to find developing premarket moves. New observations are posted as **premarket breakout research watches** (including change versus prior close and whether price cleared the previous 20-session high); they are not approved entries. New paper setups remain disabled until the regular session, and existing model, quote, and portfolio risk gates are unchanged. Extended-hours liquidity and provider freshness can be weaker, so the post labels these as observations that must be rechecked after the open.

Only active setups are refreshed on the faster monitoring cadence. Opening slates, discoveries, pending entries, active observations, outcomes, and the after-hours review survive restarts.

The opening slate also lists fresh upward research watches that have not passed the formal signal gates. These early views now include an ATR-based entry reference, first target, and invalidation to make developing moves easier to assess. They remain explicitly unvalidated watch levels, not approved entries or probability forecasts.

## Data providers

Current intraday and daily OHLCV history requires configured Alpaca market-data credentials; the former Yahoo Chart fallback is disabled in `src/stocksData.js`. For top candidates and open positions, configured supplementary providers may add quote and event context:

- Alpaca latest trade/quote snapshots, corporate actions, active-asset universe, plus optional WebSocket trades, quotes, minute/corrected bars, trading statuses, and LULD bands
- Polygon/Massive last trade
- Finnhub quote plus near-term earnings calendar
- Alpha Vantage Global Quote
- SEC EDGAR submissions and company facts when a compliant `SEC_USER_AGENT` is configured
- point-in-time FRED/ALFRED VIX, Treasury-curve, and high-yield-spread observations when a FRED key is configured

The bot records provider count, maximum quote dispersion, agreement, bid/ask spread, and quote imbalance. Cached Alpaca bars can be refreshed with the current Alpaca stream snapshot, so open-position monitoring does not wait for another REST chart download. Entry prices use the offer when available, exit monitoring uses the bid, and modeled cost per side is never less than half the observed spread. Alpha Vantage's default quote can be end-of-day, so it remains a reference and is not counted as an independent live quote.

Optional keys entered with `/stocks api-key` are AES-256-GCM encrypted at rest and never echoed. Guild-stored Alpaca credentials enable REST snapshots, corporate actions, and daily active-universe capture. Because one process owns one shared WebSocket, streaming credentials must be set with `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` in the process environment. `ALPACA_DATA_FEED=iex` is the safe default; `sip` should be selected only when the account is entitled to it. SEC requests require a descriptive user agent containing an email address, for example `OmniMod Research admin@example.com`.

Provider entitlements and delays vary by plan. A second provider improves fault detection; it does not make an inaccurate feed or a trading thesis certain.

Primary references: [Alpaca real-time stock schemas](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data), [Alpaca streaming data](https://docs.alpaca.markets/us/docs/streaming-market-data), [Alpaca historical feed comparison](https://docs.alpaca.markets/us/v1.1/docs/historical-stock-data-1), [Alpaca corporate actions](https://docs.alpaca.markets/us/reference/corporateactions-1), [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [FRED real-time periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html), [Finnhub API documentation](https://finnhub.io/docs/api/quote), [Alpha Vantage API documentation](https://www.alphavantage.co/documentation/), [Polygon stocks overview](https://polygon.io/docs/rest/stocks/overview), and the [Nasdaq market calendar](https://www.nasdaqtrader.com/trader.aspx?id=Calendar).

## Durable research data

Every deep-scanned symbol appends a versioned feature snapshot under `data/research/features`, including structured gate-by-gate rejection details and codes, last passed stage, final technical/model/risk disposition, rolling order-flow/spread state, provider state, event context, and ensemble decision. This makes post-scan rejected opportunities joinable with their later shadow outcomes instead of preserving their reason only in an aggregate counter. Matured counterfactuals are stored under `data/research/labels`; signal lifecycle events under `data/research/events`; SEC/corporate-action/macro observations under `data/research/intelligence`; active-universe history under `data/research/universe`; and streamed/backfilled bars under `data/research/bars`. The default retention is 730 days. Writes are serialized JSON Lines and append-only.

At an opening or manual scan, the bot captures Alpaca's active and inactive US-equity asset list, labels any newly matured screens, and attempts v4 retraining only after enough new data exists. Automated labeling scans a bounded recent window so years of minute bars are not loaded every day; the CLI can use a longer `--lookbackDays=` window for a deliberate backfill. Model training defaults to the most recent 365 days to limit regime staleness. Universe history is stored per Discord server and Alpaca asset ID as an initial baseline plus daily deltas, including explicit active/inactive status transitions, so point-in-time provider membership can be reconstructed without silently applying today's universe to the past. An asset explicitly marked inactive remains in the history with that status. An asset absent from a later all-status response is marked no longer returned by that provider; this does not verify that it was delisted (it may be a provider/account coverage change or symbol change). Snapshot capture aborts rather than recording mass removals when the response is empty, is not an array, or contains missing/duplicate symbols.

Historical Alpaca bars can be backfilled with a resumable checkpoint:

```powershell
npm run research:backfill -- --symbols=AAPL,MSFT,NVDA --timeframe=1Min --start=2026-01-01 --end=2026-03-01 --feed=iex
npm run research:label -- --guild=YOUR_GUILD_ID --provider=alpaca-iex-1min
npm run model:train-research -- --guild=YOUR_GUILD_ID
```

Use one-minute, split/dividend-adjusted bars for the most faithful barrier labels. The provider passed to `research:label` must match the stored bar directory; live streamed IEX bars use `alpaca-iex`, while the example backfill uses `alpaca-iex-1min`. Backfilled prices cannot create training examples before feature snapshots existed. They only mature matching historical screens and never bypass promotion gates. Repeating an already completed identical backfill exits without duplicating that slice.

Research-bar writes use exclusive per-provider/date `.jsonl.lock` files so concurrent processes cannot overwrite one another. An identical historical backfill also takes an exclusive per-query `.json.lock`, preventing duplicate provider requests and checkpoint races. If a writer exits unexpectedly, inspect both bar and checkpoint locks with `npm run research:locks`. This command is read-only and reports the recorded host/PID, lock age, and whether a same-host process is still present. For recovery, stop all backfill writers first; only consider manually removing a specific lock after the report confirms its same-host PID is absent and it is older than the threshold. Remote, unverifiable, or malformed lock metadata requires operator investigation. Age alone is never sufficient, and neither the inspector nor the writer removes locks automatically.

## Discord commands

- `/stocks help`
- `/stocks setup`
- `/stocks configure`
- `/stocks api-key`
- `/stocks watchlist`
- `/stocks scan`
- `/stocks momentum`
- `/stocks ticker`
- `/stocks tracker`
- `/stocks history`
- `/stocks performance`
- `/stocks diagnostics`
- `/stocks model action:status`
- `/stocks model action:train`
- `/stocks status`
- `/stocks role`

Setup, configuration, provider-key, model-training, forced-scan, watchlist-change, and role-panel commands require Manage Server or Administrator. Model status is readable without admin permission. `/stocks performance` reports target-hit rate, net-profitable rate after modeled slippage, expectancy in R, profit factor, maximum drawdown, and a probability-reliability diagnostic. That diagnostic compares only stored issuance-time target-hit estimates that were displayed with completed v2 paper outcomes; it reports forecast-versus-observed gap, Brier score, and a same-sample base-rate comparison, with horizon/regime segments. It requires at least 20 eligible outcomes across five UTC completion days before interpretation and remains descriptive—not independent calibration or evidence of profitability. It does not change model approval or signals.

`/stocks diagnostics` is admin-only. It reports the latest scan funnel, historic rejection reasons, provider request/failure/429 counts, latency, scan timing, and provider quota use when a response includes rate-limit headers. Requested and available-chart counts now separate market-context ETFs from non-context symbols; stock-owned seeds are counted only after ETF/ETP ownership checks. Unavailable requested symbols and unexpected returns are recorded separately, including on cache hits. Counts are distinct symbols per scan; the operator report aggregates the latest per configured guild and does not claim a globally unique cross-guild universe. Older diagnostics lack these new breakdowns and display them as unavailable. A provider that does not return quota headers is shown as unknown. Diagnostics never store request URLs or credentials. The historical log starts when this version first scans; it cannot reconstruct earlier funnel counts.

By default the screen uses each server's configured watchlist (49 hard-coded defaults; administrators may keep up to 75 symbols) plus 15 fixed market-context symbols. The default union is 52 requested charts, of which 37 are stock candidates and 15 are context-only. When Alpaca credentials are configured, `STOCKS_DYNAMIC_DISCOVERY` defaults to `true`: during regular and premarket sessions it loads active, tradable NASDAQ/NYSE/AMEX equities and batches their market snapshots. Premarket uses only fresh positive-move/liquidity snapshot candidates; it skips the session-ranked movers/most-active screeners. Regular-session discovery also merges those two ranked screeners. At most 15 new names (configurable up to 30) receive the existing Yahoo chart analysis; they still face all current technical, confirmation, model, quote, portfolio, and loss-control gates. This adds about one snapshot request per 400 eligible names at each 15-minute discovery refresh, plus two ranked-screener calls; response rate-limit headers are collected when supplied. Set `STOCKS_DYNAMIC_DISCOVERY=false` to disable it. Missing credentials or denied/unavailable endpoints fall back to the configured watchlist and appear in scan diagnostics. Broad discovery excludes official Nasdaq Trader ETF-flagged listings and source-reviewed supplemental ETNs/ETPs shared with the ETF/ETP bot. Stale or invalid supplemental wrapper rows are held out pending review. Both bots default to the same checked-in classification file; if overridden, configure the same absolute ETF_ETP_CLASSIFICATION_PATH and ETF_ETP_CLASSIFICATION_MAX_AGE_DAYS in both processes. A missing or invalid registry withholds broad Stocks discovery; configured watchlists remain operator-controlled. ADRs and other listed share classes may still be included because Alpaca does not provide a complete security-type classifier; OTC, ARCA and BATS listings are excluded. Feed coverage follows `ALPACA_DATA_FEED` (default IEX, which is one exchange); consolidated SIP coverage requires appropriate account entitlement. Validate this expanded universe prospectively in paper operation before relying on it. See [OPPORTUNITY-DISCOVERY-AUDIT.md](OPPORTUNITY_DISCOVERY_AUDIT.md) for limitations and staged-discovery design.

## Configuration

Copy `.env.example` to `.env`, then set at least `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Useful model controls are:

```dotenv
STOCKS_MONITOR_MINUTES=5
STOCKS_DISCOVERY_MINUTES=15
STOCKS_MIN_SCORE=68
STOCKS_MIN_DATA_QUALITY=60
STOCKS_CONFIRMATION_SCANS=2
STOCKS_EARNINGS_BLACKOUT_DAYS=2
STOCKS_DAILY_CACHE_HOURS=8
STOCKS_ASSUMED_SLIPPAGE_BPS=8
STOCKS_MAX_SPREAD_BPS=35
STOCKS_RESEARCH_RETENTION_DAYS=730
STOCKS_MODEL_MIN_SAMPLES=80
STOCKS_MODEL_MIN_HOLDOUT=20
STOCKS_ENSEMBLE_BUY_PROBABILITY=62
STOCKS_ENSEMBLE_WATCH_PROBABILITY=54
STOCKS_MODEL_AUTO_TRAIN=true
STOCKS_ALLOW_RULE_ONLY_SIGNALS=false
STOCKS_RESEARCH_MODEL_MIN_SAMPLES=240
STOCKS_EXPERT_MIN_SAMPLES=120
STOCKS_MODEL_EMBARGO_MINUTES=240
STOCKS_MODEL_LOOKBACK_DAYS=365
STOCKS_LABEL_LOOKBACK_DAYS=14
STOCKS_COUNTERFACTUAL_SLIPPAGE_BPS=10
STOCKS_BOOTSTRAP_SAMPLES=300
STOCKS_MAX_SECTOR_SIGNALS=2
STOCKS_MAX_PAIR_CORRELATION=85
STOCKS_DAILY_LOSS_LIMIT_R=3
STOCKS_CONSECUTIVE_LOSS_LIMIT=3
STOCKS_MIN_PORTFOLIO_EXPECTED_R=0.05
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
ALPACA_DATA_FEED=iex
ALPACA_STREAM_ENABLED=true
ALPACA_STREAM_MAX_SYMBOLS=30
SEC_USER_AGENT=OmniMod Research admin@example.com
FRED_API_KEY=
STOCKS_SEC_FILING_BLACKOUT_HOURS=4
STOCKS_CORPORATE_ACTION_BLACKOUT_DAYS=2
```

Do not reduce confirmations or quality thresholds merely to increase alert count. Threshold changes should be checked out of sample.

## Local development and verification

```powershell
npm install
Copy-Item .env.example .env
npm run check
npm test
npm run backtest
npm run model:train -- --guild=YOUR_GUILD_ID
npm run research:label -- --guild=YOUR_GUILD_ID --provider=alpaca-iex
npm run model:train-research -- --guild=YOUR_GUILD_ID
npm audit --omit=dev
npm start
```

The rule-model backtest downloads 60 days of 15-minute bars and one year of daily context, walks forward without fitting parameters, and reports the earlier 70% separately from the latest 30% holdout. Each segment also lists counts and after-cost return metrics by terminal outcome (`loss`, `fell_short`, `target_hit`, `exceeded`, and `not_filled`); outcomes with no graded trades report unavailable metrics, not zero. It assumes slippage and stop-first ordering on ambiguous bars. It remains survivorship-biased because it tests today's watchlist, so use it as a regression gate, not a profitability certificate. The v4 learned layer is promoted only by its separate full-coverage, purged/embargoed walk-forward and untouched-holdout checks. Repeatedly tuning against the same holdout invalidates that holdout.

Options can be passed as `--key=value`:

```powershell
npm run backtest -- --symbols=AAPL,MSFT,NVDA,AMZN --range=60d --minScore=68 --confirmations=2 --slippageBps=8 --verbose=true
```

`--slippageBps` is modeled per side, defaults to 8, and accepts explicit `0` for a zero-slippage sensitivity comparison; invalid values outside 0–100 bps are rejected instead of silently changing the assumption.

For reproducible, offline runs, `npm run backtest -- --data=path/to/dataset.json` accepts a root `schemaVersion: 1`, a `manifest`, and a `symbols` map. The manifest requires `schemaVersion: 1`, `provider`, `datasetId`, `retrievedAt`, `timezone`, `timestampSemantics` (`bar_open`, `bar_close`, `unknown`), `universeCoverage` (`historical_point_in_time`, `current_snapshot`, `unknown`), `corporateActions` (`split_adjusted`, `unadjusted`, `unknown`), `licenseStatus` (`authorized`, `restricted`, `unknown`), `licenseReference`, and `contentSha256`. Compute `contentSha256` as SHA-256 over canonical JSON of the dataset with the entire `manifest` property omitted; object keys are sorted recursively and array order is preserved. Each bar uses Unix-second `timestamp`, `open`, `high`, `low`, `close`, and optional `volume`; rows must be chronological with valid OHLC. Include benchmark and eligible-symbol history. The CLI labels the later chronological segment and whether declared metadata supports OOS review; declarations and the hash are not independent verification, so this is not itself evidence of valid OOS performance or vendor provenance. The local path makes no provider requests and retains survivorship and dataset-quality risk.

To add the required fingerprinted manifest without replacing the source file, use `node scripts/create-backtest-manifest.js --data=raw-dataset.json --out=pinned-dataset.json` plus all manifest fields shown below. Unknown fields are allowed and do not qualify the data for OOS review. The output path must not exist; inspect all declarations before labeling data complete.

```powershell
node scripts/create-backtest-manifest.js --data=raw-dataset.json --out=pinned-dataset.json --provider=YOUR_PROVIDER --datasetId=YOUR_DATASET_ID --retrievedAt=2026-09-30T12:00:00Z --timezone=America/New_York --timestampSemantics=unknown --universeCoverage=unknown --corporateActions=unknown --licenseStatus=unknown --licenseReference=YOUR_LICENSE_OR_SOURCE_REFERENCE
```

The offline Stocks replay also accepts `--costSchedule=path/to/costs.json` or an embedded `executionCostSchedule` array in the dataset. Each row needs a unique `id`, UTC `validFrom`/`validUntil`, `feeBpsPerSide`, `slippageBpsPerSide`, and credential-free HTTPS `source`; overlaps are rejected and schedule gaps block that scan. Fee estimates are charged on both entry and exit; slippage retains the replay's existing quote/spread-aware calculation with the scheduled per-side reserve as its floor. Reports count schedule coverage and identify applied rows. URLs are shape-checked, not authenticated; all cost rows are user-supplied assumptions, not broker-verified actual charges. This applies only to the offline replay, not live signal selection.

## cPanel deployment

1. Create a Node.js 20 application with root `stocks-bot`, URL `omnimod.cc/stocks-bot`, and startup file `app.js`.
2. Upload the project except `.env`, `node_modules`, `data`, and `.htaccess`.
3. Never overwrite the cPanel-generated `.htaccess`.
4. Add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID` in cPanel environment variables.
5. Set `OMNIMOD_STOCKS_DATA_DIR=/home/omniaeyu/.omnimod-stocks-data` so configuration, calibration history, research data, model artifacts, snapshots, and trackers survive restarts.
6. Set a stable, unique 32+ character `STOCKS_CONFIG_SECRET`; changing it makes encrypted provider keys unreadable.
7. Run NPM Install, restart the application, then run `/stocks setup` and `/stocks help` in Discord.

The application URL and `/health` endpoint report process and Discord-worker state. The bot requires a Discord application/token separate from other OmniMod bots.

## Short trades and longer investments

Use `/stocks momentum` and `/stocks ticker symbol:AAPL` for intraday research. New paper setups now require a quote within 60 seconds, an explicit model expectancy that survives an additional current-spread plus 10 bps stress reserve, and portfolio limits. Missing correlation is unknown and blocks additional exposure; pending entries count toward limits. Daily realized losses use the exit date in New York and the recorded paper risk size. A heuristic score is never converted to an invented expected return. Existing optional rule-only research remains explicitly unvalidated and disabled by default.

Use `/stocks invest symbol:AAPL sessions:20` for separate swing-horizon daily price-trend research. Omit `symbol` to rank up to 20 watchlist stocks. Choose `sessions:5`, `20`, or `60` for roughly a week, a month, or a quarter. `/stocks invest symbol:SPY sessions:60` shows the broad-market comparison itself. It is not an actionable swing entry/exit system, nor the intraday model stretched into a longer forecast.

The SPY context labels trend (`risk_on`, `mixed`, or `risk_off`), annualized 20-observation realized volatility relative to up to 252 recent rolling windows, and drawdown from its 252-observation peak. Frozen daily and monthly long-window outcome journals retain the volatility bucket and can summarize non-overlapping outcomes by horizon. These are descriptive price-only cohorts, not macro regime detection, causal explanations, or strategy inputs. Historical observations without the newer volatility label stay in an explicit unknown cohort.

Use `/stocks thesis action:add` to save your own long-term thesis, type, horizon, planned review date, key assumptions, base/bull/bear cases, invalidation evidence, catalysts, and at least one (up to five) HTTPS source URL. The bot checks HTTPS syntax only; it does not verify source quality. `list` shows the latest revision per ticker and `show` displays it. `due` is a date reminder; `review` captures facts from the latest annual SEC filing and the latest filed 10-Q against the latest saved thesis revision. Each reported fact keeps its source filing, exact fiscal period and missing-data state. `coverage` shows each evidence domain's latest numeric fact period and its age relative to the capture when period dates exist. This is descriptive recency, not a universal stale-data verdict; annual/quarterly reports and market prices update on different schedules. The annual history view includes up to five available reported years for revenue, net income, diluted EPS, calculated free cash flow, cash dividends paid per common share, total cash dividends paid, cash paid to repurchase common stock, and weighted-average diluted shares. Capital-return facts appear only when the selected filing reports the standardized SEC tag; missing tags do not mean zero activity. These raw reported amounts are not dividend-yield, payout-safety, or buyback-effectiveness analyses. The view also derives revenue and free cash flow per diluted share only when the annual numerator and share count have identical reported period dates. These are historical ratios, not forecasts. Share-count movement can reflect issuance, repurchases, acquisitions and corporate actions; it is context, not an automatic dilution verdict. Quarterly cash-flow values are included only when SEC facts report a discrete quarter from that exact 10-Q accession; cumulative YTD values are not misrepresented as quarterly results. Reviews are private, append-only and are not a thesis verdict or recommendation. Replies are ephemeral; records are stored locally per Discord user in the bot's private data directory. Keep that directory to retain notes across deployments. Do not include secrets or sensitive account details.

The daily research rank is derived from completed, consistently adjusted OHLC, SPY-relative returns, trend persistence, liquidity, volatility and drawdown; cached upcoming earnings, corporate actions, high-impact SEC filings and extreme macro stress can veto a clean research classification. It shows fixed-rule, non-overlapping historical next-open outcomes after 20 bps round-trip costs, with missing aligned sessions withheld. Ranks are heuristics, not probabilities or price targets. Reports also show up to about five years of adjusted-price returns versus SPY as a separate historical context line; those longer returns do not change the 5/20/60-session rank, candidate selection, or approval gates, and insufficient or incomplete history is shown as unavailable. The optional SEC supplement described below adds limited filing facts and descriptive ratios to a manual report, but those facts do not determine the daily rank. Neither path provides comprehensive fundamental underwriting, forward earnings, or intrinsic value. Tactical paper cards now distinguish an event feed that was checked and found no nearby item from missing credentials, unmapped symbols, partial macro coverage, and provider errors; the macro score reports its component coverage. Event-feed status is context only and does not change signal scoring or approval.

The `/stocks invest` command can rank up to 20 requested stocks, but its displayed result count is capped at five and SEC enrichment is fetched only for those displayed top-ranked rows. SEC facts are not retrieved for the rest of the ranked pool and do not affect the ranking. A missing SEC section on an unshown symbol therefore means it was not enriched in that command run, not that its reported fundamentals were checked and absent.

The optional SEC supplement also derives an indicative market-cap estimate and backward-looking P/S, P/E, price/FCF and FCF-yield ratios only for eligible U.S. 10-K filings with period-aligned annual facts, a reported share count no more than 550 days old, and no known post-filing split. It uses the most recent raw close and filing-date shares. Foreign filing forms, stale shares, splits, missing denominators, and nonpositive earnings/FCF withhold affected multiples. The report also shows annualized revenue, gross-profit, net-income and FCF changes only when the latest three positive annual facts are available with consecutive period ends; it uses actual elapsed days and labels the observed periods. Missing, negative, or gapped facts remain unavailable. This is arithmetic context, not intrinsic value or a cheap/fair/expensive classification.

The SEC supplement also reconstructs up to six historical annual-multiple observations from distinct 10-K accessions in SEC submission history. It pairs each filing's exact-accession revenue, net income, free cash flow and period-end common shares with the first available completed raw close strictly after that filing date. A split between the reported share-count date and price date, missing or period-misaligned facts, nonpositive denominators, an SEC share date older than the available price/action history, and unavailable post-filing bars withhold affected values. It shows a min/max *observed sample* only when at least three snapshots qualify; this is not an intrinsic-value band, forecast, or estimate of what a reasonable multiple should be. The feature is descriptive only and does not alter the rank, decision, model, or approval gates.

`/stocks invest` also preserves the original decision in a private forward journal at the actual time the provider response arrives. Future prices cannot alter that issued decision. Outcomes resolve only after the next actual open and the full 5/20/60-session horizon, checked against an independent exchange calendar. They remain hypothetical adjusted-price returns rather than executed trades. Repeated daily observations overlap and are not independent statistical samples.

`/stocks thesis action:performance` keeps a separate reference series for each saved thesis revision. Its horizon checkpoint uses the revision's stated calendar-month horizon and reports the first saved comparable adjusted-close mark on or after the target date, alongside the exact target and observation dates and SPY comparison. It remains pending until such a mark is captured; a late/manual capture is clearly dated rather than presented as an exact-duration return. This tests price-path context after your thesis was recorded, not whether the thesis was correct or whether an actual position made money. Captures are manual and only begin when you request the command.

When the bot is running, completed-session collection runs automatically without a new channel or notification. It records all three short horizons for up to 20 current stocks and rotates through up to 20 pending symbols. Once per symbol per calendar month, it also freezes the 60-session daily-trend decision into separate 126/252/756-session (about 6/12/36-month) shadow price-paths. These reuse the same five-year Yahoo daily history, SPY benchmark, independent exchange calendar and 20 bps round-trip assumption; they add no provider request and never create a normal alert. Only complete, current scored screens are captured. The long-window rows test what happened after a technical daily-trend screen, not a long-term fundamental thesis or holder recommendation. Summary performance removes overlapping windows per symbol; results are hypothetical and do not model portfolio sizing, taxes, or actual fills. Missing aligned history stays pending rather than shortening the horizon. Collection runs once per session, with failed-provider retries no more than hourly and no more than three attempts per session. Set `STOCKS_INVESTMENT_DAILY_RESEARCH=false` to keep collection command-only. Journals are stored as `investment-journal-<guild>.json` inside the private data directory; keep that directory when deploying updates.

Additional environment controls (no real balance or allocation is inferred):

- `STOCKS_MAX_OPEN_POSITIONS=3` counts tracking and unfilled pending entries.
- `STOCKS_MAX_OPEN_RISK_R=2` caps aggregate planned paper risk units, not account dollars or portfolio percentage.
- `STOCKS_EXECUTION_STRESS_BPS=10` adds a robustness reserve on top of the current spread and the model's already-costed expectancy.

`/stocks scan`, `/stocks status` and opening slates explain quote, correlation, cost and exposure rejections. `/stocks ticker` labels snapshots that fail the portfolio/session/quality checks as research-only.

Read-only probe: `npm run investment:smoke -- SPY,AAPL` fetches daily data without Discord, credentials, orders or journal writes. The latest check (September 24, 2026, 23:26 UTC) returned 1,254 completed sessions through September 24 for both symbols, with no provider errors. AAPL was classified as a `RESEARCH_CANDIDATE` by the daily price-trend rule; this is not a buy instruction or performance evidence. Yahoo's public chart data is unofficial; reliable intraday decisions still need suitable current quote entitlements, and every strategy needs prospective outcome evidence. See [ACCURACY-REVIEW.md](ACCURACY-REVIEW.md).

Execution and concentration references: [SEC order execution overview](https://www.investor.gov/introduction-investing/investing-basics/how-stock-markets-work/executing-order), [FINRA concentration risk](https://www.finra.org/investors/insights/concentration-risk).

The SEC long-term evidence supplement also reports a simplified operating-income-to-interest-expense ratio when those standardized facts have matching periods, and a filing-dated principal maturity ladder when SEC standard facts are available (next 12 months, years 2–5, and after year 5). These values are retained in the private thesis evidence journal. Coverage varies by issuer and can omit custom/dimensional disclosures; blank buckets are unavailable, not zero. The simplified ratio is not sector-adjusted and may not be comparable for financial companies. Neither feature is a stand-alone solvency/credit assessment, and neither changes daily ranks, trade approvals, or risk controls.
