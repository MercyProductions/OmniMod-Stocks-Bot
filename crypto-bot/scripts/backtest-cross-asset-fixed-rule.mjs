import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistoricalRows } from './backtest-historical.js';
import { backtestHistoricalCandles } from '../src/historicalBacktest.js';
import { validateStrategy } from '../src/backtest.js';
import { bootstrapDayClusterExpectancy } from '../src/dayClusterBootstrap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = path.resolve(HERE, '..');
const DATA_ROOT = path.join(BOT_ROOT, 'data', 'research', 'historical');
const AS_OF = '2026-09-29T17:00:00.000Z';
export const SYMBOLS = ['BTC', 'SOL', 'XRP', 'BNB', 'ADA'];
const COST_TIERS = [
  { label: '10 bp', feeBpsPerSide: 2.5, quotedSpreadBps: 2, slippageBpsPerSide: 1.5 },
  { label: '20 bp', feeBpsPerSide: 5, quotedSpreadBps: 6, slippageBpsPerSide: 2 },
  { label: '40 bp', feeBpsPerSide: 10, quotedSpreadBps: 10, slippageBpsPerSide: 5 },
];

function datasetFilename(symbol) {
  if (symbol === 'BTC') return 'BTCUSDT-15m-2026-04-01_to_2026-09-29.ndjson';
  return `${symbol}USDT-15m-2026-04-01_to_2026-09-29-17Z.ndjson`;
}

function stableSeed(text) {
  let hash = 2_166_136_261;
  for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return hash;
}

export async function loadVerifiedDataset(symbol) {
  const filename = datasetFilename(symbol);
  const datasetPath = path.join(DATA_ROOT, filename);
  const manifestPath = `${datasetPath}.manifest.json`;
  const [raw, manifestText] = await Promise.all([readFile(datasetPath), readFile(manifestPath, 'utf8')]);
  const manifest = JSON.parse(manifestText);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== manifest.sha256) throw new Error(`${symbol}: local data checksum does not match its manifest.`);
  if (manifest.symbol !== `${symbol}USDT` || manifest.interval !== '15m'
    || manifest.returnedBars !== 17_444 || manifest.expectedBars !== 17_444
    || manifest.missingBarSlots !== 0 || manifest.complete !== true
    || manifest.endTimeExclusive !== Date.parse(AS_OF)) {
    throw new Error(`${symbol}: manifest does not match the pinned complete 15-minute study window.`);
  }
  return { rows: await loadHistoricalRows(datasetPath), manifest: { sha256, dataset: filename,
    fetchedAt: manifest.fetchedAt, returnedBars: manifest.returnedBars, provider: manifest.provider } };
}

export async function runCrossAssetFixedRuleStudy() {
  const datasets = Object.fromEntries(await Promise.all(SYMBOLS.map(async (symbol) => [symbol, await loadVerifiedDataset(symbol)])));
  const combinedRows = SYMBOLS.flatMap((symbol) => datasets[symbol].rows);
  const costResults = [];
  for (const costs of COST_TIERS) {
    // Replay together so each asset's regime label uses timestamp-matched BTC bars.
    const report = backtestHistoricalCandles(combinedRows, { asOf: AS_OF, strategyOptions: {
      feeBpsPerSide: costs.feeBpsPerSide, quotedSpreadBps: costs.quotedSpreadBps,
      slippageBpsPerSide: costs.slippageBpsPerSide,
    } });
    const assets = report.filter((row) => SYMBOLS.slice(1).includes(row.symbol));
    for (const row of assets) {
      const validation = validateStrategy(datasets[row.symbol].rows, { ...costs });
      if (validation.recent.trades !== row.recent.trades || validation.earlier.trades !== row.earlier.trades
        || Math.abs(validation.recent.expectancyR - row.recent.expectancyR) > 1e-12) {
        throw new Error(`${row.symbol}: cluster-bootstrap replay did not match the historical replay summary.`);
      }
      row.clusterBootstrap = {
        earlier: bootstrapDayClusterExpectancy(validation.earlier.tradesList, { seed: stableSeed(`${row.symbol}:${costs.label}:earlier`) }),
        recent: bootstrapDayClusterExpectancy(validation.recent.tradesList, { seed: stableSeed(`${row.symbol}:${costs.label}:recent`) }),
      };
    }
    costResults.push({ ...costs, roundTripCostBps: 2 * costs.feeBpsPerSide + costs.quotedSpreadBps + 2 * costs.slippageBpsPerSide,
      assets });
  }
  const payload = { generatedAt: new Date().toISOString(), asOf: AS_OF, strategy: 'unchanged Crypto fixed-rule 15-minute strategy; BTC-derived parameters; no tuning in this study',
    source: 'Binance Spot public OHLCV datasets; manifest SHA-256 checked locally', benchmark: 'BTCUSDT bars are used only for timestamp-matched market-regime classification',
    datasets: Object.fromEntries(Object.entries(datasets).map(([symbol, row]) => [symbol, row.manifest])),
    costAssumptions: COST_TIERS.map(({ label, feeBpsPerSide, quotedSpreadBps, slippageBpsPerSide }) => ({ label, feeBpsPerSide, quotedSpreadBps, slippageBpsPerSide,
      roundTripBps: 2 * feeBpsPerSide + quotedSpreadBps + 2 * slippageBpsPerSide })),
    results: costResults.map(({ label, roundTripCostBps, assets }) => ({ label, roundTripCostBps,
      assets: assets.map((row) => ({ symbol: row.symbol, candleCount: row.candleCount, sufficient: row.sufficient,
        coverage: row.coverage, earlier: row.earlier, recent: row.recent, overall: row.overall,
        performanceByMarketRegime: row.performanceByMarketRegime,
        clusterBootstrap: row.clusterBootstrap, warning: row.warning })) })),
    limitations: ['OHLCV bars are not executable quotes or observed fills.', 'Fee, spread and slippage tiers are scenarios, not verified historical provider/broker costs.',
      'BTC-derived parameters were previously examined on BTC; the cross-asset check is not a blinded test.',
      'This does not validate the production ensemble, signal model, actual fill quality, market impact, funding, or commercial data entitlements.',
      'Regime-stratified rows are descriptive, may be sparse, overlap across assets, and are not multiplicity-adjusted.',
      'Universe survivorship and dependence across assets/regimes remain; results are exploratory and do not establish profitability.'] };
  const output = path.join(BOT_ROOT, 'CROSS_ASSET_FIXED_RULE_VALIDATION_2026-09-30.json');
  const markdownOutput = path.join(BOT_ROOT, 'CROSS_ASSET_FIXED_RULE_VALIDATION_2026-09-30.md');
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
  const lines = ['# Crypto fixed-rule cross-asset replay — 2026-09-30', '',
    `As-of: ${AS_OF}. Strategy: ${payload.strategy}.`, '',
    '## Dataset integrity', '',
    '| Asset | Bars | SHA-256 |', '|---|---:|---|'];
  for (const [symbol, dataset] of Object.entries(payload.datasets)) lines.push(`| ${symbol} | ${dataset.returnedBars} | \`${dataset.sha256}\` |`);
  lines.push('', 'All datasets are Binance Spot 15-minute OHLCV for 2026-04-01 through 2026-09-29 17:00 UTC, with 17,444 completed bars and zero declared missing slots. The validator recomputes each file SHA-256 against its saved manifest. BTC bars are used for time-matched regime classification.', '',
    '## Results', '',
    'The rule and parameters are unchanged. Results are exploratory: BTC-derived parameters were previously examined, costs are modeled scenarios rather than observed charges/fills, and candle bars are not executable quotes.', '');
  for (const tier of payload.results) {
    lines.push(`### ${tier.label} modeled round-trip cost`, '',
      '| Asset | Recent n/days | Recent expectancy (R) | Cluster 95% interval (R) | Recent PF | Recent net (R) | Recent max DD (R) | Earlier n/days | Earlier expectancy (R) | Earlier cluster 95% interval (R) |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of [...tier.assets].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const interval = (value) => Number.isFinite(value.lower95R) && Number.isFinite(value.upper95R)
        ? `[${value.lower95R.toFixed(3)}, ${value.upper95R.toFixed(3)}]` : 'unavailable';
      lines.push(`| ${row.symbol} | ${row.recent.trades}/${row.coverage.recent.signalDays} | ${Number(row.recent.expectancyR).toFixed(3)} | ${interval(row.clusterBootstrap.recent)} | ${Number(row.recent.profitFactor).toFixed(3)} | ${Number(row.recent.netR).toFixed(1)} | ${Number(row.recent.maxDrawdownR).toFixed(1)} | ${row.earlier.trades}/${row.coverage.earlier.signalDays} | ${Number(row.earlier.expectancyR).toFixed(3)} | ${interval(row.clusterBootstrap.earlier)} |`);
    }
    lines.push('');
    lines.push(`#### ${tier.label}: descriptive performance by BTC regime at signal time`, '',
      '| Asset | Segment | BTC regime | Trades / signal days | Win rate | Expectancy (R) | Profit factor | Net (R) | Max DD (R) |',
      '|---|---|---|---:|---:|---:|---:|---:|---:|');
    const display = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits) : '—';
    for (const row of [...tier.assets].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      for (const segment of ['recent', 'earlier']) for (const regime of ['risk_on', 'neutral', 'risk_off', 'unknown']) {
        const stats = row.performanceByMarketRegime?.[segment]?.[regime];
        if (!stats) continue;
        lines.push(`| ${row.symbol} | ${segment} | ${regime} | ${stats.trades}/${stats.signalDays ?? 'unknown'} | ${display(stats.winRate, 1)}% | ${display(stats.expectancyR)} | ${display(stats.profitFactor)} | ${display(stats.netR, 1)} | ${display(stats.maxDrawdownR, 1)} |`);
      }
    }
    lines.push('', 'Regime rows are descriptive, overlapping across assets and subject to the same OHLCV fill assumptions; do not infer a strategy gate from sparse regime samples.', '');
  }
  lines.push('## Limitations', '', ...payload.limitations.map((item) => `- ${item}`), '');
  await writeFile(markdownOutput, `${lines.join('\n')}\n`);
  return { output, markdownOutput, payload };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { output, markdownOutput, payload } = await runCrossAssetFixedRuleStudy();
    console.log(JSON.stringify({ output, markdownOutput, generatedAt: payload.generatedAt, datasets: payload.datasets,
      results: payload.results, limitations: payload.limitations }, null, 2));
  } catch (error) {
    console.error(`Cross-asset validation failed: ${String(error?.message || error).slice(0, 240)}`);
    process.exitCode = 1;
  }
}
