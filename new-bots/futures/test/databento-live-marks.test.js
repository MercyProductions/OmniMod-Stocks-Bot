import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fetchDatabentoFuturePositionMarks } from '../src/databentoLiveMarks.js';

const now = Date.parse('2026-09-29T15:00:00.000Z');
const makeOrder = (overrides = {}) => ({ orderId: 'futures-open-1', owner: 'futures', assetClass: 'future', status: 'open',
  instrumentKey: 'CME_ESZ6', units: 2, multiplier: 50, future: { contractId: 'CME_ESZ6', providerRawSymbol: 'ESZ6', expiry: '2026-12-18T14:30:00.000Z',
  tickSize: 0.25, multiplier: 50, activeContract: true, contractSpecVerified: true, specSource: 'https://example.test/fixture-contract', specVerifiedAt: new Date(now - 86_400_000).toISOString() },
  ...overrides });

const mapping = { hd: { rtype: 22, publisher_id: 0, instrument_id: 123 }, stype_in_symbol: 'ESZ6', stype_out_symbol: 'ESZ6', start_ts: null, end_ts: null };

class FakeSocket extends EventEmitter {
  writes = [];
  destroyed = false;
  write(value) {
    this.writes.push(value);
    if (value.startsWith('auth=')) queueMicrotask(() => this.emit('data', Buffer.from('success=1|session_id=1\n')));
    if (value === 'start_session=0\n') queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify(mapping) + '\n' + JSON.stringify({ hd: { rtype: 1, publisher_id: 1, instrument_id: 123, ts_event: new Date(now - 300).toISOString() }, flags: 128,
      ts_recv: new Date(now - 300).toISOString(), ts_out: new Date(now - 100).toISOString(),
      levels: [{ bid_px: '5000.00', ask_px: '5000.25', bid_sz: 5, ask_sz: 4 }] }) + '\n')));
    return true;
  }
  destroy() { this.destroyed = true; }
  setTimeout() {}
}

test('Databento live mark adapter authenticates by challenge and consumes fresh MBP-1 top of book', async () => {
  let socket;
  const metrics = [];
  const result = await fetchDatabentoFuturePositionMarks([makeOrder(), { ...makeOrder({ orderId: 'other', owner: 'stocks', assetClass: 'stock' }) }], {
    apiKey: 'db-test-key-mNUM6', now, metrics, connect: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('data', Buffer.from('lsg_version=0.2.0\ncram=test-challenge\n')));
      return socket;
    },
  });
  assert.equal(result.marks.length, 1);
  assert.deepEqual(result.marks[0], { orderId: 'futures-open-1', quote: { bid: 5000, ask: 5000.25, time: new Date(now - 300).toISOString(), quality: 'executable' }, sessionOpen: false });
  assert.ok(socket.writes.some((line) => line === `auth=${createHash('sha256').update('test-challenge|db-test-key-mNUM6').digest('hex')}-mNUM6|dataset=GLBX.MDP3|encoding=json|compression=none|ts_out=1|pretty_px=1|pretty_ts=1|heartbeat_interval_s=10|slow_reader_behavior=warn\n`));
  assert.ok(socket.writes.includes('schema=mbp-1|stype_in=raw_symbol|symbols=ESZ6|id=1\n'));
  assert.equal(socket.destroyed, true);
  assert.equal(metrics[0].status, 200);
  assert.equal(metrics[0].quotedSymbols, 1);
});

test('Databento live marks fail closed on missing credentials, contract identity or aggregate displayed size', async () => {
  let connections = 0;
  const connect = () => { connections += 1; throw new Error('must not connect'); };
  const noKey = await fetchDatabentoFuturePositionMarks([makeOrder()], { now, connect });
  const noSpec = await fetchDatabentoFuturePositionMarks([makeOrder({ future: {} })], { apiKey: 'test-key', now, connect });
  assert.equal(noKey.diagnostics.status, 'credentials_missing');
  assert.equal(noSpec.diagnostics.status, 'contract_metadata_unavailable');
  assert.equal(connections, 0);
  const result = await fetchDatabentoFuturePositionMarks([makeOrder({ units: 2 }), makeOrder({ orderId: 'futures-open-2', units: 2 })], {
    apiKey: 'test-key', now, timeoutMs: 1_000, connect: () => {
      const socket = new FakeSocket();
      socket.write = function (value) {
        this.writes.push(value);
        if (value.startsWith('auth=')) queueMicrotask(() => this.emit('data', Buffer.from('success=1|session_id=1\n')));
        if (value === 'start_session=0\n') queueMicrotask(() => this.emit('data', Buffer.from(JSON.stringify(mapping) + '\n' + JSON.stringify({ hd: { rtype: 1, publisher_id: 1, instrument_id: 123, ts_event: new Date(now - 300).toISOString() }, flags: 128,
          ts_recv: new Date(now - 300).toISOString(), ts_out: new Date(now - 100).toISOString(), levels: [{ bid_px: '5000', ask_px: '5000.25', bid_sz: 3, ask_sz: 3 }] }) + '\n')));
        return true;
      };
      queueMicrotask(() => socket.emit('data', Buffer.from('lsg_version=0.2.0\ncram=test\n')));
      return socket;
    },
  });
  assert.equal(result.marks.length, 0);
  assert.equal(result.diagnostics.rejectionReasons.top_of_book_size_below_position, 2);
});

test('Databento position marks require a credential-free HTTPS contract source and strict fresh timestamp', async () => {
  let connections = 0;
  const connect = () => { connections++; throw new Error('invalid contracts must not connect'); };
  const insecureSource = await fetchDatabentoFuturePositionMarks([makeOrder({ future: { ...makeOrder().future, specSource: 'http://example.test/spec' } })], {
    apiKey: 'test-key', now, connect,
  });
  const malformedTimestamp = await fetchDatabentoFuturePositionMarks([makeOrder({ future: { ...makeOrder().future, specVerifiedAt: '2026-09-28 15:00:00' } })], {
    apiKey: 'test-key', now, connect,
  });
  assert.equal(insecureSource.diagnostics.rejectionReasons.position_contract_source_not_verified_https, 1);
  assert.equal(malformedTimestamp.diagnostics.rejectionReasons.position_contract_verification_time_invalid_or_stale, 1);
  assert.equal(connections, 0);
});

test('Futures pending-entry marks require the same still-current reviewed exchange session', async () => {
  const entrySession = { marketDate: '2026-09-29', timeZone: 'America/Chicago',
    openTime: '2026-09-29T13:30:00Z', closeTime: '2026-09-29T20:00:00Z',
    source: 'https://example.test/exchange-session', reviewedAt: new Date(now - 10000).toISOString() };
  for (const [session, expected] of [
    [entrySession, true], [null, false], [{ ...entrySession, source: '' }, false],
    [{ ...entrySession, reviewedAt: new Date(now - 2 * 86400000).toISOString() }, false],
    [{ ...entrySession, closeTime: new Date(now).toISOString() }, false],
    [{ ...entrySession, openTime: new Date(now + 1000).toISOString() }, false],
    [{ ...entrySession, marketDate: '2026-09-30' }, false],
  ]) {
    const result = await fetchDatabentoFuturePositionMarks([makeOrder({ status: 'reserved', sessionDate: '2026-09-29',
      future: { ...makeOrder().future, entrySession: session } })], {
      apiKey: 'fixture-key', now, clock: () => now, connect: () => {
        const socket = new FakeSocket(); queueMicrotask(() => socket.emit('data', Buffer.from('lsg_version=0.2.0\ncram=test\n'))); return socket;
      },
    });
    assert.equal(result.marks.length, 1, 'quote remains available for exits even without entry clearance');
    assert.equal(result.marks[0].sessionOpen, expected);
  }
});
