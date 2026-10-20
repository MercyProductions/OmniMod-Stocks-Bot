import { config } from './config.js';
import { paths, readJson, writeJson } from './storage.js';
import { decryptSecret, encryptSecret } from './secretStore.js';

export const DEFAULT_WATCHLIST = Object.freeze([
  'SPY','QQQ','IWM','DIA','XLK','XLF','XLE','XLV','XLY','XLI','XLP','XLU',
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD','AVGO','NFLX','CRM','ORCL',
  'PLTR','MU','INTC','ARM','SMCI','UBER','COIN','MSTR','JPM','BAC','GS','V','MA',
  'LLY','UNH','JNJ','XOM','CVX','WMT','COST','HD','DIS','BA','CAT','GE'
]);

function defaults() {
  return {
    signalsChannelId: '', resultsChannelId: '', logsChannelId: '', alertRoleId: '', adminRoleId: '',
    encryptedProviderKeys: {}, monitorMinutes: config.monitorMinutes, discoveryMinutes: config.discoveryMinutes,
    dailyHour: config.dailyHour, dailyMinute: config.dailyMinute, minScore: config.minScore,
    maxSignals: config.maxSignals, minPrice: config.minPrice, minAverageVolume: config.minAverageVolume,
    minDataQuality: config.minDataQuality, confirmationScans: config.confirmationScans,
    earningsBlackoutDays: config.earningsBlackoutDays, dailyCacheHours: config.dailyCacheHours,
    assumedSlippageBps: config.assumedSlippageBps,
    sharedPaperRoundTripFeesPerShare: config.sharedPaperRoundTripFeesPerShare,
    sharedPaperCostAssumptionsConfigured: config.sharedPaperCostAssumptionsConfigured,
    maxSpreadBps: config.maxSpreadBps, modelMinSamples: config.modelMinSamples,
    ensembleBuyProbability: config.ensembleBuyProbability, ensembleWatchProbability: config.ensembleWatchProbability,
    allowRuleOnlySignals: config.allowRuleOnlySignals,
    researchModelMinSamples: config.researchModelMinSamples, expertMinSamples: config.expertMinSamples,
    modelEmbargoMinutes: config.modelEmbargoMinutes, modelLookbackDays: config.modelLookbackDays, maxSectorSignals: config.maxSectorSignals,
    maxPairCorrelation: config.maxPairCorrelation, dailyLossLimitR: config.dailyLossLimitR,
    maxOpenPositions: config.maxOpenPositions, maxOpenRiskR: config.maxOpenRiskR, executionStressBps: config.executionStressBps,
    consecutiveLossLimit: config.consecutiveLossLimit, minPortfolioExpectedR: config.minPortfolioExpectedR,
    secFilingBlackoutHours: config.secFilingBlackoutHours, corporateActionBlackoutDays: config.corporateActionBlackoutDays,
    watchlist: [...DEFAULT_WATCHLIST], configuredAt: '', configuredBy: ''
  };
}

function normalize(value = {}) {
  const base = defaults();
  const number = (key, min, max) => {
    const raw = value[key] ?? base[key];
    const parsed = raw === '' ? NaN : Number(raw);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : base[key]));
  };
  const boolean = (key) => typeof value[key] === 'boolean' ? value[key] : base[key];
  const watchlist = [...new Set((Array.isArray(value.watchlist) ? value.watchlist : base.watchlist)
    .map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,10}$/.test(s)))].slice(0, 75);
  const encryptedProviderKeys = value.encryptedProviderKeys && typeof value.encryptedProviderKeys === 'object'
    ? value.encryptedProviderKeys : {};
  return {
    ...base, ...value, encryptedProviderKeys, watchlist: watchlist.length ? watchlist : [...DEFAULT_WATCHLIST],
    monitorMinutes: number('monitorMinutes', 2, 30), discoveryMinutes: number('discoveryMinutes', 5, 120),
    dailyHour: number('dailyHour', 0, 23), dailyMinute: number('dailyMinute', 0, 59),
    minScore: number('minScore', 45, 95), maxSignals: number('maxSignals', 1, 12),
    minPrice: number('minPrice', 0.1, 1000), minAverageVolume: number('minAverageVolume', 10000, 1000000000),
    minDataQuality: number('minDataQuality', 30, 95), confirmationScans: number('confirmationScans', 1, 5),
    earningsBlackoutDays: number('earningsBlackoutDays', 0, 14), dailyCacheHours: number('dailyCacheHours', 1, 24),
    assumedSlippageBps: number('assumedSlippageBps', 0, 100),
    maxSpreadBps: number('maxSpreadBps', 5, 500), modelMinSamples: number('modelMinSamples', 40, 10000),
    ensembleBuyProbability: number('ensembleBuyProbability', 0.50, 0.95), ensembleWatchProbability: number('ensembleWatchProbability', 0.45, 0.90),
    allowRuleOnlySignals: boolean('allowRuleOnlySignals'),
    researchModelMinSamples: number('researchModelMinSamples', 100, 1000000), expertMinSamples: number('expertMinSamples', 60, 1000000),
    modelEmbargoMinutes: number('modelEmbargoMinutes', 30, 1440), modelLookbackDays: number('modelLookbackDays', 30, 1460), maxSectorSignals: number('maxSectorSignals', 1, 12),
    maxPairCorrelation: number('maxPairCorrelation', 0.20, 0.99), dailyLossLimitR: number('dailyLossLimitR', 0.5, 20),
    maxOpenPositions: number('maxOpenPositions', 1, 12), maxOpenRiskR: number('maxOpenRiskR', 0.25, 12), executionStressBps: number('executionStressBps', 0, 200),
    consecutiveLossLimit: number('consecutiveLossLimit', 1, 20), minPortfolioExpectedR: number('minPortfolioExpectedR', -1, 5),
    secFilingBlackoutHours: number('secFilingBlackoutHours', 0, 168), corporateActionBlackoutDays: number('corporateActionBlackoutDays', 0, 30)
  };
}

export async function getGuildSettings(guildId) {
  const store = await readJson(paths.guildSettings(), {});
  return normalize(store?.[String(guildId)] || {});
}

export async function updateGuildSettings(guildId, patch) {
  if (!guildId) throw new Error('A Discord server id is required.');
  const store = await readJson(paths.guildSettings(), {});
  store[String(guildId)] = { ...(store[String(guildId)] || {}), ...patch, configuredAt: new Date().toISOString() };
  await writeJson(paths.guildSettings(), store);
  return getGuildSettings(guildId);
}

export async function saveProviderKey(guildId, provider, value) {
  const settings = await getGuildSettings(guildId);
  const encryptedProviderKeys = { ...settings.encryptedProviderKeys };
  if (value) encryptedProviderKeys[provider] = encryptSecret(value);
  else delete encryptedProviderKeys[provider];
  return updateGuildSettings(guildId, { encryptedProviderKeys });
}

export function providerKeys(settings) {
  return {
    alpha_vantage: decryptSecret(settings.encryptedProviderKeys?.alpha_vantage) || config.alphaVantageKey,
    finnhub: decryptSecret(settings.encryptedProviderKeys?.finnhub) || config.finnhubKey,
    polygon: decryptSecret(settings.encryptedProviderKeys?.polygon) || config.polygonKey,
    alpaca_key_id: decryptSecret(settings.encryptedProviderKeys?.alpaca_key_id) || config.alpacaKeyId,
    alpaca_secret_key: decryptSecret(settings.encryptedProviderKeys?.alpaca_secret_key) || config.alpacaSecretKey,
    fred: decryptSecret(settings.encryptedProviderKeys?.fred) || config.fredApiKey
  };
}

export async function listConfiguredGuildIds(client) {
  const store = await readJson(paths.guildSettings(), {});
  const saved = Object.entries(store || {}).filter(([, v]) => v?.signalsChannelId).map(([id]) => id);
  if (saved.length) return [...new Set(saved)];
  if (config.guildId) return [config.guildId];
  const guilds = client ? await client.guilds.fetch().catch(() => null) : null;
  return guilds ? [...guilds.keys()] : [];
}

export function maskSecret(value) {
  return String(value || '') ? 'configured' : 'not configured';
}
