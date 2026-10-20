import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runners = [
  { name: 'Forex', dir: 'forex', env: { FOREX_SOURCE: 'oanda-practice', OANDA_ACCOUNT_ID: 'integration-test', OANDA_API_TOKEN: 'integration-test', FOREX_INSTRUMENTS: 'EUR_USD' } },
  { name: 'Futures', dir: 'futures',
    env: { FUTURES_SOURCE: 'manual',
    FUTURES_FILE: join(ROOT, 'futures/examples/futures.json'), FUTURES_DAY_SESSION_FILE: join(ROOT, 'futures/examples/day-session.json') } },
  { name: 'Options', dir: 'options', env: { OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', TRADIER_ENV: 'production', TRADIER_TOKEN: 'integration-test' } },
  { name: 'ETF/ETP', dir: 'etfs-etps', env: { ETF_SOURCE: 'alpaca', ALPACA_API_KEY_ID: 'integration-test', ALPACA_API_SECRET_KEY: 'integration-test' } },
];

async function runRecoveryScenario(runner, { emergencyStop, expectedReason, expired }) {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-runner-recovery-'));
  const statePath = join(directory, 'paper-ledger.json');
  const preloadPath = join(directory, 'block-network.mjs');
  const networkMarkerPath = join(directory, 'network-blocked.txt');
  const now = Date.now();
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [
      { orderId: `${runner.dir}-expired`, owner: runner.dir === 'etfs-etps' ? 'etfs-etps' : runner.dir,
        status: 'reserved', entryExpiresAt: new Date(now + (expired ? -60_000 : 60_000)).toISOString(), forceExitAt: new Date(now + 3_600_000).toISOString() },
      { orderId: `${runner.dir}-open-overdue`, owner: runner.dir === 'etfs-etps' ? 'etfs-etps' : runner.dir,
        assetClass: ({ Forex: 'fx', Futures: 'future', Options: 'option', 'ETF/ETP': 'etf' })[runner.name],
        instrumentKey: ({ Forex: 'EUR_USD', Futures: 'ESZ6', Options: 'SPY-CALL-SPREAD', 'ETF/ETP': 'SPY' })[runner.name],
        status: 'open', direction: 'long', units: 1, multiplier: 1, fillPrice: 100, riskUsd: 10,
        forceExitAt: new Date(now - 60_000).toISOString(), maxFavorableExcursionUsd: 0, maxAdverseExcursionUsd: 0 },
    ] }));
    await writeFile(preloadPath, "import { writeFileSync } from 'node:fs';\nglobalThis.fetch = async () => { writeFileSync(process.env.OMNIMOD_TEST_NETWORK_MARKER, 'provider reached'); throw new Error('blocked-network-test'); };\n");
    const env = { ...process.env, ...runner.env, TRADING_RISK_STATE_PATH: statePath,
      OMNIMOD_EMERGENCY_STOP: String(emergencyStop), OMNIMOD_LIVE_TRADING_ENABLED: 'false', OMNIMOD_TEST_NETWORK_MARKER: networkMarkerPath };
    if (runner.name === 'Options') {
      const sessionPath = join(directory, 'options-session.json');
      await writeFile(sessionPath, JSON.stringify({ signals: [{ signal: { underlyingSymbol: 'SPY', catalystReview: {
        status: 'clear', source: 'fixture', summary: 'integration test', reviewedAt: new Date(now).toISOString(),
      } } }], marks: [] }));
      env.OPTIONS_SESSION_FILE = sessionPath;
    }
    const runnerPath = join(ROOT, runner.dir, 'src/index.js');
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, runnerPath], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    if (runner.errorPattern) assert.match(output, runner.errorPattern, `expected provider/source failure was not observed; exit=${child.status}; ${output.slice(-800)}`);
    else assert.equal(child.status, 0, `runner did not complete its blocked-network smoke; ${output.slice(-800)}`);
    if (runner.name !== 'Futures') await assert.doesNotReject(readFile(networkMarkerPath), `runner did not reach the injected network boundary; ${output.slice(-800)}`);
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].status, 'cancelled', `runner did not recover before subsequent scan work; ${output.slice(-800)}`);
    assert.equal(ledger.orders[0].cancelReason, expectedReason);
    assert.equal(ledger.orders[1].status, 'open', `runner fabricated a close without a fresh executable mark; ${output.slice(-800)}`);
    assert.equal(ledger.orders[1].exitPrice, undefined);
    assert.equal(ledger.orders[1].exitReason, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const runner of runners) {
  test(`${runner.name} runner expires pending entries before blocked provider requests`, () =>
    runRecoveryScenario(runner, { emergencyStop: false, expectedReason: 'entry_window_expired', expired: true }));
  test(`${runner.name} runner applies emergency stop before blocked provider requests`, () =>
    runRecoveryScenario(runner, { emergencyStop: true, expectedReason: 'emergency_stop_active', expired: false }));
}
