import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrediction, calibrateTargetProbability, evaluatePrediction, mergeNewPredictions, selectTradeHorizon, summarizePerformance, summarizeProbabilityReliability } from '../src/predictionEngine.js';
import { analyzeMomentum, pendingConfirmationRejections, scoreAsset, selectConfirmationAdvisoryCandidates, updateCandidateConfirmations } from '../src/stocksData.js';
import { isDailyDiscoveryDue, isDailyReviewDue, isUsEquityHoliday, marketCloseTime, marketSession, shouldScanConfiguredUniverse } from '../src/time.js';

function stock(overrides = {}) {
  const row = {
    id: 'NVDA', symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NMS', sector: 'XLK', price: 150,
    previousClose: 147, change1h: 1.4, changeDay: 2.04, change5d: 5.5, highDay: 151, lowDay: 146,
    previous20High: 150.5, volumeToday: 35_000_000, averageDailyVolume: 42_000_000, relativeVolume: 1.75,
    rsi14: 64, macd: 1.15, ema9: 149.2, ema21: 147.8, atrPercent: 1.8,
    macdSignal: 0.9, macdHistogram: 0.25, dailyRsi14: 61, dailyMacdHistogram: 0.4,
    dailySma20: 145, dailySma50: 138, dailySma200: 120, dailyAtrPercent: 2.1,
    vwap: 149.4, vwapDistancePct: 0.40, adx14: 26, change20d: 9,
    relativeStrengthDay: 1.2, relativeStrength5d: 2.4, sectorRelativeStrength: 0.9,
    marketBreadth: 63, advancingBreadth: 58, dataQuality: 82, providerQuoteCount: 2,
    marketMove: 0.65, marketRegime: 'mixed', sectorChange: 1.1, provider: 'Yahoo Chart',
    crossCheckProvider: 'Finnhub', providerAgreement: 98, freshness: 'live/delayed', delayed: true,
    lastUpdated: '2026-07-21T15:00:00.000Z', ...overrides
  };
  return { ...row, model: scoreAsset(row) };
}

test('Auralith model scores stronger momentum above weak conditions', () => {
  const strong = stock();
  const weak = stock({ change1h: -2.2, changeDay: -4, change5d: -8, relativeVolume: 0.3, rsi14: 34, macd: -2, ema9: 141, ema21: 148, marketMove: -1.5, sectorChange: -2 });
  assert.ok(strong.model.score > weak.model.score);
  assert.deepEqual(Object.keys(strong.model).filter((key) => ['trend','volume','oscillator','breakout','sector','regime'].includes(key)).sort(), ['breakout','oscillator','regime','sector','trend','volume']);
});

test('screen keeps below-threshold names watch-only instead of manufacturing a signal', () => {
  const candidate = stock({ freshness: 'live/delayed', relativeVolume: 0.7 });
  candidate.model = scoreAsset(candidate);
  const settings = { minPrice: 2, minAverageVolume: 500_000, minScore: 80, maxSignals: 5 };
  const analysis = analyzeMomentum({ assets: [candidate] }, settings);
  assert.equal(analysis.candidates.length, 0);
  assert.equal(analysis.watchCandidates.length, 1);
  assert.equal(analysis.watchCandidates[0].selectionTier, 'watch_only');
  assert.equal(analysis.diagnostics.selectedMode, 'watch_only');
});

test('watch-only diagnostics never include stale data as a signal', () => {
  const candidate = stock({ freshness: 'stale', relativeVolume: 1.2 });
  candidate.model = scoreAsset(candidate);
  const settings = { minPrice: 2, minAverageVolume: 500_000, minScore: 95, maxSignals: 5 };
  const analysis = analyzeMomentum({ assets: [candidate] }, settings);
  assert.equal(analysis.candidates.length, 0);
  assert.equal(analysis.diagnostics.staleAssets, 1);
});

test('configured ETF/ETP watchlist rows remain visible but cannot become Stocks watches or setups', () => {
  const assets = [stock({ symbol: 'NVDA', id: 'NVDA' }), stock({ symbol: 'BND', id: 'BND' }),
    stock({ symbol: 'ETN1', id: 'ETN1' }), stock({ symbol: 'SPY', id: 'SPY' })];
  const ownership = { status: 'available', ownedSymbols: ['BND'], blockedSymbols: ['ETN1'] };
  const analysis = analyzeMomentum({ assets, ownership }, { minPrice: 2, minAverageVolume: 500_000, minScore: 45, maxSignals: 5 });
  assert.equal(analysis.diagnostics.marketContext, 1);
  assert.equal(analysis.diagnostics.ownershipExcluded, 2);
  assert.equal(analysis.diagnostics.instruments, 1);
  assert.deepEqual(analysis.candidates.map((row) => row.symbol), ['NVDA']);
  assert.ok(analysis.watchCandidates.every((row) => !['BND', 'ETN1'].includes(row.symbol)));
  assert.deepEqual(analysis.rejectionRecords.find((row) => row.symbol === 'BND').reasonCodes, ['primary_owner_etf_etp']);
  assert.deepEqual(analysis.rejectionRecords.find((row) => row.symbol === 'ETN1').reasonCodes, ['unreviewed_etp_classification']);
  const unavailable = analyzeMomentum({ assets, ownership: { status: 'unavailable' } },
    { minPrice: 2, minAverageVolume: 500_000, minScore: 45, maxSignals: 5 });
  assert.equal(unavailable.diagnostics.instruments, 0);
  assert.equal(unavailable.diagnostics.rejectedByReason.ownership_classification_unavailable, 3);
});

test('high velocity setup receives a short intraday horizon', () => {
  const row = stock({ relativeVolume: 2.5, change1h: 2.4, ema9: 153, ema21: 145, rsi14: 68, macd: 2.1 });
  row.model.score = 88;
  assert.equal(selectTradeHorizon(row).minutes, 30);
});

test('prediction has bounded risk, two targets, and an explicit conditional entry', () => {
  const prediction = buildPrediction(stock(), { allowRuleOnlySignals: true }, 'guild', new Date('2026-07-21T15:00:00Z'));
  assert.ok(prediction.stopPrice < prediction.entryLow);
  assert.ok(prediction.targetPrice > prediction.entryHigh);
  assert.ok(prediction.exceedPrice > prediction.targetPrice);
  assert.ok(prediction.riskReward >= 0.5);
  assert.match(prediction.buyCondition, /do not chase/i);
  assert.match(prediction.disclaimer, /paper tracking/i);
});

test('paper predictions freeze event-feed coverage and clear stale macro values when coverage disappears', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const complete = buildPrediction(stock({ secDataStatus: 'available', corporateActionDataStatus: 'available', macroDataStatus: 'partial', macroComponentsAvailable: 1, macroStress: 22 }), {}, 'guild', start);
  assert.equal(complete.secDataStatus, 'available');
  assert.equal(complete.corporateActionDataStatus, 'available');
  assert.equal(complete.macroDataStatus, 'partial');
  assert.equal(complete.macroComponentsAvailable, 1);
  assert.equal(complete.macroStress, 22);

  const missing = evaluatePrediction(complete, stock({ secDataStatus: 'provider_error', corporateActionDataStatus: 'credentials_missing', macroDataStatus: 'credentials_missing', macroStress: null }), new Date(start.getTime() + 60_000));
  assert.equal(missing.prediction.secDataStatus, 'provider_error');
  assert.equal(missing.prediction.corporateActionDataStatus, 'credentials_missing');
  assert.equal(missing.prediction.macroDataStatus, 'credentials_missing');
  assert.equal(missing.prediction.macroStress, null);

  const unknown = buildPrediction(stock(), {}, 'guild', start);
  assert.equal(unknown.macroStress, null);
});

test('manual catalyst metadata never changes the production model score or setup decision', () => {
  const now = new Date('2026-07-21T15:00:00Z');
  const plain = buildPrediction(stock(), { allowRuleOnlySignals: true }, 'guild', now);
  const tagged = buildPrediction(stock({ manualCatalysts: [{ eventType: 'earnings', direction: 'negative', expectedness: 'scheduled',
    horizon: 'intraday', impact: 'high', reason: 'Fixture only', sourceUrl: 'https://example.com' }] }), { allowRuleOnlySignals: true }, 'guild', now);
  for (const key of ['score', 'action', 'entryPrice', 'stopPrice', 'targetPrice', 'riskReward']) assert.equal(tagged[key], plain[key]);
  assert.equal(tagged.manualCatalysts.length, 1);
});

test('rule-only setup abstains by default until a validated champion exists', () => {
  const prediction = buildPrediction(stock(), { allowRuleOnlySignals: false }, 'guild', new Date('2026-07-21T15:00:00Z'));
  assert.match(prediction.action, /DO NOT OPEN/i);
  assert.match(prediction.buyCondition, /No validated champion/i);
});

test('stop before target grades red loss', () => {
  const prediction = buildPrediction(stock(), {}, 'guild', new Date('2026-07-21T15:00:00Z'));
  const result = evaluatePrediction(prediction, stock({ price: prediction.stopPrice * 0.999 }), new Date('2026-07-21T15:10:00Z'));
  assert.equal(result.prediction.status, 'loss');
  assert.equal(result.events[0].color, 'red');
});

test('continued monitoring warns when a live setup is halted', () => {
  const prediction = buildPrediction(stock(), { allowRuleOnlySignals: true }, 'guild', new Date('2026-07-21T15:00:00Z'));
  const result = evaluatePrediction(prediction, stock({ halted: true, tradingStatus: { reason: 'Regulatory halt' } }), new Date('2026-07-21T15:05:00Z'));
  assert.equal(result.events[0].type, 'risk_warning');
  assert.match(result.prediction.action, /HALTED/);
  assert.match(result.events[0].description, /Regulatory halt/);
});

test('target one enters green trailing observation and target two grades blue', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const prediction = buildPrediction(stock(), {}, 'guild', start);
  let result = evaluatePrediction(prediction, stock({ price: prediction.targetPrice * 1.001 }), new Date(start.getTime() + 10 * 60_000));
  assert.equal(result.prediction.status, 'target_tracking');
  assert.equal(result.events[0].color, 'green');
  result = evaluatePrediction(result.prediction, stock({ price: prediction.exceedPrice * 1.001 }), new Date(start.getTime() + 15 * 60_000));
  assert.equal(result.prediction.status, 'exceeded');
  assert.equal(result.events[0].color, 'blue');
});

test('round-trip commission reduces the stock replay net return while default behavior stays unchanged', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const baseline = buildPrediction(stock(), { assumedSlippageBps: 0 }, 'guild', start);
  const costed = buildPrediction(stock(), { assumedSlippageBps: 0, commissionBpsPerSide: 10,
    executionCostContext: { id: 'broker-fees', feeBpsPerSide: 10, source: 'https://data.example.com/fees' } }, 'guild', start);
  const closeAtTarget2 = (prediction) => {
    let result = evaluatePrediction(prediction, stock({ price: prediction.targetPrice * 1.001 }), new Date(start.getTime() + 10 * 60_000));
    result = evaluatePrediction(result.prediction, stock({ price: prediction.exceedPrice * 1.001 }), new Date(start.getTime() + 15 * 60_000));
    return result.prediction;
  };
  const baselineOutcome = closeAtTarget2(baseline);
  const costedOutcome = closeAtTarget2(costed);
  assert.equal(baselineOutcome.commissionBpsPerSide, 0);
  assert.ok(Math.abs(costedOutcome.netReturnPct - baselineOutcome.netReturnPct + 0.2) < 0.0001);
  assert.equal(costedOutcome.executionCostContext.id, 'broker-fees');
});

test('configured per-share round-trip fees are reflected in stock paper outcomes and missing fees are identified', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const asset = stock({ price: 100 });
  const configured = buildPrediction(asset, { assumedSlippageBps: 0,
    sharedPaperRoundTripFeesPerShare: 0.02, sharedPaperCostAssumptionsConfigured: true }, 'guild', start);
  const missing = buildPrediction(asset, { assumedSlippageBps: 0,
    sharedPaperRoundTripFeesPerShare: NaN, sharedPaperCostAssumptionsConfigured: false }, 'guild', start);
  assert.equal(configured.roundTripFeesPerShare, 0.02);
  assert.equal(configured.commissionBpsPerSide, 1);
  assert.equal(configured.executionFeeAssumptionConfigured, true);
  assert.equal(missing.roundTripFeesPerShare, null);
  assert.equal(missing.executionFeeAssumptionConfigured, false);
});

test('deadline grades nonnegative shortfall yellow and negative close red', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const prediction = buildPrediction(stock(), {}, 'guild', start);
  let result = evaluatePrediction(prediction, stock({ price: prediction.entryPrice * 1.001 }), new Date(prediction.deadlineAt));
  assert.equal(result.prediction.status, 'fell_short');
  assert.equal(result.events[0].color, 'yellow');
  const second = { ...prediction, id: `${prediction.id}-loss` };
  result = evaluatePrediction(second, stock({ price: prediction.entryPrice * 0.999 }), new Date(prediction.deadlineAt));
  assert.equal(result.prediction.status, 'loss');
});

test('daily merge prevents duplicate ticker signals', () => {
  const prediction = buildPrediction(stock(), {}, 'guild', new Date('2026-07-21T15:00:00Z'));
  const first = mergeNewPredictions({ guildId: 'guild', predictions: [] }, [prediction]);
  const second = mergeNewPredictions(first, [prediction]);
  assert.equal(first.added.length, 1); assert.equal(second.added.length, 0); assert.equal(second.predictions.length, 1);
});

test('candidate must persist across the configured number of scans', () => {
  const row = stock();
  const first = updateCandidateConfirmations({}, [row], { now: new Date('2026-07-21T15:00:00Z'), required: 2, discoveryMinutes: 15 });
  assert.equal(first.confirmed.length, 0);
  const second = updateCandidateConfirmations(first.states, [row], { now: new Date('2026-07-21T15:15:00Z'), required: 2, discoveryMinutes: 15 });
  assert.equal(second.confirmed.length, 1);
  assert.equal(second.confirmed[0].confirmationCount, 2);
});

test('pending confirmation diagnostics include only candidates that still fail the configured scan count', () => {
  const candidates = [{ symbol: 'A' }, { symbol: 'B' }];
  assert.deepEqual(pendingConfirmationRejections(candidates, { A: { consecutive: 1 }, B: { consecutive: 2 } }, 2), [
    { symbol: 'A', stage: 'confirmation', reasonCodes: ['confirmation_scans_pending'], reasons: ['1/2 consecutive qualifying scans'] },
  ]);
  assert.deepEqual(pendingConfirmationRejections(candidates, {}, 2).map((row) => row.reasonCodes[0]), [
    'confirmation_scans_pending', 'confirmation_scans_pending',
  ]);
});

test('confirmation advisory cohort only relaxes persistence for otherwise model-approved candidates', () => {
  const candidates = [
    { symbol: 'A', ensemble: { decision: 'BUY' } },
    { symbol: 'B', ensemble: { decision: 'NO_TRADE' } },
    { symbol: 'C', ensemble: { decision: 'RULE_ONLY' } },
  ];
  assert.deepEqual(selectConfirmationAdvisoryCandidates(candidates, [{ symbol: 'A' }], { required: 2 }), []);
  assert.deepEqual(selectConfirmationAdvisoryCandidates(candidates, [], { required: 2 }), [candidates[0]]);
  assert.deepEqual(selectConfirmationAdvisoryCandidates(candidates, [], { required: 2, allowRuleOnlySignals: true }), [candidates[0], candidates[2]]);
  assert.deepEqual(selectConfirmationAdvisoryCandidates(candidates, [], { required: 1 }), []);
});

test('extended setup waits for a pullback and expires without recording a trade loss', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const prediction = buildPrediction(stock({ vwap: 146, vwapDistancePct: 2.74, ema9: 147 }), { assumedSlippageBps: 8 }, 'guild', start);
  assert.equal(prediction.status, 'pending_entry');
  const result = evaluatePrediction(prediction, stock({ price: prediction.doNotChasePrice * 1.01 }), new Date(new Date(prediction.entryExpiresAt).getTime() + 60_000));
  assert.equal(result.prediction.status, 'not_filled');
  assert.equal(result.prediction.netReturnPct, null);
});

test('provider disagreement blocks a trade candidate', () => {
  const candidate = stock({ providerAgreement: 62, providerQuoteCount: 3 });
  candidate.model = scoreAsset(candidate);
  const analysis = analyzeMomentum({ assets: [candidate] }, { minPrice: 2, minAverageVolume: 500_000, minScore: 45, maxSignals: 5, minDataQuality: 60, earningsBlackoutDays: 2 });
  assert.equal(analysis.candidates.length, 0);
  assert.match(analysis.watchCandidates[0].rejectionReasons.join(','), /provider disagreement/);
});

test('wide executable spread blocks a trade and observed spread raises modeled costs', () => {
  const candidate = stock({ microstructureProvider: 'Alpaca IEX stream', bidPrice: 149, askPrice: 151, spreadBps: 100, quoteImbalance: 0 });
  candidate.model = scoreAsset(candidate);
  const analysis = analyzeMomentum({ assets: [candidate] }, { minPrice: 2, minAverageVolume: 500_000, minScore: 45, maxSignals: 5, minDataQuality: 60, earningsBlackoutDays: 2, maxSpreadBps: 35 });
  assert.equal(analysis.candidates.length, 0);
  assert.match(analysis.watchCandidates[0].rejectionReasons.join(','), /spread too wide/);
  const prediction = buildPrediction(stock({ microstructureProvider: 'Alpaca IEX stream', bidPrice: 149.9, askPrice: 150.1, spreadBps: 40 }), { assumedSlippageBps: 8 }, 'guild', new Date('2026-07-21T15:00:00Z'));
  assert.equal(prediction.slippageBps, 20);
});

test('probability calibration stays explicitly uncalibrated on small samples', () => {
  const calibration = calibrateTargetProbability(78, [
    { id: 'small-1', accountingVersion: 2, score: 78, status: 'target_hit', horizonKey: 'scalp', completedAt: '2026-09-01T15:00:00Z' },
    { id: 'small-2', accountingVersion: 2, score: 75, status: 'loss', horizonKey: 'scalp', completedAt: '2026-09-02T15:00:00Z' }
  ], 'scalp', 'unknown', '2026-09-30T00:00:00Z');
  assert.equal(calibration.calibrated, false);
  assert.equal(calibration.sampleSize, 2);
  assert.equal(calibration.dayCount, 2);
  assert.ok(calibration.probability > 30 && calibration.probability < 70);
});

test('rule-score target-hit estimate requires same score band, horizon, regime and five outcome days', () => {
  const predictions = [
    ...Array.from({ length: 25 }, (_, index) => ({ id: `scalp-mixed-${index}`, accountingVersion: 2, score: 78, status: index < 14 ? 'target_hit' : 'loss', horizonKey: 'scalp',
      marketRegime: 'mixed', completedAt: new Date(Date.UTC(2026, 8, 1 + index % 5, 15)).toISOString() })),
    ...Array.from({ length: 20 }, (_, index) => ({ id: `session-mixed-${index}`, accountingVersion: 2, score: 78, status: 'loss', horizonKey: 'session', marketRegime: 'mixed',
      completedAt: new Date(Date.UTC(2026, 8, 1 + index % 5, 15)).toISOString() })),
    ...Array.from({ length: 20 }, (_, index) => ({ id: `scalp-riskoff-${index}`, accountingVersion: 2, score: 78, status: 'loss', horizonKey: 'scalp', marketRegime: 'risk_off',
      completedAt: new Date(Date.UTC(2026, 8, 1 + index % 5, 15)).toISOString() })),
    { id: 'legacy-id', accountingVersion: 1, score: 78, status: 'target_hit', horizonKey: 'scalp' },
    { score: 78, status: 'target_hit', horizonKey: 'scalp' }
  ];
  const estimate = calibrateTargetProbability(78, predictions, 'scalp', 'mixed');
  assert.equal(estimate.sampleSize, 25);
  assert.equal(estimate.wins, 14);
  assert.equal(estimate.dayCount, 5);
  assert.equal(estimate.calibrated, true);
  assert.equal(estimate.horizonKey, 'scalp');
  assert.equal(estimate.scope, 'same scalp horizon, same mixed market regime');
  const wrongRegime = calibrateTargetProbability(78, predictions, 'scalp', 'risk_on');
  assert.equal(wrongRegime.sampleSize, 0);
  assert.equal(wrongRegime.calibrated, false);

  const clustered = predictions.filter((row) => row.horizonKey === 'scalp' && row.marketRegime === 'mixed')
    .map((row, index) => ({ ...row, completedAt: new Date(Date.UTC(2026, 8, 1 + index % 4, 15)).toISOString() }));
  const insufficientDays = calibrateTargetProbability(78, clustered, 'scalp', 'mixed');
  assert.equal(insufficientDays.sampleSize, 25);
  assert.equal(insufficientDays.dayCount, 4);
  assert.equal(insufficientDays.calibrated, false);
});

test('target-hit calibration excludes duplicate, unidentified, and post-forecast outcomes', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    id: `unique-${index}`, accountingVersion: 2, score: 78, status: index < 10 ? 'target_hit' : 'loss',
    horizonKey: 'scalp', marketRegime: 'mixed',
    completedAt: new Date(Date.UTC(2026, 8, 1 + index % 5, 15)).toISOString()
  }));
  history.push({ ...history[0] });
  history.push({ ...history[1], id: 'future-outcome', completedAt: '2026-10-01T15:00:00Z' });
  history.push({ ...history[2], id: undefined });
  const estimate = calibrateTargetProbability(78, history, 'scalp', 'mixed', '2026-09-30T16:00:00Z');
  assert.equal(estimate.sampleSize, 20);
  assert.equal(estimate.dayCount, 5);
  assert.equal(estimate.wins, 10);
  assert.equal(estimate.calibrated, true);
});

test('ambiguous same-bar stop and target is graded conservatively as a loss', () => {
  const start = new Date('2026-07-21T15:00:00Z');
  const prediction = buildPrediction(stock(), { assumedSlippageBps: 8 }, 'guild', start);
  prediction.lastBarTimestamp = 100;
  prediction.lastBarHigh = prediction.entryPrice;
  prediction.lastBarLow = prediction.entryPrice;
  const asset = stock({
    price: prediction.entryPrice,
    recentBars: [{ timestamp: 101, open: prediction.entryPrice, high: prediction.exceedPrice * 1.01, low: prediction.stopPrice * 0.99, close: prediction.entryPrice, volume: 1000 }]
  });
  const result = evaluatePrediction(prediction, asset, new Date(start.getTime() + 5 * 60_000));
  assert.equal(result.prediction.status, 'loss');
  assert.ok(result.prediction.netReturnPct < 0);
});

test('performance counts targets without presenting shortfalls as wins', () => {
  const result = summarizePerformance([{ status: 'target_hit' }, { status: 'exceeded' }, { status: 'fell_short' }, { status: 'loss' }, { status: 'tracking' }]);
  assert.equal(result.wins, 2); assert.equal(result.closed, 4); assert.equal(result.winRate, 50);
});

test('performance separates target hits from net-profitable time exits', () => {
  const result = summarizePerformance([
    { status: 'fell_short', realizedR: 0.2 },
    { status: 'target_hit', realizedR: 0.8 },
    { status: 'loss', realizedR: -0.5 },
    { status: 'not_filled' }
  ]);
  assert.ok(Math.abs(result.winRate - 100 / 3) < 1e-9);
  assert.ok(Math.abs(result.profitableRate - 200 / 3) < 1e-9);
  assert.equal(result.notFilled, 1);
});

test('performance reports average favorable and adverse excursions in initial-risk units', () => {
  const result = summarizePerformance([
    { status: 'target_hit', entryPrice: 100, stopPct: 2, maxPrice: 106, minPrice: 98 },
    { status: 'loss', entryPrice: 50, stopPct: 1, maxPrice: 51, minPrice: 49.5 },
    { status: 'tracking', entryPrice: 25, stopPct: 1, maxPrice: 30, minPrice: 20 }
  ]);
  assert.equal(result.excursionSampleSize, 2);
  assert.ok(Math.abs(result.averageMaxFavorableExcursionR - 2.5) < 1e-9);
  assert.ok(Math.abs(result.averageMaxAdverseExcursionR + 1) < 1e-9);
});

test('probability reliability compares stored issuance-time forecasts with completed target outcomes', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `p-${index}`, accountingVersion: 2, status: index % 2 ? 'loss' : 'target_hit',
    completedAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 4))).toISOString(),
    calibration: { calibrated: true, probability: 90 }, horizonKey: index % 2 ? 'session' : 'momentum',
    marketRegime: index % 3 ? 'risk_on' : 'risk_off'
  }));
  rows.push({ ...rows[0] }); // duplicate identifier is counted once
  rows.push({ ...rows[1], id: 'future', completedAt: '2099-01-01T00:00:00Z' });
  rows.push({ ...rows[2], id: 'legacy', accountingVersion: 1 });
  rows.push({ ...rows[3], id: 'unshown', calibration: { calibrated: false, probability: 50 } });
  const evidence = summarizeProbabilityReliability(rows, { now: '2026-02-01T00:00:00Z' });
  assert.equal(evidence.samples, 20);
  assert.equal(evidence.independentDayClusters, 5);
  assert.equal(evidence.meanProbability, 0.9);
  assert.equal(evidence.observedTargetHitRate, 0.5);
  assert.ok(Math.abs(evidence.absoluteCalibrationGap - 0.4) < 1e-9);
  assert.ok(evidence.brierScore > evidence.sameSampleBaseRateBrier);
  assert.equal(evidence.status, 'descriptive_only');
  assert.ok(evidence.segments.some((row) => row.dimension === 'horizonKey' && row.key === 'momentum'));
  assert.match(evidence.method, /prevent an independent calibration or profitability claim/);
});

test('headline Brier score excludes null, uncalibrated, legacy, duplicate, and future forecasts', () => {
  const valid = { id: 'valid-calibration', accountingVersion: 2, status: 'target_hit', completedAt: '2026-01-01T15:00:00Z', calibration: { calibrated: true, probability: 75 } };
  const summary = summarizePerformance([
    valid,
    { id: 'null-probability', accountingVersion: 2, status: 'loss', completedAt: '2026-01-02T15:00:00Z', calibration: { calibrated: true, probability: null } },
    { id: 'not-calibrated', accountingVersion: 2, status: 'loss', completedAt: '2026-01-03T15:00:00Z', calibration: { calibrated: false, probability: 1 } },
    { id: 'legacy', accountingVersion: 1, status: 'loss', completedAt: '2026-01-04T15:00:00Z', calibration: { calibrated: true, probability: 1 } },
    { ...valid },
    { id: 'future', accountingVersion: 2, status: 'loss', completedAt: '2099-01-01T00:00:00Z', calibration: { calibrated: true, probability: 1 } },
  ]);
  assert.equal(summary.calibratedCount, 1);
  assert.equal(summary.brierScore, 0.0625);
});

test('probability reliability withholds interpretation below outcome and day floors', () => {
  const evidence = summarizeProbabilityReliability(Array.from({ length: 19 }, (_, index) => ({
    id: `small-${index}`, accountingVersion: 2, status: 'target_hit', completedAt: `2026-01-0${index < 10 ? 1 : 2}T12:00:00Z`,
    calibration: { calibrated: true, probability: 70 }
  })), { now: '2026-02-01T00:00:00Z' });
  assert.equal(evidence.status, 'insufficient_evidence');
  assert.equal(evidence.samples, 19);
  assert.equal(evidence.independentDayClusters, 2);
});

test('market session opens discovery only before or during regular hours', () => {
  assert.equal(marketSession(new Date('2026-07-21T12:00:00Z')).state, 'pre_market');
  assert.equal(marketSession(new Date('2026-07-21T12:00:00Z')).openForDiscovery, false);
  assert.equal(marketSession(new Date('2026-07-21T15:00:00Z')).state, 'regular');
  assert.equal(marketSession(new Date('2026-07-21T22:00:00Z')).openForDiscovery, false);
  assert.equal(marketSession(new Date('2026-07-19T15:00:00Z')).monitorable, false);
});

test('premarket discovery can scan the configured universe without enabling new trade signals', () => {
  const premarket = marketSession(new Date('2026-07-21T12:00:00Z'));
  const regular = marketSession(new Date('2026-07-21T15:00:00Z'));
  const afterHours = marketSession(new Date('2026-07-21T22:00:00Z'));
  assert.equal(shouldScanConfiguredUniverse(premarket, { discoverPremarket: true }), true);
  assert.equal(shouldScanConfiguredUniverse(premarket, { discoverPremarket: false }), false);
  assert.equal(shouldScanConfiguredUniverse(regular, { allowNewSignals: true }), true);
  assert.equal(shouldScanConfiguredUniverse(afterHours, { discoverPremarket: true }), false);
});

test('market calendar closes regular weekdays that are U.S. equity holidays', () => {
  const independenceObserved = new Date('2026-07-03T15:00:00Z');
  assert.equal(isUsEquityHoliday(independenceObserved), true);
  assert.equal(marketSession(independenceObserved).state, 'closed');
});

test('modeled intraday deadline never extends past the regular close', () => {
  assert.equal(marketCloseTime(new Date('2026-07-21T18:30:00Z')).toISOString(), '2026-07-21T20:00:00.000Z');
  assert.equal(marketCloseTime(new Date('2026-01-21T18:30:00Z')).toISOString(), '2026-01-21T21:00:00.000Z');
});

test('opening slate becomes due at the configured local time and remains due after it', () => {
  const settings = { dailyHour: 8, dailyMinute: 30 };
  assert.equal(isDailyDiscoveryDue(new Date('2026-07-21T13:29:00Z'), settings), false);
  assert.equal(isDailyDiscoveryDue(new Date('2026-07-21T13:30:00Z'), settings), true);
  assert.equal(isDailyDiscoveryDue(new Date('2026-07-21T16:00:00Z'), settings), true);
  assert.equal(isDailyDiscoveryDue(new Date('2026-07-19T16:00:00Z'), settings), false);
});

test('after-hours review becomes due once per weekday after 8:05 PM Eastern', () => {
  assert.equal(isDailyReviewDue(new Date('2026-07-21T00:04:00Z')), false);
  assert.equal(isDailyReviewDue(new Date('2026-07-21T00:05:00Z')), true);
  assert.equal(isDailyReviewDue(new Date('2026-07-20T00:30:00Z')), false);
});
