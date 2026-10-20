import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { buildOptionDayTradeCandidate } from './strategies.js';
import { fetchTradierOptionInputs, fetchTradierOptionPositionMarks } from './tradierMarketData.js';
import { waitForTradierStartSlot } from './tradierRateLimit.js';
import { runForwardShadowPaper } from '../../shared/forwardShadowPaper.js';
import { fetchFinnhubEconomicCalendar } from '../../shared/finnhubEconomicCalendar.js';
import { fetchAlpacaCatalystNews, applyAlpacaCatalystNews } from '../../shared/alpacaCatalystNews.js';
import { fetchAlpacaCallDividendScreen } from './alpacaDividendScreen.js';
import { tradierUnderlyingSymbol } from '../../shared/optionContractIdentity.js';
import { marketDateAt } from '../../shared/marketDate.js';
import { UNDERLYING_RESEARCH_VERSION, UNDERLYING_RESEARCH_HASH, UNDERLYING_RESEARCH_RULES } from './underlyingResearchStrategy.js';

export const INDEPENDENT_OPTION_PAPER_VERSION = 'independent-orb-debit-vertical-v3';
export function describeIndependentOptionPaper(d = {}) {
  return `Independent option paper: ${String(d.status || 'not_run').replaceAll('_', ' ')} · ${d.strategyCandidates ?? 0} spread candidates · ${d.shadowReservations ?? 0} isolated research reservations. Unvalidated; no approved alerts.`;
}
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const numeric = (value) => typeof value === 'number' && Number.isFinite(value);
const ms = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Immutable underlying levels must remain actionable when the later consolidated option/underlying quote arrives. */
export function buildIndependentOptionCandidate({ observation, input, now, config }) {
  const reject = (reason) => ({ status: 'no-setup', reasons: [reason], strategy: INDEPENDENT_OPTION_PAPER_VERSION });
  if (observation?.status !== 'technical_watch' || observation.version !== UNDERLYING_RESEARCH_VERSION
    || observation.configHash !== UNDERLYING_RESEARCH_HASH || !['iex', 'sip'].includes(observation.feed)
    || !['long', 'short'].includes(observation.direction) || !/^[A-Za-z0-9-]{1,80}$/.test(observation.assetId || '')
    || observation.primaryContext?.status === 'conflict') return reject('independent_hypothesis_or_identity_unverified');
  const origin = ms(observation.observedAt), closedBar = ms(observation.sessionOpen) + Number(observation.metrics?.completedMinutes) * 60000;
  if (!numeric(now) || !Number.isFinite(origin) || origin > now || now - origin > 120000
    || !Number.isFinite(closedBar) || closedBar > now || now - closedBar > UNDERLYING_RESEARCH_RULES.maxBarAgeMs) return reject('independent_observation_expired');
  if (input?.marketDataStatus !== 'ready') return { status: 'provider_or_input_rejected', strategy: INDEPENDENT_OPTION_PAPER_VERSION,
    reasons: [input?.marketDataStatus || 'independent_option_data_unavailable'] };
  const signal = input.signal, quote = signal?.underlyingQuote, levels = observation.referenceLevels, metrics = observation.metrics;
  if (tradierUnderlyingSymbol(signal?.underlyingSymbol) !== tradierUnderlyingSymbol(observation.symbol)
    || signal?.direction !== observation.direction || signal?.sessionDate !== observation.sessionDate
    || ![levels?.entry, levels?.invalidation, levels?.target, metrics?.sessionVwap, metrics?.rangeHigh, metrics?.rangeLow, metrics?.breakoutBuffer, metrics?.lastClose].every(positive)) return reject('independent_reference_levels_invalid');
  const qTime = ms(quote?.time), mid = (Number(quote?.bid) + Number(quote?.ask)) / 2;
  if (!positive(quote?.bid) || !positive(quote?.ask) || quote.ask < quote.bid || qTime > now || now - qTime > 10000
    || !Number.isFinite(qTime) || qTime < closedBar || qTime - closedBar > UNDERLYING_RESEARCH_RULES.maxBarAgeMs
    || Math.abs(mid / metrics.lastClose - 1) * 100 > UNDERLYING_RESEARCH_RULES.maxQuoteDriftPct
    || (quote.ask - quote.bid) / mid * 100 > UNDERLYING_RESEARCH_RULES.maxSpreadPct) return reject('independent_quote_not_current_or_near_reference');
  const long = observation.direction === 'long';
  if (!(long ? quote.bid > metrics.rangeHigh + metrics.breakoutBuffer && mid > metrics.sessionVwap && levels.target > quote.ask && levels.invalidation < quote.bid
    : quote.ask < metrics.rangeLow - metrics.breakoutBuffer && mid < metrics.sessionVwap && levels.target < quote.bid && levels.invalidation > quote.ask)) return reject('independent_breakout_no_longer_held');
  if (now >= ms(observation.sessionClose) - UNDERLYING_RESEARCH_RULES.entryCloseBufferMs
    || ms(signal.sessionClose) !== ms(observation.sessionClose)) return reject('independent_session_changed_or_late');
  const strategy = buildOptionDayTradeCandidate({ signal: { ...signal, underlyingTarget: levels.target },
    primarySignalObservedAt: observation.observedAt, chain: input.chain, now, config });
  if (strategy.status !== 'candidate') return strategy;
  const candidate = { ...strategy.candidate, strategyId: INDEPENDENT_OPTION_PAPER_VERSION,
    option: { ...strategy.candidate.option, entryValidation: { ...strategy.candidate.option.entryValidation,
      breakout: { rangeHigh: metrics.rangeHigh, rangeLow: metrics.rangeLow, buffer: metrics.breakoutBuffer, vwap: metrics.sessionVwap } } },
    idempotencyKey: `${observation.assetId}:${observation.sessionDate}:${observation.direction}:independent-vertical:${input.chain.expiry}`,
    marketGateTrace: null,
    signal: { independentResearch: { version: UNDERLYING_RESEARCH_VERSION, configHash: UNDERLYING_RESEARCH_HASH,
      feed: observation.feed, assetId: observation.assetId, observedAt: observation.observedAt, referenceLevels: levels } },
    researchContext: { ...strategy.candidate.researchContext, setupType: 'independent_orb_debit_vertical',
      features: { ...strategy.candidate.researchContext.features, underlying_relative_volume: metrics.relativeVolume,
        underlying_vwap: metrics.sessionVwap, underlying_reference_target: levels.target, underlying_invalidation: levels.invalidation } } };
  return { ...strategy, strategy: INDEPENDENT_OPTION_PAPER_VERSION, candidate };
}

function reviewMap(records) {
  const values = new Map(), duplicates = new Set();
  for (const row of Array.isArray(records) ? records : []) {
    const key = tradierUnderlyingSymbol(row?.symbol);
    if (!key) continue;
    if (values.has(key)) duplicates.add(key);
    values.set(key, row);
  }
  for (const key of duplicates) values.delete(key);
  return values;
}

async function preserveUnderlyingInputs(intradayResearch, selected, { directory, env, now }) {
  const file = intradayResearch?.diagnostics?.archive?.file;
  if (typeof file !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-f0-9]{24}\.json\.gz$/.test(file)) fail('underlying_archive_missing');
  const compressed = await readFile(resolve(env.OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH || '.cache/options-intraday-research', file));
  const encoded = gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
  const hash = createHash('sha256').update(encoded).digest('hex');
  if (!file.includes(`-${hash.slice(0, 24)}.`)) fail('underlying_archive_hash_mismatch');
  const saved = JSON.parse(encoded.toString('utf8'));
  if (saved.owner !== 'options' || saved.version !== UNDERLYING_RESEARCH_VERSION || saved.configHash !== UNDERLYING_RESEARCH_HASH
    || saved.feed !== intradayResearch.diagnostics.feed || !Number.isFinite(ms(saved.capturedAt)) || ms(saved.capturedAt) > now
    || !Array.isArray(saved.rows) || !saved.barsBySymbol || !saved.quotesBySymbol) fail('underlying_archive_provenance_invalid');
  for (const watch of selected) {
    const original = saved.rows.find((row) => row.symbol === watch.symbol && row.assetId === watch.assetId);
    if (JSON.stringify(original) !== JSON.stringify(watch) || !Array.isArray(saved.barsBySymbol[watch.symbol])
      || !saved.barsBySymbol[watch.symbol].length || !saved.quotesBySymbol[watch.symbol]) fail('underlying_archive_observation_mismatch');
  }
  const folder = resolve(directory, 'underlying-inputs');
  await mkdir(folder, { recursive: true });
  const target = resolve(folder, file);
  try { await writeFile(target, compressed, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(target)).equals(compressed)) fail('frozen_underlying_inputs_changed');
  }
  return { status: 'preserved', file: `underlying-inputs/${file}`, sha256: hash, retention: 'persistent; no automatic pruning' };
}

/** Independent no-alert paper experiment. Production reservations are read for risk only, never written here. */
export async function runIndependentOptionPaper({ intradayResearch, reviews = {}, strategyConfig = {}, riskPolicy = {},
  accountEquity, portfolioStatePath, stateDirectory, env = process.env, now = Date.now(), clock = Date.now, observationClock = null,
  fetcher = fetch, providerMetrics = [], startPacer = waitForTradierStartSlot } = {}) {
  if (observationClock !== null && typeof observationClock !== 'function') throw new TypeError('Independent observation clock must be a function.');
  const started = clock();
  let lastObservation = now;
  const at = () => {
    if (!observationClock) return now + Math.max(0, clock() - started);
    const current = observationClock();
    if (!Number.isFinite(current) || current < lastObservation) throw new RangeError('Independent observation time must be finite and monotonic.');
    lastObservation = current;
    return current;
  };
  at();
  const source = String(env.OPTIONS_INDEPENDENT_PAPER_SOURCE || 'auto').trim().toLowerCase();
  const d = { version: INDEPENDENT_OPTION_PAPER_VERSION, status: 'not_started', paperOnly: true, publishedAsApproved: false,
    technicalWatches: 0, selected: 0, providerReady: 0, strategyCandidates: 0, shadowReservations: 0,
    productionReservations: 0, rejectionReasons: {}, providerRequests: 0, stageDurationsMs: {} };
  const result = { diagnostics: d, inputs: [], evaluations: [], forward: [] };
  const finish = (status) => { d.status = status; d.elapsedMs = Math.max(0, clock() - started); return result; };
  if (!['auto', 'tradier', 'disabled'].includes(source)) return finish('invalid_independent_paper_source');
  if (source === 'disabled') return finish('disabled');
  if (!env.TRADIER_TOKEN) return finish('credentials_missing');
  if (String(env.TRADIER_ENV || 'sandbox').trim().toLowerCase() !== 'production') return finish('sandbox_quotes_not_executable');
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)
    || reviews.reviews !== undefined && !Array.isArray(reviews.reviews)
    || reviews.assignmentReviews !== undefined && !Array.isArray(reviews.assignmentReviews)) return finish('invalid_review_input');
  if (!stateDirectory || !portfolioStatePath) return finish('shared_risk_or_research_path_missing');
  const maxUnderlyings = Number(env.OPTIONS_INDEPENDENT_PAPER_MAX_UNDERLYINGS || 3);
  const budget = Number(env.OPTIONS_INDEPENDENT_PAPER_BUDGET_MS || 45000);
  if (!Number.isInteger(maxUnderlyings) || maxUnderlyings < 1 || maxUnderlyings > 12 || !Number.isInteger(budget) || budget < 1000 || budget > 60000) return finish('invalid_independent_paper_configuration');
  const catalystSource = env.OPTIONS_CATALYST_SOURCE || 'manual', dividendSource = env.OPTIONS_ASSIGNMENT_DATA_SOURCE || 'manual';
  if (!['manual', 'finnhub', 'alpaca', 'finnhub+alpaca'].includes(catalystSource) || !['manual', 'alpaca'].includes(dividendSource)) return finish('invalid_catalyst_configuration');
  const deadline = started + budget, directory = resolve(stateDirectory, 'options-independent');
  const quota = new Map();
  const boundedFetch = async (url, options = {}) => {
    if (String(options.method || 'GET').toUpperCase() !== 'GET') fail('research_only_get_requests');
    const parsed = new URL(url);
    if (!['api.tradier.com', 'data.alpaca.markets', 'finnhub.io'].includes(parsed.hostname)) fail('unsupported_research_provider');
    if (clock() >= deadline) fail('research_time_budget');
    if (quota.get(parsed.hostname) <= 5) fail('research_quota_headroom');
    d.providerRequests++;
    const signal = AbortSignal.timeout(Math.max(1, Math.min(8000, Math.floor(deadline - clock()))));
    const response = await fetcher(url, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
    const remaining = response.headers?.get?.(parsed.hostname === 'api.tradier.com' ? 'X-Ratelimit-Available' : 'X-RateLimit-Remaining');
    if (remaining != null && String(remaining).trim() && Number.isFinite(Number(remaining))) quota.set(parsed.hostname, Number(remaining));
    if ([401, 403, 429].includes(response.status)) quota.set(parsed.hostname, 0);
    return response;
  };
  const boundedPacer = (token, environment, options = {}) => startPacer(token, environment, { ...options, maxWaitMs: Math.max(0, Math.min(2000, deadline - clock())) });
  boundedPacer.deferStarts = (...args) => startPacer.deferStarts?.(...args);
  boundedPacer.observe = (...args) => startPacer.observe?.(...args);
  const tradier = () => ({ token: env.TRADIER_TOKEN, environment: 'production', fetchImpl: boundedFetch,
    now: at(), clockNow: clock, providerMetrics, startPacer: boundedPacer, deadline, maxAttempts: 1, maxRetryWaitMs: 0,
    maxQuoteAgeMs: strategyConfig.maxQuoteAgeMs ?? 10000, maxLegSkewMs: strategyConfig.maxLegSkewMs ?? 3000 });
  const selected = [], watches = Array.isArray(intradayResearch?.rows) ? intradayResearch.rows.filter((row) => row.status === 'technical_watch') : [];
  d.technicalWatches = watches.length;
  const catalysts = reviewMap(reviews.reviews), assignments = reviewMap(reviews.assignmentReviews);
  const aliases = new Map();
  for (const watch of watches) aliases.set(tradierUnderlyingSymbol(watch.symbol), (aliases.get(tradierUnderlyingSymbol(watch.symbol)) || 0) + 1);
  for (const watch of watches) {
    const reason = watch.version !== UNDERLYING_RESEARCH_VERSION || watch.configHash !== UNDERLYING_RESEARCH_HASH ? 'independent_hypothesis_unverified'
      : aliases.get(tradierUnderlyingSymbol(watch.symbol)) > 1 ? 'ambiguous_independent_underlying'
        : selected.length >= maxUnderlyings ? 'independent_option_analysis_budget'
          : !Number.isFinite(ms(watch.observedAt)) || ms(watch.observedAt) > at() || at() - ms(watch.observedAt) > 120000 ? 'independent_observation_expired' : null;
    if (reason) result.evaluations.push({ symbol: watch.symbol, status: 'provider_or_input_rejected', reasons: [reason] });
    else selected.push(watch);
  }
  d.selected = selected.length;
  const feed = intradayResearch?.diagnostics?.feed || 'unknown';
  const { now: _policyTime, emergencyStop: _stop, liveTradingEnabled: _live, ...frozenRisk } = riskPolicy;
  const config = { ...strategyConfig, catalystSource, requireDividendProvider: dividendSource === 'alpaca',
    independentDefinition: { version: UNDERLYING_RESEARCH_VERSION, ruleHash: UNDERLYING_RESEARCH_HASH, feed,
      catalystSource, dividendSource, accountEquity, risk: frozenRisk, decisionClockVersion: 'current-observation-v2' } };
  const profile = { id: 'independent-orb', overrides: { maxLegSpreadPct: strategyConfig.maxLegSpreadPct ?? 15 },
    hypothesis: 'The frozen independent underlying opening-range hypothesis can support positive after-cost intraday debit-vertical expectancy.',
    changeMade: 'Source direction from independent provider-backed intraday research; preserve the existing option and shared-risk gates.',
    reason: 'Measure independent opportunities prospectively without promoting an unvalidated strategy or requiring primary-bot alerts.' };
  const shadow = (observations, loadOpenOrderQuotes) => runForwardShadowPaper({ owner: 'options', profiles: [profile],
    allowlist: ['maxLegSpreadPct'], baseConfig: config, strategyVersion: INDEPENDENT_OPTION_PAPER_VERSION, observations,
    evaluate: (observation, configuration, time) => buildIndependentOptionCandidate({ ...observation, now: time, config: configuration }),
    loadOpenOrderQuotes, stateDirectory: directory, portfolioStatePath, now: at(), observationClock: at, accountEquity,
    riskPolicy: { ...riskPolicy, emergencyStop: riskPolicy.emergencyStop !== false, liveTradingEnabled: false },
    maxQuoteAgeMs: strategyConfig.maxQuoteAgeMs ?? 10000, maxSpreadPct: riskPolicy.maxSpreadPct ?? 25,
    sessionDate: marketDateAt(at(), 'America/New_York'), sessionOpen: true, externalRiskMode: 'independent',
    allowManifestFreeze: d.strategyCandidates > 0 });
  try {
    // Track old contracts even when they leave the shortlist, no entry qualifies, or the paper stop is active.
    let stage = clock();
    result.forward = await shadow([], async (profiles) => {
      const maps = new Map(profiles.map((row) => [row.profileId, new Map()]));
      const orders = profiles.flatMap((row) => row.orders);
      if (!orders.length) { d.positionMarks = { status: 'no_open_option_positions', positions: 0 }; return maps; }
      try {
        // Pending entries may no longer be on the shortlist. Read the current review
        // file at monitoring time instead of reusing the discovery scan's reviews.
        const marks = await fetchTradierOptionPositionMarks(orders, { ...tradier(), entryReviewOptions: { env } });
        d.positionMarks = marks.diagnostics;
        for (const profile of profiles) for (const order of profile.orders) {
          const mark = marks.marks.find((row) => row.orderId === order.orderId);
          if (mark?.sessionOpen === true) maps.get(profile.profileId).set(order.instrumentKey.toUpperCase(), mark.quote);
        }
      } catch (error) { d.positionMarks = { status: 'provider_error', reason: error.code || error.cause?.code || 'request_failed' }; }
      return maps;
    });
    d.stageDurationsMs.positionMonitoring = Math.max(0, clock() - stage);
    if (!selected.length) return finish('no_independent_watches');
    d.underlyingInputs = await preserveUnderlyingInputs(intradayResearch, selected, { directory, env, now: at() });
    // Unknown costs never default to free; monitoring above still runs.
    if (![config.feePerContractRoundTrip, config.slippageReservePerContract].every((value) => numeric(value) && value >= 0)) {
      result.evaluations.push(...selected.map((row) => ({ symbol: row.symbol, status: 'no-setup', reasons: ['independent_execution_costs_unconfigured'] })));
      return finish('execution_costs_unconfigured');
    }
    let rows = selected.map((watch) => ({ observation: watch, signal: { underlyingSymbol: watch.symbol,
      sessionDate: watch.sessionDate, direction: watch.direction, underlyingPrice: watch.referenceLevels?.entry,
      underlyingTarget: watch.referenceLevels?.target, underlyingStop: watch.referenceLevels?.invalidation, observedAt: watch.observedAt,
      // A bounded reference zone avoids rebasing a missed move into a new target.
      entryLow: watch.referenceLevels?.entry * 0.9975, entryHigh: watch.referenceLevels?.entry * 1.0025,
      catalystReview: catalysts.get(tradierUnderlyingSymbol(watch.symbol)) || { status: 'missing' },
      optionAssignmentReview: assignments.get(tradierUnderlyingSymbol(watch.symbol)) || { status: 'missing' } } }));
    stage = clock();
    const targets = rows.map((row) => row.signal.underlyingSymbol);
    if (catalystSource.includes('finnhub')) {
      const calendar = await fetchFinnhubEconomicCalendar({ token: env.FINNHUB_API_KEY || '', marketDate: marketDateAt(at(), 'America/New_York'),
        instruments: targets, countryCodesByInstrument: Object.fromEntries(targets.map((symbol) => [symbol, ['US']])), now: at(), fetcher: boundedFetch,
        cache: fetcher === fetch, metrics: providerMetrics, clock, maxAttempts: 1 });
      rows = rows.map((row) => ({ ...row, signal: { ...row.signal, catalystReview: calendar.reviews[row.signal.underlyingSymbol] } }));
      d.calendar = calendar.diagnostics;
    }
    if (catalystSource.includes('alpaca')) {
      const news = await fetchAlpacaCatalystNews(targets, { key: env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID,
        secret: env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY, now: at(), fetcher: boundedFetch, metrics: providerMetrics });
      rows = applyAlpacaCatalystNews(rows, news, { now: at() }); d.companyNews = news.diagnostics;
    }
    d.stageDurationsMs.catalysts = Math.max(0, clock() - stage);
    stage = clock();
    rows = await fetchTradierOptionInputs(rows, { ...tradier(), refreshUnderlyingAfterChains: true,
      maxCatalystReviewAgeMs: strategyConfig.maxCatalystReviewAgeMs ?? 1800000,
      minDaysToExpiry: strategyConfig.minDaysToExpiry ?? 1, maxDaysToExpiry: strategyConfig.maxDaysToExpiry ?? 45 });
    d.stageDurationsMs.optionData = Math.max(0, clock() - stage);
    if (dividendSource === 'alpaca') {
      const dividends = await fetchAlpacaCallDividendScreen(rows, { key: env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID,
        secret: env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY, fetcher: boundedFetch, metrics: providerMetrics, clock, maxAttempts: 1 });
      rows = dividends.rows; d.dividends = dividends.diagnostics;
    }
    result.inputs = rows;
    d.providerReady = rows.filter((row) => row.marketDataStatus === 'ready').length;
    result.evaluations.push(...rows.map((input) => ({ symbol: input.observation.symbol,
      ...buildIndependentOptionCandidate({ observation: input.observation, input, now: at(), config }) })));
    d.strategyCandidates = result.evaluations.filter((row) => row.status === 'candidate').length;
    // Freeze first; only later quotes/scans can reserve and later still can fill in this isolated cohort.
    result.forward = await shadow(rows.map((input) => ({ instrumentKey: input.observation.symbol, observation: input.observation, input })));
    d.shadowReservations = result.forward.reduce((sum, row) => sum + row.counts.reservations, 0);
    return finish('research_observed');
  } catch (error) {
    const reason = error.code || error.cause?.code || 'independent_provider_or_state_failure';
    d.failure = { reason };
    result.evaluations.push(...selected.map((row) => ({ symbol: row.symbol, status: 'provider_or_input_rejected', reasons: [reason] })));
    return finish('research_unavailable');
  } finally {
    for (const row of result.evaluations) for (const reason of new Set(row.reasons || [])) d.rejectionReasons[reason] = (d.rejectionReasons[reason] || 0) + 1;
    d.forwardGates = { manifests: result.forward.map((row) => row.manifest.status),
      riskBlocked: result.forward.reduce((sum, row) => sum + row.counts.riskBlocked, 0),
      rejectionReasons: result.forward.reduce((all, row) => {
        for (const [reason, count] of Object.entries(row.topRejectionReasons || {})) all[reason] = (all[reason] || 0) + count;
        return all;
      }, {}) };
    // Durable research inputs supplement the short-retention discovery archives. No token or request headers are stored.
    try {
      await mkdir(directory, { recursive: true });
      const event = { version: INDEPENDENT_OPTION_PAPER_VERSION, observedAt: new Date(at()).toISOString(),
        underlyingRuleHash: UNDERLYING_RESEARCH_HASH, feed, inputs: result.inputs, evaluations: result.evaluations,
        diagnostics: { ...d }, experiments: result.forward.map((row) => ({ id: row.id, experimentHash: row.experimentHash, manifest: row.manifest })) };
      const eventHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      await appendFile(resolve(directory, `observations-${marketDateAt(at(), 'America/New_York')}.jsonl`), JSON.stringify({ eventHash, ...event }) + '\n', { encoding: 'utf8', mode: 0o600 });
      d.observationJournal = { status: 'recorded', eventHash, retention: 'persistent; no automatic pruning' };
    } catch { d.observationJournal = { status: 'write_failed' }; }
    d.elapsedMs = Math.max(0, clock() - started);
  }
}
