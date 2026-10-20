import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replayForexDayBreakout } from '../src/replay.js';
import { getForexMarketSession } from '../src/marketSession.js';
import { runForexReplayFile } from '../scripts/replay.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const m15Bars = Array.from({ length: 30 }, (_, i) => {
  const close = 1.1 + i * 0.0001;
  const time = now - (30 - i) * M15;
  return { time: new Date(time).toISOString(), completedAt: new Date(time + M15).toISOString(), complete: true,
    mid: { o: close - 0.00005, h: close + 0.0001, l: close - 0.0001, c: close } };
});
m15Bars.at(-1).mid = { o: 1.1028, h: 1.1041, l: 1.1027, c: 1.104 };
const h1Bars = Array.from({ length: 80 }, (_, i) => {
  const close = 1.09 + i * 0.0001;
  const time = now - (80 - i) * H1;
  return { time: new Date(time).toISOString(), complete: true,
    mid: { o: close - 0.00005, h: close + 0.0001, l: close - 0.0001, c: close } };
});
const catalystReview = { status: 'clear', source: 'fixture calendar review', summary: 'No scheduled major release.', reviewedAt: new Date(now).toISOString() };
const sessionDate = getForexMarketSession(now).marketDate;
const quote = (minutes, bid, ask) => ({ bid, ask, time: new Date(now + minutes * 60_000).toISOString(), quality: 'executable' });
const dataset = {
  instrument: 'EUR_USD', m15Bars, accountEquityUsd: 10_000,
  config: { quoteToUsd: 1, roundTripFeesPerUnit: 0.00001, slippageReservePerUnit: 0.00001 },
  policy: { maxQuoteAgeMs: 60_000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.5,
    maxTotalOpenRiskPct: 3, maxGrossExposurePct: 5_000, maxDailyLossPct: 3, minRewardRisk: 1.5 },
};

test('Forex replay passes point-in-time bars and existing M15/H1 strategy through costed quote lifecycle and isolated shadows', async () => {
  const report = await replayForexDayBreakout({ ...dataset, shadowConfigs: [
    { id: 'wider-breakout-buffer', overrides: { breakoutBufferAtr: 0.2 } },
  ], executionCostSchedule: [{ id: 'fx-fees', validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 20 * 60_000).toISOString(),
    roundTripFeesPerUnit: 0.00003, slippageReservePerUnit: 0.00002, source: 'https://data.example.com/fx-fees' }], observations: [
    { asOf: quote(0, 1.10402, 1.10404).time, quote: quote(0, 1.10402, 1.10404), context: { h1Bars, sessionDate, catalystReview } },
    { asOf: quote(1, 1.10401, 1.10403).time, quote: quote(1, 1.10401, 1.10403), context: { h1Bars, sessionDate, catalystReview } },
    { asOf: quote(2, 1.1052, 1.10522).time, quote: quote(2, 1.1052, 1.10522), context: { h1Bars, sessionDate, catalystReview } },
  ] });
  assert.equal(report.candidatesConsidered, 3);
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.unresolvedOrders, 0);
  assert.equal(report.trades[0].exitReason, 'target');
  assert.ok(report.feesUsd > 0);
  assert.ok(report.slippageReserveUsd > 0);
  assert.equal(report.trades[0].executionCostContext.id, 'fx-fees');
  assert.equal(report.shadowStrategies.length, 1);
  assert.equal(report.shadowStrategies[0].mode, 'isolated_shadow_paper_replay');
  assert.deepEqual(report.shadowStrategies[0].overrides, { breakoutBufferAtr: 0.2 });
  assert.equal(report.shadowStrategies[0].report.owner, 'forex');
});

test('Forex shadow profiles cannot change execution costs or risk controls', async () => {
  await assert.rejects(replayForexDayBreakout({ ...dataset, observations: [
    { asOf: quote(0, 1.10402, 1.10404).time, quote: quote(0, 1.10402, 1.10404), context: { h1Bars, sessionDate, catalystReview } },
  ], shadowConfigs: [{ id: 'unsafe', overrides: { roundTripFeesPerUnit: 0 } }] }), /cannot override roundTripFeesPerUnit/);
});

test('Forex replay excludes incomplete future M15 bars at each decision', async () => {
  const report = await replayForexDayBreakout({ ...dataset,
    observations: [{ asOf: new Date(now - 1).toISOString(), quote: quote(-1, 1.10402, 1.10404),
      context: { h1Bars, sessionDate, catalystReview } }] });
  assert.equal(report.candidatesConsidered, 0);
  assert.ok(report.futureBarsExcluded > 0);
});

test('Forex backtest command reads a local dataset without contacting a provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forex-replay-'));
  const file = join(directory, 'replay.json');
  try {
    await writeFile(file, JSON.stringify({ ...dataset, observations: [
      { asOf: quote(0, 1.10402, 1.10404).time, quote: quote(0, 1.10402, 1.10404), context: { h1Bars, sessionDate, catalystReview } },
    ] }));
    const result = await runForexReplayFile(file);
    assert.equal(result.dataset, resolve(file));
    assert.equal(result.report.candidatesConsidered, 1);
    assert.equal(result.report.reservationsCreated, 1);
    assert.equal(result.report.unresolvedOrders, 1);
    assert.equal(result.report.executionOutcomes.fillCount, 0);
    assert.equal(result.report.executionOutcomes.pendingEntryCount, 1);
    assert.equal(result.report.executionOutcomes.unfilledCount, 0);
    assert.equal(result.report.executionOutcomes.reservationFillRatePct, null);
    assert.equal(result.report.executionOutcomes.notFilledRatePct, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Forex replay CLI evaluates disjoint chronological windows with the same frozen config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forex-holdout-'));
  const file = join(directory, 'replay.json');
  const observations = [0, 1, 2, 3].map((minute) => ({ asOf: quote(minute, 1.10402, 1.10404).time,
    quote: quote(minute, 1.10402, 1.10404), context: { h1Bars, sessionDate, catalystReview } }));
  try {
    await writeFile(file, JSON.stringify({ ...dataset, observations, evaluationWindows: [
      { id: 'holdout-a', start: observations[0].asOf, end: observations[1].asOf },
      { id: 'holdout-b', start: observations[2].asOf, end: observations[3].asOf },
    ] }));
    const result = await runForexReplayFile(file);
    assert.equal(result.report.mode, 'fixed-strategy-chronological-holdout-windows');
    assert.deepEqual(result.report.windows.map((row) => row.id), ['holdout-a', 'holdout-b']);
    assert.ok(result.report.windows.every((row) => row.report.owner === 'forex' && row.report.scoreFrom === row.start));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
