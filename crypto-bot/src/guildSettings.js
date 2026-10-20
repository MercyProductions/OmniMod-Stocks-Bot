import { config } from './config.js';
import { paths, readJson, writeJson } from './storage.js';

function defaults() {
  return {
    signalsChannelId: '', resultsChannelId: '', logsChannelId: '',
    alertRoleId: '', adminRoleId: '', coingeckoApiKey: '', coingeckoApiTier: config.coingeckoApiTier,
    monitorMinutes: config.monitorMinutes, discoveryMinutes: config.discoveryMinutes,
    dailyHour: config.dailyHour, dailyMinute: config.dailyMinute,
    minScore: config.minScore, maxSignals: config.maxSignals,
    maxMarketRank: config.maxMarketRank, minVolumeUsd: config.minVolumeUsd,
    broadDiscoveryEnabled: config.broadDiscoveryEnabled,
    venueDiscoveryEnabled: config.venueDiscoveryEnabled, venueResearchCandidates: config.venueResearchCandidates,
    minProviderConfirmations: config.minProviderConfirmations, maxProviderCandidates: config.maxProviderCandidates,
    minRiskReward: config.minRiskReward, accountRiskPct: config.accountRiskPct,
    estimatedRoundTripBps: config.estimatedRoundTripBps,
    maxOpenRiskPct: config.maxOpenRiskPct, guardMaxDailyLossR: config.guardMaxDailyLossR,
    maxConcurrentSignals: config.maxConcurrentSignals, maxSignalCorrelation: config.maxSignalCorrelation,
    metaMinSamples: config.metaMinSamples, metaRetrainHours: config.metaRetrainHours,
    minMetaProbability: config.minMetaProbability, researchRetentionDays: config.researchRetentionDays,
    guardRollingWindow: config.guardRollingWindow, guardMinOutcomes: config.guardMinOutcomes,
    guardMaxDrawdownR: config.guardMaxDrawdownR, guardMinExpectancyR: config.guardMinExpectancyR,
    guardMaxBrier: config.guardMaxBrier, guardLookbackHours: config.guardLookbackHours,
    derivativesEnabled: config.derivativesEnabled, realtimeEnabled: config.realtimeEnabled,
    microstructureEnabled: config.microstructureEnabled,
    simulatedOrderUsd: config.simulatedOrderUsd, executionLatencyMs: config.executionLatencyMs,
    maxExecutionSlippageBps: config.maxExecutionSlippageBps,
    validationFolds: config.validationFolds, blindHoldoutFraction: config.blindHoldoutFraction,
    conformalAlpha: config.conformalAlpha, maxOodScore: config.maxOodScore,
    challengerMinSamples: config.challengerMinSamples,
    challengerBrierImprovement: config.challengerBrierImprovement,
    eventVetoEnabled: config.eventVetoEnabled,
    configuredAt: '', configuredBy: ''
  };
}

function normalize(value = {}) {
  const base = defaults();
  const number = (key, min, max) => {
    const numeric = Number(value[key] ?? base[key]);
    return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : base[key]));
  };
  const discoverySource = value.discoveryMinutes ?? value.scanMinutes ?? base.discoveryMinutes;
  return {
    ...base, ...value,
    signalsChannelId: String(value.signalsChannelId || ''),
    resultsChannelId: String(value.resultsChannelId || ''),
    logsChannelId: String(value.logsChannelId || ''),
    alertRoleId: String(value.alertRoleId || ''),
    adminRoleId: String(value.adminRoleId || ''),
    coingeckoApiKey: String(value.coingeckoApiKey || ''),
    coingeckoApiTier: ['public', 'demo', 'pro'].includes(String(value.coingeckoApiTier)) ? String(value.coingeckoApiTier) : 'demo',
    monitorMinutes: number('monitorMinutes', 2, 30),
    discoveryMinutes: Math.max(5, Math.min(120, Number(discoverySource) || base.discoveryMinutes)),
    dailyHour: number('dailyHour', 0, 23), dailyMinute: number('dailyMinute', 0, 59),
    minScore: number('minScore', 50, 95), maxSignals: number('maxSignals', 1, 12),
    maxMarketRank: number('maxMarketRank', 20, 1000), minVolumeUsd: number('minVolumeUsd', 100_000, 1_000_000_000),
    broadDiscoveryEnabled: base.broadDiscoveryEnabled && value.broadDiscoveryEnabled !== false,
    venueDiscoveryEnabled: base.venueDiscoveryEnabled && value.venueDiscoveryEnabled !== false,
    venueResearchCandidates: number('venueResearchCandidates', 0, 4),
    minProviderConfirmations: number('minProviderConfirmations', 2, 4),
    maxProviderCandidates: number('maxProviderCandidates', 3, 20),
    minRiskReward: number('minRiskReward', 1.3, 4), accountRiskPct: number('accountRiskPct', 0.1, 1),
    estimatedRoundTripBps: number('estimatedRoundTripBps', 0, 100),
    maxOpenRiskPct: number('maxOpenRiskPct', .1, 10), guardMaxDailyLossR: number('guardMaxDailyLossR', .5, 25),
    maxConcurrentSignals: number('maxConcurrentSignals', 1, 12),
    maxSignalCorrelation: number('maxSignalCorrelation', 0.4, 0.99),
    metaMinSamples: number('metaMinSamples', 80, 100_000), metaRetrainHours: number('metaRetrainHours', 1, 168),
    minMetaProbability: number('minMetaProbability', 0.5, 0.85),
    researchRetentionDays: number('researchRetentionDays', 30, 3650),
    guardRollingWindow: number('guardRollingWindow', 10, 200), guardMinOutcomes: number('guardMinOutcomes', 10, 100),
    guardMaxDrawdownR: number('guardMaxDrawdownR', 1, 25),
    guardMinExpectancyR: number('guardMinExpectancyR', -0.5, 0.5), guardMaxBrier: number('guardMaxBrier', 0.15, 0.5),
    guardLookbackHours: number('guardLookbackHours', 24, 720),
    derivativesEnabled: value.derivativesEnabled ?? base.derivativesEnabled,
    realtimeEnabled: value.realtimeEnabled ?? base.realtimeEnabled,
    microstructureEnabled: value.microstructureEnabled ?? base.microstructureEnabled,
    simulatedOrderUsd: number('simulatedOrderUsd', 100, 1_000_000),
    executionLatencyMs: number('executionLatencyMs', 50, 10_000),
    maxExecutionSlippageBps: number('maxExecutionSlippageBps', 5, 300),
    validationFolds: number('validationFolds', 3, 8),
    blindHoldoutFraction: number('blindHoldoutFraction', 0.1, 0.3),
    conformalAlpha: number('conformalAlpha', 0.05, 0.4), maxOodScore: number('maxOodScore', 2, 10),
    challengerMinSamples: number('challengerMinSamples', 30, 500),
    challengerBrierImprovement: number('challengerBrierImprovement', 0, 0.05),
    eventVetoEnabled: value.eventVetoEnabled ?? base.eventVetoEnabled
  };
}

export async function getGuildSettings(guildId) {
  const store = await readJson(paths.guildSettings(), {});
  return normalize({
    coingeckoApiKey: config.coingeckoApiKey,
    coingeckoApiTier: config.coingeckoApiTier,
    ...(store?.[String(guildId)] || {})
  });
}

export async function updateGuildSettings(guildId, patch) {
  if (!guildId) throw new Error('A Discord server id is required.');
  const store = await readJson(paths.guildSettings(), {});
  store[String(guildId)] = { ...(store[String(guildId)] || {}), ...patch, configuredAt: new Date().toISOString() };
  await writeJson(paths.guildSettings(), store);
  return getGuildSettings(guildId);
}

export async function listConfiguredGuildIds(client) {
  const store = await readJson(paths.guildSettings(), {});
  const saved = Object.entries(store || {})
    .filter(([, value]) => value?.signalsChannelId)
    .map(([guildId]) => guildId);
  if (saved.length) return [...new Set(saved)];
  if (config.guildId) return [config.guildId];
  const guilds = client ? await client.guilds.fetch().catch(() => null) : null;
  return guilds ? [...guilds.keys()] : [];
}

export function maskSecret(value) {
  const text = String(value || '');
  return text ? `${text.slice(0, 4)}...${text.slice(-4)}` : 'not configured';
}
