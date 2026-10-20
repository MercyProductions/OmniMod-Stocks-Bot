import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marketDateAt } from '../../shared/marketDate.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Options runner blocks otherwise-ready call setup when optional dividend data credentials are missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-dividend-'));
  const inputPath = join(directory, 'session.json'), ledgerPath = join(directory, 'ledger.json');
  const preloadPath = join(directory, 'mock-provider.mjs'), callsPath = join(directory, 'calls.json');
  const now = Date.now(), sessionDate = marketDateAt(now, 'America/New_York');
  const expiry = new Date(now + 4 * 86_400_000).toISOString().slice(0, 10);
  try {
    await writeFile(inputPath, JSON.stringify({ sessionDate, signals: [{ signal: {
      underlyingSymbol: 'SPY', sessionDate, direction: 'long', underlyingPrice: 100, underlyingTarget: 104,
      entryLow: 99, entryHigh: 101, observedAt: new Date(now - 1000).toISOString(),
      catalystReview: { status: 'clear', source: 'operator review', summary: 'No material scheduled event.', reviewedAt: new Date(now).toISOString() },
      optionAssignmentReview: { status: 'clear', source: 'https://issuer.example/dividends', summary: 'No ex-date through expiry.',
        reviewedAt: new Date(now).toISOString(), reviewedThrough: expiry, nextExDividendDate: null },
    } }] }));
    await writeFile(ledgerPath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    await writeFile(preloadPath, `
const fs = await import('node:fs/promises');
const callsPath = ${JSON.stringify(callsPath)};
const now = Date.now(), expiry = ${JSON.stringify(expiry)};
globalThis.fetch = async (input) => {
  const url = new URL(input); const calls = JSON.parse(await fs.readFile(callsPath, 'utf8').catch(() => '[]'));
  calls.push(url.hostname + url.pathname); await fs.writeFile(callsPath, JSON.stringify(calls));
  if (url.pathname.endsWith('/markets/clock')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 3 * 60 * 60_000).toISOString() } }) };
  if (url.pathname.endsWith('/markets/quotes')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ quotes: { quote:
    url.searchParams.get('symbols').split(',').map(symbol => symbol === 'SPY'
      ? { symbol, bid: 99.99, ask: 100.01, bid_date: Date.now(), ask_date: Date.now() }
      : { symbol, underlying: 'SPY', expiration_date: expiry, option_type: 'call', strike: symbol.endsWith('00100000') ? 100 : 103,
        bid: symbol.endsWith('00100000') ? 2 : 1, ask: symbol.endsWith('00100000') ? 2.05 : 1.05,
        bid_date: Date.now(), ask_date: Date.now(), volume: 100, open_interest: 500, contract_size: 100 }) } }) };
  if (url.pathname.endsWith('/markets/options/expirations')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ expirations: { date: [expiry] } }) };
  if (url.pathname.endsWith('/markets/options/chains')) return { ok: true, status: 200, headers: new Headers(), json: async () => ({ options: { option: [
    { symbol: 'SPY' + expiry.replaceAll('-', '').slice(2) + 'C00100000', underlying: 'SPY', expiration_date: expiry, option_type: 'call', strike: 100, bid: 2, ask: 2.05, bid_date: now - 1000, ask_date: now - 1000, volume: 100, open_interest: 500, contract_size: 100 },
    { symbol: 'SPY' + expiry.replaceAll('-', '').slice(2) + 'C00103000', underlying: 'SPY', expiration_date: expiry, option_type: 'call', strike: 103, bid: 1, ask: 1.05, bid_date: now - 1000, ask_date: now - 1000, volume: 100, open_interest: 500, contract_size: 100 },
  ] } }) };
  throw new Error('unexpected outbound endpoint: ' + url.hostname + url.pathname);
};
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'alpaca',
        OPTIONS_SESSION_FILE: inputPath, OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP: '0', OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT: '0',
        TRADIER_ENV: 'production', TRADIER_TOKEN: 'test-only', ALPACA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '',
        TRADING_RISK_STATE_PATH: ledgerPath, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow'),
        OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const report = JSON.parse(child.stdout.trim());
    const measuredOptionStages = ['signalLoadingAndMapping', 'calendarAndCompanyNews', 'tradierSessionQuotesAndChains',
      'dividendAssignmentScreen', 'positionMonitoring', 'strategyAndRisk', 'forwardShadow'];
    for (const stage of measuredOptionStages) assert.ok(Number.isFinite(report.scanDiagnostics.performance.stageDurationsMs[stage])
      && report.scanDiagnostics.performance.stageDurationsMs[stage] >= 0, `missing measured stage ${stage}`);
    assert.equal(report.dividendScreenDiagnostics.status, 'credentials_missing');
    assert.ok(report.results[0].reasons.includes('cash_dividend_screen_unavailable_or_incomplete'));
    assert.equal(report.results[0].status, 'no-setup');
    assert.deepEqual(JSON.parse(await readFile(callsPath, 'utf8')), [
      'api.tradier.com/v1/markets/clock', 'api.tradier.com/v1/markets/quotes',
      'api.tradier.com/v1/markets/options/expirations', 'api.tradier.com/v1/markets/options/chains',
    ]);
    assert.equal(JSON.parse(await readFile(ledgerPath, 'utf8')).orders.length, 0);

    const shadowLedgerPath = join(directory, 'shadow-ledger.json');
    const shadowRun = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'manual',
        OPTIONS_SESSION_FILE: inputPath, OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP: '0', OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT: '0',
        TRADIER_ENV: 'production', TRADIER_TOKEN: 'test-only', ALPACA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '',
        TRADING_RISK_STATE_PATH: shadowLedgerPath, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow-manual-review'),
        OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const shadowOutput = `${shadowRun.stdout || ''}\n${shadowRun.stderr || ''}`;
    assert.equal(shadowRun.status, 0, shadowOutput.slice(-2_000));
    const shadowReport = JSON.parse(shadowRun.stdout.trim());
    const greekTrack = shadowReport.forwardShadow.find((track) => track.id === 'fresh-complete-greeks');
    assert.ok(greekTrack);
    assert.equal(greekTrack.counts.noSetup, 1);
    assert.ok(greekTrack.decisions[0].reasons.includes('required_greeks_missing_stale_or_skewed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
