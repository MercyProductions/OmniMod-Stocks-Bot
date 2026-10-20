import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate } from '../primarySignal.js';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, reservePaperCandidate } from '../paperRisk.js';
import { parseAlpacaStockQuote, normalizeStockQuoteEvidence } from '../stockQuoteEvidence.js';
const now = Date.parse('2026-10-02T15:00:00Z');
const proof = (at = now, bid = 100, ask = 100.01) => ({ version: 1, kind: 'alpaca_stock_l1', symbol: 'AAPL', provider: 'Alpaca',
  feed: 'sip', coverage: 'consolidated', currency: 'USD', source: 'latest', time: new Date(at).toISOString(), rawTimestamp: new Date(at).toISOString(),
  bid, ask, reportedBidSize: 1000, reportedAskSize: 1000, bidSizeShares: 1000, askSizeShares: 1000,
  sizeBasis: 'sip_shares_since_2025_11_03', bidExchange: 'Q', askExchange: 'Q', tape: 'C', conditions: ['R'] });
const quote = (at = now, bid = 100, ask = 100.01) => ({ bid, ask, time: new Date(at).toISOString(), quality: 'executable', stockQuoteEvidence: proof(at, bid, ask) });
const input = { owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', strategyId: 'stock-book-test', signalId: 'one', sessionDate: '2026-10-02',
  now, sessionOpen: true, stopPct: 1, targetPct: 2, forceExitAt: new Date(now + 3600000).toISOString(), roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.01 };
const native = extra => ({ S: 'AAPL', bp: 100, ap: 100.01, bs: 125, as: 250, bx: 'Q', ax: 'Q', z: 'C',
  c: ['R'], t: '2026-10-02T15:00:00.123456789Z', ...extra });

test('native SIP size is preserved in shares, with nanosecond timestamp provenance', () => {
  for (const source of ['latest', 'snapshot', 'stream']) {
    const q = parseAlpacaStockQuote(native(), { symbol: 'AAPL', feed: 'sip', source, now: now + 1000 });
    assert.equal(q.stockQuoteEvidence.askSizeShares, 250);
    assert.equal(q.stockQuoteEvidence.source, source);
    assert.equal(q.time, '2026-10-02T15:00:00.123Z');
    assert.equal(q.stockQuoteEvidence.rawTimestamp, native().t);
  }
});

test('IEX evidence is explicitly single venue with conservative size and actual exchange IDs', () => {
  const q = parseAlpacaStockQuote(native({ bx: 'V', ax: 'V' }), { symbol: 'AAPL', feed: 'iex', now: now + 1000 });
  assert.equal(q.coverage, 'single_venue');
  assert.equal(q.stockQuoteEvidence.bidSizeShares, 125);
  assert.equal(q.stockQuoteEvidence.sizeBasis, 'iex_reported_size_conservative_shares');
  assert.throws(() => parseAlpacaStockQuote(native(), { symbol: 'AAPL', feed: 'iex', now: now + 1000 }), { code: 'stock_quote_evidence_required' });
});

test('native parser refuses malformed, stale, nonregular and ambiguous quote evidence', () => {
  const opts = { symbol: 'AAPL', feed: 'sip', now: now + 1000 };
  for (const change of [{ bs: 0 }, { as: '250' }, { bs: 1.5 }, { as: true }, { as: NaN }, { ap: null }, { bp: '100' },
    { ap: 99 }, { c: [] }, { c: ['N'] }, { c: ['R', 'H'] }, { z: 'D' }, { bx: '' }, { t: '' },
    { S: 'MSFT' }, { t: new Date(now - 60000).toISOString() }, { t: new Date(now + 9000).toISOString() }]) {
    assert.throws(() => parseAlpacaStockQuote(native(change), opts), JSON.stringify(change));
  }
  for (const feed of ['delayed_sip', 'overnight', 'unknown']) assert.throws(() => parseAlpacaStockQuote(native(), { ...opts, feed }));
  assert.throws(() => parseAlpacaStockQuote(native({ t: '2025-10-01T15:00:00Z' }), { ...opts, now: Date.parse('2025-10-01T15:00:01Z') }));
  assert.equal(normalizeStockQuoteEvidence({ ...proof(), currency: 'EUR' }), null);
  assert.equal(normalizeStockQuoteEvidence({ ...proof(), sizeBasis: 'round_lots_100' }), null);
});

test('direct shared risk calls cannot bypass stock evidence validation', () => {
  const candidate = buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate;
  const { stockQuoteEvidence, ...unproven } = candidate;
  const portfolio = { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] };
  assert.equal(evaluatePaperCandidate(candidate, portfolio, { now }).status, 'paper-approved');
  assert.ok(evaluatePaperCandidate(unproven, portfolio, { now }).reasons.includes('stock_quote_evidence_required'));
});

test('stock candidate cannot approve unproven price-only executable labels', () => {
  const { stockQuoteEvidence, ...unproven } = quote();
  assert.equal(buildPrimarySignalCandidate({ ...input, quote: unproven }).status, 'rejected');
});

test('stock quote evidence cannot claim a different symbol or delayed feed', () => {
  for (const change of [{ symbol: 'NVDA' }, { feed: 'delayed_sip' }, { bid: 99 }, { conditions: ['N'] }, { bidSizeShares: 100000 }]) {
    assert.equal(buildPrimarySignalCandidate({ ...input, quote: { ...quote(), stockQuoteEvidence: { ...proof(), ...change } } }).status, 'rejected');
  }
});

test('stock reservation retains source evidence and later execution cannot exceed displayed size', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-evidence-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'paper.json'), config = { sharedPaperStatePath: statePath, sharedPaperAccountEquity: 10000, sharedPaperEmergencyStop: false };
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  assert.equal(reserved.status, 'reserved'); assert.deepEqual(reserved.order.stockQuoteEvidence, proof());
  const execute = q => processPaperQuote(reserved.order.orderId, q, { statePath, now: Date.parse(q.time), emergencyStop: false });
  const switched = quote(now + 1000); Object.assign(switched.stockQuoteEvidence, { feed: 'iex', coverage: 'single_venue',
    sizeBasis: 'iex_reported_size_conservative_shares', bidExchange: 'V', askExchange: 'V' });
  assert.equal((await execute(switched)).reason, 'stock_quote_feed_mismatch');
  const thin = quote(now + 1000); thin.stockQuoteEvidence.reportedAskSize = thin.stockQuoteEvidence.askSizeShares = 1;
  const before = await readFile(statePath, 'utf8');
  assert.equal((await execute(thin)).reason, 'insufficient_displayed_stock_liquidity'); assert.equal(await readFile(statePath, 'utf8'), before);
  assert.equal((await execute(quote(now + 2000))).status, 'filled');
  const exit = quote(now + 3000, 103, 103.01); exit.stockQuoteEvidence.reportedBidSize = exit.stockQuoteEvidence.bidSizeShares = 1;
  assert.equal((await execute(exit)).reason, 'insufficient_displayed_stock_liquidity');
  exit.stockQuoteEvidence.reportedBidSize = exit.stockQuoteEvidence.bidSizeShares = 1000;
  const done = await execute(exit); assert.equal(done.status, 'closed'); assert.ok(done.order.realizedPnlUsd < done.order.grossPnlUsd);
  assert.deepEqual(done.order.lastStockQuoteEvidence, exit.stockQuoteEvidence);
  const ledger = await readPaperRiskLedger({ statePath });
  assert.ok(ledger.events.filter(e => ['filled', 'closed'].includes(e.type)).every(e => e.stockQuoteEvidence));
});

test('older filled stock orders can exit with fresh proof without rewriting historical evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'paper.json'), config = { sharedPaperStatePath: statePath, sharedPaperAccountEquity: 10000, sharedPaperEmergencyStop: false };
  const reserved = await reserveSharedPaperCandidate(buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate, config, now);
  await processPaperQuote(reserved.order.orderId, quote(now + 1000), { statePath, now: now + 1000, emergencyStop: false });
  const ledger = await readPaperRiskLedger({ statePath });
  delete ledger.orders[0].stockQuoteEvidence; delete ledger.orders[0].lastStockQuoteEvidence;
  ledger.events = ledger.events.map(({ stockQuoteEvidence, ...event }) => event);
  await writeFile(statePath, JSON.stringify(ledger));
  const done = await processPaperQuote(reserved.order.orderId, quote(now + 2000, 103, 103.01), { statePath, now: now + 2000, emergencyStop: true });
  assert.equal(done.status, 'closed'); assert.equal(done.order.stockQuoteEvidence, undefined);
  const after = await readPaperRiskLedger({ statePath });
  assert.deepEqual(after.events.slice(0, ledger.events.length), ledger.events);
  assert.ok(after.events.at(-1).stockQuoteEvidence);
});

test('short stock paper execution uses bid size for entry and ask size for exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-short-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'paper.json');
  const candidate = { ...buildPrimarySignalCandidate({ ...input, quote: quote() }).candidate,
    direction: 'short', entryPrice: 100, stopPrice: 101.1, targetPrice: 98 };
  const decision = evaluatePaperCandidate(candidate, { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] }, { now });
  assert.equal(decision.status, 'paper-approved');
  const reserved = await reservePaperCandidate(candidate, decision, { statePath, now, emergencyStop: false });
  const execute = q => processPaperQuote(reserved.order.orderId, q, { statePath, now: Date.parse(q.time), emergencyStop: false });
  const entry = quote(now + 1000); entry.stockQuoteEvidence.bidSizeShares = entry.stockQuoteEvidence.reportedBidSize = 1;
  assert.equal((await execute(entry)).reason, 'insufficient_displayed_stock_liquidity');
  assert.equal((await execute(quote(now + 2000))).status, 'filled');
  const exit = quote(now + 3000, 97.9, 97.91); exit.stockQuoteEvidence.askSizeShares = exit.stockQuoteEvidence.reportedAskSize = 1;
  assert.equal((await execute(exit)).reason, 'insufficient_displayed_stock_liquidity');
  exit.stockQuoteEvidence.askSizeShares = exit.stockQuoteEvidence.reportedAskSize = 1000;
  assert.equal((await execute(exit)).status, 'closed');
});
