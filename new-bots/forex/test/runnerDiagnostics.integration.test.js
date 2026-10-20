import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Forex runner reports measured pipeline stage durations in disabled-data mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-forex-diagnostics-'));
  try {
    const report = spawnSync(process.execPath, [join(ROOT, 'forex/src/index.js')], {
      cwd: directory, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, FOREX_SOURCE: 'disabled', TRADING_RISK_STATE_PATH: join(directory, 'ledger.json'),
        OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'), OMNIMOD_EMERGENCY_STOP: 'false',
        OMNIMOD_LIVE_TRADING_ENABLED: 'false', OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow') },
    });
    const output = `${report.stdout || ''}\n${report.stderr || ''}`;
    assert.equal(report.status, 0, output.slice(-2_000));
    const parsed = JSON.parse(report.stdout.trim());
    const durations = parsed.scanDiagnostics.performance.stageDurationsMs;
    for (const stage of ['sharedResearchContext', 'catalystReview', 'openPositionMonitoring', 'instrumentDataAndStrategy', 'forwardShadow']) {
      assert.ok(Number.isFinite(durations[stage]) && durations[stage] >= 0, `missing measured stage ${stage}`);
    }
    assert.equal(parsed.scanDiagnostics.primaryResearchContext.sourceRead.status, 'missing_file');
    assert.equal(parsed.scanDiagnostics.primaryResearchContext.sourceRead.acceptedRecords, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
