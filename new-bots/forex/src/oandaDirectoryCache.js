import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeOandaDirectory } from './oandaUniverse.js';

const signature = (row) => JSON.stringify([row.type, row.displayPrecision, row.tradeUnitsPrecision,
  row.minimumTradeSize, row.maximumOrderUnits, row.marginRate, row.maximumPositionSize]);

/** Membership is scoped by environment/account without storing either credential. */
export function oandaDirectoryCachePath({ account, directory = join(process.cwd(), 'data') }) {
  if (!account) throw new Error('An account scope is required for the Forex directory cache.');
  const scope = createHash('sha256').update('oanda-practice:' + account).digest('hex');
  return join(directory, 'oanda-universe-' + scope + '.json');
}

export async function loadOandaDirectory({ path, fetchInstruments, now = Date.now(), ttlMs = 3_600_000 }) {
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) throw new RangeError('Forex directory TTL must be between one minute and one day.');
  let cached = null, cacheReadStatus = 'missing';
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length > 5_000_000) throw new Error('Oversized directory cache.');
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || !Number.isFinite(parsed.fetchedAt) || parsed.fetchedAt > now + 5_000) throw new Error('Invalid directory cache.');
    normalizeOandaDirectory({ instruments: parsed.instruments });
    cached = parsed;
    cacheReadStatus = 'valid';
  } catch (error) { if (error.code !== 'ENOENT') cacheReadStatus = 'invalid'; }
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < ttlMs) return {
    payload: { instruments: cached.instruments }, state: cached, previousQuotes: cached.quoteRows ?? {},
    diagnostics: { source: 'fresh_cache', cacheReadStatus, fetchedAt: new Date(cached.fetchedAt).toISOString(),
      ageMs: now - cached.fetchedAt, ttlMs, membershipDelta: cached.membershipDelta },
  };
  // A failed refresh throws. Expired membership is never silently approved.
  const fresh = normalizeOandaDirectory(await fetchInstruments());
  const before = new Map((cached?.instruments ?? []).map((row) => [row.name, row]));
  const after = new Map(fresh.instruments.map((row) => [row.name, row]));
  const membershipDelta = {
    baseline: cached == null,
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
    changed: [...after.keys()].filter((name) => before.has(name) && signature(before.get(name)) !== signature(after.get(name))).sort(),
  };
  const state = { version: 1, fetchedAt: now, instruments: fresh.instruments, membershipDelta,
    membershipHistory: [...(cached?.membershipHistory ?? []).slice(-29), { at: new Date(now).toISOString(), ...membershipDelta }],
    quoteRows: cached?.quoteRows ?? {} };
  return { payload: { instruments: fresh.instruments }, state, previousQuotes: state.quoteRows,
    diagnostics: { source: 'provider', cacheReadStatus, fetchedAt: new Date(now).toISOString(), ageMs: 0, ttlMs, membershipDelta } };
}

export async function saveOandaDirectory({ path, state, quoteRows = {}, now = Date.now() }) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ ...state, quoteRows, quoteSnapshotAt: now }) + '\n', 'utf8');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
