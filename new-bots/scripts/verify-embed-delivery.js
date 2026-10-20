/** Explicit operational delivery test. Never emits trading ideas or starts scanners. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { postDiscordMessage } from '../shared/discordWebhook.js';
import { MARKET_NAMES } from '../shared/discordPresentation.js';

if (process.argv[2] !== '--send') throw new Error('Use --send to explicitly post one embed verification per configured application.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guild = '1494837775659171900';
const destinations = { stocks: '1531880703921225888', crypto: '1526817321568436234' };
const evidence = [];
for (const bot of ['stocks', 'crypto', 'forex', 'futures', 'options', 'etfs-etps']) {
  const directory = resolve(root, ['stocks', 'crypto'].includes(bot) ? `${bot}-bot` : `new-bots/${bot}`);
  const env = parseEnv(await readFile(join(directory, '.env'), 'utf8'));
  env.DISCORD_DELIVERY_MODE = 'bot';
  env.DISCORD_GUILD_ID ||= guild;
  env.DISCORD_CHANNEL_ID ||= destinations[bot];
  const proofDir = join(root, 'review-verification', 'embed-delivery', bot);
  await mkdir(proofDir, { recursive: true });
  process.chdir(proofDir);
  let acknowledged;
  const payload = { embeds: [{ title: `OmniMod ${MARKET_NAMES[bot]} · Embed delivery verified`, color: 0x8b5cf6,
    description: 'Connection and presentation test — this is not a market signal.',
    fields: [
      { name: 'Day-trading feed', value: 'Scan coverage → developing watches → separately approved paper setups. Each highlighted idea states its remaining conditions; highlighted names are not the entire scanned universe.' },
      { name: 'Watch versus entry', value: 'A watch means conditions are developing. It is not an approved entry or a calibrated probability of profit. Approved paper setups include a conditional entry, stop and target.' },
      { name: 'Current rollout', value: ['stocks', 'crypto'].includes(bot)
        ? 'New presentation passed local checks. The website-hosted scanner update is still pending deployment.'
        : 'The independent local app is running. Live-market provider readiness is still incomplete; paper entries are paused and live orders are disabled.' },
    ], footer: { text: 'Operational test · no setup created · no order placed' }, timestamp: new Date().toISOString() }] };
  const sent = await postDiscordMessage(payload, { env, dedupeKey: 'day-trading-embed-verification-20261002',
    fetcher: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && response.ok) {
        const value = await response.clone().json();
        acknowledged = { embedCount: value.embeds?.length ?? 0, contentLength: value.content?.length ?? 0 };
        if (acknowledged.embedCount !== 1 || acknowledged.contentLength !== 0) throw new Error('Discord did not retain the expected embed.');
      }
      return response;
    } });
  const row = { bot, ...sent, ...acknowledged, channelId: env.DISCORD_CHANNEL_ID, checkedAt: new Date().toISOString() };
  evidence.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(join(root, 'review-verification/day-trading-embed-delivery-20261002.json'), JSON.stringify(evidence, null, 2) + '\n');
