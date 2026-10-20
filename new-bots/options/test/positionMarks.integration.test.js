import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Options runner applies automatic Tradier leg marks to shared open paper positions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-options-marks-'));
  const statePath = join(directory, 'paper-ledger.json');
  const preloadPath = join(directory, 'mock-tradier.mjs');
  const inputPath = join(directory, 'options-session.json');
  const now = Date.now();
  const expiry = new Date(now + 4 * 86_400_000).toISOString().slice(0, 10);
  const datePart = expiry.replaceAll('-', '').slice(2);
  const long = `SPY${datePart}C00100000`, short = `SPY${datePart}C00103000`;
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'open-options-position', owner: 'options', assetClass: 'option', status: 'open',
      instrumentKey: `${long}+${short}`, exposureKey: 'SPY', option: { expiry, strategy: 'bull-call-debit-vertical', longLeg: { symbol: long, strike: 100 }, shortLeg: { symbol: short, strike: 103 } },
      entryPrice: 1.1, fillPrice: 1.1, stopPrice: 0.55, targetPrice: 2.1, direction: 'long', units: 1, multiplier: 100,
      riskUsd: 55.2, notionalUsd: 110, marginRequirementUsd: 0,
      roundTripFeesPerUnit: 0.1, slippageReservePerUnit: 0.1, quoteTime: new Date(now - 10_000).toISOString(),
      filledAt: new Date(now - 10_000).toISOString(), forceExitAt: new Date(now + 60 * 60_000).toISOString(),
      sessionDate: new Date(now).toISOString().slice(0, 10), sessionTimeZone: 'America/New_York',
    }] }));
    await writeFile(inputPath, JSON.stringify({ signals: [], marks: [] }));
    await writeFile(preloadPath, `
const now = Date.now();
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const body = url.pathname.endsWith('/clock')
    ? { clock: { state: 'open', timestamp: new Date(now).toISOString(), next_change: new Date(now + 60 * 60_000).toISOString() } }
    : { quotes: { quote: [
      { symbol: '${long}', underlying: 'SPY', expiration_date: '${expiry}', option_type: 'call', strike: 100, contract_size: 100, bid: 2, ask: 2.05, bid_date: now - 1_000, ask_date: now - 1_000, greeks: { delta: 0.6, gamma: 0.02, theta: -0.03, vega: 0.07, mid_iv: 0.3, updated_at: new Date(now - 20 * 60_000).toISOString() } },
      { symbol: '${short}', underlying: 'SPY', expiration_date: '${expiry}', option_type: 'call', strike: 103, contract_size: 100, bid: 1, ask: 1.05, bid_date: now - 1_000, ask_date: now - 1_000, greeks: { delta: 0.25, gamma: 0.01, theta: -0.02, vega: 0.04, mid_iv: 0.25, updated_at: new Date(now - 20 * 60_000).toISOString() } },
    ] } };
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
};
`);
    const env = { ...process.env, OPTIONS_SOURCE: 'tradier', OPTIONS_SIGNAL_SOURCE: 'manual', TRADIER_ENV: 'production', TRADIER_TOKEN: 'integration-test',
      OPTIONS_SESSION_FILE: inputPath, TRADING_RISK_STATE_PATH: statePath, OMNIMOD_FORWARD_SHADOW_STATE_DIR: join(directory, 'forward-shadow'),
      OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' };
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'options/src/index.js')], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-1_500));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.positionMarkDiagnostics.status, 'complete');
    assert.equal(report.positionMarkDiagnostics.quoted, 1);
    assert.equal(report.positionMarkDiagnostics.expectedPositions, 1);
    assert.equal(report.positionMarkDiagnostics.freshPositions, 1);
    assert.equal(report.positionMarkDiagnostics.quoteRejected, 0);
    assert.equal(report.positionMarkDiagnostics.staleOrUnmarkedPositions, 0);
    assert.equal(report.forwardShadow.filter((track) => track.id !== 'independent-orb').length, 3, 'production Tradier mode should retain the three existing forward research tracks');
    const independent = report.forwardShadow.find((track) => track.id === 'independent-orb');
    assert.equal(independent.manifest.status, 'waiting_for_inputs');
    assert.equal(independent.counts.reservations, 0);
    assert.ok(report.forwardShadow.every((track) => track.mode === 'forward_shadow_paper'));
    assert.equal(report.optionExpiryDiagnostics.missingOrInvalidExpiry, 0);
    assert.equal(report.optionExpiryDiagnostics.openPositions, 1);
    assert.equal(report.markResults.at(-1).status, 'open');
    assert.equal(report.markResults.at(-1).order.markPrice, 0.95);
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].markPrice, 0.95);
    assert.equal(ledger.orders[0].status, 'open');
    assert.equal(ledger.orders[0].latestOptionGreekContext.net.delta, 0.35);
    assert.equal(ledger.events.filter((event) => event.type === 'option_greeks_marked').length, 1);
  } finally {
    const rel = relative(tmpdir(), directory); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    await rm(directory, { recursive: true, force: true });
  }
});
