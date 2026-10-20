import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marketDateAt } from '../../shared/marketDate.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('Futures runner replaces manual bars and quotes with replayed Databento session data before paper strategy evaluation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-day-feed-'));
  const wallNow = Date.now();
  const open = Math.floor((wallNow - 135 * 60_000) / (5 * 60_000)) * 5 * 60_000;
  const close = wallNow + 4 * 60 * 60_000;
  // Base the supplied exchange-session date on its close timestamp. This
  // remains a valid next-session fixture when the test starts late in Chicago.
  const date = marketDateAt(close, 'America/Chicago');
  const contractPath = join(directory, 'futures.json');
  const sessionPath = join(directory, 'day-session.json');
  const riskPath = join(directory, 'risk.json');
  const preloadPath = join(directory, 'mock-live.mjs');
  try {
    await writeFile(contractPath, JSON.stringify([{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }]));
    const contract = { symbol: 'ES', providerSymbol: 'ES.v.0', providerRawSymbol: 'ESZ6', contractId: 'CME_ESZ6', assetClass: 'equity-index-future',
      exposureKey: 'SPY', expiry: '2026-12-18T14:30:00.000Z', activeContract: true, contractSpecVerified: true, specSource: 'https://example.test/verified-contract',
      specVerifiedAt: new Date(wallNow - 60_000).toISOString(), multiplier: 50, tickSize: 0.25, tickValueUsd: 12.5,
      initialMarginUsd: 1000, maintenanceMarginUsd: 900, settlementReview: { settlementType: 'cash_settled',
        source: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html', reviewedAt: new Date(wallNow - 60_000).toISOString(),
        lastTradeAt: '2026-12-18T14:30:00.000Z' } };
    const trendBars = Array.from({ length: 50 }, (_, i) => ({ time: new Date(Math.floor(wallNow / 3_600_000) * 3_600_000 - (50 - i) * 3_600_000).toISOString(),
      open: 5000 + i * 0.1, high: 5001 + i * 0.1, low: 4999 + i * 0.1, close: 5000 + i * 0.1, volume: 1000 }));
    await writeFile(sessionPath, JSON.stringify({ sessionDate: date, dayTrades: [{ contract, trendBars,
      session: { marketDate: date, timeZone: 'America/Chicago', openTime: new Date(open).toISOString(), closeTime: new Date(close).toISOString(),
        source: 'https://www.cmegroup.com/markets/equities.html', reviewedAt: new Date(wallNow).toISOString() },
      catalystReview: { status: 'clear', source: 'test fixture', summary: 'No scheduled event in this isolated fixture.', reviewedAt: new Date(wallNow).toISOString() },
      config: { roundTripFeesPerContract: 2, slippageReservePerContract: 1 } }], marks: [] }));
    await writeFile(riskPath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    await writeFile(preloadPath, `
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
const open = ${open};
const now = Date.now();
net.connect = ({ host, port }) => {
  if (host !== 'glbx-mdp3.lsg.databento.com' || port !== 13000) throw new Error('unexpected live endpoint');
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = (value) => {
    if (value.startsWith('auth=')) queueMicrotask(() => socket.emit('data', Buffer.from('success=1|session_id=test\\n')));
    if (value === 'start_session=0\\n') {
      const rows = [{ hd: { rtype: 22, publisher_id: 0, instrument_id: 123 }, stype_in_symbol: 'ESZ6', stype_out_symbol: 'ESZ6', start_ts: null, end_ts: null }];
      const latestCompleteFiveMinuteGroup = Math.floor((now - open) / 300000) - 1;
      for (let i = 0; open + i * 60000 + 60000 <= now; i++) {
        const base = i < 3 ? 5000 : 5001 + (i - 3) * 0.03;
        rows.push({ hd: { rtype: 33, publisher_id: 1, instrument_id: 123, ts_event: new Date(open + i * 60000).toISOString() },
          open: base, high: base + 0.5, low: base - 0.5, close: base + 0.25,
          volume: Math.floor(i / 5) === latestCompleteFiveMinuteGroup ? 250 : 100 });
      }
      rows.push({ hd: { rtype: 23, publisher_id: 0, instrument_id: 0 }, code: 3, msg: 'Replay completed for ohlcv-1m' });
      rows.push({ hd: { rtype: 1, publisher_id: 1, instrument_id: 123, ts_event: new Date(now - 1000).toISOString() }, flags: 128, ts_recv: new Date(now - 1000).toISOString(), ts_out: new Date(now - 900).toISOString(),
        levels: [{ bid_px: 5002.75, ask_px: 5003, bid_sz: 10, ask_sz: 10 }] });
      queueMicrotask(() => socket.emit('data', Buffer.from(rows.map(JSON.stringify).join('\\n') + '\\n')));
    }
    return true;
  };
  queueMicrotask(() => socket.emit('data', Buffer.from('lsg_version=0.2.0\\ncram=test\\n')));
  return socket;
};
syncBuiltinESMExports();
`);
    const env = { ...process.env, FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'databento-live', FUTURES_POSITION_MARK_SOURCE: 'manual',
      DATABENTO_API_KEY: 'test-only-key', FUTURES_FILE: contractPath, FUTURES_DAY_SESSION_FILE: sessionPath,
      OMNIMOD_SIGNAL_RESEARCH_PATH: join(directory, 'signals.jsonl'),
      TRADING_RISK_STATE_PATH: riskPath, PAPER_ACCOUNT_EQUITY_USD: '200000', FUTURES_ROUND_TRIP_FEES_PER_CONTRACT: '2',
      FUTURES_SLIPPAGE_RESERVE_PER_CONTRACT: '1', OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false' };
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'futures/src/index.js')], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.primaryResearchContext.sourceRead.status, 'missing_file');
    assert.equal(report.primaryResearchContext.sourceRead.acceptedRecords, 0);
    for (const stage of ['inputLoadAndValidation', 'contractDiscovery', 'continuousMarketContext', 'h1Trend',
      'catalystCalendar', 'liveSessionData', 'positionMonitoring', 'dayStrategyAndRisk', 'forwardShadow']) {
      assert.equal(Number.isFinite(report.funnel.performance.stageDurationsMs[stage]), true, stage);
      assert.ok(report.funnel.performance.stageDurationsMs[stage] >= 0, stage);
    }
    assert.equal(report.contractDiscovery.status, 'disabled');
    assert.equal(report.contractDiscovery.contracts.length, 0);
    assert.equal(report.dayTradeReadiness.status, 'configured_inputs_present');
    assert.equal(report.dayTradeReadiness.evaluatedRows, 1);
    assert.equal(report.liveSessionDiagnostics.status, 'complete');
    assert.equal(report.liveSessionDiagnostics.replayCompleted, true);
    assert.equal(report.dayResults[0].status, 'risk-blocked', JSON.stringify(report.dayResults[0]));
    assert.equal(report.dayResults[0].candidate?.signal?.relativeVolume > 1.5, true);
    assert.ok(report.dayResults[0].decision?.reasons.includes('emergency_stop_active'));
    assert.equal(JSON.parse(await readFile(riskPath, 'utf8')).orders.length, 0);

    const h1RiskPath = join(directory, 'h1-risk.json');
    await writeFile(h1RiskPath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    const h1Child = spawnSync(process.execPath, [join(ROOT, 'futures/src/index.js')], {
      cwd: directory,
      env: { ...env, FUTURES_DAY_DATA_SOURCE: 'manual', FUTURES_TREND_DATA_SOURCE: 'databento-historical',
        DATABENTO_API_KEY: '', TRADING_RISK_STATE_PATH: h1RiskPath },
      encoding: 'utf8', timeout: 30_000,
    });
    const h1Output = `${h1Child.stdout || ''}\n${h1Child.stderr || ''}`;
    assert.equal(h1Child.status, 0, h1Output.slice(-2_000));
    const h1Report = JSON.parse(h1Child.stdout.trim());
    assert.equal(h1Report.trendDataDiagnostics.status, 'credentials_missing');
    assert.equal(h1Report.dayResults[0].status, 'no-setup');
    assert.ok(h1Report.dayResults[0].reasons.includes('h1_trend_data_incomplete'));
    assert.ok(h1Report.dayResults[0].reasons.includes('databento_credentials_missing'));
    assert.equal(JSON.parse(await readFile(h1RiskPath, 'utf8')).orders.length, 0);

    const calendarRiskPath = join(directory, 'calendar-risk.json');
    await writeFile(calendarRiskPath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    const calendarChild = spawnSync(process.execPath, [join(ROOT, 'futures/src/index.js')], {
      cwd: directory,
      env: { ...env, FUTURES_DAY_DATA_SOURCE: 'manual', FUTURES_TREND_DATA_SOURCE: 'manual',
        FUTURES_CATALYST_SOURCE: 'finnhub', FINNHUB_API_KEY: '', TRADING_RISK_STATE_PATH: calendarRiskPath },
      encoding: 'utf8', timeout: 30_000,
    });
    const calendarOutput = `${calendarChild.stdout || ''}\n${calendarChild.stderr || ''}`;
    assert.equal(calendarChild.status, 0, calendarOutput.slice(-2_000));
    const calendarReport = JSON.parse(calendarChild.stdout.trim());
    assert.equal(calendarReport.economicCalendarDiagnostics.status, 'credentials_missing');
    assert.equal(calendarReport.dayResults[0].status, 'no-setup');
    assert.ok(calendarReport.dayResults[0].reasons.includes('catalyst_blackout_or_unverified'));
    assert.equal(JSON.parse(await readFile(calendarRiskPath, 'utf8')).orders.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Futures runner skips unreviewed worksheet rows before paid day, H1, and calendar feeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnimod-futures-draft-skip-'));
  const contractPath = join(directory, 'futures.json');
  const sessionPath = join(directory, 'day-session.json');
  const riskPath = join(directory, 'risk.json');
  const preloadPath = join(directory, 'guard.mjs');
  const attemptsPath = join(directory, 'attempts.json');
  try {
    await writeFile(contractPath, JSON.stringify([{ symbol: 'E-mini S&P 500', providerSymbol: 'ES.v.0', assetClass: 'equity-index-future' }]));
    await writeFile(sessionPath, JSON.stringify({ sessionDate: '2026-09-30', dayTrades: [
      { preparationStatus: 'draft_requires_manual_review', contract: { providerRawSymbol: 'ESZ6' }, session: null, quote: null },
    ], marks: [] }));
    await writeFile(riskPath, JSON.stringify({ schemaVersion: 1, events: [], orders: [] }));
    await writeFile(attemptsPath, '[]');
    await writeFile(preloadPath, `
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
const path = ${JSON.stringify(attemptsPath)};
const note = (kind) => { const rows = JSON.parse(readFileSync(path, 'utf8')); rows.push(kind); writeFileSync(path, JSON.stringify(rows)); };
globalThis.fetch = async () => { note('fetch'); throw new Error('network forbidden in fixture'); };
net.connect = () => { note('socket'); throw new Error('network forbidden in fixture'); };
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, join(ROOT, 'futures/src/index.js')], {
      cwd: directory,
      env: { ...process.env, FUTURES_SOURCE: 'manual', FUTURES_DAY_DATA_SOURCE: 'databento-live',
        FUTURES_TREND_DATA_SOURCE: 'databento-historical', FUTURES_CATALYST_SOURCE: 'finnhub',
        FUTURES_POSITION_MARK_SOURCE: 'manual', DATABENTO_API_KEY: 'fixture-key', FINNHUB_API_KEY: 'fixture-key',
        FUTURES_FILE: contractPath, FUTURES_DAY_SESSION_FILE: sessionPath, TRADING_RISK_STATE_PATH: riskPath,
        OMNIMOD_EMERGENCY_STOP: 'true', OMNIMOD_LIVE_TRADING_ENABLED: 'false' },
      encoding: 'utf8', timeout: 30_000,
    });
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    assert.equal(child.status, 0, output.slice(-2_000));
    const report = JSON.parse(child.stdout.trim());
    assert.equal(Number.isFinite(report.funnel.performance.stageDurationsMs.dayStrategyAndRisk), true);
    assert.equal(report.funnel.performance.stageDurationsMs.h1Trend >= 0, true);
    assert.equal(report.dayTradeReadiness.status, 'draft_contracts_only');
    assert.equal(report.dayTradeReadiness.evaluatedRows, 0);
    assert.equal(report.dayTradeReadiness.draftsSkipped, 1);
    assert.equal(report.dayResults.length, 0);
    assert.equal(report.liveSessionDiagnostics.status, 'no_day_trades');
    assert.equal(report.trendDataDiagnostics.status, 'no_day_trades');
    assert.equal(report.economicCalendarDiagnostics.status, 'no_day_trades');
    assert.deepEqual(report.providerMetrics, []);
    assert.deepEqual(JSON.parse(await readFile(attemptsPath, 'utf8')), []);
    assert.deepEqual(JSON.parse(await readFile(riskPath, 'utf8')).orders, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
