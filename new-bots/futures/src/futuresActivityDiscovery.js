import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { fetchDatabentoCostEstimate } from './databentoMarketData.js';
import { readProviderRateLimit } from '../../shared/providerRateLimit.js';
import { createFuturesActivityScreen, FUTURES_ACTIVITY_VERSION, inspectFuturesActivityDirectory, futuresActivityDirectoryFingerprint } from './futuresActivityScreen.js';

const API = 'https://hist.databento.com/v0', MINUTE = 60_000;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value) => new Date(value).toISOString();
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value)}\n`, { flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

export function futuresActivityRange(metadata, { now, lookbackMinutes = 30, maxBarAgeMs = 180_000 } = {}) {
  if (!Number.isInteger(lookbackMinutes) || lookbackMinutes < 5 || lookbackMinutes > 60) throw new TypeError('Activity lookback must be 5–60 minutes.');
  const availability = metadata?.schema?.['ohlcv-1m'];
  const availableStart = Date.parse(availability?.start || ''), availableEnd = Date.parse(availability?.end || '');
  if (![availableStart, availableEnd, now].every(Number.isFinite) || availableEnd <= availableStart) return { status: 'activity_schema_unavailable' };
  const end = Math.floor(Math.min(availableEnd, now) / MINUTE) * MINUTE;
  if (now - end > maxBarAgeMs) return { status: 'activity_availability_stale', availableThrough: availability.end };
  const dayStart = Date.parse(`${iso(now).slice(0, 10)}T00:00:00Z`);
  const start = Math.max(dayStart, end - lookbackMinutes * MINUTE, Math.ceil(availableStart / MINUTE) * MINUTE);
  if (end - start < 2 * MINUTE) return { status: 'awaiting_same_day_completed_bars' };
  return { status: 'ready', start: iso(start), end: iso(end), availableThrough: availability.end };
}

/** All-symbol, bounded minute-bar research. No live socket, paper reservation or execution dependency. */
export async function discoverFuturesActivity({ enabled = false, directory, dataset = 'GLBX.MDP3', apiKey = '',
  maxScanCostUsd = 0, cachePath = 'data/futures-activity-screen.json', now = Date.now(), fetcher = fetch,
  clock = Date.now, sleep, metrics = [], maxCandidates = 20, maxContractsPerRoot = 1,
  lookbackMinutes = 30, maxBarAgeMs = 180_000, maxRecords = 1_000_000, maxBytes = 512 * 1024 ** 2, timeoutMs = 60_000, planOnly = false } = {}) {
  const started = clock(), observedNow = () => now + Math.max(0, clock() - started);
  const empty = (status, extra = {}) => ({ status, candidates: [], rows: [], metrics,
    diagnostics: { version: FUTURES_ACTIVITY_VERSION, status, dataset, universe: directory?.diagnostics?.streamComplete ? directory.contracts?.length ?? null : null,
      observed: null, unobserved: null, dataQualified: null, rejected: null, deferred: null, candidates: 0,
      strategyQualified: 0, riskApproved: 0, elapsedMs: Math.max(0, clock() - started), ...extra } });
  if (!enabled) return empty('disabled');
  if (!apiKey) return empty('credentials_missing');
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid activity dataset.');
  const directoryFailure = inspectFuturesActivityDirectory(directory, { dataset, now });
  if (directoryFailure && !planOnly) return empty(directoryFailure);
  if (!planOnly && !(Number.isFinite(maxScanCostUsd) && maxScanCostUsd > 0)) return empty('cost_cap_required');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 2_000_000 || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1 || maxBytes > 2 * 1024 ** 3 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000
    || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100 || !Number.isInteger(maxContractsPerRoot)
    || maxContractsPerRoot < 1 || maxContractsPerRoot > 3 || !Number.isFinite(maxBarAgeMs) || maxBarAgeMs < MINUTE || maxBarAgeMs > 5 * MINUTE)
    throw new TypeError('Invalid activity resource or candidate bounds.');
  // Validate lookback before even a free metadata request.
  futuresActivityRange({}, { now, lookbackMinutes, maxBarAgeMs });
  const headers = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json' };
  async function metadata(method, params, operation) {
    const response = await fetchDatabentoCostEstimate(fetcher, `${API}/${method}?${new URLSearchParams(params)}`,
      { headers, signal: AbortSignal.timeout(12_000) }, { clock, sleep, onAttempt: ({ status, latencyMs, headers: h, attempt }) => {
        metrics.push({ provider: 'Databento', operation, status, latencyMs, attempt: attempt + 1,
          ...(readProviderRateLimit(h) ? { rateLimit: readProviderRateLimit(h) } : {}) });
      } });
    if (!response.ok) throw new Error(`Activity metadata HTTP ${response.status}`);
    return response.text();
  }
  let range;
  try { range = futuresActivityRange(JSON.parse(await metadata('metadata.get_dataset_range', { dataset }, 'activity-availability')),
    { now, lookbackMinutes, maxBarAgeMs }); }
  catch { return empty('provider_metadata_error'); }
  if (range.status !== 'ready') return empty(range.status, { availableThrough: range.availableThrough || null });
  const params = { dataset, schema: 'ohlcv-1m', symbols: 'ALL_SYMBOLS', stype_in: 'raw_symbol', start: range.start, end: range.end };
  if (planOnly) {
    let cost;
    try {
      const body = await metadata('metadata.get_cost', params, 'activity-cost-estimate');
      cost = body.trim() ? Number(body.trim()) : NaN;
    } catch { return empty('provider_cost_error'); }
    if (!Number.isFinite(cost) || cost < 0) return empty('invalid_cost_estimate');
    return { ...empty('estimate_only'), plan: { ...params, estimatedCostUsd: cost, configuredCapUsd: maxScanCostUsd,
      maxRecords, maxBytes, timeoutMs, directoryStatus: directoryFailure || 'available', paidDownloads: 0 } };
  }
  const config = { maxCandidates, maxContractsPerRoot, maxBarAgeMs };
  const path = resolve(cachePath), archives = `${path}.archives`, fingerprint = futuresActivityDirectoryFingerprint(directory);
  // Cache the complete input query, not a particular shortlist/priority configuration.
  // Re-screen the same verified bytes after directory/ranking changes without buying them again.
  const key = hash([FUTURES_ACTIVITY_VERSION, apiKey, params]);
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(`${path}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return empty('activity_refresh_locked'); throw error; }
  let temp, normalizedFile, rawFile, response, streamStart, paidStarted = false, bytes = 0, records = 0;
  try {
    const cached = await readJson(path), sameCache = cached?.key === key && cached.version === FUTURES_ACTIVITY_VERSION;
    const cachedFile = sameCache && typeof cached.rawFile === 'string' && dirname(resolve(cached.rawFile)) === archives ? resolve(cached.rawFile) : null;
    const reusing = Boolean(cachedFile && await stat(cachedFile).then((s) => s.isFile()).catch(() => false));
    const accumulator = createFuturesActivityScreen({ directory, dataset, ...range, now, ...config });
    const digest = createHash('sha256');
    let source;
    let estimatedCostUsd = null;
    if (reusing) {
      rawFile = cachedFile;
      const input = createReadStream(cachedFile), unzip = createGunzip();
      input.on('error', (error) => unzip.destroy(error)); unzip.on('close', () => input.destroy());
      source = input.pipe(unzip);
    }
    else {
      const attempt = await readJson(`${path}.attempt.json`);
      if (attempt?.key === key) return empty('previous_window_attempt_failed', { start: range.start, end: range.end });
      let costText;
      try { costText = await metadata('metadata.get_cost', params, 'activity-cost-estimate'); }
      catch { return empty('provider_cost_error'); }
      estimatedCostUsd = Number(costText.trim());
      if (!costText.trim() || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) return empty('invalid_cost_estimate');
      if (estimatedCostUsd > maxScanCostUsd) return empty('cost_cap_exceeded', { estimatedCostUsd, configuredCapUsd: maxScanCostUsd });
      await mkdir(archives, { recursive: true });
      // Persist before the paid request; an interrupted response is not retried for this same query.
      await atomicJson(`${path}.attempt.json`, { key, at: iso(observedNow()) });
      metrics.push({ provider: 'Databento', operation: 'estimated-activity-discovery-cost', status: 200, latencyMs: 0,
        estimatedCostUsd, configuredCapUsd: maxScanCostUsd, budgetReserved: true });
      paidStarted = true; streamStart = clock();
      response = await fetcher(`${API}/timeseries.get_range`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, encoding: 'json', compression: 'none', pretty_px: 'true', pretty_ts: 'true', map_symbols: 'true' }),
        signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel?.(); throw new Error('Activity stream HTTP failure.'); }
      if (!response.body?.[Symbol.asyncIterator]) throw new Error('Activity streaming body missing.');
      if (clock() - streamStart > timeoutMs) { await response.body?.cancel?.(); throw new Error('Activity request exceeded time budget.'); }
      source = response.body;
      const name = `${dataset}-${range.end.slice(0, 10)}-${randomUUID()}`;
      temp = join(archives, `${name}.partial.gz`); rawFile = join(archives, `${name}.ndjson.gz`);
    }
    const ingestStart = clock();
    async function* ingest() {
      const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
      const consume = (line) => { if (!line.trim()) return; if (++records > maxRecords) throw new Error('Activity record cap exceeded.');
        let record; try { record = JSON.parse(line); } catch { throw new Error('Malformed activity JSON.'); } accumulator.add(record); };
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || clock() - (paidStarted ? streamStart : ingestStart) > timeoutMs) throw new Error('Activity resource cap exceeded.');
        digest.update(chunk); pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
        if (pending.length > 65_536) throw new Error('Activity record oversized.');
        yield chunk;
      }
      pending += decoder.decode(); if (pending.trim()) throw new Error('Activity stream unterminated.');
    }
    if (reusing) { for await (const unused of ingest()) { /* Only replay cached input into the pure screen. */ } }
    else await pipeline(ingest(), createGzip(), createWriteStream(temp, { flags: 'wx' }));
    const sha256 = digest.digest('hex');
    if (reusing && sha256 !== cached.sha256) throw new Error('Activity cache integrity failed.');
    // A provider-confirmed empty bar response is not proof of no trading across the dataset.
    if (!records) throw new Error('Activity stream empty; coverage unknown.');
    const result = accumulator.finish({ observedNow: observedNow() });
    result.diagnostics.cached = reusing;
    result.diagnostics.bytes = bytes;
    result.diagnostics.elapsedMs = Math.max(0, clock() - started);
    result.diagnostics.estimatedCostUsd = estimatedCostUsd;
    result.diagnostics.configuredRemainingCapUsd = maxScanCostUsd;
    result.diagnostics.source = 'Databento historical completed-minute activity';
    result.diagnostics.requestedLookbackMinutes = lookbackMinutes;
    result.diagnostics.configurationHash = hash([FUTURES_ACTIVITY_VERSION, dataset, { ...config, lookbackMinutes }]);
    await mkdir(archives, { recursive: true });
    normalizedFile = join(archives, `${dataset}-${range.end.slice(0, 10)}-${randomUUID()}.screen.json.gz`);
    const archive = { rawFile, sha256, normalizedFile, directoryFingerprint: fingerprint, directoryArchive: directory.archive || null };
    async function* normalized() {
      yield `{"diagnostics":${JSON.stringify(result.diagnostics)},"archive":${JSON.stringify(archive)},"rows":[`;
      for (let i = 0; i < result.rows.length; i++) yield `${i ? ',' : ''}${JSON.stringify(result.rows[i])}`;
      yield '],"recordDispositions":[';
      for (let i = 0; i < result.recordDispositions.length; i++) yield `${i ? ',' : ''}${JSON.stringify(result.recordDispositions[i])}`;
      yield ']}';
    }
    await pipeline(normalized(), createGzip(), createWriteStream(normalizedFile, { flags: 'wx' }));
    if (!reusing) {
      await rename(temp, rawFile); temp = null;
      await atomicJson(path, { version: FUTURES_ACTIVITY_VERSION, key, rawFile, sha256, range, cachedAt: iso(observedNow()) });
    }
    if (paidStarted) metrics.push({ provider: 'Databento', operation: 'activity-minute-bars', status: 200,
      latencyMs: Math.max(0, clock() - streamStart), records, bytes,
      ...(readProviderRateLimit(response.headers) ? { rateLimit: readProviderRateLimit(response.headers) } : {}) });
    // Each generated file is local to this archive directory. Keep the raw input used by this result.
    for (const entry of await readdir(archives, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[A-Z0-9.]+-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.(?:ndjson\.gz|screen\.json\.gz)$/.test(entry.name)) continue;
      const file = join(archives, entry.name); if ([rawFile, normalizedFile].includes(file)) continue;
      const s = await stat(file).catch(() => null); if (s && observedNow() - s.mtimeMs > 14 * 86_400_000) await unlink(file).catch(() => {});
    }
    return { status: 'screen_complete', candidates: result.candidates, diagnostics: result.diagnostics, archive, metrics };
  } catch (error) {
    const failureReason = ({
      'Activity stream HTTP failure.': 'provider_http_failure', 'Activity streaming body missing.': 'stream_missing',
      'Activity request exceeded time budget.': 'time_budget_exceeded', 'Activity record cap exceeded.': 'record_limit_exceeded',
      'Malformed activity JSON.': 'malformed_json', 'Malformed activity record.': 'invalid_record_shape',
      'Activity resource cap exceeded.': 'resource_limit_exceeded', 'Activity record oversized.': 'record_size_exceeded',
      'Activity stream unterminated.': 'unterminated_stream', 'Activity cache integrity failed.': 'cache_integrity_failed',
      'Activity stream empty; coverage unknown.': 'empty_provider_response',
    })[error?.message] || 'provider_or_archive_failure';
    if (temp) await unlink(temp).catch(() => {});
    if (normalizedFile) await unlink(normalizedFile).catch(() => {});
    if (paidStarted) metrics.push({ provider: 'Databento', operation: 'activity-minute-bars', status: response?.status || 0,
      latencyMs: Math.max(0, clock() - streamStart), records, bytes, error: failureReason });
    return empty('activity_scan_incomplete', { failureReason, partialRecords: records, partialBytes: bytes, start: range.start, end: range.end });
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}
