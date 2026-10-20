import { fileURLToPath } from 'node:url';
import { config, dataDir, projectRoot } from './config.js';
import { getGuildSettings, listConfiguredGuildIds, providerKeys } from './guildSettings.js';
import { runPaperPositionMonitor, savePaperPositionMonitorReport } from '../../new-bots/shared/paperPositionMonitor.js';
import { createMarketLogger, createMarketScanScheduler } from '../../new-bots/shared/marketBotRuntime.js';
import { paperMonitorProfile } from '../../new-bots/shared/paperMonitorConfig.js';

/** There is no account routing on legacy paper rows. Do not guess among different saved credentials. */
export async function resolveStockMonitorCredentials({ settings = config, listGuilds = listConfiguredGuildIds,
  loadGuild = getGuildSettings, keysForGuild = providerKeys } = {}) {
  if (settings.alpacaKeyId && settings.alpacaSecretKey)
    return { status: 'bot_configuration', key: settings.alpacaKeyId, secret: settings.alpacaSecretKey };
  if (settings.alpacaKeyId || settings.alpacaSecretKey) return { status: 'incomplete_bot_credentials' };
  const pairs = [];
  for (const id of await listGuilds()) {
    const keys = keysForGuild(await loadGuild(id));
    if (!keys.alpaca_key_id && !keys.alpaca_secret_key) continue;
    if (!keys.alpaca_key_id || !keys.alpaca_secret_key) return { status: 'incomplete_saved_credentials' };
    if (!pairs.some(p => p.key === keys.alpaca_key_id && p.secret === keys.alpaca_secret_key))
      pairs.push({ key: keys.alpaca_key_id, secret: keys.alpaca_secret_key });
  }
  return pairs.length === 1 ? { status: 'unique_saved_configuration', ...pairs[0] }
    : { status: pairs.length ? 'ambiguous_saved_credentials' : 'credentials_missing' };
}

export function stockMonitorEnvironment(settings = config, env = process.env, credentials = {}) {
  return { ...env, TRADING_RISK_STATE_PATH: settings.sharedPaperStatePath,
    OMNIMOD_EMERGENCY_STOP: String(settings.sharedPaperEmergencyStop !== false),
    ALPACA_DATA_FEED: settings.alpacaDataFeed,
    ALPACA_API_KEY_ID: credentials.key || '', ALPACA_API_SECRET_KEY: credentials.secret || '',
    SHARED_MAX_QUOTE_AGE_MS: String(settings.sharedPaperMaxQuoteAgeMs),
    SHARED_MAX_OPEN_MARK_AGE_MS: String(settings.sharedPaperMaxOpenMarkAgeMs),
    SHARED_MAX_SPREAD_PCT: String(settings.sharedPaperMaxSpreadPct),
    PAPER_MONITOR_INTERVAL_SECONDS: String(settings.paperMonitor.intervalSeconds) };
}

export function stockMonitorWorkerEnvironment(settings = config, env = process.env, directory = dataDir) {
  const pinned = { ...env, OMNIMOD_STOCKS_DATA_DIR: directory,
    STOCKS_PAPER_MONITOR_INTERVAL_SECONDS: String(settings.paperMonitor.intervalSeconds) };
  for (const [field, key] of Object.entries({ sharedPaperStatePath: 'TRADING_RISK_STATE_PATH',
    sharedPaperEmergencyStop: 'OMNIMOD_EMERGENCY_STOP', alpacaDataFeed: 'ALPACA_DATA_FEED',
    sharedPaperMaxQuoteAgeMs: 'SHARED_MAX_QUOTE_AGE_MS', sharedPaperMaxOpenMarkAgeMs: 'SHARED_MAX_OPEN_MARK_AGE_MS',
    sharedPaperMaxSpreadPct: 'SHARED_MAX_SPREAD_PCT', alpacaKeyId: 'ALPACA_API_KEY_ID', alpacaSecretKey: 'ALPACA_API_SECRET_KEY' })) {
    if (settings[field] !== undefined) pinned[`STOCKS_${key}`] = String(settings[field]);
  }
  return pinned;
}

export async function runStockPositionMonitor({ settings = config, env = process.env, directory = dataDir,
  resolveCredentials = resolveStockMonitorCredentials, clock = Date.now, shadowDirectories, fetchMarks } = {}) {
  // Resolve credentials only when the ledger actually contains an owned position.
  const monitorEnv = stockMonitorEnvironment(settings, env);
  const { loadMarketPositionQuotes } = await import('../../new-bots/shared/marketPositionQuotes.js');
  const report = await runPaperPositionMonitor({ bot: 'stocks', env: monitorEnv, clock, shadowDirectories,
    fetchMarks: async (bot, orders, options) => {
      const credentials = await resolveCredentials({ settings });
      if (!credentials.key || !credentials.secret) return { marks: [], diagnostics: { status: credentials.status,
        rejectionReasons: { [credentials.status]: orders.length } } };
      return (fetchMarks || loadMarketPositionQuotes)(bot, orders,
        { ...options, env: stockMonitorEnvironment(settings, env, credentials) });
    } });
  await savePaperPositionMonitorReport(report, directory);
  return report;
}

/** Separate supervised process: expensive discovery cannot block its JavaScript event loop. */
export function createStockPositionMonitor({ settings = config, env = process.env, directory = projectRoot,
  dataDirectory = dataDir, onState = () => {}, schedulerFactory = createMarketScanScheduler,
  logFactory = createMarketLogger } = {}) {
  const profile = paperMonitorProfile({ PAPER_MONITOR_INTERVAL_SECONDS: settings.paperMonitor.intervalSeconds }, 'stocks');
  let state = { enabled: profile.enabled, state: profile.enabled ? 'idle' : 'disabled' };
  const log = profile.enabled ? logFactory(dataDirectory, 'stocks', env) : null;
  const scheduler = profile.enabled ? schedulerFactory({ directory,
    entry: fileURLToPath(new URL('../scripts/monitor-paper.js', import.meta.url)), env: stockMonitorWorkerEnvironment(settings, env, dataDirectory),
    intervalMs: profile.intervalSeconds * 1000, timeoutMs: 60000,
    log: (event, detail) => log(event.replace(/^scan/, 'position_monitor'), detail),
    onState: next => { state = { enabled: true, ...next }; onState(state); } }) : null;
  return { snapshot: () => ({ ...state }), start: () => scheduler?.start(),
    stop: async () => { await scheduler?.stop(); await log?.flush?.(); } };
}
