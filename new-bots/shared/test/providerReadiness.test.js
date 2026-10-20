import test from 'node:test';
import assert from 'node:assert/strict';
import { providerProfile, missingProviderCredentials, renderProviderConfiguration, PROVIDER_PROFILES } from '../providerProfiles.js';
import { assessMarketDataReadiness } from '../marketDataReadiness.js';
import { buildDayTradingBrief, discordEmbedPayload } from '../discordPresentation.js';

test('unconfigured/manual scans do not imply the market contains zero opportunities', () => {
  for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
    const readiness = assessMarketDataReadiness(bot, { env: {}, observedRows: bot === 'futures' ? 36 : 0 });
    assert.equal(readiness.status, 'not_configured');
    assert.equal(readiness.automatedScanRan, false);
    const payload = buildDayTradingBrief({ bot, readiness, coverage: '0 provider failures', source: 'manual', emergencyStop: true });
    assert.match(JSON.stringify(payload), /Scanner status/);
    assert.match(JSON.stringify(payload), /No automated current-market scan ran/);
    assert.doesNotMatch(JSON.stringify(payload), /No candidate passed|Research continues/);
    assert.equal(payload.embeds[0].color, 0xf59e0b);
  }
});

test('credential, upstream input, provider failure and closed-session states remain distinct', () => {
  assert.equal(assessMarketDataReadiness('forex', { env: { FOREX_SOURCE: 'oanda-practice' } }).status, 'credentials_missing');
  const forexEnv = { FOREX_SOURCE: 'oanda-practice', OANDA_ACCOUNT_ID: 'fixture-id', OANDA_API_TOKEN: 'fixture-secret' };
  assert.equal(assessMarketDataReadiness('forex', { env: forexEnv, discoveryStatus: 'provider_error' }).status, 'provider_error');
  assert.equal(assessMarketDataReadiness('forex', { env: forexEnv, marketOpen: false }).status, 'market_closed');
  assert.equal(assessMarketDataReadiness('forex', { env: forexEnv }).status, 'no_usable_data');
  assert.equal(assessMarketDataReadiness('options', { env: { OPTIONS_SOURCE: 'tradier', TRADIER_TOKEN: 'fixture' }, inputCount: 0 }).status, 'inputs_missing');
  const future = assessMarketDataReadiness('futures', { env: { FUTURES_DAY_DATA_SOURCE: 'databento-live', DATABENTO_API_KEY: 'fixture' }, inputCount: 0 });
  assert.equal(future.status, 'inputs_missing');
  assert.equal(JSON.stringify(assessMarketDataReadiness('forex', { env: forexEnv })).includes('fixture-secret'), false);
});

test('free IEX and delayed options data are research-only, never silently classified as an executable feed', () => {
  const env = { ETF_SOURCE: 'alpaca', ETF_ALPACA_FEED: 'iex', ALPACA_API_KEY_ID: 'key', ALPACA_API_SECRET_KEY: 'secret' };
  const free = assessMarketDataReadiness('etfs-etps', { env, observedRows: 10, providerRequests: 3 });
  assert.equal(free.status, 'research_only');
  assert.equal(free.automatedScanRan, true);
  const paid = assessMarketDataReadiness('etfs-etps', { env: { ...env, ETF_ALPACA_FEED: 'sip' }, observedRows: 10, providerRequests: 3 });
  assert.equal(paid.status, 'data_observed');
  assert.equal(assessMarketDataReadiness('etfs-etps', { env, observedRows: 1, providerRequests: 3, providerFailures: 1 }).status, 'partial_data');
  assert.equal(assessMarketDataReadiness('options', { env: { OPTIONS_SOURCE: 'tradier', TRADIER_TOKEN: 'fixture', TRADIER_ENV: 'sandbox' },
    inputCount: 1, observedRows: 1, providerRequests: 3 }).status, 'research_only');
});

test('provider profiles change only data selectors and preserve credentials and risk controls', () => {
  const original = '# Private settings\r\nDISCORD_TOKEN=fixture-private-token\r\nOMNIMOD_EMERGENCY_STOP=true\r\n'
    + 'OMNIMOD_LIVE_TRADING_ENABLED=false\r\nETF_MAX_TRADE_RISK_PCT=0.2\r\nETF_SOURCE=fixture\r\nexport ETF_SOURCE=fixture\r\n';
  const next = renderProviderConfiguration(original, providerProfile('etfs-etps', 'free'));
  assert.match(next, /DISCORD_TOKEN=fixture-private-token/);
  assert.match(next, /OMNIMOD_EMERGENCY_STOP=true/);
  assert.match(next, /OMNIMOD_LIVE_TRADING_ENABLED=false/);
  assert.match(next, /ETF_MAX_TRADE_RISK_PCT=0.2/);
  assert.equal((next.match(/^ETF_SOURCE=/gm) || []).length, 1);
  assert.match(next, /ETF_SOURCE=alpaca/);
  assert.match(next, /ETF_ALPACA_FEED=iex/);
  for (const profiles of Object.values(PROVIDER_PROFILES)) for (const profile of Object.values(profiles)) {
    assert.ok(!Object.keys(profile.settings).some((key) => /EMERGENCY|LIVE_TRADING|MAX_.*RISK|COST_USD|API_KEY|TOKEN|SECRET/.test(key)));
  }
  assert.throws(() => renderProviderConfiguration('', providerProfile('futures', 'free')), /no integrated/);
  assert.throws(() => providerProfile('options', 'paid'), /Unknown/);
  assert.deepEqual(missingProviderCredentials(providerProfile('etfs-etps', 'free'), {
    ALPACA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '', APCA_API_KEY_ID: 'fixture', APCA_API_SECRET_KEY: 'fixture',
  }), []);
});

test('status cards stay under Discord limits with maximal watch metadata', () => {
  const readiness = { automatedScanRan: false, label: 'x'.repeat(500), detail: 'x'.repeat(5000), nextStep: 'x'.repeat(5000) };
  const results = Array.from({ length: 40 }, (_, i) => ({ status: 'risk-blocked', instrument: 'TEST' + i,
    candidate: { instrumentKey: 'TEST' + i, strategyId: 'x'.repeat(300), direction: 'long' },
    decision: { reasons: Array(10).fill('x'.repeat(1000)) } }));
  assert.doesNotThrow(() => discordEmbedPayload(buildDayTradingBrief({ bot: 'options', source: 's'.repeat(4000),
    coverage: 'c'.repeat(5000), context: ['c'.repeat(5000)], results, readiness })));
});
