# Read-only Alpaca research testing

The private `stocks-bot/.env` supplies `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` from a paper account. Keep `ALPACA_DATA_FEED=iex`, `OMNIMOD_EMERGENCY_STOP=true` and `OMNIMOD_LIVE_TRADING_ENABLED=false`. Never commit credentials or paste them into logs. Rotate a secret disclosed in chat before ongoing use.

## Access checks

```powershell
npm --prefix stocks-bot run alpaca:probe
npm --prefix stocks-bot run probe:discovery
```

The access probe uses allowlisted GET routes for the paper account, quotes, trades and historical bars. It never calls order routes. Only a sanitized account-access status is retained. Missing credentials, entitlement failures and rate limits are explicit; they are not reported as an empty market scan.

Free IEX is single-venue coverage. Older SIP history is tested separately against actual account entitlement; successful historical access does not imply real-time SIP entitlement. No subscription is purchased. Closed-session quotes cannot establish live breakout detection. The discovery probe keeps current timestamps and all freshness gates; it never backdates snapshots to force candidates.

## Bounded historical capture and evaluation

```powershell
npm --prefix stocks-bot run research:capture-alpaca -- --study=my-private-study --feed=iex --symbols=AAPL,MSFT,NVDA
```

Default capture is 90 calendar days of native raw one-minute bars, ending at least 20 minutes before collection. Use `--feed=sip` only when your account has authorized access to the requested older history. The capture enforces symbol, date, pagination and response bounds, respects the shared request gate, refuses overwrites, and fingerprints completed datasets. Failed/partial captures do not receive a completed study manifest.

Datasets stay in ignored `stocks-bot/datasets/alpaca/<study>/`. Run the existing Python walk-forward evaluator against that folder's `study.json`, choosing a fresh ignored output path and a predefined horizon of 5, 15, 30, 90 or 240 minutes. See `STOCKS_QUIET_WALKFORWARD.md` for the chronological split, purging and calibration protocol. Alpaca studies use actual one-minute paths, a full one-minute entry latency, the frozen 20-basis-point round-trip cost assumption, and stop-first ambiguity. The Alpha Vantage demo retains its native five-minute path and latency.

Raw historical prices do not establish historical availability, corrected-data vintages, verified corporate actions, executable NBBO, news or full production-strategy replay. Reconstructed observations never enter the prospective forecast warehouse. There is no automatic model installation, Discord alert, order or promotion.

## Verification checkpoint: October 20, 2026

Authenticated paper access, IEX quotes/trades, older SIP/IEX history, the broad discovery probe, a three-symbol historical capture, and all five predefined walk-forward horizon studies completed locally. Sanitized reports, raw data and numerical model results remain private and ignored. The research results do not establish a reliable predictive edge; no candidate was promoted.

Stocks tests: 324 Node tests and 18 Python tests passed; Stocks syntax checks passed with real credentials present only in the ignored operator file. The test preloader explicitly redirects configuration to a separate nonexistent test environment file so unit tests cannot inherit the operator's credentials or safety settings.

Remaining: credential rotation after chat disclosure, regular-session/premarket freshness and coverage checks, quiet-worker forward runtime, frozen forecasts followed through their actual horizons, and independently validated execution/corporate-action evidence. Live trading remains disabled. No production deployment occurred.

## Next-session observation

`node stocks-bot/scripts/validate-market-session.js --session=pre_market` (or `--session=regular`) records up to 55 actual discovery probes, at least one minute apart, only while the expected exchange session remains eligible. Three consecutive provider failures stop collection. Private timestamped JSONL and existing full discovery archives preserve original selections and rejections. Tests verify closed-session abstention, count preservation, bounds and failure termination. This is discovery research, not a replay of downstream production approval or verified early alerts. Two local thread follow-ups are scheduled for October 21, 2026 at 07:30 and 08:30 America/Chicago. The machine/app must be available; missed sessions must be reported rather than reconstructed as live observations.
