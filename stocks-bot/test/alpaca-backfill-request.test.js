import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAlpacaBackfillJson } from '../src/alpacaBackfillRequest.js';
import { createAlpacaRequestGate } from '../src/alpacaRequestGate.js';

const credentials = { keyId: 'fixture-key', secretKey: 'fixture-secret' };

test('Alpaca historical backfill honors Retry-After then returns the next successful page', async () => {
  let requests = 0;
  let now = 1_800_000_000_000;
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); now += ms; };
  const payload = await requestAlpacaBackfillJson('https://data.example.test/bars', {
    ...credentials, now: () => now,
    sleep, requestGate: createAlpacaRequestGate({ now: () => now, sleep }),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['APCA-API-KEY-ID'], credentials.keyId);
      assert.equal(options.headers['APCA-API-SECRET-KEY'], credentials.secretKey);
      requests += 1;
      if (requests === 1) return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) };
      return { ok: true, status: 200, json: async () => ({ bars: { AAPL: [] } }) };
    },
  });
  assert.deepEqual(waits, [2_000]);
  assert.equal(requests, 2);
  assert.deepEqual(payload, { bars: { AAPL: [] } });
});

test('Alpaca historical backfill does not retry before a provider reset beyond its wait bound', async () => {
  let requests = 0;
  const now = 1_800_000_000_000;
  await assert.rejects(requestAlpacaBackfillJson('https://data.example.test/bars', {
    ...credentials, now: () => now, maxRetryWaitMs: 10_000,
    requestGate: createAlpacaRequestGate({ now: () => now }),
    sleep: async () => assert.fail('long provider reset must not be shortened'),
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '60' }) };
    },
  }), /HTTP 429/);
  assert.equal(requests, 1);
});

test('Alpaca historical backfill fails permanently on 403 and malformed JSON', async () => {
  let requests = 0;
  await assert.rejects(requestAlpacaBackfillJson('https://data.example.test/bars', {
    ...credentials,
    fetchImpl: async () => { requests += 1; return { ok: false, status: 403 }; },
    sleep: async () => assert.fail('403 must not be retried'),
  }), /HTTP 403/);
  await assert.rejects(requestAlpacaBackfillJson('https://data.example.test/bars', {
    ...credentials,
    fetchImpl: async () => { requests += 1; return { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }; },
    sleep: async () => assert.fail('malformed success payload must not be retried'),
  }), /invalid JSON/);
  assert.equal(requests, 2);
});
