import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crypto-shadow-provenance-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { appendCandleBatch, loadLabeledObservations, recordShadowCandidates, resolvePendingObservations,
  RESEARCH_ENTRY_EVIDENCE_VERSION } =
  await import('../src/researchStore.js');
const { FEATURE_SCHEMA_VERSION } = await import('../src/modelFeatures.js');

after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

test('stored Crypto shadow outcome waits for completed candles from its pinned venue and pair', async () => {
  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 4 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000);
  const observationId = `source-pinned-${randomUUID()}`;
  const row = { observationId, guildId: 'test', symbol: 'BTC', horizonKey: 'rapid',
    candleProvider: 'Binance', candlePair: 'BTCUSDT', createdAt: createdAt.toISOString(),
    entryEvidenceVersion: RESEARCH_ENTRY_EVIDENCE_VERSION, entryQuoteBasis: 'same_source_ask',
    entryQuoteProvider: 'Binance', entryQuotePair: 'BTCUSDT',
    entryQuoteObservedAt: createdAt.toISOString(), entryQuoteAgeMs: 0, entryQuoteAsk: 100,
    deadlineAt: new Date(first + 4 * barMs).toISOString(), featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    features: { score: 70 }, entryPrice: 100, stopPrice: 98, partialTargetPrice: 102,
    targetPrice: 104, estimatedCostPct: 0.2 };
  const candle = (index, overrides = {}) => ({ time: first + index * barMs,
    open: 100, high: 101, low: 99, close: 100, volume: 100, ...overrides });

  assert.equal(await recordShadowCandidates([row], createdAt), 1);
  await appendCandleBatch('BTC', 'Coinbase', [candle(0), candle(1), candle(2,
    { open: 101, high: 105, low: 100.5, close: 102 })], 'BTC-USD');
  assert.deepEqual(await resolvePendingObservations([], new Date(first + 5 * barMs)), []);
  assert.equal((await loadLabeledObservations()).length, 0);

  await appendCandleBatch('BTC', 'Binance', [candle(0), candle(1), candle(2,
    { open: 101, high: 105, low: 100.5, close: 102 })], 'BTCUSDT');
  const resolved = await resolvePendingObservations([], new Date(first + 5 * barMs));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].observationId, observationId);
  assert.equal(resolved[0].reason, 'candle_target');
  assert.equal(resolved[0].candleProvider, 'Binance');
  assert.equal(resolved[0].candlePair, 'BTCUSDT');
  assert.equal(resolved[0].priceBasis, 'completed_source_candles');
  assert.equal((await loadLabeledObservations()).length, 1);
  assert.deepEqual(await resolvePendingObservations([], new Date(first + 6 * barMs)), []);
});
