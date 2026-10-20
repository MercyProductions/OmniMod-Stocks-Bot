import fs from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';

function probePid(pid) {
  try { process.kill(pid, 0); return 'present'; }
  catch (error) { return error?.code === 'ESRCH' ? 'absent' : 'unverifiable'; }
}

export function classifyResearchBarLock({ owner, ageMs, staleAfterMs, currentHost, pidStatus = probePid } = {}) {
  const validAge = Number.isFinite(ageMs) && ageMs >= 0;
  const old = validAge && Number.isFinite(staleAfterMs) && ageMs >= staleAfterMs;
  const validOwner = Number.isSafeInteger(owner?.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && owner.hostname.length > 0;
  const ownerProcess = !validOwner ? 'unknown' : owner.hostname !== currentHost ? 'remote-unverifiable' : pidStatus(owner.pid);
  const classification = !validOwner ? 'metadata-missing-or-invalid'
    : ownerProcess === 'present' ? 'owner-process-present'
      : ownerProcess === 'absent' ? 'owner-process-absent'
        : ownerProcess === 'remote-unverifiable' ? 'owner-host-is-remote' : 'owner-process-unverifiable';
  const recovery = classification === 'owner-process-absent' && old
    ? 'manual-review-candidate; never removed automatically'
    : classification === 'owner-process-present' ? 'do-not-remove; owner is running'
      : classification === 'owner-host-is-remote' ? 'do-not-remove; remote owner cannot be checked'
        : 'manual-review-required; age alone is not evidence that the lock is stale';
  return { classification, ownerProcess, ageMs: validAge ? Math.round(ageMs) : null,
    staleThresholdMs: Number.isFinite(staleAfterMs) && staleAfterMs >= 0 ? staleAfterMs : null,
    olderThanThreshold: old, recovery };
}

async function filesRecursive(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursive(target));
    else if (entry.isFile() && (entry.name.endsWith('.jsonl.lock') || entry.name.endsWith('.json.lock'))) files.push(target);
  }
  return files;
}

/** Read-only inspection; this function never modifies or removes lock files. */
export async function inspectResearchBarLocks({ barDirectory, additionalDirectories = [], now = Date.now(), staleAfterMs = 120_000,
  currentHost = hostname(), pidStatus = probePid } = {}) {
  if (typeof barDirectory !== 'string' || !barDirectory || !Number.isFinite(now)
    || !Array.isArray(additionalDirectories) || additionalDirectories.some((directory) => typeof directory !== 'string' || !directory)
    || !Number.isFinite(staleAfterMs) || staleAfterMs < 0 || typeof currentHost !== 'string' || typeof pidStatus !== 'function') {
    throw new TypeError('Research bar lock inspection settings are invalid.');
  }
  const locks = [];
  const directories = [barDirectory, ...additionalDirectories].map((directory) => path.resolve(directory));
  for (const file of (await Promise.all(directories.map(filesRecursive))).flat()) {
    const [stats, raw] = await Promise.all([fs.stat(file), fs.readFile(file, 'utf8')]);
    let owner = null;
    try { owner = JSON.parse(raw); } catch { /* Keep invalid metadata visible as unknown. */ }
    const ageMs = now - stats.mtimeMs;
    const status = classifyResearchBarLock({ owner, ageMs, staleAfterMs, currentHost, pidStatus });
    locks.push({ file, owner: Number.isSafeInteger(owner?.pid) ? { pid: owner.pid,
      hostname: typeof owner.hostname === 'string' ? owner.hostname : null,
      startedAt: typeof owner.startedAt === 'string' ? owner.startedAt : null } : null, ...status });
  }
  return { inspectedAt: new Date(now).toISOString(), directories, count: locks.length, locks,
    policy: 'Read-only. Never remove by age alone. Stop writers and confirm a same-host owner PID is absent before manual removal.' };
}
