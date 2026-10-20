import { localDateKey, marketCloseTime } from './time.js';
import { extractModelFeatures } from './modelFeatures.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const finite = (value, fallback = 0) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const COMPLETE = new Set(['loss', 'fell_short', 'target_hit', 'exceeded']);
const TERMINAL = new Set([...COMPLETE, 'not_filled']);
const roundTripCostBps = (prediction) => 2 * (finite(prediction?.slippageBps) + finite(prediction?.commissionBpsPerSide));
const netReturnPct = (grossPct, prediction) => grossPct - roundTripCostBps(prediction) / 100;

export function selectTradeHorizon(asset) {
  const score = finite(asset.model?.score);
  const relativeVolume = finite(asset.relativeVolume);
  const change1h = finite(asset.change1h);
  const adx = finite(asset.adx14, 25);
  if (score >= 86 && relativeVolume >= 1.8 && change1h >= 0.8 && adx >= 22) {
    return { key: 'scalp', label: '30-minute momentum', minutes: 30, followThroughMinutes: 15 };
  }
  if (score >= 76 && relativeVolume >= 1.05 && change1h >= 0.2) {
    return { key: 'momentum', label: '90-minute momentum', minutes: 90, followThroughMinutes: 30 };
  }
  return { key: 'session', label: 'Intraday session', minutes: 240, followThroughMinutes: 45 };
}

function signalId(guildId, asset, dateKey) {
  return `${guildId}-${dateKey}-${asset.symbol}`.replace(/[^0-9a-z_-]/gi, '-').toLowerCase();
}

function completedOutcome(item) {
  return COMPLETE.has(item?.status);
}

export function calibrateTargetProbability(score, predictions = [], horizonKey = '', marketRegime = 'unknown', asOf = Date.now()) {
  const band = Math.floor(clamp(score, 0, 99.99) / 10) * 10;
  const regime = String(marketRegime || 'unknown');
  const cutoff = new Date(asOf).getTime();
  const cutoffMs = Number.isFinite(cutoff) ? cutoff : Date.now();
  const seen = new Set();
  const comparable = predictions.filter((item) => {
    const completedAt = Date.parse(item?.completedAt || '');
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id) || item.accountingVersion !== 2 || !completedOutcome(item)
      || !Number.isFinite(completedAt) || completedAt > cutoffMs
      || (horizonKey && item.horizonKey !== horizonKey)
      || String(item.marketRegime || 'unknown') !== regime
      || finite(item.score, -100) < band || finite(item.score, -100) >= band + 10) return false;
    seen.add(id);
    return true;
  });
  const wins = comparable.filter((item) => ['target_hit', 'exceeded'].includes(item.status)).length;
  const outcomeDays = new Set(comparable.map((item) => new Date(item.completedAt).toISOString().slice(0, 10)));
  const dayCount = outcomeDays.size;
  const calibrated = comparable.length >= 20 && dayCount >= 5;
  // A weakly informative beta prior prevents tiny samples from displaying extreme probabilities.
  const alpha = wins + 3;
  const beta = comparable.length - wins + 3;
  const probability = alpha / (alpha + beta);
  const standardError = Math.sqrt(probability * (1 - probability) / (alpha + beta + 1));
  return {
    probability: probability * 100,
    low: clamp((probability - 1.645 * standardError) * 100, 1, 99),
    high: clamp((probability + 1.645 * standardError) * 100, 1, 99),
    sampleSize: comparable.length,
    dayCount,
    wins,
    scoreBand: `${band}-${band + 9}`,
    calibrated,
    horizonKey: horizonKey || 'all',
    marketRegime: regime,
    scope: `${horizonKey ? `same ${horizonKey} horizon, ` : ''}same ${regime} market regime`,
    label: calibrated
      ? `historical score-band target-hit estimate; same ${horizonKey || 'all'} horizon and ${regime} regime; ${dayCount} outcome days; not independently calibrated`
      : 'preliminary historical score-band target-hit estimate; fewer than 20 outcomes or five outcome days in this horizon/regime cohort'
  };
}

function structuralStop(asset, entryPrice, atrPct) {
  const supports = [asset.vwap, asset.ema21, asset.openingRangeLow]
    .map(Number).filter((value) => Number.isFinite(value) && value > 0 && value < entryPrice);
  const nearestSupport = supports.length ? Math.max(...supports) : 0;
  const volatilityDistancePct = clamp(atrPct * 0.38, 0.55, 2.6);
  if (!nearestSupport) return volatilityDistancePct;
  const structureDistancePct = (entryPrice / nearestSupport - 1) * 100 + clamp(finite(asset.intradayAtrPercent) * 0.25, 0.08, 0.45);
  return clamp(Math.max(volatilityDistancePct * 0.85, Math.min(structureDistancePct, volatilityDistancePct * 1.25)), 0.55, 3);
}

export function buildPrediction(asset, settings, guildId, now = new Date(), timezone = 'America/Chicago', history = []) {
  const model = asset.model || {};
  const score = clamp(model.score, 0, 100);
  const horizon = selectTradeHorizon(asset);
  const atrPct = clamp(finite(asset.dailyAtrPercent, asset.atrPercent), 0.4, 8);
  const quotedPrice = finite(asset.askPrice) > 0 ? Number(asset.askPrice) : finite(asset.livePrice, asset.price);
  const supportReference = Math.max(...[asset.vwap, asset.ema9].map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= quotedPrice), 0);
  const stretchedFromVwap = finite(asset.vwapDistancePct) > 0.65;
  const pullbackPct = clamp(finite(asset.vwapDistancePct) * 0.35, 0.20, 0.80);
  const entryPrice = stretchedFromVwap && supportReference ? Math.max(supportReference, quotedPrice * (1 - pullbackPct / 100)) : quotedPrice;
  const requiresPullback = entryPrice < quotedPrice * 0.998;
  const stopPct = structuralStop(asset, entryPrice, atrPct);
  const expectedHorizonMove = finite(asset.intradayAtrPercent, atrPct / 8) * Math.sqrt(Math.max(1, horizon.minutes / Math.max(1, finite(asset.barIntervalMinutes, 5))));
  const target1Pct = clamp(Math.min(stopPct * 1.25, expectedHorizonMove * 1.05), 0.55, 2.5);
  const target2Pct = clamp(stopPct * 2, target1Pct + 0.4, 6);
  const entryLow = entryPrice * 0.999;
  const entryHigh = entryPrice * 1.0015;
  const stopPrice = entryPrice * (1 - stopPct / 100);
  const targetPrice = entryPrice * (1 + target1Pct / 100);
  const exceedPrice = entryPrice * (1 + target2Pct / 100);
  const doNotChasePrice = entryPrice * (1 + clamp(atrPct * 0.22, 0.25, 1) / 100);
  const dateKey = localDateKey(now, timezone);
  const modeledDeadline = new Date(now.getTime() + horizon.minutes * 60_000);
  const regularClose = marketCloseTime(now);
  const deadlineAt = regularClose > now && regularClose < modeledDeadline ? regularClose : modeledDeadline;
  const calibration = calibrateTargetProbability(score, history, horizon.key, asset.marketRegime || 'unknown', now);
  const lastBar = asset.recentBars?.at(-1);
  // Model at least half the observed spread on each side, even when the configured
  // generic slippage assumption is lower. This keeps paper results executable.
  const slippageBps = clamp(Math.max(finite(settings?.assumedSlippageBps), finite(asset.spreadBps) / 2), 0, 100);
  const perShareFees = Number(settings?.sharedPaperRoundTripFeesPerShare);
  const perShareFeesConfigured = settings?.sharedPaperCostAssumptionsConfigured === true
    && Number.isFinite(perShareFees) && perShareFees >= 0;
  const commissionBpsPerSide = perShareFeesConfigured
    ? (entryPrice > 0 ? (perShareFees / entryPrice) * 10_000 / 2 : 0)
    : clamp(settings?.commissionBpsPerSide, 0, 100);
  const explicitCommissionConfigured = settings?.commissionBpsPerSide !== null
    && settings?.commissionBpsPerSide !== undefined && settings?.commissionBpsPerSide !== ''
    && Number.isFinite(Number(settings.commissionBpsPerSide));
  const providerNames = asset.crossCheckProviders?.length ? asset.crossCheckProviders : asset.crossCheckProvider ? [asset.crossCheckProvider] : [];
  const signalQuality = score >= 85 ? 'A' : score >= 76 ? 'B' : 'C';
  const monitoringMinutes = atrPct >= 4 || stopPct <= 1 ? 2 : Math.min(5, Math.max(2, finite(settings?.monitorMinutes, 5)));
  const ensemble = asset.ensemble || { active: false, decision: 'RULE_ONLY', modelId: '', reason: 'No validated champion is installed.' };
  const modelAbstained = ['WATCH', 'NO_EDGE'].includes(ensemble.decision)
    || (ensemble.decision === 'RULE_ONLY' && !settings?.allowRuleOnlySignals);
  const correlationSeries = [];
  const correlationBars = [...(asset.recentBars || [])].sort((left, right) => left.timestamp - right.timestamp).slice(-100);
  for (let index = 1; index < correlationBars.length; index += 1) {
    const prior = finite(correlationBars[index - 1].close); const current = finite(correlationBars[index].close);
    if (prior > 0 && current > 0) correlationSeries.push([Number(correlationBars[index].timestamp), Math.log(current / prior), Number(correlationBars[index - 1].timestamp)]);
  }

  return {
    id: signalId(guildId, asset, dateKey),
    modelVersion: '4.0',
    guildId,
    dateKey,
    assetId: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    status: requiresPullback ? 'pending_entry' : 'tracking',
    outcomeColor: requiresPullback ? 'orange' : 'purple',
    selectionTier: asset.selectionTier || 'qualified',
    confirmationCount: finite(asset.confirmationCount, 1),
    confirmationRequired: finite(asset.confirmationRequired, 1),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    observedThroughAt: asset.lastUpdated || now.toISOString(),
    entryExpiresAt: new Date(Math.min(now.getTime() + 45 * 60_000, deadlineAt.getTime())).toISOString(),
    entryFilledAt: requiresPullback ? '' : now.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    horizonKey: horizon.key,
    horizonLabel: horizon.label,
    horizonMinutes: horizon.minutes,
    followThroughMinutes: horizon.followThroughMinutes,
    followThroughDeadlineAt: '',
    trailingFloorPrice: 0,
    breakevenArmedAt: '',
    breakevenFloorPrice: 0,
    entryPrice,
    entryLow,
    entryHigh,
    doNotChasePrice,
    stopPrice,
    targetPrice,
    exceedPrice,
    quotedPrice,
    currentPrice: quotedPrice,
    livePrice: finite(asset.livePrice, asset.price),
    livePriceProvider: asset.livePriceProvider || asset.provider,
    maxPrice: requiresPullback ? 0 : entryPrice,
    minPrice: requiresPullback ? 0 : entryPrice,
    targetPct: target1Pct,
    exceedPct: target2Pct,
    stopPct,
    riskPerShare: entryPrice - stopPrice,
    riskReward: target1Pct / stopPct,
    expectedEodPrice: targetPrice,
    score,
    confidence: Math.round(score),
    signalQuality,
    calibration,
    expectedProfitable: calibration.calibrated ? calibration.probability / 100 * (target1Pct / stopPct) - (1 - calibration.probability / 100) > 0 : null,
    expectedValueR: calibration.calibrated ? calibration.probability / 100 * (target1Pct / stopPct) - (1 - calibration.probability / 100) : null,
    action: modelAbstained ? `${ensemble.decision} / DO NOT OPEN A PAPER TRADE`
      : requiresPullback ? `WAIT FOR PULLBACK BUY (${signalQuality}-grade paper setup)` : `CONDITIONAL BUY (${signalQuality}-grade paper setup)`,
    buyCondition: modelAbstained ? `No buy condition is active: ${ensemble.reason}`
      : `Buy only inside the entry zone while price remains above VWAP ${finite(asset.vwap).toFixed(2)} and the 5-minute EMA trend remains positive. ${requiresPullback ? 'The paper setup remains unfilled until price returns to the zone within 45 minutes. ' : ''}Do not chase above ${doNotChasePrice.toFixed(2)}.`,
    sellPlan: `Exit at ${stopPrice.toFixed(2)} if invalidated. At target 1 (${targetPrice.toFixed(2)}), take partial paper profit and trail the rest; close the remainder at target 2 (${exceedPrice.toFixed(2)}) or the trailing floor.`,
    monitoringMinutes,
    continuedMonitoring: true,
    slippageBps,
    commissionBpsPerSide,
    roundTripFeesPerShare: perShareFeesConfigured ? perShareFees : null,
    executionFeeAssumptionConfigured: perShareFeesConfigured || explicitCommissionConfigured,
    executionCostContext: settings?.executionCostContext && typeof settings.executionCostContext === 'object'
      ? structuredClone(settings.executionCostContext) : null,
    spreadBps: finite(asset.spreadBps),
    bidPrice: finite(asset.bidPrice),
    askPrice: finite(asset.askPrice),
    quoteImbalance: finite(asset.quoteImbalance),
    microstructureProvider: asset.microstructureProvider || '',
    streamingQuote: Boolean(asset.streamingQuote),
    ensemble,
    ensembleDecision: ensemble.decision || 'RULE_ONLY',
    ensembleModelId: ensemble.modelId || '',
    researchModelId: ensemble.source === 'research_v4' ? ensemble.modelId || '' : '',
    ensembleSource: ensemble.source || (ensemble.active ? 'trade_outcome_v3' : 'rule_only'),
    expertId: ensemble.expertId || '',
    expertAlgorithm: ensemble.algorithm || '',
    ensembleProbability: Number.isFinite(Number(ensemble.probability)) ? Number(ensemble.probability) : null,
    ensembleExpectedR: Number.isFinite(Number(ensemble.expectedR)) ? Number(ensemble.expectedR) : null,
    modelFeatures: extractModelFeatures(asset),
    portfolioExpectedR: finite(asset.portfolioExpectedR, null),
    portfolioUtilityR: finite(asset.portfolioUtilityR, null),
    executionEvidence: asset.executionEvidence || null,
    selectionEvidence: asset.selectionEvidence || '',
    paperRiskMultiplier: clamp(asset.paperRiskMultiplier ?? 1, 0.1, 1),
    correlationSeries,
    risk: model.risk,
    trend: model.trendLabel,
    marketRegime: asset.marketRegime,
    change1h: asset.change1h,
    changeDay: asset.changeDay,
    change5d: asset.change5d,
    change20d: asset.change20d,
    volumeToday: asset.volumeToday,
    averageDailyVolume: asset.averageDailyVolume,
    relativeVolume: asset.relativeVolume,
    rsi14: asset.rsi14,
    dailyRsi14: asset.dailyRsi14,
    macd: asset.macd,
    macdHistogram: asset.macdHistogram,
    atrPercent: atrPct,
    intradayAtrPercent: asset.intradayAtrPercent,
    barIntervalMinutes: asset.barIntervalMinutes,
    adx14: asset.adx14,
    vwap: asset.vwap,
    vwapDistancePct: asset.vwapDistancePct,
    previous20High: asset.previous20High,
    sector: asset.sector,
    sectorChange: asset.sectorChange,
    relativeStrengthDay: asset.relativeStrengthDay,
    relativeStrength5d: asset.relativeStrength5d,
    marketMove: asset.marketMove,
    marketBreadth: asset.marketBreadth,
    provider: asset.provider,
    discoveryVersion: asset.discoveryVersion || 'configured-or-legacy',
    crossCheckProvider: providerNames.join(' + '),
    crossCheckProviders: providerNames,
    providerAgreement: asset.providerAgreement,
    providerDispersionBps: asset.providerDispersionBps,
    providerQuoteCount: asset.providerQuoteCount,
    liveProviderQuoteCount: asset.liveProviderQuoteCount,
    referenceProviderCount: asset.referenceProviderCount,
    dataQuality: asset.dataQuality,
    freshness: asset.freshness,
    lastUpdated: asset.lastUpdated,
    delayed: Boolean(asset.delayed),
    nextEarningsDate: asset.nextEarningsDate || '',
    daysToEarnings: asset.daysToEarnings ?? null,
    recentSecForm: asset.recentSecForm || '',
    recentSecFiledAt: asset.recentSecFiledAt || '',
    secFilingAgeHours: asset.secFilingAgeHours ?? null,
    secFilingRisk: finite(asset.secFilingRisk),
    secDataStatus: asset.secDataStatus || 'unknown',
    secDataError: asset.secDataError || '',
    corporateActionType: asset.corporateActionType || '',
    corporateActionDate: asset.corporateActionDate || '',
    daysToCorporateAction: asset.daysToCorporateAction ?? null,
    corporateActionRisk: finite(asset.corporateActionRisk),
    corporateActionDataStatus: asset.corporateActionDataStatus || 'unknown',
    corporateActionDataError: asset.corporateActionDataError || '',
    macroStress: asset.macroStress == null ? null : finite(asset.macroStress),
    macroDataStatus: asset.macroDataStatus || 'unknown',
    macroComponentsAvailable: asset.macroComponentsAvailable ?? null,
    macroDataError: asset.macroDataError || '',
    manualCatalysts: (Array.isArray(asset.manualCatalysts) ? asset.manualCatalysts : []).slice(0, 5),
    recentNewsStatus: asset.recentNewsStatus || 'unknown',
    recentNews: (Array.isArray(asset.recentNews) ? asset.recentNews : []).slice(0, 3),
    factors: {
      trend: model.trend,
      momentum: model.momentum ?? model.oscillator,
      volume: model.volume,
      breakout: model.breakout,
      vwap: model.vwap,
      relativeStrength: model.relativeStrength,
      sector: model.sector,
      sectorDataStatus: model.sectorContextStatus || 'unavailable',
      regime: model.regime,
      provider: model.provider,
      chasePenalty: model.chasePenalty,
      stalePenalty: model.stalePenalty,
      volatilityPenalty: model.volatilityPenalty,
      eventPenalty: model.eventPenalty,
      qualityPenalty: model.qualityPenalty,
      weights: model.weights
    },
    thesis: `${asset.symbol} passed ${finite(asset.confirmationCount, 1)}/${finite(asset.confirmationRequired, 1)} required confirmation scans with ${Number(asset.relativeVolume).toFixed(2)}x relative volume, RSI ${Number(asset.rsi14).toFixed(1)}, ${finite(asset.vwapDistancePct).toFixed(2)}% versus VWAP, and ${finite(asset.relativeStrengthDay).toFixed(2)}% one-day strength versus SPY in a ${asset.marketRegime} tape.`,
    continuation: `Monitor about every ${monitoringMinutes} minutes through the ${horizon.label.toLowerCase()} window. The alert is invalid if price loses the modeled stop, provider data becomes stale, or the trend/VWAP thesis materially deteriorates.`,
    messageId: '',
    channelId: '',
    lastEvent: 'created',
    lastEventAt: now.toISOString(),
    lastRiskWarningAt: '',
    targetReachedAt: '',
    exceededAt: '',
    stopReachedAt: '',
    completedAt: '',
    exitPrice: 0,
    accountingVersion: 2,
    partialExitFraction: 0.5,
    grossReturnPct: null,
    netReturnPct: null,
    realizedR: null,
    lastBarTimestamp: finite(lastBar?.timestamp),
    lastBarHigh: finite(lastBar?.high, entryPrice),
    lastBarLow: finite(lastBar?.low, entryPrice),
    disclaimer: 'Research and paper tracking only. Not financial advice; no brokerage connection or order is used. Losses are possible.'
  };
}

export function buildPredictions(candidates, settings, guildId, now = new Date(), timezone = 'America/Chicago', history = []) {
  return candidates.filter((asset) => asset.selectionTier === 'qualified').slice(0, settings.maxSignals).map((asset) => buildPrediction(asset, settings, guildId, now, timezone, history));
}

function event(prediction, type, color, description, occurredAt = prediction.lastEventAt || new Date().toISOString()) {
  return { prediction, type, color, description, occurredAt };
}

function closePrediction(prediction, status, color, eventName, exitPrice, now, description) {
  const price = finite(exitPrice, prediction.currentPrice);
  const partial = prediction.targetReachedAt ? clamp(prediction.partialExitFraction ?? 0.5, 0, 1) : 0;
  const weightedExit = partial * prediction.targetPrice + (1 - partial) * price;
  const grossReturnPct = prediction.entryPrice ? (weightedExit / prediction.entryPrice - 1) * 100 : 0;
  const afterCostReturnPct = netReturnPct(grossReturnPct, prediction);
  Object.assign(prediction, {
    status,
    outcomeColor: color,
    action: status === 'loss' ? 'EXIT / INVALIDATED' : status === 'fell_short' ? 'CLOSE / TIME EXIT' : 'SELL / PROFIT EXIT',
    exitPrice: price,
    averageExitPrice: weightedExit,
    grossReturnPct,
    netReturnPct: afterCostReturnPct,
    realizedR: prediction.stopPct ? afterCostReturnPct / prediction.stopPct : 0,
    completedAt: now.toISOString(),
    lastEvent: eventName,
    lastEventAt: now.toISOString(),
    continuedMonitoring: false
  });
  return event(prediction, eventName, color, description, now.toISOString());
}

function newBarObservations(existing, asset, now) {
  const bars = [...(asset.recentBars || [])].sort((a, b) => a.timestamp - b.timestamp);
  const previousTimestamp = finite(existing.lastBarTimestamp);
  const observations = [];
  for (const bar of bars) {
    if (bar.timestamp * 1000 > now.getTime()) continue;
    if (bar.timestamp < previousTimestamp) continue;
    if (bar.timestamp === previousTimestamp) {
      const highChanged = finite(bar.high) > finite(existing.lastBarHigh, bar.high);
      const lowChanged = finite(bar.low) < finite(existing.lastBarLow, bar.low);
      if (!highChanged && !lowChanged) continue;
      const anchor = finite(existing.currentPrice, asset.price);
      observations.push({
        ...bar,
        open: anchor,
        high: highChanged ? bar.high : Math.max(anchor, finite(bar.close, anchor)),
        low: lowChanged ? bar.low : Math.min(anchor, finite(bar.close, anchor)),
        incremental: true
      });
    } else {
      observations.push(bar);
    }
  }
  const livePrice = finite(asset.livePrice, asset.price);
  if (!observations.length || finite(observations.at(-1)?.close) !== livePrice) {
    const current = livePrice;
    observations.push({ timestamp: Math.floor(now.getTime() / 1000), open: finite(existing.currentPrice, current), high: current, low: current, close: current, volume: 0, snapshot: true });
  }
  return observations;
}

export function evaluatePrediction(existing, asset, now = new Date()) {
  if (!existing || !asset || TERMINAL.has(existing.status)) return { prediction: existing, events: [] };
  // Provider outages must never manufacture fills or time-exits at a cached price.
  if (asset.freshness === 'stale') return { prediction: { ...existing, freshness: 'stale' }, events: [] };
  const current = finite(asset.bidPrice) > 0 ? Number(asset.bidPrice) : finite(asset.livePrice, asset.price);
  if (!Number.isFinite(current) || current <= 0) return { prediction: existing, events: [] };
  const latestBar = asset.recentBars?.at(-1);
  const prediction = {
    ...existing,
    currentPrice: current,
    updatedAt: now.toISOString(),
    latestScore: asset.model?.score ?? existing.latestScore ?? existing.score,
    lastUpdated: asset.lastUpdated || existing.lastUpdated,
    freshness: asset.freshness || existing.freshness,
    vwap: asset.vwap || existing.vwap,
    providerAgreement: asset.providerAgreement ?? existing.providerAgreement,
    providerDispersionBps: asset.providerDispersionBps ?? existing.providerDispersionBps,
    spreadBps: asset.spreadBps ?? existing.spreadBps,
    bidPrice: asset.bidPrice ?? existing.bidPrice,
    askPrice: asset.askPrice ?? existing.askPrice,
    quoteImbalance: asset.quoteImbalance ?? existing.quoteImbalance,
    microstructureProvider: asset.microstructureProvider || existing.microstructureProvider,
    quoteAgeSeconds: asset.quoteAgeSeconds ?? existing.quoteAgeSeconds ?? null,
    luldDistanceBps: asset.luldDistanceBps ?? existing.luldDistanceBps ?? null,
    halted: Boolean(asset.halted),
    tradingStatus: asset.tradingStatus || existing.tradingStatus || null,
    recentSecForm: asset.recentSecForm || existing.recentSecForm || '',
    recentSecFiledAt: asset.recentSecFiledAt || existing.recentSecFiledAt || '',
    secFilingAgeHours: asset.secFilingAgeHours ?? existing.secFilingAgeHours ?? null,
    secFilingRisk: asset.secFilingRisk ?? existing.secFilingRisk ?? 0,
    secDataStatus: asset.secDataStatus || existing.secDataStatus || 'unknown',
    secDataError: asset.secDataError || existing.secDataError || '',
    corporateActionType: asset.corporateActionType || existing.corporateActionType || '',
    corporateActionDate: asset.corporateActionDate || existing.corporateActionDate || '',
    daysToCorporateAction: asset.daysToCorporateAction ?? existing.daysToCorporateAction ?? null,
    corporateActionRisk: asset.corporateActionRisk ?? existing.corporateActionRisk ?? 0,
    corporateActionDataStatus: asset.corporateActionDataStatus || existing.corporateActionDataStatus || 'unknown',
    corporateActionDataError: asset.corporateActionDataError || existing.corporateActionDataError || '',
    macroStress: asset.macroDataStatus
      ? (['available', 'partial'].includes(asset.macroDataStatus) && asset.macroStress != null ? finite(asset.macroStress) : null)
      : existing.macroStress ?? 0,
    macroDataStatus: asset.macroDataStatus || existing.macroDataStatus || 'unknown',
    macroComponentsAvailable: asset.macroComponentsAvailable ?? existing.macroComponentsAvailable ?? null,
    macroDataError: asset.macroDataError || existing.macroDataError || '',
    manualCatalysts: asset.manualCatalysts ?? existing.manualCatalysts ?? [],
    recentNewsStatus: asset.recentNewsStatus || existing.recentNewsStatus || 'unknown',
    recentNews: asset.recentNews ?? existing.recentNews ?? [],
    dataQuality: asset.dataQuality ?? existing.dataQuality,
    observedThroughAt: asset.lastUpdated || now.toISOString()
  };
  const events = [];
  const observations = newBarObservations(existing, asset, now);
  let lastProcessedBar = null;
  let priorClose = finite(existing.currentPrice, current);

  for (const bar of observations) {
    if (!bar.snapshot) lastProcessedBar = bar;
    let high = finite(bar.high, current);
    const low = finite(bar.low, current);
    const close = finite(bar.close, current);
    const occurredAt = new Date(finite(bar.timestamp) * 1000 || now.getTime());

    if (prediction.status === 'pending_entry') {
      if (occurredAt >= new Date(prediction.entryExpiresAt)) {
        Object.assign(prediction, { status: 'not_filled', outcomeColor: 'gray', action: 'NO TRADE / ENTRY EXPIRED', completedAt: prediction.entryExpiresAt, lastEvent: 'not_filled', lastEventAt: prediction.entryExpiresAt, continuedMonitoring: false });
        events.push(event(prediction, 'not_filled', 'gray', 'Price did not return to the validated entry zone before it expired. No paper trade was opened.', prediction.entryExpiresAt));
        break;
      }
      const touchedEntry = high >= prediction.entryLow && low <= prediction.entryHigh;
      if (!touchedEntry) {
        priorClose = close;
        continue;
      }
      prediction.status = 'tracking';
      prediction.outcomeColor = 'purple';
      prediction.entryFilledAt = occurredAt.toISOString();
      prediction.currentPrice = prediction.entryPrice;
      prediction.maxPrice = prediction.entryPrice;
      prediction.minPrice = prediction.entryPrice;
      prediction.action = 'BUY ZONE FILLED / MONITOR';
      prediction.lastEvent = 'entry_filled';
      prediction.lastEventAt = occurredAt.toISOString();
      events.push(event(prediction, 'entry_filled', 'purple', 'Price returned to the validated entry zone. The conditional paper setup is now active.', occurredAt.toISOString()));
      priorClose = prediction.entryPrice;
      // A bar can rise before falling into the pullback zone. Its earlier high
      // cannot prove that an unfilled limit entry subsequently reached a target.
      if (!bar.snapshot && finite(bar.open) > prediction.entryHigh) high = Math.max(prediction.entryPrice, close);
      // Continue through the same bar: if it also crosses the stop, conservative grading records the loss.
    }

    if (!prediction.targetReachedAt && (occurredAt > new Date(prediction.deadlineAt) || (!bar.snapshot && occurredAt >= new Date(prediction.deadlineAt)))) {
      const netReturn = netReturnPct((priorClose / prediction.entryPrice - 1) * 100, prediction);
      const positive = netReturn >= 0;
      events.push(closePrediction(prediction, positive ? 'fell_short' : 'loss', positive ? 'yellow' : 'red', positive ? 'fell_short' : 'loss', priorClose, new Date(prediction.deadlineAt), positive ? 'The setup finished non-negative after modeled slippage but did not reach target 1.' : 'The setup timed out below entry after modeled slippage.'));
      break;
    }
    if (prediction.targetReachedAt && (occurredAt > new Date(prediction.followThroughDeadlineAt || prediction.deadlineAt) || (!bar.snapshot && occurredAt >= new Date(prediction.followThroughDeadlineAt || prediction.deadlineAt)))) {
      events.push(closePrediction(prediction, 'target_hit', 'green', 'target_closed', priorClose, new Date(prediction.followThroughDeadlineAt || prediction.deadlineAt), 'Target 1 held through the follow-through window; the remaining paper observation closed.'));
      break;
    }
    prediction.maxPrice = Math.max(finite(prediction.maxPrice, close), high);
    prediction.minPrice = Math.min(finite(prediction.minPrice, close), low);

    if (!prediction.targetReachedAt) {
      if (prediction.breakevenArmedAt && low <= finite(prediction.breakevenFloorPrice, prediction.entryPrice)) {
        const gapExit = Math.min(prediction.breakevenFloorPrice, finite(bar.open, prediction.breakevenFloorPrice), bar.snapshot ? close : Infinity);
        const loss = gapExit < prediction.breakevenFloorPrice;
        events.push(closePrediction(prediction, loss ? 'loss' : 'fell_short', loss ? 'red' : 'yellow', 'risk_closed', gapExit, occurredAt, 'The raised paper-risk floor was reached; gaps are filled at the available lower price.'));
        break;
      }
      // Five-minute OHLC cannot reveal path order. When stop and target share a bar, grade stop-first.
      if (low <= prediction.stopPrice) {
        prediction.stopReachedAt = occurredAt.toISOString();
        const gapExit = Math.min(prediction.stopPrice, finite(bar.open, prediction.stopPrice), bar.snapshot ? close : Infinity);
        events.push(closePrediction(prediction, 'loss', 'red', 'loss', gapExit, occurredAt, 'The invalidation level was reached before target 1 (ambiguous same-bar paths are graded stop-first).'));
        break;
      }
      if (high >= prediction.exceedPrice) {
        prediction.targetReachedAt = occurredAt.toISOString();
        prediction.exceededAt = occurredAt.toISOString();
        events.push(closePrediction(prediction, 'exceeded', 'blue', 'exceeded', prediction.exceedPrice, occurredAt, 'Price reached the second target. The paper plan closed the remaining position.'));
        break;
      }
      if (high >= prediction.targetPrice) {
        prediction.targetReachedAt = occurredAt.toISOString();
        prediction.status = 'target_tracking';
        prediction.outcomeColor = 'green';
        prediction.action = 'SELL PARTIAL / RAISE STOP';
        prediction.followThroughDeadlineAt = new Date(Math.min(marketCloseTime(occurredAt).getTime(), occurredAt.getTime() + Math.max(15, prediction.followThroughMinutes || 30) * 60_000)).toISOString();
        prediction.trailingFloorPrice = Math.max(prediction.entryPrice * 1.001, prediction.targetPrice * 0.9975);
        prediction.lastEvent = 'target_hit';
        prediction.lastEventAt = occurredAt.toISOString();
        events.push(event(prediction, 'target_hit', 'green', 'Target 1 was reached. Take partial paper profit and trail the remainder toward target 2.', occurredAt.toISOString()));
        break;
      }
      const breakevenTrigger = prediction.entryPrice + (prediction.entryPrice - prediction.stopPrice) * 0.50;
      if (!prediction.breakevenArmedAt && high >= breakevenTrigger) {
        prediction.breakevenArmedAt = occurredAt.toISOString();
        prediction.breakevenFloorPrice = prediction.entryPrice * (1 + roundTripCostBps(prediction) / 10_000);
        prediction.action = 'HOLD / RISK REDUCED TO BREAKEVEN';
        prediction.lastEvent = 'risk_reduced';
        prediction.lastEventAt = occurredAt.toISOString();
        events.push(event(prediction, 'risk_reduced', 'blue', 'Price reached 0.50R. The paper stop is raised to approximately breakeven while monitoring continues.', occurredAt.toISOString()));
        break;
      }
    } else {
      // Test the floor known before this bar. Raising it from this bar's high
      // before checking its low would fill at a price that may not yet exist.
      if (low <= prediction.trailingFloorPrice) {
        const gapExit = Math.min(prediction.trailingFloorPrice, finite(bar.open, prediction.trailingFloorPrice), bar.snapshot ? close : Infinity);
        events.push(closePrediction(prediction, 'target_hit', 'green', 'target_closed', gapExit, occurredAt, 'The trailing paper-profit floor closed the remaining observation after target 1; gaps use the available lower price.'));
        break;
      }
      if (high >= prediction.exceedPrice) {
        prediction.exceededAt = occurredAt.toISOString();
        events.push(closePrediction(prediction, 'exceeded', 'blue', 'exceeded', prediction.exceedPrice, occurredAt, 'Price reached the second target. The paper plan closed the remaining position.'));
        break;
      }
      prediction.trailingFloorPrice = Math.max(finite(prediction.trailingFloorPrice, prediction.targetPrice), prediction.maxPrice * 0.995);
    }
    priorClose = close;
  }

  if (!events.length && prediction.targetReachedAt && now >= new Date(prediction.followThroughDeadlineAt || prediction.deadlineAt)) {
    events.push(closePrediction(prediction, 'target_hit', 'green', 'target_closed', current, now, 'Target 1 held through the follow-through window; the remaining paper observation closed.'));
  }

  const warningCooldown = prediction.lastRiskWarningAt ? now.getTime() - new Date(prediction.lastRiskWarningAt).getTime() : Infinity;
  const thesisDeteriorated = !events.length && !prediction.targetReachedAt
    && finite(prediction.latestScore, prediction.score) <= finite(prediction.score) - 12
    && current < finite(asset.vwap, current)
    && current < finite(asset.ema21, current);
  const executionRisk = !events.length && (prediction.halted
    || (asset.microstructureProvider && finite(prediction.luldDistanceBps, 10000) < 35)
    || (asset.streamingQuote && finite(prediction.quoteAgeSeconds, 0) > 60));
  const newEventRisk = !events.length && (finite(prediction.secFilingRisk) >= 75
    || finite(prediction.corporateActionRisk) >= 80 || finite(prediction.macroStress) >= 90);
  if ((thesisDeteriorated || executionRisk || newEventRisk) && warningCooldown >= 30 * 60_000) {
    prediction.lastRiskWarningAt = now.toISOString();
    prediction.lastEvent = 'risk_warning';
    prediction.lastEventAt = now.toISOString();
    prediction.action = prediction.halted ? 'TRADING HALTED / DO NOT PLACE AN ORDER'
      : thesisDeteriorated ? 'SELL / REDUCE REVIEW: THESIS DETERIORATING' : 'RISK REVIEW / DO NOT ADD';
    const reasons = [
      thesisDeteriorated ? 'Price lost VWAP and EMA21 while the model score deteriorated.' : '',
      prediction.halted ? `Trading status is halted${prediction.tradingStatus?.reason ? `: ${prediction.tradingStatus.reason}` : '.'}` : '',
      asset.microstructureProvider && finite(prediction.luldDistanceBps, 10000) < 35 ? 'Price is close to a LULD band.' : '',
      asset.streamingQuote && finite(prediction.quoteAgeSeconds, 0) > 60 ? 'The live quote is stale.' : '',
      finite(prediction.secFilingRisk) >= 75 ? `New high-impact SEC filing risk (${prediction.recentSecForm || 'filing'}).` : '',
      finite(prediction.corporateActionRisk) >= 80 ? `Nearby corporate action (${prediction.corporateActionType || 'event'}).` : '',
      finite(prediction.macroStress) >= 90 ? 'Macro stress crossed the emergency threshold.' : ''
    ].filter(Boolean);
    events.push(event(prediction, 'risk_warning', 'orange', `${reasons.join(' ')} Review execution and exposure; the published hard invalidation remains the stop.`));
  }

  if (!events.length && now >= new Date(prediction.deadlineAt)) {
    const netReturn = netReturnPct((current / prediction.entryPrice - 1) * 100, prediction);
    const positive = netReturn >= 0;
    events.push(closePrediction(prediction, positive ? 'fell_short' : 'loss', positive ? 'yellow' : 'red', positive ? 'fell_short' : 'loss', current, now, positive ? 'The setup finished non-negative after modeled slippage but did not reach target 1.' : 'The setup timed out below entry after modeled slippage.'));
  }

  const observedBar = lastProcessedBar || latestBar;
  if (observedBar) {
    prediction.lastBarTimestamp = finite(observedBar.timestamp);
    prediction.lastBarHigh = finite(observedBar.high, current);
    prediction.lastBarLow = finite(observedBar.low, current);
  }
  return { prediction, events };
}

export function mergeNewPredictions(tracker, predictions) {
  const current = Array.isArray(tracker?.predictions) ? tracker.predictions : [];
  const ids = new Set(current.map((item) => item.id));
  const added = predictions.filter((item) => !ids.has(item.id));
  return { version: 4, guildId: tracker?.guildId || predictions[0]?.guildId || '', predictions: [...current, ...added].slice(-2000), updatedAt: new Date().toISOString(), added };
}

function outcomeR(item) {
  if (Number.isFinite(finite(item.realizedR, NaN))) return Number(item.realizedR);
  if (item.status === 'exceeded') return finite(item.exceedPct) / Math.max(0.01, finite(item.stopPct, 1));
  if (item.status === 'target_hit') return finite(item.targetPct) / Math.max(0.01, finite(item.stopPct, 1));
  if (item.status === 'loss' && (!item.currentPrice || !item.entryPrice)) return -1;
  const returnPct = item.entryPrice ? (finite(item.currentPrice, item.entryPrice) / item.entryPrice - 1) * 100 : 0;
  return returnPct / Math.max(0.01, finite(item.stopPct, 1));
}

function probabilityEvidenceRows(predictions, now) {
  const seen = new Set();
  return predictions.filter((item) => {
    const probability = finite(item.calibration?.probability, NaN);
    const completedAt = Date.parse(item.completedAt || '');
    const id = item.id;
    if (item.accountingVersion !== 2 || !COMPLETE.has(item.status) || item.calibration?.calibrated !== true
      || !Number.isFinite(probability) || probability < 0 || probability > 100
      || !Number.isFinite(completedAt) || completedAt > now || (id && seen.has(id))) return false;
    if (id) seen.add(id);
    return true;
  });
}

export function summarizeProbabilityReliability(predictions = [], options = {}) {
  const now = new Date(options.now ?? Date.now()).getTime();
  const minimumSamples = Math.max(10, Number(options.minimumSamples) || 20);
  const minimumDays = Math.max(5, Number(options.minimumDays) || 5);
  const rows = probabilityEvidenceRows(predictions, now);
  const observations = rows.map((item) => ({
    probability: Number(item.calibration.probability) / 100,
    outcome: ['target_hit', 'exceeded'].includes(item.status) ? 1 : 0,
    completedAt: Date.parse(item.completedAt),
    horizonKey: String(item.horizonKey || 'unknown'),
    marketRegime: String(item.marketRegime || 'unknown'),
    id: item.id
  }));
  const summarize = (cohort) => {
    const n = cohort.length;
    const observedRate = n ? cohort.reduce((sum, row) => sum + row.outcome, 0) / n : null;
    const meanProbability = n ? cohort.reduce((sum, row) => sum + row.probability, 0) / n : null;
    const brierScore = n ? cohort.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / n : null;
    const baseRateBrier = n ? cohort.reduce((sum, row) => sum + ((observedRate || 0) - row.outcome) ** 2, 0) / n : null;
    const days = new Set(cohort.map((row) => new Date(row.completedAt).toISOString().slice(0, 10))).size;
    return {
      samples: n, independentDayClusters: days, meanProbability, observedTargetHitRate: observedRate,
      absoluteCalibrationGap: n ? Math.abs(meanProbability - observedRate) : null,
      brierScore, sameSampleBaseRateBrier: baseRateBrier,
      brierSkillVsSameSampleBaseRate: baseRateBrier > 0 ? 1 - brierScore / baseRateBrier : null,
      status: n < minimumSamples || days < minimumDays ? 'insufficient_evidence' : 'descriptive_only'
    };
  };
  const all = summarize(observations);
  const segments = ['horizonKey', 'marketRegime'].flatMap((dimension) => [...new Set(observations.map((row) => row[dimension]))]
    .sort().map((key) => ({ dimension, key, ...summarize(observations.filter((row) => row[dimension] === key)) })));
  return {
    ...all, minimumSamples, minimumDays, segments,
    method: 'Stored issuance-time target-hit estimates compared with completed v2 paper outcomes. Same-sample base-rate Brier is descriptive; overlapping setups, same-day dependence, selection and regime change prevent an independent calibration or profitability claim.'
  };
}

export function summarizePerformance(predictions = []) {
  const closed = predictions.filter((item) => COMPLETE.has(item.status)).sort((left, right) => Date.parse(left.completedAt || left.createdAt || 0) - Date.parse(right.completedAt || right.createdAt || 0));
  const wins = closed.filter((item) => ['target_hit', 'exceeded'].includes(item.status)).length;
  const returns = closed.map(outcomeR);
  const profitable = returns.filter((value) => value > 0).length;
  const grossProfit = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = 0; let peak = 0; let maxDrawdownR = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  // Keep the headline Brier/count aligned with the stricter evidence report:
  // only completed v2 rows with an explicitly calibrated issuance-time value
  // are eligible. In particular, Number(null) === 0 must not invent a 0% forecast.
  const calibrated = probabilityEvidenceRows(closed, Date.now());
  const probabilityReliability = summarizeProbabilityReliability(predictions);
  // Price extremes are useful excursion diagnostics, but OHLC bars cannot prove
  // whether a favorable or adverse extreme happened first within the same bar.
  const excursionRows = closed.filter((item) => Number(item.entryPrice) > 0 && Number(item.stopPct) > 0
    && Number.isFinite(Number(item.maxPrice)) && Number.isFinite(Number(item.minPrice)));
  const maxFavorableExcursionR = excursionRows.length
    ? excursionRows.reduce((sum, item) => sum + Math.max(0, (Number(item.maxPrice) / Number(item.entryPrice) - 1) * 100 / Number(item.stopPct)), 0) / excursionRows.length : null;
  const maxAdverseExcursionR = excursionRows.length
    ? excursionRows.reduce((sum, item) => sum + Math.min(0, (Number(item.minPrice) / Number(item.entryPrice) - 1) * 100 / Number(item.stopPct)), 0) / excursionRows.length : null;
  const brierScore = calibrated.length ? calibrated.reduce((sum, item) => {
    const probability = Number(item.calibration.probability) / 100;
    const actual = ['target_hit', 'exceeded'].includes(item.status) ? 1 : 0;
    return sum + (probability - actual) ** 2;
  }, 0) / calibrated.length : null;
  return {
    total: predictions.length,
    open: predictions.filter((item) => !TERMINAL.has(item.status)).length,
    notFilled: predictions.filter((item) => item.status === 'not_filled').length,
    closed: closed.length,
    wins,
    losses: closed.filter((item) => item.status === 'loss').length,
    fellShort: closed.filter((item) => item.status === 'fell_short').length,
    exceeded: closed.filter((item) => item.status === 'exceeded').length,
    winRate: closed.length ? wins / closed.length * 100 : 0,
    profitable,
    profitableRate: closed.length ? profitable / closed.length * 100 : 0,
    expectancyR: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    maxDrawdownR,
    netR: returns.reduce((sum, value) => sum + value, 0),
    averageMaxFavorableExcursionR: maxFavorableExcursionR,
    averageMaxAdverseExcursionR: maxAdverseExcursionR,
    excursionSampleSize: excursionRows.length,
    brierScore,
    calibratedCount: calibrated.length,
    probabilityReliability
  };
}
