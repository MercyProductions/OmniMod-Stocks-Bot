# Offline shadow replay profiles

Forex, Futures, Options, and ETFs/ETPs replay commands accept an optional `shadowConfigs` array in the same local JSON dataset used for the production-strategy replay. Each profile reruns the same timestamped observations, completed bars, quotes, session/catalyst context, execution costs, and paper-risk policy using an isolated temporary ledger. Shadow outcomes are returned under `report.shadowStrategies`; they do not replace production results, send Discord alerts, write to the shared live paper ledger, or reach an order endpoint.

Example profile:

```json
{
  "shadowConfigs": [
    { "id": "higher-volume", "overrides": { "minRelativeVolume": 2.0 } }
  ]
}
```

At most three unique labeled profiles are allowed per replay. Only market-specific strategy inputs can vary:

- Forex: `breakoutBars`, `breakoutBufferAtr`
- Futures: `rangeBars`, `minRelativeVolume`, `breakoutBufferAtr`
- Options: `minOpenInterest`, `minVolume`, `maxLegSpreadPct`, `minRewardRisk`
- ETFs/ETPs: `rangeBars`, `minRelativeVolume`, `breakoutBufferAtr`, `breakoutBufferBps`

Risk policy, fees, slippage, source observations, quote/session/catalyst gates, and instrument identity remain shared and fixed across tracks. Each result includes reservation fill and not-filled rates, target-1 and stop outcomes, net R return, MAE/MFE, drawdown, tail-loss estimate, turnover, exposure, holding time, sample sizes, and regime breakdown. Target 2 is explicitly `null` because these strategies currently define one target. These are exploratory isolated replays, not production approvals; use pinned chronological holdouts and forward paper data before considering strategy changes. Synthetic fixture tests verify separation and execution; no profitability claim is implied.
