import { analyzeMomentum, buildAssetFromBars, scoreAsset, updateCandidateConfirmations } from '../src/stocksData.js';
import { buildPrediction, evaluatePrediction } from '../src/predictionEngine.js';
import { parseAssumedSlippageBps, predictionCostSettings } from '../src/backtestSettings.js';
import { formatBacktestSegment } from '../src/backtestReport.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadBacktestUniverse } from '../src/backtestData.js';
import { executionCostsAt, validateExecutionCostSchedule } from '../src/executionCostSchedule.js';
import { assessBacktestManifest } from '../src/backtestManifest.js';

const DEFAULT_SYMBOLS = ['AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD','AVGO','JPM','XOM','LLY'];
const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, value = 'true'] = item.replace(/^--/, '').split('=');
  return [key, value];
}));
const localDataPath = args.data ? resolve(args.data) : null;
const localData = localDataPath ? JSON.parse(await readFile(localDataPath, 'utf8')) : null;
if (!localData) throw new Error('Backtests require a pinned local --data dataset. Automatic chart downloads are disabled; use data obtained under an authorized provider agreement.');
const manifest = assessBacktestManifest(localData.manifest, localData);
const schedulePathArg = args.costSchedule || args['cost-schedule'];
const scheduleDocument = schedulePathArg
  ? JSON.parse(await readFile(resolve(schedulePathArg), 'utf8'))
  : localData.executionCostSchedule;
const scheduleRows = Array.isArray(scheduleDocument) ? scheduleDocument : scheduleDocument?.rows;
const costSchedule = scheduleDocument == null ? null : validateExecutionCostSchedule(scheduleRows);
const localSymbols = localData?.symbols && typeof localData.symbols === 'object' ? Object.keys(localData.symbols) : [];
const symbols = [...new Set([...(args.symbols ? args.symbols.toUpperCase().split(',') : (localDataPath ? localSymbols : DEFAULT_SYMBOLS)), 'SPY', 'QQQ'])];
const range = ['5d','30d','60d'].includes(args.range) ? args.range : '60d';
const settings = {
  minPrice: Number(args.minPrice || 2),
  minAverageVolume: Number(args.minVolume || 500_000),
  minScore: Number(args.minScore || 68),
  minDataQuality: Number(args.minDataQuality || 60),
  maxSignals: Number(args.maxSignals || 3),
  earningsBlackoutDays: 0,
  confirmationScans: Number(args.confirmations || 2),
  discoveryMinutes: 30,
  monitorMinutes: 5,
  assumedSlippageBps: parseAssumedSlippageBps(args.slippageBps)
};
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const minuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const dateCache = new Map(); const minuteCache = new Map();

function dateKey(timestamp) {
  if (!dateCache.has(timestamp)) dateCache.set(timestamp, dateFormatter.format(new Date(timestamp * 1000)));
  return dateCache.get(timestamp);
}

function marketMinute(timestamp) {
  if (minuteCache.has(timestamp)) return minuteCache.get(timestamp);
  const parts = minuteFormatter.formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minute = Number(values.hour) * 60 + Number(values.minute);
  minuteCache.set(timestamp, minute);
  return minute;
}

function withContext(assets) {
  const bySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const spy = bySymbol.get('SPY'); const qqq = bySymbol.get('QQQ');
  const benchmarks = [spy, qqq].filter(Boolean);
  const marketMove = benchmarks.reduce((sum, asset) => sum + asset.changeDay, 0) / Math.max(1, benchmarks.length);
  const universe = assets.filter((asset) => !['SPY','QQQ'].includes(asset.symbol));
  const marketBreadth = universe.length ? universe.filter((asset) => asset.price > asset.dailySma20).length / universe.length * 100 : 50;
  const advancingBreadth = universe.length ? universe.filter((asset) => asset.changeDay > 0).length / universe.length * 100 : 50;
  const marketRegime = marketMove > 0.35 && marketBreadth >= 55 ? 'risk-on trend' : marketMove < -0.55 && marketBreadth < 42 ? 'risk-off trend' : Math.abs(marketMove) < 0.2 ? 'sideways' : 'mixed';
  return assets.map((asset) => {
    const contextual = {
      ...asset,
      marketMove,
      marketFiveDayMove: spy?.change5d || 0,
      marketBreadth,
      advancingBreadth,
      marketRegime,
      sectorChange: marketMove,
      sectorFiveDayChange: spy?.change5d || 0,
      relativeStrengthDay: asset.changeDay - (spy?.changeDay || marketMove),
      relativeStrength5d: asset.change5d - (spy?.change5d || 0),
      sectorRelativeStrength: asset.changeDay - marketMove
    };
    contextual.model = scoreAsset(contextual);
    return contextual;
  });
}

function completePrediction(prediction, candidate, forwardBars) {
  let current = prediction;
  // Reveal one completed candle at a time, including to the monitor's fallback
  // quote. Passing the full future path would expose its final price too early.
  for (const bar of forwardBars) {
    if (['loss','fell_short','target_hit','exceeded','not_filled'].includes(current.status)) break;
    const evaluationTime = new Date(bar.timestamp * 1000 + 15 * 60_000);
    const result = evaluatePrediction(current, { ...candidate, price: bar.close, livePrice: bar.close, recentBars: [bar] }, evaluationTime);
    current = result.prediction;
  }
  return current;
}

console.log(localDataPath
  ? `Loading ${symbols.length} symbols from local point-in-time dataset ${localDataPath}...`
  : `Loading ${symbols.length} symbols (${range} of 15-minute bars; 1 year of daily context)...`);
const loaded = await loadBacktestUniverse(symbols, { localData, dateKey, marketMinute });
const sessions = [...new Set((loaded.get('SPY')?.intraday || []).map((bar) => bar.session))].sort();
const predictions = [];
const costScheduleDiagnostics = { mode: costSchedule ? 'time-bounded-source-cited' : 'fixed-backtest-assumption', rows: costSchedule?.length ?? 0,
  scansOutsideSchedule: 0, signalsUsingSchedule: 0, appliedScheduleIds: {} };

for (const session of sessions) {
  let confirmationStates = {};
  const signaled = new Set();
  for (const scanMinute of [600, 630, 660, 690, 720, 750, 780, 810, 840, 870]) {
    const spyBar = loaded.get('SPY').intraday.find((bar) => bar.session === session && bar.minute >= scanMinute);
    if (!spyBar) continue;
    const scanTimestamp = spyBar.timestamp;
    const selectedCosts = costSchedule ? executionCostsAt(costSchedule, scanTimestamp * 1000) : null;
    if (costSchedule && !selectedCosts) { costScheduleDiagnostics.scansOutsideSchedule += 1; continue; }
    const baseAssets = [];
    for (const [symbol, series] of loaded) {
      // Provider timestamps mark bar OPEN, so its close/high/low are unavailable
      // until 15 minutes later. Never include the scan's still-future bar.
      const intradayHistory = series.intraday.filter((bar) => bar.timestamp + 15 * 60 <= scanTimestamp).slice(-160);
      const dailyHistory = series.daily.filter((bar) => bar.session < session);
      if (intradayHistory.length < 40 || dailyHistory.length < 50) continue;
      const asset = buildAssetFromBars(symbol, intradayHistory, dailyHistory);
      if (asset) baseAssets.push(asset);
    }
    const assets = withContext(baseAssets);
    const analysis = analyzeMomentum({ assets }, settings);
    const confirmation = updateCandidateConfirmations(confirmationStates, analysis.candidates, {
      now: new Date(scanTimestamp * 1000), required: settings.confirmationScans, discoveryMinutes: 30
    });
    confirmationStates = confirmation.states;
    for (const candidate of confirmation.confirmed) {
      if (signaled.has(candidate.symbol) || predictions.filter((row) => row.dateKey === session).length >= settings.maxSignals) continue;
      const executionBar = loaded.get(candidate.symbol).intraday.find((bar) => bar.timestamp === scanTimestamp);
      if (!executionBar) continue;
      signaled.add(candidate.symbol);
      const prediction = buildPrediction({ ...candidate, livePrice: executionBar.open },
        predictionCostSettings(settings, selectedCosts, candidate.spreadBps),
        'walk-forward', new Date(scanTimestamp * 1000), 'America/New_York', predictions);
      if (selectedCosts) {
        costScheduleDiagnostics.signalsUsingSchedule += 1;
        costScheduleDiagnostics.appliedScheduleIds[selectedCosts.id] = (costScheduleDiagnostics.appliedScheduleIds[selectedCosts.id] || 0) + 1;
      }
      const endTimestamp = Math.floor((new Date(prediction.deadlineAt).getTime() + (prediction.followThroughMinutes + 20) * 60_000) / 1000);
      const forward = loaded.get(candidate.symbol).intraday.filter((bar) => bar.timestamp >= scanTimestamp && bar.timestamp < endTimestamp);
      if (!forward.length) continue;
      predictions.push(completePrediction(prediction, candidate, forward));
    }
  }
}

const cutoff = sessions[Math.floor(sessions.length * 0.7)] || sessions.at(-1);
const train = predictions.filter((row) => row.dateKey < cutoff);
const holdout = predictions.filter((row) => row.dateKey >= cutoff);
const format = formatBacktestSegment;

console.log(`\nChronological RULE-ONLY replay (no validated ensemble used; no parameter fitting performed). Manifest supports point-in-time OOS review: ${manifest.metadataSupportsOosReview ? 'declared, not independently verified' : 'no'}.`);
console.table({ earlier70pct: format(train), holdout30pct: format(holdout), all: format(predictions) });
if (args.verbose === 'true') {
  console.table(predictions.map((row) => ({ date: row.dateKey, time: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }).format(new Date(row.createdAt)), symbol: row.symbol, score: Number(row.score.toFixed(1)), status: row.status, change1h: Number(finiteForReport(row.change1h).toFixed(2)), vwapPct: Number(finiteForReport(row.vwapDistancePct).toFixed(2)), rvol: Number(finiteForReport(row.relativeVolume).toFixed(2)), rsi: Number(finiteForReport(row.rsi14).toFixed(1)), stopPct: Number(row.stopPct.toFixed(2)), targetPct: Number(row.targetPct.toFixed(2)), netReturnPct: Number(finiteForReport(row.netReturnPct).toFixed(2)), maxMovePct: Number(((row.maxPrice / row.entryPrice - 1) * 100).toFixed(2)) })));
  const regimes = [...new Set(predictions.map((row) => row.marketRegime))];
  console.log('By entry regime:');
  console.table(Object.fromEntries(regimes.map((regime) => [regime || 'unknown', format(predictions.filter((row) => row.marketRegime === regime))])));
}
console.log(`Chronological later segment begins ${cutoff}. Dataset manifest: ${manifest.provider}/${manifest.datasetId}; sha256=${manifest.contentSha256}; retrieved ${manifest.retrievedAt}; timestamp=${manifest.timestampSemantics}; universe=${manifest.universeCoverage}; corporate actions=${manifest.corporateActions}; license=${manifest.licenseStatus} (${manifest.licenseReference}). Manifest values are user-supplied declarations, not independently verified. Assumptions: ${settings.slippageBps ?? settings.assumedSlippageBps} bps slippage per side, stop-first on ambiguous bars, maximum ${settings.maxSignals} signals/day.`);
console.log(`Execution costs: ${costScheduleDiagnostics.mode}; ${costScheduleDiagnostics.rows} dated schedule row(s); ${costScheduleDiagnostics.signalsUsingSchedule} signal(s) used scheduled fees/slippage; ${costScheduleDiagnostics.scansOutsideSchedule} scan(s) blocked for missing cost coverage.`);
if (costSchedule && predictions.length) console.log('Cost schedule IDs used:', costScheduleDiagnostics.appliedScheduleIds);
console.log(`Dataset limits: ${symbols.length} supplied symbols (including SPY/QQQ); point-in-time membership, data vendor/licensing, delay, and timestamp quality are not verified by this replay. Results inherit survivorship risk unless the supplied universe is historically point-in-time. Execution costs are modeled assumptions, not broker fills. This is a regression/research test, not evidence of future profit.`);

function finiteForReport(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
