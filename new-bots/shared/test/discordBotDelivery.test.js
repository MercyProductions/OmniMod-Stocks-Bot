import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { postDiscordMessage } from '../discordWebhook.js';

test('bot delivery verifies identity and destination before sending, suppresses mentions and durably deduplicates', async () => {
  const cwd = process.cwd(), dir = await mkdtemp(join(tmpdir(), 'omnimod-bot-delivery-'));
  const env = { DISCORD_DELIVERY_MODE: 'bot', DISCORD_TOKEN: 'secret-sentinel', DISCORD_CLIENT_ID: '111111111111111111',
    DISCORD_GUILD_ID: '222222222222222222', DISCORD_CHANNEL_ID: '333333333333333333',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/fallback-must-not-be-used' };
  let applicationId = env.DISCORD_CLIENT_ID, guildId = env.DISCORD_GUILD_ID, messageChannelId = env.DISCORD_CHANNEL_ID, failPost = false;
  const requests = [];
  const fetcher = async (url, options) => {
    assert.ok(url.startsWith('https://discord.com/api/v10/')); assert.equal(options.headers.authorization, `Bot ${env.DISCORD_TOKEN}`);
    requests.push({ url, options });
    if (url.endsWith('/oauth2/applications/@me')) return { ok: true, json: async () => ({ id: applicationId }) };
    if (url.endsWith('/messages')) return failPost ? { ok: false, status: 429 } : { ok: true, json: async () => ({ id: '444444444444444444', channel_id: messageChannelId }) };
    return { ok: true, json: async () => ({ id: env.DISCORD_CHANNEL_ID, guild_id: guildId, type: 0 }) };
  };
  try {
    process.chdir(dir);
    applicationId = '555555555555555555'; await assert.rejects(postDiscordMessage('test', { env, fetcher }), /token does not match/);
    assert.equal(requests.length, 1); applicationId = env.DISCORD_CLIENT_ID;
    guildId = '555555555555555555'; await assert.rejects(postDiscordMessage('test', { env, fetcher }), /destination/);
    assert.equal(requests.filter((r) => r.options.method === 'POST').length, 0); guildId = env.DISCORD_GUILD_ID;
    failPost = true; await assert.rejects(postDiscordMessage('test', { env, fetcher, dedupeKey: 'signal-1' }), /HTTP 429/);
    failPost = false; messageChannelId = '555555555555555555';
    await assert.rejects(postDiscordMessage('test', { env, fetcher, dedupeKey: 'signal-1' }), /acknowledgement/);
    messageChannelId = env.DISCORD_CHANNEL_ID;
    const sent = await postDiscordMessage('@everyone research', { env, fetcher, dedupeKey: 'signal-1' });
    assert.equal(sent.posted, true); assert.equal(sent.transport, 'bot');
    const count = requests.length;
    const again = await postDiscordMessage('same semantic signal', { env, fetcher, dedupeKey: 'signal-1' });
    assert.equal(again.deduplicated, true); assert.equal(requests.length, count);
    const posts = requests.filter((r) => r.options.method === 'POST').map((r) => JSON.parse(r.options.body));
    assert.ok(posts.every((r) => r.enforce_nonce === true && r.nonce.length <= 25));
    assert.equal(new Set(posts.map((r) => r.nonce)).size, 1, 'unconfirmed retry retains its Discord nonce');
    assert.deepEqual(posts.at(-1).allowed_mentions, { parse: [] });
    assert.equal(posts.at(-1).content, undefined);
    assert.equal(posts.at(-1).embeds[0].description, '@everyone research');
    assert.equal((await readFile(join(dir, 'data', 'discord-delivery.json'), 'utf8')).includes(env.DISCORD_TOKEN), false);
  } finally {
    process.chdir(cwd);
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('omnimod-bot-delivery-')) throw Error('Unsafe test cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});
