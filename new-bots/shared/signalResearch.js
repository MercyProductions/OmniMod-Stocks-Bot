import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

const owners = new Set(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);
const terminal = new Set(['target_hit', 'stop_hit', 'loss', 'win', 'closed', 'fell_short', 'expired', 'cancelled']);
const active = new Set(['active', 'tracking', 'pending_entry', 'open']);
const INTRADAY_STRATEGY_IDS = new Set(['intraday', 'daytrade', 'scalp', 'momentum', 'rapid', 'session']);
const defaultFile = resolve(dirname(fileURLToPath(import.meta.url)), 'data', 'primary-signals.jsonl');
const DEFAULT_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_JOURNAL_MAX_RECORDS = 5_000;
const SIGNAL_LOCK_STALE_MS = 60_000;

/** Only known short-horizon strategy labels may flow into another day-trading bot. */
export function isIntradayPrimaryResearch(signalOrStrategyId) {
  if (signalOrStrategyId && typeof signalOrStrategyId === 'object'
    && signalOrStrategyId.strategyFamily === 'intraday_day_trade'
    && owners.has(signalOrStrategyId.owner)) return true;
  const value = typeof signalOrStrategyId === 'string' ? signalOrStrategyId : signalOrStrategyId?.strategyId;
  const strategyId = String(value ?? '').trim().toLowerCase();
  return INTRADAY_STRATEGY_IDS.has(strategyId)
    || /^(stocks|crypto):(intraday|daytrade|scalp|momentum|rapid|session)$/.test(strategyId);
}

function normalize(row, owner, capturedAt) {
  const signalId = String(row?.id ?? row?.signalId ?? '').trim();
  const symbol = String(row?.symbol ?? row?.underlyingSymbol ?? '').trim().toUpperCase();
  const time = Date.parse(row?.createdAt ?? row?.observedAt ?? capturedAt);
  if (!signalId || !symbol || !Number.isFinite(time)) return null;
  const lifetime = {};
  for (const key of ['entryExpiresAt', 'forceExitAt']) {
    if (row?.[key] == null) continue;
    const at = typeof row[key] === 'number' ? new Date(row[key]).getTime() : typeof row[key] === 'string' ? Date.parse(row[key]) : NaN;
    if (!Number.isFinite(at) || at <= time) return null;
    lifetime[key] = new Date(at).toISOString();
  }
  if (lifetime.entryExpiresAt && lifetime.forceExitAt && Date.parse(lifetime.entryExpiresAt) > Date.parse(lifetime.forceExitAt)) return null;
  const direction = resolveDirection(row);
  const inputStatus = String(row?.status ?? '').trim().toLowerCase();
  const entry = finiteOrNull(row?.entryPrice);
  const target = finiteOrNull(row?.targetPrice);
  // Cross-bot directional context must never turn missing/flat evidence into an implicit long.
  if (!direction) return null;
  const material = { owner, signalId, symbol, time: new Date(time).toISOString() };
  const id = createHash('sha256').update(JSON.stringify(material)).digest('hex');
  const sourceNews = Array.isArray(row?.recentNews) ? row.recentNews : Array.isArray(row?.recentMarketNews) ? row.recentMarketNews : [];
  const recentNews = sourceNews.slice(0, 12).flatMap((article) => {
    const headline = String(article?.headline || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 180);
    const publisher = String(article?.publisher || article?.source || article?.provider || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
    const activityAt = Date.parse(article?.activityAt || article?.updatedAt || article?.createdAt || article?.publishedAt || '');
    let sourceUrl = '';
    try {
      const url = new URL(String(article?.sourceUrl || article?.url || ''));
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) sourceUrl = url.toString().slice(0, 500);
    } catch { /* The source link is optional; malformed URLs are not shared. */ }
    if (!headline || !Number.isFinite(activityAt) || activityAt > time + 60_000 || time - activityAt > 24 * 60 * 60_000
      || (!publisher && !sourceUrl)) return [];
    return [{ publisher, headline, sourceUrl, activityAt: new Date(activityAt).toISOString() }];
  }).slice(0, 2);
  return {
    id, owner, signalId, symbol, direction,
    instrumentKey: String(row?.instrumentKey ?? symbol).trim().toUpperCase().slice(0, 100),
    exposureKey: String(row?.exposureKey ?? symbol).trim().toUpperCase().slice(0, 80),
    strategyId: String(row?.horizonKey ?? row?.strategyId ?? 'unknown'),
    ...(row?.strategyFamily === 'intraday_day_trade' ? { strategyFamily: 'intraday_day_trade' } : {}),
    sessionDate: String(row?.dateKey ?? row?.sessionDate ?? material.time.slice(0, 10)),
    observedAt: material.time,
    ...lifetime,
    // These are point-in-time research levels from a primary bot, not executable quotes.
    entryLow: finiteOrNull(row?.entryLow), entryHigh: finiteOrNull(row?.entryHigh),
    entryPrice: entry,
    stopPrice: finiteOrNull(row?.stopPrice), targetPrice: finiteOrNull(row?.targetPrice),
    status: terminal.has(inputStatus) ? inputStatus : active.has(inputStatus) ? 'active' : 'unknown',
    catalystContextStatus: String(row?.recentNewsStatus || row?.recentMarketNewsStatus || (sourceNews.length ? 'available' : 'unknown')).slice(0, 30),
    catalystContext: recentNews,
    paperOnly: true, executable: false,
  };
}

function resolveDirection(row) {
  const explicit = explicitDirectionText(row);
  if (isExplicitNonAction(explicit)) return null;
  const short = /\b(?:short|down|bear(?:ish)?|sell)\b/.test(explicit);
  const long = /\b(?:long|up|bull(?:ish)?|buy)\b/.test(explicit);
  if (short && long) return null;
  if (short) return 'short';
  if (long) return 'long';
  const entry = finiteOrNull(row?.entryPrice);
  const target = finiteOrNull(row?.targetPrice);
  if (entry !== null && target !== null && target < entry) return 'short';
  if (entry !== null && target !== null && target > entry) return 'long';
  return null;
}

function isExplicitNonAction(value) {
  return /\b(?:abstain|withheld|no trade|do not (?:open|buy|enter|trade)|don't (?:open|buy|enter|trade))\b/.test(value);
}

function explicitDirectionText(row) {
  return [row?.action, row?.direction].filter((value) => value != null && String(value).trim()).join(' ').toLowerCase();
}

function finiteOrNull(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
}

function signalLockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : true; }
}

async function acquireSignalJournalLock(lockPath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
        return handle;
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const [raw, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
        let owner = null;
        try { owner = JSON.parse(raw); } catch { /* Invalid metadata is recoverable after its file has aged. */ }
        const ageMs = Date.now() - Date.parse(owner?.startedAt || '');
        const definitelyStale = owner?.hostname === hostname() && signalLockOwnerAlive(Number(owner.pid)) === false;
        const abandonedMetadata = (!owner || !Number.isFinite(ageMs) || !Number.isInteger(Number(owner.pid))
          || !owner.hostname) && Date.now() - details.mtimeMs > SIGNAL_LOCK_STALE_MS;
        if (definitelyStale || abandonedMetadata) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (inspectError) {
        if (inspectError.code === 'ENOENT') continue;
        // A just-created or remote lock is left untouched when it cannot be safely classified.
      }
      if (Date.now() >= deadline) throw new Error('Primary signal journal is locked; no records were changed.');
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function compactSignalJournal(path, records, { now, retentionMs, maxRecords, lockTimeoutMs }) {
  if (!Number.isFinite(retentionMs) || retentionMs < 1_000 || retentionMs > 30 * 24 * 60 * 60_000) {
    throw new RangeError('Signal journal retention must be between one second and 30 days.');
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 50_000) {
    throw new RangeError('Signal journal record limit must be an integer between 1 and 50000.');
  }
  const lockPath = `${path}.lock`;
  const lock = await acquireSignalJournalLock(lockPath, lockTimeoutMs);
  try {
    let content = '';
    try { content = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const byId = new Map();
    let expiredOrMalformed = 0;
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { expiredOrMalformed++; continue; }
      const observed = Date.parse(record?.observedAt ?? '');
      if (!owners.has(record?.owner) || record?.executable !== false || record?.paperOnly !== true
        || !record?.id || !Number.isFinite(observed) || observed > now + 5_000 || now - observed > retentionMs) {
        expiredOrMalformed++;
        continue;
      }
      byId.set(String(record.id), record);
    }
    for (const record of records) byId.set(String(record.id), record);
    const retained = [...byId.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-maxRecords);
    const compacted = `${retained.map((record) => JSON.stringify(record)).join('\n')}${retained.length ? '\n' : ''}`;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, compacted, 'utf8');
    try { await rename(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { rowsRetained: retained.length, rowsExpiredOrMalformed: expiredOrMalformed,
      rowsDroppedByLimit: Math.max(0, byId.size - retained.length) };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

/** Persist signals only after the primary bot confirms delivery and tracking. */
export async function publishPrimaryResearchSignals(owner, rows, { file = process.env.OMNIMOD_SIGNAL_RESEARCH_PATH, now = Date.now(),
  retentionMs = DEFAULT_JOURNAL_RETENTION_MS, maxRecords = DEFAULT_JOURNAL_MAX_RECORDS, lockTimeoutMs = 3_000 } = {}) {
  if (!owners.has(owner)) throw new Error('Unknown primary signal owner.');
  if (!Array.isArray(rows)) throw new TypeError('Signal rows must be an array.');
  validateJournalOptions({ now, retentionMs, maxRecords, lockTimeoutMs });
  const path = resolve(file || defaultFile);
  const capturedAt = new Date(now).toISOString();
  const records = rows.map((row) => normalize(row, owner, capturedAt)).filter(Boolean);
  const nonActionRows = rows.filter((row) => isExplicitNonAction(explicitDirectionText(row))).length;
  const ambiguousDirectionRows = rows.filter((row) => !isExplicitNonAction(explicitDirectionText(row)) && !resolveDirection(row)).length;
  const retentionCutoff = now - retentionMs;
  const publishableRecords = records.filter((record) => {
    const observed = Date.parse(record.observedAt);
    return Number.isFinite(observed) && observed <= now + 5_000 && observed >= retentionCutoff;
  });
  const rejectedRows = rows.length - publishableRecords.length;
  if (publishableRecords.length) {
    await mkdir(dirname(path), { recursive: true });
    const journal = await compactSignalJournal(path, publishableRecords.map((record) => ({ ...record, capturedAt })),
      { now, retentionMs, maxRecords, lockTimeoutMs });
    return { file: path, rowsWritten: publishableRecords.length, rowsRejected: rejectedRows,
      rejectionCounts: { explicit_no_action: nonActionRows, ambiguous_direction: ambiguousDirectionRows,
        other_invalid_record: rejectedRows - ambiguousDirectionRows - nonActionRows },
      journal, ids: publishableRecords.map((record) => record.id) };
  }
  return { file: path, rowsWritten: 0, rowsRejected: rejectedRows,
    rejectionCounts: { explicit_no_action: nonActionRows, ambiguous_direction: ambiguousDirectionRows,
      other_invalid_record: rejectedRows - ambiguousDirectionRows - nonActionRows },
    ids: [] };
}

/** Read recent cross-bot context. Directional signals and headlines are advisory, never executable or approval inputs. */
async function readPrimaryResearchSignalsInternal({ file = process.env.OMNIMOD_SIGNAL_RESEARCH_PATH, now = Date.now(), maxAgeMs = 30 * 60_000, owners: includeOwners } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new RangeError('maxAgeMs must be positive.');
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp.');
  if (includeOwners !== undefined && (!Array.isArray(includeOwners) || includeOwners.some((owner) => !owners.has(owner)))) {
    throw new TypeError('owners must be an array of known signal owners.');
  }
  const path = resolve(file || defaultFile);
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { records: [], diagnostics: { status: 'missing_file', linesRead: 0, consideredRecords: 0,
      acceptedRecords: 0, rejectedRecordCount: 0, rejectionCounts: {}, rejectedRecords: [], rejectedRecordDetailsOmitted: 0,
      expiredRecords: 0, expiredByOwner: {}, duplicateRecords: 0, malformedJsonRows: 0 } };
    throw error;
  }
  const allowed = includeOwners ? new Set(includeOwners) : owners;
  const unique = new Map();
  const rejectionCounts = {};
  const rejectedRecords = [];
  const expiredByOwner = {};
  let consideredRecords = 0;
  let expiredRecords = 0;
  let duplicateRecords = 0;
  let malformedJsonRows = 0;
  let rejectedRecordDetailsOmitted = 0;
  let rejectedRecordCount = 0;
  const reject = (record, lineNumber, reasons) => {
    rejectedRecordCount += 1;
    for (const reason of reasons) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    if (rejectedRecords.length >= 1_000) { rejectedRecordDetailsOmitted += 1; return; }
    const bounded = (value, max = 100) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) || null;
    rejectedRecords.push({ lineNumber, recordId: bounded(record?.id ?? record?.signalId), owner: bounded(record?.owner, 30),
      symbol: bounded(record?.symbol, 32)?.toUpperCase() ?? null, reasons });
  };
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    consideredRecords += 1;
    let record;
    try { record = JSON.parse(line); }
    catch {
      malformedJsonRows += 1;
      reject(null, index + 1, ['malformed_json']);
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      reject(null, index + 1, ['record_not_object']);
      continue;
    }
    if (!owners.has(record.owner)) {
      reject(record, index + 1, ['source_owner_invalid']);
      continue;
    }
    // Other known owners are intentionally outside this consumer's requested scope.
    if (!allowed.has(record.owner)) continue;
    const reasons = [];
    if (record.executable !== false) reasons.push('signal_not_explicitly_non_executable');
    if (record.paperOnly !== true) reasons.push('signal_not_marked_paper_only');
    if (typeof record.id !== 'string' || !record.id.trim()) reasons.push('signal_id_missing');
    const observed = Date.parse(record.observedAt);
    if (!Number.isFinite(observed)) reasons.push('observation_time_invalid');
    else if (observed > now + 5_000) reasons.push('observation_from_future');
    else if (now - observed > maxAgeMs) {
      expiredRecords += 1;
      expiredByOwner[record.owner] = (expiredByOwner[record.owner] || 0) + 1;
      continue;
    }
    if (reasons.length) {
      reject(record, index + 1, reasons);
      continue;
    }
    if (unique.has(record.id)) {
      duplicateRecords += 1;
      reject(record, index + 1, ['duplicate_signal_id']);
    }
    unique.set(record.id, record);
  }
  const records = [...unique.values()].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  return { records, diagnostics: { status: 'complete', linesRead: lines.filter((line) => line.trim().length > 0).length,
    consideredRecords, acceptedRecords: records.length, rejectedRecordCount: Object.values(rejectionCounts).length
      ? rejectedRecordCount : 0,
    rejectionCounts, rejectedRecords, rejectedRecordDetailsOmitted, expiredRecords, expiredByOwner,
    duplicateRecords, malformedJsonRows } };
}

/** Read recent cross-bot context. Directional signals and headlines are advisory, never executable or approval inputs. */
export async function readPrimaryResearchSignals(options = {}) {
  return (await readPrimaryResearchSignalsInternal(options)).records;
}

/** Read cross-bot context and explain source-journal rows excluded by trust, freshness, and deduplication gates. */
export async function readPrimaryResearchSignalsWithDiagnostics(options = {}) {
  return readPrimaryResearchSignalsInternal(options);
}

function validateJournalOptions({ now, retentionMs, maxRecords, lockTimeoutMs }) {
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite timestamp.');
  if (!Number.isFinite(new Date(now).getTime())) throw new TypeError('now must be a valid timestamp.');
  if (!Number.isFinite(retentionMs) || retentionMs < 1_000 || retentionMs > 30 * 24 * 60 * 60_000) {
    throw new RangeError('Signal journal retention must be between one second and 30 days.');
  }
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 50_000) {
    throw new RangeError('Signal journal record limit must be an integer between 1 and 50000.');
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 30_000) {
    throw new RangeError('Signal journal lock timeout must be an integer between 0 and 30000 milliseconds.');
  }
}
