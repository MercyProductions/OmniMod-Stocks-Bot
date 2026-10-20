# Crypto public funnel probe

Read-only cohort status at 2026-10-02T00:07:06Z: 15 frozen observations (nine audit-resolved, six pending) all have the same UTC entry date, 2026-10-01. This is **one date of correlated public research**, not 15 independent sessions or executable performance. `npm run probe:public-funnel -- --status` now reports per-entry-date created/resolved/pending coverage and missing-date counts without making provider requests. The next recorded deadline was 2026-10-02T00:24:23Z. Production model and approval behavior are unchanged.

Observed 2026-10-01T21:36:17.643Z. This is a diagnostic snapshot, not a trading signal.

```json
{
  "startedAt": "2026-10-01T21:36:02.471Z",
  "completedAt": "2026-10-01T21:36:17.643Z",
  "elapsedMs": 15171,
  "stageDurationsMs": {
    "snapshot": 9,
    "discovery": 3,
    "directory": 4557,
    "websocket": 6016,
    "quotes": 1797,
    "deepAnalysis": 2789
  },
  "scope": "One bounded public discovery, quote, technical and historical-validation diagnostic. No learned model, full event review, portfolio risk, Discord, paper reservation, or order action.",
  "settings": {
    "discoveryMinutes": 15,
    "maxMarketRank": 250,
    "minVolumeUsd": 5000000,
    "minScore": 64,
    "minProviderConfirmations": 2,
    "maxProviderCandidates": 8,
    "minRiskReward": 1.7,
    "estimatedRoundTripBps": 20,
    "derivativesEnabled": true,
    "maxExecutionSlippageBps": 35,
    "coingeckoApiTier": "public"
  },
  "snapshot": {
    "source": "CoinGecko public cache",
    "fetchedAt": "2026-10-01T21:25:47.254Z",
    "cacheHit": true,
    "stale": false,
    "providerRowsReturned": 500,
    "uniqueAssets": 352,
    "providerReportedTotal": 17964,
    "providerErrorPresent": false
  },
  "funnel": {
    "universe": 352,
    "freshnessPassed": 330,
    "freshnessUnknown": 0,
    "freshnessRejected": 2,
    "nonStable": 336,
    "identityRejected": 4,
    "rankPassed": 239,
    "liquidityPassed": 168,
    "scorePassed": 46,
    "trendPassed": 23,
    "discoveryQualified": 23,
    "directoryAvailable": true,
    "directoryVenues": [
      "Binance",
      "Coinbase",
      "Kraken"
    ],
    "directorySupportedVenueCounts": {
      "Binance": 19,
      "Coinbase": 18,
      "Kraken": 19
    },
    "directoryPassed": 19,
    "directoryRejected": 4,
    "deepAnalysisCapSelected": 8,
    "omittedByDeepAnalysisCap": 11,
    "selectedVenueThresholdMet": 8,
    "selectedVenueThresholdNotMet": 0,
    "sampledDirectoryExclusionsMeetingVenueThreshold": 0,
    "sampledDirectoryExclusions": 4
  },
  "discoveryRejectionCodes": {
    "duplicate_provider_symbol": 4,
    "liquidity": 71,
    "market_rank": 91,
    "minimum_score": 122,
    "provider_timestamp_stale": 2,
    "stable_asset": 16,
    "trend_continuation": 23
  },
  "directoryRejectionCodes": {
    "insufficient_listed_spot_venues": 4
  },
  "krakenWebsocket": {
    "status": "timed_out_or_partial",
    "requestedSymbols": 12,
    "sourceTimestampedQuotes": 8
  },
  "providerTelemetry": {
    "Coinbase": {
      "requests": 23,
      "successes": 17,
      "failures": 6,
      "rateLimits": 0,
      "cooldownDeferrals": 0,
      "averageLatencyMs": 104,
      "maxLatencyMs": 229,
      "rateLimit": null,
      "usedWeightLastMinute": null
    },
    "Kraken": {
      "requests": 1,
      "successes": 1,
      "failures": 0,
      "rateLimits": 0,
      "cooldownDeferrals": 0,
      "averageLatencyMs": 363,
      "maxLatencyMs": 363,
      "rateLimit": null,
      "usedWeightLastMinute": null
    },
    "Binance": {
      "requests": 36,
      "successes": 32,
      "failures": 4,
      "rateLimits": 0,
      "cooldownDeferrals": 0,
      "averageLatencyMs": 395,
      "maxLatencyMs": 4556,
      "rateLimit": null,
      "usedWeightLastMinute": 111
    },
    "Binance Futures": {
      "requests": 8,
      "successes": 0,
      "failures": 8,
      "rateLimits": 0,
      "cooldownDeferrals": 0,
      "averageLatencyMs": 182,
      "maxLatencyMs": 230,
      "rateLimit": null,
      "usedWeightLastMinute": null
    },
    "Kraken Futures": {
      "requests": 3,
      "successes": 3,
      "failures": 0,
      "rateLimits": 0,
      "cooldownDeferrals": 0,
      "averageLatencyMs": 292,
      "maxLatencyMs": 375,
      "rateLimit": null,
      "usedWeightLastMinute": null
    }
  },
  "quoteChecks": [
    {
      "assetId": "aave",
      "symbol": "AAVE",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "midnight-3",
      "symbol": "NIGHT",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 1
    },
    {
      "assetId": "avalanche-2",
      "symbol": "AVAX",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "origintrail",
      "symbol": "TRAC",
      "preflight": "passed",
      "respondingVenues": [
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 1
    },
    {
      "assetId": "jasmycoin",
      "symbol": "JASMY",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "the-sandbox",
      "symbol": "SAND",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "binancecoin",
      "symbol": "BNB",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "syrup",
      "symbol": "SYRUP",
      "preflight": "passed",
      "respondingVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedExecutableVenues": [
        "Binance",
        "Coinbase",
        "Kraken"
      ],
      "timestampedVenueThresholdMet": true,
      "krakenWebsocketTimestampObserved": true,
      "krakenWebsocketFirstArrivalMs": 2514,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 0
    },
    {
      "assetId": "the-open-network",
      "symbol": "GRAM",
      "preflight": "rejected",
      "respondingVenues": [
        "Binance"
      ],
      "timestampedExecutableVenues": [
        "Binance"
      ],
      "timestampedVenueThresholdMet": false,
      "krakenWebsocketTimestampObserved": false,
      "krakenWebsocketFirstArrivalMs": null,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 2
    },
    {
      "assetId": "cash-cat",
      "symbol": "CASHCAT",
      "preflight": "rejected",
      "respondingVenues": [],
      "timestampedExecutableVenues": [],
      "timestampedVenueThresholdMet": false,
      "krakenWebsocketTimestampObserved": false,
      "krakenWebsocketFirstArrivalMs": null,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 3
    },
    {
      "assetId": "iota",
      "symbol": "IOTA",
      "preflight": "rejected",
      "respondingVenues": [
        "Binance"
      ],
      "timestampedExecutableVenues": [
        "Binance"
      ],
      "timestampedVenueThresholdMet": false,
      "krakenWebsocketTimestampObserved": false,
      "krakenWebsocketFirstArrivalMs": null,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 2
    },
    {
      "assetId": "unibase",
      "symbol": "UB",
      "preflight": "rejected",
      "respondingVenues": [],
      "timestampedExecutableVenues": [],
      "timestampedVenueThresholdMet": false,
      "krakenWebsocketTimestampObserved": false,
      "krakenWebsocketFirstArrivalMs": null,
      "sourceIdentity": "ticker_only_unverified",
      "quoteRejections": {},
      "providerErrorCount": 3
    }
  ],
  "deepAnalysis": {
    "status": "public_diagnostic_only",
    "analyzed": 8,
    "marketRegime": "risk_on",
    "strictScreenCandidates": 0,
    "validationAdvisoryOnlyCandidates": 1,
    "multiGateRejectionCodes": {
      "execution_cost": 3,
      "minimum_score": 7,
      "strategy_validation": 7,
      "trend_continuation": 3
    },
    "validationFailureCounts": {
      "nonpositive_recent_expectancy": 6,
      "nonpositive_overall_expectancy": 6,
      "recent_profit_factor_not_above_one": 6,
      "overall_profit_factor_not_above_one": 6,
      "incomplete_historical_candle_path": 1,
      "insufficient_historical_sample": 1,
      "missing_recent_expectancy": 1,
      "missing_overall_expectancy": 1,
      "missing_recent_profit_factor": 1,
      "missing_overall_profit_factor": 1
    },
    "providerErrorCount": 19,
    "providerErrorCategories": {
      "Binance": 1,
      "Binance Futures": 8,
      "Coinbase": 1,
      "Deribit": 8,
      "Kraken Futures": 1
    },
    "assets": [
      {
        "assetId": "aave",
        "symbol": "AAVE",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "AAVEUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 33.68476555137562,
        "executionStressedRoundTripBps": 54.21191387843904,
        "executionSpreadBps": 4.11534730591688,
        "executionOneWaySlippageBps": 6.842382775687808,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 11,
        "strategyValidationOverallTrades": 28,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 2
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.0651168200458378,
        "strategyValidationOverallExpectancyR": -0.2338230489133919,
        "strategyValidationRecentProfitFactor": 0.8492719194036797,
        "strategyValidationOverallProfitFactor": 0.5818291258302656,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": true,
        "strictRejectionCodes": [
          "strategy_validation"
        ],
        "executionBlocked": false,
        "dataConflict": false
      },
      {
        "assetId": "midnight-3",
        "symbol": "NIGHT",
        "exchangeProviderCount": 2,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "NIGHTUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 35.8222252448185,
        "executionStressedRoundTripBps": 59.55556311204624,
        "executionSpreadBps": 2.5759921414313216,
        "executionOneWaySlippageBps": 7.911112622409247,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 20,
        "strategyValidationOverallTrades": 50,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 3
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": 0.0021280645457368184,
        "strategyValidationOverallExpectancyR": 0.02375421825255519,
        "strategyValidationRecentProfitFactor": 1.004404648938739,
        "strategyValidationOverallProfitFactor": 1.0534820403379226,
        "strategyValidationFailureReasons": [],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "trend_continuation"
        ],
        "executionBlocked": false,
        "dataConflict": false
      },
      {
        "assetId": "avalanche-2",
        "symbol": "AVAX",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "AVAXUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 27.05684854965292,
        "executionStressedRoundTripBps": 37.642121374132294,
        "executionSpreadBps": 1.8261504747981112,
        "executionOneWaySlippageBps": 3.528424274826459,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 6,
        "strategyValidationOverallTrades": 29,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 3
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.8340920928871739,
        "strategyValidationOverallExpectancyR": -0.42416605937604246,
        "strategyValidationRecentProfitFactor": 0.052586218611122885,
        "strategyValidationOverallProfitFactor": 0.40379141363403437,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "strategy_validation"
        ],
        "executionBlocked": false,
        "dataConflict": false
      },
      {
        "assetId": "origintrail",
        "symbol": "TRAC",
        "exchangeProviderCount": 2,
        "candleCount": 299,
        "candleProvider": "Coinbase",
        "candlePair": "TRAC-USD",
        "candleCoverage": {
          "candleCount": 299,
          "firstOpenAt": "2026-09-28T16:30:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 9,
          "irregularTransitions": 8,
          "largestGapMs": 2700000,
          "contiguous": false
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 133.84776843671804,
        "executionStressedRoundTripBps": 304.6194210917951,
        "executionSpreadBps": 52.87218061531682,
        "executionOneWaySlippageBps": 56.92388421835902,
        "strategyValidationSufficient": false,
        "strategyValidationRecentTrades": 0,
        "strategyValidationOverallTrades": 0,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 2,
            "signalDays": 0
          },
          "recent": {
            "candleDays": 2,
            "signalDays": 0
          },
          "overall": {
            "candleDays": 3,
            "signalDays": 0
          }
        },
        "strategyValidationRecentExpectancyR": null,
        "strategyValidationOverallExpectancyR": null,
        "strategyValidationRecentProfitFactor": null,
        "strategyValidationOverallProfitFactor": null,
        "strategyValidationFailureReasons": [
          "incomplete_historical_candle_path",
          "insufficient_historical_sample",
          "missing_recent_expectancy",
          "missing_overall_expectancy",
          "missing_recent_profit_factor",
          "missing_overall_profit_factor"
        ],
        "derivativesAvailable": false,
        "derivativesProviderCount": 0,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "execution_cost",
          "strategy_validation"
        ],
        "executionBlocked": true,
        "dataConflict": false
      },
      {
        "assetId": "jasmycoin",
        "symbol": "JASMY",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "JASMYUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 99.08536390180556,
        "executionStressedRoundTripBps": 217.71340975451392,
        "executionSpreadBps": 35.33568904593648,
        "executionOneWaySlippageBps": 39.54268195090278,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 8,
        "strategyValidationOverallTrades": 41,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 3
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.1707225828810841,
        "strategyValidationOverallExpectancyR": -0.2653071628817516,
        "strategyValidationRecentProfitFactor": 0.7042012943939111,
        "strategyValidationOverallProfitFactor": 0.5635847461628409,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "execution_cost",
          "strategy_validation",
          "trend_continuation"
        ],
        "executionBlocked": true,
        "dataConflict": false
      },
      {
        "assetId": "the-sandbox",
        "symbol": "SAND",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "SANDUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 114.3142399807793,
        "executionStressedRoundTripBps": 255.78559995194826,
        "executionSpreadBps": 45.04504504504477,
        "executionOneWaySlippageBps": 47.15711999038965,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 14,
        "strategyValidationOverallTrades": 35,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 3
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.04299281638043192,
        "strategyValidationOverallExpectancyR": -0.19959329969152212,
        "strategyValidationRecentProfitFactor": 0.8985770136656102,
        "strategyValidationOverallProfitFactor": 0.6355155764549304,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "execution_cost",
          "strategy_validation"
        ],
        "executionBlocked": true,
        "dataConflict": false
      },
      {
        "assetId": "binancecoin",
        "symbol": "BNB",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "BNBUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 21.54349478039306,
        "executionStressedRoundTripBps": 23.858736950982657,
        "executionSpreadBps": 0.1299350974187211,
        "executionOneWaySlippageBps": 0.7717473901965313,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 9,
        "strategyValidationOverallTrades": 21,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 3
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.3822281103156572,
        "strategyValidationOverallExpectancyR": -0.46780191956088174,
        "strategyValidationRecentProfitFactor": 0.35110722171162295,
        "strategyValidationOverallProfitFactor": 0.21337755121498486,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "strategy_validation"
        ],
        "executionBlocked": false,
        "dataConflict": false
      },
      {
        "assetId": "syrup",
        "symbol": "SYRUP",
        "exchangeProviderCount": 3,
        "candleCount": 599,
        "candleProvider": "Binance",
        "candlePair": "SYRUPUSDT",
        "candleCoverage": {
          "candleCount": 599,
          "firstOpenAt": "2026-09-25T15:45:00.000Z",
          "lastCompletedAt": "2026-10-01T21:30:00.000Z",
          "missingIntervals": 0,
          "irregularTransitions": 0,
          "largestGapMs": 900000,
          "contiguous": true
        },
        "technicalDataSufficient": true,
        "strategyValidationCostRoundTripBps": 20,
        "executionEstimatedRoundTripBps": 51.125897331564914,
        "executionStressedRoundTripBps": 97.81474332891229,
        "executionSpreadBps": 12.634238787112853,
        "executionOneWaySlippageBps": 15.562948665782457,
        "strategyValidationSufficient": true,
        "strategyValidationRecentTrades": 11,
        "strategyValidationOverallTrades": 31,
        "strategyValidationCoverage": {
          "earlier": {
            "candleDays": 4,
            "signalDays": 4
          },
          "recent": {
            "candleDays": 3,
            "signalDays": 2
          },
          "overall": {
            "candleDays": 6,
            "signalDays": 6
          }
        },
        "strategyValidationRecentExpectancyR": -0.3736010871413988,
        "strategyValidationOverallExpectancyR": -0.128817834456024,
        "strategyValidationRecentProfitFactor": 0.49853683578586316,
        "strategyValidationOverallProfitFactor": 0.774514797376273,
        "strategyValidationFailureReasons": [
          "nonpositive_recent_expectancy",
          "nonpositive_overall_expectancy",
          "recent_profit_factor_not_above_one",
          "overall_profit_factor_not_above_one"
        ],
        "derivativesAvailable": true,
        "derivativesProviderCount": 1,
        "strictScreenQualified": false,
        "validationAdvisoryQualified": false,
        "strictRejectionCodes": [
          "minimum_score",
          "strategy_validation",
          "trend_continuation"
        ],
        "executionBlocked": false,
        "dataConflict": false
      }
    ],
    "interpretation": "The existing strict technical/validation screen only. Manual catalysts, learned model, portfolio guard, shared risk, Discord delivery and paper outcomes were not evaluated. Multi-gate counts overlap."
  },
  "limitations": [
    "Ticker-only exchange matching can confuse assets with the same symbol; paid coin-ID pair verification is not exercised.",
    "Kraken REST ticker receipt time is not a trusted market-observation timestamp. This probe separately attempts bounded source-timestamped WebSocket quotes.",
    "The excluded sample is capped at four and does not establish directory recall or market-wide opportunity coverage.",
    "A quote confirmation is not a strategy approval, executable fill, or evidence of positive expectancy.",
    "The optional deep analysis lacks the worker’s manual catalysts, learned model, portfolio state, shared risk and delivery gates; it is not a full production scan.",
    "Opt-in research capture is an isolated ticker-only public cohort with source-pinned candle outcomes and modeled costs; it cannot train the production model or establish executable fills."
  ],
  "historyJournal": "data/public-funnel-probe/probe-history.ndjson"
}
```
