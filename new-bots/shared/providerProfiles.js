/** Supported adapters only. A profile configures data access; it never approves a trade. */
const alpaca = ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY'];
export const PROVIDER_PROFILES = {
  stocks: {
    free: { settings: { ALPACA_DATA_FEED: 'iex', STOCKS_DYNAMIC_DISCOVERY: 'true' }, credentials: alpaca,
      label: 'Alpaca Basic / IEX plus existing public research sources', quality: 'single-venue research',
      limitations: ['Free account/API keys required for Alpaca.', 'IEX is not the consolidated US market; existing execution gates remain.', 'Dynamic deep analysis remains capped; broad listing membership does not mean every stock was analyzed.'] },
    paid: { settings: { ALPACA_DATA_FEED: 'sip', STOCKS_DYNAMIC_DISCOVERY: 'true' }, credentials: alpaca,
      label: 'Alpaca consolidated SIP', quality: 'entitlement-dependent consolidated feed',
      limitations: ['SIP subscription/entitlement must already exist; this profile does not purchase it.', 'Model, catalyst, strategy and portfolio checks still apply.'] },
  },
  crypto: {
    free: { settings: { COINGECKO_API_TIER: 'public', CRYPTO_BROAD_DISCOVERY_ENABLED: 'true', CRYPTO_VENUE_DISCOVERY_ENABLED: 'true' },
      credentials: [], label: 'CoinGecko public plus public exchange data', quality: 'public research feeds',
      limitations: ['Public rate limits and regional endpoint availability constrain coverage.', 'Whole-venue research and the legacy production ranking pool remain separate.'] },
    demo: { settings: { COINGECKO_API_TIER: 'demo', CRYPTO_BROAD_DISCOVERY_ENABLED: 'true', CRYPTO_VENUE_DISCOVERY_ENABLED: 'true' },
      credentials: ['COINGECKO_API_KEY'], label: 'CoinGecko Demo plus public exchanges', quality: 'free-key research feeds',
      limitations: ['Requires a free Demo key; monthly call budgets still apply.'] },
    paid: { settings: { COINGECKO_API_TIER: 'pro', CRYPTO_BROAD_DISCOVERY_ENABLED: 'true', CRYPTO_VENUE_DISCOVERY_ENABLED: 'true' },
      credentials: ['COINGECKO_API_KEY'], label: 'CoinGecko Pro plus public exchanges', quality: 'paid research feeds',
      limitations: ['Requires an existing Pro key/subscription.', 'Paid metadata does not establish executable prices or profitable signals.'] },
  },
  forex: {
    free: { settings: { FOREX_SOURCE: 'oanda-practice', OANDA_ENV: 'practice', FOREX_DYNAMIC_DISCOVERY: 'true' },
      credentials: ['OANDA_ACCOUNT_ID', 'OANDA_API_TOKEN'], label: 'OANDA v20 practice', quality: 'practice bid/ask and history',
      limitations: ['Free eligible practice account required; division availability varies.', 'Fresh catalyst review, USD cost assumptions and paper equity remain required.'] },
    'paid-calendar': { settings: { FOREX_SOURCE: 'oanda-practice', OANDA_ENV: 'practice', FOREX_DYNAMIC_DISCOVERY: 'true', FOREX_CATALYST_SOURCE: 'finnhub' },
      credentials: ['OANDA_ACCOUNT_ID', 'OANDA_API_TOKEN', 'FINNHUB_API_KEY'], label: 'OANDA practice plus Finnhub calendar', quality: 'practice quotes; optional paid event feed',
      limitations: ['Finnhub Economic Calendar entitlement must already exist.', 'This adds scheduled-event coverage, not a new execution feed.'] },
  },
  futures: {
    free: { supported: false, settings: {}, credentials: [], label: 'No integrated permanent free live contract feed',
      quality: 'offline research only',
      limitations: ['Existing manual/continuous context is not a live futures market scan.', 'Trial credits are not a permanent free feed; no proxy is substituted for an active contract.'] },
    paid: { settings: { FUTURES_SOURCE: 'databento', FUTURES_DAY_DATA_SOURCE: 'databento-live',
      FUTURES_POSITION_MARK_SOURCE: 'databento-live', FUTURES_TREND_DATA_SOURCE: 'databento-historical',
      FUTURES_CONTRACT_DISCOVERY_ENABLED: 'true', FUTURES_CONTRACT_DISCOVERY_SCOPE: 'dataset',
      FUTURES_ACTIVITY_DISCOVERY_ENABLED: 'true' }, credentials: ['DATABENTO_API_KEY'],
      label: 'Databento licensed active-contract feed', quality: 'licensed live quotes plus historical bars',
      limitations: ['Dataset/exchange licensing and an explicit positive per-scan cost cap are required.', 'Reviewed active contracts, session boundaries, margins, catalysts and costs remain required.', 'Dataset-wide historical definitions are reference discovery only; broad live screening and account-backed coverage remain unverified.'] },
  },
  options: {
    free: { settings: { OPTIONS_SOURCE: 'tradier', TRADIER_ENV: 'sandbox', OPTIONS_SIGNAL_SOURCE: 'shared' },
      credentials: ['TRADIER_TOKEN'], label: 'Tradier sandbox', quality: '15-minute delayed research only',
      limitations: ['Eligible account/token required. Delayed prices cannot approve current entries or realistic live fills.', 'Production signals still come from Stocks/ETFs. Add a discovery profile for independent underlying and bounded contract research.'] },
    'broker-data': { settings: { OPTIONS_SOURCE: 'tradier', TRADIER_ENV: 'production', OPTIONS_SIGNAL_SOURCE: 'shared' },
      credentials: ['TRADIER_TOKEN'], label: 'Tradier Brokerage real-time market data', quality: 'account-entitled stock/option quotes',
      limitations: ['Requires eligible Brokerage access and appropriate data-use rights; no broker orders are submitted.', 'Underlying signals, catalyst/dividend reviews, synchronized quotes and liquidity checks remain required.'] },
    'discovery-free': { settings: { OPTIONS_DISCOVERY_SOURCE: 'alpaca', OPTIONS_DISCOVERY_FEED: 'iex' },
      credentials: alpaca, label: 'Independent Alpaca optionable-underlying discovery / IEX', quality: 'single-venue underlying research',
      limitations: ['Free eligible Alpaca account/API keys required. This supplements the Tradier profile; it does not configure option-chain data.',
        'All eligible flagged underlyings are screened before a research shortlist cap. Flags can refer to expired options.',
        'With a Tradier token, the independent shortlist supports bounded expiration/contract inventories. Technical strategy approval and forward outcomes remain pending. No shortlisted row becomes an approved setup.'] },
    'discovery-paid': { settings: { OPTIONS_DISCOVERY_SOURCE: 'alpaca', OPTIONS_DISCOVERY_FEED: 'sip' },
      credentials: alpaca, label: 'Independent Alpaca optionable-underlying discovery / SIP', quality: 'consolidated underlying research',
      limitations: ['Existing SIP entitlement required. This does not purchase data or configure option-chain access.',
        'This changes coverage research only; current option approval and risk gates remain.'] },
  },
  'etfs-etps': {
    free: { settings: { ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'iex', ETF_DISCOVERY_MODE: 'full-market' }, credentials: alpaca,
      label: 'Alpaca Basic / IEX', quality: 'single-venue research only',
      limitations: ['Free account/API keys required. Existing paper-entry/position-mark gates require SIP.', 'Listing discovery is broad; the 200-candidate deep-analysis budget and wrapper classification checks remain.'] },
    paid: { settings: { ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'sip', ETF_DISCOVERY_MODE: 'full-market' }, credentials: alpaca,
      label: 'Alpaca consolidated SIP', quality: 'entitlement-dependent consolidated quotes',
      limitations: ['Requires an existing SIP entitlement.', 'Costs, paper equity, catalyst and ETF/ETP classification gates remain required.'] },
  },
};

export function providerProfile(bot, profile) {
  const item = PROVIDER_PROFILES[bot]?.[profile];
  if (!item) throw new Error('Unknown bot/profile. Use --list for supported choices.');
  return { bot, profile, supported: item.supported !== false, ...structuredClone(item) };
}

export function missingProviderCredentials(profile, env = {}) {
  return profile.credentials.filter((key) => {
    const alias = key === 'ALPACA_API_KEY_ID' ? env.APCA_API_KEY_ID : key === 'ALPACA_API_SECRET_KEY' ? env.APCA_API_SECRET_KEY : '';
    return !(String(env[key] ?? '').trim() || String(alias ?? '').trim());
  });
}

/** Updates only known data selectors, preserving credentials, risk settings and unrelated text. */
export function renderProviderConfiguration(text, profile) {
  if (!profile.supported) throw new Error('This profile has no integrated live data adapter.');
  const keys = new Set(Object.keys(profile.settings));
  const lines = String(text).split(/\r?\n/).filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    return !match || !keys.has(match[1]);
  });
  return lines.join('\n').trimEnd() + '\n\n# Selected market-data profile: ' + profile.bot + '/' + profile.profile + '\n'
    + Object.entries(profile.settings).map(([key, value]) => key + '=' + value).join('\n') + '\n';
}
