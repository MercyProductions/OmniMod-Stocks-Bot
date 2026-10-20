# Public daily-data smoke test

No bot login, trade, or Discord message was made. Public provider limits and availability can change. This is a plumbing check, not investment evidence.

```json
{
  "checkedAt": "2026-09-29T17:39:46.876Z",
  "purpose": "Capped BTC/ETH public daily-data smoke test; liquidity snapshot intentionally absent, so no investment qualification.",
  "report": [
    {
      "symbol": "BTC",
      "provider": "Binance",
      "interval": "1d",
      "completedBars": 719,
      "lastDailyCloseAt": "2026-09-29T00:00:00.000Z",
      "providerErrors": [],
      "horizonSamples": [
        {
          "horizonDays": 5,
          "samples": 31,
          "assessment": "DESCRIPTIVE historical windows; no untouched strategy-selection holdout"
        },
        {
          "horizonDays": 20,
          "samples": 9,
          "assessment": "INSUFFICIENT independent windows"
        },
        {
          "horizonDays": 60,
          "samples": 3,
          "assessment": "INSUFFICIENT independent windows"
        }
      ],
      "decision": "INSUFFICIENT / UNSUITABLE",
      "reasons": [
        "Current 24-hour dollar-volume snapshot is unavailable; liquidity cannot be evaluated."
      ]
    },
    {
      "symbol": "ETH",
      "provider": "Binance",
      "interval": "1d",
      "completedBars": 719,
      "lastDailyCloseAt": "2026-09-29T00:00:00.000Z",
      "providerErrors": [],
      "horizonSamples": [
        {
          "horizonDays": 5,
          "samples": 22,
          "assessment": "DESCRIPTIVE historical windows; no untouched strategy-selection holdout"
        },
        {
          "horizonDays": 20,
          "samples": 7,
          "assessment": "INSUFFICIENT independent windows"
        },
        {
          "horizonDays": 60,
          "samples": 2,
          "assessment": "INSUFFICIENT independent windows"
        }
      ],
      "decision": "INSUFFICIENT / UNSUITABLE",
      "reasons": [
        "Current 24-hour dollar-volume snapshot is unavailable; liquidity cannot be evaluated."
      ]
    }
  ]
}
```
