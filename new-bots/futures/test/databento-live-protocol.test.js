import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveSymbolRouter, liveHeader, liveNumber, liveTimestampNs, normalizeLiveMinuteBar, parseLiveQuote } from '../src/databentoLiveProtocol.js';
import { fetchDatabentoFuturesDayMarketData } from '../src/databentoLiveSession.js';
import { fetchDatabentoFuturePositionMarks } from '../src/databentoLiveMarks.js';

const now = Date.parse('2026-09-29T15:10:04Z');
const stamp = (offset = 0) => new Date(now + offset).toISOString();
const mapping = (symbol = 'ESZ6', instrument = 123, extra = {}) => ({ hd: { rtype: 22, publisher_id: 0, instrument_id: instrument },
  stype_in_symbol: symbol, stype_out_symbol: symbol, stype_in: 1, stype_out: 1, start_ts: null, end_ts: null, ...extra });
const quote = (instrument = 123, offset = -200, extra = {}) => ({ hd: { rtype: 1, publisher_id: 1, instrument_id: instrument, ts_event: stamp(offset) },
  ts_recv: stamp(offset), ts_out: stamp(offset + 100), sequence: 100, flags: 128,
  levels: [{ bid_px: '6010.00', ask_px: '6010.25', bid_sz: 20, ask_sz: 20 }], ...extra });
const session = { marketDate: '2026-09-29', openTime: '2026-09-29T15:00:00.000Z', closeTime: '2026-09-29T22:00:00.000Z' };
const contract = (symbol = 'ESZ6') => ({ symbol: symbol.slice(0, 2), providerSymbol: symbol, providerRawSymbol: symbol, contractId: `CME:${symbol}`, exposureKey: 'SPY',
  expiry: '2026-12-18T14:30:00.000Z', contractSpecVerified: true, activeContract: true,
  specSource: 'https://example.test/reviewed-contract', specVerifiedAt: stamp(-60_000),
  multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5, initialMarginUsd: 1000, maintenanceMarginUsd: 900 });
const trade = (symbol = 'ESZ6') => ({ contract: contract(symbol), session });
const order = (symbol = 'ESZ6') => ({ orderId: `paper-${symbol}`, instrumentKey: `CME:${symbol}`, owner: 'futures', assetClass: 'future',
  status: 'open', units: 1, multiplier: 50, future: contract(symbol) });
const minuteBars = (instrument = 123) => Array.from({ length: 10 }, (_, i) => ({
  hd: { rtype: 33, publisher_id: 1, instrument_id: instrument, ts_event: new Date(Date.parse(session.openTime) + i * 60_000).toISOString() },
  open: '6000', high: '6001', low: '5999', close: '6000.5', volume: 10,
}));
const replay = { hd: { rtype: 23 }, code: 3 };
const encoded = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
function connection(stream) {
  return () => {
    const socket = new EventEmitter();
    socket.destroy = () => { socket.destroyed = true; };
    socket.setTimeout = () => {};
    socket.write = (value) => {
      if (value.startsWith('auth=')) queueMicrotask(() => socket.emit('data', Buffer.from('success=1\n')));
      if (value === 'start_session=0\n') queueMicrotask(() => stream(socket));
      return true;
    };
    queueMicrotask(() => socket.emit('data', Buffer.from('cram=fixture-challenge\n')));
    return socket;
  };
}
const feed = (records) => connection((socket) => socket.emit('data', Buffer.from(encoded(records))));
const settings = { apiKey: 'fixture-only', now, clock: () => now, timeoutMs: 30 };

test('instrument-only nested quotes resolve through exact raw-symbol mappings without losing nanoseconds', () => {
  const router = createLiveSymbolRouter(['ESZ6']);
  const record = quote(123, -200, { hd: { ...quote().hd, ts_event: '2026-09-29T15:10:03.123456789Z' } });
  assert.equal(router.route(record).kind, 'ignored');
  router.route(mapping());
  const resolved = router.route(record);
  assert.equal(resolved.kind, 'quote');
  assert.equal(resolved.symbol, 'ESZ6');
  assert.equal(resolved.record.ts_event, record.hd.ts_event);
  assert.equal(liveHeader(resolved.record).at, 1790694603123456789n);
  assert.equal(router.diagnostics().unmapped_record, 1);
});

test('symbol intervals are start-inclusive/end-exclusive at nanosecond precision', () => {
  const router = createLiveSymbolRouter(['ESZ6', 'ESH7']);
  const boundary = '2026-09-29T15:10:03.123456789Z';
  router.route(mapping('ESZ6', 123, { end_ts: boundary }));
  router.route(mapping('ESH7', 123, { start_ts: boundary }));
  const record = (time) => quote(123, -200, { hd: { ...quote().hd, ts_event: time } });
  assert.equal(router.route(record('2026-09-29T15:10:03.123456788Z')).symbol, 'ESZ6');
  assert.equal(router.route(record(boundary)).symbol, 'ESH7');
  assert.deepEqual(router.reasonsFor('ESZ6'), []);
});

test('overlapping mappings reject both ambiguous symbols and multiple identities for one raw symbol', () => {
  const router = createLiveSymbolRouter(['ESZ6', 'NQZ6']);
  router.route(mapping()); router.route(mapping('NQZ6'));
  assert.deepEqual(router.reasonsFor('ESZ6'), ['live_mapping_identity_conflict']);
  assert.deepEqual(router.reasonsFor('NQZ6'), ['live_mapping_identity_conflict']);
  assert.equal(router.route(quote()).kind, 'ignored');
  const sameSymbol = createLiveSymbolRouter(['ESZ6']);
  sameSymbol.route(mapping()); sameSymbol.route(mapping('ESZ6', 124));
  assert.equal(sameSymbol.route(quote()).kind, 'rejected');
  assert.deepEqual(sameSymbol.reasonsFor('ESZ6'), ['live_symbol_instrument_conflict']);
});

test('nonoverlapping instrument mappings and exact duplicates remain usable', () => {
  const router = createLiveSymbolRouter(['ESZ6']);
  router.route(mapping('ESZ6', 122, { end_ts: stamp(-1000) }));
  router.route(mapping('ESZ6', 123, { start_ts: stamp(-1000) }));
  router.route(mapping('ESZ6', 123, { start_ts: stamp(-1000) }));
  assert.equal(router.route(quote()).kind, 'quote');
  assert.deepEqual(router.reasonsFor('ESZ6'), []);
});

test('embedded identity, reviewed publisher, changing publisher and mapping type disagreements are rejected', () => {
  for (const [extra, expected] of [[{ raw_symbol: 'NQZ6' }, 'live_embedded_symbol_conflict'],
    [{ hd: { ...quote().hd, publisher_id: 2 } }, 'live_reviewed_publisher_mismatch']]) {
    const router = createLiveSymbolRouter(['ESZ6'], { expectedPublishers: new Map([['ESZ6', 1]]) });
    router.route(mapping());
    assert.equal(router.route(quote(123, -200, extra)).kind, 'rejected');
    assert.ok(router.reasonsFor('ESZ6').includes(expected));
  }
  const router = createLiveSymbolRouter(['ESZ6']); router.route(mapping()); router.route(quote());
  assert.equal(router.route(quote(123, -100, { hd: { ...quote().hd, publisher_id: 2 } })).kind, 'rejected');
  assert.ok(router.reasonsFor('ESZ6').includes('live_publisher_changed'));
  const wrongType = createLiveSymbolRouter(['ESZ6']); wrongType.route(mapping('ESZ6', 123, { stype_out: 0 }));
  assert.ok(wrongType.reasonsFor('ESZ6').includes('live_mapping_not_exact_raw_symbol'));
});

test('undefined mapping sentinels are supported but missing or reversed bounds are not invented', () => {
  for (const end of [null, '18446744073709551615', '2554-07-21T23:34:33.709551615Z']) {
    const router = createLiveSymbolRouter(['ESZ6']); router.route(mapping('ESZ6', 123, { end_ts: end }));
    assert.equal(router.route(quote()).kind, 'quote');
  }
  for (const bounds of [{ start_ts: undefined }, { start_ts: stamp(), end_ts: stamp(-1) }])
    assert.throws(() => createLiveSymbolRouter(['ESZ6']).route(mapping('ESZ6', 123, bounds)), /interval/);
});

test('nested headers cannot contradict flat metadata and malformed timestamps cannot roll into another date', () => {
  assert.throws(() => liveHeader({ ...quote(), instrument_id: 999 }), /headers conflict/);
  for (const value of [null, 1, '2026-02-30T15:00:00Z', '2026-09-29 15:00:00Z', '2026-09-29T15:00:00.1234567890Z'])
    assert.equal(liveTimestampNs(value), null);
  for (const value of [null, true, false, '', ' ', '0x80']) assert.ok(Number.isNaN(liveNumber(value)));
});

test('pretty quote prices retain their explicit scale without a price-magnitude heuristic', () => {
  for (const [bid, ask] of [['0.000000010', '0.000000020'], ['100000000.00', '100000000.25']]) {
    const result = parseLiveQuote(quote(123, -200, { levels: [{ bid_px: bid, ask_px: ask, bid_sz: 2, ask_sz: 3 }] }), now, 5000, 2000);
    assert.equal(result.bid, Number(bid)); assert.equal(result.ask, Number(ask));
  }
});

test('invalid quotes, missing timestamps and unreliable book flags cannot become executable data', () => {
  const invalid = [ { flags: undefined }, { flags: 0 }, { flags: 128 | 32 }, { flags: 128 | 8 }, { flags: 128 | 4 },
    { ts_out: undefined }, { ts_recv: stamp(-6000) }, { ts_out: stamp(3000) }, { ts_out: stamp(-400) },
    { levels: [{ bid_px: true, ask_px: 6011, bid_sz: 1, ask_sz: 1 }] },
    { levels: [{ bid_px: 6010, ask_px: 6009, bid_sz: 1, ask_sz: 1 }] },
    { levels: [{ bid_px: 6010, ask_px: 6011, bid_sz: null, ask_sz: 1 }] },
    { levels: [{ bid_px: 6010, ask_px: 6011, bid_sz: 1.5, ask_sz: 1 }] },
    { hd: { ...quote().hd, rtype: 0 } }, { hd: { ...quote().hd, publisher_id: 0 } } ];
  for (const fields of invalid) assert.equal(parseLiveQuote(quote(123, -200, fields), now, 5000, 2000), null, JSON.stringify(fields));
  assert.equal(parseLiveQuote(quote(), now, NaN, 2000), null);
});

test('minute bars require the real OHLCV-1m schema and exact interval alignment', () => {
  const router = createLiveSymbolRouter(['ESZ6']); router.route(mapping());
  const record = router.route(minuteBars()[0]).record;
  assert.equal(normalizeLiveMinuteBar(record, 'ESZ6').volume, 10);
  assert.equal(normalizeLiveMinuteBar({ ...record, hd: undefined, rtype: 32 }, 'ESZ6'), null);
  assert.equal(normalizeLiveMinuteBar({ ...record, hd: undefined, ts_event: '2026-09-29T15:00:00.001Z' }, 'ESZ6'), null);
  assert.equal(normalizeLiveMinuteBar({ ...record, hd: undefined, ts_event: '2026-09-29T15:00:00.000000001Z' }, 'ESZ6'), null);
  assert.equal(normalizeLiveMinuteBar({ ...record, volume: false }, 'ESZ6'), null);
  assert.equal(normalizeLiveMinuteBar({ ...record, low: '6002' }, 'ESZ6'), null);
});

test('older quotes and lower same-time sequence updates cannot replace the most recent observation', () => {
  const router = createLiveSymbolRouter(['ESZ6']); router.route(mapping());
  assert.equal(router.route(quote()).kind, 'quote');
  assert.equal(router.route(quote(123, -1000)).kind, 'ignored');
  assert.equal(router.route(quote(123, -200, { sequence: 99 })).kind, 'ignored');
  assert.equal(router.route(quote(123, -100)).kind, 'quote');
  assert.equal(router.diagnostics().out_of_order_quotes, 2);
});

test('provider errors and slow-reader warnings fail closed without including raw server text', () => {
  for (const record of [{ hd: { rtype: 21 }, code: 3, err: 'fixture-secret-in-server-text' },
    { hd: { rtype: 23 }, code: 2, msg: 'fixture-secret-in-server-text' }]) {
    assert.throws(() => createLiveSymbolRouter(['ESZ6']).route(record), (error) => !error.message.includes('fixture-secret'));
  }
  assert.equal(createLiveSymbolRouter(['ESZ6']).route(replay).kind, 'system');
});

test('both adapters reject trailing provider errors after an otherwise usable packet', async () => {
  const records = [mapping(), ...minuteBars(), replay, quote(), { hd: { rtype: 21 }, code: 7, err: 'fixture-secret' }];
  for (const run of [() => fetchDatabentoFuturesDayMarketData([trade()], { ...settings, connect: feed(records) }),
    () => fetchDatabentoFuturePositionMarks([order()], { ...settings, connect: feed(records) })])
    await assert.rejects(run(), (error) => /Skipped records/.test(error.message) && !error.message.includes('fixture-secret'));
});

test('fragmented nested-header streams work for session and position adapters', async () => {
  const bytes = Buffer.from(encoded([mapping(), ...minuteBars(), replay, quote()]));
  const connect = connection((socket) => {
    for (let i = 0; i < bytes.length; i += 7) { if (!socket.destroyed) socket.emit('data', bytes.subarray(i, i + 7)); }
  });
  const day = await fetchDatabentoFuturesDayMarketData([trade()], { ...settings, connect });
  const marks = await fetchDatabentoFuturePositionMarks([order()], { ...settings, connect });
  assert.equal(day.rows[0].liveDataStatus, 'complete'); assert.equal(day.rows[0].bars.length, 2);
  assert.equal(marks.marks.length, 1);
  assert.equal(day.diagnostics.protocol.symbol_mappings, 1);
});

test('identical duplicate minutes are counted once; conflicting duplicates invalidate the session', async () => {
  for (const conflict of [false, true]) {
    const duplicate = { ...minuteBars()[0], volume: conflict ? 11 : 10 };
    const result = await fetchDatabentoFuturesDayMarketData([trade()], { ...settings,
      connect: feed([mapping(), ...minuteBars(), duplicate, replay, quote()]) });
    assert.equal(result.rows[0].liveDataStatus, conflict ? 'incomplete' : 'complete');
    if (conflict) { assert.ok(result.rows[0].liveDataReasons.includes('live_minute_bar_conflict')); assert.equal(result.rows[0].quote, null); }
    else assert.equal(result.rows[0].bars[0].volume, 50);
  }
});

test('waiting for a second symbol cannot keep an expired first quote fresh in either adapter', async () => {
  for (const mode of ['session', 'marks']) {
    let elapsed = 0;
    const metrics = [];
    const connect = connection((socket) => {
      socket.emit('data', Buffer.from(encoded([mapping(), mapping('NQZ6', 124), ...minuteBars(), ...minuteBars(124), replay, quote()])));
      elapsed = 6000;
      socket.emit('data', Buffer.from(encoded([quote(124, 5900)])));
    });
    const options = { ...settings, clock: () => now + elapsed, connect, metrics };
    if (mode === 'session') {
      const result = await fetchDatabentoFuturesDayMarketData([trade(), trade('NQZ6')], options);
      assert.equal(result.rows[0].quote, null); assert.equal(result.rows[1].liveDataStatus, 'complete');
      assert.equal(result.diagnostics.quoted, 1);
    } else {
      const result = await fetchDatabentoFuturePositionMarks([order(), order('NQZ6')], options);
      assert.deepEqual(result.marks.map((m) => m.orderId), ['paper-NQZ6']);
      assert.equal(result.diagnostics.rejectionReasons.current_executable_quote_unavailable, 1);
      assert.equal(metrics[0].quotedSymbols, 1); assert.equal(metrics[0].status, 408);
    }
  }
});

test('collection revalidates session close and contract expiry at completion', async () => {
  for (const mode of ['session', 'marks']) {
    let elapsed = 0;
    const connect = connection((socket) => {
      elapsed = 2000;
      socket.emit('data', Buffer.from(encoded([mapping(), ...minuteBars(), replay, quote(123, 1900)])));
    });
    const options = { ...settings, clock: () => now + elapsed, connect };
    if (mode === 'session') {
      const result = await fetchDatabentoFuturesDayMarketData([{ ...trade(), session: { ...session, closeTime: stamp(1000) } }], options);
      assert.ok(result.rows[0].liveDataReasons.includes('session_closed_during_collection')); assert.equal(result.rows[0].quote, null);
    } else {
      const result = await fetchDatabentoFuturePositionMarks([{ ...order(), future: { ...contract(), expiry: stamp(1000) } }], options);
      assert.equal(result.marks.length, 0); assert.equal(result.diagnostics.rejectionReasons.position_contract_became_invalid_during_collection, 1);
    }
  }
});

test('incompatible reviewed publishers cannot be overwritten by another row for the same symbol', async () => {
  let attempts = 0;
  const options = { ...settings, connect: () => { attempts++; throw new Error('must not connect'); } };
  const day = await fetchDatabentoFuturesDayMarketData([1, 2].map((id) => ({ ...trade(), contract: { ...contract(), providerPublisherId: id } })), options);
  const positions = await fetchDatabentoFuturePositionMarks([1, 2].map((id) => ({ ...order(), orderId: `paper-${id}`, future: { ...contract(), providerPublisherId: id } })), options);
  assert.equal(attempts, 0); assert.equal(day.diagnostics.eligible, 0);
  assert.equal(day.diagnostics.preflightRejectionReasons.reviewed_contract_publisher_conflict, 2);
  assert.equal(positions.diagnostics.rejectionReasons.position_publisher_conflict, 2);
});

test('failed source collection clears pre-existing manually supplied quote and bars', async () => {
  const staleInput = { ...trade(), quote: { bid: 6010, ask: 6011, time: stamp(), quality: 'executable' }, bars: [{ time: stamp() }] };
  const noKey = await fetchDatabentoFuturesDayMarketData([staleInput], { now });
  const noReplay = await fetchDatabentoFuturesDayMarketData([staleInput], { ...settings, connect: feed([mapping(), ...minuteBars(), quote()]) });
  for (const result of [noKey, noReplay]) { assert.equal(result.rows[0].quote, null); assert.deepEqual(result.rows[0].bars, []); }
  assert.ok(noReplay.rows[0].liveDataReasons.includes('provider_replay_incomplete'));
});
