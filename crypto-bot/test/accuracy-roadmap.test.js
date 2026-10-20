import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDerivatives, summarizeOpenInterestHistory } from '../src/derivativesProviders.js';
import {
  chronologicalSplit, predictBoostedModel, predictMetaProbability, trainBoostedModel, trainMetaModelBundle
} from '../src/metaModel.js';
import { applyPortfolioRisk, assetCorrelation, diagnoseAssetCorrelation } from '../src/portfolioRisk.js';
import { evaluateRiskGuard } from '../src/riskGuard.js';
import { materializeObservations } from '../src/researchStore.js';
import { parseBinanceMessage, parseCoinbaseMessage, parseKrakenMessage, RealtimeMarketHub } from '../src/realtimeFeeds.js';
import { parseBinanceEvents, parseCoinbaseEvents, parseKrakenEvents } from '../src/realtimeFeeds.js';
import { MicrostructureAccumulator } from '../src/microstructure.js';
import { estimateExecutionCost, monteCarloCostStress } from '../src/executionSimulator.js';
import { summarizeOptionsSurface } from '../src/derivativesProviders.js';
import { evaluateEventRisk, normalizedEvent } from '../src/eventRisk.js';
import { predictOutcomeDistribution, trainOutcomeModelBundle } from '../src/outcomeModels.js';
import { compareBundles, normalizeModelBundle, resolveModelCostStressSettings, summarizeModelReadiness } from '../src/modelRegistry.js';
import { extractModelFeatures, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } from '../src/modelFeatures.js';
import { RESEARCH_LABEL_VERSION, RESEARCH_ENTRY_EVIDENCE_VERSION,
  RESEARCH_OUTCOME_EVIDENCE_VERSION } from '../src/researchStore.js';
import { buildCommands } from '../src/commands.js';

function observations(count = 260) {
  const start = Date.parse('2025-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const strong = index % 5 >= 2;
    const created = start + index * 8 * 3_600_000;
    return {
      observationId: `o-${index}`, createdAt: new Date(created).toISOString(),
      deadlineAt: new Date(created + 2 * 3_600_000).toISOString(),
      horizonKey: index % 2 ? 'rapid' : 'intraday', assetClass: 'large', regimeKey: 'risk_on',
      label: strong ? 1 : 0,
      features: { technicalScore: strong ? 82 + index % 3 : 34 + index % 4, providerQuality: strong ? 92 : 52, rsi14: strong ? 61 : 39 }
    };
  });
}

test('boosted model uses purged chronological holdout and activates only after improvement', () => {
  const rows = observations();
  const split = chronologicalSplit(rows, { holdoutFraction: 0.25, purgeMinutes: 360 });
  assert.ok(split.training.at(-1).deadlineAt < split.holdout[0].createdAt);
  const model = trainBoostedModel(rows, { minimumSamples: 200, rounds: 32 });
  assert.equal(model.active, true);
  assert.ok(model.metrics.auc > 0.9);
  assert.ok(model.metrics.brier < model.baselineMetrics.brier);
  assert.ok(model.dayCoverage.foldDays.every((days) => days >= 5));
  assert.ok(model.dayCoverage.blindDays >= 5);
  assert.ok(predictBoostedModel(model, { technicalScore: 90, providerQuality: 95, rsi14: 60 })
    > predictBoostedModel(model, { technicalScore: 25, providerQuality: 40, rsi14: 35 }));
});

test('boosted model abstains when its validation folds or blind set are concentrated in too few days', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const clustered = observations(320).map((row, index) => {
    const createdAt = new Date(start + Math.floor(index / 80) * 24 * 3_600_000 + (index % 80) * 18 * 60_000).toISOString();
    return { ...row, createdAt, deadlineAt: new Date(Date.parse(createdAt) + 2 * 3_600_000).toISOString() };
  });
  const model = trainBoostedModel(clustered, { minimumSamples: 200, rounds: 24 });
  assert.equal(model.active, false);
  assert.match(model.reason, /at least 5 distinct UTC days/);
  assert.ok(model.dayCoverage.blindDays < 5 || model.dayCoverage.foldDays.some((days) => days < 5));
});

test('context bundle reports an active blended meta probability', () => {
  const bundle = trainMetaModelBundle(observations(320), { minimumSamples: 200, rounds: 24 });
  const result = predictMetaProbability(bundle, { technicalScore: 88, providerQuality: 93, rsi14: 62 }, {
    horizonKey: 'rapid', assetClass: 'large', regimeKey: 'risk_on'
  });
  assert.equal(result.active, true);
  assert.ok(result.probability > 0.5);
  assert.ok(result.models.some((model) => model.key === 'global'));
  const shifted = predictMetaProbability(bundle, { technicalScore: 10_000, providerQuality: 93, rsi14: 62 }, {
    horizonKey: 'rapid', assetClass: 'large', regimeKey: 'risk_on', maxOodScore: 4
  });
  assert.equal(shifted.abstain, true);
  assert.ok(shifted.oodScore > 4);
});

test('legacy active meta bundles without multi-day evidence are disabled on load and at prediction time', () => {
  const bundle = trainMetaModelBundle(observations(320), { minimumSamples: 200, rounds: 24 });
  const legacy = structuredClone(bundle);
  for (const model of Object.values(legacy.models)) delete model.dayCoverage;
  const normalized = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    outcomeEvidenceVersion: RESEARCH_OUTCOME_EVIDENCE_VERSION, meta: legacy });
  assert.equal(normalized.meta.models.global.active, false);
  assert.equal(normalized.meta.activeModels, 0);
  assert.match(normalized.meta.models.global.reason, /Disabled on load/);
  const directPrediction = predictMetaProbability(legacy, { technicalScore: 88, providerQuality: 93, rsi14: 62 }, {
    horizonKey: 'rapid', assetClass: 'large', regimeKey: 'risk_on'
  });
  assert.equal(directPrediction.active, false);
  assert.match(directPrediction.reason, /coverage is missing/);
});

test('model registry disables legacy models when provider-feature semantics changed', () => {
  const normalized = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION - 1,
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    outcomeEvidenceVersion: RESEARCH_OUTCOME_EVIDENCE_VERSION,
    meta: { activeModels: 1, models: { global: { active: true, accepted: true } } },
    outcomes: { active: true, samples: 300 } });
  assert.equal(normalized.featureSchemaCompatible, false);
  assert.equal(normalized.meta.activeModels, 0);
  assert.equal(normalized.meta.models.global.active, false);
  assert.equal(normalized.outcomes.active, false);
  assert.match(normalized.meta.models.global.reason, /feature semantics/);
});

test('model registry disables same-candle-source bundles whose entry basis was not pinned', () => {
  const normalized = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    meta: { activeModels: 1, models: { global: { active: true, accepted: true } } },
    outcomes: { active: true, samples: 300 } });
  assert.equal(normalized.entryEvidenceCompatible, false);
  assert.equal(normalized.meta.activeModels, 0);
  assert.equal(normalized.outcomes.active, false);
  assert.match(normalized.meta.models.global.reason, /same-source ask/);
});

test('model registry disables bundles that could include pre-deadline candle approximations', () => {
  const normalized = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    meta: { activeModels: 1, models: { global: { active: true, accepted: true } } },
    outcomes: { active: true, samples: 300 } });
  assert.equal(normalized.outcomeEvidenceCompatible, false);
  assert.equal(normalized.meta.activeModels, 0);
  assert.equal(normalized.outcomes.active, false);
  assert.match(normalized.meta.models.global.reason, /pre-deadline candle-close approximation/);
});

test('model registry disables models trained on unpinned legacy outcome labels', () => {
  const normalized = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION - 1,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    meta: { activeModels: 1, models: { global: { active: true, accepted: true } } },
    outcomes: { active: true, samples: 300 } });
  assert.equal(normalized.labelSchemaCompatible, false);
  assert.equal(normalized.meta.activeModels, 0);
  assert.equal(normalized.meta.models.global.active, false);
  assert.equal(normalized.outcomes.active, false);
  assert.match(normalized.meta.models.global.reason, /source-pinned/);
});

test('model readiness reports current-schema labels separately from a disabled stored model', () => {
  const stale = normalizeModelBundle({ labelVersion: RESEARCH_LABEL_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION - 1,
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION,
    outcomeEvidenceVersion: RESEARCH_OUTCOME_EVIDENCE_VERSION,
    meta: { activeModels: 1, models: { global: { active: true } } } });
  const status = summarizeModelReadiness({ production: stale }, { eligibleLabeled: 37 }, { metaMinSamples: 200 });
  assert.equal(status.currentFeatureSchema, FEATURE_SCHEMA_VERSION);
  assert.equal(status.productionFeatureSchema, FEATURE_SCHEMA_VERSION - 1);
  assert.equal(status.schemaCompatible, false);
  assert.equal(status.eligibleSamples, 37);
  assert.equal(status.minimumSamples, 200);
  assert.equal(status.canMeetMinimumSamples, false);
  const untrained = summarizeModelReadiness({}, { eligibleLabeled: 200 }, { metaMinSamples: 200 });
  assert.equal(untrained.productionFeatureSchema, null);
  assert.equal(untrained.schemaCompatible, null);
  assert.equal(untrained.canMeetMinimumSamples, true);
});

test('public WebSocket provider frames normalize to one quote shape', () => {
  assert.deepEqual(parseBinanceMessage({ s: 'BTCUSDT', b: '100', a: '102' }), {
    provider: 'Binance WS', symbol: 'BTC', bid: 100, ask: 102, price: 101
  });
  assert.equal(parseCoinbaseMessage({ type: 'ticker', product_id: 'ETH-USD', price: '50', best_bid: '49', best_ask: '51' }).symbol, 'ETH');
  assert.equal(parseKrakenMessage({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 99, ask: 101, last: 100 }] }).price, 100);
  const kraken = parseKrakenMessage({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 99, ask: 101, last: 100, timestamp: '2026-09-30T14:00:00.123Z' }] });
  assert.equal(kraken.providerObservedAt, '2026-09-30T14:00:00.123Z');
  assert.equal(kraken.timestampBasis, 'provider_event');
  assert.equal(kraken.base, 'BTC');
  assert.equal(kraken.target, 'USD');
  assert.equal(parseKrakenMessage({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 99, ask: 101, last: 100, timestamp: 'invalid' }] }).providerObservedAt, null);
});

test('Kraken realtime quote retains source time separately from local receive time', () => {
  const hub = new RealtimeMarketHub({ enabled: false });
  const providerObservedAt = new Date(Date.now() - 250).toISOString();
  hub.recordQuote({ provider: 'Kraken WS', symbol: 'BTC', pair: 'BTC/USD', base: 'BTC', target: 'USD',
    bid: 99, ask: 101, price: 100, providerObservedAt, timestampBasis: 'provider_event' });
  const quote = hub.getExecutableKrakenQuote('BTC');
  assert.equal(quote.provider, 'Kraken');
  assert.equal(quote.observedAt, providerObservedAt);
  assert.ok(Date.parse(quote.receivedAt) >= Date.parse(providerObservedAt));
  assert.ok(Date.parse(hub.getConsensus('BTC').quotes[0].receivedAt) >= Date.parse(providerObservedAt));
  hub.recordQuote({ provider: 'Kraken WS', symbol: 'ETH', bid: 9, ask: 11, price: 10, timestampBasis: 'unknown' });
  assert.equal(hub.getExecutableKrakenQuote('ETH'), null);
  hub.stop();
});

test('Kraken warmup waits only for fresh source-timestamped quotes and stays bounded', async () => {
  const hub = new RealtimeMarketHub();
  const waiting = hub.waitForExecutableKrakenQuotes(['CRO'], { timeoutMs: 100 });
  let settled = false;
  void waiting.then(() => { settled = true; });
  hub.recordQuote({ provider: 'Kraken WS', symbol: 'CRO', bid: 9, ask: 11, price: 10,
    timestampBasis: 'unknown' });
  hub.recordQuote({ provider: 'Kraken WS', symbol: 'CRO', bid: 9, ask: 11, price: 10,
    providerObservedAt: new Date(Date.now() - 360_000).toISOString(), timestampBasis: 'provider_event' });
  await Promise.resolve();
  assert.equal(settled, false, 'receipt-time-only and stale quotes must not end warmup');
  hub.recordQuote({ provider: 'Kraken WS', symbol: 'CRO', bid: 9, ask: 11, price: 10,
    providerObservedAt: new Date().toISOString(), timestampBasis: 'provider_event' });
  const ready = await waiting;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, 1);
  const missing = await hub.waitForExecutableKrakenQuotes(['MISSING'], { timeoutMs: 10 });
  assert.equal(missing.status, 'partial_or_unavailable');
  assert.equal(missing.ready, 0);
  hub.stop();
});

test('derivatives aggregation rewards agreement and vetoes extreme long crowding', () => {
  const normal = aggregateDerivatives([
    { provider: 'Kraken Futures', markPrice: 100.1, indexPrice: 100, fundingAnnualizedPct: 8, openInterestChangePct: 1, longShortRatio: 1.1, takerBuySellRatio: 1.2, openInterestUsd: 1_000_000 },
    { provider: 'Deribit', markPrice: 100.2, indexPrice: 100, fundingAnnualizedPct: 10, openInterestChangePct: 1.5, openInterestUsd: 500_000 }
  ], 100);
  assert.equal(normal.providerCount, 2);
  assert.equal(normal.blockLongs, false);
  assert.ok(normal.score > 50);

  const crowded = aggregateDerivatives([
    { provider: 'Test', markPrice: 104, indexPrice: 100, fundingAnnualizedPct: 120, openInterestChangePct: 12, longShortRatio: 3.5, takerBuySellRatio: 2 }
  ], 100);
  assert.equal(crowded.blockLongs, true);
  assert.ok(crowded.score < normal.score);
});

test('open-interest delta requires two distinct fresh points and preserves a measured zero change', () => {
  const now = Date.parse('2026-09-24T12:10:00Z');
  assert.deepEqual(summarizeOpenInterestHistory([{ sumOpenInterestValue: 100, timestamp: now - 300_000 }], { now }), {
    openInterestChangePct: 0, openInterestChangeAvailable: false
  });
  assert.deepEqual(summarizeOpenInterestHistory([
    { sumOpenInterestValue: 100, timestamp: now - 600_000 }, { sumOpenInterestValue: 100, timestamp: now - 300_000 }
  ], { now }), {
    openInterestChangePct: 0, openInterestChangeAvailable: true
  });
  assert.equal(summarizeOpenInterestHistory([
    { sumOpenInterestValue: 100, timestamp: now - 600_000 }, { sumOpenInterestValue: 125, timestamp: now - 300_000 }
  ], { now }).openInterestChangePct, 25);
  assert.equal(summarizeOpenInterestHistory([
    { sumOpenInterestValue: 100, timestamp: now - 300_000 }, { sumOpenInterestValue: 125, timestamp: now - 300_000 }
  ], { now }).openInterestChangeAvailable, false);
  assert.equal(summarizeOpenInterestHistory([
    { sumOpenInterestValue: 100, timestamp: now - 1_500_000 }, { sumOpenInterestValue: 125, timestamp: now - 960_000 }
  ], { now }).openInterestChangeAvailable, false);
  assert.equal(aggregateDerivatives([]).openInterestChangeAvailable, false);
  const snapshotsOnly = aggregateDerivatives([
    { provider: 'Kraken Futures', markPrice: 100, indexPrice: 100, fundingAnnualizedPct: 0, openInterestUsd: 1_000_000,
      openInterestChangePct: 25, openInterestChangeAvailable: false },
    { provider: 'Deribit', markPrice: 100, indexPrice: 100, fundingAnnualizedPct: 0, openInterestUsd: 2_000_000,
      openInterestChangePct: -15, openInterestChangeAvailable: false }
  ]);
  assert.equal(snapshotsOnly.openInterestChangeAvailable, false);
  assert.equal(snapshotsOnly.openInterestChangePct, 0);
});

test('portfolio gate rejects highly correlated duplicate exposure and enforces the cap', () => {
  const path = Array.from({ length: 60 }, (_, index) => 100 * (1.002 ** index) * (1 + Math.sin(index / 4) * 0.01));
  const first = { id: 'a', symbol: 'AAA', sparkline: path, model: { score: 90 } };
  const duplicate = { id: 'b', symbol: 'BBB', sparkline: path.map((value) => value * 2), model: { score: 89 } };
  assert.ok(assetCorrelation(first, duplicate) > 0.99);
  const result = applyPortfolioRisk([first, duplicate], [], [first, duplicate], { maxConcurrentSignals: 3, maxSignalCorrelation: 0.82 });
  assert.deepEqual(result.selected.map((asset) => asset.symbol), ['AAA']);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.correlationDiagnostics.usedForApproval, false);
  assert.equal(result.correlationDiagnostics.comparablePairs, 1);
  assert.equal(result.correlationDiagnostics.aboveConfiguredThreshold, 1);
});

test('correlation diagnostics keep incomplete or unaligned sparkline samples unknown', () => {
  const complete = Array.from({ length: 30 }, (_, index) => 100 * (1 + index / 100));
  assert.equal(diagnoseAssetCorrelation({ sparkline: complete }, { sparkline: [...complete] }).status, 'available');
  assert.equal(diagnoseAssetCorrelation({ sparkline: complete }, { sparkline: complete.slice(1) }).reason, 'unaligned_sparkline_length');
  const gapped = [...complete]; gapped[12] = null;
  assert.equal(diagnoseAssetCorrelation({ sparkline: complete }, { sparkline: gapped }).reason, 'invalid_or_gapped_sparkline');
  assert.equal(diagnoseAssetCorrelation({ sparkline: complete.slice(0, 12) }, { sparkline: complete.slice(0, 12) }).reason, 'insufficient_sparkline_history');
  assert.equal(diagnoseAssetCorrelation({ sparkline: [] }, { sparkline: complete }).reason, 'missing_sparkline');
});

test('correlation diagnostics flag when the legacy approval estimate uses misaligned samples', () => {
  const path = Array.from({ length: 60 }, (_, index) => 100 * (1.002 ** index) * (1 + Math.sin(index / 4) * 0.01));
  const first = { id: 'a', symbol: 'AAA', sparkline: path, model: { score: 90 } };
  const misaligned = { id: 'b', symbol: 'BBB', sparkline: path.slice(1), model: { score: 89 } };
  const result = applyPortfolioRisk([first, misaligned], [], [first, misaligned], { maxConcurrentSignals: 3, maxSignalCorrelation: 0.82 });
  assert.deepEqual(result.selected.map((asset) => asset.symbol), ['AAA']);
  assert.equal(result.rejected[0].asset.symbol, 'BBB', 'legacy production approval behavior remains unchanged');
  assert.equal(result.correlationDiagnostics.unavailablePairs, 1);
  assert.equal(result.correlationDiagnostics.approvalFlagsOnUnavailableData, 1);
});

test('risk guard shuts down after negative edge, drawdown, and probability drift', () => {
  const predictions = Array.from({ length: 24 }, (_, index) => ({
    status: index % 5 === 0 ? 'target_hit' : 'loss', realizedR: index % 5 === 0 ? 0.5 : -1,
    probability: 0.75, completedAt: new Date(Date.now() - (24 - index) * 60_000).toISOString()
  }));
  const guard = evaluateRiskGuard(predictions, {
    guardLookbackHours: 168, guardRollingWindow: 30, guardMinOutcomes: 20,
    guardMinExpectancyR: 0, guardMaxDrawdownR: 5, guardMaxBrier: 0.28
  });
  assert.equal(guard.allowNewSignals, false);
  assert.ok(guard.reasons.length >= 2);
});

test('append-only shadow events materialize one resolved training observation', () => {
  const events = [
    { type: 'shadow_created', observationId: 'x', timestamp: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', features: { score: 70 }, setupFamily: 'snapshot_momentum', productionBundleId: 'bundle-1' },
    { type: 'shadow_resolved', observationId: 'x', timestamp: '2026-01-01T02:00:00Z', label: 1, realizedR: 1.5 }
  ];
  const [row] = materializeObservations(events);
  assert.equal(row.features.score, 70);
  assert.equal(row.setupFamily, 'snapshot_momentum');
  assert.equal(row.productionBundleId, 'bundle-1');
  assert.equal(row.resolution.label, 1);
});

test('trade and level-2 frames produce microstructure flow, depth, and spread features', () => {
  assert.equal(parseBinanceEvents({ e: 'aggTrade', s: 'BTCUSDT', p: '100', q: '2', m: false })[0].side, 'buy');
  assert.equal(parseCoinbaseEvents({ type: 'snapshot', product_id: 'BTC-USD', bids: [['99', '4']], asks: [['101', '2']] })[0].kind, 'book_delta');
  assert.equal(parseCoinbaseEvents({ type: 'match', product_id: 'BTC-USD', price: '100', size: '1', side: 'sell' })[0].side, 'buy');
  assert.deepEqual(parseKrakenEvents({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99, qty: 3 }], asks: [{ price: 101, qty: 1 }] }] })[0].bids[0], [99, 3]);

  const accumulator = new MicrostructureAccumulator('BTC');
  for (let index = 0; index < 12; index += 1) {
    accumulator.recordQuote({ provider: 'Test', bid: 99.9 + index * 0.01, ask: 100.1 + index * 0.01 });
    accumulator.recordTrade({ provider: 'Test', price: 100 + index * 0.01, size: 2, side: index < 9 ? 'buy' : 'sell' });
  }
  accumulator.recordBook({ provider: 'Test', bids: [[99.9, 20], [99.5, 30]], asks: [[100.1, 5], [100.5, 10]] });
  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.available, true);
  assert.ok(snapshot.orderFlowImbalance > 0);
  assert.ok(snapshot.depthImbalance > 0);
  assert.ok(snapshot.spreadBps > 0);
});

test('execution simulator blocks thin expensive markets and stress-tests expectancy', () => {
  const thin = estimateExecutionCost({ marketData: {
    microstructure: { available: true, spreadBps: 45, depthUsd1Pct: 2_000, quoteVolatilityBps: 12, orderFlowImbalance: -0.8, depthImbalance: -0.7 },
    technicals: { atrPct: 2 }
  } }, { simulatedOrderUsd: 1000, executionLatencyMs: 750, estimatedRoundTripBps: 20, maxExecutionSlippageBps: 35 });
  assert.equal(thin.blockTrade, true);
  const stress = monteCarloCostStress(Array.from({ length: 50 }, () => ({ realizedR: 0.8, stopPct: 2 })), { iterations: 500, baseCostBps: 20 });
  assert.equal(stress.passed, true);
  assert.equal(stress.probabilityPositive, 1);
  assert.equal(resolveModelCostStressSettings({ estimatedRoundTripBps: 0 }).baseCostBps, 0);
  assert.equal(resolveModelCostStressSettings({}).baseCostBps, 20);
  assert.equal(resolveModelCostStressSettings({ estimatedRoundTripBps: 'invalid' }).baseCostBps, 20);
  assert.equal(monteCarloCostStress([{ realizedR: 0.8, stopPct: 2 }], { iterations: 100, baseCostBps: 0 }).baseCostBps, 0);
});

test('options surface summarizes skew, term structure, DVOL, and liquidations', () => {
  const rows = [];
  for (const expiry of ['10AUG26', '25SEP26']) {
    for (const [strike, type, iv] of [[58000, 'P', 65], [62000, 'P', 60], [68000, 'C', 50], [72000, 'C', 48]]) {
      rows.push({ instrument_name: `BTC-${expiry}-${strike}-${type}`, mark_iv: iv, underlying_price: 65000, open_interest: 100, volume: 10 });
    }
  }
  const summary = summarizeOptionsSurface(rows, [[1, 40, 41, 39, 40], [2, 42, 43, 41, 42]], [
    { liquidation: 'M', direction: 'sell', amount: 100, price: 65000 }
  ], new Date('2026-08-03T12:00:00Z'));
  assert.equal(summary.available, false); // Eight contracts are deliberately below the production coverage threshold.
  assert.ok(summary.putCallSkewIv > 0);
  assert.equal(summary.dvol, 42);
  assert.ok(summary.liquidationUsd1h > 0);
});

test('event-risk evaluator blocks symbol-specific and market-wide windows only while active', () => {
  const now = new Date('2026-08-03T12:00:00Z');
  const events = [
    { symbol: 'BTC', severity: 'block', reason: 'network incident', startsAt: '2026-08-03T11:00:00Z', endsAt: '2026-08-03T13:00:00Z' },
    { symbol: '*', severity: 'caution', reason: 'exchange maintenance', startsAt: '2026-08-03T11:00:00Z', endsAt: '2026-08-03T13:00:00Z' }
  ];
  assert.equal(evaluateEventRisk({ symbol: 'BTC' }, events, now).blocked, true);
  assert.equal(evaluateEventRisk({ symbol: 'ETH' }, events, now).blocked, false);
  assert.equal(evaluateEventRisk({ symbol: 'ETH' }, events, now).caution, true);
});

test('Crypto event severity copy matches block, learned caution-feature, and observe-only behavior', () => {
  const caution = extractModelFeatures({ marketData: { eventRisk: { caution: true } } });
  const observe = extractModelFeatures({ marketData: { eventRisk: { observe: true } } });
  const block = extractModelFeatures({ marketData: { eventRisk: { blocked: true } } });
  assert.equal(caution.eventCaution, 1);
  assert.equal(observe.eventCaution, 0);
  assert.equal(block.eventCaution, 0);

  const command = buildCommands().find((item) => item.name === 'crypto');
  const event = command.options.find((item) => item.name === 'event');
  const severity = event.options.find((item) => item.name === 'severity');
  assert.match(severity.description, /caution is a model feature/i);
  assert.match(severity.choices.find((choice) => choice.value === 'observe').name, /no gate effect/i);
});

test('derivatives model features distinguish fresh crowding ratios from unavailable zero values', () => {
  const fresh = extractModelFeatures({ marketData: { derivatives: {
    longShortRatio: 1.4, longShortRatioAvailable: true,
    takerBuySellRatio: 1.2, takerBuySellRatioAvailable: true
  } } });
  const unavailable = extractModelFeatures({ marketData: { derivatives: {
    longShortRatio: 0, longShortRatioAvailable: false,
    takerBuySellRatio: 0, takerBuySellRatioAvailable: false
  } } });
  assert.equal(fresh.longShortRatioAvailable, 1);
  assert.equal(fresh.takerBuySellRatioAvailable, 1);
  assert.equal(unavailable.longShortRatio, 0);
  assert.equal(unavailable.longShortRatioAvailable, 0);
  assert.equal(unavailable.takerBuySellRatio, 0);
  assert.equal(unavailable.takerBuySellRatioAvailable, 0);
  assert.equal(FEATURE_SCHEMA_VERSION, 3);
});

test('manual Crypto catalysts retain explicit classification, timing, source, and legacy unknowns', () => {
  const event = normalizedEvent({ symbol: 'eth', severity: 'caution', eventType: 'token_unlock', direction: 'negative',
    expectedness: 'scheduled', horizon: 'swing', impact: 'high', sourceUrl: 'https://example.org/unlock',
    reason: 'Scheduled token release', startsAt: '2026-08-03T12:00:00Z', endsAt: '2026-08-03T15:00:00Z' });
  assert.equal(event.symbol, 'ETH');
  assert.equal(event.eventType, 'token_unlock');
  assert.equal(event.direction, 'negative');
  assert.equal(event.expectedness, 'scheduled');
  assert.equal(event.horizon, 'swing');
  assert.equal(event.impact, 'high');
  assert.equal(event.sourceUrl, 'https://example.org/unlock');
  const legacy = normalizedEvent({ symbol: 'BTC', startsAt: '2026-08-03T12:00:00Z', endsAt: '2026-08-03T13:00:00Z' });
  assert.deepEqual([legacy.eventType, legacy.direction, legacy.expectedness, legacy.horizon, legacy.impact], ['other', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(normalizedEvent({ sourceUrl: 'http://example.org/source', startsAt: '2026-08-03T12:00:00Z', endsAt: '2026-08-03T13:00:00Z' }).sourceUrl, '');
  assert.equal(normalizedEvent({ sourceUrl: 'https://user:pass@example.org/source', startsAt: '2026-08-03T12:00:00Z', endsAt: '2026-08-03T13:00:00Z' }).sourceUrl, '');
  const observeOnly = normalizedEvent({ severity: 'observe', symbol: 'ETH', startsAt: '2026-08-03T12:00:00Z', endsAt: '2026-08-03T15:00:00Z' });
  const gate = evaluateEventRisk({ symbol: 'ETH' }, [observeOnly], new Date('2026-08-03T13:00:00Z'));
  assert.equal(gate.observe, true);
  assert.equal(gate.blocked, false);
  assert.equal(gate.caution, false);
});

test('outcome bundle predicts target-before-stop, event time, and return distribution after blind validation', () => {
  const rows = observations(320).map((row, index) => {
    const target = row.label === 1;
    return {
      ...row, targetLabel: target ? 1 : 0, realizedR: target ? 1.6 + index % 3 * 0.1 : -1,
      timeToEventMinutes: target ? 70 + index % 5 : 180 + index % 7,
      maxFavorableExcursionR: target ? 2.1 : 0.25, maxAdverseExcursionR: target ? -0.25 : -1.2
    };
  });
  const malformedRows = [
    { ...rows[0], observationId: 'null-realizedR', realizedR: null },
    { ...rows[1], observationId: 'null-target', targetLabel: null },
    { ...rows[2], observationId: 'missing-event-time', timeToEventMinutes: null },
    { ...rows[3], observationId: 'null-favorable-excursion', maxFavorableExcursionR: null },
    { ...rows[4], observationId: 'null-adverse-excursion', maxAdverseExcursionR: null },
  ];
  const bundle = trainOutcomeModelBundle([...rows, ...malformedRows], { minimumSamples: 200, validationFolds: 4, blindHoldoutFraction: 0.15 });
  assert.equal(bundle.samples, rows.length, 'incomplete direct inputs are excluded rather than imputed as zero');
  assert.equal(bundle.active, true);
  const strong = predictOutcomeDistribution(bundle, { technicalScore: 90, providerQuality: 95, rsi14: 60 });
  const weak = predictOutcomeDistribution(bundle, { technicalScore: 25, providerQuality: 40, rsi14: 35 });
  assert.ok(strong.targetProbability > weak.targetProbability);
  assert.ok(strong.returnR.median > weak.returnR.median);
  assert.ok(strong.timeMinutes.median < weak.timeMinutes.median);
});

test('champion/challenger comparison promotes only on fresh Brier improvement', () => {
  const rows = observations(260);
  const challengerModel = trainBoostedModel(rows, { minimumSamples: 200, rounds: 24 });
  const constantModel = {
    active: true, baseScore: 0, stats: FEATURE_NAMES.map((name) => ({ name, mean: 0, scale: 1 })), stumps: []
  };
  const comparison = compareBundles(
    { meta: { models: { global: constantModel } } },
    { meta: { models: { global: challengerModel } } },
    rows.slice(-60), { challengerBrierImprovement: 0.005 }
  );
  assert.equal(comparison.promoted, true);
  assert.ok(comparison.challengerMetrics.brier < comparison.productionMetrics.brier);
});

test('direct meta-model training does not count null, invalid, or non-binary labels as negative samples', () => {
  const valid = observations(39);
  const malformed = observations(60).map((row, index) => ({ ...row, observationId: `bad-${index}`, label: index % 3 === 0 ? null : 2 }));
  const model = trainBoostedModel([...valid, ...malformed], { minimumSamples: 40 });
  assert.equal(model.active, false);
  assert.equal(model.samples, 39);
});
