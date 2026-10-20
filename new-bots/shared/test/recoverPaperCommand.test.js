import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPaperRecovery } from '../recoverPaper.js';

test('operator recovery cancels expired unfilled reservations and is safe to repeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-paper-recover-cli-'));
  const statePath = join(directory, 'ledger.json');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [
      { orderId: 'expired-1', status: 'reserved', entryExpiresAt: new Date(now - 1).toISOString() },
      { orderId: 'time-expired-1', status: 'reserved', entryExpiresAt: new Date(now + 60_000).toISOString(), forceExitAt: new Date(now - 1).toISOString() },
      { orderId: 'filled-1', status: 'filled', forceExitAt: new Date(now - 1).toISOString() },
    ] }));
    const result = await runPaperRecovery({ statePath, now, emergencyStop: false, ownerStoppedConfirmed: true });
    assert.equal(result.status, 'reconciled');
    assert.equal(result.recovery.cancelledReservations, 2);
    assert.equal(result.recovery.awaitingFreshQuote, 1);
    assert.equal(result.recovery.outcomes.find((row) => row.orderId === 'filled-1').reason, 'time_exit_waiting_for_fresh_executable_quote');
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].status, 'cancelled');
    assert.equal(ledger.orders[1].status, 'cancelled');
    assert.equal(ledger.orders[1].cancelReason, 'time_exit_before_fill');
    assert.equal(ledger.orders[2].status, 'filled');
    assert.equal(ledger.orders[2].exitPrice, undefined);
    const repeated = await runPaperRecovery({ statePath, now, emergencyStop: false, ownerStoppedConfirmed: true });
    assert.equal(repeated.recovery.cancelledReservations, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('emergency-stop recovery preserves filled paper positions and explains that fresh quotes are required', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-paper-recover-stop-'));
  const statePath = join(directory, 'ledger.json');
  const now = Date.parse('2026-09-29T15:00:00Z');
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [
      { orderId: 'filled-stop', status: 'open', fillPrice: 100, markPrice: 99, exitPrice: undefined },
    ] }));
    const result = await runPaperRecovery({ statePath, now, emergencyStop: true, ownerStoppedConfirmed: true });
    assert.equal(result.recovery.awaitingFreshQuote, 1);
    assert.equal(result.recovery.outcomes[0].reason, 'emergency_stop_waiting_for_fresh_executable_quote');
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].status, 'open');
    assert.equal(ledger.orders[0].fillPrice, 100);
    assert.equal(ledger.orders[0].exitPrice, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('manual recovery requires explicit owner-stopped confirmation before mutating the ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-paper-recover-confirm-'));
  const statePath = join(directory, 'ledger.json');
  const original = JSON.stringify({ schemaVersion: 1, events: [], orders: [
    { orderId: 'expired-unconfirmed', status: 'reserved', entryExpiresAt: '2026-09-29T14:59:59Z' },
  ] });
  try {
    await writeFile(statePath, original);
    const result = await runPaperRecovery({ statePath, now: Date.parse('2026-09-29T15:00:00Z'), emergencyStop: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'operator_confirmation_required');
    assert.equal(await readFile(statePath, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('operator recovery refuses to touch a locked ledger and does not remove the lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-paper-recover-lock-'));
  const statePath = join(directory, 'ledger.json');
  const lockPath = `${statePath}.lock`;
  try {
    const lockText = JSON.stringify({ pid: 3, hostname: 'another-host', operation: 'update', startedAt: new Date().toISOString() });
    await writeFile(lockPath, lockText);
    const result = await runPaperRecovery({ statePath });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'ledger_lock_requires_manual_review');
    assert.equal(await readFile(lockPath, 'utf8'), lockText);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
