import { analyzeCandles, classifyMarketRegime, normalizeCandles } from './technicalAnalysis.js';
import { validateStrategy } from './backtest.js';

const BAR_MS = 15 * 60_000;

function findLastCompletedIndex(candles, decisionTime) {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time + BAR_MS <= decisionTime) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

function summarizeRegimes(trades = []) {
  const keys = ['risk_on', 'neutral', 'risk_off', 'unknown'];
  return Object.fromEntries(keys.map((key) => {
    const selected = trades.filter((trade) => (trade.marketRegimeAtSignal || 'unknown') === key);
    const values = selected.map((trade) => trade.realizedR);
    const signalDays = new Set(selected.map((trade) => {
      const numericTime = trade.signalTime === null || trade.signalTime === undefined || trade.signalTime === '' ? NaN : Number(trade.signalTime);
      const time = Number.isFinite(numericTime) && numericTime > 0 ? numericTime : Date.parse(trade.signalTime || '');
      return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
    }).filter(Boolean)).size;
    const wins = values.filter((value) => value > 0.05).length;
    const smallMoves = values.filter((value) => value >= -0.05 && value <= 0.05).length;
    const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    let equity = 0; let peak = 0; let maxDrawdownR = 0;
    for (const value of values) { equity += value; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
    const hasOutcomes = values.length > 0;
    return [key, {
      trades: values.length, signalDays, wins, smallMoves, losses: values.filter((value) => value < -0.05).length,
      winRate: hasOutcomes ? wins / values.length * 100 : null,
      expectancyR: hasOutcomes ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      profitFactor: !hasOutcomes ? null : grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : null,
      netR: hasOutcomes ? grossProfit - grossLoss : null,
      maxDrawdownR: hasOutcomes ? maxDrawdownR : null
    }];
  }));
}

function summarizeExitReasons(trades = []) {
  const grouped = new Map();
  for (const trade of trades) {
    const reason = String(trade.exitReason || 'unknown');
    if (!grouped.has(reason)) grouped.set(reason, []);
    grouped.get(reason).push(trade.realizedR);
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, values]) => {
    const wins = values.filter((value) => value > 0.05).length;
    const smallMoves = values.filter((value) => value >= -0.05 && value <= 0.05).length;
    const grossProfit = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
    let equity = 0; let peak = 0; let maxDrawdownR = 0;
    for (const value of values) { equity += value; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
    return [reason, {
      trades: values.length, wins, smallMoves, losses: values.filter((value) => value < -0.05).length,
      winRate: wins / values.length * 100,
      expectancyR: values.reduce((sum, value) => sum + value, 0) / values.length,
      profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : null,
      netR: grossProfit - grossLoss, maxDrawdownR
    }];
  }));
}

/** Validate a pinned, provider-separated candle dataset without reading or mutating bot storage. */
export function backtestHistoricalCandles(rows, { asOf, strategyOptions = {} } = {}) {
  const asOfMs = Number.isFinite(Number(asOf)) ? Number(asOf) : Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || asOfMs <= 0) throw new TypeError('An explicit valid asOf timestamp is required for reproducible historical replay.');
  if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('Historical input must contain at least one candle row.');
  const groups = new Map();
  for (const row of rows) {
    const symbol = String(row?.symbol ?? '').trim().toUpperCase();
    const provider = String(row?.provider ?? 'unknown').trim().toLowerCase();
    if (!symbol) throw new TypeError('Every historical candle row must include a symbol.');
    const key = `${symbol}\u0000${provider}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  if (!groups.size) throw new TypeError('Historical input has no rows with a symbol.');
  const series = new Map([...groups.entries()].map(([key, sourceRows]) => [key, normalizeCandles(
    sourceRows.filter((row) => Number.isFinite(Number(row?.time)) && Number(row.time) > 0 && Number(row.time) + BAR_MS <= asOfMs)
  )]));
  const reportRows = [...groups.entries()].map(([key, sourceRows]) => {
    const [symbol, provider] = key.split('\u0000');
    const validTimestampRows = sourceRows.filter((row) => Number.isFinite(Number(row?.time)) && Number(row.time) > 0);
    const completed = validTimestampRows.filter((row) => Number(row.time) + BAR_MS <= asOfMs);
    const candles = normalizeCandles(completed);
    // Imported historical rows commonly name the asset `BTC` and store `BTCUSDT` in `pair`;
    // newer feeds may put the pair itself in `symbol`. Keep the match provider-scoped.
    const benchmark = series.get(`BTCUSDT\u0000${provider}`) || series.get(`BTC\u0000${provider}`);
    const regimeCache = new Map();
    const marketRegimeAtSignal = (signalCandle) => {
      if (!benchmark?.length) return 'unknown';
      // Signals are available only after their candle closes. Never classify with an unfinished BTC bar.
      const decisionTime = Number(signalCandle.time) + BAR_MS;
      if (regimeCache.has(decisionTime)) return regimeCache.get(decisionTime);
      const lastIndex = findLastCompletedIndex(benchmark, decisionTime);
      if (lastIndex < 79) { regimeCache.set(decisionTime, 'unknown'); return 'unknown'; }
      const recent = benchmark.slice(Math.max(0, lastIndex - 239), lastIndex + 1);
      const technicals = analyzeCandles(recent);
      const regime = technicals.dataSufficient ? classifyMarketRegime(technicals).key : 'unknown';
      regimeCache.set(decisionTime, regime);
      return regime;
    };
    const validation = validateStrategy(candles, { ...strategyOptions, marketRegimeAtSignal });
    const summarize = (segment) => ({
      trades: segment.trades, wins: segment.wins, smallMoves: segment.smallMoves, losses: segment.losses,
      winRate: segment.winRate, expectancyR: segment.expectancyR, profitFactor: segment.profitFactor,
      netR: segment.netR, maxDrawdownR: segment.maxDrawdownR,
      costScheduleGapSignals: segment.costScheduleGapSignals,
      costModelsUsed: segment.costModel?.rowsUsed ?? null,
    });
    return {
      symbol, provider, sourceRows: sourceRows.length, invalidTimestampRowsDropped: sourceRows.length - validTimestampRows.length,
      incompleteOrFutureBarsExcluded: validTimestampRows.length - completed.length,
      malformedOrDuplicateRowsDropped: completed.length - candles.length, candleCount: candles.length,
      coverage: validation.coverage, sufficient: validation.sufficient, warning: validation.warning,
      costModel: validation.costModel,
      earlier: summarize(validation.earlier), recent: summarize(validation.recent), overall: summarize(validation.overall),
      performanceByMarketRegime: {
        earlier: summarizeRegimes(validation.earlier.tradesList),
        recent: summarizeRegimes(validation.recent.tradesList),
        overall: summarizeRegimes(validation.overall.tradesList)
      },
      performanceByExitReason: {
        earlier: summarizeExitReasons(validation.earlier.tradesList),
        recent: summarizeExitReasons(validation.recent.tradesList),
        overall: summarizeExitReasons(validation.overall.tradesList)
      },
      edgeEvidence: validation.evidence,
    };
  });
  return reportRows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.provider.localeCompare(b.provider));
}
