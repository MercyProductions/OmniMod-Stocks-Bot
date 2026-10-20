import { discoverOandaFxUniverse } from '../src/oandaUniverse.js';
import { requestForexJson } from '../src/providerRequest.js';

const token = process.env.OANDA_API_TOKEN?.trim(), account = process.env.OANDA_ACCOUNT_ID?.trim();
const missing = [!token && 'OANDA_API_TOKEN', !account && 'OANDA_ACCOUNT_ID'].filter(Boolean);
const capturedAt = new Date().toISOString();
if (missing.length || (process.env.OANDA_ENV || 'practice') !== 'practice') {
  console.log(JSON.stringify({ capturedAt, status: 'provider_verification_unavailable',
    missing, practiceEnvironmentRequired: true, accountFxUniverse: null,
    providerRequests: 0, limitation: 'No account-backed membership or quote coverage was measured.' }, null, 2));
} else {
  const providerMetrics = [];
  const get = (path, operation, instruments = []) => requestForexJson('https://api-fxpractice.oanda.com' + path,
    { headers: { authorization: 'Bearer ' + token }, metrics: providerMetrics, operation, instruments, timeoutMs: 12_000 });
  try {
    const result = await discoverOandaFxUniverse({ configuredInstruments: (process.env.FOREX_INSTRUMENTS || 'EUR_USD,GBP_USD').split(','),
      maxInstruments: Number(process.env.FOREX_MAX_SCAN_INSTRUMENTS || 20), now: Date.now(), clock: Date.now,
      maxSpreadPct: Number(process.env.FOREX_MAX_SPREAD_PCT || 0.03), maxQuoteAgeMs: 120_000,
      fetchInstruments: () => get('/v3/accounts/' + encodeURIComponent(account) + '/instruments', 'instrument-universe'),
      fetchPrices: (pairs) => get('/v3/accounts/' + encodeURIComponent(account) + '/pricing?instruments=' + encodeURIComponent(pairs.join(',')), 'universe-pricing', pairs) });
    console.log(JSON.stringify({ capturedAt, status: 'provider_observation', accountFxUniverse: result.accountInstruments.length,
      selected: result.instruments, diagnostics: result.diagnostics, screenRows: result.screenRows, providerMetrics,
      limitation: 'Read-only discovery probe; no history, strategy approval, paper orders or Discord delivery was attempted.' }, null, 2));
  } catch {
    console.log(JSON.stringify({ capturedAt, status: 'provider_verification_failed', accountFxUniverse: null,
      providerRequests: providerMetrics.length, failures: providerMetrics.filter((row) => row.error || Number(row.status) >= 400).length,
      limitation: 'No complete account directory was verified. Inspect sanitized provider diagnostics before retrying.' }, null, 2));
    process.exitCode = 1;
  }
}
