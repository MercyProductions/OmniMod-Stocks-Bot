import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Acquire exclusive ownership of one deterministic historical-backfill checkpoint. */
export async function acquireBackfillCheckpointLock(checkpointFile) {
  if (typeof checkpointFile !== 'string' || !checkpointFile.trim()) throw new TypeError('Backfill checkpoint path is required.');
  const lockFile = `${checkpointFile}.lock`;
  await fs.mkdir(path.dirname(checkpointFile), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  let handle;
  try {
    handle = await fs.open(lockFile, 'wx', 0o600);
  } catch (error) {
    let alreadyExists = error?.code === 'EEXIST';
    if (!alreadyExists && process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code)) {
      try { await fs.stat(lockFile); alreadyExists = true; }
      catch (statError) { if (statError?.code !== 'ENOENT') throw error; }
    }
    if (alreadyExists) {
      throw new Error(`An identical Stocks backfill is already running or left a lock requiring inspection: ${lockFile}`, { cause: error });
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), nonce, startedAt: new Date().toISOString() }));
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(lockFile).catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    try {
      const owner = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      if (owner?.nonce === nonce) await fs.unlink(lockFile);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  };
}
