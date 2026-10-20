import test from 'node:test';
import assert from 'node:assert/strict';
import { createForexRequestGate, requestForexJson } from '../src/providerRequest.js';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('an idle request gate reports no cooldown even if the wall clock advances during bookkeeping', async () => {
  let tick = 100;
  const gate = createForexRequestGate({ now: () => tick++, sleep: async () => assert.fail('idle gate must not sleep') });
  assert.deepEqual(await gate('OANDA practice'), { cooldownDelayMs: 0 });
});

test('records only sanitized provider operation, latency and status on success', async () => {
  const metrics = [];
  const ticks = [100, 108];
  let requestOptions;
  const result = await requestForexJson('https://practice.example/v3/accounts/secret-account/pricing', {
    operation: 'pricing', metrics, clock: () => ticks.shift(), fetcher: async (_url, options) => { requestOptions = options; return response({ prices: [] }); },
  });
  assert.deepEqual(result, { prices: [] });
  assert.equal(requestOptions.headers.accept, 'application/json');
  assert.deepEqual(metrics, [{ provider: 'OANDA practice', operation: 'pricing', status: 200, requestStartedAt: 100, latencyMs: 8, attempt: 1, cooldownDelayMs: 0 }]);
});

test('records provider HTTP failures without swallowing them', async () => {
  const metrics = [];
  let clock = 1;
  let thrown;
  const waits = [];
  try {
    await requestForexJson('https://practice.example/candles', {
      operation: 'candles-M15', instrument: 'eur_usd', metrics, clock: () => clock++,
      sleep: async (ms) => waits.push(ms), random: () => 0, requestGate: null, fetcher: async () => response({}, 429),
    });
  } catch (error) { thrown = error; }
  assert.match(thrown.message, /HTTP 429/);
  assert.equal(metrics[0].status, 429);
  assert.equal(metrics[0].operation, 'candles-M15');
  assert.equal(metrics[0].instrument, 'EUR_USD');
  assert.equal(thrown.providerOperation, 'candles-M15');
  assert.equal(thrown.providerInstrument, 'EUR_USD');
  assert.equal(metrics[0].latencyMs, 2);
  assert.deepEqual(waits, [500, 1_000]);
  assert.equal(metrics.length, 3);
  assert.equal(JSON.stringify(metrics).includes('practice.example'), false);
});

test('provider request context is normalized and limited to currency-pair identifiers', async () => {
  const metrics = [];
  await requestForexJson('https://practice.example/pricing', {
    operation: 'quote-currency-conversion-USD_JPY', instrument: 'usd_jpy', relatedInstrument: 'eur_usd',
    instruments: ['USD_JPY', 'invalid', 'EUR_USD'], metrics, fetcher: async () => response({ prices: [] }),
  });
  assert.equal(metrics[0].instrument, 'USD_JPY');
  assert.equal(metrics[0].relatedInstrument, 'EUR_USD');
  assert.deepEqual(metrics[0].instruments, ['USD_JPY', 'EUR_USD']);
  assert.equal(JSON.stringify(metrics).includes('invalid'), false);
});

test('captures provider-supplied quota headers without including request credentials', async () => {
  const metrics = [];
  await requestForexJson('https://practice.example/pricing', {
    operation: 'pricing', metrics,
    fetcher: async () => ({ ...response({ prices: [] }), headers: new Headers({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '45' }) }),
  });
  assert.equal(metrics[0].rateLimit.limit, 60);
  assert.equal(metrics[0].rateLimit.utilizationPct, 25);
  assert.equal(JSON.stringify(metrics).includes('practice.example'), false);
});

test('records network and malformed JSON failures with bounded error text', async () => {
  const metrics = [];
  let clock = 5;
  await assert.rejects(requestForexJson('https://practice.example/pricing', {
    operation: 'pricing', metrics, clock: () => clock++, fetcher: async () => { throw new Error('socket closed'); },
  }), /socket closed/);
  assert.equal(metrics[0].status, 0);
  assert.match(metrics[0].error, /socket closed/);

  const malformed = [];
  await assert.rejects(requestForexJson('https://practice.example/pricing', {
    operation: 'pricing', metrics: malformed, fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new Error('invalid json'); } }),
  }), /invalid json/);
  assert.equal(malformed[0].status, 200);
});

test('honors OANDA rate reset, defers long waits, and does not retry non-transient HTTP errors', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  const waits = [];
  const metrics = [];
  const requestGate = createForexRequestGate({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  const value = await requestForexJson('https://practice.example/pricing', {
    operation: 'pricing', metrics, clock: () => now, random: () => 0,
    sleep: async (ms) => { waits.push(ms); now += ms; }, requestGate,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? { ...response({}, 429), headers: new Headers({ 'X-RateLimit-Reset': String((now + 1_500) / 1000) }) }
        : response({ prices: [] });
    },
  });
  assert.deepEqual(value, { prices: [] });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_500]);
  assert.deepEqual(metrics.map((row) => row.status), [429, 200]);
  assert.equal(metrics[0].retryDelayMs, 1_500);

  calls = 0;
  const deferred = [];
  await assert.rejects(requestForexJson('https://practice.example/pricing', {
    metrics: deferred, maxRetryWaitMs: 1, fetcher: async () => {
      calls += 1;
      return { ...response({}, 429), headers: new Headers({ 'Retry-After': '30' }) };
    }, requestGate: createForexRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } }),
  }), /Retry deferred/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(requestForexJson('https://practice.example/pricing', {
    fetcher: async () => { calls += 1; return response({}, 403); },
    requestGate: createForexRequestGate(),
  }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('an OANDA 429 cools down subsequent sibling requests and exposes wait telemetry', async () => {
  let now = 100_000;
  const waits = [];
  const gate = createForexRequestGate({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  await gate('OANDA practice');
  gate.defer('OANDA practice', 1_500);
  const metrics = [];
  await requestForexJson('https://practice.example/v3/accounts/x/pricing', {
    provider: 'OANDA practice', operation: 'pricing', metrics, clock: () => now, requestGate: gate,
    fetcher: async () => response({ prices: [] }),
  });
  assert.deepEqual(waits, [1_500]);
  assert.equal(metrics[0].cooldownDelayMs, 1_500);
});
