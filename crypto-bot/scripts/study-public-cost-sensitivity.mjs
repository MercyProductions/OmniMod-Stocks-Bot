import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessStrategyValidation } from '../src/cryptoData.js';
import { validateStrategy } from '../src/backtest.js';
import { normalizeCandles } from '../src/technicalAnalysis.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPORT = path.join(ROOT, 'PUBLIC_FUNNEL_PROBE.md');
const CANDLE_DIR = path.join(ROOT, 'data/public-funnel-probe/research');
const OUTPUT = path.join(ROOT, 'PUBLIC_COST_SENSITIVITY.md');
const BAR_MS = 900_000;

function measured(value, count) {
  return count > 0 && Number.isFinite(value) ? value : null;
}

function measuredProfitFactor(value, count) {
  return count > 0 && value === Infinity ? 'infinite' : measured(value, count);
}

function summary(validation) {
  return {
    recent: { trades: validation.recent.trades, signalDays: validation.coverage.recent.signalDays,
      expectancyR: measured(validation.recent.expectancyR, validation.recent.trades),
      profitFactor: measuredProfitFactor(validation.recent.profitFactor, validation.recent.trades) },
    overall: { trades: validation.overall.trades, signalDays: validation.coverage.overall.signalDays,
      expectancyR: measured(validation.overall.expectancyR, validation.overall.trades),
      profitFactor: measuredProfitFactor(validation.overall.profitFactor, validation.overall.trades) },
    validationReasons: assessStrategyValidation(validation).reasons,
  };
}

export function comparePinnedCostScenario(asset, sourceRows, settings = {}) {
  const first = Date.parse(asset?.candleCoverage?.firstOpenAt || '');
  const last = Date.parse(asset?.candleCoverage?.lastCompletedAt || '');
  const baseCostBps = Number(asset?.strategyValidationCostRoundTripBps);
  const quoteCostBps = Number(asset?.executionEstimatedRoundTripBps);
  const unavailable = (reason) => ({ assetId: asset?.assetId || null, symbol: asset?.symbol || null,
    status: 'unavailable', reason });
  if (!asset?.candleProvider || !asset?.candlePair || !Number.isFinite(first) || !Number.isFinite(last)
    || !(last > first) || !Number.isInteger(asset.candleCount) || asset.candleCount < 100)
    return unavailable('missing_or_invalid_frozen_candle_identity');
  if (!Number.isFinite(baseCostBps) || baseCostBps < 0 || baseCostBps > 200
    || !Number.isFinite(quoteCostBps) || quoteCostBps < 0 || quoteCostBps > 200)
    return unavailable('cost_outside_replay_range');
  if (asset.candleCoverage?.contiguous !== true) return unavailable('incomplete_frozen_candle_path');
  if (!Number.isInteger(asset.strategyValidationRecentTrades) || asset.strategyValidationRecentTrades < 0
    || !Number.isInteger(asset.strategyValidationOverallTrades) || asset.strategyValidationOverallTrades < 0
    || (asset.strategyValidationRecentTrades > 0
      ? !Number.isFinite(asset.strategyValidationRecentExpectancyR)
      : asset.strategyValidationRecentExpectancyR !== null)
    || (asset.strategyValidationOverallTrades > 0
      ? !Number.isFinite(asset.strategyValidationOverallExpectancyR)
      : asset.strategyValidationOverallExpectancyR !== null))
    return unavailable('missing_frozen_baseline_metrics');
  const selected = sourceRows.filter((row) => row.provider === asset.candleProvider
    && row.pair === asset.candlePair && row.time >= first && row.time + BAR_MS <= last);
  const seen = new Map();
  for (const row of selected) {
    const fingerprint = JSON.stringify([row.open, row.high, row.low, row.close, row.volume]);
    if (seen.has(row.time) && seen.get(row.time) !== fingerprint) return unavailable('conflicting_source_candles');
    seen.set(row.time, fingerprint);
  }
  const candles = normalizeCandles(selected);
  if (candles.length !== asset.candleCount || candles[0]?.time !== first
    || candles.at(-1)?.time + BAR_MS !== last
    || candles.some((row, index) => index > 0 && row.time - candles[index - 1].time !== BAR_MS))
    return unavailable('frozen_candle_coverage_mismatch');
  const common = { minimumScore: settings.minScore, rewardRisk: settings.minRiskReward };
  const base = validateStrategy(candles, { ...common, roundTripFeeBps: baseCostBps });
  const reportedRecent = asset.strategyValidationRecentExpectancyR;
  const reportedOverall = asset.strategyValidationOverallExpectancyR;
  if (base.recent.trades !== asset.strategyValidationRecentTrades
    || base.overall.trades !== asset.strategyValidationOverallTrades
    || (reportedRecent !== null && Math.abs(base.recent.expectancyR - reportedRecent) > 1e-8)
    || (reportedOverall !== null && Math.abs(base.overall.expectancyR - reportedOverall) > 1e-8))
    return unavailable('frozen_baseline_replay_mismatch');
  const quoteScenario = validateStrategy(candles, { ...common, roundTripFeeBps: quoteCostBps });
  return { assetId: asset.assetId, symbol: asset.symbol, status: 'compared',
    candleProvider: asset.candleProvider, candlePair: asset.candlePair,
    firstOpenAt: asset.candleCoverage.firstOpenAt, lastCompletedAt: asset.candleCoverage.lastCompletedAt,
    candleCount: candles.length,
    candleSha256: createHash('sha256').update(JSON.stringify(candles)).digest('hex'),
    baseCostBps, quoteScenarioCostBps: quoteCostBps, costDifferenceBps: quoteCostBps - baseCostBps,
    baseline: summary(base), quoteCostScenario: summary(quoteScenario) };
}

async function run() {
  const text = await readFile(REPORT, 'utf8');
  const json = text.split('```json')[1]?.split('```')[0];
  if (!json) throw new Error('The latest public funnel report has no JSON payload.');
  const probe = JSON.parse(json);
  if (probe.deepAnalysis?.status !== 'public_diagnostic_only')
    throw new Error('The latest public funnel report did not run deep analysis.');
  const names = await readdir(CANDLE_DIR);
  const rows = [];
  for (const asset of probe.deepAnalysis.assets || []) {
    const symbol = String(asset.symbol || '').toLowerCase().replace(/[^0-9a-z_-]/g, '-');
    const files = names.filter((name) => name.startsWith(`candles-${symbol}-`) && name.endsWith('.ndjson'));
    const candles = [];
    for (const name of files) {
      for (const line of (await readFile(path.join(CANDLE_DIR, name), 'utf8')).split(/\r?\n/)) {
        if (line) candles.push(JSON.parse(line));
      }
    }
    rows.push(comparePinnedCostScenario(asset, candles, probe.settings));
  }
  const compared = rows.filter((row) => row.status === 'compared');
  const report = {
    generatedAt: new Date().toISOString(), probeSnapshotFetchedAt: probe.snapshot.fetchedAt,
    probeCompletedAt: probe.completedAt, probeStrictCandidates: probe.deepAnalysis.strictScreenCandidates,
    compared: compared.length, unavailable: rows.length - compared.length,
    quoteScenarioCostAboveBaseline: compared.filter((row) => row.costDifferenceBps > 0).length,
    baselineValidationPassing: compared.filter((row) => row.baseline.validationReasons.length === 0).length,
    quoteScenarioValidationPassing: compared.filter((row) => row.quoteCostScenario.validationReasons.length === 0).length,
    rows,
    interpretation: 'Research-only cost sensitivity. A single quote-time cost estimate is applied uniformly to older OHLC candles. It is not a point-in-time spread/slippage history, an executable-fill backtest, an independent holdout, or a production approval change.',
  };
  const fmt = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
  const table = rows.map((row) => row.status !== 'compared'
    ? `| ${row.symbol} | unavailable: ${row.reason} | — | — | — | — |`
    : `| ${row.symbol} | ${fmt(row.baseCostBps)} → ${fmt(row.quoteScenarioCostBps)} | ${row.baseline.recent.trades} → ${row.quoteCostScenario.recent.trades} | ${fmt(row.baseline.recent.expectancyR)} → ${fmt(row.quoteCostScenario.recent.expectancyR)} | ${fmt(row.baseline.overall.expectancyR)} → ${fmt(row.quoteCostScenario.overall.expectancyR)} | ${row.baseline.validationReasons.length ? 'no' : 'yes'} → ${row.quoteCostScenario.validationReasons.length ? 'no' : 'yes'} |`)
    .join('\n');
  await writeFile(OUTPUT, `# Public Crypto historical cost sensitivity\n\n`+
    `Frozen discovery snapshot: ${probe.snapshot.fetchedAt}; scenario generated: ${report.generatedAt}.\n\n`+
    `This applies each asset's **current** quote-based estimated round-trip cost to its older frozen 15-minute candle history. It changes replay stop/target geometry and sometimes the trade set as well as cost deductions. An individual mean can even improve under a higher cost because the replayed trades change; that is not evidence of a better strategy. It is a research sensitivity scenario, **not** historical point-in-time execution evidence or a reason to change production approval. The original replay assumes a fixed configured cost.\n\n`+
    `| Asset | Cost, bps | Recent trades | Recent mean R | Overall mean R | Historical gate passes |\n| --- | ---: | ---: | ---: | ---: | --- |\n${table}\n\n`+
    `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  console.log(JSON.stringify({ output: OUTPUT, compared: report.compared, unavailable: report.unavailable,
    quoteScenarioCostAboveBaseline: report.quoteScenarioCostAboveBaseline,
    baselineValidationPassing: report.baselineValidationPassing,
    quoteScenarioValidationPassing: report.quoteScenarioValidationPassing }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
