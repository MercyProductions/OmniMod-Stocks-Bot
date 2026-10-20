import test from 'node:test';
import assert from 'node:assert/strict';
import { clearCryptoMacroCalendarCache, loadCryptoMacroCalendar } from '../src/cryptoMacroCalendar.js';

const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test('manual/default mode does not make a calendar request', async () => {
  let requests = 0;
  const result = await loadCryptoMacroCalendar({ fetcher: async () => { requests += 1; } });
  assert.equal(requests, 0);
  assert.equal(result.diagnostics.status, 'not_configured');
  assert.deepEqual(result.events, []);
  const skipped = await loadCryptoMacroCalendar({ enabled: false, skipReason: 'no_discovery_candidates', fetcher: async () => { requests += 1; } });
  assert.equal(skipped.diagnostics.status, 'no_discovery_candidates');
  assert.equal(requests, 0);
});

test('enabled calendar without credentials fails closed for new crypto candidates', async () => {
  let requests = 0;
  const result = await loadCryptoMacroCalendar({ enabled: true, token: '', now: new Date('2026-09-29T14:00:00Z'),
    fetcher: async () => { requests += 1; } });
  assert.equal(requests, 0);
  assert.equal(result.diagnostics.status, 'credentials_missing');
  assert.equal(result.events[0].symbol, '*');
  assert.equal(result.events[0].severity, 'block');
});

test('US medium/high scheduled releases create a non-directional global veto', async () => {
  let requestedUrl;
  const result = await loadCryptoMacroCalendar({ enabled: true, token: 'local-test-token', now: new Date('2026-09-29T14:00:00Z'),
    fetcher: async (url, options) => { requestedUrl = new URL(url); assert.equal(options.headers['X-Finnhub-Token'], 'local-test-token'); return response({ economicCalendar: [
      { date: '2026-09-29', country: 'US', event: 'FOMC decision', impact: 'high', time: '2026-09-29 18:00:00' },
      { date: '2026-09-29', country: 'GB', event: 'UK data', impact: 'high', time: '2026-09-29 10:00:00' }
    ] }); } });
  assert.equal(requestedUrl.searchParams.has('token'), false);
  assert.equal(result.diagnostics.reviewStatus, 'blocked');
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].reason, /scheduled release/);
  assert.equal(result.events[0].direction, 'unknown');
});

test('no medium/high US releases returns clear; provider failure fails closed', async () => {
  clearCryptoMacroCalendarCache();
  const clear = await loadCryptoMacroCalendar({ enabled: true, token: 'test', now: new Date('2026-09-29T14:00:00Z'),
    fetcher: async () => response({ economicCalendar: [{ date: '2026-09-29', country: 'US', event: 'Low impact', impact: 'low' }] }) });
  assert.equal(clear.diagnostics.reviewStatus, 'clear');
  assert.deepEqual(clear.events, []);
  const failed = await loadCryptoMacroCalendar({ enabled: true, token: 'provider-failure-test', now: new Date('2026-09-29T14:00:00Z'),
    fetcher: async () => response({}, 503) });
  assert.equal(failed.diagnostics.status, 'provider_error');
  assert.equal(failed.events[0].severity, 'block');
  assert.doesNotMatch(JSON.stringify(failed.diagnostics), /test/);
});

test('calendar response is cached for the scan window and expires explicitly', async () => {
  clearCryptoMacroCalendarCache();
  let requests = 0;
  let clock = 10_000;
  const options = { enabled: true, token: 'cache-test', now: new Date('2026-09-30T14:00:00Z'), clock: () => clock,
    successTtlMs: 60_000, fetcher: async () => { requests += 1; return response({ economicCalendar: [] }); } };
  const first = await loadCryptoMacroCalendar(options);
  const second = await loadCryptoMacroCalendar(options);
  assert.equal(first.diagnostics.cache, 'miss');
  assert.equal(second.diagnostics.cache, 'hit');
  assert.equal(requests, 1);
  clock += 60_001;
  await loadCryptoMacroCalendar(options);
  assert.equal(requests, 2);
  clearCryptoMacroCalendarCache();
});

test('concurrent guild scans coalesce the same calendar request', async () => {
  clearCryptoMacroCalendarCache();
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = { enabled: true, token: 'coalesce-test', now: new Date('2026-10-01T14:00:00Z'),
    fetcher: async () => { requests += 1; await gate; return response({ economicCalendar: [] }); } };
  const first = loadCryptoMacroCalendar(options);
  while (!requests) await new Promise((resolve) => setImmediate(resolve));
  const second = loadCryptoMacroCalendar(options);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(a.diagnostics.cache, 'miss');
  assert.equal(b.diagnostics.cache, 'coalesced');
  clearCryptoMacroCalendarCache();
});
