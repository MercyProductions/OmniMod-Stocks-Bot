import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { futuresActivityDirectoryFingerprint, inspectFuturesActivityDirectory } from './futuresActivityScreen.js';
import { inspectActiveFutureContract, parseFuturesExpiry, validateActiveFutureContract } from './universe.js';
import { validateFuturesSettlementReview } from './contractReview.js';
import { validateFuturesSession } from './dayStrategy.js';
import { isFreshClearCatalystReview } from '../../shared/catalystReview.js';
import { hasExplicitNonNegativeFiniteAmount } from '../../shared/strategyConfig.js';

export const FUTURES_ACTIVITY_ROUTING_VERSION = 'futures-reviewed-activity-routing-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const duplicates = (rows, key) => {
  const counts = new Map();
  for (const row of rows) { const id = key(row); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
};
const referenceKey = (c) => [c?.providerDataset, c?.providerPublisherId, c?.providerInstrumentId, c?.providerRawSymbol].map(text).join(':');

/** Read only reviewed metadata. A missing file never becomes an empty successful scan. */
export async function loadFuturesActivityReviews(path) {
  if (!path) return { status: 'review_file_not_configured', dayTrades: [], sha256: null };
  let handle;
  try {
    handle = await open(path, 'r');
    const limit = 8 * 1024 * 1024, stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return { status: 'review_file_limit_exceeded', dayTrades: [], sha256: null };
    // Bounded read also protects against a file growing after stat().
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) return { status: 'review_file_limit_exceeded', dayTrades: [], sha256: null };
    const bytes = buffer.subarray(0, size), parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.dayTrades) || parsed.dayTrades.length > 10000)
      return { status: 'review_file_schema_invalid', dayTrades: [], sha256: null };
    return { status: 'loaded', dayTrades: parsed.dayTrades, sessionDate: parsed.sessionDate, sha256: hash(bytes) };
  } catch { return { status: 'review_file_unavailable_or_invalid', dayTrades: [], sha256: null }; }
  finally { await handle?.close(); }
}

/** Activity chooses the work; reviewed metadata supplies terms, never prices or approval. */
export function routeFuturesActivityForAnalysis({ enabled = false, activity, directory, reviews,
  configuredRows = [], dataset = 'GLBX.MDP3', now = Date.now(), maxAdditional = 10,
  maxBarAgeMs = 180000, dayDataSource, trendDataSource, catalystSource = 'manual', deliveryEntryBufferHours = 24 } = {}) {
  if (!Array.isArray(configuredRows)) throw new TypeError('Configured Futures rows must be an array.');
  const decisions = [], additions = [];
  const candidates = Array.isArray(activity?.candidates) ? activity.candidates : [];
  const diagnostics = { version: FUTURES_ACTIVITY_ROUTING_VERSION, status: enabled ? 'evaluated' : 'disabled',
    activityCandidates: activity?.status === 'screen_complete' ? candidates.length : null,
    configuredInputs: configuredRows.length, reviewedPool: reviews?.dayTrades?.length ?? 0,
    reviewSha256: reviews?.sha256 ?? null, maxAdditional, metadataReady: 0, selected: 0,
    alreadyConfigured: 0, rejected: 0, deferred: 0, rejectionReasons: {}, strategyApprovalInferred: false };
  const finish = () => {
    diagnostics.selected = additions.length;
    for (const d of decisions) {
      if (d.status === 'rejected') diagnostics.rejected++;
      if (d.status === 'deferred') diagnostics.deferred++;
      if (d.status === 'already_configured') diagnostics.alreadyConfigured++;
      for (const reason of d.reasons) diagnostics.rejectionReasons[reason] = (diagnostics.rejectionReasons[reason] || 0) + 1;
    }
    return { dayTrades: [...configuredRows, ...additions], additions, diagnostics, decisions };
  };
  if (!enabled) return finish();
  const blocked = [];
  if (!Number.isFinite(now) || !Number.isInteger(maxAdditional) || maxAdditional < 1 || maxAdditional > 100
    || !Number.isFinite(maxBarAgeMs) || maxBarAgeMs <= 0 || maxBarAgeMs > 300000
    || !Number.isFinite(deliveryEntryBufferHours) || deliveryEntryBufferHours < 24 || deliveryEntryBufferHours > 720)
    blocked.push('activity_analysis_policy_invalid');
  if (dayDataSource !== 'databento-live' || trendDataSource !== 'databento-historical') blocked.push('current_live_and_h1_sources_required');
  if (!['manual', 'finnhub'].includes(catalystSource)) blocked.push('catalyst_source_invalid');
  const directoryError = Number.isFinite(now) ? inspectFuturesActivityDirectory(directory, { dataset, now }) : 'directory_clock_invalid';
  if (directoryError) blocked.push(directoryError);
  if (activity?.status !== 'screen_complete') blocked.push('current_activity_screen_required');
  if (!directoryError && activity?.diagnostics?.directoryFingerprint !== futuresActivityDirectoryFingerprint(directory)) blocked.push('activity_directory_fingerprint_mismatch');
  if (reviews?.status !== 'loaded' || !Array.isArray(reviews?.dayTrades)) blocked.push(reviews?.status || 'review_pool_unavailable');
  if (blocked.length) {
    diagnostics.status = 'blocked'; diagnostics.blockingReasons = [...new Set(blocked)];
    for (const c of candidates) decisions.push({ identity: c.identity, rawSymbol: c.providerRawSymbol, status: 'rejected', reasons: diagnostics.blockingReasons });
    return finish();
  }
  const definitions = new Map(directory.contracts.map((c) => [c.identity, c]));
  const reviewRows = reviews.dayTrades;
  const reviewsByKey = new Map(reviewRows.map((r) => [referenceKey(r?.contract), r]));
  const duplicateReviews = duplicates(reviewRows, (r) => referenceKey(r?.contract));
  const duplicateIds = duplicates(reviewRows, (r) => upper(r?.contract?.contractId));
  const duplicateCandidates = duplicates(candidates, (c) => c.identity);
  const duplicateRawDefinitions = duplicates(directory.contracts, (c) => upper(c.providerRawSymbol));
  const configuredRaw = new Set(configuredRows.map((r) => upper(r?.contract?.providerRawSymbol)));
  const configuredIds = new Set(configuredRows.map((r) => upper(r?.contract?.contractId)));
  const selectedRaw = new Set(), selectedIds = new Set();
  for (const c of candidates) {
    const d = { identity: c.identity, rawSymbol: c.providerRawSymbol, root: c.providerRoot, status: 'rejected', reasons: [] };
    decisions.push(d);
    const candidateKey = referenceKey({ providerDataset: dataset, ...c });
    const def = definitions.get(c.identity), review = reviewsByKey.get(candidateKey), contract = review?.contract;
    if (duplicateCandidates.has(c.identity)) d.reasons.push('duplicate_activity_identity');
    if (!def || referenceKey(def) !== candidateKey || def.providerRoot !== c.providerRoot
      || parseFuturesExpiry(def.expiry) !== parseFuturesExpiry(c.expiry)) d.reasons.push('activity_definition_identity_mismatch');
    if (duplicateRawDefinitions.has(upper(c.providerRawSymbol))) d.reasons.push('ambiguous_provider_raw_symbol');
    const closedAt = Date.parse(c.latestBarClosedAt);
    if (!Number.isFinite(closedAt) || closedAt > now || now - closedAt > maxBarAgeMs) d.reasons.push('activity_candidate_stale_or_future');
    if (d.reasons.length) continue;
    if (configuredRaw.has(upper(c.providerRawSymbol))) { d.status = 'already_configured'; d.reasons.push('existing_session_input_preserved'); continue; }
    if (!review) { d.reasons.push('reviewed_contract_metadata_missing'); continue; }
    if (duplicateReviews.has(candidateKey) || duplicateIds.has(upper(contract?.contractId))) d.reasons.push('ambiguous_review_identity');
    if (review.preparationStatus !== 'operator_reviewed_paper_input') d.reasons.push('operator_review_required');
    if (contract?.providerRoot !== def.providerRoot || contract?.providerExchange !== def.providerExchange
      || parseFuturesExpiry(contract?.expiryAt ?? contract?.expiry) !== parseFuturesExpiry(def.expiry)) d.reasons.push('review_definition_identity_mismatch');
    const definitionAt = Date.parse(def.definitionTimestamp);
    if (!Number.isFinite(definitionAt) || definitionAt > now || now - definitionAt > 86400000) d.reasons.push('provider_definition_stale_or_future');
    // Existing paper accounting uses USD; unknown/non-USD amounts require a conversion adapter.
    if (def.providerCurrency !== 'USD') d.reasons.push('usd_contract_accounting_not_verified');
    for (const [providerField, reviewedField] of [['providerTickSize', 'tickSize'], ['providerContractMultiplier', 'multiplier']]) {
      const providerValue = Number(def[providerField]), reviewedValue = Number(contract?.[reviewedField]);
      if (!(providerValue > 0) || !Number.isFinite(providerValue)) d.reasons.push(`${providerField}_unavailable`);
      else if (!Number.isFinite(reviewedValue) || Math.abs(providerValue - reviewedValue) > Math.max(1e-8, providerValue * 1e-6)) d.reasons.push(`${providerField}_review_mismatch`);
    }
    d.reasons.push(...inspectActiveFutureContract(contract, { now }).reasons);
    d.reasons.push(...validateFuturesSettlementReview(contract, { now, entryBufferMs: deliveryEntryBufferHours * 3600000 }).reasons);
    const session = validateFuturesSession(review.session ?? {}, { now });
    d.reasons.push(...session.reasons);
    if (session.openTime > now || now >= session.closeTime - 30 * 60000) d.reasons.push('outside_strategy_entry_session');
    if (reviews.sessionDate !== session.marketDate) d.reasons.push('review_pool_session_date_mismatch');
    if (catalystSource === 'manual' && !isFreshClearCatalystReview(review.catalystReview, { now })) d.reasons.push('fresh_clear_catalyst_review_required');
    for (const key of ['roundTripFeesPerContract', 'slippageReservePerContract'])
      if (!hasExplicitNonNegativeFiniteAmount(review.config?.[key])) d.reasons.push('explicit_contract_cost_reserves_required');
    d.reasons = [...new Set(d.reasons)];
    if (d.reasons.length) continue;
    if (configuredIds.has(upper(contract.contractId))) { d.reasons.push('contract_id_conflicts_with_configured_input'); continue; }
    if (selectedIds.has(upper(contract.contractId)) || selectedRaw.has(upper(contract.providerRawSymbol))) { d.reasons.push('duplicate_selected_contract'); continue; }
    diagnostics.metadataReady++;
    if (additions.length >= maxAdditional || configuredRows.length + additions.length >= 100) {
      d.status = 'deferred'; d.reasons.push('deep_analysis_capacity'); continue;
    }
    selectedIds.add(upper(contract.contractId)); selectedRaw.add(upper(contract.providerRawSymbol));
    const discoveryContext = { version: FUTURES_ACTIVITY_ROUTING_VERSION, cohort: 'broad_activity_reviewed',
      identity: c.identity, root: c.providerRoot, activityRank: c.overallActivityRank, latestBarClosedAt: c.latestBarClosedAt,
      routedAt: new Date(now).toISOString(), directoryFingerprint: activity.diagnostics.directoryFingerprint,
      activityConfigurationHash: activity.diagnostics.configurationHash ?? null,
      activitySourceSha256: activity.archive?.sha256 ?? null, activityArchive: activity.archive?.normalizedFile ?? null,
      reviewSha256: reviews.sha256, metadataSha256: hash(JSON.stringify({ contract, session: review.session, config: review.config, catalystReview: review.catalystReview })) };
    // Whitelist metadata: never inherit review-file quotes, bars, provider-success flags or strategy overrides.
    additions.push({ preparationStatus: 'operator_reviewed_paper_input', contract: validateActiveFutureContract(contract, { now }),
      session: structuredClone(review.session), catalystReview: structuredClone(review.catalystReview ?? null),
      config: { roundTripFeesPerContract: Number(review.config.roundTripFeesPerContract),
        slippageReservePerContract: Number(review.config.slippageReservePerContract) },
      bars: [], trendBars: [], quote: null, discoveryContext });
    d.status = 'selected_for_analysis'; d.contractId = contract.contractId; d.discoveryContext = discoveryContext;
  }
  return finish();
}
