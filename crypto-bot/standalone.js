import 'dotenv/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, requireRuntimeConfig } from './src/config.js';
import { startStandaloneCryptoHost } from './src/standaloneHost.js';
import { redactDiscordRuntimeText } from '../new-bots/shared/marketDiscordConfig.js';

try {
  requireRuntimeConfig();
  process.env.OMNIMOD_EMBEDDED_HOST = '1';
  await startStandaloneCryptoHost({ directory: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, DISCORD_TOKEN: config.discordToken, DISCORD_CLIENT_ID: config.clientId },
    loadWorker: () => import('./src/index.js') });
} catch (error) {
  console.error(redactDiscordRuntimeText(error?.message || 'Independent Crypto startup failed.'));
  // A failed dynamic worker import may already have opened sockets; terminate this host only.
  process.exit(1);
}
