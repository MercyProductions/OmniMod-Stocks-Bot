import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { evaluateOpeningRangeBreakout } from '../src/strategies.js';
import { evaluatePaperCandidate, reservePaperCandidate, readPaperRiskLedger, processPaperQuote } from '../../shared/paperRisk.js';
import { stockQuote } from '../../shared/fixtures/stockQuoteEvidence.js';
import { etfInput, NOW, portfolio, policy } from './quoteRefreshFixtures.js';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'etf-decision-lifecycle-'));
  t.after(async () => { const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(directory, { recursive: true, force: true }); });
  const candidate = evaluateOpeningRangeBreakout({ ...etfInput(), now: NOW }).candidate;
  return { statePath: join(directory, 'ledger.json'), candidate, decision: evaluatePaperCandidate(candidate, portfolio(), policy()) };
}

test('quote-age check happens after the ledger lock wait', async t => {
  const { statePath, candidate, decision } = await setup(t); let current = NOW;
  await writeFile(`${statePath}.lock`, JSON.stringify({ pid: process.pid }));
  const waiting = reservePaperCandidate(candidate, decision, { statePath, now: NOW, observationClock: () => current, emergencyStop: false });
  await new Promise(done => setTimeout(done, 40)); current += 15001; await unlink(`${statePath}.lock`);
  const result = await waiting;
  assert.equal(result.reason, 'quote_expired_before_reservation'); assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
});

test('bad or backward reservation clocks write no order', async t => {
  const { statePath, candidate, decision } = await setup(t);
  for (const observationClock of [() => NaN, () => NOW - 1, 42, () => { throw new Error('clock unavailable'); }]) {
    const result = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, observationClock, emergencyStop: false });
    assert.equal(result.reason, 'invalid_reservation_observation_clock');
  }
  assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
});

test('locked decision cannot reserve beyond entry cutoff or force-exit time', async t => {
  const { statePath, candidate, decision } = await setup(t);
  for (const [at, expected] of [[candidate.entryExpiresAt, 'invalid_or_expired_entry_window'], [candidate.forceExitAt, 'invalid_or_expired_time_exit']]) {
    const result = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, observationClock: () => Date.parse(at), emergencyStop: false });
    assert.equal(result.reason, expected);
  }
});

test('fresh reservation still needs a later fill and later exit with costs', async t => {
  const { statePath, candidate, decision } = await setup(t);
  const reservation = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, observationClock: () => NOW, emergencyStop: false });
  assert.equal(reservation.status, 'reserved'); assert.equal(reservation.order.entryExpiresAt, candidate.entryExpiresAt);
  const processQuote = (at, bid, ask) => processPaperQuote(reservation.order.orderId,
    stockQuote('SPY', { bid, ask, time: new Date(at).toISOString(), quality: 'executable' }),
    { statePath, expectedOwner: 'etfs-etps', now: at, maxQuoteAgeMs: 15000, maxSpreadPct: 0.5, sessionOpen: true, emergencyStop: false });
  await processQuote(NOW + 1000, candidate.bid, candidate.ask);
  assert.equal((await readPaperRiskLedger({ statePath })).orders[0].status, 'filled');
  await processQuote(NOW + 2000, candidate.targetPrice + 0.01, candidate.targetPrice + 0.02);
  const closed = (await readPaperRiskLedger({ statePath })).orders[0];
  assert.equal(closed.status, 'closed'); assert.ok(closed.realizedPnlUsd > 0);
  assert.ok(closed.feesUsd > 0); assert.ok(closed.slippageUsd > 0);
  assert.ok(Math.abs(closed.realizedPnlUsd - (closed.grossPnlUsd - closed.feesUsd - closed.slippageUsd)) <= 0.011);
  assert.ok(Date.parse(closed.closedAt) > Date.parse(closed.reservedAt));
});

test('unfilled reservation is cancelled at its existing strategy cutoff', async t => {
  const { statePath, candidate, decision } = await setup(t);
  const reservation = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, emergencyStop: false });
  const at = Date.parse(candidate.entryExpiresAt);
  await processPaperQuote(reservation.order.orderId, stockQuote('SPY', { bid: candidate.bid, ask: candidate.ask, time: new Date(at).toISOString(), quality: 'executable' }),
    { statePath, expectedOwner: 'etfs-etps', now: at, maxQuoteAgeMs: 15000, maxSpreadPct: 0.5, sessionOpen: true, emergencyStop: false });
  const order = (await readPaperRiskLedger({ statePath })).orders[0];
  assert.equal(order.status, 'cancelled'); assert.equal(order.cancelReason, 'entry_window_expired');
});
