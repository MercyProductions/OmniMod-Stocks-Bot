import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordWebhook } from '../../shared/discordWebhook.js';
import { horizonScenario } from './scenarios.js';
import { isMarketObservationFresh, marketObservationAgeMinutes } from './freshness.js';
import { buildOptionCandidatesForChains, fetchTradierChains } from './tradierOptions.js';
const env = (key, fallback) => process.env[key] ?? fallback;
const file = env('MARKET_FILE', env('SNAPSHOT_FILE', 'examples/wrappers-and-macro-markets.json'));
const source = env('MARKET_SOURCE', 'manual').toLowerCase();
const optionsFile = env('OPTIONS_FILE', 'examples/options.json');
const optionsSource = env('OPTIONS_SOURCE', 'manual').toLowerCase();
const optionsUniverseFile = env('OPTIONS_UNIVERSE_FILE', 'examples/options-universe.json');
const tradierEnv = env('TRADIER_ENV', 'sandbox').toLowerCase();
const optionMaxAgeMinutes = Math.max(1, Math.min(1440, Number(env('MAX_OPTION_QUOTE_AGE_MINUTES', 25)) || 25));
const maxMarkets = Math.max(1, Math.min(100, Number(env('MAX_MARKETS', 30)) || 30));
const maxMarketAgeMinutes = Math.max(1, Math.min(10080, Number(env('MAX_MARKET_AGE_MINUTES', 15)) || 15));
const loadedInputs = JSON.parse(await readFile(resolve(process.cwd(), file), 'utf8'));
if (!Array.isArray(loadedInputs)) throw new Error('Market file must contain a JSON array');
const inputs = loadedInputs.slice(0, maxMarkets);
if (source !== 'manual') throw new Error(`Unsupported MARKET_SOURCE: ${source}; configure an authorized market-data adapter.`);
const rows = inputs;
const now = Date.now();
const observations = rows.map((x) => {
  const ageMinutes = marketObservationAgeMinutes(x, now), stale = !isMarketObservationFresh(x, now, maxMarketAgeMinutes);
  return { ...x, ageMinutes: Number.isFinite(ageMinutes) ? Number(ageMinutes.toFixed(1)) : null, stale,
    ...(stale ? {} : { scenarios: [horizonScenario(x, 1, x.return1dPct, '1-day'), horizonScenario(x, 5, x.return5dPct, '5-day')] }) };
});
const optionInputs = JSON.parse(await readFile(resolve(process.cwd(), optionsFile), 'utf8'));
if (!['manual', 'tradier'].includes(optionsSource)) throw new Error(`Unsupported OPTIONS_SOURCE: ${optionsSource}`);
let optionChains = [], optionCandidates = [];
if (optionsSource === 'tradier') {
  const optionUniverse = JSON.parse(await readFile(resolve(process.cwd(), optionsUniverseFile), 'utf8'));
  optionChains = await fetchTradierChains(optionUniverse, {
    token: env('TRADIER_TOKEN', ''), environment: tradierEnv, maxAgeMinutes: optionMaxAgeMinutes,
    minDaysToExpiry: Math.max(0, Math.min(365, Number(env('MIN_OPTION_DAYS_TO_EXPIRY', 7)) || 0)),
    maxDaysToExpiry: Math.max(1, Math.min(730, Number(env('MAX_OPTION_DAYS_TO_EXPIRY', 45)) || 45)),
  });
  optionCandidates = buildOptionCandidatesForChains(optionChains, observations, {
    minOpenInterest: Math.max(0, Number(env('MIN_OPTION_OPEN_INTEREST', 100)) || 0),
    maxLegSpreadPct: Math.max(1, Math.min(100, Number(env('MAX_OPTION_LEG_SPREAD_PCT', 35)) || 35)),
    maxCandidates: 3,
    maxUnderlyingQuoteSkewMinutes: Math.max(1, Math.min(180, Number(env('MAX_OPTION_UNDERLYING_SKEW_MINUTES', 15)) || 15)),
  });
}
const usable = observations.filter((x) => !x.stale && Number.isFinite(Number(x.volatility20dPct)) && Number(x.volatility20dPct) > 0);
const grouped = Object.groupBy ? Object.groupBy(usable, (x) => x.assetClass) : usable.reduce((o, x) => ((o[x.assetClass] ||= []).push(x), o), {});
const concentration = Object.fromEntries(Object.entries(grouped).map(([name, values]) => [name, { count: values.length, meanVolatility20dPct: values.reduce((a, x) => a + Number(x.volatility20dPct), 0) / values.length }]));
function analyzeVertical(option) {
  const type = option.strategy, long = Number(option.longStrike), short = Number(option.shortStrike);
  const premium = Number(option.netPremiumPerShare), contracts = Number(option.contracts), multiplier = Number(option.multiplier ?? 100);
  const expires = Date.parse(option.expiry);
  if (!['bull-call-debit', 'bear-put-debit', 'bear-call-credit', 'bull-put-credit'].includes(type)
    || !(long > 0 && short > 0 && premium > 0 && Number.isInteger(contracts) && contracts > 0 && multiplier > 0)
    || !Number.isFinite(expires)) return { symbol: option.symbol, status: 'invalid-input' };
  const debit = type.endsWith('-debit'), call = type.includes('call');
  const validOrder = debit ? (call ? long < short : long > short) : (call ? long > short : long < short);
  if (!validOrder || (debit && premium >= Math.abs(short - long)) || (!debit && premium >= Math.abs(short - long))) return { symbol: option.symbol, status: 'invalid-spread-geometry-or-premium' };
  const width = Math.abs(short - long), perContractMaxLoss = (debit ? premium : width - premium) * multiplier;
  const perContractMaxProfit = (debit ? width - premium : premium) * multiplier;
  const breakeven = debit ? (call ? long + premium : long - premium) : (call ? short + premium : short - premium);
  return { symbol: option.symbol, strategy: type, expiry: option.expiry, daysToExpiry: Math.max(0, (expires - now) / 86400000), status: expires <= now ? 'expired-input' : 'payoff-calculated', contracts, multiplier, maxLossUsd: Number((perContractMaxLoss * contracts).toFixed(2)), maxProfitUsd: Number((perContractMaxProfit * contracts).toFixed(2)), breakevenAtExpiry: Number(breakeven.toFixed(4)), note: 'Expiry payoff bound from supplied legs/premium; excludes fees, early exercise/assignment, and mark-to-market effects.' };
}
const optionPayoffs = optionsSource === 'manual' ? optionInputs.map(analyzeVertical) : optionCandidates;
const journal = await appendPaperSnapshot('multi-asset', [...observations, ...optionChains.map(({ options, ...summary }) => summary), ...optionPayoffs], { strategy: 'cross-asset context and defined-risk option research', maxMarketAgeMinutes, optionsSource });
const marketLines = observations.slice(0, 6).map((x) => {
  const symbol = String(x.symbol).replace(/[\r\n@`]/g, ' ');
  const scenarios = (x.scenarios || []).map((s) => `${s.horizon} ${s.bias} (${s.normalizedMove ?? 'n/a'}σ)`).join('; ');
  const productNote = x.instrumentNote ? ` | ${String(x.instrumentNote).replace(/[\r\n]/g, ' ').slice(0, 150)}` : '';
  const reset = x.leverageReset ? ` | ${x.leverageReset} leverage reset` : '';
  return `${symbol} | ${x.assetClass}${reset} | ${x.stale ? 'STALE' : 'current'} | ${scenarios || `1d ${x.return1dPct ?? 'n/a'}% / 5d ${x.return5dPct ?? 'n/a'}%`}${productNote}`;
});
const optionLines = optionPayoffs.filter((x) => ['payoff-calculated', 'research-candidate'].includes(x.status)).slice(0, 4).map((x) => x.status === 'research-candidate'
  ? `${x.symbol} ${x.strategy} ${x.expiry} | debit $${x.estimatedNetDebitPerShare}/share | max loss $${x.maxLossUsd} | scenario P/L $${x.estimatedExpiryPnlAtScenarioTargetUsd}`
  : `${x.symbol} ${x.strategy} | max loss $${x.maxLossUsd} | max gain $${x.maxProfitUsd} | expiry ${x.expiry}`);
const dedupeKey = JSON.stringify({ markets: observations.map((x) => [x.symbol, x.stale, ...(x.scenarios || []).map((scenario) => scenario.bias)]), options: optionPayoffs.map((x) => [x.symbol, x.strategy, x.status]) });
const delivery = await postDiscordWebhook(['OmniMod Multi-Asset · research snapshot · no broker orders', 'Source: user-supplied observations', ...(optionsSource === 'tradier' ? [`Options source: Tradier ${tradierEnv}; quote-age limit ${optionMaxAgeMinutes}m`] : []), journal.capturedAt, ...(marketLines.length ? marketLines : ['No market inputs supplied.']), ...(optionLines.length ? optionLines : optionsSource === 'tradier' ? ['No option candidate passed direction, quote quality and liquidity filters.'] : []), 'Volatility-scaled levels are scenarios, not predicted prices or probabilities. Option candidate P/L is a scenario, not a forecast. Nothing here is an order or allocation recommendation.'].join('\n'), { dedupeKey });
console.log(JSON.stringify({ bot: 'multi-asset', mode: `${source} research; no broker orders`, asOf: journal.capturedAt, staleCount: observations.filter((x) => x.stale).length, byAssetClass: concentration, observations, optionsSource, optionChains, optionPayoffs, paperJournal: journal, discordDelivery: delivery, note: 'Public chart data may be delayed and is not an official market-data feed. Option candidates use quoted leg prices and a heuristic underlying scenario; they are not forecasts or recommendations. No portfolio weights were provided and no orders are placed.' }, null, 2));
