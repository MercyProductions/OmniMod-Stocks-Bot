import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateForexDayBreakout } from '../src/dayStrategy.js';
import { getForexMarketSession } from '../src/marketSession.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const makeCandles = (count, granularityMs, trend = 1) => Array.from({ length: count }, (_, i) => {
  const close = 1.1 + i * trend * 0.0001;
  return { time: new Date(now - (count - i) * granularityMs).toISOString(), complete: true,
    mid: { o: close - 0.00005, h: close + 0.0001, l: close - 0.0001, c: close } };
});
const common = {
  instrument: 'EUR_USD', now, sessionDate: '2026-09-29', catalystReview: {
    status: 'clear', source: 'official central-bank calendar', summary: 'No scheduled high-impact event during the paper setup window.', reviewedAt: now,
  },
  quote: { bid: 1.103, ask: 1.10302, time: new Date(now).toISOString(), quality: 'executable' },
  m15: makeCandles(30, 15 * 60_000), h1: makeCandles(80, 60 * 60_000),
  config: { quoteToUsd: 1, roundTripFeesPerUnit: 0.00001, slippageReservePerUnit: 0.00001 },
};

test('emits only trend-aligned M15 breakout with executable fresh quotes and bounded same-day levels', () => {
  const m15 = common.m15.map((row) => structuredClone(row));
  const final = m15.at(-1);
  final.mid.o = 1.1021; final.mid.c = 1.103; final.mid.h = 1.1031; final.mid.l = 1.102;
  const result = evaluateForexDayBreakout({ ...common, m15 });
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.sessionTimeZone, 'America/New_York');
  assert.equal(result.candidate.direction, 'long');
  assert.ok(result.candidate.stopPrice < result.candidate.entryPrice);
  assert.ok(result.candidate.targetPrice > result.candidate.entryPrice);
  assert.equal(result.candidate.multiplier, 1);
  assert.equal(result.candidate.researchContext.setupType, 'm15_range_breakout');
  assert.equal(result.candidate.marketGateTrace.observedAt, result.candidate.quoteTime);
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('usd_conversion_and_costs'));
  assert.equal(result.candidate.researchContext.features.h1_ema20, result.candidate.signal.h1Ema20);
  assert.equal(result.candidate.forceExitAt, '2026-09-29T20:59:00.000Z');
  assert.equal(result.candidate.idempotencyKey, 'EUR_USD:2026-09-29:m15-range-breakout:long');
  assert.equal(evaluateForexDayBreakout({ ...common, m15 }).candidate.idempotencyKey, result.candidate.idempotencyKey);
  const tryPair = evaluateForexDayBreakout({ ...common, instrument: 'EUR_TRY' });
  assert.ok(tryPair.reasons.includes('outside_fx_day_entry_window'));
  const cross = evaluateForexDayBreakout({ ...common, instrument: 'EUR_GBP', m15,
    config: { ...common.config, quoteToUsd: 1.26, gainQuoteToUsd: 1.25 } });
  assert.equal(cross.status, 'candidate');
  assert.equal(cross.candidate.gainMultiplier, 1.25);
  assert.equal(cross.candidate.multiplier, 1.26);
  for (const gainQuoteToUsd of [undefined, null, true, '', Infinity, 1.27]) {
    const rejected = evaluateForexDayBreakout({ ...common, instrument: 'EUR_GBP', m15,
      config: { ...common.config, quoteToUsd: 1.26, gainQuoteToUsd } });
    assert.equal(rejected.status, 'no-setup');
    assert.ok(rejected.reasons.includes('invalid_gain_conversion_factor'));
  }
  assert.ok(evaluateForexDayBreakout({ ...common, m15, config: { ...common.config, quoteToUsd: 1.26 } })
    .reasons.includes('usd_quote_currency_requires_unit_conversion'));
});

test('fails closed when catalyst review, quote, history, conversion, or cost assumptions are absent', () => {
  for (const input of [
    { ...common, catalystReview: { ...common.catalystReview, status: 'blocked' } },
    { ...common, catalystReview: { ...common.catalystReview, source: '' } },
    { ...common, catalystReview: { ...common.catalystReview, reviewedAt: now - 31 * 60_000 } },
    { ...common, catalystReview: { ...common.catalystReview, reviewedAt: now + 60_000 } },
    { ...common, quote: { ...common.quote, quality: 'delayed' } },
    { ...common, h1: common.h1.slice(0, 40) },
    { ...common, config: { ...common.config, quoteToUsd: undefined } },
    { ...common, config: { ...common.config, roundTripFeesPerUnit: null } },
    { ...common, config: { ...common.config, slippageReservePerUnit: null } },
    { ...common, config: { quoteToUsd: 1 } },
  ]) {
    const result = evaluateForexDayBreakout(input);
    assert.equal(result.status, 'no-setup');
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  }
});

test('Forex breakout rejects malformed boolean or blank quotes, candles, and strategy configuration', () => {
  for (const value of [true, false, '']) {
    const badQuote = evaluateForexDayBreakout({ ...common, quote: { ...common.quote, bid: value } });
    assert.equal(badQuote.status, 'no-setup', `bid=${String(value)}`);
    assert.ok(badQuote.reasons.includes('executable_quote_required'));
    const badCandle = common.m15.map((row, index) => index < 15
      ? { ...row, mid: { ...row.mid, c: value } } : row);
    const badHistory = evaluateForexDayBreakout({ ...common, m15: badCandle });
    assert.equal(badHistory.status, 'no-setup', `candle close=${String(value)}`);
    assert.ok(badHistory.reasons.includes('insufficient_completed_history'));
  }
  for (const key of ['maxSpreadAtr', 'breakoutBufferAtr', 'quoteToUsd']) {
    const badConfig = evaluateForexDayBreakout({ ...common, config: { ...common.config, [key]: true } });
    assert.equal(badConfig.status, 'no-setup', `${key}=true`);
    assert.ok(badConfig.reasons.includes('invalid_strategy_config'));
  }
});

test('rejects duplicated completed candle timestamps before they can distort the breakout or trend inputs', () => {
  const m15 = common.m15.map((row) => structuredClone(row));
  const last = m15.at(-1);
  last.mid.o = 1.1021; last.mid.c = 1.103; last.mid.h = 1.1031; last.mid.l = 1.102;
  const duplicateM15 = evaluateForexDayBreakout({ ...common, m15: [...m15, structuredClone(last)] });
  assert.equal(duplicateM15.status, 'no-setup');
  assert.ok(duplicateM15.reasons.includes('duplicate_m15_candle_timestamps'));

  const duplicateH1 = evaluateForexDayBreakout({ ...common, h1: [...common.h1, structuredClone(common.h1.at(-1))] });
  assert.equal(duplicateH1.status, 'no-setup');
  assert.ok(duplicateH1.reasons.includes('duplicate_h1_candle_timestamps'));
});

test('uses OANDA New York trading dates, DST-aware close, and weekly/daily closures', () => {
  const summer = getForexMarketSession(Date.parse('2026-09-29T15:00:00Z'));
  assert.equal(summer.marketDate, '2026-09-29');
  assert.equal(summer.closeAt, Date.parse('2026-09-29T20:59:00Z'));
  const winter = getForexMarketSession(Date.parse('2026-01-13T15:00:00Z'));
  assert.equal(winter.closeAt, Date.parse('2026-01-13T21:59:00Z'));
  assert.equal(getForexMarketSession(Date.parse('2026-09-29T20:59:30Z')).isOpen, false);
  assert.equal(getForexMarketSession(Date.parse('2026-09-29T21:02:00Z')).isOpen, false);
  assert.equal(getForexMarketSession(Date.parse('2026-09-29T21:06:00Z')).isOpen, true);
  assert.equal(getForexMarketSession(Date.parse('2026-09-26T20:00:00Z')).isOpen, false);
  assert.equal(getForexMarketSession(Date.parse('2026-09-27T21:06:00Z')).isOpen, true);
  const closed = getForexMarketSession(Date.parse('2026-09-29T15:00:00Z'), { closedSessionDates: ['2026-09-29'] });
  assert.equal(closed.isOpen, false);
  const early = getForexMarketSession(Date.parse('2026-09-29T16:50:00Z'), { earlyClosesEt: { '2026-09-29': '12:30' } });
  assert.equal(early.isOpen, false);
  assert.equal(early.closeAt, Date.parse('2026-09-29T16:30:00Z'));
  assert.throws(() => getForexMarketSession(now, { earlyClosesEt: { '2026-09-29': '17:00' } }), /Invalid Forex early-close/);
});

test('OANDA TRY pairs use Central European weekday hours, not the general New York FX session', () => {
  const beforeCloseSummer = getForexMarketSession(Date.parse('2026-09-29T14:59:00Z'), { instrument: 'EUR_TRY' });
  const atCloseSummer = getForexMarketSession(Date.parse('2026-09-29T15:00:00Z'), { instrument: 'USD_TRY' });
  assert.equal(beforeCloseSummer.timeZone, 'Europe/Berlin');
  assert.equal(beforeCloseSummer.schedule, 'try-central-europe-weekdays');
  assert.equal(beforeCloseSummer.isOpen, true);
  assert.equal(beforeCloseSummer.closeAt, Date.parse('2026-09-29T15:00:00Z'));
  assert.equal(atCloseSummer.isOpen, false);
  const winter = getForexMarketSession(Date.parse('2026-01-13T16:00:00Z'), { instrument: 'TRY_JPY' });
  assert.equal(winter.isOpen, false);
  assert.equal(getForexMarketSession(Date.parse('2026-01-13T15:59:00Z'), { instrument: 'TRY_JPY' }).isOpen, true);
  assert.equal(getForexMarketSession(Date.parse('2026-09-27T10:00:00Z'), { instrument: 'EUR_TRY' }).isOpen, false);
  assert.throws(() => getForexMarketSession(now, { instrument: 'EURTRY' }), /BASE_QUOTE/);
  const fridayBeforeEuropeDst = getForexMarketSession(Date.parse('2026-03-27T07:00:00Z'), { instrument: 'EUR_TRY' });
  const mondayAfterEuropeDst = getForexMarketSession(Date.parse('2026-03-30T07:00:00Z'), { instrument: 'EUR_TRY' });
  assert.equal(fridayBeforeEuropeDst.closeAt, Date.parse('2026-03-27T16:00:00Z'));
  assert.equal(mondayAfterEuropeDst.closeAt, Date.parse('2026-03-30T15:00:00Z'));
});

test('OANDA NZD pairs observe the Auckland-time six-minute maintenance break across DST', () => {
  const before = getForexMarketSession(Date.parse('2026-09-29T17:58:59Z'), { instrument: 'NZD_USD' });
  const atBreak = getForexMarketSession(Date.parse('2026-09-29T17:59:00Z'), { instrument: 'USD_NZD' });
  const throughBreak = getForexMarketSession(Date.parse('2026-09-29T18:04:59Z'), { instrument: 'NZD_JPY' });
  const after = getForexMarketSession(Date.parse('2026-09-29T18:05:00Z'), { instrument: 'NZD_USD' });
  assert.equal(before.isOpen, true);
  assert.equal(atBreak.nzdMaintenanceBreak, true);
  assert.equal(atBreak.isOpen, false);
  assert.equal(throughBreak.isOpen, false);
  assert.equal(after.nzdMaintenanceBreak, false);
  assert.equal(after.isOpen, true);
  assert.equal(getForexMarketSession(Date.parse('2026-09-29T17:59:00Z'), { instrument: 'EUR_USD' }).isOpen, true);
});

test('keeps Sunday Forex reopen and next-session close aligned across both DST transition weekends', () => {
  const springBeforeOpen = getForexMarketSession(Date.parse('2026-03-08T21:04:59Z'));
  const springOpen = getForexMarketSession(Date.parse('2026-03-08T21:05:00Z'));
  assert.equal(springBeforeOpen.isOpen, false);
  assert.equal(springOpen.isOpen, true);
  assert.equal(springOpen.marketDate, '2026-03-09');
  assert.equal(springOpen.closeAt, Date.parse('2026-03-09T20:59:00Z'));

  const fallBeforeOpen = getForexMarketSession(Date.parse('2026-11-01T22:04:59Z'));
  const fallOpen = getForexMarketSession(Date.parse('2026-11-01T22:05:00Z'));
  assert.equal(fallBeforeOpen.isOpen, false);
  assert.equal(fallOpen.isOpen, true);
  assert.equal(fallOpen.marketDate, '2026-11-02');
  assert.equal(fallOpen.closeAt, Date.parse('2026-11-02T21:59:00Z'));
});

test('does not generate candidates from stale bars or outside the weekday session window', () => {
  const stale = common.m15.map((row) => ({ ...row, time: new Date(Date.parse(row.time) - 60 * 60_000).toISOString() }));
  assert.equal(evaluateForexDayBreakout({ ...common, m15: stale }).status, 'no-setup');
  assert.equal(evaluateForexDayBreakout({ ...common, now: Date.parse('2026-09-27T15:00:00Z') }).status, 'no-setup');
  assert.equal(evaluateForexDayBreakout({ ...common, now: Date.parse('2026-09-29T21:00:00Z'), sessionDate: '2026-09-29' }).status, 'no-setup');
});
