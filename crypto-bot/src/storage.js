import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { dataDir, legacyDataDir } from './config.js';

let initialized = false;

async function pruneProviderWindows() {
  const cutoff = Date.now() - 2 * 24 * 60 * 60_000;
  const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('provider-window-') || !entry.name.endsWith('.json')) continue;
    const file = path.join(dataDir, entry.name);
    const stats = await fs.stat(file).catch(() => null);
    if (stats && stats.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
  }
}

export async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (initialized) {
    return;
  }
  if (process.env.OMNIMOD_TEST_ISOLATE_DATA_DIR === '1'
    || path.resolve(dataDir) === path.resolve(legacyDataDir)) {
    initialized = true;
    await pruneProviderWindows();
    return;
  }
  initialized = true;
  const entries = await fs.readdir(legacyDataDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    await fs.copyFile(path.join(legacyDataDir, entry.name), path.join(dataDir, entry.name), fsConstants.COPYFILE_EXCL)
      .catch((error) => { if (error?.code !== 'EEXIST') throw error; });
  }
  await pruneProviderWindows();
}

export async function readJson(file, fallback = null) {
  await ensureDataDir();
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    // A damaged ledger/configuration must never silently become an empty one.
    throw new Error(`Unable to read stored JSON: ${path.basename(file)}`, { cause: error });
  }
}

const pendingWrites = new Map();

export async function writeJson(file, value, options = {}) {
  const key = path.resolve(file);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeJsonAtomic(file, value, options));
  pendingWrites.set(key, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
  }
}

async function writeJsonAtomic(file, value, options = {}) {
  await ensureDataDir();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: options.mode ?? 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

function safeId(value, fallback = 'default') {
  return String(value || '').replace(/[^0-9a-z_-]/gi, '') || fallback;
}

export const paths = {
  dayTradingWatchNotices: (guildId) => path.join(dataDir, `day-watch-notices-${safeId(guildId)}.json`),
  guildSettings: () => path.join(dataDir, 'guild-settings.json'),
  marketSnapshot: (guildId) => path.join(dataDir, `market-${safeId(guildId)}.json`),
  tracker: (guildId) => path.join(dataDir, `tracker-${safeId(guildId)}.json`),
  discovery: (guildId, dateKey) => path.join(dataDir, `discovery-${safeId(guildId)}-${dateKey}.json`),
  providerClaim: (guildId, dateKey) => path.join(dataDir, `provider-coingecko-${safeId(guildId)}-${dateKey}.json`),
  providerWindow: (windowKey) => path.join(dataDir, `provider-window-${safeId(windowKey)}.json`),
  scanDiagnostic: (guildId, scanId) => path.join(dataDir, `scan-diagnostic-${safeId(guildId)}-${safeId(scanId)}.json`),
  metaModel: () => path.join(dataDir, 'meta-models.json'),
  modelRegistry: () => path.join(dataDir, 'model-registry.json'),
  eventRisk: (guildId) => path.join(dataDir, `event-risk-${safeId(guildId)}.json`),
  validationReport: () => path.join(dataDir, 'validation-report.json'),
  historicalImportManifest: () => path.join(dataDir, 'historical-import-manifest.json'),
  derivativesState: () => path.join(dataDir, 'derivatives-state.json'),
  guardState: (guildId) => path.join(dataDir, `risk-guard-${safeId(guildId)}.json`),
  researchDir: () => path.join(dataDir, 'research'),
  microstructureDir: () => path.join(dataDir, 'microstructure')
};

export async function claimProviderWindow(windowKey, details = {}) {
  await ensureDataDir();
  const file = paths.providerWindow(windowKey);
  const claim = { windowKey, state: 'claimed', claimedAt: new Date().toISOString(), ...details };
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, 'utf8'); }
    finally { await handle.close(); }
    return { claimed: true, claim };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { claimed: false, claim: await readJson(file, null) };
  }
}

export async function claimDailyDiscovery(guildId, dateKey, details = {}) {
  await ensureDataDir();
  const file = paths.providerClaim(guildId, dateKey);
  const claim = { guildId, dateKey, state: 'claimed', claimedAt: new Date().toISOString(), ...details };
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, 'utf8'); }
    finally { await handle.close(); }
    return { claimed: true, claim };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readJson(file, null);
    const timestamp = existing?.completedAt || existing?.claimedAt;
    const staleFailedClaim = Boolean(existing?.failed) && timestamp && Date.now() - new Date(timestamp).getTime() > 5 * 60_000;
    const abandonedClaim = existing?.state === 'claimed' && timestamp && Date.now() - new Date(timestamp).getTime() > 10 * 60_000;
    if (staleFailedClaim || abandonedClaim) {
      await fs.unlink(file).catch(() => {});
      return claimDailyDiscovery(guildId, dateKey, { ...details, recoveredFrom: existing?.state || 'unknown' });
    }
    return { claimed: false, claim: existing };
  }
}

export async function finishDailyDiscovery(guildId, dateKey, patch = {}) {
  const file = paths.providerClaim(guildId, dateKey);
  const current = await readJson(file, null);
  if (!current) return null;
  const next = { ...current, ...patch, state: 'completed', completedAt: new Date().toISOString() };
  await writeJson(file, next);
  return next;
}

export async function readDailyDiscovery(guildId, dateKey) {
  return readJson(paths.discovery(guildId, dateKey), null);
}

export async function writeDailyDiscovery(guildId, dateKey, value) {
  return writeJson(paths.discovery(guildId, dateKey), value);
}

export async function readMarketSnapshot(guildId) {
  return readJson(paths.marketSnapshot(guildId), null);
}

export async function writeMarketSnapshot(guildId, value) {
  return writeJson(paths.marketSnapshot(guildId), value);
}

export async function readTracker(guildId) {
  const tracker = await readJson(paths.tracker(guildId), { version: 1, guildId, predictions: [], updatedAt: '' });
  if (!tracker || !Array.isArray(tracker.predictions)) {
    throw new Error('Invalid tracker ledger: predictions must be an array. Restore a valid backup before resuming.');
  }
  return tracker;
}

export async function writeTracker(guildId, value) {
  return writeJson(paths.tracker(guildId), value);
}

export async function listDiscoveries(guildId, limit = 30) {
  await ensureDataDir();
  const prefix = `discovery-${safeId(guildId)}-`;
  const files = (await fs.readdir(dataDir).catch(() => []))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort().reverse().slice(0, Math.max(1, Math.min(90, Number(limit) || 30)));
  const rows = [];
  for (const name of files) {
    const value = await readJson(path.join(dataDir, name), null);
    if (value) rows.push(value);
  }
  return rows;
}

export async function writeScanDiagnostic(guildId, row) {
  const scanId = `${Date.now()}-${randomUUID()}`;
  const file = paths.scanDiagnostic(guildId, scanId);
  await writeJson(file, { ...row, guildId, scanId });
  const prefix = `scan-diagnostic-${safeId(guildId)}-`;
  const files = (await fs.readdir(dataDir).catch(() => [])).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort().reverse();
  for (const stale of files.slice(100)) await fs.unlink(path.join(dataDir, stale)).catch(() => {});
  return { ...row, guildId, scanId };
}

export async function listScanDiagnostics(guildId, limit = 100) {
  await ensureDataDir();
  const prefix = `scan-diagnostic-${safeId(guildId)}-`;
  const files = (await fs.readdir(dataDir).catch(() => []))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort().reverse().slice(0, Math.max(1, Math.min(100, Number(limit) || 100)));
  const rows = [];
  for (const name of files) {
    const row = await readJson(path.join(dataDir, name), null);
    if (row) rows.push(row);
  }
  return rows;
}
