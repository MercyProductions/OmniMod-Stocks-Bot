import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAlpacaCallDividendScreen } from '../src/alpacaDividendScreen.js';
import { createAlpacaRequestGate } from '../../shared/alpacaRequestGate.js';

const rows = [
  { signal: { underlyingSymbol: 'SPY', direction: 'long', sessionDate: '2026-09-29' }, chain: { expiry: '2026-10-02' } },
  { signal: { underlyingSymbol: 'QQQ', direction: 'short', sessionDate: '2026-09-29' }, chain: { expiry: '2026-10-02' } },
];
const response = (body, status = 200, headers = new Headers()) => ({ ok: status === 200, status, headers, json: async () => body });

test('Alpaca cash-dividend screen records an ex-date as a positive-only call veto', async () => {
  const requests = [], metrics = [];
  const result = await fetchAlpacaCallDividendScreen(rows, { key: 'test-key', secret: 'test-secret', metrics,
    fetcher: async (url, options) => { requests.push({ url: new URL(url), options }); return response({ cash_dividends: [
      { symbol: 'SPY', ex_date: '2026-10-01', rate: '0.10' },
    ], next_page_token: null }); } });
  assert.equal(result.diagnostics.matches, 1);
  assert.equal(result.rows[0].assignmentDataStatus, 'event_detected');
  assert.equal(result.rows[0].signal.corporateActionScreenStatus, 'pagination_complete');
  assert.equal(result.rows[1].signal.corporateActionScreenStatus, undefined, 'short exposure is not gated on short-call assignment risk');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('types'), 'cash_dividend');
  assert.equal(requests[0].url.searchParams.get('data_quality'), 'all');
  assert.equal(requests[0].url.searchParams.get('symbols'), 'SPY');
  assert.equal(requests[0].options.headers['APCA-API-SECRET-KEY'], 'test-secret');
  assert.equal(JSON.stringify(metrics).includes('test-secret'), false);
  assert.deepEqual(result.rows[0].signal.corporateActionDividendVeto, { provider: 'Alpaca', eventType: 'cash_dividend', exDate: '2026-10-01' });
});

test('empty corporate-action response is not converted to assignment clearance', async () => {
  const result = await fetchAlpacaCallDividendScreen([rows[0]], { key: 'k', secret: 's',
    fetcher: async () => response({ cash_dividends: [], next_page_token: null }) });
  assert.equal(result.rows[0].assignmentDataStatus, 'no_event_returned_not_clearance');
  assert.equal(result.rows[0].signal.corporateActionScreenStatus, 'pagination_complete');
  assert.equal(result.rows[0].signal.optionAssignmentReview, undefined);
  assert.match(result.diagnostics.note, /not dividend clearance/);
});

test('provider failures, missing keys, malformed rows, and incomplete pagination do not produce a clear screen', async () => {
  const noKeys = await fetchAlpacaCallDividendScreen([rows[0]], { fetcher: async () => { throw new Error('must not call'); } });
  assert.equal(noKeys.rows[0].signal.corporateActionScreenStatus, 'credentials_missing');
  const failed = await fetchAlpacaCallDividendScreen([rows[0]], { key: 'k', secret: 's', retrySleep: async () => {}, random: () => 0,
    fetcher: async () => response({}, 503) });
  assert.equal(failed.rows[0].signal.corporateActionScreenStatus, 'provider_error');
  const malformed = await fetchAlpacaCallDividendScreen([rows[0]], { key: 'k', secret: 's', fetcher: async () => response({ cash_dividends: [{}] }) });
  assert.equal(malformed.rows[0].signal.corporateActionScreenStatus, 'incomplete_records');
  let pages = 0;
  const truncated = await fetchAlpacaCallDividendScreen([rows[0]], { key: 'k', secret: 's', maxPages: 1,
    fetcher: async () => { pages++; return response({ cash_dividends: [], next_page_token: 'next' }); } });
  assert.equal(pages, 1);
  assert.equal(truncated.rows[0].signal.corporateActionScreenStatus, 'pagination_incomplete');
});

test('Alpaca corporate-action read retries a transient 429 and retains attempt/quota telemetry', async () => {
  const metrics = [], waits = [];
  let calls = 0;
  let now = 1800000000000;
  const sleep = async ms => { waits.push(ms); now += ms; };
  const result = await fetchAlpacaCallDividendScreen([rows[0]], { key: 'k', secret: 's', metrics,
    retrySleep: sleep, clock: () => now, requestGate: createAlpacaRequestGate({ now: () => now, sleep }), random: () => 0,
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? response({}, 429, new Headers({ 'Retry-After': '0.25', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0' }))
        : response({ cash_dividends: [], next_page_token: null }, 200, new Headers({ 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150' }));
    } });
  assert.equal(result.rows[0].assignmentDataStatus, 'no_event_returned_not_clearance');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(metrics.map((row) => row.attempt), [1, 2]);
  assert.equal(metrics[0].status, 429);
  assert.equal(metrics[0].retryDelayMs, 250);
  assert.equal(metrics[0].rateLimit.remaining, 0);
  assert.equal(JSON.stringify(metrics).includes('secret'), false);
});
