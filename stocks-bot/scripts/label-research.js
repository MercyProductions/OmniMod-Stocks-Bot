import { config } from '../src/config.js';
import { labelPendingResearch } from '../src/counterfactualLabels.js';

function argument(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const result = await labelPendingResearch({
  guildId: argument('guild', config.guildId),
  provider: argument('provider', `alpaca-${config.alpacaDataFeed}`),
  lookbackDays: Number(argument('lookbackDays', String(config.researchRetentionDays))),
  maxSnapshots: Number(argument('maxSnapshots', '1000000')),
  slippageBps: Number(argument('slippageBps', String(config.counterfactualSlippageBps))),
  maxSpreadBps: Number(argument('maxSpreadBps', '500'))
});
console.log(JSON.stringify(result, null, 2));
