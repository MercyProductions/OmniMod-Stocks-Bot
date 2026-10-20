import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildSettings, updateGuildSettings } from './guildSettings.js';

const NAMES = Object.freeze({
  category: 'OMNIMOD CRYPTO',
  signals: 'omnimod-crypto-signals',
  results: 'omnimod-crypto-results',
  logs: 'omnimod-crypto-logs',
  alerts: 'OmniMod Crypto Alerts'
});

function textChannel(channels, name, parentId) {
  return channels.find((channel) =>
    channel.type === ChannelType.GuildText && channel.name === name && channel.parentId === parentId
  );
}

function preferredAdminRole(roles, configuredId) {
  if (configuredId) {
    const configured = roles.get(configuredId);
    if (configured) return configured;
  }
  const names = ['admin', 'owner', 'staff'];
  for (const name of names) {
    const role = roles.find((candidate) => candidate.name.toLowerCase() === name);
    if (role) return role;
  }
  return roles.find((role) => role.permissions.has(PermissionFlagsBits.Administrator)) || null;
}

export async function ensurePrimaryWorkspace(client, guildId) {
  if (!guildId) throw new Error('A primary Discord guild ID is required for automatic workspace setup.');
  const guild = await client.guilds.fetch(guildId);
  const current = await getGuildSettings(guildId);
  const channels = await guild.channels.fetch();
  const configuredSignals = current.signalsChannelId ? channels.get(current.signalsChannelId) : null;
  if (configuredSignals?.isTextBased()) return { settings: current, created: false };

  const member = await guild.members.fetchMe();
  if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('OmniMod Crypto needs Manage Channels for first-run workspace setup, or an admin can run /crypto setup with existing channels.');
  }

  let category = channels.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === NAMES.category);
  if (!category) {
    category = await guild.channels.create({ name: NAMES.category, type: ChannelType.GuildCategory, reason: 'OmniMod Crypto first-run setup' });
  }

  const roles = await guild.roles.fetch();
  const adminRole = preferredAdminRole(roles, current.adminRoleId);
  let alertRole = current.alertRoleId ? roles.get(current.alertRoleId) : roles.find((role) => role.name === NAMES.alerts);
  if (!alertRole && member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    alertRole = await guild.roles.create({ name: NAMES.alerts, color: 0x8b5cf6, mentionable: true, reason: 'OmniMod Crypto alert opt-in' });
  }

  const publicOverwrites = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] }
  ];
  const privateOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] }
  ];
  if (adminRole) privateOverwrites.push({ id: adminRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

  const refreshed = await guild.channels.fetch();
  const ensureText = async (name, topic, permissionOverwrites) => textChannel(refreshed, name, category.id) || guild.channels.create({
    name, type: ChannelType.GuildText, parent: category.id, topic, permissionOverwrites, reason: 'OmniMod Crypto first-run setup'
  });
  const signals = await ensureText(NAMES.signals, 'Daily momentum research, paper entries, targets, stops, and continuation guidance.', publicOverwrites);
  const results = await ensureText(NAMES.results, 'Tracked outcomes: green target, blue exceeded, yellow shortfall, red loss.', publicOverwrites);
  const logs = await ensureText(NAMES.logs, 'Private OmniMod Crypto scheduler, cache, provider, and health events.', privateOverwrites);

  const settings = await updateGuildSettings(guildId, {
    signalsChannelId: signals.id,
    resultsChannelId: results.id,
    logsChannelId: logs.id,
    alertRoleId: alertRole?.id || '',
    adminRoleId: adminRole?.id || '',
    configuredAt: new Date().toISOString(),
    configuredBy: client.user.id
  });
  return { settings, created: true, signalsChannel: signals };
}
