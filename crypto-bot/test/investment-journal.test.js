import test from 'node:test';
import assert from 'node:assert/strict';
import { updateInvestmentJournal, summarizeInvestmentJournal, pendingInvestmentSymbols } from '../src/investmentJournal.js';
import { factorLines, formatOpeningInvestmentResearch, formatOpeningScanDecision, paperOutcomeLabel, predictionEmbed, summarizeSignalEvidence, trackerConfidenceText } from '../src/discordPublisher.js';

const DAY = 86400000;
const start = Date.parse('2026-01-01T00:00:00Z');
test('paper outcome labels distinguish an expired target from short-position direction', () => {
  assert.equal(paperOutcomeLabel('fell_short'), 'target not reached');
  assert.equal(paperOutcomeLabel('target_hit'), 'first target reached');
  assert.equal(paperOutcomeLabel('loss'), 'stop reached');
});

function bars(count) { return Array.from({ length: count }, (_, i) => ({ time: start + i * DAY, open: 100 + i, close: 101 + i })); }
function fixture(count, decision = 'DAILY TREND WATCH') {
  const history = { provider: 'Fixture', pair: 'ETHUSD', candles: bars(count) };
  const result = { symbol: 'ETH', assetId: 'ethereum', score: 80, asOf: new Date(start + DAY).toISOString(), decision, marketRegime: { label: 'risk_on' } };
  return { contexts: [{ history, result }], benchmark: { provider: 'Fixture', pair: 'BTCUSD', candles: bars(count) } };
}
function dailyFixture(count, { provider = 'Binance', assetPair = 'ETHUSDT', benchmarkPair = 'BTCUSDT' } = {}) {
  const data = fixture(count);
  data.contexts[0].history.provider = provider;
  data.contexts[0].history.pair = assetPair;
  data.contexts[0].history.interval = '1d';
  data.contexts[0].result.asOf = new Date(start + count * DAY).toISOString();
  data.benchmark.provider = provider;
  data.benchmark.pair = benchmarkPair;
  data.benchmark.interval = '1d';
  return data;
}
function memoryStorage() {
  let state;
  return { readJson: async (_, fallback) => structuredClone(state ?? fallback),
    writeJson: async (_, value) => { state = structuredClone(value); }, get: () => structuredClone(state) };
}

test('private journal freezes the first decision and resolves only genuine future sessions', async () => {
  const storage = memoryStorage(), file = 'journal-fixture-immutable';
  const initial = fixture(1);
  initial.contexts[0].result.marketRegime.volatilityRegime = 'extreme';
  const captured = new Date(start + DAY + 3600000);
  const contextAtCapture = { source: 'CoinGecko public /global', status: 'fresh', available: true,
    fetchedAt: captured.toISOString(), providerUpdatedAt: captured.toISOString(), btcDominancePct: 58,
    ethDominancePct: 12, totalMarketCapUsd: 2_500_000_000_000, totalVolumeUsd: 90_000_000_000,
    marketCapChange24hPct: 1.2, volumeChange24hPct: 3.4 };
  const first = await updateInvestmentJournal('fixture', initial.contexts, initial.benchmark, { storage, file, now: captured, roundTripFeeBps: 40,
    globalMarketContext: contextAtCapture });
  assert.equal(first.snapshots, 3);
  assert.deepEqual(first.globalContextCoverage, { total: 1, fresh: 1, stale: 0, unavailable: 0, missing: 0 });
  assert.equal(first.resolved, 0);
  const later = fixture(8, 'WAIT / HIGH RISK');
  const result = await updateInvestmentJournal('fixture', later.contexts, later.benchmark, { storage, file, now: new Date(start + 8 * DAY), roundTripFeeBps: 1 });
  assert.equal(result.snapshots, 3);
  assert.equal(result.resolved, 1);
  const record = storage.get().observations.find((row) => row.horizonSessions === 5);
  assert.equal(record.decision, 'DAILY TREND WATCH');
  assert.equal(record.volatilityRegime, 'extreme');
  assert.equal(record.roundTripCostBps, 40);
  assert.equal(record.observedAt, captured.toISOString());
  assert.deepEqual(record.globalMarketContext, contextAtCapture, 'market-wide context is frozen at issuance for future descriptive cohort analysis');
  assert.equal(record.resolution.entryAt, new Date(start + 2 * DAY).toISOString());
  assert.equal(record.resolution.exitAt, new Date(start + 7 * DAY).toISOString());
  assert.equal(record.resolution.noTradeExecuted, true);
  assert.deepEqual(result.globalContextCoverage, { total: 1, fresh: 1, stale: 0, unavailable: 0, missing: 0 });
  assert.ok(Math.abs(record.resolution.netReturn - (107 / 102 - 1 - .004)) < 1e-12);
});

test('provider switches and missing benchmark sessions remain pending', async () => {
  const storage = memoryStorage(), file = 'journal-fixture-missing';
  const first = fixture(1);
  await updateInvestmentJournal('fixture', first.contexts, first.benchmark, { storage, file, now: new Date(start + DAY + 3600000) });
  const later = fixture(10);
  later.contexts[0].history.provider = 'Different';
  let status = await updateInvestmentJournal('fixture', later.contexts, later.benchmark, { storage, file, now: new Date(start + 10 * DAY) });
  assert.equal(status.resolved, 0);
  later.contexts[0].history.provider = 'Fixture';
  later.benchmark.candles.splice(3, 1);
  status = await updateInvestmentJournal('fixture', later.contexts, later.benchmark, { storage, file, now: new Date(start + 10 * DAY) });
  assert.equal(status.resolved, 0);
});

test('concurrent journal updates preserve both snapshots and invalid storage is not replaced', async () => {
  const storage = memoryStorage(), file = 'journal-fixture-concurrent';
  const first = fixture(1), second = fixture(1);
  second.contexts[0].result.symbol = 'SOL';
  await Promise.all([updateInvestmentJournal('fixture', first.contexts, first.benchmark, { storage, file, now: new Date(start + DAY) }),
    updateInvestmentJournal('fixture', second.contexts, second.benchmark, { storage, file, now: new Date(start + DAY) })]);
  assert.equal(storage.get().observations.length, 6);
  let wrote = false;
  await assert.rejects(updateInvestmentJournal('fixture', first.contexts, first.benchmark, { file: 'journal-corrupt', now: new Date(start + DAY),
    storage: { readJson: async () => ({ version: 1, observations: null }), writeJson: async () => { wrote = true; } } }), /invalid structure/);
  assert.equal(wrote, false);
});

test('forward summary separates trend/volatility cohorts and does not call overlaps independent samples', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ symbol: 'ETH', marketRegime: 'risk_on', volatilityRegime: 'elevated', horizonSessions: 5, decision: 'DAILY TREND WATCH',
    asOf: new Date(start + i * DAY).toISOString(), observedAt: new Date(start + i * DAY + 3600000).toISOString(),
    resolution: { entryAt: new Date(start + i * DAY).toISOString(), exitAt: new Date(start + (i + 5) * DAY).toISOString(), netReturn: .01, excessReturn: .005 } }));
  const result = summarizeInvestmentJournal(records, 'ETH');
  assert.equal(result.horizons[0].resolved, 10);
  assert.equal(result.horizons[0].nonOverlappingWindows, 2);
  assert.equal(result.horizons[0].meanNetReturnPct, 1);
  assert.equal(result.byRegime.risk_on[5].resolved, 10);
  assert.equal(result.byRegime.risk_on[5].nonOverlappingWindows, 2);
  assert.equal(result.byVolatilityRegime.elevated[5].resolved, 10);
  assert.equal(result.byVolatilityRegime.elevated[5].nonOverlappingWindows, 2);
  assert.deepEqual(result.globalContextCoverage, { total: 10, fresh: 0, stale: 0, unavailable: 0, missing: 10 });
  const legacy = summarizeInvestmentJournal([{ symbol: 'ETH', horizonSessions: 5, decision: 'WAIT',
    resolution: { entryAt: new Date(start).toISOString(), exitAt: new Date(start + 5 * DAY).toISOString(), netReturn: -.01, excessReturn: -.005 } }], 'ETH');
  assert.equal(legacy.byVolatilityRegime.unknown[5].resolved, 1);
  assert.match(result.limitation, /overlap/);
});

test('opening summary separates daily watch research and explicit journal unavailability', () => {
  assert.match(formatOpeningInvestmentResearch({ unavailable: 'journal unavailable' }), /unavailable/);
  const report = { results: [{ symbol: 'ETH', score: 70, decision: 'DAILY TREND WATCH' }], forwardJournal: { resolved: 0, pending: 3,
    longWindowShadow: { 90: { nonOverlappingWindows: 1, pending: 2 }, 180: { nonOverlappingWindows: 0, pending: 3 }, 365: { nonOverlappingWindows: 0, pending: 1 } } } };
  const text = formatOpeningInvestmentResearch(report);
  assert.match(text, /DAILY PRICE-TREND WATCHLIST/);
  assert.match(text, /ETH/);
  assert.match(text, /0 resolved \/ 3 pending/);
  assert.match(text, /Monthly long-window shadow of the 200-day screen: 90d 1 non-overlap resolved \/ 2 pending/);
  assert.match(text, /no buy instruction/);
  assert.ok(text.length <= 1024);
});

test('long-window shadow captures monthly same-venue crypto daily paths within provider coverage', async () => {
  const storage = memoryStorage(), file = 'journal-long-window-monthly';
  const first = dailyFixture(400);
  const firstNow = new Date(start + 400 * DAY + 60 * 60_000);
  let report = await updateInvestmentJournal('fixture', first.contexts, first.benchmark, { storage, file, now: firstNow });
  assert.equal(report.longWindowShadow[90].issued, 1);
  assert.equal(report.longWindowShadow[180].issued, 1);
  assert.equal(report.longWindowShadow[365].issued, 1);
  assert.equal(report.longWindowShadow[365].pending, 1);
  let saved = storage.get();
  const shadow = saved.observations.filter((row) => row.modelVersion === 'crypto-daily-long-window-shadow-v1');
  assert.equal(shadow.length, 3);
  assert.ok(shadow.every((row) => row.researchTrack.includes('monthly long-window shadow') && row.dataProvider === 'Binance'));
  assert.equal(saved.longWindowCaptureBySymbol.ETH, firstNow.toISOString().slice(0, 7));

  const sameMonth = dailyFixture(401);
  report = await updateInvestmentJournal('fixture', sameMonth.contexts, sameMonth.benchmark,
    { storage, file, now: new Date(start + 401 * DAY + 60 * 60_000) });
  assert.equal(report.longWindowShadow[90].issued, 1, 'daily calls do not duplicate a monthly long-window capture');

  const nextMonth = dailyFixture(432);
  report = await updateInvestmentJournal('fixture', nextMonth.contexts, nextMonth.benchmark,
    { storage, file, now: new Date(start + 432 * DAY + 60 * 60_000) });
  assert.equal(report.longWindowShadow[90].issued, 2);

  const coinbaseStorage = memoryStorage(), coinbase = dailyFixture(320, { provider: 'Coinbase', assetPair: 'ETH-USD', benchmarkPair: 'BTC-USD' });
  report = await updateInvestmentJournal('fixture', coinbase.contexts, coinbase.benchmark,
    { storage: coinbaseStorage, file: 'journal-coinbase-limits', now: new Date(start + 320 * DAY + 60 * 60_000) });
  assert.equal(report.longWindowShadow[90].issued, 1);
  assert.equal(report.longWindowShadow[180].issued, 1);
  assert.equal(report.longWindowShadow[365].issued, 0, 'a 300-candle Coinbase daily cap cannot support a 365-day path');

  const mismatched = dailyFixture(400, { provider: 'Binance', assetPair: 'ETHUSDT', benchmarkPair: 'BTCUSD' });
  report = await updateInvestmentJournal('fixture', mismatched.contexts, mismatched.benchmark,
    { storage: memoryStorage(), file: 'journal-mismatched-quote', now: firstNow });
  assert.equal(report.longWindowShadow[90].issued, 0, 'long-window asset and BTC baselines require the same quote currency');

  const ambiguous = dailyFixture(400);
  ambiguous.contexts.push({ ...structuredClone(ambiguous.contexts[0]), result: { ...ambiguous.contexts[0].result, assetId: 'other-eth' } });
  report = await updateInvestmentJournal('fixture', ambiguous.contexts, ambiguous.benchmark,
    { storage: memoryStorage(), file: 'journal-ambiguous-symbol', now: firstNow });
  assert.equal(report.longWindowShadow[90].issued, 0, 'duplicate provider assets with the same ticker are not merged into one shadow track');
});

test('crypto prediction card labels tactical paper trades separately from daily investment research', () => {
  const embed = predictionEmbed({ symbol: 'BTC', action: 'PAPER LONG', horizonLabel: 'Momentum scalp',
    thesis: 'Fixture thesis', disclaimer: 'Paper research only.', risk: 'High', confidence: 50, confidenceLowerBound: null,
    confidenceMethod: 'model estimate; collecting calibration data', calibrationSampleSize: 0, continuation: 'Monitor the setup.',
    globalMarketContext: { available: true, status: 'fresh', totalMarketCapUsd: 2_500_000_000_000,
      totalVolumeUsd: 90_000_000_000, btcDominancePct: 58.4, ethDominancePct: 12.1,
      marketCapChange24hPct: -1.2, volumeChange24hPct: 4.5, providerUpdatedAt: '2026-09-24T12:00:00.000Z' },
    createdAt: '2026-09-24T12:00:00.000Z', deadlineAt: '2026-09-24T13:00:00.000Z' });
  assert.match(embed.data.title, /^SHORT-TERM PAPER TRADE \| BTC \| PAPER LONG$/);
  assert.equal(embed.data.fields.find((field) => field.name === 'Probability evidence').value,
    'Withheld: the historical score-band estimate needs 30 comparable outcomes across 5 distinct UTC days (0/30 outcomes, unknown/5 days). The score-derived prior is not a measured probability.');
  assert.match(embed.data.fields.find((field) => field.name === 'Reward / risk').value, /modeled EV proxy/);
  const globalContext = embed.data.fields.find((field) => field.name === 'Global crypto context').value;
  assert.match(globalContext, /BTC \/ ETH dominance 58\.40% \/ 12\.10%/);
  assert.match(globalContext, /Descriptive context only; not used by approval or score/);
  assert.match(embed.data.fields.find((field) => field.name === 'Manually labeled catalysts (not model-validated)').value, /automated catalyst coverage is incomplete/);
  const catalyst = predictionEmbed({ symbol: 'BTC', action: 'WAIT', horizonLabel: 'Momentum scalp', thesis: 'Fixture',
    disclaimer: 'Paper only', risk: 'Elevated', confidence: 50, createdAt: '2026-09-24T12:00:00Z',
    continuation: 'Continue monitoring.',
    catalystContext: [{ eventType: 'exchange_listing', direction: 'positive', expectedness: 'scheduled', horizon: 'swing', impact: 'medium', severity: 'observe', reason: 'Admin-reported listing', sourceUrl: 'https://example.org/listing' }] });
  const catalystField = catalyst.data.fields.find((field) => field.name === 'Manually labeled catalysts (not model-validated)').value;
  assert.match(catalystField, /exchange_listing \| positive \| scheduled \| swing \| medium \| observe/);
  assert.match(catalystField, /https:\/\/example\.org\/listing/);
  const research = formatOpeningInvestmentResearch({ results: [{ symbol: 'BTC', decision: 'DAILY TREND WATCH' }] });
  assert.match(research, /^DAILY PRICE-TREND WATCHLIST/);
  assert.match(research, /no fundamental\/tokenomics underwriting/);
  const evidence = embed.data.fields.find((field) => field.name === 'Evidence at prediction time').value;
  assert.ok(evidence.length <= 1024);
  assert.match(evidence, /No additional positive market factor/);
  assert.match(evidence, /Probability calibration evidence is limited/);
  assert.match(evidence, /Validated learning model is inactive/);
});

test('crypto prediction card identifies provider headlines as market-wide unscored context', () => {
  const embed = predictionEmbed({ symbol: 'ETH', action: 'PAPER LONG', thesis: 'Fixture', disclaimer: 'Paper only.', risk: 'High',
    confidence: 50, continuation: 'Monitor.', createdAt: '2026-09-29T15:00:00.000Z', recentMarketNews: [{ source: 'Wire', headline: 'Exchange reports an outage', eventType: 'network_disruption', direction: 'negative', potentialSeverity: 'high',
      publishedAt: '2026-09-29T14:59:00.000Z', url: 'https://example.org/story', relatedEntities: ['WETH'] },
    { source: 'Wire', headline: 'Ethereum network update', publishedAt: '2026-09-29T14:58:00.000Z', relatedEntities: ['ETH'] }] });
  const field = embed.data.fields.find((item) => item.name === 'Recent crypto market headlines — unscored');
  assert.match(field.value, /Exchange reports an outage/);
  assert.match(field.value, /rule tag network\\_disruption \/ negative \/ potential severity high/);
  assert.match(field.value, /no exact related-symbol tag/);
  assert.match(field.value, /Finnhub related tag matches ETH/);
  assert.match(field.value, /event truth, expectedness, price impact/);
  assert.match(field.value, /related tags are provider metadata, not verified event impact/);
  assert.match(field.value, /Headlines are unscored and do not affect the decision/);
  assert.match(field.value, /https:\/\/example\.org\/story/);
  const unknownPublisher = predictionEmbed({ symbol: 'BTC', action: 'PAPER LONG', thesis: 'Fixture', disclaimer: 'Paper only.', risk: 'High',
    confidence: 50, continuation: 'Monitor.', createdAt: '2026-09-29T15:00:00.000Z', recentMarketNews: [{ headline: 'Source not supplied',
      publishedAt: '2026-09-29T14:59:00.000Z', url: '' }] }).data.fields.find((item) => item.name === 'Recent crypto market headlines — unscored');
  assert.match(unknownPublisher.value, /Finnhub feed — publisher unknown/);
  assert.match(unknownPublisher.value, /no article URL/);
});

test('crypto evidence summary separates observed momentum support from model and volatility cautions', () => {
  const evidence = summarizeSignalEvidence({ providerCount: 3, providers: 'A, B, C', change1h: 1.2, change24h: 4.5,
    change7d: 8.1, risk: 'High', marketRegime: 'BTC risk-off', calibrationSampleSize: 4, metaModelActive: false,
    outcomeModelActive: false, factors: { executionCostBps: 35, executionQuality: 'REST/ATR fallback' } });
  assert.deepEqual(evidence.supporting.slice(0, 3), ['3 price sources (A, B, C)', '1h momentum 1.20%', '24h momentum 4.50%']);
  assert.ok(evidence.cautions.some((reason) => /calibration evidence is limited/.test(reason)));
  assert.ok(evidence.cautions.some((reason) => /volatility risk is high/.test(reason)));
  assert.ok(evidence.cautions.some((reason) => /BTC regime is BTC risk-off/.test(reason)));
  assert.ok(evidence.cautions.some((reason) => /Estimated round-trip execution cost is 35.0 bps \(REST\/ATR fallback\)/.test(reason)));
  const zeroEstimate = summarizeSignalEvidence({ factors: { executionCostBps: 0, executionQuality: 'live microstructure' } });
  assert.ok(zeroEstimate.cautions.some((reason) => /0.0 bps \(live microstructure\)/.test(reason)));
  const missingEstimate = summarizeSignalEvidence({ factors: { executionCostBps: 0, executionQuality: 'unknown' } });
  assert.ok(missingEstimate.cautions.some((reason) => /Execution-cost estimate unavailable/.test(reason)));
});

test('Crypto factor card distinguishes unavailable market data from observed zero values', () => {
  const missingLine = factorLines({ factors: { snapshotModel: 50, technicalDataSufficient: false, orderBookAvailable: false, providerCount: 1,
      derivativesConfigured: true, derivativesAvailable: true, derivativesProviderCount: 1,
      openInterestChangeAvailable: false, fundingAnnualizedPct: 0,
      microstructureAvailable: true, orderFlowAvailable: false, depthAvailable: false, spreadAvailable: false,
      executionCostBps: 20, executionQuality: 'REST/ATR fallback',
      dvolAvailable: false, optionsAvailable: true, putCallSkewAvailable: false, validationRan: true, validationTrades: 0,
      overallValidationRan: true, validationOverallTrades: 0 } });
  assert.match(missingLine, /Technical n\/a/);
  assert.match(missingLine, /Book n\/a/);
  assert.match(missingLine, /Funding PA 0\.00% \| OI 5m n\/a/);
  assert.match(missingLine, /Flow n\/a \| Depth n\/a \| Micro spread n\/a/);
  assert.match(missingLine, /Execution est\. 20\.0bps \(REST\/ATR fallback\)/);
  assert.match(missingLine, /DVOL n\/a \| Put skew n\/a/);
  assert.match(missingLine, /Recent check no completed sample \(n=0\)/);

  const zeroLine = factorLines({ factors: { snapshotModel: 50, technicalDataSufficient: true, technicalScore: 0, rsi14: 0, adx14: 0, atrPct: 0,
      volumeZScore: 0, orderBookAvailable: true, orderBookImbalance: 0, providerCount: 2, priceDispersionPct: 0,
      regimeScore: 50, derivativesConfigured: true, derivativesAvailable: true, derivativesProviderCount: 1,
      openInterestChangeAvailable: true,
      derivativesScore: 50, fundingAnnualizedPct: 0, openInterestChangePct: 0, microstructureAvailable: true,
      orderFlowAvailable: true, depthAvailable: true, spreadAvailable: true,
      orderFlowImbalance: 0, depthImbalance: 0, microSpreadBps: 0, executionCostBps: 20,
      executionQuality: 'live microstructure', dvolAvailable: false, optionsAvailable: true, putCallSkewAvailable: true, putCallSkewIv: 0,
      validationRan: true, validationTrades: 12, validationExpectancyR: 0,
      overallValidationRan: true, validationOverallTrades: 12, validationOverallExpectancyR: 0 } });
  assert.match(zeroLine, /Book \+0\.0%/);
  assert.match(zeroLine, /Funding PA 0\.00% \| OI 5m 0\.00%/);
  assert.match(zeroLine, /Flow \+0\.0% \| Depth \+0\.0% \| Micro spread 0\.0bps/);
  assert.match(zeroLine, /Put skew 0\.0 IV/);
  assert.match(zeroLine, /Recent check 0\.00R\/12/);
});

test('Crypto does not present score priors as probabilities before calibration evidence exists', () => {
  assert.equal(trackerConfidenceText({ confidence: 57, confidenceMethod: 'model estimate; collecting calibration data', calibrationSampleSize: 4 }),
    'Withheld: the historical score-band estimate needs 30 comparable outcomes across 5 distinct UTC days (4/30 outcomes, unknown/5 days). The score-derived prior is not a measured probability.');
  assert.equal(trackerConfidenceText({ confidence: 57 }),
    'Withheld: the historical score-band estimate needs 30 comparable outcomes across 5 distinct UTC days (unknown/30 outcomes, unknown/5 days). The score-derived prior is not a measured probability.');
  assert.equal(trackerConfidenceText({ confidence: 57, calibrationSampleSize: 0, calibrationDayCount: 0 }),
    'Withheld: the historical score-band estimate needs 30 comparable outcomes across 5 distinct UTC days (0/30 outcomes, 0/5 days). The score-derived prior is not a measured probability.');
});

test('Crypto probability display distinguishes a qualified model estimate from an unverified historical score-band estimate', () => {
  assert.match(trackerConfidenceText({ confidence: 60, metaModelActive: true, metaAbstained: false,
    metaProbability: .61, calibrationSampleSize: 42 }), /Holdout-qualified model estimate: 61\.0%/);
  assert.match(trackerConfidenceText({ confidence: 62, calibrationQualified: true,
    confidenceMethod: 'historical score-band estimate; independent calibration unverified',
    confidenceLowerBound: 55, calibrationSampleSize: 35, calibrationDayCount: 8 }), /Historical score-band estimate of positive after-cost paper R: 62\.0%.*posterior lower bound 55\.0%.*has not passed an independent calibration test/);
  assert.match(trackerConfidenceText({ confidence: 62, confidenceMethod: 'empirically calibrated',
    confidenceLowerBound: 55, calibrationSampleSize: 35, calibrationDayCount: 2 }), /Withheld.*n=35, days=2/);
  assert.match(trackerConfidenceText({ confidence: 62, confidenceMethod: 'empirically calibrated',
    confidenceLowerBound: null, calibrationSampleSize: 35, calibrationDayCount: 8 }), /Withheld/);
  assert.match(trackerConfidenceText({ confidence: 72, metaModelActive: true, metaAbstained: true,
    metaAbstainReason: 'out of distribution', calibrationSampleSize: 42 }), /model abstained.*out of distribution/);
});

test('daily trend journal summary continues to count legacy longer-hold labels', () => {
  const result = summarizeInvestmentJournal([{ symbol: 'BTC', horizonSessions: 5, decision: 'LONGER-HOLD WATCH',
    resolution: { entryAt: new Date(start + DAY).toISOString(), exitAt: new Date(start + 6 * DAY).toISOString(), netReturn: .01, excessReturn: 0 } }], 'BTC');
  assert.equal(result.horizons[0].watchSnapshots, 1);
});

test('opening decision explains a risk pause separately from model qualification', () => {
  const paused = formatOpeningScanDecision({ preliminary: 8, confirmed: 0, portfolioSelected: 0,
    guardPaused: true, guardReasons: ['Trailing 24h gross losses 3.63R reached the hard limit.'] });
  assert.match(paused, /8 preliminary \/ 0 confirmed/);
  assert.match(paused, /Paper signals paused: Trailing 24h gross losses 3.63R/);
  const filtered = formatOpeningScanDecision({ preliminary: 8, confirmed: 0, portfolioSelected: 0, guardPaused: false });
  assert.match(filtered, /multi-provider and walk-forward validation/);
  assert.doesNotMatch(filtered, /paused/);
});

test('unavailable scores are frozen rather than dropping unfavorable research decisions', async () => {
  const storage = memoryStorage(), item = fixture(1, 'INSUFFICIENT / UNSUITABLE');
  item.contexts[0].result.score = null;
  const result = await updateInvestmentJournal('fixture', item.contexts, item.benchmark, { storage, file: 'null-score-journal', now: new Date(start + DAY + 3600000) });
  assert.equal(result.snapshots, 3);
  assert.equal(storage.get().observations[0].score, null);
  assert.equal(storage.get().observations[0].decision, 'INSUFFICIENT / UNSUITABLE');
});

test('means use the same separate windows and removed-symbol retries rotate with a bounded budget', async () => {
  const observations = Array.from({ length: 10 }, (_, i) => ({ symbol: 'ETH', horizonSessions: 5,
    resolution: { entryAt: new Date(start + i * DAY).toISOString(), exitAt: new Date(start + (i + 5) * DAY).toISOString(), netReturn: i === 0 ? .01 : i === 5 ? .02 : 10, excessReturn: 0 } }));
  assert.equal(summarizeInvestmentJournal(observations).horizons[0].meanNetReturnPct, 1.5);
  const dropped = ['A', 'B', 'C', 'D'].map((symbol) => ({ symbol, horizonSessions: 5, observedAt: new Date(start).toISOString(), resolution: null }));
  const storage = { readJson: async () => ({ version: 1, observations: dropped }) };
  const first = await pendingInvestmentSymbols('fixture', [], { storage, file: 'rotation', now: new Date(start + 10 * DAY) });
  const second = await pendingInvestmentSymbols('fixture', [], { storage, file: 'rotation', now: new Date(start + 11 * DAY) });
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.notDeepEqual(first.map((row) => row.symbol), second.map((row) => row.symbol));
});

test('unavailable due outcomes flag an incomplete forward cohort rather than disappearing', async () => {
  const storage = memoryStorage(), first = fixture(1);
  await updateInvestmentJournal('fixture', first.contexts, first.benchmark, { storage, file: 'incomplete', now: new Date(start + DAY + 3600000) });
  const later = fixture(10);
  later.contexts[0].history.provider = 'Wrong venue';
  const report = await updateInvestmentJournal('fixture', later.contexts, later.benchmark, { storage, file: 'incomplete', now: new Date(start + 10 * DAY) });
  assert.equal(report.cohortIncomplete, true);
  assert.equal(report.overduePending, 1);
  assert.equal(report.resolved, 0);
});
