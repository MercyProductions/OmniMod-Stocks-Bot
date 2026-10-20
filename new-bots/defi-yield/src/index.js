import { appendPaperSnapshot } from '../../shared/paperJournal.js';
import { postDiscordWebhook } from '../../shared/discordWebhook.js';
import { conservativeApyRate, poolTimestampStatus, rankPoolsByConservativeApy } from './ranking.js';

const env = (key, fallback) => process.env[key] ?? fallback;
const minTvl = Number(env('MIN_TVL_USD', 1_000_000));
const minCurrentApy = Number.isFinite(Number(env('MIN_CURRENT_APY_PCT', 1))) ? Math.max(0, Number(env('MIN_CURRENT_APY_PCT', 1))) : 1;
const maxPoolAgeMs = Math.max(1, Number(env('MAX_POOL_AGE_HOURS', 24)) || 24) * 3600000;
const allowedProjects = new Set(env('ALLOWED_PROJECTS', 'aave-v3,compound-v3,morpho-blue').split(',').map((x) => x.trim().toLowerCase()));
const allowedChains = new Set(env('ALLOWED_CHAINS', 'Ethereum,Arbitrum,Base,Optimism').split(',').map((x) => x.trim().toLowerCase()));
const cap = Math.max(1, Math.min(100, Number(env('MAX_POOLS', 30)) || 30));
const principal = Math.max(0, Number(env('INVESTMENT_USD', 0)) || 0);
const holdDays = Math.max(1, Number(env('HOLD_DAYS', 30)) || 30);
const roundTripCostText = env('ROUND_TRIP_COST_USD', '').trim();
const roundTripCost = roundTripCostText === '' ? null : Number(roundTripCostText);
if (roundTripCost !== null && (!Number.isFinite(roundTripCost) || roundTripCost < 0)) throw new Error('ROUND_TRIP_COST_USD must be a non-negative number or empty.');
const retrievedAt = new Date();
const now = retrievedAt.getTime();
const response = await fetch('https://yields.llama.fi/pools', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Yield data provider returned HTTP ${response.status}`);
const payload = await response.json();
const rows = (payload.data || []).filter((x) => {
  return poolTimestampStatus(x, now, maxPoolAgeMs).eligible
  && x.stablecoin === true
  && allowedProjects.has(String(x.project).toLowerCase())
  && allowedChains.has(String(x.chain).toLowerCase())
  && Number(x.tvlUsd) >= minTvl
  && Number.isFinite(Number(x.apy))
  && Number(x.apy) >= minCurrentApy
  && Number.isFinite(Number(x.apyMean30d))
  && Number(x.apy) <= Math.max(100, Number(x.apyMean30d) * 3);
});
const rankedRows = rankPoolsByConservativeApy(rows, { principal, holdDays, roundTripCost });
const pools = rankedRows.slice(0, cap).map((x) => ({
  rankingRatePct: Number(conservativeApyRate(x).toFixed(3)),
  project: x.project, chain: x.chain, symbol: x.symbol, poolId: x.pool,
  stablecoin: x.stablecoin, tvlUsd: Number(x.tvlUsd), currentApyPct: Number(x.apy),
  mean30dApyPct: Number(x.apyMean30d), apyChange7dPct: Number(x.apyPct7D),
  indicativeGrossReturnUsd: principal ? Number((principal * ((1 + Number(x.apy) / 100) ** (holdDays / 365) - 1)).toFixed(2)) : null,
  baseApyPct: x.apyBase != null && Number.isFinite(Number(x.apyBase)) ? Number(x.apyBase) : null,
  incentiveApyPct: x.apyReward != null && Number.isFinite(Number(x.apyReward)) ? Number(x.apyReward) : null,
  indicativeBaseOnlyGrossReturnUsd: principal && x.apyBase != null && Number.isFinite(Number(x.apyBase)) ? Number((principal * ((1 + Number(x.apyBase) / 100) ** (holdDays / 365) - 1)).toFixed(2)) : null,
  indicativeNetReturnUsd: principal && Number.isFinite(roundTripCost) ? Number((principal * ((1 + Number(x.apy) / 100) ** (holdDays / 365) - 1) - roundTripCost).toFixed(2)) : null,
  costAssumptionResult: !principal ? 'principal unset; gross APY ranking' : !Number.isFinite(roundTripCost) ? 'costs unset; gross APY ranking' : (principal * ((1 + Number(x.apy) / 100) ** (holdDays / 365) - 1) - roundTripCost) > 0 ? 'positive illustrative net at supplied assumptions' : 'negative illustrative net at supplied assumptions',
  breakevenApyPct: principal && Number.isFinite(roundTripCost) ? Number((((1 + roundTripCost / principal) ** (365 / holdDays) - 1) * 100).toFixed(3)) : null,
  costAssumption: Number.isFinite(roundTripCost) ? `user-supplied round trip $${roundTripCost}` : 'not supplied; net return not calculated',
  exposure: x.exposure, observedAt: retrievedAt.toISOString(), sourceUpdatedAt: x.timestamp || null,
  upstreamAgeMinutes: poolTimestampStatus(x, now, maxPoolAgeMs).upstreamAgeMinutes,
  timestampQuality: poolTimestampStatus(x, now, maxPoolAgeMs).status,
  rateTrend: Number(x.apy) < Number(x.apyMean30d) * 0.8 ? 'Current APY is materially below its 30-day mean.' : Number(x.apy) > Number(x.apyMean30d) * 1.2 ? 'Current APY is materially above its 30-day mean; confirm this is sustainable.' : 'Current APY is within 20% of its 30-day mean.',
  screen: 'Ranked at the lower of current and 30-day mean APY. Total APY may include volatile incentives; base-only estimate is shown when provided. Verify reserve-level withdrawal liquidity and caps; total TVL is not available withdrawal liquidity.'
}));
const journal = await appendPaperSnapshot('defi-yield', pools, { strategy: 'stablecoin lending discovery', minimumTvl: minTvl, minCurrentApyPct: minCurrentApy, principal, holdDays, roundTripCostUsd: roundTripCost });
const lines = pools.slice(0, 6).map((x) => `${x.project}/${x.chain} ${x.symbol} | rank APY ${x.rankingRatePct.toFixed(2)}% | current ${x.currentApyPct.toFixed(2)}% (base ${x.baseApyPct ?? 'n/a'}%, reward ${x.incentiveApyPct ?? 'n/a'}%) | TVL $${Math.round(x.tvlUsd).toLocaleString()}`);
const dedupeKey = JSON.stringify(pools.slice(0, 6).map((pool) => [pool.poolId, pool.rateTrend]));
const timestampNote = pools.some((pool) => pool.upstreamAgeMinutes === null) ? 'Some pool rows have no upstream timestamp; the observation time is when this bot retrieved the API response, not proof of per-pool update time.' : '';
const delivery = await postDiscordWebhook(['OmniMod DeFi Yield · read-only pool research', journal.capturedAt, ...(lines.length ? lines : ['No pool met the current screen.']), roundTripCost === null ? 'Net yield not calculated because round-trip costs are unset. APY varies.' : `Illustrative net uses supplied $${roundTripCost} round-trip cost; APY varies.`, timestampNote].filter(Boolean).join('\n'), { dedupeKey });
console.log(JSON.stringify({ bot: 'defi-yield', mode: 'read-only research', provider: 'DeFiLlama yields API', retrievedAt: retrievedAt.toISOString(), qualifyingPools: pools, timestampNote, paperJournal: journal, discordDelivery: delivery }, null, 2));
