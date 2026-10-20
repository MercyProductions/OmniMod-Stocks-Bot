import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGuardMetrics, evaluateRiskGuard } from '../src/riskGuard.js';
import { summarizeEdgeEvidence, segmentEdgeEvidence, summarizeProbabilityEvidence, segmentProbabilityEvidence } from '../src/edgeEvidence.js';
import { applyPortfolioRisk } from '../src/portfolioRisk.js';
import { analyzeInvestment, deriveSupplyContext, evaluateInvestmentHorizons, completedDailyCandles, isInvestmentSnapshotFresh, researchInvestments, selectInvestmentCandidates } from '../src/investmentResearch.js';
import { fetchHistoricalCandles } from '../src/marketProviders.js';
import { calibrateProbability } from '../src/predictionEngine.js';
import { buildCommands } from '../src/commands.js';

const now = new Date('2026-09-19T12:00:00Z');
const closed = (r, extras = {}) => ({ status: r > 0 ? 'target_hit' : 'loss', realizedR: r,
  completedAt: '2026-09-19T10:00:00Z', accountingVersion: 2, ...extras });

test('guard rejects missing, malformed and future outcomes without inventing zeros', () => {
  const metrics = calculateGuardMetrics([closed(null), closed(''), closed(false), closed(2, { completedAt: '2027-01-01' }), closed(-1)], {}, now);
  assert.equal(metrics.samples, 1);
  assert.equal(metrics.expectancyR, -1);
  assert.equal(metrics.missingResults, 3);
  assert.equal(metrics.brier, null);
  assert.equal(metrics.calibrationDrift, null);
});

test('hard losses and exposure stop new positions before minimum evidence count', () => {
  const oneLoss = evaluateRiskGuard([closed(-6)], { guardMinOutcomes: 20 }, {}, now);
  assert.equal(oneLoss.paused, true);
  assert.ok(oneLoss.hardReasons.some((reason) => reason.includes('drawdown')));
  assert.ok(oneLoss.hardReasons.some((reason) => reason.includes('24h')));
  const exposure = evaluateRiskGuard([{ status: 'tracking', accountRiskPct: 2 }], { maxOpenRiskPct: 1.5 }, {}, now);
  assert.equal(exposure.paused, true);
  const empty = evaluateRiskGuard([], {}, {}, now);
  assert.equal(empty.allowNewSignals, true);
  assert.equal(empty.operatingMode, 'paper_collecting_evidence');
});

test('calibration compares only the same eligible probability subset and preserves zero', () => {
  const rows = [closed(-1, { probability: 0 }), ...Array.from({ length: 20 }, () => closed(1))];
  const metrics = calculateGuardMetrics(rows, {}, now);
  assert.equal(metrics.probabilitySamples, 1);
  assert.equal(metrics.brier, 0);
  assert.equal(metrics.calibrationDrift, 0);
  assert.ok(metrics.winRate > .9);
  const invalid = calculateGuardMetrics([closed(1, { probability: 1.2 }), closed(1, { probability: null }), closed(1, { probability: .9, accountingVersion: 1 })], {}, now);
  assert.equal(invalid.probabilitySamples, 0);
});

test('risk guard probability floor counts deduplicated eligible pairs, not repeated ids', () => {
  const repeated = Array.from({ length: 20 }, () => closed(1, { id: 'same-outcome', probability: 0 }));
  const guard = evaluateRiskGuard(repeated, { guardMinOutcomes: 20, guardMinExpectancyR: -0.5, guardMaxBrier: 0.15, guardMaxDrawdownR: 25, guardMaxDailyLossR: 25 }, {}, now);
  assert.equal(guard.metrics.probabilitySamples, 1);
  assert.equal(guard.metrics.brier, 1);
  assert.equal(guard.reasons.some((reason) => reason.includes('Probability Brier score')), false);
  assert.equal(guard.allowNewSignals, true);
});

test('hard drawdown includes outcomes outside the smaller statistical window', () => {
  const rows = [closed(-6, { completedAt: '2026-09-15T00:00:00Z' }), ...Array.from({ length: 12 }, (_, i) => closed(1, { completedAt: new Date(Date.parse('2026-09-16') + i * 3600000).toISOString() }))];
  const metrics = calculateGuardMetrics(rows, { guardRollingWindow: 10 }, now);
  assert.equal(metrics.maxDrawdownR, 0);
  assert.equal(metrics.hardDrawdownR, 6);
});

test('net evidence needs corrected history spread across days, excludes duplicate/future labels', () => {
  const sameDay = Array.from({ length: 40 }, (_, i) => closed(i % 2 ? .8 : 1.2));
  assert.equal(summarizeEdgeEvidence(sameDay, { now }).status, 'insufficient_evidence');
  const rows = sameDay.map((row, i) => ({ ...row, id: String(i), horizonKey: i % 2 ? 'rapid' : 'session',
    completedAt: new Date(Date.parse('2026-08-01') + Math.floor(i / 4) * 86400000).toISOString(), realizedR: 1 + Math.floor(i / 4) * .02 + i % 3 * .1 }));
  const evidence = summarizeEdgeEvidence([...rows, rows[0], closed(100, { completedAt: '2027-01-01' })], { now });
  assert.equal(evidence.samples, 40);
  assert.equal(evidence.status, 'positive_estimate');
  assert.ok(evidence.lower95R > 0);
  assert.equal(segmentEdgeEvidence(rows, { now }).filter((row) => row.dimension === 'horizonKey').length, 2);
  assert.equal(calculateGuardMetrics(rows.map((row) => ({ ...row, accountingVersion: 1 })), { guardLookbackHours: 720 }, now).evidence.samples, 0);
});

test('portfolio blocks duplicate symbols without universe data and enforces aggregate planned risk', () => {
  const result = applyPortfolioRisk([{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }],
    [{ status: 'tracking', symbol: 'BTC', accountRiskPct: 1 }], [], { maxConcurrentSignals: 5, maxOpenRiskPct: 1.5, accountRiskPct: .5 });
  assert.deepEqual(result.selected.map((row) => row.symbol), ['ETH']);
  assert.equal(result.rejected.length, 2);
  assert.equal(applyPortfolioRisk([{ symbol: 'BTC' }], [{ symbol: 'BTC', status: 'rejected' }], [], {}).selected.length, 1);
});

test('probability priors do not get data confidence bounds or learn from legacy/future outcomes', () => {
  const result = calibrateProbability(75, [closed(1, { score: 75, accountingVersion: 1 }), closed(1, { score: 75, completedAt: '2027-01-01' })], { asOf: now });
  assert.equal(result.sampleSize, 0);
  assert.equal(result.lowerBound, null);
});

function daily(count = 500, drift = .001) {
  const start = Date.parse('2025-01-01');
  let previous = 100;
  return Array.from({ length: count }, (_, i) => {
    const open = previous;
    previous *= 1 + drift + Math.sin(i / 5) * .001;
    return { time: start + i * 86400000, open, high: previous * 1.01, low: open * .99, close: previous, volume: 1000 };
  });
}
const asset = { id: 'ethereum', symbol: 'ETH', volume24h: 100000000 };

test('longer-hold daily analysis separates constructive strength from insufficient or gapped data', () => {
  const prices = daily(), btc = daily(500, .0005), asOf = new Date(prices.at(-1).time + 86400000);
  const good = analyzeInvestment(asset, prices, btc, { now: asOf });
  assert.equal(good.decision, 'DAILY TREND WATCH');
  assert.ok(good.excess60Pct > 0);
  assert.deepEqual(good.longTermPerformance.map((row) => row.status), ['observed', 'observed', 'observed', 'insufficient_history', 'insufficient_history']);
  assert.equal(good.probability, undefined);
  assert.equal(analyzeInvestment(asset, prices.slice(-150), btc, { now: asOf }).score, null);
  assert.equal(analyzeInvestment(asset, prices.filter((_, i) => i !== 480), btc, { now: asOf }).score, null);
  assert.equal(analyzeInvestment(asset, prices, btc.slice(0, -2), { now: asOf }).score, null);
  assert.equal(analyzeInvestment({ ...asset, symbol: 'USDT' }, prices, btc, { now: asOf }).score, null);
  const weakTrend = analyzeInvestment(asset, daily(500, -.001), btc, { now: asOf });
  assert.ok(weakTrend.reasons.some((reason) => /misses one or more criteria.*SMA200.*60% 50-day trend persistence/.test(reason)));
  const noSnapshot = analyzeInvestment({ ...asset, volume24h: null }, prices, btc, { now: asOf });
  assert.ok(noSnapshot.reasons.includes('Current 24-hour dollar-volume snapshot is unavailable; liquidity cannot be evaluated.'));
  const belowFloor = analyzeInvestment({ ...asset, volume24h: 4_999_999 }, prices, btc, { now: asOf });
  assert.ok(belowFloor.reasons.some((reason) => /Reported 24-hour dollar volume is below the \$5,000,000 research minimum/.test(reason)));
  assert.ok(!belowFloor.reasons.some((reason) => /snapshot is unavailable/.test(reason)));
});

test('long-horizon Crypto price context is BTC-relative and cannot change the daily trend rank', () => {
  const prices = daily(600, .001), btc = daily(600, .0005), asOf = new Date(prices.at(-1).time + 86400000);
  const base = analyzeInvestment(asset, prices, btc, { now: asOf });
  const olderPathChanged = prices.map((row, index) => index < 300 ? { ...row, close: row.close * 2, high: row.high * 2 } : row);
  const revised = analyzeInvestment(asset, olderPathChanged, btc, { now: asOf });
  assert.equal(revised.score, base.score);
  assert.equal(revised.decision, base.decision);
  assert.notEqual(revised.longTermPerformance.find((row) => row.days === 365).assetReturnPct,
    base.longTermPerformance.find((row) => row.days === 365).assetReturnPct);
  const gapped = analyzeInvestment(asset, prices.filter((_, index) => index !== 500), btc, { now: asOf });
  assert.equal(gapped.longTermPerformance.find((row) => row.days === 180).status, 'gapped_asset_history');
});

test('stored prediction-time probabilities expose descriptive Brier and reliability by context', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, accountingVersion: 2, status: index < 12 ? 'target_hit' : 'loss', probability: .8,
    realizedR: index < 12 ? .5 : -1, completedAt: new Date(Date.parse('2026-09-01T12:00:00Z') + Math.floor(index / 6) * 86400000).toISOString(),
    horizonKey: index % 2 ? 'rapid' : 'session', assetClass: 'large', regimeKey: 'risk_on' }));
  const evidence = summarizeProbabilityEvidence(rows, { now });
  assert.equal(evidence.samples, 30);
  assert.equal(evidence.independentDayClusters, 5);
  assert.equal(evidence.status, 'descriptive_only');
  assert.ok(Math.abs(evidence.meanProbability - .8) < 1e-12);
  assert.ok(Math.abs(evidence.observedPositiveRate - .4) < 1e-12);
  assert.ok(Math.abs(evidence.absoluteCalibrationGap - .4) < 1e-12);
  assert.ok(evidence.brier > evidence.sameSampleBaseRateBrier);
  assert.equal(evidence.brierSkillVsSameSampleBaseRate < 0, true);
  assert.match(evidence.method, /not a calibration certification/);
  const segments = segmentProbabilityEvidence(rows, { now });
  assert.equal(segments.find((row) => row.dimension === 'horizonKey' && row.key === 'rapid').samples, 15);
  const clustered = summarizeProbabilityEvidence(rows.map((row) => ({ ...row, completedAt: rows[0].completedAt })), { now });
  assert.equal(clustered.status, 'insufficient_evidence');
  const guard = calculateGuardMetrics(rows, { guardLookbackHours: 720 }, now);
  assert.equal(guard.probabilityEvidence.samples, 30);
  assert.equal(guard.probabilitySegments.length, 4);
});

test('daily investment candidate funnel preserves market-cap core and adds momentum and turnover discoveries', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: `coin-${index}`, symbol: `C${index}`, rank: index + 1,
    change7d: index === 20 ? 250 : 10 - index, change24h: index === 20 ? 25 : 1,
    volume24h: 1_000_000 + index, volumeToMarketCap: index === 25 ? 4 : 0.02 }));
  const selected = selectInvestmentCandidates(rows, 12);
  assert.equal(selected.length, 12);
  assert.deepEqual(selected.slice(0, 6).map((row) => row.id), ['coin-0','coin-1','coin-2','coin-3','coin-4','coin-5']);
  assert.ok(selected.some((row) => row.id === 'coin-20' && row.selectionTrack === 'weekly momentum discovery'));
  assert.ok(selected.some((row) => row.id === 'coin-25' && row.selectionTrack === 'relative-turnover discovery'));
  assert.equal(selectInvestmentCandidates(rows, 50).length, 20);
});

test('expanded investment history fetch runs with bounded concurrency and records selection track', async () => {
  const requests = [], requestedLimits = [];
  let active = 0, maximumActive = 0;
  const assets = Array.from({ length: 20 }, (_, index) => ({ id: index === 0 ? 'bitcoin' : `coin-${index}`,
    symbol: index === 0 ? 'BTC' : `C${index}`, rank: index + 1, price: 10 + index, volume24h: 50_000_000,
    volumeToMarketCap: index / 10, change7d: index, change24h: index / 2 }));
  const candles = Array.from({ length: 400 }, (_, index) => ({ time: Date.UTC(2025, 0, 1) + index * 86_400_000, open: 100 + index,
    high: 101 + index, low: 99 + index, close: 100 + index, volume: 1000 }));
  const report = await researchInvestments(assets, { maxCandidates: 4, historyFetcher: async (asset, options) => {
    requests.push(asset.symbol); active += 1; maximumActive = Math.max(maximumActive, active);
    requestedLimits.push(options.limit);
    await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1;
    return { provider: 'Fixture', candles };
  } });
  assert.equal(report.candidatePoolSize, 20);
  assert.equal(report.candidateCount, 4);
  assert.equal(report.results.length, 4);
  assert.equal(new Set(report.results.map((row) => row.selectionTrack)).size, 3);
  assert.equal(maximumActive, 2);
  assert.equal(requests.length, 4);
  assert.ok(requestedLimits.every((limit) => limit === 1000));
});

test('same-snapshot supply ratios expose float and FDV context without changing the trend decision', () => {
  const prices = daily(), btc = daily(500, .0005), asOf = new Date(prices.at(-1).time + 86400000);
  const base = analyzeInvestment(asset, prices, btc, { now: asOf });
  const withSupply = analyzeInvestment({ ...asset, circulatingSupply: 75, totalSupply: 100, maxSupply: 120,
    marketCap: 1_000_000, fullyDilutedValuation: 1_600_000 }, prices, btc,
  { now: asOf, snapshotSource: 'CoinGecko', snapshotFetchedAt: '2026-09-19T11:00:00Z' });
  assert.equal(withSupply.score, base.score);
  assert.equal(withSupply.decision, base.decision);
  assert.equal(withSupply.supplyContext.circulatingOfTotalPct, 75);
  assert.equal(withSupply.supplyContext.circulatingOfMaximumPct, 62.5);
  assert.ok(Math.abs(withSupply.supplyContext.fdvPremiumPct - 60) < 1e-9);
  assert.equal(withSupply.supplyContext.source, 'CoinGecko');
  assert.deepEqual(withSupply.supplyContext.issues, []);
});

test('inconsistent or incomplete supply pairs stay unavailable with an explicit consistency note', () => {
  const result = deriveSupplyContext({ circulating: 110, total: 100, maximum: 90, marketCapUsd: 200, fullyDilutedValuationUsd: 150,
    source: 'CoinPaprika', observedAt: '2026-09-19T11:00:00Z' });
  assert.equal(result.circulatingOfTotalPct, null);
  assert.equal(result.circulatingOfMaximumPct, null);
  assert.equal(result.fdvPremiumPct, null);
  assert.equal(result.issues.length, 3);
  assert.equal(deriveSupplyContext({ circulating: 75, total: null, maximum: null, marketCapUsd: 100, fullyDilutedValuationUsd: null }).circulatingOfTotalPct, null);
});

test('daily selection only consumes completed data at the stated decision time', () => {
  const prices = daily(), btc = daily(500, .0005), asOf = new Date(prices[400].time);
  const before = analyzeInvestment(asset, prices, btc, { now: asOf });
  const changed = prices.map((row, i) => i >= 400 ? { ...row, high: row.high * 2, close: row.close * 2 } : row);
  assert.deepEqual(analyzeInvestment(asset, changed, btc, { now: asOf }), before);
  assert.equal(completedDailyCandles(prices, asOf).length, 400);
});

test('5/20/60-day evaluation uses separate windows, costs, BTC baseline and next-open entry', () => {
  const prices = daily(), asOf = new Date(prices.at(-1).time + 86400000);
  const zeroCost = evaluateInvestmentHorizons(prices, prices, { now: asOf, roundTripFeeBps: 0 });
  const cost = evaluateInvestmentHorizons(prices, prices, { now: asOf, roundTripFeeBps: 50 });
  assert.deepEqual(cost.map((row) => row.horizonDays), [5,20,60]);
  for (let i = 0; i < cost.length; i++) {
    assert.ok(cost[i].samples > 0);
    assert.ok(Math.abs(zeroCost[i].meanNetReturnPct - cost[i].meanNetReturnPct - .5) < 1e-9);
    assert.equal(cost[i].meanExcessReturnPct, 0);
    const trades = cost[i].trades;
    assert.ok(trades.every((row, j) => !j || Date.parse(row.entryAt) >= Date.parse(trades[j - 1].exitAt)));
    assert.ok(trades.every((row) => row.entryAt === row.signalAt));
  }
  assert.match(cost[2].evidence, /INSUFFICIENT/);
});

test('daily provider requests use daily interval and exclude the current unfinished day', async (t) => {
  const start = Math.floor(Date.now() / 86400000) * 86400000;
  const raw = Array.from({ length: 201 }, (_, i) => [start - (200 - i) * 86400000, 100, 101, 99, 100, 1]);
  let url;
  t.mock.method(globalThis, 'fetch', async (value) => { url = String(value); return new Response(JSON.stringify(raw)); });
  const result = await fetchHistoricalCandles({ symbol: 'DAILYTEST' }, { interval: '1d', limit: 300, providers: ['Binance'] });
  assert.match(url, /interval=1d/);
  assert.equal(result.candles.length, 200);
  assert.equal(result.intervalMs, 86400000);
});

test('Discord command schema exposes invest research without a trading action', () => {
  const schema = buildCommands()[0];
  assert.ok(schema.options.some((option) => option.name === 'invest'));
  assert.match(schema.options.find((option) => option.name === 'invest').description, /not protocol underwriting/i);
  assert.ok(schema.options.some((option) => option.name === 'diagnostics'));
  assert.ok(schema.options.length <= 25);
  const configure = schema.options.find((option) => option.name === 'configure');
  const minimumScore = configure.options.find((option) => option.name === 'minimum_score');
  assert.match(minimumScore.description, /momentum screen score; this is not a probability/i);
  const event = schema.options.find((option) => option.name === 'event');
  const eventOptions = event.options;
  assert.ok(eventOptions.some((option) => option.name === 'source_url'));
  assert.ok(eventOptions.some((option) => option.name === 'starts_at'));
  assert.ok(eventOptions.some((option) => option.name === 'expectedness'));
  assert.ok(eventOptions.find((option) => option.name === 'severity').choices.some((choice) => choice.value === 'observe'));
});

test('stale, absent and future liquidity snapshots cannot support a current investment ranking', () => {
  assert.equal(isInvestmentSnapshotFresh({ fetchedAt: '2026-09-19T11:30:00Z' }, now), true);
  assert.equal(isInvestmentSnapshotFresh({ fetchedAt: '2026-09-19T11:30:00Z', stale: true }, now), false);
  assert.equal(isInvestmentSnapshotFresh({ fetchedAt: '2026-09-19T09:00:00Z' }, now), false);
  assert.equal(isInvestmentSnapshotFresh({ fetchedAt: '2026-09-19T13:00:00Z' }, now), false);
  assert.equal(isInvestmentSnapshotFresh({}, now), false);
});
