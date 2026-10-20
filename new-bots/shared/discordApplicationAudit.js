import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { isDiscordId } from './marketDiscordConfig.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = { stocks: '../stocks-bot', crypto: '../crypto-bot', forex: 'forex', futures: 'futures', options: 'options', 'etfs-etps': 'etfs-etps' };

/** Inventory only; tokens and identity hashes never leave this function. */
export async function inspectDiscordApplications({ rootDir = root, runtimeBot, runtimeEnv = {} } = {}) {
  const applications = {}, tokens = new Map(), clients = new Map();
  const record = (map, value, bot) => {
    if (!value) return;
    const hash = createHash('sha256').update(value).digest('hex');
    map.set(hash, [...(map.get(hash) || []), bot]);
  };
  for (const [bot, path] of Object.entries(paths)) {
    let env = {}, envFilePresent = true;
    try { env = parseEnv(await readFile(resolve(rootDir, path, '.env'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') envFilePresent = false; else throw error; }
    if (bot === runtimeBot) env = { ...env, ...runtimeEnv };
    const get = (key) => String(env[key] || '').trim();
    record(tokens, get('DISCORD_TOKEN'), bot); record(clients, get('DISCORD_CLIENT_ID'), bot);
    const applicationRunner = !['stocks', 'crypto'].includes(bot);
    const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', ...(applicationRunner ? ['DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'] : [])];
    const missing = required.filter((key) => !get(key));
    const invalid = ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'].filter((key) => get(key) && !isDiscordId(get(key)));
    applications[bot] = { envFilePresent, tokenConfigured: Boolean(get('DISCORD_TOKEN')), clientIdConfigured: Boolean(get('DISCORD_CLIENT_ID')),
      guildIdConfigured: Boolean(get('DISCORD_GUILD_ID')), channelIdConfigured: Boolean(get('DISCORD_CHANNEL_ID')),
      destination: applicationRunner ? 'configured single-guild channel' : 'existing per-guild settings; not verified by env audit',
      missing, invalid, status: missing.length || invalid.length ? 'configuration_incomplete' : 'configured_unverified',
      gateway: 'not_checked_by_local_audit', registration: 'not_checked_by_local_audit', delivery: 'not_checked_by_local_audit' };
  }
  const duplicateTokens = [...tokens.values()].filter((bots) => bots.length > 1);
  const duplicateApplications = [...clients.values()].filter((bots) => bots.length > 1);
  return { scope: 'local configuration only; no secret values or identity hashes exposed', applications,
    duplicateTokens, duplicateApplications,
    sixDistinctConfiguredIdentities: Object.values(applications).every((row) => row.status === 'configured_unverified') && !duplicateTokens.length && !duplicateApplications.length };
}

export async function assertIndependentDiscordIdentity(bot, env, options = {}) {
  const audit = await inspectDiscordApplications({ ...options, runtimeBot: bot, runtimeEnv: env });
  const conflicts = [...audit.duplicateApplications, ...audit.duplicateTokens].filter((owners) => owners.includes(bot));
  if (conflicts.length) throw new Error(`Discord identity is shared by multiple market owners: ${[...new Set(conflicts.flat())].join(', ')}. Each bot requires a separate application and token.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await inspectDiscordApplications(), null, 2));
}
