import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordWebhook } from '../../shared/discordWebhook.js';
import { analyzeCycleQuote, evaluateCycleQuote, compareSameBlockQuotes, isUsableQuote } from './quoteAnalysis.js';
import { fetchV2CycleQuotes } from './evmRouterQuotes.js';

const env = (key, fallback) => process.env[key] ?? fallback;
const quotePath = env('QUOTE_FILE', 'examples/quotes.json');
const source = env('QUOTE_SOURCE', 'evm-v2').toLowerCase();
const routePath = env('ROUTES_FILE', 'examples/routes.json');
const maxAgeMs = Math.max(1, Number(env('MAX_QUOTE_AGE_SECONDS', 60))) * 1000;
const minNet = Math.max(0, Number(env('MIN_NET_EDGE_USD', 0.25)));
const now = Date.now();
const opportunities = [], routeEvaluations = [];
let quotes = [], rpcErrors = [], validCount = 0, mode;
if (source === 'evm-v2') {
  const routes = JSON.parse(await readFile(resolve(process.cwd(), routePath), 'utf8'));
  const result = await fetchV2CycleQuotes(routes, env('RPC_URL', 'https://ethereum-rpc.publicnode.com'), { now, maxAgeMs });
  quotes = result.quotes; rpcErrors = result.errors; validCount = quotes.length;
  routeEvaluations.push(...quotes.map((quote) => evaluateCycleQuote(quote, { minNetUsd: minNet })).filter(Boolean));
  opportunities.push(...routeEvaluations.filter((evaluation) => evaluation.status === 'candidate'));
  mode = 'read-only Uniswap V2-compatible Router02 quotes; no wallet or transaction';
} else if (source === 'json') {
  quotes = JSON.parse(await readFile(resolve(process.cwd(), quotePath), 'utf8'));
  const valid = quotes.filter((quote) => isUsableQuote(quote, { now, maxAgeMs }));
  validCount = valid.length;
  for (const buy of valid.filter((q) => q.side === 'buy')) for (const sell of valid.filter((q) => q.side === 'sell')) {
    const opportunity = compareSameBlockQuotes(buy, sell, { now, maxAgeMs, minNetUsd: minNet });
    if (opportunity) opportunities.push(opportunity);
  }
  mode = 'offline JSON quote research; no RPC or wallet';
} else throw new Error(`Unsupported QUOTE_SOURCE: ${source}`);
const journal = await appendPaperSnapshot('onchain-inefficiencies', [...quotes, ...routeEvaluations], { strategy: source === 'evm-v2' ? 'same-block router cycle quote screen' : 'same-block cross-venue quote screen', maxAgeMs, minEstimatedNetUsd: minNet, validFreshQuotes: validCount, rpcErrors: rpcErrors.length });
const lines = opportunities.slice(0, 6).map((x) => x.routeId
  ? `${x.routeId} | ${x.venue} | ${x.outputMultiple}x before configured gas/slippage | estimated net $${x.estimatedNetUsd}`
  : `${x.baseTokenAddress.slice(0, 8)}… | ${x.buyVenue} → ${x.sellVenue} | estimated net $${x.estimatedNetUsd}`);
const dedupeKey = JSON.stringify(opportunities.slice(0, 6).map((item) => [item.chainId, item.routeId || item.baseTokenAddress, item.buyVenue || item.venue, item.sellVenue || '', Math.floor(item.estimatedNetUsd)]));
const errors = rpcErrors.map((error) => `Route ${error.routeId || error.venue}: ${error.message}`);
const delivery = await postDiscordWebhook(['OmniMod On-Chain · quote research · no wallet or transactions', journal.capturedAt, `${validCount}/${quotes.length} configured quotes returned`, ...(lines.length ? lines : ['No configured route cleared current cost assumptions.']), ...errors.slice(0, 3), 'Router quotes are estimates, not atomic execution. Gas, MEV, tokens with transfer taxes, and changing state can erase the apparent edge.'].join('\n'), { dedupeKey });
console.log(JSON.stringify({ bot: 'onchain-inefficiencies', mode, source, validQuotes: validCount, configuredQuotes: source === 'json' ? quotes.length : undefined, rpcErrors, routeEvaluations, opportunities, paperJournal: journal, discordDelivery: delivery }, null, 2));
