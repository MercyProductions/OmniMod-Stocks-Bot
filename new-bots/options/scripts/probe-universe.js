import { discoverOptionUnderlyings } from '../src/underlyingDiscovery.js';
import { discoverOptionContracts } from '../src/contractDiscovery.js';
import { analyzeOptionUnderlyings } from '../src/underlyingIntradayResearch.js';

// Provider GETs and local coverage archives only. No Discord, paper ledger or orders.
const providerMetrics = [];
const result = await discoverOptionUnderlyings({ env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'alpaca' }, providerMetrics });
const technical = process.argv.includes('--technical') ? await analyzeOptionUnderlyings({ underlyingDiscovery: result, providerMetrics }) : null;
const contracts = process.argv.includes('--contracts') ? await discoverOptionContracts({ underlyingDiscovery: result, providerMetrics }) : null;
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), ...result, technical, contracts, providerMetrics,
  paperOrders: 0, discordPosts: 0, productionStrategyInvoked: false }, null, 2));
if (result.diagnostics.status === 'provider_error' || result.diagnostics.status.startsWith('invalid_')) process.exitCode = 1;
if (contracts?.diagnostics.failedOperations > 0 || contracts?.diagnostics.status.startsWith('invalid_')) process.exitCode = 1;
if (technical?.diagnostics.status === 'provider_error' || technical?.diagnostics.status.startsWith('invalid_')) process.exitCode = 1;
