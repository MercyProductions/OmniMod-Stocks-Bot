import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paperLedgerFingerprint } from './paperStatePath.js';

const BOT_SETUP = {
  stocks: { relativeEnvPath: '../stocks-bot/.env', discordTransport: 'application', required: ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY'],
    modes: [{ key: 'ALPACA_DATA_FEED', value: 'sip', label: 'consolidated SIP feed' }], optional: ['SEC_USER_AGENT', 'FINNHUB_API_KEY', 'FRED_API_KEY'],
    paper: { equityKeys: ['OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'], costs: [
      { key: 'STOCKS_ROUND_TRIP_FEES_PER_SHARE', maxValue: 10, processEnvAliases: ['STOCKS_STOCKS_ROUND_TRIP_FEES_PER_SHARE'] },
      { key: 'STOCKS_ASSUMED_SLIPPAGE_BPS', processEnvAliases: ['STOCKS_STOCKS_ASSUMED_SLIPPAGE_BPS'], defaultValue: 8 },
    ], notes: ['Shared paper reservations require an explicit effective round-trip fee reserve per share, including applicable broker, venue, and regulatory fees. A zero is accepted only when the all-in fee assumption is truly zero.'] } },
  crypto: { relativeEnvPath: '../crypto-bot/.env', discordTransport: 'application', required: [], modes: [],
    optional: ['COINGECKO_API_KEY', 'COINGECKO_API_TIER', 'FINNHUB_API_KEY', 'DEFILLAMA_API_KEY'], publicFallback: true,
    paper: { equityKeys: ['OMNIMOD_PAPER_ACCOUNT_EQUITY_USD'], costs: [
      { key: 'CRYPTO_ROUND_TRIP_FEE_BPS', defaultValue: 20 }, { key: 'CRYPTO_MAX_EXECUTION_SLIPPAGE_BPS', defaultValue: 35 },
    ] } },
  forex: { relativeEnvPath: 'forex/.env', discordTransport: 'application', required: ['OANDA_API_TOKEN', 'OANDA_ACCOUNT_ID', 'PAPER_ACCOUNT_EQUITY_USD'],
    modes: [{ key: 'FOREX_SOURCE', value: 'oanda-practice', label: 'OANDA Practice source' }, { key: 'OANDA_ENV', value: 'practice', label: 'OANDA Practice environment' }], optional: ['FINNHUB_API_KEY'],
    paper: { equityKeys: ['PAPER_ACCOUNT_EQUITY_USD'], costs: [{ key: 'FOREX_ROUND_TRIP_FEES_PER_UNIT' }, { key: 'FOREX_SLIPPAGE_RESERVE_PER_UNIT' }] } },
  futures: { relativeEnvPath: 'futures/.env', discordTransport: 'application', required: ['DATABENTO_API_KEY', 'DATABENTO_DATASET', 'PAPER_ACCOUNT_EQUITY_USD'],
    modes: [{ key: 'FUTURES_DAY_DATA_SOURCE', value: 'databento-live', label: 'Databento Live day feed' },
      { key: 'FUTURES_TREND_DATA_SOURCE', value: 'databento-historical', label: 'Databento Historical trend feed' }],
    positive: ['FUTURES_MAX_SCAN_COST_USD'], optional: ['FINNHUB_API_KEY'],
    paper: { equityKeys: ['PAPER_ACCOUNT_EQUITY_USD'], costs: [{ key: 'FUTURES_ROUND_TRIP_FEES_PER_CONTRACT' }, { key: 'FUTURES_SLIPPAGE_RESERVE_PER_CONTRACT' }] } },
  options: { relativeEnvPath: 'options/.env', discordTransport: 'application', required: ['TRADIER_TOKEN', 'PAPER_ACCOUNT_EQUITY_USD'],
    modes: [{ key: 'OPTIONS_SOURCE', value: 'tradier', label: 'Tradier source' }, { key: 'TRADIER_ENV', value: 'production', label: 'Tradier production data' }], optional: ['FINNHUB_API_KEY'],
    paper: { equityKeys: ['PAPER_ACCOUNT_EQUITY_USD'], costs: [{ key: 'OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP' }, { key: 'OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT' }] } },
  'etfs-etps': { relativeEnvPath: 'etfs-etps/.env', discordTransport: 'application', required: ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY', 'PAPER_ACCOUNT_EQUITY_USD'],
    modes: [{ key: 'ETF_SOURCE', value: 'alpaca', label: 'Alpaca source' }, { key: 'ETF_ALPACA_FEED', value: 'sip', label: 'consolidated SIP feed' }], optional: ['FINNHUB_API_KEY'],
    paper: { equityKeys: ['PAPER_ACCOUNT_EQUITY_USD'], costs: [{ key: 'ETF_ROUND_TRIP_FEES_PER_UNIT' }, { key: 'ETF_SLIPPAGE_RESERVE_PER_UNIT' }] } },
};

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values.set(match[1], value);
  }
  return values;
}

export async function inspectProviderReadiness({ rootDir, processEnv = process.env, ledgerEquityAnchor = null } = {}) {
  const root = resolve(rootDir || dirname(dirname(fileURLToPath(import.meta.url))));
  const bots = {};
  const equityByBot = {};
  const ledgerFingerprintByBot = {};
  for (const [bot, setup] of Object.entries(BOT_SETUP)) {
    const envPath = resolve(root, setup.relativeEnvPath);
    let envText = '';
    let envFilePresent = true;
    try { envText = await readFile(envPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') envFilePresent = false; else throw error; }
    const env = parseEnv(envText);
    // Node's --env-file-if-exists does not overwrite variables already in the
    // process environment. Mirror that precedence in this read-only report.
    const valueOf = (key) => Object.hasOwn(processEnv, key)
      ? String(processEnv[key] ?? '') : (env.get(key) ?? '');
    const sourceOf = (key) => Object.hasOwn(processEnv, key) ? 'process-environment'
      : env.has(key) ? 'bot-env-file' : 'missing';
    const discordTransport = setup.discordTransport || 'webhook';
    const discordTokenConfigured = Boolean(valueOf('DISCORD_TOKEN').trim());
    const discordClientIdConfigured = Boolean(valueOf('DISCORD_CLIENT_ID').trim());
    const discordWebhookConfigured = Boolean(valueOf('DISCORD_WEBHOOK_URL').trim());
    const needsDestination = !['stocks', 'crypto'].includes(bot);
    const discordGuildConfigured = Boolean(valueOf('DISCORD_GUILD_ID').trim());
    const discordChannelConfigured = Boolean(valueOf('DISCORD_CHANNEL_ID').trim());
    const processLedgerOverride = valueOf('TRADING_RISK_STATE_PATH').trim();
    const fileLedgerOverride = env.get('TRADING_RISK_STATE_PATH')?.trim() || '';
    const ledgerSetting = processLedgerOverride || fileLedgerOverride;
    const ledgerSettingSource = processLedgerOverride ? 'process-environment'
      : fileLedgerOverride ? 'bot-env-file' : 'shared-default';
    ledgerFingerprintByBot[bot] = paperLedgerFingerprint(ledgerSetting);
    const missing = setup.required.filter((key) => !valueOf(key).trim());
    const missingModes = setup.modes.filter((mode) => valueOf(mode.key).toLowerCase() !== mode.value).map((mode) => mode.label);
    const missingPositive = (setup.positive || []).filter((key) => !(Number(valueOf(key)) > 0));
    const complete = !missing.length && !missingModes.length && !missingPositive.length;
    const optionalProvidersConfigured = setup.optional.filter((key) => Boolean(valueOf(key).trim()));
    const providerModes = bot === 'crypto' ? (() => {
      const keyConfigured = Boolean(valueOf('COINGECKO_API_KEY').trim());
      const requestedTier = String(valueOf('COINGECKO_API_TIER') || 'demo').trim().toLowerCase();
      const recognizedTier = ['public', 'demo', 'pro'].includes(requestedTier);
      // Match crypto-bot/src/cryptoData.js: missing key or explicit public uses the
      // free endpoint; only a key plus "pro" selects CoinGecko's Pro endpoint.
      const effectiveMode = !keyConfigured || requestedTier === 'public' ? 'public'
        : requestedTier === 'pro' ? 'pro' : 'demo';
      return {
        coinGecko: { keyConfigured, requestedTier, effectiveMode, tierSettingRecognized: recognizedTier },
        freeFallback: { available: true, providers: ['CoinPaprika public API', 'Binance/Coinbase/Kraken public exchange feeds'] },
      };
    })() : undefined;
    const configuredEquityKey = setup.paper?.equityKeys.find((key) => valueOf(key).trim() !== '') || null;
    const configuredEquity = configuredEquityKey ? Number(valueOf(configuredEquityKey)) : null;
    const equityValid = Number.isFinite(configuredEquity) && configuredEquity > 0;
    const equityKey = equityValid ? configuredEquityKey : null;
    equityByBot[bot] = equityValid ? configuredEquity : null;
    const paperCosts = (setup.paper?.costs || []).map(({ key, defaultValue, maxValue, processEnvAliases = [] }) => {
      const runtimeKey = [...processEnvAliases, key].find((candidate) => processEnv[candidate] !== undefined);
      const raw = runtimeKey ? String(processEnv[runtimeKey]) : valueOf(key);
      const fromEnvironment = raw !== undefined && raw.trim() !== '';
      const numeric = fromEnvironment ? Number(raw) : defaultValue;
      const valid = Number.isFinite(numeric) && numeric >= 0 && (maxValue === undefined || numeric <= maxValue);
      return { key, status: !valid ? (fromEnvironment ? 'invalid' : 'missing') : fromEnvironment ? 'environment' : 'runtime-default' };
    });
    const missingPaperCostSettings = paperCosts.filter((row) => ['missing', 'invalid'].includes(row.status)).map((row) => row.key);
    const paperAccountEquityConfigured = Boolean(equityKey);
    bots[bot] = {
      status: setup.publicFallback ? optionalProvidersConfigured.length ? 'public-fallback-plus-optional-provider-configured-unverified' : 'public-fallback-available'
        : complete ? 'configured-unverified' : envFilePresent ? 'incomplete' : 'env-file-missing',
      envFilePresent,
      discord: {
        deliveryMethod: discordTransport,
        tokenConfigured: discordTokenConfigured,
        clientIdConfigured: discordClientIdConfigured,
        guildIdConfigured: discordGuildConfigured,
        channelIdConfigured: discordChannelConfigured,
        destinationRequired: needsDestination,
        webhookConfigured: discordWebhookConfigured,
        status: discordTransport === 'application'
          ? !discordTokenConfigured || !discordClientIdConfigured ? 'missing-application-credentials'
            : needsDestination && (!discordGuildConfigured || !discordChannelConfigured) ? 'missing-application-destination' : 'application-credentials-present-unverified'
          : discordWebhookConfigured ? 'webhook-present-unverified' : 'missing-webhook',
        secretsExposed: false,
      },
      settingSources: Object.fromEntries([...setup.required, ...setup.modes.map((mode) => mode.key), ...(setup.positive || [])]
        .map((key) => [key, sourceOf(key)])),
      missingRequiredKeys: missing,
      missingRequiredModes: missingModes,
      missingPositiveSettings: missingPositive,
      optionalProvidersConfigured,
      ...(providerModes ? { providerModes } : {}),
      paperEquityConfigured: paperAccountEquityConfigured,
      paperEquityKey: equityKey,
      paperEquityStatus: !configuredEquityKey ? 'missing' : equityValid ? 'configured' : 'invalid-positive-dollar-amount-required',
      paperLedgerFingerprint: ledgerFingerprintByBot[bot],
      paperLedgerSettingSource: ledgerSettingSource,
      paperRiskStatus: !paperAccountEquityConfigured ? 'disabled-unconfigured-equity'
        : missingPaperCostSettings.length ? 'incomplete-cost-assumptions' : 'configured-unverified',
      paperCostAssumptions: paperCosts,
      missingPaperCostSettings,
      paperReadinessNotes: setup.paper?.notes || [],
      emergencyStop: valueOf('OMNIMOD_EMERGENCY_STOP').toLowerCase() === 'false' ? 'explicitly-disabled' : 'active-by-default',
      liveTrading: 'disabled-by-code',
      verification: 'credential presence only; authentication, entitlement, data freshness, and provider availability are untested',
    };
  }
  const configuredBotIds = Object.keys(equityByBot).filter((bot) => equityByBot[bot] !== null);
  const invalidBotIds = Object.keys(bots).filter((bot) => bots[bot].paperEquityStatus === 'invalid-positive-dollar-amount-required');
  const missingBotIds = Object.keys(bots).filter((bot) => bots[bot].paperEquityStatus === 'missing');
  const distinctEquityValues = new Set(configuredBotIds.map((bot) => equityByBot[bot]));
  const mismatchedBotIds = distinctEquityValues.size > 1
    ? configuredBotIds.filter((bot) => equityByBot[bot] !== equityByBot[configuredBotIds[0]]) : [];
  const accountEquity = {
    status: invalidBotIds.length ? 'invalid'
      : !configuredBotIds.length ? 'not-configured'
        : missingBotIds.length ? 'partial'
          : distinctEquityValues.size > 1 ? 'mismatch' : 'consistent',
    configuredBotIds, missingBotIds, invalidBotIds, mismatchedBotIds,
    valuesExposed: false,
  };
  const paperEquityAnchor = !ledgerEquityAnchor ? { status: 'not_checked', mismatchedBotIds: [], valuesExposed: false }
    : ['invalid_anchor', 'history_conflict'].includes(ledgerEquityAnchor.status)
      ? { status: 'manual_review_required', source: ledgerEquityAnchor.status, mismatchedBotIds: [], valuesExposed: false }
      : ledgerEquityAnchor.status === 'unanchored'
        ? { status: 'unanchored', mismatchedBotIds: [], valuesExposed: false }
        : !Number.isFinite(Number(ledgerEquityAnchor.value)) || Number(ledgerEquityAnchor.value) <= 0
          ? { status: 'manual_review_required', source: 'invalid_anchor', mismatchedBotIds: [], valuesExposed: false }
          : accountEquity.status !== 'consistent'
            ? { status: accountEquity.status === 'invalid' ? 'configuration_invalid'
              : accountEquity.status === 'mismatch' ? 'configuration_mismatch' : 'configuration_incomplete',
            mismatchedBotIds: accountEquity.mismatchedBotIds, valuesExposed: false }
            : (() => {
              const anchor = Number(ledgerEquityAnchor.value);
              const mismatched = configuredBotIds.filter((bot) => Math.abs(equityByBot[bot] - anchor) > Math.max(0.01, Math.max(equityByBot[bot], anchor) * 1e-9));
              return { status: mismatched.length ? 'mismatch' : 'aligned', mismatchedBotIds: mismatched, valuesExposed: false };
            })();
  const ledgerFingerprints = new Set(Object.values(ledgerFingerprintByBot));
  const paperLedger = {
    status: ledgerFingerprints.size <= 1 ? 'consistent' : 'mismatch',
    configuredBotIds: Object.keys(ledgerFingerprintByBot),
    mismatchedBotIds: ledgerFingerprints.size <= 1 ? [] : Object.keys(ledgerFingerprintByBot)
      .filter((bot) => ledgerFingerprintByBot[bot] !== ledgerFingerprintByBot[Object.keys(ledgerFingerprintByBot)[0]]),
    fingerprintsExposed: true,
    scope: 'effective path derived from each bot .env file and the operator process environment; does not prove active worker configuration or cross-host filesystem sharing',
  };
  return { scope: 'local .env key presence only; secret values are never returned', accountEquity, paperEquityAnchor, paperLedger, bots };
}
