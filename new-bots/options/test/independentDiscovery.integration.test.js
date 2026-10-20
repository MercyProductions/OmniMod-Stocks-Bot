import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Options independent research stays separate from entries and follows qualified Discord delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-independent-options-'));
  try {
    const preload = join(directory, 'provider.mjs'), input = join(directory, 'input.json'), ledger = join(directory, 'risk.json');
    await writeFile(input, JSON.stringify({ signals: [] }));
    await writeFile(ledger, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    await writeFile(preload, `
const started = performance.now();
Date.now = () => Date.parse('2026-10-02T15:00:00Z') + Math.floor(performance.now() - started);
const fs = await import('node:fs/promises');
const callsPath = ${JSON.stringify(join(directory, 'calls.json'))};
const calls = [];
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  calls.push({ path: url.pathname, method: options.method || 'GET' });
  await fs.writeFile(callsPath, JSON.stringify(calls));
  if (url.hostname === 'discord.com' && url.pathname.startsWith('/api/webhooks/')) return { ok: true, status: 204 };
  if (options.method && options.method !== 'GET') throw new Error('Only provider GET permitted');
  let payload;
  if (url.pathname === '/v2/assets') payload = [{ id: 'durable-test-id', symbol: 'FRESH', class: 'us_equity', status: 'active', exchange: 'NYSE', tradable: true, attributes: ['has_options'] }];
  else if (url.pathname === '/v2/clock') payload = { timestamp: '2026-10-02T15:00:00Z', is_open: true, next_open: '2026-10-05T13:30:00Z', next_close: '2026-10-02T20:00:00Z' };
  else if (url.pathname === '/v2/calendar') payload = [{ date: '2026-10-02', open: '09:30', close: '16:00' }];
  else if (url.pathname === '/v2/stocks/snapshots') payload = { FRESH: { latestQuote: { bp: 102, ap: 102.02, t: '2026-10-02T15:00:00Z' }, dailyBar: { o: 100, c: 102, h: 103, l: 99, v: 100000, t: '2026-10-02T04:00:00Z' } } };
  else if (url.pathname === '/v2/stocks/bars') payload = { bars: { FRESH: Array.from({ length: 90 }, (_, i) => ({
    t: new Date(Date.parse('2026-10-02T13:30:00Z') + i * 60000).toISOString(), o: 100, h: i === 89 ? 100.5 : 100.2,
    l: 99.8, c: i === 89 ? 100.4 : 100, vw: i === 89 ? 100.2 : 100, v: i === 89 ? 2000 : 1000,
  })) }, next_page_token: null };
  else if (url.pathname === '/v2/stocks/quotes/latest') payload = { quotes: { FRESH: { bp: 100.39, ap: 100.41, bs: 10, as: 10, t: '2026-10-02T15:00:00Z' } } };
  else if (url.pathname === '/v1/markets/options/expirations') payload = { expirations: { date: ['2026-10-09', '2028-01-21'] } };
  else if (url.pathname === '/v1/markets/options/chains') payload = { options: { option: [{ symbol: 'FRESH261009C00100000', underlying: 'FRESH',
    root_symbol: 'FRESH', expiration_date: '2026-10-09', option_type: 'call', strike: 100, contract_size: 100,
    bid: 2, ask: 2.1, bid_date: Date.now() - 900000, ask_date: Date.now() - 900000, volume: 50, open_interest: 300 }] } };
  else throw new Error('Unexpected network action: ' + url.pathname);
  return { ok: true, status: 200, headers: new Headers(), json: async () => payload };
};
`);
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../src/index.js', import.meta.url))], { cwd: directory, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, OPTIONS_SOURCE: 'manual', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_SESSION_FILE: input,
        OPTIONS_CATALYST_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'manual', OPTIONS_DISCOVERY_SOURCE: 'alpaca',
        OPTIONS_DISCOVERY_FEED: 'iex', ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret',
        OPTIONS_CONTRACT_DISCOVERY_SOURCE: 'tradier', TRADIER_ENV: 'sandbox', TRADIER_TOKEN: 'fixture-tradier',
        OPTIONS_EXPIRATION_CACHE_PATH: join(directory, 'expirations'), OPTIONS_CONTRACT_HISTORY_PATH: join(directory, 'contracts'),
        OPTIONS_DIRECTORY_CACHE_PATH: join(directory, 'directory.json'), OPTIONS_DISCOVERY_HISTORY_PATH: join(directory, 'history'),
        TRADING_RISK_STATE_PATH: ledger, OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
        OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'), OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
        DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: '', DISCORD_DELIVERY_MODE: 'webhook' } });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.scanDiagnostics.universe.status, 'screen_complete');
    assert.equal(output.scanDiagnostics.universe.cheapScreen.cheaplyScreened, 1);
    assert.equal(output.scanDiagnostics.funnel.primarySignals, 0);
    assert.equal(output.scanDiagnostics.funnel.strategyCandidates, 0);
    assert.equal(output.scanDiagnostics.funnel.paperReservations, 0);
    assert.equal(output.independentUnderlyingResearch.shortlist[0].symbol, 'FRESH');
    assert.equal(output.independentContractResearch.diagnostics.expirationDates, 2);
    assert.equal(output.independentContractResearch.diagnostics.verifiedIdentities, 1);
    assert.equal(output.independentContractResearch.diagnostics.delayedResearchQuotes, 1);
    assert.equal(output.independentContractResearch.diagnostics.paperEligible, 0);
    assert.equal(output.independentIntradayResearch.diagnostics.technicalWatches, 1);
    assert.equal(output.independentIntradayResearch.diagnostics.evaluated, 1);
    assert.equal(output.independentIntradayResearch.diagnostics.paperEligible, 0);
    assert.equal(output.independentIntradayResearch.rows[0].eligibleForPaper, false);
    assert.equal(output.scanDiagnostics.marketDataReadiness.automatedScanRan, true);
    assert.equal(output.discordDelivery.posted, false);
    assert.equal(JSON.parse(await readFile(ledger)).orders.length, 0);
    const diagnostic = JSON.parse((await readFile(join(directory, 'data/options-scan-diagnostics.jsonl'), 'utf8')).trim());
    assert.equal(diagnostic.diagnostics.universe.eligibleInstruments, 1);
    assert.equal(diagnostic.diagnostics.safety.liveTradingEnabled, false);
    assert.equal(diagnostic.diagnostics.universe.strategyInputs, 0);
    assert.equal(diagnostic.diagnostics.universe.contractDiscovery.chainResponses, 1);
    assert.equal(diagnostic.diagnostics.universe.intradayResearch.technicalWatches, 1);
    // A valid existing directional setup reaches the Discord attempt before broad research.
    const quoteTime = '2026-10-02T14:59:59Z';
    const leg = (symbol, strike, bid, ask) => ({ symbol, underlying: 'SPY', type: 'put', expiry: '2026-10-09', strike, bid, ask,
      time: quoteTime, quoteQuality: 'executable', multiplier: 100, volume: 50, openInterest: 500 });
    await writeFile(input, JSON.stringify({ signals: [{ signal: { underlyingSymbol: 'SPY', sessionDate: '2026-10-02',
      sessionClose: '2026-10-02T20:00:00Z', sessionOpen: true, direction: 'short', underlyingPrice: 100, underlyingTarget: 96,
      observedAt: quoteTime, underlyingQuote: { bid: 99.99, ask: 100.01, time: quoteTime, quality: 'executable' },
      catalystReview: { status: 'clear', source: 'manual-review', summary: 'Synthetic event clearance.', reviewedAt: quoteTime } },
      chain: { expiry: '2026-10-09', quoteQuality: 'executable', options: [leg('SPY261009P00100000', 100, 2, 2.1), leg('SPY261009P00097000', 97, 0.9, 1)] },
      config: { feePerContractRoundTrip: 0, slippageReservePerContract: 0 } }] }));
    const second = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../src/index.js', import.meta.url))], { cwd: directory, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, OPTIONS_SOURCE: 'manual', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_SESSION_FILE: input,
        OPTIONS_CATALYST_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'manual', OPTIONS_DISCOVERY_SOURCE: 'alpaca',
        OPTIONS_DISCOVERY_FEED: 'iex', ALPACA_API_KEY_ID: 'fixture-key', ALPACA_API_SECRET_KEY: 'fixture-secret',
        OPTIONS_CONTRACT_DISCOVERY_SOURCE: 'tradier', TRADIER_ENV: 'sandbox', TRADIER_TOKEN: 'fixture-tradier',
        OPTIONS_EXPIRATION_CACHE_PATH: join(directory, 'expirations'), OPTIONS_CONTRACT_HISTORY_PATH: join(directory, 'contracts'),
        OPTIONS_DIRECTORY_CACHE_PATH: join(directory, 'directory.json'), OPTIONS_DISCOVERY_HISTORY_PATH: join(directory, 'history'),
        TRADING_RISK_STATE_PATH: ledger, OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
        OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'), OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
        PAPER_ACCOUNT_EQUITY_USD: '10000', DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/12345/synthetic',
        DISCORD_DELIVERY_MODE: 'webhook' } });
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.scanDiagnostics.funnel.strategyCandidates, 1);
    assert.equal(secondReport.discordDelivery.posted, true, 'Synthetic fetch only, no real Discord request.');
    assert.equal(secondReport.scanDiagnostics.funnel.paperReservations, 0);
    const calls = JSON.parse(await readFile(join(directory, 'calls.json')));
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls.filter((row) => row.method === 'POST').length, 1);
    assert.ok(calls.some((row) => row.path.endsWith('/chains')));
    assert.equal((await readFile(join(directory, 'data/options.jsonl'), 'utf8')).trim().split('\n').length, 1);
  } finally {
    const rel = relative(tmpdir(), directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
