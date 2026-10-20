import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBacktestCostModel, walkForwardBacktest, validateStrategy } from '../src/backtest.js';
import { assessStrategyValidation, scoreAsset } from '../src/cryptoData.js';
import { buildPrediction, evaluatePrediction } from '../src/predictionEngine.js';
import { aggregateProviderQuotes, fetchHistoricalCandles, fetchProviderQuotes, screenSpotPairCoverage, summarizeCandleCoverage, verifiedCoinGeckoTickerPairs } from '../src/marketProviders.js';
import { withProviderTelemetry } from '../src/providerTelemetry.js';
import { inspectSourcePinnedEntryBar, normalizeLabeledObservations, resolveObservation, selectObservationCandles,
  RESEARCH_ENTRY_EVIDENCE_VERSION, selectSourcePinnedEntryQuote } from '../src/researchStore.js';
import { validateWorkerConfiguration } from '../src/workerConfiguration.js';
import { analyzeCandles, normalizeCandles } from '../src/technicalAnalysis.js';
import { chronologicalSplit } from '../src/metaModel.js';
import { FEATURE_SCHEMA_VERSION } from '../src/modelFeatures.js';
import { buildSourcePinnedShadowPrediction } from '../src/shadowEntryEvidence.js';

function candles(count = 500) {
  let previous = 100;
  return Array.from({ length: count }, (_, index) => {
    const open = previous;
    previous *= 1 + .0004 + Math.sin(index / 3) * .002;
    return { time: 1700000000000 + index * 900000, open, close: previous,
      high: Math.max(open, previous) * 1.003, low: Math.min(open, previous) * .997, volume: 1000 };
  });
}
const sample = { id: 'btc', symbol: 'BTC', name: 'Bitcoin', price: 100,
  model: { score: 75, risk: 'High', trend: 'Rising', validationPassed: true } };

test('earlier holdout boundary cannot consume recent candles and every trade has a full horizon', () => {
  const rows = candles();
  const options = { minimumScore: 55, horizonBars: 16, endIndex: 300 };
  const original = walkForwardBacktest(rows, options);
  assert.ok(original.trades > 0);
  assert.equal(original.wins + original.smallMoves + original.losses, original.trades,
    'win, small-move, and loss buckets should account for every trade');
  const modified = rows.map((row, index) => index > 300 ? { ...row, high: row.high * 10, low: row.low / 10 } : row);
  assert.deepEqual(walkForwardBacktest(modified, options), original);
  assert.ok(original.tradesList.every((trade) => trade.exitCandleOpenTime <= rows[300].time && trade.exitTime <= rows[301].time));
  const result = validateStrategy(rows, { minimumScore: 55 });
  assert.ok(result.earlier.tradesList.every((trade) => trade.exitTime <= rows[Math.floor(rows.length * .65)].time));
  assert.equal(result.coverage.overall.candleDays, new Set(rows.slice(80, -1).map((row) => new Date(row.time).toISOString().slice(0, 10))).size);
  assert.equal(result.coverage.overall.signalDays, new Set(result.overall.tradesList.map((trade) => new Date(trade.signalTime).toISOString().slice(0, 10))).size);
  assert.equal(result.sufficient, result.recent.trades >= 5 && result.overall.trades >= 10,
    'calendar coverage is reported separately from the existing approval threshold');
});

test('missing future candles censor replay outcomes and block historical strategy approval', () => {
  const complete = candles();
  const baseline = walkForwardBacktest(complete, { minimumScore: 55 });
  assert.equal(baseline.censoredFutureGapSignals, 0);
  const first = baseline.tradesList[0];
  assert.ok(first);
  const signalIndex = complete.findIndex((row) => row.time === first.signalCandleOpenTime);
  const missingEntryBar = complete.filter((_, index) => index !== signalIndex + 1);
  const replay = walkForwardBacktest(missingEntryBar, { minimumScore: 55 });
  assert.ok(replay.censoredFutureGapSignals > 0);
  assert.ok(replay.tradesList.every((trade) => trade.signalCandleOpenTime !== first.signalCandleOpenTime));
  const validation = validateStrategy(missingEntryBar, { minimumScore: 55 });
  assert.equal(validation.dataQuality.irregularTransitions, 1);
  assert.equal(validation.dataQuality.missingIntervals, 1);
  assert.equal(validation.sufficient, false);
  assert.match(validation.warning, /missing or irregular interval/);
  assert.ok(assessStrategyValidation(validation).reasons.includes('incomplete_historical_candle_path'));
});

test('45-minute horizon uses exactly three future 15-minute bars', () => {
  const replay = walkForwardBacktest(candles(), { minimumScore: 55, horizonBars: 3 });
  assert.ok(replay.trades > 0);
  assert.ok(replay.tradesList.every((trade) => trade.barsHeld >= 1 && trade.barsHeld <= 3));
});

test('backtest stop fills include fees and gap-through losses', () => {
  const rows = candles();
  const first = walkForwardBacktest(rows, { minimumScore: 55 }).tradesList[0];
  const index = rows.findIndex((row) => row.time === first.signalCandleOpenTime);
  rows[index + 2] = { ...rows[index + 2], open: first.stop * .95, low: first.stop * .94, close: first.stop * .95, high: first.stop * .96 };
  const trade = walkForwardBacktest(rows, { minimumScore: 55 }).tradesList[0];
  assert.equal(trade.exitReason, 'stop');
  assert.ok(trade.realizedR < -1.1);
});

test('signal timestamps use completed-candle decision time for UTC day clustering', () => {
  const rows = candles();
  const firstTrade = walkForwardBacktest(rows, { minimumScore: 55 }).tradesList[0];
  assert.ok(firstTrade);
  const signalIndex = rows.findIndex((row) => row.time === firstTrade.signalCandleOpenTime);
  const midnight = Date.UTC(2026, 8, 30);
  const aligned = rows.map((row, index) => ({ ...row, time: midnight - 15 * 60_000 + (index - signalIndex) * 15 * 60_000 }));
  const trade = walkForwardBacktest(aligned, { minimumScore: 55 }).tradesList[0];
  assert.equal(trade.signalCandleOpenTime, midnight - 15 * 60_000);
  assert.equal(trade.signalTime, midnight);
  assert.equal(trade.entryTime, midnight);
  assert.equal(trade.exitTime, trade.exitCandleOpenTime + 15 * 60_000);
});

test('backtest cost model separately accounts for per-side fees, one full spread, and per-side slippage', () => {
  const options = { feeBpsPerSide: 10, quotedSpreadBps: 4, slippageBpsPerSide: 2 };
  const cost = resolveBacktestCostModel(options);
  assert.deepEqual(cost, { mode: 'explicit_components', feeBpsPerSide: 10, quotedSpreadBps: 4,
    slippageBpsPerSide: 2, roundTripBps: 28,
    note: 'Assumes one full quoted spread crossed and per-side fee/slippage on entry and exit; estimates, not observed fills.' });
  const result = walkForwardBacktest(candles(), { minimumScore: 55, ...options });
  const trade = result.tradesList[0];
  assert.ok(trade);
  assert.equal(trade.estimatedCostPct, 0.28);
  assert.equal(result.costModel.roundTripBps, 28);
  assert.throws(() => resolveBacktestCostModel({ ...options, roundTripFeeBps: 20 }), /either legacy/);
  assert.throws(() => resolveBacktestCostModel({ feeBpsPerSide: -1 }), /nonnegative/);
  assert.throws(() => resolveBacktestCostModel({ feeBpsPerSide: 101, slippageBpsPerSide: 1 }), /may not exceed/);
});

test('invalid prices do not corrupt tracking, stops include observed gaps and fees', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  const prediction = buildPrediction(sample, {}, 'g', start);
  for (const price of [0, -1, NaN, Infinity, null]) {
    assert.equal(evaluatePrediction(prediction, { price }, start).prediction, prediction);
  }
  const result = evaluatePrediction(prediction, { price: prediction.stopPrice - 1 }, start).prediction;
  assert.ok(result.realizedR < -1);
  const riskPct = prediction.maxPositionPct / 100 * (prediction.stopPct + prediction.estimatedCostPct);
  assert.ok(riskPct <= prediction.accountRiskPct + 1e-9);
});

test('final limit fill does not book profits above its target', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  const prediction = buildPrediction(sample, {}, 'g', start);
  const result = evaluatePrediction(prediction, { price: prediction.targetPrice * 2 }, start).prediction;
  const expected = .5 + .5 * prediction.riskReward - prediction.estimatedCostPct / prediction.stopPct;
  assert.ok(Math.abs(result.realizedR - expected) < 1e-9);
});

const row = { observationId: 'o', createdAt: '2026-09-01T00:00:00Z', deadlineAt: '2026-09-01T01:00:00Z',
  entryPrice: 100, stopPrice: 98, targetPrice: 104, partialTargetPrice: 102, estimatedCostPct: .2 };
const bar = (minutes, overrides = {}) => ({ time: Date.parse(row.createdAt) + minutes * 60000,
  open: 100, high: 101, low: 99, close: 100, volume: 1, ...overrides });

test('shadow training loader excludes unknown or malformed outcomes instead of filling zero targets', () => {
  const valid = { observationId: 'valid', createdAt: row.createdAt, deadlineAt: row.deadlineAt,
    version: 3, candleProvider: 'Binance', candlePair: 'BTCUSDT',
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION, entryQuoteBasis: 'same_source_ask',
    entryQuoteProvider: 'Binance', entryQuotePair: 'BTCUSDT', entryQuoteObservedAt: row.createdAt,
    entryQuoteAgeMs: 0, entryQuoteAsk: 100, entryPrice: 100,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION, features: { score: 70 }, resolution: {
    version: 3, candleProvider: 'Binance', candlePair: 'BTCUSDT', priceBasis: 'completed_source_candles',
    reason: 'deadline_candle',
    label: 0, targetLabel: 0, realizedR: 0, estimatedCostPct: 0, timeToEventMinutes: 30,
    maxFavorableExcursionR: 0, maxAdverseExcursionR: 0, timestamp: '2026-09-01T00:30:00Z',
  } };
  const malformed = [
    { ...valid, observationId: 'excluded-experiment', excludedFromProductionLearning: true },
    { ...valid, observationId: 'venue-experiment', researchCohort: 'full-venue-discovery-v1' },
    { ...valid, observationId: 'null-label', resolution: { ...valid.resolution, label: null } },
    { ...valid, observationId: 'missing-return', resolution: { ...valid.resolution, realizedR: null } },
    { ...valid, observationId: 'missing-cost', resolution: { ...valid.resolution, estimatedCostPct: null } },
    { ...valid, observationId: 'missing-target', resolution: { ...valid.resolution, targetLabel: null } },
    { ...valid, observationId: 'missing-time', resolution: { ...valid.resolution, timeToEventMinutes: null } },
    { ...valid, observationId: 'missing-excursion', resolution: { ...valid.resolution, maxFavorableExcursionR: null } },
    { ...valid, observationId: 'inconsistent-label', resolution: { ...valid.resolution, label: 1 } },
    { ...valid, observationId: 'future', resolution: { ...valid.resolution, timestamp: '2099-01-01T00:00:00Z' } },
    { ...valid, observationId: 'wrong-provider', resolution: { ...valid.resolution, candleProvider: 'Coinbase' } },
    { ...valid, observationId: 'consensus-entry', entryQuoteBasis: 'cross_venue_consensus' },
    { ...valid, observationId: 'wrong-entry-pair', entryQuotePair: 'BTC-USD' },
    { ...valid, observationId: 'mismatched-ask', entryQuoteAsk: 101 },
    { ...valid, observationId: 'stale-entry', entryQuoteAgeMs: 60_000 },
    { ...valid, observationId: 'legacy-entry', entryEvidenceVersion: null },
    { ...valid, observationId: 'legacy-label', resolution: { ...valid.resolution, version: 2 } },
    { ...valid, observationId: 'approximate-deadline', resolution: {
      ...valid.resolution, reason: 'deadline_last_closed_candle' } },
    { ...valid, observationId: 'second-deadline-audit', resolution: {
      ...valid.resolution, priceBasis: 'completed_source_candles_with_second_deadline_audit',
      reason: 'deadline_last_completed_second' } },
    { ...valid, observationId: 'second-barrier-audit', resolution: {
      ...valid.resolution, priceBasis: 'completed_source_candles_with_second_deadline_audit',
      reason: 'second_stop_first' } },
    { ...valid, observationId: 'unknown-resolution-reason', resolution: {
      ...valid.resolution, reason: undefined } },
  ];
  const rows = normalizeLabeledObservations([valid, ...malformed]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 0);
  assert.equal(rows[0].realizedR, 0, 'a measured zero return remains a legitimate outcome');
  assert.equal(rows[0].estimatedCostPct, 0, 'an observed zero cost is distinct from missing cost');
  const legacy = { ...valid, observationId: 'legacy-feature-semantics' };
  delete legacy.featureSchemaVersion;
  assert.equal(normalizeLabeledObservations([valid, legacy]).length, 1,
    'outcomes whose feature meanings are unknown must not train the current model');
});

test('shadow entry quote must match the outcome candle venue and be fresh', () => {
  const now = new Date('2026-09-01T00:00:20Z');
  const asset = { marketData: { candleProvider: 'Binance', candlePair: 'BTCUSDT', providerCount: 2,
    quotes: [{ provider: 'Binance', pair: 'BTCUSDT', timestampBasis: 'provider_event',
      observedAt: '2026-09-01T00:00:10Z', bid: 99, ask: 100 }] } };
  assert.equal(selectSourcePinnedEntryQuote(asset, now).ask, 100);
  assert.equal(selectSourcePinnedEntryQuote({ marketData: { ...asset.marketData, candlePair: 'BTC-USD' } }, now), null);
  assert.equal(selectSourcePinnedEntryQuote({ marketData: { ...asset.marketData,
    quotes: [{ ...asset.marketData.quotes[0], timestampBasis: 'response_received' }] } }, now), null);
  assert.equal(selectSourcePinnedEntryQuote({ marketData: { ...asset.marketData,
    quotes: [{ ...asset.marketData.quotes[0], observedAt: '2026-09-01T00:00:22Z' }] } }, now), null);
  assert.equal(selectSourcePinnedEntryQuote(asset, new Date('2026-09-01T00:01:00Z')), null);
});

test('production shadow prediction freezes same-source ask levels without changing the production asset', () => {
  const now = new Date('2026-09-01T00:00:20Z');
  const raw = { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, price: 99.95,
    marketCap: 100_000_000, volume24h: 10_000_000, volumeToMarketCap: 0.1,
    high24h: 105, low24h: 90, athChangePercent: -10, change1h: 1, change24h: 2, change7d: 5,
    marketData: { candleProvider: 'Binance', candlePair: 'BTCUSDT', providerCount: 2,
      technicals: { dataSufficient: true, atrPct: 1.2, ema9: 101, ema21: 100, ema50: 98 },
      quotes: [{ provider: 'Binance', pair: 'BTCUSDT', timestampBasis: 'provider_event',
        observedAt: '2026-09-01T00:00:10Z', bid: 99.9, ask: 100 }],
      execution: { blockTrade: false, estimatedRoundTripBps: 24 } } };
  const asset = { ...raw, model: scoreAsset(raw) };
  const shadow = buildSourcePinnedShadowPrediction(asset, { estimatedRoundTripBps: 20,
    minProviderConfirmations: 2 }, 'test', now);
  assert.equal(shadow.prediction.entryPrice, 100);
  assert.equal(asset.price, 99.95);
  assert.equal(shadow.quote.pair, 'BTCUSDT');
  assert.ok(shadow.estimatedCostPct >= 0.3 - 1e-9);
  assert.equal(shadow.entryEvidenceVersion, RESEARCH_ENTRY_EVIDENCE_VERSION);
});

test('shadow candle hits resolve even when current quote no longer touches target', () => {
  const result = resolveObservation(row, [bar(0, { open: 102, low: 101, high: 104, close: 103 })], 101, new Date('2026-09-01T00:30:00Z'));
  assert.equal(result.targetLabel, 1);
  assert.ok(Math.abs(result.realizedR - 1.4) < 1e-9);
  assert.equal(result.timeToEventMinutes, 15);
});

test('shadow bars crossing both barriers assume stop first and charge costs', () => {
  const result = resolveObservation(row, [bar(0, { low: 97, high: 105 })], 105, new Date('2026-09-01T00:30:00Z'));
  assert.equal(result.label, 0);
  assert.equal(result.targetLabel, 0);
  assert.ok(Math.abs(result.realizedR + 1.1) < 1e-9);
});

test('source-pinned shadow outcomes ignore snapshot prices and reject mixed venues or ambiguous partial bars', () => {
  const strict = { ...row, version: 3, candleProvider: 'Binance', candlePair: 'BTCUSDT' };
  const sourceBar = (minutes, overrides = {}) => ({ ...bar(minutes, overrides), provider: 'Binance', pair: 'BTCUSDT' });
  const binance = { ...bar(0, { high: 101 }), provider: 'Binance', pair: 'BTCUSDT' };
  const coinbase = { ...bar(0, { high: 105 }), provider: 'Coinbase', pair: 'BTC-USD' };
  const matched = selectObservationCandles([binance, coinbase], strict);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].high, 101);
  assert.equal(resolveObservation(strict, [], 110, new Date('2026-09-01T00:10:00Z')), null,
    'an unverified broad current price cannot create a training label');
  assert.equal(resolveObservation(strict, [coinbase], 110, new Date('2026-09-01T00:31:00Z')), null,
    'the resolver itself must reject a candle from the wrong venue');
  const target = resolveObservation(strict, [binance, sourceBar(15, { open: 101, high: 105, low: 100.5, close: 102 })],
    80, new Date('2026-09-01T00:31:00Z'));
  assert.equal(target.version, 3);
  assert.equal(target.reason, 'candle_target');
  assert.equal(target.priceBasis, 'completed_source_candles');
  assert.equal(resolveObservation(strict, [binance, sourceBar(30, { high: 105 })], 110,
    new Date('2026-09-01T00:46:00Z')), null, 'a missing intervening bar blocks a later apparent winner');
  const partial = { ...strict, createdAt: '2026-09-01T00:05:00Z' };
  assert.equal(inspectSourcePinnedEntryBar(partial, [sourceBar(0, { high: 105 })],
    new Date('2026-09-01T00:31:00Z')), 'entry_containing_candle_ambiguous');
  assert.equal(resolveObservation(partial, [sourceBar(0, { high: 105 }), sourceBar(15, { high: 105 })], 110,
    new Date('2026-09-01T00:31:00Z')), null, 'a hit in the containing bar has unknown order around creation');
  assert.equal(selectObservationCandles([binance, sourceBar(0, { high: 103 })], strict).length, 0,
    'conflicting bars from one source must not be resolved by last-write-wins normalization');
});

test('shadow ignores open bars and post-deadline targets, requiring deadline evidence', () => {
  assert.equal(resolveObservation(row, [bar(0, { high: 105 })], 100, new Date('2026-09-01T00:10:00Z')), null);
  assert.equal(resolveObservation(row, [bar(60, { high: 105 })], 110, new Date('2026-09-01T02:00:00Z')), null);
  const result = resolveObservation(row, [bar(0), bar(15), bar(30), bar(45, { close: 99.5 })], 110, new Date('2026-09-01T02:00:00Z'));
  assert.equal(result.reason, 'deadline_candle');
  assert.equal(result.label, 0);
  assert.ok(result.realizedR < 0);
});

test('late-arriving training labels cannot leak into earlier folds', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ createdAt: new Date(index * 86400000).toISOString(),
    deadlineAt: new Date(index * 86400000 + 60000).toISOString(), resolvedAt: new Date(30 * 86400000).toISOString() }));
  assert.equal(chronologicalSplit(rows, { purgeMinutes: 0 }).training.length, 0);
});

test('provider consensus excludes duplicate, stale, and crossed quotes', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const good = { provider: 'A', price: 100, bid: 99.99, ask: 100.01, observedAt: new Date(now).toISOString() };
  const result = aggregateProviderQuotes([good, good, { ...good, provider: 'B', bid: 101 },
    { ...good, provider: 'C', observedAt: '2020-01-01T00:00:00Z' }], 0, { now });
  assert.equal(result.providerCount, 1);
  assert.deepEqual(result.rejectionCounts, { invalid_or_crossed_quote: 1, stale_observation_timestamp: 1, missing_or_duplicate_provider: 1 });
});

test('receipt-time-only ticker observations stay diagnostic and cannot satisfy fresh exchange confirmation', () => {
  const now = Date.now();
  const result = aggregateProviderQuotes([
    { provider: 'Binance', price: 100, bid: 99.99, ask: 100.01, observedAt: new Date(now).toISOString() },
    { provider: 'Kraken', price: 100, bid: 99.99, ask: 100.01, observedAt: new Date(now).toISOString(), timestampBasis: 'response_received' },
  ], 0, { now: new Date(now) });
  assert.equal(result.exchangeProviderCount, 1);
  assert.deepEqual(result.providers, ['Binance']);
  assert.equal(result.unconfirmedQuotes[0].provider, 'Kraken');
  assert.equal(result.unconfirmedQuotes[0].timestampTrust, 'receipt_time_only');
});

test('provider consensus requires timestamps and rejects quotes more than five seconds in the future', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const quote = { provider: 'feed', price: 100, bid: 99.99, ask: 100.01 };
  const result = aggregateProviderQuotes([
    quote,
    { ...quote, provider: 'future-ok', observedAt: new Date(now + 5_000).toISOString() },
    { ...quote, provider: 'future', observedAt: new Date(now + 5_001).toISOString() },
    { ...quote, provider: 'stale', observedAt: new Date(now - 5 * 60_000 - 1).toISOString() },
  ], 0, { now });
  assert.deepEqual(result.providers, ['future-ok']);
  assert.deepEqual(result.rejectionCounts, {
    missing_observation_timestamp: 1,
    future_observation_timestamp: 1,
    stale_observation_timestamp: 1,
  });
  assert.equal(result.consensusPrice, 100);
});

test('untimestamped market snapshot stays reference-only and cannot inflate exchange confirmation', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const result = aggregateProviderQuotes([
    { provider: 'Binance', price: 100, bid: 99.99, ask: 100.01, observedAt: new Date(now).toISOString() },
  ], 500, { now });
  assert.equal(result.providerCount, 1);
  assert.equal(result.exchangeProviderCount, 1);
  assert.deepEqual(result.providers, ['Binance']);
  assert.equal(result.consensusPrice, 100);
  assert.equal(result.priceDispersionPct, 0);
  assert.equal(result.referenceQuote.price, 500);
  assert.equal(result.referenceQuote.executable, false);
  assert.equal(result.referencePriceDeviationPct, 400);
});

test('historical providers exclude unfinished candles and cache per provider preference', async (t) => {
  const now = Math.floor(Date.now() / 900000) * 900000;
  const rows = Array.from({ length: 81 }, (_, index) => [now - (80 - index) * 900000, 100, 101, 99, 100, 1]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    if (String(url).includes('coinbase')) return new Response(JSON.stringify(rows.map(([time]) => [time / 1000, 99, 101, 100, 100, 1]).reverse()));
    return new Response(JSON.stringify(rows));
  });
  const first = await fetchHistoricalCandles({ symbol: 'TEST' }, { limit: 81, providers: ['Binance'] });
  const second = await fetchHistoricalCandles({ symbol: 'TEST' }, { limit: 81, providers: ['Coinbase'] });
  assert.equal(first.candles.length, 80);
  assert.equal(second.provider, 'Coinbase');
  assert.equal(second.candles.length, 80);
  assert.equal(calls, 2);
  assert.ok(first.candles.every((candle) => candle.time + 900000 <= Date.now()));
});

test('candle coverage reports missing intervals without changing history eligibility', () => {
  const step = 900_000;
  const start = 1_700_000_000_000;
  const rows = [0, 1, 3, 4].map((slot) => ({ time: start + slot * step,
    open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  const coverage = summarizeCandleCoverage(rows, step);
  assert.equal(coverage.candleCount, 4);
  assert.equal(coverage.missingIntervals, 1);
  assert.equal(coverage.irregularTransitions, 1);
  assert.equal(coverage.largestGapMs, 2 * step);
  assert.equal(coverage.contiguous, false);
  assert.equal(coverage.lastCompletedAt, new Date(start + 5 * step).toISOString());
});

test('exchange candle requests retry transient network disconnects but do not trust incomplete history', async (t) => {
  const now = Math.floor(Date.now() / 900000) * 900000;
  // Hold this scenario inside the bar; a real quarter-hour rollover during the
  // retry would legitimately complete the last fixture candle.
  t.mock.method(Date, 'now', () => now + 60_000);
  const rows = Array.from({ length: 81 }, (_, index) => [now - (80 - index) * 900000, '100', '101', '99', '100', '1']);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('temporary socket reset');
    return new Response(JSON.stringify(rows));
  });

  const result = await fetchHistoricalCandles({ symbol: 'TRANSIENTFIXTURE' }, { limit: 81, providers: ['Binance'], force: true });
  assert.equal(calls, 2);
  assert.equal(result.provider, 'Binance');
  assert.equal(result.candles.length, 80, 'the unfinished current candle remains excluded after retry');
});

test('identical concurrent forced candle-history requests share one provider pull', async (t) => {
  const now = Math.floor(Date.now() / 900000) * 900000;
  const rows = Array.from({ length: 81 }, (_, index) => [now - (80 - index) * 900000, 100, 101, 99, 100, 1]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify(rows));
  });
  const asset = { symbol: 'CANDLECOALESCEFIXTURE' };
  const options = { limit: 81, providers: ['Binance'], force: true };
  const [first, second] = await Promise.all([
    fetchHistoricalCandles(asset, options),
    fetchHistoricalCandles(asset, options),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.provider, 'Binance');
  assert.equal(first.candles.length, 80);
});

test('concurrent Kraken history lookups share one cold AssetPairs directory request', async (t) => {
  const interval = 900_000;
  const latestCompleted = Math.floor(Date.now() / interval) * interval - interval;
  const rows = Array.from({ length: 80 }, (_, index) => [
    (latestCompleted - (79 - index) * interval) / 1000, '100', '101', '99', '100', '100', '10', 1,
  ]);
  const directory = { error: [], result: {
    XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD' },
    XETHZUSD: { altname: 'ETHUSD', wsname: 'ETH/USD', base: 'XETH', quote: 'ZUSD' },
  } };
  let directoryCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    if (value.endsWith('/AssetPairs')) { directoryCalls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return new Response(JSON.stringify(directory)); }
    if (value.includes('/OHLC?')) {
      const pair = new URL(value).searchParams.get('pair');
      return new Response(JSON.stringify({ error: [], result: { [pair]: rows, last: 1 } }));
    }
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const results = await Promise.all([
    fetchHistoricalCandles({ symbol: 'BTC' }, { limit: 80, providers: ['Kraken'] }),
    fetchHistoricalCandles({ symbol: 'ETH' }, { limit: 80, providers: ['Kraken'] }),
  ]);
  assert.equal(directoryCalls, 1);
  assert.deepEqual(results.map((result) => result.provider), ['Kraken', 'Kraken']);
  assert.ok(results.every((result) => result.candles.length >= 50));
});

test('spot-pair coverage preflight removes symbols below the existing venue-confirmation minimum', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/api/v3/exchangeInfo')) return new Response(JSON.stringify({ symbols: [
      { symbol: 'SOLOUSDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'HALTEDUSDT', status: 'BREAK', isSpotTradingAllowed: true },
    ] }));
    if (value.endsWith('/products')) return new Response(JSON.stringify([
      { base_currency: 'BTC', quote_currency: 'USD', status: 'online' },
      { base_currency: 'SOLO', quote_currency: 'USD', status: 'delisted' },
    ]));
    if (value.endsWith('/AssetPairs')) return new Response(JSON.stringify({ error: [], result: {
      XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD' },
    } }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const { result, providers } = await withProviderTelemetry(() => screenSpotPairCoverage([
    { id: 'bitcoin', symbol: 'BTC' },
    { id: 'solo-fixture', symbol: 'SOLO' }, { id: 'halted-fixture', symbol: 'HALTED' },
  ], { minProviders: 2 }));
  assert.equal(result.available, true);
  assert.deepEqual(result.candidates.map((row) => row.symbol), ['BTC']);
  assert.deepEqual(result.supportedVenueCounts, { Binance: 1, Coinbase: 1, Kraken: 1 });
  assert.deepEqual(result.krakenDependentAssetIds, ['bitcoin']);
  assert.deepEqual(result.rejections.map((row) => [row.symbol, row.observed, row.required]), [
    ['SOLO', 1, 2], ['HALTED', 0, 2],
  ]);
  assert.ok(calls.some((value) => value.endsWith('/api/v3/exchangeInfo')));
  assert.ok(calls.some((value) => value.endsWith('/products')));
  assert.ok(providers.Binance && providers.Coinbase, 'directory requests must contribute to venue quota telemetry');
  assert.equal(providers['Binance Directory'], undefined);
  assert.equal(providers['Coinbase Directory'], undefined);
});

test('identical concurrent provider quote requests share one fresh three-venue sample', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (value.includes('data-api.binance.vision')) return new Response(JSON.stringify({
      lastPrice: '100', bidPrice: '99.99', askPrice: '100.01', quoteVolume: '1000000', closeTime: Date.now()
    }));
    if (value.includes('api.exchange.coinbase.com')) return new Response(JSON.stringify({
      price: '100', bid: '99.99', ask: '100.01', volume: '10000', time: new Date().toISOString()
    }));
    if (value.includes('/Ticker?pair=XBTUSD')) return new Response(JSON.stringify({ error: [], result: {
      XXBTZUSD: { c: ['100'], b: ['99.99'], a: ['100.01'], v: ['0', '10000'] }
    } }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const asset = { id: 'quote-coalescing-fixture', symbol: 'BTC' };
  const [first, second] = await Promise.all([fetchProviderQuotes(asset), fetchProviderQuotes(asset)]);
  assert.deepEqual(second, first);
  assert.equal(first.quotes.length, 3);
  assert.equal(first.errors.length, 0);
  assert.equal(calls.length, 3, 'each venue ticker should be fetched once');
});

test('fresh Kraken WebSocket quote replaces its receipt-time-only REST ticker and is still age-gated', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('data-api.binance.vision')) return new Response(JSON.stringify({
      lastPrice: '100', bidPrice: '99.99', askPrice: '100.01', quoteVolume: '1000000', closeTime: Date.now()
    }));
    if (value.includes('api.exchange.coinbase.com')) return new Response(JSON.stringify({
      price: '100', bid: '99.99', ask: '100.01', volume: '10000', time: new Date().toISOString()
    }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const now = Date.now();
  const observedAt = new Date(now - 250).toISOString();
  const result = await fetchProviderQuotes({ id: 'realtime-kraken-fixture', symbol: 'BTC' }, {
    now, realtimeQuote: { provider: 'Kraken', symbol: 'BTC', pair: 'BTC/USD', base: 'BTC', target: 'USD',
      bid: 99.99, ask: 100.01, price: 100, observedAt, timestampBasis: 'provider_event' }
  });
  const kraken = result.quotes.find((quote) => quote.provider === 'Kraken');
  assert.equal(kraken.observedAt, observedAt);
  assert.equal(kraken.timestampBasis, 'provider_event');
  assert.ok(!calls.some((url) => url.includes('api.kraken.com')));
  const accepted = aggregateProviderQuotes(result.quotes, 0, { now, maxAgeMs: 5_000 });
  assert.equal(accepted.providerCount, 3);
  const stale = aggregateProviderQuotes([kraken], 0, { now: Date.parse(observedAt) + 5_001, maxAgeMs: 5_000 });
  assert.equal(stale.providerCount, 0);
  assert.equal(stale.rejectionCounts.stale_observation_timestamp, 1);
});

test('missing Binance and Coinbase provider times cannot be replaced by local receipt time', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    if (value.includes('data-api.binance.vision')) return new Response(JSON.stringify({
      lastPrice: '100', bidPrice: '99.99', askPrice: '100.01', quoteVolume: '1000000'
    }));
    if (value.includes('api.exchange.coinbase.com')) return new Response(JSON.stringify({
      price: '100', bid: '99.99', ask: '100.01', volume: '10000'
    }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const observedAt = new Date().toISOString();
  const result = await fetchProviderQuotes({ id: 'missing-source-time-fixture', symbol: 'BTC' }, {
    realtimeQuote: { provider: 'Kraken', symbol: 'BTC', pair: 'BTC/USD', base: 'BTC', target: 'USD',
      bid: 99.99, ask: 100.01, price: 100, observedAt, timestampBasis: 'provider_event' }
  });
  const consensus = aggregateProviderQuotes(result.quotes, 100);
  assert.equal(result.quotes.find((quote) => quote.provider === 'Binance').observedAt, null);
  assert.equal(result.quotes.find((quote) => quote.provider === 'Coinbase').observedAt, null);
  assert.equal(consensus.providerCount, 1);
  assert.equal(consensus.rejectionCounts.missing_observation_timestamp, 2);
});

test('Pro CoinGecko identity allowlist requires exact coin ID, active venue pair, and clean ticker flags', () => {
  const asset = { id: 'identity-fixture-coin', symbol: 'FIX' };
  const ids = { Binance: 'binance', Coinbase: 'gdax', Kraken: 'kraken' };
  const verified = verifiedCoinGeckoTickerPairs(asset, { tickers: [
    { coin_id: 'identity-fixture-coin', market: { identifier: 'binance' }, base: 'FIX', target: 'USDT', is_stale: false, is_anomaly: false },
    { coin_id: 'another-coin-id', market: { identifier: 'binance' }, base: 'FIX', target: 'USDT', is_stale: false, is_anomaly: false },
    { coin_id: 'identity-fixture-coin', market: { identifier: 'gdax' }, base: 'FIX', target: 'USD', is_stale: true, is_anomaly: false },
    { coin_id: 'identity-fixture-coin', market: { identifier: 'kraken' }, base: 'FIX', target: 'USD', is_stale: false, is_anomaly: true },
    { coin_id: 'identity-fixture-coin', market: { identifier: 'other' }, base: 'FIX', target: 'USD', is_stale: false, is_anomaly: false }
  ] }, ids);
  assert.deepEqual([...verified], ['binance:FIX:USDT']);
});

test('Pro identity mapping blocks ticker-only quotes unless CoinGecko confirms the exact venue pair', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/exchanges/list')) return new Response(JSON.stringify([
      { id: 'binance', name: 'Binance' }, { id: 'gdax', name: 'Coinbase Exchange' }, { id: 'kraken', name: 'Kraken' }
    ]));
    if (value.includes('/coins/identity-fixture-pro/tickers')) return new Response(JSON.stringify({ tickers: [
      { coin_id: 'identity-fixture-pro', market: { identifier: 'binance' }, base: 'FIX', target: 'USDT', is_stale: false, is_anomaly: false }
    ] }));
    if (value.includes('data-api.binance.vision')) return new Response(JSON.stringify({
      lastPrice: '100', bidPrice: '99.99', askPrice: '100.01', quoteVolume: '1000000', closeTime: Date.now()
    }));
    if (value.includes('api.exchange.coinbase.com')) return new Response(JSON.stringify({
      price: '100', bid: '99.99', ask: '100.01', volume: '10000', time: new Date().toISOString()
    }));
    if (value.includes('/AssetPairs')) return new Response(JSON.stringify({ error: [], result: {
      FIXUSD: { altname: 'FIXUSD', wsname: 'FIX/USD', base: 'FIX', quote: 'ZUSD' }
    } }));
    if (value.includes('/Ticker?pair=FIXUSD')) return new Response(JSON.stringify({ error: [], result: {
      FIXUSD: { c: ['100'], b: ['99.99'], a: ['100.01'], v: ['0', '10000'] }
    } }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const result = await fetchProviderQuotes({ id: 'identity-fixture-pro', symbol: 'FIX' }, {
    settings: { coingeckoApiTier: 'pro', coingeckoApiKey: 'fixture-key' },
    realtimeQuote: { provider: 'Kraken', symbol: 'FIX', pair: 'FIX/USD', base: 'FIX', target: 'USD',
      bid: 99.99, ask: 100.01, price: 100, observedAt: new Date().toISOString(), timestampBasis: 'provider_event' }
  });
  assert.equal(result.identity.status, 'pro_verified_pair_allowlist');
  assert.deepEqual(result.quotes.map((quote) => quote.provider), ['Binance']);
  assert.ok(result.errors.some((error) => error.startsWith('Coinbase:') && /identity was not verified/.test(error)));
  assert.ok(result.errors.some((error) => error.startsWith('Kraken:') && /identity was not verified/.test(error)));
  assert.ok(!calls.some((url) => url.includes('/AssetPairs')), 'the timestamped WebSocket pair must still pass exact-identity checks before substituting REST');
  assert.ok(calls.some((url) => url.includes('exchange_ids=binance%2Cgdax%2Ckraken')));
});

test('Demo key verifies coin ID and exact venue pairs while an unavailable identity feed fails closed', async (t) => {
  const identityCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const value = String(url);
    if (value.includes('api.coingecko.com/api/v3/')) {
      identityCalls.push({ url: value, demoKey: options.headers['x-cg-demo-api-key'] });
      if (value.includes('/exchanges/list')) return new Response(JSON.stringify([
        { id: 'binance', name: 'Binance' }, { id: 'gdax', name: 'Coinbase Exchange' },
        { id: 'kraken', name: 'Kraken' }
      ]));
      if (value.includes('/coins/identity-fixture-demo/tickers')) return new Response(JSON.stringify({ tickers: [
        { coin_id: 'identity-fixture-demo', market: { identifier: 'binance' }, base: 'FIX', target: 'USDT', is_stale: false, is_anomaly: false },
        { coin_id: 'other-coin', market: { identifier: 'gdax' }, base: 'FIX', target: 'USD', is_stale: false, is_anomaly: false },
        { coin_id: 'identity-fixture-demo', market: { identifier: 'kraken' }, base: 'FIX', target: 'USD', is_stale: false, is_anomaly: false }
      ] }));
      if (value.includes('/coins/identity-fixture-demo-denied/tickers')) return new Response('forbidden', { status: 403 });
    }
    if (value.includes('data-api.binance.vision')) return new Response(JSON.stringify({
      lastPrice: '100', bidPrice: '99.99', askPrice: '100.01', quoteVolume: '1000000', closeTime: Date.now()
    }));
    if (value.includes('api.exchange.coinbase.com')) return new Response(JSON.stringify({
      price: '100', bid: '99.99', ask: '100.01', volume: '10000', time: new Date().toISOString()
    }));
    throw new Error(`Unexpected provider URL ${value}`);
  });
  const realtimeQuote = { provider: 'Kraken', symbol: 'FIX', pair: 'FIX/USD', base: 'FIX', target: 'USD',
    bid: 99.99, ask: 100.01, price: 100, observedAt: new Date().toISOString(), timestampBasis: 'provider_event' };
  const settings = { coingeckoApiTier: 'demo', coingeckoApiKey: 'fixture-demo-key' };
  const result = await fetchProviderQuotes({ id: 'identity-fixture-demo', symbol: 'FIX' }, { settings, realtimeQuote });
  assert.equal(result.identity.mode, 'coingecko_demo');
  assert.equal(result.identity.status, 'demo_verified_pair_allowlist');
  assert.deepEqual(result.quotes.map((quote) => quote.provider), ['Binance', 'Kraken']);
  assert.ok(result.errors.some((error) => error.startsWith('Coinbase:') && /identity was not verified/.test(error)));
  assert.equal(identityCalls.length, 2);
  assert.ok(identityCalls.every((call) => call.demoKey === 'fixture-demo-key'));
  const denied = await fetchProviderQuotes({ id: 'identity-fixture-demo-denied', symbol: 'FIX' }, { settings, realtimeQuote });
  assert.equal(denied.identity.status, 'failed');
  assert.equal(denied.quotes.length, 0);
  const invalidTier = await fetchProviderQuotes({ id: 'identity-fixture-invalid-tier', symbol: 'FIX' }, {
    settings: { coingeckoApiTier: 'mistyped', coingeckoApiKey: 'fixture-demo-key' }, realtimeQuote
  });
  assert.equal(invalidTier.identity.status, 'failed');
  assert.equal(invalidTier.quotes.length, 0);
});

test('Binance Retry-After cooldown suppresses later history requests to the same host', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
  });
  const asset = { symbol: 'COOLDOWNFIXTURE' };
  const first = await fetchHistoricalCandles(asset, { limit: 80, providers: ['Binance'], force: true });
  assert.equal(calls, 1);
  assert.match(first.errors[0], /retry deferred/i);

  const second = await fetchHistoricalCandles(asset, { limit: 80, providers: ['Binance'], force: true });
  assert.equal(calls, 1, 'a fresh provider call must not ignore the active server cooldown');
  assert.match(second.errors[0], /cooling down/i);
});

test('gapped candle histories are not technically confirmed and malformed OHLC is rejected', () => {
  const rows = candles(100);
  assert.equal(analyzeCandles(rows).dataSufficient, true);
  assert.equal(analyzeCandles(rows.filter((_, index) => index !== 90)).dataSufficient, false);
  assert.equal(normalizeCandles([{ ...rows[0], high: 1 }]).length, 0);
});

test('shadow cannot skip missing bars to report a later target', () => {
  assert.equal(resolveObservation(row, [bar(30, { open: 102, low: 101, high: 105, close: 103 })], 100,
    new Date('2026-09-01T01:00:00Z')), null);
});

test('unaligned deadlines use only the last earlier close and disclose approximation', () => {
  const result = resolveObservation({ ...row, deadlineAt: '2026-09-01T01:02:00Z' },
    [bar(0), bar(15), bar(30), bar(45, { close: 99.5 })], 120, new Date('2026-09-01T02:00:00Z'));
  assert.equal(result.reason, 'deadline_last_closed_candle');
  assert.equal(result.timeToEventMinutes, 60);
  assert.equal(result.targetLabel, 0);
});

test('combined worker rejects missing or shared tokens before starting either client', () => {
  assert.throws(() => validateWorkerConfiguration({ discordToken: 'fixture-a' }, { discordToken: 'fixture-a' }), /cannot share/);
  assert.throws(() => validateWorkerConfiguration({ discordToken: 'fixture-a' }, {}), /requires separate/);
  assert.doesNotThrow(() => validateWorkerConfiguration({ discordToken: 'fixture-a' }, { discordToken: 'fixture-b' }));
});
