import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAsset, normalizeGlobalMarketContext, scoreAsset } from '../src/cryptoData.js';
import { analyzeInvestment, classifyBenchmarkRegime } from '../src/investmentResearch.js';

test('CoinGecko market normalization preserves nullable supply facts without turning missing data into zero', () => {
  const asset = normalizeAsset({ id: 'fixture-token', symbol: 'FIX', name: 'Fixture', current_price: 2,
    market_cap: 200, total_volume: 20, circulating_supply: 50, total_supply: 80, max_supply: null,
    fully_diluted_valuation: null });
  assert.equal(asset.circulatingSupply, 50);
  assert.equal(asset.totalSupply, 80);
  assert.equal(asset.maxSupply, null);
  assert.equal(asset.fullyDilutedValuation, null);
});

test('CoinGecko sparkline normalization preserves invalid sample slots for correlation diagnostics', () => {
  const asset = normalizeAsset({ id: 'fixture-token', symbol: 'FIX', name: 'Fixture', current_price: 2,
    sparkline_in_7d: { price: [2, null, 2.1, 0, 'bad', 2.2] } });
  assert.deepEqual(asset.sparkline, [2, null, 2.1, null, null, 2.2]);
});

test('global crypto context preserves BTC dominance, validates provider time, and labels stale data', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const payload = { data: { updated_at: now.getTime() / 1000, total_market_cap: { usd: 2_500_000_000_000 },
    total_volume: { usd: 85_000_000_000 }, market_cap_percentage: { btc: 58.5, eth: 12.2 },
    market_cap_change_percentage_24h_usd: -1.7, volume_change_percentage_24h_usd: 8.2, active_cryptocurrencies: 12_345 } };
  const context = normalizeGlobalMarketContext(payload, { now, fetchedAt: now });
  assert.equal(context.status, 'fresh');
  assert.equal(context.totalMarketCapUsd, 2_500_000_000_000);
  assert.equal(context.btcDominancePct, 58.5);
  assert.equal(context.ethDominancePct, 12.2);
  assert.equal(context.marketCapChange24hPct, -1.7);
  assert.equal(context.activeCryptocurrencies, 12_345);
  assert.equal(normalizeGlobalMarketContext({ data: { ...payload.data, market_cap_percentage: { btc: 140 } } }, { now, fetchedAt: now }).btcDominancePct, null);
  const malformedTotals = normalizeGlobalMarketContext({ data: { ...payload.data, total_market_cap: { usd: -1 },
    total_volume: { usd: -1 }, active_cryptocurrencies: -4, market_cap_change_percentage_24h_usd: -101,
    volume_change_percentage_24h_usd: -101 } }, { now, fetchedAt: now });
  assert.equal(malformedTotals.totalMarketCapUsd, null);
  assert.equal(malformedTotals.totalVolumeUsd, null);
  assert.equal(malformedTotals.activeCryptocurrencies, null);
  assert.equal(malformedTotals.marketCapChange24hPct, null);
  assert.equal(malformedTotals.volumeChange24hPct, null);
  const missingActivity = normalizeGlobalMarketContext({ data: { updated_at: now.getTime() / 1000,
    total_market_cap: { usd: 100 }, total_volume: { usd: 0 }, active_cryptocurrencies: null } }, { now, fetchedAt: now });
  assert.equal(missingActivity.activeCryptocurrencies, null, 'missing activity must not become observed zero');
  const stale = normalizeGlobalMarketContext({ data: { ...payload.data, updated_at: (now.getTime() - 7 * 60 * 60_000) / 1000 } }, { now, fetchedAt: now });
  assert.equal(stale.status, 'stale');
  assert.equal(normalizeGlobalMarketContext({ data: { updated_at: now.getTime() / 1000 } }, { now, fetchedAt: now }), null);
});

test('adding global regime context does not change the tactical Crypto score', () => {
  const base = { id: 'context-fixture', rank: 20, price: 100, change1h: 0.5, change24h: 2, change7d: 5,
    volume24h: 100_000_000, volumeToMarketCap: 0.05, athChangePercent: -20,
    marketData: { regime: { key: 'risk_on', label: 'Risk-on', score: 70, allowNewLongs: true } } };
  const context = { source: 'CoinGecko public /global', status: 'fresh', available: true, btcDominancePct: 58 };
  const without = scoreAsset(base);
  const withContext = scoreAsset({ ...base, marketData: { ...base.marketData, regime: { ...base.marketData.regime, globalMarketContext: context } } });
  assert.equal(withContext.score, without.score);
  assert.equal(withContext.risk, without.risk);
});

test('execution-liquidity shadow removes rank from its counterfactual score without changing production score', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const make = (rank, observedAt = now.toISOString()) => ({ rank, volume24h: 100_000_000, volumeToMarketCap: 0.08,
    change1h: 0.5, change24h: 2, change7d: 4, athChangePercent: -30, price: 100, low24h: 90, high24h: 110,
    marketData: { microstructure: { available: true, observedAt, spreadP95Bps: 18, depthUsd1Pct: 150_000 },
      execution: { available: true, oneWaySlippageBps: 35 } } });
  const leading = scoreAsset(make(1), { now });
  const lowerRank = scoreAsset(make(40), { now });
  assert.notEqual(leading.score, lowerRank.score);
  assert.equal(leading.liquidityShadow.version, 'execution-liquidity-v1');
  assert.ok(Math.abs(leading.liquidityShadow.score - lowerRank.liquidityShadow.score) < 1e-10);
  assert.equal(leading.score, scoreAsset(make(1), { now }).score); // production remains deterministic and unchanged
  assert.equal(scoreAsset(make(1, '2026-09-25T11:58:29Z'), { now }).liquidityShadow, null); // stale book/quote data
  assert.equal(scoreAsset({ ...make(1), marketData: {} }, { now }).liquidityShadow, null);
});

test('daily trend research carries provider supply fields and snapshot provenance without changing its score', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const candles = Array.from({ length: 220 }, (_, index) => {
    const close = 100 + index;
    return { time: start + index * 86_400_000, open: close - .5, high: close + 1, low: close - 1, close, volume: 1 };
  });
  const asset = { id: 'fixture-token', symbol: 'FIX', name: 'Fixture', volume24h: 20_000_000,
    circulatingSupply: 50, totalSupply: 80, maxSupply: null, fullyDilutedValuation: null };
  const now = new Date(start + 221 * 86_400_000);
  const result = analyzeInvestment(asset, candles, candles, { now, minVolumeUsd: 1,
    snapshotSource: 'CoinGecko demo', snapshotFetchedAt: '2025-08-10T00:00:00.000Z' });
  const withoutSupply = analyzeInvestment({ ...asset, circulatingSupply: null, totalSupply: null, maxSupply: null, fullyDilutedValuation: null },
    candles, candles, { now, minVolumeUsd: 1, snapshotSource: 'CoinGecko demo', snapshotFetchedAt: '2025-08-10T00:00:00.000Z' });
  assert.equal(result.supplySnapshot.circulating, 50);
  assert.equal(result.supplySnapshot.total, 80);
  assert.equal(result.supplySnapshot.maximum, null);
  assert.equal(result.supplySnapshot.source, 'CoinGecko demo');
  assert.equal(result.supplySnapshot.observedAt, '2025-08-10T00:00:00.000Z');
  assert.equal(result.score, withoutSupply.score); // adding supply evidence does not alter the technical score
});

test('BTC benchmark regime reports trend, relative volatility and drawdown as descriptive metadata only', () => {
  const start = Date.parse('2025-01-01T00:00:00Z');
  const series = (growth) => Array.from({ length: 260 }, (_, index) => {
    const close = 100 * Math.exp(growth * index);
    return { time: start + index * 86_400_000, open: close, high: close * 1.01, low: close * .99, close };
  });
  const rising = classifyBenchmarkRegime(series(.004));
  assert.equal(rising.label, 'risk_on');
  assert.equal(classifyBenchmarkRegime(series(-.004)).label, 'risk_off');
  assert.equal(classifyBenchmarkRegime(series(0)).label, 'mixed');
  assert.equal(classifyBenchmarkRegime(series(.004).slice(-200)).label, 'insufficient_history');
  assert.equal(rising.volatilityRegime, 'typical');
  assert.equal(rising.volatilityPercentile, 50);
  assert.ok(Number.isFinite(rising.annualizedVolatilityPct));
  assert.equal(rising.drawdownFrom252DayPeakPct, 0);
  assert.match(rising.method, /not used to alter asset scores/i);
  const volatile = series(.001);
  for (let index = volatile.length - 20; index < volatile.length; index += 1)
    volatile[index].close = volatile[index - 1].close * (index % 2 ? 1.05 : 0.95);
  const volatileRegime = classifyBenchmarkRegime(volatile);
  assert.ok(volatileRegime.volatilityPercentile >= 90);
  assert.equal(volatileRegime.volatilityRegime, 'extreme');
  const gapped = series(.001);
  gapped[gapped.length - 10].time += 86_400_000;
  assert.equal(classifyBenchmarkRegime(gapped).volatilityRegime, 'insufficient_history');
});
