import { config } from '../src/config.js';
import { getGuildSettings } from '../src/guildSettings.js';
import { trainGuildModel } from '../src/ensembleModel.js';
import { readTracker } from '../src/storage.js';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}

const guildId = argument('guild') || config.guildId;
if (!guildId) throw new Error('Provide --guild=DISCORD_GUILD_ID or configure DISCORD_GUILD_ID.');

const [settings, tracker] = await Promise.all([getGuildSettings(guildId), readTracker(guildId)]);
const result = await trainGuildModel(guildId, tracker.predictions || [], settings);
console.log(JSON.stringify({
  accepted: result.accepted,
  reason: result.reason,
  modelId: result.id || '',
  sampleSize: result.sampleSize,
  minimumSamples: result.minimumSamples || settings.modelMinSamples,
  training: result.training || null,
  holdout: result.holdout || null
}, null, 2));

