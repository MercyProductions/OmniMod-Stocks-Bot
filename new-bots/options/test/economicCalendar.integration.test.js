import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('combined Options catalyst sources fail closed before Tradier quotes or option chains', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-calendar-'));
  const inputPath = join(directory, 'options-session.json');
  const statePath = join(directory, 'paper-ledger.json');
  const preloadPath = join(directory, 'mock-tradier-clock.mjs');
  const now = Date.now();
  try {
    await writeFile(inputPath, JSON.stringify({ sessionDate: new Date(now).toISOString().slice(0, 10), signals: [{ signal: {
      underlyingSymbol: 'SPY', sessionDate: new Date(now).toISOString().slice(0, 10), direction: 'long', underlyingPrice: 100,
      underlyingTarget: 104, entryLow: 99, entryHigh: 101, observedAt: new Date(now - 1_000).toISOString(),
      catalystReview: { status: 'clear', source: 'manual review', summary: 'Clear fixture.', reviewedAt: new Date(now).toISOString() },
    } }] }));
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    await writeFile(preloadPath, `
const fs = await import('node:fs/promises');
const callsPath = ${JSON.stringify(join(directory, 'calls.json'))};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const calls = JSON.parse(await fs.readFile(callsPath, 'utf8').catch(() => '[]'));
  calls.push(url.pathname);
  await fs.writeFile(callsPath, JSON.stringify(calls));
  if (url.hostname === 'finnhub.io') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ economicCalendar: [] }) };
  if (url.hostname === 'data.alpaca.markets') return { ok: true, status: 200, headers: new Headers(), json: async () => ({ news: [
    { id: 'old-headline', created_at: new Date(${now - 10_000}).toISOString(), symbols: ['SPY'], headline: 'Earlier scheduled story', source: 'fixture' },
  ] }) };
  if (url.pathname !== '/v1/markets/clock') throw new Error('unexpected market quote or option chain request after catalyst screening');
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ clock: {
    state: process.env.ALPACA_API_KEY_ID ? 'closed' : 'open', timestamp: new Date(${now}).toISOString(), next_change: new Date(${now + 60 * 60_000}).toISOString(),
  } }) };
};
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_CATALYST_SOURCE: 'finnhub+alpaca',
        FINNHUB_API_KEY: '', ALPACA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '', TRADIER_ENV: 'production', TRADIER_TOKEN: 'test-only', OPTIONS_SESSION_FILE: inputPath,
        TRADING_RISK_STATE_PATH: statePath, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow'),
        OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH: join(directory, 'calendar-cache.json'),
        OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.economicCalendarDiagnostics.status, 'credentials_missing');
    assert.equal(report.companyNewsDiagnostics.status, 'provider_error');
    assert.equal(report.results[0].providerStatus, 'catalyst_review_required');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8')), ['/v1/markets/clock']);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).orders.length, 0);

    const configured = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_CATALYST_SOURCE: 'finnhub+alpaca',
        FINNHUB_API_KEY: 'test-only', ALPACA_API_KEY_ID: 'test-only', ALPACA_API_SECRET_KEY: 'test-only', TRADIER_ENV: 'production', TRADIER_TOKEN: 'test-only', OPTIONS_SESSION_FILE: inputPath,
        TRADING_RISK_STATE_PATH: statePath, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow'),
        OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH: join(directory, 'calendar-cache.json'),
        OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const configuredOutput = `${configured.stdout || ''}\n${configured.stderr || ''}`;
    assert.equal(configured.status, 0, configuredOutput.slice(-2_000));
    const configuredReport = JSON.parse(configured.stdout.trim());
    assert.equal(configuredReport.economicCalendarDiagnostics.status, 'complete');
    assert.equal(configuredReport.companyNewsDiagnostics.status, 'complete');
    assert.equal(configuredReport.companyNewsDiagnostics.rejected, 0);
    assert.equal(configuredReport.results[0].providerStatus, 'market_not_open');
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8')),
      ['/v1/markets/clock', '/api/v1/calendar/economic', '/v1beta1/news', '/v1/markets/clock']);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
