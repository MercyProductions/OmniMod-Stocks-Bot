import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const sleepDefault = (ms) => new Promise((done) => setTimeout(done, ms));
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Ranking is a workload allocation heuristic, not a probability or a strategy approval. */
export function screenEquitySnapshot(symbol, snapshot, { now, openTime, maxAgeMs = 15_000 } = {}) {
  const row = { symbol, status: 'excluded', reasons: [], observedAt: new Date(now).toISOString() };
  const reject = (reason) => { row.reasons.push(reason); return row; };
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return reject('snapshot_missing');
  const quote = snapshot.latestQuote, day = snapshot.dailyBar, previous = snapshot.prevDailyBar;
  const bid = finiteNumber(quote?.bp), ask = finiteNumber(quote?.ap), time = Date.parse(quote?.t || '');
  if (!(bid > 0 && ask >= bid)) return reject('invalid_bid_ask');
  if (!Number.isFinite(time) || time < openTime || time > now || now - time > maxAgeMs) return reject('stale_or_future_quote');
  const dayTime = Date.parse(day?.t || '');
  // Daily bars are stamped at the start of the exchange date, not at their latest update.
  const marketDate = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  if (!Number.isFinite(dayTime) || dayTime > now || marketDate(dayTime) !== marketDate(now)) return reject('daily_bar_not_current_session');
  const open = finiteNumber(day?.o), close = finiteNumber(day?.c), high = finiteNumber(day?.h), low = finiteNumber(day?.l), volume = finiteNumber(day?.v);
  if (!(open > 0 && close > 0 && low > 0 && high >= Math.max(open, close) && low <= Math.min(open, close) && volume > 0)) return reject('invalid_or_inactive_daily_bar');
  if (![volume * close, high / open, close / open, (bid + ask) / 2].every(Number.isFinite)) return reject('invalid_or_inactive_daily_bar');
  const previousTime = Date.parse(previous?.t || ''), previousClose = finiteNumber(previous?.c);
  const priorValid = previousClose > 0 && Number.isFinite(previousTime) && previousTime < dayTime && dayTime - previousTime <= 7 * 86_400_000;
  const midpoint = (bid + ask) / 2;
  row.status = 'screened';
  row.quoteAt = new Date(time).toISOString();
  row.bid = bid; row.ask = ask;
  row.spreadPct = (ask - bid) / midpoint * 100;
  row.sessionMovePct = (close / open - 1) * 100;
  row.changePct = priorValid ? (close / previousClose - 1) * 100 : null;
  row.gapPct = priorValid ? (open / previousClose - 1) * 100 : null;
  row.rangePct = (high - low) / open * 100;
  row.sessionVolume = volume;
  row.sessionDollarVolume = volume * close;
  // A missing prior close (e.g. new listing) does not make a current security invisible.
  row.rankingScore = Math.abs(row.changePct ?? row.sessionMovePct) + row.rangePct
    + Math.abs(row.gapPct ?? 0) / 2 + Math.log10(1 + row.sessionDollarVolume) / 10;
  return row;
}

/** Bounded GET batches cover every eligible member before the deep-analysis cap. */
export async function screenFullEquityMarket({ assets, requestSnapshots, now, openTime, closeTime,
  maxAgeMs = 15_000, maxCandidates = 200, priorities = [], batchSize = 100,
  minimumIntervalMs = 350, sleep = sleepDefault, clock = Date.now, observationClock = null, version = 'equity-full-directory-v1', deadlineTime = Infinity } = {}) {
  if (!Array.isArray(assets) || new Set(assets.map((row) => row.symbol)).size !== assets.length) throw new TypeError('Equity screen requires unique assets.');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 200) throw new RangeError('Equity deep-analysis budget must be an integer from 1 to 200.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new RangeError('Equity snapshot batch size must be from 1 to 100.');
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new RangeError('Equity screen timing configuration is invalid.');
  if (![now, openTime, closeTime].every(Number.isFinite) || closeTime <= openTime) throw new RangeError('Equity screen requires a valid session.');
  if (observationClock !== null && typeof observationClock !== 'function') throw new TypeError('Observation clock must be a function.');
  const started = clock(), observedNow = () => {
    const at = observationClock ? observationClock() : now + Math.max(0, clock() - started);
    if (!Number.isFinite(at)) throw new TypeError('Invalid observation time.');
    return at;
  };
  const rows = [], batchErrors = [], unexpectedSymbols = new Set();
  let requests = 0, attemptedSymbols = 0, returnedSymbols = 0, deferredReason = null, lastRequestAt = null;
  for (let offset = 0; offset < assets.length; offset += batchSize) {
    const batch = assets.slice(offset, offset + batchSize), symbols = batch.map((row) => row.symbol);
    if (observedNow() >= closeTime) deferredReason = 'session_closed_before_screen';
    if (observedNow() >= deadlineTime) deferredReason = 'scan_time_budget';
    if (!deferredReason && lastRequestAt !== null) await sleep(Math.max(0, minimumIntervalMs - (clock() - lastRequestAt)));
    if (observedNow() >= closeTime) deferredReason = 'session_closed_before_screen';
    if (observedNow() >= deadlineTime) deferredReason = 'scan_time_budget';
    if (deferredReason) {
      rows.push(...batch.map(({ symbol }) => ({ symbol, status: 'deferred', reasons: [deferredReason] })));
      continue;
    }
    requests++; attemptedSymbols += symbols.length; lastRequestAt = clock();
    try {
      const payload = await requestSnapshots(symbols);
      const snapshots = payload?.snapshots ?? payload;
      if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots) || payload?.next_page_token) throw new Error('Snapshot response shape or pagination was unexpected.');
      const requested = new Set(symbols);
      for (const symbol of Object.keys(snapshots)) if (!requested.has(symbol)) unexpectedSymbols.add(symbol);
      for (const symbol of symbols) {
        const snapshot = Object.hasOwn(snapshots, symbol) ? snapshots[symbol] : null;
        if (snapshot && typeof snapshot === 'object') returnedSymbols++;
        rows.push(screenEquitySnapshot(symbol, snapshot, { now: observedNow(), openTime, maxAgeMs }));
      }
    } catch (error) {
      const status = Number(error.status ?? error.cause?.status) || null;
      const localBudget = /^ALPACA_(?:BUDGET_|PACING_DEFERRED)/.test(error.code || error.cause?.code || '');
      batchErrors.push({ batch: requests, symbols: symbols.length, status,
        reason: localBudget ? 'local_budget_deferred' : status ? `http_${status}` : 'request_or_payload_error' });
      rows.push(...symbols.map((symbol) => ({ symbol, status: localBudget ? 'deferred' : 'excluded', reasons: [localBudget ? 'local_budget_deferred' : 'snapshot_provider_error'] })));
      // An entitlement/auth failure or exhausted cooldown is not retried once per remaining batch.
      if ([401, 403, 429].includes(status)) deferredReason = 'provider_auth_or_quota_deferred';
      if (localBudget) deferredReason = 'local_budget_deferred';
    }
  }
  const prioritySet = new Set(priorities);
  const qualified = rows.filter((row) => row.status === 'screened').sort((a, b) => b.rankingScore - a.rankingScore
    || Number(prioritySet.has(b.symbol)) - Number(prioritySet.has(a.symbol)) || a.symbol.localeCompare(b.symbol));
  const shortlist = deferredReason ? [] : qualified.slice(0, maxCandidates).map((row) => row.symbol), selected = new Set(shortlist);
  for (const row of qualified) {
    row.status = selected.has(row.symbol) ? 'shortlisted' : 'deferred';
    if (!selected.has(row.symbol)) row.reasons.push(deferredReason || 'deep_analysis_budget');
  }
  const rejectionReasons = {};
  for (const row of rows) for (const reason of row.reasons) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
  return { rows, shortlist, diagnostics: { version: version,
    status: deferredReason || (batchErrors.length ? 'partial_provider_failure' : returnedSymbols < assets.length ? 'partial_snapshot_coverage' : 'screen_complete'),
    eligibleInstruments: assets.length, attemptedSymbols, returnedSymbols, cheaplyScreened: qualified.length,
    missingSnapshots: rejectionReasons.snapshot_missing || 0, unrequestedSymbols: assets.length - attemptedSymbols,
    shortlisted: shortlist.length, analysisDeferred: rejectionReasons.deep_analysis_budget || 0,
    requests, batchSize, batchErrors, unexpectedSymbols: [...unexpectedSymbols].sort(),
    maxCandidates, elapsedMs: Math.max(0, clock() - started), rejectionReasons,
    ranking: 'absolute current movement + session range + gap/2 + log dollar-volume/10; priority breaks ties only',
    quality: 'discovery snapshots only; refreshed detailed quotes and unchanged strategy/risk gates are still required' } };
}

/** Full per-symbol records are compressed separately, keeping operational journals small. */
export async function archiveDiscovery(value, { directory, now } = {}) {
  const folder = resolve(directory), date = new Date(now).toISOString().slice(0, 10);
  const encoded = JSON.stringify({ schemaVersion: 1, capturedAt: new Date(now).toISOString(), ...value });
  const hash = createHash('sha256').update(encoded).digest('hex').slice(0, 24);
  const name = `${date}-${hash}.json.gz`;
  await mkdir(folder, { recursive: true });
  let status = 'recorded';
  try { await writeFile(join(folder, name), gzipSync(encoded), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; status = 'existing'; }
  const cutoff = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{24}\.json\.gz$/.test(entry.name) && entry.name.slice(0, 10) < cutoff) {
      await unlink(join(folder, entry.name));
    }
  }
  return { status, file: name, retentionDays: 14, format: 'gzip-json-full-screen-with-rejections' };
}
