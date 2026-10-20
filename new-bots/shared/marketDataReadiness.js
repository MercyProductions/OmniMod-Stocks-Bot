import { providerProfile, missingProviderCredentials } from './providerProfiles.js';

/** Readiness is reported separately from strategy outcomes; zero API errors can mean no API calls. */
export function assessMarketDataReadiness(bot, { env = process.env, observedRows = 0, providerRequests = 0,
  providerFailures = 0, inputCount = null, marketOpen = null, discoveryStatus = null, underlyingDiscovery = null } = {}) {
  const value = (key, fallback) => String(env[key] || fallback).toLowerCase();
  let profile, manual = false, researchOnly = false;
  if (bot === 'forex') { profile = providerProfile(bot, 'free'); manual = value('FOREX_SOURCE', 'disabled') !== 'oanda-practice'; }
  else if (bot === 'options') {
    manual = value('OPTIONS_SOURCE', 'manual') !== 'tradier';
    researchOnly = value('TRADIER_ENV', 'sandbox') !== 'production';
    profile = providerProfile(bot, researchOnly ? 'free' : 'broker-data');
  } else if (bot === 'etfs-etps') {
    manual = value('ETF_SOURCE', 'fixture') !== 'alpaca';
    researchOnly = value('ETF_ALPACA_FEED', 'iex') !== 'sip';
    profile = providerProfile(bot, researchOnly ? 'free' : 'paid');
    if (value('ETF_ALPACA_FEED', 'iex') === 'delayed_sip') profile.quality = 'delayed consolidated research only';
  } else if (bot === 'futures') {
    profile = providerProfile(bot, 'paid');
    manual = value('FUTURES_DAY_DATA_SOURCE', 'manual') !== 'databento-live';
  } else throw new Error('Readiness requires a market runner with measured scan evidence.');
  const missing = missingProviderCredentials(profile, env);
  const evidence = { observedRows, providerRequests, providerFailures, inputCount };
  const result = (status, label, detail, nextStep, automatedScanRan = false) => ({
    status, label, detail, nextStep, automatedScanRan, evidence, missingCredentialNames: missing,
    quality: profile.quality, profile: profile.profile,
  });
  if (bot === 'options' && (manual || inputCount === 0) && underlyingDiscovery?.cheapScreen?.cheaplyScreened > 0) {
    return { ...result('research_only', 'Independent underlying research',
      'Current underlying snapshots were screened independently. Contract-inventory coverage is reported separately. No independent option-chain strategy or paper-entry approval ran.',
      'Inspect underlying/contract coverage and rejections; independent strategy and forward validation remain pending.', true),
      quality: underlyingDiscovery.feedQuality, evidence: { ...evidence, independentUniverse: underlyingDiscovery.eligibleInstruments,
        independentSnapshots: underlyingDiscovery.cheapScreen.cheaplyScreened } };
  }
  if (manual) return result('not_configured', bot === 'forex' ? 'Market scanner disabled' : 'Manual / fixture mode',
    'No automated current-market scan ran. Zero results here do not mean the market has no opportunities.',
    bot === 'futures' ? 'Connect an entitled active-contract feed and reviewed contract inputs. A permanent free live adapter is not integrated.'
      : 'Configure a supported data profile and its local credentials; see DATA_PROVIDER_SETUP.md.');
  if (missing.length) return result('credentials_missing', 'Data connection incomplete', 'No authenticated market coverage has been verified.',
    'Set these names in the local .env: ' + missing.join(', ') + '.');
  if (discoveryStatus === 'provider_error' || (providerRequests > 0 && providerFailures >= providerRequests))
    return result('provider_error', 'Market-data request failed', 'This is an incomplete scan, not an empty opportunity list.',
      'Inspect provider errors, authentication, entitlement and rate-limit diagnostics.');
  if ((bot === 'options' || bot === 'futures') && inputCount === 0) return result('inputs_missing',
    bot === 'options' ? 'Waiting for underlying candidates' : 'Waiting for active-contract inputs',
    bot === 'options' ? 'No production option-chain strategy scan ran because no usable underlying signals were supplied. Independent underlying research coverage is reported separately.'
      : 'Context symbols are not active day-trading contracts. No contract strategy scan ran.',
    bot === 'options' ? 'Verify the Stocks/ETF signal source and required reviews.' : 'Discover and review active contracts, session boundaries and margin data.');
  if (marketOpen === false) return result('market_closed', 'Market session closed', 'No new session entries were evaluated.',
    'Wait for the next eligible session; position monitoring remains separate.');
  if (observedRows > 0) return result(providerFailures > 0 ? 'partial_data' : researchOnly ? 'research_only' : 'data_observed',
    providerFailures > 0 ? 'Partial market data' : researchOnly ? 'Research feed · restricted coverage' : 'Market data observed',
    researchOnly ? 'This feed has limited or delayed/reference coverage. Current executable-entry requirements remain unchanged.'
      : 'Measured data reached this scan. This does not prove full-market coverage or strategy profitability.',
    researchOnly ? 'Use the optional entitled feed for consolidated/executable quotes; inspect the full funnel.' : 'Use the funnel to separate coverage, strategy and risk rejections.', true);
  return result('no_usable_data', 'No usable market inputs', 'No usable strategy inputs were measured. Zero setups do not establish that the market was fully scanned.',
    'Inspect the universe, feed entitlement, freshness and upstream filter diagnostics.');
}
