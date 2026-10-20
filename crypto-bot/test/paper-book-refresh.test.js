import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cryptoRulesFixture } from '../../new-bots/shared/fixtures/cryptoBookEvidence.js';
import { parseCoinbasePaperBook } from '../src/coinbasePaperBook.js';
const directory = await mkdtemp(join(tmpdir(), 'omnimod-book-provider-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { fetchCoinbasePaperBook } = await import('../src/marketProviders.js');
const { refreshCryptoPaperQuotes: actualRefreshCryptoPaperQuotes } = await import('../src/paperQuoteRefresh.js');
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.parse('2026-10-03T12:00:00Z');
const id = (assetId = 'bitcoin', base = 'BTC') => ({ version: 1, namespace: 'coingecko', assetId,
  provider: 'Coinbase', base, quoteCurrency: 'USD', pair: `${base}-USD`,
  verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() });
const payload = (at = now) => ({ sequence: 10001, time: new Date(at).toISOString(),
  bids: [['99.95', '10', 2]], asks: [['100.05', '20', 1]] });
const asset = (identity = id()) => ({ id: identity.assetId, symbol: identity.base,
  marketData: { quotes: [{ provider: identity.provider, pair: identity.pair, base: identity.base, target: identity.quoteCurrency,
    price: 100, bid: 99.95, ask: 100.05, observedAt: new Date(now - 60000).toISOString(),
    timestampBasis: 'provider_event', cryptoIdentity: identity }] } });
const refreshCryptoPaperQuotes = (rows, options) => actualRefreshCryptoPaperQuotes(rows, { loadInstrumentRules: async identity => cryptoRulesFixture({ ...identity, time: now }), ...options });
const book = identity => parseCoinbasePaperBook(payload(), identity, { now });

test('order book parser preserves source time, sequence, native units and displayed size', () => {
  const out = parseCoinbasePaperBook(payload(), id(), { now });
  assert.equal(out.observedAt, payload().time);
  assert.equal(out.timestampBasis, 'provider_order_book');
  assert.equal(out.bid, 99.95); assert.equal(out.ask, 100.05);
  assert.equal(out.cryptoQuoteEvidence.bidSize, 10);
  assert.equal(out.cryptoQuoteEvidence.askSize, 20, 'aggregated size is not multiplied by the order count');
  assert.equal(out.cryptoQuoteEvidence.sequence, 10001);
  const native = { ...id(), pair: 'BTC-USDT', quoteCurrency: 'USDT' };
  assert.equal(parseCoinbasePaperBook(payload(), native, { now }).target, 'USDT');
});

test('invalid, indicative or undated books cannot create executable paper quotes', () => {
  const mutations = [
    { time: null }, { time: now }, { time: '' }, { time: new Date(now - 16000).toISOString() },
    { time: new Date(now + 6000).toISOString() }, { sequence: null }, { sequence: '100' }, { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { auction_mode: true }, { auction_mode: 'false' }, { auction: {} },
    { bids: [] }, { asks: [] }, { bids: [['101', '10', 1]] }, { bids: [['99', '0', 1]] },
    { asks: [['100.05', true, 1]] }, { asks: [[null, '5', 1]] }, { bids: [['99', '10'], ['98', '20']] },
  ];
  for (const row of mutations) assert.throws(() => parseCoinbasePaperBook({ ...payload(), ...row }, id(), { now }), undefined, JSON.stringify(row));
  assert.throws(() => parseCoinbasePaperBook(payload(), { ...id(), verifiedAt: new Date(now - 70 * 60000).toISOString() }, { now }));
  for (const maxQuoteAgeMs of [NaN, '15000', 0, -1, Infinity]) assert.throws(() => parseCoinbasePaperBook(payload(), id(), { now, maxQuoteAgeMs }));
});

test('native provider acquisition uses exact public L1 endpoint with no identity/history side requests', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return Response.json(payload()); });
  const out = await fetchCoinbasePaperBook(id(), { clock: () => now });
  assert.deepEqual(calls, ['https://api.exchange.coinbase.com/products/BTC-USD/book?level=1']);
  assert.equal(out.cryptoIdentity.assetId, 'bitcoin');
  assert.equal(out.cryptoQuoteEvidence.time, payload().time);
});

test('invalid quote policy and stale identity make no provider request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(payload()); });
  for (const maxQuoteAgeMs of [NaN, 0, Infinity, '15000'])
    await assert.rejects(fetchCoinbasePaperBook(id(), { clock: () => now, maxQuoteAgeMs }));
  await assert.rejects(fetchCoinbasePaperBook({ ...id(), verifiedAt: new Date(now - 70 * 60000).toISOString() }, { clock: () => now }));
  assert.equal(calls, 0);
});

test('concurrent Coinbase book requests share the paced REST request gate', async t => {
  const starts = [];
  t.mock.method(globalThis, 'fetch', async () => { starts.push(performance.now()); return Response.json(payload()); });
  await Promise.all([fetchCoinbasePaperBook(id(), { clock: () => now }), fetchCoinbasePaperBook(id('ethereum', 'ETH'), { clock: () => now }),
    fetchCoinbasePaperBook(id('solana', 'SOL'), { clock: () => now })]);
  assert.equal(starts.length, 3);
  for (let n = 1; n < starts.length; n++) assert.ok(starts[n] - starts[n - 1] >= 130, 'request starts must be spaced, not burst together');
});

test('failed native request cannot fall back to ticker data', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unavailable', { status: 404 }); });
  const out = await refreshCryptoPaperQuotes([asset()], { clock: () => now });
  assert.equal(calls, 1);
  assert.equal(out.quotesByKey.size, 0);
  assert.equal(out.diagnostics.refresh.failures, 1);
  assert.equal(out.diagnostics.rejectionCounts.coinbase_paper_book_unavailable, 1);
});

test('post-analysis refresh replaces old ticker prices with current book evidence without mutating research', async () => {
  const original = asset(), before = structuredClone(original);
  const out = await refreshCryptoPaperQuotes([original], { clock: () => now, loadCoinbaseBook: async identity => book(identity) });
  assert.deepEqual(original, before);
  assert.equal(out.quotesByKey.size, 1);
  assert.equal(out.entryByAssetId.get('bitcoin').cryptoQuoteEvidence.time, payload().time);
  assert.equal(out.diagnostics.refresh.requestedRoutes, 1);
});

test('refresh rejects unsupported native currency, duplicate records and conflicting identity claims before fetching', async () => {
  const native = { ...id(), pair: 'BTC-USDT', quoteCurrency: 'USDT' };
  let calls = 0;
  for (const rows of [[asset(native)], [asset(), asset()], [asset(), asset({ ...id(), assetId: 'another-bitcoin' })],
    [{ ...asset(), marketData: { quotes: [...asset().marketData.quotes, ...asset().marketData.quotes] } }]]) {
    const out = await refreshCryptoPaperQuotes(rows, { clock: () => now, loadCoinbaseBook: async () => { calls++; throw Error('must not fetch'); } });
    assert.equal(out.quotesByKey.size, 0); assert.equal(out.diagnostics.refresh.requestedRoutes, 0);
  }
  assert.equal(calls, 0);
});

test('returned identity cannot substitute another pair; delayed collection rechecks all quote ages', async () => {
  const changed = await refreshCryptoPaperQuotes([asset()], { clock: () => now, loadCoinbaseBook: async () => book(id('ethereum', 'ETH')) });
  assert.equal(changed.quotesByKey.size, 0); assert.equal(changed.diagnostics.refresh.failures, 1);
  let time = now;
  const aged = await refreshCryptoPaperQuotes([asset()], { clock: () => time, loadCoinbaseBook: async identity => { time += 16000; return book(identity); } });
  assert.equal(aged.quotesByKey.size, 0); assert.equal(aged.diagnostics.refresh.receivedBooks, 1);
  assert.equal(aged.diagnostics.rejectionCounts.crypto_quote_not_current_and_executable, 1);
});

test('quote-only refresh bounds concurrent work and preserves every requested exact identity', async () => {
  let active = 0, peak = 0;
  const rows = Array.from({ length: 8 }, (_, n) => asset(id(`asset-${n}`, `COIN${n}`)));
  const out = await refreshCryptoPaperQuotes(rows, { clock: () => now, loadCoinbaseBook: async identity => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return book(identity);
  } });
  assert.equal(peak, 3); assert.equal(out.quotesByKey.size, 8); assert.equal(out.diagnostics.refresh.requestedRoutes, 8);
});
