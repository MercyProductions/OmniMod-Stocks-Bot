import { stockQuote } from '../../shared/fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTimeOfDayRelativeVolume, evaluateOpeningRangeBreakout } from '../src/strategies.js';
import { evaluatePaperCandidate } from '../../shared/paperRisk.js';
import { resolveEtfExposureKey } from '../src/exposure.js';

const OPEN = Date.parse('2026-09-29T13:30:00Z');
const BAR = 5 * 60_000;

function fixture({ direction = 'long', quoteQuality = 'executable', skewMs = 1_000, gapAt = -1, sessionOverrides = {}, config = {} } = {}) {
  const bars = Array.from({ length: 25 }, (_, index) => {
    const time = OPEN + index * BAR;
    const breakout = index === 24;
    const base = direction === 'long' ? 100.1 : 99.9;
    return {
      time: time + (index === gapAt ? BAR : 0), open: base,
      high: breakout ? (direction === 'long' ? 100.95 : 100) : index < 3 ? 100.2 : 100.2,
      low: breakout ? (direction === 'short' ? 99.05 : 99.8) : index < 3 ? 99.8 : 99.8,
      close: breakout ? (direction === 'long' ? 100.8 : 99.2) : base,
      volume: breakout ? 2_500 : 1_000,
    };
  });
  const now = OPEN + bars.length * BAR;
  const quote = direction === 'long'
    ? { bid: 100.8, ask: 100.81, time: now - skewMs, quality: quoteQuality }
    : { bid: 99.19, ask: 99.2, time: now - skewMs, quality: quoteQuality };
  return {
    input: { symbol: 'SPY', bars, quote: stockQuote('SPY', { ...quote, time: new Date(quote.time).toISOString() }), now, session: { marketDate: '2026-09-29', openTime: OPEN, closeTime: OPEN + 78 * BAR, ...sessionOverrides }, config: { roundTripFeesPerUnit: 0, slippageReservePerUnit: 0, ...config } },
    now,
  };
}

test('confirmed 15-minute opening-range breakout requires VWAP, relative volume, and executable side price', () => {
  const { input } = fixture({ sessionOverrides: { discoveryVersion: 'etf-full-directory-v1' } });
  const result = evaluateOpeningRangeBreakout(input);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.owner, 'etfs-etps');
  assert.equal(result.candidate.sessionTimeZone, 'America/New_York');
  assert.equal(result.candidate.direction, 'long');
  assert.equal(result.candidate.entryPrice, input.quote.ask);
  assert.ok(result.candidate.stopPrice < result.candidate.entryPrice);
  assert.ok(result.candidate.targetPrice > result.candidate.entryPrice);
  assert.ok(result.candidate.signal.relativeVolume >= 1.5);
  assert.equal(result.candidate.researchContext.setupType, 'opening_range_breakout');
  assert.equal(result.candidate.researchContext.discoveryVersion, 'etf-full-directory-v1');
  assert.equal(result.candidate.marketGateTrace.observedAt, result.candidate.quoteTime);
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('vwap_alignment'));
  assert.equal(result.candidate.marketGateTrace.passedGates.includes('fresh_catalyst_review'), false,
    'an optional catalyst review must not be reported as passed when it was not required');
  assert.equal(result.candidate.researchContext.features.relative_volume, result.candidate.signal.relativeVolume);
  assert.equal(result.candidate.signal.timeOfDayRelativeVolume.status, 'insufficient_prior_sessions',
    'live input with today-only bars must disclose that a time-of-day baseline is unavailable');
  assert.match(result.candidate.idempotencyKey, /2026-09-29:etp-orb:long/);
  assert.equal(evaluateOpeningRangeBreakout(fixture().input).candidate.idempotencyKey, result.candidate.idempotencyKey);
  const risk = evaluatePaperCandidate(result.candidate, { accountEquity: 10_000, realizedPnlToday: 0, openPositions: [] }, {
    now: input.now, maxQuoteAgeMs: 15_000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.25,
    maxTotalOpenRiskPct: 1, maxGrossExposurePct: 200, maxDailyLossPct: 1, minRewardRisk: 1.5,
  });
  assert.equal(risk.status, 'paper-approved');
  assert.ok(risk.sizing.units > 0);
});

test('source-cited ETP identity and leverage terms persist into the paper candidate without changing the strategy decision', () => {
  const base = fixture().input;
  const classified = { ...base, symbol: 'ETN1', quote: stockQuote('ETN1', base.quote), assetClass: 'etp', exposureKey: 'GOLD', productType: 'etn', leverage: 1, inverse: false,
    classificationSourceUrl: 'https://issuer.example/etn1', classificationReviewedAt: '2026-09-01T00:00:00.000Z' };
  const result = evaluateOpeningRangeBreakout(classified);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.assetClass, 'etp');
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('reviewed_etp_classification'));
  assert.deepEqual(result.candidate.instrumentMetadata, { productType: 'etn', leverage: 1, inverse: false,
    classificationSourceUrl: 'https://issuer.example/etn1', classificationReviewedAt: '2026-09-01T00:00:00.000Z',
    riskNotices: ['issuer_credit_risk_not_modeled'] });
  assert.equal(evaluateOpeningRangeBreakout(base).status, 'candidate');
});

test('classified leveraged and commodity wrappers carry product-specific risk notices', () => {
  const base = fixture().input;
  const common = { ...base, assetClass: 'etp', exposureKey: 'UNDERLYING', inverse: false,
    classificationSourceUrl: 'https://issuer.example/product', classificationReviewedAt: '2026-09-01T00:00:00.000Z' };
  const leveraged = evaluateOpeningRangeBreakout({ ...common, symbol: 'LEV1', quote: stockQuote('LEV1', base.quote), productType: 'leveraged_etf', leverage: 2 });
  assert.deepEqual(leveraged.candidate.instrumentMetadata.riskNotices, ['daily_reset_path_risk']);
  const commodity = evaluateOpeningRangeBreakout({ ...common, symbol: 'CMD1', quote: stockQuote('CMD1', base.quote), productType: 'commodity_pool', leverage: 1 });
  assert.deepEqual(commodity.candidate.instrumentMetadata.riskNotices, ['futures_roll_risk_not_modeled']);
});

test('manual ETP rows require fresh cited classification and canonical exposure before they can become candidates', () => {
  const base = fixture().input;
  const missing = evaluateOpeningRangeBreakout({ ...base, symbol: 'NOTE1', quote: stockQuote('NOTE1', base.quote), assetClass: 'etp' });
  assert.equal(missing.status, 'no-setup');
  assert.ok(missing.reasons.includes('etp_classification_missing_stale_or_invalid'));

  const valid = { ...base, symbol: 'NOTE1', quote: stockQuote('NOTE1', base.quote), assetClass: 'etp', exposureKey: 'GOLD', productType: 'etn', leverage: 1,
    inverse: false, classificationSourceUrl: 'https://issuer.example/note1', classificationReviewedAt: new Date(base.now - 30 * 86_400_000).toISOString() };
  assert.equal(evaluateOpeningRangeBreakout(valid).status, 'candidate');
  for (const invalid of [
    { ...valid, classificationReviewedAt: new Date(base.now - 181 * 86_400_000).toISOString() },
    { ...valid, classificationSourceUrl: 'http://issuer.example/note1' },
    { ...valid, exposureKey: undefined },
    { ...valid, leverage: true },
    { ...valid, productType: 'inverse_etf', leverage: 2 },
    { ...valid, productType: 'leveraged_etf', leverage: 1 },
  ]) {
    const result = evaluateOpeningRangeBreakout(invalid);
    assert.equal(result.status, 'no-setup');
    assert.ok(result.reasons.includes('etp_classification_missing_stale_or_invalid'));
  }
});

test('declared leveraged and inverse wrapper multipliers scale gross exposure but not instrument stop-risk or P&L multiplier', () => {
  const base = fixture().input;
  const ordinary = evaluateOpeningRangeBreakout(base).candidate;
  const leveraged = evaluateOpeningRangeBreakout({ ...base, symbol: 'WRAP3', quote: stockQuote('WRAP3', base.quote), assetClass: 'etp', exposureKey: 'SPY',
    productType: 'inverse_etf', leverage: -3, inverse: true, classificationSourceUrl: 'https://issuer.example/wrap3',
    classificationReviewedAt: '2026-09-01T00:00:00.000Z' }).candidate;
  const portfolio = { accountEquity: 10_000, realizedPnlToday: 0, openPositions: [] };
  const policy = { now: base.now, maxQuoteAgeMs: 15_000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.25,
    maxTotalOpenRiskPct: 1, maxGrossExposurePct: 50, maxDailyLossPct: 1, minRewardRisk: 1.5 };
  const ordinaryRisk = evaluatePaperCandidate(ordinary, portfolio, policy);
  const leveragedRisk = evaluatePaperCandidate(leveraged, portfolio, policy);
  assert.equal(ordinaryRisk.status, 'paper-approved');
  assert.ok(leveragedRisk.reasons.includes('gross_exposure_limit'));
  assert.equal(leveragedRisk.sizing.notionalExposureMultiplier, 3);
  assert.equal(leveragedRisk.sizing.proposedRiskUsd, ordinaryRisk.sizing.proposedRiskUsd);
  assert.equal(leveraged.multiplier, ordinary.multiplier, 'underlying leverage does not replace the contract multiplier used for the ETF price/P&L');
});

test('time-of-day relative volume uses only prior completed matching session slots and distinct dates', () => {
  const slotIndex = 24;
  const marketDate = '2026-09-29';
  const barTime = OPEN + slotIndex * BAR;
  const priorDates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
  const observations = priorDates.map((date, index) => ({ marketDate: date, sessionOpenTime: OPEN,
    time: OPEN + slotIndex * BAR, volume: (index + 1) * 1_000 }));
  observations.push(
    { ...observations[0], volume: 9_000 }, // duplicate date cannot inflate the sample; latest same-slot observation wins
    { marketDate, sessionOpenTime: OPEN, time: barTime, volume: 99_000 }, // today's data is not training history
    { marketDate: '2026-09-30', sessionOpenTime: OPEN, time: OPEN + slotIndex * BAR, volume: 99_000 },
    { marketDate: '2026-09-18', sessionOpenTime: OPEN, time: OPEN + (slotIndex - 1) * BAR, volume: 99_000 },
  );
  const result = calculateTimeOfDayRelativeVolume({ observations, marketDate, sessionOpenTime: OPEN, barTime,
    barVolume: 6_000, now: barTime + BAR, minSessions: 5 });
  assert.equal(result.status, 'available');
  assert.equal(result.sampleSessions, 5);
  assert.equal(result.baselineVolume, 4_600, 'duplicate prior date uses its latest slot value');
  assert.equal(result.ratio, 1.3043);
  const incomplete = calculateTimeOfDayRelativeVolume({ observations, marketDate, sessionOpenTime: OPEN, barTime,
    barVolume: 6_000, now: barTime + BAR - 1, minSessions: 5 });
  assert.equal(incomplete.status, 'current_bar_incomplete_or_outside_session');
  const thin = calculateTimeOfDayRelativeVolume({ observations: observations.slice(0, 2), marketDate,
    sessionOpenTime: OPEN, barTime, barVolume: 6_000, now: barTime + BAR, minSessions: 5 });
  assert.equal(thin.status, 'insufficient_prior_sessions');
  assert.equal(thin.ratio, null);
});

test('malformed ETF/ETP quote and bar numbers are rejected instead of coercing booleans', () => {
  for (const value of [true, false, '']) {
    const badQuote = fixture();
    badQuote.input.quote = { ...badQuote.input.quote, bid: value };
    const quoteResult = evaluateOpeningRangeBreakout(badQuote.input);
    assert.equal(quoteResult.status, 'no-setup', `bid=${String(value)}`);
    assert.ok(quoteResult.reasons.includes('invalid_bid_ask'));

    const badBar = fixture();
    badBar.input.bars[0] = { ...badBar.input.bars[0], volume: value };
    const barResult = evaluateOpeningRangeBreakout(badBar.input);
    assert.equal(barResult.status, 'no-setup', `volume=${String(value)}`);
    assert.ok(barResult.reasons.includes('opening_range_has_gap'));
  }
  const slotIndex = 24;
  const marketDate = '2026-09-29';
  const barTime = OPEN + slotIndex * BAR;
  const observations = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28'].map((date) => ({
    marketDate: date, sessionOpenTime: OPEN, time: barTime, volume: 1_000,
  }));
  observations.push({ ...observations[0], time: barTime + 1, volume: true });
  const result = calculateTimeOfDayRelativeVolume({ observations, marketDate, sessionOpenTime: OPEN, barTime,
    barVolume: 1_000, now: barTime + BAR, minSessions: 5 });
  assert.equal(result.status, 'available');
  assert.equal(result.sampleSessions, 5, 'malformed historical volume cannot replace a valid observation');
  assert.equal(calculateTimeOfDayRelativeVolume({ observations, marketDate, sessionOpenTime: OPEN, barTime,
    barVolume: true, now: barTime + BAR }).status, 'invalid_input');
});

test('leveraged ETF reservation conflicts with an already-open underlying exposure', () => {
  const { input, now } = fixture();
  input.symbol = 'TQQQ';
  input.quote = stockQuote('TQQQ', input.quote);
  input.exposureKey = resolveEtfExposureKey(input.symbol);
  const strategy = evaluateOpeningRangeBreakout(input);
  assert.equal(strategy.status, 'candidate');
  assert.equal(strategy.candidate.exposureKey, 'QQQ');
  const risk = evaluatePaperCandidate(strategy.candidate, {
    accountEquity: 10_000, realizedPnlToday: 0,
    openPositions: [{ status: 'open', instrumentKey: 'QQQ', exposureKey: 'QQQ', direction: 'long' }],
  }, { now, maxQuoteAgeMs: 15_000, maxSpreadPct: 0.5, maxTradeRiskPct: 0.25,
    maxTotalOpenRiskPct: 1, maxGrossExposurePct: 200, maxDailyLossPct: 1, minRewardRisk: 1.5 });
  assert.notEqual(risk.status, 'paper-approved');
  assert.ok(risk.reasons.includes('duplicate_open_exposure'));
});

test('short breakout uses bid entry and reverses stop/target geometry', () => {
  const { input } = fixture({ direction: 'short' });
  const result = evaluateOpeningRangeBreakout(input);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.direction, 'short');
  assert.equal(result.candidate.entryPrice, input.quote.bid);
  assert.ok(result.candidate.stopPrice > result.candidate.entryPrice);
  assert.ok(result.candidate.targetPrice < result.candidate.entryPrice);
});

test('no breakout, delayed reference price, stale quote, gap, halt, and cutoff do not create candidates', () => {
  const normal = fixture();
  normal.input.bars.at(-1).close = 100.1;
  assert.equal(evaluateOpeningRangeBreakout(normal.input).status, 'no-setup');

  for (const options of [
    { quoteQuality: 'delayed-reference' },
    { skewMs: 20_000 },
    { gapAt: 1 },
    { gapAt: 10 },
    { sessionOverrides: { marketHalted: true } },
  ]) assert.equal(evaluateOpeningRangeBreakout(fixture(options).input).status, 'no-setup');

  const nearClose = fixture();
  nearClose.input.now = nearClose.input.session.closeTime - 10 * 60_000;
  nearClose.input.quote.time = nearClose.input.now - 1_000;
  assert.equal(evaluateOpeningRangeBreakout(nearClose.input).status, 'no-setup');
});

test('catalyst blackout, excessive stop distance, and insufficient history fail closed', () => {
  assert.ok(evaluateOpeningRangeBreakout(fixture({ sessionOverrides: { catalystBlocked: true } }).input).reasons.includes('catalyst_blackout'));
  const wideStop = fixture({ config: { maxStopPct: 0.1 } });
  assert.ok(evaluateOpeningRangeBreakout(wideStop.input).reasons.includes('stop_distance_out_of_bounds'));
  const shortHistory = fixture();
  shortHistory.input.bars = shortHistory.input.bars.slice(0, 10);
  assert.ok(evaluateOpeningRangeBreakout(shortHistory.input).reasons.includes('insufficient_intraday_history'));
});

test('provider-required catalyst gate rejects missing/stale/blocked reviews and accepts fresh sourced clearance', () => {
  const missing = fixture({ config: { requireCatalystReview: true } });
  assert.ok(evaluateOpeningRangeBreakout(missing.input).reasons.includes('catalyst_review_missing_stale_or_unclear'));
  const fresh = fixture({ config: { requireCatalystReview: true }, sessionOverrides: {
    catalystReview: { status: 'clear', source: 'SEC filing review', summary: 'No material event or scheduled filing today.', reviewedAt: new Date(missing.now).toISOString() },
  } });
  assert.equal(evaluateOpeningRangeBreakout(fresh.input).status, 'candidate');
  const stale = fixture({ config: { requireCatalystReview: true }, sessionOverrides: {
    catalystReview: { status: 'clear', source: 'source', summary: 'reviewed', reviewedAt: new Date(missing.now - 31 * 60_000).toISOString() },
  } });
  assert.ok(evaluateOpeningRangeBreakout(stale.input).reasons.includes('catalyst_review_missing_stale_or_unclear'));
});

test('invalid strategy limits cannot qualify a signal', () => {
  const { input } = fixture({ config: { maxQuoteAgeMs: 'unlimited' } });
  const result = evaluateOpeningRangeBreakout(input);
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('invalid_strategy_config'));
  for (const config of [
    { roundTripFeesPerUnit: null, slippageReservePerUnit: 0 },
    { roundTripFeesPerUnit: 0, slippageReservePerUnit: null },
  ]) {
    const malformed = fixture({ config }).input;
    assert.ok(evaluateOpeningRangeBreakout(malformed).reasons.includes('cost_reserve_missing_or_invalid'));
  }
  assert.equal(evaluateOpeningRangeBreakout(fixture({ config: { roundTripFeesPerUnit: 0, slippageReservePerUnit: 0 } }).input).status, 'candidate');
});

test('ETP strategy overrides cannot weaken default history, freshness, volume, breakout, stop, reward, or close gates', () => {
  const unsafeOverrides = [
    { rangeBars: 2 }, { minHistoryBars: 23 }, { maxQuoteAgeMs: 15_001 }, { maxQuoteBarSkewMs: 90_001 },
    { minRelativeVolume: 1.49 }, { breakoutBufferAtr: 0.049 }, { breakoutBufferBps: 4.99 },
    { maxStopPct: 1.251 }, { minRewardRisk: 1.49 }, { targetRewardRisk: 1.99 },
    { noNewEntryMinutesBeforeClose: 29 },
  ];
  for (const override of unsafeOverrides) {
    const { input } = fixture({ config: override });
    const result = evaluateOpeningRangeBreakout(input);
    assert.equal(result.status, 'no-setup', `${JSON.stringify(override)} unexpectedly qualified`);
    assert.ok(result.reasons.includes('invalid_strategy_config'), `${JSON.stringify(override)}: ${result.reasons}`);
  }

  const { input } = fixture({ config: { rangeBars: 4, maxQuoteAgeMs: 5_000, maxQuoteBarSkewMs: 60_000,
    minRelativeVolume: 2, breakoutBufferAtr: 0.1, breakoutBufferBps: 10, maxStopPct: 1.1,
    minRewardRisk: 1.75, targetRewardRisk: 2.5, noNewEntryMinutesBeforeClose: 45 } });
  const result = evaluateOpeningRangeBreakout(input);
  assert.equal(result.status, 'candidate', result.reasons?.join(','));
});
