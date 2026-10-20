import { fillRiskPolicyFixture } from '../fixtures/fillRiskPolicy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaperPositionMonitor } from '../paperPositionMonitor.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
const now = Date.parse('2026-10-03T15:00:00Z');
const identity = { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase', pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD',
  verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() };
const order = (extra = {}) => ({ orderId: 'crypto', idempotencyKey: 'crypto', owner: 'crypto', assetClass: 'crypto', instrumentKey: 'BTC',
  status: 'reserved', direction: 'long', units: 0.5, multiplier: 1, lotSize: 0.00000001,
  riskUsd: 1, notionalUsd: 50, marginRequirementUsd: 0, accountEquityUsd: 10000, entryPrice: 100, stopPrice: 98, targetPrice: 105,
  roundTripFeesPerUnit: 0.2, slippageReservePerUnit: 0.1,
  quoteTime: new Date(now - 2000).toISOString(), reservedAt: new Date(now - 1000).toISOString(),
  entryExpiresAt: new Date(now + 600000).toISOString(), forceExitAt: new Date(now + 3600000).toISOString(),
  entryRiskPolicy: fillRiskPolicyFixture(), entryQuotePolicy: { maxQuoteAgeMs: 15000, maxSpreadPct: 0.5 }, sessionDate: '2026-10-03',
  cryptoIdentity: identity, cryptoInstrumentRules: cryptoRulesFixture({ time: now }), ...extra });
const quote = (time = now, bid = 99.9, ask = 100) => ({ bid, ask, time: new Date(time).toISOString(), quality: 'executable', cryptoIdentity: identity,
  cryptoInstrumentRules: cryptoRulesFixture({ time }), cryptoQuoteEvidence: coinbaseBookEvidence({ time, bid, ask }) });
async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-crypto-monitor-')), statePath = join(root, 'production.json'), shadow = join(root, 'shadow');
  await mkdir(shadow);
  const save = (path, orders) => writeFile(path, JSON.stringify({ schemaVersion: 1, orders, events: [] }));
  const env = { TRADING_RISK_STATE_PATH: statePath, OMNIMOD_EMERGENCY_STOP: 'false' };
  const run = extra => runPaperPositionMonitor({ bot: 'crypto', env, clock: () => now, shadowDirectories: [shadow], ...extra });
  try { await work({ root, statePath, shadow, save, run, env }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('Crypto independent monitor advances production and older shadow fractional positions without discovery', () => fixture(async ({ statePath, shadow, save, run }) => {
  await save(statePath, [order(), order({ orderId: 'other', owner: 'stocks', assetClass: 'stock', instrumentKey: 'AAPL' })]);
  const old = join(shadow, 'crypto-old-profile-1234567890abcdef.json'); await save(old, [order()]);
  const fill = await run({ fetchMarks: async (_bot, orders) => ({ marks: orders.map(o => ({ orderId: o.orderId, quote: quote(), sessionOpen: true })) }) });
  assert.equal(fill.counts.filled, 2);
  const exit = await run({ clock: () => now + 1000, fetchMarks: async (_bot, orders) => ({ marks: orders.map(o => ({ orderId: o.orderId, quote: quote(now + 1000, 105.1, 105.2), sessionOpen: true })) }) });
  assert.equal(exit.counts.closed, 2);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.orders[0].exitReason, 'target'); assert.equal(saved.orders[1].status, 'reserved');
}));
test('Crypto idle monitor makes no provider request or ledger', () => fixture(async ({ statePath, run }) => {
  const result = await run({ fetchMarks: () => assert.fail('must not request') });
  assert.equal(result.status, 'idle'); await assert.rejects(readFile(statePath), { code: 'ENOENT' });
}));
test('Crypto stop cancels only its pending orders and cannot fabricate an open exit on outage', () => fixture(async ({ statePath, save, run, env }) => {
  await save(statePath, [order(), order({ orderId: 'open', status: 'open', fillPrice: 100, filledAt: new Date(now - 1000).toISOString() }),
    order({ orderId: 'other', owner: 'stocks', assetClass: 'stock', instrumentKey: 'AAPL' })]);
  const result = await run({ env: { ...env, OMNIMOD_EMERGENCY_STOP: 'true' }, fetchMarks: () => { throw new Error('private failure'); } });
  assert.equal(result.counts.cancelled, 1); assert.equal(result.counts.closed, 0); assert.equal(result.status, 'degraded');
  assert.equal(JSON.stringify(result).includes('private failure'), false);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).orders[2].status, 'reserved');
}));
