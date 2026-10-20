import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProviderRateLimit } from './providerRateLimit.js';

const DEFAULT_CACHE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'finnhub-economic-calendar-cache.json');
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const CACHE_LOCK_STALE_MS = 60_000;

// ISO-4217 currency codes mapped to the country/region codes used by Finnhub's
// economic calendar. Unknown and supranational commodity codes still fail closed.
const COUNTRY_BY_CURRENCY = Object.freeze({
  USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH', CAD: 'CA', AUD: 'AU', NZD: 'NZ',
  TRY: 'TR', HKD: 'HK', SGD: 'SG', NOK: 'NO', SEK: 'SE', MXN: 'MX', ZAR: 'ZA',
  DKK: 'DK', PLN: 'PL', CZK: 'CZ', HUF: 'HU', THB: 'TH', CNY: 'CN', CNH: 'CN',
  INR: 'IN', KRW: 'KR', TWD: 'TW', ILS: 'IL', RUB: 'RU', BRL: 'BR',
});
const asDate = (value) => {
  const text = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : null;
};

/** Map scheduled events to conservative target-specific blackouts. Country overrides support non-FX instruments. */
export function mapFinnhubEconomicCalendar(payload, instruments, { marketDate, now = Date.now(), countryCodesByInstrument = {} } = {}) {
  if (!Array.isArray(instruments) || !instruments.length || !asDate(marketDate) || !Number.isFinite(now)) {
    throw new TypeError('Economic calendar needs configured targets, a valid market date, and a finite review time.');
  }
  if (!Array.isArray(payload?.economicCalendar)) throw new TypeError('Finnhub economic calendar response is missing economicCalendar.');
  const from = new Date(Date.parse(`${marketDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${marketDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const events = payload.economicCalendar.map((event, index) => {
    const dateTime = String(event?.time ?? event?.date ?? '');
    const date = asDate(dateTime.slice(0, 10));
    const country = String(event?.country ?? '').trim().toUpperCase();
    const name = String(event?.event ?? '').trim();
    const impact = String(event?.impact ?? '').trim().toLowerCase();
    if (!date || !country || !name || !['high', 'medium', 'low'].includes(impact)) {
      throw new TypeError(`Finnhub economic calendar event ${index + 1} is missing a usable date, country, event name, or impact.`);
    }
    return { date, dateTime, country, name, impact, source: 'Finnhub Economic Calendar' };
  }).filter((event) => event.date >= from && event.date <= to);

  const reviews = {};
  for (const rawTarget of instruments) {
    const target = String(rawTarget).trim().toUpperCase();
    const currencies = target.split('_');
    const derivedCountries = currencies.length === 2 ? currencies.map((currency) => COUNTRY_BY_CURRENCY[currency]) : [];
    const override = countryCodesByInstrument[target];
    const countries = Array.isArray(override) ? override.map((country) => String(country).trim().toUpperCase()) : derivedCountries;
    const supported = countries.length > 0 && countries.every((country) => /^[A-Z]{2}$/.test(country));
    const relevant = supported ? events.filter((event) => countries.includes(event.country)) : [];
    const material = relevant.filter((event) => event.impact !== 'low');
    const status = !supported || material.length ? 'blocked' : 'clear';
    const summary = !supported
      ? `Economic-calendar country mapping is unavailable for ${target}.`
      : material.length
        ? `${material.length} medium/high scheduled release(s) affect ${target} within the conservative three-date window.`
        : `No medium/high-impact scheduled release for ${target} in the conservative three-date window.`;
    reviews[target] = { status, source: 'Finnhub Economic Calendar', summary, reviewedAt: new Date(now).toISOString(),
      coveredDates: { from, to }, events: material.map(({ date, dateTime, country, name, impact }) => ({ date, dateTime, country, name, impact })) };
  }
  return { reviews, diagnostics: { status: 'complete', provider: 'Finnhub Economic Calendar', queriedEvents: payload.economicCalendar.length,
    coveredEvents: events.length, from, to, pairCount: instruments.length, materialPairBlocks: Object.values(reviews).filter((row) => row.status !== 'clear').length } };
}

function calendarCacheKey(token, from, to) {
  return createHash('sha256').update(`${token}\0${from}\0${to}`).digest('hex');
}

async function acquireCalendarCacheLock(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (handle) await unlink(lockPath).catch(() => {});
      if (error.code !== 'EEXIST') {
        // Windows may surface an exclusive-create collision as EPERM rather
        // than EEXIST. Treat it as contention only when the lock path exists;
        // unrelated permission failures must still fail closed.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
        try { await stat(lockPath); }
        catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw error;
        }
      }
      try {
        const [raw, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
        let owner = null;
        try { owner = JSON.parse(raw); } catch { /* Recover only aged unclassifiable metadata. */ }
        const age = Date.now() - Date.parse(owner?.startedAt || '');
        let deadLocalOwner = false;
        if (owner?.hostname === hostname() && Number.isInteger(Number(owner.pid)) && Number(owner.pid) > 0) {
          try { process.kill(Number(owner.pid), 0); } catch (probeError) { deadLocalOwner = probeError.code === 'ESRCH'; }
        }
        const invalidOldMetadata = (!owner || !Number.isFinite(age) || !owner.hostname || !Number.isInteger(Number(owner.pid)))
          && Date.now() - details.mtimeMs > CACHE_LOCK_STALE_MS;
        if (deadLocalOwner || invalidOldMetadata) { await unlink(lockPath).catch(() => {}); continue; }
      } catch (inspectError) {
        if (inspectError.code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) throw new Error('Finnhub calendar cache is locked; request was not duplicated.');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function readFreshCalendarCache(path, key, now, ttlMs) {
  let store;
  try { store = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  const row = store?.entries?.[key];
  const cachedAt = Date.parse(row?.cachedAt || '');
  if (!Array.isArray(row?.payload?.economicCalendar) || !Number.isFinite(cachedAt)
    || cachedAt > now + 5_000 || now - cachedAt > ttlMs) return null;
  return { payload: row.payload, cachedAt: new Date(cachedAt).toISOString() };
}

async function writeCalendarCache(path, key, payload, cachedAt) {
  let store = { version: 1, entries: {} };
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (existing?.version === 1 && existing.entries && typeof existing.entries === 'object' && !Array.isArray(existing.entries)) store = existing;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  store.entries[key] = { cachedAt, payload };
  const sorted = Object.entries(store.entries).sort((a, b) => Date.parse(b[1]?.cachedAt || '') - Date.parse(a[1]?.cachedAt || '')).slice(0, 14);
  store.entries = Object.fromEntries(sorted);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function retryDelayMs(headers, attempt, random, now) {
  const retryAfter = typeof headers?.get === 'function' ? headers.get('Retry-After') : null;
  if (retryAfter != null && String(retryAfter).trim()) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(500 * (2 ** attempt), 4_000) + Math.floor(random() * 250);
}

export async function fetchFinnhubEconomicCalendar({ token = '', marketDate, instruments, now = Date.now(), fetcher = fetch, metrics = [], countryCodesByInstrument = {}, clock = Date.now,
  cache = fetcher === fetch, cachePath = process.env.OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH || DEFAULT_CACHE_PATH,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS, cacheLockTimeoutMs = 15_000,
  maxAttempts = 3, maxRetryWaitMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random } = {}) {
  if (!Array.isArray(instruments) || !instruments.length) throw new TypeError('Finnhub economic calendar requires one or more configured targets.');
  if (!token) return { reviews: Object.fromEntries(instruments.map((target) => [target, { status: 'blocked', source: 'Finnhub Economic Calendar', summary: 'Calendar credentials are missing; scheduled-event clearance is unavailable.', reviewedAt: new Date(now).toISOString() }])), diagnostics: { status: 'credentials_missing', provider: 'Finnhub Economic Calendar', pairCount: instruments.length } };
  if (!asDate(marketDate)) throw new TypeError('Finnhub economic calendar market date must be a valid YYYY-MM-DD date.');
  const center = Date.parse(`${marketDate}T00:00:00Z`);
  if (!Number.isFinite(center)) throw new TypeError('Finnhub economic calendar market date must be YYYY-MM-DD.');
  const from = new Date(center - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(center + 86_400_000).toISOString().slice(0, 10);
  const query = new URLSearchParams({ from, to });
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0
    || !Number.isFinite(now) || !Number.isFinite(cacheTtlMs) || cacheTtlMs < 1_000 || cacheTtlMs > 60 * 60_000
    || !Number.isInteger(cacheLockTimeoutMs) || cacheLockTimeoutMs < 0 || cacheLockTimeoutMs > 30_000) {
    throw new RangeError('Economic-calendar cache time settings are invalid.');
  }
  const key = calendarCacheKey(token, from, to);
  const requestPayload = async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const startedAt = clock();
      let response, status = 0, rateLimit = null;
      try {
        response = await fetcher(`https://finnhub.io/api/v1/calendar/economic?${query}`, {
          headers: { accept: 'application/json', 'X-Finnhub-Token': token }, signal: AbortSignal.timeout(12_000),
        });
        status = Number(response.status) || 0;
        rateLimit = readProviderRateLimit(response.headers);
        if (!response.ok) {
          const error = new Error(`Finnhub Economic Calendar returned HTTP ${status}.`);
          error.status = status;
          throw error;
        }
        const payload = await response.json();
        if (!Array.isArray(payload?.economicCalendar)) throw new TypeError('Finnhub economic calendar response is missing economicCalendar.');
        metrics.push({ provider: 'Finnhub Economic Calendar', operation: 'economic-calendar', status,
          requestStartedAt: startedAt, latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1, ...(rateLimit ? { rateLimit } : {}) });
        return payload;
      } catch (error) {
        const message = String(error.message || error).replace(/https?:\/\/[^\s]+/gi, '[url]').slice(0, 180);
        status = Number(error.status) || status;
        const retryable = status === 429 || status >= 500 || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
        const failure = new Error(message, { cause: error });
        failure.status = status || undefined;
        let delayMs = null;
        if (retryable && attempt + 1 < maxAttempts) {
          delayMs = retryDelayMs(response?.headers, attempt, random, clock());
          if (delayMs > maxRetryWaitMs) {
            failure.message = `${message} Retry deferred because the required wait exceeds the local retry limit.`;
            delayMs = null;
          }
        }
        metrics.push({ provider: 'Finnhub Economic Calendar', operation: 'economic-calendar', status,
          requestStartedAt: startedAt, latencyMs: Math.max(0, clock() - startedAt), attempt: attempt + 1,
          ...(rateLimit ? { rateLimit } : {}), ...(delayMs !== null ? { retryDelayMs: delayMs } : {}), error: failure.message });
        if (delayMs === null) throw failure;
        await sleep(delayMs);
      }
    }
    throw new Error('Finnhub Economic Calendar failed after bounded retries.');
  };
  let payload, cacheStatus = 'disabled', cachedAt = null;
  if (cache) {
    const path = resolve(cachePath || DEFAULT_CACHE_PATH);
    await mkdir(dirname(path), { recursive: true });
    const lock = await acquireCalendarCacheLock(`${path}.lock`, cacheLockTimeoutMs);
    try {
      const cached = await readFreshCalendarCache(path, key, now, cacheTtlMs);
      if (cached) {
        ({ payload, cachedAt } = cached);
        cacheStatus = 'hit';
        metrics.push({ provider: 'Finnhub Economic Calendar', operation: 'economic-calendar-cache', status: 200,
          requestStartedAt: clock(), latencyMs: 0, cache: 'hit' });
      } else {
        payload = await requestPayload();
        cachedAt = new Date(now).toISOString();
        await writeCalendarCache(path, key, payload, cachedAt);
        cacheStatus = 'miss';
      }
    } finally {
      await lock.close();
      await unlink(`${path}.lock`).catch(() => {});
    }
  } else payload = await requestPayload();
  const mapped = mapFinnhubEconomicCalendar(payload, instruments, { marketDate, now, countryCodesByInstrument });
  return { ...mapped, diagnostics: { ...mapped.diagnostics, cache: cacheStatus, cachedAt } };
}
