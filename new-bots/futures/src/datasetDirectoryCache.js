import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { discoverDatabentoDatasetDirectory, FUTURES_DIRECTORY_VERSION } from './databentoDatasetDirectory.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { const handle = await open(temp, 'wx'); try { await handle.writeFile(`${JSON.stringify(value)}\n`); } finally { await handle.close(); } await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

/** Complete reference snapshots only. Locks and durable attempt spacing also cover manual CLI invocations. */
export async function loadDatasetDirectory({ products = [], cachePath = 'data/futures-dataset-directory.json',
  maxAgeMs = 6 * 60 * 60_000, apiKey = '', dataset = 'GLBX.MDP3', maxScanCostUsd = 0,
  now = Date.now(), metrics = [], fetcher = fetch, clock = Date.now, ...limits } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 86_400_000) throw new TypeError('Invalid directory cache age.');
  const path = resolve(cachePath), archiveDirectory = `${path}.archives`;
  const cacheKey = hash([FUTURES_DIRECTORY_VERSION, dataset, apiKey, products.map((p) => [p.symbol, p.providerSymbol])]);
  const envelope = await readJson(path);
  let cached = envelope?.cacheKey === cacheKey && envelope.version === FUTURES_DIRECTORY_VERSION && envelope.result
    && hash(envelope.result) === envelope.sha256 && envelope.result?.diagnostics?.streamComplete === true
    && Array.isArray(envelope.result.contracts) && Number.isFinite(Date.parse(envelope.fetchedAt))
    && Date.parse(envelope.fetchedAt) <= now ? envelope : null;
  if (cached && (!cached.result.archive?.rawFile || !await stat(cached.result.archive.rawFile).then(() => true).catch(() => false))) cached = null;
  const view = (result, status, ageMs, providerError = null) => ({ ...result, status, cached: ageMs !== null, ageMs, metrics, providerError,
    // Re-check expiry at every read; cached references never approve a contract.
    contracts: result.contracts.filter((c) => Date.parse(c.expiry) > now).map((c) => ({ ...c, tradeEligible: false, contractSpecVerified: false })),
    diagnostics: { ...result.diagnostics, cacheAgeMs: ageMs, referenceAgeMs: Math.max(0, now - Date.parse(result.diagnostics.observedThroughExclusive)),
      currentlyUnexpiredReferences: result.contracts.filter((c) => Date.parse(c.expiry) > now).length } });
  // Instrument IDs are only guaranteed within a provider UTC date. A new date needs new definitions.
  if (cached && cached.result.diagnostics.observedFrom?.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    && now - Date.parse(cached.fetchedAt) <= maxAgeMs) return view(cached.result, 'cached', now - Date.parse(cached.fetchedAt));
  const failed = (status, message = null) => cached
    ? view(cached.result, 'stale_cache_after_provider_error', now - Date.parse(cached.fetchedAt), message || status)
    : { status, contracts: [], metrics, cached: false, ageMs: null, providerError: message,
      diagnostics: { version: FUTURES_DIRECTORY_VERSION, scope: 'dataset', dataset, streamComplete: false,
        uniqueIdentities: null, unexpiredOutrights: null, discoveredRoots: null } };
  if (!apiKey) return failed('credentials_missing');
  if (!(Number.isFinite(maxScanCostUsd) && maxScanCostUsd > 0)) return failed('cost_cap_required');
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(`${path}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return failed('refresh_locked', 'Another directory refresh or unrecovered lock exists.'); throw error; }
  try {
    const attempt = await readJson(`${path}.attempt.json`);
    // A failed/partial paid response is not retried on every scanner tick (nor after a process restart).
    if (attempt?.cacheKey === cacheKey && Number.isFinite(Date.parse(attempt.at)) && now - Date.parse(attempt.at) < 60 * 60_000)
      return failed('refresh_backoff', 'Directory refresh is limited to one attempt per hour.');
    await atomicJson(`${path}.attempt.json`, { cacheKey, at: new Date(now).toISOString() });
    let result;
    try { result = await discoverDatabentoDatasetDirectory({ ...limits, products, apiKey, dataset, maxScanCostUsd, now, metrics, fetcher, clock, archiveDirectory,
      existingRange: cached ? { start: cached.result.diagnostics.observedFrom, end: cached.result.diagnostics.observedThroughExclusive } : null }); }
    catch { return failed('provider_error', 'Directory metadata/provider request failed; check credentials, entitlement and availability.'); }
    if (cached && result.status === 'source_range_unchanged') return { ...view(cached.result, 'cached', now - Date.parse(cached.fetchedAt)),
      availabilityRechecked: true, metadataCheckedAt: new Date(now).toISOString() };
    if (result.status !== 'refreshed') {
      if (cached) return failed(result.status, result.diagnostics?.failure || result.status);
      return { ...result, cached: false, ageMs: null };
    }
    // Metrics contain only this attempt's request observations and are not replayed as cached API activity.
    const { metrics: ignored, ...stored } = result;
    await atomicJson(path, { version: FUTURES_DIRECTORY_VERSION, cacheKey, fetchedAt: new Date(now).toISOString(), result: stored, sha256: hash(stored) });
    // Only this module's generated regular files are pruned; the current archive is always retained.
    for (const entry of await readdir(archiveDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[A-Z0-9.]+-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.(?:ndjson\.gz|directory\.json\.gz|failure\.json)$/.test(entry.name)) continue;
      const file = join(archiveDirectory, entry.name);
      if ([stored.archive.rawFile, stored.archive.normalizedFile].includes(file)) continue;
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > 14 * 86_400_000) await unlink(file).catch(() => {});
    }
    return { ...view(stored, 'refreshed', 0), cached: false };
  } finally { await lock.close(); await unlink(`${path}.lock`); }
}
