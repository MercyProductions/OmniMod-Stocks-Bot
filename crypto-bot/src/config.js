import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaperLedgerPath } from '../../new-bots/shared/paperStatePath.js';
import { paperMonitorProfile } from '../../new-bots/shared/paperMonitorConfig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const legacyDataDir = path.join(projectRoot, 'data');
const defaultDataDir = process.platform === 'win32'
  ? legacyDataDir
  : path.join(os.homedir(), '.omnimod-crypto-data');

function numberEnv(name, fallback, min, max) {
  if (process.env[name] == null || String(process.env[name]).trim() === '') return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function boolEnv(name, fallback) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

export const dataDir = path.resolve(process.env.OMNIMOD_CRYPTO_DATA_DIR || defaultDataDir);
export { legacyDataDir, projectRoot };

export const config = Object.freeze({
  paperMonitor: paperMonitorProfile(process.env, 'crypto'),
  discordToken: String(process.env.DISCORD_TOKEN || '').trim(),
  clientId: String(process.env.DISCORD_CLIENT_ID || '').trim(),
  guildId: String(process.env.DISCORD_GUILD_ID || '').trim(),
  port: numberEnv('PORT', 3000, 1, 65535),
  timezone: String(process.env.TIMEZONE || 'America/Chicago').trim(),
  monitorMinutes: numberEnv('CRYPTO_MONITOR_MINUTES', 5, 2, 30),
  discoveryMinutes: numberEnv('CRYPTO_DISCOVERY_MINUTES', numberEnv('CRYPTO_SCAN_MINUTES', 15, 5, 120), 5, 120),
  dailyHour: numberEnv('CRYPTO_DAILY_HOUR', 7, 0, 23),
  dailyMinute: numberEnv('CRYPTO_DAILY_MINUTE', 0, 0, 59),
  minScore: numberEnv('CRYPTO_MIN_SCORE', 64, 50, 95),
  maxSignals: numberEnv('CRYPTO_MAX_SIGNALS', 5, 1, 12),
  maxMarketRank: numberEnv('CRYPTO_MAX_MARKET_RANK', 250, 20, 1000),
  broadDiscoveryEnabled: boolEnv('CRYPTO_BROAD_DISCOVERY_ENABLED', true),
  venueDiscoveryEnabled: boolEnv('CRYPTO_VENUE_DISCOVERY_ENABLED', true),
  venueResearchCandidates: numberEnv('CRYPTO_VENUE_RESEARCH_CANDIDATES', 2, 0, 4),
  minVolumeUsd: numberEnv('CRYPTO_MIN_VOLUME_USD', 5_000_000, 100_000, 1_000_000_000),
  minProviderConfirmations: numberEnv('CRYPTO_MIN_PROVIDER_CONFIRMATIONS', 2, 2, 4),
  maxDiscoveryAssetAgeMinutes: numberEnv('CRYPTO_MAX_DISCOVERY_ASSET_AGE_MINUTES', 30, 1, 240),
  maxProviderCandidates: numberEnv('CRYPTO_MAX_PROVIDER_CANDIDATES', 8, 3, 20),
  minRiskReward: numberEnv('CRYPTO_MIN_RISK_REWARD', 1.7, 1.3, 4),
  accountRiskPct: numberEnv('CRYPTO_ACCOUNT_RISK_PCT', 0.5, 0.1, 1),
  estimatedRoundTripBps: numberEnv('CRYPTO_ROUND_TRIP_FEE_BPS', 20, 0, 100),
  maxOpenRiskPct: numberEnv('CRYPTO_MAX_OPEN_RISK_PCT', 1.5, .1, 10),
  guardMaxDailyLossR: numberEnv('CRYPTO_GUARD_MAX_DAILY_LOSS_R', 3, .5, 25),
  maxConcurrentSignals: numberEnv('CRYPTO_MAX_CONCURRENT_SIGNALS', 3, 1, 12),
  maxSignalCorrelation: numberEnv('CRYPTO_MAX_SIGNAL_CORRELATION', 0.82, 0.4, 0.99),
  metaMinSamples: numberEnv('CRYPTO_META_MIN_SAMPLES', 200, 80, 100_000),
  metaRetrainHours: numberEnv('CRYPTO_META_RETRAIN_HOURS', 24, 1, 168),
  minMetaProbability: numberEnv('CRYPTO_MIN_META_PROBABILITY', 0.56, 0.5, 0.85),
  researchRetentionDays: numberEnv('CRYPTO_RESEARCH_RETENTION_DAYS', 730, 30, 3650),
  guardRollingWindow: numberEnv('CRYPTO_GUARD_ROLLING_WINDOW', 30, 10, 200),
  guardMinOutcomes: numberEnv('CRYPTO_GUARD_MIN_OUTCOMES', 20, 10, 100),
  guardMaxDrawdownR: numberEnv('CRYPTO_GUARD_MAX_DRAWDOWN_R', 5, 1, 25),
  guardMinExpectancyR: numberEnv('CRYPTO_GUARD_MIN_EXPECTANCY_R', 0, -0.5, 0.5),
  guardMaxBrier: numberEnv('CRYPTO_GUARD_MAX_BRIER', 0.28, 0.15, 0.5),
  guardLookbackHours: numberEnv('CRYPTO_GUARD_LOOKBACK_HOURS', 168, 24, 720),
  derivativesEnabled: boolEnv('CRYPTO_DERIVATIVES_ENABLED', true),
  realtimeEnabled: boolEnv('CRYPTO_REALTIME_ENABLED', true),
  microstructureEnabled: boolEnv('CRYPTO_MICROSTRUCTURE_ENABLED', true),
  microstructureFlushSeconds: numberEnv('CRYPTO_MICROSTRUCTURE_FLUSH_SECONDS', 300, 30, 900),
  simulatedOrderUsd: numberEnv('CRYPTO_SIMULATED_ORDER_USD', 1000, 100, 1_000_000),
  executionLatencyMs: numberEnv('CRYPTO_EXECUTION_LATENCY_MS', 750, 50, 10_000),
  maxExecutionSlippageBps: numberEnv('CRYPTO_MAX_EXECUTION_SLIPPAGE_BPS', 35, 5, 300),
  sharedPaperAccountEquity: numberEnv('OMNIMOD_PAPER_ACCOUNT_EQUITY_USD', 0, 0, 1_000_000_000),
  sharedPaperStatePath: resolvePaperLedgerPath(process.env.TRADING_RISK_STATE_PATH || ''),
  sharedPaperEmergencyStop: boolEnv('OMNIMOD_EMERGENCY_STOP', true),
  sharedPaperMaxQuoteAgeMs: numberEnv('SHARED_MAX_QUOTE_AGE_MS', 15000, 1000, 120000),
  sharedPaperMaxOpenMarkAgeMs: numberEnv('SHARED_MAX_OPEN_MARK_AGE_MS', 300000, 1000, 86400000),
  sharedPaperMaxOpenPositions: numberEnv('SHARED_MAX_OPEN_POSITIONS', 5, 1, 30),
  sharedPaperMaxTradeRiskPct: numberEnv('SHARED_MAX_TRADE_RISK_PCT', 0.25, 0.01, 2),
  sharedPaperMaxTotalOpenRiskPct: numberEnv('SHARED_MAX_TOTAL_OPEN_RISK_PCT', 1, 0.1, 10),
  sharedPaperMaxGrossExposurePct: numberEnv('SHARED_MAX_GROSS_EXPOSURE_PCT', 150, 10, 1000),
  sharedPaperMaxDailyLossPct: numberEnv('SHARED_MAX_DAILY_LOSS_PCT', 1, 0.1, 10),
  sharedPaperMaxSpreadPct: numberEnv('SHARED_MAX_SPREAD_PCT', 0.5, 0.01, 5),
  sharedPaperMinRewardRisk: numberEnv('SHARED_MIN_REWARD_RISK', 1.25, 0.5, 10),
  validationFolds: numberEnv('CRYPTO_VALIDATION_FOLDS', 4, 3, 8),
  blindHoldoutFraction: numberEnv('CRYPTO_BLIND_HOLDOUT_FRACTION', 0.15, 0.1, 0.3),
  conformalAlpha: numberEnv('CRYPTO_CONFORMAL_ALPHA', 0.2, 0.05, 0.4),
  maxOodScore: numberEnv('CRYPTO_MAX_OOD_SCORE', 4, 2, 10),
  challengerMinSamples: numberEnv('CRYPTO_CHALLENGER_MIN_SAMPLES', 50, 30, 500),
  challengerBrierImprovement: numberEnv('CRYPTO_CHALLENGER_BRIER_IMPROVEMENT', 0.005, 0, 0.05),
  eventVetoEnabled: boolEnv('CRYPTO_EVENT_VETO_ENABLED', true),
  catalystSource: String(process.env.CRYPTO_CATALYST_SOURCE || 'manual').trim().toLowerCase(),
  finnhubApiKey: String(process.env.FINNHUB_API_KEY || '').trim(),
  historicalImportDir: String(process.env.CRYPTO_HISTORICAL_IMPORT_DIR || '').trim(),
  coingeckoApiKey: String(process.env.COINGECKO_API_KEY || '').trim(),
  coingeckoApiTier: String(process.env.COINGECKO_API_TIER || 'demo').trim().toLowerCase(),
  defillamaApiKey: String(process.env.DEFILLAMA_API_KEY || '').trim(),
  defillamaHacksEnabled: boolEnv('DEFILLAMA_HACKS_ENABLED', false),
  githubToken: String(process.env.GITHUB_TOKEN || '').trim(),
  postOnStart: boolEnv('POST_ON_START', true),
  autoProvision: boolEnv('CRYPTO_AUTO_PROVISION', false)
});

export function requireRuntimeConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}
