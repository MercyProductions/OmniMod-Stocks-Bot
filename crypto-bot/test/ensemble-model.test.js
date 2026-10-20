import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../src/technicalAnalysis.js';
import { aggregateProviderQuotes } from '../src/marketProviders.js';
import { validateStrategy } from '../src/backtest.js';
import { assessStrategyValidation, classifyDiscoveryTimestamp, scoreAsset, screenMomentum, screenMomentumDetailed } from '../src/cryptoData.js';
import {
  buildPrediction, calibrateProbability, evaluatePrediction, summarizePerformance
} from '../src/predictionEngine.js';

function candleSeries(count = 500, drift = 0.0007) {
  const rows = [];
  let previous = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = Math.sin(index / 8) * 0.00015;
    const close = previous * (1 + drift + cycle);
    rows.push({
      time: 1_700_000_000_000 + index * 900_000,
      open: previous, high: Math.max(previous, close) * 1.003, low: Math.min(previous, close) * 0.997,
      close, volume: 1_000_000 * (1 + Math.max(0, Math.sin(index / 5)))
    });
    previous = close;
  }
  return rows;
}

function enrichedAsset(overrides = {}) {
  const candles = candleSeries();
  const technicals = analyzeCandles(candles);
  const row = {
    id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, price: candles.at(-1).close,
    marketCap: 1_000_000_000_000, volume24h: 25_000_000_000, high24h: candles.at(-1).close * 1.02,
    low24h: candles.at(-1).close * 0.96, athChangePercent: -15, change1h: 0.8, change24h: 3.2,
    change7d: 8, change30d: 14, volumeToMarketCap: 0.025,
    marketData: {
      providerCount: 3, exchangeProviderCount: 3, providers: ['Binance', 'Coinbase', 'Kraken'],
      coverageScore: 92, priceDispersionPct: 0.08, medianSpreadPct: 0.04, conflicted: false,
      technicals, orderBook: { available: true, imbalance: 0.18 },
      regime: { key: 'risk_on', label: 'Risk-on', score: 78, allowNewLongs: true },
      validation: {
        sufficient: true, recent: { trades: 8, expectancyR: 0.22, profitFactor: 1.5 },
        overall: { trades: 22, expectancyR: 0.18, profitFactor: 1.4 }, warning: ''
      }
    },
    ...overrides
  };
  return { ...row, model: scoreAsset(row) };
}

test('strategy-validation diagnostics identify sample and after-cost gates without changing approval', () => {
  const favorable = { sufficient: true,
    recent: { trades: 8, expectancyR: 0.12, profitFactor: 1.3 },
    overall: { trades: 20, expectancyR: 0.08, profitFactor: 1.2 } };
  assert.deepEqual(assessStrategyValidation(favorable).reasons, []);
  assert.equal(assessStrategyValidation(favorable).passed, true);
  const insufficient = { ...favorable, sufficient: false };
  assert.deepEqual(assessStrategyValidation(insufficient).reasons, ['insufficient_historical_sample']);
  const noObservedTrades = { sufficient: false,
    recent: { trades: 0, expectancyR: 0, profitFactor: 0 },
    overall: { trades: 0, expectancyR: 0, profitFactor: 0 } };
  assert.deepEqual(assessStrategyValidation(noObservedTrades).reasons, [
    'insufficient_historical_sample', 'missing_recent_expectancy', 'missing_overall_expectancy',
    'missing_recent_profit_factor', 'missing_overall_profit_factor'
  ]);
  const observedLoss = { sufficient: false,
    recent: { trades: 1, expectancyR: -1, profitFactor: 0 },
    overall: { trades: 1, expectancyR: -1, profitFactor: 0 } };
  assert.deepEqual(assessStrategyValidation(observedLoss).reasons, [
    'insufficient_historical_sample', 'nonpositive_recent_expectancy', 'nonpositive_overall_expectancy',
    'recent_profit_factor_not_above_one', 'overall_profit_factor_not_above_one'
  ]);
  const weak = { ...favorable, overall: { trades: 20, expectancyR: -0.1, profitFactor: 0.8 } };
  assert.deepEqual(assessStrategyValidation(weak).reasons,
    ['nonpositive_overall_expectancy', 'overall_profit_factor_not_above_one']);
  const row = enrichedAsset();
  row.marketData.validation = weak;
  const scored = scoreAsset(row);
  assert.equal(scored.validationPassed, false);
  assert.deepEqual(scored.validationFailureReasons, assessStrategyValidation(weak).reasons);
  assert.deepEqual(assessStrategyValidation(null).reasons, [
    'insufficient_historical_sample', 'missing_recent_expectancy', 'missing_overall_expectancy',
    'missing_recent_profit_factor', 'missing_overall_profit_factor'
  ]);
});

test('candle ensemble distinguishes constructive and deteriorating trends', () => {
  const constructive = analyzeCandles(candleSeries(300, 0.0008));
  const deteriorating = analyzeCandles(candleSeries(300, -0.0012));
  assert.equal(constructive.dataSufficient, true);
  assert.ok(constructive.ema9 > constructive.ema21);
  assert.ok(constructive.technicalScore > deteriorating.technicalScore);
  assert.ok(constructive.atrPct > 0);
});

test('provider consensus uses a robust median and exposes disagreement', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const agreed = aggregateProviderQuotes([
    { provider: 'Binance', price: 100.1, bid: 100.05, ask: 100.15, observedAt: new Date(now).toISOString() },
    { provider: 'Coinbase', price: 99.9, bid: 99.85, ask: 99.95, observedAt: new Date(now).toISOString() },
    { provider: 'Kraken', price: 100, bid: 99.95, ask: 100.05, observedAt: new Date(now).toISOString() }
  ], 100, { now });
  assert.equal(agreed.providerCount, 3);
  assert.equal(agreed.exchangeProviderCount, 3);
  assert.equal(agreed.referenceQuote.timestampTrust, 'snapshot_reference_only');
  assert.equal(agreed.referenceQuote.executable, false);
  assert.equal(agreed.consensusPrice, 100);
  assert.equal(agreed.conflicted, false);

  const conflict = aggregateProviderQuotes([
    { provider: 'Binance', price: 100, bid: 99.9, ask: 100.1, observedAt: new Date(now).toISOString() },
    { provider: 'Coinbase', price: 103, bid: 102.9, ask: 103.1, observedAt: new Date(now).toISOString() }
  ], 100, { now });
  assert.equal(conflict.conflicted, true);
  assert.ok(conflict.coverageScore < agreed.coverageScore);
});

test('an untimestamped snapshot plus one exchange cannot pass the two-provider paper gate', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const quotes = aggregateProviderQuotes([
    { provider: 'Binance', price: 100, bid: 99.99, ask: 100.01, observedAt: new Date(now).toISOString() },
  ], 500, { now });
  const asset = enrichedAsset();
  asset.marketData = { ...asset.marketData, ...quotes };
  asset.model = scoreAsset(asset);
  const prediction = buildPrediction(asset, { minProviderConfirmations: 2 }, 'guild', new Date(now), 'UTC');
  assert.equal(asset.model.providerCount, 1);
  assert.equal(asset.model.exchangeProviderCount, 1);
  assert.ok(prediction.approvalRejections.includes('provider_confirmation'));
});

test('confirmed screening rejects provider conflict and negative recent validation', () => {
  const good = enrichedAsset();
  const conflictedBase = enrichedAsset({ id: 'conflict', symbol: 'CON' });
  conflictedBase.marketData = { ...conflictedBase.marketData, conflicted: true };
  const negativeBase = enrichedAsset({ id: 'negative', symbol: 'NEG' });
  negativeBase.marketData = {
    ...negativeBase.marketData,
    validation: {
      sufficient: true, recent: { trades: 8, expectancyR: -0.3, profitFactor: 0.6 },
      overall: { trades: 20, expectancyR: -0.1, profitFactor: 0.8 }, warning: 'negative'
    }
  };
  const insufficientBase = enrichedAsset({ id: 'insufficient', symbol: 'INS' });
  insufficientBase.marketData = {
    ...insufficientBase.marketData,
    validation: { sufficient: false, recent: { trades: 2, expectancyR: 0.5, profitFactor: 2 }, overall: { trades: 4, expectancyR: 0.4, profitFactor: 2 }, warning: 'small sample' }
  };
  const rows = screenMomentum({ assets: [good, conflictedBase, negativeBase, insufficientBase] }, {
    maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2
  }, { requireConfirmation: true });
  assert.deepEqual(rows.map((row) => row.id), ['bitcoin']);
});

test('keyed Pro and Demo identity shortfalls have their own first-failure reason', () => {
  const proAsset = enrichedAsset({ id: 'pro-asset', symbol: 'PRO' });
  proAsset.marketData = { ...proAsset.marketData, assetIdentity: {
    mode: 'coingecko_pro', status: 'pro_verified_pair_allowlist', verifiedVenueCount: 1
  } };
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2 };
  const pro = screenMomentumDetailed({ assets: [proAsset] }, settings, { requireConfirmation: true });
  assert.deepEqual(pro.rejections, [
    { symbol: 'PRO', assetId: 'pro-asset', stage: 'model_approval', code: 'coin_id_pair_verification' }
  ]);

  const demoAsset = enrichedAsset({ id: 'demo-asset', symbol: 'DEMO' });
  demoAsset.marketData = { ...demoAsset.marketData, assetIdentity: {
    mode: 'coingecko_demo', status: 'demo_verified_pair_allowlist', verifiedVenueCount: 1
  } };
  const demo = screenMomentumDetailed({ assets: [demoAsset] }, settings, { requireConfirmation: true });
  assert.deepEqual(demo.rejections, [
    { symbol: 'DEMO', assetId: 'demo-asset', stage: 'model_approval', code: 'coin_id_pair_verification' }
  ]);

  const freeAsset = enrichedAsset({ id: 'free-asset', symbol: 'FREE' });
  freeAsset.marketData = { ...freeAsset.marketData, assetIdentity: {
    mode: 'ticker_only_demo', status: 'ticker_only_unverified', verifiedVenueCount: null
  } };
  const free = screenMomentumDetailed({ assets: [freeAsset] }, settings, { requireConfirmation: true });
  assert.deepEqual(free.candidates.map((row) => row.id), ['free-asset']);
});

test('full confirmation audit reports every failed gate without changing candidate eligibility', () => {
  const blocked = enrichedAsset({ id: 'blocked', symbol: 'BLOCK', change1h: -10, change24h: -25, change7d: -60 });
  blocked.marketData = {
    ...blocked.marketData,
    providerCount: 0,
    exchangeProviderCount: 0,
    technicallyConfirmed: false,
    conflicted: true,
    technicals: { dataSufficient: false, return1h: -1, ema9: 1, ema21: 2 },
    regime: { key: 'risk_off', score: 20, allowNewLongs: false },
    derivatives: { available: true, blockLongs: true },
    execution: { blockTrade: true },
    eventRisk: { blocked: true },
    validation: { sufficient: false, recent: { trades: 0 }, overall: { trades: 0 } }
  };
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 95, minProviderConfirmations: 2 };
  const ordinary = screenMomentumDetailed({ assets: [blocked] }, settings, { requireConfirmation: true });
  const audited = screenMomentumDetailed({ assets: [blocked] }, settings,
    { requireConfirmation: true, collectAllRejections: true });

  assert.deepEqual(ordinary.candidates, []);
  assert.deepEqual(ordinary.rejections.map((row) => row.code), ['minimum_score']);
  assert.deepEqual(audited.candidates, []);
  assert.deepEqual(audited.rejections.map((row) => row.code), [
    'minimum_score', 'technical_data', 'provider_confirmation', 'provider_conflict',
    'market_regime', 'derivatives_crowding', 'execution_cost', 'event_veto',
    'strategy_validation', 'trend_continuation'
  ]);
});

test('validation-advisory screening bypasses only the historical strategy-validation gate', () => {
  const insufficient = enrichedAsset({ id: 'insufficient', symbol: 'INS' });
  insufficient.marketData = { ...insufficient.marketData,
    validation: { sufficient: false, recent: { trades: 2, expectancyR: 0.5, profitFactor: 2 },
      overall: { trades: 4, expectancyR: 0.4, profitFactor: 2 }, warning: 'small sample' } };
  const conflicted = enrichedAsset({ id: 'conflicted', symbol: 'BAD' });
  conflicted.marketData = { ...conflicted.marketData, conflicted: true };
  const eventBlocked = enrichedAsset({ id: 'event', symbol: 'EVT' });
  eventBlocked.marketData = { ...eventBlocked.marketData, eventRisk: { blocked: true } };
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2 };
  const strict = screenMomentumDetailed({ assets: [insufficient, conflicted, eventBlocked] }, settings, { requireConfirmation: true });
  const advisory = screenMomentumDetailed({ assets: [insufficient, conflicted, eventBlocked] }, settings,
    { requireConfirmation: true, validationAdvisory: true });
  assert.deepEqual(strict.candidates, []);
  assert.deepEqual(advisory.candidates.map((row) => row.id), ['insufficient']);
  assert.deepEqual(advisory.rejections, [
    { symbol: 'BAD', assetId: 'conflicted', stage: 'model_approval', code: 'provider_conflict' },
    { symbol: 'EVT', assetId: 'event', stage: 'model_approval', code: 'event_veto' }
  ]);
});

test('detailed screening preserves existing candidates and emits symbol-level first rejection reasons', () => {
  const good = enrichedAsset();
  const rankRejected = enrichedAsset({ id: 'rank-rejected', symbol: 'RANK', rank: 999 });
  const liquidityRejected = enrichedAsset({ id: 'liquidity-rejected', symbol: 'DRY', volume24h: 0, volumeToMarketCap: 0 });
  const snapshot = { assets: [good, rankRejected, liquidityRejected] };
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2 };
  const detailed = screenMomentumDetailed(snapshot, settings);
  assert.deepEqual(detailed.candidates.map((row) => row.id), screenMomentum(snapshot, settings).map((row) => row.id));
  assert.deepEqual(detailed.rejections, [
    { symbol: 'RANK', assetId: 'rank-rejected', stage: 'candidate_filter', code: 'market_rank' },
    { symbol: 'DRY', assetId: 'liquidity-rejected', stage: 'candidate_filter', code: 'liquidity' }
  ]);
  assert.equal(detailed.stageCounts.universe, 3);
  assert.equal(detailed.stageCounts.trendPassed, 1);
});

test('duplicate provider tickers across distinct crypto assets are rejected before deep analysis', () => {
  const first = enrichedAsset({ id: 'asset-alpha', symbol: 'DUP', name: 'Alpha' });
  const second = enrichedAsset({ id: 'asset-beta', symbol: ' dup ', name: 'Beta', rank: 2 });
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2 };
  const result = screenMomentumDetailed({ assets: [first, second] }, settings);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.rejections, [
    { symbol: 'DUP', assetId: 'asset-alpha', stage: 'data_identity', code: 'duplicate_provider_symbol' },
    { symbol: 'DUP', assetId: 'asset-beta', stage: 'data_identity', code: 'duplicate_provider_symbol' }
  ]);
  assert.equal(result.stageCounts.identityRejected, 2);
});

test('discovery rejects and attributes malformed rows without silently losing them from the universe funnel', () => {
  const malformed = enrichedAsset({ id: 'asset-without-symbol', symbol: '   ' });
  const result = screenMomentumDetailed({ assets: [malformed] }, {
    maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2,
  });
  assert.equal(result.stageCounts.universe, 1);
  assert.equal(result.stageCounts.identityRejected, 1);
  assert.deepEqual(result.rejections, [
    { symbol: '', assetId: 'asset-without-symbol', stage: 'data_identity', code: 'missing_asset_symbol' },
  ]);
});

test('synthetic Crypto discovery funnel reconciles every universe row through its first terminal gate', () => {
  const now = Date.parse('2026-09-30T15:00:00.000Z');
  const at = (overrides = {}) => enrichedAsset({ lastUpdated: new Date(now).toISOString(), ...overrides });
  const base = at();
  const scoreReject = at({ id: 'low-score', symbol: 'LOW', change1h: -10, change24h: -25, change7d: -60,
    athChangePercent: -99, volumeToMarketCap: 0.004, high24h: base.price, low24h: base.price,
    marketData: { ...base.marketData, technicals: { dataSufficient: false } } });
  const trendReject = at({ id: 'weak-trend', symbol: 'WEAK', marketData: { ...base.marketData,
    technicals: { ...base.marketData.technicals, return1h: -1, ema9: 100, ema21: 101 } } });
  const assets = [
    at(), at({ id: 'stable', symbol: 'USDT' }),
    at({ id: 'missing-symbol', symbol: ' ' }),
    at({ id: 'duplicate-one', symbol: 'DUP' }), at({ id: 'duplicate-two', symbol: 'dup', rank: 2 }),
    at({ id: 'stale', symbol: 'OLD', lastUpdated: new Date(now - 60 * 60_000).toISOString() }),
    at({ id: 'rank', symbol: 'RANK', rank: 999 }),
    at({ id: 'liquidity', symbol: 'DRY', volume24h: 0, volumeToMarketCap: 0 }),
    scoreReject, trendReject,
  ];
  const result = screenMomentumDetailed({ assets }, { maxMarketRank: 250, minVolumeUsd: 5_000_000,
    minScore: 50, minProviderConfirmations: 2 }, { requireDiscoveryTimestamp: true, now, maxDiscoveryQuoteAgeMs: 30 * 60_000 });
  const count = (stage, code) => result.rejections.filter((row) => row.stage === stage && row.code === code).length;
  const counts = result.stageCounts;
  assert.equal(counts.universe, 10);
  assert.equal(counts.nonStable + count('discovery', 'stable_asset'), counts.universe);
  assert.equal(counts.nonStable, counts.identityRejected + counts.freshnessPassed + counts.freshnessUnknown + counts.freshnessRejected);
  assert.equal(counts.freshnessPassed + counts.freshnessUnknown, counts.rankPassed + count('candidate_filter', 'market_rank'));
  assert.equal(counts.rankPassed, counts.liquidityPassed + count('candidate_filter', 'liquidity'));
  assert.equal(counts.liquidityPassed, counts.scorePassed + count('candidate_filter', 'minimum_score'));
  assert.equal(counts.scorePassed, counts.trendPassed + count('candidate_filter', 'trend_continuation'));
  assert.equal(result.candidates.length, counts.trendPassed);
  assert.equal(result.rejections.length + result.candidates.length, counts.universe);
});

test('discovery timestamps classify freshness without treating missing timestamps as fresh', () => {
  const now = Date.parse('2026-09-29T15:00:00.000Z');
  assert.equal(classifyDiscoveryTimestamp('2026-09-29T14:45:00.000Z', now, 30 * 60_000).state, 'fresh');
  assert.equal(classifyDiscoveryTimestamp('2026-09-29T14:00:00.000Z', now, 30 * 60_000).state, 'stale');
  assert.equal(classifyDiscoveryTimestamp('2026-09-29T15:02:00.000Z', now, 30 * 60_000).state, 'future');
  assert.equal(classifyDiscoveryTimestamp('', now, 30 * 60_000).state, 'unknown');
  assert.equal(classifyDiscoveryTimestamp('not-a-timestamp', now, 30 * 60_000).state, 'invalid');
});

test('production discovery freshness rejects stale snapshots and stale or absent asset timestamps', () => {
  const now = Date.parse('2026-09-29T15:00:00.000Z');
  const fresh = enrichedAsset({ lastUpdated: '2026-09-29T14:45:00.000Z' });
  const stale = enrichedAsset({ id: 'stale', symbol: 'OLD', lastUpdated: '2026-09-29T14:00:00.000Z' });
  const missing = enrichedAsset({ id: 'missing', symbol: 'MISS', lastUpdated: '' });
  const settings = { maxMarketRank: 250, minVolumeUsd: 5_000_000, minScore: 50, minProviderConfirmations: 2 };
  const screen = screenMomentumDetailed({ assets: [fresh, stale, missing] }, settings,
    { requireDiscoveryTimestamp: true, now, maxDiscoveryQuoteAgeMs: 30 * 60_000 });
  assert.deepEqual(screen.candidates.map((row) => row.id), ['bitcoin']);
  assert.deepEqual(screen.rejections, [
    { symbol: 'OLD', assetId: 'stale', stage: 'data_freshness', code: 'provider_timestamp_stale' },
    { symbol: 'MISS', assetId: 'missing', stage: 'data_freshness', code: 'provider_timestamp_missing' }
  ]);
  assert.equal(screen.stageCounts.freshnessPassed, 1);
  assert.equal(screen.stageCounts.freshnessRejected, 2);

  const cached = screenMomentumDetailed({ assets: [fresh] }, settings,
    { requireDiscoveryTimestamp: true, staleSnapshot: true, now, maxDiscoveryQuoteAgeMs: 30 * 60_000 });
  assert.deepEqual(cached.candidates, []);
  assert.deepEqual(cached.rejections, [
    { symbol: 'BTC', assetId: 'bitcoin', stage: 'data_freshness', code: 'stale_market_snapshot' }
  ]);
});

test('probability calibration moves with comparable realized outcomes', () => {
  const positive = Array.from({ length: 40 }, (_, index) => ({ accountingVersion: 2, completedAt: new Date(Date.UTC(2026, 0, 1 + index % 5)).toISOString(), score: 76 + index % 3, status: 'target_hit', realizedR: 0.6 }));
  const negative = Array.from({ length: 40 }, (_, index) => ({ accountingVersion: 2, completedAt: new Date(Date.UTC(2026, 0, 1 + index % 5)).toISOString(), score: 76 + index % 3, status: 'loss', realizedR: -1 }));
  const good = calibrateProbability(77, positive);
  const bad = calibrateProbability(77, negative);
  assert.ok(good.probability > bad.probability);
  assert.equal(good.evidenceMature, true);
  assert.equal(good.method, 'historical score-band estimate; minimum sample met, independent calibration unverified');
  assert.ok(good.lowerBound < good.probability);
  assert.equal(good.calibrationDayCount, 5);
});

test('clustered same-day outcomes do not qualify as empirical probability evidence', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({ accountingVersion: 2, completedAt: '2026-01-01T00:00:00Z', score: 76 + index % 3, status: 'target_hit', realizedR: 0.6 }));
  const result = calibrateProbability(77, history);
  assert.equal(result.sampleSize, 40);
  assert.equal(result.calibrationDayCount, 1);
  assert.equal(result.lowerBound, null);
  assert.equal(result.method, 'score-derived prior; collecting comparable outcomes');
});

test('positive-net calibration follows after-cost realized R rather than target-status labels', () => {
  const context = { asOf: '2026-09-24T16:00:00Z', horizonKey: 'scalp', assetClass: 'large', regimeKey: 'risk_on' };
  const history = [
    { accountingVersion: 2, completedAt: '2026-09-24T15:00:00Z', score: 77, horizonKey: 'scalp', assetClass: 'large', regimeKey: 'risk_on', status: 'fell_short', realizedR: 0.2 },
    { accountingVersion: 2, completedAt: '2026-09-24T15:00:00Z', score: 77, horizonKey: 'scalp', assetClass: 'large', regimeKey: 'risk_on', status: 'target_hit', realizedR: -0.1 },
    { accountingVersion: 2, completedAt: '2026-09-24T15:00:00Z', score: 77, horizonKey: 'scalp', assetClass: 'large', regimeKey: 'risk_on', status: 'unverified', realizedR: 3 },
    { accountingVersion: 2, completedAt: '2026-09-24T15:00:00Z', score: 77, horizonKey: 'scalp', assetClass: 'large', regimeKey: 'risk_on', status: 'target_hit', realizedR: null }
  ];
  const result = calibrateProbability(77, history, context);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.wins, 1);
});

test('first target banks paper profit and protects the remainder at break-even', () => {
  const asset = enrichedAsset();
  const settings = {
    minRiskReward: 1.7, estimatedRoundTripBps: 20, accountRiskPct: 0.5,
    minProviderConfirmations: 2, monitorMinutes: 5
  };
  const prediction = buildPrediction(asset, settings, 'guild', new Date('2026-08-03T12:00:00Z'));
  let result = evaluatePrediction(
    prediction, { ...asset, price: prediction.partialTargetPrice * 1.001 }, new Date('2026-08-03T12:15:00Z')
  );
  assert.equal(result.events[0].type, 'partial_profit');
  assert.equal(result.prediction.effectiveStopPrice, prediction.entryPrice);

  result = evaluatePrediction(
    result.prediction, { ...asset, price: prediction.entryPrice * 0.999 }, new Date('2026-08-03T12:30:00Z')
  );
  assert.equal(result.prediction.status, 'target_hit');
  assert.equal(result.events[0].type, 'protected_exit');
  assert.ok(result.prediction.realizedR > 0);
});

test('walk-forward validation is chronological and returns risk metrics', () => {
  const validation = validateStrategy(candleSeries(600, 0.0005), {
    minimumScore: 55, rewardRisk: 1.7, roundTripFeeBps: 20
  });
  assert.equal(validation.candleCount, 600);
  assert.ok(validation.overall.trades >= validation.recent.trades);
  assert.ok(Number.isFinite(validation.overall.expectancyR));
  assert.ok(validation.overall.maxDrawdownR >= 0);
});

test('performance reports expectancy, profit factor, net R, and drawdown', () => {
  const summary = summarizePerformance([
    { status: 'target_hit', realizedR: 0.7 }, { status: 'exceeded', realizedR: 1.4 },
    { status: 'loss', realizedR: -1 }, { status: 'tracking' }
  ]);
  assert.equal(summary.closed, 3);
  assert.ok(summary.expectancyR > 0);
  assert.ok(Math.abs(summary.netR - 1.1) < 1e-9);
  assert.ok(summary.profitFactor > 1);
});
