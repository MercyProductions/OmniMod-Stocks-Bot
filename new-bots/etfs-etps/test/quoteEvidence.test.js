import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stockQuote } from '../../shared/fixtures/stockQuoteEvidence.js';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote, readPaperRiskLedger } from '../../shared/paperRisk.js';
import { fetchAlpacaEtfPositionMarks } from '../src/alpacaMarketData.js';
import { evaluateOpeningRangeBreakout } from '../src/strategies.js';

const now = Date.parse('2026-10-02T15:35:00Z');
const q = (at = now, bid = 100.8, ask = 100.81, options) => stockQuote('SPY', {
  bid, ask, time: new Date(at).toISOString(), quality: 'executable',
}, options);
const candidate = () => ({ mode: 'paper', owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY',
  strategyId: 'etp-opening-range-breakout-v1', sessionDate: '2026-10-02', sessionTimeZone: 'America/New_York',
  forceExitAt: '2026-10-02T20:00:00Z', exposureKey: 'SPY', idempotencyKey: 'SPY:2026-10-02:etp-orb:long',
  direction: 'long', bid: 100.8, ask: 100.81, entryPrice: 100.81, stopPrice: 100, targetPrice: 102.43,
  quoteTime: new Date(now).toISOString(), quoteQuality: 'executable', sessionOpen: true, multiplier: 1, lotSize: 1,
  roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01, stockQuoteEvidence: q().stockQuoteEvidence });
const portfolio = { accountEquity: 10000, realizedPnlToday: 0, openPositions: [] };
const strategyInput = () => ({ symbol: 'SPY', now, quote: q(),
  session: { marketDate: '2026-10-02', openTime: now - 25 * 300000, closeTime: Date.parse('2026-10-02T20:00:00Z') },
  config: { roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01 },
  bars: Array.from({ length: 25 }, (_, i) => ({ time: now - (25 - i) * 300000, open: 100.1,
    high: i === 24 ? 100.95 : 100.2, low: 99.8, close: i === 24 ? 100.8 : 100.1, volume: i === 24 ? 2500 : 1000 })) });

test('ETF strategy refuses price-only executable claims', () => {
  const input = strategyInput();
  delete input.quote.stockQuoteEvidence;
  const result = evaluateOpeningRangeBreakout(input);
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('stock_quote_evidence_required'));
});

test('direct ETF shared-risk calls require native evidence', () => {
  const input = candidate(); delete input.stockQuoteEvidence;
  const result = evaluatePaperCandidate(input, portfolio, { now });
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('stock_quote_evidence_required'));
});

test('ETF reservation and later fill preserve evidence and refuse insufficient displayed shares', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-etf-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'paper.json');
  const input = candidate();
  const decision = evaluatePaperCandidate(input, portfolio, { now });
  assert.equal(decision.status, 'paper-approved');
  const reserved = await reservePaperCandidate(input, decision, { statePath, now, emergencyStop: false });
  assert.equal(reserved.status, 'reserved');
  const before = await readFile(statePath, 'utf8');
  const result = await processPaperQuote(reserved.order.orderId, q(now + 1000, 100.8, 100.81, { askSize: 1 }),
    { statePath, now: now + 1000, emergencyStop: false });
  assert.equal(result.reason, 'insufficient_displayed_stock_liquidity');
  assert.equal(await readFile(statePath, 'utf8'), before);
  assert.deepEqual(reserved.order.stockQuoteEvidence, input.stockQuoteEvidence);
});

test('owned ETF monitor retains native snapshot source and share sizes', async () => {
  const native = { S: 'SPY', t: new Date(now).toISOString(), bp: 100.8, ap: 100.81,
    bs: 123, as: 456, bx: 'P', ax: 'Q', c: ['R'], z: 'B' };
  const result = await fetchAlpacaEtfPositionMarks([{ orderId: 'one', owner: 'etfs-etps', assetClass: 'etf',
    instrumentKey: 'SPY', status: 'filled' }], { now: new Date(now), clock: () => now,
    env: { ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'test', ALPACA_API_SECRET_KEY: 'test' },
    fetcher: async url => ({ ok: true, status: 200, headers: new Headers(), json: async () =>
      String(url).includes('/clock') ? { is_open: true, timestamp: new Date(now).toISOString() }
        : String(url).includes('/calendar') ? [{ date: '2026-10-02', open: '09:30', close: '16:00' }]
          : { SPY: { latestQuote: native } } }),
  });
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].quote.stockQuoteEvidence?.askSizeShares, 456);
  assert.equal(result.marks[0].quote.stockQuoteEvidence?.source, 'snapshot');
});

test('native ETF evidence survives strategy approval without changing price levels or risk sizing', () => {
  const result = evaluateOpeningRangeBreakout(strategyInput());
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.candidate.stockQuoteEvidence, q().stockQuoteEvidence);
  assert.equal(result.candidate.entryPrice, 100.81);
  assert.equal(result.candidate.stopPrice, 100);
  assert.ok(result.candidate.marketGateTrace.passedGates.includes('native_consolidated_quote_evidence'));
  assert.equal(evaluatePaperCandidate(result.candidate, portfolio, { now }).status, 'paper-approved');
});

test('ETF strategy and shared risk reject IEX executable labels, mismatched and malformed evidence', () => {
  const invalidQuotes = [q(now, 100.8, 100.81, { feed: 'iex' }),
    { ...q(), stockQuoteEvidence: { ...q().stockQuoteEvidence, symbol: 'QQQ' } },
    { ...q(), stockQuoteEvidence: { ...q().stockQuoteEvidence, conditions: ['N'] } },
    { ...q(), stockQuoteEvidence: { ...q().stockQuoteEvidence, askSizeShares: 9999999 } },
    { ...q(), stockQuoteEvidence: { ...q().stockQuoteEvidence, time: new Date(now - 1000).toISOString() } },
  ];
  for (const quote of invalidQuotes) {
    assert.equal(evaluateOpeningRangeBreakout({ ...strategyInput(), quote }).status, 'no-setup');
    for (const assetClass of ['etf', 'etp', 'ETF', 'ETP']) {
      assert.equal(evaluatePaperCandidate({ ...candidate(), assetClass, stockQuoteEvidence: quote.stockQuoteEvidence }, portfolio, { now }).status, 'blocked');
    }
  }
});

for (const assetClass of ['etf', 'etp']) for (const direction of ['long', 'short']) {
  test(`${assetClass} ${direction} lifecycle checks the correct displayed side at fill, mark and exit`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'omnimod-etp-lifecycle-')); t.after(() => rm(root, { recursive: true, force: true }));
    const statePath = join(root, 'paper.json');
    const input = { ...candidate(), assetClass, direction, ...(direction === 'short' ? { entryPrice: 100.8, stopPrice: 101.61, targetPrice: 99.18 } : {}) };
    const decision = evaluatePaperCandidate(input, portfolio, { now });
    assert.equal(decision.status, 'paper-approved');
    const reserved = await reservePaperCandidate(input, decision, { statePath, now, emergencyStop: false });
    assert.equal(reserved.status, 'reserved');
    assert.ok(reserved.order.units > 1);
    const run = quote => processPaperQuote(reserved.order.orderId, quote, { statePath, now: Date.parse(quote.time), emergencyStop: false });
    const unchanged = async (quote, reason) => {
      const prior = await readFile(statePath, 'utf8');
      assert.equal((await run(quote)).reason, reason);
      assert.equal(await readFile(statePath, 'utf8'), prior);
    };
    const thinEntry = direction === 'long' ? { askSize: 1 } : { bidSize: 1 };
    await unchanged(q(now + 1000, 100.8, 100.81, thinEntry), 'insufficient_displayed_stock_liquidity');
    await unchanged(q(now + 1000, 100.8, 100.81, { feed: 'iex' }), 'stock_quote_feed_mismatch');
    const missing = q(now + 1000); delete missing.stockQuoteEvidence;
    await unchanged(missing, 'stock_quote_evidence_required');
    assert.equal((await run(q(now + 2000))).status, 'filled');
    const thinExit = direction === 'long' ? { bidSize: 1 } : { askSize: 1 };
    await unchanged(q(now + 3000, 100.8, 100.81, thinExit), 'insufficient_displayed_stock_liquidity');
    assert.equal((await run(q(now + 3000))).status, 'open');
    const bid = direction === 'long' ? 103 : 98, ask = bid + 0.01;
    await unchanged(q(now + 4000, bid, ask, thinExit), 'insufficient_displayed_stock_liquidity');
    const done = await run(q(now + 4000, bid, ask));
    assert.equal(done.status, 'closed');
    assert.ok(done.order.realizedPnlUsd < done.order.grossPnlUsd);
    const ledger = await readPaperRiskLedger({ statePath });
    assert.deepEqual(done.order.stockQuoteEvidence, input.stockQuoteEvidence);
    assert.ok(ledger.events.filter(row => ['filled', 'marked', 'closed'].includes(row.type)).every(row => row.stockQuoteEvidence?.feed === 'sip'));
  });
}

test('older ETF fills require current SIP proof for exits without rewriting historical fills', async t => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-etf-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'paper.json');
  const input = candidate(); const decision = evaluatePaperCandidate(input, portfolio, { now });
  const reserved = await reservePaperCandidate(input, decision, { statePath, now, emergencyStop: false });
  await processPaperQuote(reserved.order.orderId, q(now + 1000), { statePath, now: now + 1000, emergencyStop: false });
  const ledger = await readPaperRiskLedger({ statePath });
  delete ledger.orders[0].stockQuoteEvidence; delete ledger.orders[0].lastStockQuoteEvidence;
  ledger.events = ledger.events.map(({ stockQuoteEvidence, ...event }) => event);
  await writeFile(statePath, JSON.stringify(ledger));
  const before = await readFile(statePath, 'utf8');
  const missing = q(now + 2000); delete missing.stockQuoteEvidence;
  assert.equal((await processPaperQuote(reserved.order.orderId, missing, { statePath, now: now + 2000, emergencyStop: true })).reason, 'stock_quote_evidence_required');
  assert.equal(await readFile(statePath, 'utf8'), before);
  const done = await processPaperQuote(reserved.order.orderId, q(now + 2000), { statePath, now: now + 2000, emergencyStop: true });
  assert.equal(done.status, 'closed'); assert.equal(done.order.stockQuoteEvidence, undefined);
  const after = await readPaperRiskLedger({ statePath });
  assert.deepEqual(after.events.slice(0, ledger.events.length), ledger.events);
  assert.equal(after.events.at(-1).stockQuoteEvidence.feed, 'sip');
});

test('owned ETF monitor rejects incomplete, wrong-symbol, stale and nonregular native quotes', async () => {
  for (const [change, expected] of [
    [{ as: 0 }, 'stock_quote_evidence_required'], [{ bs: '100' }, 'stock_quote_evidence_required'],
    [{ S: 'QQQ' }, 'stock_quote_symbol_mismatch'], [{ c: ['N'] }, 'stock_quote_condition_not_regular'],
    [{ t: new Date(now - 60000).toISOString() }, 'stale_or_future_quote'],
  ]) {
    const native = { S: 'SPY', t: new Date(now).toISOString(), bp: 100.8, ap: 100.81,
      bs: 123, as: 456, bx: 'P', ax: 'Q', c: ['R'], z: 'B', ...change };
    const result = await fetchAlpacaEtfPositionMarks([{ orderId: 'one', owner: 'etfs-etps', assetClass: 'etp',
      instrumentKey: 'SPY', status: 'filled' }], { now: new Date(now), clock: () => now,
      env: { ETF_ALPACA_FEED: 'sip', ALPACA_API_KEY_ID: 'test', ALPACA_API_SECRET_KEY: 'test' },
      fetcher: async url => ({ ok: true, status: 200, headers: new Headers(), json: async () =>
        String(url).includes('/clock') ? { is_open: true, timestamp: new Date(now).toISOString() }
          : String(url).includes('/calendar') ? [{ date: '2026-10-02', open: '09:30', close: '16:00' }]
            : { SPY: { latestQuote: native } } }),
    });
    assert.equal(result.marks.length, 0);
    assert.equal(result.diagnostics.rejectionReasons[expected], 1);
  }
});
