# Public Crypto historical cost sensitivity

Frozen discovery snapshot: 2026-10-01T21:25:47.254Z; scenario generated: 2026-10-01T21:42:38.277Z.

This applies each asset's **current** quote-based estimated round-trip cost to its older frozen 15-minute candle history. It changes replay stop/target geometry and sometimes the trade set as well as cost deductions. An individual mean can even improve under a higher cost because the replayed trades change; that is not evidence of a better strategy. It is a research sensitivity scenario, **not** historical point-in-time execution evidence or a reason to change production approval. The original replay assumes a fixed configured cost.

| Asset | Cost, bps | Recent trades | Recent mean R | Overall mean R | Historical gate passes |
| --- | ---: | ---: | ---: | ---: | --- |
| AAVE | 20.000 → 33.685 | 11 → 10 | -0.065 → -0.104 | -0.234 → -0.337 | no → no |
| NIGHT | 20.000 → 35.822 | 20 → 18 | 0.002 → -0.116 | 0.024 → -0.049 | yes → no |
| AVAX | 20.000 → 27.057 | 6 → 6 | -0.834 → -0.907 | -0.424 → -0.482 | no → no |
| TRAC | unavailable: incomplete_frozen_candle_path | — | — | — | — |
| JASMY | 20.000 → 99.085 | 8 → 6 | -0.171 → 0.205 | -0.265 → -0.198 | no → no |
| SAND | 20.000 → 114.314 | 14 → 8 | -0.043 → -0.380 | -0.200 → -0.523 | no → no |
| BNB | 20.000 → 21.543 | 9 → 9 | -0.382 → -0.398 | -0.468 → -0.485 | no → no |
| SYRUP | 20.000 → 51.126 | 11 → 7 | -0.374 → -0.186 | -0.129 → 0.024 | no → no |

```json
{
  "generatedAt": "2026-10-01T21:42:38.277Z",
  "probeSnapshotFetchedAt": "2026-10-01T21:25:47.254Z",
  "probeCompletedAt": "2026-10-01T21:36:17.643Z",
  "probeStrictCandidates": 0,
  "compared": 7,
  "unavailable": 1,
  "quoteScenarioCostAboveBaseline": 7,
  "baselineValidationPassing": 1,
  "quoteScenarioValidationPassing": 0,
  "rows": [
    {
      "assetId": "aave",
      "symbol": "AAVE",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "AAVEUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "365bc5e46f788a49feb7196a6224b7c470543bc4cdbe183443522471b6464e10",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 33.68476555137562,
      "costDifferenceBps": 13.68476555137562,
      "baseline": {
        "recent": {
          "trades": 11,
          "signalDays": 2,
          "expectancyR": -0.0651168200458378,
          "profitFactor": 0.8492719194036797
        },
        "overall": {
          "trades": 28,
          "signalDays": 6,
          "expectancyR": -0.2338230489133919,
          "profitFactor": 0.5818291258302656
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 10,
          "signalDays": 2,
          "expectancyR": -0.10411513101857606,
          "profitFactor": 0.7325274169127739
        },
        "overall": {
          "trades": 26,
          "signalDays": 6,
          "expectancyR": -0.3374459401293557,
          "profitFactor": 0.4429655032085964
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "midnight-3",
      "symbol": "NIGHT",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "NIGHTUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "331aabd3f443cf8a4bdce77c4bb82be081c537a9a2f216fc0976d67253bc86af",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 35.8222252448185,
      "costDifferenceBps": 15.822225244818497,
      "baseline": {
        "recent": {
          "trades": 20,
          "signalDays": 3,
          "expectancyR": 0.0021280645457368184,
          "profitFactor": 1.004404648938739
        },
        "overall": {
          "trades": 50,
          "signalDays": 6,
          "expectancyR": 0.02375421825255519,
          "profitFactor": 1.0534820403379226
        },
        "validationReasons": []
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 18,
          "signalDays": 3,
          "expectancyR": -0.11589363003130743,
          "profitFactor": 0.7711226311047168
        },
        "overall": {
          "trades": 47,
          "signalDays": 6,
          "expectancyR": -0.04913874420549626,
          "profitFactor": 0.8925592380206151
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "avalanche-2",
      "symbol": "AVAX",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "AVAXUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "c05c903c898228d8ee0f67a411e9419e8bcceba0460a514f1c401c094ac83295",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 27.05684854965292,
      "costDifferenceBps": 7.056848549652919,
      "baseline": {
        "recent": {
          "trades": 6,
          "signalDays": 3,
          "expectancyR": -0.8340920928871739,
          "profitFactor": 0.052586218611122885
        },
        "overall": {
          "trades": 29,
          "signalDays": 6,
          "expectancyR": -0.42416605937604246,
          "profitFactor": 0.40379141363403437
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 6,
          "signalDays": 3,
          "expectancyR": -0.9074198524990805,
          "profitFactor": 0.035324650022585856
        },
        "overall": {
          "trades": 29,
          "signalDays": 6,
          "expectancyR": -0.48248463389862617,
          "profitFactor": 0.35881728484814707
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "origintrail",
      "symbol": "TRAC",
      "status": "unavailable",
      "reason": "incomplete_frozen_candle_path"
    },
    {
      "assetId": "jasmycoin",
      "symbol": "JASMY",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "JASMYUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "a9a71ac2e37a3378ea122d41ab88a33fe5239cc167d9c2300eb9442d4daad6c4",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 99.08536390180556,
      "costDifferenceBps": 79.08536390180556,
      "baseline": {
        "recent": {
          "trades": 8,
          "signalDays": 3,
          "expectancyR": -0.1707225828810841,
          "profitFactor": 0.7042012943939111
        },
        "overall": {
          "trades": 41,
          "signalDays": 6,
          "expectancyR": -0.2653071628817516,
          "profitFactor": 0.5635847461628409
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 6,
          "signalDays": 3,
          "expectancyR": 0.20456021052358297,
          "profitFactor": 1.9398066705677781
        },
        "overall": {
          "trades": 25,
          "signalDays": 6,
          "expectancyR": -0.1982699799441798,
          "profitFactor": 0.6114455914508975
        },
        "validationReasons": [
          "nonpositive_overall_expectancy",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "the-sandbox",
      "symbol": "SAND",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "SANDUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "568e064a286e69fef86b94df99e581f622ce6ad5188d9b377c5b7f92bc5d9617",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 114.3142399807793,
      "costDifferenceBps": 94.3142399807793,
      "baseline": {
        "recent": {
          "trades": 14,
          "signalDays": 3,
          "expectancyR": -0.04299281638043192,
          "profitFactor": 0.8985770136656102
        },
        "overall": {
          "trades": 35,
          "signalDays": 6,
          "expectancyR": -0.19959329969152212,
          "profitFactor": 0.6355155764549304
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 8,
          "signalDays": 3,
          "expectancyR": -0.37984167516845524,
          "profitFactor": 0.012885275817675838
        },
        "overall": {
          "trades": 20,
          "signalDays": 6,
          "expectancyR": -0.5230397127245883,
          "profitFactor": 0.0134578094114666
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "binancecoin",
      "symbol": "BNB",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "BNBUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "d31d9e646697cb6636ba394f72951e6a6c69a4c8651de814bb5e335b2462d8c5",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 21.54349478039306,
      "costDifferenceBps": 1.5434947803930612,
      "baseline": {
        "recent": {
          "trades": 9,
          "signalDays": 3,
          "expectancyR": -0.3822281103156572,
          "profitFactor": 0.35110722171162295
        },
        "overall": {
          "trades": 21,
          "signalDays": 6,
          "expectancyR": -0.46780191956088174,
          "profitFactor": 0.21337755121498486
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 9,
          "signalDays": 3,
          "expectancyR": -0.39842527776422704,
          "profitFactor": 0.3364886064859086
        },
        "overall": {
          "trades": 21,
          "signalDays": 6,
          "expectancyR": -0.48454352961276453,
          "profitFactor": 0.2027432972566621
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      }
    },
    {
      "assetId": "syrup",
      "symbol": "SYRUP",
      "status": "compared",
      "candleProvider": "Binance",
      "candlePair": "SYRUPUSDT",
      "firstOpenAt": "2026-09-25T15:45:00.000Z",
      "lastCompletedAt": "2026-10-01T21:30:00.000Z",
      "candleCount": 599,
      "candleSha256": "4b1afd6fe898e09f106298e54d5668c4379b33249429fe71995b5532942fdfdc",
      "baseCostBps": 20,
      "quoteScenarioCostBps": 51.125897331564914,
      "costDifferenceBps": 31.125897331564914,
      "baseline": {
        "recent": {
          "trades": 11,
          "signalDays": 2,
          "expectancyR": -0.3736010871413988,
          "profitFactor": 0.49853683578586316
        },
        "overall": {
          "trades": 31,
          "signalDays": 6,
          "expectancyR": -0.128817834456024,
          "profitFactor": 0.774514797376273
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ]
      },
      "quoteCostScenario": {
        "recent": {
          "trades": 7,
          "signalDays": 2,
          "expectancyR": -0.185714285714286,
          "profitFactor": 0.6749999999999995
        },
        "overall": {
          "trades": 24,
          "signalDays": 6,
          "expectancyR": 0.024023297823354828,
          "profitFactor": 1.0555319374503047
        },
        "validationReasons": [
          "nonpositive_recent_expectancy",
          "recent_profit_factor_not_above_one"
        ]
      }
    }
  ],
  "interpretation": "Research-only cost sensitivity. A single quote-time cost estimate is applied uniformly to older OHLC candles. It is not a point-in-time spread/slippage history, an executable-fill backtest, an independent holdout, or a production approval change."
}
```
