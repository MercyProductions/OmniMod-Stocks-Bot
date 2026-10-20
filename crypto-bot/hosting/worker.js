// Exactly one market per process. The existing scanner owns all trading decisions.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, botDir, createLog, delay, markets, processIdentity, redact, revisionFor, statusPath } from './common.js';

const market = process.argv[2];
if (!markets.includes(market) || process.platform !== 'linux') throw new Error('Hosted worker requires Linux and an explicit market');
process.env.OMNIMOD_EMBEDDED_HOST = '1';
process.chdir(botDir(market));
const redactionEnv = { ...process.env };
const log = createLog(market, undefined, redactionEnv);
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => log(level, ...args);
const identity = await processIdentity(process.pid);
if (!identity?.startTicks) throw new Error('Cannot establish worker process identity');
const deploymentId = await revisionFor(market);
let module, config, stopping = false, heartbeat;
const base = { market, processId: process.pid, startTicks: identity.startTicks, deploymentId,
  startedAt: new Date().toISOString(), nodeVersion: process.version, state: 'connecting', phase: 'configuration', discordReady: false };
let writes = Promise.resolve();
const publish = () => {
  const runtime = module?.getRuntimeState?.() || globalThis[market === 'crypto' ? '__omnimodCryptoRuntime' : '__omnimodStocksRuntime'] || {};
  const state = { ...base, ...Object.fromEntries(['state', 'phase', 'discordReady', 'discordUser', 'lastScanAt', 'scansCompleted',
    'schedulerRunning', 'lastTickAt', 'nextTickAt', 'configuredGuilds'].filter((key) => runtime[key] !== undefined).map((key) => [key, runtime[key]])),
    clientId: config?.clientId, heartbeatAt: new Date().toISOString(), lastError: redact(base.lastError || runtime.lastError || '', redactionEnv) };
  if (stopping) { state.state = base.state; state.discordReady = false; state.schedulerRunning = false; }
  writes = writes.then(() => atomicJson(statusPath(market), state));
  return writes;
};
async function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true; clearInterval(heartbeat); base.state = code ? 'error' : 'stopped';
  log('shutdown', reason);
  const deadline = setTimeout(() => process.exit(1), 8000);
  try { await module?.shutdown?.(reason); await publish(); } catch { log('shutdown_failed', 'Cleanup or status write failed'); }
  clearTimeout(deadline); process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, (error) => {
  base.lastError = redact(error?.stack || error, redactionEnv); log(event, base.lastError); void shutdown(event, 1);
});
try {
  const configuration = await import(pathToFileURL(join(botDir(market), 'src/config.js')).href);
  config = configuration.config; configuration.requireRuntimeConfig();
  Object.assign(redactionEnv, process.env, { HOST_DISCORD_TOKEN: config.discordToken });
  for (const [key, value] of Object.entries(config)) if (/key|secret|token/i.test(key)) redactionEnv[`CONFIG_SECRET_${key}`] = String(value);
  if (!/^\d{17,22}$/.test(config.clientId)) throw new Error('Invalid application ID');
  // Authenticate before importing a module that starts its own scheduler.
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${config.discordToken}` }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Discord identity preflight returned HTTP ${response.status}`);
  const user = await response.json();
  if (user.bot !== true || user.id !== config.clientId) throw new Error('Discord bot identity does not match configured client ID');
  // Redact secrets loaded by dotenv as well as inherited credentials.
  await publish();
  heartbeat = setInterval(() => void publish().catch(() => void shutdown('heartbeat_write_failed', 1)), 10000);
  const loading = import(pathToFileURL(join(botDir(market), 'src/index.js')).href);
  loading.catch(() => {});
  const bootDeadline = Date.now() + 60000;
  let loadError;
  loading.then((value) => { module = value; }, (error) => { loadError = error; });
  while (!stopping) {
    if (loadError) throw loadError;
    const runtime = module?.getRuntimeState?.();
    if (runtime?.discordReady && (market !== 'stocks' || runtime.schedulerRunning)) break;
    if (Date.now() > bootDeadline) throw new Error('Discord worker did not become ready within 60 seconds');
    await delay(100);
  }
  if (!stopping) { await publish(); log('ready', `${market} independently ready`); }
} catch (error) {
  base.lastError = redact(error?.message || error, redactionEnv); log('boot_failed', base.lastError); await shutdown('boot_failed', 1);
}
