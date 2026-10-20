import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const NOW = Date.parse('2026-09-30T01:30:00Z');
const EASTERN_MARKET_DATE = '2026-09-29';

test('Options and ETF runners use Eastern local dates for calendar requests and P&L fallbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-eastern-session-date-'));
  const preload = join(directory, 'provider-fixture.mjs');
  try {
    await writeFile(preload, `
import fs from 'node:fs/promises';
Date.now = () => ${NOW};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.hostname !== 'finnhub.io') throw new Error('unexpected network request: ' + url.hostname);
  await fs.writeFile(process.env.TEST_CALENDAR_URL_PATH, url.toString());
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ economicCalendar: [] }) };
};
`);

    const cases = [
      { id: 'options', name: 'Options', entry: 'options/src/index.js', inputName: 'options.json', stateName: 'options-ledger.json',
        input: { signals: [{ signal: { underlyingSymbol: 'SPY', direction: 'long', observedAt: new Date(NOW - 1_000).toISOString() } }], marks: [] },
        env: { OPTIONS_SOURCE: 'manual', OPTIONS_SIGNAL_SOURCE: 'manual', OPTIONS_CATALYST_SOURCE: 'finnhub', OPTIONS_SESSION_FILE: null } },
      { id: 'etfs-etps', name: 'ETF/ETP', entry: 'etfs-etps/src/index.js', inputName: 'etfs.json', stateName: 'etfs-ledger.json',
        input: { trades: [{ symbol: 'SPY', bars: [], quote: {}, session: {} }], marks: [] },
        env: { ETF_SOURCE: 'fixture', ETF_CATALYST_SOURCE: 'finnhub', ETF_SESSION_FILE: null } },
    ];

    for (const item of cases) {
      const inputPath = join(directory, item.inputName);
      const statePath = join(directory, item.stateName);
      const requestPath = join(directory, `${item.id}.calendar-url`);
      await writeFile(inputPath, JSON.stringify(item.input));
      await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
      const env = { ...process.env, ...item.env, FINNHUB_API_KEY: 'fixture-only', TRADING_RISK_STATE_PATH: statePath,
        OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH: join(directory, `${item.id}-calendar-cache.json`),
        PAPER_ACCOUNT_EQUITY_USD: '0', OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
        TEST_CALENDAR_URL_PATH: requestPath };
      if (item.name === 'Options') env.OPTIONS_SESSION_FILE = inputPath;
      else env.ETF_SESSION_FILE = inputPath;
      const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, item.entry)], {
        cwd: directory, env, encoding: 'utf8', timeout: 30_000,
      });
      const output = `${child.stdout || ''}\n${child.stderr || ''}`;
      assert.equal(child.status, 0, `${item.name}: ${output.slice(-2_000)}`);
      const report = JSON.parse(child.stdout.trim());
      assert.equal(report.sessionDate, EASTERN_MARKET_DATE, `${item.name} P&L date must use America/New_York`);
      assert.equal(report.economicCalendarDiagnostics.status, 'complete', `${item.name} calendar should be fixture-backed: ${JSON.stringify(report.economicCalendarDiagnostics)}`);
      const request = new URL(await readFile(requestPath, 'utf8'));
      assert.equal(request.searchParams.get('from'), '2026-09-28', `${item.name} calendar lower bound`);
      assert.equal(request.searchParams.get('to'), '2026-09-30', `${item.name} calendar upper bound`);
      assert.equal(JSON.parse(await readFile(statePath, 'utf8')).orders.length, 0, `${item.name} fixture must not create a paper order`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
