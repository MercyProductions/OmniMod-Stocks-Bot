import { Client, Events, GatewayIntentBits, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMarketDiscordConfig, requireMarketDiscordConfig, discordInstallUrl, redactDiscordRuntimeText } from './marketDiscordConfig.js';
import { acquireMarketApplicationLock, createMarketLogger, createMarketScanScheduler } from './marketBotRuntime.js';
import { createRunnerHeartbeat } from './runnerHeartbeat.js';
import { paperLedgerFingerprint } from './paperStatePath.js';
import { postDiscordMessage } from './discordWebhook.js';
import { discordEmbedPayload } from './discordPresentation.js';
import { buildMarketDiscordCommands, handleMarketDiscordCommand, readMarketOperationalSnapshot } from './marketDiscordOperations.js';
import { assertIndependentDiscordIdentity } from './discordApplicationAudit.js';
import { watchApplicationStop } from './marketApplicationControl.js';

export async function validateMarketDiscordDestination(client, config) {
  if (client.application?.id !== config.clientId || !client.user?.bot) throw new Error('Discord token/application identity mismatch.');
  const channel = await client.channels.fetch(config.channelId);
  if (!channel || channel.guildId !== config.guildId || ![0, 5].includes(channel.type)) {
    throw new Error('Configured destination is not a text/announcement channel in the configured guild.');
  }
  if (!channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new Error('Bot lacks View Channel, Send Messages or Embed Links in the configured channel.');
  }
  return channel;
}

export async function startMarketDiscordApplication({ bot, directory, env = process.env,
  clientFactory = () => new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } }),
  installSignalHandlers = true, auditRootDir }) {
  const config = requireMarketDiscordConfig(bot, env);
  await assertIndependentDiscordIdentity(bot, env, { rootDir: auditRootDir });
  const dataDirectory = join(directory, 'data');
  const releaseLock = await acquireMarketApplicationLock(dataDirectory, bot);
  const log = createMarketLogger(dataDirectory, bot, env);
  let client;
  try { client = clientFactory(); }
  catch (error) { await releaseLock(); throw error; }
  let discordReady = false, stopping = false, stopped = null, scanState = {}, monitorState = {}, cancelReadiness = null, stopWatcher;
  const heartbeat = createRunnerHeartbeat({ bot, directory: dataDirectory, role: 'discord-application',
    getState: () => ({ ...scanState, discordReady, positionMonitor: { enabled: config.monitorIntervalMs > 0, ...monitorState }, emergencyStopActive: env.OMNIMOD_EMERGENCY_STOP !== 'false',
      liveTradingEnabled: false, ledgerFingerprint: paperLedgerFingerprint(env.TRADING_RISK_STATE_PATH || '') }) });
  const scheduler = createMarketScanScheduler({ directory, entry: resolve(directory, 'src/index.js'), env,
    intervalMs: config.intervalMs, timeoutMs: config.timeoutMs, log,
    onState: (next) => { scanState = next; void heartbeat.update(next); } });
  const monitor = config.monitorIntervalMs > 0 ? createMarketScanScheduler({ directory,
    entry: fileURLToPath(new URL('./paperPositionMonitor.js', import.meta.url)), args: [bot], env,
    intervalMs: config.monitorIntervalMs, timeoutMs: 60000,
    log: (event, detail) => log(event.replace(/^scan/, 'position_monitor'), detail),
    onState: (next) => { monitorState = next; void heartbeat.update({ positionMonitor: { enabled: true, ...next } }); } }) : null;
  const signalStop = () => { void stop().catch(() => { process.exitCode = 1; void log('shutdown_failed', 'Inspect child and lock owner before restart.'); }); };
  const stop = () => {
    if (stopping) return stopped;
    stopping = true;
    stopWatcher?.close();
    cancelReadiness?.();
    stopped = (async () => {
      await Promise.all([scheduler.stop(), monitor?.stop()]); discordReady = false;
      await heartbeat.stop({ state: 'stopped', discordReady: false, schedulerRunning: false });
      client.destroy();
      await releaseLock();
      if (installSignalHandlers) { process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop); }
      await log('application_stopped'); await log.flush();
    })();
    return stopped;
  };
  stopWatcher = watchApplicationStop({ directory: dataDirectory, owner: releaseLock.owner,
    onStop: async () => { await log('local_shutdown_requested'); await stop(); },
    onError: () => { void log('local_shutdown_failed', 'Inspect application heartbeat and lock before restart.'); } });
  stopWatcher.start();
  client.on(Events.Error, (error) => { void log('discord_error', `code=${error.code || 'unknown'} ${error.message || ''}`); });
  client.on(Events.ShardError, (error) => { void log('discord_shard_error', `code=${error.code || 'unknown'} ${error.message || ''}`); });
  client.on(Events.ShardDisconnect, () => { discordReady = false; void heartbeat.update({ discordReady }); void log('discord_disconnected'); });
  client.on(Events.ShardResume, () => { discordReady = client.isReady(); void heartbeat.update({ discordReady }); });
  client.on(Events.ClientReady, () => { if (!stopping && scanState.schedulerRunning) { discordReady = true; void heartbeat.update({ discordReady }); } });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleMarketDiscordCommand(interaction, { config, env,
      getSnapshot: () => readMarketOperationalSnapshot({ bot, directory, env }),
      getRuntime: () => ({ discordReady, ...scheduler.snapshot() }), requestScan: () => scheduler.requestScan(),
      deliveryTest: () => postDiscordMessage(`${config.name} connection test. Paper research only; no order was created.`,
        { env: { ...env, DISCORD_DELIVERY_MODE: 'bot' }, dedupeKey: `application-test:${config.clientId}` }),
    }).catch(async (error) => {
      await log('command_failed', `code=${error.code || 'unknown'} ${error.message || ''}`);
      const response = { embeds: discordEmbedPayload('Operation failed. Inspect the bot’s local log; no successful delivery is being claimed.', { title: `${config.name} · Operation failed` }).embeds, allowedMentions: { parse: [] } };
      try { if (interaction.deferred || interaction.replied) await interaction.editReply(response);
        else await interaction.reply({ ...response, flags: 64 }); } catch { /* Discord outage; log above remains authoritative. */ }
    });
  });
  if (installSignalHandlers) { process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop); }
  heartbeat.start();
  try {
    await log('application_starting', config.name);
    await new Promise((accept, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.off(Events.ClientReady, ready);
        cancelReadiness = null;
        if (error) reject(error); else accept();
      };
      const ready = () => finish();
      const timeout = setTimeout(() => finish(new Error('Discord gateway readiness timed out.')), 45_000);
      cancelReadiness = () => finish(new Error('Discord startup was interrupted.'));
      client.once(Events.ClientReady, ready);
      // Catch synchronous adapter failures as well as rejected login promises.
      Promise.resolve().then(() => client.login(config.token))
        .catch(() => finish(new Error('Discord login failed; verify this application token locally.')));
    });
    if (stopping) throw new Error('Discord startup was interrupted.');
    await validateMarketDiscordDestination(client, config);
    if (stopping) throw new Error('Discord startup was interrupted.');
    discordReady = true;
    await heartbeat.update({ discordReady });
    await log('application_ready', 'Identity and destination verified; scheduler starting.');
    scheduler.start();
    monitor?.start();
    return { client, config, scheduler, monitor, stop };
  } catch (error) { await stop(); throw error; }
}

export async function runMarketDiscordCli({ bot, directory, env = process.env, args = process.argv.slice(2) }) {
  if (args.length > 1 || (args.length && !['--setup', '--register'].includes(args[0]))) throw new Error('Use no arguments, --setup or --register.');
  if (args[0] === '--setup') {
    const config = readMarketDiscordConfig(bot, env);
    console.log(JSON.stringify({ bot, expectedName: config.name, configured: config.ready, missing: config.missing,
      invalid: config.invalid, installationUrl: discordInstallUrl(config), intents: ['Guilds'], permissions: ['View Channel', 'Send Messages', 'Embed Links'],
      registration: `/${config.command} (Manage Server, configured guild only)`, identity: 'Set this separate application’s bot name and avatar in the Discord Developer Portal.',
      verification: 'Local configuration only; run register, start and delivery-test after user-approved server installation.' }, null, 2));
    return;
  }
  if (args[0] === '--register') {
    const config = requireMarketDiscordConfig(bot, env);
    await assertIndependentDiscordIdentity(bot, env);
    const rest = new REST({ version: '10', retries: 0 }).setToken(config.token);
    try {
      const application = await rest.get('/oauth2/applications/@me');
      if (application?.id !== config.clientId) throw new Error('Configured application mismatch.');
      // Guild-scoped registration leaves global and other-guild commands untouched.
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: buildMarketDiscordCommands(config) });
    } catch { throw new Error('Discord command registration failed; verify token, application ID and installed guild locally.'); }
    console.log(`${config.name}: guild operational commands registered.`);
    return;
  }
  return startMarketDiscordApplication({ bot, directory, env });
}

export function reportMarketDiscordStartupError(error) {
  console.error(redactDiscordRuntimeText(error?.message || 'Discord application failed.'));
  process.exitCode = 1;
}
