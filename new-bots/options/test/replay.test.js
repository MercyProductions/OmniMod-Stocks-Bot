import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { replayOptionDebitVertical } from '../src/replay.js';
import { runOptionsReplayFile } from '../scripts/replay.js';

const start = Date.parse('2026-09-29T15:00:00Z');
const legsAt = (minute, longBid, longAsk, shortBid, shortAsk) => {
  const time = new Date(start + minute * 60_000).toISOString();
  const long = { underlying: 'SPY', symbol: 'SPY261002C00100000', type: 'call', strike: 100, bid: longBid, ask: longAsk, expiry: '2026-10-02', multiplier: 100, openInterest: 500, volume: 50, time, bidTime: time, askTime: time, quoteQuality: 'executable', greeks: { delta: 0.55, impliedVolatility: 0.28 } };
  const short = { underlying: 'SPY', symbol: 'SPY261002C00110000', type: 'call', strike: 110, bid: shortBid, ask: shortAsk, expiry: '2026-10-02', multiplier: 100, openInterest: 500, volume: 50, time, bidTime: time, askTime: time, quoteQuality: 'executable', greeks: { delta: 0.35, impliedVolatility: 0.25 } };
  return { time, options: [long, short], quote: { bid: Number(Math.max(0, longBid - shortAsk).toFixed(4)), ask: Number((longAsk - shortBid).toFixed(4)), time, quality: 'executable' } };
};
const snapshot = (minute, longBid, longAsk, shortBid, shortAsk) => {
  const data = legsAt(minute, longBid, longAsk, shortBid, shortAsk);
  const signal = { underlyingSymbol: 'SPY', sessionDate: '2026-09-29', sessionClose: '2026-09-29T20:00:00Z',
    direction: 'long', underlyingPrice: 100, underlyingTarget: 112, observedAt: data.time,
    underlyingQuote: { symbol: 'SPY', bid: 99.99, ask: 100.01, time: data.time, bidTime: data.time, askTime: data.time, quality: 'executable' }, sessionOpen: true,
    catalystReview: { status: 'clear', source: 'point-in-time fixture review', summary: 'No scheduled event.', reviewedAt: data.time },
    optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'No ex-dividend date through option expiry.', reviewedAt: data.time, reviewedThrough: '2026-10-02', nextExDividendDate: null } };
  return { asOf: data.time, quote: data.quote, context: { signal, chain: { expiry: '2026-10-02', quoteQuality: 'executable', source: 'licensed historical fixture', options: data.options } } };
};
const base = {
  underlyingSymbol: 'SPY', spreadSymbols: ['SPY261002C00100000', 'SPY261002C00110000'], accountEquityUsd: 100_000,
  config: { minOpenInterest: 100, minVolume: 1, maxLegSpreadPct: 15, maxQuoteAgeMs: 10_000, maxLegSkewMs: 3_000,
    minDaysToExpiry: 1, maxDaysToExpiry: 45, minRewardRisk: 1.5, feePerContractRoundTrip: 1, slippageReservePerContract: 0.5 },
  policy: { maxQuoteAgeMs: 10_000, maxSpreadPct: 25, maxTradeRiskPct: 0.5, maxTotalOpenRiskPct: 3,
    maxGrossExposurePct: 100, maxDailyLossPct: 2, minRewardRisk: 1.5 },
};

test('Options replay uses a fixed vertical identity and later composite quotes for costed fill/target and isolated shadows', async () => {
  const report = await replayOptionDebitVertical({ ...base, shadowConfigs: [
    { id: 'higher-open-interest', overrides: { minOpenInterest: 1_000 } },
    { id: 'greek-data-required', overrides: { requireCompleteGreeks: true } },
  ], executionCostSchedule: [{ id: 'spread-fees', validFrom: new Date(start - 60_000).toISOString(), validUntil: new Date(start + 10 * 60_000).toISOString(),
    roundTripFeesPerUnit: 3, slippageReservePerUnit: 1, source: 'https://data.example.com/options-fees' }], observations: [
    snapshot(0, 2, 2.1, 0.9, 1), snapshot(1, 2, 2.1, 0.9, 1), snapshot(2, 3.5, 3.6, 1, 1.1),
  ] });
  assert.equal(report.candidatesConsidered, 3);
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 1);
  assert.equal(report.unresolvedOrders, 0);
  assert.equal(report.trades[0].exitReason, 'target');
  assert.equal(report.trades[0].optionGreekContext.netDeltaPerSpread, 0.2);
  assert.equal(report.trades[0].optionGreekContext.impliedVolatilityDifference, 0.03);
  assert.ok(report.feesUsd > 0);
  assert.ok(report.slippageReserveUsd > 0);
  assert.equal(report.trades[0].executionCostContext.id, 'spread-fees');
  assert.equal(report.trades[0].executionCostContext.roundTripFeesPerUnit, 3, 'schedule units represent one complete vertical, including both legs');
  assert.equal(report.shadowStrategies.length, 2);
  assert.equal(report.shadowStrategies[0].mode, 'isolated_shadow_paper_replay');
  assert.equal(report.shadowStrategies[0].report.owner, 'options');
  assert.equal(report.shadowStrategies[1].report.reservationsCreated, 0);
  assert.equal(report.shadowStrategies[1].report.trades.length, 0);
  assert.equal(report.shadowStrategies[1].report.topRejectionReasons.required_greeks_missing_stale_or_skewed, 3);
});

test('Options replay fails closed when selected spread legs or synchronized composite quotes do not match', async () => {
  const observations = [snapshot(0, 2, 2.1, 0.9, 1)];
  observations[0].quote.ask += 0.01;
  const report = await replayOptionDebitVertical({ ...base, observations });
  assert.equal(report.candidatesConsidered, 0);
  assert.equal(report.topRejectionReasons.option_composite_quote_mismatch, 1);
});

test('malformed option-chain replay records cannot crash or manufacture a fill', async () => {
  for (const options of [null, {}, [null, null]]) {
    const observation = snapshot(0, 2, 2.1, 0.9, 1); observation.context.chain.options = options;
    const report = await replayOptionDebitVertical({ ...base, observations: [observation] });
    assert.equal(report.reservationsCreated, 0);
    assert.equal(report.optionQuoteValidation.rejected, 1);
  }
});

test('Options chronological replay respects the original hypothesis timestamp instead of the refreshed quote time', async () => {
  const observations = [snapshot(0, 2, 2.1, 0.9, 1)];
  observations[0].context.primarySignalObservedAt = new Date(start - 120000).toISOString();
  const report = await replayOptionDebitVertical({ ...base, observations });
  assert.equal(report.candidatesConsidered, 0);
  assert.equal(report.reservationsCreated, 0);
  assert.equal(report.topRejectionReasons.primary_signal_expired, 1);
});

test('unrelated later option legs cannot manufacture fills or profits in replay', async () => {
  const observations = [snapshot(0, 2, 2.1, 0.9, 1), snapshot(1, 2, 2.1, 0.9, 1), snapshot(2, 3.5, 3.6, 1, 1.1)];
  observations[2].context.chain.options[0].underlying = 'QQQ';
  const report = await replayOptionDebitVertical({ ...base, observations });
  assert.equal(report.reservationsCreated, 1);
  assert.equal(report.closedTrades, 0, 'the false profitable mark must not close the position');
  assert.equal(report.unresolvedOrders, 1);
  assert.equal(report.optionQuoteValidation.rejected, 1);
  assert.equal(report.optionQuoteValidation.rejectionReasons.underlying_identity_mismatch, 1);

  const badFill = [snapshot(0, 2, 2.1, 0.9, 1), snapshot(1, 2, 2.1, 0.9, 1)];
  delete badFill[1].context.chain.options[0].multiplier;
  const unfilled = await replayOptionDebitVertical({ ...base, observations: badFill });
  assert.equal(unfilled.reservationsCreated, 1);
  assert.equal(unfilled.closedTrades, 0);
  assert.equal(unfilled.optionQuoteValidation.rejectionReasons.contract_deliverable_unverified, 1);
  assert.equal(badFill[1].quote.quality, 'executable', 'input observations must not be mutated');
});

test('Options backtest command reads local point-in-time chain data without provider calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-replay-'));
  const file = join(directory, 'replay.json');
  try {
    await writeFile(file, JSON.stringify({ ...base, observations: [snapshot(0, 2, 2.1, 0.9, 1)] }));
    const result = await runOptionsReplayFile(file);
    assert.equal(result.dataset, resolve(file));
    assert.equal(result.report.candidatesConsidered, 1);
    assert.equal(result.report.reservationsCreated, 1);
    assert.equal(result.report.unresolvedOrders, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Options replay CLI evaluates disjoint chronological windows with the same frozen vertical identity and config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-holdout-'));
  const file = join(directory, 'replay.json');
  const observations = [0, 1, 2, 3].map((minute) => snapshot(minute, 2, 2.1, 0.9, 1));
  try {
    await writeFile(file, JSON.stringify({ ...base, observations, evaluationWindows: [
      { id: 'holdout-a', start: observations[0].asOf, end: observations[1].asOf },
      { id: 'holdout-b', start: observations[2].asOf, end: observations[3].asOf },
    ] }));
    const result = await runOptionsReplayFile(file);
    assert.equal(result.report.mode, 'fixed-strategy-chronological-holdout-windows');
    assert.deepEqual(result.report.windows.map((row) => row.id), ['holdout-a', 'holdout-b']);
    assert.ok(result.report.windows.every((row) => row.report.owner === 'options' && row.report.scoreFrom === row.start));
    assert.ok(result.report.windows.every((row) => row.report.instrumentKey === 'SPY261002C00100000+SPY261002C00110000'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
