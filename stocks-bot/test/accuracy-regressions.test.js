import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBars, attachProviderConsensus, refreshAssetFreshness, analyzeMomentum, scoreAsset, attachMarketContext, summarizeSectorProxyCoverage, summarizeSecIndustryCoverage } from '../src/stocksData.js';
import { secIssuerIndustryMetadata } from '../src/eventIntelligence.js';
import { evaluatePrediction, buildPrediction, summarizePerformance } from '../src/predictionEngine.js';
import { marketSession, marketCloseTime, isUsEquityHoliday } from '../src/time.js';
import { trainingExamples, purgeOutcomeOverlap, modelHealth } from '../src/ensembleModel.js';
import { researchModelHealth } from '../src/researchModel.js';
import { labelCounterfactualSnapshot } from '../src/counterfactualLabels.js';

const start = Date.parse('2026-09-18T15:00:00Z');
function plan(overrides = {}) {
  return {
    id: 'test', status: 'tracking', entryPrice: 100, entryLow: 99.9, entryHigh: 100.15,
    stopPrice: 99, stopPct: 1, targetPrice: 102, exceedPrice: 104, slippageBps: 10,
    currentPrice: 100, maxPrice: 100, minPrice: 100, score: 80,
    createdAt: new Date(start).toISOString(), deadlineAt: new Date(start + 30 * 60_000).toISOString(),
    entryExpiresAt: new Date(start + 20 * 60_000).toISOString(), lastBarTimestamp: start / 1000 - 300,
    lastBarHigh: 100, lastBarLow: 100, ...overrides
  };
}
function asset(bar, extra = {}) {
  return { price: bar.close, recentBars: [bar], freshness: 'historical', ...extra };
}
function bar(minutes, overrides = {}) {
  return { timestamp: start / 1000 + minutes * 60, open: 100, high: 100.1, low: 99.9, close: 100, ...overrides };
}

test('null and inconsistent provider OHLC are discarded, never zero-priced candles', () => {
  const result = normalizeBars({ timestamp: [1, 2, 3], indicators: { quote: [{ open: [null, 100, 100], high: [101, 99, 101], low: [99, 99, 99], close: [100, 100, 100] }] } });
  assert.deepEqual(result.map((row) => row.timestamp), [3]);
});

test('stale and future provider quotes cannot supply an executable bid/ask or agreement', () => {
  const primary = { provider: 'Chart', price: 100, lastUpdated: new Date(start).toISOString() };
  const quotes = [{ provider: 'Old', price: 150, bid: 149, ask: 151, timestamp: new Date(start - 3600_000).toISOString() },
    { provider: 'Future', price: 110, bid: 109, ask: 111, timestamp: new Date(start + 3600_000).toISOString() }];
  const result = attachProviderConsensus(primary, { quotes }, start);
  assert.equal(result.livePrice, 100);
  assert.equal(result.liveProviderQuoteCount, 1);
  assert.equal(result.bidPrice, 0);
  assert.equal(result.microstructureProvider, '');
});

test('provider consensus retains the selected live price timestamp for premarket freshness checks', () => {
  const chartAt = new Date(start - 60_000).toISOString();
  const liveAt = new Date(start - 10_000).toISOString();
  const result = attachProviderConsensus({ provider: 'Yahoo Chart', price: 100, lastUpdated: chartAt }, {
    quotes: [{ provider: 'Alpaca IEX snapshot', price: 101, timestamp: liveAt, classification: 'intraday' }]
  }, start);
  assert.equal(result.livePrice, 101);
  assert.equal(result.livePriceProvider, 'Alpaca IEX snapshot');
  assert.equal(result.livePriceUpdatedAt, liveAt);
});

test('cached asset freshness expires and stale snapshots cannot qualify', () => {
  const row = { symbol: 'NVDA', price: 100, lastUpdated: new Date(start).toISOString(), freshness: 'live/delayed', averageDailyVolume: 1_000_000 };
  assert.equal(refreshAssetFreshness(row, start + 21 * 60_000).freshness, 'stale');
  const result = analyzeMomentum({ stale: true, assets: [row] }, { minScore: 0 });
  assert.equal(result.candidates.length, 0);
  assert.ok(result.rejections.NVDA.includes('stale data'));
  assert.equal(evaluatePrediction(plan(), { ...row, freshness: 'stale', price: 1 }, new Date(start + 3600_000)).events.length, 0);
});

test('missing earnings date is unknown rather than a nearby earnings penalty', () => {
  assert.equal(scoreAsset({ price: 100, daysToEarnings: null }).eventPenalty, 0);
});

test('missing stock sector stays unknown and scores sector context neutrally instead of copying SPY', () => {
  const rows = [
    { symbol: 'SPY', price: 101, changeDay: 1, change5d: 2, dailySma20: 100 },
    { symbol: 'QQQ', price: 101, changeDay: 1.5, change5d: 2.5, dailySma20: 100 },
    { symbol: 'IWM', price: 100, changeDay: 0.5, change5d: 1.5, dailySma20: 100 },
    { symbol: 'DIA', price: 101, changeDay: 0.8, change5d: 1.8, dailySma20: 100 },
    { symbol: 'XLK', price: 103, changeDay: 3, change5d: 4, dailySma20: 100 },
    { symbol: 'NVDA', sector: 'XLK', price: 105, changeDay: 5, change5d: 8, dailySma20: 100 },
    { symbol: 'NEWCO', sector: null, price: 106, changeDay: 6, change5d: 9, dailySma20: 100 },
  ];
  const context = attachMarketContext(rows);
  const known = context.find((row) => row.symbol === 'NVDA');
  const unknown = context.find((row) => row.symbol === 'NEWCO');
  assert.equal(known.sector, 'XLK');
  assert.equal(known.sectorChange, 3);
  assert.equal(known.sectorRelativeStrength, 2);
  assert.equal(unknown.sectorChange, null);
  assert.equal(unknown.sectorFiveDayChange, null);
  assert.equal(unknown.sectorRelativeStrength, null);
  assert.equal(scoreAsset(unknown).sector, 50, 'missing sector data uses the neutral factor score');
  assert.ok(unknown.relativeStrengthDay !== null, 'broad-market relative strength remains a separate measured feature');
  assert.deepEqual(summarizeSectorProxyCoverage(context), { candidates: 2, proxyAvailable: 1, proxyUnavailable: 1, coveragePct: 50 });
});

test('SEC SIC metadata is retained as industry evidence without manufacturing sector coverage', () => {
  assert.deepEqual(secIssuerIndustryMetadata({ sic: '3571', sicDescription: 'Electronic Computers' }), {
    secSic: '3571', secSicDescription: 'Electronic Computers'
  });
  assert.deepEqual(secIssuerIndustryMetadata({ sic: 'n/a', sicDescription: '' }), { secSic: '', secSicDescription: '' });
  assert.deepEqual(summarizeSecIndustryCoverage([
    { symbol: 'SPY', secSic: '9999', secSicDescription: 'ETF' },
    { symbol: 'AAPL', secSic: '3571', secSicDescription: 'Electronic Computers' },
    { symbol: 'NEWCO', secSic: '', secSicDescription: '' }
  ]), { candidates: 2, classified: 1, unavailable: 1, coveragePct: 50 });
});

test('stock sessions and trade deadlines honor early closes and Saturday New Year exception', () => {
  assert.equal(marketCloseTime(new Date('2026-11-27T16:00:00Z')).toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(marketSession(new Date('2026-12-24T18:00:00Z')).openForDiscovery, false);
  assert.equal(isUsEquityHoliday(new Date('2027-12-31T16:00:00Z')), false);
});

test('half exits at target one are included in weighted realized return', () => {
  const result = evaluatePrediction(plan(), asset(bar(5, { high: 105, low: 100, close: 104 })), new Date(start + 300_000)).prediction;
  assert.equal(result.status, 'exceeded');
  assert.equal(result.averageExitPrice, 103);
  assert.ok(Math.abs(result.netReturnPct - 2.8) < 1e-8);
});

test('breakeven stops and trailing stops fill adverse gaps at the open', () => {
  const breached = bar(5, { open: 95, high: 96, low: 94, close: 95 });
  const flat = evaluatePrediction(plan({ breakevenArmedAt: new Date(start).toISOString(), breakevenFloorPrice: 100.2 }), asset(breached), new Date(start + 300_000)).prediction;
  assert.equal(flat.exitPrice, 95);
  assert.equal(flat.status, 'loss');
  const trail = evaluatePrediction(plan({ status: 'target_tracking', targetReachedAt: new Date(start).toISOString(), trailingFloorPrice: 101, followThroughDeadlineAt: new Date(start + 900_000).toISOString() }), asset(breached), new Date(start + 300_000)).prediction;
  assert.equal(trail.exitPrice, 95);
  assert.ok(trail.netReturnPct < 0);
});

test('bar opening at the deadline cannot produce a target from later prices', () => {
  const result = evaluatePrediction(plan(), asset(bar(30, { high: 110, low: 100, close: 109 })), new Date(start + 35 * 60_000)).prediction;
  assert.equal(result.status, 'loss');
  assert.equal(result.exitPrice, 100);
  assert.equal(result.targetReachedAt, undefined);
});

test('pullback candle high preceding a limit fill cannot manufacture a target', () => {
  const result = evaluatePrediction(plan({ status: 'pending_entry', currentPrice: 105 }), asset(bar(5, { open: 105, high: 106, low: 99.95, close: 100 })), new Date(start + 300_000)).prediction;
  assert.equal(result.status, 'tracking');
  assert.equal(result.targetReachedAt, undefined);
});

test('snapshot quotes do not advance the OHLC cursor past delayed provider bars', () => {
  const existing = plan();
  const result = evaluatePrediction(existing, { price: 100.1, freshness: 'historical' }, new Date(start + 300_000)).prediction;
  assert.equal(result.lastBarTimestamp, existing.lastBarTimestamp);
});

test('calibration excludes results not yet completed at signal time', () => {
  const history = [{ score: 80, status: 'target_hit', completedAt: new Date(start + 1).toISOString() }];
  const prediction = buildPrediction({ symbol: 'X', price: 100, model: { score: 80 } }, {}, 'test', new Date(start), 'America/New_York', history);
  assert.equal(prediction.calibration.sampleSize, 0);
});

test('null outcome fields never become fabricated zero-return training samples', () => {
  assert.equal(trainingExamples([{ id: 'missing', accountingVersion: 2, status: 'loss', realizedR: null, netReturnPct: null, stopPct: 1 }]).length, 0);
  assert.equal(summarizePerformance([{ status: 'loss', realizedR: null }]).netR, -1);
});

test('counterfactual labels reject missing path coverage and crossed quotes', () => {
  const snapshot = { snapshotId: 's', symbol: 'X', recordedAt: new Date(start).toISOString(), price: 100, askPrice: 100, bidPrice: 101, spreadBps: 1, features: {} };
  const path = Array.from({ length: 30 }, (_, minute) => bar(minute));
  const labels = labelCounterfactualSnapshot(snapshot, path, { horizons: [30] });
  assert.equal(labels[0].executable, false);
  assert.equal(labelCounterfactualSnapshot(snapshot, path.filter((_, index) => index !== 5), { horizons: [30] }).length, 0);
  assert.equal(labelCounterfactualSnapshot(snapshot, path.slice(1), { horizons: [30] }).length, 0);
});

test('model split purges outcomes crossing the test boundary and embargo', () => {
  const boundary = '2026-09-18T15:00:00Z';
  const rows = [
    { id: 'safe', timestamp: '2026-09-18T10:00:00Z', completedAt: '2026-09-18T11:00:00Z' },
    { id: 'embargo', timestamp: '2026-09-18T13:00:00Z', completedAt: '2026-09-18T14:45:00Z' },
    { id: 'overlap', timestamp: '2026-09-18T14:00:00Z', completedAt: '2026-09-18T16:00:00Z' }
  ];
  assert.deepEqual(purgeOutcomeOverlap(rows, boundary, 30).map((row) => row.id), ['safe']);
});

test('ungraded open predictions cannot dilute research-model loss kill switch', () => {
  const model = { id: 'm', labelVersion: 2, trainedAt: new Date(start).toISOString() };
  const losses = Array.from({ length: 15 }, () => ({ researchModelId: 'm', status: 'loss', realizedR: -1 }));
  const open = Array.from({ length: 25 }, () => ({ researchModelId: 'm', status: 'tracking', realizedR: null }));
  assert.equal(researchModelHealth(model, [...losses, ...open], new Date(start)).healthy, false);
});

test('intraminute snapshots defer entry to a complete candle without horizon leakage', () => {
  const snapshot = { snapshotId: 's', symbol: 'X', recordedAt: new Date(start + 30_000).toISOString(), price: 100, askPrice: 100, bidPrice: 99.9, spreadBps: 10, features: {} };
  const path = Array.from({ length: 31 }, (_, minute) => bar(minute, { open: 101, high: 101.1, low: 100.9, close: 101 }));
  const [label] = labelCounterfactualSnapshot(snapshot, path, { horizons: [30] });
  assert.equal(label.deferredEntry, true);
  assert.equal(label.entryAt, new Date(start + 60_000).toISOString());
  assert.equal(label.effectiveHorizonSeconds, 29 * 60);
  assert.ok(label.entryPrice > 101);
  assert.ok(Date.parse(label.terminalAt) <= start + 30.5 * 60_000);
});

test('legacy artifacts and old accounting outcomes cannot be deployed or retrained as corrected data', () => {
  const legacy = { id: 'old', trainedAt: new Date(start).toISOString(), validation: { accepted: true } };
  assert.equal(modelHealth(legacy).healthy, false);
  assert.equal(researchModelHealth(legacy).healthy, false);
  assert.equal(trainingExamples([{ id: 'old', status: 'exceeded', realizedR: 2 }]).length, 0);
});
