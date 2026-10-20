import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('worker persists provider telemetry and unknown funnel counts when market discovery and fallback fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-crypto-failed-scan-'));
  const dataDirectory = join(directory, 'data');
  const preloadPath = join(directory, 'fail-providers.mjs');
  try {
    await writeFile(preloadPath, `
globalThis.fetch = async () => new Response('test provider outage', { status: 503, headers: { 'content-type': 'text/plain' } });
`);
    const workerScript = `
const app = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/index.js')).href)});
let failed = false;
try { await app.runGuildScan('isolated-failure-guild', { forceProvider: true }); }
catch { failed = true; }
const runtime = app.getRuntimeState();
await app.shutdown('integration-test');
process.stdout.write('\\n__RESULT__' + JSON.stringify({ failed, diagnostics: runtime.lastScanDiagnostics }));
`;
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, '--input-type=module', '-e', workerScript], {
      cwd: directory, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, NODE_ENV: 'test', OMNIMOD_TEST_SKIP_DISCORD_LOGIN: '1',
        OMNIMOD_TEST_ISOLATE_DATA_DIR: '1',
        OMNIMOD_CRYPTO_DATA_DIR: dataDirectory, OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
        COINGECKO_API_KEY: '', COINGECKO_API_TIER: 'public', DISCORD_TOKEN: 'test-only-token',
        DISCORD_CLIENT_ID: '000000000000000000',
        DISCORD_GUILD_ID: '', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const marker = child.stdout.lastIndexOf('__RESULT__');
    assert.notEqual(marker, -1, output.slice(-2_000));
    const result = JSON.parse(child.stdout.slice(marker + '__RESULT__'.length).trim());
    assert.equal(result.failed, true);
    assert.equal(result.diagnostics.failed, true);
    assert.equal(result.diagnostics.failureStage, 'market_snapshot');
    assert.ok(result.diagnostics.totalDurationMs >= 0);
    assert.equal(result.diagnostics.funnel.universe, null);
    assert.equal(result.diagnostics.funnel.successfullyScanned, null);
    assert.equal(result.diagnostics.funnel.topRejectionReasons.scan_failed, 1);
    assert.ok(result.diagnostics.providers.CoinGecko.failures > 0);
    assert.ok(result.diagnostics.providers.CoinPaprika.failures > 0);

    const diagnosticFiles = (await readdir(dataDirectory)).filter((name) => name.startsWith('scan-diagnostic-isolated-failure-guild-'));
    assert.equal(diagnosticFiles.length, 1);
    const persisted = JSON.parse(await readFile(join(dataDirectory, diagnosticFiles[0]), 'utf8'));
    assert.equal(persisted.failureStage, 'market_snapshot');
    assert.equal(persisted.funnel.universe, null);
    assert.ok(persisted.providers.CoinGecko.failures > 0);
    assert.ok(persisted.providers.CoinPaprika.failures > 0);
    assert.doesNotMatch(JSON.stringify(persisted), /https?:\/\//i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
