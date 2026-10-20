import { fixture as optionFixture, fillQuote, NOW } from '../../options/test/helpers/optionFillFixture.js';
import { buildOptionDayTradeCandidate } from '../../options/src/strategies.js';
import { stockQuoteEvidence } from '../fixtures/stockQuoteEvidence.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger } from '../paperRisk.js';

const owners = [
  { owner: 'stocks', assetClass: 'stock', instrumentKey: 'NVDA', exposureKey: 'NVDA' },
  { owner: 'crypto', assetClass: 'crypto', instrumentKey: 'SOL', exposureKey: 'SOL' },
  { owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', exposureKey: 'EUR_USD' },
  { owner: 'futures', assetClass: 'future', instrumentKey: 'CME_ZCZ6', exposureKey: 'CORN',
    future: { contractId: 'CME:ZC:202612', providerRawSymbol: 'ZCZ6' }, initialMarginUsd: 25, maintenanceMarginUsd: 20 },
  { owner: 'options', assetClass: 'option', instrumentKey: 'SPY261006C00100000+SPY261006C00103000', exposureKey: 'SPY' },
  { owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'QQQ', exposureKey: 'QQQ' },
];
const equity = 1_000_000;
const base = NOW;
const cryptoIdentityAt = time => ({ version: 1, namespace: 'coingecko', assetId: 'solana', provider: 'Coinbase',
  pair: 'SOL-USD', base: 'SOL', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(time).toISOString() });
const policy = (now) => ({ now, maxQuoteAgeMs: 15_000, maxOpenMarkAgeMs: 300_000,
  maxOpenPositions: 8, maxTradeRiskPct: 0.02, maxTotalOpenRiskPct: 10,
  maxGrossExposurePct: 1_000, maxInitialMarginPct: 100, maxDailyLossPct: 5,
  maxSpreadPct: 0.1, minRewardRisk: 1.1 });
const candidateFor = (instrument, now) => instrument.owner === 'options' ? buildOptionDayTradeCandidate(optionFixture()).candidate : ({ ...instrument,
  ...(['stocks', 'etfs-etps'].includes(instrument.owner) ? { stockQuoteEvidence: stockQuoteEvidence(instrument.instrumentKey, { bid: 99.99, ask: 100, time: new Date(now - 1000).toISOString() }) } : {}),
  ...(instrument.owner === 'crypto' ? { cryptoIdentity: cryptoIdentityAt(now), cryptoInstrumentRules: cryptoRulesFixture({ provider: 'Coinbase', pair: 'SOL-USD', base: 'SOL', time: now }), cryptoQuoteEvidence: coinbaseBookEvidence({ pair: 'SOL-USD', bid: 99.99, ask: 100, time: now - 1000 }) } : {}),
  mode: 'paper', idempotencyKey: `${instrument.owner}:${instrument.instrumentKey}:day-one`,
  strategyId: `integration-${instrument.owner}`, sessionDate: '2026-10-02', sessionTimeZone: 'UTC', direction: 'long',
  bid: 99.99, ask: 100, entryPrice: 100, stopPrice: 99.5, targetPrice: 101,
  quoteTime: new Date(now - 1_000).toISOString(), quoteQuality: 'executable', sessionOpen: true,
  forceExitAt: new Date(base + 72 * 60 * 60_000).toISOString(), multiplier: 1, lotSize: instrument.owner === 'crypto' ? 0.00000001 : 1,
  roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01 });
const quoteAt = (time, bid = 99.99, ask = 100) => ({ stockQuoteEvidence: stockQuoteEvidence('NVDA', { bid, ask, time: new Date(time).toISOString() }), time: new Date(time).toISOString(), bid, ask, quality: 'executable', cryptoIdentity: cryptoIdentityAt(time), cryptoInstrumentRules: cryptoRulesFixture({ provider: 'Coinbase', pair: 'SOL-USD', base: 'SOL', time }), cryptoQuoteEvidence: coinbaseBookEvidence({ pair: 'SOL-USD', bid, ask, time }) });

test('six market owners coordinate concurrent paper reservations and multi-day recovery in one ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-six-market-lifecycle-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const proposals = owners.map((instrument) => candidateFor(instrument, base));
    const decisions = proposals.map((proposal) => evaluatePaperCandidate(proposal,
      { accountEquity: equity, realizedPnlToday: 0, openPositions: [] }, { ...policy(base), ...(proposal.owner === 'options' ? { maxSpreadPct: 25 } : {}) }));
    assert.ok(decisions.every((decision) => decision.status === 'paper-approved'));
    const reservations = await Promise.all(proposals.map((proposal, index) => reservePaperCandidate(proposal, decisions[index], {
      statePath, now: base, emergencyStop: false,
    })));
    assert.equal(reservations.filter((row) => row.status === 'reserved').length, owners.length,
      JSON.stringify(reservations.map((row, index) => ({ owner: proposals[index].owner, status: row.status, reason: row.reason }))));
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, owners.length);

    const fillAt = base + 10_000;
    const fills = await Promise.all(reservations.slice(0, 5).map((row) => processPaperQuote(row.order.orderId,
      row.order.owner === 'options' ? fillQuote(optionFixture(), fillAt) : quoteAt(fillAt),
      { statePath, now: fillAt, maxQuoteAgeMs: 15_000, maxSpreadPct: row.order.owner === 'options' ? 25 : 0.1, emergencyStop: false })));
    assert.ok(fills.every((row) => row.status === 'filled'), JSON.stringify(fills.map(row => ({status:row.status,reason:row.reason}))));

    // Model a full session with no accepted provider quote: recovery must not invent a mark or exit.
    const nextSession = base + 24 * 60 * 60_000 + 60_000;
    const outageRecovery = await recoverPaperOrders({ statePath, now: nextSession, emergencyStop: false });
    assert.equal(outageRecovery.awaitingFreshQuote, 5);
    assert.equal(outageRecovery.stillValidReservations, 1);
    let ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders.filter((row) => row.status === 'filled').length, 5);
    assert.equal(ledger.orders.filter((row) => row.status === 'reserved').length, 1);
    assert.ok(ledger.orders.every((row) => row.exitPrice === undefined && row.exitReason === undefined));

    // Kill switch cancels the unfilled order, but preserves filled positions until a fresh quote arrives.
    const killRecovery = await recoverPaperOrders({ statePath, now: nextSession + 1_000, emergencyStop: true });
    assert.equal(killRecovery.cancelledReservations, 1);
    assert.equal(killRecovery.awaitingFreshQuote, 5);
    ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders.filter((row) => row.status === 'cancelled' && row.cancelReason === 'emergency_stop_active').length, 1);
    assert.equal(ledger.orders.filter((row) => row.status === 'filled').length, 5);

    // The first later executable marks close each remaining position at a real supplied quote time.
    const emergencyQuoteAt = nextSession + 60_000;
    const exits = await Promise.all(ledger.orders.filter((row) => row.status === 'filled').map((row) => processPaperQuote(
      row.orderId, row.owner === 'options' ? { bid: 0.9, ask: 1, time: new Date(emergencyQuoteAt).toISOString(), quality: 'executable' } : quoteAt(emergencyQuoteAt, 99.8, 99.81), { statePath, now: emergencyQuoteAt,
        maxQuoteAgeMs: 15_000, maxSpreadPct: 0.1, emergencyStop: true })));
    assert.ok(exits.every((row) => row.status === 'closed' && row.order.exitReason === 'emergency_stop'));
    ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders.filter((row) => row.status === 'closed').length, 5);
    assert.equal(ledger.orders.filter((row) => row.status === 'cancelled').length, 1);
    assert.equal(new Set(ledger.orders.map((row) => row.owner)).size, owners.length);
    const summary = summarizePaperLedger(ledger, { now: emergencyQuoteAt });
    assert.equal(summary.closedCount, 5);
    assert.equal(summary.exits.emergency, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
