import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStrategy } from '../src/backtest.js';
import { bootstrapDayClusterExpectancy } from '../src/dayClusterBootstrap.js';
import { loadVerifiedDataset, SYMBOLS } from './backtest-cross-asset-fixed-rule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HORIZONS = Object.freeze([
  { minutes: 45, bars: 3 }, { minutes: 120, bars: 8 },
  { minutes: 240, bars: 16 }, { minutes: 360, bars: 24 },
]);
const COSTS = Object.freeze({ feeBpsPerSide: 5, quotedSpreadBps: 6, slippageBpsPerSide: 2 });

function seed(text) {
  let hash = 2_166_136_261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return hash;
}

function summarizeSegment(segment, symbol, minutes, name) {
  const interval = bootstrapDayClusterExpectancy(segment.tradesList, {
    seed: seed(`${symbol}:${minutes}:${name}`),
  });
  return {
    trades: segment.trades, signalDays: interval.signalDays,
    expectancyR: segment.expectancyR, netR: segment.netR,
    profitFactor: segment.profitFactor, maxDrawdownR: segment.maxDrawdownR,
    winRatePct: segment.winRate,
    averageBarsHeld: segment.trades
      ? segment.tradesList.reduce((sum, trade) => sum + trade.barsHeld, 0) / segment.trades : null,
    exitReasons: Object.fromEntries([...new Set(segment.tradesList.map((trade) => trade.exitReason))]
      .sort().map((reason) => [reason, segment.tradesList.filter((trade) => trade.exitReason === reason).length])),
    dayClusterInterval95R: { lower: interval.lower95R, upper: interval.upper95R,
      method: interval.method },
    censoredFutureGapSignals: segment.censoredFutureGapSignals,
  };
}

const display = (value, places = 3) => Number.isFinite(value) ? value.toFixed(places) : 'unavailable';
const bounds = (row) => `[${display(row.dayClusterInterval95R.lower)}, ${display(row.dayClusterInterval95R.upper)}]`;

export async function runHorizonSensitivityStudy() {
  // The four windows are fixed from the existing product horizons. These data
  // were used in earlier exploration; this is not a blind holdout.
  const results = [];
  const manifests = {};
  for (const symbol of SYMBOLS) {
    const { rows, manifest } = await loadVerifiedDataset(symbol);
    manifests[symbol] = manifest;
    for (const horizon of HORIZONS) {
      const validation = validateStrategy(rows, { ...COSTS, horizonBars: horizon.bars });
      if (!validation.dataQuality.contiguous || !validation.sufficient) {
        throw new Error(`${symbol} ${horizon.minutes}m: incomplete candle path or insufficient replay sample.`);
      }
      results.push({ symbol, horizonMinutes: horizon.minutes, horizonBars: horizon.bars,
        datasetSha256: manifest.sha256, candleCount: validation.candleCount,
        earlier: summarizeSegment(validation.earlier, symbol, horizon.minutes, 'earlier'),
        recent: summarizeSegment(validation.recent, symbol, horizon.minutes, 'recent') });
    }
  }
  const crossAssetRows = results.filter((row) => row.symbol !== 'BTC');
  const crossAssetAllNegative = crossAssetRows.every((row) => row.earlier.expectancyR < 0
    && row.recent.expectancyR < 0 && row.recent.dayClusterInterval95R.upper < 0);
  const report = {
    study: 'Crypto fixed-rule holding-window sensitivity', asOf: '2026-09-29T17:00:00.000Z',
    fixedStudyPlan: { horizonMinutes: HORIZONS.map((row) => row.minutes),
      costModel: { ...COSTS, roundTripBps: 20 }, chronologicalSplit: 'existing fixed 65% earlier / 35% recent',
      parameters: 'same unchanged fixed rule, score, stop and reward/risk for all windows' },
    datasetManifests: manifests, results,
    descriptiveFinding: crossAssetAllNegative
      ? 'All four cross-assets have negative earlier and recent after-cost expectancy at every tested horizon; every recent day-cluster interval has an upper bound below zero. No tested horizon rescues this fixed rule under the modeled 20 bp costs.'
      : 'The cross-asset results are mixed; inspect the full table and do not select a horizon from this previously examined data.',
    limitations: [
      'The pinned Binance OHLCV assets and 240-minute fixed rule were previously examined; no horizon here is an untouched blind test.',
      'The fixed rule is not the complete production Crypto ensemble or provider/portfolio approval path.',
      'Cost components are one 20 bp round-trip scenario, not observed fills, spread history, market impact or funding.',
      'Different exits can change subsequent non-overlapping entry opportunities; rows are strategy-level comparisons, not matched entry outcomes.',
      'Assets, adjacent horizons and signal days are dependent; the displayed day-cluster intervals have no multiple-comparison correction.',
      'A favorable horizon in this study cannot be promoted without later untouched data and multi-session forward paper evidence.'
    ]
  };
  const jsonPath = path.join(ROOT, 'HORIZON_SENSITIVITY_2026-10-01.json');
  const markdownPath = path.join(ROOT, 'HORIZON_SENSITIVITY_2026-10-01.md');
  const lines = [
    '# Crypto fixed-rule horizon sensitivity — 2026-10-01', '',
    'Frozen comparison of 45, 120, 240 and 360-minute holding windows using the five checksum-pinned Binance 15-minute datasets ending 2026-09-29 17:00 UTC. All variants keep the same entry rule, stop, reward/risk and modeled 20 bp round-trip cost. BTC was previously used to examine parameters and is displayed as context; the other four assets are cross-asset exploration. These datasets were previously examined, so this is **not a blind holdout**.', '',
    'Each row uses the existing chronological 65% earlier / 35% recent split. The interval resamples entire UTC signal days; it is descriptive and does not account for multiple horizons or correlated assets. Net R and expectancy are after modeled costs.', '',
    '| Asset | Window | Recent trades/days | Recent expectancy R | Day-cluster 95% interval | Recent PF | Recent net R | Recent max DD R | Earlier trades/days | Earlier expectancy R |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const row of results) lines.push(`| ${row.symbol} | ${row.horizonMinutes}m | ${row.recent.trades}/${row.recent.signalDays} | ${display(row.recent.expectancyR)} | ${bounds(row.recent)} | ${display(row.recent.profitFactor)} | ${display(row.recent.netR, 1)} | ${display(row.recent.maxDrawdownR, 1)} | ${row.earlier.trades}/${row.earlier.signalDays} | ${display(row.earlier.expectancyR)} |`);
  lines.push('', '## Interpretation', '', report.descriptiveFinding, '',
    'Compare the entire cross-asset and earlier/recent pattern, not the best single cell. These horizons represent different trade lifetimes and can change the later opportunity sequence. No horizon is selected or promoted by this report. The JSON companion retains exit-reason counts, average bars held, dataset hashes, and all modeled metrics.', '',
    '## Limitations', '', ...report.limitations.map((item) => `- ${item}`), '');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, `${lines.join('\n')}\n`);
  return { jsonPath, markdownPath, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { jsonPath, markdownPath, report } = await runHorizonSensitivityStudy();
    console.log(JSON.stringify({ jsonPath, markdownPath, rows: report.results.length,
      horizons: report.fixedStudyPlan.horizonMinutes }));
  } catch (error) {
    console.error(`Horizon sensitivity failed: ${String(error?.message || error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}
