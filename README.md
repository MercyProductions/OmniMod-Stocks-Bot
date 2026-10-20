# OmniMod Stocks Bot

Discover U.S. stock day-trading research opportunities and track qualified paper setups. `npm start` launches **only Stocks**. Automated tests establish code behavior; current provider coverage and forward performance require separate evidence.

## How it works

1. Refresh eligible stock discovery; manually configured symbols are priorities rather than the entire discoverable market. Reviewed ETFs/ETPs belong to their primary bot.
2. Batch inexpensive market snapshots to rank movement, gaps and volume, then cap deeper history downloads and candidate analysis.
3. Analyze multi-timeframe trend, RSI/MACD, VWAP, breakout structure, relative strength, market/sector context and available catalysts.
4. Apply confirmation, data-quality, validated-model/strategy approval and portfolio gates. Shadow/research observations remain distinct from approved setups.
5. Refresh executable quotes at the decision boundary; later quotes drive paper fills, exits and costed outcomes. /invest and thesis tools are separate longer-horizon research.

Highlights are not the full universe and watches are not automatically approved entries. Model probability, heuristic strength and data quality have different meanings. Zero results can mean a closed session, disabled provider, missing evidence, pending model or risk rejection.

## Predictive intelligence research branch

The preserved Auralith baseline remains unchanged. This branch adds point-in-time observations, an isolated LightGBM research service and warehouse, and an optional Chronos challenger. No new stock model is validated or promoted. Read the [audit](docs/STOCKS_PREDICTIVE_AUDIT.md), [setup and limits](docs/STOCKS_PREDICTIVE_SETUP.md), and [phase checklist](docs/STOCKS_PREDICTIVE_PHASES.json) before use.

## Requirements and layout

Use Git, **Node.js 22.9+** (the export was checked with Node 24), npm and your own Discord app/server. The primary project is [`stocks-bot/`](stocks-bot/). The existing six-market source integration bundle is preserved because shared adapters/tests import sibling projects. Their presence does not start those bots. The root wrapper selects only this repository’s named application.

`repository.json` records the original export/source hashes. Later Git commits/tags are authoritative for subsequent changes. Dependencies remain locked in the existing project lockfiles.

## Install from a clean checkout

```sh
git clone https://github.com/MercyProductions/OmniMod-Stocks-Bot.git
cd OmniMod-Stocks-Bot
npm run bootstrap
npm run info
npm test
npm run check
```

Bootstrap installs locked dependencies with lifecycle scripts disabled. It does not create a provider subscription. Tests use isolated fixture/mocked inputs.

Copy the template on Windows PowerShell:

```powershell
Copy-Item stocks-bot/.env.example stocks-bot/.env
```

Or on Linux/macOS:

```sh
cp stocks-bot/.env.example stocks-bot/.env
```

Edit that **local** `.env`; never copy the maintainer’s tokens or publish your file. [Every shipped template setting is listed here](docs/CONFIGURATION.md), with sensitive values replaced by instructions to supply your own.

## Create your own Discord application

1. In the [Developer Portal](https://discord.com/developers/applications), create your own application and bot user. Choose its name/avatar.
2. Reset/copy its bot token into `DISCORD_TOKEN`; set the application ID as `DISCORD_CLIENT_ID`. They are different values. Each independently running bot needs its own application/token.
3. Enable Discord Developer Mode and copy your server ID to `DISCORD_GUILD_ID`. Configure your setup-command channel selections; never reuse the owner’s destination IDs.
4. Install it to your server with `bot` and `applications.commands` scopes. Allow View Channel, Send Messages, Embed Links and Read Message History in its channels. Setup that creates channels/roles needs the corresponding management permission.
5. Register commands and start this application:

```sh
npm run register
npm start
```

Use `/stocks setup` in your server to select destinations/roles. Registration/startup connects to your own Discord application and can publish messages. A connected gateway does not establish feed readiness.

The identity skeleton is deliberately empty:

```dotenv
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
```

Add the project’s own destination/provider fields from its template. Do not share tokens in issues, screenshots or pull requests.

## Free data and paid upgrades

| Source | Role | Settings in local .env | Limits / prerequisites |
| --- | --- | --- | --- |
| Alpaca IEX | Free-account screening where entitled | ALPACA_API_KEY_ID; ALPACA_API_SECRET_KEY; ALPACA_DATA_FEED=iex | Single-exchange observations are not consolidated executable coverage. |
| Alpaca SIP | Optional entitled upgrade | Same keys; ALPACA_DATA_FEED=sip | Confirm account access; delayed_sip remains delayed. |
| Finnhub / Polygon | Optional corroboration/events | FINNHUB_API_KEY / POLYGON_API_KEY | A key does not grant every endpoint or replace the main feed. |
| Yahoo Chart | Legacy adapter; not the supported fallback | No suggested activation | Current historical/intraday collection requires Alpaca. |

Review this mode skeleton; blank credentials intentionally do not authenticate:

```dotenv
ALPACA_DATA_FEED=iex
OMNIMOD_PAPER_ACCOUNT_EQUITY_USD=0
OMNIMOD_EMERGENCY_STOP=true
OMNIMOD_LIVE_TRADING_ENABLED=false
```

The [configuration reference](docs/CONFIGURATION.md) lists all shipped variables. A key enables only the implemented adapters, not every endpoint sold by the provider. Read the primary project’s [existing technical guide](stocks-bot/README.md) for deeper settings and market-specific workflows.

### Preview provider profiles

```sh
npm --prefix new-bots run data:setup -- --bot stocks --profile free
npm --prefix new-bots run data:setup -- --list
```

Without `--apply`, this previews settings/missing prerequisites without editing `.env` or calling a provider. A free profile can be unsupported (Futures) or observation-only (limited/delayed feeds). Upgrade names differ by bot: inspect `--list` rather than assuming every market has a `paid` profile. Use `--apply` only after adding your own credentials and reviewing selectors. Equity, cost reserves, contract reviews and catalysts still require configuration.

## Paper accounts and shared risk

No live order route is implemented. Keep `OMNIMOD_LIVE_TRADING_ENABLED=false`. The emergency stop defaults to true. For paper reservations, deliberately configure positive paper equity, instrument-specific fees/slippage, current catalyst evidence and reviewed risk limits before setting `OMNIMOD_EMERGENCY_STOP=false`.

Stocks/Crypto use `OMNIMOD_PAPER_ACCOUNT_EQUITY_USD`; the other four bots use `PAPER_ACCOUNT_EQUITY_USD`. The first reservation anchors that ledger’s equity. A missing validated model, quote, review, cost assumption or account basis can block entries while discovery still operates.

For multiple clones on one computer, set the **same absolute `TRADING_RISK_STATE_PATH` and `OMNIMOD_SIGNAL_RESEARCH_PATH`** in every participating bot’s private configuration. Separate clones have separate default portfolios. Match equity/cost assumptions and keep marks current. File locks do not coordinate different hosts. Shared research never overrides the primary owner’s strategy/risk approval.

Watch, reservation, fill and target-hit counts have different meanings. Paper entry requires a later eligible quote. Stops/targets/excursions/returns are quote-sampled simulations after recorded costs, not calibrated broker fills. See [shared risk](new-bots/shared/paperRisk.js) and [fill checks](new-bots/shared/FILL_PORTFOLIO_RISK.md).

## Configure an account step by step

Create your own Alpaca account and generate its API key ID/secret in the account dashboard. Put both values in the local template fields, then start with `ALPACA_DATA_FEED=iex` for screening. Run the discovery probe and inspect returned coverage/errors. For SIP, activate the appropriate data entitlement in that account before changing the feed to `sip`; do not treat a rejected SIP request as a reason to substitute stale quotes. Finnhub/Polygon credentials are optional corroboration, not replacements for that setup.

## Operation and diagnostics

/stocks setup, /stocks status, /stocks diagnostics, /stocks scan, /stocks tracker, /stocks performance and /stocks model.

Additional commands from this repository root:

```sh
npm --prefix stocks-bot run probe:discovery
npm --prefix stocks-bot run monitor:paper
```

Probes/scans can contact the configured provider; metered history or explicit odds refresh may consume your credits. Review request/cost caps first. Do not start duplicate workers against one Discord identity/data store.

| Symptom | Check |
| --- | --- |
| No slash commands | Own token/client-ID pair, correct guild installation, registration and permissions. |
| Connected but zero candidates | Selected source, discovery/screen counts, session, current inputs and rejected-gate reasons. |
| HTTP 401/403 | Key validity, account region/permissions and endpoint entitlement; do not report it as no opportunities. |
| HTTP 429 | Quota headers, cooldown/concurrency and duplicate workers sharing the same provider account. |
| Watches without setups | Data age, model readiness, confirmation, catalyst evidence, explicit costs, emergency stop and risk limits. |
| Unexpected result summary | Separate research/shadow observations, issued alerts, delivery and actual paper fills. Consult durable records. |
| Stale records after restart | Actual data path/OS user, timezone, last successful request and old state; preserve the store when investigating. |

Runtime stores can contain private server settings and credentials saved by admin commands. Keep them outside Git/public web roots, persist them across restarts and back them up privately before upgrades. Original hosting documents may describe older deployments; source publication does not configure cPanel or start a production service.

## Baseline and contributing

The pre-change version is preserved as [`baseline/pre-readme-sports-audit-2026-10-20`](https://github.com/MercyProductions/OmniMod-Stocks-Bot/tree/baseline/pre-readme-sports-audit-2026-10-20), commit `6c0baede4106c00a65aa6ec7306122473db549f2`. Inspect it without erasing later work:

```sh
git switch -c inspect-baseline baseline/pre-readme-sports-audit-2026-10-20
```

Fork, create a development branch and use your own local credentials. Add regression tests for confirmed defects. Freeze model/strategy versions, dates, horizons and costs before evaluating changes. Compare the same chronological out-of-sample game/trade populations, reporting proper scores/calibration, sample sizes, costs and unresolved outcomes. A few good days or more alerts do not establish improvement. Preserve source and private runtime evidence before model changes.

`npm test` runs this primary project’s tests. `npm run check` runs configured syntax checks. `npm run test:all` checks the full shared/new-market, Stocks and Crypto integration bundle. Submit the problem/change/checks/limits in your PR; share sanitized diagnostics rather than private state.

## Source map

- [Scanner](stocks-bot/src/stocksData.js)
- [Decision pipeline](stocks-bot/src/predictionEngine.js)
- [Research records](stocks-bot/src/researchStore.js)

## Provider documentation

- [Discord setup](https://docs.discord.com/developers/quick-start/getting-started)
- [Alpaca coverage](https://docs.alpaca.markets/us/docs/about-market-data-api)
- [CoinGecko Demo authentication](https://docs.coingecko.com/demo/reference/authentication)
- [OANDA API access](https://developer.oanda.com/rest-live-v20/introduction/)
- [Databento access](https://databento.com/docs/getting-started/build-first-app)
- [Tradier sandbox/data differences](https://docs.tradier.com/docs/market-data)
- [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/)

References checked on 2026-10-20. Confirm current region, licensing, quota and endpoint entitlement in your own account before enabling a paid selector. Each contributor needs their own provider account; this code does not redistribute the maintainer’s data subscriptions.
