# Operator scan-data locations

Verified locally on 2026-10-03. This change concerns observation, not strategy approval or paper execution.

## Defect and correction

The operator report previously resolved Stocks and Crypto data directories once at module import, defaulted to each repository's `data` folder on every OS, and ignored bot-local `.env` path settings. The actual bots use their project data folder on Windows and `~/.omnimod-stocks-data` / `~/.omnimod-crypto-data` on other operating systems. Stocks also reads its local path setting explicitly; Crypto receives it from its launch environment/dotenv.

As a result, a working worker could have scan journals, heartbeat files and paper-position-monitor records while the report said `no-scan-data`. A preserved original-source regression reproduced that discrepancy with real temporary files.

`operatorDataPaths.js` now resolves the expected locations on each collection call. `collectOperatorReport()` uses those locations consistently for all three record types and reports `dataLocation.source`, `relativeTo` and `directoryExists`. It does not include the paths or `.env` values in the report. No bot configuration is imported or mutated.

Resolution order:

1. Explicit `stocksDataDir` / `cryptoDataDir` report argument. Relative arguments retain their existing meaning: relative to the report process working directory.
2. Nonempty `OMNIMOD_STOCKS_DATA_DIR` / `OMNIMOD_CRYPTO_DATA_DIR` process environment value.
3. The matching bot-local `.env` setting. Stocks falls through an empty process value; Crypto's existing empty process value masks dotenv, matching its runtime behavior.
4. The platform-specific runtime default described above.

Relative worker path settings assume the managed launcher runs from that bot's project directory. That is how the existing Windows launcher starts the workers. The reporter cannot infer a separate worker's environment, OS user/home or custom working directory, including the legacy coupled website host. Supply absolute report arguments or absolute path environment overrides when inspecting such deployments. The report does not search old folders and select whichever contains data: that could substitute stale records from another instance.

Missing configured folders remain missing. Files in place of directories, permission errors and unreadable configuration fail visibly rather than becoming successful empty scans. Node's built-in environment parser handles quoted paths and comments without loading secrets into `process.env`. All four newer bots retain their existing project data locations.

## Verification and current operational evidence

- The original implementation failed the configured-folder regression (`no-scan-data` instead of `fresh`).
- `node --test shared/test/operatorDataPaths.test.js shared/test/operatorReport.test.js`: **37 passed**. Seven new cases cover collection of all three record types, Windows/Linux defaults, override precedence, empty values, no stale fallback, call-time resolution, environment non-mutation, redaction and filesystem failures. One intermediate failure was an incorrectly named timestamp in a newly added test fixture; it was corrected to the monitor's existing `completedAt` schema.
- `npm run verify:all`: **1,834 passed** (1,140 shared/new-market, 302 Stocks, 392 Crypto), configured syntax checks including 352 shared-workspace JavaScript files, and nine Windows launcher checks.
- Read-only local report at **2026-10-03T19:54:36.866Z**: Stocks and Crypto both resolve existing Windows project data directories but have no scan journals or active-worker heartbeats there. Their saved position monitors report idle. This does not establish the state of the remote website host.
- The four new workers have fresh scan records and running heartbeats, but their sources remain Forex `disabled`, Futures `manual/manual`, Options `manual`, ETF/ETP `manual-fixture`. Shared active orders: **0**. Those are not verified full-market scans or evidence of zero market opportunities.

Evidence: `../../review-verification/operator-data-path-{baseline-test,focused,verification,readiness}-20261003.*` and `../../review-verification/operator-data-path-checkpoint-20261003.json`. Original files and SHA-256 hashes are under `../../review-verification/operator-data-path-baseline-20261003/`.

## Remaining work

Provider account/entitlement setup, explicit paper equity/cost assumptions, separate Stocks/Crypto deployment verification, and independent after-cost forward/OOS sessions remain unfinished. A path-resolution fix does not supply credentials, activate paid data, prove market coverage, or establish strategy profitability. No real `.env`, threshold, risk control, live-order setting or remote deployment was changed in this phase.
