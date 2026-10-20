import { fileURLToPath } from 'node:url';
import { runMarketDiscordCli, reportMarketDiscordStartupError } from '../shared/marketDiscordApplication.js';

runMarketDiscordCli({ bot: 'etfs-etps', directory: fileURLToPath(new URL('.', import.meta.url)) })
  .catch(reportMarketDiscordStartupError);
