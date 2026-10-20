import { hostname } from 'node:os';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BOT_IDS = new Set(['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']);
const safePart = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown';

export function runnerHeartbeatPath(bot, { directory = resolve(process.cwd(), 'data'), pid = process.pid, host = hostname() } = {}) {
  if (!BOT_IDS.has(bot)) throw new Error('Unknown primary bot id.');
  return join(resolve(directory), `${bot}-heartbeat-${safePart(host)}-${Number(pid)}.json`);
}

/** Start a low-frequency, secret-free liveness record. A crash leaves an expiring record. */
export function createRunnerHeartbeat({ bot, directory, role = 'service', intervalMs = 15_000, getState = () => ({}) }) {
  if (!BOT_IDS.has(bot)) throw new Error('Unknown primary bot id.');
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new RangeError('Heartbeat interval must be at least one second.');
  const host = hostname(), pid = process.pid, startedAt = new Date().toISOString();
  const file = runnerHeartbeatPath(bot, { directory, pid, host });
  let fields = {}, timer = null, stopped = false, writing = Promise.resolve();
  const flush = () => {
    writing = writing.then(async () => {
      const heartbeatAt = new Date().toISOString();
      let runtime = {};
      try { runtime = getState() || {}; } catch { runtime = { stateReadError: true }; }
      const row = { schemaVersion: 1, bot, role, pid, host, startedAt, heartbeatAt,
        processState: stopped ? 'stopped' : 'running', intervalMs, ...runtime, ...fields };
      await mkdir(resolve(directory || join(process.cwd(), 'data')), { recursive: true });
      const temp = `${file}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, file);
    }).catch((error) => { process.stderr.write(`[${bot}] heartbeat write failed: ${String(error.message || error).slice(0, 160)}\n`); });
    return writing;
  };
  return {
    file,
    start() { if (timer) return; stopped = false; void flush(); timer = setInterval(() => void flush(), intervalMs); timer.unref?.(); },
    update(next = {}) { fields = { ...fields, ...next }; return flush(); },
    async stop(next = {}) { fields = { ...fields, ...next }; stopped = true; if (timer) clearInterval(timer); timer = null; await flush(); },
  };
}

export async function readRunnerHeartbeatStatus(bot, { directory = resolve(process.cwd(), 'data'), now = Date.now(), staleAfterMs = 45_000 } = {}) {
  if (!BOT_IDS.has(bot)) throw new Error('Unknown primary bot id.');
  const names = (await readdir(resolve(directory)).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => name.startsWith(`${bot}-heartbeat-`) && name.endsWith('.json')).sort().slice(-100);
  const rows = [];
  for (const name of names) {
    try {
      const row = JSON.parse(await readFile(join(resolve(directory), name), 'utf8'));
      const at = Date.parse(row.heartbeatAt);
      if (row.schemaVersion !== 1 || row.bot !== bot || !Number.isInteger(Number(row.pid)) || !Number.isFinite(at) || at > now + 5_000) continue;
      const ageMs = Math.max(0, now - at);
      const status = row.processState === 'stopped' ? 'stopped' : ageMs <= staleAfterMs ? 'running' : 'stale';
      rows.push({ status, pid: Number(row.pid), host: String(row.host || ''), role: String(row.role || 'unknown'),
        startedAt: row.startedAt || null, heartbeatAt: new Date(at).toISOString(), ageMs,
        ledgerFingerprint: /^[a-f0-9]{16}$/.test(String(row.ledgerFingerprint || '')) ? String(row.ledgerFingerprint) : null,
        emergencyStopActive: typeof row.emergencyStopActive === 'boolean' ? row.emergencyStopActive : null,
        liveTradingEnabled: typeof row.liveTradingEnabled === 'boolean' ? row.liveTradingEnabled : null,
        scanState: row.state || row.processState || 'unknown', phase: row.phase || null,
        childPid: Number.isInteger(Number(row.childPid)) ? Number(row.childPid) : null,
        nextScanAt: row.nextScanAt || null, lastScanStartedAt: row.lastScanStartedAt || null,
        lastScanFinishedAt: row.lastScanFinishedAt || row.lastScanAt || null,
        lastScanExitCode: row.lastScanExitCode ?? null,
        discordReady: typeof row.discordReady === 'boolean' ? row.discordReady : null,
        schedulerRunning: typeof row.schedulerRunning === 'boolean' ? row.schedulerRunning : null,
        positionMonitor: row.positionMonitor && typeof row.positionMonitor === 'object' ? {
          enabled: row.positionMonitor.enabled === true, state: row.positionMonitor.state || 'unknown',
          schedulerRunning: row.positionMonitor.schedulerRunning === true,
          childPid: Number.isInteger(row.positionMonitor.childPid) ? row.positionMonitor.childPid : null,
          lastFinishedAt: row.positionMonitor.lastScanFinishedAt || null,
          lastExitCode: row.positionMonitor.lastScanExitCode ?? null, nextAt: row.positionMonitor.nextScanAt || null,
        } : null });
    } catch { /* A torn/unreadable heartbeat is not evidence of a live process. */ }
  }
  const active = rows.filter((row) => row.status === 'running');
  const latest = [...rows].sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))[0] || null;
  return { status: active.length ? 'running' : latest?.status || 'unknown', activeProcesses: active.length,
    staleProcesses: rows.filter((row) => row.status === 'stale').length,
    lastHeartbeatAt: latest?.heartbeatAt || null, ageMs: latest?.ageMs ?? null,
    processes: rows.sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt)) };
}
