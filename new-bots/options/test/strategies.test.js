import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionDayTradeCandidate } from '../src/strategies.js';
import { evaluatePaperCandidate } from '../../shared/paperRisk.js';

const now = Date.parse('2026-09-29T15:00:00Z');
const leg = (symbol, type, strike, bid, ask, overrides = {}) => ({
  symbol, underlying: 'SPY', type, strike, bid, ask, expiry: '2026-10-02', multiplier: 100,
  openInterest: 500, volume: 50, time: new Date(now - 1_000).toISOString(), quoteQuality: 'executable', ...overrides,
});
const input = (direction = 'long', overrides = {}) => ({
  now,
  signal: { underlyingSymbol: 'SPY', sessionDate: '2026-09-29', sessionClose: new Date(now + 5 * 60 * 60_000).toISOString(), direction, underlyingPrice: 100, underlyingTarget: direction === 'long' ? 104 : 96, observedAt: new Date(now - 1_000).toISOString(), underlyingQuote: { bid: 99.99, ask: 100.01, time: new Date(now - 1_000).toISOString(), quality: 'executable' }, catalystReview: { status: 'clear', source: 'manual-review', summary: 'No high-impact event found.', reviewedAt: new Date(now - 1_000).toISOString() }, optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'No ex-dividend date through option expiry.', reviewedAt: new Date(now - 1_000).toISOString(), reviewedThrough: '2026-10-02', nextExDividendDate: null }, sessionOpen: true },
  chain: { expiry: '2026-10-02', quoteQuality: 'executable', source: 'fixture', options: direction === 'long'
    ? [leg('SPY261002C00100000', 'call', 100, 2, 2.1), leg('SPY261002C00103000', 'call', 103, 0.9, 1)]
    : [leg('SPY261002P00100000', 'put', 100, 2, 2.1), leg('SPY261002P00097000', 'put', 97, 0.9, 1)] },
  config: { minOpenInterest: 100, minVolume: 1, maxLegSpreadPct: 15, maxQuoteAgeMs: 10_000, maxLegSkewMs: 3_000, minDaysToExpiry: 1, maxDaysToExpiry: 45, minRewardRisk: 1.5, feePerContractRoundTrip: 0, slippageReservePerContract: 0 },
  ...overrides,
});

test('bullish underlying day signal selects a defined-risk same-expiry call debit vertical', () => {
  const result = buildOptionDayTradeCandidate(input('long'));
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.owner, 'options');
  assert.equal(result.candidate.researchContext.setupType, 'underlying_confirmed_debit_vertical');
  assert.equal(result.candidate.marketGateTrace.observedAt, result.candidate.quoteTime);
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('call_assignment_review'));
  assert.equal(result.candidate.marketGateTrace.passedGates.includes('complete_greeks_required'), false);
  assert.equal(result.candidate.researchContext.features.combined_open_interest, 1_000);
  assert.equal(result.candidate.sessionTimeZone, 'America/New_York');
  assert.equal(result.candidate.exposureKey, 'SPY');
  assert.equal(result.candidate.idempotencyKey, 'SPY:2026-09-29:long:option-vertical:2026-10-02');
  assert.equal(buildOptionDayTradeCandidate(input('long')).candidate.idempotencyKey, result.candidate.idempotencyKey);
  assert.equal(result.candidate.option.strategy, 'bull-call-debit-vertical');
  assert.equal(result.candidate.entryPrice, 1.2);
  assert.equal(result.candidate.maxLossPerUnit, 1.2);
  assert.equal(result.candidate.option.maxLossPerContractUsd, 120);
  assert.equal(result.candidate.option.assignmentReview.reviewedThrough, '2026-10-02');
  assert.equal(Date.parse(result.candidate.forceExitAt), Date.parse(input('long').signal.sessionClose) - 5 * 60_000);
  assert.equal(result.candidate.option.forceExitBufferMinutes, 5);
  const risk = evaluatePaperCandidate(result.candidate, { accountEquity: 10_000, realizedPnlToday: 0, openPositions: [] }, {
    now, maxQuoteAgeMs: 10_000, maxSpreadPct: 25, maxTradeRiskPct: 2, maxTotalOpenRiskPct: 3,
    maxGrossExposurePct: 100, maxDailyLossPct: 1, minRewardRisk: 1.5,
  });
  assert.equal(risk.status, 'paper-approved');
  // The 50% premium stop is an operational exit, not a guaranteed fill. Size
  // against the entire defined-risk debit so gaps/missed marks cannot exceed
  // the declared per-trade risk budget by construction.
  assert.equal(risk.sizing.units, 1);
  assert.equal(risk.sizing.proposedRiskUsd, result.candidate.option.maxLossPerContractUsd);
  assert.ok(risk.sizing.proposedRiskUsd <= 200);
});

test('strategy checks contract identity itself, even when a caller labels quotes executable', () => {
  const original = input('long');
  const cases = [
    [{ symbol: 'QQQ261002C00100000' }, 'adjusted_root_unverified'],
    [{ underlying: 'QQQ' }, 'underlying_identity_mismatch'],
    [{ symbol: 'SPY261002P00100000' }, 'option_type_mismatch'],
    [{ symbol: 'SPY261009C00100000' }, 'expiration_identity_mismatch'],
    [{ strike: 99 }, 'strike_identity_mismatch'],
    [{ multiplier: undefined }, 'contract_deliverable_unverified'],
    [{ multiplier: 10 }, 'contract_deliverable_unverified'],
  ];
  for (const [override, reason] of cases) {
    const result = buildOptionDayTradeCandidate({ ...original,
      chain: { ...original.chain, options: [{ ...original.chain.options[0], ...override }, original.chain.options[1]] } });
    assert.equal(result.status, 'no-setup', reason);
    assert.equal(result.diagnostics.legRejections[reason], 1, reason);
  }
  const duplicate = buildOptionDayTradeCandidate({ ...original, chain: { ...original.chain,
    options: [...original.chain.options, { ...original.chain.options[0], symbol: 'SPY   261002C00100000' }] } });
  assert.equal(duplicate.status, 'no-setup');
  assert.equal(duplicate.diagnostics.legRejections.duplicate_contract_identity, 2);
  const emptyLeg = buildOptionDayTradeCandidate({ ...original, chain: { ...original.chain, options: [null] } });
  assert.equal(emptyLeg.status, 'no-setup');
});

test('padded OCC spelling is canonicalized without changing valid spread economics', () => {
  const original = input('long');
  const expected = buildOptionDayTradeCandidate(original).candidate;
  const result = buildOptionDayTradeCandidate({ ...original, chain: { ...original.chain,
    options: original.chain.options.map((leg) => ({ ...leg, symbol: leg.symbol.replace('SPY', 'SPY   ') })) } });
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.instrumentKey, expected.instrumentKey);
  assert.equal(result.candidate.entryPrice, expected.entryPrice);
  assert.equal(result.candidate.maxLossPerUnit, expected.maxLossPerUnit);
  assert.equal(result.candidate.targetPrice, expected.targetPrice);
  assert.equal(result.candidate.dataIdentityVersion, 'standard-listed-option-v1');
});

test('bearish underlying day signal selects a put debit vertical', () => {
  const result = buildOptionDayTradeCandidate(input('short'));
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.direction, 'long');
  assert.equal(result.candidate.underlyingDirection, 'short');
  assert.equal(result.candidate.marketGateTrace.passedGates.includes('call_assignment_review'), false,
    'put spreads must not assert a call assignment review');
  assert.equal(result.candidate.option.strategy, 'bear-put-debit-vertical');
  const risk = evaluatePaperCandidate(result.candidate, { accountEquity: 10_000, realizedPnlToday: 0, openPositions: [] }, {
    now, maxQuoteAgeMs: 10_000, maxSpreadPct: 25, maxTradeRiskPct: 2, maxTotalOpenRiskPct: 3,
    maxGrossExposurePct: 100, maxDailyLossPct: 1, minRewardRisk: 1.5,
  });
  assert.equal(risk.status, 'paper-approved');
});

test('paper cost reserves aggregate per-contract round-trip fees and slippage across both spread legs', () => {
  const base = input('long');
  const result = buildOptionDayTradeCandidate(input('long', { config: { ...base.config, feePerContractRoundTrip: 1.25, slippageReservePerContract: 0.4 } }));
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.option.contractsPerSpread, 2);
  assert.equal(result.candidate.roundTripFeesPerUnit, 2.5);
  assert.equal(result.candidate.slippageReservePerUnit, 0.8);
  assert.equal(result.candidate.option.spreadFeesPerRoundTrip, 2.5);
  assert.equal(result.candidate.option.spreadSlippageReservePerRoundTrip, 0.8);
  const risk = evaluatePaperCandidate(result.candidate, { accountEquity: 10_000, realizedPnlToday: 0, openPositions: [] }, {
    now, maxQuoteAgeMs: 10_000, maxSpreadPct: 25, maxTradeRiskPct: 2, maxTotalOpenRiskPct: 3,
    maxGrossExposurePct: 100, maxDailyLossPct: 1, minRewardRisk: 1.5,
  });
  assert.equal(risk.sizing.units, 1);
  assert.equal(risk.sizing.proposedRiskUsd, 123.3);
});

test('selected vertical retains quote-time leg Greeks and IV for shadow analysis without gating the setup', () => {
  const base = input('long');
  const [long, short] = base.chain.options;
  const result = buildOptionDayTradeCandidate(input('long', { chain: { ...base.chain, options: [
    { ...long, greeks: { delta: 0.55, gamma: 0.04, theta: -0.02, vega: 0.12, impliedVolatility: 0.28, updatedAt: new Date(now - 3 * 60 * 60_000).toISOString() } },
    { ...short, greeks: { delta: 0.35, gamma: 0.03, theta: -0.01, vega: 0.07, impliedVolatility: 0.25, updatedAt: new Date(now - 60 * 60_000).toISOString() } },
  ] } }));
  assert.equal(result.status, 'candidate');
  assert.deepEqual({ status: result.candidate.optionGreekContext.status, netDelta: result.candidate.optionGreekContext.netDeltaPerSpread, ivDiff: result.candidate.optionGreekContext.impliedVolatilityDifference }, {
    status: 'complete', netDelta: 0.2, ivDiff: 0.03,
  });
  assert.equal(result.candidate.optionGreekContext.netDeltaSharesPerSpread, 20);
  assert.equal(result.candidate.optionGreekContext.netDeltaUsdPerSpread, 2_000);
  assert.equal(result.candidate.optionGreekContext.netGammaPerSpread, 0.01);
  assert.equal(result.candidate.optionGreekContext.netThetaPerSpread, -0.01);
  assert.equal(result.candidate.optionGreekContext.netThetaUsdPerDay, -1);
  assert.equal(result.candidate.optionGreekContext.netVegaPerSpread, 0.05);
  assert.equal(result.candidate.optionGreekContext.greeksTimestampSkewMs, 2 * 60 * 60_000);
  assert.equal(result.candidate.optionGreekContext.greekDataFreshness, 'older_than_two_hours');
  assert.equal(buildOptionDayTradeCandidate(input('long')).status, 'candidate', 'missing Greeks remain descriptive and do not change the gate');
  assert.equal(buildOptionDayTradeCandidate(input('long')).candidate.optionGreekContext.status, 'partial_or_unavailable');
});

test('complete recent synchronized Greeks gate only the explicitly requested research track', () => {
  const base = input('long');
  const withGreeks = (ageMs = 30 * 60_000) => ({ ...base.chain, options: base.chain.options.map((row, index) => ({
    ...row, greeks: { delta: index ? 0.35 : 0.55, gamma: 0.03, theta: -0.02, vega: 0.08,
      impliedVolatility: 0.27, updatedAt: new Date(now - ageMs - index * 1_000).toISOString() },
  })) });
  const ordinary = buildOptionDayTradeCandidate(input('long'));
  assert.equal(ordinary.status, 'candidate', 'production behavior does not require Greeks');
  const qualified = buildOptionDayTradeCandidate(input('long', { chain: withGreeks(), config: { ...base.config, requireCompleteGreeks: true } }));
  assert.equal(qualified.status, 'candidate');
  const missing = buildOptionDayTradeCandidate(input('long', { config: { ...base.config, requireCompleteGreeks: true } }));
  assert.equal(missing.status, 'no-setup');
  assert.equal(missing.diagnostics.greekDataRejectedPairs, 1);
  const stale = buildOptionDayTradeCandidate(input('long', { chain: withGreeks(3 * 60 * 60_000), config: { ...base.config, requireCompleteGreeks: true } }));
  assert.equal(stale.status, 'no-setup');
  assert.equal(stale.diagnostics.greekDataRejectedPairs, 1);
});

test('delayed, stale, skewed, thin, crossed, or mismatched-expiry quotes are rejected', () => {
  const cases = [
    input('long', { chain: { ...input('long').chain, quoteQuality: 'delayed' } }),
    input('long', { signal: { ...input('long').signal, observedAt: new Date(now - 20_000).toISOString() } }),
    input('long', { chain: { ...input('long').chain, options: [leg('SPY261002C00100000', 'call', 100, 2, 2.1, { time: new Date(now - 8_000).toISOString() }), leg('SPY261002C00103000', 'call', 103, 0.9, 1)] } }),
    input('long', { chain: { ...input('long').chain, options: [leg('SPY261002C00100000', 'call', 100, 2, 2.1, { openInterest: 5 }), leg('SPY261002C00103000', 'call', 103, 0.9, 1)] } }),
    input('long', { chain: { ...input('long').chain, options: [leg('SPY261002C00100000', 'call', 100, 2.2, 2.1), leg('SPY261002C00103000', 'call', 103, 0.9, 1)] } }),
    input('long', { chain: { ...input('long').chain, options: [leg('SPY261002C00100000', 'call', 100, 2, 2.1), leg('SPY261002C00103000', 'call', 103, 0.9, 1, { expiry: '2026-10-09' })] } }),
  ];
  for (const scenario of cases) {
    const result = buildOptionDayTradeCandidate(scenario);
    assert.equal(result.status, 'no-setup');
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  }
});

test('malformed boolean or blank underlying and option-chain measurements cannot qualify', () => {
  const base = input('long');
  for (const field of ['bid', 'ask', 'strike', 'multiplier', 'openInterest', 'volume']) {
    for (const value of [true, '']) {
      const result = buildOptionDayTradeCandidate(input('long', { chain: { ...base.chain,
        options: base.chain.options.map((row) => ({ ...row, [field]: value })) } }));
      assert.equal(result.status, 'no-setup', `${field}=${String(value)}`);
      assert.ok(Object.keys(result.diagnostics?.legRejections ?? {}).length > 0, `${field}=${String(value)}`);
    }
  }
  const badUnderlyingQuote = buildOptionDayTradeCandidate(input('long', { signal: { ...base.signal,
    underlyingQuote: { ...base.signal.underlyingQuote, bid: true } } }));
  assert.equal(badUnderlyingQuote.status, 'no-setup');
  assert.ok(badUnderlyingQuote.reasons.includes('underlying_quote_missing_stale_or_mismatched'));
  const badUnderlyingPrice = buildOptionDayTradeCandidate(input('long', { signal: { ...base.signal, underlyingPrice: true } }));
  assert.equal(badUnderlyingPrice.status, 'no-setup');
  assert.ok(badUnderlyingPrice.reasons.includes('invalid_underlying_signal'));
});

test('vertical legs must be synchronized with each other, not merely near the underlying signal time', () => {
  const base = input('long');
  const [long, short] = base.chain.options;
  const skewed = input('long', {
    signal: { ...base.signal, observedAt: new Date(now - 3_000).toISOString() },
    chain: { ...base.chain, options: [
      { ...long, time: new Date(now - 4_500).toISOString() },
      { ...short, time: new Date(now - 1_000).toISOString() },
    ] },
  });
  const result = buildOptionDayTradeCandidate(skewed);
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('option_leg_quote_pair_skew'));
  assert.equal(result.diagnostics.legQuoteSkewPairs, 1);
});

test('opposing direction, catalyst blackout, expired window, and bad strategy config fail closed', () => {
  assert.ok(buildOptionDayTradeCandidate(input('long', { signal: { ...input('long').signal, underlyingTarget: 98 } })).reasons.includes('underlying_target_conflicts_with_signal'));
  assert.ok(buildOptionDayTradeCandidate(input('long', { signal: { ...input('long').signal, catalystBlocked: true } })).reasons.includes('underlying_catalyst_blackout'));
  assert.ok(buildOptionDayTradeCandidate(input('long', { config: { minRewardRisk: NaN } })).reasons.includes('invalid_strategy_config'));
  for (const key of ['feePerContractRoundTrip', 'slippageReservePerContract']) {
    const config = { ...input('long').config, [key]: null };
    assert.ok(buildOptionDayTradeCandidate(input('long', { config })).reasons.includes('invalid_strategy_config'));
  }
  assert.ok(buildOptionDayTradeCandidate(input('long', { chain: { ...input('long').chain, expiry: '2026-09-29' } })).reasons.includes('expiry_outside_configured_holding_window'));
});

test('Options overrides cannot loosen default liquidity, quote-quality, expiry, exit, or reward-risk gates', () => {
  const base = input('long');
  const unsafeOverrides = [
    { minOpenInterest: 99 }, { minVolume: 0 }, { maxLegSpreadPct: 15.01 }, { maxQuoteAgeMs: 10_001 },
    { maxLegSkewMs: 3_001 }, { maxCatalystReviewAgeMs: 30 * 60_000 + 1 },
    { maxAssignmentReviewAgeMs: 24 * 60 * 60_000 + 1 }, { minDaysToExpiry: 0 },
    { maxDaysToExpiry: 46 }, { forceExitBufferMinutes: 4 }, { minRewardRisk: 1.49 },
  ];
  for (const override of unsafeOverrides) {
    const result = buildOptionDayTradeCandidate(input('long', { config: { ...base.config, ...override } }));
    assert.equal(result.status, 'no-setup', `${JSON.stringify(override)} unexpectedly qualified`);
    assert.ok(result.reasons.includes('invalid_strategy_config'), `${JSON.stringify(override)}: ${result.reasons}`);
  }
  const tighter = buildOptionDayTradeCandidate(input('long', { config: { ...base.config, minOpenInterest: 250,
    minVolume: 2, maxLegSpreadPct: 12, maxQuoteAgeMs: 5_000, maxLegSkewMs: 1_000,
    maxCatalystReviewAgeMs: 15 * 60_000, maxAssignmentReviewAgeMs: 12 * 60 * 60_000,
    minDaysToExpiry: 2, maxDaysToExpiry: 30, forceExitBufferMinutes: 10, minRewardRisk: 1.5 } }));
  assert.equal(tighter.status, 'candidate', tighter.reasons?.join(','));
});

test('0DTE eligibility cannot be enabled by lowering the configured minimum expiry window', () => {
  const base = input('long');
  const result = buildOptionDayTradeCandidate(input('long', {
    chain: { ...base.chain, expiry: '2026-09-29', options: base.chain.options.map((row) => ({ ...row, expiry: '2026-09-29' })) },
    config: { ...base.config, minDaysToExpiry: 0 },
  }));
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('invalid_strategy_config'));
});

test('options do not enter inside the configured pre-close exit buffer', () => {
  const late = input('long', { signal: { ...input('long').signal, sessionClose: new Date(now + 4 * 60_000).toISOString() } });
  const result = buildOptionDayTradeCandidate(late);
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('insufficient_time_before_option_exit'));
  const invalid = buildOptionDayTradeCandidate(input('long', { config: { ...input('long').config, forceExitBufferMinutes: 31 } }));
  assert.ok(invalid.reasons.includes('invalid_strategy_config'));
});

test('missing, stale, or mismatched underlying quote cannot qualify an options paper candidate', () => {
  for (const override of [
    { underlyingQuote: undefined },
    { underlyingQuote: { bid: 0, ask: 100, time: new Date(now - 1_000).toISOString(), quality: 'executable' } },
    { underlyingQuote: { bid: 99.99, ask: 100.01, time: new Date(now - 20_000).toISOString(), quality: 'executable' }, observedAt: new Date(now - 20_000).toISOString() },
    { underlyingQuote: { bid: 99.99, ask: 100.01, time: new Date(now - 1_000).toISOString(), quality: 'delayed' } },
  ]) {
    const result = buildOptionDayTradeCandidate(input('long', { signal: override }));
    assert.notEqual(result.status, 'candidate');
    assert.ok(result.reasons.includes('underlying_quote_missing_stale_or_mismatched') || result.reasons.includes('underlying_signal_stale_or_future'));
  }
});

test('missing, blocked, or stale catalyst review cannot qualify an options candidate', () => {
  for (const catalystReview of [undefined, { status: 'blocked', reviewedAt: new Date(now - 1_000).toISOString() }, { status: 'clear', reviewedAt: new Date(now - 31 * 60_000).toISOString() }]) {
    const result = buildOptionDayTradeCandidate(input('long', { signal: { catalystReview } }));
    assert.notEqual(result.status, 'candidate');
    assert.ok(result.reasons.includes('fresh_catalyst_clearance_required') || result.reasons.includes('underlying_catalyst_blackout'));
  }
});

test('call debit vertical requires fresh source-cited ex-dividend coverage through expiry', () => {
  const base = input('long');
  const cases = [
    [undefined, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, reviewedAt: new Date(now - 25 * 60 * 60_000).toISOString() }, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, source: 'https://user:secret@issuer.example/dividends' }, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, source: 'https://issuer.example/dividends?apiKey=secret' }, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, reviewedThrough: '2026-10-01' }, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, reviewedThrough: '2026-02-30' }, 'call_assignment_review_missing_stale_or_incomplete'],
    [{ ...base.signal.optionAssignmentReview, nextExDividendDate: '2026-10-01' }, 'short_call_ex_dividend_within_option_expiry'],
  ];
  for (const [optionAssignmentReview, reason] of cases) {
    const result = buildOptionDayTradeCandidate(input('long', { signal: { ...base.signal, optionAssignmentReview } }));
    assert.equal(result.status, 'no-setup');
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons}`);
  }
  const put = input('short', { signal: { ...input('short').signal, optionAssignmentReview: undefined } });
  assert.equal(buildOptionDayTradeCandidate(put).status, 'candidate', 'put debit verticals do not require call-dividend clearance');
});

test('optional Alpaca dividend screen is an additional fail-closed call gate and positive event veto', () => {
  const base = input('long', { config: { ...input('long').config, requireDividendProvider: true } });
  assert.ok(buildOptionDayTradeCandidate(base).reasons.includes('cash_dividend_screen_unavailable_or_incomplete'));
  const screened = { ...base, signal: { ...base.signal, corporateActionScreenStatus: 'pagination_complete' } };
  const cleared = buildOptionDayTradeCandidate(screened);
  assert.equal(cleared.status, 'candidate', `an empty screen does not replace the independent cited review (${cleared.reasons})`);
  const event = { ...screened, signal: { ...screened.signal, corporateActionDividendVeto: {
    provider: 'Alpaca', eventType: 'cash_dividend', exDate: '2026-10-01',
  } } };
  assert.ok(buildOptionDayTradeCandidate(event).reasons.includes('short_call_ex_dividend_within_option_expiry'));
  assert.equal(buildOptionDayTradeCandidate(input('short', { config: { ...input('short').config, requireDividendProvider: true } })).status, 'candidate',
    'put debit verticals are outside this short-call-specific veto');
});
