import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { runForwardShadowPaper as runShadow, summarizeForwardShadowPerformance } from '../forwardShadowPaper.js';
import { readPaperRiskLedger, PAPER_EXECUTION_VERSION } from '../paperRisk.js';

const start = Date.parse('2026-09-29T15:00:00Z');
const quote = (bid, ask, time) => ({ bid, ask, time: new Date(time).toISOString(), quality: 'executable' });
const withPlan = (profiles) => profiles?.map((profile) => ({ hypothesis: 'Test whether the profile has positive after-cost expectancy.',
  changeMade: 'Apply the declared profile override.', reason: 'Exercise isolated prospective shadow research.', ...profile }));
// Existing lifecycle tests start after a deliberately empty freeze scan. The direct-run test below
// verifies that a newly created manifest never accepts the observations that created it.
async function runForwardShadowPaper(input) {
  const profiles = withPlan(input.profiles);
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  await runShadow({ ...input, profiles, now: now - 1_000, observations: [{ instrument: 'EUR_USD', candidate: false }], observationsByProfile: {},
    quotesByInstrument: new Map(), loadOpenOrderQuotes: undefined });
  return runShadow({ ...input, profiles });
}

test('changing the enabled monitoring cadence freezes a different forward experiment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-monitor-profile-'));
  const prior = process.env.PAPER_MONITOR_INTERVAL_SECONDS;
  const input = { owner: 'forex', strategyVersion: 'monitor-cadence-test-v1',
    profiles: withPlan([{ id: 'monitor', overrides: { breakoutBufferAtr: 0.05 } }]), allowlist: ['breakoutBufferAtr'],
    baseConfig: {}, observations: [{ candidate: false }], evaluate: () => ({ status: 'no-setup', reasons: ['fixture'] }),
    stateDirectory: directory, accountEquity: 100000, riskPolicy: { emergencyStop: false }, sessionOpen: true };
  try {
    process.env.PAPER_MONITOR_INTERVAL_SECONDS = '0';
    const disabled = (await runShadow({ ...input, now: start }))[0];
    process.env.PAPER_MONITOR_INTERVAL_SECONDS = '60';
    const enabled = (await runShadow({ ...input, now: start + 1000 }))[0];
    assert.notEqual(enabled.experimentHash, disabled.experimentHash);
    assert.equal(enabled.manifest.status, 'frozen_new');
    const manifest = JSON.parse(await readFile(enabled.manifest.manifestPath, 'utf8'));
    assert.equal(manifest.positionMonitoring.enabled, true); assert.equal(manifest.positionMonitoring.intervalSeconds, 60);
    assert.equal(enabled.counts.reservations, 0);
  } finally {
    if (prior === undefined) delete process.env.PAPER_MONITOR_INTERVAL_SECONDS;
    else process.env.PAPER_MONITOR_INTERVAL_SECONDS = prior;
    await rm(directory, { recursive: true, force: true });
  }
});

test('forward shadow expectancy interval resamples recent entry sessions and stays unavailable for one session', () => {
  const orders = [
    { status: 'closed', sessionDate: '2026-09-28', closedAt: '2026-09-28T16:00:00Z', riskUsd: 100, realizedPnlUsd: 100 },
    { status: 'closed', sessionDate: '2026-09-29', closedAt: '2026-09-29T16:00:00Z', riskUsd: 100, realizedPnlUsd: -100 },
    { status: 'closed', sessionDate: '2026-09-29', closedAt: '2026-09-29T16:01:00Z', riskUsd: 100, realizedPnlUsd: 100 },
  ].map((order) => ({ ...order, grossPnlUsd: order.realizedPnlUsd, feesUsd: 0, slippageUsd: 0 }));
  const summary = summarizeForwardShadowPerformance({ orders }, { accountEquity: 10_000, sessionDate: '2026-09-29', now: start });
  const interval = summary.recentSessionExpectancyBootstrap;
  assert.equal(interval.trades, 3);
  assert.equal(interval.sessionDays, 2);
  assert.equal(interval.windowSessionDays, 2);
  assert.equal(interval.replicates, 1_000);
  assert.ok(Number.isFinite(interval.lower95R));
  assert.ok(Number.isFinite(interval.upper95R));
  assert.ok(interval.lower95R <= interval.expectancyR && interval.expectancyR <= interval.upper95R);
  assert.match(interval.method, /entire market-session entry-date clusters/);
  assert.match(summary.metricDefinitions.recentSessionExpectancyBootstrap, /not a promotion test/);

  const oneDay = summarizeForwardShadowPerformance({ orders: orders.slice(1) }, { accountEquity: 10_000, sessionDate: '2026-09-29', now: start });
  assert.equal(oneDay.recentSessionExpectancyBootstrap.sessionDays, 1);
  assert.equal(oneDay.recentSessionExpectancyBootstrap.lower95R, null);
  assert.equal(oneDay.recentSessionExpectancyBootstrap.replicates, 0);
});

test('forward shadow reports malformed closes without counting them as breakeven or complete evidence', () => {
  const orders = [
    { status: 'closed', sessionDate: '2026-09-28', closedAt: '2026-09-28T16:00:00Z',
      realizedPnlUsd: 5, grossPnlUsd: 5, feesUsd: 0, slippageUsd: 0,
      riskUsd: 10, fillPrice: 100, units: 1, multiplier: 1,
      maxFavorableExcursionUsd: 8, maxAdverseExcursionUsd: 2, exitReason: 'target' },
    { status: 'closed', sessionDate: '2026-09-29', closedAt: '2026-09-29T16:00:00Z',
      realizedPnlUsd: null, riskUsd: 10, exitReason: 'stop' },
    { status: 'closed', sessionDate: 'unknown', closedAt: '2026-09-30T16:00:00Z',
      realizedPnlUsd: true, riskUsd: 10 },
  ];
  const summary = summarizeForwardShadowPerformance({ orders }, { accountEquity: 10_000, now: start });
  assert.equal(summary.closedRecordCount, 3);
  assert.equal(summary.sampleSize, 1);
  assert.equal(summary.missingRealizedPnlCount, 2);
  assert.equal(summary.target1Hits, 1);
  assert.equal(summary.stopCount, 1);
  assert.equal(summary.target1HitRatePct, 33.33);
  assert.equal(summary.averageNetReturnPct, null);
  assert.equal(summary.netReturnSampleCount, 1);
  assert.equal(summary.averageRealizedR, null);
  assert.equal(summary.realizedRSampleSize, 1);
  assert.equal(summary.worstMaxAdverseExcursionUsd, null);
  assert.equal(summary.bestMaxFavorableExcursionUsd, null);
  assert.equal(summary.adverseExcursionSampleCount, 1);
  assert.equal(summary.recentSessionExpectancyBootstrap.unclassifiedSessionCount, 1);
  assert.equal(summary.recentSessionExpectancyBootstrap.lower95R, null);
  assert.equal(summary.recentSessionExpectancyBootstrap.replicates, 0);
});

test('forward shadow expectancy bootstrap is bounded to the most recent 60 entry sessions', () => {
  const orders = Array.from({ length: 65 }, (_, index) => {
    const sessionDate = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
    const net = index % 2 ? 10 : -10;
    return { status: 'closed', sessionDate, closedAt: `${sessionDate}T16:00:00Z`, riskUsd: 100,
      realizedPnlUsd: net, grossPnlUsd: net, feesUsd: 0, slippageUsd: 0 };
  });
  const summary = summarizeForwardShadowPerformance({ orders }, { accountEquity: 10_000, sessionDate: '2026-03-06', now: start });
  assert.equal(summary.recentSessionExpectancyBootstrap.windowSessionDays, 60);
  assert.equal(summary.recentSessionExpectancyBootstrap.sessionDays, 60);
  assert.equal(summary.recentSessionExpectancyBootstrap.trades, 60);
});

test('forward shadow withholds after-cost expectancy when a close lacks or contradicts cost accounting', () => {
  const base = { status: 'closed', sessionDate: '2026-09-29', closedAt: '2026-09-29T16:00:00Z',
    realizedPnlUsd: 10, grossPnlUsd: 11, feesUsd: 1, slippageUsd: 0,
    riskUsd: 100, fillPrice: 100, units: 1, multiplier: 1 };
  for (const defect of [{ feesUsd: null }, { feesUsd: 2 }]) {
    const summary = summarizeForwardShadowPerformance({ orders: [base, { ...base,
      closedAt: '2026-09-30T16:00:00Z', sessionDate: '2026-09-30', ...defect }] },
    { accountEquity: 10_000, now: start });
    assert.equal(summary.sampleSize, 2, 'both raw net results remain visible as observations');
    assert.equal(summary.reconciledAfterCostCount, 1);
    assert.equal(summary.netPnlUsd, null);
    assert.equal(summary.averageNetReturnPct, null);
    assert.equal(summary.averageRealizedR, null);
    assert.equal(summary.recentSessionExpectancyBootstrap.lower95R, null);
    assert.equal(summary.recentSessionExpectancyBootstrap.replicates, 0);
  }
});

function evaluator(observation, config, now) {
  if (observation.candidate !== true) return { status: 'no-setup', reasons: ['no_profile_candidate'] };
  const q = observation.quote;
  return { status: 'candidate', candidate: {
    mode: 'paper', owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', exposureKey: 'EUR_USD',
    strategyId: 'fx-range-v1', idempotencyKey: 'EUR_USD:2026-09-29:fx-range-v1:long', sessionDate: '2026-09-29', sessionTimeZone: 'America/New_York',
    direction: 'long', bid: q.bid, ask: q.ask, entryPrice: q.ask, stopPrice: q.ask - 0.001,
    targetPrice: q.ask + 0.002, quoteTime: q.time, quoteQuality: q.quality, sessionOpen: true,
    forceExitAt: new Date(start + 4 * 60 * 60_000).toISOString(), multiplier: 1, lotSize: 1,
    roundTripFeesPerUnit: 0.00001, slippageReservePerUnit: 0.00001, signal: { profileThreshold: config.breakoutBufferAtr, asOf: now },
  } };
}

test('new shadow experiments freeze before candidates and reject changed or edited manifests while marking old positions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-manifest-'));
  const profile = withPlan([{ id: 'base', overrides: { breakoutBufferAtr: 0.05 } }]);
  const base = { owner: 'forex', strategyVersion: 'forex-test-v1', profiles: profile,
    allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory: directory,
    accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2, sessionOpen: true,
    riskPolicy: { maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500,
      maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5,
      minRewardRisk: 1.25, emergencyStop: false, liveTradingEnabled: false }, evaluate: evaluator };
  const candidate = (time) => [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, time) }];
  try {
    const waiting = (await runShadow({ ...base, now: start - 2_000, observations: [] }))[0];
    assert.equal(waiting.manifest.status, 'waiting_for_inputs');
    await assert.rejects(readFile(waiting.manifest.manifestPath, 'utf8'), { code: 'ENOENT' });
    const stopped = (await runShadow({ ...base, now: start - 1_000, observations: candidate(start - 1_000),
      riskPolicy: { ...base.riskPolicy, emergencyStop: true } }))[0];
    assert.equal(stopped.manifest.status, 'waiting_for_inputs');
    await assert.rejects(readFile(stopped.manifest.manifestPath, 'utf8'), { code: 'ENOENT' });
    const frozen = (await runShadow({ ...base, now: start, observations: candidate(start) }))[0];
    assert.equal(frozen.manifest.status, 'frozen_new');
    assert.equal(frozen.counts.reservations, 0);
    assert.deepEqual(frozen.decisions[0].reasons, ['forward_window_starts_after_manifest_freeze']);
    const manifest = JSON.parse(await readFile(frozen.manifest.manifestPath, 'utf8'));
    assert.equal(manifest.paperExecutionVersion, PAPER_EXECUTION_VERSION);
    const legacyExperimentHash = createHash('sha256').update(JSON.stringify({ strategyVersion: manifest.strategyVersion,
      baseConfigHash: manifest.baseConfigHash, configHash: manifest.configHash })).digest('hex').slice(0, 16);
    assert.notEqual(frozen.experimentHash, legacyExperimentHash, 'execution revisions must not join the old frozen cohort');
    assert.equal(frozen.paperExecutionVersion, PAPER_EXECUTION_VERSION);
    assert.equal(manifest.hypothesis, profile[0].hypothesis);
    assert.equal(manifest.decision, 'pending_manual_review');
    assert.equal(manifest.forwardWindowDays, 60);
    const active = (await runShadow({ ...base, now: start + 1_000,
      observations: candidate(start + 1_000) }))[0];
    assert.equal(active.manifest.status, 'active');
    assert.equal(active.counts.reservations, 1);
    assert.equal(active.performance.candidateCount, 1, 'the freeze-scan candidate is outside the measured cohort');
    const prefreezeQuote = (await runShadow({ ...base, now: start + 1_500,
      observations: candidate(start) }))[0];
    assert.deepEqual(prefreezeQuote.decisions[0].reasons, ['candidate_outside_frozen_forward_window']);
    assert.equal(prefreezeQuote.performance.candidateCount, 1);
    const alteredPlan = (await runShadow({ ...base, now: start + 2_000,
      profiles: [{ ...profile[0], hypothesis: 'Rewritten after a signal was observed.' }],
      observations: candidate(start + 2_000),
      quotesByInstrument: new Map([['EUR_USD', quote(1.10005, 1.1001, start + 2_000)]]) }))[0];
    assert.equal(alteredPlan.manifest.status, 'mismatch');
    assert.equal(alteredPlan.marksProcessed, 1);
    assert.equal(alteredPlan.counts.reservations, 0);
    assert.deepEqual(alteredPlan.decisions[0].reasons, ['experiment_manifest_mismatch']);
    assert.equal(alteredPlan.performance.sampleSize, 0);
    const editedManifest = { ...manifest, reason: 'Edited directly on disk.' };
    await writeFile(frozen.manifest.manifestPath, JSON.stringify(editedManifest));
    const tampered = (await runShadow({ ...base, now: start + 3_000,
      observations: candidate(start + 3_000) }))[0];
    assert.equal(tampered.manifest.status, 'mismatch');
    assert.equal(tampered.counts.reservations, 0);
    await writeFile(frozen.manifest.manifestPath, 'null');
    const malformed = (await runShadow({ ...base, now: start + 4_000,
      observations: candidate(start + 4_000) }))[0];
    assert.equal(malformed.manifest.status, 'invalid_manifest');
    assert.deepEqual(malformed.decisions[0].reasons, ['experiment_manifest_unreadable_or_invalid']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forward shadow profiles persist isolated paper ledgers and advance later-quote outcomes without alerts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-'));
  const profiles = [
    { id: 'base', overrides: { breakoutBufferAtr: 0.05 } },
    { id: 'sensitive', overrides: { breakoutBufferAtr: 0 } },
  ];
  const base = { owner: 'forex', strategyVersion: 'forex-test-v1', profiles, allowlist: ['breakoutBufferAtr'], baseConfig: {},
    stateDirectory: directory, accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2,
    riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500,
      maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5, minRewardRisk: 1.25,
      emergencyStop: false, liveTradingEnabled: false }, sessionOpen: true };
  try {
    const firstQuote = quote(1.1, 1.1001, start);
    const first = await runForwardShadowPaper({ ...base, now: start,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: firstQuote }],
      evaluate: (observation, config, now) => evaluator(observation, config, now) });
    assert.equal(first.length, 2);
    assert.ok(first.every((track) => track.mode === 'forward_shadow_paper' && track.counts.reservations === 1), JSON.stringify(first.map((track) => ({ counts: track.counts, decisions: track.decisions }))));
    assert.notEqual(first[0].statePath, first[1].statePath);

    const fillTime = start + 1_000;
    const filled = await runForwardShadowPaper({ ...base, now: fillTime, profiles,
      observations: [{ instrument: 'EUR_USD', candidate: false }],
      quotesByInstrument: new Map([['EUR_USD', quote(1.10005, 1.1001, fillTime)]]),
      evaluate: (observation, config, now) => evaluator(observation, config, now) });
    assert.ok(filled.every((track) => track.marksProcessed === 1 && track.performance.openCount === 1));

    const exitTime = start + 2_000;
    let quoteLoads = 0;
    const closed = await runForwardShadowPaper({ ...base, now: exitTime, profiles,
      observations: [{ instrument: 'EUR_USD', candidate: false }],
      quotesByInstrument: new Map(),
      loadOpenOrderQuotes: async (tracks) => {
        quoteLoads++;
        assert.equal(tracks.length, profiles.length);
        return new Map(tracks.map((track) => [track.profileId, new Map([['EUR_USD', quote(1.1022, 1.1023, exitTime)]])]));
      },
      evaluate: (observation, config, now) => evaluator(observation, config, now) });
    assert.equal(quoteLoads, 1);
    assert.ok(closed.every((track) => track.performance.closedCount === 1));
    assert.ok(closed.every((track) => track.performance.netPnlUsd > 0));
    assert.ok(closed.every((track) => track.performance.sampleSize === 1 && track.performance.target1Hits === 1
      && track.performance.stopCount === 0 && track.performance.averageNetReturnPct > 0
      && track.performance.averageRealizedR > 0 && track.performance.worstMaxAdverseExcursionUsd > 0));
    assert.ok(closed.every((track) => track.counts.candidateCount === 0
      && track.performance.scanCandidateCount === 0 && track.performance.candidateCount === 1
      && track.performance.candidatesWithReservation === 1 && track.performance.candidatesFilled === 1
      && track.performance.candidateToReservationRatePct === 100 && track.performance.candidateToFillRatePct === 100
      && track.performance.target1HitRatePct === 100
      && track.performance.stopRatePct === 0 && track.performance.reservationCount === 1
      && track.performance.filledReservationCount === 1 && track.performance.completedEntryAttempts === 1
      && track.performance.reservationFillRatePct === 100 && track.performance.notFilledRatePct === 0
      && track.performance.averageMaxFavorableExcursionUsdQuoteSampledGross === track.performance.averageMaxFavorableExcursionUsd
      && track.performance.averageMaxAdverseExcursionUsdQuoteSampledGross === track.performance.averageMaxAdverseExcursionUsd));
    assert.ok(closed.every((track) => track.performance.target2Hits === null && track.performance.notFilledCount === 0));
    const files = await readdir(directory);
    assert.equal(files.filter((file) => file.endsWith('.json') && !file.endsWith('.experiment.json')).length, 2);
    const log = JSON.parse((await readFile(closed[0].journalPath, 'utf8')).trim().split(/\r?\n/)[0]);
    assert.equal(log.schemaVersion, 1);
    assert.equal(log.decision.profileId, 'base');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a changed strategy version or base config isolates outcome cohorts while old positions remain monitored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-version-'));
  const base = { owner: 'forex', strategyVersion: 'forex-test-v1',
    profiles: [{ id: 'base', overrides: { breakoutBufferAtr: 0.05 } }], allowlist: ['breakoutBufferAtr'],
    baseConfig: {}, stateDirectory: directory, accountEquity: 100_000, maxQuoteAgeMs: 10_000,
    maxSpreadPct: 0.2, sessionOpen: true, riskPolicy: { now: start, maxTradeRiskPct: 0.25,
      maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500, maxInitialMarginPct: 50,
      maxDailyLossPct: 1, maxOpenPositions: 5, minRewardRisk: 1.25, emergencyStop: false,
      liveTradingEnabled: false }, evaluate: evaluator };
  try {
    const first = (await runForwardShadowPaper({ ...base, now: start,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }] }))[0];
    assert.equal(first.counts.reservations, 1);
    const revised = (await runForwardShadowPaper({ ...base, strategyVersion: 'forex-test-v2', now: start + 1_000,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.10005, 1.1001, start + 1_000) }],
      quotesByInstrument: new Map([['EUR_USD', quote(1.10005, 1.1001, start + 1_000)]]) }))[0];
    assert.equal(revised.statePath, first.statePath, 'old cohort remains in the monitored paper ledger');
    assert.notEqual(revised.experimentHash, first.experimentHash);
    assert.equal(revised.marksProcessed, 1, 'the old reservation still receives a fresh quote');
    assert.equal(revised.performance.sampleSize, 0, 'old outcomes cannot enter the new experiment');
    assert.equal(revised.legacyOrOtherExperimentOrders, 1);
    assert.equal(revised.priorExperimentOrderCount, 1);
    assert.equal(revised.priorExperimentRiskBlock, true);
    assert.equal(revised.counts.riskBlocked, 1);
    assert.equal((await readPaperRiskLedger({ statePath: first.statePath })).orders[0].status, 'filled');
    const configChanged = (await runForwardShadowPaper({ ...base, baseConfig: { stopAtr: 1.5 }, now: start + 2_000,
      observations: [{ instrument: 'EUR_USD', candidate: false }],
      quotesByInstrument: new Map([['EUR_USD', quote(1.1022, 1.1023, start + 2_000)]]) }))[0];
    assert.equal(configChanged.statePath, first.statePath);
    assert.notEqual(configChanged.experimentHash, first.experimentHash);
    assert.notEqual(configChanged.experimentHash, revised.experimentHash);
    assert.equal(configChanged.marksProcessed, 1);
    assert.equal(configChanged.performance.sampleSize, 0);
    const original = (await runForwardShadowPaper({ ...base, now: start + 3_000,
      observations: [{ instrument: 'EUR_USD', candidate: false }] }))[0];
    assert.equal(original.performance.sampleSize, 1);
    assert.equal(original.performance.target1Hits, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changed shadow overrides still mark prior ledgers and block same-day replacement entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-override-'));
  const base = { owner: 'forex', strategyVersion: 'forex-test-v1',
    allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory: directory,
    accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2, sessionOpen: true,
    riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1,
      maxGrossExposurePct: 500, maxInitialMarginPct: 50, maxDailyLossPct: 1,
      maxOpenPositions: 5, minRewardRisk: 1.25, emergencyStop: false, liveTradingEnabled: false },
    evaluate: evaluator };
  const originalProfile = [{ id: 'base', overrides: { breakoutBufferAtr: 0.05 } }];
  const revisedProfile = [{ id: 'base', overrides: { breakoutBufferAtr: 0.1 } }];
  try {
    const original = (await runForwardShadowPaper({ ...base, profiles: originalProfile, now: start,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }] }))[0];
    assert.equal(original.counts.reservations, 1);
    const revised = (await runForwardShadowPaper({ ...base, profiles: revisedProfile, now: start + 1_000,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.10005, 1.1001, start + 1_000) }],
      quotesByInstrument: new Map([['EUR_USD', quote(1.10005, 1.1001, start + 1_000)]]) }))[0];
    assert.notEqual(revised.statePath, original.statePath);
    assert.equal(revised.priorExperimentLedgers, 1);
    assert.equal(revised.priorExperimentMarksProcessed, 1);
    assert.equal(revised.priorExperimentRiskBlock, true);
    assert.equal(revised.counts.riskBlocked, 1);
    assert.equal(revised.decisions[0].reasons[0], 'prior_shadow_experiment_open_or_closed_this_risk_day');
    assert.equal((await readPaperRiskLedger({ statePath: original.statePath })).orders[0].status, 'filled');
    assert.equal((await readPaperRiskLedger({ statePath: revised.statePath })).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forward shadow rates disclose pending and terminal unfilled entry denominators', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-entry-rates-'));
  const profile = [{ id: 'rates', overrides: { breakoutBufferAtr: 0.05 } }];
  const base = { owner: 'forex', strategyVersion: 'forex-test-v1', profiles: profile, allowlist: ['breakoutBufferAtr'], baseConfig: {},
    stateDirectory: directory, accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2,
    riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500,
      maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5, minRewardRisk: 1.25,
      emergencyStop: false, liveTradingEnabled: false }, sessionOpen: true };
  try {
    const first = await runForwardShadowPaper({ ...base, now: start,
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }], evaluate: evaluator });
    assert.equal(first[0].counts.candidateCount, 1);
    assert.equal(first[0].performance.pendingReservationCount, 1);
    assert.equal(first[0].performance.reservationFillRatePct, null);
    assert.equal(first[0].performance.notFilledRatePct, null);

    const expired = await runForwardShadowPaper({ ...base, now: start + 5 * 60 * 60_000,
      observations: [{ instrument: 'EUR_USD', candidate: false }], quotesByInstrument: new Map(), evaluate: evaluator });
    assert.equal(expired[0].performance.notFilledCount, 1);
    assert.equal(expired[0].performance.completedEntryAttempts, 1);
    assert.equal(expired[0].performance.reservationFillRatePct, 0);
    assert.equal(expired[0].performance.notFilledRatePct, 100);
    assert.equal(expired[0].performance.pendingReservationCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('market-specific risk gates can veto shadow entries after the shared paper-risk approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-depth-'));
  const profile = [{ id: 'depth-check', overrides: { breakoutBufferAtr: 0.05 } }];
  try {
    const rows = await runForwardShadowPaper({ owner: 'forex', strategyVersion: 'forex-test-v1', profiles: profile, allowlist: ['breakoutBufferAtr'],
      baseConfig: {}, stateDirectory: directory, now: start, accountEquity: 100_000, maxQuoteAgeMs: 10_000,
      maxSpreadPct: 0.2, riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1,
        maxGrossExposurePct: 500, maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5,
        minRewardRisk: 1.25, emergencyStop: false, liveTradingEnabled: false },
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }],
      evaluate: evaluator, riskGate: (approval) => ({ ...approval, status: 'risk-blocked', reasons: ['test_depth_veto'] }) });
    assert.equal(rows[0].counts.riskBlocked, 1);
    assert.equal(rows[0].performance.candidateCount, 1);
    assert.equal(rows[0].performance.candidatesWithReservation, 0);
    assert.equal(rows[0].performance.candidateToReservationRatePct, 0);
    assert.equal(rows[0].performance.candidateToFillRatePct, 0);
    assert.deepEqual(rows[0].decisions[0].reasons, ['test_depth_veto']);
    assert.deepEqual(rows[0].topRejectionReasons, { test_depth_veto: 1 });
    assert.equal(rows[0].performance.openCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('profile-specific observation cohorts support model-advisory research without changing the production cohort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-cohorts-'));
  const profiles = [
    { id: 'production', overrides: { breakoutBufferAtr: 0.05 } },
    { id: 'model-advisory', overrides: { breakoutBufferAtr: 0.05 } },
  ];
  const profileRows = await runForwardShadowPaper({ owner: 'forex', strategyVersion: 'forex-test-v1', profiles, allowlist: ['breakoutBufferAtr'], baseConfig: {},
    stateDirectory: directory, now: start, accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2,
    riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500,
      maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5, minRewardRisk: 1.25,
      emergencyStop: false, liveTradingEnabled: false },
    observations: [{ instrument: 'EUR_USD', candidate: false }],
    observationsByProfile: { 'model-advisory': [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }] },
    evaluate: evaluator });
  try {
    assert.equal(profileRows[0].counts.observations, 1);
    assert.equal(profileRows[0].counts.noSetup, 1);
    assert.equal(profileRows[0].counts.reservations, 0);
    assert.equal(profileRows[0].performance.candidateCount, 0);
    assert.equal(profileRows[1].counts.observations, 1);
    assert.equal(profileRows[1].counts.reservations, 1);
    assert.equal(profileRows[1].performance.candidateCount, 1);
    assert.equal(profileRows[1].performance.candidateToReservationRatePct, 100);
    assert.equal(profileRows[1].performance.candidateToFillRatePct, 0);
    assert.match(profileRows[1].decisions[0].candidateId, /shadow:model-advisory:[a-f0-9]{16}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forward shadows check the shared portfolio while allowing the exact production signal they mirror', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-shared-book-'));
  const profile = [{ id: 'production', overrides: { breakoutBufferAtr: 0.05 } }];
  const paperOrder = (idempotencyKey) => ({ owner: 'forex', assetClass: 'forex', instrumentKey: 'EUR_USD', exposureKey: 'EUR_USD',
    idempotencyKey, strategyId: 'fx-range-v1', sessionDate: '2026-09-29', direction: 'long', status: 'open',
    entryPrice: 1.1001, stopPrice: 1.0991, targetPrice: 1.1021, multiplier: 1, units: 10,
    riskUsd: 10, notionalUsd: 11, marginRequirementUsd: 0, realizedPnlUsd: 0 });
  const run = (portfolioStatePath, stateDirectory = join(directory, 'shadow')) => runForwardShadowPaper({ owner: 'forex', strategyVersion: 'forex-test-v1', profiles: profile,
    allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory, portfolioStatePath,
    now: start, accountEquity: 100_000, maxQuoteAgeMs: 10_000, maxSpreadPct: 0.2,
    riskPolicy: { now: start, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500,
      maxInitialMarginPct: 50, maxDailyLossPct: 1, maxOpenPositions: 5, minRewardRisk: 1.25,
      emergencyStop: false, liveTradingEnabled: false },
    observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start) }], evaluate: evaluator });
  try {
    const portfolioStatePath = join(directory, 'portfolio.json');
    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [paperOrder('EUR_USD:2026-09-29:fx-range-v1:long')] }));
    const mirrored = await run(portfolioStatePath);
    assert.equal(mirrored[0].counts.reservations, 1);

    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [paperOrder('unrelated-open-position')] }));
    const blocked = await run(portfolioStatePath);
    assert.equal(blocked[0].counts.riskBlocked, 1);
    assert.ok(blocked[0].decisions[0].reasons.includes('duplicate_open_exposure'));
    assert.equal(blocked[0].counts.reservations, 0);

    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{ owner: 'stocks', status: 'closed',
      sessionDate: '2026-09-29', closedSessionDate: '2026-09-29', closedAt: new Date(start).toISOString(),
      realizedPnlUsd: -1_001, grossPnlUsd: -1_001, feesUsd: 0, slippageUsd: 0 }] }));
    const lossStopped = await run(portfolioStatePath, join(directory, 'loss-shadow'));
    assert.equal(lossStopped[0].counts.riskBlocked, 1);
    assert.ok(lossStopped[0].decisions[0].reasons.includes('daily_loss_limit'));

    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{ owner: 'stocks', status: 'closed',
      sessionDate: '2026-09-29', closedSessionDate: '2026-09-29', closedAt: new Date(start).toISOString(), realizedPnlUsd: null }] }));
    const unknownPnl = await run(portfolioStatePath, join(directory, 'unknown-pnl-shadow'));
    assert.equal(unknownPnl[0].counts.riskBlocked, 1);
    assert.ok(unknownPnl[0].decisions[0].reasons.includes('invalid_risk_policy_or_daily_pnl'));
    assert.equal(unknownPnl[0].counts.reservations, 0);

    await writeFile(portfolioStatePath, '{invalid json');
    await assert.rejects(run(portfolioStatePath, join(directory, 'unavailable-shadow')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('forward shadows reject unsupported overrides and never accept unsupported bot owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-validate-'));
  try {
    await assert.rejects(runForwardShadowPaper({ owner: 'forex', baseConfig: {}, profiles: [{ id: 'base', overrides: { breakoutBufferAtr: 0.05 } }],
      allowlist: ['breakoutBufferAtr'], observations: [], evaluate: () => ({}), stateDirectory: directory }), /strategyVersion/);
    await assert.rejects(runForwardShadowPaper({ owner: 'forex', strategyVersion: 'forex-test-v1', baseConfig: {}, profiles: [{ id: 'unsafe', overrides: { maxTradeRiskPct: 99 } }],
      allowlist: ['breakoutBufferAtr'], observations: [], evaluate: () => ({}), stateDirectory: directory }), /invalid or disallowed override/);
    await assert.rejects(runForwardShadowPaper({ owner: 'prediction-markets', profiles: [], allowlist: [], observations: [],
      evaluate: () => ({}), stateDirectory: directory }), /not a supported trading bot/);
    const sevenProfiles = Array.from({ length: 7 }, (_, index) => ({ id: `track-${index}`, overrides: { breakoutBufferAtr: index / 100 } }));
    await assert.rejects(runForwardShadowPaper({ owner: 'forex', strategyVersion: 'forex-test-v1', baseConfig: {}, profiles: sevenProfiles, allowlist: ['breakoutBufferAtr'],
      observations: [], evaluate: () => ({ status: 'no-setup' }), stateDirectory: directory }), /at most six profiles/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('independent shadow risk sums actual and experimental losses instead of treating the trade as a mirror', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-independent-risk-'));
  try {
    const portfolioStatePath = join(directory, 'production.json');
    const loss = { owner: 'stocks', status: 'closed', sessionDate: '2026-09-29', closedSessionDate: '2026-09-29',
      closedAt: new Date(start).toISOString(), realizedPnlUsd: -600, grossPnlUsd: -600, feesUsd: 0, slippageUsd: 0 };
    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [loss] }));
    const args = { owner: 'forex', strategyVersion: 'independent-risk-test-v1', profiles: withPlan([{ id: 'independent', overrides: { breakoutBufferAtr: 0.05 } }]),
      allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory: join(directory, 'shadow'), portfolioStatePath,
      now: start, accountEquity: 100000, maxQuoteAgeMs: 10000, maxSpreadPct: 0.2,
      riskPolicy: { emergencyStop: false, maxDailyLossPct: 1, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500, minRewardRisk: 1.25 },
      observations: [{ instrument: 'EUR_USD', candidate: false }], evaluate: evaluator };
    const frozen = await runShadow(args);
    await writeFile(frozen[0].statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{ ...loss, owner: 'forex',
      experimentFingerprint: frozen[0].experimentHash, reservedAt: new Date(start + 1).toISOString() }] }));
    const result = await runShadow({ ...args, now: start + 1000, externalRiskMode: 'independent',
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start + 1000) }] });
    assert.equal(result[0].counts.reservations, 0);
    assert.ok(result[0].decisions[0].reasons.includes('daily_loss_limit'));
    const mirror = await runShadow({ ...args, now: start + 1000, externalRiskMode: 'mirror',
      observations: [{ instrument: 'EUR_USD', candidate: true, quote: quote(1.1, 1.1001, start + 1000) }] });
    assert.equal(mirror[0].counts.reservations, 1, JSON.stringify(mirror[0].decisions));
  } finally {
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit observation clock advances after monitoring and never allows time to move backwards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-observation-clock-'));
  try {
    let time = start;
    const input = { owner: 'forex', strategyVersion: 'clock-test-v1', profiles: withPlan([{ id: 'clock', overrides: { breakoutBufferAtr: 0.05 } }]),
      allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory: directory, now: start, accountEquity: 100000,
      riskPolicy: { emergencyStop: false }, observations: [{ instrument: 'EUR_USD', candidate: false }],
      observationClock: () => time, loadOpenOrderQuotes: async () => { time += 6000; return new Map(); },
      evaluate: (_observation, _config, at) => { assert.equal(at, time); return { status: 'no-setup', reasons: [] }; } };
    await runShadow(input);
    await assert.rejects(runShadow({ ...input, observationClock: () => start - 1 }), /monotonic/);
  } finally {
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('forward shadow allowlists can safely vary explicit boolean strategy gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forward-shadow-bool-'));
  try {
    const reports = await runForwardShadowPaper({ owner: 'options', strategyVersion: 'options-test-v1', baseConfig: {}, profiles: [{ id: 'greeks-required', overrides: { requireCompleteGreeks: true } }],
      allowlist: ['requireCompleteGreeks'], observations: [{ instrumentKey: 'SPY', signal: {}, chain: {} }],
      evaluate: (_observation, config) => config.requireCompleteGreeks ? { status: 'no-setup', reasons: ['greeks_missing'] } : { status: 'candidate' },
      stateDirectory: directory, accountEquity: 10_000, now: Date.now() });
    assert.equal(reports[0].id, 'greeks-required');
    assert.equal(reports[0].counts.noSetup, 1);
    await assert.rejects(runForwardShadowPaper({ owner: 'options', strategyVersion: 'options-test-v1', baseConfig: {}, profiles: [{ id: 'bad-boolean', overrides: { minOpenInterest: true } }],
      allowlist: ['minOpenInterest'], observations: [], evaluate: () => ({}), stateDirectory: directory }), /invalid or disallowed override/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const externalRiskMode of ['mirror', 'independent']) test(`pending ${externalRiskMode} shadow rereads production losses before fill without a shortlist`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-shadow-fill-risk-'));
  try {
    const portfolioStatePath = join(directory, 'production.json');
    await writeFile(portfolioStatePath, JSON.stringify({ schemaVersion: 1, orders: [], events: [] }));
    const args = { owner: 'forex', strategyVersion: 'fill-risk-test-v1', profiles: withPlan([{ id: 'base', overrides: { breakoutBufferAtr: 0.05 } }]),
      allowlist: ['breakoutBufferAtr'], baseConfig: {}, stateDirectory: join(directory, 'shadow'), portfolioStatePath, externalRiskMode,
      now: start, accountEquity: 100000, maxQuoteAgeMs: 10000, maxSpreadPct: 0.2,
      riskPolicy: { emergencyStop: false, maxDailyLossPct: 1, maxTradeRiskPct: 0.25, maxTotalOpenRiskPct: 1, maxGrossExposurePct: 500, minRewardRisk: 1.25 },
      observations: [{ instrument: 'EUR_USD', candidate: false }], evaluate: evaluator };
    await runShadow(args);
    const reserved = await runShadow({ ...args, now: start + 1000, observations: [{ instrument:'EUR_USD', candidate:true, quote:quote(1.1,1.1001,start+1000) }] });
    assert.equal(reserved[0].counts.reservations,1);
    const production = {schemaVersion:1,accountEquityUsd:100000,events:[],orders:[{status:'closed',owner:'stocks',closedAt:new Date(start+1500).toISOString(),
      realizedPnlUsd:-1100,grossPnlUsd:-1090,feesUsd:5,slippageUsd:5}]};
    await writeFile(portfolioStatePath,JSON.stringify(production)); const before=await readFile(portfolioStatePath,'utf8');
    await runShadow({...args,now:start+2000,observations:[],quotesByInstrument:new Map([['EUR_USD',quote(1.1,1.1001,start+2000)]])});
    const ledger=await readPaperRiskLedger({statePath:reserved[0].statePath});
    assert.equal(ledger.orders[0].status,'reserved');
    assert.equal(ledger.orders[0].lastFillRiskCheck.reason,'daily_loss_limit_at_fill');
    assert.equal(await readFile(portfolioStatePath,'utf8'),before);
    await rm(portfolioStatePath);
    await runShadow({...args,now:start+3000,observations:[],quotesByInstrument:new Map([['EUR_USD',quote(1.1,1.1001,start+3000)]])});
    assert.equal((await readPaperRiskLedger({statePath:reserved[0].statePath})).orders[0].lastFillRiskCheck.reason,'external_portfolio_risk_unavailable_at_fill');
  } finally { const rel=relative(tmpdir(),directory);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(directory,{recursive:true,force:true}); }
});
