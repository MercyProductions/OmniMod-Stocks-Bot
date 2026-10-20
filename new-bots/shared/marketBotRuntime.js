import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink, appendFile, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { redactDiscordRuntimeText } from './marketDiscordConfig.js';

export async function acquireMarketApplicationLock(directory, bot) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'discord-application.lock');
  const owner = { bot, pid: process.pid, host: hostname(), nonce: randomUUID(), startedAt: new Date().toISOString() };
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Discord application lock exists. Inspect its owner before restarting; never remove a live owner lock.'); throw error; }
  try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
  const release = async () => {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.nonce !== owner.nonce) throw new Error('Discord application lock ownership changed; refusing to remove it.');
    await unlink(path);
  };
  release.owner = Object.freeze({ ...owner });
  return release;
}

export function createMarketLogger(directory, bot, env = process.env) {
  let writes = Promise.resolve();
  const file = join(directory, 'discord-application.log');
  const log = (event, detail = '') => {
    const safe = redactDiscordRuntimeText(detail, env).slice(0, 8000);
    const line = JSON.stringify({ at: new Date().toISOString(), bot, event, detail: safe }) + '\n';
    // Child market reports stay in the bounded local log; lifecycle messages also reach the supervisor.
    if (!/^(scan|position_monitor)_output/.test(event)) process.stdout.write(line);
    writes = writes.then(async () => {
      await mkdir(directory, { recursive: true });
      if ((await stat(file).catch(() => null))?.size > 1_048_576) {
        await unlink(`${file}.previous`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await rename(file, `${file}.previous`);
      }
      await appendFile(file, line, 'utf8');
    }).catch(() => { process.stderr.write(`[${bot}] application log unavailable.\n`); });
    return writes;
  };
  log.flush = () => writes;
  return log;
}

/** One existing scanner child at a time; errors finish a pass without killing its application. */
export function createMarketScanScheduler({ directory, entry, args = [], env, intervalMs, timeoutMs,
  spawnChild = spawn, setTimer = setTimeout, clearTimer = clearTimeout, clock = Date.now,
  onState = () => {}, log = () => {} }) {
  let child = null, timer = null, deadlineTimer = null, killTimer = null, stopping = false, started = false;
  let lastManualAt = -Infinity, stopResolve = null;
  const state = { state: 'idle', childPid: null, schedulerRunning: false, lastScanStartedAt: null,
    lastScanFinishedAt: null, lastScanExitCode: null, nextScanAt: null };
  const publish = () => { onState({ ...state }); };
  const schedule = () => {
    if (stopping) return;
    state.state = 'waiting'; state.nextScanAt = new Date(clock() + intervalMs).toISOString(); publish();
    timer = setTimer(() => { timer = null; run(false); }, intervalMs);
  };
  const terminateChild = () => {
    if (!child) return;
    child.kill('SIGTERM');
    killTimer = setTimer(() => child?.kill('SIGKILL'), 2000);
  };
  const run = (manual) => {
    if (!started || stopping) return { status: 'scheduler_not_running' };
    if (child) return { status: 'scan_already_running' };
    if (manual && clock() - lastManualAt < 30_000) return { status: 'manual_scan_cooldown' };
    if (manual) lastManualAt = clock();
    if (timer) clearTimer(timer); timer = null;
    state.state = 'scan-running'; state.lastScanStartedAt = new Date(clock()).toISOString(); state.nextScanAt = null;
    let finished = false;
    const finish = (code) => {
      if (finished) return; finished = true;
      if (deadlineTimer) clearTimer(deadlineTimer); if (killTimer) clearTimer(killTimer);
      deadlineTimer = null; killTimer = null; child = null;
      state.childPid = null; state.lastScanFinishedAt = new Date(clock()).toISOString(); state.lastScanExitCode = code;
      log('scan_finished', String(code));
      if (stopping) { state.state = 'stopped'; state.schedulerRunning = false; publish(); stopResolve?.(); }
      else schedule();
    };
    try {
      child = spawnChild(process.execPath, [entry, ...args], { cwd: directory, env: { ...env, DISCORD_DELIVERY_MODE: 'bot' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      state.childPid = child.pid ?? null; publish();
      for (const [stream, event] of [[child.stdout, 'scan_output'], [child.stderr, 'scan_output_error']]) {
        let pending = '';
        stream?.setEncoding?.('utf8');
        stream?.on('data', (chunk) => {
          pending += chunk;
          let index;
          while ((index = pending.indexOf('\n')) >= 0) { log(event, pending.slice(0, index)); pending = pending.slice(index + 1); }
        });
        stream?.on('end', () => { if (pending) log(event, pending); pending = ''; });
      }
      child.once('error', (error) => { log('scan_spawn_failed', String(error.code || 'unknown')); finish('spawn-error'); });
      child.once('close', (code, signal) => finish(code ?? signal ?? 'unknown'));
      deadlineTimer = setTimer(() => { log('scan_timeout', 'Stopping overdue scanner child.'); terminateChild(); }, timeoutMs);
      return { status: 'scan_started' };
    } catch (error) { log('scan_spawn_failed', String(error.code || 'unknown')); finish('spawn-error'); return { status: 'spawn_failed' }; }
  };
  return {
    snapshot: () => ({ ...state }),
    start() { if (started) return; started = true; state.schedulerRunning = true; run(false); },
    requestScan: () => run(true),
    async stop() {
      stopping = true;
      if (timer) clearTimer(timer); timer = null; state.nextScanAt = null;
      if (!child) { state.state = 'stopped'; state.schedulerRunning = false; publish(); return; }
      state.state = 'stopping'; publish();
      await new Promise((resolve) => { stopResolve = resolve; terminateChild(); });
    },
  };
}
