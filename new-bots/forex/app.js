import { fileURLToPath } from 'node:url';
import { runMarketDiscordCli, reportMarketDiscordStartupError } from '../shared/marketDiscordApplication.js';

runMarketDiscordCli({ bot: 'forex', directory: fileURLToPath(new URL('.', import.meta.url)) })
  .catch(reportMarketDiscordStartupError);
