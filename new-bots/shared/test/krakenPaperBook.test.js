import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import { normalizeCryptoQuoteEvidence } from '../cryptoQuoteEvidence.js';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate } from '../primarySignal.js';
import { evaluatePaperCandidate, processPaperQuote } from '../paperRisk.js';
import { buildCryptoPaperQuotes } from '../../../crypto-bot/src/paperExecutionQuotes.js';

const now = Date.parse('2026-10-03T15:00:00Z');
const identity = { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Kraken', pair: 'XBTUSD', base: 'BTC', quoteCurrency: 'USD',
  verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() };
const evidence = (at = now, bid = 100, ask = 100.01) => ({ version: 1, kind: 'kraken_l1_bbo', symbol: 'BTC/USD',
  time: new Date(at).toISOString(), bid, ask, bidSize: 10000, askSize: 10000,
  eventTrigger: 'bbo', systemStatus: 'online', subscriptionAcknowledged: true });
const quote = (at = now, bid = 100, ask = 100.01) => ({ bid, ask, time: new Date(at).toISOString(), quality: 'executable',
  cryptoIdentity: identity, cryptoInstrumentRules: cryptoRulesFixture({ ...identity, time: at }), cryptoQuoteEvidence: evidence(at, bid, ask) });
const input = { owner: 'crypto', assetClass: 'crypto', symbol: 'BTC', strategyId: 'kraken-book-test', signalId: 'one',
  sessionDate: '2026-10-03', now, sessionOpen: true, stopPct: 1, targetPct: 2,
  forceExitAt: new Date(now + 3600000).toISOString(), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-kraken-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'ledger.json');
  return { statePath, config: { sharedPaperAccountEquity: 10000, sharedPaperStatePath: statePath, sharedPaperEmergencyStop: false } };
}

test('Kraken event prices without BBO evidence cannot become an executable source or candidate', () => {
  const { cryptoQuoteEvidence, ...ticker } = quote();
  const source = { ...ticker, provider: 'Kraken', pair: 'XBTUSD', base: 'BTC', target: 'USD', observedAt: ticker.time, timestampBasis: 'provider_event' };
  assert.equal(buildCryptoPaperQuotes([{ id: 'bitcoin', symbol: 'BTC', marketData: { quotes: [source] } }], { now }).quotesByKey.size, 0);
  assert.equal(buildPrimarySignalCandidate({ ...input, quote: ticker }).status, 'rejected');
});

test('Kraken evidence binds symbol, prices, time, native sizes and subscription status at approval', () => {
  assert.deepEqual(normalizeCryptoQuoteEvidence(evidence()), evidence());
  const good = buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate;
  for (const patch of [{ symbol: 'ETH/USD' }, { time: new Date(now - 1).toISOString() }, { bid: 99 }, { askSize: 0 }, { bidSize: true },
    { eventTrigger: 'trades' }, { systemStatus: 'post_only' }, { subscriptionAcknowledged: false }, { kind: 'coinbase_l1_book' }]) {
    const changed = { ...evidence(), ...patch };
    assert.equal(buildPrimarySignalCandidate({ ...input, quote: { ...quote(), cryptoQuoteEvidence: changed } }).status, 'rejected');
    assert.equal(evaluatePaperCandidate({ ...good, cryptoQuoteEvidence: changed }, { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] },
      { now, emergencyStop: false }).status, 'blocked');
  }
});

test('later Kraken prices without evidence cannot fill an approved reservation', async t => {
  const { config, statePath } = await setup(t);
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  assert.equal(reserved.status, 'reserved');
  const before = await readFile(statePath, 'utf8'), { cryptoQuoteEvidence, ...ticker } = quote(now + 1000);
  assert.equal((await processPaperQuote(reserved.order.orderId, ticker, { statePath, now: now + 1000, emergencyStop: false })).status, 'blocked');
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('Kraken displayed liquidity is enforced by the locked executor and retained in after-cost outcomes', async t => {
  const { config, statePath } = await setup(t);
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  assert.deepEqual(reserved.order.cryptoQuoteEvidence, evidence());
  const execute = q => processPaperQuote(reserved.order.orderId, q, { statePath, now: Date.parse(q.time), emergencyStop: false });
  const thin = quote(now + 1000); thin.cryptoQuoteEvidence.askSize = 0.00000001;
  assert.equal((await execute(thin)).reason, 'insufficient_displayed_crypto_liquidity');
  assert.equal((await execute(quote(now + 2000))).status, 'filled');
  const mark = quote(now + 3000, 100.5, 100.51); mark.cryptoQuoteEvidence.bidSize = 0.00000001;
  const before = await readFile(statePath, 'utf8');
  assert.equal((await execute(mark)).reason, 'insufficient_displayed_crypto_liquidity');
  assert.equal(await readFile(statePath, 'utf8'), before, 'no executable P&L mark larger than observed liquidation size');
  const exit = quote(now + 4000, 103, 103.01); exit.cryptoQuoteEvidence.bidSize = 0.00000001;
  assert.equal((await execute(exit)).reason, 'insufficient_displayed_crypto_liquidity');
  exit.cryptoQuoteEvidence.bidSize = 10000;
  const done = await execute(exit);
  assert.equal(done.status, 'closed'); assert.ok(done.order.realizedPnlUsd < done.order.grossPnlUsd);
  assert.deepEqual(done.order.lastCryptoQuoteEvidence, exit.cryptoQuoteEvidence);
  const ledger = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(ledger.events.filter(e => ['filled', 'closed'].includes(e.type)).every(e => e.cryptoQuoteEvidence?.kind === 'kraken_l1_bbo'));
});

test('short Kraken lifecycle uses bid size at entry and ask size for later liquidation', async t => {
  const { config, statePath } = await setup(t);
  const candidate = { ...buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate,
    direction: 'short', entryPrice: 100, stopPrice: 101, targetPrice: 98 };
  const reserved = await reserveSharedPaperCandidate(candidate, config, now); assert.equal(reserved.status, 'reserved');
  const execute = q => processPaperQuote(reserved.order.orderId, q, { statePath, now: Date.parse(q.time), emergencyStop: false });
  const thinEntry = quote(now + 1000); thinEntry.cryptoQuoteEvidence.bidSize = 0.00000001;
  assert.equal((await execute(thinEntry)).reason, 'insufficient_displayed_crypto_liquidity');
  assert.equal((await execute(quote(now + 2000))).status, 'filled');
  const thinExit = quote(now + 3000, 97.9, 97.91); thinExit.cryptoQuoteEvidence.askSize = 0.00000001;
  assert.equal((await execute(thinExit)).reason, 'insufficient_displayed_crypto_liquidity');
  thinExit.cryptoQuoteEvidence.askSize = 10000;
  assert.equal((await execute(thinExit)).status, 'closed');
});

test('older open Kraken orders can exit on new valid evidence without inventing historical entry evidence', async t => {
  const { config, statePath } = await setup(t);
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  await processPaperQuote(reserved.order.orderId, quote(now + 1000), { statePath, now: now + 1000, emergencyStop: false });
  const ledger = JSON.parse(await readFile(statePath, 'utf8'));
  delete ledger.orders[0].cryptoQuoteEvidence; delete ledger.orders[0].lastCryptoQuoteEvidence;
  ledger.orders[0].paperExecutionVersion = 'fixture-prior-execution';
  await writeFile(statePath, JSON.stringify(ledger));
  const closed = await processPaperQuote(reserved.order.orderId, quote(now + 2000, 103, 103.01), { statePath, now: now + 2000, emergencyStop: false });
  assert.equal(closed.status, 'closed'); assert.equal(closed.order.cryptoQuoteEvidence, undefined);
  assert.equal(closed.order.paperExecutionVersion, 'fixture-prior-execution');
  assert.equal(closed.order.lastCryptoQuoteEvidence.kind, 'kraken_l1_bbo');
});
