import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { archiveDiscovery } from '../../shared/equitySnapshotDiscovery.js';
import { marketDateAt } from '../../shared/marketDate.js';
import { requestTradierWithRetry } from './tradierMarketData.js';
import { OPTIONS_DISCOVERY_VERSION } from './underlyingDiscovery.js';
import { parseExpirationInventory, parseContractInventory, selectResearchExpirations, tradierUnderlyingSymbol, validOptionDate } from './contractInventory.js';

export const OPTIONS_CONTRACT_DISCOVERY_VERSION = 'options-independent-contracts-v1';
const DAY = 86400000;
const errorCode = (error) => String(error?.code || '').startsWith('TRADIER_BUDGET_') ? error.code : ['TRADIER_PACING_DEFERRED', 'TRADIER_RESEARCH_DEADLINE',
  'invalid_expiration_response', 'invalid_expiration_date', 'invalid_chain_response'].includes(error?.code) ? error.code : 'provider_or_payload_failure';
async function saveCache(file, record) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}
async function cachedExpirations({ file, scope, now, ttl, fetchDates }) {
  let old = null;
  try {
    const row = JSON.parse(await readFile(file, 'utf8'));
    if (row.version === OPTIONS_CONTRACT_DISCOVERY_VERSION && row.scope === scope && Number.isFinite(row.observedAt)
      && row.observedAt <= now && Array.isArray(row.dates) && row.dates.every(validOptionDate)
      && new Set(row.dates).size === row.dates.length && Number.isInteger(row.cursor) && row.cursor >= 0) old = row;
  } catch { /* Missing/corrupt caches never supply a guessed expiration. */ }
  if (old && now - old.observedAt < ttl && marketDateAt(old.observedAt, 'America/New_York') === marketDateAt(now, 'America/New_York')) {
    return { record: old, status: 'fresh', changes: { baseline: false, added: [], removed: [] } };
  }
  const parsed = parseExpirationInventory(await fetchDates());
  const record = { version: OPTIONS_CONTRACT_DISCOVERY_VERSION, scope, observedAt: now, dates: parsed.dates, cursor: old?.cursor || 0,
    members: old?.members || {} };
  await saveCache(file, record);
  return { record, status: 'refreshed', duplicateDates: parsed.duplicateDates, changes: { baseline: !old,
    added: record.dates.filter((date) => !old?.dates.includes(date)), removed: (old?.dates || []).filter((date) => !record.dates.includes(date)) } };
}

export function describeOptionContracts(diagnostics = {}) {
  const n = (value) => Number.isInteger(value) && value >= 0 ? value : 'unknown';
  const status = String(diagnostics.status || 'not run').replaceAll('_', ' ');
  return `Independent contracts: ${status} · ${n(diagnostics.expirationDates)} expiration dates · ${n(diagnostics.chainResponses)} chain responses · ${n(diagnostics.verifiedIdentities)} verified standard identities. ${diagnostics.environment === 'sandbox' ? 'Sandbox quotes are delayed. ' : ''}Inventory only; no strategy or entry approval.`;
}

/** Independent read-only chain research. It never feeds production signalRows or the paper ledger. */
export async function discoverOptionContracts({ underlyingDiscovery, env = process.env, now = Date.now(),
  clock = Date.now, fetcher = fetch, providerMetrics = [], startPacer,
  retrySleep = (ms) => new Promise((done) => setTimeout(done, ms)), random = Math.random } = {}) {
  const started = clock(), at = () => now + Math.max(0, clock() - started);
  const source = String(env.OPTIONS_CONTRACT_DISCOVERY_SOURCE || 'auto').toLowerCase();
  const environment = String(env.TRADIER_ENV || 'sandbox').toLowerCase();
  const result = { underlyings: [], diagnostics: { version: OPTIONS_CONTRACT_DISCOVERY_VERSION, status: 'not_started', source: 'Tradier', environment,
    inputUnderlyings: Array.isArray(underlyingDiscovery?.shortlist) ? underlyingDiscovery.shortlist.length : null,
    selectedUnderlyings: 0, deferredUnderlyings: 0, expiredMetadataFallbacks: 0, expirationInventories: 0,
    expirationDates: null, eligibleExpirations: null, selectedChains: 0, deferredExpirations: null,
    chainRequests: 0, chainResponses: 0, contractsReturned: null, verifiedIdentities: null,
    identityRejected: null, freshResearchQuotes: null, delayedResearchQuotes: null,
    strategyCandidates: 0, paperEligible: 0, providerRequests: 0, providerFailures: 0, failedOperations: 0,
    stageDurationsMs: {}, rejectionReasons: {}, downstreamStatus: 'independent_strategy_and_forward_validation_pending' } };
  const d = result.diagnostics, fullInventories = [], metricOffset = providerMetrics.length;
  const finish = (status) => {
    d.status = status; d.elapsedMs = Math.max(0, clock() - started);
    d.deferredUnderlyings = result.underlyings.filter((row) => row.status === 'deferred').length;
    d.providerFailures = providerMetrics.slice(metricOffset).filter((row) => row.error || Number(row.status) >= 400 || Number(row.status) === 0).length;
    return result;
  };
  if (!['auto', 'tradier', 'disabled'].includes(source)) return finish('invalid_contract_discovery_source');
  if (source === 'disabled') return finish('disabled');
  if (!['sandbox', 'production'].includes(environment)) return finish('invalid_environment');
  const token = String(env.TRADIER_TOKEN || '').trim();
  if (!token) { d.missingCredentialNames = ['TRADIER_TOKEN']; return finish('credentials_missing'); }
  if (!underlyingDiscovery || underlyingDiscovery.diagnostics?.version !== OPTIONS_DISCOVERY_VERSION
    || !Array.isArray(underlyingDiscovery.shortlist)) return finish('underlying_discovery_unavailable');
  if (!underlyingDiscovery.shortlist.length) return finish('no_independent_underlying_shortlist');
  const close = Date.parse(underlyingDiscovery.diagnostics.sessionClose || '');
  if (underlyingDiscovery.diagnostics.marketOpen !== true || !Number.isFinite(close) || close <= at()) return finish('underlying_session_unverified_or_closed');
  const maxUnderlyings = Number(env.OPTIONS_CONTRACT_MAX_UNDERLYINGS || 12), maxChains = Number(env.OPTIONS_CONTRACT_MAX_EXPIRATIONS || 2);
  const minDays = Number(env.OPTIONS_CONTRACT_MIN_DTE ?? 1), maxDays = Number(env.OPTIONS_CONTRACT_MAX_DTE ?? 45);
  const ttl = Number(env.OPTIONS_EXPIRATION_REFRESH_MS || 3600000), budget = Number(env.OPTIONS_CONTRACT_BUDGET_MS || 45000);
  if (!Number.isInteger(maxUnderlyings) || maxUnderlyings < 1 || maxUnderlyings > 12 || !Number.isInteger(maxChains) || maxChains < 1 || maxChains > 4
    || !Number.isInteger(minDays) || !Number.isInteger(maxDays) || minDays < 0 || maxDays < minDays || maxDays > 1095
    || !Number.isFinite(ttl) || ttl < 60000 || ttl > DAY || !Number.isFinite(budget) || budget < 1000 || budget > 60000) return finish('invalid_contract_configuration');
  const deadline = started + budget, sessionDate = marketDateAt(now, 'America/New_York');
  d.config = { maxUnderlyings, maxChainsPerUnderlying: maxChains, minDays, maxDays, metadataRefreshMs: ttl, startBudgetMs: budget };
  d.quality = environment === 'sandbox' ? 'delayed contract research only' : 'production contract research only; no approval';
  const root = environment === 'production' ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1';
  let stopReason = null;
  const deferred = () => {
    if (clock() >= deadline) stopReason ||= 'research_time_budget';
    if (at() >= close) stopReason ||= 'session_closed';
    return stopReason;
  };
  const request = async (url, operation) => {
    if (deferred()) throw Object.assign(new Error('Research deferred.'), { code: 'TRADIER_RESEARCH_DEADLINE' });
    const response = await requestTradierWithRetry([url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(8000, Math.floor(deadline - clock())))) }], {
      fetchImpl: fetcher, token, environment, operation, providerMetrics, clockNow: clock,
      retrySleep, random, maxAttempts: 2, maxRetryWaitMs: 2000, deadline, ...(startPacer ? { startPacer } : {}),
      onRequest: () => { d.providerRequests++; if (operation === 'research-option-chains') d.chainRequests++; } });
    if ([401, 403, 429].includes(response.status)) stopReason = 'provider_auth_or_quota_deferred';
    const available = response.headers?.get?.('X-Ratelimit-Available');
    if (available != null && String(available).trim() !== '' && Number(available) >= 0 && Number(available) <= 5) stopReason ||= 'provider_quota_headroom';
    if (!response.ok) throw Object.assign(new Error('Provider HTTP failure.'), { status: response.status });
    return response.json();
  };
  const failure = (error) => {
    d.failedOperations++;
    const code = errorCode(error);
    if (code === 'TRADIER_PACING_DEFERRED') stopReason = 'provider_pacing_deferred';
    if (code.startsWith('TRADIER_BUDGET_')) stopReason = 'provider_budget_unavailable';
    if (code === 'TRADIER_RESEARCH_DEADLINE') stopReason ||= 'research_time_budget';
    return { reason: stopReason || code, status: Number(error.status) || null };
  };
  const tally = (reason, count = 1) => { d.rejectionReasons[reason] = (d.rejectionReasons[reason] || 0) + count; };
  const counts = new Map(), assetCounts = new Map();
  for (const row of underlyingDiscovery.shortlist) {
    const symbol = tradierUnderlyingSymbol(row?.symbol);
    if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
    if (row?.assetId) assetCounts.set(row.assetId, (assetCounts.get(row.assetId) || 0) + 1);
  }
  const selected = [];
  for (const input of underlyingDiscovery.shortlist) {
    const symbol = tradierUnderlyingSymbol(input?.symbol), observed = Date.parse(input?.quoteAt || '');
    const reason = !symbol || typeof input?.assetId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(input.assetId) ? 'invalid_underlying_identity'
      : counts.get(symbol) > 1 || assetCounts.get(input.assetId) > 1 ? 'ambiguous_underlying_identity'
        : !Number.isFinite(observed) || observed > at() + 5000 || at() - observed > 120000 ? 'stale_underlying_shortlist'
          : selected.length >= maxUnderlyings ? 'underlying_chain_budget' : null;
    const row = { symbol, assetId: input?.assetId || null, status: reason ? 'deferred' : 'selected', reasons: reason ? [reason] : [],
      expirations: null, selectedExpirations: [], chains: [] };
    result.underlyings.push(row);
    if (reason) { tally(reason); d.deferredUnderlyings++; } else selected.push(row);
  }
  d.selectedUnderlyings = selected.length;
  if (!selected.length) return finish('no_valid_underlying_inputs');
  const cacheDirectory = resolve(env.OPTIONS_EXPIRATION_CACHE_PATH || '.cache/options-expirations');
  const prepared = [];
  try {
    await mkdir(cacheDirectory, { recursive: true });
    const stage = clock();
    // Enumerate/cache every selected underlying before spending the remaining budget on chains.
    for (const row of selected) {
      if (deferred()) { row.status = 'deferred'; row.reasons.push(stopReason); tally(stopReason); continue; }
      const scope = createHash('sha256').update([token, environment, row.assetId, row.symbol].join('\n')).digest('hex');
      const file = join(cacheDirectory, scope + '.json');
      try {
        const cached = await cachedExpirations({ file, scope, now: at(), ttl, fetchDates: () => request(
          `${root}/markets/options/expirations?symbol=${encodeURIComponent(row.symbol)}&includeAllRoots=true&strikes=false&contractSize=false&expirationType=false`, 'research-option-expirations') });
        const selection = selectResearchExpirations(cached.record.dates, { sessionDate, minDays, maxDays, maxChains, cursor: cached.record.cursor });
        row.expirations = cached.record.dates; row.selectedExpirations = selection.selected; row.status = 'expirations_observed';
        row.expirationCache = { status: cached.status, observedAt: new Date(cached.record.observedAt).toISOString(), changes: cached.changes };
        row.expirationExclusions = selection.excluded; row.expirationDeferrals = selection.deferred;
        d.expirationInventories++; d.expirationDates = (d.expirationDates || 0) + row.expirations.length;
        d.eligibleExpirations = (d.eligibleExpirations || 0) + selection.eligible.length;
        d.selectedChains += selection.selected.length; d.deferredExpirations = (d.deferredExpirations || 0) + selection.deferred.length;
        for (const excluded of [...selection.excluded, ...selection.deferred]) tally(excluded.reason);
        prepared.push({ row, selection, file, record: cached.record, fetchedRotating: 0 });
      } catch (error) { row.status = 'expiration_unavailable'; row.failure = failure(error); row.reasons.push(row.failure.reason); tally(row.failure.reason); }
    }
    d.stageDurationsMs.expirationDiscovery = Math.max(0, clock() - stage);
    const chainStage = clock();
    // One expiry per underlying per round prevents a single liquid symbol consuming the whole budget.
    for (let round = 0; round < maxChains; round++) for (const item of prepared) {
      const { row, selection } = item, expiry = selection.selected[round];
      if (!expiry) continue;
      if (deferred()) { row.chains.push({ expiry, status: 'deferred', reason: stopReason }); tally(stopReason); continue; }
      try {
        const payload = await request(`${root}/markets/options/chains?symbol=${encodeURIComponent(row.symbol)}&expiration=${expiry}&greeks=false`, 'research-option-chains');
        const inventory = parseContractInventory(payload, { underlying: row.symbol, expiry, environment, now: at() });
        const current = inventory.contracts.filter((contract) => !contract.reasons.length).map((contract) => contract.symbol).sort();
        const prior = item.record.members?.[expiry];
        const previous = Array.isArray(prior) && prior.every((symbol) => typeof symbol === 'string') ? prior : null;
        inventory.membershipChanges = { baseline: previous === null, scope: 'verified_standard_contracts',
          added: current.filter((symbol) => !previous?.includes(symbol)),
          removed: inventory.counts.identityRejected ? null : (previous || []).filter((symbol) => !current.includes(symbol)),
          removalStatus: inventory.counts.identityRejected ? 'unknown_due_to_identity_rejections' : 'observed' };
        if (!inventory.counts.identityRejected) {
          item.record.members = Object.fromEntries(Object.entries(item.record.members || {}).filter(([date, symbols]) => validOptionDate(date) && date >= sessionDate && Array.isArray(symbols)));
          item.record.members[expiry] = current;
          item.changedMembers = true;
        }
        fullInventories.push({ assetId: row.assetId, observedAt: new Date(at()).toISOString(), ...inventory });
        row.chains.push({ expiry, status: inventory.status, counts: inventory.counts, rejectionReasons: inventory.rejectionReasons,
          membershipChanges: { baseline: inventory.membershipChanges.baseline, added: inventory.membershipChanges.added.length,
            removed: inventory.membershipChanges.removed?.length ?? null, removalStatus: inventory.membershipChanges.removalStatus } });
        d.chainResponses++;
        for (const key of ['contractsReturned', 'verifiedIdentities', 'identityRejected', 'freshResearchQuotes', 'delayedResearchQuotes']) d[key] = (d[key] || 0) + inventory.counts[key];
        for (const [reason, count] of Object.entries(inventory.rejectionReasons)) tally(reason, count);
        if (selection.rotating.includes(expiry)) item.fetchedRotating++;
      } catch (error) { const failed = failure(error); row.chains.push({ expiry, status: 'chain_unavailable', ...failed }); tally(failed.reason); }
    }
    d.stageDurationsMs.chainDiscovery = Math.max(0, clock() - chainStage);
    for (const item of prepared) if (item.fetchedRotating || item.changedMembers) {
      item.record.cursor += item.fetchedRotating;
      try { await saveCache(item.file, item.record); } catch { d.rotationPersistence = 'write_failed'; }
    }
    d.deferredChains = result.underlyings.flatMap((row) => row.chains).filter((row) => row.status === 'deferred').length;
    return finish(stopReason || (d.failedOperations ? 'partial_provider_failure' : 'inventory_observed'));
  } catch (error) {
    d.failure = { reason: 'local_inventory_storage_failure' };
    return finish('inventory_storage_failure');
  } finally {
    try {
      d.archive = await archiveDiscovery({ owner: 'options', version: OPTIONS_CONTRACT_DISCOVERY_VERSION, environment,
        underlyingDiscoveryVersion: underlyingDiscovery.diagnostics.version, underlyingArchive: underlyingDiscovery.diagnostics.archive || null,
        diagnostics: { ...d }, underlyings: result.underlyings, inventories: fullInventories },
      { directory: env.OPTIONS_CONTRACT_HISTORY_PATH || '.cache/options-contract-history', now: at() });
    } catch { d.archive = { status: 'write_failed' }; }
  }
}
