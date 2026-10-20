import { readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PROVIDER_PROFILES, providerProfile, missingProviderCredentials, renderProviderConfiguration } from '../shared/providerProfiles.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const folders = { stocks: 'stocks-bot', crypto: 'crypto-bot', forex: 'new-bots/forex',
  futures: 'new-bots/futures', options: 'new-bots/options', 'etfs-etps': 'new-bots/etfs-etps' };
const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
const flagValue = (name) => args.includes(name) ? argument(name) : null;
const selectorValues = new Set(['manual', 'fixture', 'disabled', 'sandbox', 'production', 'delayed_sip', 'false', 'true',
  ...Object.values(PROVIDER_PROFILES).flatMap((profiles) => Object.values(profiles).flatMap((profile) => Object.values(profile.settings)))]);
const selectorKeys = [...new Set(Object.values(PROVIDER_PROFILES).flatMap((profiles) => Object.values(profiles).flatMap((profile) => Object.keys(profile.settings))))];

async function inspect(bot) {
  const path = resolve(workspace, folders[bot], '.env');
  const text = await readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const local = parseEnv(text);
  const env = { ...local, ...process.env };
  if (bot === 'stocks') for (const key of Object.keys(env)) {
    if (process.env['STOCKS_' + key] !== undefined) env[key] = process.env['STOCKS_' + key];
  }
  return { path, text, env };
}

function plan(bot, name, env) {
  const profile = providerProfile(bot, name);
  const missingCredentials = missingProviderCredentials(profile, env);
  const budget = Number(env.FUTURES_MAX_SCAN_COST_USD);
  const missingSetup = bot === 'futures' && name === 'paid' && !(Number.isFinite(budget) && budget > 0)
    ? ['explicit_positive_FUTURES_MAX_SCAN_COST_USD_budget'] : [];
  return { ...profile, missingCredentials, missingSetup,
    canApply: profile.supported && missingCredentials.length === 0 && missingSetup.length === 0,
    providerVerified: false, note: 'Configuration only. No provider request, subscription purchase, order or Discord post is made.' };
}

async function main() {
  if (args.includes('--list')) { console.log(JSON.stringify(PROVIDER_PROFILES, null, 2)); return; }
  if (args.includes('--audit')) {
    const bots = [];
    for (const bot of Object.keys(folders)) {
      const { env } = await inspect(bot);
      bots.push({ bot, source: 'local configuration and inherited environment; remote deployments are not inspected',
        selectors: Object.fromEntries(selectorKeys.filter((key) => env[key] !== undefined)
          .map((key) => [key, selectorValues.has(env[key]) ? env[key] : 'unrecognized_value'])),
        profiles: Object.keys(PROVIDER_PROFILES[bot]).map((name) => plan(bot, name, env)) });
    }
    console.log(JSON.stringify({ capturedAt: new Date().toISOString(), bots }, null, 2));
    return;
  }
  const bot = flagValue('--bot'), name = flagValue('--profile');
  if (!folders[bot] || !name) throw new Error('Usage: --audit | --list | --bot stocks|crypto|forex|futures|options|etfs-etps --profile NAME [--apply]');
  const current = await inspect(bot), selected = plan(bot, name, current.env);
  if (args.includes('--apply')) {
    if (!selected.canApply) throw new Error('Profile not applied. Missing credentials/setup: ' +
      [...selected.missingCredentials, ...selected.missingSetup, ...(!selected.supported ? ['no_supported_adapter'] : [])].join(', '));
    if (Object.entries(selected.settings).some(([key, value]) => process.env[key] !== undefined && process.env[key] !== value
      || (bot === 'stocks' && process.env['STOCKS_' + key] !== undefined && process.env['STOCKS_' + key] !== value)))
      throw new Error('An inherited environment selector overrides this profile. Resolve it before applying the local configuration.');
    // Exclusive temp file and a final concurrent-change check preserve unrelated edits.
    const temporary = current.path + '.provider-' + randomUUID() + '.tmp';
    try {
      const mode = (await stat(current.path).catch(() => ({ mode: 0o600 }))).mode;
      await writeFile(temporary, renderProviderConfiguration(current.text, selected), { encoding: 'utf8', flag: 'wx', mode });
      const latest = await readFile(current.path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
      if (latest !== current.text) throw new Error('Configuration changed during setup; no update applied.');
      await rename(temporary, current.path);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  console.log(JSON.stringify({ ...selected, applied: args.includes('--apply'),
    next: 'Supply remaining market-specific reviews/costs, run a read-only provider preflight, then restart the affected bot. Paper/live controls are unchanged.' }, null, 2));
}

main().catch((error) => { console.error(error.code ? 'Configuration file operation failed (' + error.code + ').' : error.message); process.exitCode = 1; });
