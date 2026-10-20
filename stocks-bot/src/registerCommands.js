import { REST, Routes } from 'discord.js';
import { config, requireRuntimeConfig } from './config.js';
import { buildCommands } from './commands.js';

requireRuntimeConfig();
const rest = new REST({ version: '10' }).setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);
await rest.put(route, { body: buildCommands() });
console.log(`Registered OmniMod Stocks commands ${config.guildId ? `for guild ${config.guildId}` : 'globally'}.`);
