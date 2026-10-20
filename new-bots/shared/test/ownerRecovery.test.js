import { stockQuote } from '../fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processPaperQuote, recoverPaperOrders, readPaperRiskLedger } from '../paperRisk.js';
import { buildPrimarySignalCandidate, reserveSharedPaperCandidate, markSharedPaperOrders } from '../primarySignal.js';

const at = Date.parse('2026-10-02T15:00:00Z');
const owners = ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps'];
const pending = (owner, id = owner) => ({ orderId: id, owner, status: 'reserved',
  entryExpiresAt: new Date(at + 60000).toISOString(), forceExitAt: new Date(at + 300000).toISOString() });
async function fixture(t, orders) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-owner-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'ledger.json');
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1, orders, events: [] }));
  return statePath;
}

test('a scanner stop recovers only that owner; explicit global recovery still stops every owner', async t => {
  for (const owner of owners) {
    const original = owners.map(o => pending(o));
    const statePath = await fixture(t, original);
    const result = await recoverPaperOrders({ statePath, owner, now: at, emergencyStop: true });
    assert.equal(result.cancelledReservations, 1);
    const ledger = await readPaperRiskLedger({ statePath });
    assert.deepEqual(ledger.orders.filter(o => o.owner !== owner), original.filter(o => o.owner !== owner));
    assert.equal(ledger.events.length, 1);
    const global = await recoverPaperOrders({ statePath, now: at, emergencyStop: true });
    assert.equal(global.cancelledReservations, 5);
  }
});

test('owner scope is validated before mutation', async t => {
  const statePath = await fixture(t, [pending('stocks')]);
  const before = await readFile(statePath, 'utf8');
  for (const owner of ['', 'stock', null, false, []]) {
    await assert.rejects(recoverPaperOrders({ statePath, owner, now: at, emergencyStop: true }), TypeError);
    assert.equal(await readFile(statePath, 'utf8'), before);
  }
});

test('ambiguous IDs and wrong expected owner cannot mutate a different order under the lock', async t => {
  const statePath = await fixture(t, [pending('crypto', 'same'), pending('stocks', 'same')]);
  const before = await readFile(statePath, 'utf8');
  const result = await processPaperQuote('same', null, { statePath, now: at, emergencyStop: true, expectedOwner: 'stocks' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'ambiguous_order_identity');
  assert.equal(await readFile(statePath, 'utf8'), before);
  const single = await fixture(t, [pending('crypto')]);
  const guarded = await processPaperQuote('crypto', null, { statePath: single, now: at, emergencyStop: true, expectedOwner: 'stocks' });
  assert.equal(guarded.reason, 'order_owner_mismatch');
  assert.equal((await readPaperRiskLedger({ statePath: single })).orders[0].status, 'reserved');
});

test('primary mark recovery cannot cancel another bot even when this primary bot is stopped', async t => {
  const statePath = await fixture(t, [pending('stocks'), pending('crypto')]);
  const result = await markSharedPaperOrders({ owner: 'stocks', config: { sharedPaperStatePath: statePath, sharedPaperEmergencyStop: true },
    now: at, quotesBySymbol: new Map() });
  assert.equal(result.recovery.cancelledReservations, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders.find(o => o.owner === 'crypto').status, 'reserved');
});

async function reserveStock(t) {
  const statePath = await fixture(t, []);
  const config = { sharedPaperStatePath: statePath, sharedPaperAccountEquity: 10000, sharedPaperEmergencyStop: false,
    sharedPaperMaxQuoteAgeMs: 15000, sharedPaperMaxSpreadPct: 0.5 };
  const candidate = buildPrimarySignalCandidate({ owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', strategyId: 'test', signalId: 'one',
    sessionDate: '2026-10-02', now: at, quote: stockQuote('AAPL', { bid: 100, ask: 100.01, time: new Date(at - 1000).toISOString(), quality: 'executable' }),
    sessionOpen: true, stopPct: 1, targetPct: 2, forceExitAt: new Date(at + 3600000).toISOString(),
    roundTripFeesPerUnit: 0, slippageReservePerUnit: 0.01 }).candidate;
  assert.equal((await reserveSharedPaperCandidate(candidate, config, at)).status, 'reserved');
  return { statePath, config };
}

test('primary quote freshness uses completion clock, not the market scan start', async t => {
  const { statePath, config } = await reserveStock(t);
  const result = await markSharedPaperOrders({ owner: 'stocks', config, now: at, clock: () => at + 30000,
    quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 100, ask: 100.01, time: new Date(at + 1000).toISOString(), quality: 'executable' })]]) });
  assert.equal(result.quoteRejected, 1);
  assert.equal(result.rejectionReasons.quote_not_current_and_executable, 1);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'reserved');
});

test('primary marks recheck the session at quote processing time', async t => {
  const { statePath, config } = await reserveStock(t);
  const checks = [];
  const result = await markSharedPaperOrders({ owner: 'stocks', config, now: at, clock: () => at + 1000,
    sessionOpen: current => { checks.push(current); return false; },
    quotesBySymbol: new Map([['AAPL', stockQuote('AAPL', { bid: 100, ask: 100.01, time: new Date(at + 1000).toISOString(), quality: 'executable' })]]) });
  assert.deepEqual(checks, [at + 1000]);
  assert.equal(result.processed, 1);
  assert.equal(result.quoteRejected, 0, 'a closed session is a waiting entry, not malformed quote data');
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'reserved');
});

test('current primary decision clock accepts fresh post-scan quotes but refuses aged quotes and elapsed entry windows', async t => {
  const statePath = await fixture(t, []);
  const completed = at + 80000;
  t.mock.method(Date, 'now', () => completed);
  const input = { owner: 'stocks', assetClass: 'stock', symbol: 'AAPL', strategyId: 'test', signalId: 'late',
    sessionDate: '2026-10-02', quote: stockQuote('AAPL', { bid: 100, ask: 100.01, time: new Date(completed - 1000).toISOString(), quality: 'executable' }),
    sessionOpen: true, stopPct: 1, targetPct: 2, forceExitAt: new Date(at + 3600000).toISOString(),
    roundTripFeesPerUnit: 0, slippageReservePerUnit: 0.01 };
  // This is the old scanner call: a legitimate late-fetched quote appears future-dated.
  assert.ok(buildPrimarySignalCandidate({ ...input, now: at }).reasons.includes('stale_or_future_quote'));
  const current = buildPrimarySignalCandidate(input);
  assert.equal(current.status, 'candidate');
  const config = { sharedPaperStatePath: statePath, sharedPaperAccountEquity: 10000, sharedPaperEmergencyStop: false };
  assert.equal((await reserveSharedPaperCandidate(current.candidate, config)).status, 'reserved');
  assert.ok(buildPrimarySignalCandidate({ ...input,
    quote: { ...input.quote, time: new Date(at + 1000).toISOString() } }).reasons.includes('stale_or_future_quote'));
  assert.ok(buildPrimarySignalCandidate({ ...input,
    entryExpiresAt: new Date(at + 70000).toISOString() }).reasons.includes('entry_window_expired'));
});
