import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { aggregateDatabentoFiveMinuteBars, fetchDatabentoFuturesDayMarketData } from '../src/databentoLiveSession.js';

const now = Date.parse('2026-09-29T15:10:04.000Z');
const session = { marketDate: '2026-09-29', openTime: '2026-09-29T15:00:00.000Z', closeTime: '2026-09-29T22:00:00.000Z' };
const trade = { contract: { symbol: 'ES', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', contractId: 'CME:ES:202612', exposureKey: 'SPY',
  expiry: '2026-12-18T14:30:00.000Z', contractSpecVerified: true, activeContract: true,
  specSource: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', specVerifiedAt: new Date(now - 60_000).toISOString(),
  multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5, initialMarginUsd: 1000, maintenanceMarginUsd: 900 }, session, trendBars: [{ time: '2026-09-27T00:00:00Z' }] };

function bars({ from = 0, to = 10, omit = [] } = {}) {
  return Array.from({ length: to - from }, (_, index) => from + index).filter((index) => !omit.includes(index)).map((index) => ({
    rtype: 33, publisher_id: 1, instrument_id: 123, raw_symbol: 'ESZ6', ts_event: new Date(Date.parse(session.openTime) + index * 60_000).toISOString(),
    open: String(6000 + index), high: String(6001 + index), low: String(5999 + index),
    close: String(6000.5 + index), volume: 10,
  }));
}
const mapping = { hd: { rtype: 22, publisher_id: 0, instrument_id: 123 }, stype_in_symbol: 'ESZ6', stype_out_symbol: 'ESZ6', start_ts: null, end_ts: null };
const quote = { hd: { rtype: 1, publisher_id: 1, instrument_id: 123, ts_event: new Date(now - 500).toISOString() }, flags: 128, ts_recv: new Date(now - 500).toISOString(), ts_out: new Date(now - 200).toISOString(),
  levels: [{ bid_px: 6010, ask_px: 6010.25, bid_sz: 10, ask_sz: 8 }] };

class FakeSocket extends EventEmitter {
  writes = [];
  destroyed = false;
  write(value) {
    this.writes.push(value);
    if (value.startsWith('auth=')) queueMicrotask(() => this.emit('data', Buffer.from('success=1|session_id=test\n')));
    if (value === 'start_session=0\n') queueMicrotask(() => this.emit('data', Buffer.from([
      mapping, ...bars(), { rtype: 23, code: 3, msg: 'Replay completed for ohlcv-1m' }, quote,
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')));
    return true;
  }
  setTimeout() { return this; }
  destroy() { this.destroyed = true; return this; }
}

test('Databento replay converts only complete contiguous 1m bars into session-aligned 5m bars', () => {
  const records = bars({ omit: [7] });
  const result = aggregateDatabentoFiveMinuteBars(records, 'ESZ6', session, { now });
  assert.equal(result.length, 1);
  assert.equal(result[0].time, session.openTime);
  assert.equal(result[0].volume, 50);
  assert.equal(result[0].open, 6000);
  assert.equal(result[0].close, 6004.5);
});

test('misaligned OHLCV interval timestamps cannot be floored into an apparently valid 5m bar', () => {
  const records = bars();
  records[0] = { ...records[0], ts_event: new Date(Date.parse(session.openTime) + 15_000).toISOString() };
  const result = aggregateDatabentoFiveMinuteBars(records, 'ESZ6', session, { now });
  assert.deepEqual(result.map((row) => row.time), [new Date(Date.parse(session.openTime) + 5 * 60_000).toISOString()]);
});

test('Live session authenticates, replays 1m bars, waits for replay completion, and emits fresh executable BBO', async () => {
  const socket = new FakeSocket(), metrics = [];
  const result = await fetchDatabentoFuturesDayMarketData([trade], {
    apiKey: 'test-api-key', now, clock: () => now, metrics, connect: () => {
      queueMicrotask(() => socket.emit('data', Buffer.from('cram=challenge\n')));
      return socket;
    }, timeoutMs: 100,
  });
  assert.ok(socket.writes.some((line) => line.startsWith('schema=ohlcv-1m|stype_in=raw_symbol|symbols=ESZ6|start=')));
  assert.ok(socket.writes.includes('schema=mbp-1|stype_in=raw_symbol|symbols=ESZ6|id=2\n'));
  assert.ok(socket.writes.indexOf('start_session=0\n') > socket.writes.findIndex((line) => line.startsWith('schema=mbp-1')));
  assert.equal(result.diagnostics.status, 'complete', JSON.stringify({ diagnostics: result.diagnostics, reasons: result.rows[0].liveDataReasons, quote: result.rows[0].quote, bars: result.rows[0].bars }));
  assert.equal(result.diagnostics.replayCompleted, true);
  assert.equal(result.rows[0].liveDataStatus, 'complete');
  assert.equal(result.rows[0].bars.length, 2);
  assert.deepEqual(result.rows[0].quote, { bid: 6010, ask: 6010.25, bidSize: 10, askSize: 8, time: new Date(now - 500).toISOString(), quality: 'executable' });
  assert.equal(result.rows[0].trendBars, trade.trendBars, 'operator-provided H1 history remains separate');
  assert.equal(metrics.length, 3);
  assert.equal(socket.destroyed, true);
});

test('an ErrorMsg code that overlaps SystemMsg ReplayCompleted is rejected, never treated as a completed replay', async () => {
  class ConnectionLimitSocket extends FakeSocket {
    write(value) {
      this.writes.push(value);
      if (value.startsWith('auth=')) queueMicrotask(() => this.emit('data', Buffer.from('success=1|session_id=test\n')));
      if (value === 'start_session=0\n') queueMicrotask(() => this.emit('data', Buffer.from([
        mapping, ...bars(), quote,
        { rtype: 21, code: 3, err: 'Connection limit exceeded' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n')));
      return true;
    }
  }
  const socket = new ConnectionLimitSocket();
  await assert.rejects(fetchDatabentoFuturesDayMarketData([trade], { apiKey: 'test-key', now, clock: () => now,
    connect: () => { queueMicrotask(() => socket.emit('data', Buffer.from('cram=challenge\n'))); return socket; }, timeoutMs: 100,
  }), /Connection limit exceeded/);
  assert.equal(socket.destroyed, true);
});

test('missing credentials, unverifiable contract identity, and out-of-window session fail closed without connecting', async () => {
  let connections = 0;
  const connect = () => { connections++; throw new Error('must not connect'); };
  const noKey = await fetchDatabentoFuturesDayMarketData([trade], { now, connect });
  assert.equal(noKey.rows[0].liveDataStatus, 'credentials_missing');
  const invalid = await fetchDatabentoFuturesDayMarketData([{ ...trade, contract: { ...trade.contract, contractSpecVerified: false } }], { apiKey: 'test', now, connect });
  assert.equal(invalid.rows[0].liveDataStatus, 'contract_or_session_unavailable');
  const old = await fetchDatabentoFuturesDayMarketData([{ ...trade, session: { ...session, openTime: new Date(now - 25 * 60 * 60_000).toISOString() } }], { apiKey: 'test', now, connect });
  assert.ok(old.rows[0].liveDataReasons.includes('session_open_outside_live_replay_window'));
  assert.equal(connections, 0);
});

test('stale active-contract specification is rejected before opening the live socket', async () => {
  let connections = 0;
  const stale = { ...trade, contract: { ...trade.contract, specVerifiedAt: new Date(now - 100 * 86_400_000).toISOString() } };
  const result = await fetchDatabentoFuturesDayMarketData([stale], { apiKey: 'test', now, connect: () => { connections++; throw new Error('must not connect'); } });
  assert.equal(connections, 0);
  assert.equal(result.rows[0].liveDataStatus, 'contract_or_session_unavailable');
  assert.ok(result.rows[0].liveDataReasons.includes('verified_active_contract_metadata_invalid'));
  assert.equal(result.diagnostics.eligible, 0);
  assert.equal(result.diagnostics.metadataRejected, 1);
  assert.equal(result.diagnostics.preflightRejectionReasons.contract_spec_stale, 1);
});

test('live feed reports metadata rejection counts and streams only independently verified rows', async () => {
  const socket = new FakeSocket();
  const stale = { ...trade, contract: { ...trade.contract, specVerifiedAt: new Date(now - 100 * 86_400_000).toISOString() } };
  const result = await fetchDatabentoFuturesDayMarketData([trade, stale], { apiKey: 'test', now, clock: () => now, connect: () => {
    queueMicrotask(() => socket.emit('data', Buffer.from('cram=challenge\n'))); return socket;
  }, timeoutMs: 100 });
  assert.equal(result.diagnostics.requested, 2);
  assert.equal(result.diagnostics.eligible, 1);
  assert.equal(result.diagnostics.metadataRejected, 1);
  assert.equal(result.rows[0].liveDataStatus, 'complete');
  assert.equal(result.rows[1].liveDataStatus, 'incomplete');
  assert.ok(result.rows[1].liveDataReasons.includes('verified_active_contract_metadata_invalid'));
  assert.equal(socket.writes.some((line) => line.startsWith('schema=ohlcv-1m|stype_in=raw_symbol|symbols=ESZ6|')), true);
  assert.equal(result.diagnostics.symbols, 1);
});

test('provider top-of-book with insufficient displayed size is not eligible live input', async () => {
  class ThinSocket extends FakeSocket {
    write(value) {
      if (value === 'start_session=0\n') {
        this.writes.push(value);
        queueMicrotask(() => this.emit('data', Buffer.from([mapping, ...bars(), { rtype: 23, code: 3 }, { ...quote, levels: [{ ...quote.levels[0], bid_sz: 0 }] }].map(JSON.stringify).join('\n') + '\n')));
        return true;
      }
      return super.write(value);
    }
  }
  const socket = new ThinSocket();
  const result = await fetchDatabentoFuturesDayMarketData([trade], { apiKey: 'key', now, clock: () => now, connect: () => {
    queueMicrotask(() => socket.emit('data', Buffer.from('cram=challenge\n'))); return socket;
  }, timeoutMs: 100 });
  assert.equal(result.rows[0].liveDataStatus, 'incomplete');
  assert.ok(result.rows[0].liveDataReasons.includes('fresh_executable_live_quote_unavailable'));
});

test('a replay timeout cannot label partially observed bars and an early quote as complete data', async () => {
  class IncompleteSocket extends FakeSocket {
    write(value) {
      if (value === 'start_session=0\n') {
        this.writes.push(value);
        queueMicrotask(() => this.emit('data', Buffer.from([mapping, ...bars(), quote].map(JSON.stringify).join('\n') + '\n')));
        return true;
      }
      return super.write(value);
    }
  }
  const socket = new IncompleteSocket();
  const result = await fetchDatabentoFuturesDayMarketData([trade], { apiKey: 'key', now, clock: () => now, timeoutMs: 40, connect: () => {
    queueMicrotask(() => socket.emit('data', Buffer.from('cram=challenge\n'))); return socket;
  } });
  assert.equal(result.diagnostics.status, 'partial');
  assert.equal(result.diagnostics.replayCompleted, false);
  assert.equal(result.rows[0].liveDataStatus, 'incomplete');
  assert.ok(result.rows[0].liveDataReasons.includes('provider_replay_incomplete'));
});
