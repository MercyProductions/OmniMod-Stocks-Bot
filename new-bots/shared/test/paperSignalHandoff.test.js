import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPaperResearchHandoffRows, formatPaperResearchHandoff, publishDeliveredPaperResearch } from '../paperSignalHandoff.js';
import { isIntradayPrimaryResearch, readPrimaryResearchSignals } from '../signalResearch.js';

const now = Date.parse('2026-09-30T15:00:00Z');
const order = (overrides = {}) => ({
  orderId: 'ord-futures-es', idempotencyKey: 'futures:ESZ6:or:long', owner: 'futures', paperOnly: true,
  instrumentKey: 'ESZ6', exposureKey: 'SPY', strategyId: 'futures-opening-range-v1', direction: 'long',
  sessionDate: '2026-09-30', reservedAt: new Date(now).toISOString(), entryPrice: 5_700,
  stopPrice: 5_690, targetPrice: 5_720, status: 'reserved', ...overrides,
});

test('handoff selects only distinct reserved paper decisions and keeps wrapper instrument separate from exposure', () => {
  const rows = buildPaperResearchHandoffRows('futures', [
    { contractId: 'ESZ6', strategy: 'futures-opening-range-v1', status: 'reserved', reservation: { order: order() } },
    { contractId: 'MESZ6', status: 'reserved', reservation: { order: order({ orderId: 'ord-micro', idempotencyKey: 'micro', instrumentKey: 'MESZ6' }) } },
    { status: 'risk-blocked', reservation: { order: order({ orderId: 'blocked' }) } },
    { status: 'reserved', reservation: { order: order({ orderId: 'not-paper', paperOnly: false }) } },
    { status: 'reserved', reservation: { order: order({ orderId: 'bad-direction', direction: 'flat' }) } },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'SPY');
  assert.equal(rows[0].instrumentKey, 'ESZ6');
  assert.equal(rows[0].exposureKey, 'SPY');
  assert.equal(rows[0].strategyFamily, 'intraday_day_trade');
  assert.equal(formatPaperResearchHandoff(rows).includes('SPY LONG'), true);
  assert.deepEqual(buildPaperResearchHandoffRows('futures', [{ status: 'reserved', reservation: { order: order() } }], { limit: 0 }), []);
  assert.throws(() => buildPaperResearchHandoffRows('forex', [], { limit: 11 }), /limit/);
});

test('options handoff preserves underlying direction and spot levels instead of vertical premium direction', () => {
  const [row] = buildPaperResearchHandoffRows('options', [{
    status: 'reserved',
    candidate: { assetClass: 'option', underlyingDirection: 'short', exposureKey: 'SPY', sessionDate: '2026-09-30',
      researchSignal: { symbol: 'SPY', direction: 'short', underlyingPrice: 500, underlyingTarget: 490 } },
    reservation: { order: order({ owner: 'options', instrumentKey: 'SPY261002P500+SPY261002P490', direction: 'long',
      exposureKey: 'SPY', entryPrice: 2.5, stopPrice: 1.25, targetPrice: 5 }) },
  }]);
  assert.equal(row.direction, 'short');
  assert.equal(row.entryPrice, 500);
  assert.equal(row.targetPrice, 490);
  assert.equal(row.symbol, 'SPY');
});

test('inverse ETF handoff reverses instrument direction into its canonical underlying direction', () => {
  const [row] = buildPaperResearchHandoffRows('etfs-etps', [{
    symbol: 'SPXU', status: 'reserved',
    reservation: { order: order({ owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'SPXU', exposureKey: 'SPY',
      direction: 'long', instrumentMetadata: { productType: 'inverse_etf', inverse: true } }) },
  }]);
  assert.equal(row.symbol, 'SPY');
  assert.equal(row.direction, 'short');
});

test('only successfully delivered summaries publish non-executable six-owner context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-paper-handoff-'));
  const file = join(dir, 'signals.jsonl');
  const rows = buildPaperResearchHandoffRows('futures', [{ status: 'reserved', reservation: { order: order() } }]);
  try {
    const skipped = await publishDeliveredPaperResearch('futures', rows, { posted: false }, { file, now });
    assert.equal(skipped.status, 'not-delivered');
    await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' });

    const published = await publishDeliveredPaperResearch('futures', rows, { posted: true }, { file, now });
    assert.equal(published.rowsWritten, 1);
    const records = await readPrimaryResearchSignals({ file, now, owners: ['futures'] });
    assert.equal(records.length, 1);
    assert.equal(records[0].exposureKey, 'SPY');
    assert.equal(records[0].instrumentKey, 'ESZ6');
    assert.equal(records[0].executable, false);
    assert.equal(records[0].paperOnly, true);
    assert.equal(isIntradayPrimaryResearch(records[0]), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
