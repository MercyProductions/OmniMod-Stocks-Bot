# Stocks accuracy review — September 18, 2026

The bot remains a research and paper-tracking system. It does not place brokerage orders, and these fixes do not establish that a strategy is profitable.

## Corrected behavior

- Missing or malformed OHLC values are discarded, instead of converting nulls into zero-dollar prices. Missing earnings dates no longer imply an upcoming event.
- Cached chart freshness ages on every read. A provider outage marks every fallback asset stale, preventing new signals and fabricated settlements at stale prices. Stale/future provider quotes cannot contribute live agreement or executable bid/ask prices; quotes used for execution must be no older than 60 seconds.
- Cash-equity early closes cap discovery, entry expiration and target follow-through. Saturday New Year's Day is not incorrectly observed on the preceding Friday. Recurring calendar rules follow [NYSE trading hours](https://www.nyse.com/trade/hours-calendars). Extraordinary closures still require an update.
- Paper accounting now includes a 50% sale at target 1 and the remaining 50% at the final exit, with modeled costs. Adverse gaps through initial, breakeven and trailing stops fill at the available lower price. A bar's high cannot raise its stop retroactively before its low is checked.
- A bar opening at the deadline cannot contribute its later high/low. A pullback candle's earlier high cannot manufacture a target after a later entry. Snapshot prices cannot advance the OHLC cursor past delayed candles.
- Calibration uses only outcomes completed by the signal time. Legacy model training now purges overlapping outcomes with an embargo at every train/test boundary. Null outcomes and still-open observations cannot become zero-return training examples or dilute model loss limits.
- Counterfactual labels require continuous, complete interval coverage and valid bid/ask ordering. Intraminute snapshots defer simulated entry to the next full candle's open and end at the last complete candle inside the horizon; effective duration is recorded. Label format is now version 2; retraining excludes earlier labels. Existing version 1 files are retained for audit and can be regenerated with `npm run research:label` when their source bars remain available.
- Historical backtests use only completed candles, enter from the next available opening price, reveal subsequent candles one at a time, and leave incomplete observations open. Output explicitly identifies this as a rule-only watchlist simulation, not validation of a deployed ensemble.
- Blank numeric environment settings use defaults. Storage integrity and concurrent-write checks are included in the full test suite.

## Validation and remaining limits

`npm test` passes 59 tests, including 17 new accuracy regressions and the storage-integrity regression. `npm run check` passes. Verification uses synthetic fixtures and local state isolation. No live bot, Discord notification, brokerage order, provider credential setup, or live return claim was involved.

Historical outcomes already saved under the old accounting rules are not retroactively rewritten and cannot train the corrected outcome model. Legacy champion artifacts are refused until retrained under the corrected outcome/label version and validation rules; the default configuration therefore abstains while collecting new evidence. Prior performance reports remain legacy evidence. The public-chart backtest is survivorship-biased and lacks historical bid/ask, order queues, market impact, and complete point-in-time event data. Provider entitlements and quote latency require deployment checks with the owner's accounts. Paper exits and a delayed-price alert are not executable fill guarantees.

## Additional investment and portfolio work

The follow-up review added a separate `/stocks invest` path for 5/20/60 completed-session research and SPY comparison, current cached event-risk notes, a frozen forward observation journal, and bounded automatic post-close collection. Portfolio selection now uses explicit model-only expected return, fresh executable quotes, an extra spread/cost stress reserve, honest unknown correlation, exit-day loss accounting, and aggregate active/pending position and paper-risk limits. Scan/status and individual research cards explain rejections.

Validation after these additions: 80 tests pass, including daily adjustment/causality, sparse history, SPY baseline, current/stale earnings context, quote costs, portfolio limits, concurrent journal merges, immutable issuance, independent-session resolution, and automatic retry limits. The read-only SPY+AAPL public-data smoke returned 1,255 sessions per symbol through 2026-09-18 and no errors at 2026-09-19T03:10:51Z. No Discord runtime or trading was started. The new journal has no predated outcomes: future evidence must accumulate as the bot runs. Valuation/fundamentals and comprehensive future event coverage remain outside the longer-horizon model.

## Premarket breakout discovery correction — 2026-09-24

Premarket scans previously annotated high breaks only after ordinary regular-session candidate/watch selection. A qualifying move could therefore be hidden by score, RSI, VWAP or short-term follow-through gates before publication. Premarket research now evaluates the current extended-hours snapshot separately and posts up to five watches when the time is 04:00–09:29 ET, observation age is at most 20 minutes, data quality is at least 60, price is at least $2, average daily volume is at least 500,000, price exceeds the prior 20-session high, and the move from prior close is at least 1%. This path is observation-only and does not enter model/risk approval or paper setup creation.

Synthetic tests cover the end-to-end bar-feature high break even when regular-session qualification rejects the symbol, plus stale, quality, liquidity, movement, time-window and breakout rejection. Full Stocks validation passes **117/117 tests** and `npm run check`; live Yahoo behavior and Discord delivery remain unverified. Do not interpret the new watch as an executable entry or evidence of profitability.

## Premarket breakout discovery correction — 2026-09-24

Premarket scans previously annotated high breaks only after ordinary regular-session candidate/watch selection. A qualifying move could therefore be hidden by score, RSI, VWAP or short-term follow-through gates before publication. Premarket research now evaluates the current extended-hours snapshot separately and posts up to five watches when the time is 04:00–09:29 ET, observation age is at most 20 minutes, data quality is at least 60, price is at least $2, average daily volume is at least 500,000, price exceeds the prior 20-session high, and the move from prior close is at least 1%. This path is observation-only and does not enter model/risk approval or paper setup creation.

Synthetic tests cover the end-to-end bar-feature high break even when regular-session qualification rejects the symbol, plus stale, quality, liquidity, movement, time-window and breakout rejection. Live Yahoo behavior and Discord delivery remain unverified. Do not interpret the new watch as an executable entry or as evidence of profitability.
