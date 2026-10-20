import test from 'node:test';
import { cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCryptoPaperQuotes } from '../../../crypto-bot/src/paperExecutionQuotes.js';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate } from '../primarySignal.js';
import { processPaperQuote, evaluatePaperCandidate } from '../paperRisk.js';

const now = Date.parse('2026-10-03T12:00:00Z');
const identity = { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase',
  pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() };
const evidence = (at = now, bid = 100, ask = 100.01) => ({ version: 1, kind: 'coinbase_l1_book', pair: 'BTC-USD',
  sequence: 12345, time: new Date(at).toISOString(), bid, ask, bidSize: 20, askSize: 30, auctionMode: false });
const quote = (at = now) => ({ bid: 100, ask: 100.01, time: new Date(at).toISOString(), quality: 'executable',
  cryptoIdentity: identity, cryptoInstrumentRules: cryptoRulesFixture({ ...identity, time: at }), cryptoQuoteEvidence: evidence(at) });
const input = { owner: 'crypto', assetClass: 'crypto', symbol: 'BTC', strategyId: 'book-test', signalId: 'one',
  sessionDate: '2026-10-03', now, sessionOpen: true, stopPct: 1, targetPct: 2,
  forceExitAt: new Date(now + 3600000).toISOString(), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 };

test('regression: last-trade timestamp alone cannot become an executable Coinbase book quote', () => {
  const result = buildCryptoPaperQuotes([{ id: 'bitcoin', symbol: 'BTC', marketData: { quotes: [{
    provider: 'Coinbase', pair: 'BTC-USD', base: 'BTC', target: 'USD', cryptoIdentity: identity,
    bid: 100, ask: 100.01, observedAt: new Date(now).toISOString(), timestampBasis: 'provider_event',
  }] } }], { now });
  assert.equal(result.quotesByKey.size, 0);
});

test('regression: primary candidate rejects Coinbase quotes without book evidence', () => {
  const { cryptoQuoteEvidence, ...ticker } = quote();
  assert.equal(buildPrimarySignalCandidate({ ...input, quote: ticker }).status, 'rejected');
});

test('regression: risk approval checks that the candidate matches its book evidence', () => {
  const candidate = buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate;
  const result = evaluatePaperCandidate({ ...candidate, cryptoQuoteEvidence: { ...evidence(), bid: 99 } },
    { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] }, { now, emergencyStop: false });
  assert.equal(result.status, 'blocked');
});

test('regression: later ticker data cannot fill a paper order approved from an order book', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-book-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  const reservation = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  assert.equal(reservation.status, 'reserved');
  const before = await readFile(statePath, 'utf8');
  const { cryptoQuoteEvidence, ...ticker } = quote(now + 1000);
  const result = await processPaperQuote(reservation.order.orderId, ticker, { statePath, now: now + 1000, emergencyStop: false });
  assert.equal(result.status, 'blocked');
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('book evidence survives reservation, fill and exit; full fills need enough displayed quantity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-book-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'risk.json');
  const config = { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false };
  const reservation = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  assert.deepEqual(reservation.order.cryptoQuoteEvidence, evidence());
  const execute = q => processPaperQuote(reservation.order.orderId, q, { statePath, now: Date.parse(q.time), emergencyStop: false });
  const thin = quote(now + 1000); thin.cryptoQuoteEvidence.askSize = 0.001;
  assert.equal((await execute(thin)).reason, 'insufficient_displayed_crypto_liquidity');
  assert.equal((await execute(quote(now + 2000))).status, 'filled');
  const exit = { ...quote(now + 3000), bid: 103, ask: 103.01,
    cryptoQuoteEvidence: { ...evidence(now + 3000, 103, 103.01), bidSize: 0.001 } };
  const before = await readFile(statePath, 'utf8');
  assert.equal((await execute(exit)).reason, 'insufficient_displayed_crypto_liquidity');
  assert.equal(await readFile(statePath, 'utf8'), before, 'no invented partial exit, P&L or mark');
  exit.cryptoQuoteEvidence.bidSize = 1000;
  const done = await execute(exit);
  assert.equal(done.status, 'closed');
  assert.deepEqual(done.order.lastCryptoQuoteEvidence, exit.cryptoQuoteEvidence);
  const ledger = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(ledger.events.filter(e => ['filled', 'closed'].includes(e.type)).every(e => e.cryptoQuoteEvidence?.kind === 'coinbase_l1_book'));
  assert.ok(Number.isFinite(done.order.realizedPnlUsd));
});

test('mismatched book price, time, pair, size and auction state are rejected at each candidate boundary', () => {
  for (const fields of [{ bid: 99 }, { time: new Date(now - 1000).toISOString() }, { pair: 'ETH-USD' },
    { bidSize: null }, { askSize: true }, { auctionMode: true }, { sequence: '12345' }]) {
    const bad = { ...quote(), cryptoQuoteEvidence: { ...evidence(), ...fields } };
    assert.equal(buildPrimarySignalCandidate({ ...input, quote: bad }).status, 'rejected');
    const candidate = buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate;
    assert.equal(evaluatePaperCandidate({ ...candidate, cryptoQuoteEvidence: bad.cryptoQuoteEvidence },
      { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] }, { now }).status, 'blocked');
  }
});
