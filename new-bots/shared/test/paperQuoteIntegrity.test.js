import { fixture as optionFixture, fillQuote } from '../../options/test/helpers/optionFillFixture.js';
import { buildOptionDayTradeCandidate } from '../../options/src/strategies.js';
import { stockQuoteEvidence, stockQuote, withStockCandidateEvidence } from '../fixtures/stockQuoteEvidence.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePaperCandidate, processPaperQuote, reservePaperCandidate, PAPER_EXECUTION_VERSION } from '../paperRisk.js';

const now = Date.parse('2026-10-02T15:00:00Z');
const proposal = (overrides = {}) => withStockCandidateEvidence({
  mode: 'paper', owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY', exposureKey: 'SPY',
  idempotencyKey: 'quote-integrity:SPY', strategyId: 'quote-integrity-fixture', sessionDate: '2026-10-02',
  direction: 'long', bid: 100, ask: 100.1, entryPrice: 100.1, stopPrice: 99, targetPrice: 103,
  quoteTime: new Date(now - 1000).toISOString(), quoteQuality: 'executable', sessionOpen: true,
  forceExitAt: new Date(now + 3_600_000).toISOString(), multiplier: 1, lotSize: 1,
  roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03, ...overrides,
});
const option = () => buildOptionDayTradeCandidate(optionFixture()).candidate;
const optionQuote = at => fillQuote(optionFixture(), at);
const quote = (at, overrides = {}) => stockQuote('SPY', { bid: 100, ask: 100.1, time: new Date(at).toISOString(), quality: 'executable', ...overrides });

async function fixture(candidate = proposal(), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-quote-integrity-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const decision = evaluatePaperCandidate(candidate, { accountEquity: candidate.assetClass === 'option' ? 50_000 : 10_000, realizedPnlToday: 0, openPositions: [] },
      { now, maxQuoteAgeMs: 5000, maxSpreadPct: 0.2, ...overrides });
    assert.equal(decision.status, 'paper-approved', JSON.stringify(decision.reasons));
    const reserved = await reservePaperCandidate(candidate, decision, { statePath, now, emergencyStop: false });
    assert.equal(reserved.status, 'reserved');
    return { statePath, orderId: reserved.order.orderId, order: reserved.order,
      cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

test('missing option quote prices cannot fabricate a worthless liquidation', async () => {
  const f = await fixture(option(), { maxSpreadPct: 50 });
  try {
    assert.equal((await processPaperQuote(f.orderId, optionQuote(now + 1000),
      { statePath: f.statePath, now: now + 1000, emergencyStop: false, maxSpreadPct: 50 })).status, 'filled');
    const before = await readFile(f.statePath, 'utf8');
    const result = await processPaperQuote(f.orderId, quote(now + 2000, { bid: null, ask: null }),
      { statePath: f.statePath, now: now + 2000, emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'quote_not_current_and_executable');
    assert.equal(await readFile(f.statePath, 'utf8'), before, 'invalid data cannot change P&L or events');
  } finally { await f.cleanup(); }
});

test('a pending fill cannot inherit a looser monitor spread policy', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.statePath, 'utf8');
    const result = await processPaperQuote(f.orderId, quote(now + 1000, { bid: 99.8, ask: 100.1 }),
      { statePath: f.statePath, now: now + 1000, emergencyStop: false, maxSpreadPct: 0.5 });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'spread_limit');
    assert.equal(await readFile(f.statePath, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('a pending fill cannot inherit a looser monitor freshness policy', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.statePath, 'utf8');
    const result = await processPaperQuote(f.orderId, quote(now + 1000),
      { statePath: f.statePath, now: now + 10_000, emergencyStop: false, maxQuoteAgeMs: 60_000 });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'quote_not_current_and_executable');
    assert.equal(await readFile(f.statePath, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('approval quote limits persist and monitor calls may tighten them', async () => {
  const f = await fixture();
  try {
    assert.equal(f.order.paperExecutionVersion, PAPER_EXECUTION_VERSION);
    assert.deepEqual(f.order.entryQuotePolicy, { maxQuoteAgeMs: 5000, maxSpreadPct: 0.2 });
    const options = { statePath: f.statePath, now: now + 4000, emergencyStop: false };
    assert.equal((await processPaperQuote(f.orderId, quote(now + 1000),
      { ...options, maxQuoteAgeMs: 2000 })).reason, 'quote_not_current_and_executable');
    assert.equal((await processPaperQuote(f.orderId, quote(now + 4000),
      { ...options, maxSpreadPct: 0.05 })).reason, 'spread_limit');
    // A new invocation reads the persisted limits and accepts a quote within both policies.
    assert.equal((await processPaperQuote(f.orderId, { ...quote(now + 4000), bid: '100', ask: '100.1' }, options)).status, 'filled');
  } finally { await f.cleanup(); }
});

test('malformed numeric quotes never fill, cancel, mark or exit any supported asset class', async () => {
  const markets = [['stocks', 'stock'], ['crypto', 'crypto'], ['forex', 'forex'],
    ['futures', 'future'], ['options', 'option'], ['etfs-etps', 'etf'], ['etfs-etps', 'etp']];
  const badValues = [null, undefined, '', '  ', true, false, [], [1], {}, { valueOf: () => 1 }, NaN, Infinity, -Infinity, 'NaN', 'Infinity'];
  for (const [owner, assetClass] of markets) {
    const cryptoIdentity = assetClass === 'crypto' ? { version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase',
      pair: 'BTC-USD', base: 'BTC', quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() } : undefined;
    const stockEvidenceAt = at => stockQuoteEvidence('SPY', { bid: 100, ask: 100.1, time: new Date(at).toISOString() });
    const marketQuote = (at, fields = {}) => assetClass === 'option' ? { ...optionQuote(at), ...fields } : quote(at, { ...(owner === 'stocks' ? { stockQuoteEvidence: stockEvidenceAt(at) } : {}), ...(cryptoIdentity ? { cryptoIdentity, cryptoInstrumentRules: cryptoRulesFixture({ time: at }), cryptoQuoteEvidence: coinbaseBookEvidence({ bid: 100, ask: 100.1, time: at }) } : {}), ...fields });
    const candidate = assetClass === 'option' ? option() : proposal({ owner, assetClass, ...(owner === 'stocks' ? { stockQuoteEvidence: stockEvidenceAt(now - 1000) } : {}), idempotencyKey: `quote-integrity:${assetClass}`,
      ...(cryptoIdentity ? { cryptoIdentity, lotSize: 0.00000001, cryptoInstrumentRules: cryptoRulesFixture({ time: now - 1000 }), cryptoQuoteEvidence: coinbaseBookEvidence({ bid: 100, ask: 100.1, time: now - 1000 }), instrumentKey: 'BTC', exposureKey: 'BTC' } : {}),
      ...(assetClass === 'future' ? { initialMarginUsd: 100, maintenanceMarginUsd: 80 } : {}) });
    const f = await fixture(candidate, assetClass === 'option' ? { maxSpreadPct: 25 } : {});
    try {
      for (const stage of ['reserved', 'filled']) {
        if (stage === 'filled') assert.equal((await processPaperQuote(f.orderId, marketQuote(now + 1000),
          { statePath: f.statePath, now: now + 1000, emergencyStop: false, ...(assetClass === 'option' ? { maxSpreadPct: 25 } : {}) })).status, 'filled');
        const before = await readFile(f.statePath, 'utf8');
        for (const field of ['bid', 'ask']) for (const value of badValues) {
          const result = await processPaperQuote(f.orderId, marketQuote(now + 2000, { [field]: value }),
            { statePath: f.statePath, now: now + 2000, emergencyStop: false });
          assert.equal(result.reason, 'quote_not_current_and_executable', `${assetClass}/${stage}/${field}/${String(value)}`);
          assert.equal(await readFile(f.statePath, 'utf8'), before);
        }
      }
    } finally { await f.cleanup(); }
  }
});

test('explicit numeric zero option exits remain valid, including under emergency stop', async () => {
  for (const prices of [{ bid: 0, ask: 0 }, { bid: '0.0', ask: '0.05' }]) {
    const f = await fixture(option(), { maxSpreadPct: 50 });
    try {
      assert.equal((await processPaperQuote(f.orderId, optionQuote(now + 1000),
        { statePath: f.statePath, now: now + 1000, emergencyStop: false, maxSpreadPct: 50 })).status, 'filled');
      const result = await processPaperQuote(f.orderId, quote(now + 2000, prices),
        { statePath: f.statePath, now: now + 2000, emergencyStop: true });
      assert.equal(result.status, 'closed');
      assert.equal(result.order.exitPrice, 0);
      assert.ok(result.order.realizedPnlUsd < 0);
    } finally { await f.cleanup(); }
  }
});

test('missing or corrupt saved entry limits cannot be supplied by a monitor', async () => {
  const f = await fixture();
  try {
    const original = JSON.parse(await readFile(f.statePath, 'utf8'));
    for (const value of [undefined, null, {}, [], { maxQuoteAgeMs: true, maxSpreadPct: 0.2 },
      { maxQuoteAgeMs: 5000, maxSpreadPct: null }, { maxQuoteAgeMs: 0, maxSpreadPct: 0.2 }]) {
      const ledger = structuredClone(original);
      ledger.orders[0].entryQuotePolicy = value;
      await writeFile(f.statePath, JSON.stringify(ledger));
      const before = await readFile(f.statePath, 'utf8');
      const result = await processPaperQuote(f.orderId, quote(now + 1000),
        { statePath: f.statePath, now: now + 1000, emergencyStop: false });
      assert.equal(result.reason, 'entry_quote_policy_unavailable');
      assert.equal(await readFile(f.statePath, 'utf8'), before);
    }
    assert.equal((await processPaperQuote(f.orderId, null,
      { statePath: f.statePath, now: now + 1000, emergencyStop: true })).status, 'cancelled');
    const expired = structuredClone(original);
    delete expired.orders[0].entryQuotePolicy;
    await writeFile(f.statePath, JSON.stringify(expired));
    assert.equal((await processPaperQuote(f.orderId, null,
      { statePath: f.statePath, now: now + 3_600_000, emergencyStop: false })).reason, 'time_exit_before_fill');
  } finally { await f.cleanup(); }
});

test('legacy filled positions can still be marked and stopped without widening entry eligibility', async () => {
  const f = await fixture();
  try {
    await processPaperQuote(f.orderId, quote(now + 1000), { statePath: f.statePath, now: now + 1000, emergencyStop: false });
    const ledger = JSON.parse(await readFile(f.statePath, 'utf8'));
    delete ledger.orders[0].entryQuotePolicy;
    delete ledger.orders[0].paperExecutionVersion;
    await writeFile(f.statePath, JSON.stringify(ledger));
    const closed = await processPaperQuote(f.orderId, quote(now + 2000, { bid: 98.9, ask: 99.5 }),
      { statePath: f.statePath, now: now + 2000, emergencyStop: false });
    assert.equal(closed.status, 'closed', 'wide spread must not prevent a risk-reducing stop exit');
    assert.equal(closed.order.exitReason, 'stop');
    assert.equal(closed.order.exitPrice, 98.9);
  } finally { await f.cleanup(); }
});

test('invalid runtime policies are not coerced into permissive limits', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.statePath, 'utf8');
    for (const field of ['maxQuoteAgeMs', 'maxSpreadPct']) for (const value of [null, '', ' ', true, false, [], {}, NaN, Infinity, -1]) {
      const result = await processPaperQuote(f.orderId, quote(now + 1000),
        { statePath: f.statePath, now: now + 1000, emergencyStop: false, [field]: value });
      assert.equal(result.reason, 'invalid_quote_policy', `${field}: ${String(value)}`);
    }
    assert.equal(await readFile(f.statePath, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('approval fingerprint prevents changing the entry spread limit before reservation', async () => {
  const candidate = proposal();
  const decision = evaluatePaperCandidate(candidate, { accountEquity: 10_000 }, { now, maxSpreadPct: 0.2 });
  assert.equal(decision.status, 'paper-approved');
  decision.riskLimits.maxSpreadPct = 50;
  assert.equal((await reservePaperCandidate(candidate, decision, { now, emergencyStop: false })).reason, 'approval_candidate_mismatch');
});
