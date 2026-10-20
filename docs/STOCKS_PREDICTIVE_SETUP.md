# Stocks predictive research setup

This is development-branch research infrastructure. Auralith v4 remains the production strategy. New models cannot place orders, become champions, or post approved trade alerts. No paid provider is required to run the code; actual stock data still requires legally authorized access. Free Alpaca IEX is a single-venue source, not a consolidated-market substitute.

## Runtime and installation

Use the repository root `npm run bootstrap` for locked Node dependencies. Node 22.9+ is the repository requirement. Use a separate Python 3.11+ environment; the implementation was tested with Python 3.14.3, CPU LightGBM 4.6.0, NumPy 2.4.3 and scikit-learn 1.9.1. Python dependencies are confined to the worker, not cPanel's Node application.

PowerShell, repository root:

```powershell
py -m venv .venv-stocks
& ./.venv-stocks/Scripts/python.exe -m pip install -r stocks-bot/forecasting/requirements.txt
& ./.venv-stocks/Scripts/python.exe -m unittest discover -s stocks-bot/forecasting -p 'test_*.py' -v
npm test
npm run check
```

No production secrets were copied into this clone. Obtain your own Discord application and provider credentials following the repository README and `CONFIGURATION.md`. The existing scanner uses `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` and `ALPACA_DATA_FEED`; do not confuse these with unofficial key names. Paid SIP access is configured through the existing feed setting and your entitled account. Setting a feed string does not grant an entitlement.

## Data capture and offline research

After reviewed code is installed on a research instance, each existing deep-screen feature JSONL row contains `predictiveObservation`. Capturing this field makes no new market-data HTTP requests. The broad-discovery archive already holds cheap-screen snapshots/rejections; it is separate from the deep-model warehouse and has a 14-day retention policy. Preserve authorized archives before expiration if needed for research.

The Python commands accept explicit file lists; they do not expand shell wildcards internally. Keep generated artifacts and data in ignored directories. Example PowerShell:

```powershell
$stockFeatures = @(Get-ChildItem stocks-bot/data/research/features/*.jsonl | ForEach-Object FullName)
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/engine.py --db stocks-bot/data/predictive.sqlite ingest @stockFeatures
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/engine.py --db stocks-bot/data/predictive.sqlite status
```

Use the actual configured `dataDir` if it differs. Files without the new observation field are counted as legacy and skipped; no historical feature availability is invented. Source byte offsets and forecasts commit together. Truncated files, malformed complete lines and conflicting observation IDs fail visibly; incomplete final lines wait for the next pass. Existing predictions are immutable and retries are idempotent.

### Outcomes

Supply the existing research store's one-minute `market_bar` JSONL files, preserving exact provider strings such as `alpaca-iex`. The files require symbol, timestamp in epoch seconds, OHLC and actual `recordedAt`. Do not relabel SIP paths as IEX, combine feeds, fill missing minutes, or infer fills from a current last price.

```powershell
$stockBars = @(Get-ChildItem stocks-bot/data/research/bars -Recurse -Filter '*.jsonl' | ForEach-Object FullName)
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/engine.py --db stocks-bot/data/predictive.sqlite label @stockBars --cost-bps 20
```

Check the actual market-bar path in `storage.js`; provider subdirectories are supported by explicit lists. Labels use the next full minute, complete same-feed minute paths, conservative stop-first ambiguity, gap-through-stop opens, session deadlines and immutable cost assumptions. The default target is 1%, stop 0.75%, and assumed round-trip cost 20 bps split equally across entry and exit. **These are research-policy assumptions, not production Auralith parameters or evidence of executable fills.** Costs must be adapted to the instrument/venue in a separate experiment database. Whole-horizon MAE/MFE are labeled as such, not represented as held-position excursions. No target-2 strategy is implemented here.

Actual label creation/availability time is retained. A delayed backfill cannot be treated as a label available months earlier. This deliberately prevents training from retroactively collected evidence unless a separate verified point-in-time historical import is built. Existing files alone may therefore be insufficient for a retrospective study.

### Training

```powershell
New-Item -ItemType Directory -Force stocks-bot/artifacts | Out-Null
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/engine.py --db stocks-bot/data/predictive.sqlite train --output stocks-bot/artifacts/stocks-experiment-001.json
```

The command refuses to overwrite experiments. Each horizon needs at least 200 labels across 24 dates and sufficient class diversity after purging. Train/selection/calibration/final-holdout blocks are 50/15/15/20% of global observation dates. Purging considers complete horizon end and actual label availability plus a five-minute embargo. Round counts 30/60 are selected on the selection block. Platt parameters and residual ranges use only calibration data. The held-out outcome metrics do not approve the model. Expanding walk-forward, matched Auralith replay, regime/liquidity breakdowns, realistic execution and forward validation remain required.

Direction and target-before-stop probabilities are separate from expected return. At inference probabilities remain explicitly `experimentalProbabilityUp` / `experimentalTargetBeforeStopProbability`; `calibratedProbability` stays null until independent deployment validation exists. The residual range is not claimed to have validated 90% market coverage. Models with missing schema, excessive missingness, distribution outliers or unavailable/expired horizons abstain. A model cannot issue a prospective forecast for an observation preceding its creation.

## Isolated service and Node worker

Set `STOCKS_FORECAST_TOKEN` to a **new dedicated random secret of at least 32 characters** in the process environment. Do not reuse Discord/provider tokens or put secrets into URLs or source. Both processes require the same secret. The worker requires `STOCKS_FORECAST_URL=http://127.0.0.1:8792/forecast` locally.

Start Python in its own supervised process:

```powershell
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/service.py --db stocks-bot/data/predictive.sqlite --port 8792
# Only after a research artifact exists, optionally add:
# --model stocks-bot/artifacts/stocks-experiment-001.json
```

Then run a bounded worker pass in a separate terminal with the two research environment variables set:

```powershell
npm --prefix stocks-bot run research:predictive
```

The worker submits new persisted deep observations, up to 250 or 45 seconds per pass, with a five-second HTTP timeout. It emits only counts/timing, never Discord messages or orders. Schedule repeated passes independently of the main scanner. On error the prior durable cursor remains; replay returns frozen forecasts. A worker lock prevents competing cursor writers. After an abnormal worker exit, verify the owning process has ended before removing its stale `.lock` file. Never delete an active lock to force concurrency.

The Python HTTP server binds numeric loopback only, requires a dedicated Bearer token, rejects bodies above 2 MB, serializes inference and returns sanitized errors. For remote use keep it private behind an authenticated TLS reverse proxy/VPN. The Node client requires HTTPS except numeric loopback, rejects credentials/query strings in endpoints, rejects redirects and bounds responses. Python or network failure does not interrupt the existing Discord scanner because the scanner never calls this service.

cPanel Python support, process supervision, CPU/RAM quotas and actual deployed source **were not verified**. Do not upload model weights into a public web directory. A separate local/VPS worker is supported by the interface, but its operational deployment still requires review. No hosting changes were made.

## Optional Chronos challenger

Install `chronos-forecasting==2.3.2` and an appropriate CPU/GPU PyTorch build in the separate environment. The selected candidate is `amazon/chronos-bolt-tiny` (Apache-2.0 model card), with an explicit 40-character model revision. Model fetching happens only when invoking the optional command, not during Discord/service startup.

```powershell
& ./.venv-stocks/Scripts/python.exe stocks-bot/forecasting/engine.py --db stocks-bot/data/predictive.sqlite chronos --bars stocks-bot/datasets/verified-context.json --horizon 15 --revision a0e552de83495b5c28c14c71c374f3e33280b340
```

The input is a JSON array of at least 32 consecutive complete five-minute bars in one verified regular session. Each bar requires `timestamp`, `close`, `sessionDate`, `sessionCloseAt`, `intervalMinutes: 5`, `complete: true` and `adjustmentStatus: "verified"`. The caller must establish those attributes from entitled source/calendar/action evidence; renaming unverified data does not verify it. Horizons crossing close, gaps and unverified adjustments are rejected. This conservative context requirement prevents an opening-session claim unsupported by available bars. Next-session behavior is not implemented. Raw pretrained quantiles are experimental; stock skill, pretraining overlap and range coverage are unverified.

Official projects: [LightGBM](https://github.com/lightgbm-org/LightGBM), [Chronos](https://github.com/amazon-science/chronos-forecasting), [Chronos-Bolt-Tiny model](https://huggingface.co/amazon/chronos-bolt-tiny).

## Review gates still open

Read `STOCKS_PREDICTIVE_PHASES.json` before claiming completion. There are no new approved alerts, no demonstrated lead-time improvement and no profitability evidence. Quiet-market discovery, next-session models, stronger point-in-time news/corporate-action handling, historical/walk-forward comparison and forward-paper promotion remain separate work. Keep live trading disabled.
