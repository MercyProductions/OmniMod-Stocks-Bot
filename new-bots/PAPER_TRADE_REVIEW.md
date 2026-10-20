# Paper trade review workflow

`npm run report:research` derives a read-only review queue from every closed shared-paper order. Its flags are observations from the simulated ledger, not causal conclusions. The current local ledger has no closed trades. When forward paper records exist, use the JSON report's `postTradeReview.reviewQueue` to obtain the exact `orderId` and recorded price, cost, excursion, and issuance facts.

Orders reserved after 2026-10-01 also carry a bounded `sharedApprovalEvidence` snapshot in the review: quote age, spread, costed reward/risk, risk budget, reserved size, and any raw score/confidence/probability fields supplied by the source signal. These raw fields are not calibrated probabilities. Production candidate paths now add a bounded `marketGateTrace` of checks they report as passed, tied to the owner, strategy and candidate quote time. It is partial source-reported evidence, not a reconstruction or proof of every technical, provider or model gate; absent, invalid, and shadow-profile traces stay unavailable or explicitly invalid. Earlier orders cannot be backfilled from later data.

To record a manual assessment, create a local JSON input file outside source control. For a **losing** paper order:

```json
{
  "orderId": "the-order-uuid-from-the-report",
  "reviewer": "research lead",
  "thesisValidity": "uncertain",
  "lossCause": "undetermined",
  "evidenceBasis": "paper_ledger",
  "evidenceAsOf": "2026-10-01T16:00:00.000Z",
  "summary": "The recorded quote path does not establish why this particular setup lost."
}
```

Run `npm run review:paper -- C:\path\to\review-input.json` from `new-bots`. It resolves the same `TRADING_RISK_STATE_PATH` as the shared paper ledger. If that path is set, use the same absolute value used by the bots. The command checks that the order is closed, binds the review to its complete terminal record, and appends one line to `<ledger-path>.reviews.jsonl`. It prints only the order ID, new review ID, revision link, and timestamp. It never changes the paper order or any strategy gate.

For a non-losing order, use `lossCause: "not_applicable"`; thesis validity still needs review. Supported losing-trade assessments are `undetermined`, `valid_setup_lost`, `weak_setup_quality`, `incorrect_market_regime`, `poor_execution`, `excess_spread_or_slippage`, `bad_stop_placement`, `late_entry`, `false_breakout`, `catalyst_shock`, `correlated_market_move`, `bad_or_missing_data`, and `strategy_bug`. These are **operator assessments**, not automatically established facts. Use `uncertain`/`undetermined` when evidence cannot distinguish the cause. A stop exit alone does not establish a false breakout or bad stop.

`evidenceBasis` may be `paper_ledger`, which refers to the order's recorded facts, or `external_https`, which also requires `sourceUrl`. External URLs must use HTTPS and omit credentials, query strings, and fragments. The summary must explain what the evidence actually supports. `evidenceAsOf` is the evidence's observation time and may precede the trade; it cannot be later than the review. The journal records the review time separately. This workflow does not independently verify an external source or reconstruct unsampled price movement.

Corrections append another record. Include `supersedesReviewId` equal to the latest review ID from the JSON report; the original remains in the journal. A changed paper order, malformed journal row, broken revision chain, or mismatched fingerprint is reported as a journal issue. The writer fails closed until that condition is investigated; do not erase the journal to make an error disappear. The JSON/HTML dashboard excludes stale or invalid assessments and labels accepted ones as manual. The integrity digest catches accidental editing but is not a cryptographic signature against a malicious writer.

The review journal has no authority to retrain a model, change a threshold, promote a shadow strategy, size a trade, or place an order. Compare patterns only after enough independent, costed forward observations and point-in-time evidence exist.
