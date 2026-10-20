import { stockQuoteEvidence, stockQuote, withStockCandidateEvidence } from '../fixtures/stockQuoteEvidence.js';
import { coinbaseBookEvidence, cryptoRulesFixture } from '../fixtures/cryptoBookEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePaperCandidate, inspectPaperRiskLock, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger, transitionPaperOrder } from '../paperRisk.js';

const now = Date.parse('2026-09-29T15:00:00.000Z');
// These exit-only fixtures model an already recorded historical fill. Legacy
// reservations without original entry evidence are intentionally no longer fillable.
async function seedLegacyFilledPosition(statePath, orderId, fillPrice) {
  const ledger = await readPaperRiskLedger({ statePath });
  Object.assign(ledger.orders.find(order => order.orderId === orderId), { status: 'filled', fillPrice,
    filledAt: new Date(now + 1000).toISOString(), lastProcessedQuoteTime: new Date(now + 1000).toISOString() });
  await writeFile(statePath, JSON.stringify(ledger));
}
const candidate = (overrides = {}) => withStockCandidateEvidence({
  mode: 'paper', owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPY', exposureKey: 'SPY',
  idempotencyKey: 'spy:opening-range:2026-09-29:long', strategyId: 'test-orb', sessionDate: '2026-09-29', direction: 'long',
  bid: 150, ask: 150.1, entryPrice: 150.1, stopPrice: 149.6, targetPrice: 151.1,
  quoteTime: new Date(now - 5_000).toISOString(), quoteQuality: 'executable',
  sessionOpen: true, forceExitAt: new Date(now + 4 * 60 * 60_000).toISOString(), multiplier: 1, lotSize: 1, roundTripFeesPerUnit: 0.02,
  slippageReservePerUnit: 0.03, ...overrides,
});
const portfolio = (overrides = {}) => ({ accountEquity: 10_000, realizedPnlToday: 0, openPositions: [], ...overrides });
const policy = (overrides = {}) => ({ now, maxQuoteAgeMs: 60_000, maxSpreadPct: 0.2, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 200, maxDailyLossPct: 1, minRewardRisk: 1.25, ...overrides });

function reserveInChild(input) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/reservePaperWorker.js', import.meta.url))], {
      env: { ...process.env, OMNIMOD_TEST_RESERVATION: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    worker.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    worker.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    worker.once('error', reject);
    worker.once('close', (code) => {
      if (code !== 0) return reject(new Error(`reservation child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`invalid child response: ${stdout} ${stderr}; ${error.message}`)); }
    });
  });
}

test('lock inspector reports missing, active, stale-owner-absent, remote, and legacy locks without changing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-lock-inspect-'));
  const statePath = join(directory, 'ledger.json');
  const lockPath = `${statePath}.lock`;
  const inspectionNow = Date.now() + 5_000;
  try {
    assert.equal((await inspectPaperRiskLock({ statePath, now: inspectionNow })).classification, 'unlocked');

    await writeFile(lockPath, JSON.stringify({ pid: 42, hostname: 'local-host', operation: 'reserve-candidate', startedAt: new Date(inspectionNow - 5_000).toISOString() }));
    const active = await inspectPaperRiskLock({ statePath, now: inspectionNow, staleAfterMs: 1_000, host: 'local-host', pidStatus: () => 'present' });
    assert.equal(active.classification, 'owner-process-present');
    assert.equal(active.olderThanThreshold, true);
    assert.equal(active.recovery, 'manual-review-required; lock was not modified');

    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, hostname: 'local-host', operation: 'process-paper-quote', startedAt: new Date(inspectionNow - 120_000).toISOString() }));
    const crashed = await inspectPaperRiskLock({ statePath, now: inspectionNow, staleAfterMs: 60_000, host: 'local-host', pidStatus: () => 'absent' });
    assert.equal(crashed.classification, 'owner-process-absent');
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, 999_999_999);

    await writeFile(lockPath, JSON.stringify({ pid: 9, hostname: 'another-host', operation: 'reserve-candidate', startedAt: new Date(inspectionNow).toISOString() }));
    const remote = await inspectPaperRiskLock({ statePath, now: inspectionNow, host: 'local-host', pidStatus: () => { throw new Error('must not probe remote pid'); } });
    assert.equal(remote.classification, 'owner-host-is-remote');

    await writeFile(lockPath, '');
    const legacy = await inspectPaperRiskLock({ statePath, now: inspectionNow });
    assert.equal(legacy.classification, 'metadata-missing-or-invalid');
    assert.equal(await readFile(lockPath, 'utf8'), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paper risk gate sizes from stop risk and estimated fees/slippage', () => {
  const result = evaluatePaperCandidate(candidate(), portfolio(), policy());
  assert.equal(result.status, 'paper-approved');
  assert.equal(result.paperOnly, true);
  assert.equal(result.owner, 'etfs-etps');
  assert.equal(result.sizing.units, 45);
  assert.ok(result.sizing.proposedRiskUsd <= result.sizing.riskBudgetUsd);
  assert.equal(result.sizing.grossRewardRisk, 2);
  assert.ok(result.sizing.rewardRisk < result.sizing.grossRewardRisk);
  assert.equal(result.sizing.roundTripCostReservePerUnitUsd, 0.05);
});

test('configured closed-trade circuits distinguish current loss streak and drawdown from incomplete history', () => {
  const closedOrders = [
    { status: 'closed', realizedPnlUsd: -120, grossPnlUsd: -120, feesUsd: 0, slippageUsd: 0,
      closedAt: '2026-09-25T15:00:00.000Z' },
    { status: 'closed', realizedPnlUsd: -100, grossPnlUsd: -100, feesUsd: 0, slippageUsd: 0,
      closedAt: '2026-09-26T15:00:00.000Z' },
  ];
  const account = portfolio({ closedOrders });
  const streak = evaluatePaperCandidate(candidate(), account, policy({ maxConsecutiveLosses: 2 }));
  assert.ok(streak.reasons.includes('consecutive_loss_limit'));
  const drawdown = evaluatePaperCandidate(candidate(), account, policy({ maxClosedDrawdownPct: 2 }));
  assert.ok(drawdown.reasons.includes('maximum_closed_drawdown_limit'));
  const recovered = evaluatePaperCandidate(candidate(), portfolio({ closedOrders: [
    ...closedOrders, { status: 'closed', realizedPnlUsd: 300, grossPnlUsd: 300, feesUsd: 0, slippageUsd: 0,
      closedAt: '2026-09-27T15:00:00.000Z' },
  ] }), policy({ maxClosedDrawdownPct: 2 }));
  assert.ok(recovered.reasons.includes('maximum_closed_drawdown_limit'), 'recovery must not silently reset the historical circuit');
  const incomplete = evaluatePaperCandidate(candidate(), portfolio({ closedOrders: [
    ...closedOrders, { status: 'closed', realizedPnlUsd: null, closedAt: '2026-09-27T15:00:00.000Z' },
  ] }), policy({ maxConsecutiveLosses: 3 }));
  assert.ok(incomplete.reasons.includes('closed_trade_sequence_unavailable'));
  const netOnly = evaluatePaperCandidate(candidate(), portfolio({ closedOrders: [
    { status: 'closed', realizedPnlUsd: -1, closedAt: '2026-09-27T15:00:00.000Z' },
  ] }), policy({ maxConsecutiveLosses: 3 }));
  assert.ok(netOnly.reasons.includes('closed_trade_sequence_unavailable'),
    'an optional closed-trade circuit cannot trust a net-only legacy result');
  for (const invalid of [{ maxConsecutiveLosses: 0 }, { maxConsecutiveLosses: 1.5 },
    { maxClosedDrawdownPct: '' }, { maxClosedDrawdownPct: 101 }]) {
    assert.ok(evaluatePaperCandidate(candidate(), portfolio(), policy(invalid)).reasons.includes('invalid_risk_policy_or_daily_pnl'));
  }
});

test('atomic reservation enforces closed-trade circuits and anchors settings across processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-closed-circuit-'));
  const statePath = join(directory, 'ledger.json');
  const losses = [
    { status: 'closed', realizedPnlUsd: -120, grossPnlUsd: -120, feesUsd: 0, slippageUsd: 0,
      closedAt: '2026-09-25T15:00:00.000Z' },
    { status: 'closed', realizedPnlUsd: -100, grossPnlUsd: -100, feesUsd: 0, slippageUsd: 0,
      closedAt: '2026-09-26T15:00:00.000Z' },
  ];
  try {
    const proposal = candidate();
    const approved = evaluatePaperCandidate(proposal, portfolio(), policy({ maxConsecutiveLosses: 2 }));
    assert.equal(approved.status, 'paper-approved');
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, accountEquityUsd: 10_000,
      orders: losses, events: [] }));
    const blocked = await reservePaperCandidate(proposal, approved, { statePath, now, emergencyStop: false });
    assert.equal(blocked.reason, 'consecutive_loss_limit_at_reservation');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 2);

    const drawdownDecision = evaluatePaperCandidate(proposal, portfolio(), policy({ maxClosedDrawdownPct: 2 }));
    assert.equal((await reservePaperCandidate(proposal, drawdownDecision, { statePath, now,
      emergencyStop: false })).reason, 'maximum_closed_drawdown_limit_at_reservation');

    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, accountEquityUsd: 10_000,
      orders: [...losses, { status: 'closed', realizedPnlUsd: null,
        closedAt: '2026-09-27T15:00:00.000Z' }], events: [] }));
    assert.equal((await reservePaperCandidate(proposal, approved, { statePath, now,
      emergencyStop: false })).reason, 'closed_trade_sequence_unavailable_at_reservation');

    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, accountEquityUsd: 10_000,
      orders: [], events: [] }));
    const first = await reservePaperCandidate(proposal, approved, { statePath, now, emergencyStop: false });
    assert.equal(first.status, 'reserved');
    assert.deepEqual((await readPaperRiskLedger({ statePath })).closedTradeCircuit,
      { maxConsecutiveLosses: 2, maxClosedDrawdownPct: null });
    const other = candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:other' });
    const weaker = evaluatePaperCandidate(other, portfolio(), policy({ maxConsecutiveLosses: 3 }));
    assert.equal((await reserveInChild({ candidate: other, decision: weaker, statePath, now })).reason,
      'closed_trade_circuit_policy_mismatch_at_reservation');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reservation persists sanitized research context without changing risk approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-paper-context-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const input = candidate({ researchContext: { setupType: 'opening_range_breakout', marketRegime: 'risk_on', discoveryVersion: 'etf-full-directory-v1',
      observedAt: new Date(now - 10_000).toISOString(), features: { relative_volume: 1.7, invalid: true } } });
    const decision = evaluatePaperCandidate(input, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    const reservation = await reservePaperCandidate(input, decision, { statePath, now, emergencyStop: false });
    assert.equal(reservation.status, 'reserved');
    assert.equal(reservation.order.researchContext.marketRegime, 'risk_on');
    assert.deepEqual(reservation.order.researchContext.features, { relative_volume: 1.7 });
    assert.equal((await readPaperRiskLedger({ statePath })).orders[0].researchContext.setupType, 'opening_range_breakout');
    assert.equal((await readPaperRiskLedger({ statePath })).orders[0].researchContext.discoveryVersion, 'etf-full-directory-v1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paper ledger reader rejects malformed order and event row containers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-ledger-schema-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    for (const ledger of [
      { schemaVersion: 1, orders: [null], events: [] },
      { schemaVersion: 1, orders: [{ status: 'opne', riskUsd: 10, notionalUsd: 100 }], events: [] },
      { schemaVersion: 1, orders: [{ riskUsd: 10, notionalUsd: 100 }], events: [] },
      { schemaVersion: 1, orders: [], events: 'not-an-array' },
      { schemaVersion: 1, orders: [], events: [null] },
    ]) {
      await writeFile(statePath, JSON.stringify(ledger));
      await assert.rejects(readPaperRiskLedger({ statePath }), /Invalid paper risk ledger/);
    }
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, orders: [] }));
    assert.deepEqual((await readPaperRiskLedger({ statePath })).events, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paper risk requires explicit nonblank numeric fee and slippage reserves', () => {
  for (const field of ['roundTripFeesPerUnit', 'slippageReservePerUnit']) {
    for (const value of [undefined, null, '', '   ', true, NaN, Infinity, -0.01]) {
      const result = evaluatePaperCandidate(candidate({ [field]: value }), portfolio(), policy());
      assert.equal(result.status, 'blocked', `${field}=${String(value)} must not become a zero-cost assumption`);
      assert.ok(result.reasons.includes('cost_reserve_missing_or_invalid'));
    }
  }
  const numericStrings = evaluatePaperCandidate(candidate({ roundTripFeesPerUnit: '0.02', slippageReservePerUnit: '0.03' }), portfolio(), policy());
  assert.equal(numericStrings.status, 'paper-approved', 'finite non-negative numeric strings remain supported');
  const explicitZero = evaluatePaperCandidate(candidate({ roundTripFeesPerUnit: 0, slippageReservePerUnit: 0 }), portfolio(), policy());
  assert.equal(explicitZero.status, 'paper-approved', 'explicit numeric zero remains a valid deliberate assumption');
});

test('paper risk refuses booleans and blank strings wherever positive values are required', () => {
  for (const [field, expectedReason] of [
    ['bid', 'invalid_bid_ask'], ['ask', 'invalid_bid_ask'],
    ['entryPrice', 'invalid_price_levels'], ['stopPrice', 'invalid_price_levels'], ['targetPrice', 'invalid_price_levels'],
    ['multiplier', 'invalid_contract_multiplier_or_lot_size'], ['lotSize', 'invalid_contract_multiplier_or_lot_size'],
  ]) {
    for (const value of [true, false, '']) {
      const result = evaluatePaperCandidate(candidate({ [field]: value }), portfolio(), policy());
      assert.equal(result.status, 'blocked', `${field}=${String(value)}`);
      assert.ok(result.reasons.includes(expectedReason), `${field}=${String(value)}: ${result.reasons.join(',')}`);
    }
  }
  for (const accountEquity of [true, false, '']) {
    const result = evaluatePaperCandidate(candidate(), portfolio({ accountEquity }), policy());
    assert.equal(result.status, 'blocked', `accountEquity=${String(accountEquity)}`);
    assert.ok(result.reasons.includes('invalid_account_equity'));
  }
  for (const maxTradeRiskPct of [true, false, '']) {
    const result = evaluatePaperCandidate(candidate(), portfolio(), policy({ maxTradeRiskPct }));
    assert.equal(result.status, 'blocked', `maxTradeRiskPct=${String(maxTradeRiskPct)}`);
    assert.ok(result.reasons.includes('invalid_risk_policy_or_daily_pnl'));
  }
});

test('ledger summary separates each market session P&L from the shared UTC risk day', () => {
  const ledger = { orders: [
    { status: 'closed', closedAt: '2026-09-30T00:30:00.000Z', closedSessionDate: '2026-09-29',
      realizedPnlUsd: -20, grossPnlUsd: -20, feesUsd: 0, slippageUsd: 0 },
    { status: 'closed', closedAt: '2026-09-30T02:30:00.000Z', closedSessionDate: '2026-09-30',
      realizedPnlUsd: 8, grossPnlUsd: 8, feesUsd: 0, slippageUsd: 0 },
    { status: 'closed', closedAt: '2026-09-29T23:59:59.000Z', closedSessionDate: '2026-09-29',
      realizedPnlUsd: 50, grossPnlUsd: 50, feesUsd: 0, slippageUsd: 0 },
  ] };
  const summary = summarizePaperLedger(ledger, { sessionDate: '2026-09-30', now: Date.parse('2026-09-30T03:00:00.000Z') });
  assert.equal(summary.realizedPnlTodayUsd, 8, 'market-session reporting remains keyed to the supplied session date');
  assert.equal(summary.riskDayUtc, '2026-09-30');
  assert.equal(summary.realizedPnlRiskDayUtcUsd, -12, 'the account circuit-breaker day is common UTC across markets');
});

test('unreconciled current-day paper costs make daily loss and after-cost performance unavailable', () => {
  const riskDate = new Date(now).toISOString().slice(0, 10);
  const base = { owner: 'stocks', strategyId: 'opening_range', status: 'closed',
    closedAt: new Date(now - 60_000).toISOString(), closedSessionDate: riskDate,
    realizedPnlUsd: -25, grossPnlUsd: -15, feesUsd: 5, slippageUsd: 5 };
  for (const defect of [{ feesUsd: null }, { realizedPnlUsd: -5 }]) {
    const order = { ...base, ...defect };
    const summary = summarizePaperLedger({ orders: [order] }, { sessionDate: riskDate, now });
    assert.equal(summary.realizedPnlTodayUsd, null);
    assert.equal(summary.realizedPnlRiskDayUtcUsd, null);
    assert.equal(summary.netPnlUsd, null);
    assert.equal(summary.expectancyUsd, null);
    assert.equal(summary.closedTradesUnreconciledCostAccounting, 1);
    assert.equal(summary.maxDrawdownUsd, null);
    const preflight = evaluatePaperCandidate(candidate(), portfolio({ realizedPnlToday: summary.realizedPnlRiskDayUtcUsd }), policy());
    assert.ok(preflight.reasons.includes('invalid_risk_policy_or_daily_pnl'));
  }
  const prior = summarizePaperLedger({ orders: [{ ...base, closedAt: '2026-09-28T14:00:00Z',
    closedSessionDate: '2026-09-28', feesUsd: null }] }, { sessionDate: riskDate, now });
  assert.equal(prior.realizedPnlRiskDayUtcUsd, 0, 'a dated prior-day accounting gap does not fabricate today\'s loss');
  assert.equal(prior.netPnlUsd, null, 'lifetime after-cost evidence still remains incomplete');
});

test('ledger performance withholds full-cohort totals when closed P&L is missing', () => {
  const summary = summarizePaperLedger({ orders: [
    { owner: 'crypto', strategyId: 'test', status: 'closed', closedAt: '2026-09-29T14:00:00Z', realizedPnlUsd: 10, riskUsd: 20 },
    { owner: 'crypto', strategyId: 'test', status: 'closed', closedAt: '2026-09-29T14:01:00Z', realizedPnlUsd: null, riskUsd: 20 },
    { owner: 'crypto', strategyId: 'test', status: 'closed', closedAt: '2026-09-29T14:02:00Z', realizedPnlUsd: -4, riskUsd: 20 },
    { owner: 'crypto', strategyId: 'test', status: 'closed', closedAt: '2026-09-29T14:03:00Z', realizedPnlUsd: true, riskUsd: 20 },
  ] });
  assert.equal(summary.closedCount, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.netPnlUsd, null);
  assert.equal(summary.expectancyUsd, null);
  assert.equal(summary.profitFactor, null);
  assert.equal(summary.maxDrawdownUsd, null, 'an unknown close blocks full-cohort sequence metrics');
  assert.equal(summary.closeSequenceStatus, 'incomplete_close_sequence');
  assert.equal(summary.byBotAndStrategy['crypto:test'].closedCount, 2);
  assert.equal(summary.closedTradesMissingRealizedPnl, 2, 'unknown and malformed outcomes stay outside performance but remain visible');
});

test('missing open or daily P&L remains unknown and blocks a new paper approval', () => {
  const riskDate = new Date(now).toISOString().slice(0, 10);
  const summary = summarizePaperLedger({ orders: [
    { owner: 'stocks', status: 'closed', closedAt: `${riskDate}T14:00:00Z`, closedSessionDate: riskDate,
      realizedPnlUsd: null },
    { owner: 'crypto', status: 'open', unrealizedPnlUsd: null },
  ] }, { sessionDate: riskDate, now });
  assert.equal(summary.realizedPnlTodayUsd, null);
  assert.equal(summary.realizedPnlRiskDayUtcUsd, null);
  assert.equal(summary.unrealizedPnlUsd, null);
  const result = evaluatePaperCandidate(candidate(), portfolio({ realizedPnlToday: summary.realizedPnlRiskDayUtcUsd }), policy());
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('invalid_risk_policy_or_daily_pnl'));
  assert.equal(evaluatePaperCandidate(candidate(), portfolio({ realizedPnlToday: 0 }), policy()).status, 'paper-approved');
});

test('an undated close cannot be excluded from the current UTC risk-day total', () => {
  const summary = summarizePaperLedger({ orders: [
    { status: 'closed', realizedPnlUsd: -5, closedAt: null, closedSessionDate: null },
  ] }, { sessionDate: '2026-09-29', now });
  assert.equal(summary.realizedPnlTodayUsd, null);
  assert.equal(summary.realizedPnlRiskDayUtcUsd, null);
  assert.equal(summary.unclassifiedClosedTrades, 1);
  const priorDay = summarizePaperLedger({ orders: [
    { status: 'closed', realizedPnlUsd: null, closedAt: '2026-09-28T15:00:00Z', closedSessionDate: '2026-09-28' },
  ] }, { sessionDate: '2026-09-29', now });
  assert.equal(priorDay.realizedPnlTodayUsd, 0);
  assert.equal(priorDay.realizedPnlRiskDayUtcUsd, 0);
  assert.equal(priorDay.netPnlUsd, null);
});

test('shared paper approval uses a five-second future timestamp tolerance', () => {
  const withinSkew = evaluatePaperCandidate(candidate({ quoteTime: new Date(now + 5_000).toISOString() }), portfolio(), policy());
  const beyondSkew = evaluatePaperCandidate(candidate({ quoteTime: new Date(now + 5_001).toISOString() }), portfolio(), policy());
  assert.equal(withinSkew.status, 'paper-approved');
  assert.ok(beyondSkew.reasons.includes('stale_or_future_quote'));
});

test('atomic paper reservation rejects a candidate or sizing decision changed after approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-approval-binding-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const changedCandidate = candidate({ ...proposal, idempotencyKey: 'changed-after-approval', stopPrice: 149 });
    const candidateMismatch = await reservePaperCandidate(changedCandidate, decision, { statePath, now, emergencyStop: false });
    assert.deepEqual(candidateMismatch, { status: 'blocked', reason: 'approval_candidate_mismatch' });

    const changedSizing = structuredClone(decision);
    changedSizing.sizing.units += 1;
    const sizingMismatch = await reservePaperCandidate(proposal, changedSizing, { statePath, now, emergencyStop: false });
    assert.deepEqual(sizingMismatch, { status: 'blocked', reason: 'approval_candidate_mismatch' });
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('final paper reservation rechecks the five-second quote timestamp boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-reservation-clock-skew-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const proposal = candidate({ quoteTime: new Date(now + 10_000).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy({ now: now + 6_000 }));
    assert.equal(decision.status, 'paper-approved', 'approval clock sees quote only 4 seconds ahead');
    const reservation = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.deepEqual(reservation, { status: 'blocked', reason: 'quote_expired_before_reservation' });
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('final ledger reservation refuses live-mode requests for all six market owners without writing an order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-live-mode-guard-'));
  const statePath = join(directory, 'paper-ledger.json');
  const previousLiveFlag = process.env.OMNIMOD_LIVE_TRADING_ENABLED;
  try {
    const cases = [
      { assetClass: 'stock', owner: 'stocks', instrumentKey: 'AAPL', stockQuoteEvidence: stockQuoteEvidence('AAPL', { bid: 150, ask: 150.1, time: new Date(now - 5000).toISOString() }) },
      { assetClass: 'crypto', owner: 'crypto', instrumentKey: 'BTC', lotSize: 0.00000001, cryptoInstrumentRules: cryptoRulesFixture(candidate()), cryptoQuoteEvidence: coinbaseBookEvidence(candidate()), cryptoIdentity: {
        version: 1, namespace: 'coingecko', assetId: 'bitcoin', provider: 'Coinbase', pair: 'BTC-USD', base: 'BTC',
        quoteCurrency: 'USD', verificationSource: 'coingecko_tickers_complete', verifiedAt: new Date(now).toISOString() } },
      { assetClass: 'forex', owner: 'forex', instrumentKey: 'EUR_USD' },
      { assetClass: 'future', owner: 'futures', instrumentKey: 'ESZ6', initialMarginUsd: 200, maintenanceMarginUsd: 150,
        future: { providerRawSymbol: 'ESZ6' } },
      { assetClass: 'option', owner: 'options', instrumentKey: 'SPY-CALL-DEBIT-SPREAD', exposureKey: 'SPY' },
      { assetClass: 'etf', owner: 'etfs-etps', instrumentKey: 'SPY', exposureKey: 'SPY' },
    ];
    process.env.OMNIMOD_LIVE_TRADING_ENABLED = 'true';
    for (const [index, market] of cases.entries()) {
      const proposal = candidate({ ...market, idempotencyKey: `${market.owner}:live-guard:${index}` });
      const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
      assert.equal(decision.status, 'paper-approved', `${market.owner} fixture must reach the final reservation guard: ${decision.reasons}`);
      const reservation = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
      assert.deepEqual(reservation, { status: 'blocked', reason: 'live_trading_is_not_implemented' }, market.owner);
    }
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 0);
  } finally {
    if (previousLiveFlag == null) delete process.env.OMNIMOD_LIVE_TRADING_ENABLED;
    else process.env.OMNIMOD_LIVE_TRADING_ENABLED = previousLiveFlag;
    await rm(directory, { recursive: true, force: true });
  }
});

test('declared wrapper leverage scales gross exposure caps while preserving stop-risk sizing', () => {
  const plain = evaluatePaperCandidate(candidate(), portfolio(), policy({ maxGrossExposurePct: 100 }));
  const leveragedCandidate = candidate({ assetClass: 'etp', exposureMultiplier: 3,
    instrumentMetadata: { productType: 'leveraged_etf', leverage: 3, inverse: false } });
  const leveraged = evaluatePaperCandidate(leveragedCandidate, portfolio(), policy({ maxGrossExposurePct: 100 }));
  assert.equal(plain.status, 'paper-approved');
  assert.equal(leveraged.status, 'blocked');
  assert.ok(leveraged.reasons.includes('gross_exposure_limit'));
  assert.equal(leveraged.sizing.proposedNotionalUsd, plain.sizing.proposedNotionalUsd * 3);
  assert.equal(leveraged.sizing.proposedRiskUsd, plain.sizing.proposedRiskUsd);
  assert.equal(leveraged.sizing.notionalExposureMultiplier, 3);
  assert.ok(evaluatePaperCandidate(candidate({ exposureMultiplier: 11 }), portfolio(), policy()).reasons.includes('invalid_notional_exposure_multiplier'));
});

test('paper reward/risk approval uses net target reward and stop risk after configured costs', () => {
  const proposal = candidate({ roundTripFeesPerUnit: 0.2, slippageReservePerUnit: 0.2 });
  const result = evaluatePaperCandidate(proposal, portfolio(), policy({ minRewardRisk: 1.25 }));
  assert.equal(result.sizing.grossRewardRisk, 2);
  assert.equal(result.sizing.rewardRisk, Number((0.6 / 0.9).toFixed(3)));
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('reward_risk_below_minimum'));
});

test('stale, non-executable, wrong-owner, conflicting, and emergency-stop candidates fail closed', () => {
  for (const [proposal, positions, limits, reason] of [
    [candidate({ quoteTime: new Date(now - 61_000).toISOString() }), [], {}, 'stale_or_future_quote'],
    [candidate({ quoteQuality: 'delayed-reference' }), [], {}, 'quote_not_executable'],
    [candidate({ owner: 'stocks' }), [], {}, 'primary_bot_owner_mismatch'],
    [candidate(), [{ status: 'open', instrumentKey: 'SPY', exposureKey: 'SPY', direction: 'short' }], {}, 'conflicting_open_exposure'],
    [candidate(), [], { emergencyStop: true }, 'emergency_stop_active'],
    [candidate(), [], { liveTradingEnabled: true }, 'live_trading_disabled'],
  ]) {
    const result = evaluatePaperCandidate(proposal, portfolio({ openPositions: positions }), policy(limits));
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
  }
});

test('shared exposure gate canonicalizes leveraged ETF wrappers across legacy ledger rows and asset classes', () => {
  const leveragedEtf = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'TQQQ', exposureKey: 'TQQQ' });
  const existingNasdaq = { status: 'open', instrumentKey: 'QQQ', exposureKey: 'QQQ', assetClass: 'stock', direction: 'long' };
  const etfVsStock = evaluatePaperCandidate(leveragedEtf, portfolio({ openPositions: [existingNasdaq] }), policy());
  assert.ok(etfVsStock.reasons.includes('duplicate_open_exposure'));

  const inverseLong = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPXU', exposureKey: 'SPY',
    instrumentMetadata: { productType: 'inverse_etf', inverse: true }, direction: 'long' });
  const spyLong = { status: 'open', instrumentKey: 'SPY', exposureKey: 'SPY', assetClass: 'stock', direction: 'long' };
  const inverseOffsetsSpy = evaluatePaperCandidate(inverseLong, portfolio({ openPositions: [spyLong] }), policy());
  assert.ok(inverseOffsetsSpy.reasons.includes('conflicting_open_exposure'));
  assert.ok(!inverseOffsetsSpy.reasons.includes('duplicate_open_exposure'));
  const spyShort = { ...spyLong, direction: 'short' };
  const inverseDuplicatesSpyShort = evaluatePaperCandidate(inverseLong, portfolio({ openPositions: [spyShort] }), policy());
  assert.ok(inverseDuplicatesSpyShort.reasons.includes('duplicate_open_exposure'));

  const misconfiguredEs = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_ESZ6', exposureKey: 'WRONG_KEY',
    future: { contractId: 'CME:ES:202612', providerRawSymbol: 'ESZ6' }, initialMarginUsd: 1_000, maintenanceMarginUsd: 900,
    multiplier: 50, entryPrice: 5000, stopPrice: 4990, targetPrice: 5020, bid: 4999.75, ask: 5000 });
  const leveragedSp = { status: 'open', instrumentKey: 'UPRO', exposureKey: 'UPRO', assetClass: 'etf', direction: 'long', riskUsd: 20,
    notionalUsd: 5_000, marginRequirementUsd: 0 };
  const futuresVsEtf = evaluatePaperCandidate(misconfiguredEs, portfolio({ openPositions: [leveragedSp] }), policy({ maxSpreadPct: 1 }));
  assert.ok(futuresVsEtf.reasons.includes('duplicate_open_exposure'));

  const spotBtcEtp = candidate({ owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'IBIT', exposureKey: 'IBIT' });
  const cryptoBtc = { status: 'open', instrumentKey: 'BTC', exposureKey: 'BTC', assetClass: 'crypto', direction: 'long' };
  const etpVsCrypto = evaluatePaperCandidate(spotBtcEtp, portfolio({ openPositions: [cryptoBtc] }), policy());
  assert.ok(etpVsCrypto.reasons.includes('duplicate_open_exposure'));

  const microBtcFuture = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_MBTZ6', exposureKey: 'WRONG_KEY',
    future: { contractId: 'CME:MBT:202612', providerRawSymbol: 'MBTZ6' }, initialMarginUsd: 500, maintenanceMarginUsd: 450 });
  const microVsSpot = evaluatePaperCandidate(microBtcFuture, portfolio({ openPositions: [{ ...cryptoBtc, direction: 'short' }] }), policy({ maxSpreadPct: 1 }));
  assert.ok(microVsSpot.reasons.includes('conflicting_open_exposure'));

  const spyOption = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY-CALL-SPREAD', exposureKey: 'SPY' });
  const upro = { status: 'open', instrumentKey: 'UPRO', exposureKey: 'UPRO', assetClass: 'etf', direction: 'short' };
  const optionVsLegacyEtf = evaluatePaperCandidate(spyOption, portfolio({ openPositions: [upro] }), policy());
  assert.ok(optionVsLegacyEtf.reasons.includes('conflicting_open_exposure'));

  const leveragedUnderlyingOption = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'TQQQ-CALL-SPREAD', exposureKey: 'TQQQ' });
  const qqqLong = { status: 'open', instrumentKey: 'QQQ', exposureKey: 'QQQ', assetClass: 'stock', direction: 'long' };
  const optionVsNasdaq = evaluatePaperCandidate(leveragedUnderlyingOption, portfolio({ openPositions: [qqqLong] }), policy());
  assert.ok(optionVsNasdaq.reasons.includes('duplicate_open_exposure'));

  const bitcoinEtpOption = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'IBIT-CALL-SPREAD', exposureKey: 'IBIT' });
  const btcLong = { status: 'open', instrumentKey: 'BTC', exposureKey: 'BTC', assetClass: 'crypto', direction: 'long' };
  const optionVsBtc = evaluatePaperCandidate(bitcoinEtpOption, portfolio({ openPositions: [btcLong] }), policy());
  assert.ok(optionVsBtc.reasons.includes('duplicate_open_exposure'));

  const bearishPutSpread = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY-PUT-DEBIT-SPREAD', exposureKey: 'SPY',
    direction: 'long', underlyingDirection: 'short' });
  const spyShortPosition = { status: 'open', instrumentKey: 'SPY', exposureKey: 'SPY', assetClass: 'stock', direction: 'short' };
  const bearishOptionDuplicate = evaluatePaperCandidate(bearishPutSpread, portfolio({ openPositions: [spyShortPosition] }), policy());
  assert.ok(bearishOptionDuplicate.reasons.includes('duplicate_open_exposure'));
  assert.ok(!bearishOptionDuplicate.reasons.includes('conflicting_open_exposure'));
  const bullishOptionConflict = evaluatePaperCandidate(bearishPutSpread, portfolio({ openPositions: [spyLong] }), policy());
  assert.ok(bullishOptionConflict.reasons.includes('conflicting_open_exposure'));
  assert.ok(!bullishOptionConflict.reasons.includes('duplicate_open_exposure'));

  const treasuryFuture = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_ZNZ6', exposureKey: 'BAD_RATES_KEY',
    future: { contractId: 'CME_ZNZ6', providerRawSymbol: 'ZNZ6' }, initialMarginUsd: 1_000, maintenanceMarginUsd: 900 });
  const shortTreasuryEtf = { status: 'open', instrumentKey: 'TMV', exposureKey: 'TLT', assetClass: 'etf', direction: 'short' };
  const ratesConflict = evaluatePaperCandidate(treasuryFuture, portfolio({ openPositions: [shortTreasuryEtf] }), policy({ maxSpreadPct: 1 }));
  assert.ok(ratesConflict.reasons.includes('conflicting_open_exposure'));
});

test('shared exposure gate catches exact index ETF aliases against futures and stock positions', () => {
  const russellFuture = { status: 'open', assetClass: 'future', instrumentKey: 'CME_M2KZ6', exposureKey: 'WRONG',
    future: { providerRawSymbol: 'M2KZ6' }, direction: 'long' };
  const tza = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'TZA', exposureKey: 'TZA' });
  const russellReasons = evaluatePaperCandidate(tza, portfolio({ openPositions: [russellFuture] }), policy({ maxSpreadPct: 1 })).reasons;
  assert.ok(russellReasons.includes('duplicate_open_exposure') || russellReasons.includes('conflicting_open_exposure'));

  const nasdaqStock = { status: 'open', assetClass: 'stock', instrumentKey: 'QQQ', exposureKey: 'QQQ', direction: 'short' };
  const qld = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'QLD', exposureKey: 'QLD' });
  const nasdaqReasons = evaluatePaperCandidate(qld, portfolio({ openPositions: [nasdaqStock] }), policy()).reasons;
  assert.ok(nasdaqReasons.includes('duplicate_open_exposure') || nasdaqReasons.includes('conflicting_open_exposure'));
});

test('FX portfolio gate catches same-direction currency concentration across pairs and mapped futures', () => {
  const eurUsdLong = candidate({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', exposureKey: 'EUR_USD', direction: 'long' });
  const eurJpyLong = { status: 'open', owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_JPY', exposureKey: 'EUR_JPY', direction: 'long' };
  const concentrated = evaluatePaperCandidate(eurUsdLong, portfolio({ openPositions: [eurJpyLong] }), policy());
  assert.ok(concentrated.reasons.includes('concentrated_currency_exposure'));
  assert.deepEqual(concentrated.currencyExposureConflicts, [{ currency: 'EUR', direction: 'long', existingInstrument: 'EUR_JPY', existingOwner: 'forex' }]);

  const shortUsdJpy = candidate({ owner: 'forex', assetClass: 'forex', instrumentKey: 'USD_JPY', exposureKey: 'USD_JPY', direction: 'short' });
  const yenFutureLong = { status: 'open', owner: 'futures', assetClass: 'future', instrumentKey: 'CME_6JZ6', direction: 'long',
    future: { providerRawSymbol: '6JZ6' } };
  const futuresConcentration = evaluatePaperCandidate(shortUsdJpy, portfolio({ openPositions: [yenFutureLong] }), policy());
  assert.ok(futuresConcentration.reasons.includes('concentrated_currency_exposure'));
  const longUsdJpy = { ...shortUsdJpy, direction: 'long' };
  const yenFuturesHedge = evaluatePaperCandidate(longUsdJpy, portfolio({ openPositions: [yenFutureLong] }), policy());
  assert.ok(!yenFuturesHedge.reasons.includes('concentrated_currency_exposure'));

  for (const [root, pair] of [['6C', 'USD_CAD'], ['6S', 'USD_CHF'], ['6M', 'USD_MXN'], ['BR', 'USD_BRL'],
    ['6Z', 'USD_ZAR'], ['6R', 'USD_RUB'], ['SIR', 'USD_INR'], ['CKO', 'USD_CZK'], ['6H', 'USD_CNH'], ['UN', 'USD_NOK'], ['SE', 'USD_SEK']]) {
    const futureLong = { ...yenFutureLong, instrumentKey: `CME_${root}Z6`, future: { providerRawSymbol: `${root}Z6` } };
    const spotShort = candidate({ owner: 'forex', assetClass: 'forex', instrumentKey: pair, exposureKey: pair, direction: 'short' });
    assert.ok(evaluatePaperCandidate(spotShort, portfolio({ openPositions: [futureLong] }), policy()).reasons.includes('concentrated_currency_exposure'), `${root} should share same-direction foreign-currency risk with ${pair} short`);
    const spotLong = { ...spotShort, direction: 'long' };
    assert.ok(!evaluatePaperCandidate(spotLong, portfolio({ openPositions: [futureLong] }), policy()).reasons.includes('concentrated_currency_exposure'), `${root} and ${pair} long should offset in both legs`);
  }
  const microYenLong = { ...yenFutureLong, instrumentKey: 'CME_MJYZ6', future: { providerRawSymbol: 'MJYZ6' } };
  assert.ok(evaluatePaperCandidate(shortUsdJpy, portfolio({ openPositions: [microYenLong] }), policy()).reasons.includes('concentrated_currency_exposure'));
  const legacyMicroYenLong = { ...yenFutureLong, instrumentKey: 'CME_M6JZ6', future: { providerRawSymbol: 'M6JZ6' } };
  const legacyUsdJpyLong = { ...shortUsdJpy, direction: 'long' };
  const legacyExposureReasons = evaluatePaperCandidate(legacyUsdJpyLong, portfolio({ openPositions: [legacyMicroYenLong] }), policy()).reasons;
  assert.ok(legacyExposureReasons.includes('duplicate_open_exposure') || legacyExposureReasons.includes('conflicting_open_exposure'));

  const hedgedUsdLeg = { status: 'open', owner: 'forex', assetClass: 'forex', instrumentKey: 'GBP_USD', exposureKey: 'GBP_USD', direction: 'short' };
  const diversified = evaluatePaperCandidate(eurUsdLong, portfolio({ openPositions: [hedgedUsdLeg] }), policy());
  assert.ok(!diversified.reasons.includes('concentrated_currency_exposure'));
});

test('concurrent atomic FX reservations admit only one same-direction currency exposure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-fx-exposure-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const first = candidate({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_JPY', exposureKey: 'EUR_JPY',
      idempotencyKey: 'eurjpy-long', entryPrice: 160, stopPrice: 159.8, targetPrice: 160.6,
      bid: 159.999, ask: 160, multiplier: 1, roundTripFeesPerUnit: 0.001, slippageReservePerUnit: 0.001 });
    const firstDecision = evaluatePaperCandidate(first, portfolio(), policy({ maxSpreadPct: 0.2 }));
    assert.equal(firstDecision.status, 'paper-approved', JSON.stringify(firstDecision.reasons));

    const second = candidate({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', exposureKey: 'EUR_USD',
      idempotencyKey: 'eurusd-long', entryPrice: 1.1, stopPrice: 1.095, targetPrice: 1.115,
      bid: 1.0999, ask: 1.1, multiplier: 1, roundTripFeesPerUnit: 0.00001, slippageReservePerUnit: 0.00001 });
    const secondDecision = evaluatePaperCandidate(second, portfolio(), policy({ maxSpreadPct: 0.2 }));
    assert.equal(secondDecision.status, 'paper-approved', JSON.stringify(secondDecision.reasons));
    const results = await Promise.all([
      reservePaperCandidate(first, firstDecision, { statePath, now, emergencyStop: false }),
      reservePaperCandidate(second, secondDecision, { statePath, now, emergencyStop: false }),
    ]);
    assert.deepEqual(results.map((row) => row.status).sort(), ['exposure-conflict', 'reserved']);
    const conflict = results.find((row) => row.status === 'exposure-conflict');
    assert.equal(conflict.reason, 'concentrated_currency_exposure_at_reservation');
    assert.deepEqual(conflict.conflictingCurrencies, ['EUR']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('broad commodity ETN blocks overlapping mapped commodity sleeves in the shared exposure gate', () => {
  const djp = candidate({ owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'DJP', exposureKey: 'COMMODITY_BASKET' });
  for (const open of [
    { status: 'open', instrumentKey: 'GLD', exposureKey: 'GLD', assetClass: 'etf', direction: 'long' },
    { status: 'open', instrumentKey: 'CME_MCLZ6', exposureKey: 'OIL', assetClass: 'future', future: { providerRawSymbol: 'MCLZ6' }, direction: 'short' },
  ]) {
    const reasons = evaluatePaperCandidate(djp, portfolio({ openPositions: [open] }), policy()).reasons;
    assert.ok(reasons.includes('duplicate_open_exposure') || reasons.includes('conflicting_open_exposure'));
  }
  const unrelated = { status: 'open', instrumentKey: 'SPY', exposureKey: 'SPY', assetClass: 'etf', direction: 'long' };
  assert.ok(!evaluatePaperCandidate(djp, portfolio({ openPositions: [unrelated] }), policy()).reasons.includes('duplicate_open_exposure'));
});

test('daily loss, portfolio risk, spread, and missing paper mode stop candidates', () => {
  const cases = [
    [candidate(), portfolio({ realizedPnlToday: -100 }), {}, 'daily_loss_limit'],
    [candidate(), portfolio({ openPositions: [{ status: 'open', riskUsd: 80, notionalUsd: 0 }] }), {}, 'combined_open_risk_limit'],
    [candidate({ bid: 149, ask: 150.1 }), portfolio(), {}, 'spread_limit'],
    [candidate({ mode: undefined }), portfolio(), {}, 'live_trading_disabled'],
  ];
  for (const [proposal, account, limits, reason] of cases) {
    const result = evaluatePaperCandidate(proposal, account, policy(limits));
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.includes(reason));
  }
  for (const [account, limits] of [
    [portfolio(), { maxTradeRiskPct: NaN }],
    [portfolio({ realizedPnlToday: NaN }), {}],
    [portfolio({ openPositions: [{ status: 'open', riskUsd: NaN, notionalUsd: 100 }] }), {}],
  ]) {
    assert.equal(evaluatePaperCandidate(candidate(), account, policy(limits)).status, 'blocked');
    assert.ok(evaluatePaperCandidate(candidate(), account, policy(limits)).reasons.includes('invalid_risk_policy_or_daily_pnl'));
  }
});

test('daily loss gate includes marked open P&L and blocks positions with unavailable P&L', () => {
  const markedLoss = { status: 'open', riskUsd: 20, notionalUsd: 100, unrealizedPnlUsd: -100, markedAt: new Date(now - 1_000).toISOString() };
  const result = evaluatePaperCandidate(candidate(), portfolio({ openPositions: [markedLoss] }), policy());
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('daily_loss_limit'));
  assert.equal(result.riskLimits.dailyPnlUsd, -100);

  for (const unrealizedPnlUsd of [undefined, null, true, false, '', 'NaN']) {
    const unknown = evaluatePaperCandidate(candidate(), portfolio({ openPositions: [{ ...markedLoss, unrealizedPnlUsd }] }), policy());
    assert.equal(unknown.status, 'blocked');
    assert.ok(unknown.reasons.includes('open_position_pnl_unavailable'));
  }
});

test('stale open-position marks block approval even when a prior unrealized P&L value exists', () => {
  const stale = { status: 'open', riskUsd: 20, notionalUsd: 100, unrealizedPnlUsd: 0,
    markedAt: new Date(now - 5 * 60_000 - 1).toISOString() };
  const result = evaluatePaperCandidate(candidate(), portfolio({ openPositions: [stale] }), policy());
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('open_position_mark_stale_or_unavailable'));
  assert.equal(result.riskLimits.openPositionMarks.staleCount, 1);
});

test('another bot cannot loosen an existing position mark-age limit', () => {
  const tighterExistingPolicy = { status: 'open', riskUsd: 20, notionalUsd: 100, unrealizedPnlUsd: 0,
    maxOpenMarkAgeMs: 60_000, markedAt: new Date(now - 2 * 60_000).toISOString() };
  const result = evaluatePaperCandidate(candidate(), portfolio({ openPositions: [tighterExistingPolicy] }), policy({ maxOpenMarkAgeMs: 10 * 60_000 }));
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasons.includes('open_position_mark_stale_or_unavailable'));
});

test('account equity percentage limits cannot exceed 100% and minimum reward/risk cannot be configured below 1', () => {
  const invalidPolicies = [
    { maxTradeRiskPct: 100.01 }, { maxTotalOpenRiskPct: 100.01 },
    { maxDailyLossPct: 100.01 }, { maxInitialMarginPct: 100.01 },
    { minRewardRisk: 0.99 },
  ];
  for (const limits of invalidPolicies) {
    const result = evaluatePaperCandidate(candidate(), portfolio(), policy(limits));
    assert.equal(result.status, 'blocked', JSON.stringify(limits));
    assert.ok(result.reasons.includes('invalid_risk_policy_or_daily_pnl'), JSON.stringify(limits));
  }
  for (const limits of [
    { maxTradeRiskPct: 100 }, { maxTotalOpenRiskPct: 100 },
    { maxDailyLossPct: 100 }, { maxInitialMarginPct: 100 }, { minRewardRisk: 1 },
  ]) {
    const result = evaluatePaperCandidate(candidate(), portfolio(), policy(limits));
    assert.ok(!result.reasons.includes('invalid_risk_policy_or_daily_pnl'), JSON.stringify(limits));
  }
});

test('futures margin sizing limits total contracts and existing combined initial margin', () => {
  const proposal = candidate({
    owner: 'futures', assetClass: 'future', instrumentKey: 'CME:ES:202612', exposureKey: 'SP500',
    idempotencyKey: 'es:signal', multiplier: 50, initialMarginUsd: 1_000, maintenanceMarginUsd: 800,
  });
  const limited = evaluatePaperCandidate(proposal, portfolio({ accountEquity: 10_000 }), policy({ maxTradeRiskPct: 0.5, maxInitialMarginPct: 0.5 }));
  assert.equal(limited.status, 'blocked');
  assert.ok(limited.reasons.includes('initial_margin_exposure_limit'));
  const approved = evaluatePaperCandidate(proposal, portfolio({ accountEquity: 100_000 }), policy({ maxInitialMarginPct: 25 }));
  assert.equal(approved.status, 'paper-approved');
  assert.equal(approved.sizing.proposedInitialMarginUsd, 9_000);
  const combined = evaluatePaperCandidate(proposal, portfolio({ accountEquity: 100_000,
    openPositions: [{ status: 'open', assetClass: 'future', riskUsd: 20, notionalUsd: 20_000, marginRequirementUsd: 20_000 }],
  }), policy({ maxInitialMarginPct: 25 }));
  assert.equal(combined.status, 'blocked');
  assert.ok(combined.reasons.includes('initial_margin_exposure_limit'));
});

test('ledger reservation lock atomically enforces combined futures margin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-margin-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const limits = policy({ maxTradeRiskPct: 0.25, maxInitialMarginPct: 15 });
    const future = (symbol) => candidate({
      owner: 'futures', assetClass: 'future', instrumentKey: `CME:${symbol}`, exposureKey: symbol,
      idempotencyKey: `${symbol}:signal`, direction: 'long', bid: 10, ask: 10.01, entryPrice: 10.01,
      stopPrice: 9.91, targetPrice: 10.26, multiplier: 1, initialMarginUsd: 5, maintenanceMarginUsd: 4,
    });
    const first = future('A'), second = future('B');
    const strictPortfolio = portfolio({ accountEquity: 5_000 });
    const firstDecision = evaluatePaperCandidate(first, strictPortfolio, limits);
    const secondDecision = evaluatePaperCandidate(second, strictPortfolio, limits);
    assert.equal(firstDecision.status, 'paper-approved');
    assert.equal(secondDecision.status, 'paper-approved');
    const result = await Promise.all([
      reservePaperCandidate(first, firstDecision, { statePath, now, emergencyStop: false }),
      reservePaperCandidate(second, secondDecision, { statePath, now, emergencyStop: false }),
    ]);
    assert.deepEqual(result.map((row) => row.status).sort(), ['blocked', 'reserved']);
    assert.equal(result.find((row) => row.status === 'blocked').reason, 'initial_margin_exposure_limit_at_reservation');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared ledger reserves idempotently across concurrent calls and blocks duplicate exposure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate();
    const approved = evaluatePaperCandidate(proposal, portfolio(), policy());
    const results = await Promise.all([
      reservePaperCandidate(proposal, approved, { statePath, now, emergencyStop: false }),
      reservePaperCandidate(proposal, approved, { statePath, now, emergencyStop: false }),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), ['duplicate', 'reserved']);
    const secondSignal = candidate({ idempotencyKey: 'spy:other-signal' });
    const secondSignalDecision = evaluatePaperCandidate(secondSignal, portfolio(), policy());
    const duplicateExposure = await reservePaperCandidate(secondSignal, secondSignalDecision, { statePath, now, emergencyStop: false });
    assert.equal(duplicateExposure.status, 'exposure-conflict');
    assert.equal(duplicateExposure.reason, 'duplicate_open_exposure_at_reservation');
    const inverseWrapper = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'SPXU', exposureKey: 'SPY',
      idempotencyKey: 'spxu:inverse-signal', instrumentMetadata: { productType: 'inverse_etf', inverse: true } });
    const inverseDecision = evaluatePaperCandidate(inverseWrapper, portfolio(), policy());
    assert.equal(inverseDecision.status, 'paper-approved');
    const inverseReservation = await reservePaperCandidate(inverseWrapper, inverseDecision, { statePath, now, emergencyStop: false });
    assert.equal(inverseReservation.status, 'exposure-conflict');
    assert.equal(inverseReservation.reason, 'conflicting_open_exposure_at_reservation');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
    const optionStatePath = join(directory, 'option-ledger.json');
    const bearishOption = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'MSFT-PUT-DEBIT-SPREAD', exposureKey: 'MSFT',
      direction: 'long', underlyingDirection: 'short', idempotencyKey: 'spy:bearish-option' });
    const bearishDecision = evaluatePaperCandidate(bearishOption, portfolio(), policy());
    assert.equal(bearishDecision.status, 'paper-approved');
    const bearishReservation = await reservePaperCandidate(bearishOption, bearishDecision, { statePath: optionStatePath, now, emergencyStop: false });
    assert.equal(bearishReservation.status, 'reserved');
    const ledgerWithBearish = await readPaperRiskLedger({ statePath: optionStatePath });
    assert.equal(ledgerWithBearish.orders.at(-1).underlyingDirection, 'short');
    const stopped = await reservePaperCandidate(candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ' }), approved, { statePath, now, emergencyStop: true });
    assert.deepEqual(stopped, { status: 'blocked', reason: 'emergency_stop_active' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation fails closed when persisted active risk metadata becomes malformed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-corrupt-active-risk-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const existing = candidate();
    const existingDecision = evaluatePaperCandidate(existing, portfolio(), policy());
    const first = await reservePaperCandidate(existing, existingDecision, { statePath, now, emergencyStop: false });
    assert.equal(first.status, 'reserved');
    const next = candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:other-signal' });
    const nextDecision = evaluatePaperCandidate(next, portfolio(), policy());
    const ledger = await readPaperRiskLedger({ statePath });
    for (const [field, value] of [['riskUsd', null], ['riskUsd', true], ['notionalUsd', ''], ['notionalUsd', false]]) {
      const corrupted = structuredClone(ledger);
      corrupted.orders[0][field] = value;
      await writeFile(statePath, JSON.stringify(corrupted));
      const result = await reservePaperCandidate(next, nextDecision, { statePath, now, emergencyStop: false });
      assert.equal(result.status, 'blocked', `${field}=${String(value)}`);
      assert.equal(result.reason, 'active_order_risk_metadata_invalid_at_reservation');
      assert.equal(result.invalidActiveOrders, 1);
      assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('separate bot worker processes serialize shared-ledger reservations and prevent duplicate exposure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-cross-process-reservation-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const first = candidate({ idempotencyKey: 'spy:cross-process:first' });
    const second = candidate({ idempotencyKey: 'spy:cross-process:second' });
    const firstDecision = evaluatePaperCandidate(first, portfolio(), policy());
    const secondDecision = evaluatePaperCandidate(second, portfolio(), policy());
    assert.equal(firstDecision.status, 'paper-approved');
    assert.equal(secondDecision.status, 'paper-approved');
    const results = await Promise.all([
      reserveInChild({ candidate: first, decision: firstDecision, statePath, now }),
      reserveInChild({ candidate: second, decision: secondDecision, statePath, now }),
    ]);
    assert.deepEqual(results.map((row) => row.status).sort(), ['exposure-conflict', 'reserved']);
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);

    const duplicateStatePath = join(directory, 'duplicate-ledger.json');
    const repeated = candidate({ idempotencyKey: 'spy:cross-process:identical' });
    const repeatedDecision = evaluatePaperCandidate(repeated, portfolio(), policy());
    const duplicates = await Promise.all([
      reserveInChild({ candidate: repeated, decision: repeatedDecision, statePath: duplicateStatePath, now }),
      reserveInChild({ candidate: repeated, decision: repeatedDecision, statePath: duplicateStatePath, now }),
    ]);
    assert.deepEqual(duplicates.map((row) => row.status).sort(), ['duplicate', 'reserved']);
    assert.equal((await readPaperRiskLedger({ statePath: duplicateStatePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ledger persists effective wrapper notional and source classification for aggregate exposure checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-wrapper-risk-'));
  const statePath = join(directory, 'ledger.json');
  const proposal = candidate({ assetClass: 'etp', instrumentKey: 'WRAP3', exposureKey: 'SPY',
    idempotencyKey: 'wrap3:2026-09-29:long', exposureMultiplier: 2,
    instrumentMetadata: { productType: 'leveraged_etf', leverage: 2, inverse: false, classificationSourceUrl: 'https://issuer.example/wrap3' } });
  try {
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    const reservation = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.equal(reservation.status, 'reserved', JSON.stringify(reservation));
    const saved = (await readPaperRiskLedger({ statePath })).orders[0];
    assert.equal(saved.exposureMultiplier, 2);
    assert.equal(saved.notionalUsd, decision.sizing.proposedNotionalUsd);
    assert.equal(saved.instrumentMetadata.productType, 'leveraged_etf');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation rechecks canonical wrapper exposure against the persisted ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const qqq = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:paper' });
    const tqqq = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'TQQQ', exposureKey: 'TQQQ', idempotencyKey: 'tqqq:paper' });
    const qqqDecision = evaluatePaperCandidate(qqq, portfolio(), policy());
    const tqqqDecision = evaluatePaperCandidate(tqqq, portfolio(), policy());
    const tqqqOption = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'TQQQ261002C00050000+TQQQ261002C00055000',
      exposureKey: 'TQQQ', idempotencyKey: 'tqqq-option:paper' });
    const tqqqOptionDecision = evaluatePaperCandidate(tqqqOption, portfolio(), policy());
    const first = await reservePaperCandidate(qqq, qqqDecision, { statePath, now, emergencyStop: false });
    assert.equal(first.status, 'reserved');
    const second = await reservePaperCandidate(tqqq, tqqqDecision, { statePath, now, emergencyStop: false });
    assert.equal(second.status, 'exposure-conflict');
    const third = await reservePaperCandidate(tqqqOption, tqqqOptionDecision, { statePath, now, emergencyStop: false });
    assert.equal(third.status, 'exposure-conflict');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation shares Treasury ETF and Treasury futures exposure across bots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-rates-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const etf = candidate({ owner: 'etfs-etps', assetClass: 'etf', instrumentKey: 'IEF', exposureKey: 'IEF', idempotencyKey: 'ief:paper' });
    const future = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_ZNZ6', exposureKey: 'CUSTOM',
      future: { contractId: 'CME_ZNZ6', providerRawSymbol: 'ZNZ6' }, idempotencyKey: 'zn:paper', initialMarginUsd: 100, maintenanceMarginUsd: 90 });
    const etfDecision = evaluatePaperCandidate(etf, portfolio(), policy());
    const futureDecision = evaluatePaperCandidate(future, portfolio(), policy({ maxSpreadPct: 1 }));
    assert.equal(etfDecision.status, 'paper-approved');
    assert.equal(futureDecision.status, 'paper-approved');
    const first = await reservePaperCandidate(etf, etfDecision, { statePath, now, emergencyStop: false });
    assert.equal(first.status, 'reserved');
    const second = await reservePaperCandidate(future, futureDecision, { statePath, now, emergencyStop: false });
    assert.equal(second.status, 'exposure-conflict');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation persists broad commodity basket overlap and blocks mapped commodity futures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-commodity-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const basket = candidate({ owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'DJP', exposureKey: 'COMMODITY_BASKET', idempotencyKey: 'djp:paper' });
    const oilFuture = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_MCLZ6', exposureKey: 'OIL',
      future: { providerRawSymbol: 'MCLZ6' }, idempotencyKey: 'mcl:paper', initialMarginUsd: 100, maintenanceMarginUsd: 90 });
    const basketDecision = evaluatePaperCandidate(basket, portfolio(), policy());
    const oilDecision = evaluatePaperCandidate(oilFuture, portfolio(), policy({ maxSpreadPct: 1 }));
    assert.equal(basketDecision.status, 'paper-approved');
    assert.equal(oilDecision.status, 'paper-approved');
    const first = await reservePaperCandidate(basket, basketDecision, { statePath, now, emergencyStop: false });
    assert.equal(first.status, 'reserved');
    assert.ok(first.order.exposureKeys.includes('OIL'));
    assert.ok(first.order.exposureKeys.includes('CORN'));
    const second = await reservePaperCandidate(oilFuture, oilDecision, { statePath, now, emergencyStop: false });
    assert.equal(second.status, 'exposure-conflict');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent basket ETN and mapped commodity reservations admit only one position', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-concurrent-commodity-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const basket = candidate({ owner: 'etfs-etps', assetClass: 'etp', instrumentKey: 'DJP', exposureKey: 'COMMODITY_BASKET', idempotencyKey: 'djp:concurrent' });
    const cornFuture = candidate({ owner: 'futures', assetClass: 'future', instrumentKey: 'CME_MZCZ6', exposureKey: 'CORN',
      future: { providerRawSymbol: 'MZCZ6' }, idempotencyKey: 'mzc:concurrent', initialMarginUsd: 100, maintenanceMarginUsd: 90 });
    const basketDecision = evaluatePaperCandidate(basket, portfolio(), policy());
    const cornDecision = evaluatePaperCandidate(cornFuture, portfolio(), policy({ maxSpreadPct: 1 }));
    assert.equal(basketDecision.status, 'paper-approved');
    assert.equal(cornDecision.status, 'paper-approved');
    const results = await Promise.all([
      reservePaperCandidate(basket, basketDecision, { statePath, now, emergencyStop: false }),
      reservePaperCandidate(cornFuture, cornDecision, { statePath, now, emergencyStop: false }),
    ]);
    assert.deepEqual(results.map(({ status }) => status).sort(), ['exposure-conflict', 'reserved']);
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reservation lock rechecks aggregate risk across concurrent different instruments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const first = candidate({ idempotencyKey: 'spy:signal', instrumentKey: 'SPY', exposureKey: 'SPY' });
    const second = candidate({ idempotencyKey: 'qqq:signal', instrumentKey: 'QQQ', exposureKey: 'QQQ' });
    const strictPolicy = policy({ maxTotalOpenRiskPct: 0.3 });
    const firstDecision = evaluatePaperCandidate(first, portfolio(), strictPolicy);
    const secondDecision = evaluatePaperCandidate(second, portfolio(), strictPolicy);
    assert.equal(firstDecision.status, 'paper-approved');
    assert.equal(secondDecision.status, 'paper-approved');
    const results = await Promise.all([
      reservePaperCandidate(first, firstDecision, { statePath, now, emergencyStop: false }),
      reservePaperCandidate(second, secondDecision, { statePath, now, emergencyStop: false }),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), ['blocked', 'reserved']);
    assert.equal(results.find((x) => x.status === 'blocked').reason, 'combined_open_risk_limit_at_reservation');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared ledger blocks cross-bot reservations that use a different account-equity basis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-equity-basis-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const first = candidate({ idempotencyKey: 'spy:equity-basis', instrumentKey: 'SPY', exposureKey: 'SPY' });
    const second = candidate({ idempotencyKey: 'qqq:equity-basis', instrumentKey: 'QQQ', exposureKey: 'QQQ', owner: 'stocks', assetClass: 'stock', stockQuoteEvidence: stockQuoteEvidence('QQQ', { bid: 150, ask: 150.1, time: new Date(now - 5000).toISOString() }) });
    const firstDecision = evaluatePaperCandidate(first, portfolio(), policy());
    const secondDecision = evaluatePaperCandidate(second, portfolio({ accountEquity: 20_000 }), policy());
    assert.equal(firstDecision.status, 'paper-approved');
    assert.equal(secondDecision.status, 'paper-approved');
    const reserved = await reservePaperCandidate(first, firstDecision, { statePath, now, emergencyStop: false });
    assert.equal(reserved.status, 'reserved');
    assert.equal(reserved.order.accountEquityUsd, 10_000);
    assert.equal((await readPaperRiskLedger({ statePath })).accountEquityUsd, 10_000);
    const mismatch = await reservePaperCandidate(second, secondDecision, { statePath, now, emergencyStop: false });
    assert.equal(mismatch.status, 'blocked');
    assert.equal(mismatch.reason, 'shared_account_equity_mismatch');
    const cancelled = await transitionPaperOrder(reserved.order.orderId, 'cancelled', { statePath });
    assert.equal(cancelled.status, 'updated');
    assert.equal(cancelled.order.status, 'cancelled');
    const laterCandidate = candidate({ idempotencyKey: 'iwm:equity-basis-after-close', instrumentKey: 'IWM', exposureKey: 'IWM', owner: 'stocks', assetClass: 'stock', stockQuoteEvidence: stockQuoteEvidence('IWM', { bid: 150, ask: 150.1, time: new Date(now - 5000).toISOString() }) });
    const laterDecision = evaluatePaperCandidate(laterCandidate, portfolio({ accountEquity: 20_000 }), policy());
    const historicalMismatch = await reservePaperCandidate(laterCandidate, laterDecision, { statePath, now, emergencyStop: false });
    assert.equal(historicalMismatch.status, 'blocked', 'equity basis remains anchored after the first reservation closes');
    assert.equal(historicalMismatch.reason, 'shared_account_equity_mismatch');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paper orders fill only on a later executable quote, close on the target, and realize costs exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    const invalidManualFill = await transitionPaperOrder(reserved.order.orderId, 'filled', { statePath });
    assert.equal(invalidManualFill.status, 'invalid-transition');
    assert.equal((await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 150, ask: 150.1, time: proposal.quoteTime, quality: 'executable' }), { statePath, now, emergencyStop: false })).status, 'duplicate_or_out_of_order_quote');
    const filled = await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }), { statePath, now: now + 1_000, emergencyStop: false, maxSpreadPct: 0.2 });
    assert.equal(filled.status, 'filled');
    assert.equal(filled.order.markPrice, 150, 'the first mark uses the liquidatable bid');
    assert.equal(filled.order.maxAdverseExcursionUsd, 4.5, 'the entry spread is sampled adverse excursion');
    assert.equal(filled.order.unrealizedPnlUsd, -6.75, 'open P&L includes spread, fees and slippage reserve');
    const openSummary = summarizePaperLedger(await readPaperRiskLedger({ statePath }), { accountEquity: 10_000, sessionDate: '2026-09-29' });
    assert.equal(openSummary.filledOpenCount, 1);
    assert.equal(openSummary.activeReservationCount, 0);
    assert.ok(openSummary.unrealizedPnlUsd < 0);
    const closed = await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 151.2, ask: 151.21, time: new Date(now + 2_000).toISOString(), quality: 'executable' }), { statePath, now: now + 2_000, emergencyStop: false, maxSpreadPct: 0.2 });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.order.exitReason, 'target');
    assert.equal(closed.order.exitPrice, 151.1);
    assert.deepEqual(closed.order.exitQuote, { bid: 151.2, ask: 151.21,
      spreadPct: ((151.21 - 151.2) / ((151.21 + 151.2) / 2)) * 100 });
    assert.equal(closed.order.realizedPnlUsd, 42.75);
    assert.equal(closed.order.closedPortfolioRiskDateUtc, '2026-09-29');
    assert.equal(closed.order.positionQuoteSampleCount, 2, 'coverage includes fill and later exit quotes');
    assert.equal(closed.order.maxPositionQuoteGapMs, 1_000);
    assert.equal((await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 151.2, ask: 151.21, time: new Date(now + 3_000).toISOString(), quality: 'executable' }), { statePath, now: now + 3_000, emergencyStop: false })).status, 'terminal');
    const ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders[0].status, 'closed');
    assert.equal(ledger.events.filter((event) => event.type === 'closed').length, 1);
    const performance = summarizePaperLedger(ledger, { accountEquity: 10_000, sessionDate: '2026-09-29' });
    assert.equal(performance.closedCount, 1);
    assert.equal(performance.realizedPnlTodayUsd, 42.75);
    assert.equal(performance.averageWinUsd, 42.75);
    assert.equal(performance.excursionSampleCount, 1);
    assert.equal(performance.averageMaxFavorableExcursionUsd, 49.5);
    assert.equal(performance.averageMaxAdverseExcursionUsd, 4.5);
    assert.equal(performance.byBotAndStrategy['etfs-etps:test-orb'].averageMaxFavorableExcursionUsd, 49.5);
    assert.equal(performance.positionQuoteCoverageCount, 1);
    assert.equal(performance.averagePositionQuoteSamples, 2);
    assert.equal(performance.averageMaxPositionQuoteGapMs, 1_000);
    assert.equal(performance.byBotAndStrategy['etfs-etps:test-orb'].averageMaxPositionQuoteGapMs, 1_000);
    assert.equal(performance.openCount, 0);
    assert.equal(performance.exits.target, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('short paper fill marks the liquidatable ask and includes the spread in open risk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-short-mark-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ direction: 'short', idempotencyKey: 'spy:short:mark',
      entryPrice: 150, stopPrice: 150.5, targetPrice: 149 });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    const filled = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 1_000, emergencyStop: false, maxSpreadPct: 0.2 });
    assert.equal(filled.status, 'filled');
    assert.equal(filled.order.fillPrice, 150);
    assert.equal(filled.order.markPrice, 150.1);
    assert.ok(filled.order.maxAdverseExcursionUsd > 0);
    assert.ok(filled.order.unrealizedPnlUsd < -Number(filled.order.roundTripFeesPerUnit
      + filled.order.slippageReservePerUnit) * filled.order.units);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paper quote monitoring refuses to mutate an active order with corrupted execution fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-invalid-monitor-state-'));
  const statePath = join(directory, 'paper-ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    const filled = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 1_000, emergencyStop: false, maxSpreadPct: 0.2 });
    assert.equal(filled.status, 'filled');
    const ledger = await readPaperRiskLedger({ statePath });
    ledger.orders[0].fillPrice = null;
    await writeFile(statePath, JSON.stringify(ledger));

    const result = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 151.2, ask: 151.21, time: new Date(now + 2_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 2_000, emergencyStop: false, maxSpreadPct: 0.2 });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'active_order_execution_metadata_invalid');
    const unchanged = await readPaperRiskLedger({ statePath });
    assert.equal(unchanged.orders[0].status, 'filled');
    assert.equal(unchanged.orders[0].fillPrice, null);
    assert.equal(unchanged.events.filter((event) => event.type === 'closed').length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('option paper reservations preserve their two leg identifiers for independent mark monitoring', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-option-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY261002C00100000+SPY261002C00103000', exposureKey: 'SPY',
      idempotencyKey: 'SPY:option:test', entryPrice: 0.2, stopPrice: 0.1, targetPrice: 0.4, bid: 0.15, ask: 0.2, multiplier: 100, lotSize: 1,
      option: { strategy: 'bull-call-debit-vertical', expiry: '2026-10-02', assignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', reviewedThrough: '2026-10-02' }, longLeg: { symbol: 'SPY261002C00100000' }, shortLeg: { symbol: 'SPY261002C00103000' } } });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy({ maxSpreadPct: 50 }));
    assert.equal(decision.status, 'paper-approved', JSON.stringify(decision.reasons));
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.deepEqual(reserved.order.option, proposal.option);
    assert.equal(reserved.order.option.assignmentReview.reviewedThrough, '2026-10-02');
    assert.equal(reserved.order.instrumentKey, `${proposal.option.longLeg.symbol}+${proposal.option.shortLeg.symbol}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('zero-valued executable option vertical marks can close the paper position while other assets still require positive bids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-option-zero-mark-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY261002C00100000+SPY261002C00103000', exposureKey: 'SPY',
      idempotencyKey: 'SPY:option:zero-mark', entryPrice: 0.2, stopPrice: 0.1, targetPrice: 0.4, bid: 0.15, ask: 0.2, multiplier: 100, lotSize: 1,
      option: { strategy: 'bull-call-debit-vertical', expiry: '2026-10-02', longLeg: { symbol: 'SPY261002C00100000' }, shortLeg: { symbol: 'SPY261002C00103000' } } });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy({ maxSpreadPct: 50 }));
    assert.equal(decision.status, 'paper-approved', JSON.stringify(decision.reasons));
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    await seedLegacyFilledPosition(statePath, reserved.order.orderId, 0.2);
    const closed = await processPaperQuote(reserved.order.orderId,
      { bid: 0, ask: 0, time: new Date(now + 2_000).toISOString(), quality: 'executable' },
      { statePath, now: now + 2_000, emergencyStop: false });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.order.exitPrice, 0);
    assert.equal(closed.order.exitReason, 'stop');
    assert.deepEqual(closed.order.exitQuote, { bid: 0, ask: 0, spreadPct: 0 });
    assert.equal(closed.order.realizedPnlUsd, Number((-20.05 * closed.order.units).toFixed(2)));

    const stockProposal = candidate({ instrumentKey: 'ZEROBID', idempotencyKey: 'zero-bid-stock' });
    const stockDecision = evaluatePaperCandidate(stockProposal, portfolio(), policy());
    const stock = await reservePaperCandidate(stockProposal, stockDecision, { statePath, now, emergencyStop: false });
    const invalid = await processPaperQuote(stock.order.orderId,
      { bid: 0, ask: 0.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' },
      { statePath, now: now + 1_000, emergencyStop: false });
    assert.equal(invalid.status, 'blocked');
    assert.equal(invalid.reason, 'quote_not_current_and_executable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('option Greek journal ignores future provider timestamps and advances to a later valid snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-option-greeks-'));
  const statePath = join(dir, 'risk.json');
  try {
    const proposal = candidate({ owner: 'options', assetClass: 'option', instrumentKey: 'SPY261002C00100000+SPY261002C00103000',
      idempotencyKey: 'options:greeks-test', forceExitAt: new Date(now + 4 * 60 * 60_000).toISOString(), multiplier: 100 });
    const decision = evaluatePaperCandidate(proposal, portfolio({ accountEquity: 100_000 }), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    await seedLegacyFilledPosition(statePath, reserved.order.orderId, 150.1);
    const context = (asOf, delta, freshness = 'within_two_hours') => ({ asOf, freshness, net: { delta } });
    await processPaperQuote(reserved.order.orderId, { bid: 150.1, ask: 150.2, time: new Date(now + 2_000).toISOString(), quality: 'executable',
      optionGreekContext: context(new Date(now + 60_000).toISOString(), 0.9, 'future_or_invalid_timestamp') },
    { statePath, now: now + 2_000, emergencyStop: false });
    let ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders[0].latestOptionGreekContext, undefined);
    assert.equal(ledger.events.filter((event) => event.type === 'option_greeks_marked').length, 0);

    const asOf = new Date(now + 1_500).toISOString();
    await processPaperQuote(reserved.order.orderId, { bid: 150.2, ask: 150.3, time: new Date(now + 3_000).toISOString(), quality: 'executable',
      optionGreekContext: context(asOf, 0.35) }, { statePath, now: now + 3_000, emergencyStop: false });
    await processPaperQuote(reserved.order.orderId, { bid: 150.3, ask: 150.4, time: new Date(now + 4_000).toISOString(), quality: 'executable',
      optionGreekContext: context(null, null, 'timestamp_unavailable') }, { statePath, now: now + 4_000, emergencyStop: false });
    ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders[0].latestOptionGreekContext.asOf, asOf);
    assert.equal(ledger.orders[0].latestOptionGreekContext.net.delta, 0.35);
    assert.equal(ledger.events.filter((event) => event.type === 'option_greeks_marked').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop gaps realize at executable bid and emergency stop cancels an unfilled reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }), { statePath, now: now + 1_000, emergencyStop: false, maxSpreadPct: 0.2 });
    const stopped = await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 149, ask: 149.1, time: new Date(now + 2_000).toISOString(), quality: 'executable' }), { statePath, now: now + 2_000, emergencyStop: false, maxSpreadPct: 0.01 });
    assert.equal(stopped.order.exitReason, 'stop');
    assert.equal(stopped.order.exitPrice, 149);
    assert.equal(stopped.order.realizedPnlUsd, -51.75);
    assert.equal(stopped.order.maxAdverseExcursionUsd, 49.5);

    const another = candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:opening-range:2026-09-29:long' });
    const anotherDecision = evaluatePaperCandidate(another, portfolio(), policy());
    const pending = await reservePaperCandidate(another, anotherDecision, { statePath, now, emergencyStop: false });
    const killed = await processPaperQuote(pending.order.orderId, null, { statePath, now: now + 3_000, emergencyStop: true });
    assert.equal(killed.status, 'cancelled');
    assert.equal(killed.reason, 'emergency_stop_active');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reservation rechecks realized daily loss atomically after a concurrent prior loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const strictPolicy = policy({ maxDailyLossPct: 0.1 });
    const first = candidate();
    const firstDecision = evaluatePaperCandidate(first, portfolio(), strictPolicy);
    assert.equal(firstDecision.status, 'paper-approved');
    const reserved = await reservePaperCandidate(first, firstDecision, { statePath, now, emergencyStop: false });
    await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }), { statePath, now: now + 1_000, emergencyStop: false, maxSpreadPct: 0.2 });
    await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 149, ask: 149.1, time: new Date(now + 2_000).toISOString(), quality: 'executable' }), { statePath, now: now + 2_000, emergencyStop: false, maxSpreadPct: 0.2 });

    const second = candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:signal' });
    const stalePortfolioDecision = evaluatePaperCandidate(second, portfolio(), strictPolicy);
    assert.equal(stalePortfolioDecision.status, 'paper-approved');
    const rejected = await reservePaperCandidate(second, stalePortfolioDecision, { statePath, now: now + 3_000, emergencyStop: false });
    assert.equal(rejected.status, 'blocked');
    assert.equal(rejected.reason, 'daily_loss_limit_at_reservation');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared reservation applies realized loss across market-local midnight using UTC risk date', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-utc-risk-day-'));
  const statePath = join(directory, 'ledger.json');
  const riskNow = Date.parse('2026-09-30T01:00:00.000Z');
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'prior-ny-session-loss', idempotencyKey: 'prior-ny-session-loss', owner: 'stocks', assetClass: 'stock',
      instrumentKey: 'AAPL', exposureKey: 'AAPL', direction: 'long', status: 'closed',
      accountEquityUsd: 10_000, riskUsd: 25, notionalUsd: 1_000,
      closedAt: '2026-09-30T00:30:00.000Z', closedSessionDate: '2026-09-29', realizedPnlUsd: -20,
      grossPnlUsd: -20, feesUsd: 0, slippageUsd: 0,
    }] }));
    const summary = summarizePaperLedger(await readPaperRiskLedger({ statePath }), {
      accountEquity: 10_000, sessionDate: '2026-09-30', now: riskNow,
    });
    assert.equal(summary.realizedPnlTodayUsd, 0, 'the prior close belongs to the previous New York session date');
    assert.equal(summary.realizedPnlRiskDayUtcUsd, -20, 'the prior close belongs to the current common UTC risk day');

    const proposal = candidate({ sessionDate: '2026-09-30', quoteTime: new Date(riskNow - 1_000).toISOString(),
      forceExitAt: new Date(riskNow + 4 * 60 * 60_000).toISOString(), instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq-utc-risk-day' });
    const staleDecision = evaluatePaperCandidate(proposal, portfolio(), policy({ now: riskNow, maxDailyLossPct: 0.1 }));
    assert.equal(staleDecision.status, 'paper-approved', 'the caller may not yet have incorporated the account loss');
    const reservation = await reservePaperCandidate(proposal, staleDecision, { statePath, now: riskNow, emergencyStop: false });
    assert.equal(reservation.status, 'blocked');
    assert.equal(reservation.reason, 'daily_loss_limit_at_reservation');
    assert.equal(reservation.realizedPnlRiskDayUtcUsd, -20);
    assert.equal(reservation.riskDayUtc, '2026-09-30');
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared reservation fails closed when closed-trade P&L has no trustworthy UTC date', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-unknown-risk-day-'));
  const statePath = join(directory, 'ledger.json');
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'undated-closed-trade', idempotencyKey: 'undated-closed-trade', owner: 'stocks', assetClass: 'stock',
      instrumentKey: 'AAPL', direction: 'long', status: 'closed', realizedPnlUsd: -25,
    }] }));
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    const reservation = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.deepEqual(reservation, { status: 'blocked', reason: 'closed_trade_risk_day_unknown_at_reservation', unclassifiedClosedTrades: 1 });
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared reservation blocks same-risk-day closed trades with missing or malformed realized P&L', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-unknown-closed-pnl-'));
  const statePath = join(directory, 'ledger.json');
  try {
    for (const realizedPnlUsd of [null, true, '', 'NaN']) {
      await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
        orderId: 'closed-with-unknown-outcome', idempotencyKey: 'closed-with-unknown-outcome', owner: 'stocks', assetClass: 'stock',
        instrumentKey: 'AAPL', direction: 'long', status: 'closed', closedAt: new Date(now - 60_000).toISOString(), realizedPnlUsd,
      }] }));
      const proposal = candidate({ instrumentKey: 'MSFT', exposureKey: 'MSFT', idempotencyKey: `msft:${String(realizedPnlUsd)}` });
      const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
      assert.equal(decision.status, 'paper-approved');
      const result = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
      assert.deepEqual(result, { status: 'blocked', reason: 'closed_trade_realized_pnl_unknown_at_reservation', unclassifiedClosedTrades: 1 });
      assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
    }

    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'older-closed-unknown-outcome', idempotencyKey: 'older-closed-unknown-outcome', owner: 'stocks', assetClass: 'stock',
      instrumentKey: 'AAPL', direction: 'long', status: 'closed', closedAt: '2026-09-28T14:00:00.000Z', realizedPnlUsd: null,
    }] }));
    const historical = candidate({ instrumentKey: 'MSFT', exposureKey: 'MSFT', idempotencyKey: 'msft:historical-null' });
    const historicalDecision = evaluatePaperCandidate(historical, portfolio(), policy());
    const historicalResult = await reservePaperCandidate(historical, historicalDecision, { statePath, now, emergencyStop: false });
    assert.equal(historicalResult.status, 'reserved', 'a known prior UTC risk day cannot affect today\'s loss circuit');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation rejects same-UTC-day closes with net-only or contradictory modeled costs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-unreconciled-costs-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ instrumentKey: 'MSFT', exposureKey: 'MSFT', idempotencyKey: 'msft:cost-audit' });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    for (const defect of [{ feesUsd: null }, { realizedPnlUsd: -5 }]) {
      await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
        orderId: 'bad-costs', idempotencyKey: 'bad-costs', owner: 'stocks', status: 'closed',
        closedAt: new Date(now - 60_000).toISOString(), closedSessionDate: new Date(now).toISOString().slice(0, 10),
        realizedPnlUsd: -20, grossPnlUsd: -15, feesUsd: 3, slippageUsd: 2, ...defect,
      }] }));
      const result = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
      assert.deepEqual(result, { status: 'blocked', reason: 'closed_trade_cost_accounting_unavailable_at_reservation',
        unreconciledClosedTrades: 1 });
      assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reservation rechecks marked open losses atomically after approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-risk-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const strictPolicy = policy({ maxDailyLossPct: 0.1 });
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), strictPolicy);
    assert.equal(decision.status, 'paper-approved');
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'existing-open-position', idempotencyKey: 'existing-open-position', owner: 'stocks', assetClass: 'stock',
      instrumentKey: 'MSFT', exposureKey: 'MSFT', exposureKeys: ['MSFT'], direction: 'long', status: 'open',
      riskUsd: 20, notionalUsd: 100, marginRequirementUsd: 0, accountEquityUsd: 10_000, unrealizedPnlUsd: -10,
      markedAt: new Date(now - 1_000).toISOString(),
    }] }));

    const result = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'daily_loss_limit_at_reservation');
    assert.equal(result.unrealizedOpenPnlUsd, -10);
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('atomic reservation recheck blocks fresh open positions with missing or malformed unrealized P&L', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-null-open-pnl-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    for (const unrealizedPnlUsd of [null, true, false, '', 'NaN']) {
      await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
        orderId: 'existing-open-position', idempotencyKey: 'existing-open-position', owner: 'stocks', assetClass: 'stock',
        instrumentKey: 'MSFT', exposureKey: 'MSFT', exposureKeys: ['MSFT'], direction: 'long', status: 'open',
        riskUsd: 20, notionalUsd: 100, marginRequirementUsd: 0, accountEquityUsd: 10_000, unrealizedPnlUsd,
        markedAt: new Date(now - 1_000).toISOString(),
      }] }));
      const result = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
      assert.equal(result.status, 'blocked', String(unrealizedPnlUsd));
      assert.equal(result.reason, 'open_position_pnl_unavailable_at_reservation');
      assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('initial paper approval treats boolean and blank unrealized P&L as unavailable', () => {
  for (const unrealizedPnlUsd of [true, false, '', 'NaN']) {
    const position = { status: 'open', riskUsd: 20, notionalUsd: 100, markedAt: new Date(now - 1_000).toISOString(), unrealizedPnlUsd };
    const result = evaluatePaperCandidate(candidate(), portfolio({ openPositions: [position] }), policy());
    assert.equal(result.status, 'blocked', String(unrealizedPnlUsd));
    assert.ok(result.reasons.includes('open_position_pnl_unavailable'));
  }
});

test('reservation rejects an open position whose mark became stale after initial approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stale-mark-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate();
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'existing-stale-position', idempotencyKey: 'existing-stale-position', owner: 'stocks', assetClass: 'stock',
      instrumentKey: 'MSFT', exposureKey: 'MSFT', exposureKeys: ['MSFT'], direction: 'long', status: 'open',
      riskUsd: 20, notionalUsd: 100, marginRequirementUsd: 0, accountEquityUsd: 10_000,
      unrealizedPnlUsd: 0, markedAt: new Date(now - 5 * 60_000 - 1).toISOString(),
    }] }));

    const result = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'open_position_mark_stale_or_unavailable_at_reservation');
    assert.equal(result.openPositionMarks.staleCount, 1);
    assert.equal((await readPaperRiskLedger({ statePath })).orders.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unfilled primary-signal reservation expires at its entry deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-expiry-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ entryExpiresAt: new Date(now + 10_000).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    assert.equal(reserved.status, 'reserved');
    const expired = await processPaperQuote(reserved.order.orderId, null, { statePath, now: now + 10_000, emergencyStop: false });
    assert.equal(expired.status, 'cancelled');
    assert.equal(expired.reason, 'entry_window_expired');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed or post-exit entry deadlines fail closed during approval', () => {
  for (const entryExpiresAt of ['not-a-time', new Date(now + 5 * 60 * 60_000).toISOString()]) {
    const proposal = candidate({ entryExpiresAt });
    const result = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.includes('invalid_or_expired_entry_window'));
  }
});

test('reservation rechecks a valid entry deadline after prior approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-reserve-expiry-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const proposal = candidate({ entryExpiresAt: new Date(now + 10_000).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    assert.equal(decision.status, 'paper-approved');
    const result = await reservePaperCandidate(proposal, decision, { statePath, now: now + 10_000, emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'invalid_or_expired_entry_window');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restart recovery cancels expired reservations and preserves open positions for fresh-quote monitoring', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-restart-recovery-'));
  const statePath = join(directory, 'ledger.json');
  try {
    const expiredProposal = candidate({ instrumentKey: 'SPY', idempotencyKey: 'spy:expired-restart', entryExpiresAt: new Date(now + 10_000).toISOString() });
    const expiredDecision = evaluatePaperCandidate(expiredProposal, portfolio(), policy());
    const expiredReservation = await reservePaperCandidate(expiredProposal, expiredDecision, { statePath, now, emergencyStop: false });
    assert.equal(expiredReservation.status, 'reserved');

    const openProposal = candidate({ instrumentKey: 'QQQ', exposureKey: 'QQQ', idempotencyKey: 'qqq:open-restart', forceExitAt: new Date(now + 60 * 60_000).toISOString() });
    const openDecision = evaluatePaperCandidate(openProposal, portfolio(), policy());
    const openReservation = await reservePaperCandidate(openProposal, openDecision, { statePath, now, emergencyStop: false });
    assert.equal(openReservation.status, 'reserved');
    assert.equal((await processPaperQuote(openReservation.order.orderId,
      stockQuote('QQQ', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 1_000, emergencyStop: false })).status, 'filled');

    const persisted = await readPaperRiskLedger({ statePath });
    persisted.orders.push({ orderId: 'qqq-time-expired-pending', status: 'reserved',
      entryExpiresAt: new Date(now + 20_000).toISOString(), forceExitAt: new Date(now + 5_000).toISOString() });
    await writeFile(statePath, JSON.stringify(persisted));

    // A fresh process can reopen the same stable ledger path and reconcile it.
    const recovered = await recoverPaperOrders({ statePath, now: now + 10_000, emergencyStop: false });
    assert.equal(recovered.cancelledReservations, 2);
    assert.equal(recovered.awaitingFreshQuote, 1);
    assert.equal(recovered.activeOrders, 1);
    const ledger = await readPaperRiskLedger({ statePath });
    assert.equal(ledger.orders.find((order) => order.orderId === expiredReservation.order.orderId).cancelReason, 'entry_window_expired');
    assert.equal(ledger.orders.find((order) => order.orderId === 'qqq-time-expired-pending').cancelReason, 'time_exit_before_fill');
    assert.equal(ledger.orders.find((order) => order.orderId === openReservation.order.orderId).status, 'filled');
    assert.equal(ledger.orders.find((order) => order.orderId === openReservation.order.orderId).exitPrice, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unfilled reservation cannot fill after the strategy time-exit deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-time-exit-'));
  const statePath = join(dir, 'risk.json');
  try {
    const proposal = candidate({ forceExitAt: new Date(now + 5_000).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    const expired = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 5_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 5_000, emergencyStop: false });
    assert.equal(expired.status, 'cancelled');
    assert.equal(expired.reason, 'time_exit_before_fill');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scheduled exit waits for a post-deadline quote instead of backdating a delayed scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-delayed-time-exit-'));
  const statePath = join(dir, 'risk.json');
  try {
    const deadline = now + 5_000;
    const proposal = candidate({ forceExitAt: new Date(deadline).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    const fill = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 1_000, emergencyStop: false });
    assert.equal(fill.status, 'filled');

    const delayed = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150.2, ask: 150.3, time: new Date(now + 4_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 6_000, emergencyStop: false });
    assert.equal(delayed.status, 'open');
    assert.equal(delayed.order.closedAt, undefined);

    const postDeadline = await processPaperQuote(reserved.order.orderId,
      stockQuote('SPY', { bid: 150.4, ask: 150.5, time: new Date(now + 7_000).toISOString(), quality: 'executable' }),
      { statePath, now: now + 7_000, emergencyStop: false });
    assert.equal(postDeadline.status, 'closed');
    assert.equal(postDeadline.order.exitReason, 'time_exit');
    assert.ok(Date.parse(postDeadline.order.closedAt) >= deadline);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('closed paper P&L is assigned to the configured market-session timezone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-session-date-'));
  const statePath = join(dir, 'risk.json');
  try {
    const proposal = candidate({ sessionTimeZone: 'America/Chicago', forceExitAt: new Date(now + 24 * 60 * 60_000).toISOString() });
    const decision = evaluatePaperCandidate(proposal, portfolio(), policy());
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
    await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 150, ask: 150.1, time: new Date(now + 1_000).toISOString(), quality: 'executable' }), { statePath, now: now + 1_000, emergencyStop: false });
    const closeTime = Date.parse('2026-09-30T04:30:00.000Z');
    const closed = await processPaperQuote(reserved.order.orderId, stockQuote('SPY', { bid: 151.2, ask: 151.21, time: new Date(closeTime).toISOString(), quality: 'executable' }), { statePath, now: closeTime, emergencyStop: false });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.order.closedSessionDate, '2026-09-29');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
