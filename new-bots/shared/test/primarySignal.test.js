import { stockQuote } from '../fixtures/stockQuoteEvidence.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrimarySignalCandidate, getSharedPaperDiagnostics, markSharedPaperOrders, reconcileSharedPaperOrders, reserveSharedPaperCandidate } from '../primarySignal.js';
import { processPaperQuote, readPaperRiskLedger } from '../paperRisk.js';

const input = {
  owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', exposureKey: 'AAPL',
  strategyId: 'stock-intraday-v1', signalId: 'sig-1', sessionDate: '2026-09-29',
  quote: stockQuote('AAPL', { bid: 250, ask: 250.02, time: '2026-09-29T15:00:00Z', quality: 'executable' }), now: Date.parse('2026-09-29T15:00:01Z'),
  entryLow: 249.9, entryHigh: 251, stopPct: 1, targetPct: 2,
  forceExitAt: '2026-09-29T20:00:00Z', entryExpiresAt: '2026-09-29T15:30:00Z', maxQuoteAgeMs: 15_000,
  sessionOpen: true, roundTripFeesPerUnit: 0, slippageReservePerUnit: 0.02,
};

test('builds deterministic long paper candidate from the executable ask and distinct signal levels', () => {
  const result = buildPrimarySignalCandidate(input);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.entryPrice, input.quote.ask);
  assert.ok(result.candidate.stopPrice < input.quote.bid);
  assert.ok(result.candidate.targetPrice > input.quote.ask);
  assert.equal(result.candidate.idempotencyKey, 'AAPL:2026-09-29:stock-intraday-v1:sig-1');
  assert.equal(buildPrimarySignalCandidate(input).candidate.idempotencyKey, result.candidate.idempotencyKey);
  const traced = buildPrimarySignalCandidate({ ...input, marketGateTrace: { source: 'market_candidate_emission',
    owner: 'stocks', strategyId: input.strategyId, observedAt: input.quote.time,
    passedGates: ['confirmed_candidate'] } });
  assert.deepEqual(traced.candidate.marketGateTrace.passedGates, ['confirmed_candidate']);
});

test('shared stock candidate cannot silently substitute zero fees when the fee reserve is missing', () => {
  const { roundTripFeesPerUnit: _fee, ...withoutFee } = input;
  const result = buildPrimarySignalCandidate(withoutFee);
  assert.equal(result.status, 'rejected');
  assert.ok(result.reasons.includes('execution_cost_reserve_missing'));
});

test('primary signal cost validation rejects null and blank coercions for fees and slippage', () => {
  for (const field of ['roundTripFeesPerUnit', 'slippageReservePerUnit']) {
    for (const value of [null, '', '   ', true, NaN, Infinity, -0.01]) {
      const result = buildPrimarySignalCandidate({ ...input, [field]: value });
      assert.equal(result.status, 'rejected', `${field}=${String(value)} must not become a zero-cost assumption`);
      assert.ok(result.reasons.includes('execution_cost_reserve_missing'));
    }
  }
  assert.equal(buildPrimarySignalCandidate({ ...input, roundTripFeesPerUnit: '0', slippageReservePerUnit: '0.02' }).status, 'candidate');
});

test('reference prices, stale quotes, expired plans, wrong sessions and chasing cannot become candidates', () => {
  for (const invalid of [
    { quote: { ...input.quote, quality: 'reference' } },
    { quote: { ...input.quote, time: '2026-09-29T14:00:00Z' } },
    { entryHigh: 249 },
    { entryExpiresAt: '2026-09-29T14:59:00Z' },
    { sessionOpen: false },
  ]) {
    const result = buildPrimarySignalCandidate({ ...input, ...invalid });
    assert.equal(result.status, 'rejected');
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  }
});

test('crypto owner and spot asset map to same normalized shared-risk schema', () => {
  const result = buildPrimarySignalCandidate({ ...input, owner: 'crypto', assetClass: 'crypto', symbol: 'btc-usd', exposureKey: 'BTC', strategyId: 'crypto-scalp-v1', signalId: 'crypto-9',
    quote: { ...input.quote, cryptoInstrumentRules: cryptoRulesFixture(input.quote), cryptoQuoteEvidence: coinbaseBookEvidence(input.quote), cryptoIdentity: { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase',
      pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: input.quote.time } } });
  assert.equal(result.candidate.owner, 'crypto');
  assert.equal(result.candidate.instrumentKey, 'BTC-USD');
  assert.equal(result.candidate.exposureKey, 'BTC');
  assert.ok(result.candidate.idempotencyKey.endsWith(':2026-09-29:crypto-scalp-v1:crypto-9'));
  assert.ok(result.candidate.idempotencyKey.includes('bitcoin'));
  assert.ok(result.candidate.idempotencyKey.includes('Coinbase'));
});

test('shared reservation and mark adapter preserve paper-only quote lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-primary-'));
  const statePath = join(dir, 'risk.json');
  const now = Date.parse(input.quote.time) + 1000;
  const config = { sharedPaperAccountEquity: 10_000, sharedPaperStatePath: statePath,
    sharedPaperEmergencyStop: false, sharedPaperMaxQuoteAgeMs: 15_000, sharedPaperMaxSpreadPct: 0.5 };
  try {
    const built = buildPrimarySignalCandidate({ ...input, now });
    const reservation = await reserveSharedPaperCandidate(built.candidate, config, now);
    assert.equal(reservation.status, 'reserved');
    const expiredCandidate = buildPrimarySignalCandidate({ ...input, symbol: 'MSFT', exposureKey: 'MSFT', signalId: 'expired', quote: stockQuote('MSFT', input.quote),
      entryExpiresAt: new Date(now + 500).toISOString(), now });
    const expiredReservation = await reserveSharedPaperCandidate(expiredCandidate.candidate, config, now);
    assert.equal(expiredReservation.status, 'reserved');
    const filled = await markSharedPaperOrders({ owner: 'stocks', config, now: now + 1_000,
      quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 250, ask: 250.02, time: new Date(now + 1_000).toISOString(), quality: 'executable' })]]) });
    assert.equal(filled.processed, 1);
    assert.equal(filled.quotesProvided, 1);
    assert.equal(filled.quoteMissing, 0);
    assert.equal(filled.quoteRejected, 0);
    assert.equal(filled.freshPositions, 1);
    assert.equal(filled.staleOrUnmarkedPositions, 0);
    assert.equal(filled.recovery.cancelledReservations, 1);
    const ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders[0].status, 'filled');
    assert.equal(ledger.orders[0].paperOnly, true);
    assert.equal(ledger.orders.find((row) => row.orderId === expiredReservation.order.orderId).cancelReason, 'entry_window_expired');
    const diagnostics = await getSharedPaperDiagnostics(config, { sessionDate: '2026-09-29', now: now + 1_000 });
    assert.equal(diagnostics.status, 'available', diagnostics.error);
    assert.equal(diagnostics.activeOrders, 1);
    assert.equal(diagnostics.byBot.stocks.filled, 1);
    assert.equal(diagnostics.riskDayUtc, '2026-09-29');
    assert.equal(diagnostics.realizedPnlRiskDayUtcUsd, 0);
    assert.equal(diagnostics.staleOrUnmarked, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stocks paper reservations remain disabled until an explicit fee assumption is configured', async () => {
  const result = await reserveSharedPaperCandidate(input, { sharedPaperAccountEquity: 10_000, sharedPaperStatePath: 'unused.json', sharedPaperCostAssumptionsConfigured: false }, input.now);
  assert.equal(result.status, 'not-configured');
});

test('missing stock fee assumption blocks new reservations but leaves shared-ledger diagnostics readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-paper-missing-stock-fee-'));
  try {
    const statePath = join(dir, 'ledger.json');
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, orders: [{ owner: 'crypto', assetClass: 'crypto', instrumentKey: 'BTC',
      status: 'open', riskUsd: 25, notionalUsd: 1_000, unrealizedPnlUsd: 3, accountEquityUsd: 10_000, markedAt: new Date(input.now).toISOString() }], events: [] }));
    const diagnostics = await getSharedPaperDiagnostics({ sharedPaperAccountEquity: 10_000,
      sharedPaperStatePath: statePath, sharedPaperCostAssumptionsConfigured: false }, { now: input.now });
    assert.equal(diagnostics.status, 'available');
    assert.equal(diagnostics.newReservationReadiness, 'blocked_missing_stock_fee_assumption');
    assert.equal(diagnostics.activeOrders, 1, 'an existing shared position remains visible while new reservations are blocked');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('shared position-mark diagnostics distinguish missing and rejected quotes from fresh marks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-primary-mark-diagnostics-'));
  const statePath = join(dir, 'risk.json');
  const now = Date.parse(input.quote.time) + 1_000;
  const config = { sharedPaperAccountEquity: 10_000, sharedPaperStatePath: statePath,
    sharedPaperEmergencyStop: false, sharedPaperMaxQuoteAgeMs: 15_000, sharedPaperMaxOpenMarkAgeMs: 300_000 };
  try {
    const built = buildPrimarySignalCandidate({ ...input, now });
    const reservation = await reserveSharedPaperCandidate(built.candidate, config, now);
    assert.equal(reservation.status, 'reserved');
    await markSharedPaperOrders({ owner: 'stocks', config, now: now + 1_000,
      quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 250, ask: 250.02, time: new Date(now + 1_000).toISOString(), quality: 'executable' })]]) });

    const missing = await markSharedPaperOrders({ owner: 'stocks', config, now: now + 6 * 60_000, quotesBySymbol: new Map() });
    assert.equal(missing.expectedPositions, 1);
    assert.equal(missing.quoteMissing, 1);
    assert.equal(missing.staleOrUnmarkedPositions, 1);
    assert.equal(missing.freshPositions, 0);

    const rejected = await markSharedPaperOrders({ owner: 'stocks', config, now: now + 7 * 60_000,
      quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 250, ask: 250.02, time: new Date(now + 1_000).toISOString(), quality: 'executable' })]]) });
    assert.equal(rejected.quotesProvided, 1);
    assert.equal(rejected.quoteRejected, 1);
    assert.equal(rejected.rejectionReasons.quote_not_current_and_executable, 1);
    assert.equal(rejected.staleOrUnmarkedPositions, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reconciles primary tracker paper fields from reserved through fill and close without overwriting strategy outcomes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-primary-reconcile-'));
  const statePath = join(dir, 'risk.json');
  const now = Date.parse(input.quote.time) + 1_000;
  const config = { sharedPaperAccountEquity: 10_000, sharedPaperStatePath: statePath,
    sharedPaperEmergencyStop: false, sharedPaperMaxQuoteAgeMs: 15_000, sharedPaperMaxSpreadPct: 0.5 };
  const prediction = { id: 'sig-1', symbol: 'AAPL', status: 'tracking', sharedPaperOrderId: null };
  try {
    const built = buildPrimarySignalCandidate({ ...input, now });
    const reservation = await reserveSharedPaperCandidate(built.candidate, config, now);
    assert.equal(reservation.status, 'reserved');
    prediction.sharedPaperOrderId = reservation.order.orderId;
    const observerConfig = { ...config };
    delete observerConfig.sharedPaperAccountEquity;
    const reserved = await reconcileSharedPaperOrders({ owner: 'stocks', predictions: [prediction], config: observerConfig, now });
    assert.equal(reserved.linked, 1);
    assert.equal(reserved.predictions[0].sharedPaperStatus, 'reserved');
    assert.equal(reserved.predictions[0].sharedPaperFillPrice, null, 'missing fill prices remain unknown');
    assert.equal(reserved.activeDivergence, 0);

    const fillTime = now + 1_000;
    await markSharedPaperOrders({ owner: 'stocks', config: observerConfig, now: fillTime, sessionOpen: true,
      quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 250, ask: 250.02, time: new Date(fillTime).toISOString(), quality: 'executable' })]]) });
    const filled = await reconcileSharedPaperOrders({ owner: 'stocks', predictions: [prediction], config: observerConfig, now: fillTime });
    assert.equal(filled.predictions[0].sharedPaperStatus, 'filled');
    assert.equal(filled.predictions[0].sharedPaperFillPrice, 250.02);
    assert.equal(filled.predictions[0].status, 'tracking', 'ledger state does not rewrite the primary strategy tracker result');

    const closeTime = fillTime + 1_000;
    await processPaperQuote(reservation.order.orderId, stockQuote('AAPL', { bid: 260, ask: 260.02, time: new Date(closeTime).toISOString(), quality: 'executable' }), {
      statePath, now: closeTime, maxQuoteAgeMs: 15_000, maxSpreadPct: 0.5, sessionOpen: true, emergencyStop: false,
    });
    const closed = await reconcileSharedPaperOrders({ owner: 'stocks', predictions: [prediction], config: observerConfig, now: closeTime });
    assert.equal(closed.predictions[0].sharedPaperStatus, 'closed');
    assert.equal(closed.predictions[0].sharedPaperExitReason, 'target');
    assert.ok(Number.isFinite(closed.predictions[0].sharedPaperRealizedPnlUsd));
    assert.equal(closed.activeDivergence, 1, 'a still-active local strategy row is reported when its independent paper order is closed');

    const wrongOwner = await reconcileSharedPaperOrders({ owner: 'crypto', predictions: [prediction], config: observerConfig, now: closeTime });
    assert.equal(wrongOwner.ownerMismatch, 1);
    assert.equal(wrongOwner.predictions[0].sharedPaperStatus, 'ledger_owner_mismatch');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
