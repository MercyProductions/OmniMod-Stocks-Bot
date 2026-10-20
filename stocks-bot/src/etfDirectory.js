import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mergeEtfDirectories, NASDAQ_ETF_DIRECTORY_URLS } from '../../new-bots/shared/nasdaqEtfDirectory.js';
import { parseSupplementalEtpRegistryDetailed } from '../../new-bots/shared/etpClassification.js';

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DEFAULT_CACHE_PATH = path.join(DATA_ROOT, 'etf-directory-cache.json');
const DEFAULT_CLASSIFICATION_PATH = fileURLToPath(new URL('../../new-bots/etfs-etps/examples/etp-classifications.json', import.meta.url));
const REFRESH_MS = 6 * 60 * 60_000;
const MAX_STALE_MS = 48 * 60 * 60_000;
const pendingByPath = new Map();

function readHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function retryDelay(headers, attempt, now) {
  const raw = readHeader(headers, 'retry-after');
  const seconds = Number(raw);
  const date = Date.parse(raw || '');
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return Math.min(1000 * (2 ** attempt), 4000);
}

async function fetchDirectory(url, { fetcher, metrics, sleepFn, clock }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = clock();
    let response;
    try {
      response = await fetcher(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const error = new Error(`Nasdaq ETF directory returned HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      metrics.push({ provider: 'Nasdaq ETF directory', latencyMs: Math.max(0, clock() - startedAt), status: response.status, attempt: attempt + 1,
        rows: text.split(/\r?\n/).length });
      return text;
    } catch (error) {
      const status = Number(response?.status || error?.status) || 0;
      const retryable = status === 429 || status >= 500 || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
      const delayMs = retryable && attempt < 2 ? retryDelay(response?.headers, attempt, clock()) : null;
      metrics.push({ provider: 'Nasdaq ETF directory', latencyMs: Math.max(0, clock() - startedAt), status, attempt: attempt + 1,
        ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), error: String(error?.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180) });
      if (delayMs === null || delayMs > 10_000) throw new Error(`Nasdaq ETF directory unavailable: ${String(error?.message || error).slice(0, 140)}`);
      await sleepFn(delayMs);
    }
  }
  throw new Error('Nasdaq ETF directory unavailable after bounded retries.');
}

function validCache(value) {
  return value?.schemaVersion === 1 && Array.isArray(value.symbols) && value.symbols.length > 0 && Number.isFinite(Date.parse(value.fetchedAt));
}

async function readCache(cachePath) {
  try {
    const value = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    return validCache(value) ? value : null;
  } catch { return null; }
}

async function saveCache(cachePath, value) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, cachePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Returns a current official ETF classification set or a bounded stale cache. */
export async function getListedEtfUniverse({ cachePath = DEFAULT_CACHE_PATH, cached: suppliedCache = null, fetcher = fetch, metrics = [], now = Date.now(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now } = {}) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(current) || !Array.isArray(metrics)) throw new TypeError('ETF directory time and metrics are invalid.');
  const cached = validCache(suppliedCache) ? suppliedCache : await readCache(cachePath);
  const age = cached ? current - Date.parse(cached.fetchedAt) : Infinity;
  if (age >= 0 && age <= REFRESH_MS) return { ...cached, status: 'fresh_cache', cacheAgeMs: age, refreshError: null };
  const pending = pendingByPath.get(path.resolve(cachePath));
  if (pending) return { ...await pending, status: 'shared_refresh' };
  const refresh = (async () => {
    try {
      const [nasdaqText, otherText] = await Promise.all([
        fetchDirectory(NASDAQ_ETF_DIRECTORY_URLS.nasdaq, { fetcher, metrics, sleepFn, clock }),
        fetchDirectory(NASDAQ_ETF_DIRECTORY_URLS.other, { fetcher, metrics, sleepFn, clock }),
      ]);
      const merged = mergeEtfDirectories(nasdaqText, otherText);
      const record = { schemaVersion: 1, fetchedAt: new Date(current).toISOString(), symbols: merged.entries.map((row) => row.symbol),
        sources: merged.sources, directoryInspection: merged.directoryInspection };
      await saveCache(cachePath, record);
      return { ...record, status: 'refreshed', cacheAgeMs: 0, refreshError: null };
    } catch (error) {
      if (cached && age >= 0 && age <= MAX_STALE_MS) return { ...cached, status: 'stale_fallback', cacheAgeMs: age,
        refreshError: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180) };
      throw error;
    }
  })();
  pendingByPath.set(path.resolve(cachePath), refresh);
  try { return await refresh; }
  finally { if (pendingByPath.get(path.resolve(cachePath)) === refresh) pendingByPath.delete(path.resolve(cachePath)); }
}

/** Use the same reviewed ETP identities as the ETF/ETP bot; hold invalid wrapper rows out of Stocks discovery too. */
export async function getStockDiscoveryOwnership({ directory, classificationPath = process.env.ETF_ETP_CLASSIFICATION_PATH || DEFAULT_CLASSIFICATION_PATH,
  maxReviewAgeDays = process.env.ETF_ETP_CLASSIFICATION_MAX_AGE_DAYS || 180, now = new Date() } = {}) {
  if (!Array.isArray(directory?.symbols)) throw new TypeError('A valid ETF directory is required.');
  let supplemental;
  try {
    supplemental = parseSupplementalEtpRegistryDetailed(JSON.parse(await fs.readFile(path.resolve(classificationPath), 'utf8')),
      { now, maxReviewAgeDays });
  } catch (error) {
    throw new Error(`Supplemental ETP classification registry invalid: ${error.message}`);
  }
  const blockedSymbols = [...new Set(supplemental.blockedSymbols)].sort();
  const blockedSet = new Set(blockedSymbols);
  const ownedSymbols = [...new Set([...directory.symbols.filter((symbol) => !blockedSet.has(symbol)),
    ...supplemental.entries.filter((entry) => !blockedSet.has(entry.symbol)).map((entry) => entry.symbol)])].sort();
  const excludedSymbols = [...new Set([...ownedSymbols, ...blockedSymbols])].sort();
  const revision = createHash('sha256').update(JSON.stringify({ directory: directory.fetchedAt, excludedSymbols })).digest('hex');
  return { ownedSymbols, blockedSymbols, excludedSymbols, reviewedSupplementalCount: supplemental.entries.length, revision };
}
