import { summarizeEdgeEvidence } from './edgeEvidence.js';
import { analyzeCandles, normalizeCandles } from './technicalAnalysis.js';

const BAR_MS = 15 * 60_000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

function summarize(trades) {
  const results = trades.map((trade) => trade.realizedR);
  const wins = results.filter((value) => value > 0.05).length;
  const smallMoves = results.filter((value) => value >= -0.05 && value <= 0.05).length;
  const grossProfit = results.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(results.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const result of results) {
    equity += result;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    trades: trades.length, wins, smallMoves, losses: results.filter((value) => value < -0.05).length,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    expectancyR: trades.length ? results.reduce((sum, value) => sum + value, 0) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    netR: grossProfit - grossLoss, maxDrawdownR
  };
}

function utcDayCount(rows = []) {
  return new Set(rows.map((row) => new Date(row.time).toISOString().slice(0, 10))).size;
}

function signalDayCount(trades = []) {
  return new Set(trades.map((trade) => new Date(trade.signalTime).toISOString().slice(0, 10))).size;
}

function candlePathQuality(rows = []) {
  let irregularTransitions = 0;
  let missingIntervals = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const elapsed = rows[index].time - rows[index - 1].time;
    if (elapsed !== BAR_MS) irregularTransitions += 1;
    if (elapsed > BAR_MS) missingIntervals += Math.max(0, Math.floor(elapsed / BAR_MS) - 1);
  }
  return { expectedIntervalMs: BAR_MS, irregularTransitions, missingIntervals,
    contiguous: rows.length >= 2 && irregularTransitions === 0 };
}

export function resolveBacktestCostModel(options = {}) {
  const detailedKeys = ['feeBpsPerSide', 'quotedSpreadBps', 'slippageBpsPerSide'];
  const detailed = detailedKeys.some((key) => options[key] !== undefined);
  if (detailed && options.roundTripFeeBps !== undefined) throw new TypeError('Use either legacy roundTripFeeBps or explicit per-side fee/spread/slippage inputs, not both.');
  const readCost = (key) => {
    const raw = options[key];
    if (raw === null || (raw !== undefined && typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim())) {
      throw new TypeError(`${key} must be a numeric basis-point value.`);
    }
    const value = raw === undefined ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a finite nonnegative basis-point value.`);
    return value;
  };
  if (detailed) {
    const feeBpsPerSide = readCost('feeBpsPerSide');
    const quotedSpreadBps = readCost('quotedSpreadBps');
    const slippageBpsPerSide = readCost('slippageBpsPerSide');
    const roundTripBps = 2 * feeBpsPerSide + quotedSpreadBps + 2 * slippageBpsPerSide;
    if (roundTripBps > 200) throw new RangeError('Combined round-trip cost assumptions may not exceed 200 bps.');
    return { mode: 'explicit_components', feeBpsPerSide, quotedSpreadBps, slippageBpsPerSide, roundTripBps,
      note: 'Assumes one full quoted spread crossed and per-side fee/slippage on entry and exit; estimates, not observed fills.' };
  }
  const rawLegacy = options.roundTripFeeBps;
  if (rawLegacy === null || (rawLegacy !== undefined && typeof rawLegacy !== 'number' && typeof rawLegacy !== 'string')
    || (typeof rawLegacy === 'string' && !rawLegacy.trim())) throw new TypeError('roundTripFeeBps must be a numeric basis-point value.');
  const configured = rawLegacy === undefined ? 20 : Number(rawLegacy);
  if (!Number.isFinite(configured) || configured < 0 || configured > 200) throw new RangeError('roundTripFeeBps must be from 0 through 200 bps.');
  return { mode: 'legacy_all_in_round_trip_assumption', roundTripBps: configured,
    note: 'Single combined round-trip cost proxy; spread, fee and slippage components are not separately identified.' };
}

export function walkForwardBacktest(candles = [], options = {}) {
  const rows = normalizeCandles(candles);
  const startIndex = Math.max(80, Number(options.startIndex) || 80);
  // endIndex is a hard data boundary, including exits (never consume the holdout).
  const endIndex = Math.min(rows.length - 1, Number(options.endIndex ?? rows.length - 1));
  const horizonBars = clamp(Number(options.horizonBars) || 16, 3, 48);
  const minimumScore = clamp(Number(options.minimumScore) || 66, 50, 90);
  const rewardRisk = clamp(Number(options.rewardRisk) || 1.7, 1.3, 4);
  const costModel = resolveBacktestCostModel(options);
  const stopAtrMultiplier = clamp(options.stopAtrMultiplier ?? 1.35, 0.8, 3.5);
  const trades = [];
  let costScheduleGapSignals = 0;
  let censoredFutureGapSignals = 0;

  for (let index = startIndex; index + horizonBars <= endIndex; index += 1) {
    const history = rows.slice(Math.max(0, index - 240), index + 1);
    const technicals = analyzeCandles(history);
    if (!technicals.dataSufficient || technicals.technicalScore < minimumScore
      || technicals.ema9 <= technicals.ema21 || technicals.return1h < -0.6
      || technicals.rsi14 > 76 || technicals.rsi14 < 45) continue;

    // A missing bar in the future outcome window makes the target/stop order
    // unknowable. Keep it out of scored trades and report the censoring.
    if (rows.slice(index + 1, index + horizonBars + 1)
      .some((bar, offset) => bar.time !== rows[index].time + (offset + 1) * BAR_MS)) {
      censoredFutureGapSignals += 1;
      continue;
    }

    // The completed signal candle is known only after its close.
    const pointInTimeCost = typeof options.costModelAt === 'function'
      ? options.costModelAt(rows[index].time + BAR_MS, rows[index]) : costModel;
    if (!pointInTimeCost) { costScheduleGapSignals += 1; continue; } // A configured dated schedule fails closed across gaps.
    const costRatio = pointInTimeCost.roundTripBps / 10_000;
    const entry = rows[index + 1].open;
    const stopRatio = clamp(Math.max(0.009, technicals.atrPct / 100 * stopAtrMultiplier, costRatio * 3), 0.009, 0.06);
    const targetRatio = stopRatio * rewardRisk + costRatio;
    const stop = entry * (1 - stopRatio);
    const partialTarget = entry * (1 + stopRatio);
    const finalTarget = entry * (1 + targetRatio);
    const costR = costRatio / stopRatio;
    let partial = false;
    let realizedR = 0;
    let exitIndex = index + horizonBars;
    let exitReason = 'deadline';

    for (let cursor = index + 1; cursor <= index + horizonBars; cursor += 1) {
      const bar = rows[cursor];
      // When a candle crosses both levels, assume the adverse level happened first.
      // This is deliberately conservative because OHLC data does not reveal intrabar order.
      if (!partial && bar.low <= stop) {
        realizedR = (Math.min(stop, bar.open) - entry) / (entry - stop) - costR;
        exitIndex = cursor;
        exitReason = 'stop';
        break;
      }
      if (partial && bar.low <= entry) {
        realizedR = 0.5 + 0.5 * (Math.min(entry, bar.open) - entry) / (entry - stop) - costR;
        exitIndex = cursor;
        exitReason = 'protected_exit';
        break;
      }
      if (!partial && bar.high >= partialTarget && bar.low <= entry) {
        realizedR = 0.5 - costR;
        exitIndex = cursor;
        exitReason = 'protected_exit';
        break;
      }
      if (bar.high >= finalTarget) {
        realizedR = 0.5 + ((finalTarget - entry) / (entry - stop)) * 0.5 - costR;
        exitIndex = cursor;
        exitReason = 'final_target';
        break;
      }
      if (!partial && bar.high >= partialTarget) {
        partial = true;
        // The new break-even stop might be crossed after T1 inside this same bar.
        if (bar.low <= entry) {
          realizedR = 0.5 - costR;
          exitIndex = cursor;
          exitReason = 'protected_exit';
          break;
        }
      }
      if (cursor === index + horizonBars) {
        const remainingR = (bar.close - entry) / (entry - stop);
        realizedR = partial ? 0.5 + remainingR * 0.5 - costR : remainingR - costR;
        exitIndex = cursor;
      }
    }

    trades.push({
      signalCandleOpenTime: rows[index].time, signalTime: rows[index].time + BAR_MS,
      entryTime: rows[index + 1].time,
      exitCandleOpenTime: rows[exitIndex]?.time || rows.at(-1).time,
      exitTime: (rows[exitIndex]?.time || rows.at(-1).time) + BAR_MS,
      marketRegimeAtSignal: typeof options.marketRegimeAtSignal === 'function'
        ? String(options.marketRegimeAtSignal(rows[index], index) || 'unknown') : 'unknown',
      score: technicals.technicalScore, entry, stop, partialTarget, finalTarget,
      realizedR, estimatedCostPct: Number((costRatio * 100).toFixed(10)), costModel: pointInTimeCost,
      exitReason, barsHeld: Math.max(1, exitIndex - index)
    });
    index = Math.max(index, exitIndex);
  }
  const usedCostModels = [...new Map(trades.map((trade) => [trade.costModel?.scheduleRowId || 'static', trade.costModel])).values()];
  return { ...summarize(trades), tradesList: trades, costScheduleGapSignals, censoredFutureGapSignals,
    costModel: options.costModelAt ? { mode: 'dated_schedule', rowsUsed: usedCostModels } : costModel };
}

export function validateStrategy(candles = [], options = {}) {
  const rows = normalizeCandles(candles);
  const dataQuality = candlePathQuality(rows);
  if (typeof options.costModelAt === 'function' && [options.roundTripFeeBps, options.feeBpsPerSide, options.slippageBpsPerSide].some((value) => value !== undefined)) {
    throw new TypeError('Use either a dated cost schedule or static round-trip, fee, and slippage inputs, not both.');
  }
  const splitIndex = Math.max(100, Math.floor(rows.length * 0.65));
  const common = {
    minimumScore: options.minimumScore, rewardRisk: options.rewardRisk,
    roundTripFeeBps: options.roundTripFeeBps, feeBpsPerSide: options.feeBpsPerSide,
    quotedSpreadBps: options.quotedSpreadBps, slippageBpsPerSide: options.slippageBpsPerSide,
    horizonBars: options.horizonBars,
    stopAtrMultiplier: options.stopAtrMultiplier,
    marketRegimeAtSignal: options.marketRegimeAtSignal, costModelAt: options.costModelAt
  };
  const earlier = walkForwardBacktest(rows, { ...common, startIndex: 80, endIndex: splitIndex - 1 });
  const recent = walkForwardBacktest(rows, { ...common, startIndex: splitIndex, endIndex: rows.length - 2 });
  const overall = walkForwardBacktest(rows, { ...common, startIndex: 80, endIndex: rows.length - 2 });
  // Trade rows are not independent evidence when many signals cluster in a short date range.
  // Expose calendar coverage separately; this diagnostic does not alter strategy approval.
  const coverage = {
    earlier: { candleDays: utcDayCount(rows.slice(80, splitIndex)), signalDays: signalDayCount(earlier.tradesList) },
    recent: { candleDays: utcDayCount(rows.slice(splitIndex, rows.length - 1)), signalDays: signalDayCount(recent.tradesList) },
    overall: { candleDays: utcDayCount(rows.slice(80, rows.length - 1)), signalDays: signalDayCount(overall.tradesList) }
  };
  return {
    candleCount: rows.length, coverage, dataQuality, costModel: recent.costModel, earlier, recent, overall,
    evidence: summarizeEdgeEvidence(recent.tradesList),
    sufficient: dataQuality.contiguous && recent.trades >= 5 && overall.trades >= 10,
    warning: !dataQuality.contiguous ? 'Historical candles contain a missing or irregular interval; approval is withheld.'
      : recent.trades < 5 ? 'Too few recent trades for a reliable holdout estimate.'
      : recent.expectancyR <= 0 ? 'Recent holdout expectancy is not positive.'
        : overall.maxDrawdownR > Math.max(3, overall.netR) ? 'Historical drawdown is large relative to the observed edge.' : ''
  };
}
