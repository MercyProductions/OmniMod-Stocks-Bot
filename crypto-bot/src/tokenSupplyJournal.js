import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir as defaultDataDir } from './config.js';
import { ensureDataDir } from './storage.js';

const DAY = 86_400_000;
const TEN_YEARS_MS = 10 * 366 * DAY;
const queues = new Map();

function providerFamily(value) {
  const source = String(value || '').toLowerCase();
  if (source.includes('coingecko')) return 'CoinGecko';
  if (source.includes('coinpaprika')) return 'CoinPaprika';
  return '';
}

function monthKey(date) { return date.toISOString().slice(0, 7); }
function monthKeys(now) {
  const start = new Date(now.getTime() - TEN_YEARS_MS);
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(now); end.setUTCDate(1); end.setUTCHours(0, 0, 0, 0);
  const keys = [];
  while (start <= end) {
    keys.push(monthKey(start));
    start.setUTCMonth(start.getUTCMonth() + 1);
  }
  return keys;
}

function positive(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

function parseLog(content) {
  if (!content.trim()) return [];
  return content.trimEnd().split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error('Crypto token-supply history contains an invalid row; existing data was not replaced.', { cause: error }); }
  });
}

function buildSnapshot(context, now) {
  const { result } = context;
  const supply = result.supplySnapshot;
  const provider = providerFamily(supply?.source);
  const observedMs = Date.parse(supply?.observedAt || '');
  if (context.capture === false || !result.assetId || !provider || !Number.isFinite(observedMs)
    || observedMs > now.getTime() + 5_000 || now.getTime() - observedMs > DAY) return null;
  const values = {
    circulatingSupply: positive(supply.circulating), totalSupply: positive(supply.total),
    maxSupply: positive(supply.maximum), marketCapUsd: positive(supply.marketCapUsd),
    fullyDilutedValuationUsd: positive(supply.fullyDilutedValuationUsd)
  };
  if (!Object.values(values).some(Number.isFinite)) return null;
  return Object.freeze({ version: 1, assetId: String(result.assetId), symbol: String(result.symbol || ''), provider,
    observedAt: new Date(observedMs).toISOString(), recordedAt: now.toISOString(), ...values });
}

function compareSupply(current, prior, field) {
  const a = current[field], b = prior[field];
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b - 1) * 100 : null;
}

function annualizedSupplyChange(current, prior, field, elapsedDays) {
  const a = current[field], b = prior[field];
  if (!(elapsedDays >= 180) || !(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0)) return null;
  const annualized = (Math.pow(a / b, 365.2425 / elapsedDays) - 1) * 100;
  return Number.isFinite(annualized) ? annualized : null;
}

function summarizeSeries(rows, now) {
  const recent = rows.filter((row) => Date.parse(row.observedAt) >= now.getTime() - TEN_YEARS_MS)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const latest = recent.at(-1);
  if (!latest) return { samples: 0, latest: null, changes: [] };
  const changes = [30, 90, 365].map((targetDays) => {
    const target = Date.parse(latest.observedAt) - targetDays * DAY;
    const tolerance = Math.max(7, targetDays * 0.2) * DAY;
    const prior = recent.filter((row) => {
      const age = Date.parse(latest.observedAt) - Date.parse(row.observedAt);
      return age >= targetDays * DAY - tolerance && age <= targetDays * DAY + tolerance;
    }).sort((a, b) => Math.abs(Date.parse(a.observedAt) - target) - Math.abs(Date.parse(b.observedAt) - target))[0];
    const elapsedDays = prior ? Math.round((Date.parse(latest.observedAt) - Date.parse(prior.observedAt)) / DAY) : null;
    return prior ? { targetDays, elapsedDays, from: prior.observedAt, to: latest.observedAt,
      circulatingChangePct: compareSupply(latest, prior, 'circulatingSupply'),
      totalChangePct: compareSupply(latest, prior, 'totalSupply'),
      ...(targetDays === 365 ? {
        annualizedCirculatingChangePct: annualizedSupplyChange(latest, prior, 'circulatingSupply', elapsedDays),
        annualizedTotalChangePct: annualizedSupplyChange(latest, prior, 'totalSupply', elapsedDays)
      } : {}) } : { targetDays, elapsedDays: null,
      circulatingChangePct: null, totalChangePct: null };
  });
  return { provider: latest.provider, samples: recent.length, firstObservedAt: recent[0].observedAt,
    latest, changes, coverage: 'Provider-reported snapshots only; collection begins when this bot version runs.' };
}

export async function recordTokenSupplySnapshots(guildId, contexts, options = {}) {
  const id = String(guildId || '');
  if (!/^\d{5,25}$/.test(id)) throw new Error('A valid Discord server id is required for token-supply history.');
  const now = new Date(options.now ?? Date.now());
  const root = options.dataDir || defaultDataDir;
  const snapshots = contexts.map((context) => buildSnapshot(context, now)).filter(Boolean);
  const queueKey = path.resolve(root);
  let recorded = 0;
  const prior = queues.get(queueKey) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    if (!options.dataDir) await ensureDataDir();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const byMonth = new Map();
    for (const row of snapshots) {
      const key = monthKey(new Date(row.observedAt));
      byMonth.set(key, [...(byMonth.get(key) || []), row]);
    }
    for (const [key, rows] of byMonth) {
      const file = path.join(root, `crypto-token-supply-${key}.jsonl`);
      const existing = await fs.readFile(file, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
      const saved = parseLog(existing);
      const keys = new Set(saved.map((row) => `${row.assetId}|${row.provider}|${String(row.observedAt).slice(0, 10)}`));
      const fresh = rows.filter((row) => {
        const rowKey = `${row.assetId}|${row.provider}|${row.observedAt.slice(0, 10)}`;
        if (keys.has(rowKey)) return false;
        keys.add(rowKey); return true;
      });
      if (fresh.length) await fs.appendFile(file, `${fresh.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      recorded += fresh.length;
    }
  });
  queues.set(queueKey, task);
  try { await task; }
  finally { if (queues.get(queueKey) === task) queues.delete(queueKey); }

  const historyMonths = await Promise.all(monthKeys(now).map(async (key) => {
    const monthlyFile = path.join(root, `crypto-token-supply-${key}.jsonl`);
    const content = await fs.readFile(monthlyFile, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
    return parseLog(content);
  }));
  const historyRows = historyMonths.flat().filter((row) => row.version === 1 && Date.parse(row.observedAt) <= now.getTime());
  const byAssetId = {};
  for (const context of contexts) {
    const assetId = String(context.result.assetId || '');
    if (!assetId) continue;
    const provider = providerFamily(context.result.supplySnapshot?.source);
    if (!provider) continue;
    byAssetId[assetId] = summarizeSeries(historyRows.filter((row) => row.assetId === assetId && row.provider === provider), now);
  }
  return { byAssetId, recorded };
}
