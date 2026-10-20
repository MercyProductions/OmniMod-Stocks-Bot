import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { FUTURES_H1_VERSION } from './databentoH1Normalization.js';

export const h1Fingerprint = (value) => createHash('sha256').update(value).digest('hex');
async function readBoundedJson(path, limit) {
  try {
    if ((await stat(path)).size > limit) throw new Error('H1 cache exceeds resource bound.');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('H1 cache is unreadable or corrupt.'); }
}
async function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}

/** One completed-hour query per cache. A failed paid attempt is never automatically repurchased. */
export async function withDatabentoH1Cache({ cachePath, key, maxBytes, now }, load) {
  if (!cachePath) return { ...await load(async () => {}), cached: false, cacheEnabled: false };
  const path = resolve(cachePath);
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(`${path}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('H1 cache refresh locked.'); throw new Error('H1 cache is unavailable.'); }
  try {
    const prior = await readBoundedJson(path, maxBytes * 6 + 4096);
    if (prior?.version === FUTURES_H1_VERSION && prior.key === key) {
      if (typeof prior.body !== 'string' || Buffer.byteLength(prior.body) > maxBytes
        || prior.sha256 !== h1Fingerprint(prior.body)) throw new Error('H1 cache integrity failure.');
      return { body: prior.body, sourceEstimatedCostUsd: prior.sourceEstimatedCostUsd, sha256: prior.sha256,
        capturedAt: prior.capturedAt, cached: true, cacheEnabled: true };
    }
    const attempted = await readBoundedJson(`${path}.attempt.json`, 1024 ** 2);
    if (attempted && (attempted.version !== 1 || !attempted.pending || typeof attempted.pending !== 'object' || Array.isArray(attempted.pending)))
      throw new Error('H1 attempt journal is invalid.');
    const pending = attempted?.pending || {};
    if (Object.hasOwn(pending, key)) throw new Error('H1 previous paid query attempt did not complete; automatic retry blocked.');
    if (Object.keys(pending).length >= 5000) throw new Error('H1 attempt journal requires operator maintenance.');
    const loaded = await load(async () => {
      pending[key] = new Date(now()).toISOString();
      await atomic(`${path}.attempt.json`, { version: 1, pending });
    });
    const saved = { version: FUTURES_H1_VERSION, key, ...loaded, sha256: h1Fingerprint(loaded.body), capturedAt: new Date(now()).toISOString() };
    await atomic(path, saved);
    delete pending[key];
    await atomic(`${path}.attempt.json`, { version: 1, pending });
    return { ...saved, cached: false, cacheEnabled: true };
  } finally { await lock.close(); await unlink(`${path}.lock`).catch(() => {}); }
}
