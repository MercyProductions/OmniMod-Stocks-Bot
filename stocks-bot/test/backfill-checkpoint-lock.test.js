import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireBackfillCheckpointLock } from '../src/backfillCheckpointLock.js';

test('identical historical backfills cannot concurrently own the same checkpoint', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-backfill-checkpoint-'));
  const checkpoint = path.join(directory, 'same-query.json');
  try {
    const release = await acquireBackfillCheckpointLock(checkpoint);
    await assert.rejects(() => acquireBackfillCheckpointLock(checkpoint), /already running or left a lock/);
    const metadata = JSON.parse(await fs.readFile(`${checkpoint}.lock`, 'utf8'));
    assert.equal(metadata.pid, process.pid);
    assert.equal(typeof metadata.nonce, 'string');
    await release();
    await assert.rejects(() => fs.access(`${checkpoint}.lock`), { code: 'ENOENT' });
    const releaseRetry = await acquireBackfillCheckpointLock(checkpoint);
    await releaseRetry();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('checkpoint lock release does not remove a replacement owner lock', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-backfill-lock-owner-'));
  const checkpoint = path.join(directory, 'same-query.json');
  try {
    const release = await acquireBackfillCheckpointLock(checkpoint);
    const lockFile = `${checkpoint}.lock`;
    await fs.unlink(lockFile);
    await fs.writeFile(lockFile, JSON.stringify({ pid: 99, hostname: 'replacement', nonce: 'replacement-owner' }), { flag: 'wx' });
    await release();
    assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).nonce, 'replacement-owner');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a separate Stocks backfill process cannot acquire an already-owned checkpoint', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-backfill-cross-process-'));
  const checkpoint = path.join(directory, 'same-query.json');
  const modulePath = new URL('../src/backfillCheckpointLock.js', import.meta.url).href;
  const childSource = `import { acquireBackfillCheckpointLock } from ${JSON.stringify(modulePath)}; const release = await acquireBackfillCheckpointLock(process.argv[1]); console.log('ready'); await new Promise(r => setTimeout(r, 300)); await release();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, checkpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Checkpoint lock child timed out. ${stderr}`)), 5000);
      const pollOutput = () => {
        if (stdout.includes('ready')) { clearTimeout(timeout); resolve(); }
        else if (child.exitCode !== null) { clearTimeout(timeout); reject(new Error(`Checkpoint lock child exited early: ${stderr}`)); }
        else setTimeout(pollOutput, 10);
      };
      pollOutput();
    });
    await ready;
    await assert.rejects(() => acquireBackfillCheckpointLock(checkpoint), /already running or left a lock/);
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    const release = await acquireBackfillCheckpointLock(checkpoint);
    await release();
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
