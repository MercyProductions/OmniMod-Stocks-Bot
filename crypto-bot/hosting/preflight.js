import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { appDir, delay, hostingDir, matchesProcess, processIdentity, readJson, stateDir, stopOwned } from './common.js';

export async function hostPreflight() {
  if (process.platform !== 'linux') throw new Error('Linux required');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID(), file = join(stateDir, `probe-${nonce}.json`), lock = join(stateDir, `probe-${nonce}.lock`);
  const entry = join(hostingDir, 'probe-worker.js');
  let saved, finished, child;
  const run = (args) => {
    const processChild = spawn('/usr/bin/flock', ['-n', lock, process.execPath, ...args],
      { cwd: appDir, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, OMNIMOD_INDEPENDENT_STATE_DIR: stateDir } });
    const done = new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('exit', (code) => resolve(code)); });
    done.catch(() => {}); return { processChild, done };
  };
  try {
    ({ processChild: child, done: finished } = run([entry, nonce]));
    for (let attempt = 0; attempt < 50; attempt++) { saved = await readJson(file); if (saved) break; await delay(100); }
    if (!saved) throw new Error('Offline probe did not start');
    if (!matchesProcess(saved, await processIdentity(saved.processId), entry, appDir, nonce)) throw new Error('Kernel process identity mismatch');
    if (await run(['-e', 'process.exit(42)']).done !== 1) throw new Error('Duplicate-process flock exclusion failed');
    if (await stopOwned({ ...saved, startTicks: 'wrong' }, entry, appDir, nonce)) throw new Error('Reused PID protection failed');
    if (!await stopOwned(saved, entry, appDir, nonce)) throw new Error('Probe shutdown failed');
    if (await finished !== 0) throw new Error('Probe exit was not clean');
    if (await run(['-e', 'process.exit(0)']).done !== 0) throw new Error('Kernel lock was not released');
    return { passed: true, nodeVersion: process.version, kernelProcessIdentity: true, exclusiveFlock: true,
      pidReuseProtection: true, gracefulShutdown: true, lockRelease: true, completedAt: new Date().toISOString() };
  } finally {
    if (saved) await stopOwned(saved, entry, appDir, nonce).catch(() => {});
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await unlink(file).catch(() => {}); await unlink(lock).catch(() => {});
  }
}
