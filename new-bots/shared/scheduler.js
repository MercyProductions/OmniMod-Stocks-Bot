import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { createRunnerHeartbeat } from './runnerHeartbeat.js';
import { paperLedgerFingerprint } from './paperStatePath.js';

const entry = process.argv[2];
if (!entry) throw new Error('Pass a project entry file, for example src/index.js.');

const rawMinutes = Number(process.env.SCAN_INTERVAL_MINUTES ?? 5);
if (!Number.isFinite(rawMinutes) || rawMinutes < 1 || rawMinutes > 1440) {
  throw new Error('SCAN_INTERVAL_MINUTES must be between 1 and 1440.');
}
const intervalMs = rawMinutes * 60_000;
const target = resolve(process.cwd(), entry);
let child = null;
let stopping = false;
let timer = null;
let schedulerState = 'starting';
let lastScanStartedAt = null, lastScanFinishedAt = null, lastScanExitCode = null, nextScanAt = null;
const bot = basename(process.cwd());
const heartbeat = createRunnerHeartbeat({ bot, directory: resolve(process.cwd(), 'data'), role: 'scheduled-runner',
  getState: () => ({ state: schedulerState, childPid: child?.pid ?? null, lastScanStartedAt, lastScanFinishedAt,
    lastScanExitCode, nextScanAt, emergencyStopActive: process.env.OMNIMOD_EMERGENCY_STOP !== 'false', liveTradingEnabled: false,
    ledgerFingerprint: paperLedgerFingerprint(process.env.TRADING_RISK_STATE_PATH || '') }) });

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  schedulerState = 'stopping';
  if (timer) clearTimeout(timer);
  await heartbeat.stop({ state: 'stopped', stopSignal: signal });
  if (child && child.exitCode === null) child.kill(signal);
  else process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

function runOnce() {
  if (stopping) return;
  const started = Date.now();
  schedulerState = 'scan-running'; lastScanStartedAt = new Date(started).toISOString(); nextScanAt = null;
  void heartbeat.update({ state: schedulerState, lastScanStartedAt, nextScanAt });
  child = spawn(process.execPath, [target], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write(`Scan process could not start: ${error.message}\n`);
  });
  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    lastScanFinishedAt = new Date().toISOString(); lastScanExitCode = code ?? signal ?? 'unknown';
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);
    schedulerState = 'waiting'; nextScanAt = new Date(Date.now() + intervalMs).toISOString();
    void heartbeat.update({ state: schedulerState, lastScanFinishedAt, lastScanExitCode, nextScanAt });
    process.stdout.write(`Scan finished (exit ${code ?? signal ?? 'unknown'}; ${elapsedSeconds}s). Next pass in ${rawMinutes} minute(s).\n`);
    timer = setTimeout(runOnce, intervalMs);
  });
}

process.stdout.write(`Recurring research scans enabled: ${rawMinutes} minute interval. Stop with Ctrl+C.\n`);
heartbeat.start();
runOnce();
