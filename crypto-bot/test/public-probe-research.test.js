import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crypto-public-probe-research-'));
process.env.OMNIMOD_CRYPTO_DATA_DIR = directory;
process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR = '1';
const { makePublicProbeObservation, capturePublicProbeObservations,
  fetchBinanceDeadlineSeconds, fetchBinanceEntrySeconds,
  resolvePublicProbeObservations,
  summarizePublicProbeObservations } =
  await import('../scripts/public-probe-research.mjs');
const { inspectSourcePinnedDeadlineSeconds, inspectSourcePinnedEntrySeconds,
  loadLabeledObservations, resolveObservation,
  materializeObservations, readResearchEvents } =
  await import('../src/researchStore.js');

after(async () => {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(directory, { recursive: true, force: true });
});

const settings = { minProviderConfirmations: 2, minRiskReward: 1.7, estimatedRoundTripBps: 20 };
function asset(observedAt, overrides = {}) {
  return {
    id: 'example-coin', symbol: 'EX', name: 'Example', rank: 30, price: 100,
    marketCap: 1_000_000_000, volume24h: 120_000_000, high24h: 102, low24h: 94,
    athChangePercent: -25, change1h: 1.5, change24h: 7, change7d: 14,
    volumeToMarketCap: 0.12,
    marketData: {
      candleProvider: 'Binance', candlePair: 'EXUSDT', providerCount: 2,
      technicals: { dataSufficient: true, atrPct: 1.2, ema9: 101, ema21: 100, ema50: 98,
        technicalScore: 75 },
      quotes: [{ provider: 'Binance', pair: 'EXUSDT', observedAt, timestampBasis: 'provider_event',
        price: 100.05, bid: 100, ask: 100.1 }],
      execution: { blockTrade: false, estimatedRoundTripBps: 24 },
      regime: { score: 60, allowNewLongs: true },
    },
    ...overrides,
  };
}

test('public research capture requires a fresh quote matching its pinned candle source and cannot train a model', async () => {
  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 6 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000);
  const candidate = asset(new Date(first + 4 * 60_000 + 45_000).toISOString());
  assert.equal(makePublicProbeObservation(asset(new Date(first - 60_000).toISOString()), settings, createdAt), null);
  assert.equal(makePublicProbeObservation(asset(candidate.marketData.quotes[0].observedAt, {
    marketData: { ...candidate.marketData, candlePair: 'DIFFERENTUSDT' },
  }), settings, createdAt), null);
  assert.equal(makePublicProbeObservation(asset(candidate.marketData.quotes[0].observedAt, {
    marketData: { ...candidate.marketData, quotes: [{ ...candidate.marketData.quotes[0], timestampBasis: 'response_received' }] },
  }), settings, createdAt), null);

  const observation = makePublicProbeObservation(candidate, settings, createdAt, ['strategy_validation']);
  assert.equal(observation.entryPrice, 100.1);
  assert.equal(observation.candlePair, observation.quotePair);
  assert.equal(observation.trainingEligible, false);
  assert.equal(observation.features, null);
  assert.ok(observation.estimatedCostPct >= 0.2);
  const captured = await capturePublicProbeObservations([candidate], settings, createdAt,
    [{ assetId: candidate.id, code: 'strategy_validation' }]);
  assert.equal(captured.recorded, 1);
  assert.equal((await capturePublicProbeObservations([candidate], settings, createdAt)).recorded, 0);
  const before = await summarizePublicProbeObservations(createdAt);
  assert.equal(before.created, 1);
  assert.equal(before.pending, 1);
  assert.equal(before.due, 0);
  assert.equal(before.dueNeedsFinerData, 0);
  assert.equal(before.dueRetryableWithCurrentBars, 0);
  assert.equal(before.nextPendingDeadlineAt, observation.deadlineAt);
  assert.equal(before.nextFutureDeadlineAt, observation.deadlineAt);
  assert.equal(before.creationDayCoverage.distinctUtcDays, 1);
  assert.deepEqual(before.creationDayCoverage.byUtcDay[createdAt.toISOString().slice(0, 10)],
    { created: 1, resolved: 0, pending: 1 });
  assert.deepEqual(before.byRejectionCode.strategy_validation,
    { created: 1, pending: 1, due: 0, resolved: 0, exactResolved: 0, approximateDeadlineResolved: 0 });

  const bars = Array.from({ length: 24 }, (_, index) => ({ time: first + index * barMs,
    open: 100.1, high: 101, low: 99.5, close: 100.2, volume: 100 }));
  const followAt = new Date(Date.parse(observation.deadlineAt) + barMs);
  const wrongPair = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => ({
    provider: 'Binance', pair: 'OTHERUSDT', candles: bars,
  }) });
  assert.equal(wrongPair.sourcesUnavailable, 1);
  assert.equal(wrongPair.newlyResolved, 0);
  assert.equal(wrongPair.unresolvedDue, 1);
  assert.deepEqual(wrongPair.unresolvedByReason, { provider_pair_mismatch: 1 });
  const failedFetch = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => {
    throw new Error('simulated provider failure');
  } });
  assert.deepEqual(failedFetch.unresolvedByReason, { history_fetch_failed: 1 });
  const shortHistory = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => ({
    provider: 'Binance', pair: 'EXUSDT', candles: bars.slice(0, 1),
  }) });
  assert.deepEqual(shortHistory.unresolvedByReason, { candle_path_or_deadline_unavailable: 1 });
  const result = await resolvePublicProbeObservations(followAt, { fetchCandles: async (_row, options) => {
    assert.deepEqual(options.providers, ['Binance']);
    return { provider: 'Binance', pair: 'EXUSDT', candles: bars };
  } });
  assert.equal(result.due, 1);
  assert.equal(result.newlyResolved, 1);
  assert.equal(result.unresolvedDue, 0);
  assert.deepEqual(result.unresolvedByReason, {});
  const afterStatus = await summarizePublicProbeObservations(followAt);
  assert.equal(afterStatus.pending, 0);
  assert.equal(afterStatus.resolved, 1);
  assert.deepEqual(afterStatus.resolvedByOutcome, { approximate_deadline_audit: 1 });
  assert.equal(afterStatus.exactBarrierOrDeadlineResolved, 0);
  assert.equal(afterStatus.approximateDeadlineResolved, 1);
  assert.equal(afterStatus.creationDayCoverage.resolvedEntryUtcDays, 1);
  assert.deepEqual(afterStatus.creationDayCoverage.byUtcDay[createdAt.toISOString().slice(0, 10)],
    { created: 1, resolved: 1, pending: 0 });
  assert.deepEqual(afterStatus.byRejectionCode.strategy_validation,
    { created: 1, pending: 0, due: 0, resolved: 1, exactResolved: 0, approximateDeadlineResolved: 1 });
  const rows = materializeObservations(await readResearchEvents());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resolution.candleProvider, 'Binance');
  assert.equal(rows[0].resolution.candlePair, 'EXUSDT');
  assert.equal((await loadLabeledObservations()).length, 0);
});

test('a due observation with an ambiguous entry-containing candle stays unresolved without repeat history calls', async () => {
  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 10 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000);
  const candidate = asset(new Date(createdAt.getTime() - 10_000).toISOString());
  candidate.id = 'ambiguous-coin';
  candidate.symbol = 'AMB';
  candidate.marketData.candlePair = 'AMBUSDT';
  candidate.marketData.quotes[0].pair = 'AMBUSDT';
  const observation = makePublicProbeObservation(candidate, settings, createdAt, ['strategy_validation']);
  assert.ok(observation);
  const captured = await capturePublicProbeObservations([candidate], settings, createdAt,
    [{ assetId: candidate.id, code: 'strategy_validation' }]);
  assert.equal(captured.recorded, 1);
  const bars = Array.from({ length: 8 }, (_, index) => ({ time: first + index * barMs,
    open: observation.entryPrice, high: observation.entryPrice * 1.002,
    low: index === 0 ? observation.stopPrice * 0.99 : observation.entryPrice * 0.999,
    close: observation.entryPrice, volume: 100 }));
  const followAt = new Date(Date.parse(observation.deadlineAt) + barMs);
  const firstAttempt = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => ({
    provider: 'Binance', pair: 'AMBUSDT', candles: bars
  }) });
  assert.equal(firstAttempt.sourcesFetched, 1);
  assert.equal(firstAttempt.newlyResolved, 0);
  assert.deepEqual(firstAttempt.unresolvedByReason, { entry_containing_candle_ambiguous: 1 });
  const secondAttempt = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => {
    throw new Error('known ambiguous source must not be fetched again');
  } });
  assert.equal(secondAttempt.sourcesSelected, 0);
  assert.equal(secondAttempt.ambiguousEntryRowsSkipped, 1);
  assert.deepEqual(secondAttempt.unresolvedByReason, { entry_containing_candle_ambiguous: 1 });
  const status = await summarizePublicProbeObservations(followAt);
  assert.equal(status.dueNeedsFinerData, 1);
  assert.equal(status.dueRetryableWithCurrentBars, 0);
  assert.equal(status.nextFutureDeadlineAt, null);
  assert.equal((await loadLabeledObservations()).length, 0);
  await fs.rm(path.join(directory, 'research'), { recursive: true, force: true });
});

test('finer entry evidence requires a complete same-pair second path without barrier ambiguity', () => {
  const createdMs = Date.parse('2026-09-01T00:05:00.500Z');
  const row = { version: 3, createdAt: new Date(createdMs).toISOString(),
    deadlineAt: '2026-09-01T01:00:00Z', candleProvider: 'Binance', candlePair: 'EXUSDT',
    entryPrice: 100, stopPrice: 99, partialTargetPrice: 101 };
  const seconds = Array.from({ length: 600 }, (_, index) => ({
    time: Math.floor(createdMs / 1000) * 1000 + index * 1000,
    open: 100, high: 100.1, low: 99.9, close: 100,
    provider: 'Binance', pair: 'EXUSDT',
  }));
  const now = new Date('2026-09-01T01:01:00Z');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds, now).status, 'clear');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.slice(1), now).status,
    'incomplete_entry_seconds');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.map((bar, index) => index === 250
    ? { ...bar, pair: 'OTHERUSDT' } : bar), now).status, 'invalid_entry_seconds');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.map((bar, index) => index === 250
    ? { ...bar, low: null } : bar), now).status, 'invalid_entry_seconds');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.map((bar, index) => index === 0
    ? { ...bar, low: 98.9 } : bar), now).status, 'entry_second_ambiguous');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.map((bar, index) => index === 250
    ? { ...bar, low: 98.9 } : bar), now).status, 'post_entry_barrier_in_finer_data');
  assert.equal(inspectSourcePinnedEntrySeconds(row, seconds.map((bar, index) => index === 0
    ? { ...bar, low: 98.9 } : index === 599 ? { ...bar, pair: 'OTHERUSDT' } : bar),
  now).status, 'invalid_entry_seconds', 'an early barrier cannot mask later invalid provenance');
});

test('bounded Binance 1-second fetch uses the exact pinned pair and partial-bar window', async () => {
  const row = { symbol: 'EX', candleProvider: 'Binance', candlePair: 'EXUSDT',
    createdAt: '2026-09-01T00:05:00.500Z' };
  let requestedUrl;
  const bars = await fetchBinanceEntrySeconds(row, { request: async (url) => {
    requestedUrl = new URL(url);
    return { ok: true, json: async () => [[Date.parse('2026-09-01T00:05:00Z'),
      '100', '100.1', '99.9', '100']] };
  } });
  assert.equal(requestedUrl.hostname, 'data-api.binance.vision');
  assert.equal(requestedUrl.searchParams.get('symbol'), 'EXUSDT');
  assert.equal(requestedUrl.searchParams.get('interval'), '1s');
  assert.equal(requestedUrl.searchParams.get('limit'), '600');
  assert.equal(bars[0].provider, 'Binance');
  assert.equal(bars[0].pair, 'EXUSDT');
  await assert.rejects(fetchBinanceEntrySeconds({ ...row, candlePair: 'WRONGUSDT' },
    { request: async () => { throw new Error('unexpected request'); } }));
});

test('cached finer clearance permits a later exact-source stop without model training', async () => {
  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 10 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000);
  const candidate = asset(new Date(createdAt.getTime() - 10_000).toISOString());
  candidate.id = 'finer-coin';
  candidate.symbol = 'FIN';
  candidate.marketData.candlePair = 'FINUSDT';
  candidate.marketData.quotes[0].pair = 'FINUSDT';
  const observation = makePublicProbeObservation(candidate, settings, createdAt, ['strategy_validation']);
  assert.ok(observation);
  assert.equal((await capturePublicProbeObservations([candidate], settings, createdAt)).recorded, 1);
  const bars = Array.from({ length: 8 }, (_, index) => ({ time: first + index * barMs,
    open: observation.entryPrice, high: observation.entryPrice * 1.002,
    low: index === 0 || index === 1 ? observation.stopPrice * 0.99 : observation.entryPrice * 0.999,
    close: observation.entryPrice, volume: 100 }));
  const followAt = new Date(Date.parse(observation.deadlineAt) + barMs);
  const initial = await resolvePublicProbeObservations(followAt, { fetchCandles: async () => ({
    provider: 'Binance', pair: 'FINUSDT', candles: bars.slice(0, 1),
  }) });
  assert.equal(initial.newlyResolved, 0);
  assert.deepEqual(initial.unresolvedByReason, { entry_containing_candle_ambiguous: 1 });
  const seconds = Array.from({ length: 600 }, (_, index) => ({
    time: first + 5 * 60_000 + index * 1000,
    open: observation.entryPrice, high: observation.entryPrice,
    low: observation.entryPrice, close: observation.entryPrice,
    provider: 'Binance', pair: 'FINUSDT',
  }));
  let finerRequests = 0;
  const firstFiner = await resolvePublicProbeObservations(followAt, {
    finerEntry: true,
    fetchEntrySeconds: async () => { finerRequests += 1; return seconds; },
    fetchCandles: async () => { throw new Error('temporary 15-minute history failure'); },
  });
  assert.equal(finerRequests, 1);
  assert.equal(firstFiner.finerEntryRowsCleared, 1);
  assert.equal(firstFiner.newlyResolved, 0);
  const cachedStatus = await summarizePublicProbeObservations(followAt);
  assert.equal(cachedStatus.dueNeedsFinerData, 0);
  assert.equal(cachedStatus.dueWithCachedFinerClearance, 1);
  const resolved = await resolvePublicProbeObservations(followAt, {
    fetchEntrySeconds: async () => { throw new Error('cached evidence must avoid a new finer fetch'); },
    fetchCandles: async () => ({ provider: 'Binance', pair: 'FINUSDT', candles: bars }),
  });
  assert.equal(resolved.finerEntryRequests, 0);
  assert.equal(resolved.newlyResolved, 1);
  const rows = materializeObservations(await readResearchEvents());
  const result = rows.find((row) => row.observationId === observation.observationId)?.resolution;
  assert.equal(result?.reason, 'candle_stop_first');
  assert.equal(result?.priceBasis, 'completed_source_candles_with_second_entry_clearance');
  assert.equal(result?.entrySegmentEvidence?.barCount, 600);
  assert.equal((await loadLabeledObservations()).length, 0);
});

test('deadline seconds require a complete pinned path and preserve the subsecond evidence limit', () => {
  const row = { version: 3, createdAt: '2026-09-01T00:00:00Z',
    deadlineAt: '2026-09-01T00:25:59.543Z', candleProvider: 'Binance', candlePair: 'EXUSDT',
    entryPrice: 100, stopPrice: 99, partialTargetPrice: 101, targetPrice: 102,
    estimatedCostPct: 0.2 };
  const start = Date.parse('2026-09-01T00:15:00Z');
  const seconds = Array.from({ length: 659 }, (_, index) => ({
    time: start + index * 1000, open: 100, high: 100.1, low: 99.9, close: 100,
    provider: 'Binance', pair: 'EXUSDT',
  }));
  const now = new Date('2026-09-01T00:26:00Z');
  const assessment = inspectSourcePinnedDeadlineSeconds(row, seconds, now);
  assert.equal(assessment.status, 'complete');
  assert.equal(assessment.barCount, 659);
  assert.equal(assessment.unobservedTailMs, 543);
  assert.equal(inspectSourcePinnedDeadlineSeconds(row, seconds.slice(1), now).status,
    'incomplete_deadline_seconds');
  assert.equal(inspectSourcePinnedDeadlineSeconds(row, seconds.map((bar, index) => index === 400
    ? { ...bar, pair: 'OTHERUSDT' } : bar), now).status, 'invalid_deadline_seconds');
  assert.equal(inspectSourcePinnedDeadlineSeconds(row, seconds.map((bar, index) => index === 400
    ? { ...bar, close: null } : bar), now).status, 'invalid_deadline_seconds');
  const firstBar = { time: Date.parse(row.createdAt), open: 100, high: 100.5,
    low: 99.5, close: 100, volume: 100, provider: 'Binance', pair: 'EXUSDT' };
  const deadline = resolveObservation(row, [firstBar], null, now,
    { deadlineSecondCandles: seconds, requireDeadlineSecondEvidence: true });
  assert.equal(deadline.reason, 'deadline_last_completed_second');
  assert.equal(deadline.priceBasis, 'completed_source_candles_with_second_deadline_audit');
  assert.equal(deadline.deadlineSegmentEvidence.unobservedTailMs, 543);
  assert.equal(resolveObservation(row, [firstBar], null, now,
    { deadlineSecondCandles: seconds.slice(1), requireDeadlineSecondEvidence: true }), null);
  const stopSeconds = seconds.map((bar, index) => index === 300
    ? { ...bar, low: 98.9 } : bar);
  assert.equal(resolveObservation(row, [firstBar], null, now,
    { deadlineSecondCandles: stopSeconds, requireDeadlineSecondEvidence: true }).reason,
  'second_stop_first');
});

test('bounded Binance deadline request and isolated probe produce only audit labels', async () => {
  const row = { symbol: 'EX', candleProvider: 'Binance', candlePair: 'EXUSDT',
    deadlineAt: '2026-09-01T00:25:59.543Z' };
  let url;
  await fetchBinanceDeadlineSeconds(row, { request: async (requested) => {
    url = new URL(requested);
    return { ok: true, json: async () => [] };
  } });
  assert.equal(url.searchParams.get('interval'), '1s');
  assert.equal(url.searchParams.get('limit'), '659');
  assert.equal(url.searchParams.get('startTime'), String(Date.parse('2026-09-01T00:15:00Z')));
  await assert.rejects(fetchBinanceDeadlineSeconds({ ...row, candlePair: 'WRONGUSDT' },
    { request: async () => { throw new Error('unexpected request'); } }));

  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 10 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000 + 543);
  const candidate = asset(new Date(createdAt.getTime() - 10_000).toISOString());
  candidate.id = 'deadline-coin';
  candidate.symbol = 'DDL';
  candidate.marketData.candlePair = 'DDLUSDT';
  candidate.marketData.quotes[0].pair = 'DDLUSDT';
  const observation = makePublicProbeObservation(candidate, settings, createdAt);
  assert.ok(observation);
  assert.equal((await capturePublicProbeObservations([candidate], settings, createdAt)).recorded, 1);
  const deadlineMs = Date.parse(observation.deadlineAt);
  const bars = Array.from({ length: Math.ceil((deadlineMs - first) / barMs) + 1 }, (_, index) => ({
    time: first + index * barMs, open: observation.entryPrice,
    high: observation.entryPrice, low: observation.entryPrice,
    close: observation.entryPrice, volume: 100,
  }));
  const segmentStart = Math.floor(deadlineMs / barMs) * barMs;
  const secondCount = (Math.floor(deadlineMs / 1000) * 1000 - segmentStart) / 1000;
  const seconds = Array.from({ length: secondCount }, (_, index) => ({
    time: segmentStart + index * 1000, open: observation.entryPrice,
    high: observation.entryPrice, low: observation.entryPrice,
    close: observation.entryPrice, provider: 'Binance', pair: 'DDLUSDT',
  }));
  const followAt = new Date(deadlineMs + barMs);
  const result = await resolvePublicProbeObservations(followAt, {
    finerEntry: true,
    fetchCandles: async () => ({ provider: 'Binance', pair: 'DDLUSDT', candles: bars }),
    fetchDeadlineSeconds: async () => seconds,
    fetchEntrySeconds: async () => { throw new Error('clean entry must not need finer entry data'); },
  });
  assert.equal(result.finerDeadlineRequests, 1);
  assert.equal(result.finerDeadlineRowsCovered, 1);
  assert.equal(result.newlyResolved, 1);
  const rows = materializeObservations(await readResearchEvents());
  const resolution = rows.find((item) => item.observationId === observation.observationId)?.resolution;
  assert.equal(resolution?.reason, 'deadline_last_completed_second');
  assert.equal(resolution?.priceBasis, 'completed_source_candles_with_second_deadline_audit');
  const status = await summarizePublicProbeObservations(followAt);
  assert.equal(status.coarseDeadlineResolved, 0);
  assert.equal(status.subsecondDeadlineResolved, 1);
  assert.equal((await loadLabeledObservations()).length, 0);
});

test('finer deadline requests share a two-call cap and leave excess rows unresolved', async () => {
  const barMs = 15 * 60_000;
  const first = Math.floor((Date.now() - 9 * 60 * 60_000) / barMs) * barMs;
  const createdAt = new Date(first + 5 * 60_000 + 543);
  const candidates = ['CAPA', 'CAPB', 'CAPC'].map((symbol) => {
    const row = asset(new Date(createdAt.getTime() - 10_000).toISOString());
    row.id = `deadline-${symbol.toLowerCase()}`;
    row.symbol = symbol;
    row.marketData.candlePair = `${symbol}USDT`;
    row.marketData.quotes[0].pair = `${symbol}USDT`;
    return row;
  });
  assert.equal((await capturePublicProbeObservations(candidates, settings, createdAt)).recorded, 3);
  const frozen = makePublicProbeObservation(candidates[0], settings, createdAt);
  const bySymbol = new Map(candidates.map((candidate) => [candidate.symbol,
    makePublicProbeObservation(candidate, settings, createdAt)]));
  const deadlineMs = Date.parse(frozen.deadlineAt);
  const segmentStart = Math.floor(deadlineMs / barMs) * barMs;
  const secondCount = (Math.floor(deadlineMs / 1000) * 1000 - segmentStart) / 1000;
  let requests = 0;
  const result = await resolvePublicProbeObservations(new Date(deadlineMs + barMs), {
    finerEntry: true,
    fetchCandles: async (row) => ({ provider: 'Binance', pair: `${row.symbol}USDT`,
      candles: Array.from({ length: Math.ceil((deadlineMs - first) / barMs) + 1 }, (_, index) => ({
        time: first + index * barMs, open: bySymbol.get(row.symbol).entryPrice,
        high: bySymbol.get(row.symbol).entryPrice,
        low: bySymbol.get(row.symbol).entryPrice,
        close: bySymbol.get(row.symbol).entryPrice, volume: 100,
      })) }),
    fetchDeadlineSeconds: async (row) => {
      requests += 1;
      return Array.from({ length: secondCount }, (_, index) => ({
        time: segmentStart + index * 1000, open: row.entryPrice,
        high: row.entryPrice, low: row.entryPrice, close: row.entryPrice,
        provider: 'Binance', pair: row.candlePair,
      }));
    },
  });
  assert.equal(requests, 2, JSON.stringify(result));
  assert.equal(result.finerDeadlineRequests, 2);
  assert.equal(result.newlyResolved, 2);
  assert.equal(result.unresolvedDue, 1);
  assert.equal(result.unresolvedByReason.finer_source_cap, 1);
});
