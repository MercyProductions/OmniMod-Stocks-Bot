import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendKrakenWebsocketSmokeHistory, buildKrakenWebsocketSmokeHistoryRow } from '../src/krakenWebsocketSmokeHistory.js';

const payload = (checkedAt) => ({
  checkedAt, status: 'PASS_PROVIDER_AGGREGATION_ONLY', elapsedMs: 2300,
  observations: [{ symbol: 'BTC', providerTimestampPresent: true, quoteValid: true, ageMs: 220,
    acceptedProviders: ['Binance', 'Coinbase', 'Kraken'], providerCount: 3, krakenAccepted: true,
    conflicted: false, rejectionCounts: {}, providerErrorNames: [] }],
});

test('Kraken WebSocket smoke history keeps provider-health evidence without retaining quote values or error text', () => {
  const input = payload('2026-09-30T14:50:45Z');
  input.secret = 'never-store-this';
  input.observations[0].price = 12345;
  input.observations[0].providerErrorNames = ['private-token-value'];
  const row = buildKrakenWebsocketSmokeHistoryRow(input);
  assert.equal(row.status, 'PASS_PROVIDER_AGGREGATION_ONLY');
  assert.deepEqual(row.symbols[0].acceptedProviders, ['Binance', 'Coinbase', 'Kraken']);
  assert.equal(row.symbols[0].providerErrorCount, 1);
  assert.equal(JSON.stringify(row).includes('never-store-this'), false);
  assert.equal(JSON.stringify(row).includes('private-token-value'), false);
  assert.equal(JSON.stringify(row).includes('12345'), false);
});

test('Kraken WebSocket smoke journal appends repeated observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-kraken-smoke-'));
  const path = join(directory, 'history.ndjson');
  try {
    await appendKrakenWebsocketSmokeHistory(buildKrakenWebsocketSmokeHistoryRow(payload('2026-09-30T14:50:45Z')), { path });
    await appendKrakenWebsocketSmokeHistory(buildKrakenWebsocketSmokeHistoryRow(payload('2026-09-30T14:55:45Z')), { path });
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.checkedAt), ['2026-09-30T14:50:45.000Z', '2026-09-30T14:55:45.000Z']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Kraken WebSocket smoke history rejects malformed observations', () => {
  assert.throws(() => buildKrakenWebsocketSmokeHistoryRow({}), /valid Kraken WebSocket smoke/);
});
