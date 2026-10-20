import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishPrimaryResearchSignals } from '../../shared/signalResearch.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Options runner withholds cross-source direction conflicts before any Tradier request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-signal-conflict-'));
  const signalsPath = join(directory, 'primary-signals.jsonl');
  const sessionPath = join(directory, 'session.json');
  const reviewsPath = join(directory, 'reviews.json');
  const callsPath = join(directory, 'provider-calls.json');
  const preloadPath = join(directory, 'mock-provider.mjs');
  const ledgerPath = join(directory, 'ledger.json');
  const now = Date.now();
  const signal = (id, direction) => ({ id, symbol: 'SPY', instrumentKey: 'SPY', exposureKey: 'SPY', direction,
    strategyId: `${id}-intraday`, strategyFamily: 'intraday_day_trade', sessionDate: new Date(now).toISOString().slice(0, 10),
    observedAt: new Date(now).toISOString(), entryPrice: 500, stopPrice: direction === 'long' ? 497 : 503,
    targetPrice: direction === 'long' ? 505 : 495, status: 'active' });
  try {
    await publishPrimaryResearchSignals('stocks', [signal('stocks-spy', 'long')], { file: signalsPath, now });
    await publishPrimaryResearchSignals('etfs-etps', [signal('etf-spy', 'short')], { file: signalsPath, now });
    await writeFile(sessionPath, JSON.stringify({ signals: [] }));
    await writeFile(reviewsPath, JSON.stringify({ reviews: [] }));
    await writeFile(preloadPath, `
const fs = await import('node:fs/promises');
const callsPath = ${JSON.stringify(callsPath)};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const calls = JSON.parse(await fs.readFile(callsPath, 'utf8').catch(() => '[]'));
  calls.push(url.hostname + url.pathname);
  await fs.writeFile(callsPath, JSON.stringify(calls));
  throw new Error('unexpected provider request');
};
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'shared',
        OPTIONS_SESSION_FILE: sessionPath, OPTIONS_CATALYST_REVIEW_FILE: reviewsPath,
        OMNIMOD_SIGNAL_RESEARCH_PATH: signalsPath, TRADING_RISK_STATE_PATH: ledgerPath,
        TRADIER_ENV: 'production', TRADIER_TOKEN: 'test-only', PAPER_ACCOUNT_EQUITY_USD: '10000',
        OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP: '0', OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT: '0',
        OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow'),
        OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.counts.inputs, 0);
    assert.deepEqual(report.signalMappingDiagnostics.conflicts, [
      { symbol: 'SPY', directions: ['long', 'short'], owners: ['stocks', 'etfs-etps'] },
    ]);
    assert.equal(report.signalMappingDiagnostics.directionConflicts, 1);
    assert.equal(report.signalMappingDiagnostics.sourceRead.acceptedRecords, 2);
    assert.equal(report.signalMappingDiagnostics.sourceRead.expiredRecords, 0);
    assert.equal(report.signalMappingDiagnostics.sourceRead.rejectedRecordCount, 0);
    assert.deepEqual(JSON.parse(await readFile(callsPath, 'utf8').catch(() => '[]')), [],
      'conflicted underlying must not trigger Tradier clock, quote, expiry, chain, or mark requests');
    await assert.rejects(() => readFile(ledgerPath, 'utf8'), { code: 'ENOENT' }, 'a withheld conflict must not initialize or write the paper ledger');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
