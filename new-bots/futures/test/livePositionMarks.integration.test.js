import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Futures runner applies Databento live top-of-book marks to the shared paper ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-live-marks-'));
  const now = Date.now();
  const statePath = join(directory, 'paper-ledger.json');
  const universePath = join(directory, 'futures-universe.json');
  const sessionPath = join(directory, 'futures-session.json');
  const preloadPath = join(directory, 'mock-databento-live.mjs');
  try {
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, events: [], orders: [{
      orderId: 'open-future-1', owner: 'futures', assetClass: 'future', status: 'open', instrumentKey: 'CME_ESZ6',
      future: { contractId: 'CME_ESZ6', providerRawSymbol: 'ESZ6', expiry: '2026-12-18', tickSize: 0.25, multiplier: 50,
        activeContract: true, contractSpecVerified: true, specSource: 'https://example.test/fixture-contract', specVerifiedAt: new Date(now - 86_400_000).toISOString() },
      entryPrice: 5000, fillPrice: 5000, stopPrice: 4990, targetPrice: 5020, direction: 'long', units: 1, multiplier: 50,
      riskUsd: 500, notionalUsd: 250000, marginRequirementUsd: 12000,
      roundTripFeesPerUnit: 2, slippageReservePerUnit: 1, quoteTime: new Date(now - 10_000).toISOString(), filledAt: new Date(now - 10_000).toISOString(),
      forceExitAt: new Date(now + 60 * 60_000).toISOString(), sessionDate: new Date(now).toISOString().slice(0, 10), sessionTimeZone: 'America/Chicago',
    }] }));
    await writeFile(universePath, JSON.stringify([{ symbol: 'ES', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }]));
    await writeFile(sessionPath, JSON.stringify({ dayTrades: [], marks: [] }));
    await writeFile(preloadPath, `
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
const now = Date.now();
net.connect = ({ host, port }) => {
  if (host !== 'glbx-mdp3.lsg.databento.com' || port !== 13000) throw new Error('unexpected live endpoint');
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = (value) => {
    if (value.startsWith('auth=')) queueMicrotask(() => socket.emit('data', Buffer.from('success=1|session_id=1\\n')));
    if (value === 'start_session=0\\n') queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify({ hd: { rtype: 22, publisher_id: 0, instrument_id: 123 }, stype_in_symbol: 'ESZ6', stype_out_symbol: 'ESZ6', start_ts: null, end_ts: null }) + '\\n' + JSON.stringify({ hd: { rtype: 1, publisher_id: 1, instrument_id: 123, ts_event: new Date(now - 300).toISOString() }, flags: 128,
      ts_recv: new Date(now - 300).toISOString(), ts_out: new Date(now - 100).toISOString(),
      levels: [{ bid_px: '5000', ask_px: '5000.25', bid_sz: 5, ask_sz: 5 }] }) + '\\n')));
    return true;
  };
  queueMicrotask(() => socket.emit('data', Buffer.from('lsg_version=0.2.0\\ncram=test\\n')));
  return socket;
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, FUTURES_SOURCE: 'manual', FUTURES_POSITION_MARK_SOURCE: 'databento-live', DATABENTO_API_KEY: 'test-only-key',
      FUTURES_FILE: universePath, FUTURES_DAY_SESSION_FILE: sessionPath, TRADING_RISK_STATE_PATH: statePath,
      OMNIMOD_EMERGENCY_STOP: 'false', OMNIMOD_LIVE_TRADING_ENABLED: 'false' };
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'futures/src/index.js')], {
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
    assert.equal(report.contractLifecycleDiagnostics.status, 'attention_required');
    assert.equal(report.contractLifecycleDiagnostics.openPositions, 1);
    assert.equal(report.contractLifecycleDiagnostics.missingOrInvalidMetadata, 1);
    assert.equal(report.contractLifecycleDiagnostics.staleSettlementReviews, 1);
    assert.equal(report.markResults.at(-1).status, 'open');
    assert.equal(report.markResults.at(-1).order.markPrice, 5000);
    const ledger = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(ledger.orders[0].status, 'open');
    assert.equal(ledger.orders[0].markPrice, 5000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
