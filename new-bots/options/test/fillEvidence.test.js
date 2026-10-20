import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { buildOptionDayTradeCandidate } from '../src/strategies.js';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote } from '../../shared/paperRisk.js';
import { fixture, fillQuote, NOW, iso } from './helpers/optionFillFixture.js';

async function reserved(t, direction = 'long') {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-option-fill-'));
  t.after(async () => { const path = relative(tmpdir(), dir); assert.ok(path && !isAbsolute(path) && !path.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const statePath = join(dir, 'ledger.json'), row = fixture(direction);
  const candidate = buildOptionDayTradeCandidate(row).candidate;
  const decision = evaluatePaperCandidate(candidate, { accountEquity: 50000, openPositions: [], realizedPnlToday: 0 },
    { now: NOW, maxQuoteAgeMs: 10000, maxSpreadPct: 25, minRewardRisk: 1.5 }, { emergencyStop: false, liveEnabled: false });
  const reservation = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, emergencyStop: false });
  assert.equal(reservation.status, 'reserved');
  return { row, candidate, statePath, order: reservation.order,
    mark: (quote, settings = {}) => processPaperQuote(reservation.order.orderId, quote,
      { statePath, now: NOW + 1000, maxQuoteAgeMs: 10000, maxSpreadPct: 25, emergencyStop: false, ...settings }) };
}

test('an option premium quote alone cannot fill a reserved position', async t => {
  const f = await reserved(t), quote = fillQuote(f.row); delete quote.optionEntryEvidence;
  const result = await f.mark(quote);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'option_entry_evidence_missing');
});

test('a pending option cannot fill after the underlying has passed its original target', async t => {
  const f = await reserved(t), quote = fillQuote(f.row);
  quote.optionEntryEvidence.underlyingQuote.bid = 104.1; quote.optionEntryEvidence.underlyingQuote.ask = 104.12;
  const result = await f.mark(quote);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'option_underlying_target_passed_before_fill');
});

test('a revoked catalyst review blocks a fill despite a favorable executable spread price', async t => {
  const f = await reserved(t), quote = fillQuote(f.row);
  quote.optionEntryEvidence.catalyst.review = { ...f.row.signal.catalystReview, status: 'blocked' };
  const result = await f.mark(quote);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'option_entry_catalyst_clearance_required');
});

test('current synchronized entry evidence allows a later fill and is retained as evidence', async t => {
  const f = await reserved(t), quote = fillQuote(f.row);
  const result = await f.mark(quote);
  assert.equal(result.status, 'filled', JSON.stringify(result));
  const persisted = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.deepEqual(persisted.orders[0].optionEntryEvidence, quote.optionEntryEvidence);
  assert.deepEqual(persisted.events.find(event => event.type === 'filled').optionEntryEvidence, quote.optionEntryEvidence);
});

test('wrong underlying identity, missing legs and stale or skewed native times cannot create fills', async t => {
  const f = await reserved(t);
  const mutations = [
    e => { e.underlyingQuote.symbol = 'QQQ'; },
    e => { e.legs[0] = null; },
    e => { e.legs[0].symbol = e.legs[1].symbol; },
    e => { e.underlyingQuote.bidTime = iso(NOW - 60000); },
    e => { e.underlyingQuote.bidTime = e.underlyingQuote.askTime = e.underlyingQuote.time = iso(NOW - 3001); },
    e => { e.legs[0].volume = 0; },
    e => { e.legs[0].bid = 1.99; },
    e => { e.catalyst.checkedAt = iso(NOW + 1001); },
    e => { e.catalyst.review = { ...e.catalyst.review, reviewedAt: iso(NOW - 1800001) }; },
    e => { e.underlyingQuote.bid = 100.8; e.underlyingQuote.ask = 100.82; },
    e => { e.sessionDate = '2026-10-01'; },
  ];
  for (const mutate of mutations) {
    const quote = fillQuote(f.row); mutate(quote.optionEntryEvidence);
    const result = await f.mark(quote);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
  }
});

for (const direction of ['long', 'short']) test(`${direction} underlying invalidation cancels the pending option without claiming a fill`, async t => {
  const f = await reserved(t, direction), quote = fillQuote(f.row);
  const price = direction === 'long' ? 98.9 : 101.1;
  quote.optionEntryEvidence.underlyingQuote.bid = price; quote.optionEntryEvidence.underlyingQuote.ask = price + 0.01;
  const result = await f.mark(quote);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'option_underlying_invalidated_before_fill');
  assert.equal(result.order.filledAt, undefined);
});

test('a legacy pending option with no verified entry policy remains blocked but can be cancelled', async t => {
  const f = await reserved(t), ledger = JSON.parse(await readFile(f.statePath, 'utf8'));
  delete ledger.orders[0].option.entryValidation;
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.statePath, JSON.stringify(ledger));
  assert.equal((await f.mark(fillQuote(f.row))).reason, 'option_entry_policy_unavailable');
  assert.equal((await f.mark(null, { emergencyStop: true })).status, 'cancelled');
});

test('clock advancement after the execution lock expires pending entries before fill', async t => {
  const f = await reserved(t);
  const result = await f.mark(fillQuote(f.row), { observationClock: () => NOW + 120000 });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'entry_window_expired');
});

test('a filled position can stop out without new underlying or catalyst evidence', async t => {
  const f = await reserved(t);
  assert.equal((await f.mark(fillQuote(f.row))).status, 'filled');
  const result = await f.mark({ bid: 0.4, ask: 0.41, time: iso(NOW + 2000), quality: 'executable' }, { now: NOW + 2000 });
  assert.equal(result.status, 'closed'); assert.equal(result.order.exitReason, 'stop');
});
