import { stockQuoteEvidence } from '../fixtures/stockQuoteEvidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePaperCandidate, readPaperRiskLedger, reservePaperCandidate } from '../paperRisk.js';
import { inspectClosedPaperTrade } from '../postTradeReview.js';
import { paperApprovalEvidence } from '../paperApprovalEvidence.js';

const now = Date.parse('2026-09-29T15:00:00.000Z');

test('reservation retains bounded shared approval and raw model values for later review without signal metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-approval-evidence-'));
  const statePath = join(directory, 'paper.json');
  try {
    const candidate = {
      mode: 'paper', owner: 'stocks', assetClass: 'stock', instrumentKey: 'AAPL', exposureKey: 'AAPL',
      idempotencyKey: 'aapl:2026-09-29:approved', strategyId: 'intraday-test', sessionDate: '2026-09-29',
      stockQuoteEvidence: stockQuoteEvidence('AAPL', { bid: 100, ask: 100.05, time: new Date(now - 4000).toISOString() }),
      direction: 'long', bid: 100, ask: 100.05, entryPrice: 100.05, stopPrice: 99.5, targetPrice: 101.5,
      quoteTime: new Date(now - 4_000).toISOString(), quoteQuality: 'executable', sessionOpen: true,
      forceExitAt: new Date(now + 60 * 60_000).toISOString(), multiplier: 1, lotSize: 1,
      roundTripFeesPerUnit: 0.02, slippageReservePerUnit: 0.03,
      marketGateTrace: { source: 'market_candidate_emission', owner: 'stocks',
        strategyId: 'intraday-test', observedAt: new Date(now - 4_000).toISOString(),
        passedGates: ['confirmed_candidate', 'portfolio_selected'],
        guildId: 'trace-private-discord-id' },
      signal: { score: 72, confidence: '0.61', probability: Infinity,
        guildId: 'private-discord-id', accessToken: 'never-persist-this' },
    };
    const decision = evaluatePaperCandidate(candidate, { accountEquity: 10_000,
      realizedPnlToday: 0, openPositions: [] }, { now, maxQuoteAgeMs: 15_000, maxSpreadPct: 0.5,
      maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 150,
      maxDailyLossPct: 1, minRewardRisk: 1.25 });
    assert.equal(decision.status, 'paper-approved');
    const result = await reservePaperCandidate(candidate, decision, { statePath, now, emergencyStop: false });
    assert.equal(result.status, 'reserved');
    const order = (await readPaperRiskLedger({ statePath })).orders[0];
    assert.equal(order.approvalEvidence.scope, 'shared_paper_risk_gate_only');
    assert.equal(order.approvalEvidence.quoteAgeAtReservationMs, 4_000);
    assert.equal(order.approvalEvidence.netRewardRiskAfterCostReserve, decision.sizing.rewardRisk);
    assert.equal(order.approvalEvidence.riskBudgetUsd, decision.sizing.riskBudgetUsd);
    assert.deepEqual(order.approvalEvidence.sourceValues, { score: 72, confidence: 0.61, probability: null });
    assert.equal(order.approvalEvidence.marketStrategyGateRecordStatus, 'source_reported_partial');
    assert.deepEqual(order.approvalEvidence.marketGateTrace.passedGates,
      ['confirmed_candidate', 'portfolio_selected']);
    assert.equal(JSON.stringify(order).includes('private-discord-id'), false);
    assert.equal(JSON.stringify(order).includes('never-persist-this'), false);
    const reviewed = inspectClosedPaperTrade({ ...order, status: 'closed', closedAt: new Date(now + 5_000).toISOString(),
      filledAt: new Date(now + 1_000).toISOString(), realizedPnlUsd: -1 });
    assert.equal(reviewed.approvalGateRecordStatus, 'shared_paper_gate_only');
    assert.equal(reviewed.modelValuesStatus, 'raw_unverified_values');
    assert.deepEqual(reviewed.sourceModelValues, order.approvalEvidence.sourceValues);
    assert.equal(reviewed.marketGateTraceStatus, 'source_reported_partial');
    assert.deepEqual(reviewed.marketGateTrace.passedGates, ['confirmed_candidate', 'portfolio_selected']);
    assert.equal(inspectClosedPaperTrade({ ...order, status: 'closed', approvalEvidence: undefined }).approvalGateRecordStatus,
      'unavailable_in_shared_ledger');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid or stale source gate assertions are not promoted into a post-trade pass record', () => {
  const quoteTime = new Date(now - 4_000).toISOString();
  const candidate = { owner: 'forex', strategyId: 'range-v1', quoteTime };
  const decision = { status: 'paper-approved', sizing: { units: 1 } };
  const base = { source: 'market_candidate_emission', owner: 'forex', strategyId: 'range-v1',
    observedAt: quoteTime, passedGates: ['fresh_executable_quote'] };
  for (const invalid of [
    { owner: 'stocks' }, { strategyId: 'other-strategy' },
    { observedAt: new Date(now - 20_000).toISOString() },
    { observedAt: new Date(now + 10_000).toISOString() },
    { passedGates: ['fresh_executable_quote', 'fresh_executable_quote'] },
    { passedGates: ['<untrusted>'] },
  ]) {
    const evidence = paperApprovalEvidence({ ...candidate, marketGateTrace: { ...base, ...invalid } },
      decision, new Date(now).toISOString());
    assert.equal(evidence.marketStrategyGateRecordStatus, 'invalid_source_report');
    assert.deepEqual(evidence.marketGateTrace.passedGates, []);
  }
  assert.equal(paperApprovalEvidence(candidate, decision, new Date(now).toISOString())
    .marketStrategyGateRecordStatus, 'unavailable');
  assert.throws(() => paperApprovalEvidence(candidate, { status: 'blocked' }, new Date(now).toISOString()));
});
