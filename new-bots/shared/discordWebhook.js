import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDiscordId } from './marketDiscordConfig.js';
import { discordEmbedPayload } from './discordPresentation.js';

const getStatePath = () => resolve(process.cwd(), 'data', 'discord-delivery.json');

export function isInCooldown(lastSentAt, now, cooldownMs) {
  const last = Number(lastSentAt);
  return Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < cooldownMs;
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(getStatePath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

async function writeState(state) {
  const folder = resolve(process.cwd(), 'data');
  const statePath = getStatePath();
  await mkdir(folder, { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), 'utf8');
  await rename(temporary, statePath);
}

export async function postDiscordWebhook(content, { dedupeKey = null } = {}) {
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook) return { enabled: false, posted: false };
  let url;
  try { url = new URL(webhook); } catch { throw new Error('DISCORD_WEBHOOK_URL is not a valid URL.'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname)
    || !/^\/api\/webhooks\/\d+\/[A-Za-z\d._-]+\/?$/.test(url.pathname)) {
    throw new Error('DISCORD_WEBHOOK_URL must be an HTTPS Discord webhook URL.');
  }
  const cooldownSetting = Number(process.env.DISCORD_ALERT_COOLDOWN_MINUTES ?? 30);
  const cooldownMinutes = Number.isFinite(cooldownSetting) ? Math.max(0, Math.min(10080, cooldownSetting)) : 30;
  let state = null, key = null;
  if (dedupeKey != null && cooldownMinutes > 0) {
    state = await readState();
    const webhookScope = createHash('sha256').update(webhook).digest('hex');
    key = createHash('sha256').update(`${webhookScope}\n${String(dedupeKey)}`).digest('hex');
    const previous = state[key];
    const now = Date.now();
    if (isInCooldown(previous, now, cooldownMinutes * 60_000)) {
      return { enabled: true, posted: false, deduplicated: true, retryAt: new Date(Number(previous) + cooldownMinutes * 60_000).toISOString() };
    }
  }
  const payload = discordEmbedPayload(content);
  const username = process.env.DISCORD_WEBHOOK_USERNAME?.trim().slice(0, 80);
  const avatarUrl = process.env.DISCORD_WEBHOOK_AVATAR_URL?.trim();
  if (avatarUrl) {
    let parsed;
    try { parsed = new URL(avatarUrl); } catch { throw new Error('DISCORD_WEBHOOK_AVATAR_URL must be a valid HTTPS URL.'); }
    if (parsed.protocol !== 'https:') throw new Error('DISCORD_WEBHOOK_AVATAR_URL must be a valid HTTPS URL.');
  }
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, ...(username ? { username } : {}), ...(avatarUrl ? { avatar_url: avatarUrl } : {}) }),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  if (key) {
    const now = Date.now();
    const cutoff = now - 7 * 86_400_000;
    const cleaned = Object.fromEntries(Object.entries(state).filter(([, timestamp]) => Number(timestamp) >= cutoff).slice(-1000));
    cleaned[key] = now;
    await writeState(cleaned);
  }
  return { enabled: true, posted: true };
}

/** Application delivery has no webhook fallback after a configuration or API failure. */
export async function postDiscordMessage(content, { dedupeKey = null, env = process.env, fetcher = fetch } = {}) {
  const mode = env.DISCORD_DELIVERY_MODE || (env.DISCORD_TOKEN || env.DISCORD_CLIENT_ID || env.DISCORD_CHANNEL_ID ? 'bot' : 'webhook');
  if (mode === 'webhook') return postDiscordWebhook(content, { dedupeKey });
  if (mode !== 'bot') throw new Error('DISCORD_DELIVERY_MODE must be bot or webhook.');
  const token = String(env.DISCORD_TOKEN || '').trim();
  const clientId = String(env.DISCORD_CLIENT_ID || '').trim();
  const guildId = String(env.DISCORD_GUILD_ID || '').trim();
  const channelId = String(env.DISCORD_CHANNEL_ID || '').trim();
  if (!token || ![clientId, guildId, channelId].every(isDiscordId)) throw new Error('Bot delivery requires DISCORD_TOKEN and valid DISCORD_CLIENT_ID, DISCORD_GUILD_ID and DISCORD_CHANNEL_ID.');
  const payload = discordEmbedPayload(content);
  const cooldownRaw = Number(env.DISCORD_ALERT_COOLDOWN_MINUTES ?? 30);
  const cooldownMs = (Number.isFinite(cooldownRaw) ? Math.max(0, Math.min(10080, cooldownRaw)) : 30) * 60_000;
  const key = dedupeKey == null ? null : createHash('sha256').update(`bot:${clientId}:${guildId}:${channelId}\n${dedupeKey}`).digest('hex');
  const state = key ? await readState() : {};
  if (key && isInCooldown(state[key], Date.now(), cooldownMs)) return { enabled: true, posted: false, transport: 'bot', deduplicated: true };
  const request = async (path, method = 'GET', payload) => {
    let response;
    try {
      response = await fetcher(`https://discord.com/api/v10${path}`, { method,
        headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(12000) });
    } catch { throw new Error('Discord application transport failed; delivery is unconfirmed.'); }
    if (!response.ok) throw new Error(`Discord application request returned HTTP ${response.status}.`);
    try { return await response.json(); } catch { throw new Error('Discord application response was invalid.'); }
  };
  const application = await request('/oauth2/applications/@me');
  if (application?.id !== clientId) throw new Error('Discord token does not match DISCORD_CLIENT_ID.');
  const channel = await request(`/channels/${channelId}`);
  if (channel?.id !== channelId || channel.guild_id !== guildId || ![0, 5].includes(channel.type)) {
    throw new Error('Discord destination must be a text/announcement channel in DISCORD_GUILD_ID.');
  }
  const nonce = (key || createHash('sha256').update(`${Date.now()}:${process.pid}:${Math.random()}`).digest('hex')).slice(0, 24);
  const posted = await request(`/channels/${channelId}/messages`, 'POST', { ...payload, nonce, enforce_nonce: true });
  if (!isDiscordId(posted?.id) || posted.channel_id !== channelId) throw new Error('Discord message acknowledgement did not match the destination.');
  if (key) {
    const now = Date.now();
    const cleaned = Object.fromEntries(Object.entries(state).filter(([, at]) => Number(at) >= now - 7 * 86_400_000).slice(-1000));
    cleaned[key] = now;
    await writeState(cleaned);
  }
  return { enabled: true, posted: true, transport: 'bot', messageId: posted.id };
}
