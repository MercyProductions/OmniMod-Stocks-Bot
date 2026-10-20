# Shared paper quote integrity — 2026-10-03

Status: local implementation and regression verification complete. Provider-backed execution, fill calibration, deployment and multi-session performance remain unverified. This is a continuation of the six-market goal, not a replacement for provider setup or forward validation.

## Reproduced failures

Three isolated regressions failed against the saved original `paperRisk.js`:

1. After a valid option-spread fill, a quote labeled executable with `bid: null, ask: null` closed the position at zero. JavaScript numeric coercion treated missing fields as an actual worthless quote.
2. A reservation approved with a 0.2% spread ceiling filled on a roughly 0.30015% spread when the later monitor used its 0.5% default.
3. A reservation approved with a five-second freshness ceiling filled on a nine-second-old quote when the monitor allowed sixty seconds.

These are deterministic local defects, not evidence that an actual account or hosted bot experienced them. The current local operator report contains no shared production ledger.

## Change and contract

`shared/paperRisk.js` now checks explicit finite numeric prices and policy fields. Numbers and nonblank finite numeric strings remain supported; missing values, blanks, booleans, arrays, objects and infinities cannot become prices. Actual numeric zero remains valid for option-spread liquidation. Other asset classes still require positive bids.

The approval fingerprint now includes `riskLimits.maxSpreadPct`. Each new reservation saves:

```json
{
  "paperExecutionVersion": "paper-quotes-v2-pinned-entry-policy",
  "entryQuotePolicy": {
    "maxQuoteAgeMs": 5000,
    "maxSpreadPct": 0.2
  }
}
```

The numbers above are test examples. Production values come from that candidate's actual approval. A pending fill uses the stricter of the saved approval and current monitoring limits. Invalid quotes leave the ledger, P&L and events unchanged. The existing emergency-stop, expiration, exposure, fee, stop, target and loss logic remains.

Entry spread ceilings do not prevent risk-reducing exits from an already filled position. Open positions still require fresh executable quotes under the monitor's current freshness policy. A genuine zero-valued option spread can close at zero; a missing quote cannot.

## Existing records and research versions

An unfilled legacy reservation without valid saved entry limits cannot fill: it returns `entry_quote_policy_unavailable`. It can still expire or cancel under the existing stop/deadline handling. Do not invent limits or rewrite its earlier approval. A still-relevant idea needs a new, independently approved candidate.

Filled legacy positions can still be monitored and exited using current valid quotes. Historical fills/P&L are not recalculated or overwritten. No migration script modifies existing records.

`shared/forwardShadowPaper.js` includes the execution version in the experiment fingerprint, frozen manifest, journal and returned report. Revised execution cannot silently join an old frozen forward cohort. Existing prior-experiment positions continue through the monitor; the prior-cohort risk blocks remain. This does not promote a strategy or change discovery/technical/model thresholds.

The shared executor supports all six owners. The four newer market runners call its quote lifecycle directly; the Stocks/Crypto legacy publication and observation paths are separate and must not be assumed to have become executable quote-based trading merely because shared tests pass.

## Verification

- Baseline regression: three failures, capturing the erroneous close and two fills.
- Final focused integrity suite: ten tests pass, including 420 malformed-price cases across seven asset classes and both reserved/filled states; valid zeros, tighter policies, malformed saved limits, legacy exits and approval-fingerprint protection.
- Existing shared-risk, shadow and approval suite: 86 tests passed after the initial correction. The final full run includes the expanded cases and execution-cohort assertion.
- `npm run verify:all`: **1,476 tests pass** — 859 shared/new-market, 268 Stocks, 349 Crypto. Configured syntax checks pass, including 292 shared/new-market JavaScript files; nine Windows launcher checks pass.

All new regression writes use temporary ledgers. No provider calls, paid feed activation, live order, Discord post, upload or runtime configuration change was performed by this phase.

Evidence is under `../../review-verification/`: `paper-quote-integrity-baseline-20261003/manifest.json`, the baseline/focused/six-market logs, `paper-quote-integrity-operator-20261003.json`, and `paper-quote-integrity-checkpoint-20261003.json`.

## Remaining operation work

The current local report still shows Forex, Futures, Options and ETFs running as Discord applications with `not_configured` market readiness, zero provider requests and no automated market scan. Stocks/Crypto have no local runtime evidence; remote state must be checked separately. Missing feed credentials, account entitlements, explicit costs/equity and required market reviews remain unresolved.

Next: configure legitimately available free/account-included or explicitly opted-in paid feeds, measure authenticated directories/quotes/latency, then collect separate costed forward cohorts. Snapshot polling still cannot prove an uninterrupted executable price path or real fill depth. No profitable or statistically validated strategy is established by this fix.
