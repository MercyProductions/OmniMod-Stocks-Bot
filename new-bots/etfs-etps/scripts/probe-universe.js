import { fetchAlpacaEtfSession } from '../src/alpacaMarketData.js';

// Read-only current discovery, without any paper ledger, strategy approval or Discord transport.
const capturedAt = new Date().toISOString();
const credentialsPresent = Boolean((process.env.ALPACA_API_KEY_ID || process.env.APCA_API_KEY_ID)
  && (process.env.ALPACA_API_SECRET_KEY || process.env.APCA_API_SECRET_KEY));
if (!credentialsPresent) {
  console.log(JSON.stringify({ capturedAt, status: 'credentials_missing', providerRequests: 0,
    actualAccountUniverse: null, cheapScreen: null, paperOrders: 0, discordPosts: 0,
    missingSetup: 'Save Alpaca API key ID and secret in the local ETF .env, then rerun. Do not paste keys into chat.' }, null, 2));
} else {
  const providerMetrics = [];
  try {
    const result = await fetchAlpacaEtfSession({ env: { ...process.env, ETF_DISCOVERY_MODE: 'full-market' },
      catalystReviews: {}, providerMetrics });
    console.log(JSON.stringify({ capturedAt, status: result.diagnostics?.discovery?.cheapScreen?.status ?? result.diagnostics?.reason ?? 'unknown',
      source: result.source, marketOpen: result.diagnostics?.marketOpen ?? null,
      discovery: result.diagnostics?.discovery ?? null, providerMetrics,
      paperOrders: 0, discordPosts: 0, scope: 'Directory/account/bulk snapshot screen only; empty catalyst reviews prevent news/history and no paper risk or execution module is invoked.' }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ capturedAt, status: 'provider_or_configuration_failure',
      operation: error.providerOperation ?? 'configuration-or-directory', providerMetrics,
      paperOrders: 0, discordPosts: 0, actualAccountUniverse: null }, null, 2));
    process.exitCode = 1;
  }
}
