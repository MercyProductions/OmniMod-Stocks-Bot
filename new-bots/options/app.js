import { fileURLToPath } from 'node:url';
import { runMarketDiscordCli, reportMarketDiscordStartupError } from '../shared/marketDiscordApplication.js';

runMarketDiscordCli({ bot: 'options', directory: fileURLToPath(new URL('.', import.meta.url)) })
  .catch(reportMarketDiscordStartupError);
