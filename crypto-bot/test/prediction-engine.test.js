import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrediction, deliverPredictionsSafely, evaluatePrediction, mergeNewPredictions, mergePendingOutcomeDeliveries, removeDeliveredOutcomeDeliveries, selectTradeHorizon, summarizePerformance } from '../src/predictionEngine.js';
import { scoreAsset } from '../src/cryptoData.js';

function asset(overrides = {}) {
  const row = {
    id: 'example', symbol: 'EX', name: 'Example', rank: 30, price: 100,
    marketCap: 1_000_000_000, volume24h: 120_000_000, high24h: 102, low24h: 94,
    athChangePercent: -25, change1h: 1.5, change24h: 7, change7d: 14,
    volumeToMarketCap: 0.12, ...overrides
  };
  return { ...row, model: scoreAsset(row) };
}

test('momentum model rewards confirmed liquid momentum', () => {
  const strong = scoreAsset(asset());
  const weak = scoreAsset(asset({ change1h: -2, change24h: -8, change7d: -15, volume24h: 1_000_000, volumeToMarketCap: 0.001 }));
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score >= 60);
});

test('prediction creates bounded target, stop, and risk-reward', () => {
  const prediction = buildPrediction(asset(), { maxSignals: 5 }, 'guild', new Date('2026-07-14T15:00:00Z'));
  assert.ok(prediction.targetPrice > prediction.entryPrice);
  assert.ok(prediction.stopPrice < prediction.entryPrice);
  assert.ok(prediction.riskReward >= 1.35);
  assert.ok([45, 120, 240, 360].includes(prediction.horizonMinutes));
  assert.equal(new Date(prediction.deadlineAt).getTime() - new Date(prediction.createdAt).getTime(), prediction.horizonMinutes * 60_000);
});

test('optional crypto news is displayed after scoring and leaves the model decision unchanged', () => {
  const input = asset();
  const now = new Date('2026-07-14T15:00:00Z');
  const baseline = buildPrediction(input, { maxSignals: 5 }, 'guild', now);
  const withNews = buildPrediction(input, { maxSignals: 5 }, 'guild', now, 'America/Chicago', [], {
    recentMarketNews: [{ id: 'n1', headline: 'Market-wide headline', source: 'Wire', publishedAt: '2026-07-14T14:59:00.000Z', url: 'https://example.org/news' }]
  });
  assert.deepEqual(withNews.modelFeatures, baseline.modelFeatures);
  assert.equal(withNews.score, baseline.score);
  assert.equal(withNews.expectedProfitable, baseline.expectedProfitable);
  assert.equal(withNews.recentMarketNews[0].headline, 'Market-wide headline');
});

test('saved prediction features retain derivatives ratio availability', () => {
  const row = asset({ marketData: { derivatives: {
    available: true, score: 55, longShortRatio: 0, longShortRatioAvailable: false,
    takerBuySellRatio: 1.15, takerBuySellRatioAvailable: true
  } } });
  const prediction = buildPrediction(row, {}, 'guild', new Date('2026-07-14T15:00:00Z'));
  assert.equal(prediction.modelFeatures.longShortRatioAvailable, 0);
  assert.equal(prediction.modelFeatures.takerBuySellRatioAvailable, 1);
  assert.equal(prediction.factors.longShortRatioAvailable, false);
  assert.equal(prediction.factors.takerBuySellRatioAvailable, true);
});

test('fast liquid momentum receives a scalp horizon instead of an all-day deadline', () => {
  const fast = asset({ change1h: 4.2, change24h: 10, change7d: 16, volumeToMarketCap: 0.3, volume24h: 500_000_000 });
  const horizon = selectTradeHorizon(fast);
  assert.equal(horizon.key, 'scalp');
  assert.equal(horizon.minutes, 45);
});

test('final target closes the position and cannot gain extra hindsight profit', () => {
  const prediction = buildPrediction(asset(), {}, 'guild', new Date('2026-07-14T15:00:00Z'));
  const result = evaluatePrediction(prediction, asset({ price: prediction.targetPrice }), new Date('2026-07-14T15:10:00Z'));
  assert.equal(result.prediction.status, 'target_hit');
  assert.equal(result.events[0].color, 'green');
  const later = evaluatePrediction(result.prediction, asset({ price: prediction.exceedPrice * 2 }), new Date('2026-07-14T15:20:00Z'));
  assert.equal(later.prediction.realizedR, result.prediction.realizedR);
  assert.equal(later.events.length, 0);
});

test('a single price jump beyond the exceed threshold emits only the blue result', () => {
  const prediction = buildPrediction(asset(), {}, 'guild', new Date('2026-07-14T15:00:00Z'));
  const result = evaluatePrediction(
    prediction,
    asset({ price: prediction.exceedPrice * 1.01 }),
    new Date('2026-07-14T16:00:00Z')
  );
  assert.equal(result.prediction.status, 'exceeded');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].color, 'blue');
});

test('a reversal after the final target does not reopen the closed paper position', () => {
  const start = new Date('2026-07-14T15:00:00Z');
  const prediction = buildPrediction(asset(), {}, 'guild', start);
  const result = evaluatePrediction(prediction, asset({ price: prediction.targetPrice }), new Date(start.getTime() + 10 * 60_000));
  const later = evaluatePrediction(result.prediction, asset({ price: prediction.stopPrice }), new Date(start.getTime() + 15 * 60_000));
  assert.equal(later.prediction.status, 'target_hit');
  assert.equal(later.prediction.realizedR, result.prediction.realizedR);
  assert.equal(later.events.length, 0);
});

test('legacy open signals are migrated away from an all-day deadline on their next observation', () => {
  const start = new Date('2026-07-14T15:00:00Z');
  const prediction = buildPrediction(asset(), {}, 'guild', start);
  const legacy = { ...prediction, horizonKey: undefined, horizonLabel: undefined, horizonMinutes: undefined, deadlineAt: '2026-07-15T05:55:00.000Z' };
  const result = evaluatePrediction(legacy, asset({ price: prediction.entryPrice * 1.001 }), new Date(start.getTime() + 10 * 60_000));
  assert.ok([45, 120, 240, 360].includes(result.prediction.horizonMinutes));
  assert.equal(new Date(result.prediction.deadlineAt).getTime() - start.getTime(), result.prediction.horizonMinutes * 60_000);
});

test('stop is red and profitable shortfall is yellow at deadline', () => {
  const start = new Date('2026-07-14T15:00:00Z');
  const prediction = buildPrediction(asset(), {}, 'guild', start);
  let result = evaluatePrediction(prediction, asset({ price: prediction.stopPrice * 0.99 }), new Date('2026-07-14T16:00:00Z'));
  assert.equal(result.prediction.status, 'loss');
  assert.equal(result.events[0].color, 'red');

  const short = { ...prediction, deadlineAt: new Date(start.getTime() + 60_000).toISOString() };
  result = evaluatePrediction(short, asset({ price: prediction.entryPrice * 1.005 }), new Date(start.getTime() + 120_000));
  assert.equal(result.prediction.status, 'fell_short');
  assert.equal(result.events.at(-1).color, 'yellow');
});

test('prediction freezes global context without changing approval or modeled score', () => {
  const now = new Date('2026-07-14T15:00:00Z');
  const context = { source: 'CoinGecko public /global', status: 'fresh', available: true,
    totalMarketCapUsd: 2_500_000_000_000, btcDominancePct: 58.5, providerUpdatedAt: '2026-07-14T14:55:00.000Z' };
  const regime = { key: 'risk_on', label: 'Risk-on', score: 70, allowNewLongs: true };
  const withContext = buildPrediction(asset({ marketData: { regime: { ...regime, globalMarketContext: context } } }), {}, 'guild', now);
  const withoutContext = buildPrediction(asset({ marketData: { regime } }), {}, 'guild', now);
  assert.deepEqual(withContext.globalMarketContext, context);
  assert.equal(withContext.score, withoutContext.score);
  assert.equal(withContext.expectedProfitable, withoutContext.expectedProfitable);
  assert.deepEqual(withContext.approvalRejections, withoutContext.approvalRejections);
});

test('prediction reports the exact final approval gates that failed', () => {
  const prediction = buildPrediction(asset(), { maxSignals: 5 }, 'guild', new Date('2026-07-14T15:00:00Z'));
  assert.equal(prediction.expectedProfitable, false);
  assert.ok(prediction.approvalRejections.includes('provider_confirmation'));
  assert.ok(prediction.approvalRejections.includes('strategy_validation'));
  assert.equal(prediction.approvalRejections.includes('provider_conflict'), false);
});

test('prediction merge classifies duplicate ids and daily symbols, including duplicates in one batch', () => {
  const existing = { id: 'old-id', guildId: 'g', dateKey: '2026-07-14', symbol: 'OLD' };
  const rows = [
    { ...existing },
    { id: 'new-id', guildId: 'g', dateKey: '2026-07-14', symbol: 'OLD' },
    { id: 'same-id', guildId: 'g', dateKey: '2026-07-14', symbol: 'NEW' },
    { id: 'same-id', guildId: 'g', dateKey: '2026-07-14', symbol: 'NEW' }
  ];
  const result = mergeNewPredictions({ guildId: 'g', predictions: [existing] }, rows.slice(1));
  assert.equal(result.added.length, 1);
  assert.deepEqual(result.rejected.map((row) => row.reason), ['daily_symbol_already_tracked', 'duplicate_signal_id']);
  assert.equal(result.predictions.length, 2);
});

test('failed Discord signal delivery does not abort other posts or get tracked as a delivered setup', async () => {
  const rows = [
    { id: 'ok', guildId: 'g', dateKey: '2026-07-14', symbol: 'OK' },
    { id: 'failed', guildId: 'g', dateKey: '2026-07-14', symbol: 'FAIL' }
  ];
  const delivery = await deliverPredictionsSafely(rows, async (row) => {
    if (row.symbol === 'FAIL') throw new Error('simulated Discord send failure');
    return { ...row, messageId: 'discord-message' };
  });
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.failures.length, 1);
  assert.equal(delivery.failures[0].reason, 'discord_send_failed');
  const tracker = mergeNewPredictions({ guildId: 'g', predictions: [] }, delivery.delivered);
  assert.deepEqual(tracker.predictions.map((row) => row.symbol), ['OK']);
});

test('outcome delivery outbox deduplicates retries and clears only confirmed deliveries', () => {
  const first = { prediction: { id: 'p1', lastEventAt: '2026-07-14T12:00:00Z' }, type: 'target_hit', occurredAt: '2026-07-14T12:00:00Z' };
  const later = { prediction: { id: 'p2' }, type: 'loss', occurredAt: '2026-07-14T12:05:00Z' };
  const queue = mergePendingOutcomeDeliveries([first], [first, later]);
  assert.equal(queue.length, 2);
  assert.deepEqual(removeDeliveredOutcomeDeliveries(queue, [first]), [later]);
});

test('a large first observation after the deadline is unverified, not a shortfall or a paper win', () => {
  const start = new Date('2026-07-14T15:00:00Z');
  const prediction = buildPrediction(asset(), {}, 'guild', start);
  const late = evaluatePrediction(prediction, asset({ price: prediction.entryPrice * 1.12 }),
    new Date(new Date(prediction.deadlineAt).getTime() + 60_000));
  assert.equal(late.prediction.status, 'unverified');
  assert.equal(late.prediction.realizedR, null);
  assert.match(late.events[0].description, /time of the move is unknown/);
  const summary = summarizePerformance([late.prediction]);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.closed, 0);
  assert.equal(summary.open, 0);
});

test('performance summary separates target, exceeded, shortfall, and loss', () => {
  const summary = summarizePerformance([
    { status: 'target_hit' }, { status: 'exceeded' }, { status: 'fell_short' }, { status: 'loss' }, { status: 'tracking' }
  ]);
  assert.deepEqual({ total: summary.total, open: summary.open, closed: summary.closed, wins: summary.wins }, { total: 5, open: 1, closed: 4, wins: 2 });
});
