import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createForexRequestGate, requestForexJson } from '../src/providerRequest.js';

test('a later request cannot inherit a cooldown beyond its local waiting limit', async () => {
  let now = 100_000, calls = 0;
  const metrics = [];
  const gate = createForexRequestGate({ now: () => now, sleep: async (ms) => { now += ms; } });
  gate.defer('OANDA practice', 60_000);
  await assert.rejects(requestForexJson('https://example.test/pricing', {
    requestGate: gate, clock: () => now, maxGateWaitMs: 2_000, metrics,
    fetcher: async () => { calls++; return new Response('{"prices":[]}'); },
  }), { code: 'FOREX_COOLDOWN_DEFERRED' });
  assert.equal(calls, 0);
  assert.equal(now, 100_000);
  assert.equal(metrics[0].requestAttempted, false);
});

test('Forex runner refreshes aged primary and conversion quotes after history work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-fx-decision-baseline-'));
  try {
    const mock = join(dir, 'mock.mjs');
    await writeFile(mock, `
let now = Date.parse('2026-10-06T15:00:00Z');
Date.now = () => now;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const json = (body) => new Response(JSON.stringify(body));
  if (url.pathname.endsWith('/instruments')) return json({ instruments: ['EUR_USD','GBP_JPY','USD_JPY'].map(name => ({ name, type:'CURRENCY' })) });
  if (url.pathname.endsWith('/pricing')) return json({ prices: url.searchParams.get('instruments').split(',').map(instrument => ({
    instrument, status:'tradeable', time:new Date(now).toISOString(),
    bids:[{price:instrument.endsWith('JPY') ? '150' : '1.103'}], asks:[{price:instrument.endsWith('JPY') ? '150.01' : '1.10302'}]
  })) });
  if (url.pathname.endsWith('/candles')) {
    now += 75_000;
    const step = url.searchParams.get('granularity') === 'M15' ? 900_000 : 3_600_000;
    const end = Math.floor(now / step) * step;
    return json({ candles:Array.from({length:120},(_,i)=>({ complete:true, time:new Date(end-(120-i)*step).toISOString(),
      mid:{o:'1.1',h:'1.11',l:'1.09',c:'1.105'} })) });
  }
  throw new Error('Unexpected external request');
};
`);
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href,
      fileURLToPath(new URL('../src/index.js', import.meta.url))], {
      cwd:dir, encoding:'utf8', timeout:20_000,
      env:{ ...process.env, FOREX_SOURCE:'oanda-practice', OANDA_ENV:'practice', OANDA_ACCOUNT_ID:'fixture-account', OANDA_API_TOKEN:'fixture-token',
        FOREX_DYNAMIC_DISCOVERY:'true', FOREX_INSTRUMENTS:'EUR_USD,GBP_JPY', FOREX_MAX_SCAN_INSTRUMENTS:'2', FOREX_GRANULARITIES:'M15,H1',
        TRADING_RISK_STATE_PATH:join(dir,'ledger.json'), OMNIMOD_SIGNAL_RESEARCH_PATH:join(dir,'signals.jsonl'), OMNIMOD_FORWARD_SHADOW_STATE_DIR:join(dir,'shadow'),
        OMNIMOD_EMERGENCY_STOP:'true', OMNIMOD_LIVE_TRADING_ENABLED:'false', DISCORD_TOKEN:'', DISCORD_WEBHOOK_URL:'', DISCORD_DELIVERY_MODE:'webhook',
        PAPER_ACCOUNT_EQUITY_USD:'0', FOREX_CATALYST_SOURCE:'manual',
      },
    });
    assert.equal(run.status,0,run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.observations.length,2);
    assert.equal(report.observations.filter(row => row.bias === 'STALE QUOTE').length,0);
    assert.equal(report.observations.find(row => row.instrument === 'GBP_JPY').usdConversion.status,'converted');
    assert.equal(report.scanDiagnostics.provider.latencyByOperation['decision-pricing'].requests,3);
    assert.equal(report.scanDiagnostics.decisionQuotes.production.refreshed,2);
    assert.equal(report.scanDiagnostics.decisionQuotes.shadow.refreshed,1);
    assert.ok(report.observations.every(row => row.quoteAgeSeconds === 0));
    assert.equal(run.stdout.includes('fixture-token'),false);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\'));
    await rm(dir,{recursive:true,force:true});
  }
});
