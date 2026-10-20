import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { gzip as gzipCallback, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { dataDir } from './config.js';

const gzip = promisify(gzipCallback);

const RETENTION_DAYS = 1_460;
const queues = new Map();
let lastPrunedDate = '';

function providerKey(source) {
  if (/coingecko/i.test(String(source || ''))) return 'coingecko';
  if (/coinpaprika/i.test(String(source || ''))) return 'coinpaprika';
  return '';
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function filePath(dateKey, provider) {
  return path.join(dataDir, `crypto-universe-${provider}-${dateKey}.json.gz`);
}

async function writeGzipAtomic(file, value) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const compressed = await gzip(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
    await fs.writeFile(temporary, compressed, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function pruneOldSnapshots(today) {
  if (lastPrunedDate === today) return;
  const cutoff = new Date(`${today}T00:00:00.000Z`).getTime() - RETENTION_DAYS * 86_400_000;
  const files = await fs.readdir(dataDir).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of files) {
    const match = /^crypto-universe-(?:coingecko|coinpaprika)-(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(name);
    if (!match || !validDateKey(match[1])) continue;
    if (Date.parse(`${match[1]}T00:00:00.000Z`) < cutoff) await fs.unlink(path.join(dataDir, name)).catch(() => {});
  }
  lastPrunedDate = today;
}

export async function appendCryptoUniverseSnapshot(snapshot = {}) {
  const provider = providerKey(snapshot.source);
  const capturedMs = Date.parse(snapshot.fetchedAt || '');
  if (!provider || !Number.isFinite(capturedMs)) return { status: 'skipped', reason: 'unsupported_provider_or_timestamp' };
  const capturedAt = new Date(capturedMs).toISOString();
  const dateUtc = capturedAt.slice(0, 10);
  const assets = [...new Map((Array.isArray(snapshot.assets) ? snapshot.assets : []).flatMap((asset) => {
    const id = String(asset?.id || '').trim();
    if (!id) return [];
    return [[id, { id, symbol: String(asset.symbol || '').toUpperCase().slice(0, 32), rank: Number.isFinite(Number(asset.rank)) ? Number(asset.rank) : null }]];
  })).values()];
  if (!assets.length) return { status: 'skipped', reason: 'empty_asset_membership', provider, dateUtc };
  const file = filePath(dateUtc, provider);
  const key = path.resolve(file);
  const previous = queues.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await pruneOldSnapshots(dateUtc);
    const existing = await fs.readFile(file).then((bytes) => JSON.parse(gunzipSync(bytes).toString('utf8')))
      .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(new Error(`Unable to read Crypto universe journal: ${path.basename(file)}`, { cause: error })));
    if (existing && (existing.version !== 1 || existing.provider !== provider || existing.dateUtc !== dateUtc || !Array.isArray(existing.assets)))
      throw new Error('Crypto universe journal schema is invalid; preserve and repair the existing snapshot before writing.');
    if (existing && Date.parse(existing.capturedAt) >= capturedMs)
      return { status: 'unchanged', provider, dateUtc, assetCount: existing.assets.length, retentionDays: RETENTION_DAYS };
    const record = {
      version: 1, provider, source: String(snapshot.source || provider), dateUtc, capturedAt,
      providerReportedTotal: snapshot.providerReportedTotal !== null && snapshot.providerReportedTotal !== undefined
        && Number.isSafeInteger(Number(snapshot.providerReportedTotal)) ? Number(snapshot.providerReportedTotal) : null,
      providerRowsReturned: Math.max(0, Number(snapshot.providerRowsReturned) || assets.length),
      queryOrder: String(snapshot.queryOrder || 'provider-defined'),
      marketCapRankCapRequested: Number.isFinite(Number(snapshot.marketCapRankCapRequested)) ? Number(snapshot.marketCapRankCapRequested) : null,
      discoveryPages: Math.max(0, Number(snapshot.discoveryPages) || 0),
      marketCapPagesFetched: Math.max(0, Number(snapshot.marketCapPagesFetched) || 0),
      marketCapPagesRequested: Math.max(0, Number(snapshot.marketCapPagesRequested) || 0),
      providerErrors: (Array.isArray(snapshot.providerErrors) ? snapshot.providerErrors : []).slice(0, 8).map((item) => String(item).slice(0, 240)),
      assetCount: assets.length, assets
    };
    await writeGzipAtomic(file, record);
    return { status: 'recorded', provider, dateUtc, assetCount: assets.length, retentionDays: RETENTION_DAYS };
  });
  queues.set(key, task);
  try { return await task; }
  finally { if (queues.get(key) === task) queues.delete(key); }
}

export async function readCryptoUniverseSnapshot(dateUtc, provider) {
  const normalizedProvider = providerKey(provider);
  if (!validDateKey(String(dateUtc || '')) || !normalizedProvider) return null;
  const file = filePath(dateUtc, normalizedProvider);
  return fs.readFile(file).then((bytes) => JSON.parse(gunzipSync(bytes).toString('utf8')))
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(new Error(`Unable to read Crypto universe journal: ${path.basename(file)}`, { cause: error })));
}

export const cryptoUniverseJournalRetentionDays = RETENTION_DAYS;
