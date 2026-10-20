import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStockPositionMonitor, resolveStockMonitorCredentials, runStockPositionMonitor, stockMonitorEnvironment, stockMonitorWorkerEnvironment } from '../src/paperPositionMonitor.js';
import { createMarketScanScheduler } from '../../new-bots/shared/marketBotRuntime.js';

test('monitor credentials use explicit bot configuration or one unambiguous saved pair', async () => {
  const bot = await resolveStockMonitorCredentials({ settings: { alpacaKeyId: 'a', alpacaSecretKey: 'b' }, listGuilds: () => assert.fail('bot configuration is complete') });
  assert.equal(bot.status, 'bot_configuration');
  const saved = async (pairs) => resolveStockMonitorCredentials({ settings: {}, listGuilds: async () => pairs.map((_, i) => i),
    loadGuild: async id => pairs[id], keysForGuild: row => row });
  assert.equal((await saved([])).status, 'credentials_missing');
  assert.equal((await saved([{ alpaca_key_id: 'a' }])).status, 'incomplete_saved_credentials');
  assert.equal((await saved([{ alpaca_key_id: 'a', alpaca_secret_key: 'b' }, { alpaca_key_id: 'a', alpaca_secret_key: 'b' }])).status, 'unique_saved_configuration');
  assert.equal((await saved([{ alpaca_key_id: 'a', alpaca_secret_key: 'b' }, { alpaca_key_id: 'c', alpaca_secret_key: 'd' }])).status, 'ambiguous_saved_credentials');
  assert.equal((await resolveStockMonitorCredentials({ settings: { alpacaKeyId: 'a' } })).status, 'incomplete_bot_credentials');
});

test('effective monitor configuration preserves loaded local policy over unrelated process defaults', () => {
  const result = stockMonitorEnvironment({ sharedPaperStatePath: 'chosen.json', sharedPaperEmergencyStop: true,
    alpacaDataFeed: 'iex', sharedPaperMaxQuoteAgeMs: 12000, sharedPaperMaxOpenMarkAgeMs: 300000,
    sharedPaperMaxSpreadPct: 0.2, paperMonitor: { intervalSeconds: 60 } },
  { TRADING_RISK_STATE_PATH: 'other.json', OMNIMOD_EMERGENCY_STOP: 'false', ALPACA_API_KEY_ID: 'stale' }, { key: 'a', secret: 'b' });
  assert.equal(result.TRADING_RISK_STATE_PATH, 'chosen.json'); assert.equal(result.OMNIMOD_EMERGENCY_STOP, 'true');
  assert.equal(result.ALPACA_API_KEY_ID, 'a'); assert.equal(result.SHARED_MAX_SPREAD_PCT, '0.2');
  assert.equal(result.PAPER_MONITOR_INTERVAL_SECONDS, '60');
});

test('disabled scheduler allocates no child, log or timer', async () => {
  const monitor = createStockPositionMonitor({ settings: { paperMonitor: { intervalSeconds: 0 } },
    schedulerFactory: () => assert.fail('no child'), logFactory: () => assert.fail('no log') });
  monitor.start(); await monitor.stop(); assert.equal(monitor.snapshot().enabled, false);
});

test('supervised child pins the running app policy, cadence, provider and data directory', () => {
  const result = stockMonitorWorkerEnvironment({ paperMonitor: { intervalSeconds: 120 }, sharedPaperEmergencyStop: true,
    sharedPaperStatePath: 'ledger-a.json', alpacaDataFeed: 'sip', sharedPaperMaxQuoteAgeMs: 5000, alpacaKeyId: '', alpacaSecretKey: '' },
  { STOCKS_PAPER_MONITOR_INTERVAL_SECONDS: '60', STOCKS_OMNIMOD_EMERGENCY_STOP: 'false', ALPACA_API_KEY_ID: 'unrelated' }, 'data-a');
  assert.equal(result.STOCKS_PAPER_MONITOR_INTERVAL_SECONDS, '120');
  assert.equal(result.STOCKS_OMNIMOD_EMERGENCY_STOP, 'true'); assert.equal(result.STOCKS_ALPACA_API_KEY_ID, '');
  assert.equal(result.STOCKS_ALPACA_DATA_FEED, 'sip'); assert.equal(result.OMNIMOD_STOCKS_DATA_DIR, 'data-a');
});

test('actual quote-only child completes and stops independently without booting Discord or requesting market data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-monitor-runtime-'));
  const statePath = join(root, 'ledger.json'); let monitor;
  try {
    const driver = join(root, 'isolated-monitor.mjs');
    const monitorModule = new URL('../src/paperPositionMonitor.js', import.meta.url).href;
    await writeFile(driver, `import { runStockPositionMonitor } from ${JSON.stringify(monitorModule)};\nconst report = await runStockPositionMonitor({ shadowDirectories: [process.env.OMNIMOD_TEST_SHADOW_DIRECTORY] });\nif (report.status === 'degraded') process.exitCode = 2;\n`);
    let signal;
    const completed = new Promise(resolve => { signal = resolve; });
    const env = { ...process.env, STOCKS_TRADING_RISK_STATE_PATH: statePath, OMNIMOD_STOCKS_DATA_DIR: root,
      STOCKS_PAPER_MONITOR_INTERVAL_SECONDS: '60', STOCKS_OMNIMOD_EMERGENCY_STOP: 'true',
      OMNIMOD_LIVE_TRADING_ENABLED: 'false', OMNIMOD_TEST_SHADOW_DIRECTORY: root };
    monitor = createStockPositionMonitor({ settings: { paperMonitor: { intervalSeconds: 60 } }, env,
      dataDirectory: root, schedulerFactory: options => {
        assert.ok(options.entry.endsWith('monitor-paper.js'));
        return createMarketScanScheduler({ ...options, entry: driver });
      }, onState: state => { if (state.lastScanFinishedAt) signal(state); } });
    monitor.start();
    let timeout;
    const result = await Promise.race([completed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Monitor child timed out')), 10000); })]).finally(() => clearTimeout(timeout));
    assert.equal(result.lastScanExitCode, 0); assert.equal(result.state, 'waiting');
    await monitor.stop(); assert.equal(monitor.snapshot().state, 'stopped');
    const report = JSON.parse(await readFile(join(root, 'paper-position-monitor.json'), 'utf8'));
    assert.equal(report.status, 'idle'); assert.equal(report.provider.requestAttempts, 0);
    await assert.rejects(readFile(statePath), { code: 'ENOENT' });
  } finally { await monitor?.stop(); await rm(root, { recursive: true, force: true }); }
});

test('idle wrapper saves a report without reading or resolving provider secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnimod-stock-monitor-idle-'));
  try {
    await mkdir(join(root, 'shadows'));
    const result = await runStockPositionMonitor({ directory: root, env: {}, shadowDirectories: [join(root, 'shadows')],
      settings: { sharedPaperStatePath: join(root, 'ledger.json'), sharedPaperEmergencyStop: true, alpacaDataFeed: 'iex',
        sharedPaperMaxQuoteAgeMs: 15000, sharedPaperMaxOpenMarkAgeMs: 300000, sharedPaperMaxSpreadPct: 0.5, paperMonitor: { intervalSeconds: 0 } },
      resolveCredentials: () => assert.fail('idle needs no credentials') });
    assert.equal(result.status, 'idle'); assert.equal(result.monitoringProfile.intervalSeconds, 0);
    assert.equal(JSON.parse(await readFile(join(root, 'paper-position-monitor.json'), 'utf8')).bot, 'stocks');
  } finally { await rm(root, { recursive: true, force: true }); }
});
