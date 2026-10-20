import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePremarketBreakoutWatches, buildPremarketBreakoutWatches, buildResearchWatches, newResearchWatchUpdates } from '../src/researchWatches.js';
import { buildAssetFromBars, analyzeMomentum } from '../src/stocksData.js';

const candidate = (overrides = {}) => ({
  symbol: 'ARM', price: 75.25, model: { score: 72 }, dataQuality: 63,
  ema9: 75, ema21: 74, change1h: 0.8, changeDay: 1.3, relativeVolume: 0.9,
  selectionTier: 'qualified', lastUpdated: '2026-09-21T13:30:00Z', ...overrides
});

test('quality-passing ticker is visible as an early upward watch without model approval', () => {
  const watches = buildResearchWatches({ candidates: [candidate()], watchCandidates: [] });
  assert.equal(watches[0].direction, 'UPWARD WATCH');
  assert.equal(watches[0].referenceEntry, 75.25);
  assert.ok(watches[0].referenceTarget1 > watches[0].referenceEntry);
  assert.ok(watches[0].referenceInvalidation < watches[0].referenceEntry);
  assert.match(watches[0].reasons[0], /confirming scan/);
  assert.equal(newResearchWatchUpdates(watches, null).length, 1);
  assert.equal(buildResearchWatches({ candidates: [candidate()] }, [{ symbol: 'ARM' }]).length, 0);
});

test('a watch posts once and again only if its quality screen improves', () => {
  const developing = buildResearchWatches({ watchCandidates: [candidate({ selectionTier: 'watch_only', rejectionReasons: ['relative volume'] })] });
  const prior = { watchOnly: developing, watchNoticeSymbols: ['ARM'] };
  assert.equal(newResearchWatchUpdates(developing, prior).length, 0);
  const improved = buildResearchWatches({ candidates: [candidate()] });
  assert.equal(newResearchWatchUpdates(improved, prior).length, 1);
  const neutral = buildResearchWatches({ candidates: [candidate({ change1h: -0.2 })] });
  assert.equal(newResearchWatchUpdates(neutral, prior).length, 0);
});

test('upward watches are not hidden by five neutral screen candidates', () => {
  const neutral = Array.from({ length: 5 }, (_, i) => candidate({ symbol: `N${i}`, change1h: -0.1, model: { score: 90 - i } }));
  const watches = buildResearchWatches({ candidates: neutral, watchCandidates: [candidate({ selectionTier: 'watch_only', rejectionReasons: ['relative volume'] })] });
  assert.equal(watches[0].symbol, 'ARM');
  assert.equal(watches.length, 5);
});

test('premarket breakout discovery finds fresh extended-hours breaks even when regular-session gates reject them', () => {
  const intraday = [];
  for (const date of ['2026-09-21', '2026-09-22', '2026-09-23']) {
    const start = Date.parse(`${date}T13:30:00Z`) / 1000;
    for (let index = 0; index < 78; index += 1) {
      const price = 100 + (date.endsWith('21') ? 0 : date.endsWith('22') ? 0.1 : 0.2) + index * 0.002;
      intraday.push({ timestamp: start + index * 300, open: price, high: price + 0.03, low: price - 0.03, close: price, volume: 10_000 });
    }
  }
  const premarketStart = Date.parse('2026-09-24T11:50:00Z') / 1000;
  for (let index = 0; index < 20; index += 1) {
    const price = 100.5 + index * 0.13;
    intraday.push({ timestamp: premarketStart + index * 300, open: price - 0.02, high: price + 0.05, low: price - 0.05, close: price, volume: 2_000 });
  }
  const daily = [];
  let date = new Date('2026-08-01T00:00:00Z'), index = 0;
  while (daily.length < 25) {
    if (![0, 6].includes(date.getUTCDay())) {
      const price = 95 + index * 0.1;
      daily.push({ timestamp: Date.parse(`${date.toISOString().slice(0, 10)}T20:00:00Z`) / 1000,
        open: price - 0.1, high: price + 0.2, low: price - 0.2, close: price, volume: 1_000_000 });
      index += 1;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  const now = new Date('2026-09-24T13:25:00Z');
  const asset = buildAssetFromBars('ARM', intraday, daily, { marketRegime: 'risk-on', relativeStrengthDay: 2, sectorChange: 1 });
  assert.equal(asset.marketMinute, 565);
  assert.ok(asset.price > asset.previous20High);
  assert.ok(asset.changeDay > 1);
  assert.equal(analyzeMomentum({ assets: [asset] }, { minPrice: 2, minAverageVolume: 500_000, minScore: 68 }).watchCandidates.length, 0);

  const watches = buildPremarketBreakoutWatches([{ ...asset, lastUpdated: now.toISOString(), freshness: 'live/delayed' }], now);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].premarketBreakout, true);
  assert.match(watches[0].screen, /20-session high/);
  assert.equal(newResearchWatchUpdates(watches, null).length, 1);
});

test('premarket breakout uses a newer fresh cross-provider trade when the chart bar is stale or lacks extended-hours bars', () => {
  const now = new Date('2026-09-24T13:25:00Z');
  const asset = {
    symbol: 'XYZ', price: 99.8, previousClose: 99.9, previous20High: 100,
    changeDay: -0.1, marketMinute: 960, premarketBarCount: 0, premarketRangeHigh: 0,
    lastUpdated: '2026-09-24T12:30:00Z', freshness: 'stale', provider: 'Yahoo Chart',
    livePrice: 101, livePriceProvider: 'Alpaca IEX snapshot', livePriceUpdatedAt: '2026-09-24T13:24:30Z',
    dataQuality: 45, averageDailyVolume: 1_000_000
  };
  const result = analyzePremarketBreakoutWatches([asset], now);
  const [watch] = result.watches;
  assert.equal(watch.price, 101);
  assert.ok(watch.changeDay > 1);
  assert.equal(watch.priceSource, 'Alpaca IEX snapshot');
  assert.equal(watch.observedAt, asset.livePriceUpdatedAt);
  assert.equal(result.diagnostics.freshCrossProviderPrices, 1);
});

test('fresh premarket trade cannot use a prior-session chart range or relative volume', () => {
  const now = new Date('2026-09-24T13:25:00Z');
  const staleChart = {
    symbol: 'XYZ', price: 99.8, previousClose: 100, previous20High: 105, changeDay: -0.2,
    marketMinute: 960, premarketBarCount: 12, premarketSessionDate: '2026-09-23',
    premarketRangeHigh: 100, premarketRelativeVolume: 2.5,
    lastUpdated: '2026-09-23T20:00:00Z', freshness: 'stale', provider: 'Alpaca IEX',
    livePrice: 101, livePriceProvider: 'Alpaca SIP', livePriceUpdatedAt: '2026-09-24T13:24:30Z',
    dataQuality: 70, averageDailyVolume: 1_000_000,
  };
  const result = analyzePremarketBreakoutWatches([staleChart], now);
  assert.equal(result.watches.length, 0, 'old session range must not create a fresh premarket setup');
  assert.equal(result.diagnostics.rejectionCounts.no_breakout_level_cleared, 1);
});

test('premarket detector does not trust a stale cross-provider price in place of the chart observation', () => {
  const now = new Date('2026-09-24T13:25:00Z');
  const asset = {
    symbol: 'XYZ', price: 99.8, previousClose: 99.9, previous20High: 100,
    changeDay: -0.1, marketMinute: 960, premarketBarCount: 0,
    lastUpdated: '2026-09-24T12:30:00Z', freshness: 'stale', provider: 'Yahoo Chart',
    livePrice: 101, livePriceProvider: 'Alpaca IEX snapshot', livePriceUpdatedAt: '2026-09-24T13:18:00Z',
    dataQuality: 70, averageDailyVolume: 1_000_000
  };
  assert.deepEqual(buildPremarketBreakoutWatches([asset], now), []);
});

test('premarket breakout discovery rejects stale, low-quality, illiquid, weak-move, and non-breakout observations', () => {
  const base = { symbol: 'ARM', price: 101, previous20High: 100, changeDay: 2, marketMinute: 500,
    lastUpdated: '2026-09-24T13:20:00Z', freshness: 'live/delayed', dataQuality: 70, averageDailyVolume: 1_000_000 };
  const now = new Date('2026-09-24T13:25:00Z');
  const invalid = [
    { freshness: 'stale' }, { dataQuality: 59 }, { averageDailyVolume: 499_999 }, { changeDay: 0.99 },
    { price: 100 }, { marketMinute: 570 }, { lastUpdated: '2026-09-24T12:00:00Z' }, { symbol: 'SPY' }
  ];
  for (const override of invalid) assert.deepEqual(buildPremarketBreakoutWatches([{ ...base, ...override }], now), []);
});

test('premarket discovery diagnostics identify the first failing gate and retain breakout cap counts', () => {
  const now = new Date('2026-09-24T13:25:00Z');
  const base = { price: 101, previous20High: 100, changeDay: 2, marketMinute: 500,
    lastUpdated: '2026-09-24T13:20:00Z', freshness: 'live/delayed', dataQuality: 70,
    averageDailyVolume: 1_000_000, premarketBarCount: 6 };
  const assets = [
    { ...base, symbol: 'NOBAR', premarketBarCount: 0 },
    { ...base, symbol: 'STALE', freshness: 'stale' },
    { ...base, symbol: 'LOWQ', dataQuality: 59 },
    { ...base, symbol: 'ILLQ', averageDailyVolume: 499_999 },
    { ...base, symbol: 'NOBREAK', price: 99, previous20High: 100, changeDay: 0.1 },
    { ...base, symbol: 'LOWRV', price: 99, previous20High: 100, changeDay: 0.7,
      premarketRangeHigh: 98.5, premarketRelativeVolume: 1.49 },
    ...Array.from({ length: 7 }, (_, index) => ({ ...base, symbol: `BRK${index}` }))
  ];
  const result = analyzePremarketBreakoutWatches(assets, now);
  assert.equal(result.diagnostics.considered, 13);
  assert.equal(result.diagnostics.stages.breakout, 7);
  assert.equal(result.diagnostics.breakoutCandidates, 7);
  assert.equal(result.diagnostics.watchCapOmissions, 2);
  assert.deepEqual(result.watches.map((row) => row.symbol), ['BRK0', 'BRK1', 'BRK2', 'BRK3', 'BRK4']);
  const reasons = Object.fromEntries(result.diagnostics.rejections.map((row) => [row.symbol, row.reasonCode]));
  assert.equal(reasons.NOBAR, 'no_current_premarket_observation');
  assert.equal(reasons.STALE, 'stale_or_old_observation');
  assert.equal(reasons.LOWQ, 'data_quality_below_floor');
  assert.equal(reasons.ILLQ, 'price_or_average_volume_below_floor');
  assert.equal(reasons.NOBREAK, 'no_breakout_level_cleared');
  assert.equal(reasons.LOWRV, 'premarket_relative_volume_unconfirmed');
  assert.deepEqual(buildPremarketBreakoutWatches(assets, now), result.watches);
});

test('premarket range breakouts are watched below the prior 20-session high only with volume confirmation', () => {
  const now = new Date('2026-09-24T13:25:00Z');
  const base = { symbol: 'XYZ', price: 20.25, previous20High: 20.5, changeDay: 0.7, marketMinute: 565,
    lastUpdated: '2026-09-24T13:20:00Z', freshness: 'live/delayed', dataQuality: 72, averageDailyVolume: 1_000_000,
    premarketRangeHigh: 20.2, premarketRelativeVolume: 1.8, premarketBarCount: 12 };
  const [watch] = buildPremarketBreakoutWatches([base], now);
  assert.equal(watch.screen, 'premarket range high cleared with volume confirmation');
  assert.deepEqual(watch.breakoutTypes, ['premarket_range_high']);
  assert.equal(newResearchWatchUpdates([watch], { premarketWatchNoticeKeys: ['XYZ:premarket_range_high'] }).length, 0);
  assert.equal(newResearchWatchUpdates([watch], { watchNoticeSymbols: ['XYZ'] }).length, 1);
  assert.deepEqual(buildPremarketBreakoutWatches([{ ...base, premarketRelativeVolume: 1.49 }], now), []);
});

test('Yahoo extended-hours bars derive same-time premarket relative volume and prior range high', () => {
  const intraday = [];
  for (const [date, volume, base] of [['2026-09-21', 100, 99.9], ['2026-09-22', 100, 99.95], ['2026-09-23', 100, 100], ['2026-09-24', 200, 100.1]]) {
    const start = Date.parse(`${date}T12:50:00Z`) / 1000;
    for (let index = 0; index < 7; index += 1) {
      const price = date === '2026-09-24' && index === 6 ? 100.5 : base + index * 0.04;
      intraday.push({ timestamp: start + index * 300, open: price - 0.01, high: price + 0.02,
        low: price - 0.02, close: price, volume });
    }
  }
  const daily = Array.from({ length: 25 }, (_, index) => ({ timestamp: Date.parse(`2026-08-${String(index + 1).padStart(2, '0')}T20:00:00Z`) / 1000,
    open: 99.8, high: 100.6, low: 99.6, close: 100, volume: 1_000_000 }));
  const asset = buildAssetFromBars('XYZ', intraday, daily);
  assert.ok(asset.price < asset.previous20High);
  assert.equal(asset.premarketBarCount, 7);
  assert.equal(asset.premarketSessionDate, '2026-09-24');
  assert.equal(asset.premarketRelativeVolume, 2);
  assert.ok(asset.price > asset.premarketRangeHigh);
});
