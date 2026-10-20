import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appDir, createLog, hostingDir, legacyStatusFile, matchesProcess, processIdentity, readJson, revisionFor, stopOwned } from './common.js';
import { hostPreflight } from './preflight.js';

const log = createLog('passenger');
const revision = await revisionFor();
let launchPromise, lastLaunch = 0, stopping = false;
let preflight = { passed: false, state: 'pending' };
// The initial hold deployment checks the real Node/Linux host before touching bot processes.
if ((await readJson(join(hostingDir, 'control.json')))?.mode === 'hold') {
  void hostPreflight().then((result) => { preflight = result; }, () => { preflight = { passed: false, state: 'failed' }; });
}
async function ensureManager() {
  if (stopping) return;
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    const control = await readJson(join(hostingDir, 'control.json'));
    if (!control || control.mode === 'hold') return;
    if (!['run', 'rollback'].includes(control.mode)) throw new Error('Invalid hosting mode');
    const saved = await readJson(legacyStatusFile);
    if (saved) {
      const current = await processIdentity(saved.processId);
      const modern = saved.architecture === 'independent-processes-v1';
      const entry = modern ? join(hostingDir, 'manager.js') : join(appDir, 'app.js');
      // Legacy records did not retain kernel start ticks. Accept the cutover only while
      // its fresh heartbeat, exact entry/cwd and service identity all match.
      const age = Date.now() - Date.parse(saved.heartbeatAt);
      const legacyVerified = !modern && saved.mode === 'worker' && saved.service === 'omnimod-crypto-bot'
        && age >= -5000 && age <= 45000 && current;
      const ownership = legacyVerified ? { ...saved, startTicks: current.startTicks } : saved;
      if (current) {
        if (!matchesProcess(ownership, current, entry, appDir)) throw new Error('Existing manager identity could not be verified; no process was signalled');
        if (modern && saved.deploymentId === revision && age >= -5000 && age <= 120000) return;
        if (!await stopOwned(ownership, entry, appDir)) throw new Error('Manager ownership changed during cutover');
        log('previous_manager_stopped', modern ? 'manager upgrade; workers preserved' : 'legacy combined worker');
      }
    }
    if (Date.now() - lastLaunch < 15000) return;
    lastLaunch = Date.now();
    // Reuse the legacy flock so an old cron invocation cannot create a second manager.
    const lock = process.env.OMNIMOD_MARKET_LOCK_FILE || join(homedir(), '.omnimod-market-bots.lock');
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['-n', lock, process.execPath, join(hostingDir, 'manager.js')],
        { cwd: appDir, detached: true, stdio: 'ignore', env: { ...process.env } });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    log('manager_launch_requested');
  })().catch((error) => log('manager_unavailable', error.message)).finally(() => { launchPromise = null; });
  return launchPromise;
}
async function health() {
  const saved = await readJson(legacyStatusFile);
  const control = await readJson(join(hostingDir, 'control.json'));
  if (!control || control.mode === 'hold') return { service: 'omnimod-crypto-bot', state: 'migration_prepared',
    nodeVersion: process.version, architecture: 'independent-processes-v1', preflight,
    previousWorker: saved ? { processId: saved.processId, state: saved.state, heartbeatAt: saved.heartbeatAt } : null };
  if (saved?.architecture !== 'independent-processes-v1') return { service: 'omnimod-crypto-bot', state: 'migrating', architecture: 'independent-processes-v1' };
  const { startTicks, ...safe } = saved;
  const age = Date.now() - Date.parse(saved.heartbeatAt);
  return { ...safe, state: age < -5000 || age > 45000 || !Number.isFinite(age) ? 'stale' : saved.state,
    supervisor: { passengerProcessId: process.pid } };
}
const leases = new Set();
const server = http.createServer(async (request, response) => {
  try {
    let route = new URL(request.url, 'http://localhost').pathname;
    const prefix = (process.env.PASSENGER_BASE_URI || '/crypto-bot').replace(/\/$/, '');
    if (route === prefix || route.startsWith(prefix + '/')) route = route.slice(prefix.length) || '/';
    if (!['/', '/health', '/keepalive'].includes(route)) { response.writeHead(404); response.end(); return; }
    await ensureManager();
    if (route === '/keepalive') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      let busy = false;
      const pulse = async () => { if (busy || response.destroyed) return; busy = true;
        try { await ensureManager(); response.write(JSON.stringify(await health()) + '\n'); }
        catch { close(); } finally { busy = false; } };
      const close = () => { clearInterval(interval); clearTimeout(deadline); leases.delete(close); response.end(); };
      const interval = setInterval(() => void pulse(), 15000);
      const deadline = setTimeout(close, 330000); leases.add(close); response.once('close', close); void pulse(); return;
    }
    const state = await health();
    response.writeHead(state.state === 'running' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(state) + '\n');
  } catch { response.writeHead(503); response.end('{"state":"unavailable"}\n'); }
});
const passenger = typeof PhusionPassenger !== 'undefined' || process.env.PASSENGER_BASE_URI || process.env.PASSENGER_APP_ENV;
server.listen(process.env.PORT ? Number(process.env.PORT) : passenger ? 'passenger' : 3000);
const timer = setInterval(() => void ensureManager(), 10000);
void ensureManager();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  stopping = true; clearInterval(timer); for (const close of leases) close();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref();
});
