import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const services = [
  { owner: 'stocks', project: 'stocks-bot', dataEnv: 'OMNIMOD_STOCKS_DATA_DIR',
    providerEnv: { ALPACA_API_KEY_ID: 'integration-test', ALPACA_API_SECRET_KEY: 'integration-test', STOCKS_DYNAMIC_DISCOVERY: 'true' } },
  { owner: 'crypto', project: 'crypto-bot', dataEnv: 'OMNIMOD_CRYPTO_DATA_DIR', providerEnv: {} },
];

async function runRecoveryScenario(service, { emergencyStop, expired }) {
  const directory = await mkdtemp(join(tmpdir(), `omnimod-${service.owner}-service-recovery-`));
  const statePath = join(directory, 'paper-ledger.json');
  const dataPath = join(directory, 'data');
  const trackerPath = join(dataPath, 'tracker-recovery-integration-test.json');
  const preloadPath = join(directory, 'block-network.mjs');
  const driverPath = join(directory, 'run-scan.mjs');
  try {
    const otherOwner = service.owner === 'stocks' ? 'crypto' : 'stocks';
    const unrelated = { orderId: `${otherOwner}-untouched`, owner: otherOwner, status: 'reserved',
      entryExpiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(),
      forceExitAt: new Date(Date.now() + 3_600_000).toISOString() };
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [
      { orderId: `${service.owner}-expired`, owner: service.owner, status: 'reserved',
        entryExpiresAt: new Date(Date.now() + (expired ? -60_000 : 60_000)).toISOString(), forceExitAt: new Date(Date.now() + 3_600_000).toISOString() },
      { orderId: `${service.owner}-open-overdue`, owner: service.owner,
        assetClass: service.owner === 'crypto' ? 'crypto' : 'stock', instrumentKey: service.owner === 'crypto' ? 'BTC' : 'AAPL',
        status: 'open', direction: 'long', units: 1, multiplier: 1, fillPrice: 100, riskUsd: 10,
        forceExitAt: new Date(Date.now() - 60_000).toISOString() },
      unrelated,
    ] }));
    const persistedPaperOrderId = `${service.owner}-open-overdue`;
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dataPath, { recursive: true }));
    await writeFile(trackerPath, JSON.stringify({ version: 1, guildId: 'recovery-integration-test', updatedAt: new Date().toISOString(), predictions: [
      { id: `${service.owner}-signal`, symbol: service.owner === 'crypto' ? 'BTC' : 'AAPL', status: 'tracking',
        sharedPaperOrderId: persistedPaperOrderId, sharedPaperStatus: 'reserved' },
    ] }));
    const networkMarkerPath = join(directory, 'network-blocked.txt');
    await writeFile(preloadPath, "import { writeFileSync } from 'node:fs';\nglobalThis.fetch = async () => { writeFileSync(process.env.OMNIMOD_TEST_NETWORK_MARKER, 'provider reached'); throw new Error('blocked-network-test'); };\n");
    const moduleUrl = pathToFileURL(join(ROOT, service.project, 'src/index.js')).href;
    await writeFile(driverPath, `const app = await import(${JSON.stringify(moduleUrl)});\ntry {\n  await app.runGuildScan('recovery-integration-test', { manual: true, forceProvider: true, allowNewSignals: true, reason: 'recovery-integration-test' });\n} catch (error) { console.error(error?.stack || error); } finally { await app.shutdown('integration-test'); }\n`);
    const env = { ...process.env, ...service.providerEnv, NODE_ENV: 'test', OMNIMOD_TEST_SKIP_DISCORD_LOGIN: '1',
      DISCORD_TOKEN: 'test-only-not-a-real-token', DISCORD_CLIENT_ID: '123456789012345678',
      STOCKS_DISCORD_TOKEN: 'test-only-not-a-real-token', STOCKS_DISCORD_CLIENT_ID: '123456789012345678',
      TRADING_RISK_STATE_PATH: statePath, OMNIMOD_EMERGENCY_STOP: String(emergencyStop), OMNIMOD_LIVE_TRADING_ENABLED: 'false',
      OMNIMOD_TEST_NETWORK_MARKER: networkMarkerPath,
      [service.dataEnv]: dataPath };
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, driverPath], {
      cwd: directory, env, encoding: 'utf8', timeout: 45_000,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    await assert.doesNotReject(readFile(networkMarkerPath), `service did not reach blocked market data; exit=${child.status}; ${output.slice(-1200)}`);
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].status, 'cancelled', `service did not recover before market data; ${output.slice(-1200)}`);
    assert.equal(ledger.orders[0].cancelReason, emergencyStop ? 'emergency_stop_active' : 'entry_window_expired');
    assert.equal(ledger.orders[1].status, 'open', `service fabricated a close without fresh provider quotes; ${output.slice(-1200)}`);
    assert.equal(ledger.orders[1].exitPrice, undefined);
    assert.equal(ledger.orders[1].exitReason, undefined);
    assert.deepEqual(ledger.orders.find(row => row.orderId === unrelated.orderId), unrelated,
      'this service must not recover another owner using its own stop or session settings');
    assert.ok(ledger.events.every(row => row.orderId !== unrelated.orderId));
    const tracker = JSON.parse(await readFile(trackerPath, 'utf8'));
    assert.equal(tracker.predictions[0].sharedPaperStatus, 'open', `service did not persist the post-restart ledger state; ${output.slice(-1200)}`);
    assert.ok(tracker.predictions[0].sharedPaperLedgerCheckedAt);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const service of services) {
  test(`${service.owner} service expires pending entries before market-data failure without Discord login`, () =>
    runRecoveryScenario(service, { emergencyStop: false, expired: true }));
  test(`${service.owner} service applies emergency stop before market-data failure without Discord login`, () =>
    runRecoveryScenario(service, { emergencyStop: true, expired: false }));
}
