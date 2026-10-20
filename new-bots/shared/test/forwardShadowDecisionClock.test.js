import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runForwardShadowPaper } from '../forwardShadowPaper.js';

test('asynchronous strategy data collection advances risk and journal time before shadow approval', async () => {
  const directory=await mkdtemp(join(tmpdir(),'omnimod-shadow-decision-clock-'));
  const start=Date.parse('2026-10-06T15:00:00Z');
  try {
    const input={owner:'forex',strategyVersion:'async-clock-test-v1',
      profiles:[{id:'base',overrides:{breakoutBufferAtr:0.05},hypothesis:'Measure net breakout outcomes.',
        changeMade:'Use declared buffer.',reason:'Fixture verifies prospective timing.'}],
      allowlist:['breakoutBufferAtr'],baseConfig:{},stateDirectory:directory,accountEquity:100_000,
      maxQuoteAgeMs:120_000,maxSpreadPct:0.2,riskPolicy:{emergencyStop:false,maxGrossExposurePct:500},sessionOpen:true,
      observations:[{instrument:'EUR_USD'}],now:start-1_000,evaluate:()=>({status:'no-setup',reasons:['freeze_fixture']})};
    await runForwardShadowPaper(input);
    let at=start;
    const report=await runForwardShadowPaper({...input,now:start,observationClock:()=>at,evaluate:async()=>{
      at+=6_000;
      return {status:'candidate',candidate:{mode:'paper',owner:'forex',assetClass:'forex',instrumentKey:'EUR_USD',
        exposureKey:'EUR_USD',strategyId:'fixture',sessionDate:'2026-10-06',idempotencyKey:'async-clock',
        direction:'long',bid:1.1,ask:1.1001,entryPrice:1.1001,stopPrice:1.09,targetPrice:1.13,
        multiplier:1,gainMultiplier:1,lotSize:1,roundTripFeesPerUnit:0.00001,slippageReservePerUnit:0.00001,
        quoteTime:new Date(at).toISOString(),quoteQuality:'executable',sessionOpen:true,
        entryExpiresAt:new Date(at+60_000).toISOString(),forceExitAt:new Date(at+3_600_000).toISOString()}};
    }});
    assert.equal(report[0].decisions[0].status,'reserved',JSON.stringify(report[0].decisions));
    const entries=(await readFile(report[0].journalPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.at(-1).capturedAt,new Date(at).toISOString());
  } finally {assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'\\'));await rm(directory,{recursive:true,force:true});}
});
