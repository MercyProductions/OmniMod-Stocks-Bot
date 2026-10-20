import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireMarketApplicationLock } from '../marketBotRuntime.js';
import { applicationStopPath, matchesStopRequest, requestApplicationStop, watchApplicationStop } from '../marketApplicationControl.js';

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-stop-test-'));
  try { await run(directory); }
  finally { if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('omnimod-stop-test-')) throw Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); }
}
test('stop requests must address the exact bot, host, PID and lock nonce', () => {
  const owner = { bot: 'forex', host: hostname(), pid: 123, nonce: randomUUID() };
  const request = { version: 1, action: 'stop', bot: owner.bot, host: owner.host, pid: owner.pid, ownerNonce: owner.nonce, requestId: randomUUID() };
  assert.equal(matchesStopRequest(request, owner), true);
  for (const overrides of [{ ownerNonce: randomUUID() }, { pid: 124 }, { host: 'elsewhere' }, { bot: 'options' }, { action: 'start' }, { requestId: '../../bad' }]) {
    assert.equal(matchesStopRequest({ ...request, ...overrides }, owner), false);
  }
});
test('a local stop invokes cleanup once and waits for its lock release', async () => temporary(async (directory) => {
  const release = await acquireMarketApplicationLock(directory, 'forex'); let stops = 0;
  const watcher = watchApplicationStop({ directory, owner: release.owner, intervalMs: 5,
    onStop: async () => { stops++; await new Promise((resolve) => setTimeout(resolve, 20)); await release(); } });
  watcher.start();
  try {
    const result = await requestApplicationStop({ directory, bot: 'forex', timeoutMs: 1000, pollMs: 5 });
    assert.equal(result.status, 'owner_released'); assert.equal(stops, 1);
    await watcher.poll(); assert.equal(stops, 1);
  } finally { watcher.close(); }
}));
test('stale stop requests cannot stop a new owner with the same PID', async () => temporary(async (directory) => {
  const release = await acquireMarketApplicationLock(directory, 'forex'); let stops = 0;
  const watcher = watchApplicationStop({ directory, owner: release.owner, onStop: async () => { stops++; } });
  await writeFile(applicationStopPath(directory), JSON.stringify({ version: 1, action: 'stop', bot: 'forex', host: hostname(),
    pid: process.pid, ownerNonce: randomUUID(), requestId: randomUUID() }));
  await watcher.poll(); assert.equal(stops, 0); await release(); watcher.close();
}));
test('an unresponsive application remains unconfirmed and its lock is preserved', async () => temporary(async (directory) => {
  const release = await acquireMarketApplicationLock(directory, 'forex');
  const result = await requestApplicationStop({ directory, bot: 'forex', timeoutMs: 20, pollMs: 5 });
  assert.equal(result.status, 'stop_not_confirmed');
  assert.equal(JSON.parse(await readFile(join(directory, 'discord-application.lock'))).nonce, release.owner.nonce); await release();
}));
test('missing owner is not reported as a verified graceful shutdown and remote owner is rejected', async () => temporary(async (directory) => {
  assert.equal((await requestApplicationStop({ directory, bot: 'forex' })).status, 'no_recorded_owner');
  await writeFile(join(directory, 'discord-application.lock'), JSON.stringify({ bot: 'forex', host: 'remote', pid: 1, nonce: randomUUID() }));
  await assert.rejects(requestApplicationStop({ directory, bot: 'forex' }), /could not be verified/);
}));
test('closing the control watcher cancels future stop handling', async () => temporary(async (directory) => {
  const release = await acquireMarketApplicationLock(directory, 'forex');
  const watcher = watchApplicationStop({ directory, owner: release.owner, onStop: () => assert.fail('closed watcher') });
  watcher.start(); watcher.close();
  await requestApplicationStop({ directory, bot: 'forex', timeoutMs: 10, pollMs: 5 }); await watcher.poll(); await release();
}));
