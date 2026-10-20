import { config } from '../src/config.js';
import { getGuildSettings } from '../src/guildSettings.js';
import { trainResearchModel } from '../src/researchModel.js';

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
}

const guildId = argument('guild') || config.guildId;
if (!guildId) throw new Error('Provide --guild=DISCORD_GUILD_ID or configure DISCORD_GUILD_ID.');
const settings = await getGuildSettings(guildId);
const model = await trainResearchModel(guildId, settings);
console.log(JSON.stringify({
  accepted: model.validation.accepted, modelId: model.id, samples: model.sampleSize,
  independentDays: model.independentDays, acceptedExperts: model.acceptedExperts,
  experts: Object.fromEntries(Object.entries(model.experts).map(([key, value]) => [key, { accepted: value.accepted, samples: value.sampleSize, days: value.days, algorithm: value.selectedAlgorithm, reason: value.reason }]))
}, null, 2));

