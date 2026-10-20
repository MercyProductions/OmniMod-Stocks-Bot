import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateWorkerConfiguration } from './src/workerConfiguration.js';
import { isWorkerOnlyMode } from './src/runtimeMode.js';

process.env.OMNIMOD_EMBEDDED_HOST = '1';

const startedAt = new Date();
const bootId = `${startedAt.getTime()}-${process.pid}`;
const workerOnly = isWorkerOnlyMode(process.platform, process.env.OMNIMOD_WORKER_ONLY);
const appDir = dirname(fileURLToPath(import.meta.url));
const workerScript = join(appDir, 'scripts', 'run-persistent-worker.sh');
const workerStatusFile = process.env.OMNIMOD_MARKET_STATUS_FILE
  || (process.platform === 'win32'
    ? join(tmpdir(), 'omnimod-market-worker-status.json')
    : '/home/omniaeyu/.omnimod-market-worker-status.json');
function runtimeFiles(root, nested = false) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (nested || ['src', 'scripts'].includes(entry.name))) {
      files.push(...runtimeFiles(join(root, entry.name), true));
    } else if (entry.isFile() && ['.js', '.cjs', '.mjs', '.sh'].some((suffix) => entry.name.endsWith(suffix))) {
      files.push(join(root, entry.name));
    } else if (entry.isFile() && ['package.json', 'package-lock.json'].includes(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  return files.sort();
}
const deploymentFiles = [
  ...runtimeFiles(appDir),
  ...runtimeFiles(join(appDir, '..', 'stocks-bot'))
];
const deploymentHash = createHash('sha256');
for (const file of deploymentFiles) {
  deploymentHash.update(file).update(String.fromCharCode(0));
  try {
    deploymentHash.update(readFileSync(file));
  } catch {
    deploymentHash.update('missing:' + file);
  }
  deploymentHash.update(String.fromCharCode(0));
}
const deploymentId = deploymentHash.digest('hex').slice(0, 16);
const bootState = {
  service: 'omnimod-crypto-bot',
  state: 'starting',
  message: 'OmniMod Crypto and Stocks workers are booting.',
  lastError: '',
  startedAt: startedAt.toISOString(),
  bootId,
  deploymentId,
  mode: workerOnly ? 'worker' : 'passenger'
};
let cryptoModule = null;
let stocksModule = null;
let server = null;
let stopping = false;
let supervisorLastSpawnAt = '';
let supervisorLastError = '';
let supervisorLaunchPromise = null;
const keepAlive = setInterval(() => {}, 60_000);
const statusHeartbeat = workerOnly
  ? setInterval(() => void publishWorkerStatus(), 10_000)
  : null;
statusHeartbeat?.unref?.();

function runtimeError(label, error) {
  bootState.state = 'error';
  bootState.message = label;
  bootState.lastError = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[${new Date().toISOString()}] ${label}`, error);
}

function cryptoRuntime() {
  return globalThis.__omnimodCryptoRuntime || null;
}

function stocksRuntime() {
  try {
    return stocksModule?.getRuntimeState?.() || globalThis.__omnimodStocksRuntime || null;
  } catch (error) {
    return {
      state: 'unknown',
      discordReady: false,
      lastError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function bootDiscordWorkers() {
  const [{ config: cryptoConfig }, { config: stocksConfig }] = await Promise.all([
    import('./src/config.js'), import('../stocks-bot/src/config.js')
  ]);
  validateWorkerConfiguration(cryptoConfig, stocksConfig);
  cryptoModule = await import('./src/index.js');
  await waitFor(() => cryptoRuntime()?.discordReady, 30_000, 'OmniMod Crypto Discord client');

  stocksModule = await import('../stocks-bot/src/index.js');
  if (stocksModule.workerReady) {
    await Promise.race([
      stocksModule.workerReady,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('OmniMod Stocks Discord client did not become ready within 30 seconds.')),
        30_000
      ))
    ]);
  }

  bootState.state = 'running';
  bootState.message = 'OmniMod Crypto and Stocks Discord workers are running.';
  bootState.lastError = '';
  console.log(`[${new Date().toISOString()}] Crypto and Stocks Discord workers are ready.`);
}

const workerBoot = workerOnly
  ? bootDiscordWorkers()
    .then(() => publishWorkerStatus())
    .catch(async (error) => {
      runtimeError('Combined Discord worker boot failed.', error);
      await publishWorkerStatus();
      setImmediate(() => void shutdown('worker boot failure', 1));
    })
  : Promise.resolve();

function inProcessState() {
  const crypto = cryptoRuntime();
  const stocks = stocksRuntime();
  return {
    ...bootState,
    state: bootState.state === 'error'
      ? 'error'
      : stocks?.discordReady && crypto?.discordReady
        ? 'running'
        : 'connecting',
    processId: process.pid,
    parentProcessId: process.ppid,
    bootId,
    mode: bootState.mode,
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    environment: {
      stocksTokenPresent: Boolean(process.env.STOCKS_DISCORD_TOKEN),
      stocksClientIdPresent: Boolean(process.env.STOCKS_DISCORD_CLIENT_ID),
      stocksGuildIdPresent: Boolean(process.env.STOCKS_DISCORD_GUILD_ID),
      stocksDataDirPresent: Boolean(process.env.OMNIMOD_STOCKS_DATA_DIR)
    },
    worker: crypto ? {
      state: crypto.state,
      phase: crypto.phase,
      discordReady: crypto.discordReady,
      discordUser: crypto.discordUser,
      lastError: crypto.lastError,
      lastScanAt: crypto.lastScanAt,
      scansCompleted: crypto.scansCompleted
    } : null,
    stocks: stocks ? {
      state: stocks.state,
      phase: stocks.phase,
      discordReady: stocks.discordReady,
      discordUser: stocks.discordUser,
      lastError: stocks.lastError,
      lastScanAt: stocks.lastScanAt,
      scansCompleted: stocks.scansCompleted,
      lastTickAt: stocks.lastTickAt,
      nextTickAt: stocks.nextTickAt,
      configuredGuilds: stocks.configuredGuilds,
      schedulerRunning: stocks.schedulerRunning
    } : null
  };
}

async function publishWorkerStatus() {
  if (!workerOnly) return;
  const state = inProcessState();
  state.heartbeatAt = new Date().toISOString();
  const temporaryFile = `${workerStatusFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporaryFile, workerStatusFile);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Could not publish worker status.`, error);
  }
}

async function persistentWorkerState() {
  try {
    const saved = JSON.parse(await readFile(workerStatusFile, 'utf8'));
    const heartbeatMs = Date.parse(saved.heartbeatAt || '');
    const stale = !Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > 45_000;
    return {
      ...saved,
      state: stale ? 'stale' : saved.state,
      message: stale
        ? 'Persistent Discord worker heartbeat is stale; restart has been requested.'
        : saved.message,
      supervisor: {
        passengerProcessId: process.pid,
        lastSpawnAt: supervisorLastSpawnAt,
        lastError: supervisorLastError
      }
    };
  } catch {
    return {
      ...bootState,
      state: 'starting',
      message: 'Persistent Discord worker is starting.',
      processId: process.pid,
      mode: 'passenger-supervisor',
      supervisor: {
        passengerProcessId: process.pid,
        lastSpawnAt: supervisorLastSpawnAt,
        lastError: supervisorLastError
      }
    };
  }
}

async function workerHeartbeatIsFresh(maxAgeMs = 25_000) {
  try {
    const saved = JSON.parse(await readFile(workerStatusFile, 'utf8'));
    const heartbeatMs = Date.parse(saved.heartbeatAt || '');
    return Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= maxAgeMs;
  } catch {
    return false;
  }
}

async function replaceOutdatedWorker() {
  try {
    const saved = JSON.parse(await readFile(workerStatusFile, 'utf8'));
    const heartbeatMs = Date.parse(saved.heartbeatAt || '');
    const fresh = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= 25_000;
    if (!fresh || saved.deploymentId === deploymentId) return false;
    const workerPid = Number(saved.processId);
    if (!Number.isInteger(workerPid) || workerPid <= 1 || saved.mode !== 'worker') return false;

    console.log(
      `[${new Date().toISOString()}] Replacing worker ${workerPid}; deployment ${saved.deploymentId || 'legacy'} -> ${deploymentId}.`
    );
    process.kill(workerPid, 'SIGTERM');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        process.kill(workerPid, 0);
      } catch {
        return true;
      }
    }
    throw new Error(`Worker ${workerPid} did not stop within 5 seconds.`);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return true;
    throw error;
  }
}

async function ensurePersistentWorker() {
  if (workerOnly) return false;
  if (supervisorLaunchPromise) return supervisorLaunchPromise;

  supervisorLaunchPromise = (async () => {
    const replaced = await replaceOutdatedWorker();
    if (!replaced && await workerHeartbeatIsFresh()) return false;
    try {
      const child = spawn('/bin/sh', [workerScript], {
        cwd: appDir,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          OMNIMOD_WORKER_ONLY: '1'
        }
      });
      child.unref();
      supervisorLastSpawnAt = new Date().toISOString();
      supervisorLastError = '';
      console.log(
        `[${supervisorLastSpawnAt}] Persistent Discord worker launch requested as pid ${child.pid}.`
      );
      return true;
    } catch (error) {
      supervisorLastError = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] Could not launch persistent Discord worker.`, error);
      return false;
    }
  })();

  try {
    return await supervisorLaunchPromise;
  } finally {
    supervisorLaunchPromise = null;
  }
}

async function holdKeepaliveLease(request, response) {
  await ensurePersistentWorker();
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-accel-buffering': 'no',
    connection: 'keep-alive'
  });

  let closed = false;
  let sending = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pulse);
    clearTimeout(expiry);
    if (!response.writableEnded) response.end();
  };
  const sendPulse = async () => {
    if (closed || sending) return;
    sending = true;
    try {
      await ensurePersistentWorker();
      const state = await persistentWorkerState();
      response.write(`${JSON.stringify({
        service: bootState.service,
        state: state.state,
        workerProcessId: state.processId || null,
        heartbeatAt: state.heartbeatAt || null,
        at: new Date().toISOString()
      })}\n`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Keepalive pulse failed.`, error);
    } finally {
      sending = false;
    }
  };

  const pulse = setInterval(() => void sendPulse(), 15_000);
  const expiry = setTimeout(close, 330_000);
  request.once('aborted', close);
  response.once('close', close);
  await sendPulse();
}

function json(response, code, body) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

if (!workerOnly) {
  void ensurePersistentWorker();
  server = http.createServer(async (request, response) => {
    const route = routePath(request.url || '/');
    if (route === '/keepalive') {
      await holdKeepaliveLease(request, response);
      return;
    }
    if (route === '/' || route === '/health') {
      await ensurePersistentWorker();
      const state = await persistentWorkerState();
      json(response, state.state === 'error' ? 503 : 200, state);
      return;
    }
    json(response, 404, { service: bootState.service, error: 'not_found' });
  });

  const listenTarget = getListenTarget();
  server.listen(listenTarget, () => {
    console.log(`[${new Date().toISOString()}] Combined Crypto/Stocks health server listening on ${listenLabel(listenTarget)} (boot ${bootId}).`);
  });
} else {
  console.log(`[${new Date().toISOString()}] Combined Crypto/Stocks persistent worker starting (boot ${bootId}).`);
}

function fatalRuntimeError(label, error) {
  runtimeError(label, error);
  if (workerOnly) {
    void publishWorkerStatus().finally(() => void shutdown(label, 1));
  }
}

process.on('unhandledRejection', (error) => fatalRuntimeError('Unhandled promise rejection.', error));
process.on('uncaughtException', (error) => fatalRuntimeError('Uncaught exception.', error));

async function shutdown(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  bootState.state = 'stopping';
  bootState.message = `Combined host received ${signal}.`;
  console.warn(`[${new Date().toISOString()}] Combined host received ${signal}; shutting down boot ${bootId}.`);
  clearInterval(keepAlive);
  if (statusHeartbeat) clearInterval(statusHeartbeat);
  await publishWorkerStatus();
  const forceExit = setTimeout(() => {
    console.error(`[${new Date().toISOString()}] Combined host shutdown timed out.`);
    process.exit(1);
  }, 8_000);
  forceExit.unref?.();
  await Promise.allSettled([
    cryptoModule?.shutdown?.(signal),
    stocksModule?.shutdown?.(signal)
  ]);
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void shutdown(signal));
}

process.once('beforeExit', (code) => {
  console.warn(`[${new Date().toISOString()}] Combined host beforeExit code=${code}, boot=${bootId}.`);
});
process.once('exit', (code) => {
  console.warn(`[${new Date().toISOString()}] Combined host exit code=${code}, boot=${bootId}.`);
});

function isPassengerRuntime() {
  return typeof PhusionPassenger !== 'undefined'
    || Boolean(process.env.PASSENGER_BASE_URI)
    || Boolean(process.env.PASSENGER_APP_ENV);
}

function getListenTarget() {
  if (process.env.PORT) return Number.parseInt(process.env.PORT, 10);
  if (isPassengerRuntime()) {
    return 'passenger';
  }
  return 3000;
}

function listenLabel(target) {
  return typeof target === 'string' ? target : `port ${target}`;
}

function routePath(rawUrl) {
  const url = new URL(rawUrl, 'http://localhost');
  const baseUris = [process.env.PASSENGER_BASE_URI || '', '/crypto-bot']
    .map((item) => item.replace(/\/+$/, ''))
    .filter(Boolean);
  let pathname = url.pathname || '/';
  for (const baseUri of baseUris) {
    if (pathname.toLowerCase().startsWith(baseUri.toLowerCase())) {
      pathname = pathname.slice(baseUri.length) || '/';
      break;
    }
  }
  return pathname === '' ? '/' : pathname;
}
