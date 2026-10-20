# Market-data setup: free research and optional entitled feeds

Shared Alpaca request budgeting (2026-10-03): Stocks, ETFs and Options now coordinate inspected Alpaca REST paths through a common local filesystem budget. The default is 180 request starts/minute; provider quota/cooldown responses can constrain it further. Optional process-environment settings support a verified paid account limit, a shared directory and a multi-key account alias. Use the same configuration for all workers and the operator report. See `shared/ALPACA_SHARED_BUDGET.md` and `shared/alpaca-budget.env.example`; putting these settings in Stocks' application-parsed `.env` alone does not export them to the shared runtime. No actual configuration or paid subscription was changed. This does not coordinate other hosts, external applications, WebSocket connection limits or non-Alpaca providers.

Independent position monitoring (2026-10-03): Forex, Futures, Options and ETFs now have `npm run monitor:paper` for existing production/shadow positions without rerunning discovery or history. Optional `PAPER_MONITOR_INTERVAL_SECONDS=60` starts a separate supervised quotes-only child after an application restart; default `0` leaves current scheduling intact. Existing source/entitlement gates and the paper stop still apply. Four local checks found no active orders and made zero requests, so real feed operation remains unverified. See `shared/POSITION_MONITORING.md`. Actual `.env` files were not changed.

Futures live-feed correction (2026-10-03): existing Databento Live entry/position paths now handle nested headers and interval-specific symbol mappings, validate explicit quote fields and recheck freshness at completion. No new setting or paid entitlement was enabled. Missing credentials still mean unknown live coverage. See `futures/LIVE_PROTOCOL_INTEGRITY.md` for verified mock behavior and account-backed checks still needed.

Futures H1 correction (2026-10-03): the existing `FUTURES_TREND_DATA_SOURCE=databento-historical` path now requests explicit symbol/price/time formatting and checks nested JSON headers. `FUTURES_H1_CACHE=data/futures-h1-history.json` reuses completed-hour input queries while rechecking current metadata and freshness. New downloads still require a positive remaining historical budget; cached reads do not buy data. Actual environments are unchanged. The 08:08 UTC probe still found no Databento key. See `futures/H1_DATA_INTEGRITY.md`.

Updated 2026-10-03. A running Discord bot is not proof of an operating market scanner. A count of zero provider failures can mean zero provider requests.

Futures now also supports opt-in `FUTURES_ACTIVITY_DISCOVERY_ENABLED=true` for completed-minute activity research across its current-date directory. The paid profile includes it; downloads still require a positive remaining historical budget. From `futures`, `npm run probe:activity` checks availability/estimated cost without paid bars, cache writes, messages or trades. The 07:30 UTC probe found no key and made zero requests. See `futures/ACTIVITY_DISCOVERY.md` for settings and the distinction between research candidates, executable liquidity and approved setups. Actual environments remain unchanged.

Futures now supports a separate dataset-wide historical directory with `FUTURES_CONTRACT_DISCOVERY_SCOPE=dataset`. From `futures`, `npm run probe:directory` checks credentials/provider schema availability and cost without downloading paid definitions. `npm run discover:contracts` uses the all-symbol directory behind an explicitly positive historical cost cap; periodic refresh remains separately enabled by `FUTURES_CONTRACT_DISCOVERY_ENABLED`. The 06:56 UTC local probe found no Databento key: zero requests, actual coverage unknown. Full setup, limits, archives and remaining live-screening requirements are in `futures/DATASET_DIRECTORY.md`. No permanent free live Futures feed is integrated, and no paid subscription is activated automatically.

Options independent intraday research uses the existing discovery Alpaca key pair and selected IEX/SIP feed. No subscription is activated by the code. The `discovery-free` and `discovery-paid` profiles cover underlying discovery and optional technical research; Tradier separately supplies option chains. A new isolated forward-paper bridge can evaluate those watches using existing production Tradier data, required reviews, explicit costs and shared risk. It never sends approved entry alerts or broker orders. `OPTIONS_INDEPENDENT_PAPER_SOURCE=disabled` disables that experiment; `OPTIONS_INTRADAY_RESEARCH_SOURCE=disabled` disables underlying technical research. Free IEX remains single-venue, missing minutes are counted/rejected, sandbox quotes cannot fill, and a SIP failure never silently becomes an IEX execution quote. From `options`, run `npm run probe:universe -- --technical --contracts` for read-only diagnostics without messages, reservations or orders. The actual 2026-10-03 06:04 UTC probe found no local Alpaca/Tradier credentials and made zero requests; actual coverage remains unknown. No real environment or paid account was changed.

Stocks now has `npm run probe:discovery` in `stocks-bot` for read-only directory/snapshot measurements. Its existing broad scanner now reports every directory disposition, configured-vs-dynamic eligibility, per-stage coverage, failures/deferrals and complete rejection archives. The 2026-10-03 06:30 UTC invocation found 49 configured priority symbols but no local Alpaca credentials: zero requests, actual market universe unknown. Existing IEX/SIP configuration is retained, and no paid subscription or trading route is activated. See the Stocks README for the fixed discovery filters and current subtype/OTC limits.

## What the current screenshots mean

| Bot | Observed configuration | What zero means |
| --- | --- | --- |
| Forex | Source disabled; OANDA account ID and token empty | No current-market scan. The two displayed pairs were configuration, not two successfully observed markets. |
| Futures | Manual context, manual day-session data; no Databento key; no day contracts | The 36 context symbols do not establish 36 live contract scans. No active-contract strategy inputs were evaluated. |
| Options | Manual/fixture input; no Tradier token; manual signal source | No chain-strategy scan. Independent Alpaca underlying research is implemented locally, but its keys and real coverage are still unverified. |
| ETFs & ETPs | Fixture input; no Alpaca credentials | No live ETF scan. Zero selected fixture rows are not an empty market. |
| Stocks | Local Alpaca credentials absent; deployed worker is separate | Public/legacy operation does not establish full-market quote coverage. Listing discovery and limited deep selection must be measured separately. |
| Crypto | Public feeds available; deployed worker is separate | Production rank-based screening is narrower than the newer local venue research path. Neither represents every crypto venue. |

These local observations do not enumerate remote secrets or prove server feed entitlement. The server health endpoint reports process state, not full-universe data quality. Never treat a healthy heartbeat as evidence of profitability or complete coverage.

## Supported data choices

| Market | Free or account-included route | Optional upgrade | Important boundary |
| --- | --- | --- | --- |
| Stocks | Existing public research; Alpaca Basic IEX with a free account/key | Alpaca SIP | IEX is one venue, not the consolidated US tape. Existing quality/model gates remain. |
| Crypto | CoinGecko public + public exchange feeds; optional free Demo key | CoinGecko Pro | Rate limits, regions, identity mapping and per-venue coverage remain explicit. |
| Forex | OANDA v20 practice account and token, where available | Optional Finnhub economic-calendar entitlement | Practice prices support research; API access and catalyst/cost inputs are still required. |
| Futures | Offline replay/manual research is implemented | Licensed Databento Live + Historical | No integrated permanent free live active-contract feed has been verified. Trial credits are not a permanent free service. |
| Options | Alpaca IEX independent underlying research; Tradier sandbox delayed-data profile | Alpaca SIP research; broker-entitled Tradier production chain data | Independent discovery and isolated costed paper research implemented locally; production promotion and real forward evidence pending. Sandbox cannot approve entries. No broker-order route exists. |
| ETFs & ETPs | Alpaca Basic IEX for research | Alpaca SIP | The current executable paper-entry/mark model requires consolidated SIP. IEX cannot be relabeled as executable to generate more entries. |

Primary documentation checked for this phase: [Alpaca data plans](https://docs.alpaca.markets/us/v1.1/docs/about-market-data-api), [Alpaca options feed definitions](https://docs.alpaca.markets/us/v1.1/reference/optionlatestquotes), [OANDA v20 onboarding](https://developer.oanda.com/rest-live-v20/introduction/), [Tradier market data](https://docs.tradier.com/docs/market-data), [Tradier API usage](https://docs.tradier.com/docs/faq), [Databento getting started](https://databento.com/docs/quickstart).

Alpaca's free indicative options feed is **not an implemented adapter in this project**. Its quotes are modified and trades delayed, so adding it would provide research coverage, not automatically usable entry prices. Tradier's documented personal-use boundary also needs appropriate provider rights before distributing its data commercially.

Free-first therefore means useful, honestly labeled research where an authorized free feed exists. It does not promise that every market can have full, consolidated, executable live coverage for zero cost. A paid-feed failure must remain visible; fallback research must not silently inherit paid-feed quality.

## Configure without changing risk controls

Run from the local `new-bots` directory:

```powershell
npm run data:setup -- --audit
npm run data:setup -- --list
npm run data:setup -- --bot forex --profile free
npm run data:setup -- --bot etfs-etps --profile free
```

Audit/preview perform no provider requests, purchases, orders or Discord posts. Output includes credential **names and missing/present status only**, never values. The audit reads local files and inherited environment, not cPanel's configuration.

1. Create the chosen eligible provider account yourself and accept its terms.
2. Store credentials in the corresponding bot's local ignored `.env`; do not paste them into chat.
3. Preview the profile. Resolve the listed missing items.
4. Apply explicitly using the same command with `--apply`.
5. Supply market-specific costs, paper equity, catalyst reviews and instrument metadata. Applying a data profile does not certify these inputs.
6. Run the relevant read-only preflight. For Forex, `npm run probe:universe` from `new-bots/forex` measures account directory and quotes without orders or Discord messages.
7. Restart only the affected application to load its environment and inspect its next scanner-status/funnel report. Remote deployments require their own configuration and release process.

Available profile names:

- Stocks: `free`, `paid`.
- Crypto: `free`, `demo`, `paid`.
- Forex: `free`, `paid-calendar`.
- Futures: `paid`. `free` is an explanatory unsupported profile and cannot be applied.
- Options: `free`, `broker-data` for Tradier data; `discovery-free`, `discovery-paid` add independent Alpaca underlying research while preserving the chosen Tradier profile. These do not approve a production strategy or relax the paper stop. The optional independent paper experiment separately requires production option data, reviews, costs and risk readiness.
- ETFs/ETPs: `free`, `paid`.

The setup command changes only data-source selectors. It preserves Discord tokens, existing provider credentials, stop/risk controls and live-trading flags. Missing credentials or unsupported profiles prevent writes. It does not copy keys across bots, grant data entitlements, choose a spending budget, submit orders or enable trading.

## Required local fields

| Provider | Fields | Used by |
| --- | --- | --- |
| Alpaca | `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` | Stocks, ETF/ETP data; Options independent underlying research and optional news/dividend checks |
| OANDA practice | `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN` | Forex |
| CoinGecko Demo/Pro | `COINGECKO_API_KEY` and profile-selected tier | Crypto |
| Tradier | `TRADIER_TOKEN` for the selected sandbox/production environment | Options |
| Databento | `DATABENTO_API_KEY`, licensed `DATABENTO_DATASET`, explicit `FUTURES_MAX_SCAN_COST_USD` budget | Futures |
| Finnhub calendar | `FINNHUB_API_KEY` with economic-calendar entitlement | Optional scheduled-event screening |

For Futures, the paid profile will not apply without an explicit positive finite per-scan historical-data budget. Subscription/exchange charges are separate from that cap. Do not substitute continuous proxy prices for reviewed active contracts. Existing `discover:contracts` and day-session review tools retain contract/margin/session validation; a key alone does not complete setup.

For Options, production chain workload still requires Stocks/ETF or manual directional candidates and catalyst/dividend reviews. Independent coverage can run with a free Alpaca IEX account or entitled SIP feed even when upstream signals are empty. Preview a discovery profile and run `npm run probe:universe` from `new-bots/options`; add `-- --technical --contracts` for bounded underlying technical research and expiration/chain inventories. The ordinary scan can additionally run the isolated `independent-orb-debit-vertical-v1` experiment with `OPTIONS_INDEPENDENT_PAPER_SOURCE=auto` (default) or `tradier`, a production Tradier token, explicit fee/slippage settings, account equity and a ready shared risk book. Existing catalyst and call-assignment reviews still apply. The experiment freezes before any reservation and requires later executable quotes for fills. Its default three-underlying/45-second budget controls deep work, not directory size. No live or approved Discord entry is created. Actual forward validation remains pending; missing keys report unknown coverage and an empty upstream file is never treated as a whole-market scan.

For Forex and ETFs, manual catalyst clearance must be fresh and source-backed when no entitled automatic event feed is selected. Provider setup does not automatically mark event risk clear.

## Verification and remaining scope

The four new runners now persist a separate `marketDataReadiness` report and display an amber **Scanner status** card for unconfigured/manual modes, missing credentials, missing strategy inputs or provider failures. These reports distinguish an absent market scan from a valid scan with no approved opportunities. Emergency-stop status is separate from data readiness.

The ETF full-directory phase performs cheap batched snapshots before deep selection, with explicit partial coverage and per-symbol archives; `npm run probe:universe` in `etfs-etps` measures that path without orders/Discord. Actual account coverage is still unverified, and non-ETF-flagged products require authoritative supplemental classifications. The current work does **not** establish complete independent discovery for all six bots, paid-feed entitlement, out-of-sample success, or profits. Next work includes real provider preflights, authenticated Stocks coverage and screening evaluation, authenticated Options strategy/identity/mark validation, authenticated Futures directory/activity coverage and executable new-root strategy integration, complete ETP metadata, and measured forward paper performance.
