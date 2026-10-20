import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backtestHistoricalCandles } from '../src/historicalBacktest.js';
import { scheduledCryptoCostModelAt, validateExecutionCostSchedule } from '../src/executionCostSchedule.js';

function parseArgs(argv) {
  return Object.fromEntries(argv.map((item) => {
    const [key, ...parts] = item.replace(/^--/, '').split('=');
    return [key, parts.length ? parts.join('=') : 'true'];
  }));
}

export async function loadHistoricalRows(file) {
  if (!file) throw new Error('Pass --data=<file.json|file.ndjson>.');
  const text = await fs.readFile(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.ndjson') return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload) ? payload : payload?.candles;
  if (!Array.isArray(rows)) throw new TypeError('JSON historical dataset must be a candle array or contain a candles array.');
  return rows;
}

export async function runHistoricalBacktest(args) {
  const dataset = path.resolve(args.data || '');
  if (!args.data) throw new Error('Pass --data=<file.json|file.ndjson>.');
  const rows = await loadHistoricalRows(dataset);
  const strategyOptions = {};
  for (const key of ['roundTripFeeBps', 'feeBpsPerSide', 'quotedSpreadBps', 'slippageBpsPerSide', 'minimumScore', 'rewardRisk', 'horizonBars', 'stopAtrMultiplier']) {
    if (args[key] !== undefined) {
      const value = Number(args[key]);
      if (!Number.isFinite(value)) throw new TypeError(`--${key} must be numeric.`);
      strategyOptions[key] = value;
    }
  }
  const schedulePath = args.costSchedule || args['cost-schedule'];
  let executionCostSchedule;
  if (schedulePath) {
    if (strategyOptions.roundTripFeeBps !== undefined || strategyOptions.feeBpsPerSide !== undefined || strategyOptions.slippageBpsPerSide !== undefined) throw new TypeError('A dated cost schedule cannot be combined with static round-trip, fee, or slippage inputs.');
    const payload = JSON.parse(await fs.readFile(path.resolve(schedulePath), 'utf8'));
    executionCostSchedule = validateExecutionCostSchedule(Array.isArray(payload) ? payload : payload?.rows);
    const quotedSpreadBps = strategyOptions.quotedSpreadBps ?? 0;
    strategyOptions.costModelAt = (timestamp) => scheduledCryptoCostModelAt(executionCostSchedule, timestamp, quotedSpreadBps);
    strategyOptions.quotedSpreadBps = quotedSpreadBps;
  }
  const report = backtestHistoricalCandles(rows, { asOf: args.asOf, strategyOptions });
  const reportStrategyOptions = { ...strategyOptions };
  delete reportStrategyOptions.costModelAt;
  return { mode: 'offline-historical-validation', dataset, datasetRows: rows.length, asOf: new Date(Number.isFinite(Number(args.asOf)) ? Number(args.asOf) : Date.parse(args.asOf)).toISOString(), strategyOptions: reportStrategyOptions,
    executionCostSchedule: executionCostSchedule ? { rows: executionCostSchedule.length, source: path.resolve(schedulePath), interval: '[validFrom, validUntil); candidates in gaps are skipped' } : null,
    results: report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runHistoricalBacktest(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`Historical crypto backtest failed: ${String(error?.message || error).slice(0, 240)}`); process.exitCode = 1; }
}
