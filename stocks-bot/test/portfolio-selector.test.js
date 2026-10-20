import test from 'node:test';
import assert from 'node:assert/strict';
import { returnCorrelation, selectPortfolioCandidates, executionEvidence, portfolioReadinessText } from '../src/portfolioSelector.js';

function candidate(symbol, sector = 'XLK', offset = 0, pattern = 'trend') {
  const recentBars = Array.from({ length: 40 }, (_, index) => ({
    timestamp: 1000 + index * 300,
    close: pattern === 'independent'
      ? 100 + Math.sin(index * 0.43) * 2 + Math.cos(index * 1.71) * 0.9
      : 100 + index * 0.2 + Math.sin(index) + offset
  }));
  return { symbol, sector, recentBars, price: 100, bidPrice: 99.975, askPrice: 100.025, quoteUpdatedAt: new Date().toISOString(), spreadBps: 5, dailyAtrPercent: 2, dataQuality: 85, model: { score: 82 }, ensemble: { active: true, decision: 'BUY', expectedR: 0.4, conservativeExpectedR: 0.35, probabilityLow: 60, probabilityHigh: 72 } };
}

test('portfolio selector removes highly correlated and sector-concentrated setups', () => {
  const first = candidate('AAPL'); const duplicate = candidate('MSFT', 'XLK', 20); const financial = candidate('JPM', 'XLF', 5, 'independent');
  assert.ok(returnCorrelation(first, duplicate) > 0.99);
  const result = selectPortfolioCandidates([first, duplicate, financial], [], { maxPairCorrelation: 0.85, maxSectorSignals: 2, minPortfolioExpectedR: 0.05, dailyLossLimitR: 3, consecutiveLossLimit: 3 }, '2026-07-21');
  assert.equal(result.selected.length, 2);
  assert.ok(result.rejected.some((row) => /correlation/.test(row.reason)));
});

test('daily and consecutive loss circuit breaker blocks new portfolio entries', () => {
  const predictions = [{ dateKey: '2026-07-21', status: 'loss', realizedR: -1, completedAt: '2026-07-21T15:00:00Z' }, { dateKey: '2026-07-21', status: 'loss', realizedR: -1, completedAt: '2026-07-21T15:10:00Z' }];
  const result = selectPortfolioCandidates([candidate('AAPL')], predictions, { dailyLossLimitR: 2, consecutiveLossLimit: 3 }, '2026-07-21');
  assert.equal(result.breaker.triggered, true);
  assert.equal(result.selected.length, 0);
});

test('consecutive-loss circuit carries across trading days while the daily loss total resets', () => {
  const predictions = [
    { dateKey: '2026-07-20', status: 'loss', realizedR: -1, completedAt: '2026-07-20T19:00:00Z' },
    { dateKey: '2026-07-21', status: 'loss', realizedR: -1, completedAt: '2026-07-21T15:00:00Z' }
  ];
  const result = selectPortfolioCandidates([candidate('AAPL')], predictions, {
    dailyLossLimitR: 3, consecutiveLossLimit: 2
  }, '2026-07-21');
  assert.equal(result.breaker.dailyR, -1);
  assert.equal(result.breaker.consecutiveLosses, 2);
  assert.equal(result.breaker.triggered, true);
});

test('portfolio selector checks new candidates against an already-active setup', () => {
  const activeAsset = candidate('AAPL');
  const active = {
    symbol: 'AAPL', sector: 'XLK', status: 'tracking',
    correlationSeries: [...returnSeries(activeAsset)]
  };
  const result = selectPortfolioCandidates([candidate('MSFT', 'XLY', 30)], [active], {
    maxPairCorrelation: 0.85, maxSectorSignals: 2, minPortfolioExpectedR: 0.05,
    dailyLossLimitR: 3, consecutiveLossLimit: 3
  }, '2026-07-21');
  assert.equal(result.selected.length, 0);
  assert.match(result.rejected[0].reason, /correlation with selected AAPL/);
});

function returnSeries(asset) {
  const bars = asset.recentBars;
  const rows = [];
  for (let index = 1; index < bars.length; index += 1) rows.push([
    bars[index].timestamp,
    Math.log(bars[index].close / bars[index - 1].close)
  ]);
  return rows;
}

test('missing or nonmatching return intervals are unknown, not diversification', () => {
  assert.equal(returnCorrelation({ recentBars: [] }, candidate('A')), null);
  const shorter = candidate('B'); shorter.recentBars = shorter.recentBars.map((b) => ({ ...b, timestamp: b.timestamp + 1 }));
  assert.equal(returnCorrelation(candidate('A'), shorter), null);
  const result = selectPortfolioCandidates([shorter], [{ ...candidate('A'), status: 'tracking' }], {}, '2026-07-21');
  assert.match(result.rejected[0].reason, /Unknown correlation/);
});

test('loss realized today counts even when the position was created yesterday', () => {
  const result = selectPortfolioCandidates([], [{ dateKey: '2026-07-20', status: 'loss', realizedR: -2, paperRiskMultiplier: 0.5, completedAt: '2026-07-21T15:00:00Z' }], { dailyLossLimitR: 1 }, '2026-07-21');
  assert.equal(result.breaker.dailyR, -1);
  assert.equal(result.breaker.triggered, true);
});

test('position and aggregate risk caps include pending entries', () => {
  const active = { ...candidate('A'), status: 'pending_entry', sector: 'XLV' };
  let result = selectPortfolioCandidates([candidate('B', 'XLF', 0, 'independent')], [active], { maxOpenPositions: 1 }, '2026-07-21');
  assert.match(result.rejected[0].reason, /Open-position limit/);
  result = selectPortfolioCandidates([candidate('B', 'XLF', 0, 'independent')], [active], { maxOpenRiskR: 1.5 }, '2026-07-21');
  assert.match(result.rejected[0].reason, /Aggregate planned risk/);
});

test('daily attempt limit and duplicate symbol prevent new exposure', () => {
  const prior = { ...candidate('A'), status: 'not_filled', dateKey: '2026-07-21' };
  assert.match(selectPortfolioCandidates([candidate('B')], [prior], { maxSignals: 1 }, '2026-07-21').rejected[0].reason, /Daily entry limit/);
  assert.match(selectPortfolioCandidates([candidate('A')], [{ ...prior, status: 'tracking' }], {}, '2026-07-21').rejected[0].reason, /already has an active/);
});

test('rule-only research retains unknown expectancy and needs explicit opt-in', () => {
  const row = { ...candidate('A'), ensemble: { active: false, decision: 'RULE_ONLY' } };
  assert.equal(selectPortfolioCandidates([row]).selected.length, 0);
  const result = selectPortfolioCandidates([row], [], { allowRuleOnlySignals: true });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].portfolioExpectedR, null);
  assert.equal(result.selected[0].portfolioUtilityR, null);
});

test('actual bid/ask overrides misleading stored spread and stale quotes abstain', () => {
  const row = { ...candidate('A'), bidPrice: 99, askPrice: 101, spreadBps: 1 };
  assert.match(executionEvidence(row).reason, /spread/);
  assert.match(executionEvidence({ ...candidate('A'), quoteUpdatedAt: '2000-01-01T00:00:00Z' }).reason, /60 seconds/);
});

test('model edge must survive explicit execution-cost stress', () => {
  const result = selectPortfolioCandidates([candidate('A')], [], { executionStressBps: 100 });
  assert.equal(result.selected.length, 0);
  assert.match(result.rejected[0].reason, /spread\/cost stress/);
  assert.match(portfolioReadinessText(result), /research collection continues/i);
});

test('missing completed accounting blocks additional risk rather than resetting the loss guard', () => {
  const result = selectPortfolioCandidates([candidate('A')], [{ accountingVersion: 2, status: 'loss', realizedR: null }]);
  assert.equal(result.breaker.triggered, true);
  assert.match(result.rejected[0].reason, /repair/);
});
