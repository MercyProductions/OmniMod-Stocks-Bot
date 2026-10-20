import test from 'node:test';
import assert from 'node:assert/strict';
import { attachProviderConsensus } from '../src/stocksData.js';
import { buildStockPaperQuotes } from '../src/paperExecutionQuotes.js';
import { parseAlpacaStockQuote } from '../../new-bots/shared/stockQuoteEvidence.js';

const now = Date.parse('2026-10-02T15:00:00Z');
const settings = { feed: 'sip', now, maxQuoteAgeMs: 15000 };
function provider(symbol = 'AAPL', extra = {}) {
  const raw = { S: symbol, bp: 100, ap: 100.02, bs: 120, as: 350, bx: 'Q', ax: 'Q', z: 'C', c: ['R'],
    t: new Date(now - 1000).toISOString(), ...extra };
  const q = parseAlpacaStockQuote(raw, { symbol, feed: 'sip', source: 'snapshot', now });
  return { provider: 'Alpaca SIP snapshot', price: 100.01, timestamp: raw.t, classification: 'intraday',
    bid: q.bid, ask: q.ask, bidSize: raw.bs, askSize: raw.as, quoteTimestamp: raw.t, stockQuoteEvidence: q.stockQuoteEvidence };
}
const asset = () => ({ symbol: 'AAPL', provider: 'Yahoo Chart', price: 99, lastUpdated: new Date(now - 300000).toISOString() });
const analyzed = () => attachProviderConsensus(asset(), { quotes: [provider()] }, now);

test('native snapshot evidence survives provider consensus into a scanner execution quote', () => {
  const row = analyzed(), result = buildStockPaperQuotes([row], settings);
  assert.equal(result.quotes.size, 1);
  assert.deepEqual(result.quotes.get('AAPL').stockQuoteEvidence, provider().stockQuoteEvidence);
  assert.equal(result.quotes.get('AAPL').stockQuoteEvidence.askSizeShares, 350);
  assert.equal(result.diagnostics.evaluated, 1); assert.equal(result.diagnostics.rejected, 0);
});

test('fresh trade price cannot renew expired native quote evidence', () => {
  const old = provider('AAPL', { t: new Date(now - 14000).toISOString() });
  const row = attachProviderConsensus(asset(), { quotes: [{ ...old, timestamp: new Date(now).toISOString(), price: 105 }] }, now);
  assert.equal(row.livePrice, 105);
  const result = buildStockPaperQuotes([row], { ...settings, now: now + 2000 });
  assert.equal(result.quotes.size, 0);
  assert.deepEqual(result.diagnostics.rejectionReasons, { stale_or_future_quote: 1 });
});

test('consensus clears old proof when a new selected quote has no native evidence', () => {
  const { stockQuoteEvidence, ...unproven } = provider();
  const row = attachProviderConsensus(analyzed(), { quotes: [{ ...unproven, provider: 'Unverified quote' }] }, now);
  assert.equal(row.stockQuoteEvidence, null);
  assert.equal(buildStockPaperQuotes([row], settings).diagnostics.rejectionReasons.stock_quote_evidence_required, 1);
  const noQuotes = attachProviderConsensus(analyzed(), { quotes: [] }, now);
  assert.equal(noQuotes.stockQuoteEvidence, null);
});

test('scanner rejects mismatched, stale, halted, duplicate and missing evidence with exact counts', () => {
  const row = analyzed();
  for (const [extra, reason] of [
    [{ stockQuoteEvidence: null }, 'stock_quote_evidence_required'],
    [{ askPrice: 101 }, 'stock_quote_evidence_mismatch'],
    [{ symbol: 'MSFT' }, 'stock_quote_evidence_mismatch'],
    [{ halted: true }, 'stock_halted'],
    [{ stockQuoteEvidence: null, stockQuoteRejection: 'stock_quote_condition_not_regular' }, 'stock_quote_condition_not_regular'],
  ]) {
    const result = buildStockPaperQuotes([{ ...row, ...extra }], settings);
    assert.equal(result.quotes.size, 0); assert.deepEqual(result.diagnostics.rejectionReasons, { [reason]: 1 });
    assert.equal(result.diagnostics.rejections[0].reason, reason);
  }
  const duplicates = buildStockPaperQuotes([row, { ...row, symbol: 'aapl' }], settings);
  assert.equal(duplicates.quotes.size, 0); assert.equal(duplicates.diagnostics.rejectionReasons.duplicate_stock_symbol, 2);
  assert.equal(buildStockPaperQuotes([row], { ...settings, feed: 'iex' }).diagnostics.rejectionReasons.stock_quote_feed_mismatch, 1);
  assert.equal(buildStockPaperQuotes([row], { ...settings, now: NaN }).diagnostics.rejectionReasons.stock_quote_policy_invalid, 1);
});

test('research provider price remains available without being promoted into a paper quote', () => {
  const row = attachProviderConsensus(asset(), { quotes: [{ provider: 'Finnhub', price: 101,
    timestamp: new Date(now).toISOString(), classification: 'intraday' }] }, now);
  assert.equal(row.livePrice, 101);
  assert.equal(buildStockPaperQuotes([row], settings).quotes.size, 0);
});
