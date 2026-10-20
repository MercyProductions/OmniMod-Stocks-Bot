import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordTokenSupplySnapshots } from '../src/tokenSupplyJournal.js';

function context({ observedAt, source = 'CoinGecko demo', circulating = 100, total = 120, assetId = 'example-token', capture = true } = {}) {
  return { capture, result: { assetId, symbol: 'EXT', supplySnapshot: { circulating, total, maximum: 200,
    marketCapUsd: 10_000, fullyDilutedValuationUsd: 20_000, source, observedAt } } };
}

test('crypto supply history records one provider snapshot per asset/day and computes descriptive changes', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-supply-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const guildId = '123456789012345678';
  const firstAt = '2025-01-01T12:00:00.000Z';
  const first = await recordTokenSupplySnapshots(guildId, [context({ observedAt: firstAt })], { dataDir, now: firstAt });
  assert.equal(first.recorded, 1);
  assert.equal(first.byAssetId['example-token'].samples, 1);
  const duplicate = await recordTokenSupplySnapshots(guildId, [context({ observedAt: '2025-01-01T13:00:00.000Z', circulating: 115 })],
    { dataDir, now: '2025-01-01T13:00:00.000Z' });
  assert.equal(duplicate.recorded, 0);
  assert.equal(duplicate.byAssetId['example-token'].latest.circulatingSupply, 100);
  const laterAt = '2025-02-01T12:00:00.000Z';
  const later = await recordTokenSupplySnapshots(guildId, [context({ observedAt: laterAt, circulating: 110, total: 132 })], { dataDir, now: laterAt });
  assert.equal(later.recorded, 1);
  const change = later.byAssetId['example-token'].changes.find((row) => row.targetDays === 30);
  assert.equal(change.elapsedDays, 31);
  assert.ok(Math.abs(change.circulatingChangePct - 10) < 1e-9);
  assert.ok(Math.abs(change.totalChangePct - 10) < 1e-9);
  assert.equal(later.byAssetId['example-token'].provider, 'CoinGecko');
});

test('crypto supply history never mixes providers and ignores stale or untrusted snapshots', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-supply-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stale = context({ observedAt: '2025-01-01T00:00:00.000Z' });
  const untrusted = context({ observedAt: '2025-01-02T00:00:00.000Z', source: 'unknown provider' });
  const result = await recordTokenSupplySnapshots('123456789012345678', [stale, untrusted], { dataDir, now: '2025-02-01T00:00:00.000Z' });
  assert.equal(result.recorded, 0);
  assert.equal(result.byAssetId['example-token'].samples, 0);
  await assert.rejects(recordTokenSupplySnapshots('invalid', [], { dataDir, now: '2025-02-01T00:00:00.000Z' }), /server id/);
});

test('365-day supply evidence includes an annualized equivalent only from a long observed interval', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-supply-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const guildId = '123456789012345678';
  const firstAt = '2025-01-01T12:00:00.000Z';
  await recordTokenSupplySnapshots(guildId, [context({ observedAt: firstAt })], { dataDir, now: firstAt });
  const latestAt = '2026-01-01T12:00:00.000Z';
  const result = await recordTokenSupplySnapshots(guildId, [context({ observedAt: latestAt, circulating: 110, total: 144 })], { dataDir, now: latestAt });
  const annual = result.byAssetId['example-token'].changes.find((row) => row.targetDays === 365);
  assert.equal(annual.elapsedDays, 365);
  assert.ok(Math.abs(annual.circulatingChangePct - 10) < 1e-9);
  assert.ok(Math.abs(annual.totalChangePct - 20) < 1e-9);
  assert.ok(annual.annualizedCirculatingChangePct > 10 && annual.annualizedCirculatingChangePct < 10.02);
  assert.ok(annual.annualizedTotalChangePct > 20 && annual.annualizedTotalChangePct < 20.02);
});

test('a missing circulating-supply field does not erase the valid total-supply history', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-supply-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const guildId = '123456789012345678';
  const firstAt = '2025-01-01T12:00:00.000Z';
  await recordTokenSupplySnapshots(guildId, [context({ observedAt: firstAt, circulating: null, total: 120 })], { dataDir, now: firstAt });
  const latestAt = '2026-01-01T12:00:00.000Z';
  const result = await recordTokenSupplySnapshots(guildId, [context({ observedAt: latestAt, circulating: null, total: 144 })], { dataDir, now: latestAt });
  const annual = result.byAssetId['example-token'].changes.find((row) => row.targetDays === 365);
  assert.equal(annual.annualizedCirculatingChangePct, null);
  assert.ok(annual.annualizedTotalChangePct > 20 && annual.annualizedTotalChangePct < 20.02);
});

test('same-day samples are deduplicated across month-boundary cache reads and concurrent writers', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-supply-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const guildId = '123456789012345678';
  const first = context({ observedAt: '2025-01-31T23:40:00.000Z' });
  const firstResult = await recordTokenSupplySnapshots(guildId, [first], { dataDir, now: '2025-01-31T23:45:00.000Z' });
  assert.equal(firstResult.recorded, 1);
  const cached = context({ observedAt: '2025-01-31T23:40:00.000Z', circulating: 105 });
  const duplicateResults = await Promise.all([
    recordTokenSupplySnapshots(guildId, [cached], { dataDir, now: '2025-02-01T00:10:00.000Z' }),
    recordTokenSupplySnapshots(guildId, [cached], { dataDir, now: '2025-02-01T00:11:00.000Z' })
  ]);
  assert.deepEqual(duplicateResults.map((row) => row.recorded), [0, 0]);
  assert.equal(duplicateResults[0].byAssetId['example-token'].samples, 1);
});
