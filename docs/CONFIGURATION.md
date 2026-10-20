# Configuration reference

Generated from `stocks-bot/.env.example`. Copy the template, never another person's `.env`. Template defaults are starting settings, not account/risk recommendations. Read its comments and source before changing a safety control.

| Variable | Template default | Role |
| --- | --- | --- |
| `DISCORD_TOKEN` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `DISCORD_CLIENT_ID` | your own value; optional when its source is disabled | Your own server/application/account identifier. |
| `DISCORD_GUILD_ID` | your own value; optional when its source is disabled | Your own server/application/account identifier. |
| `PORT` | 3001 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `TIMEZONE` | America/Chicago | Runtime, data-source, cost, review or safety setting; see template comments. |
| `OMNIMOD_STOCKS_DATA_DIR` | (empty; review before enabling) | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_CONFIG_SECRET` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `STOCKS_MONITOR_MINUTES` | 5 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DISCOVERY_MINUTES` | 15 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DYNAMIC_DISCOVERY` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DYNAMIC_DISCOVERY_MAX_SYMBOLS` | 15 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DYNAMIC_DISCOVERY_CACHE_MINUTES` | 15 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DAILY_HOUR` | 8 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DAILY_MINUTE` | 30 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MIN_SCORE` | 68 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_SIGNALS` | 5 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MIN_PRICE` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MIN_AVERAGE_VOLUME` | 500000 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MIN_DATA_QUALITY` | 60 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_CONFIRMATION_SCANS` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_EARNINGS_BLACKOUT_DAYS` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DAILY_CACHE_HOURS` | 8 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_ASSUMED_SLIPPAGE_BPS` | 8 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_SPREAD_BPS` | 35 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_RESEARCH_RETENTION_DAYS` | 730 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MODEL_MIN_SAMPLES` | 80 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MODEL_MIN_HOLDOUT` | 20 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_ENSEMBLE_BUY_PROBABILITY` | 62 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_ENSEMBLE_WATCH_PROBABILITY` | 54 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MODEL_AUTO_TRAIN` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_ALLOW_RULE_ONLY_SIGNALS` | false | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_RESEARCH_MODEL_MIN_SAMPLES` | 240 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_EXPERT_MIN_SAMPLES` | 120 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MODEL_EMBARGO_MINUTES` | 240 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MODEL_LOOKBACK_DAYS` | 365 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_LABEL_LOOKBACK_DAYS` | 14 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_COUNTERFACTUAL_SLIPPAGE_BPS` | 10 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_BOOTSTRAP_SAMPLES` | 300 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_SECTOR_SIGNALS` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_OPEN_POSITIONS` | 3 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_OPEN_RISK_R` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_EXECUTION_STRESS_BPS` | 10 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_INVESTMENT_DAILY_RESEARCH` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MAX_PAIR_CORRELATION` | 85 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_DAILY_LOSS_LIMIT_R` | 3 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_CONSECUTIVE_LOSS_LIMIT` | 3 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_MIN_PORTFOLIO_EXPECTED_R` | 0.05 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `ALPHA_VANTAGE_API_KEY` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `FINNHUB_API_KEY` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `POLYGON_API_KEY` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `ALPACA_API_KEY_ID` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `ALPACA_API_SECRET_KEY` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `STOCKS_ALPACA_NEWS_ENABLED` | false | Runtime, data-source, cost, review or safety setting; see template comments. |
| `ALPACA_DATA_FEED` | iex | Runtime, data-source, cost, review or safety setting; see template comments. |
| `ALPACA_STREAM_ENABLED` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `ALPACA_STREAM_MAX_SYMBOLS` | 30 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SEC_USER_AGENT` | (empty; review before enabling) | Runtime, data-source, cost, review or safety setting; see template comments. |
| `FRED_API_KEY` | your own value; optional when its source is disabled | Private credential from your own account/application. |
| `STOCKS_EVENT_CACHE_MINUTES` | 60 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_SEC_FILING_BLACKOUT_HOURS` | 4 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_CORPORATE_ACTION_BLACKOUT_DAYS` | 2 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `POST_ON_START` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_AUTO_PROVISION` | false | Runtime, data-source, cost, review or safety setting; see template comments. |
| `OMNIMOD_PAPER_ACCOUNT_EQUITY_USD` | 0 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `STOCKS_ROUND_TRIP_FEES_PER_SHARE` | (empty; review before enabling) | Runtime, data-source, cost, review or safety setting; see template comments. |
| `TRADING_RISK_STATE_PATH` | (empty; review before enabling) | Runtime, data-source, cost, review or safety setting; see template comments. |
| `OMNIMOD_EMERGENCY_STOP` | true | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_QUOTE_AGE_MS` | 15000 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_OPEN_MARK_AGE_MS` | 300000 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_OPEN_POSITIONS` | 5 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_TRADE_RISK_PCT` | 0.25 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_TOTAL_OPEN_RISK_PCT` | 1 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_GROSS_EXPOSURE_PCT` | 150 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_DAILY_LOSS_PCT` | 1 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MAX_SPREAD_PCT` | 0.5 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `SHARED_MIN_REWARD_RISK` | 1.25 | Runtime, data-source, cost, review or safety setting; see template comments. |
| `PAPER_MONITOR_INTERVAL_SECONDS` | 0 | Runtime, data-source, cost, review or safety setting; see template comments. |
