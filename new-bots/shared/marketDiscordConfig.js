import { paperMonitorProfile } from './paperMonitorConfig.js';

export const MARKET_DISCORD_BOTS = Object.freeze({
  forex: { name: 'OmniMod Forex', command: 'forex' },
  futures: { name: 'OmniMod Futures', command: 'futures' },
  options: { name: 'OmniMod Options', command: 'options' },
  'etfs-etps': { name: 'OmniMod ETFs', command: 'etfs' },
});

export const isDiscordId = (value) => /^[1-9]\d{16,19}$/.test(String(value || ''));
export const DISCORD_BOT_PERMISSIONS = '19456'; // ViewChannel | SendMessages | EmbedLinks.

export function readMarketDiscordConfig(bot, env = process.env) {
  const definition = MARKET_DISCORD_BOTS[bot];
  if (!definition) throw new Error('Unknown Discord market owner.');
  const value = (key) => String(env[key] || '').trim();
  const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'].filter((key) => !value(key));
  const invalid = ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'].filter((key) => value(key) && !isDiscordId(value(key)));
  const intervalMinutes = Number(env.SCAN_INTERVAL_MINUTES ?? 5);
  const timeoutMinutes = Number(env.SCAN_TIMEOUT_MINUTES ?? 20);
  let monitorSeconds = 0;
  try { monitorSeconds = paperMonitorProfile(env).intervalSeconds; }
  catch { invalid.push('PAPER_MONITOR_INTERVAL_SECONDS'); }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) invalid.push('SCAN_INTERVAL_MINUTES');
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) invalid.push('SCAN_TIMEOUT_MINUTES');
  if (value('OMNIMOD_LIVE_TRADING_ENABLED') === 'true') invalid.push('OMNIMOD_LIVE_TRADING_ENABLED');
  return { bot, ...definition, token: value('DISCORD_TOKEN'), clientId: value('DISCORD_CLIENT_ID'),
    guildId: value('DISCORD_GUILD_ID'), channelId: value('DISCORD_CHANNEL_ID'),
    intervalMs: intervalMinutes * 60_000, timeoutMs: timeoutMinutes * 60_000,
    monitorIntervalMs: monitorSeconds * 1000,
    missing, invalid, ready: !missing.length && !invalid.length };
}

export function requireMarketDiscordConfig(bot, env = process.env) {
  const config = readMarketDiscordConfig(bot, env);
  if (!config.ready) throw new Error(`Discord application configuration incomplete: ${[...config.missing, ...config.invalid].join(', ')}.`);
  return config;
}

export function discordInstallUrl(config) {
  if (!isDiscordId(config.clientId) || !isDiscordId(config.guildId)) return null;
  const query = new URLSearchParams({ client_id: config.clientId, scope: 'bot applications.commands',
    permissions: DISCORD_BOT_PERMISSIONS, guild_id: config.guildId, disable_guild_select: 'true' });
  return `https://discord.com/oauth2/authorize?${query}`;
}

/** Redact known secret values before any app/child output reaches a log or console. */
export function redactDiscordRuntimeText(value, env = process.env) {
  let text = String(value ?? '');
  const secrets = Object.entries(env).filter(([key, secret]) => /TOKEN|SECRET|PASSWORD|API_KEY|WEBHOOK_URL/i.test(key)
    && typeof secret === 'string' && secret.length >= 4).map(([, secret]) => secret).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\S+/gi, '[redacted webhook]');
}
