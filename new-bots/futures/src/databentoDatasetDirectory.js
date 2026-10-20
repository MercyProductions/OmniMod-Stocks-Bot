import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { readProviderRateLimit } from '../../shared/providerRateLimit.js';
import { fetchDatabentoCostEstimate } from './databentoMarketData.js';

export const FUTURES_DIRECTORY_VERSION = 'databento-dataset-definitions-v1';
const API = 'https://hist.databento.com/v0';
const DAY = 86_400_000;
const iso = (time) => new Date(time).toISOString();
const cleanText = (value) => typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value.trim() : '';
const id = (value, max) => /^(?:[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) <= max ? String(value) : null;
const stamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ? Date.parse(value) : NaN;
const positive = (value) => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== ''
  && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 9_223_372_036_854_775_000 ? Number(value) : null;
const fixed = (value) => positive(value) === null ? null : Number((Number(value) / 1e9).toPrecision(12));

/** Date-scoped identity and latest revision, never inferred from a ticker prefix or curated roots. */
export function createFuturesDirectoryAccumulator({ dataset, start, end, now, products = [] }) {
  const startTime = Date.parse(start), endTime = Date.parse(end);
  if (![startTime, endTime, now].every(Number.isFinite) || endTime <= startTime || endTime > now) throw new TypeError('Invalid definition observation range.');
  const latest = new Map(), invalid = [], classes = {}, reasons = {};
  const known = new Map(products.map((p) => [String(p.providerSymbol || '').split('.')[0], p]));
  let records = 0, superseded = 0;
  const count = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
  function add(record) {
    records++;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Malformed definition record.');
    const publisher = id(record.publisher_id ?? record.hd?.publisher_id, 65535);
    const instrument = id(record.instrument_id ?? record.hd?.instrument_id, 4294967294);
    if (!publisher || !instrument) { invalid.push({ recordNumber: records, reason: 'invalid_provider_identity' }); return; }
    const key = `${dataset}:${start.slice(0, 10)}:${publisher}:${instrument}`;
    const time = stamp(record.ts_recv ?? record.hd?.ts_event ?? record.ts_event);
    const prior = latest.get(key);
    if (!Number.isFinite(time) || time < startTime || time >= endTime || time > now) {
      // An unorderable update must not resurrect an earlier apparently valid contract.
      latest.set(key, { key, publisher, instrument, blocked: 'invalid_definition_time', time: Infinity });
      if (prior) superseded++;
      return;
    }
    if (prior && (prior.time > time || prior.blocked === 'invalid_definition_time')) { superseded++; return; }
    const normalized = { key, publisher, instrument, time, raw: cleanText(record.raw_symbol), root: cleanText(record.asset),
      class: cleanText(record.instrument_class), action: cleanText(record.security_update_action),
      ...(record.instrument_class === 'F' ? { exchange: cleanText(record.exchange),
      expiry: stamp(record.expiration), activation: stamp(record.activation),
      // The HTTP request explicitly uses pretty_px=false: price-like fields use 1e-9 fixed precision.
      tickSize: fixed(record.min_price_increment), tickAmount: fixed(record.min_price_increment_amount),
      displayFactor: fixed(record.display_factor), multiplier: positive(record.contract_multiplier),
      contractSize: fixed(record.unit_of_measure_qty), currency: cleanText(record.currency),
      unit: cleanText(record.unit_of_measure), securityType: cleanText(record.security_type) } : {}) };
    if (prior) {
      superseded++;
      if (prior.time === time && (prior.blocked || JSON.stringify(prior) !== JSON.stringify(normalized))) {
        latest.set(key, { ...normalized, blocked: 'conflicting_definition_revision' }); return;
      }
    }
    latest.set(key, normalized);
  }
  function finish() {
    const contracts = [], exclusions = [...invalid];
    for (const row of invalid) count(row.reason);
    for (const row of latest.values()) {
      classes[row.class || 'unknown'] = (classes[row.class || 'unknown'] || 0) + 1;
      const reason = row.blocked || (row.action === 'D' ? 'deleted_definition'
        : !['', 'A', 'M'].includes(row.action) ? 'unsupported_update_action'
        : row.class !== 'F' ? ['C', 'P'].includes(row.class) ? 'option_contract' : ['S', 'T'].includes(row.class) ? 'spread_contract' : 'not_outright_future'
        : !row.root || !row.raw ? 'missing_root_or_raw_symbol'
        : !Number.isFinite(row.expiry) ? 'invalid_expiry'
        : row.expiry <= now ? 'expired_contract'
        : Number.isFinite(row.activation) && row.activation > now ? 'not_yet_activated' : null);
      if (reason) { count(reason); exclusions.push({ identity: row.key, rawSymbol: row.raw || null, root: row.root || null, reason }); continue; }
      const product = known.get(row.root);
      contracts.push({ identity: row.key, providerDataset: dataset, providerRoot: row.root,
        product: product?.symbol || row.root, providerSymbol: product?.providerSymbol || null,
        configuredPriority: Boolean(product), providerRawSymbol: row.raw, providerInstrumentId: row.instrument,
        providerPublisherId: row.publisher, providerExchange: row.exchange || null, expiry: iso(row.expiry),
        providerActivationAt: Number.isFinite(row.activation) ? iso(row.activation) : null,
        providerTickSize: row.tickSize, providerDisplayFactor: row.displayFactor, providerTickAmount: row.tickAmount,
        // Field inconsistencies and fractional quotation conventions require independent review.
        providerTickValue: null, providerContractMultiplier: row.multiplier, providerContractSize: row.contractSize,
        providerUnitOfMeasure: row.unit || null, providerCurrency: row.currency || null, providerSecurityType: row.securityType || null,
        providerInstrumentClass: 'F', definitionTimestamp: iso(row.time), discoveredAt: iso(now),
        definitionSource: `Databento ${dataset} ALL_SYMBOLS historical definition stream`,
        contractState: 'unexpired_definition_only', contractSpecVerified: false, tradeEligible: false,
        unverifiedFields: ['current activity and volume/open interest', 'front/active/deferred selection', 'broker tick value and multiplier',
          'margin', 'first notice and last trade', 'settlement', 'session calendar', 'canonical exposure', 'current executable quote'] });
    }
    const uniqueIdentities = latest.size;
    latest.clear();
    contracts.sort((a, b) => a.providerRoot.localeCompare(b.providerRoot) || a.expiry.localeCompare(b.expiry) || a.identity.localeCompare(b.identity));
    return { contracts, exclusions, diagnostics: { version: FUTURES_DIRECTORY_VERSION, scope: 'dataset', dataset,
      observedFrom: start, observedThroughExclusive: end, ageMs: now - endTime, streamComplete: true,
      records, uniqueIdentities, supersededRecords: superseded, invalidIdentityRecords: invalid.length,
      instrumentClasses: classes, unexpiredOutrights: contracts.length, discoveredRoots: new Set(contracts.map((c) => c.providerRoot)).size,
      outsideConfiguredPriorities: contracts.filter((c) => !c.configuredPriority).length,
      excluded: exclusions.length, rejectionReasons: reasons, strategyInputs: 0, tradeEligible: 0,
      note: 'Complete returned historical stream for one dataset/date; not proof of whole-market, current live activity or trade eligibility.' } };
  }
  return { add, finish };
}

/** Most recent available UTC definition date, including its opening snapshot; never request a future end. */
export function definitionRange(metadata, now) {
  const schema = metadata?.schema?.definition;
  const availableStart = stamp(schema?.start), availableEnd = stamp(schema?.end);
  if (![availableStart, availableEnd, now].every(Number.isFinite) || availableEnd <= availableStart) throw new Error('Definition schema availability is missing or invalid.');
  const end = Math.min(availableEnd, now);
  const start = Math.floor((end - 1) / DAY) * DAY;
  if (start < availableStart || end <= start || now - end > 7 * DAY) throw new Error('No complete recent definition-date range is available.');
  return { start: iso(start), end: iso(end), providerAvailableEnd: schema.end };
}

/** Cost-capped all-symbol reference discovery. The paid stream is never retried. */
export async function discoverDatabentoDatasetDirectory({ apiKey = '', dataset = 'GLBX.MDP3', products = [],
  maxScanCostUsd = 0, now = Date.now(), fetcher = fetch, clock = Date.now, sleep, metrics = [],
  archiveDirectory, planOnly = false, maxRecords = 2_000_000, maxBytes = 2 * 1024 ** 3, timeoutMs = 120_000, existingRange = null } = {}) {
  const empty = (status) => ({ status, contracts: [], diagnostics: { version: FUTURES_DIRECTORY_VERSION, scope: 'dataset', dataset,
    streamComplete: false, uniqueIdentities: null, unexpiredOutrights: null, discoveredRoots: null, status }, metrics });
  if (!/^[A-Z0-9.]{3,24}$/.test(dataset)) throw new TypeError('Invalid Databento dataset.');
  if (!apiKey) return empty('credentials_missing');
  if (!planOnly && !(Number.isFinite(maxScanCostUsd) && maxScanCostUsd > 0)) return empty('cost_cap_required');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 5_000_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 ** 3
    || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) throw new TypeError('Invalid directory resource limits.');
  if (!planOnly && !archiveDirectory) throw new TypeError('A directory archive path is required before downloading.');
  const headers = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json' };
  const startedAt = clock();
  async function metadata(method, params, operation) {
    const response = await fetchDatabentoCostEstimate(fetcher, `${API}/${method}?${new URLSearchParams(params)}`,
      { headers, signal: AbortSignal.timeout(12_000) }, { clock, sleep, onAttempt: ({ status, latencyMs, headers: h, attempt }) => {
        metrics.push({ provider: 'Databento', operation, status, latencyMs, attempt: attempt + 1, ...(readProviderRateLimit(h) ? { rateLimit: readProviderRateLimit(h) } : {}) });
      } });
    if (!response.ok) throw new Error(`${operation} HTTP ${response.status}`);
    return response.text();
  }
  const range = definitionRange(JSON.parse(await metadata('metadata.get_dataset_range', { dataset }, 'dataset-definition-availability')), now);
  if (!planOnly && existingRange?.start === range.start && existingRange?.end === range.end)
    return { ...empty('source_range_unchanged'), range };
  const params = { dataset, schema: 'definition', symbols: 'ALL_SYMBOLS', stype_in: 'raw_symbol', start: range.start, end: range.end };
  const costText = await metadata('metadata.get_cost', params, 'dataset-definition-cost');
  const estimatedCostUsd = Number(costText.trim());
  if (!costText.trim() || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new Error('Invalid dataset definition cost estimate.');
  const plan = { ...range, estimatedCostUsd, configuredCapUsd: maxScanCostUsd, maxRecords, maxBytes, timeoutMs };
  if (planOnly || estimatedCostUsd > maxScanCostUsd) return { ...empty(planOnly ? 'estimate_only' : 'cost_cap_exceeded'), plan };
  // Same operation consumed by the existing combined per-scan budget; reserve even if the stream fails halfway.
  metrics.push({ provider: 'Databento', operation: 'estimated-contract-discovery-cost', status: 200, latencyMs: 0,
    estimatedCostUsd, configuredCapUsd: maxScanCostUsd });
  await mkdir(archiveDirectory, { recursive: true });
  const name = `${dataset}-${range.start.slice(0, 10)}-${randomUUID()}`;
  const temp = join(archiveDirectory, `${name}.partial.gz`), target = join(archiveDirectory, `${name}.ndjson.gz`);
  const normalizedPath = join(archiveDirectory, `${name}.directory.json.gz`);
  const accumulator = createFuturesDirectoryAccumulator({ dataset, ...range, now, products });
  const digest = createHash('sha256');
  let bytes = 0, records = 0, response, streamStart = clock();
  try {
    response = await fetcher(`${API}/timeseries.get_range`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, encoding: 'json', compression: 'none', pretty_ts: 'true', pretty_px: 'false' }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel?.(); throw new Error(`dataset-definitions HTTP ${response.status}`); }
    if (!response.body?.[Symbol.asyncIterator]) throw new Error('Streaming definition body is unavailable.');
    async function* ingest() {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      const consume = (line) => {
        if (!line.trim()) return;
        if (++records > maxRecords) throw new Error('Definition record limit exceeded; coverage incomplete.');
        let record; try { record = JSON.parse(line); } catch { throw new Error('Malformed definition JSON; coverage incomplete.'); }
        accumulator.add(record);
      };
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || clock() - streamStart > timeoutMs) throw new Error('Definition resource limit exceeded; coverage incomplete.');
        digest.update(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, index)); pending = pending.slice(index + 1); }
        if (pending.length > 65_536) throw new Error('Oversized definition record; coverage incomplete.');
        yield chunk;
      }
      pending += decoder.decode();
      // Databento JSONL terminates each record. Reject a truncated final record, even if its prefix happens to parse.
      if (pending.trim()) throw new Error('Unterminated definition stream; coverage incomplete.');
    }
    await pipeline(ingest(), createGzip(), createWriteStream(temp, { flags: 'wx' }));
    if (!records) throw new Error('Empty definition stream; coverage unknown.');
    const result = accumulator.finish();
    if (!result.diagnostics.uniqueIdentities) throw new Error('Empty definition identities; coverage unknown.');
    result.diagnostics.bytes = bytes;
    result.diagnostics.elapsedMs = Math.max(0, clock() - startedAt);
    result.diagnostics.plan = plan;
    const archive = { rawFile: target, sha256: digest.digest('hex'), normalizedFile: normalizedPath };
    async function* normalizedJson() {
      yield `{"diagnostics":${JSON.stringify(result.diagnostics)},"archive":${JSON.stringify(archive)},"contracts":[`;
      for (let i = 0; i < result.contracts.length; i++) yield `${i ? ',' : ''}${JSON.stringify(result.contracts[i])}`;
      yield '],"exclusions":[';
      for (let i = 0; i < result.exclusions.length; i++) yield `${i ? ',' : ''}${JSON.stringify(result.exclusions[i])}`;
      yield ']}';
    }
    await pipeline(normalizedJson(), createGzip(), createWriteStream(normalizedPath, { flags: 'wx' }));
    await rename(temp, target);
    metrics.push({ provider: 'Databento', operation: 'dataset-definitions', status: response.status, latencyMs: Math.max(0, clock() - streamStart), records,
      ...(readProviderRateLimit(response.headers) ? { rateLimit: readProviderRateLimit(response.headers) } : {}) });
    // Per-identity exclusions are in the archive; never dump hundreds of thousands of rows into a Discord log.
    return { status: 'refreshed', contracts: result.contracts, diagnostics: result.diagnostics, archive, metrics };
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    await rm(normalizedPath, { force: true }).catch(() => {});
    metrics.push({ provider: 'Databento', operation: 'dataset-definitions', status: response?.status || 0,
      latencyMs: Math.max(0, clock() - streamStart), records, bytes, error: 'Directory stream incomplete; no current coverage accepted.' });
    // Do not persist a provider body, URL, authorization value or arbitrary fetch exception.
    const result = { ...empty('incomplete_stream'), plan, diagnostics: { ...empty('incomplete_stream').diagnostics,
      partialRecords: records, partialBytes: bytes, failure: /^(Definition |Malformed definition|Unterminated definition|Empty definition|Oversized definition|Streaming definition|dataset-definitions HTTP)/.test(error.message)
        ? error.message : 'Definition stream or archive failed.' } };
    await writeFile(join(archiveDirectory, `${name}.failure.json`), `${JSON.stringify(result.diagnostics)}\n`).catch(() => {});
    return result;
  }
}
