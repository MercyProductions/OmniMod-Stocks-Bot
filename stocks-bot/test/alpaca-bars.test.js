import test from 'node:test';
import assert from 'node:assert/strict';
import { alpacaBarsToChartResult, fetchAlpacaSymbol } from '../src/stocksData.js';

function rows(count, start, stepMs) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.1;
    return { t: new Date(start + index * stepMs).toISOString(), o: close - 0.05, h: close + 0.1, l: close - 0.1, c: close, v: 1000 };
  });
}

test('Alpaca bars normalize into chronological feature input', () => {
  const result = alpacaBarsToChartResult({ bars: { XYZ: rows(2, Date.parse('2026-09-28T14:30:00Z'), 300_000).reverse() } }, 'XYZ');
  assert.deepEqual(result.timestamp, [Date.parse('2026-09-28T14:30:00Z') / 1000, Date.parse('2026-09-28T14:35:00Z') / 1000]);
  assert.deepEqual(result.indicators.quote[0].close, [100, 100.1]);
  assert.equal(result.meta.currency, 'USD');
});

test('Stocks deep analysis requests authenticated Alpaca intraday and split-adjusted daily bars', async () => {
  const now = new Date('2026-09-29T15:00:00Z'), requests = [];
  const fetcher = async (url, init) => {
    const parsed = new URL(url); requests.push({ parsed, init });
    const timeframe = parsed.searchParams.get('timeframe');
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ bars: {
      XYZ: timeframe === '5Min' ? rows(24, now.getTime() - 24 * 300_000, 300_000) : rows(30, Date.parse('2026-08-01T13:30:00Z'), 86_400_000)
    } }) };
  };
  const asset = await fetchAlpacaSymbol('XYZ', null, 8, { keys: { alpaca_key_id: 'key', alpaca_secret_key: 'secret' }, feed: 'sip', fetcher, now });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ parsed }) => parsed.origin === 'https://data.alpaca.markets'));
  assert.deepEqual(requests.map(({ parsed }) => parsed.searchParams.get('timeframe')).sort(), ['1Day', '5Min']);
  assert.equal(requests.find(({ parsed }) => parsed.searchParams.get('timeframe') === '1Day').parsed.searchParams.get('adjustment'), 'split');
  assert.ok(requests.every(({ parsed }) => parsed.searchParams.get('feed') === 'sip'));
  assert.ok(requests.every(({ init }) => init.headers['APCA-API-KEY-ID'] === 'key' && init.headers['APCA-API-SECRET-KEY'] === 'secret'));
  assert.equal(asset.provider, 'Alpaca SIP');
  assert.equal(asset.intradayHistoryCount, 24);
  assert.equal(asset.dailyHistoryCount, 30);
});

test('Stocks Alpaca bar adapter feeds 429 cooldown and Retry-After into the shared credential gate', async () => {
  const now = new Date('2026-09-29T15:00:00Z');
  const gateCalls = [], deferred = [], delays = [];
  let intradayAttempts = 0;
  const requestGate = async (credential) => { gateCalls.push(credential); };
  requestGate.defer = (credential, delayMs) => deferred.push({ credential, delayMs });
  const fetcher = async (url) => {
    const parsed = new URL(url);
    const timeframe = parsed.searchParams.get('timeframe');
    if (timeframe === '5Min' && intradayAttempts++ === 0) {
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }), text: async () => 'rate limited' };
    }
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ bars: {
      XYZ: timeframe === '5Min' ? rows(24, now.getTime() - 24 * 300_000, 300_000) : rows(30, Date.parse('2026-08-01T13:30:00Z'), 86_400_000)
    } }) };
  };
  await fetchAlpacaSymbol('XYZ', null, 8, { keys: { alpaca_key_id: 'same-key', alpaca_secret_key: 'fixture-secret' },
    feed: 'sip', fetcher, now, requestGate, sleepFn: async (ms) => delays.push(ms) });
  assert.deepEqual(gateCalls, ['same-key', 'same-key', 'same-key']);
  assert.deepEqual(deferred, [{ credential: 'same-key', delayMs: 2_000 }]);
  assert.deepEqual(delays, [2_000]);
  assert.equal(JSON.stringify({ gateCalls, deferred }).includes('fixture-secret'), false);
});

test('missing Alpaca credentials fail without making an external request', async () => {
  let requested = false;
  await assert.rejects(() => fetchAlpacaSymbol('XYZ', null, 8, { keys: {}, fetcher: async () => { requested = true; } }), /credentials are required/);
  assert.equal(requested, false);
});
