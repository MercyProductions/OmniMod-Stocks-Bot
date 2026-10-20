import 'dotenv/config';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { atomicJson, botDir, createLog, hostingDir, isolatedEnvironment, legacyStatusFile, markets, processIdentity,
  publicWorker, readJson, revisionFor, stateDir, statusPath } from './common.js';
import { createSupervisor, launchSpecification } from './supervisorCore.js';

if (process.platform !== 'linux') throw new Error('cPanel process manager requires Linux flock and /proc');
const log = createLog('manager');
const identity = await processIdentity(process.pid);
const deploymentId = await revisionFor();
const startedAt = new Date().toISOString();
const definitions = await Promise.all(markets.map(async (market) => ({ market, entry: join(hostingDir, 'worker.js'), cwd: botDir(market), revision: await revisionFor(market) })));
const readStatus = (market) => readJson(statusPath(market));
const supervisor = createSupervisor({ definitions, readStatus, inspect: processIdentity, log,
  launch: async (definition) => {
    const spec = launchSpecification(definition, { node: process.execPath, stateDirectory: stateDir, env: isolatedEnvironment(definition.market, process.env) });
    await new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, spec.options);
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
      child.once('exit', (code, signal) => { if (code) log('worker_launcher_exit', definition.market, code, signal); });
    });
  }
});
let running = null, timer, stopping = false;
async function tick() {
  if (running || stopping) return running;
  running = (async () => {
    const control = await readJson(join(hostingDir, 'control.json')) || { mode: 'run', pausedMarkets: [] };
    if (!['run', 'rollback', 'hold'].includes(control.mode) || !Array.isArray(control.pausedMarkets || [])
      || (control.pausedMarkets || []).some((name) => !markets.includes(name))) throw new Error('Invalid hosting control file; no reconciliation performed');
    const results = await supervisor.reconcile(control.mode !== 'run' ? markets : control.pausedMarkets || []);
    const workers = Object.fromEntries(await Promise.all(markets.map(async (market) => [market, publicWorker(await readStatus(market))])));
    const ready = markets.every((market) => workers[market].discordReady && results.find((row) => row.market === market)?.state === 'running');
    const state = control.mode !== 'run' ? results.every((result) => result.stopped) ? 'rollback_ready' : 'rollback_pending'
      : ready ? 'running' : 'degraded';
    await atomicJson(legacyStatusFile, { service: 'omnimod-crypto-bot', architecture: 'independent-processes-v1', mode: 'worker', state,
      processId: process.pid, startTicks: identity.startTicks, startedAt, heartbeatAt: new Date().toISOString(), deploymentId,
      nodeVersion: process.version, worker: workers.crypto, stocks: workers.stocks, reconciliation: results });
  })().catch((error) => log('reconcile_failed', error.message)).finally(() => { running = null; });
  return running;
}
// Manager replacement does not stop workers. Its successor adopts their verified identities.
async function shutdown() { stopping = true; clearInterval(timer); await running; process.exit(0); }
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown());
process.on('uncaughtException', (error) => { log('fatal', error.message); process.exit(1); });
process.on('unhandledRejection', (error) => { log('fatal', error?.message || error); process.exit(1); });
await tick();
timer = setInterval(() => void tick(), 10000);
log('started', 'Independent Stocks/Crypto process manager');
