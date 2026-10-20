import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceFuturesTopBookDepth, evaluateFuturesOpeningRange, validateFuturesSession } from '../src/dayStrategy.js';
import { validateActiveFutureContract, validateFuturesUniverse } from '../src/universe.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const open = Date.parse('2026-09-29T13:00:00Z');
const makeBars = (count, step, startTime, trend = 0.02) => Array.from({ length: count }, (_, i) => {
  const close = 6000 + i * trend;
  return { time: new Date(startTime + i * step).toISOString(), open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100 };
});
const contract = {
  symbol: 'ES', providerSymbol: 'ESZ26', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', assetClass: 'equity-index-future',
  underlying: 'S&P 500', exposureKey: 'SPY', activeContract: true, contractSpecVerified: true, contractMode: 'active-contract',
  expiry: '2026-12-18T14:30:00.000Z', multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5,
  initialMarginUsd: 20_000, maintenanceMarginUsd: 18_000,
  specSource: 'https://example.test/verified-contract', specVerifiedAt: '2026-09-29T12:00:00Z',
  settlementReview: { settlementType: 'cash_settled', source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html',
    reviewedAt: '2026-09-29T12:00:00Z', lastTradeAt: '2026-12-18T14:30:00Z' },
};
const bars = makeBars(24, 5 * 60_000, open);
bars[0] = { ...bars[0], high: 6001, low: 5999 };
bars[1] = { ...bars[1], high: 6001.25, low: 5999.25 };
bars[2] = { ...bars[2], high: 6000.75, low: 5999.5 };
bars.at(-1).open = 6000.4; bars.at(-1).close = 6010; bars.at(-1).high = 6010.25; bars.at(-1).low = 6000.3; bars.at(-1).volume = 250;
const inputs = {
  contract, bars, trendBars: makeBars(60, 60 * 60_000, now - 60 * 60_000 * 60),
  quote: { bid: 6009.75, ask: 6010, time: new Date(now).toISOString(), quality: 'executable' },
  session: { marketDate: '2026-09-29', openTime: open, closeTime: Date.parse('2026-09-29T20:00:00Z'),
    source: 'https://www.cmegroup.com/markets/equities.html', reviewedAt: new Date(now).toISOString() },
  now, catalystReview: { status: 'clear', source: 'CME notices reviewed', summary: 'No known contract-specific disruption or scheduled market event in the entry window.', reviewedAt: new Date(now).toISOString() }, accountEquityUsd: 200_000,
  config: { roundTripFeesPerContract: 5, slippageReservePerContract: 2 },
};

test('verified active contract can produce a tick-aligned intraday breakout candidate', () => {
  const result = evaluateFuturesOpeningRange(inputs);
  assert.equal(result.status, 'candidate', result.reasons?.join(','));
  assert.equal(result.candidate.assetClass, 'future');
  assert.equal(result.candidate.direction, 'long');
  assert.equal(result.candidate.multiplier, 50);
  assert.equal(result.candidate.researchContext.setupType, 'session_opening_range_breakout');
  assert.equal(result.candidate.marketGateTrace.observedAt, result.candidate.quoteTime);
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('verified_active_contract'));
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('initial_margin_budget'));
  assert.equal(result.candidate.researchContext.features.relative_volume, result.candidate.signal.relativeVolume);
  assert.equal(result.candidate.initialMarginUsd, 20_000);
  assert.equal(result.candidate.future.providerRawSymbol, 'ESZ6');
  assert.equal(result.candidate.sessionTimeZone, 'America/Chicago');
  assert.equal(result.candidate.sessionSource, inputs.session.source);
  assert.equal(result.candidate.sessionReviewedAt, inputs.session.reviewedAt);
  assert.equal(result.candidate.idempotencyKey, 'CME:ES:202612:2026-09-29:session-orb:long');
  assert.equal(evaluateFuturesOpeningRange(inputs).candidate.idempotencyKey, result.candidate.idempotencyKey);
  for (const level of [result.candidate.entryPrice, result.candidate.stopPrice, result.candidate.targetPrice]) assert.equal(level / 0.25, Math.round(level / 0.25));
});

test('Futures session date and IANA timezone must match open/close timestamps', () => {
  assert.equal(validateFuturesSession(inputs.session, { now }).valid, true);
  const overnight = validateFuturesSession({ marketDate: '2026-09-29', timeZone: 'America/Chicago',
    openTime: '2026-09-28T22:00:00Z', closeTime: '2026-09-29T21:00:00Z',
    source: 'https://www.cmegroup.com/markets/equities.html', reviewedAt: new Date(now).toISOString() }, { now });
  assert.equal(overnight.valid, true);
  assert.ok(validateFuturesSession({ ...inputs.session, marketDate: '2026-09-28' }).reasons.includes('session_timezone_date_mismatch'));
  assert.ok(validateFuturesSession({ ...inputs.session, closeTime: '2026-09-30T06:00:00Z' }).reasons.includes('session_timezone_date_mismatch'));
  assert.ok(validateFuturesSession({ ...inputs.session, timeZone: 'Not/A-Timezone' }).reasons.includes('session_timezone_invalid'));
  assert.ok(validateFuturesSession({ ...inputs.session, marketDate: '2026-02-30' }).reasons.includes('invalid_or_missing_session_date'));
});

test('Futures session entry requires a fresh cited session and a plausible duration', () => {
  const { session } = inputs;
  assert.equal(validateFuturesSession(session, { now }).valid, true);
  for (const invalid of [
    { ...session, source: '' },
    { ...session, source: 'http://www.cmegroup.com/markets/equities.html' },
    { ...session, reviewedAt: new Date(now - 24 * 60 * 60_000 - 1).toISOString() },
    { ...session, reviewedAt: new Date(now + 5_001).toISOString() },
    { ...session, closeTime: open + 24 * 60 * 60_000 + 1 },
  ]) assert.equal(validateFuturesSession(invalid, { now }).valid, false);
  assert.ok(evaluateFuturesOpeningRange({ ...inputs, session: { ...session, source: '' } }).reasons.includes('session_source_or_freshness_invalid'));
});

test('historical replay validates session-review freshness against the replay clock', () => {
  const replayNow = Date.now() - 7 * 24 * 60 * 60_000;
  const offset = replayNow - now;
  const shift = (value) => new Date((Number.isFinite(Number(value)) ? Number(value) : Date.parse(value)) + offset).toISOString();
  const replayOpen = shift(inputs.session.openTime), replayClose = shift(inputs.session.closeTime);
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(replayClose)).map(({ type, value }) => [type, value]));
  const replaySession = { ...inputs.session, marketDate: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
    openTime: replayOpen, closeTime: replayClose, reviewedAt: shift(inputs.session.reviewedAt) };
  const replayContract = { ...inputs.contract, specVerifiedAt: shift(inputs.contract.specVerifiedAt),
    settlementReview: { ...inputs.contract.settlementReview, reviewedAt: shift(inputs.contract.settlementReview.reviewedAt) } };
  const result = evaluateFuturesOpeningRange({ ...inputs, now: replayNow, session: replaySession, contract: replayContract,
    bars: inputs.bars.map((bar) => ({ ...bar, time: shift(bar.time) })),
    trendBars: inputs.trendBars.map((bar) => ({ ...bar, time: shift(bar.time) })),
    quote: { ...inputs.quote, time: shift(inputs.quote.time) },
    catalystReview: { ...inputs.catalystReview, reviewedAt: shift(inputs.catalystReview.reviewedAt) } });
  assert.equal(result.status, 'candidate', result.reasons?.join(','));
  assert.equal(result.candidate.sessionReviewedAt, replaySession.reviewedAt);
});

test('Databento-style exact expiry timestamps remain eligible only until their actual expiry instant', () => {
  const exactExpiry = '2026-09-30T15:00:02.000Z';
  const exact = { ...contract, expiry: exactExpiry,
    settlementReview: { ...contract.settlementReview, lastTradeAt: exactExpiry } };
  const before = evaluateFuturesOpeningRange({ ...inputs, contract: exact, now: now + 1_000,
  });
  assert.equal(before.status, 'candidate', before.reasons?.join(','));
  const after = evaluateFuturesOpeningRange({ ...inputs, contract: exact, now: Date.parse(exactExpiry) });
  assert.equal(after.reasons.includes('invalid_or_expired_contract'), true);
});

test('continuous proxies, incomplete contract terms, margin pressure, and unverified catalysts fail closed', () => {
  const proxy = validateFuturesUniverse([{ symbol: 'ES', providerSymbol: 'ES=F', assetClass: 'equity-index-future' }])[0];
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, contract: proxy }).reasons.includes('verified_active_contract_required'), true);
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, accountEquityUsd: 50_000 }).reasons.includes('initial_margin_exceeds_budget'), true);
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, catalystReview: { ...inputs.catalystReview, status: 'blocked' } }).reasons.includes('catalyst_blackout_or_unverified'), true);
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, catalystReview: undefined }).reasons.includes('catalyst_blackout_or_unverified'), true);
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, catalystReview: { ...inputs.catalystReview, reviewedAt: new Date(now - 31 * 60_000).toISOString() } }).reasons.includes('catalyst_blackout_or_unverified'), true);
  assert.throws(() => validateActiveFutureContract({ ...contract, expiry: '2020-01-01' }, { now }), /Invalid or stale/);
});

test('opening-range evaluator rejects impossible margin specs and cannot raise the default margin budget', () => {
  const badContract = { ...contract, maintenanceMarginUsd: contract.initialMarginUsd + 1 };
  assert.ok(evaluateFuturesOpeningRange({ ...inputs, contract: badContract }).reasons.includes('contract_spec_or_margin_invalid'));
  for (const maxInitialMarginPct of [0, -1, 25.01, 100]) {
    const result = evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config, maxInitialMarginPct } });
    assert.ok(result.reasons.includes('invalid_strategy_config'), `${maxInitialMarginPct}: ${result.reasons}`);
  }
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config, maxInitialMarginPct: 10 } }).status, 'candidate');
});

test('strategy overrides may tighten defaults but cannot bypass signal, freshness, spread, or close-window gates', () => {
  const unsafeOverrides = [
    { rangeBars: 2 }, { rangeBars: 13 }, { minSessionBars: 23 }, { maxQuoteAgeMs: 5_001 },
    { maxBarAgeMs: 6 * 60_000 + 1 }, { maxSpreadTicks: 2.01 }, { minRelativeVolume: 1.49 },
    { breakoutBufferAtr: 0.049 }, { targetR: 1.49 }, { noEntryBeforeCloseMs: 30 * 60_000 - 1 },
    { deliveryEntryBufferHours: 6 },
  ];
  for (const override of unsafeOverrides) {
    const result = evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config, ...override } });
    assert.notEqual(result.status, 'candidate', `${JSON.stringify(override)} unexpectedly qualified`);
    assert.ok(result.reasons.includes('invalid_strategy_config') || result.reasons.includes('invalid_delivery_entry_buffer'),
      `${JSON.stringify(override)}: ${result.reasons}`);
  }
  const tighter = evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config, rangeBars: 4,
    maxQuoteAgeMs: 2_000, maxBarAgeMs: 5 * 60_000, maxSpreadTicks: 1, minRelativeVolume: 1.75,
    breakoutBufferAtr: 0.1, targetR: 2.5, noEntryBeforeCloseMs: 45 * 60_000,
    maxInitialMarginPct: 10, deliveryEntryBufferHours: 30 } });
  assert.equal(tighter.status, 'candidate', tighter.reasons?.join(','));
});

test('missing, stale, post-expiry, and first-notice-passed settlement terms block entry', () => {
  const cases = [
    [{ ...contract, settlementReview: undefined }, 'settlement_terms_review_missing_stale_or_invalid'],
    [{ ...contract, settlementReview: { ...contract.settlementReview, reviewedAt: '2026-01-01T00:00:00Z' } }, 'settlement_terms_review_missing_stale_or_invalid'],
    [{ ...contract, settlementReview: { ...contract.settlementReview, lastTradeAt: '2026-12-20T00:00:00Z' } }, 'last_trade_after_contract_expiry'],
    [{ ...contract, settlementReview: { ...contract.settlementReview, settlementType: 'physical_delivery', firstNoticeAt: '2026-09-29T14:59:00Z' } }, 'physical_delivery_first_notice_cutoff_missing_or_invalid'],
  ];
  for (const [candidateContract, reason] of cases) {
    const result = evaluateFuturesOpeningRange({ ...inputs, contract: candidateContract });
    assert.notEqual(result.status, 'candidate');
    assert.ok(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
  }
  const ready = evaluateFuturesOpeningRange({ ...inputs, contract: { ...contract, settlementReview: {
    settlementType: 'physical_delivery', source: 'https://www.cmegroup.com/market-regulation/rulebook.html',
    reviewedAt: '2026-09-29T14:00:00Z', firstNoticeAt: '2026-10-01T00:00:00Z', lastTradeAt: '2026-12-18T14:30:00Z' } } });
  assert.equal(ready.status, 'candidate', ready.reasons?.join(','));
  assert.equal(ready.candidate.future.settlementReview.settlementType, 'physical_delivery');
});

test('settlement cutoff cannot be reduced below 24 hours and rejects imminent notice or last trade', () => {
  const physical = { ...contract, settlementReview: { ...contract.settlementReview, settlementType: 'physical_delivery',
    firstNoticeAt: '2026-09-30T03:00:00Z' } };
  const defaultBuffer = evaluateFuturesOpeningRange({ ...inputs, contract: physical });
  assert.ok(defaultBuffer.reasons.includes('settlement_entry_cutoff_buffer_active'));
  const smallerBuffer = evaluateFuturesOpeningRange({ ...inputs, contract: physical, config: { ...inputs.config, deliveryEntryBufferHours: 6 } });
  assert.equal(smallerBuffer.status, 'no-setup');
  assert.ok(smallerBuffer.reasons.includes('invalid_delivery_entry_buffer'));

  const distantNotice = { ...contract, settlementReview: { ...contract.settlementReview, settlementType: 'physical_delivery',
    firstNoticeAt: '2026-10-01T03:00:00Z' } };
  const largerBuffer = evaluateFuturesOpeningRange({ ...inputs, contract: distantNotice, config: { ...inputs.config, deliveryEntryBufferHours: 30 } });
  assert.equal(largerBuffer.status, 'candidate', largerBuffer.reasons?.join(','));
  assert.equal(largerBuffer.candidate.future.settlementReview.entryBufferMs, 30 * 60 * 60_000);

  const cash = { ...contract, settlementReview: { ...contract.settlementReview, lastTradeAt: '2026-09-30T03:00:00Z' } };
  assert.ok(evaluateFuturesOpeningRange({ ...inputs, contract: cash }).reasons.includes('settlement_entry_cutoff_buffer_active'));
  const invalid = evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config, deliveryEntryBufferHours: 721 } });
  assert.ok(invalid.reasons.includes('invalid_delivery_entry_buffer'));
});

test('future-dated H1 bars are excluded from trend EMAs to prevent look-ahead bias', () => {
  const baseline = evaluateFuturesOpeningRange(inputs);
  const futureBars = Array.from({ length: 60 }, (_, i) => {
    const close = 5000 - i * 0.1;
    return { time: new Date(now + (i + 1) * 60 * 60_000).toISOString(), open: close + 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100 };
  });
  const result = evaluateFuturesOpeningRange({ ...inputs, trendBars: [...inputs.trendBars, ...futureBars] });
  assert.equal(baseline.status, 'candidate');
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.signal.ema20, baseline.candidate.signal.ema20);
  assert.equal(result.candidate.signal.ema50, baseline.candidate.signal.ema50);
});

test('duplicate completed H1 timestamps block the setup instead of overweighting an EMA sample', () => {
  const last = inputs.trendBars.at(-1);
  const duplicated = [...inputs.trendBars, { ...last, open: last.open + 100, high: last.high + 100, low: last.low + 100, close: last.close + 100 }];
  const result = evaluateFuturesOpeningRange({ ...inputs, trendBars: duplicated });
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('h1_trend_bars_have_duplicate_timestamps'));
});

test('halts, stale quotes, wide spreads, and missing cost assumptions do not become candidates', () => {
  assert.notEqual(evaluateFuturesOpeningRange({ ...inputs, session: { ...inputs.session, marketHalted: true } }).status, 'candidate');
  assert.notEqual(evaluateFuturesOpeningRange({ ...inputs, quote: { ...inputs.quote, time: new Date(now - 20_000).toISOString() } }).status, 'candidate');
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, quote: { ...inputs.quote, ask: 6011 } }).reasons.includes('spread_exceeds_tick_limit'), true);
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, config: {} }).reasons.includes('cost_reserve_missing_or_invalid'), true);
  for (const config of [
    { ...inputs.config, roundTripFeesPerContract: null },
    { ...inputs.config, slippageReservePerContract: null },
  ]) assert.ok(evaluateFuturesOpeningRange({ ...inputs, config }).reasons.includes('cost_reserve_missing_or_invalid'));
  assert.equal(evaluateFuturesOpeningRange({ ...inputs, config: { ...inputs.config,
    roundTripFeesPerContract: 0, slippageReservePerContract: 0 } }).status, 'candidate');
});

test('live paper approval requires displayed top-of-book size to cover both sides of the risk-sized quantity', () => {
  const approved = { status: 'paper-approved', sizing: { units: 2 }, reasons: [] };
  assert.deepEqual(enforceFuturesTopBookDepth(approved, { bidSize: 2, askSize: 3 }), approved);
  const blocked = enforceFuturesTopBookDepth(approved, { bidSize: 1, askSize: 3 });
  assert.equal(blocked.status, 'risk-blocked');
  assert.ok(blocked.reasons.includes('displayed_top_book_size_below_paper_quantity'));
  assert.equal(enforceFuturesTopBookDepth({ status: 'risk-blocked' }, {}).status, 'risk-blocked');
  for (const malformed of [true, false, '']) {
    const rejected = enforceFuturesTopBookDepth({ status: 'paper-approved', sizing: { units: 1 }, reasons: [] }, { bidSize: malformed, askSize: 1 });
    assert.equal(rejected.status, 'risk-blocked', `bidSize=${String(malformed)}`);
    assert.ok(rejected.reasons.includes('displayed_top_book_size_below_paper_quantity'));
  }
});

test('futures strategy rejects malformed contract, quote, bar, and equity numeric fields', () => {
  const badContract = evaluateFuturesOpeningRange({ ...inputs, contract: { ...contract, tickValueUsd: true } });
  assert.ok(badContract.reasons.includes('contract_spec_or_margin_invalid'));
  const badQuote = evaluateFuturesOpeningRange({ ...inputs, quote: { ...inputs.quote, bid: true } });
  assert.ok(badQuote.reasons.includes('executable_bid_ask_required'));
  const badBars = inputs.bars.map((bar, index) => index === 10 ? { ...bar, volume: true } : bar);
  const badBarResult = evaluateFuturesOpeningRange({ ...inputs, bars: badBars });
  assert.ok(badBarResult.reasons.includes('insufficient_completed_session_bars'));
  const badEquity = evaluateFuturesOpeningRange({ ...inputs, accountEquityUsd: true });
  assert.ok(badEquity.reasons.includes('initial_margin_exceeds_budget'));
});
