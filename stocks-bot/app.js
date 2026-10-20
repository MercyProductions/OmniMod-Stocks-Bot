import http from 'node:http';

const startedAt = new Date();
const status = {
  state: 'starting',
  message: 'OmniMod Stocks bot boot is queued.',
  lastError: '',
  startedAt: startedAt.toISOString()
};
let workerModule = null;
let workerBoot = null;
const keepAlive = setInterval(() => {}, 60_000);
const bootTimer = setTimeout(() => {
  if (status.state === 'starting') {
    recordRuntimeError(
      'Discord worker boot timed out',
      new Error('The Discord worker did not report ready within 90 seconds. Check the bot token, gateway access, and stderr.log.')
    );
  }
}, 90_000);

function json(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(`${payload}\n`);
}

const server = http.createServer(async (req, res) => {
  const route = getRoutePath(req.url || '/');
  if (route === '/health' || route === '/') {
    if (!workerModule && status.state === 'starting' && workerBoot) {
      await Promise.race([
        workerBoot,
        new Promise((resolve) => setTimeout(resolve, 20_000))
      ]);
    }
    const worker = getWorkerStatus();
    const code = status.state === 'error' && !worker?.discordReady ? 503 : 200;
    json(res, code, {
      service: 'omnimod-stocks-bot',
      ...status,
      worker,
      processId: process.pid,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  json(res, 404, {
    service: 'omnimod-stocks-bot',
    error: 'not_found'
  });
});

const listenTarget = getListenTarget();
server.listen(listenTarget, () => {
  console.log(`[${new Date().toISOString()}] OmniMod Stocks health server listening on ${listenLabel(listenTarget)}.`);
});

workerBoot = import('./src/index.js')
  .then(async (worker) => {
    workerModule = worker;
    if (worker?.workerReady) {
      await worker.workerReady;
    }
    clearTimeout(bootTimer);
    status.state = 'running';
    status.message = 'OmniMod Stocks Discord worker started.';
  })
  .catch((error) => recordRuntimeError('Discord worker failed to start', error));

process.on('unhandledRejection', (reason) => {
  recordRuntimeError('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  recordRuntimeError('Uncaught exception', error);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    status.state = 'stopping';
    clearInterval(keepAlive);
    clearTimeout(bootTimer);
    server.close(() => process.exit(0));
  });
}

function getListenTarget() {
  if (process.env.PORT) return Number.parseInt(process.env.PORT, 10);
  if (typeof PhusionPassenger !== 'undefined' || process.env.PASSENGER_BASE_URI || process.env.PASSENGER_APP_ENV) {
    return 'passenger';
  }
  return 3001;
}

function listenLabel(target) {
  return typeof target === 'string' ? target : `port ${target}`;
}

function getRoutePath(rawUrl) {
  const url = new URL(rawUrl, 'http://localhost');
  const baseUris = [process.env.PASSENGER_BASE_URI || '', '/stocks-bot']
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

function recordRuntimeError(label, error) {
  status.state = 'error';
  status.message = `OmniMod Stocks ${label}.`;
  status.lastError = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[${new Date().toISOString()}] OmniMod Stocks ${label}:`, error);
}

function getWorkerStatus() {
  try {
    return workerModule?.getRuntimeState ? workerModule.getRuntimeState() : null;
  } catch (error) {
    return {
      state: 'unknown',
      discordReady: false,
      lastError: error instanceof Error ? error.message : String(error)
    };
  }
}
