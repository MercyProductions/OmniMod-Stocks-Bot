import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { oandaDirectoryCachePath } from '../src/oandaDirectoryCache.js';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote } from '../../shared/paperRisk.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Forex OANDA runner screens full account FX membership and reuses the discovery quotes during deep analysis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forex-oanda-discovery-'));
  try {
    const requestLog = join(directory, 'requests.json');
    const mockPath = join(directory, 'mock-oanda.mjs');
    await writeFile(mockPath, `
import { writeFileSync } from 'node:fs';
const requests = [];
globalThis.fetch = async (input) => {
  const url = new URL(input); requests.push({ path: url.pathname, query: url.searchParams.toString() });
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname.endsWith('/instruments') && process.env.FOREX_TEST_DIRECTORY_FAIL === 'true')
    return new Response('Fixture directory denied', { status: 403 });
  if (url.pathname.endsWith('/instruments')) return json({ instruments: [
    { name: 'EUR_USD', type: 'CURRENCY' }, { name: 'GBP_USD', type: 'CURRENCY' }, { name: 'USD_JPY', type: 'CURRENCY' },
    { name: 'EUR_SGD', type: 'CURRENCY' }, { name: 'USD_SGD', type: 'CURRENCY' },
    { name: 'XAU_USD', type: 'CFD' },
  ] });
  if (url.pathname.endsWith('/pricing')) {
    const symbols = (url.searchParams.get('instruments') || '').split(',').filter(Boolean);
    return json({ prices: symbols.map((instrument) => ({ instrument, status: 'tradeable', time: new Date().toISOString(),
      bids: [{ price: instrument.endsWith('SGD') ? '1.35' : instrument === 'EUR_USD' ? '1.10000' : instrument === 'GBP_USD' ? '1.25000' : '150.000' }],
      asks: [{ price: instrument.endsWith('SGD') ? '1.3501' : instrument === 'EUR_USD' ? '1.10002' : instrument === 'GBP_USD' ? '1.25001' : '150.010' }] })) });
  }
  if (url.pathname.includes('/candles')) {
    if (process.env.FOREX_TEST_HISTORY_FAIL === 'true') return new Response('Fixture history denied', { status: 403 });
    const step = url.searchParams.get('granularity') === 'M15' ? 900_000 : url.searchParams.get('granularity') === 'H1' ? 3_600_000 : 14_400_000;
    const now = Date.now();
    return json({ candles: Array.from({ length: 120 }, (_, index) => {
      const close = 1.1 + index * 0.00001;
      return { time: new Date(now - (120 - index) * step).toISOString(), complete: true, volume: 100,
        mid: { o: String(close - 0.000005), h: String(close + 0.00001), l: String(close - 0.00001), c: String(close) } };
    }) });
  }
  throw new Error('Unexpected external request path ' + url.pathname);
};
process.on('exit', () => writeFileSync(process.env.FOREX_TEST_REQUEST_LOG, JSON.stringify(requests)));
`, { flag: 'wx' });
    const run = (overrides = {}) => spawnSync(process.execPath, ['--import', pathToFileURL(mockPath).href, join(ROOT, 'forex/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, FOREX_SOURCE: 'oanda-practice', OANDA_ENV: 'practice', OANDA_ACCOUNT_ID: 'test-account',
        OANDA_API_TOKEN: 'test-token', FOREX_INSTRUMENTS: 'EUR_USD,EUR_SGD', FOREX_MAX_SCAN_INSTRUMENTS: '2',
        FOREX_DYNAMIC_DISCOVERY: 'true', FOREX_DIRECTORY_REFRESH_MS: '3600000',
        FOREX_TEST_REQUEST_LOG: requestLog, TRADING_RISK_STATE_PATH: join(directory, 'ledger.json'),
        OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'), OMNIMOD_EMERGENCY_STOP: 'true',
        OMNIMOD_LIVE_TRADING_ENABLED: 'false', OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'),
        DISCORD_WEBHOOK_URL: '', DISCORD_TOKEN: '', DISCORD_DELIVERY_MODE: 'webhook',
        FOREX_CATALYST_CLEAR: 'true', FOREX_CATALYST_REVIEWED_AT: new Date().toISOString(),
        FOREX_CATALYST_REVIEW_SOURCE: 'https://example.com/calendar', FOREX_CATALYST_REVIEW_SUMMARY: 'Scheduled events reviewed.',
        ...overrides,
      },
    });
    const report = run();
    const output = `${report.stdout || ''}\n${report.stderr || ''}`;
    assert.equal(report.status, 0, output.slice(-2_000));
    const parsed = JSON.parse(report.stdout.trim());
    assert.deepEqual(parsed.scanDiagnostics.universe, { configured: 2, configuredSupported: 2, selected: 2, observed: 2, missing: 0, discoveryStatus: 'complete',
      accountCurrencyInstruments: 5, eligibleG10Instruments: 3, discoveryEligibleInstruments: 5, discoveredQuoteQualified: 3,
      selectedDiscovered: 0, capOmissions: 3, quoteRejected: 0,
      providerInstruments: 6, nonG10Instruments: 2, cheaplyScreened: 5, quoteQualified: 5 });
    assert.equal(parsed.observations.some((row) => row.instrument === 'EUR_SGD'), true);
    assert.equal(parsed.observations.find((row) => row.instrument === 'EUR_SGD').usdConversion.quoteToUsd, 1 / 1.35);
    assert.equal(parsed.observations.some((row) => row.instrument === 'USD_JPY'), false);
    const requests = JSON.parse(await readFile(requestLog, 'utf8'));
    const pricing = requests.filter((request) => request.path.endsWith('/pricing'));
    assert.equal(pricing.length, 1, 'one full-universe quote batch reused for every selected pair');
    assert.equal(pricing.some((request) => request.query.includes('GBP_USD') && request.query.includes('EUR_USD')), true);
    assert.equal(parsed.scanDiagnostics.directory.source, 'provider');
    assert.equal(parsed.scanDiagnostics.discoveryScreen.length, 5);
    assert.equal(output.includes('test-token'), false);
    assert.equal(output.includes('/orders'), false);

    // Repeated scan uses cached membership but requests fresh prices, not cached quotes.
    const repeat = run({ FOREX_TEST_DIRECTORY_FAIL: 'true' });
    assert.equal(repeat.status, 0, repeat.stderr);
    const repeated = JSON.parse(repeat.stdout);
    assert.equal(repeated.scanDiagnostics.directory.source, 'fresh_cache');
    const repeatedRequests = JSON.parse(await readFile(requestLog, 'utf8'));
    assert.equal(repeatedRequests.filter((row) => row.path.endsWith('/instruments')).length, 0);
    assert.equal(repeatedRequests.filter((row) => row.path.endsWith('/pricing')).length, 1);

    // A held pair excluded by the deep-analysis cap is monitored even when history fails.
    const seedAt = Date.now() - 10_000, statePath = join(directory, 'ledger.json');
    const proposal = { mode: 'paper', owner: 'forex', assetClass: 'forex', instrumentKey: 'USD_JPY', exposureKey: 'USD_JPY',
      idempotencyKey: 'off-shortlist-fixture', sessionDate: new Date(seedAt).toISOString().slice(0, 10),
      direction: 'long', bid: 150, ask: 150.01, entryPrice: 150.01,
      stopPrice: 149, targetPrice: 153, multiplier: 1 / 150, gainMultiplier: 1 / 150.01, lotSize: 1,
      roundTripFeesPerUnit: 0.00001, slippageReservePerUnit: 0.00001, sessionOpen: true, quoteQuality: 'executable',
      quoteTime: new Date(seedAt - 1000).toISOString(), forceExitAt: new Date(seedAt + 3_600_000).toISOString() };
    const decision = evaluatePaperCandidate(proposal, { accountEquity: 10_000 }, { now: seedAt, emergencyStop: false, maxGrossExposurePct: 200 });
    assert.equal(decision.status, 'paper-approved', JSON.stringify(decision.reasons));
    const reserved = await reservePaperCandidate(proposal, decision, { statePath, now: seedAt, emergencyStop: false });
    const filled = await processPaperQuote(reserved.order.orderId,
      { bid: 150, ask: 150.01, time: new Date(seedAt + 1000).toISOString(), quality: 'executable' },
      { statePath, now: seedAt + 1000, emergencyStop: false, sessionOpen: true });
    assert.equal(filled.status, 'filled');
    const historyFailure = run({ FOREX_TEST_HISTORY_FAIL: 'true', OMNIMOD_EMERGENCY_STOP: 'false' });
    assert.equal(historyFailure.status, 0, historyFailure.stderr);
    const marked = JSON.parse(historyFailure.stdout);
    assert.equal(marked.scanDiagnostics.positionMarkCoverage.quoteAccepted, 1);
    assert.equal(marked.scanDiagnostics.positionMarkCoverage.quoteMissing, 0);
    assert.equal(marked.paperResults.find((row) => row.mark)?.instrument, 'USD_JPY');
    assert.equal(marked.scanDiagnostics.provider.failures, 8);

    // After directory expiry, provider denial blocks all new analysis while monitoring continues.
    const cachePath = oandaDirectoryCachePath({ account: 'test-account', directory: join(directory, 'data') });
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    cache.fetchedAt -= 86_400_000;
    await writeFile(cachePath, JSON.stringify(cache));
    const failure = run({ FOREX_TEST_DIRECTORY_FAIL: 'true', OMNIMOD_EMERGENCY_STOP: 'false' });
    assert.equal(failure.status, 0, failure.stderr);
    const failed = JSON.parse(failure.stdout);
    assert.equal(failed.scanDiagnostics.universe.discoveryStatus, 'provider_error');
    assert.equal(failed.scanDiagnostics.universe.selected, 0);
    assert.equal(failed.scanDiagnostics.universe.accountCurrencyInstruments, null);
    assert.equal(failed.scanDiagnostics.positionMarkCoverage.quoteAccepted, 1);
    const failedRequests = JSON.parse(await readFile(requestLog, 'utf8'));
    assert.equal(failedRequests.some((row) => row.path.includes('/candles')), false);
    assert.equal(failedRequests.some((row) => row.path.includes('/orders')), false);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\'));
    await rm(directory, { recursive: true, force: true });
  }
});
