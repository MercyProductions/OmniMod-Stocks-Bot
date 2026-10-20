import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyResearchBarLock, inspectResearchBarLocks } from '../src/researchBarLockDiagnostics.js';

test('research-bar lock classification never treats age alone as proof for removal', () => {
  const base = { ageMs: 500_000, staleAfterMs: 120_000, currentHost: 'local-host' };
  assert.equal(classifyResearchBarLock({ ...base, owner: { pid: 22, hostname: 'local-host' }, pidStatus: () => 'present' }).recovery,
    'do-not-remove; owner is running');
  assert.equal(classifyResearchBarLock({ ...base, owner: { pid: 22, hostname: 'local-host' }, pidStatus: () => 'absent' }).recovery,
    'manual-review-candidate; never removed automatically');
  assert.equal(classifyResearchBarLock({ ...base, owner: { pid: 22, hostname: 'remote-host' } }).recovery,
    'do-not-remove; remote owner cannot be checked');
  assert.match(classifyResearchBarLock({ ...base, owner: null }).recovery, /age alone is not evidence/);
});

test('research-bar lock report is read-only and exposes malformed, active and potentially stale locks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omnimod-research-lock-report-'));
  try {
    const barsDirectory = path.join(directory, 'bars');
    const activePath = path.join(barsDirectory, 'alpaca-iex', '2026-09-30.jsonl.lock');
    const brokenPath = path.join(barsDirectory, 'alpaca-sip', '2026-09-30.jsonl.lock');
    const checkpointDirectory = path.join(directory, 'checkpoints');
    const checkpointPath = path.join(checkpointDirectory, 'alpaca-123.json.lock');
    await fs.mkdir(path.dirname(activePath), { recursive: true });
    await fs.mkdir(path.dirname(brokenPath), { recursive: true });
    await fs.mkdir(barsDirectory, { recursive: true });
    await fs.mkdir(checkpointDirectory, { recursive: true });
    const active = JSON.stringify({ pid: 10, hostname: 'local', startedAt: '2026-09-30T00:00:00Z' });
    await fs.writeFile(activePath, active);
    await fs.writeFile(brokenPath, '{bad metadata');
    const checkpoint = JSON.stringify({ pid: 11, hostname: 'remote', startedAt: '2026-09-30T00:00:00Z' });
    await fs.writeFile(checkpointPath, checkpoint);
    const before = [await fs.readFile(activePath, 'utf8'), await fs.readFile(brokenPath, 'utf8'), await fs.readFile(checkpointPath, 'utf8')];
    const report = await inspectResearchBarLocks({ barDirectory: barsDirectory, additionalDirectories: [checkpointDirectory], now: Date.now() + 300_000, staleAfterMs: 120_000,
      currentHost: 'local', pidStatus: () => 'present' });
    assert.equal(report.count, 3);
    assert.ok(report.locks.some((row) => row.classification === 'owner-process-present'));
    assert.ok(report.locks.some((row) => row.classification === 'owner-host-is-remote'));
    assert.ok(report.locks.some((row) => row.classification === 'metadata-missing-or-invalid'));
    assert.ok(report.locks.every((row) => !row.recovery.includes('removed')));
    assert.deepEqual([await fs.readFile(activePath, 'utf8'), await fs.readFile(brokenPath, 'utf8'), await fs.readFile(checkpointPath, 'utf8')], before);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
