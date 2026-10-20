import { requestAlpacaJson } from '../../shared/alpacaHttp.js';
import { waitForAlpacaRequest } from '../../shared/alpacaRequestGate.js';
import { archiveDiscovery } from '../../shared/equitySnapshotDiscovery.js';
import { marketDateAt } from '../../shared/marketDate.js';
import { tradierUnderlyingSymbol } from '../../shared/optionContractIdentity.js';
import { OPTIONS_DISCOVERY_VERSION } from './underlyingDiscovery.js';
import { evaluateUnderlyingResearch, reconcileUnderlyingResearch, UNDERLYING_RESEARCH_VERSION,
  UNDERLYING_RESEARCH_RULES, UNDERLYING_RESEARCH_HASH } from './underlyingResearchStrategy.js';

const DATA = 'https://data.alpaca.markets/v2/stocks';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const errorCode = (error) => error?.code || error?.cause?.code || 'provider_request_failed';
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function describeUnderlyingResearch(d = {}) {
  return `Independent intraday research: ${String(d.status || 'not_run').replaceAll('_', ' ')} · ${d.evaluated ?? 0} evaluated · ${d.dataReady ?? 0} data-ready · ${d.technicalWatches ?? 0} technical watches · ${d.conflicts ?? 0} direction conflicts. Unvalidated underlying observations; no approved option entries.`;
}

/** No production strategy, journal reservation, Discord or order dependencies are imported here. */
export async function analyzeOptionUnderlyings({ underlyingDiscovery, signalRows = [], signalMappingDiagnostics = {},
  env = process.env, now = Date.now(), clock = Date.now, observationClock = null, fetcher = fetch, sleep = defaultSleep,
  requestGate = waitForAlpacaRequest, providerMetrics = [] } = {}) {
  const started = clock(), at = () => observationClock ? observationClock() : now + Math.max(0, clock() - started);
  const source = String(env.OPTIONS_INTRADAY_RESEARCH_SOURCE || 'auto').toLowerCase();
  const feed = underlyingDiscovery?.diagnostics?.feed;
  const d = { version: UNDERLYING_RESEARCH_VERSION, configHash: UNDERLYING_RESEARCH_HASH,
    cohort: `${UNDERLYING_RESEARCH_VERSION}:${feed || 'unknown'}`, source: 'Alpaca', feed: feed ?? null,
    status: 'not_started', inputShortlist: null, selected: 0, attemptedSymbols: 0, evaluated: 0,
    dataReady: 0, technicalQualified: 0, technicalWatches: 0, conflicts: 0, deferred: 0,
    dataRejected: 0, strategyRejected: 0, providerRejected: 0, providerRequests: 0, providerFailures: 0, payloadFailures: 0, barPages: 0,
    paginationComplete: null, barsReturned: 0, quotesReturned: 0, paperEligible: 0,
    rejectionReasons: {}, stageDurationsMs: {}, mode: 'independent-underlying-research-only',
    downstreamStatus: 'independent_option_strategy_cost_catalyst_risk_and_forward_validation_pending' };
  const result = { rows: [], diagnostics: d };
  const finish = (status) => { d.status = status; d.elapsedMs = Math.max(0, clock() - started); return result; };
  if (!['auto', 'alpaca', 'disabled'].includes(source)) return finish('invalid_intraday_research_source');
  if (source === 'disabled') return finish('disabled');
  const key = env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID, secret = env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  d.missingCredentialNames = [!key && 'ALPACA_API_KEY_ID', !secret && 'ALPACA_API_SECRET_KEY'].filter(Boolean);
  if (!key || !secret) return finish('credentials_missing');
  const budget = Number(env.OPTIONS_INTRADAY_RESEARCH_BUDGET_MS || 45000);
  const maxUnderlyings = Number(env.OPTIONS_INTRADAY_RESEARCH_MAX_UNDERLYINGS || 12);
  if (!Number.isInteger(maxUnderlyings) || maxUnderlyings < 1 || maxUnderlyings > 12
    || !Number.isInteger(budget) || budget < 1000 || budget > 60000) return finish('invalid_intraday_research_configuration');
  if (underlyingDiscovery?.diagnostics?.version !== OPTIONS_DISCOVERY_VERSION || !Array.isArray(underlyingDiscovery.shortlist)) return finish('invalid_underlying_discovery');
  d.inputShortlist = underlyingDiscovery.shortlist.length;
  if (!d.inputShortlist) return finish('no_independent_shortlist');
  if (!['screen_complete', 'partial_snapshot_coverage', 'partial_provider_failure'].includes(underlyingDiscovery.diagnostics.status)) return finish('incomplete_underlying_discovery');
  if (!['iex', 'sip'].includes(feed)) return finish('invalid_research_feed');
  const { sessionOpen, sessionClose, marketOpen } = underlyingDiscovery.diagnostics;
  const open = Date.parse(sessionOpen), close = Date.parse(sessionClose);
  if (marketOpen !== true || !Number.isFinite(open) || !Number.isFinite(close) || open > at() || close <= at()
    || marketDateAt(open, 'America/New_York') !== marketDateAt(at(), 'America/New_York')) return finish('session_unavailable_or_closed');
  const deadline = started + budget, barsBySymbol = {}, quotesBySymbol = {}, rawPages = [], selected = [];
  const aliases = new Map(), identities = new Map();
  for (const row of underlyingDiscovery.shortlist) {
    const alias = tradierUnderlyingSymbol(row?.symbol);
    aliases.set(alias, (aliases.get(alias) || 0) + 1);
    identities.set(row?.assetId, (identities.get(row?.assetId) || 0) + 1);
  }
  const deferredRow = (row, reason, status = 'deferred') => ({ symbol: row?.symbol, assetId: row?.assetId,
    status, reasons: [reason], researchOnly: true, eligibleForPaper: false });
  for (const row of underlyingDiscovery.shortlist) {
    const quoteTime = Date.parse(row?.quoteAt || ''), alias = tradierUnderlyingSymbol(row?.symbol);
    const reason = !alias || typeof row?.assetId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(row.assetId) ? 'invalid_underlying_identity'
      : aliases.get(alias) > 1 || identities.get(row.assetId) > 1 ? 'ambiguous_underlying_identity'
        : !Number.isFinite(quoteTime) || quoteTime > at() || at() - quoteTime > 120000 ? 'stale_underlying_shortlist'
          : selected.length >= maxUnderlyings ? 'intraday_analysis_budget' : null;
    if (reason) result.rows.push(deferredRow(row, reason, reason === 'intraday_analysis_budget' ? 'deferred' : 'data_rejected'));
    else selected.push(row);
  }
  d.selected = selected.length;
  d.feedQuality = feed === 'iex' ? 'single-venue bars/quotes; missing minutes are not filled' : 'consolidated entitlement-dependent bars/quotes';
  let lastRequest = null, quotaRemaining = null, activeStage = null, stageStarted = null;
  const gate = (credential) => requestGate(credential, { maxWaitMs: Math.max(0, Math.min(2000, deadline - clock())) });
  gate.defer = (credential, delay) => requestGate.defer?.(credential, delay);
  gate.observe = (...args) => requestGate.observe?.(...args);
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const request = async (url, operation) => {
    if (quotaRemaining !== null && quotaRemaining <= 5) fail('provider_quota_headroom');
    if (clock() >= deadline) fail('research_time_budget');
    if (at() >= close) fail('session_closed_during_research');
    if (lastRequest !== null) {
      const delay = Math.max(0, 350 - (clock() - lastRequest));
      if (delay >= deadline - clock()) fail('research_time_budget');
      if (delay > 0) await sleep(delay);
    }
    const offset = providerMetrics.length;
    try {
      return await requestAlpacaJson(url, headers, async (target, options) => {
        if (clock() >= deadline) fail('research_time_budget');
        if (at() >= close) fail('session_closed_during_research');
        lastRequest = clock(); d.providerRequests++;
        if (operation === 'research-underlying-minute-bars') d.attemptedSymbols = selected.length;
        const response = await fetcher(target, { ...options,
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.min(8000, Math.floor(deadline - clock()))))]) });
        const value = response.headers?.get?.('X-RateLimit-Remaining');
        if (value != null && String(value).trim() !== '' && Number.isFinite(Number(value))) quotaRemaining = Number(value);
        return response;
      }, providerMetrics, `Alpaca Options ${operation}`, { maxAttempts: 1, clock, requestGate: gate });
    } finally { for (const metric of providerMetrics.slice(offset)) metric.operation ||= operation; }
  };
  try {
    if (!selected.length) return finish('no_valid_research_underlyings');
    // Fix the history cutoff before pagination; include completed bars only, even as the clock advances.
    const completedBoundary = Math.floor(at() / 60000) * 60000;
    d.historyCutoff = new Date(completedBoundary).toISOString();
    if (completedBoundary - open < UNDERLYING_RESEARCH_RULES.minBars * 60000) {
      result.rows.push(...selected.map((row) => deferredRow(row, 'opening_window_incomplete')));
      return finish('opening_window_incomplete');
    }
    const symbols = new Set(selected.map((row) => row.symbol));
    for (const symbol of symbols) barsBySymbol[symbol] = [];
    const query = new URLSearchParams({ symbols: [...symbols].join(','), timeframe: '1Min', start: sessionOpen,
      end: new Date(completedBoundary - 1).toISOString(), adjustment: 'raw',
      asof: marketDateAt(at(), 'America/New_York'), feed, sort: 'asc', limit: '10000' });
    const seen = new Set();
    d.paginationComplete = false;
    activeStage = 'history'; stageStarted = clock();
    let token = null, barStarted = clock();
    do {
      if (d.barPages >= 12) fail('history_page_budget');
      if (token) query.set('page_token', token);
      const payload = await request(`${DATA}/bars?${query}`, 'research-underlying-minute-bars');
      rawPages.push(payload); d.barPages++;
      if (!object(payload) || !object(payload.bars) || Object.keys(payload.bars).some((symbol) => !symbols.has(symbol))) fail('invalid_bar_envelope_or_identity');
      for (const [symbol, bars] of Object.entries(payload.bars)) {
        if (!Array.isArray(bars)) fail('invalid_bar_rows');
        barsBySymbol[symbol].push(...bars); d.barsReturned += bars.length;
        if (barsBySymbol[symbol].length > 390) fail('history_row_budget');
        if (bars.some((bar) => Date.parse(bar?.t) >= completedBoundary)) fail('bar_beyond_frozen_cutoff');
      }
      token = payload.next_page_token ?? null;
      if (token !== null && (typeof token !== 'string' || !token.trim() || token.length > 4096 || seen.has(token))) fail('invalid_or_repeated_page_token');
      if (token) seen.add(token);
    } while (token);
    d.paginationComplete = true;
    d.stageDurationsMs.history = Math.max(0, clock() - barStarted);
    activeStage = 'quotes'; stageStarted = clock();
    const quoteStarted = clock();
    const payload = await request(`${DATA}/quotes/latest?${new URLSearchParams({ symbols: [...symbols].join(','), feed })}`, 'research-underlying-latest-quotes');
    if (!object(payload) || !object(payload.quotes) || payload.next_page_token != null
      || Object.keys(payload.quotes).some((symbol) => !symbols.has(symbol))) fail('invalid_quote_envelope_or_identity');
    Object.assign(quotesBySymbol, payload.quotes); d.quotesReturned = Object.keys(quotesBySymbol).length;
    d.stageDurationsMs.quotes = Math.max(0, clock() - quoteStarted);
    activeStage = 'evaluation'; stageStarted = clock();
    const evaluationStarted = clock();
    for (const row of selected) {
      result.rows.push(reconcileUnderlyingResearch(evaluateUnderlyingResearch({ symbol: row.symbol, assetId: row.assetId,
        bars: barsBySymbol[row.symbol], quote: quotesBySymbol[row.symbol], sessionOpen, sessionClose, now: at(), feed }),
      { signalRows, signalMappingDiagnostics, now: at() }));
      d.evaluated++;
    }
    d.stageDurationsMs.evaluation = Math.max(0, clock() - evaluationStarted);
    return finish('research_complete');
  } catch (error) {
    const code = errorCode(error), http = Number(error.status) || null;
    const reason = ['ALPACA_PACING_DEFERRED', 'provider_quota_headroom', 'research_time_budget', 'history_page_budget', 'session_closed_during_research'].includes(code)
      ? code.toLowerCase() : [401, 403, 429].includes(http) ? 'provider_auth_or_quota_deferred' : code;
    d.failure = { reason, status: http };
    if (code.startsWith('invalid_') || code === 'bar_beyond_frozen_cutoff' || code === 'history_row_budget') d.payloadFailures++;
    d.providerFailures = providerMetrics.filter((metric) => metric.requestAttempted !== false && String(metric.operation).startsWith('research-underlying-') && (metric.error || metric.status >= 400)).length;
    d.budgetDeferrals = providerMetrics.filter((metric) => metric.requestAttempted === false && String(metric.operation).startsWith('research-underlying-')).length;
    const status = reason.includes('budget') || reason.includes('deferred') || reason === 'provider_quota_headroom' || reason === 'session_closed_during_research' ? 'deferred' : 'provider_rejected';
    result.rows.push(...selected.map((row) => deferredRow(row, reason, status)));
    return finish(status === 'deferred' ? reason : 'provider_error');
  } finally {
    if (activeStage) d.stageDurationsMs[activeStage] = Math.max(0, clock() - stageStarted);
    for (const row of result.rows) {
      for (const reason of new Set(row.reasons)) d.rejectionReasons[reason] = (d.rejectionReasons[reason] || 0) + 1;
      if (row.dataReady) d.dataReady++;
      if (row.status === 'technical_watch' || row.status === 'withheld_for_conflict') d.technicalQualified++;
      if (row.status === 'technical_watch') d.technicalWatches++;
      if (row.status === 'withheld_for_conflict') d.conflicts++;
      if (row.status === 'deferred') d.deferred++;
      if (row.status === 'data_rejected') d.dataRejected++;
      if (row.status === 'strategy_rejected') d.strategyRejected++;
      if (row.status === 'provider_rejected') d.providerRejected++;
    }
    try {
      d.archive = await archiveDiscovery({ owner: 'options', version: UNDERLYING_RESEARCH_VERSION,
        configHash: UNDERLYING_RESEARCH_HASH, rules: UNDERLYING_RESEARCH_RULES, feed,
        discoveryVersion: OPTIONS_DISCOVERY_VERSION, sessionOpen, sessionClose, selected,
        barsBySymbol, quotesBySymbol, rawPages, rows: result.rows, diagnostics: { ...d },
        upstreamContext: { signalRows: signalRows.map((row) => ({ signal: row.signal })), signalMappingDiagnostics } },
      { directory: env.OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH || '.cache/options-intraday-research', now: at() });
    } catch { d.archive = { status: 'write_failed' }; }
    d.elapsedMs = Math.max(0, clock() - started);
  }
}
