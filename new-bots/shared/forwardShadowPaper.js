import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { evaluatePaperCandidate, processPaperQuote, readPaperRiskLedger, recoverPaperOrders, reservePaperCandidate, summarizePaperLedger, PAPER_EXECUTION_VERSION } from './paperRisk.js';
import { bootstrapSessionExpectancy } from './dayClusterBootstrap.js';
import { inspectClosedPaperAccounting } from './postTradeReview.js';
import { hasExplicitFiniteAmount, hasExplicitPositiveFiniteAmount } from './strategyConfig.js';
import { paperMonitorProfile } from './paperMonitorConfig.js';
import { paperQuoteLookupKey } from './cryptoExecutionIdentity.js';

const OWNERS = new Set(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);
const FORWARD_WINDOW_DAYS = 60;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) return { unavailableNumber: String(value) };
  if (value === undefined) return { unavailableValue: 'undefined' };
  return value;
}

function validateProfiles(profiles, allowlist, baseConfig, strategyVersion, owner, monitoringEnv) {
  if (!Array.isArray(profiles) || profiles.length > 6) throw new TypeError('Forward shadow tracking supports at most six profiles per bot.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(strategyVersion || '')) throw new TypeError('Forward shadow strategyVersion must be an explicit safe version label.');
  if (!baseConfig || typeof baseConfig !== 'object' || Array.isArray(baseConfig)) throw new TypeError('Forward shadow baseConfig must be an explicit object.');
  const baseConfigHash = createHash('sha256').update(JSON.stringify(stable(baseConfig))).digest('hex').slice(0, 16);
  const ids = new Set();
  return profiles.map((profile) => {
    const id = String(profile?.id ?? '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(id) || ids.has(id)) throw new TypeError('Forward shadow profile IDs must be unique safe labels.');
    ids.add(id);
    const overrides = profile?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || !Object.keys(overrides).length) throw new TypeError(`Shadow profile ${id} needs non-empty overrides.`);
    for (const [key, value] of Object.entries(overrides)) {
      const validBoolean = ['requireCompleteGreeks', 'stopAtOpeningRangeMidpoint'].includes(key) && typeof value === 'boolean';
      const validNumber = typeof value === 'number' && Number.isFinite(value) && value >= 0;
      if (!allowlist.includes(key) || (!validBoolean && !validNumber)) throw new TypeError(`Shadow profile ${id} has an invalid or disallowed override: ${key}.`);
    }
    const narrative = {};
    for (const key of ['hypothesis', 'changeMade', 'reason']) {
      const value = profile?.[key];
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 400) {
        throw new TypeError(`Shadow profile ${id} requires a non-empty ${key} of at most 400 characters.`);
      }
      narrative[key] = value.trim();
    }
    const configHash = createHash('sha256').update(JSON.stringify(stable(overrides))).digest('hex').slice(0, 16);
    const paperExecutionVersion = PAPER_EXECUTION_VERSION;
    const positionMonitoring = paperMonitorProfile(monitoringEnv, owner);
    const experimentHash = createHash('sha256').update(JSON.stringify({ strategyVersion, baseConfigHash, configHash, paperExecutionVersion, positionMonitoring })).digest('hex').slice(0, 16);
    return { id, overrides: stable(overrides), configHash, baseConfigHash, experimentHash, strategyVersion, paperExecutionVersion, positionMonitoring, ...narrative };
  });
}

function manifestDigest(manifest) {
  const { digest, ...contents } = manifest;
  return createHash('sha256').update(JSON.stringify(stable(contents))).digest('hex');
}

async function ensureExperimentManifest({ owner, track, stateDirectory, now, ledger, canFreeze }) {
  const manifestPath = resolve(stateDirectory, `${owner}-${track.id}-${track.experimentHash}.experiment.json`);
  const definition = { schemaVersion: 1, owner, profileId: track.id, strategyVersion: track.strategyVersion,
    paperExecutionVersion: track.paperExecutionVersion,
    positionMonitoring: track.positionMonitoring,
    experimentHash: track.experimentHash, baseConfigHash: track.baseConfigHash, configHash: track.configHash,
    overrides: track.overrides, hypothesis: track.hypothesis, changeMade: track.changeMade, reason: track.reason,
    forwardWindowDays: FORWARD_WINDOW_DAYS,
    historicalResult: 'unavailable; no point-in-time holdout supplied',
    walkForwardResult: 'unavailable; no point-in-time holdout supplied',
    decision: 'pending_manual_review' };
  let manifest;
  let created = false;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') return { status: 'invalid_manifest', reason: 'experiment_manifest_unreadable_or_invalid', manifestPath };
    if (ledger.orders.some((order) => order.experimentFingerprint === track.experimentHash)) {
      return { status: 'legacy_cohort', reason: 'existing_shadow_cohort_requires_new_strategy_version', manifestPath };
    }
    if (!canFreeze) return { status: 'waiting_for_inputs', reason: 'forward_experiment_waiting_for_paper_readiness_and_observations', manifestPath };
    const frozenAt = new Date(now).toISOString();
    manifest = { ...definition, frozenAt,
      forwardWindowEndAt: new Date(now + FORWARD_WINDOW_DAYS * 86_400_000).toISOString() };
    manifest.digest = manifestDigest(manifest);
    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      created = true;
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
      catch { return { status: 'invalid_manifest', reason: 'experiment_manifest_unreadable_or_invalid', manifestPath }; }
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'invalid_manifest', reason: 'experiment_manifest_unreadable_or_invalid', manifestPath };
  }
  const frozen = Date.parse(manifest?.frozenAt ?? '');
  const end = Date.parse(manifest?.forwardWindowEndAt ?? '');
  const actualDefinition = Object.fromEntries(Object.keys(definition).map((key) => [key, manifest?.[key]]));
  if (JSON.stringify(stable(actualDefinition)) !== JSON.stringify(stable(definition))
    || manifest?.digest !== manifestDigest(manifest)
    || !Number.isFinite(frozen) || !Number.isFinite(end) || end - frozen !== FORWARD_WINDOW_DAYS * 86_400_000) {
    return { status: 'mismatch', reason: 'experiment_manifest_mismatch', manifestPath };
  }
  const status = created || now <= frozen ? 'frozen_new' : now > end ? 'expired' : 'active';
  const reason = status === 'frozen_new' ? 'forward_window_starts_after_manifest_freeze'
    : status === 'expired' ? 'forward_validation_window_expired' : null;
  return { status, reason, manifestPath, frozenAt: manifest.frozenAt,
    forwardWindowEndAt: manifest.forwardWindowEndAt, hypothesis: track.hypothesis,
    changeMade: track.changeMade, decision: manifest.decision };
}

export function summarizeForwardShadowPerformance(ledger, { accountEquity, sessionDate, now } = {}) {
  const summary = summarizePaperLedger(ledger, { accountEquity, sessionDate, now });
  const orders = Array.isArray(ledger?.orders) ? ledger.orders : [];
  const allClosed = orders.filter((order) => order.status === 'closed');
  const closed = allClosed.filter((order) => hasExplicitFiniteAmount(order.realizedPnlUsd));
  const reconciled = allClosed.filter((order) => inspectClosedPaperAccounting(order).status === 'reconciled');
  const missingCostBreakdownCount = allClosed.filter((order) => inspectClosedPaperAccounting(order).status === 'missing_breakdown').length;
  const pnlAccountingMismatchCount = allClosed.filter((order) => inspectClosedPaperAccounting(order).status === 'mismatch').length;
  const filledOrders = orders.filter((order) => Boolean(order.filledAt));
  const unfilledCancellations = orders.filter((order) => order.status === 'cancelled' && !order.filledAt);
  const completedEntryAttempts = filledOrders.length + unfilledCancellations.length;
  const returnedPct = reconciled.map((order) => {
    const denominator = hasExplicitPositiveFiniteAmount(order.fillPrice)
      && hasExplicitPositiveFiniteAmount(order.units) && hasExplicitPositiveFiniteAmount(order.multiplier ?? 1)
      ? Number(order.fillPrice) * Number(order.units) * Number(order.multiplier ?? 1) : NaN;
    return denominator > 0 ? Number(order.realizedPnlUsd) / denominator * 100 : null;
  }).filter(Number.isFinite);
  const realizedR = reconciled.map((order) => hasExplicitPositiveFiniteAmount(order.riskUsd)
    ? Number(order.realizedPnlUsd) / Number(order.riskUsd) : null).filter(Number.isFinite);
  const favorableExcursions = allClosed.map((order) => order.maxFavorableExcursionUsd)
    .filter((value) => hasExplicitFiniteAmount(value) && Number(value) >= 0).map(Number);
  const adverseExcursions = allClosed.map((order) => order.maxAdverseExcursionUsd)
    .filter((value) => hasExplicitFiniteAmount(value) && Number(value) >= 0).map(Number);
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;
  const rate = (numerator, denominator) => denominator ? Number((numerator / denominator * 100).toFixed(2)) : null;
  const target1Hits = allClosed.filter((order) => order.exitReason === 'target').length;
  const stopCount = allClosed.filter((order) => order.exitReason === 'stop').length;
  const validSessionDate = (value) => {
    const date = String(value ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
  };
  const recentSessionDates = [...new Set(allClosed.map((order) => String(order.sessionDate ?? '')).filter(validSessionDate))]
    .sort((a, b) => b.localeCompare(a)).slice(0, 60);
  const recentSessionSet = new Set(recentSessionDates);
  const recentSessionOrders = allClosed.filter((order) => recentSessionSet.has(String(order.sessionDate ?? '')))
    .map((order) => inspectClosedPaperAccounting(order).status === 'reconciled'
      ? order : { ...order, realizedPnlUsd: null });
  const unclassifiedSessionCount = allClosed.filter((order) => !validSessionDate(order.sessionDate)).length;
  const bootstrap = bootstrapSessionExpectancy(recentSessionOrders, { replicates: 1_000, seed: 1 });
  const recentSessionExpectancyBootstrap = unclassifiedSessionCount || bootstrap.excluded
    ? { ...bootstrap, lower95R: null, upper95R: null, replicates: 0,
      method: 'unavailable; a closed record has missing/invalid session, unreconciled modeled costs, P&L, or initial risk' }
    : bootstrap;
  const completeAfterCostSample = reconciled.length === allClosed.length;
  return {
    ...summary,
    netPnlUsd: completeAfterCostSample ? summary.netPnlUsd : null,
    expectancyUsd: completeAfterCostSample ? summary.expectancyUsd : null,
    winRatePct: completeAfterCostSample ? summary.winRatePct : null,
    profitFactor: completeAfterCostSample ? summary.profitFactor : null,
    averageWinUsd: completeAfterCostSample ? summary.averageWinUsd : null,
    averageLossUsd: completeAfterCostSample ? summary.averageLossUsd : null,
    maxDrawdownUsd: completeAfterCostSample ? summary.maxDrawdownUsd : null,
    currentDrawdownUsd: completeAfterCostSample ? summary.currentDrawdownUsd : null,
    byBotAndStrategy: Object.fromEntries(Object.entries(summary.byBotAndStrategy || {}).map(([key, group]) => {
      const groupOrders = allClosed.filter((order) => `${order.owner}:${order.strategyId}` === key);
      const complete = groupOrders.every((order) => inspectClosedPaperAccounting(order).status === 'reconciled');
      return [key, complete ? group : { ...group, netPnlUsd: null, averageWinUsd: null, averageLossUsd: null }];
    })),
    sampleSize: closed.length,
    closedRecordCount: allClosed.length,
    missingRealizedPnlCount: allClosed.length - closed.length,
    reconciledAfterCostCount: reconciled.length,
    missingCostBreakdownCount, pnlAccountingMismatchCount,
    afterCostEvidenceStatus: !allClosed.length ? 'no_closed_sample'
      : reconciled.length === allClosed.length ? 'reconciled_after_cost_sample'
        : pnlAccountingMismatchCount ? 'pnl_accounting_mismatch' : 'incomplete_cost_breakdown',
    target1Hits,
    target1HitRatePct: rate(target1Hits, allClosed.length),
    target2Hits: null,
    stopCount,
    stopRatePct: rate(stopCount, allClosed.length),
    timeExitCount: allClosed.filter((order) => order.exitReason === 'time_exit').length,
    reservationCount: orders.length,
    filledReservationCount: filledOrders.length,
    pendingReservationCount: orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status)).length,
    completedEntryAttempts,
    reservationFillRatePct: rate(filledOrders.length, completedEntryAttempts),
    notFilledCount: unfilledCancellations.length,
    notFilledRatePct: rate(unfilledCancellations.length, completedEntryAttempts),
    averageNetReturnPct: returnedPct.length === allClosed.length && allClosed.length ? average(returnedPct) : null,
    netReturnSampleCount: returnedPct.length,
    averageRealizedR: realizedR.length === allClosed.length && allClosed.length ? average(realizedR) : null,
    realizedRSampleSize: realizedR.length,
    recentSessionExpectancyBootstrap: { ...recentSessionExpectancyBootstrap, windowSessionDays: recentSessionDates.length,
      maxWindowSessionDays: 60, unclassifiedSessionCount },
    worstMaxAdverseExcursionUsd: adverseExcursions.length === allClosed.length && allClosed.length
      ? Number(Math.max(...adverseExcursions).toFixed(2)) : null,
    bestMaxFavorableExcursionUsd: favorableExcursions.length === allClosed.length && allClosed.length
      ? Number(Math.max(...favorableExcursions).toFixed(2)) : null,
    favorableExcursionSampleCount: favorableExcursions.length,
    adverseExcursionSampleCount: adverseExcursions.length,
    averageMaxFavorableExcursionUsdQuoteSampledGross: summary.averageMaxFavorableExcursionUsd,
    averageMaxAdverseExcursionUsdQuoteSampledGross: summary.averageMaxAdverseExcursionUsd,
    metricDefinitions: {
      sampleSize: 'Lifetime closed paper orders with explicit finite realized P&L in this isolated profile ledger; closedRecordCount includes ungraded closes.',
      reservationFillRatePct: 'Filled orders / (filled orders + terminal unfilled cancellations); pending reservations are excluded.',
      notFilledRatePct: 'Terminal unfilled cancellations / (filled orders + terminal unfilled cancellations); pending reservations are excluded.',
      target1HitRatePct: 'Closed records exited at target / all closed records, including records with unavailable P&L.',
      stopRatePct: 'Closed records exited at stop / all closed records, including records with unavailable P&L.',
      excursion: 'Gross account-currency excursion sampled from executable quotes; not net of costs and intrabar extremes may be missed.',
      averageNetReturnPct: 'Mean reconciled modeled after-cost P&L divided by filled notional; unavailable unless every close has gross, fee, slippage and net reconciliation plus valid notional.',
      recentSessionExpectancyBootstrap: 'Descriptive 95% percentile interval for risk-normalized expectancy, resampling entire entry-session clusters; uses at most the latest 60 sessions, requires at least two distinct sessions, and is withheld if any closed outcome lacks a valid session, reconciled modeled costs, P&L, or initial risk. It is not a promotion test and does not correct for repeated strategy comparisons.',
    },
    outcomeBasis: 'Lifetime isolated paper-ledger closes; modeled after-cost returns and expectancy require every close to reconcile gross P&L minus fees and slippage to net P&L. Target 2 is unsupported by these market strategies.',
  };
}

async function summarizeCandidateCohort(journalPath, ledger, experimentHash = null, frozenAt = null, forwardWindowEndAt = null) {
  let contents;
  try { contents = await readFile(journalPath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') contents = ''; else throw error; }
  const candidateIds = new Set();
  let malformedJournalRows = 0;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (experimentHash && record.experimentHash !== experimentHash) continue;
      const capturedAt = Date.parse(record.capturedAt ?? '');
      if (record.manifestStatus !== 'active' || !Number.isFinite(capturedAt)
        || capturedAt <= Date.parse(frozenAt ?? '') || capturedAt > Date.parse(forwardWindowEndAt ?? '')) continue;
      if (record.decision?.reasons?.includes('candidate_outside_frozen_forward_window')) continue;
      const id = String(record?.decision?.candidateId ?? '').trim();
      if (id) candidateIds.add(id);
    } catch { malformedJournalRows++; }
  }
  const orders = Array.isArray(ledger?.orders) ? ledger.orders : [];
  const orderIds = new Set(orders.map((order) => String(order.idempotencyKey ?? '')).filter(Boolean));
  const filledIds = new Set(orders.filter((order) => order.filledAt).map((order) => String(order.idempotencyKey ?? '')).filter(Boolean));
  const reservedCandidates = [...candidateIds].filter((id) => orderIds.has(id)).length;
  const filledCandidates = [...candidateIds].filter((id) => filledIds.has(id)).length;
  const rate = (numerator, denominator) => denominator ? Number((numerator / denominator * 100).toFixed(2)) : null;
  return {
    candidateCount: candidateIds.size,
    candidatesWithReservation: reservedCandidates,
    candidatesFilled: filledCandidates,
    candidateToReservationRatePct: rate(reservedCandidates, candidateIds.size),
    candidateToFillRatePct: rate(filledCandidates, candidateIds.size),
    malformedJournalRows,
  };
}

/**
 * Persist isolated, no-alert shadow paper tracks from the same current observations as a bot scan.
 * Profiles change strategy inputs only; each keeps its own paper ledger and the supplied risk policy.
 */
export async function runForwardShadowPaper({ owner, profiles, allowlist, baseConfig, strategyVersion, observations, evaluate,
  observationsByProfile = {}, riskGate, loadOpenOrderQuotes,
  quotesByInstrument = new Map(), stateDirectory, portfolioStatePath = null, now = Date.now(), accountEquity, riskPolicy = {},
  maxQuoteAgeMs, maxSpreadPct, sessionOpen = true, sessionDate = null, observationClock = null, externalRiskMode = 'mirror', allowManifestFreeze = true,
  monitoringEnv = process.env }) {
  if (typeof allowManifestFreeze !== 'boolean') throw new TypeError('Manifest readiness must be an explicit boolean.');
  if (!['mirror', 'independent'].includes(externalRiskMode)) throw new TypeError('Unknown shadow external-risk mode.');
  if (observationClock !== null && typeof observationClock !== 'function') throw new TypeError('Forward observation clock must be a function.');
  const refreshNow = () => {
    if (!observationClock) return;
    const current = observationClock();
    if (!Number.isFinite(current) || current < now) throw new RangeError('Forward observation time must be finite and monotonic.');
    now = current;
  };
  if (!OWNERS.has(owner)) throw new TypeError('Forward shadow owner is not a supported trading bot.');
  if (typeof evaluate !== 'function' || !Array.isArray(observations) || !(quotesByInstrument instanceof Map)) throw new TypeError('Forward shadow scan inputs are invalid.');
  if (!observationsByProfile || typeof observationsByProfile !== 'object' || Array.isArray(observationsByProfile)) throw new TypeError('Forward shadow profile observations must be an object of arrays.');
  if (!stateDirectory) throw new TypeError('Forward shadow state directory is required.');
  if (!Number.isFinite(now)) throw new TypeError('Forward shadow scan time must be finite.');
  const tracks = validateProfiles(profiles, allowlist, baseConfig, strategyVersion, owner, monitoringEnv);
  const profileIds = new Set(tracks.map((track) => track.id));
  for (const [profileId, rows] of Object.entries(observationsByProfile)) {
    if (!profileIds.has(profileId) || !Array.isArray(rows)) throw new TypeError(`Forward shadow observations contain an unknown profile or non-array: ${profileId}.`);
  }
  const runtimes = [];
  const canFreeze = allowManifestFreeze && riskPolicy.emergencyStop !== true && Number.isFinite(Number(accountEquity))
    && Number(accountEquity) > 0 && sessionOpen === true
    && (observations.length > 0 || Object.values(observationsByProfile).some((rows) => rows.length > 0));
  for (const track of tracks) {
    const statePath = resolve(stateDirectory, `${owner}-${track.id}-${track.configHash}.json`);
    const journalPath = resolve(stateDirectory, `${owner}-${track.id}-${track.configHash}.jsonl`);
    await mkdir(dirname(statePath), { recursive: true });
    const recovery = await recoverPaperOrders({ owner, statePath, now, emergencyStop: riskPolicy.emergencyStop === true });
    const before = await readPaperRiskLedger({ statePath });
    const manifest = await ensureExperimentManifest({ owner, track, stateDirectory, now, ledger: before, canFreeze });
    const active = before.orders.filter((order) => order.owner === owner && ['reserved', 'filled', 'open'].includes(order.status));
    runtimes.push({ track, statePath, journalPath, recovery, before, active, manifest });
  }
  const historicalRuntimes = [];
  const filenames = await readdir(stateDirectory);
  for (const track of tracks) {
    const prefix = `${owner}-${track.id}-`;
    for (const filename of filenames) {
      if (!filename.startsWith(prefix) || !/^[a-f0-9]{16}\.json$/.test(filename.slice(prefix.length))
        || filename === `${owner}-${track.id}-${track.configHash}.json`) continue;
      const statePath = resolve(stateDirectory, filename);
      const recovery = await recoverPaperOrders({ owner, statePath, now, emergencyStop: riskPolicy.emergencyStop === true });
      const before = await readPaperRiskLedger({ statePath });
      const active = before.orders.filter((order) => order.owner === owner && ['reserved', 'filled', 'open'].includes(order.status));
      historicalRuntimes.push({ track, statePath, recovery, before, active,
        profileId: `${track.id}@${filename.slice(prefix.length, -5)}`, marksProcessed: 0 });
    }
  }
  const markRuntimes = [...runtimes.map((runtime) => ({ ...runtime, profileId: runtime.track.id, marksProcessed: 0 })), ...historicalRuntimes];
  const supplementalQuotes = typeof loadOpenOrderQuotes === 'function'
    ? await loadOpenOrderQuotes(markRuntimes.map(({ profileId, active }) => ({ profileId, orders: active })), now)
    : new Map();
  refreshNow();
  for (const runtime of markRuntimes) {
    const profileQuotes = supplementalQuotes instanceof Map ? supplementalQuotes.get(runtime.profileId) : null;
    for (const order of runtime.active) {
      const key = paperQuoteLookupKey(order);
      const quote = key ? profileQuotes?.get?.(key) ?? quotesByInstrument.get(key) : null;
      if (!quote) continue;
      await processPaperQuote(order.orderId, quote, { statePath: runtime.statePath, expectedOwner: owner, now, observationClock, maxQuoteAgeMs, maxSpreadPct, sessionOpen,
        emergencyStop: riskPolicy.emergencyStop === true });
      runtime.marksProcessed++;
    }
  }
  const reports = [];
  for (const runtime of runtimes) {
    const { track, statePath, journalPath, recovery, active, manifest } = runtime;
    const marksProcessed = markRuntimes.find((row) => row.statePath === statePath)?.marksProcessed ?? 0;
    const priorRuntimes = historicalRuntimes.filter((row) => row.track.id === track.id);
    const priorLedgers = await Promise.all(priorRuntimes.map((row) => readPaperRiskLedger({ statePath: row.statePath })));
    const currentLedgerBeforeDecisions = await readPaperRiskLedger({ statePath });
    const priorOrders = [
      ...priorLedgers.flatMap((row) => row.orders.filter((order) => order.owner === owner)),
      ...currentLedgerBeforeDecisions.orders.filter((order) => order.owner === owner
        && order.experimentFingerprint !== track.experimentHash),
    ];
    const riskDayUtc = new Date(now).toISOString().slice(0, 10);
    const priorClosedRiskDay = (order) => {
      const stored = String(order.closedPortfolioRiskDateUtc || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
      const closedAt = Date.parse(order.closedAt || '');
      return Number.isFinite(closedAt) ? new Date(closedAt).toISOString().slice(0, 10) : null;
    };
    const priorExperimentRiskBlock = priorOrders.some((order) => ['reserved', 'filled', 'open'].includes(order.status)
      || order.status === 'closed' && (priorClosedRiskDay(order) === riskDayUtc || priorClosedRiskDay(order) === null));
    const decisions = [];
    const profileObservations = observationsByProfile[track.id] || observations;
    for (const observation of profileObservations) {
      refreshNow();
      const result = await evaluate(observation, { ...baseConfig, ...track.overrides }, now);
      refreshNow(); // Async quote refresh must advance risk/journal time as well.
      const symbol = String(observation?.instrumentKey ?? observation?.instrument ?? observation?.symbol ?? result?.candidate?.instrumentKey ?? 'unknown').slice(0, 80);
      let decision = { profileId: track.id, symbol, status: result?.status ?? 'invalid_strategy_result', reasons: result?.reasons ?? [] };
      if (result?.status === 'candidate' && result.candidate) {
        const sourceIdempotencyKey = String(result.candidate.idempotencyKey ?? '');
        const candidate = {
          ...result.candidate,
          strategyId: `${String(result.candidate.strategyId)}:shadow:${track.id}`,
          // A changed shadow rule must not inherit a production market-gate assertion.
          marketGateTrace: null,
          idempotencyKey: `${String(result.candidate.idempotencyKey)}:shadow:${track.id}:${track.experimentHash}`,
          experimentFingerprint: track.experimentHash,
          signal: { ...(result.candidate.signal ?? {}), shadowProfile: track.id, shadowConfigHash: track.configHash,
            shadowExperimentHash: track.experimentHash, shadowStrategyVersion: track.strategyVersion,
            shadowSourceIdempotencyKey: sourceIdempotencyKey },
        };
        const ledger = await readPaperRiskLedger({ statePath });
        const performance = summarizePaperLedger(ledger, { accountEquity, sessionDate: candidate.sessionDate, now });
        const externalLedger = portfolioStatePath && resolve(portfolioStatePath) !== resolve(statePath)
          ? await readPaperRiskLedger({ statePath: portfolioStatePath }) : null;
        const externalPerformance = externalLedger
          ? summarizePaperLedger(externalLedger, { accountEquity, sessionDate: candidate.sessionDate, now }) : null;
        const externalActive = externalLedger?.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status)
          && (!sourceIdempotencyKey || order.idempotencyKey !== sourceIdempotencyKey)) ?? [];
        const portfolio = { accountEquity,
          // Mirrored profiles use the worse book P&L to avoid counting a production
          // trade twice. Independent experiments add their P&L to the actual book
          // because their hypothetical trades are additional exposure.
          realizedPnlToday: externalPerformance
            ? [externalPerformance.realizedPnlRiskDayUtcUsd, performance.realizedPnlRiskDayUtcUsd]
              .every(hasExplicitFiniteAmount)
              ? externalRiskMode === 'independent'
                ? Number(externalPerformance.realizedPnlRiskDayUtcUsd) + Number(performance.realizedPnlRiskDayUtcUsd)
                : Math.min(Number(externalPerformance.realizedPnlRiskDayUtcUsd), Number(performance.realizedPnlRiskDayUtcUsd))
              : null
            : performance.realizedPnlRiskDayUtcUsd,
          openPositions: [
            ...ledger.orders.filter((order) => ['reserved', 'filled', 'open'].includes(order.status)),
            ...externalActive,
          ], closedOrders: [...ledger.orders.filter((order) => order.status === 'closed'),
            ...(externalRiskMode === 'independent' ? externalLedger?.orders.filter((order) => order.status === 'closed') ?? [] : [])] };
        const policy = { ...riskPolicy, now, maxQuoteAgeMs, maxSpreadPct, emergencyStop: riskPolicy.emergencyStop === true, liveTradingEnabled: false };
        const quoteAt = Date.parse(candidate.quoteTime ?? '');
        let approved = manifest.status !== 'active'
          ? { status: 'blocked', reasons: [manifest.reason] }
          : !Number.isFinite(quoteAt) || quoteAt <= Date.parse(manifest.frozenAt)
            || quoteAt > Date.parse(manifest.forwardWindowEndAt)
            ? { status: 'blocked', reasons: ['candidate_outside_frozen_forward_window'] }
            : priorExperimentRiskBlock
              ? { status: 'blocked', reasons: ['prior_shadow_experiment_open_or_closed_this_risk_day'] }
              : evaluatePaperCandidate(candidate, portfolio, policy);
        if (approved.status === 'paper-approved' && typeof riskGate === 'function') approved = riskGate(approved, observation, candidate);
        if (approved.status !== 'paper-approved') decision = { ...decision, status: 'risk-blocked', reasons: approved.reasons, candidateId: candidate.idempotencyKey };
        else {
          const reservation = await reservePaperCandidate(candidate, approved, { statePath, now, observationClock, emergencyStop: riskPolicy.emergencyStop === true,
            externalRiskContext: portfolioStatePath && resolve(portfolioStatePath) !== resolve(statePath)
              ? { statePath: portfolioStatePath, mode: externalRiskMode, sourceIdempotencyKey: sourceIdempotencyKey || '' } : null });
          decision = { ...decision, status: reservation.status, candidateId: candidate.idempotencyKey,
            orderId: reservation.order?.orderId ?? null, reasons: reservation.reasons ?? (reservation.reason ? [reservation.reason] : []) };
        }
      }
      decisions.push(decision);
      await appendFile(journalPath, `${JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), owner, profileId: track.id,
        configHash: track.configHash, baseConfigHash: track.baseConfigHash, experimentHash: track.experimentHash,
        strategyVersion: track.strategyVersion, paperExecutionVersion: track.paperExecutionVersion, manifestStatus: manifest.status,
        capturedAt: new Date(now).toISOString(), decision })}\n`, { encoding: 'utf8', flag: 'a' });
    }
    const ledger = await readPaperRiskLedger({ statePath });
    const cohortLedger = { ...ledger, orders: ledger.orders.filter((order) => manifest.frozenAt
      && order.experimentFingerprint === track.experimentHash
      && Date.parse(order.reservedAt ?? '') > Date.parse(manifest.frozenAt)
      && Date.parse(order.reservedAt ?? '') <= Date.parse(manifest.forwardWindowEndAt)) };
    const performance = summarizeForwardShadowPerformance(cohortLedger, { accountEquity, sessionDate: sessionDate || new Date(now).toISOString().slice(0, 10), now });
    const candidateCohort = await summarizeCandidateCohort(journalPath, cohortLedger, track.experimentHash,
      manifest.frozenAt, manifest.forwardWindowEndAt);
    const rejectionCounts = new Map();
    for (const row of decisions) {
      if (!['no-setup', 'risk-blocked', 'provider_or_input_rejected', 'invalid_strategy_result'].includes(row.status)) continue;
      const reasons = Array.isArray(row.reasons) && row.reasons.length ? row.reasons : [row.status];
      for (const reason of reasons) rejectionCounts.set(String(reason).slice(0, 100), (rejectionCounts.get(String(reason).slice(0, 100)) || 0) + 1);
    }
    const topRejectionReasons = Object.fromEntries([...rejectionCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10));
    reports.push({ id: track.id, configHash: track.configHash, baseConfigHash: track.baseConfigHash,
      experimentHash: track.experimentHash, strategyVersion: track.strategyVersion, paperExecutionVersion: track.paperExecutionVersion,
      manifest,
      legacyOrOtherExperimentOrders: ledger.orders.length - cohortLedger.orders.length,
      overrides: track.overrides, mode: 'forward_shadow_paper',
      statePath, journalPath, recovery, marksProcessed,
      priorExperimentLedgers: priorRuntimes.length,
      priorExperimentOrderCount: priorOrders.length,
      priorExperimentMarksProcessed: priorRuntimes.reduce((sum, row) => sum + row.marksProcessed, 0),
      priorExperimentRiskBlock,
      counts: { observations: profileObservations.length,
        strategyQualified: decisions.filter((row) => ['risk-blocked', 'reserved', 'filled', 'open', 'closed', 'duplicate'].includes(row.status)).length,
        candidateCount: decisions.filter((row) => ['risk-blocked', 'reserved', 'filled', 'open', 'closed', 'duplicate'].includes(row.status)).length,
        reservations: decisions.filter((row) => row.status === 'reserved').length,
        filled: decisions.filter((row) => ['filled', 'open', 'closed'].includes(row.status)).length,
        duplicate: decisions.filter((row) => row.status === 'duplicate').length,
        riskBlocked: decisions.filter((row) => row.status === 'risk-blocked').length, noSetup: decisions.filter((row) => row.status === 'no-setup').length,
        providerOrInputRejected: decisions.filter((row) => !['candidate', 'risk-blocked', 'reserved', 'filled', 'open', 'closed', 'duplicate', 'no-setup'].includes(row.status)).length },
      topRejectionReasons, decisions, performance: { ...performance, ...candidateCohort,
        priorExperimentLedgers: priorRuntimes.length,
        priorExperimentOrderCount: priorOrders.length,
        priorExperimentMarksProcessed: priorRuntimes.reduce((sum, row) => sum + row.marksProcessed, 0),
        priorExperimentRiskBlock,
        scanCandidateCount: decisions.filter((row) => ['risk-blocked', 'reserved', 'filled', 'open', 'closed', 'duplicate'].includes(row.status)).length,
        metricDefinitions: { ...performance.metricDefinitions,
          candidateCount: 'Lifetime unique stable candidate IDs recorded in this isolated profile decision journal.',
          candidateToReservationRatePct: 'Unique candidate IDs with any corresponding paper-ledger order / all unique candidate IDs.',
          candidateToFillRatePct: 'Unique candidate IDs whose corresponding paper-ledger order filled / all unique candidate IDs.' } } });
  }
  return reports;
}
