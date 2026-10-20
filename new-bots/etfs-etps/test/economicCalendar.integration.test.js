import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('ETF macro-calendar failure adds a blackout without replacing other catalyst gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-etf-calendar-'));
  const sessionPath = join(directory, 'session.json');
  const statePath = join(directory, 'paper-ledger.json');
  const marketDate = new Date().toISOString().slice(0, 10);
  try {
    await writeFile(sessionPath, JSON.stringify({ sessionDate: marketDate, trades: [{ symbol: 'SPY', exposureKey: 'SPY',
      bars: [], quote: {}, session: { marketDate, timeZone: 'America/New_York' }, catalystReview: {
        status: 'clear', source: 'manual issuer review', summary: 'No ticker-specific headline found.', reviewedAt: new Date().toISOString(),
      } }], marks: [] }));
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    const child = spawnSync(process.execPath, [join(ROOT, 'etfs-etps/src/index.js')], { cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ETF_SOURCE: 'fixture', ETF_SESSION_FILE: sessionPath, ETF_CATALYST_SOURCE: 'finnhub', FINNHUB_API_KEY: '',
        OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
        TRADING_RISK_STATE_PATH: statePath, OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' } });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-1_800));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.economicCalendarDiagnostics.status, 'credentials_missing');
    assert.equal(report.primaryResearchContext.sourceRead.status, 'missing_file');
    assert.equal(report.primaryResearchContext.sourceRead.acceptedRecords, 0);
    assert.ok(report.results[0].reasons.includes('catalyst_blackout'));
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
