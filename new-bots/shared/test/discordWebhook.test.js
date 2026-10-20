import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInCooldown, postDiscordWebhook } from '../discordWebhook.js';

test('duplicate semantic alert is suppressed only inside cooldown window', () => {
  assert.equal(isInCooldown(1000, 2000, 5000), true);
  assert.equal(isInCooldown(1000, 6000, 5000), false);
  assert.equal(isInCooldown(3000, 2000, 5000), false);
});

test('invalid timestamps and disabled cooldown never suppress', () => {
  assert.equal(isInCooldown(null, 2000, 5000), false);
  assert.equal(isInCooldown('invalid', 2000, 5000), false);
  assert.equal(isInCooldown(1000, 2000, 0), false);
});

test('successful webhook is deduplicated durably without storing its secret URL', async () => {
  const previousCwd = process.cwd();
  const testDir = await mkdtemp(join(tmpdir(), 'omnimod-webhook-test-'));
  const restore = Object.fromEntries(['DISCORD_WEBHOOK_URL', 'DISCORD_ALERT_COOLDOWN_MINUTES'].map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    process.chdir(testDir);
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/12345/test-secret';
    process.env.DISCORD_ALERT_COOLDOWN_MINUTES = '30';
    globalThis.fetch = async () => { fetchCount += 1; return { ok: true, status: 204 }; };
    const first = await postDiscordWebhook('one alert', { dedupeKey: 'same-condition' });
    const second = await postDiscordWebhook('same alert again', { dedupeKey: 'same-condition' });
    assert.equal(first.posted, true);
    assert.equal(second.deduplicated, true);
    assert.equal(fetchCount, 1);
    const statePath = resolve(testDir, 'data', 'discord-delivery.json');
    const saved = await readFile(statePath, 'utf8');
    assert.equal(saved.includes('test-secret'), false);
    assert.equal(Object.keys(JSON.parse(saved)).length, 1);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const absoluteTestDir = resolve(testDir), absoluteTemp = resolve(tmpdir());
    if (absoluteTestDir.startsWith(absoluteTemp + (absoluteTemp.endsWith('\\') ? '' : '\\')) && absoluteTestDir.includes('omnimod-webhook-test-')) {
      await rm(absoluteTestDir, { recursive: true, force: true });
    }
  }
});
