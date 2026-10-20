import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('all four runners persist setup-required diagnostics without claiming live scans from fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-provider-status-'));
  try {
    for (const bot of ['forex', 'futures', 'options', 'etfs-etps']) {
      const run = spawnSync(process.execPath, [join(root, bot, 'src/index.js')], {
        cwd: directory, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, OPTIONS_DISCOVERY_SOURCE: 'disabled', FOREX_SOURCE: 'disabled', FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'manual',
          FUTURES_POSITION_MARK_SOURCE: 'manual', FUTURES_TREND_DATA_SOURCE: 'manual', FUTURES_CONTRACT_DISCOVERY_ENABLED: 'false',
          FUTURES_CATALYST_SOURCE: 'manual', FOREX_CATALYST_SOURCE: 'manual', OPTIONS_SOURCE: 'manual', OPTIONS_SIGNAL_SOURCE: 'manual',
          OPTIONS_CATALYST_SOURCE: 'manual', OPTIONS_ASSIGNMENT_DATA_SOURCE: 'manual', ETF_SOURCE: 'fixture', ETF_CATALYST_SOURCE: 'manual',
          FUTURES_FILE: join(root, 'futures/examples/futures.json'), FUTURES_DAY_SESSION_FILE: join(root, 'futures/examples/day-session.json'),
          OPTIONS_SESSION_FILE: join(root, 'options/examples/paper-session.json'), ETF_SESSION_FILE: join(root, 'etfs-etps/examples/paper-session.json'),
          OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false',
          TRADING_RISK_STATE_PATH: join(directory, 'risk.json'), OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
          OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'shadow'), DISCORD_TOKEN: '', DISCORD_WEBHOOK_URL: '', DISCORD_DELIVERY_MODE: 'webhook' },
      });
      assert.equal(run.status, 0, bot + ': ' + run.stderr.slice(-1000));
      const output = JSON.parse(run.stdout);
      const diagnostics = output.scanDiagnostics ?? output.funnel;
      assert.equal(diagnostics.marketDataReadiness.status, 'not_configured', bot);
      assert.equal(diagnostics.marketDataReadiness.automatedScanRan, false, bot);
      assert.equal(diagnostics.marketDataReadiness.evidence.providerRequests, 0, bot);
      assert.equal(output.discordDelivery.posted, false, bot);
    }
  } finally {
    const rel = relative(tmpdir(), directory);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
