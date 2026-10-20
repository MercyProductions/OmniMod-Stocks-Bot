import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cryptoRulesFixture, krakenBookEvidence, coinbaseBookEvidence } from '../../new-bots/shared/fixtures/cryptoBookEvidence.js';
import { parseKrakenPaperBook } from '../src/krakenPaperBook.js';
import { collectKrakenPositionQuotes, parseKrakenPositionQuote } from '../src/krakenPositionQuotes.js';
const directory = await mkdtemp(join(tmpdir(), 'omnimod-kraken-refresh-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { refreshCryptoPaperQuotes } = await import('../src/paperQuoteRefresh.js');
after(() => rm(directory, { recursive: true, force: true }));
const now = Date.parse('2026-10-03T15:00:00Z');
const identity = (assetId = 'bitcoin', base = 'BTC', pair = 'XBTUSD') => ({ version: 1, namespace: 'coingecko', assetId, provider: 'Kraken', pair, base, quoteCurrency: 'USD',
  verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() });
const stream = (symbol = 'BTC/USD', at = now) => ({ symbol, bid: 100, ask: 100.1, bidSize: 2, askSize: 3, time: new Date(at).toISOString(),
  cryptoQuoteEvidence: krakenBookEvidence({ symbol, time: at, bid: 100, ask: 100.1, bidSize: 2, askSize: 3 }) });
const asset = (id = identity()) => ({ id: id.assetId, symbol: id.base, marketData: { quotes: [{ provider: id.provider, pair: id.pair,
  base: id.base, target: id.quoteCurrency, cryptoIdentity: id, cryptoInstrumentRules: cryptoRulesFixture({ ...id, time: now }),
  bid: 50, ask: 50.1, observedAt: new Date(now).toISOString(), timestampBasis: 'provider_event' }] } });
const options = { clock: () => now, loadInstrumentRules: async id => cryptoRulesFixture({ ...id, time: now }),
  loadCoinbaseBook: () => assert.fail('Kraken routes must stay native') };

test('bare Kraken parser never attests subscription status; paper binding preserves collected native evidence', () => {
  const raw = { symbol: 'BTC/USD', bid: 100, ask: 100.1, bid_qty: 2, ask_qty: 3, timestamp: new Date(now).toISOString() };
  const parsed = parseKrakenPositionQuote(raw, { now });
  assert.equal(parsed.cryptoQuoteEvidence, undefined);
  assert.throws(() => parseKrakenPaperBook(parsed, identity(), { now }), { code: 'crypto_order_book_evidence_required' });
  const q = parseKrakenPaperBook(stream(), identity(), { now });
  assert.equal(q.pair, 'XBTUSD'); assert.equal(q.cryptoQuoteEvidence.symbol, 'BTC/USD');
  assert.equal(q.cryptoQuoteEvidence.bidSize, 2); assert.equal(q.observedAt, stream().time);
  for (const row of [stream('ETH/USD'), { ...stream(), bid: 99 }, stream('BTC/USD', now - 15001), stream('BTC/USD', now + 5001),
    { ...stream(), cryptoQuoteEvidence: { ...stream().cryptoQuoteEvidence, subscriptionAcknowledged: false } }])
    assert.throws(() => parseKrakenPaperBook(row, identity(), { now }));
});

test('full scanner refresh obtains one native collection for all eligible Kraken routes and retains research snapshots', async () => {
  const rows = [asset(), asset(identity('ethereum', 'ETH', 'ETHUSD'))], before = structuredClone(rows); let collections = 0;
  const result = await refreshCryptoPaperQuotes(rows, { ...options, collectKraken: async symbols => {
    collections++; assert.deepEqual(symbols.sort(), ['BTC/USD', 'ETH/USD']);
    return { quotes: new Map(symbols.map(s => [s, stream(s)])), diagnostics: { status: 'complete', sessions: 1, durationMs: 10 } };
  } });
  assert.equal(collections, 1); assert.equal(result.quotesByKey.size, 2); assert.equal(result.diagnostics.refresh.receivedKrakenBooks, 2);
  assert.equal(result.entryByAssetId.get('bitcoin').bid, 100); assert.deepEqual(rows, before);
  assert.equal(result.entryByAssetId.get('ethereum').cryptoQuoteEvidence.symbol, 'ETH/USD');
});

test('failed Kraken collection cannot fall back even to an otherwise fresh cached book', async () => {
  const original = asset(); original.marketData.quotes[0] = { ...original.marketData.quotes[0], ...parseKrakenPaperBook(stream(), identity(), { now }) };
  for (const collectKraken of [async () => { throw new Error('private'); }, async () => ({ quotes: new Map(), diagnostics: { status: 'timeout', sessions: 1 } }),
    async () => ({ quotes: new Map([['BTC/USD', { ...stream(), cryptoQuoteEvidence: null }]]), diagnostics: { status: 'complete', sessions: 1 } })]) {
    const result = await refreshCryptoPaperQuotes([original], { ...options, collectKraken });
    assert.equal(result.quotesByKey.size, 0); assert.equal(result.diagnostics.refresh.failures, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('metadata rejection and ambiguous stream aliases cannot request a Kraken book', async () => {
  const noNetwork = () => assert.fail('no eligible native routes');
  const badRules = await refreshCryptoPaperQuotes([asset()], { ...options, loadInstrumentRules: async () => { throw Error('missing'); }, collectKraken: noNetwork });
  assert.equal(badRules.quotesByKey.size, 0);
  const original = asset(); original.marketData.quotes.push({ ...original.marketData.quotes[0], pair: 'OTHER',
    cryptoIdentity: identity('bitcoin', 'BTC', 'OTHER') });
  const ambiguous = await refreshCryptoPaperQuotes([original], { ...options, collectKraken: noNetwork });
  assert.equal(ambiguous.quotesByKey.size, 0); assert.equal(ambiguous.diagnostics.rejectionCounts.ambiguous_kraken_stream_route, 2);
});

test('partial Kraken failure preserves independent Coinbase evidence and successful Kraken symbols', async () => {
  const coinbaseId = { ...identity('solana', 'SOL', 'SOL-USD'), provider: 'Coinbase' };
  const rows = [asset(), asset(identity('ethereum', 'ETH', 'ETHUSD')), asset(coinbaseId)];
  const result = await refreshCryptoPaperQuotes(rows, { ...options,
    collectKraken: async () => ({ quotes: new Map([['BTC/USD', stream()]]), diagnostics: { status: 'partial', sessions: 1, missing: 1 } }),
    loadCoinbaseBook: async id => ({ provider: 'Coinbase', pair: id.pair, base: id.base, target: 'USD', bid: 100, ask: 100.1,
      observedAt: new Date(now).toISOString(), timestampBasis: 'provider_order_book', cryptoIdentity: id,
      cryptoQuoteEvidence: coinbaseBookEvidence({ pair: id.pair, bid: 100, ask: 100.1, time: now }) }) });
  assert.deepEqual([...result.entryByAssetId.keys()].sort(), ['bitcoin', 'solana']);
  assert.equal(result.diagnostics.rejectionCounts.kraken_timestamped_bbo_unavailable, 1);
});

test('collection delay rechecks provider observation and instrument-rule ages without renewing either', async () => {
  for (const delay of [16000, 60001]) {
    let at = now;
    const result = await refreshCryptoPaperQuotes([asset()], { ...options, clock: () => at, collectKraken: async () => {
      at += delay;
      return { quotes: new Map([['BTC/USD', stream('BTC/USD', delay > 60000 ? at : now)]]), diagnostics: { status: 'complete', sessions: 1 } };
    } });
    assert.equal(result.quotesByKey.size, 0);
  }
});

test('actual protocol collector only attaches proof after exact acknowledgment and online status', async () => {
  const connect = () => {
    const socket = new EventEmitter(); socket.terminate = () => socket.emit('close');
    socket.send = request => {
      const { req_id } = JSON.parse(request);
      socket.emit('message', JSON.stringify({ channel: 'status', data: [{ system: 'online' }] }));
      socket.emit('message', JSON.stringify({ channel: 'ticker', type: 'snapshot', data: [{ symbol: 'BTC/USD', bid: 100, ask: 100.1, bid_qty: 2, ask_qty: 3, timestamp: new Date(now).toISOString() }] }));
      socket.emit('message', JSON.stringify({ method: 'subscribe', req_id, success: true, result: { channel: 'ticker', symbol: 'BTC/USD' } }));
    };
    queueMicrotask(() => socket.emit('open')); return socket;
  };
  const result = await refreshCryptoPaperQuotes([asset()], { ...options, collectKraken: (symbols, opts) => collectKrakenPositionQuotes(symbols, { ...opts, connect }) });
  assert.equal(result.quotesByKey.size, 1);
  assert.deepEqual(result.entryByAssetId.get('bitcoin').cryptoQuoteEvidence, stream().cryptoQuoteEvidence);
});
