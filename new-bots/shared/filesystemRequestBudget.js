import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve, join } from 'node:path';

export const SHARED_BUDGET_VERSION = 'filesystem-rest-budget-v1';
const WINDOW_MS = 60000;
const DEFAULT_RPM = 180;
const MAX_RPM = 10000;
const validTime = n => Number.isSafeInteger(n) && n >= 0;
const validLimit = n => Number.isInteger(n) && n >= 1 && n <= MAX_RPM;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const sleepDefault = ms => new Promise(done => setTimeout(done, ms));


function blank(at) {
  return { schemaVersion: 1, updatedAt: at, cooldownUntil: 0, sequence: 0, deferred: 0, starts: [], quota: null };
}

function validateState(state) {
  if (state?.schemaVersion !== 1 || ![state.updatedAt, state.cooldownUntil, state.sequence, state.deferred].every(validTime)
    || !Array.isArray(state.starts) || state.starts.length > MAX_RPM
    || state.starts.some((row, i) => !validTime(row.at) || !validLimit(row.limit) || !Number.isSafeInteger(row.id)
      || row.id < 1 || row.id > state.sequence || (i && (row.at < state.starts[i - 1].at || row.id <= state.starts[i - 1].id)))
    || (state.quota !== null && (!validTime(state.quota.observedAt) || !validTime(state.quota.resetAt)
      || !Number.isSafeInteger(state.quota.remaining) || state.quota.remaining < 0
      || !Number.isSafeInteger(state.quota.limit) || state.quota.limit <= 0 || state.quota.remaining > state.quota.limit))) {
    throw failure('REQUEST_BUDGET_STATE_INVALID');
  }
  return state;
}

async function loadState(path, at) {
  try { return validateState(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return blank(at);
    throw failure('REQUEST_BUDGET_STATE_INVALID');
  }
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
  return typeof headers?.get === 'function' ? headers.get(name) : key ? headers[key] : null;
}

function headerNumber(headers, name) {
  const raw = headerValue(headers, name);
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Filesystem coordination using canonical X-RateLimit-{Limit,Remaining,Reset} headers
 * (reset epoch seconds). Provider adapters translate their native headers.
 * No account key, secret, URL or response body is persisted. */
export function createSharedRequestBudget({ directory, requestsPerMinute = DEFAULT_RPM, group = '', version = SHARED_BUDGET_VERSION,
  now = Date.now, sleep = sleepDefault } = {}) {
  if (!directory || !validLimit(requestsPerMinute) || typeof now !== 'function' || typeof sleep !== 'function'
    || (group && !/^[A-Za-z0-9._-]{1,100}$/.test(group))) throw failure('REQUEST_BUDGET_CONFIG_INVALID');
  const root = resolve(directory);
  const paths = credential => {
    const key = String(credential ?? '').trim();
    if (!key || key.length > 500) throw failure('REQUEST_BUDGET_CREDENTIAL_REQUIRED');
    const hash = digest(group ? `group:${group}` : `credential:${key}`);
    return { state: join(root, `${hash}.json`), lock: join(root, `${hash}.lock`) };
  };
  const clock = () => { const at = now(); if (!validTime(at)) throw failure('REQUEST_BUDGET_CLOCK_INVALID'); return at; };

  async function transaction(credential, deadline, action) {
    const path = paths(credential);
    await mkdir(root, { recursive: true });
    let handle;
    while (!handle) {
      try { handle = await open(path.lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw failure('REQUEST_BUDGET_STORAGE_UNAVAILABLE');
        if (clock() >= deadline) throw failure('REQUEST_BUDGET_LOCK_TIMEOUT');
        await sleep(Math.min(25, deadline - clock()));
      }
    }
    let temp;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: clock() }));
      const at = clock(), state = await loadState(path.state, at);
      if (state.updatedAt > at + 5000) throw failure('REQUEST_BUDGET_CLOCK_SKEW');
      state.starts = state.starts.filter(row => row.at > at - WINDOW_MS);
      const result = action(state, at);
      if (result.write !== false) {
        state.updatedAt = Math.max(state.updatedAt, at);
        validateState(state);
        temp = `${path.state}.${randomUUID()}.tmp`;
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
        await rename(temp, path.state); temp = null;
      }
      return result;
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      await handle.close();
      // Never steal or delete an old lock on a guessed timeout. A crashed
      // owner's lock is reported for operator recovery rather than bypassed.
      await unlink(path.lock);
    }
  }

  async function wait(credential, { maxWaitMs = 10000 } = {}) {
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 60000) throw failure('REQUEST_BUDGET_WAIT_INVALID');
    const started = clock(), deadline = started + maxWaitMs;
    for (;;) {
      const result = await transaction(credential, deadline, (state, at) => {
        const activeQuota = state.quota?.resetAt > at ? state.quota : null;
        const effectiveLimit = Math.min(requestsPerMinute, ...state.starts.map(row => row.limit), activeQuota?.limit ?? MAX_RPM);
        const last = state.starts.at(-1);
        let availableAt = Math.max(at, state.cooldownUntil, last ? last.at + Math.ceil(WINDOW_MS / effectiveLimit) : 0);
        if (state.starts.length >= effectiveLimit) availableAt = Math.max(availableAt, state.starts[state.starts.length - effectiveLimit].at + WINDOW_MS);
        if (activeQuota?.remaining === 0) availableAt = Math.max(availableAt, activeQuota.resetAt);
        // maxWait bounds queued waiting, not unavoidable filesystem work for
        // an immediately available grant (including maxWaitMs: 0).
        if (availableAt > at && availableAt > deadline) {
          state.deferred++;
          return { deferred: true };
        }
        if (availableAt > at) return { delayMs: availableAt - at, write: false };
        state.sequence++;
        state.starts.push({ at, limit: requestsPerMinute, id: state.sequence });
        if (activeQuota) activeQuota.remaining = Math.max(0, activeQuota.remaining - 1);
        return { granted: true, reservationId: state.sequence, grantedAt: at, requestsInWindow: state.starts.length,
          effectiveLimit, providerRemaining: activeQuota?.remaining ?? null };
      });
      if (result.deferred) throw failure('REQUEST_PACING_DEFERRED');
      if (result.granted) return { cooldownDelayMs: Math.max(0, clock() - started), reservationId: result.reservationId,
        sharedBudget: { version: version, scope: group ? 'filesystem_group' : 'filesystem_credential',
          grantedAt: result.grantedAt, requestsInWindow: result.requestsInWindow, effectiveLimit: result.effectiveLimit,
          providerRemaining: result.providerRemaining } };
      await sleep(Math.min(result.delayMs, 250));
    }
  }

  wait.defer = async (credential, delayMs) => {
    if (!Number.isFinite(delayMs) || delayMs < 0 || !Number.isSafeInteger(Math.ceil(clock() + delayMs))) throw failure('REQUEST_BUDGET_COOLDOWN_INVALID');
    const until = clock() + Math.ceil(delayMs);
    await transaction(credential, clock() + 2000, state => { state.cooldownUntil = Math.max(state.cooldownUntil, until); return {}; });
    return until;
  };

  wait.observe = async (credential, headers, { reservationId, status } = {}) => {
    const limit = headerNumber(headers, 'X-RateLimit-Limit'), remaining = headerNumber(headers, 'X-RateLimit-Remaining');
    const reset = headerNumber(headers, 'X-RateLimit-Reset');
    const resetAt = reset === null ? null : Math.ceil(reset * 1000);
    const validQuota = Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(remaining)
      && remaining >= 0 && remaining <= limit && validTime(resetAt);
    if (!validQuota && status !== 429 && remaining !== 0) return;
    await transaction(credential, clock() + 2000, (state, at) => {
      if (validQuota && resetAt > at && (!state.quota || resetAt >= state.quota.resetAt)) {
        // A later request may already be in flight when an earlier response
        // returns. It cannot restore tokens reserved since that response's call.
        const since = Number.isSafeInteger(reservationId) ? state.starts.filter(row => row.id > reservationId).length : state.starts.length;
        const available = Math.max(0, remaining - since);
        state.quota = { observedAt: at, resetAt, limit,
          remaining: state.quota?.resetAt === resetAt ? Math.min(state.quota.remaining, available) : available };
      }
      if (status === 429) {
        const raw = headerValue(headers, 'Retry-After'), seconds = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
        const date = raw == null ? NaN : Date.parse(raw);
        const until = Number.isFinite(seconds) && seconds >= 0 ? at + Math.ceil(seconds * 1000)
          : Number.isFinite(date) ? Math.max(at, date) : validQuota && resetAt > at ? resetAt : at + WINDOW_MS;
        state.cooldownUntil = Math.max(state.cooldownUntil, until);
      } else if (!validQuota && remaining === 0) {
        // Without a usable reset, impose a local minute cooldown; this is not
        // presented as a provider-specified reset time.
        state.cooldownUntil = Math.max(state.cooldownUntil, at + WINDOW_MS);
      }
      return {};
    });
  };
  return wait;
}

export async function inspectSharedRequestBudget({ directory, now = Date.now(), version = SHARED_BUDGET_VERSION } = {}) {
  if (!validTime(now)) throw failure('REQUEST_BUDGET_CLOCK_INVALID');
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return { version: version, status: 'no_observations', buckets: [] }; throw error; }
  const buckets = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    try {
      const state = validateState(JSON.parse(await readFile(join(directory, name), 'utf8')));
      buckets.push({ bucket: name.slice(0, 12), status: state.updatedAt > now + 5000 ? 'clock_skew' : 'observed',
        updatedAt: new Date(state.updatedAt).toISOString(), grantsTotal: state.sequence, deferredTotal: state.deferred,
        requestsInTrailingMinute: state.starts.filter(row => row.at > now - WINDOW_MS).length,
        localCooldownUntil: state.cooldownUntil > now ? new Date(state.cooldownUntil).toISOString() : null,
        providerQuota: state.quota, providerQuotaCurrent: Boolean(state.quota?.resetAt > now) });
    } catch { buckets.push({ bucket: name.slice(0, 12), status: 'invalid_state' }); }
  }
  return { version: version, status: buckets.length ? 'observed' : 'no_observations',
    scope: 'Only callers sharing this directory and credential/group; other hosts, keys and external applications are not counted.',
    pendingLocks: names.filter(name => /^[a-f0-9]{64}\.lock$/.test(name)).length, buckets };
}

/** Preserve provider-specific public error codes without coupling the state engine to a vendor. */
export function providerBudgetError(error, provider) {
  if (String(error?.code || '').startsWith('REQUEST_')) {
    const code = error.code.replace(/^REQUEST_/, `${provider}_`);
    return Object.assign(new Error(code, { cause: error }), { code });
  }
  return error;
}
export function namespaceRequestBudget(gate, provider) {
  const call = method => async (...args) => {
    try { return await method(...args); } catch (error) { throw providerBudgetError(error, provider); }
  };
  const wrapped = call(gate); wrapped.defer = call(gate.defer); wrapped.observe = call(gate.observe);
  return wrapped;
}
