import { createHash } from 'node:crypto';
import { localDateKey } from './time.js';
import { paths } from './storage.js';
import { readJsonLines, recordUniverseRows, researchFiles } from './researchStore.js';
import { recordProviderRequest } from './scanDiagnostics.js';
import { waitForAlpacaRequest, alpacaThrottleDelayMs } from './alpacaRequestGate.js';

function fingerprint(asset) {
  return createHash('sha256').update(JSON.stringify([
    asset.id, asset.symbol, asset.exchange, asset.status, asset.tradable, asset.marginable,
    asset.shortable, asset.easy_to_borrow, asset.fractionable
  ])).digest('hex').slice(0, 16);
}

async function fetchAssets(keys, metrics, requestOptions = {}) {
  const fetcher = requestOptions.fetcher || fetch;
  const wait = requestOptions.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const gate = requestOptions.requestGate ?? waitForAlpacaRequest;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let grant;
    try { grant = await gate(keys.alpaca_key_id); }
    catch (error) {
      recordProviderRequest(metrics, 'Alpaca assets', { requestAttempted: false, error: error.code || 'ALPACA_BUDGET_UNAVAILABLE' });
      throw error;
    }
    const startedAt = Date.now();
    let response;
    let recorded = false;
    try {
      response = await fetcher('https://paper-api.alpaca.markets/v2/assets?status=all&asset_class=us_equity', {
        headers: {
          accept: 'application/json',
          'APCA-API-KEY-ID': keys.alpaca_key_id,
          'APCA-API-SECRET-KEY': keys.alpaca_secret_key
        },
        signal: AbortSignal.timeout(requestOptions.timeoutMs || 30_000)
      });
      await gate.observe?.(keys.alpaca_key_id, response.headers, { reservationId: grant?.reservationId, status: response.status });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Alpaca assets returned HTTP ${response.status}: ${text.slice(0, 180)}`);
        error.status = response.status;
        error.retryAfter = response.headers?.get?.('retry-after') ?? null;
        recordProviderRequest(metrics, 'Alpaca assets', { latencyMs: Date.now() - startedAt, status: response.status, headers: response.headers, retry: attempt > 0, error: error.message });
        recorded = true;
        throw error;
      }
      const rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('Alpaca all-status assets response was not a non-empty array; existing universe history was preserved.');
      const seenAssetKeys = new Set();
      for (const asset of rows) {
        const symbol = typeof asset?.symbol === 'string' ? asset.symbol.trim() : '';
        const id = typeof asset?.id === 'string' ? asset.id.trim() : '';
        const assetKey = id || symbol;
        if (!symbol || !assetKey || seenAssetKeys.has(assetKey) || !['active', 'inactive'].includes(asset?.status)) {
          throw new Error('Alpaca all-status assets response contained a missing/duplicate asset identity or invalid status; existing universe history was preserved.');
        }
        seenAssetKeys.add(assetKey);
      }
      recordProviderRequest(metrics, 'Alpaca assets', { latencyMs: Date.now() - startedAt, status: response.status, headers: response.headers, retry: attempt > 0 });
      recorded = true;
      return rows;
    } catch (error) {
      if (!recorded) recordProviderRequest(metrics, 'Alpaca assets', { latencyMs: Date.now() - startedAt, status: error?.status || response?.status || 0, headers: response?.headers, retry: attempt > 0, error: error?.message || String(error) });
      lastError = error;
      const retryableStatus = [429, 500, 502, 503, 504].includes(error?.status);
      const retryableTransport = ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name);
      const retryAfter = error.status === 429 ? alpacaThrottleDelayMs(response?.headers, Date.now(), 1000 * 2 ** attempt) : null;
      if (retryAfter !== null) await gate.defer?.(keys.alpaca_key_id, retryAfter);
      if (attempt >= 2 || (!retryableStatus && !retryableTransport)) break;
      if (retryAfter !== null && retryAfter > 10_000) break;
      await wait(retryAfter ?? 1_000 * (2 ** attempt));
    }
  }
  throw lastError;
}

export async function reconstructUniverse(asOfDate = '9999-12-31', guildId) {
  const files = (await researchFiles('universe')).filter((file) => file.endsWith('.jsonl')).sort();
  const state = new Map();
  for (const file of files) {
    const dateKey = file.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1] || '';
    if (dateKey > asOfDate) continue;
    for (const row of await readJsonLines(file)) {
      if (row.recordType !== 'universe_asset') continue;
      if (guildId !== undefined && row.guildId !== guildId) continue;
      const assetKey = String(row.assetKey || row.id || row.symbol || '');
      if (!assetKey) continue;
      if (row.action === 'remove') state.delete(assetKey);
      else state.set(assetKey, row);
    }
  }
  return state;
}

export async function captureUniverseSnapshot(guildId, keys, now = new Date(), metrics, requestOptions) {
  if (!keys?.alpaca_key_id || !keys?.alpaca_secret_key) return { skipped: true, reason: 'Alpaca credentials are not configured.' };
  const dateKey = localDateKey(now, 'America/New_York');
  const existingToday = await readJsonLines(paths.researchUniverse(dateKey));
  if (existingToday.some((row) => row.recordType === 'universe_snapshot' && row.guildId === guildId)) {
    return { skipped: true, reason: 'Today\'s point-in-time universe snapshot already exists.', dateKey };
  }
  const [assets, previous] = await Promise.all([fetchAssets(keys, metrics, requestOptions), reconstructUniverse(dateKey, guildId)]);
  const current = new Map(assets.map((asset) => [String(asset.id || asset.symbol), asset]));
  const rows = [];
  for (const [assetKey, asset] of current) {
    const hash = fingerprint(asset);
    if (previous.get(assetKey)?.fingerprint === hash) continue;
    rows.push({
      schemaVersion: 1, recordType: 'universe_asset', action: 'upsert', recordedAt: now.toISOString(),
      dateKey, guildId, fingerprint: hash, assetKey, id: asset.id || '', symbol: asset.symbol, name: asset.name || '',
      exchange: asset.exchange || '', status: asset.status || '', class: asset.class || '',
      tradable: Boolean(asset.tradable), marginable: Boolean(asset.marginable), shortable: Boolean(asset.shortable),
      easyToBorrow: Boolean(asset.easy_to_borrow), fractionable: Boolean(asset.fractionable)
    });
  }
  for (const [assetKey, asset] of previous) {
    if (!current.has(assetKey)) rows.push({
      schemaVersion: 1, recordType: 'universe_asset', action: 'remove', recordedAt: now.toISOString(),
      dateKey, guildId, fingerprint: '', assetKey, id: asset.id || '', symbol: asset.symbol
    });
  }
  rows.push({
    schemaVersion: 1, recordType: 'universe_snapshot', recordedAt: now.toISOString(), dateKey, guildId,
    assetsReturned: current.size, activeAssets: assets.filter((asset) => asset.status === 'active').length,
    inactiveAssets: assets.filter((asset) => asset.status === 'inactive').length,
    upserts: rows.filter((row) => row.action === 'upsert').length,
    removals: rows.filter((row) => row.action === 'remove').length,
    fullBaseline: previous.size === 0
  });
  await recordUniverseRows(dateKey, rows);
  return { dateKey, assetsReturned: current.size, activeAssets: assets.filter((asset) => asset.status === 'active').length,
    inactiveAssets: assets.filter((asset) => asset.status === 'inactive').length, rowsWritten: rows.length, fullBaseline: previous.size === 0 };
}
