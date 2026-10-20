import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaperLedgerPath } from '../../new-bots/shared/paperStatePath.js';
import { parse } from 'dotenv';
import { paperMonitorProfile } from '../../new-bots/shared/paperMonitorConfig.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');
export const legacyDataDir = path.join(projectRoot, 'data');
const localEnvPath = path.join(projectRoot, '.env');
const localEnv = fs.existsSync(localEnvPath)
  ? parse(fs.readFileSync(localEnvPath))
  : {};
const defaultDataDir = process.platform === 'win32'
  ? legacyDataDir
  : path.join(os.homedir(), '.omnimod-stocks-data');

function envValue(name, prefixedName = `STOCKS_${name}`) {
  return process.env[prefixedName] ?? localEnv[name] ?? process.env[name];
}

function numberEnv(name, fallback, min, max) {
  const raw = envValue(name);
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function boolEnv(name, fallback) {
  const value = String(envValue(name) ?? '').trim().toLowerCase();
  return value ? ['1', 'true', 'yes', 'on'].includes(value) : fallback;
}

function choiceEnv(name, fallback, choices) {
  const value = String(envValue(name) || fallback).trim().toLowerCase();
  return choices.includes(value) ? value : fallback;
}

function optionalNonNegativeEnv(name, maximum) {
  const raw = envValue(name);
  if (raw === undefined || raw === null || String(raw).trim() === '') return Number.NaN;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= maximum ? value : Number.NaN;
}

const sharedPaperRoundTripFeesPerShare = optionalNonNegativeEnv('STOCKS_ROUND_TRIP_FEES_PER_SHARE', 10);

export const dataDir = path.resolve(
  process.env.OMNIMOD_STOCKS_DATA_DIR
  || localEnv.OMNIMOD_STOCKS_DATA_DIR
  || defaultDataDir
);

export const config = Object.freeze({
  paperMonitor: paperMonitorProfile({ PAPER_MONITOR_INTERVAL_SECONDS: envValue('PAPER_MONITOR_INTERVAL_SECONDS') ?? 0 }, 'stocks'),
  discordToken: String(envValue('DISCORD_TOKEN') || '').trim(),
  clientId: String(envValue('DISCORD_CLIENT_ID') || '').trim(),
  guildId: String(envValue('DISCORD_GUILD_ID') || '').trim(),
  port: numberEnv('PORT', 3001, 1, 65535),
  timezone: String(envValue('TIMEZONE') || 'America/Chicago').trim(),
  marketTimezone: 'America/New_York',
  monitorMinutes: numberEnv('STOCKS_MONITOR_MINUTES', 5, 2, 30),
  discoveryMinutes: numberEnv('STOCKS_DISCOVERY_MINUTES', 15, 5, 120),
  dynamicDiscovery: boolEnv('STOCKS_DYNAMIC_DISCOVERY', true),
  dynamicDiscoveryMaxSymbols: numberEnv('STOCKS_DYNAMIC_DISCOVERY_MAX_SYMBOLS', 15, 1, 30),
  dynamicDiscoveryCacheMinutes: numberEnv('STOCKS_DYNAMIC_DISCOVERY_CACHE_MINUTES', 15, 5, 120),
  dailyHour: numberEnv('STOCKS_DAILY_HOUR', 8, 0, 23),
  dailyMinute: numberEnv('STOCKS_DAILY_MINUTE', 30, 0, 59),
  minScore: numberEnv('STOCKS_MIN_SCORE', 68, 45, 95),
  maxSignals: numberEnv('STOCKS_MAX_SIGNALS', 5, 1, 12),
  minPrice: numberEnv('STOCKS_MIN_PRICE', 2, 0.1, 1000),
  minAverageVolume: numberEnv('STOCKS_MIN_AVERAGE_VOLUME', 500000, 10000, 1000000000),
  minDataQuality: numberEnv('STOCKS_MIN_DATA_QUALITY', 60, 30, 95),
  confirmationScans: numberEnv('STOCKS_CONFIRMATION_SCANS', 2, 1, 5),
  earningsBlackoutDays: numberEnv('STOCKS_EARNINGS_BLACKOUT_DAYS', 2, 0, 14),
  dailyCacheHours: numberEnv('STOCKS_DAILY_CACHE_HOURS', 8, 1, 24),
  assumedSlippageBps: numberEnv('STOCKS_ASSUMED_SLIPPAGE_BPS', 8, 0, 100),
  configSecret: String(envValue('STOCKS_CONFIG_SECRET', 'STOCKS_CONFIG_SECRET') || '').trim(),
  alphaVantageKey: String(envValue('ALPHA_VANTAGE_API_KEY') || '').trim(),
  finnhubKey: String(envValue('FINNHUB_API_KEY') || '').trim(),
  polygonKey: String(envValue('POLYGON_API_KEY') || '').trim(),
  alpacaKeyId: String(envValue('ALPACA_API_KEY_ID') || '').trim(),
  alpacaSecretKey: String(envValue('ALPACA_API_SECRET_KEY') || '').trim(),
  alpacaNewsEnabled: boolEnv('ALPACA_NEWS_ENABLED', false),
  alpacaDataFeed: choiceEnv('ALPACA_DATA_FEED', 'iex', ['iex', 'sip', 'delayed_sip']),
  alpacaStreamEnabled: boolEnv('ALPACA_STREAM_ENABLED', true),
  alpacaStreamMaxSymbols: numberEnv('ALPACA_STREAM_MAX_SYMBOLS', 30, 1, 1000),
  maxSpreadBps: numberEnv('STOCKS_MAX_SPREAD_BPS', 35, 5, 500),
  researchRetentionDays: numberEnv('STOCKS_RESEARCH_RETENTION_DAYS', 730, 30, 3650),
  modelMinSamples: numberEnv('STOCKS_MODEL_MIN_SAMPLES', 80, 40, 10000),
  modelMinHoldout: numberEnv('STOCKS_MODEL_MIN_HOLDOUT', 20, 10, 1000),
  ensembleBuyProbability: numberEnv('STOCKS_ENSEMBLE_BUY_PROBABILITY', 62, 50, 95) / 100,
  ensembleWatchProbability: numberEnv('STOCKS_ENSEMBLE_WATCH_PROBABILITY', 54, 45, 90) / 100,
  modelAutoTrain: boolEnv('STOCKS_MODEL_AUTO_TRAIN', true),
  allowRuleOnlySignals: boolEnv('STOCKS_ALLOW_RULE_ONLY_SIGNALS', false),
  researchModelMinSamples: numberEnv('STOCKS_RESEARCH_MODEL_MIN_SAMPLES', 240, 100, 1000000),
  expertMinSamples: numberEnv('STOCKS_EXPERT_MIN_SAMPLES', 120, 60, 1000000),
  modelEmbargoMinutes: numberEnv('STOCKS_MODEL_EMBARGO_MINUTES', 240, 30, 1440),
  modelLookbackDays: numberEnv('STOCKS_MODEL_LOOKBACK_DAYS', 365, 30, 1460),
  labelLookbackDays: numberEnv('STOCKS_LABEL_LOOKBACK_DAYS', 14, 3, 3650),
  counterfactualSlippageBps: numberEnv('STOCKS_COUNTERFACTUAL_SLIPPAGE_BPS', 10, 0, 200),
  bootstrapSamples: numberEnv('STOCKS_BOOTSTRAP_SAMPLES', 300, 50, 5000),
  maxSectorSignals: numberEnv('STOCKS_MAX_SECTOR_SIGNALS', 2, 1, 12),
  maxOpenPositions: numberEnv('STOCKS_MAX_OPEN_POSITIONS', 3, 1, 12),
  maxOpenRiskR: numberEnv('STOCKS_MAX_OPEN_RISK_R', 2, 0.25, 12),
  executionStressBps: numberEnv('STOCKS_EXECUTION_STRESS_BPS', 10, 0, 200),
  investmentDailyResearch: boolEnv('STOCKS_INVESTMENT_DAILY_RESEARCH', true),
  sharedPaperAccountEquity: numberEnv('OMNIMOD_PAPER_ACCOUNT_EQUITY_USD', 0, 0, 1_000_000_000),
  sharedPaperStatePath: resolvePaperLedgerPath(envValue('TRADING_RISK_STATE_PATH') || ''),
  sharedPaperRoundTripFeesPerShare,
  sharedPaperCostAssumptionsConfigured: Number.isFinite(sharedPaperRoundTripFeesPerShare) && sharedPaperRoundTripFeesPerShare >= 0,
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
  maxPairCorrelation: numberEnv('STOCKS_MAX_PAIR_CORRELATION', 85, 20, 99) / 100,
  dailyLossLimitR: numberEnv('STOCKS_DAILY_LOSS_LIMIT_R', 3, 0.5, 20),
  consecutiveLossLimit: numberEnv('STOCKS_CONSECUTIVE_LOSS_LIMIT', 3, 1, 20),
  minPortfolioExpectedR: numberEnv('STOCKS_MIN_PORTFOLIO_EXPECTED_R', 0.05, -1, 5),
  secUserAgent: String(envValue('SEC_USER_AGENT') || '').trim(),
  fredApiKey: String(envValue('FRED_API_KEY') || '').trim(),
  eventCacheMinutes: numberEnv('STOCKS_EVENT_CACHE_MINUTES', 60, 5, 1440),
  secFilingBlackoutHours: numberEnv('STOCKS_SEC_FILING_BLACKOUT_HOURS', 4, 0, 168),
  corporateActionBlackoutDays: numberEnv('STOCKS_CORPORATE_ACTION_BLACKOUT_DAYS', 2, 0, 30),
  postOnStart: boolEnv('POST_ON_START', true),
  autoProvision: boolEnv('STOCKS_AUTO_PROVISION', false)
});

export function requireRuntimeConfig() {
  const missing = [];
  if (!config.discordToken) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}
