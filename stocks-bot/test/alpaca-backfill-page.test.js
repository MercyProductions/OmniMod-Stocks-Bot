import test from 'node:test';
import assert from 'node:assert/strict';
import { hashAlpacaPageToken, inspectAlpacaBackfillCheckpoint, normalizeAlpacaBackfillPage } from '../src/alpacaBackfillPage.js';

const range = { symbols: ['AAPL'], start: '2026-09-01T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z' };
const validBar = { t: '2026-09-02T14:30:00.000Z', o: 100, h: 105, l: 99, c: 104, v: 0, n: 0, vw: 103 };

test('Alpaca backfill page retains valid zero-volume bars and normalizes provider symbols', () => {
  const page = normalizeAlpacaBackfillPage({ bars: { aapl: [validBar] }, next_page_token: 'opaque-page-2' }, range);
  assert.deepEqual(page.rows, [{ symbol: 'AAPL', timestamp: Date.parse(validBar.t) / 1_000,
    open: 100, high: 105, low: 99, close: 104, volume: 0, tradeCount: 0, vwap: 103 }]);
  assert.equal(page.nextPageToken, 'opaque-page-2');
});

test('Alpaca backfill page fails closed on malformed, out-of-range, duplicate, or unrequested bars', () => {
  for (const payload of [
    { bars: [] },
    { bars: { AAPL: { ...validBar } } },
    { bars: { AAPL: [{ ...validBar, h: 98 }] } },
    { bars: { AAPL: [{ ...validBar, t: '2026-09-03T00:00:00.000Z' }] } },
    { bars: { AAPL: [validBar, validBar] } },
    { bars: { MSFT: [validBar] } },
    { bars: { AAPL: [validBar] }, next_page_token: 4 },
  ]) assert.throws(() => normalizeAlpacaBackfillPage(payload, range));
});

test('Alpaca backfill page validates requested symbol and ordered date range', () => {
  assert.throws(() => normalizeAlpacaBackfillPage({ bars: {} }, { ...range, symbols: [] }), /symbols/);
  assert.throws(() => normalizeAlpacaBackfillPage({ bars: {} }, { ...range, end: range.start }), /range/);
  assert.notEqual(hashAlpacaPageToken('page-a'), hashAlpacaPageToken('page-b'));
  assert.equal(hashAlpacaPageToken(''), '');
});

test('Alpaca backfill page rejects duplicate or out-of-order timestamps across page boundaries', () => {
  const lastTimestamp = Math.floor(Date.parse(validBar.t) / 1_000);
  assert.throws(() => normalizeAlpacaBackfillPage({ bars: { AAPL: [validBar] } }, { ...range, lastTimestampBySymbol: { AAPL: lastTimestamp } }), /duplicate or out-of-order/);
  const later = { ...validBar, t: '2026-09-02T14:31:00.000Z' };
  const page = normalizeAlpacaBackfillPage({ bars: { AAPL: [later] } }, { ...range, lastTimestampBySymbol: { AAPL: lastTimestamp } });
  assert.equal(page.lastTimestampBySymbol.AAPL, Date.parse(later.t) / 1_000);
});

test('Alpaca backfill checkpoints validate query identity, counts, coverage and cursors', () => {
  const signature = JSON.stringify({ symbols: ['AAPL'], timeframe: '15Min', feed: 'iex', start: range.start, end: range.end });
  const fresh = { version: 2, signature: null, pages: 0, bars: 0, nextPageToken: '', seenPageTokenHashes: [], completed: false,
    lastTimestampBySymbol: {}, coverageBySymbol: { AAPL: { bars: 0, firstTimestamp: null, lastTimestamp: null } } };
  assert.deepEqual(inspectAlpacaBackfillCheckpoint(fresh, { signature, symbols: ['AAPL'] }), {
    legacyPriorCoverageUnknown: false, lastTimestampBySymbol: {}, coverageBySymbol: fresh.coverageBySymbol, seenPageTokenHashes: [],
  });
  const complete = { ...fresh, signature, pages: 1, bars: 1, completed: true, lastTimestampBySymbol: { AAPL: 1_788_352_200 },
    coverageBySymbol: { AAPL: { bars: 1, firstTimestamp: 1_788_352_200, lastTimestamp: 1_788_352_200 } } };
  assert.equal(inspectAlpacaBackfillCheckpoint(complete, { signature, symbols: ['AAPL'] }).coverageBySymbol.AAPL.bars, 1);
  assert.throws(() => inspectAlpacaBackfillCheckpoint({ ...complete, bars: 2 }, { signature, symbols: ['AAPL'] }), /totals/);
  assert.throws(() => inspectAlpacaBackfillCheckpoint(complete, { signature: `${signature} `, symbols: ['AAPL'] }), /does not match/);
  assert.throws(() => inspectAlpacaBackfillCheckpoint({ ...complete, seenPageTokenHashes: ['opaque-token'] }, { signature, symbols: ['AAPL'] }), /malformed/);
});

test('legacy Stocks backfill checkpoints resume with explicit unknown prior symbol coverage', () => {
  const signatureRecord = { symbols: ['AAPL'], timeframe: '15Min', feed: 'iex', start: range.start, end: range.end };
  const state = inspectAlpacaBackfillCheckpoint({ version: 1, signature: signatureRecord, pages: 1, bars: 20,
    nextPageToken: 'old-cursor', completed: false }, { signature: JSON.stringify(signatureRecord), symbols: ['AAPL'] });
  assert.equal(state.legacyPriorCoverageUnknown, true);
  assert.deepEqual(state.coverageBySymbol.AAPL, { bars: 0, firstTimestamp: null, lastTimestamp: null });
});
