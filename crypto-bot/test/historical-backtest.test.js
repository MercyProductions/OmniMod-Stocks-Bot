import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backtestHistoricalCandles } from '../src/historicalBacktest.js';

const start = Date.parse('2026-09-25T00:00:00Z');
const candle = (index, symbol = 'BTCUSDT', provider = 'fixture') => {
  const close = 100 + index * 0.03;
  return { time: start + index * 15 * 60_000, open: close - 0.02, high: close + 0.1,
    low: close - 0.1, close, volume: 1_000, symbol, provider };
};
const history = (symbol, provider) => Array.from({ length: 130 }, (_, index) => candle(index, symbol, provider));

test('historical crypto validation isolates provider series and excludes incomplete/future candles at the frozen as-of time', () => {
  const rows = [...history('BTCUSDT', 'provider-a'), ...history('BTCUSDT', 'provider-b')];
  const lastCompleteAt = start + 129 * 15 * 60_000 + 15 * 60_000;
  rows.push({ ...candle(130, 'BTCUSDT', 'provider-a'), time: lastCompleteAt - 5 * 60_000 });
  rows.push({ ...candle(130, 'BTCUSDT', 'provider-a'), time: lastCompleteAt + 60_000 });
  rows.push({ ...candle(130, 'BTCUSDT', 'provider-a'), time: 'invalid' });
  const result = backtestHistoricalCandles(rows, { asOf: lastCompleteAt });
  assert.deepEqual(result.map((row) => row.provider), ['provider-a', 'provider-b']);
  assert.equal(result[0].sourceRows, 133);
  assert.equal(result[0].invalidTimestampRowsDropped, 1);
  assert.equal(result[0].incompleteOrFutureBarsExcluded, 2);
  assert.equal(result[0].candleCount, 130);
  assert.equal(result[1].candleCount, 130);
  assert.ok('recent' in result[0] && 'expectancyR' in result[0].recent);
  assert.equal(result[0].recent.wins + result[0].recent.smallMoves + result[0].recent.losses, result[0].recent.trades);
});

test('historical crypto validation requires explicit point-in-time cutoff and rejects symbol-less input', () => {
  assert.throws(() => backtestHistoricalCandles(history('BTCUSDT', 'fixture')), /explicit valid asOf/);
  assert.throws(() => backtestHistoricalCandles([{ ...candle(1), symbol: '' }], { asOf: start + 1_000_000 }), /Every historical candle row must include a symbol/);
});

test('historical replay exposes explicit transaction-cost components and rejects ambiguous mixed cost inputs', () => {
  const asOf = start + 130 * 15 * 60_000;
  const report = backtestHistoricalCandles(history('BTCUSDT', 'fixture'), { asOf,
    strategyOptions: { feeBpsPerSide: 10, quotedSpreadBps: 4, slippageBpsPerSide: 2 } });
  assert.equal(report[0].costModel.roundTripBps, 28);
  assert.equal(report[0].costModel.mode, 'explicit_components');
  assert.throws(() => backtestHistoricalCandles(history('BTCUSDT', 'fixture'), { asOf,
    strategyOptions: { feeBpsPerSide: 10, roundTripFeeBps: 20 } }), /either legacy/);
});

test('dated crypto execution costs apply by signal time, retain source provenance, and fail closed in gaps', () => {
  const rows = Array.from({ length: 800 }, (_, index) => {
    const close = 100 + index * 0.02 + Math.sin(index / 7) * 0.7;
    return { time: start + index * 15 * 60_000, open: close - 0.03, high: close + 0.25,
      low: close - 0.25, close, volume: 1_000 + 500 * Math.sin(index / 11), symbol: 'BTCUSDT', provider: 'fixture' };
  });
  const asOf = start + 800 * 15 * 60_000;
  const costModelAt = (timestamp) => timestamp < start + 700 * 15 * 60_000
    ? { mode: 'dated_schedule', scheduleRowId: 'venue-a', source: 'https://example.com/fees', roundTripBps: 8 }
    : null;
  const report = backtestHistoricalCandles(rows, { asOf,
    strategyOptions: { costModelAt } });
  const used = report[0].overall.trades;
  assert.ok(used > 0);
  assert.ok(report[0].overall.costModelsUsed.some((model) => model.scheduleRowId === 'venue-a' && model.roundTripBps === 8));
  assert.ok(report[0].overall.costScheduleGapSignals > 0);
  assert.equal(report[0].costModel.mode, 'dated_schedule');
  assert.throws(() => backtestHistoricalCandles(rows, { asOf,
    strategyOptions: { costModelAt, roundTripFeeBps: 20 } }), /either a dated cost schedule/);
});

test('crypto dated execution schedule validates gaps, overlaps, costs, and source URLs', async () => {
  const { executionCostsAt, scheduledCryptoCostModelAt, validateExecutionCostSchedule } = await import('../src/executionCostSchedule.js');
  const rows = validateExecutionCostSchedule([{ id: 'spot', validFrom: '2026-09-25T00:00:00Z', validUntil: '2026-09-26T00:00:00Z', feeBpsPerSide: 10, slippageBpsPerSide: 2, source: 'https://venue.example/fees' }]);
  assert.equal(executionCostsAt(rows, '2026-09-25T00:00:00Z').id, 'spot');
  assert.equal(executionCostsAt(rows, '2026-09-26T00:00:00Z'), null);
  assert.equal(scheduledCryptoCostModelAt(rows, '2026-09-25T00:00:00Z', 4).roundTripBps, 28);
  const varying = validateExecutionCostSchedule([
    { ...rows[0], quotedSpreadBps: 4 },
  ]);
  assert.equal(scheduledCryptoCostModelAt(varying, '2026-09-25T00:00:00Z', 40).quotedSpreadBps, 4);
  assert.equal(scheduledCryptoCostModelAt(rows, '2026-09-25T00:00:00Z', 4).quotedSpreadBps, 4);
  assert.throws(() => validateExecutionCostSchedule([{ ...rows[0], source: 'http://venue.example/fees' }]), /HTTPS/);
  assert.throws(() => validateExecutionCostSchedule([{ ...rows[0], feeBpsPerSide: 101 }]), /invalid interval or cost/);
  assert.throws(() => validateExecutionCostSchedule([{ ...rows[0], quotedSpreadBps: 201 }]), /quotedSpreadBps/);
  assert.throws(() => scheduledCryptoCostModelAt(rows, '2026-09-25T00:00:00Z', 200), /200 bps replay limit/);
  assert.throws(() => validateExecutionCostSchedule([rows[0], { ...rows[0], id: 'spot2', validFrom: '2026-09-25T12:00:00Z' }]), /overlap/);
});

test('historical replay segments outcomes by completed BTC regime without crossing provider boundaries', () => {
  const rows = [];
  for (const [symbol, pair, provider] of [['BTC', 'BTCUSDT', 'venue-a'], ['ETH', 'ETHUSDT', 'venue-a'], ['ETH', 'ETHUSDT', 'venue-b']]) {
    for (let index = 0; index < 800; index += 1) {
      const close = 100 + index * 0.02 + Math.sin(index / 7) * 0.7;
      rows.push({ time: start + index * 15 * 60_000, open: close - 0.03, high: close + 0.25,
        low: close - 0.25, close, volume: 1_000 + 500 * Math.sin(index / 11), symbol, pair, provider });
    }
  }
  const report = backtestHistoricalCandles(rows, { asOf: start + 800 * 15 * 60_000 });
  const btc = report.find((row) => row.symbol === 'BTC');
  const ethSameVenue = report.find((row) => row.symbol === 'ETH' && row.provider === 'venue-a');
  const ethOtherVenue = report.find((row) => row.symbol === 'ETH' && row.provider === 'venue-b');
  assert.ok(btc.overall.trades > 0);
  assert.equal(btc.performanceByMarketRegime.overall.risk_on.trades, btc.overall.trades);
  assert.ok(btc.performanceByMarketRegime.overall.risk_on.signalDays > 0, 'regime diagnostics carry independent UTC signal-day coverage');
  assert.equal(btc.performanceByMarketRegime.overall.risk_off.trades, 0);
  assert.equal(btc.performanceByMarketRegime.overall.risk_off.expectancyR, null);
  assert.equal(btc.performanceByMarketRegime.overall.risk_off.profitFactor, null);
  assert.equal(btc.performanceByMarketRegime.overall.risk_off.netR, null);
  assert.equal(btc.performanceByMarketRegime.overall.risk_off.maxDrawdownR, null);
  assert.equal(ethSameVenue.performanceByMarketRegime.overall.risk_on.trades, ethSameVenue.overall.trades);
  assert.equal(ethOtherVenue.performanceByMarketRegime.overall.unknown.trades, ethOtherVenue.overall.trades);
  assert.ok(ethOtherVenue.performanceByMarketRegime.overall.unknown.signalDays > 0);
  assert.equal(ethOtherVenue.performanceByMarketRegime.overall.risk_on.trades, 0);
  assert.deepEqual(Object.keys(ethSameVenue.performanceByMarketRegime), ['earlier', 'recent', 'overall']);
  const exitReasons = btc.performanceByExitReason.overall;
  assert.deepEqual(Object.keys(btc.performanceByExitReason), ['earlier', 'recent', 'overall']);
  assert.ok(Object.keys(exitReasons).length > 0);
  assert.equal(Object.values(exitReasons).reduce((sum, row) => sum + row.trades, 0), btc.overall.trades);
  assert.ok(Object.values(exitReasons).every((row) => Number.isFinite(row.expectancyR) && Number.isFinite(row.netR)));
});

test('historical crypto CLI reads imported NDJSON with network disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-historical-'));
  const input = join(directory, 'candles-BTCUSDT-fixture.ndjson');
  const denyNetwork = join(directory, 'deny-network.mjs');
  const rows = history('BTCUSDT', 'fixture');
  try {
    await writeFile(input, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    await writeFile(denyNetwork, "globalThis.fetch = () => { throw new Error('offline historical backtest forbids network'); };\n");
    const script = fileURLToPath(new URL('../scripts/backtest-historical.js', import.meta.url));
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const asOf = start + rows.length * 15 * 60_000;
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(denyNetwork).href, script,
      `--data=${input}`, `--asOf=${asOf}`, '--roundTripFeeBps=20'], { cwd, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'offline-historical-validation');
    assert.equal(report.datasetRows, rows.length);
    assert.equal(report.results[0].symbol, 'BTCUSDT');
    assert.equal(report.results[0].provider, 'fixture');
    assert.deepEqual(Object.keys(report.results[0].performanceByExitReason), ['earlier', 'recent', 'overall']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
