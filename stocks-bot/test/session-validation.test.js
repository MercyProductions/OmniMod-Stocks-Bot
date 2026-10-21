import test from 'node:test';
import assert from 'node:assert/strict';
import {observeSession} from '../scripts/validate-market-session.js';

test('closed session never calls providers or fabricates a live observation',async()=>{
  let calls=0;
  const r=await observeSession({expectedSession:'regular',now:()=>new Date('2026-10-21T01:00:00Z'),probe:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(r.status,'outside_expected_session');
});
test('session observations persist real counts without invoking execution',async()=>{
  const saved=[];let sleeps=0;
  const r=await observeSession({expectedSession:'pre_market',samples:2,now:()=>new Date('2026-10-21T12:30:00Z'),
    probe:async()=>({directory:{status:'screen_complete'},eligibleUniverseSize:7000,candidateCount:4}),
    sleep:async()=>{sleeps++;},save:async record=>saved.push(record)});
  assert.equal(r.samples,2);assert.equal(sleeps,1);assert.equal(saved[0].candidateCount,4);
  assert.equal(saved[0].liveTradingEnabled,false);assert.equal(saved[0].productionStrategyInvoked,false);
});
test('three provider failures halt the bounded observer',async()=>{
  const r=await observeSession({expectedSession:'regular',now:()=>new Date('2026-10-21T15:00:00Z'),
    probe:async()=>{throw new Error('private provider response');},sleep:async()=>{}});
  assert.equal(r.samples,3);assert.equal(r.consecutiveFailures,3);
});
test('observer rejects unbounded frequency and sample count',async()=>{
  await assert.rejects(observeSession({expectedSession:'regular',samples:1000}));
  await assert.rejects(observeSession({expectedSession:'regular',intervalMs:1}));
});
