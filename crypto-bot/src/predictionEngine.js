import { localDateKey } from './time.js';
import { extractModelFeatures, observationContext } from './modelFeatures.js';
import { predictMetaProbability } from './metaModel.js';
import { predictOutcomeDistribution } from './outcomeModels.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const GRADED_STATUSES = new Set(['loss', 'fell_short', 'target_hit', 'exceeded']);
const CLOSED_STATUSES = new Set([...GRADED_STATUSES, 'unverified']);

export function selectTradeHorizon(asset) {
  const model = asset.model || {};
  const burst = Number(model.burst) || 0;
  const relativeVolume = Number(model.relativeVolume) || 0;
  const consistency = Number(model.trendConsistency) || 0;
  const change1h = Number(asset.change1h) || 0;
  const technicalScore = Number(model.technicalScore) || 0;

  if (burst >= 82 && relativeVolume >= 62 && change1h >= 1.25 && (!model.technicallyConfirmed || technicalScore >= 65)) {
    return { key: 'scalp', label: 'Momentum scalp', minutes: 45, targetMin: 0.012, targetMax: 0.035, stopMax: 0.022, followThroughMinutes: 20 };
  }
  if (burst >= 70 && relativeVolume >= 52 && change1h >= 0.45) {
    return { key: 'rapid', label: 'Rapid momentum', minutes: 120, targetMin: 0.016, targetMax: 0.048, stopMax: 0.03, followThroughMinutes: 35 };
  }
  if (consistency >= 66 && burst >= 58) {
    return { key: 'intraday', label: 'Intraday trend', minutes: 240, targetMin: 0.02, targetMax: 0.065, stopMax: 0.038, followThroughMinutes: 50 };
  }
  return { key: 'session', label: 'Full-session trend', minutes: 360, targetMin: 0.022, targetMax: 0.08, stopMax: 0.045, followThroughMinutes: 60 };
}

function signalId(guildId, asset, dateKey) {
  return `${guildId}-${dateKey}-${asset.id}`.replace(/[^0-9a-z_-]/gi, '-').toLowerCase();
}

function inferredR(prediction) {
  if (prediction.realizedR != null && Number.isFinite(Number(prediction.realizedR))) return Number(prediction.realizedR);
  if (prediction.status === 'loss') return -1;
  if (prediction.status === 'exceeded') return Math.max(1, Number(prediction.riskReward) || 1);
  if (prediction.status === 'target_hit') return Math.max(0.5, Number(prediction.riskReward) || 0.5);
  if (prediction.entryPrice > 0 && prediction.stopPrice < prediction.entryPrice && prediction.currentPrice > 0) {
    return (prediction.currentPrice - prediction.entryPrice) / (prediction.entryPrice - prediction.stopPrice);
  }
  return 0;
}

export function calibrateProbability(score, history = [], context = {}) {
  const rawProbability = clamp(0.5 + (Number(score) - 60) * 0.008, 0.46, 0.78);
  const scoreComparable = history.filter((item) => item.accountingVersion >= 2 && GRADED_STATUSES.has(item.status)
    && item.realizedR != null && Number.isFinite(Number(item.realizedR))
    && Number.isFinite(Date.parse(item.completedAt)) && Date.parse(item.completedAt) <= new Date(context.asOf ?? Date.now()).getTime()
    && Number.isFinite(Number(item.score)) && Math.abs(Number(item.score) - Number(score)) <= 10);
  const strata = [
    { name: 'horizon/asset/regime', rows: scoreComparable.filter((item) => item.horizonKey === context.horizonKey && item.assetClass === context.assetClass && item.regimeKey === context.regimeKey), minimum: 12 },
    { name: 'horizon/asset', rows: scoreComparable.filter((item) => item.horizonKey === context.horizonKey && item.assetClass === context.assetClass), minimum: 18 },
    { name: 'horizon', rows: scoreComparable.filter((item) => item.horizonKey === context.horizonKey), minimum: 24 },
    { name: 'global score band', rows: scoreComparable, minimum: 1 }
  ];
  const selected = strata.find((stratum) => stratum.rows.length >= stratum.minimum) || strata.at(-1);
    const comparable = selected.rows;
    const calibrationDayCount = new Set(comparable.map((item) => new Date(item.completedAt).toISOString().slice(0, 10))).size;
    const wins = comparable.filter((item) => inferredR(item) > 0).length;
  const priorStrength = 10;
  const alpha = rawProbability * priorStrength + wins;
  const beta = (1 - rawProbability) * priorStrength + comparable.length - wins;
  const probability = alpha / (alpha + beta);
  const standardError = Math.sqrt(probability * (1 - probability) / (alpha + beta + 1));
    const evidenceMature = comparable.length >= 30 && calibrationDayCount >= 5;
    return {
      probability, lowerBound: evidenceMature ? clamp(probability - 1.28 * standardError, 0.05, 0.95) : null,
      rawProbability, sampleSize: comparable.length, calibrationDayCount, wins,
      stratum: selected.name,
      evidenceMature,
      method: evidenceMature ? 'historical score-band estimate; minimum sample met, independent calibration unverified'
        : 'score-derived prior; collecting comparable outcomes'
  };
}

function describeDataQuality(asset) {
  const market = asset.marketData || {};
  if (market.conflicted) return 'Provider conflict';
  if ((market.providerCount || 0) >= 3 && market.technicals?.dataSufficient) return 'Strong confirmation';
  if ((market.providerCount || 0) >= 2) return 'Confirmed';
  return 'Single-source only';
}

export function buildPrediction(asset, settings = {}, guildId, now = new Date(), timezone = 'America/Chicago', history = [], options = {}) {
  const score = Number(asset.model.score) || 0;
  const horizon = selectTradeHorizon(asset);
  const technicals = asset.marketData?.technicals || {};
  const atrRatio = clamp((Number(technicals.atrPct) || 0) / 100, 0, 0.08);
  const spreadRatio = clamp((Number(asset.marketData?.medianSpreadPct) || 0) / 100, 0, 0.02);
  const configuredCostBps = Number(settings.estimatedRoundTripBps);
  const executionCostBps = Number(asset.marketData?.execution?.estimatedRoundTripBps);
  const effectiveCostBps = Number.isFinite(executionCostBps) && executionCostBps > 0
    ? executionCostBps : Number.isFinite(configuredCostBps) ? configuredCostBps : 20;
  const estimatedCostRatio = clamp(effectiveCostBps / 10_000, 0, 0.04);
  const riskBase = asset.model.risk === 'High' ? 0.045 : asset.model.risk === 'Elevated' ? 0.035 : 0.025;
  const volatilityStop = atrRatio > 0 ? atrRatio * 1.35 : riskBase * 0.72;
  const stopPct = clamp(Math.max(0.009, volatilityStop, spreadRatio * 3, estimatedCostRatio * 3), 0.009, horizon.stopMax);
  const requestedRiskReward = clamp(Number(settings.minRiskReward) || 1.7, 1.3, 4);
  const targetPct = clamp(
    Math.max(horizon.targetMin, stopPct * requestedRiskReward + estimatedCostRatio),
    horizon.targetMin, horizon.targetMax
  );
  const entryBand = clamp((atrRatio || 0.012) * 0.18, 0.0015, 0.006);
  const entryLow = asset.price * (1 - entryBand);
  const entryHigh = asset.price * (1 + entryBand * 0.55);
  const entryPrice = asset.price;
  const targetPrice = entryPrice * (1 + targetPct);
  const partialTargetPrice = entryPrice * (1 + stopPct);
  const exceedPrice = targetPrice * 1.01;
  const stopPrice = entryPrice * (1 - stopPct);
  const dateKey = localDateKey(now, timezone);
  const context = observationContext(asset, horizon.key);
  const features = extractModelFeatures(asset, now);
  const calibration = calibrateProbability(score, history, { ...context, asOf: now });
  const meta = predictMetaProbability(options.metaBundle, features, { ...context, maxOodScore: settings.maxOodScore });
  const outcomes = predictOutcomeDistribution(options.outcomeBundle, features);
  const learnedProbability = meta.active ? meta.probability : calibration.probability;
  // Target-before-stop and positive-net-return are distinct events; do not blend them.
  const probability = meta.active ? calibration.probability * 0.35 + learnedProbability * 0.65 : calibration.probability;
  const confidence = Math.round(probability * 100);
  const riskReward = targetPct / stopPct;
  const costInR = estimatedCostRatio / stopPct;
  // Probability models estimate a positive net outcome, not a full-target payout.
  // Use observed payoffs when available; otherwise T1/protected exit is the
  // conservative winning scenario for this 50% scale-out strategy.
  const comparable = history.filter((row) => row.accountingVersion >= 2 && GRADED_STATUSES.has(row.status)
    && Number.isFinite(Date.parse(row.completedAt)) && Date.parse(row.completedAt) <= now.getTime()
    && row.realizedR != null && Number.isFinite(Number(row.realizedR))
    && row.horizonKey === horizon.key && row.assetClass === context.assetClass);
  const winningR = comparable.map((row) => Number(row.realizedR)).filter((value) => value > 0);
  const losingR = comparable.map((row) => Number(row.realizedR)).filter((value) => value <= 0);
  const empiricalPayoffs = winningR.length >= 10 && losingR.length >= 10;
  const averageWinR = empiricalPayoffs ? winningR.reduce((sum, value) => sum + value, 0) / winningR.length : Math.max(0, 0.5 - costInR);
  const averageLossR = empiricalPayoffs ? losingR.reduce((sum, value) => sum + value, 0) / losingR.length : -1 - costInR;
  const expectedValueR = probability * averageWinR + (1 - probability) * averageLossR;
  const providerCount = Number(asset.marketData?.providerCount) || 1;
  const minimumProviders = Math.max(2, Number(settings.minProviderConfirmations) || 2);
  const approvalRejections = [
    [riskReward >= requestedRiskReward - 0.05, 'reward_risk'],
    [expectedValueR >= 0.1, 'expected_value'],
    [providerCount >= minimumProviders, 'provider_confirmation'],
    [!asset.marketData?.conflicted, 'provider_conflict'],
    [asset.marketData?.regime?.allowNewLongs !== false, 'market_regime'],
    [asset.marketData?.derivatives?.blockLongs !== true, 'derivatives_crowding'],
    [asset.marketData?.execution?.blockTrade !== true, 'execution_cost'],
    [asset.marketData?.eventRisk?.blocked !== true, 'event_veto'],
    [!meta.active || (!meta.abstain && meta.probability >= (Number(settings.minMetaProbability) || 0.56)), 'model_abstention_or_probability'],
    [!outcomes.active || (outcomes.targetProbability >= 0.5
      && Number(outcomes.returnR?.median) > 0
      && Number(outcomes.timeMinutes?.median) <= horizon.minutes * 1.25), 'outcome_distribution'],
    [asset.model.validationPassed === true, 'strategy_validation']
  ].filter(([passes]) => !passes).map(([, code]) => code);
  const expectedProfitable = approvalRejections.length === 0;
  const accountRiskPct = clamp(Number(settings.accountRiskPct) || 0.5, 0.1, 1);
  const maxPositionPct = clamp(accountRiskPct / (stopPct + estimatedCostRatio), 0, 25);
  const action = expectedProfitable ? 'BUY ZONE / PAPER LONG' : 'WAIT / NO TRADE';
  const providers = asset.marketData?.providers?.join(', ') || 'broad market snapshot only';
  const regime = asset.marketData?.regime?.label || 'Unknown';
  const monitoringMinutes = Math.max(2, Number(settings.monitorMinutes) || 5);

  return {
    id: signalId(guildId, asset, dateKey), guildId, dateKey, accountingVersion: 2,
    assetId: asset.id, symbol: asset.symbol, name: asset.name, rank: asset.rank,
    status: 'tracking', outcomeColor: expectedProfitable ? 'purple' : 'yellow',
    createdAt: now.toISOString(), deadlineAt: new Date(now.getTime() + horizon.minutes * 60_000).toISOString(), updatedAt: now.toISOString(),
    horizonKey: horizon.key, horizonLabel: horizon.label, horizonMinutes: horizon.minutes,
    followThroughMinutes: horizon.followThroughMinutes, followThroughDeadlineAt: '', trailingFloorPrice: 0,
    entryPrice, entryLow, entryHigh, partialTargetPrice, targetPrice, exceedPrice, stopPrice, effectiveStopPrice: stopPrice,
    currentPrice: entryPrice, maxPrice: entryPrice, minPrice: entryPrice,
    targetPct: targetPct * 100, stopPct: stopPct * 100, riskReward,
    estimatedCostPct: estimatedCostRatio * 100, expectedValueR,
    expectancyMethod: empiricalPayoffs ? 'observed net payoff averages' : 'conservative T1/protected-exit scenario',
    expectedEodPrice: targetPrice,
    confidence, probability, confidenceLowerBound: meta.active || calibration.lowerBound === null ? null : Math.round(Math.min(probability, calibration.lowerBound) * 100),
    confidenceMethod: meta.active ? `holdout-qualified boosted model + ${calibration.method}` : calibration.method,
      calibrationQualified: calibration.evidenceMature,
      calibrationSampleSize: calibration.sampleSize, calibrationDayCount: calibration.calibrationDayCount, score,
    calibrationStratum: calibration.stratum, metaModelActive: meta.active,
      metaProbability: meta.active ? meta.probability : null, metaModels: meta.models,
      metaAbstained: Boolean(meta.abstain), metaAbstainReason: meta.abstainReason || '',
      catalystContext: (asset.marketData?.eventRisk?.events || []).slice(0, 5).map((event) => ({
        eventType: event.eventType || 'other', direction: event.direction || 'unknown', expectedness: event.expectedness || 'unknown',
        horizon: event.horizon || 'unknown', impact: event.impact || 'unknown', reason: String(event.reason || '').slice(0, 180),
        sourceUrl: String(event.sourceUrl || '').slice(0, 500), severity: event.severity || 'block'
      })),
      // Headline context is post-score display metadata; it never enters features or candidate gates.
      recentMarketNews: Array.isArray(options.recentMarketNews) ? options.recentMarketNews.slice(0, 5) : undefined,
    metaOodScore: Number(meta.oodScore) || 0, conformalPredictionSet: meta.predictionSet || [],
    outcomeModelActive: Boolean(outcomes.active), targetBeforeStopProbability: outcomes.active ? outcomes.targetProbability : null,
    expectedTimeMinutes: outcomes.timeMinutes || null, predictedReturnR: outcomes.returnR || null,
    predictedFavorableR: outcomes.favorableR || null, predictedAdverseR: outcomes.adverseR || null,
    assetClass: context.assetClass, regimeKey: context.regimeKey, modelFeatures: features,
    expectedProfitable, approvalRejections, action, risk: asset.model.risk, trend: asset.model.trend,
    accountRiskPct, maxPositionPct, dataQuality: describeDataQuality(asset), providers,
    marketRegime: regime, providerCount, exchangeProviderCount: Number(asset.marketData?.exchangeProviderCount) || 0,
    globalMarketContext: asset.marketData?.regime?.globalMarketContext || null,
    priceDispersionPct: Number(asset.marketData?.priceDispersionPct) || 0,
    change1h: asset.change1h, change24h: asset.change24h, change7d: asset.change7d,
    volume24h: asset.volume24h, volumeToMarketCap: asset.volumeToMarketCap,
    factors: {
      snapshotModel: asset.model.snapshotScore ?? asset.model.score, technicalScore: asset.model.technicalScore,
      technicalDataSufficient: Boolean(asset.marketData?.technicals?.dataSufficient),
      intradayBurst: asset.model.burst, liquidity: asset.model.liquidity, relativeVolume: asset.model.relativeVolume,
      trendConsistency: asset.model.trendConsistency, rsi14: asset.model.rsi14, adx14: asset.model.adx14,
      atrPct: asset.model.atrPct, volumeZScore: asset.model.volumeZScore, providerQuality: asset.model.providerQuality,
      providerCount, priceDispersionPct: asset.model.priceDispersionPct, spreadPct: asset.model.medianSpreadPct,
      orderBookAvailable: Boolean(asset.marketData?.orderBook?.available), orderBookImbalance: asset.model.orderBookImbalance, regimeScore: asset.model.regime?.score,
      derivativesAvailable: Boolean(asset.marketData?.derivatives?.available),
      derivativesConfigured: asset.marketData?.derivatives !== null && asset.marketData?.derivatives !== undefined,
      openInterestChangeAvailable: Boolean(asset.marketData?.derivatives?.openInterestChangeAvailable),
      longShortRatioAvailable: Boolean(asset.marketData?.derivatives?.longShortRatioAvailable),
      takerBuySellRatioAvailable: Boolean(asset.marketData?.derivatives?.takerBuySellRatioAvailable),
      derivativesScore: asset.model.derivativesScore, derivativesProviderCount: asset.model.derivativesProviderCount,
      fundingAnnualizedPct: asset.model.fundingAnnualizedPct,
      openInterestChangePct: asset.model.openInterestChangePct, longShortRatio: asset.model.longShortRatio,
      longShortRatioAvailable: asset.model.longShortRatioAvailable,
      takerBuySellRatio: asset.model.takerBuySellRatio,
      takerBuySellRatioAvailable: asset.model.takerBuySellRatioAvailable,
      basisPct: asset.model.basisPct,
      microstructureScore: asset.model.microstructureScore, microstructureAvailable: Boolean(asset.marketData?.microstructure?.available),
      orderFlowAvailable: Number(asset.marketData?.microstructure?.tradeVolumeUsd) > 0,
      depthAvailable: Number(asset.marketData?.microstructure?.depthUsd1Pct) > 0,
      spreadAvailable: Number(asset.marketData?.microstructure?.quoteCount) > 0,
      orderFlowImbalance: asset.model.orderFlowImbalance,
      depthImbalance: asset.model.depthImbalance, microSpreadBps: asset.model.microSpreadBps,
      depthUsd1Pct: asset.model.depthUsd1Pct, executionCostBps: asset.model.executionCostBps,
      executionQuality: String(asset.marketData?.execution?.quality || 'unknown'),
      optionsAvailable: Boolean(asset.marketData?.derivatives?.options?.available),
      dvolAvailable: Boolean(asset.marketData?.derivatives?.options?.dvolAvailable),
      putCallSkewAvailable: Boolean(asset.marketData?.derivatives?.options?.putCallSkewAvailable),
      dvol: asset.marketData?.derivatives?.options?.dvol,
      dvolChangePct: asset.marketData?.derivatives?.options?.dvolChangePct,
      putCallSkewIv: asset.marketData?.derivatives?.options?.putCallSkewIv,
      liquidationUsd1h: asset.marketData?.derivatives?.options?.liquidationUsd1h,
      validationRan: asset.marketData?.validation !== null && asset.marketData?.validation !== undefined,
      validationScore: asset.model.validationScore, validationTrades: asset.model.validationTrades,
      validationExpectancyR: asset.model.validationExpectancyR,
      overallValidationRan: asset.model.validationOverallTrades !== null && asset.model.validationOverallTrades !== undefined,
      validationOverallTrades: asset.model.validationOverallTrades,
      validationOverallExpectancyR: asset.model.validationOverallExpectancyR,
      volatilityPenalty: asset.model.volatilityPenalty, chasePenalty: asset.model.chasePenalty
    },
    thesis: `${asset.symbol} has ${asset.model.trend.toLowerCase()} with a ${score.toFixed(1)} ensemble score. `
      + `${providerCount} sources (${providers}) place consensus near ${entryPrice}; dispersion is ${(Number(asset.marketData?.priceDispersionPct) || 0).toFixed(2)}%. `
      + `BTC regime is ${regime.toLowerCase()} and 15m RSI is ${(Number(asset.model.rsi14) || 50).toFixed(1)}.`,
    continuation: expectedProfitable
      ? `Monitor every ${monitoringMinutes} minutes. Take 50% paper profit near 1R, protect the remainder at break-even, exit the remainder at the final target or modeled stop, and do not chase above the entry zone.`
      : `No entry: ${meta.abstainReason || asset.marketData?.execution?.reason || asset.marketData?.eventRisk?.reasons?.join('; ') || 'confirmation, cost-adjusted expectancy, provider agreement, learned outcome, or market regime did not clear the safety gate.'}`,
    messageId: '', channelId: '', lastEvent: expectedProfitable ? 'created' : 'not_qualified', lastEventAt: now.toISOString(),
    partialTakenAt: '', deRiskAlertAt: '', targetReachedAt: '', exceededAt: '', stopReachedAt: '', completedAt: '', realizedR: null,
    disclaimer: 'Probabilistic research and paper tracking only. No profit guarantee or order execution.'
  };
}

export function buildPredictions(candidates, settings, guildId, now = new Date(), timezone = 'America/Chicago', history = [], options = {}) {
  return candidates.slice(0, settings.maxSignals).map((asset) => buildPrediction(asset, settings, guildId, now, timezone, history, options))
    .filter((prediction) => prediction.expectedProfitable);
}

function event(prediction, type, color, description) {
  return { prediction, type, color, description, occurredAt: prediction.lastEventAt || new Date().toISOString() };
}

function tradeR(prediction, price) {
  const initialRisk = Math.max(Number.EPSILON, prediction.entryPrice - prediction.stopPrice);
  return (price - prediction.entryPrice) / initialRisk;
}

function netRealizedR(prediction, price) {
  const costR = ((Number(prediction.estimatedCostPct) || 0) / 100)
    / Math.max(0.0001, (Number(prediction.stopPct) || 1) / 100);
  const remainingR = tradeR(prediction, price);
  return prediction.partialTakenAt ? 0.5 + remainingR * 0.5 - costR : remainingR - costR;
}

export function evaluatePrediction(existing, asset, now = new Date()) {
  if (!existing || !asset || CLOSED_STATUSES.has(existing.status) || existing.status === 'rejected') {
    return { prediction: existing, events: [] };
  }

  const current = Number(asset.price);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(now.getTime())) return { prediction: existing, events: [] };
  const migratedHorizon = existing.horizonMinutes ? null : selectTradeHorizon(asset);
  const createdAt = new Date(existing.createdAt || now).getTime();
  const prediction = {
    ...existing, currentPrice: current,
    maxPrice: Math.max(Number(existing.maxPrice) || current, current),
    minPrice: Math.min(Number(existing.minPrice) || current, current),
    updatedAt: now.toISOString(), latestScore: asset.model?.score ?? existing.latestScore ?? existing.score,
    effectiveStopPrice: Number(existing.effectiveStopPrice) || Number(existing.stopPrice),
    ...(migratedHorizon ? {
      horizonKey: migratedHorizon.key, horizonLabel: migratedHorizon.label,
      horizonMinutes: migratedHorizon.minutes, followThroughMinutes: migratedHorizon.followThroughMinutes,
      deadlineAt: new Date(createdAt + migratedHorizon.minutes * 60_000).toISOString()
    } : {})
  };
  const events = [];
  const withinWindow = now.getTime() <= new Date(prediction.deadlineAt).getTime();

  // A quote first observed after the deadline cannot establish that a target
  // was hit within the trade window. Do not call a large later rise a shortfall.
  if (!withinWindow && !prediction.partialTakenAt && current >= prediction.targetPrice) {
    prediction.status = 'unverified'; prediction.outcomeColor = 'yellow'; prediction.lastEvent = 'unverified';
    prediction.completedAt = now.toISOString(); prediction.lastEventAt = now.toISOString(); prediction.realizedR = null;
    events.push(event(prediction, 'unverified', 'yellow',
      'Price was above the modeled target when it was first checked after the deadline. The time of the move is unknown, so the within-window result cannot be graded.'));
    return { prediction, events };
  }

  if (current <= prediction.effectiveStopPrice && !prediction.targetReachedAt) {
    prediction.stopReachedAt = now.toISOString();
    prediction.completedAt = now.toISOString();
    prediction.lastEventAt = now.toISOString();
    if (prediction.partialTakenAt) {
      prediction.realizedR = netRealizedR(prediction, current);
      prediction.status = prediction.realizedR > 0 ? 'target_hit' : 'loss';
      prediction.outcomeColor = prediction.realizedR > 0 ? 'green' : 'red'; prediction.lastEvent = 'protected_exit';
      events.push(event(prediction, 'protected_exit', prediction.outcomeColor, 'The first target was banked; the remainder exited at the observed price, including any move through the protective stop.'));
    } else {
      prediction.status = 'loss'; prediction.outcomeColor = 'red'; prediction.lastEvent = 'loss'; prediction.realizedR = netRealizedR(prediction, current);
      events.push(event(prediction, 'loss', 'red', 'The modeled loss limit was reached before either profit target.'));
    }
    return { prediction, events };
  }

  const initialRisk = Math.max(Number.EPSILON, prediction.entryPrice - prediction.stopPrice);
  const lossProgress = (prediction.entryPrice - current) / initialRisk;
  if (!prediction.deRiskAlertAt && !prediction.partialTakenAt && lossProgress >= 0.65) {
    prediction.deRiskAlertAt = now.toISOString(); prediction.lastEvent = 'risk_warning'; prediction.lastEventAt = now.toISOString();
    events.push(event(prediction, 'risk_warning', 'warn', 'Price has consumed at least 65% of the risk budget. Do not widen the stop or add to the paper position.'));
  }

  if (withinWindow && prediction.maxPrice >= prediction.exceedPrice) {
    prediction.partialTakenAt ||= now.toISOString(); prediction.targetReachedAt ||= now.toISOString();
    prediction.status = 'exceeded'; prediction.outcomeColor = 'blue'; prediction.exceededAt = now.toISOString();
    prediction.completedAt = now.toISOString(); prediction.lastEvent = 'exceeded'; prediction.lastEventAt = now.toISOString();
    prediction.realizedR = netRealizedR(prediction, prediction.targetPrice);
    events.push(event(prediction, 'exceeded', 'blue', 'Price cleared the final target and the exceeded threshold; the paper signal is closed.'));
    return { prediction, events };
  }

  if (withinWindow && !prediction.targetReachedAt && prediction.maxPrice >= prediction.targetPrice) {
    prediction.partialTakenAt ||= now.toISOString(); prediction.targetReachedAt = now.toISOString(); prediction.status = 'target_hit';
    const followMinutes = Math.max(15, Number(prediction.followThroughMinutes) || 30);
    prediction.followThroughDeadlineAt = new Date(now.getTime() + followMinutes * 60_000).toISOString();
    prediction.effectiveStopPrice = Math.max(prediction.entryPrice, prediction.effectiveStopPrice);
    prediction.trailingFloorPrice = prediction.targetPrice * 0.995;
    prediction.outcomeColor = 'green'; prediction.lastEvent = 'target_hit'; prediction.lastEventAt = now.toISOString();
    prediction.completedAt = now.toISOString();
    prediction.realizedR = netRealizedR(prediction, prediction.targetPrice);
    events.push(event(prediction, 'target_hit', 'green', 'Both profit levels were reached. The remaining paper position closed at the final target.'));
    return { prediction, events };
  }

  if (withinWindow && !prediction.partialTakenAt && prediction.partialTargetPrice && prediction.maxPrice >= prediction.partialTargetPrice) {
    prediction.partialTakenAt = now.toISOString(); prediction.effectiveStopPrice = prediction.entryPrice;
    prediction.lastEvent = 'partial_profit'; prediction.lastEventAt = now.toISOString();
    events.push(event(prediction, 'partial_profit', 'green', 'The 1R level was reached: 50% paper profit is banked and the remaining stop moves to break-even.'));
  }

  if (prediction.targetReachedAt) {
    const trailingCandidate = prediction.maxPrice * 0.9925;
    prediction.trailingFloorPrice = Math.max(Number(prediction.trailingFloorPrice) || prediction.targetPrice * 0.995, trailingCandidate);
    const followThroughExpired = now.getTime() >= new Date(prediction.followThroughDeadlineAt || prediction.deadlineAt).getTime();
    if (current <= prediction.trailingFloorPrice || followThroughExpired) {
      prediction.status = 'target_hit'; prediction.outcomeColor = 'green'; prediction.completedAt = now.toISOString();
      prediction.lastEvent = 'target_closed'; prediction.lastEventAt = now.toISOString(); prediction.realizedR = netRealizedR(prediction, current);
      const reason = followThroughExpired ? 'the follow-through window ended' : 'price pulled back through the trailing paper-profit floor';
      events.push(event(prediction, 'target_closed', 'green', `The final target was reached and ${reason}. The paper signal is now closed.`));
      return { prediction, events };
    }
  }

  if (now.getTime() >= new Date(prediction.deadlineAt).getTime()) {
    prediction.completedAt = now.toISOString(); prediction.realizedR = netRealizedR(prediction, current);
    prediction.lastEventAt = now.toISOString();
    if (prediction.realizedR > 0.05 && prediction.partialTakenAt) {
      prediction.status = 'target_hit'; prediction.outcomeColor = 'green'; prediction.lastEvent = 'timed_profit';
      events.push(event(prediction, 'timed_profit', 'green', 'The time window ended with positive net R after the first target was banked.'));
    } else if (prediction.realizedR < -0.05) {
      prediction.status = 'loss'; prediction.outcomeColor = 'red'; prediction.lastEvent = 'loss';
      events.push(event(prediction, 'loss', 'red', 'The time window ended with a negative cost-adjusted paper result.'));
    } else {
      prediction.status = 'fell_short'; prediction.outcomeColor = 'yellow'; prediction.lastEvent = 'fell_short';
      events.push(event(prediction, 'fell_short', 'yellow', 'The long paper setup expired near break-even without reaching its modeled target.'));
    }
  }
  return { prediction, events };
}

export function mergeNewPredictions(tracker, predictions) {
  const current = Array.isArray(tracker?.predictions) ? tracker.predictions : [];
  const ids = new Set(current.map((item) => item.id));
  const dailySymbols = new Set(current.map((item) => `${item.guildId}-${item.dateKey}-${item.symbol}`));
  const added = [];
  const rejected = [];
  for (const item of predictions) {
    const key = `${item.guildId}-${item.dateKey}-${item.symbol}`;
    if (ids.has(item.id)) { rejected.push({ prediction: item, reason: 'duplicate_signal_id' }); continue; }
    if (dailySymbols.has(key)) { rejected.push({ prediction: item, reason: 'daily_symbol_already_tracked' }); continue; }
    ids.add(item.id);
    dailySymbols.add(key);
    added.push(item);
  }
  return {
    version: 2, guildId: tracker?.guildId || predictions[0]?.guildId || '',
    predictions: [...current, ...added].slice(-1000), updatedAt: new Date().toISOString(), added, rejected
  };
}

export async function deliverPredictionsSafely(predictions = [], send, onDelivered = null) {
  const delivered = [];
  const failures = [];
  const persistenceFailures = [];
  for (const prediction of predictions) {
    let result;
    try {
      result = await send(prediction);
    } catch {
      failures.push({ prediction, reason: 'discord_send_failed' });
      continue;
    }
    delivered.push(result);
    if (typeof onDelivered === 'function') {
      try { await onDelivered(result); }
      catch { persistenceFailures.push({ prediction: result, reason: 'tracker_persist_failed' }); }
    }
  }
  return { delivered, failures, persistenceFailures };
}

function outcomeDeliveryKey(outcome) {
  const prediction = outcome?.prediction || {};
  return `${prediction.id || ''}|${outcome?.type || ''}|${outcome?.occurredAt || prediction.lastEventAt || ''}`;
}

export function mergePendingOutcomeDeliveries(current = [], additions = [], limit = 200) {
  const unique = new Map();
  for (const outcome of [...(Array.isArray(current) ? current : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!outcome?.prediction?.id || !outcome?.type) continue;
    unique.set(outcomeDeliveryKey(outcome), outcome);
  }
  return [...unique.values()].slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
}

export function removeDeliveredOutcomeDeliveries(pending = [], delivered = []) {
  const deliveredKeys = new Set((Array.isArray(delivered) ? delivered : []).map(outcomeDeliveryKey));
  return (Array.isArray(pending) ? pending : []).filter((outcome) => !deliveredKeys.has(outcomeDeliveryKey(outcome)));
}

export function summarizePerformance(predictions = []) {
  const closed = predictions.filter((item) => GRADED_STATUSES.has(item.status))
    .sort((a, b) => String(a.completedAt || a.createdAt || '').localeCompare(String(b.completedAt || b.createdAt || '')));
  const results = closed.map((item) => inferredR(item));
  const wins = results.filter((value) => value > 0.05).length;
  const losses = results.filter((value) => value < -0.05).length;
  const grossProfitR = results.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLossR = Math.abs(results.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const value of results) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    total: predictions.length, open: predictions.filter((item) => !CLOSED_STATUSES.has(item.status)).length,
    closed: closed.length, unverified: predictions.filter((item) => item.status === 'unverified').length,
    wins, losses, fellShort: closed.filter((item) => item.status === 'fell_short').length,
    exceeded: closed.filter((item) => item.status === 'exceeded').length,
    winRate: closed.length ? wins / closed.length * 100 : 0,
    expectancyR: closed.length ? results.reduce((sum, value) => sum + value, 0) / closed.length : 0,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? Infinity : 0,
    netR: grossProfitR - grossLossR, maxDrawdownR,
    averageWinR: wins ? grossProfitR / wins : 0, averageLossR: losses ? grossLossR / losses : 0
  };
}
