import { join } from 'node:path';
import { acquireMarketApplicationLock, createMarketLogger } from '../../new-bots/shared/marketBotRuntime.js';
import { assertIndependentDiscordIdentity } from '../../new-bots/shared/discordApplicationAudit.js';

/** Own one Crypto worker. The legacy cPanel host remains a separate explicit entry. */
export async function startStandaloneCryptoHost({ directory, env = process.env, loadWorker,
  auditRootDir, installSignalHandlers = true, readinessTimeoutMs = 45_000 }) {
  if (env.OMNIMOD_LIVE_TRADING_ENABLED === 'true') throw new Error('Live trading is unavailable.');
  await assertIndependentDiscordIdentity('crypto', env, { rootDir: auditRootDir });
  const dataDirectory = join(directory, 'data');
  const release = await acquireMarketApplicationLock(dataDirectory, 'crypto');
  const log = createMarketLogger(dataDirectory, 'crypto', env);
  let stopping = false, stopped = null;
  const loading = Promise.resolve().then(loadWorker);
  // Observe rejection immediately while the asynchronous startup log is written.
  void loading.catch(() => {});
  const signalStop = () => { void stop().catch(() => { process.exitCode = 1; }); };
  const stop = () => {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      const worker = await loading.catch(() => null);
      await worker?.shutdown?.('standalone host shutdown');
      await release();
      if (installSignalHandlers) { process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop); }
      await log('application_stopped'); await log.flush();
    })();
    return stopped;
  };
  if (installSignalHandlers) { process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop); }
  try {
    await log('application_starting', 'Independent Crypto worker; no Stocks worker is loaded.');
    const worker = await loading;
    const deadline = Date.now() + readinessTimeoutMs;
    while (!stopping && !(worker.getRuntimeState?.().discordReady && worker.getRuntimeState?.().schedulerRunning)) {
      if (Date.now() >= deadline) throw new Error('Crypto gateway/scheduler readiness timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (stopping) throw new Error('Crypto startup was interrupted.');
    await log('application_ready', 'Independent Crypto gateway and scheduler ready.');
    return { worker, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
