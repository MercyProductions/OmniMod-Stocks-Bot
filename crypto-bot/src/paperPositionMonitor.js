import { fileURLToPath } from 'node:url';
import { config, dataDir, projectRoot } from './config.js';
import { listConfiguredGuildIds, getGuildSettings } from './guildSettings.js';
import { refreshCryptoPaperIdentity } from './marketProviders.js';
import { fetchCryptoPositionQuotes } from './positionQuotes.js';
import { runPaperPositionMonitor, savePaperPositionMonitorReport } from '../../new-bots/shared/paperPositionMonitor.js';
import { createMarketLogger, createMarketScanScheduler } from '../../new-bots/shared/marketBotRuntime.js';
import { paperMonitorProfile } from '../../new-bots/shared/paperMonitorConfig.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export async function resolveCryptoMonitorSettings({ settings = config, listGuilds = listConfiguredGuildIds, loadGuild = getGuildSettings } = {}) {
  const tier = settings.coingeckoApiTier || 'public', key = settings.coingeckoApiKey || '';
  if (!['public', 'demo', 'pro'].includes(tier)) return fail('crypto_identity_tier_invalid');
  if (tier === 'public') return { coingeckoApiTier: 'public', coingeckoApiKey: '' };
  if (key) return { coingeckoApiTier: tier, coingeckoApiKey: key };
  const distinct = [];
  for (const guild of await listGuilds()) {
    const row = await loadGuild(guild);
    if (!row.coingeckoApiKey || row.coingeckoApiTier === 'public') continue;
    if (!['demo', 'pro'].includes(row.coingeckoApiTier)) return fail('crypto_identity_tier_invalid');
    if (!distinct.some(p => p.coingeckoApiKey === row.coingeckoApiKey && p.coingeckoApiTier === row.coingeckoApiTier))
      distinct.push({ coingeckoApiKey: row.coingeckoApiKey, coingeckoApiTier: row.coingeckoApiTier });
  }
  if (distinct.length > 1) return fail('crypto_identity_credentials_ambiguous');
  if (distinct.length === 1) return distinct[0];
  if (tier === 'pro') return fail('crypto_identity_credentials_missing');
  return { coingeckoApiTier: 'public', coingeckoApiKey: '' };
}

export function cryptoMonitorEnvironment(settings = config, env = process.env, directory = dataDir) {
  return { ...env, OMNIMOD_CRYPTO_DATA_DIR: directory, TRADING_RISK_STATE_PATH: settings.sharedPaperStatePath,
    OMNIMOD_EMERGENCY_STOP: String(settings.sharedPaperEmergencyStop !== false),
    SHARED_MAX_QUOTE_AGE_MS: String(settings.sharedPaperMaxQuoteAgeMs), SHARED_MAX_OPEN_MARK_AGE_MS: String(settings.sharedPaperMaxOpenMarkAgeMs),
    SHARED_MAX_SPREAD_PCT: String(settings.sharedPaperMaxSpreadPct), PAPER_MONITOR_INTERVAL_SECONDS: String(settings.paperMonitor.intervalSeconds),
    COINGECKO_API_KEY: settings.coingeckoApiKey || '', COINGECKO_API_TIER: settings.coingeckoApiTier || 'public' };
}

export async function runCryptoPositionMonitor({ settings = config, env = process.env, directory = dataDir,
  clock = Date.now, shadowDirectories, loadSettings = resolveCryptoMonitorSettings, fetchQuotes = fetchCryptoPositionQuotes } = {}) {
  const monitorEnv = cryptoMonitorEnvironment(settings, env, directory);
  let identitySettings;
  const report = await runPaperPositionMonitor({ bot: 'crypto', env: monitorEnv, clock, shadowDirectories,
    fetchMarks: (_bot, orders) => fetchQuotes(orders, { env: monitorEnv, clock,
      refreshIdentity: async id => {
        identitySettings ??= await loadSettings({ settings });
        return refreshCryptoPaperIdentity(id, identitySettings);
      } }) });
  await savePaperPositionMonitorReport(report, directory);
  return report;
}

export function createCryptoPositionMonitor({ settings = config, env = process.env, directory = projectRoot,
  dataDirectory = dataDir, onState = () => {}, schedulerFactory = createMarketScanScheduler, logFactory = createMarketLogger } = {}) {
  const profile = paperMonitorProfile({ PAPER_MONITOR_INTERVAL_SECONDS: settings.paperMonitor.intervalSeconds }, 'crypto');
  let state = { enabled: profile.enabled, state: profile.enabled ? 'idle' : 'disabled' };
  const log = profile.enabled ? logFactory(dataDirectory, 'crypto', env) : null;
  const scheduler = profile.enabled ? schedulerFactory({ directory,
    entry: fileURLToPath(new URL('../scripts/monitor-paper.js', import.meta.url)), env: cryptoMonitorEnvironment(settings, env, dataDirectory),
    intervalMs: profile.intervalSeconds * 1000, timeoutMs: 240000,
    log: (event, detail) => log(event.replace(/^scan/, 'position_monitor'), detail),
    onState: next => { state = { enabled: true, ...next }; onState(state); } }) : null;
  return { snapshot: () => ({ ...state }), start: () => scheduler?.start(), stop: async () => { await scheduler?.stop(); await log?.flush?.(); } };
}
