import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requestAlpacaJson } from '../../shared/alpacaHttp.js';
import { archiveDiscovery, screenFullEquityMarket } from '../../shared/equitySnapshotDiscovery.js';
import { marketDateAt } from '../../shared/marketDate.js';

export const OPTIONS_DISCOVERY_VERSION = 'options-independent-underlyings-v1';
const API = 'https://paper-api.alpaca.markets/v2';
const DATA = 'https://data.alpaca.markets/v2';
const LISTINGS = new Set(['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'NYSEARCA', 'BATS']);
const OPTION_ATTRIBUTES = new Set(['has_options', 'options_enabled']);
const bounded = (value, length) => typeof value === 'string' && value.trim().length <= length ? value.trim() : '';
const tally = (rows) => {
  const counts = {};
  for (const row of rows) for (const reason of row.reasons) counts[reason] = (counts[reason] || 0) + 1;
  return counts;
};

/** Provider flags discover possible underlyings, not verified active/executable contracts. */
export function classifyOptionableAssets(payload) {
  if (!Array.isArray(payload)) throw new TypeError('Alpaca assets must be a complete array, not an envelope/page.');
  const records = payload.map((row) => ({
    id: bounded(row?.id, 80), symbol: bounded(row?.symbol, 32).toUpperCase(),
    status: bounded(row?.status, 20), class: bounded(row?.class, 30), exchange: bounded(row?.exchange, 30),
    tradable: row?.tradable === true,
    attributes: Array.isArray(row?.attributes) ? [...new Set(row.attributes.filter((value) => OPTION_ATTRIBUTES.has(value) || value === 'options_late_close'))].sort() : [],
  }));
  const ids = new Map(), symbols = new Map();
  // An inactive historical listing must not invalidate a unique current listing of the same ticker.
  for (const row of records.filter((item) => item.status === 'active' && item.class === 'us_equity')) {
    ids.set(row.id, (ids.get(row.id) || 0) + 1); symbols.set(row.symbol, (symbols.get(row.symbol) || 0) + 1);
  }
  const rows = records.map((record) => {
    const reasons = [];
    if (record.status !== 'active') reasons.push('inactive_listing');
    if (record.class !== 'us_equity') reasons.push('unsupported_asset_class');
    if (!/^[A-Za-z0-9-]{1,80}$/.test(record.id) || !/^[A-Z][A-Z0-9./-]{0,15}$/.test(record.symbol)) reasons.push('invalid_provider_identity');
    if (record.status === 'active' && record.class === 'us_equity' && (ids.get(record.id) > 1 || symbols.get(record.symbol) > 1)) reasons.push('ambiguous_active_identity');
    if (!LISTINGS.has(record.exchange)) reasons.push(record.exchange === 'OTC' ? 'feed_does_not_cover_otc' : 'unsupported_listing_feed');
    if (!record.attributes.some((value) => OPTION_ATTRIBUTES.has(value))) reasons.push('optionable_attribute_missing');
    return { ...record, status: reasons.length ? 'excluded' : 'eligible', listingStatus: record.status, reasons };
  });
  const eligible = rows.filter((row) => row.status === 'eligible').sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { records, rows, eligible, diagnostics: {
    providerInstruments: records.length, activeInstruments: records.filter((row) => row.status === 'active').length,
    eligibleInstruments: eligible.length, excludedInstruments: rows.length - eligible.length,
    underlyingTradable: eligible.filter((row) => row.tradable).length,
    attributeCounts: Object.fromEntries([...OPTION_ATTRIBUTES].map((flag) => [flag, records.filter((row) => row.attributes.includes(flag)).length])),
    rejectionReasons: tally(rows),
    coverage: 'Alpaca US equity asset master, including flagged stock and ETP underlyings; does not enumerate index options, futures options or other venues outside this provider.',
    identityNote: 'A has_options/options_enabled flag can describe expired contracts. Current expirations and complete chains must be verified separately. Equity tradable is metadata, not Options broker authorization.',
  } };
}

function membershipChanges(previous, current) {
  if (!previous) return { baseline: true, added: current.map((row) => ({ id: row.id, symbol: row.symbol })), removed: [] };
  const old = new Map(previous.map((row) => [row.id + ':' + row.symbol, row]));
  const next = new Map(current.map((row) => [row.id + ':' + row.symbol, row]));
  const brief = ([, row]) => ({ id: row.id, symbol: row.symbol });
  return { baseline: false, added: [...next].filter(([id]) => !old.has(id)).map(brief), removed: [...old].filter(([id]) => !next.has(id)).map(brief) };
}

/** No stale fallback. Failed refreshes cannot silently preserve delisted/old membership. */
async function loadDirectory({ request, cachePath, scope, now, maxAgeMs }) {
  let previous = null;
  try {
    const saved = JSON.parse(await readFile(cachePath, 'utf8'));
    if (saved.version === OPTIONS_DISCOVERY_VERSION && saved.scope === scope && Array.isArray(saved.records)
      && Number.isFinite(saved.capturedAt) && saved.capturedAt <= now) previous = saved;
  } catch { /* Missing/corrupt cache is refetched, never substituted with seeds. */ }
  if (previous && now - previous.capturedAt < maxAgeMs
    && marketDateAt(previous.capturedAt, 'America/New_York') === marketDateAt(now, 'America/New_York')) {
    const parsed = classifyOptionableAssets(previous.records);
    return { ...parsed, cache: 'fresh', capturedAt: previous.capturedAt,
      changes: { baseline: false, added: [], removed: [] } };
  }
  const parsed = classifyOptionableAssets(await request(`${API}/assets?asset_class=us_equity`, 'optionable-asset-master'));
  const changes = membershipChanges(previous ? classifyOptionableAssets(previous.records).eligible : null, parsed.eligible);
  await mkdir(dirname(cachePath), { recursive: true });
  const temp = cachePath + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify({ version: OPTIONS_DISCOVERY_VERSION, scope, capturedAt: now, records: parsed.records }), { mode: 0o600, flag: 'wx' });
  await rename(temp, cachePath);
  return { ...parsed, cache: 'refreshed', capturedAt: now, changes };
}

export function describeOptionsDiscovery(diagnostics = {}) {
  const count = (value) => Number.isInteger(value) && value >= 0 ? String(value) : 'unknown';
  const label = ({ credentials_missing: 'Alpaca keys missing', screen_complete: 'screen complete',
    provider_error: 'data request failed', provider_auth_or_quota_deferred: 'remaining work deferred by provider',
    partial_snapshot_coverage: 'partial snapshot coverage', scan_time_budget: 'remaining work deferred by time budget',
    market_closed: 'session closed' })[diagnostics.status] || String(diagnostics.status || 'not run').replaceAll('_', ' ');
  return `Independent discovery: ${label} · ${count(diagnostics.eligibleInstruments)} eligible underlyings · ${count(diagnostics.cheapScreen?.attemptedSymbols)} snapshot attempts · ${count(diagnostics.cheapScreen?.cheaplyScreened)} usable snapshots · ${count(diagnostics.cheapScreen?.shortlisted)} research shortlist. This is coverage research, not approved option setups.`;
}

/** Runs independently of upstream alerts. This phase cannot emit orders or approved signals. */
export async function discoverOptionUnderlyings({ env = process.env, now = Date.now(), fetcher = fetch,
  providerMetrics = [], clock = Date.now, observationClock = null, sleep, requestOptions = {} } = {}) {
  const started = clock(), observedNow = () => observationClock ? observationClock() : now + Math.max(0, clock() - started);
  const source = String(env.OPTIONS_DISCOVERY_SOURCE || 'auto').toLowerCase();
  const feed = String(env.OPTIONS_DISCOVERY_FEED || 'iex').toLowerCase();
  const result = { shortlist: [], diagnostics: { version: OPTIONS_DISCOVERY_VERSION, source: 'Alpaca', feed,
    status: 'not_started', providerInstruments: null, activeInstruments: null, eligibleInstruments: null,
    cheapScreen: null, strategyInputs: 0, mode: 'independent-discovery-research',
    downstreamStatus: 'independent_contract_and_strategy_pipeline_pending', marketOpen: null } };
  const finish = (status) => { result.diagnostics.status = status; result.diagnostics.elapsedMs = Math.max(0, clock() - started); return result; };
  if (!['auto', 'alpaca', 'disabled'].includes(source)) return finish('invalid_discovery_source');
  if (source === 'disabled') return finish('disabled');
  if (!['iex', 'sip'].includes(feed)) return finish('invalid_feed');
  const key = env.ALPACA_API_KEY_ID || env.APCA_API_KEY_ID, secret = env.ALPACA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  result.diagnostics.missingCredentialNames = [!key && 'ALPACA_API_KEY_ID', !secret && 'ALPACA_API_SECRET_KEY'].filter(Boolean);
  if (!key || !secret) return finish('credentials_missing');
  const maxCandidates = Number(env.OPTIONS_DISCOVERY_MAX_CANDIDATES || 12);
  const maxAgeMs = Number(env.OPTIONS_DISCOVERY_MAX_QUOTE_AGE_MS || 15_000);
  const refreshMs = Number(env.OPTIONS_DIRECTORY_REFRESH_MS || 6 * 60 * 60_000);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 200 || !(maxAgeMs > 0 && maxAgeMs <= 60_000)
    || !(refreshMs >= 60_000 && refreshMs <= 24 * 60 * 60_000)) return finish('invalid_discovery_configuration');
  const headers = { accept: 'application/json', 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const request = async (url, operation) => {
    const offset = providerMetrics.length;
    try { return await requestAlpacaJson(url, headers, fetcher, providerMetrics, `Alpaca Options ${operation}`, requestOptions); }
    finally { for (const metric of providerMetrics.slice(offset)) metric.operation ||= operation; }
  };
  let directory, rows = [];
  try {
    const directoryStarted = clock();
    directory = await loadDirectory({ request, now: observedNow(), maxAgeMs: refreshMs,
      cachePath: resolve(env.OPTIONS_DIRECTORY_CACHE_PATH || '.cache/options-underlying-directory.json'),
      scope: createHash('sha256').update(API + '\n' + key).digest('hex') });
    Object.assign(result.diagnostics, directory.diagnostics, { directoryCache: directory.cache,
      directoryCapturedAt: new Date(directory.capturedAt).toISOString(), directoryAgeMs: observedNow() - directory.capturedAt,
      membershipChanges: { baseline: directory.changes.baseline, added: directory.changes.added.length, removed: directory.changes.removed.length },
      directoryDurationMs: Math.max(0, clock() - directoryStarted), feedQuality: feed === 'iex' ? 'single-venue research' : 'consolidated entitlement-dependent research' });
    rows = directory.rows;
    if (!directory.eligible.length) return finish('no_eligible_optionable_underlyings');
    const session = await request(`${API}/clock`, 'discovery-market-clock');
    const time = Date.parse(session?.timestamp || ''), nextOpen = Date.parse(session?.next_open || ''), close = Date.parse(session?.next_close || '');
    if (!Number.isFinite(time) || time > observedNow() + 5_000 || observedNow() - time > 30_000 || typeof session?.is_open !== 'boolean') return finish('invalid_market_clock');
    result.diagnostics.marketOpen = session.is_open;
    if (!session.is_open) return finish('market_closed');
    const date = marketDateAt(observedNow(), 'America/New_York');
    const calendar = await request(`${API}/calendar?start=${date}&end=${date}`, 'discovery-market-calendar');
    const day = Array.isArray(calendar) && calendar.find((row) => row.date === date);
    // Anchor today's open to the exchange date using the provider's timezone-bearing clock.
    const clockDate = marketDateAt(time, 'America/New_York');
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
      .formatToParts(new Date(time)).find((part) => part.type === 'timeZoneName')?.value.replace('GMT', '');
    const open = day && /^\d{2}:\d{2}$/.test(day.open) ? Date.parse(`${date}T${day.open}:00${offset}`) : NaN;
    const calendarClose = day && /^\d{2}:\d{2}$/.test(day.close) ? Date.parse(`${date}T${day.close}:00${offset}`) : NaN;
    if (clockDate !== date || ![open, close, calendarClose, nextOpen].every(Number.isFinite)
      || open > observedNow() || close <= observedNow() || close !== calendarClose) return finish('invalid_market_session');
    result.diagnostics.sessionOpen = new Date(open).toISOString();
    result.diagnostics.sessionClose = new Date(close).toISOString();
    const screen = await screenFullEquityMarket({ assets: directory.eligible, now: observedNow(), openTime: open, closeTime: close,
      maxAgeMs, maxCandidates, clock, observationClock, ...(sleep ? { sleep } : {}), version: OPTIONS_DISCOVERY_VERSION,
      deadlineTime: now + 60_000,
      requestSnapshots: (symbols) => request(`${DATA}/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=${feed}`, 'underlying-snapshots') });
    result.diagnostics.cheapScreen = screen.diagnostics;
    const bySymbol = new Map(screen.rows.map((row) => [row.symbol, row]));
    rows = rows.map((row) => row.status === 'eligible' ? { ...row, ...bySymbol.get(row.symbol) } : row);
    result.shortlist = screen.shortlist.map((symbol) => ({ ...bySymbol.get(symbol), assetId: directory.eligible.find((row) => row.symbol === symbol).id,
      researchOnly: true, direction: null, strategyApproved: false }));
    return finish(screen.diagnostics.status);
  } catch (error) {
    result.diagnostics.failure = { operation: error.providerOperation || 'directory_or_session',
      status: Number(error.status ?? error.cause?.status) || null, reason: 'provider_or_payload_failure' };
    return finish('provider_error');
  } finally {
    if (directory) {
      try {
        result.diagnostics.archive = await archiveDiscovery({ owner: 'options', version: OPTIONS_DISCOVERY_VERSION,
          feed, status: result.diagnostics.status, rows, shortlist: result.shortlist, membershipChanges: directory.changes,
          counts: { ...result.diagnostics } }, { directory: env.OPTIONS_DISCOVERY_HISTORY_PATH || '.cache/options-discovery-history', now: observedNow() });
      } catch { result.diagnostics.archive = { status: 'write_failed' }; }
    }
  }
}
