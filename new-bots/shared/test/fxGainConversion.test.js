import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote } from '../paperRisk.js';
import { inspectClosedPaperAccounting } from '../postTradeReview.js';

const now = Date.parse('2026-10-02T14:00:00Z');
const policy = { now, emergencyStop: false, maxSpreadPct: 0.1, maxQuoteAgeMs: 120_000,
  maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 200, maxDailyLossPct: 1, minRewardRisk: 1.5 };
const candidate = (extra = {}) => ({
  mode: 'paper', owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_GBP', exposureKey: 'EUR_GBP',
  idempotencyKey: 'forex-conversion-test', strategyId: 'fixture', sessionDate: '2026-10-02',
  direction: 'long', bid: 100, ask: 100.01, entryPrice: 100.01, stopPrice: 99.01, targetPrice: 103.01,
  quoteTime: new Date(now - 1000).toISOString(), quoteQuality: 'executable', sessionOpen: true,
  forceExitAt: new Date(now + 3_600_000).toISOString(),
  multiplier: 1.26, gainMultiplier: 1.25, lotSize: 1, roundTripFeesPerUnit: 0.01, slippageReservePerUnit: 0.01,
  ...extra,
});

test('risk sizing uses loss conversion while reward-risk uses proceeds conversion; invalid gain factors block', () => {
  const result = evaluatePaperCandidate(candidate(), { accountEquity: 10_000 }, policy);
  assert.equal(result.status, 'paper-approved');
  assert.equal(result.sizing.units, Math.floor(25 / 1.28));
  assert.equal(result.sizing.estimatedNetRewardPerUnitUsd, 3.73);
  assert.equal(result.sizing.estimatedNetStopRiskPerUnitUsd, 1.28);
  for (const gainMultiplier of [0, -1, Infinity, '', 1.27]) {
    assert.ok(evaluatePaperCandidate(candidate({ gainMultiplier }), { accountEquity: 10_000 }, policy).reasons.includes('invalid_gain_multiplier'));
  }
});

for (const direction of ['long', 'short']) for (const outcome of ['target', 'stop']) {
  test('paper ' + direction + ' ' + outcome + ' uses the correct frozen FX side through reserve/fill/close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'omnimod-fx-gain-'));
    try {
      const statePath = join(directory, 'ledger.json');
      const proposal = candidate(direction === 'long' ? {} : { direction, entryPrice: 100, stopPrice: 101, targetPrice: 97 });
      const decision = evaluatePaperCandidate(proposal, { accountEquity: 10_000 }, policy);
      assert.equal(decision.status, 'paper-approved');
      const reserved = await reservePaperCandidate(proposal, decision, { statePath, now, emergencyStop: false });
      assert.equal(reserved.status, 'reserved');
      assert.equal(reserved.order.gainMultiplier, 1.25);
      const fill = await processPaperQuote(reserved.order.orderId,
        { bid: 100, ask: 100.01, time: new Date(now + 1000).toISOString(), quality: 'executable' },
        { ...policy, statePath, now: now + 1000, sessionOpen: true });
      assert.equal(fill.status, 'filled');
      const exit = outcome === 'target' ? proposal.targetPrice : proposal.stopPrice;
      const quote = direction === 'long' ? { bid: exit, ask: exit + 0.01 } : { bid: exit - 0.01, ask: exit };
      const closed = await processPaperQuote(reserved.order.orderId,
        { ...quote, time: new Date(now + 2000).toISOString(), quality: 'executable' },
        { ...policy, statePath, now: now + 2000, sessionOpen: true });
      assert.equal(closed.status, 'closed');
      const gross = (outcome === 'target' ? 3 * 1.25 : -1 * 1.26) * decision.sizing.units;
      assert.ok(Math.abs(closed.order.grossPnlUsd - gross) <= 0.011);
      assert.equal(inspectClosedPaperAccounting(closed.order).status, 'reconciled');
    } finally {
      const rel = relative(tmpdir(), directory);
      assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
