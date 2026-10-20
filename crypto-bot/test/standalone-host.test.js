import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { startStandaloneCryptoHost } from '../src/standaloneHost.js';

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-host-'));
  try { await run(directory); }
  finally { if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('omnimod-crypto-host-')) throw new Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true }); }
}

test('independent Crypto host loads one worker, refuses duplicate startup and closes only its worker', async () => temporary(async (directory) => {
  let loads = 0, stops = 0;
  const options = { directory, env: {}, auditRootDir: directory, installSignalHandlers: false,
    loadWorker: async () => { loads++; return { getRuntimeState: () => ({ discordReady: true, schedulerRunning: true }), shutdown: async () => { stops++; } }; } };
  const host = await startStandaloneCryptoHost(options);
  await assert.rejects(startStandaloneCryptoHost(options), /lock exists/);
  assert.equal(loads, 1);
  await Promise.all([host.stop(), host.stop()]);
  assert.equal(stops, 1);
  assert.equal((await readdir(join(directory, 'data'))).includes('discord-application.lock'), false);
}));

test('failed Crypto import and gateway readiness timeout release the host without starting another market', async () => temporary(async (directory) => {
  const options = { directory, env: {}, auditRootDir: directory, installSignalHandlers: false };
  await assert.rejects(startStandaloneCryptoHost({ ...options, loadWorker: async () => { throw new Error('import failure'); } }), /import failure/);
  let stops = 0;
  await assert.rejects(startStandaloneCryptoHost({ ...options, readinessTimeoutMs: 1,
    loadWorker: async () => ({ getRuntimeState: () => ({ discordReady: false }), shutdown: async () => { stops++; } }) }), /readiness timed out/);
  assert.equal(stops, 1);
  assert.equal((await readdir(join(directory, 'data'))).includes('discord-application.lock'), false);
}));
