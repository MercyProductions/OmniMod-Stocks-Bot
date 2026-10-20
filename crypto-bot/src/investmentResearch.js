import { updateInvestmentJournal, pendingInvestmentSymbols } from './investmentJournal.js';
import { recordTokenSupplySnapshots } from './tokenSupplyJournal.js';
import { normalizeCandles } from './technicalAnalysis.js';
import { fetchHistoricalCandles } from './marketProviders.js';

const DAY = 86_400_000;
export const LONG_TERM_PRICE_WINDOWS = Object.freeze([90, 180, 365, 540, 730]);
const mean = (rows) => rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const stablecoins = new Set(['USDT', 'USDC', 'DAI', 'USDE', 'USDS', 'FDUSD', 'TUSD', 'PYUSD', 'USDD']);

function benchmarkStressContext(candles) {
  const returns = [];
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].time - candles[index - 1].time !== DAY) returns.length = 0;
    else returns.push(Number(candles[index].close) / Number(candles[index - 1].close) - 1);
  }
  const volatilityFor = (sample) => {
    if (sample.length < 20) return null;
    const average = mean(sample);
    return Math.sqrt(mean(sample.map((value) => (value - average) ** 2)) * 365) * 100;
  };
  const currentVolatility = volatilityFor(returns.slice(-20));
  const historicalVolatility = [];
  for (let end = Math.max(19, returns.length - 251); end < returns.length; end += 1) {
    const value = volatilityFor(returns.slice(end - 19, end + 1));
    if (Number.isFinite(value)) historicalVolatility.push(value);
  }
  const volatilityTolerance = Number.isFinite(currentVolatility) ? Math.max(1e-10, Math.abs(currentVolatility) * 1e-6) : 0;
  const volatilityPercentile = Number.isFinite(currentVolatility) && historicalVolatility.length >= 40
    ? (historicalVolatility.filter((value) => value < currentVolatility - volatilityTolerance).length
      + historicalVolatility.filter((value) => Math.abs(value - currentVolatility) <= volatilityTolerance).length / 2) / historicalVolatility.length * 100
    : null;
  const volatilityRegime = volatilityPercentile === null ? 'insufficient_history'
    : volatilityPercentile < 25 ? 'lower_quartile'
      : volatilityPercentile >= 90 ? 'extreme' : volatilityPercentile >= 75 ? 'elevated' : 'typical';
  const trailing = candles.slice(-252);
  const peak = Math.max(...trailing.map((row) => Number(row.close)).filter((value) => Number.isFinite(value) && value > 0));
  const drawdownPct = peak > 0 && Number(candles.at(-1)?.close) > 0 ? (Number(candles.at(-1).close) / peak - 1) * 100 : null;
  return { annualizedVolatilityPct: currentVolatility, volatilityPercentile, volatilityRegime,
    volatilityWindows: historicalVolatility.length, drawdownFrom252DayPeakPct: drawdownPct };
}

export function isInvestmentSnapshotFresh(snapshot, now = new Date(), maximumAgeMinutes = 60) {
  const time = Date.parse(snapshot?.fetchedAt);
  const age = new Date(now).getTime() - time;
  return !snapshot?.stale && Number.isFinite(time) && age >= 0 && age <= maximumAgeMinutes * 60_000;
}

export function classifyBenchmarkRegime(candles = []) {
  const end = candles.length - 1;
  const latest = candles[end];
  if (end < 219 || !latest) return { label: 'insufficient_history', asOf: latest ? new Date(latest.time + DAY).toISOString() : null,
    method: 'Requires 220 completed BTC daily closes.' };
  const sma50 = mean(candles.slice(end - 49, end + 1).map((row) => row.close));
  const sma200 = mean(candles.slice(end - 199, end + 1).map((row) => row.close));
  const prior50 = mean(candles.slice(end - 69, end - 19).map((row) => row.close));
  const label = latest.close > sma200 && sma50 > sma200 && sma50 > prior50 ? 'risk_on'
    : latest.close < sma200 && sma50 < sma200 && sma50 < prior50 ? 'risk_off' : 'mixed';
  return { label, asOf: new Date(latest.time + DAY).toISOString(), close: latest.close, sma50, sma200,
    sma50Change20Pct: (sma50 / prior50 - 1) * 100,
    ...benchmarkStressContext(candles),
    method: 'Price-only descriptive regime: trend uses close/SMA50/SMA200; 20-consecutive-day realized volatility is ranked against up to 252 trailing rolling observations (annualized using 365 periods); drawdown is from the trailing 252-day peak. Missing-day gaps reset volatility history. No macro, breadth, or credit data; not a crash predictor and not used to alter asset scores.' };
}

export function completedDailyCandles(candles, now = new Date()) {
  return normalizeCandles(candles).filter((row) => row.time % DAY === 0 && row.time + DAY <= new Date(now).getTime());
}
function contiguous(rows) { return rows.every((row, index) => index === 0 || row.time - rows[index - 1].time === DAY); }
function trailingReturn(rows, period) { return rows.length > period ? (rows.at(-1).close / rows.at(-1 - period).close - 1) * 100 : null; }
function longTermPriceContext(rows, benchmarkRows) {
  const benchmarkByTime = new Map(benchmarkRows.map((row) => [row.time, row]));
  return LONG_TERM_PRICE_WINDOWS.map((days) => {
    const requiredBars = days + 1;
    const window = rows.slice(-requiredBars);
    if (window.length < requiredBars) return { days, status: 'insufficient_history', requiredBars, availableBars: rows.length,
      assetReturnPct: null, benchmarkReturnPct: null, excessVsBenchmarkPct: null };
    if (!contiguous(window)) return { days, status: 'gapped_asset_history', requiredBars, availableBars: window.length,
      assetReturnPct: null, benchmarkReturnPct: null, excessVsBenchmarkPct: null };
    const benchmark = window.map((row) => benchmarkByTime.get(row.time));
    if (benchmark.some((row) => !row) || !contiguous(benchmark)) return { days, status: 'unmatched_benchmark_history', requiredBars,
      availableBars: window.length, assetReturnPct: null, benchmarkReturnPct: null, excessVsBenchmarkPct: null };
    const assetReturnPct = trailingReturn(window, days), benchmarkReturnPct = trailingReturn(benchmark, days);
    return { days, status: 'observed', requiredBars, availableBars: window.length,
      startDate: new Date(window[0].time).toISOString().slice(0, 10), endDate: new Date(window.at(-1).time).toISOString().slice(0, 10),
      assetReturnPct, benchmarkReturnPct, excessVsBenchmarkPct: assetReturnPct - benchmarkReturnPct };
  });
}
function maxDrawdown(rows) {
  let peak = rows[0]?.close || 0, maximum = 0;
  for (const row of rows) { peak = Math.max(peak, row.close); maximum = Math.max(maximum, (peak - row.close) / peak * 100); }
  return maximum;
}

export function deriveSupplyContext(snapshot = {}) {
  const number = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const circulating = number(snapshot.circulating);
  const total = number(snapshot.total);
  const maximum = number(snapshot.maximum);
  const marketCap = number(snapshot.marketCapUsd);
  const fdv = number(snapshot.fullyDilutedValuationUsd);
  const issues = [];
  const circulatingOfTotalPct = circulating && total && circulating <= total ? circulating / total * 100 : null;
  const circulatingOfMaximumPct = circulating && maximum && circulating <= maximum ? circulating / maximum * 100 : null;
  const fdvPremiumPct = marketCap && fdv && fdv >= marketCap ? (fdv / marketCap - 1) * 100 : null;
  if (circulating && total && circulating > total) issues.push('reported circulating supply exceeds reported total supply');
  if (circulating && maximum && circulating > maximum) issues.push('reported circulating supply exceeds reported maximum supply');
  if (marketCap && fdv && fdv < marketCap) issues.push('reported FDV is below reported market capitalization');
  return { circulatingOfTotalPct, circulatingOfMaximumPct, fdvPremiumPct, source: snapshot.source || null,
    observedAt: snapshot.observedAt || null, issues, method: 'Ratios use only positive fields from the same provider snapshot; they are descriptive and do not establish scheduled dilution or token value capture.' };
}

export function selectInvestmentCandidates(assets = [], maximum = 12) {
  const limit = Math.max(1, Math.min(20, Math.floor(Number(maximum) || 12)));
  const unique = [...new Map(assets.filter((asset) => asset?.id && asset?.symbol && !stablecoins.has(String(asset.symbol).toUpperCase()))
    .map((asset) => [String(asset.id), asset])).values()];
  const byCap = [...unique].sort((a, b) => (Number(a.rank) || 100000) - (Number(b.rank) || 100000));
  const coreCount = Math.min(byCap.length, Math.max(1, Math.ceil(limit / 2)));
  const selected = new Map(byCap.slice(0, coreCount).map((asset) => [String(asset.id), { ...asset, selectionTrack: 'market-cap core' }]));
  const remaining = byCap.filter((asset) => !selected.has(String(asset.id)));
  const satelliteSlots = Math.max(0, limit - selected.size);
  const momentumCount = Math.floor(satelliteSlots / 2);
  const turnoverCount = satelliteSlots - momentumCount;
  const momentum = [...remaining].sort((a, b) => (Number(b.change7d) || -Infinity) - (Number(a.change7d) || -Infinity)
    || (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity)
    || (Number(a.rank) || 100000) - (Number(b.rank) || 100000));
  for (const asset of momentum.slice(0, momentumCount)) selected.set(String(asset.id), { ...asset, selectionTrack: 'weekly momentum discovery' });
  const afterMomentum = remaining.filter((asset) => !selected.has(String(asset.id)));
  const turnover = [...afterMomentum].sort((a, b) => (Number(b.volumeToMarketCap) || -Infinity) - (Number(a.volumeToMarketCap) || -Infinity)
    || (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0)
    || (Number(a.rank) || 100000) - (Number(b.rank) || 100000));
  for (const asset of turnover.slice(0, turnoverCount)) selected.set(String(asset.id), { ...asset, selectionTrack: 'relative-turnover discovery' });
  for (const asset of byCap) {
    if (selected.size >= limit) break;
    if (!selected.has(String(asset.id))) selected.set(String(asset.id), { ...asset, selectionTrack: 'market-cap fill' });
  }
  return [...selected.values()].slice(0, limit);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: String(error?.message || error).slice(0, 200) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(items.length, limit)) }, () => next()));
  return results;
}

export function analyzeInvestment(asset, source, benchmarkSource, options = {}) {
  const now = new Date(options.now ?? Date.now());
  const rows = completedDailyCandles(source, now);
  const benchmark = completedDailyCandles(benchmarkSource, now);
  const longTermPerformance = longTermPriceContext(rows, benchmark);
  const marketRegime = classifyBenchmarkRegime(benchmark);
  const benchmarkByTime = new Map(benchmark.map((row) => [row.time, row]));
  const latest = rows.at(-1);
  const recent = rows.slice(-200);
  const reasons = [];
  if (rows.length < 200) reasons.push('Fewer than 200 completed daily bars.');
  if (!contiguous(recent)) reasons.push('Gaps in the recent daily history.');
  if (!latest || now.getTime() - (latest.time + DAY) > DAY * 2) reasons.push('Daily history is stale or unavailable.');
  if (recent.some((row) => !benchmarkByTime.has(row.time))) reasons.push('BTC benchmark dates are missing or misaligned.');
  if (stablecoins.has(String(asset.symbol).toUpperCase())) reasons.push('Stablecoin excluded from capital-growth ranking.');
  const volumeUsd = Number(asset.volume24h);
  const supplySnapshot = {
    circulating: asset.circulatingSupply == null ? null : Number(asset.circulatingSupply),
    total: asset.totalSupply == null ? null : Number(asset.totalSupply),
    maximum: asset.maxSupply == null ? null : Number(asset.maxSupply),
    marketCapUsd: asset.marketCap == null ? null : Number(asset.marketCap),
    fullyDilutedValuationUsd: asset.fullyDilutedValuation == null ? null : Number(asset.fullyDilutedValuation),
    source: options.snapshotSource || null,
    observedAt: options.snapshotFetchedAt || null
  };
  const supplyContext = deriveSupplyContext(supplySnapshot);
  const minimumVolumeUsd = Number(options.minVolumeUsd) || 5_000_000;
  const hasVolumeSnapshot = asset.volume24h !== null && asset.volume24h !== undefined && asset.volume24h !== ''
    && Number.isFinite(volumeUsd);
  if (!hasVolumeSnapshot) reasons.push('Current 24-hour dollar-volume snapshot is unavailable; liquidity cannot be evaluated.');
  else if (volumeUsd < minimumVolumeUsd) reasons.push(`Reported 24-hour dollar volume is below the $${minimumVolumeUsd.toLocaleString('en-US')} research minimum.`);
  const sufficient = reasons.length === 0;
  if (!sufficient) return { symbol: asset.symbol, assetId: asset.id, suitableForWatch: false, decision: 'INSUFFICIENT / UNSUITABLE', score: null, reasons, candles: rows.length, asOf: latest ? new Date(latest.time + DAY).toISOString() : null, supplySnapshot, supplyContext, marketRegime, longTermPerformance };
  const sma50 = mean(rows.slice(-50).map((row) => row.close));
  const sma200 = mean(recent.map((row) => row.close));
  const return20Pct = trailingReturn(rows, 20), return60Pct = trailingReturn(rows, 60);
  const matched = rows.map((row) => benchmarkByTime.get(row.time)).filter(Boolean);
  const benchmark20Pct = trailingReturn(matched, 20), benchmark60Pct = trailingReturn(matched, 60);
  const excess20Pct = return20Pct - benchmark20Pct, excess60Pct = return60Pct - benchmark60Pct;
  const returns = rows.slice(-61).slice(1).map((row, index) => Math.log(row.close / rows.slice(-61)[index].close));
  const average = mean(returns);
  const volatilityPct = Math.sqrt(returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1)) * Math.sqrt(365) * 100;
  const drawdown90Pct = maxDrawdown(rows.slice(-90));
  const recentDrawdownPct = (1 - latest.close / Math.max(...rows.slice(-90).map((row) => row.close))) * 100;
  const trendPersistencePct = rows.slice(-60).filter((row, index) => {
    const offset = rows.length - 60 + index;
    return row.close > mean(rows.slice(offset - 49, offset + 1).map((value) => value.close));
  }).length / 60 * 100;
  const isBenchmark = String(asset.symbol).toUpperCase() === 'BTC';
  const constructive = latest.close > sma200 && sma50 > sma200 && trendPersistencePct >= 60;
  const relativeStrength = isBenchmark || excess60Pct > 0;
  const risks = [];
  if (!constructive) risks.push('Daily trend misses one or more criteria: price above SMA200, SMA50 above SMA200, or at least 60% 50-day trend persistence.');
  if (!relativeStrength) risks.push('Lagged BTC over the last 60 completed days.');
  if (volatilityPct > 90) risks.push('Very high 60-day annualized volatility.');
  if (drawdown90Pct > 30) risks.push('More than 30% peak-to-trough loss in the last 90 daily closes.');
  const score = Math.round(clamp((constructive ? 30 : 5) + trendPersistencePct * .25
    + clamp(excess60Pct, -20, 20) + clamp(excess20Pct / 2, -10, 10)
    + (latest.close > sma50 ? 15 : 0) - Math.max(0, volatilityPct - 60) * .15 - drawdown90Pct * .25, 0, 100));
  return { symbol: asset.symbol, assetId: asset.id, name: asset.name, score, candles: rows.length,
    asOf: new Date(latest.time + DAY).toISOString(), price: latest.close, sma50, sma200,
    supplySnapshot, supplyContext, marketRegime,
    longTermPerformance,
    return20Pct, return60Pct, benchmark20Pct, benchmark60Pct, excess20Pct, excess60Pct,
    volatilityPct, drawdown90Pct, recentDrawdownPct, trendPersistencePct, volumeUsd,
    suitableForWatch: constructive && relativeStrength && volatilityPct <= 90 && drawdown90Pct <= 30,
    decision: constructive && relativeStrength && volatilityPct <= 90 && drawdown90Pct <= 30 ? 'DAILY TREND WATCH' : 'WAIT / HIGH RISK',
    reasons: risks.length ? risks : ['Persistent daily trend with BTC-relative confirmation; research further before allocating.'],
    disclaimer: 'Ordinal research score, not a probability or buy instruction. Technical evidence does not measure intrinsic value.' };
}

export function evaluateInvestmentHorizons(source, benchmarkSource, options = {}) {
  const rows = completedDailyCandles(source, options.now);
  const benchmark = new Map(completedDailyCandles(benchmarkSource, options.now).map((row) => [row.time, row]));
  const fee = clamp(Number(options.roundTripFeeBps ?? 20), 0, 1000) / 10000;
  return [5, 20, 60].map((horizonDays) => {
    const trades = [];
    for (let signal = 199; signal + horizonDays < rows.length; signal += 1) {
      const past = rows.slice(signal - 199, signal + 1);
      const sma50 = mean(past.slice(-50).map((row) => row.close));
      const sma200 = mean(past.map((row) => row.close));
      // A fixed daily rule, evaluated without future bars or present-day liquidity.
      if (!contiguous(past) || past.at(-1).close <= sma200 || sma50 <= sma200) continue;
      const signalBenchmark = benchmark.get(rows[signal].time);
      const priorBenchmark = benchmark.get(rows[signal - 60].time);
      if (!signalBenchmark || !priorBenchmark || rows[signal].close / rows[signal - 60].close < signalBenchmark.close / priorBenchmark.close) continue;
      const entryIndex = signal + 1, exitIndex = signal + horizonDays;
      const window = rows.slice(entryIndex, exitIndex + 1);
      const benchmarkEntry = benchmark.get(rows[entryIndex].time), benchmarkExit = benchmark.get(rows[exitIndex].time);
      if (!contiguous(window) || !benchmarkEntry || !benchmarkExit || rows[entryIndex].time - rows[signal].time !== DAY) continue;
      const netReturnPct = (rows[exitIndex].close / rows[entryIndex].open - 1 - fee) * 100;
      const benchmarkReturnPct = (benchmarkExit.close / benchmarkEntry.open - 1 - fee) * 100;
      trades.push({ signalAt: new Date(rows[signal].time + DAY).toISOString(),
        entryAt: new Date(rows[entryIndex].time).toISOString(), exitAt: new Date(rows[exitIndex].time + DAY).toISOString(),
        netReturnPct, benchmarkReturnPct, excessReturnPct: netReturnPct - benchmarkReturnPct,
        worstExcursionPct: (Math.min(...window.map((row) => row.low)) / rows[entryIndex].open - 1) * 100 });
      signal = exitIndex;
    }
    return { horizonDays, samples: trades.length, meanNetReturnPct: mean(trades.map((row) => row.netReturnPct)),
      meanExcessReturnPct: mean(trades.map((row) => row.excessReturnPct)),
      worstReturnPct: trades.length ? Math.min(...trades.map((row) => row.netReturnPct)) : null,
      worstExcursionPct: trades.length ? Math.min(...trades.map((row) => row.worstExcursionPct)) : null,
      evidence: trades.length < 20 ? 'INSUFFICIENT independent windows' : 'DESCRIPTIVE historical windows; no untouched strategy-selection holdout', trades };
  });
}

export async function researchInvestments(assets, options = {}) {
  const benchmarkAsset = assets.find((asset) => String(asset.symbol).toUpperCase() === 'BTC') || { id: 'bitcoin', symbol: 'BTC' };
  const historyFetcher = options.historyFetcher || fetchHistoricalCandles;
  const historyLimit = 1000;
  const benchmark = await historyFetcher(benchmarkAsset, { interval: '1d', limit: historyLimit });
  const selected = selectInvestmentCandidates(assets, options.maxCandidates ?? 12);
  const results = [];
  const contexts = [];
  // Keep the endpoint budget bounded and avoid fully serial per-asset history retrieval.
  const researched = await mapLimit(selected, 2, async (asset) => {
    try {
      const history = String(asset.symbol).toUpperCase() === 'BTC' ? benchmark : await historyFetcher(asset, { interval: '1d', limit: historyLimit });
      if (history?.error) return { asset, history, result: { symbol: asset.symbol, assetId: asset.id, decision: 'INSUFFICIENT / UNSUITABLE', score: null,
        reasons: [history.error], selectionTrack: asset.selectionTrack, asOf: null } };
      const result = { ...analyzeInvestment(asset, history.candles, benchmark.candles, options), provider: history.provider,
        errors: history.errors, horizons: evaluateInvestmentHorizons(history.candles, benchmark.candles, options), selectionTrack: asset.selectionTrack };
      return { asset, history, result };
    } catch (error) {
      const history = { provider: '', candles: [], errors: [String(error?.message || error).slice(0, 180)] };
      return { asset, history, result: { ...analyzeInvestment(asset, [], benchmark.candles, options), provider: '', errors: history.errors,
        selectionTrack: asset.selectionTrack } };
    }
  });
  for (const item of researched) {
    results.push(item.result);
    contexts.push({ result: item.result, history: item.history });
  }
  if (options.guildId) {
    const pending = await pendingInvestmentSymbols(options.guildId, results.map((row) => row.symbol), options);
    for (const row of pending) {
      const history = await fetchHistoricalCandles({ id: row.assetId, symbol: row.symbol }, {
        interval: '1d', limit: historyLimit, providers: [row.dataProvider]
      });
      contexts.push({ capture: false, result: { symbol: row.symbol, assetId: row.assetId, asOf: null }, history });
    }
  }
  const forwardJournal = options.guildId ? await updateInvestmentJournal(options.guildId, contexts, benchmark, options) : null;
  for (const result of results) result.forwardEvidence = forwardJournal?.bySymbol[result.symbol] || null;
  let supplyHistory = { byAssetId: {} }, supplyHistoryError = '';
  if (options.guildId) {
    try {
      supplyHistory = await recordTokenSupplySnapshots(options.guildId, contexts, options);
    } catch (error) {
      supplyHistoryError = String(error.message || error).slice(0, 200);
    }
  }
  for (const result of results) result.supplyHistory = supplyHistory.byAssetId?.[result.assetId] || null;
  return { forwardJournal, candidatePoolSize: assets.filter((asset) => asset?.id && asset?.symbol && !stablecoins.has(String(asset.symbol).toUpperCase())).length,
    candidateCount: selected.length, results: results.sort((a, b) => Number(b.suitableForWatch) - Number(a.suitableForWatch) || (b.score ?? -1) - (a.score ?? -1)),
    supplyHistoryError,
    benchmarkProvider: benchmark.provider, benchmarkErrors: benchmark.errors,
    benchmarkRegime: results[0]?.marketRegime || classifyBenchmarkRegime(benchmark.candles),
    universeNote: `Selected ${selected.length} of ${assets.length} assets in the current provider snapshot across market-cap, weekly-momentum and relative-turnover tracks; current-universe survivorship and symbol-only venue mapping remain limitations.` };
}
