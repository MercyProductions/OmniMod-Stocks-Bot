# OmniMod Stocks Bot

Independent Discord application for **Stocks** market scanning, strategy research and paper-trade tracking. The primary application is [`stocks-bot/`](stocks-bot/); `npm start` launches only this bot.

This is a source snapshot prepared on 2026-10-19. Live orders remain disabled. Source-code tests do not establish profitable performance or active market-data entitlements.

## Get started

Use Node.js **22.9 or newer** (validated with Node 24) and npm.

```sh
npm run bootstrap
npm run info
npm test
npm run check
```

Bootstrap installs the three existing locked dependency trees using `npm ci --ignore-scripts`. No account credentials are shipped. Copy `stocks-bot/.env.example` to `stocks-bot/.env` locally, then configure this bot's own Discord identity, channel and selected data providers. Read the [bot documentation](stocks-bot/README.md) and [provider setup](new-bots/DATA_PROVIDER_SETUP.md) before activation.

```sh
npm run register
npm start
```

Registration modifies the configured Discord application's commands; startup connects to Discord and may publish configured scan messages. Neither command was run as part of this GitHub export.

## Repository layout and shared code

The current architecture has cross-market imports and integration tests. To preserve working relative paths without a risky packaging refactor, this repository includes the same complete **source integration bundle** as the other five bot repositories: `stocks-bot/`, `crypto-bot/`, and `new-bots/`. The sibling code supports shared risk, data adapters and verification; including it does not start the other bots. The supplemental read-only research modules are retained because the shared test workspace depends on them.

`repository.json` identifies this repository's primary bot and records each copied source file's SHA-256. The six exports share one source snapshot hash. Update shared code consistently across repositories; this snapshot arrangement does not automatically synchronize future edits.

Commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Start only the Stocks bot |
| `npm run register` | Register only this bot's Discord commands |
| `npm test` | Run this bot's existing tests |
| `npm run test:all` | Run the shared workspace, Stocks and Crypto test suites |
| `npm run check` | Run all existing source syntax checks |
| `npm run report` | Read local operator diagnostics |

## Coordinating multiple repositories

Separate checkouts have separate default runtime folders. Before operating multiple bots as one paper portfolio, set **the same absolute `TRADING_RISK_STATE_PATH`** and **the same absolute `OMNIMOD_SIGNAL_RESEARCH_PATH`** in each bot's private local configuration. Match account-equity and cost assumptions. The file-based ledger coordinates only processes on the same filesystem; it does not coordinate different hosts. Follow [shared risk documentation](new-bots/README.md) and keep the emergency stop enabled until paper configuration is reviewed.

## Verification and current limitations

See [EXPORT_VERIFICATION.md](EXPORT_VERIFICATION.md) for checks on this sanitized snapshot. Credentials, local `.env` files, cached market data, paper ledgers, private deployment configuration, logs and dependencies are excluded. Missing data inputs must not be interpreted as a successful scan finding no opportunities.

Provider-backed six-market operation and independent after-cost forward/out-of-sample strategy evidence remain incomplete. Existing historical documents describe earlier observations; they are not evidence of the current remote deployment state. No production server or live-money account is changed by this repository upload.
