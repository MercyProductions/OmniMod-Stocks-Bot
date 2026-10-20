import { fileURLToPath } from 'node:url';
import { requestApplicationStop } from '../shared/marketApplicationControl.js';
import { MARKET_DISCORD_BOTS } from '../shared/marketDiscordConfig.js';

const bot = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(MARKET_DISCORD_BOTS, bot)) {
  console.error('Usage: node scripts/stop-discord-app.js forex|futures|options|etfs-etps'); process.exitCode = 1;
} else {
  try {
    const directory = fileURLToPath(new URL(`../${bot}/data/`, import.meta.url));
    const result = await requestApplicationStop({ bot, directory });
    console.log(JSON.stringify(result));
    if (result.status === 'stop_not_confirmed' || result.status === 'owner_replaced') process.exitCode = 1;
  } catch { console.error('Local shutdown failed; inspect the application lock and heartbeat.'); process.exitCode = 1; }
}
