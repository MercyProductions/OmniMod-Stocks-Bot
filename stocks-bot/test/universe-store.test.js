import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('point-in-time universe persists a baseline and reconstructable deltas', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const originalFetch = globalThis.fetch;
  const responses = [
    [
      { id: '1', symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true },
      { id: '2', symbol: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }
    ],
    [
      { id: '1', symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true },
      { id: '3', symbol: 'NVDA', name: 'Nvidia', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }
    ]
  ];
  globalThis.fetch = async () => {
    const body = responses.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const { captureUniverseSnapshot, reconstructUniverse } = await import('../src/universeStore.js');
    const keys = { alpaca_key_id: 'id', alpaca_secret_key: 'secret' };
    const first = await captureUniverseSnapshot('guild', keys, new Date('2026-07-20T15:00:00Z'));
    const second = await captureUniverseSnapshot('guild', keys, new Date('2026-07-21T15:00:00Z'));
    assert.equal(first.fullBaseline, true);
    assert.equal(second.fullBaseline, false);
    assert.deepEqual([...await reconstructUniverse('2026-07-20').then((rows) => [...rows.values()].map((row) => row.symbol))].sort(), ['AAPL', 'MSFT']);
    assert.deepEqual([...await reconstructUniverse('2026-07-21').then((rows) => [...rows.values()].map((row) => row.symbol))].sort(), ['AAPL', 'NVDA']);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('point-in-time universes are reconstructed independently per guild', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-guilds-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const originalFetch = globalThis.fetch;
  const responses = [
    [{ id: '1', symbol: 'AAA', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }],
    [{ id: '2', symbol: 'BBB', exchange: 'NYSE', status: 'active', class: 'us_equity', tradable: true }],
    [{ id: '1', symbol: 'AAA', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }],
    [{ id: '3', symbol: 'CCC', exchange: 'NYSE', status: 'active', class: 'us_equity', tradable: true }]
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) });
  try {
    const { captureUniverseSnapshot, reconstructUniverse } = await import('../src/universeStore.js');
    const keys = { alpaca_key_id: 'id', alpaca_secret_key: 'secret' };
    await captureUniverseSnapshot('guild-a', keys, new Date('2026-07-22T15:00:00Z'));
    await captureUniverseSnapshot('guild-b', keys, new Date('2026-07-22T15:00:00Z'));
    await captureUniverseSnapshot('guild-a', keys, new Date('2026-07-23T15:00:00Z'));
    await captureUniverseSnapshot('guild-b', keys, new Date('2026-07-23T15:00:00Z'));
    assert.deepEqual([...await reconstructUniverse('2026-07-23', 'guild-a').then((rows) => [...rows.values()].map((row) => row.symbol))], ['AAA']);
    assert.deepEqual([...await reconstructUniverse('2026-07-23', 'guild-b').then((rows) => [...rows.values()].map((row) => row.symbol))], ['CCC']);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('empty or malformed Alpaca universes cannot archive every prior symbol as removed', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-invalid-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const originalFetch = globalThis.fetch;
  const responses = [
    [{ id: '1', symbol: 'AAA', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }],
    [],
    { error: 'unexpected object instead of asset list' },
    [{ id: '1', symbol: 'AAA', status: 'active' }, { id: '1', symbol: 'BBB', status: 'active' }]
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) });
  try {
    const { captureUniverseSnapshot, reconstructUniverse } = await import('../src/universeStore.js');
    const keys = { alpaca_key_id: 'id', alpaca_secret_key: 'secret' };
    await captureUniverseSnapshot('guild', keys, new Date('2026-07-24T15:00:00Z'));
    await assert.rejects(captureUniverseSnapshot('guild', keys, new Date('2026-07-25T15:00:00Z')), /non-empty array/);
    await assert.rejects(captureUniverseSnapshot('guild', keys, new Date('2026-07-26T15:00:00Z')), /non-empty array/);
    await assert.rejects(captureUniverseSnapshot('guild', keys, new Date('2026-07-27T15:00:00Z')), /duplicate asset identity/);
    const reconstructed = await reconstructUniverse('2026-07-27', 'guild');
    assert.deepEqual([...reconstructed.values()].map((row) => row.symbol), ['AAA']);
    assert.equal(reconstructed.get('1').status, 'active');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('active-to-inactive Alpaca status transitions are archived without a false removal', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-status-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const originalFetch = globalThis.fetch;
  const responses = [
    [{ id: 'stable-id', symbol: 'AAA', exchange: 'NASDAQ', status: 'active', class: 'us_equity', tradable: true }],
    [{ id: 'stable-id', symbol: 'AAA', exchange: 'NASDAQ', status: 'inactive', class: 'us_equity', tradable: false }]
  ];
  globalThis.fetch = async (url) => {
    assert.match(String(url), /status=all/);
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) };
  };
  try {
    const { captureUniverseSnapshot, reconstructUniverse } = await import('../src/universeStore.js');
    const { readJsonLines } = await import('../src/researchStore.js');
    const keys = { alpaca_key_id: 'id', alpaca_secret_key: 'secret' };
    await captureUniverseSnapshot('guild', keys, new Date('2026-07-28T15:00:00Z'));
    const result = await captureUniverseSnapshot('guild', keys, new Date('2026-07-29T15:00:00Z'));
    assert.equal(result.activeAssets, 0);
    assert.equal(result.inactiveAssets, 1);
    const row = (await reconstructUniverse('2026-07-29', 'guild')).get('stable-id');
    assert.equal(row.status, 'inactive');
    const datedRows = await readJsonLines((await import('../src/storage.js')).paths.researchUniverse('2026-07-29'));
    assert.equal(datedRows.filter((item) => item.recordType === 'universe_asset' && item.action === 'remove').length, 0);
    assert.equal(datedRows.filter((item) => item.recordType === 'universe_snapshot')[0].inactiveAssets, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('Alpaca asset-master refresh retries bounded transient failures and records every attempt', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-retry-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const { captureUniverseSnapshot } = await import('../src/universeStore.js');
  const delays = [], metrics = { requests: [] };
  let calls = 0;
  try {
    const result = await captureUniverseSnapshot('guild', { alpaca_key_id: 'id', alpaca_secret_key: 'secret' },
      new Date('2026-07-30T15:00:00Z'), metrics, {
        sleepFn: async (ms) => delays.push(ms),
        fetcher: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }), text: async () => 'rate limited' };
          if (calls === 2) return { ok: false, status: 503, headers: new Headers(), text: async () => 'temporarily unavailable' };
          return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([
            { id: 'id-a', symbol: 'AAA', exchange: 'NASDAQ', status: 'active' }
          ]) };
        }
      });
    assert.equal(result.assetsReturned, 1);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [2_000, 2_000]);
    assert.deepEqual(metrics.requests.map((row) => row.status), [429, 503, 200]);
    assert.deepEqual(metrics.requests.map((row) => row.retry), [0, 1, 1]);
  } finally {
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});

test('Alpaca asset-master refresh does not retry permanent failures or long Retry-After values', async () => {
  const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-stocks-universe-no-retry-'));
  process.env.OMNIMOD_STOCKS_DATA_DIR = temporaryData;
  const { captureUniverseSnapshot } = await import('../src/universeStore.js');
  let calls = 0;
  try {
    await assert.rejects(captureUniverseSnapshot('guild', { alpaca_key_id: 'id', alpaca_secret_key: 'secret' },
      new Date('2026-07-31T15:00:00Z'), undefined, {
        sleepFn: async () => assert.fail('permanent HTTP failure must not be retried'),
        fetcher: async () => { calls += 1; return { ok: false, status: 403, headers: new Headers(), text: async () => 'forbidden' }; }
      }), /HTTP 403/);
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(captureUniverseSnapshot('guild', { alpaca_key_id: 'id', alpaca_secret_key: 'secret' },
      new Date('2026-08-01T15:00:00Z'), undefined, {
        sleepFn: async () => assert.fail('long Retry-After must not be shortened'),
        fetcher: async () => { calls += 1; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '11' }), text: async () => 'rate limited' }; }
      }), /HTTP 429/);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(temporaryData, { recursive: true, force: true });
  }
});
