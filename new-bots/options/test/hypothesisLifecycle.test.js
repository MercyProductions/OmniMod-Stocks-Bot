import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchTradierOptionInputs } from '../src/tradierMarketData.js';
import { buildOptionDayTradeCandidate } from '../src/strategies.js';
import { captureOptionHypothesis } from '../src/primaryHypothesis.js';
import { fillQuote } from './helpers/optionFillFixture.js';
import { resolveOptionSignalsFromShared } from '../src/signalSources.js';
import { buildPaperResearchHandoffRows, publishDeliveredPaperResearch } from '../../shared/paperSignalHandoff.js';
import { readPrimaryResearchSignals } from '../../shared/signalResearch.js';
import { publishPrimaryResearchSignals } from '../../shared/signalResearch.js';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote, recoverPaperOrders } from '../../shared/paperRisk.js';

const NOW = Date.parse('2026-10-02T15:00:00Z'), iso = time => new Date(time).toISOString();
const config = { feePerContractRoundTrip: 0.65, slippageReservePerContract: 0.25 };
function input(direction = 'long') {
  return { now: NOW, config, primarySignalObservedAt: iso(NOW - 20_000), signal: {
    underlyingSymbol: 'SPY', direction, underlyingPrice: 100, underlyingTarget: direction === 'long' ? 104 : 96,
    observedAt: iso(NOW - 1000), entryLow: 99, entryHigh: 101,
    sessionDate: '2026-10-02', sessionClose: '2026-10-02T20:00:00.000Z', sessionOpen: true,
    underlyingQuote: { bid: 99.99, ask: 100.01, time: iso(NOW - 1000), quality: 'executable' },
    catalystReview: { status: 'clear', source: 'manual-review', summary: 'Synthetic event clearance.', reviewedAt: iso(NOW) },
    optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'Synthetic dividend clearance.',
      reviewedAt: iso(NOW), reviewedThrough: '2026-10-06', nextExDividendDate: null },
  }, chain: { expiry: '2026-10-06', quoteQuality: 'executable', source: 'fixture', options: [100, direction === 'long' ? 103 : 97].map((strike, i) => ({
    symbol: `SPY261006${direction === 'long' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
    underlying: 'SPY', root: 'SPY', type: direction === 'long' ? 'call' : 'put', strike, expiry: '2026-10-06', multiplier: 100,
    bid: i ? 1 : 2, ask: i ? 1.05 : 2.05, time: iso(NOW - 1000), quoteQuality: 'executable', volume: 100, openInterest: 500,
  })) } };
}
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-option-hypothesis-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

for (const direction of ['long', 'short']) test(`initial ${direction} provider acquisition keeps the original absolute target as prices move`, async () => {
  const row = input(direction), original = structuredClone(row), calls = [];
  const mid = direction === 'long' ? 100.5 : 99.5;
  const fetchImpl = async target => {
    const url = new URL(target); calls.push(url.pathname); let body;
    if (url.pathname.endsWith('/clock')) body = { clock: { state: 'open', timestamp: iso(NOW), next_change: row.signal.sessionClose } };
    else if (url.pathname.endsWith('/quotes')) body = { quotes: { quote: { symbol: 'SPY', bid: mid - 0.01, ask: mid + 0.01, bid_date: NOW, ask_date: NOW } } };
    else if (url.pathname.endsWith('/expirations')) body = { expirations: { date: ['2026-10-06'] } };
    else if (url.pathname.endsWith('/chains')) body = { options: { option: row.chain.options.map(leg => ({ ...leg, type: 'option',
      expiration_date: leg.expiry, option_type: leg.type, contract_size: leg.multiplier, root_symbol: leg.root,
      open_interest: leg.openInterest, bid_date: NOW, ask_date: NOW })) } };
    else throw new Error('Unexpected endpoint');
    return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  };
  const [loaded] = await fetchTradierOptionInputs([row], { token: 'fixture', environment: 'production', now: NOW,
    clockNow: () => NOW, startPacer: async () => ({ localQueueDelayMs: 0 }), fetchImpl });
  assert.equal(loaded.marketDataStatus, 'ready');
  assert.equal(loaded.signal.underlyingPrice, mid);
  assert.equal(loaded.signal.underlyingTarget, original.signal.underlyingTarget);
  assert.equal(loaded.signal.primaryHypothesis.entryPrice, 100);
  assert.equal(loaded.signal.primaryHypothesis.observedAt, original.primarySignalObservedAt);
  assert.deepEqual(row, original);
  assert.equal(calls.length, 4);
});

test('delivered ETF entry and exit deadlines survive the journal and Options source mapping', async t => {
  const dir = await temp(t), file = join(dir, 'signals.jsonl');
  const entryExpiresAt = iso(NOW + 30_000), forceExitAt = iso(NOW + 60_000);
  const rows = buildPaperResearchHandoffRows('etfs-etps', [{ status: 'reserved', reservation: { order: {
    orderId: 'test-etf', paperOnly: true, instrumentKey: 'SPY', exposureKey: 'SPY', direction: 'long',
    strategyId: 'etf-opening-range-v1', sessionDate: '2026-10-02', reservedAt: iso(NOW),
    entryPrice: 100, stopPrice: 99, targetPrice: 104, entryExpiresAt, forceExitAt,
  } } }]);
  await publishDeliveredPaperResearch('etfs-etps', rows, { posted: true }, { file, now: NOW });
  const records = await readPrimaryResearchSignals({ file, now: NOW });
  assert.equal(records[0].entryExpiresAt, entryExpiresAt);
  const { rows: mapped } = resolveOptionSignalsFromShared(records, { reviews: [] });
  assert.equal(mapped[0].signal.entryExpiresAt, entryExpiresAt);
  assert.equal(mapped[0].signal.forceExitAt, forceExitAt);
});

test('shared journal rejects malformed supplied deadlines and still accepts legacy records without them', async t => {
  const file = join(await temp(t), 'signals.jsonl');
  const base = { symbol: 'SPY', direction: 'long', strategyId: 'intraday', sessionDate: '2026-10-02',
    observedAt: iso(NOW), entryPrice: 100, targetPrice: 104, status: 'active' };
  const rows = [{ ...base, id: 'legacy' },
    ...['', false, [], 1e20, iso(NOW)].map((value, i) => ({ ...base, id: `invalid-${i}`, entryExpiresAt: value })),
    { ...base, id: 'misordered', entryExpiresAt: iso(NOW + 10000), forceExitAt: iso(NOW + 5000) },
    { ...base, id: 'numeric', entryExpiresAt: NOW + 5000, forceExitAt: NOW + 10000 }];
  const result = await publishPrimaryResearchSignals('stocks', rows, { file, now: NOW });
  assert.equal(result.rowsWritten, 2);
  assert.equal(result.rowsRejected, 6);
  const records = await readPrimaryResearchSignals({ file, now: NOW });
  assert.equal(records.find(row => row.signalId === 'legacy').entryExpiresAt, undefined);
  assert.equal(records.find(row => row.signalId === 'numeric').entryExpiresAt, iso(NOW + 5000));
});

test('fresh quotes cannot extend the original signal lifetime, including its exact expiry', () => {
  const row = input(); row.primarySignalObservedAt = iso(NOW - 119_000);
  const candidate = buildOptionDayTradeCandidate(row).candidate;
  assert.equal(candidate.entryExpiresAt, iso(NOW + 1000));
  assert.equal(candidate.option.primaryHypothesis.observedAt, row.primarySignalObservedAt);
  const expired = buildOptionDayTradeCandidate({ ...row, now: NOW + 1000 });
  assert.equal(expired.status, 'no-setup');
  assert.ok(expired.reasons.includes('primary_signal_expired'));
});

test('earlier source entry and force-exit deadlines cap the option plan', () => {
  const row = input(); row.signal.entryExpiresAt = iso(NOW + 10_000); row.signal.forceExitAt = iso(NOW + 60_000);
  const candidate = buildOptionDayTradeCandidate(row).candidate;
  assert.equal(candidate.entryExpiresAt, row.signal.entryExpiresAt);
  assert.equal(candidate.forceExitAt, row.signal.forceExitAt);
});

test('strategy cannot bypass the original entry zone using an otherwise fresh underlying quote', () => {
  const row = input(); row.signal.underlyingPrice = 102; row.signal.underlyingQuote.bid = 101.99; row.signal.underlyingQuote.ask = 102.01;
  const result = buildOptionDayTradeCandidate(row);
  assert.equal(result.status, 'no-setup');
  assert.ok(result.reasons.includes('quote_outside_primary_entry_zone'));
});

test('conflicting frozen targets, source clocks, session identity and entry bounds fail closed', () => {
  for (const mutate of [
    row => { row.signal.underlyingTarget = 105; },
    row => { row.primarySignalObservedAt = iso(NOW); },
    row => { row.signal.sessionDate = '2026-10-03'; },
    row => { row.signal.entryHigh = 102; },
    row => { row.signal.entryExpiresAt = iso(NOW + 60000); },
  ]) {
    const row = input(); row.signal.primaryHypothesis = captureOptionHypothesis(row.signal, row.primarySignalObservedAt);
    mutate(row);
    assert.equal(buildOptionDayTradeCandidate(row).status, 'no-setup');
  }
});

test('malformed source lifetimes and unsupported age overrides fail closed without throwing', () => {
  for (const value of ['', 'yesterday', false, [], Infinity, 1e20, iso(NOW - 30000)]) {
    const row = input(); row.signal.entryExpiresAt = value;
    assert.equal(buildOptionDayTradeCandidate(row).status, 'no-setup', JSON.stringify(value));
  }
  for (const maxAgeMs of [0, -1, NaN, 120001]) {
    const row = input(); row.config = { ...config, primarySignalMaxAgeMs: maxAgeMs };
    assert.ok(buildOptionDayTradeCandidate(row).reasons.includes('invalid_primary_signal_age_config'));
  }
  const row = input(); row.config = { ...config, primarySignalMaxAgeMs: 30000 };
  assert.equal(buildOptionDayTradeCandidate(row).candidate.entryExpiresAt, iso(NOW + 10000));
});

async function reserve(t) {
  const statePath = join(await temp(t), 'paper.json');
  const row = input(); row.signal.entryExpiresAt = iso(NOW + 5000);
  const candidate = buildOptionDayTradeCandidate(row).candidate;
  const decision = evaluatePaperCandidate(candidate, { accountEquity: 50_000, openPositions: [], realizedPnlToday: 0 },
    { now: NOW, maxQuoteAgeMs: 10_000, maxSpreadPct: 25, minRewardRisk: 1.5 }, { emergencyStop: false, liveEnabled: false });
  assert.equal(decision.status, 'paper-approved', JSON.stringify(decision));
  const reservation = await reservePaperCandidate(candidate, decision, { statePath, now: NOW, emergencyStop: false });
  assert.equal(reservation.status, 'reserved', JSON.stringify(reservation));
  return { statePath, candidate, decision, order: reservation.order, row };
}
const quote = (candidate, at, bid = 1, ask = 1.05) => ({ instrumentKey: candidate.instrumentKey, bid, ask, time: iso(at), quality: 'executable' });

test('persisted pending option orders cancel at the hypothesis deadline instead of filling later', async t => {
  const { statePath, candidate, order } = await reserve(t);
  const result = await processPaperQuote(order.orderId, quote(candidate, NOW + 5000),
    { statePath, now: NOW + 5000, emergencyStop: false, maxSpreadPct: 25 });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'entry_window_expired');
  const persisted = JSON.parse(await readFile(statePath, 'utf8')).orders[0];
  assert.equal(persisted.option.primaryHypothesis.targetPrice, 104);
  assert.equal(persisted.filledAt, undefined);
});

test('restart recovery cancels an expired unfilled option without needing a quote', async t => {
  const { statePath } = await reserve(t);
  await recoverPaperOrders({ statePath, now: NOW + 5000, emergencyStop: false });
  const order = JSON.parse(await readFile(statePath, 'utf8')).orders[0];
  assert.equal(order.status, 'cancelled');
  assert.equal(order.cancelReason, 'entry_window_expired');
});

test('a position filled before entry expiry remains managed after that deadline', async t => {
  const { statePath, candidate, order, row } = await reserve(t);
  const filled = await processPaperQuote(order.orderId, fillQuote(row, NOW + 1000),
    { statePath, now: NOW + 1000, emergencyStop: false, maxSpreadPct: 25 });
  assert.equal(filled.status, 'filled', JSON.stringify(filled));
  const marked = await processPaperQuote(order.orderId, quote(candidate, NOW + 6000, 1.2, 1.25),
    { statePath, now: NOW + 6000, emergencyStop: false, maxSpreadPct: 25 });
  assert.equal(marked.status, 'open', JSON.stringify(marked));
  const at = Date.parse(candidate.forceExitAt);
  const closed = await processPaperQuote(order.orderId, quote(candidate, at, 1.2, 1.25),
    { statePath, now: at, emergencyStop: false, maxSpreadPct: 25 });
  assert.equal(closed.status, 'closed', JSON.stringify(closed));
});
