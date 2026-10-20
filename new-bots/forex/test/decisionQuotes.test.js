import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshForexDecisionQuotes, summarizeDecisionQuotes } from '../src/decisionQuotes.js';
import { createForexRequestGate, requestForexJson } from '../src/providerRequest.js';
import { summarizeForexScan } from '../src/diagnostics.js';
import { evaluateForexDayBreakout } from '../src/dayStrategy.js';
import { evaluatePaperCandidate, reservePaperCandidate, readPaperRiskLedger } from '../../shared/paperRisk.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NOW = Date.parse('2026-10-06T15:00:00Z');
const price = (instrument, at = NOW, patch = {}) => ({ instrument, status:'tradeable', time:new Date(at).toISOString(),
  bids:[{price:'1.103'}], asks:[{price:'1.10302'}], ...patch });
const load = (options = {}) => refreshForexDecisionQuotes({ instrument:'EUR_USD', clock:()=>NOW,
  fetchPrices:async pairs => ({ prices:pairs.map(pair=>price(pair)) }), ...options });

test('reuses recent quotes without any history or pricing request', async () => {
  const original = price('EUR_USD',NOW-15_000);
  const result = await load({ quoteRows:{EUR_USD:original},fetchPrices:async()=>assert.fail('fresh cache should be reused') });
  assert.equal(result.price,original);
  assert.equal(result.diagnostics.status,'reused');
  assert.equal(result.diagnostics.beforeAgeMs.EUR_USD,15_000);
  assert.equal(result.quoteConversion.quoteToUsd,1);
});

test('refreshes an aged conversion with its primary in a single batch and uses conservative USD sides', async () => {
  let pairs;
  const cache = { GBP_JPY:price('GBP_JPY'),USD_JPY:price('USD_JPY',NOW-40_000) };
  const result = await load({ instrument:'GBP_JPY',availableInstruments:['GBP_JPY','USD_JPY'],quoteRows:cache,
    fetchPrices:async requested => { pairs=requested; return {prices:[price('GBP_JPY'),price('USD_JPY',NOW,{bids:[{price:'149'}],asks:[{price:'150'}]})]}; } });
  assert.deepEqual(pairs,['GBP_JPY','USD_JPY']);
  assert.equal(result.quoteConversion.quoteToUsd,1/149);
  assert.equal(result.quoteConversion.gainQuoteToUsd,1/150);
  assert.equal(cache.USD_JPY.time,new Date(NOW).toISOString());
  assert.equal(result.diagnostics.status,'refreshed');
});

test('uses half the configured freshness allowance when it is tighter than 30 seconds', async () => {
  const result = await load({ maxQuoteAgeMs:15_000,quoteRows:{EUR_USD:price('EUR_USD',NOW-8_000)} });
  assert.equal(result.diagnostics.status,'refreshed');
});

test('never reuses old cache after a failed refresh and does not expose provider errors or credentials', async () => {
  const cache = { EUR_USD:price('EUR_USD',NOW-35_000) };
  const result = await load({quoteRows:cache,fetchPrices:async()=>{throw new Error('private token and URL');}});
  assert.equal(result.price,null);
  assert.equal(cache.EUR_USD,undefined);
  assert.equal(result.diagnostics.rejections[0].reason,'decision_quote_request_failed');
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('duplicate, missing, stale, future, malformed and non-tradeable prices cannot become executable', async () => {
  const cases = [
    {prices:[price('EUR_USD'),price('EUR_USD')]}, {prices:[price('GBP_USD')]}, {prices:[price('EUR_USD',NOW-121_000)]},
    {prices:[price('EUR_USD',NOW+5_001)]}, {prices:[price('EUR_USD',NOW,{asks:[{price:'1'}]})]},
    {prices:[price('EUR_USD',NOW,{tradeable:false})]}, {},
  ];
  for (const payload of cases) {
    const result = await load({fetchPrices:async()=>payload});
    assert.equal(result.price,null,JSON.stringify(payload));
    assert.equal(result.diagnostics.status,'failed');
  }
});

test('validates source timestamps at receipt rather than before request latency', async () => {
  let at=NOW;
  const result = await load({clock:()=>at,fetchPrices:async()=>{at+=121_000;return{prices:[price('EUR_USD')]};}});
  assert.equal(result.price,null);
  assert.equal(result.diagnostics.afterAgeMs.EUR_USD,121_000);
  assert.equal(result.diagnostics.durationMs,121_000);
});

test('unsupported conversions and missing conversion prices remain unavailable', async () => {
  const unsupported=await load({instrument:'EUR_ZAR',availableInstruments:['EUR_ZAR']});
  assert.equal(unsupported.quoteConversion.status,'unsupported_quote_currency');
  assert.equal(unsupported.quoteConversion.quoteToUsd,null);
  const missing=await load({instrument:'EUR_JPY',availableInstruments:['EUR_JPY','USD_JPY'],fetchPrices:async()=>({prices:[price('EUR_JPY')]})});
  assert.equal(missing.quoteConversion.status,'conversion_quote_missing');
  assert.equal(missing.quoteConversion.quoteToUsd,null);
  assert.equal(missing.diagnostics.status,'failed');
});

test('deferred attempts are recorded without inflating HTTP requests, failures, latency or quota usage', async () => {
  const gate = createForexRequestGate({now:()=>NOW});
  gate.defer('OANDA practice',60_000);
  const metrics=[];
  const result=await load({fetchPrices:pairs=>requestForexJson('https://fixture.test/pricing',{
    instruments:pairs,requestGate:gate,clock:()=>NOW,maxGateWaitMs:2_000,metrics,fetcher:async()=>assert.fail('must not reach HTTP'),
  })});
  assert.equal(result.diagnostics.rejections[0].reason,'decision_quote_cooldown_deferred');
  const report=summarizeForexScan({providerMetrics:metrics,source:'oanda-practice'});
  assert.equal(report.provider.requests,0);
  assert.equal(report.provider.failures,0);
  assert.equal(report.provider.localDeferrals,1);
  assert.equal(report.provider.rateLimitEstimate,null);
  assert.equal(report.provider.latencyByOperation['market-data'].averageLatencyMs,null);
  assert.equal(summarizeDecisionQuotes([result.diagnostics]).failed,1);
});

test('cooldown extension and timer overshoot are checked before a request is released', async () => {
  for (const overshoot of [false,true]) {
    let at=NOW;
    const gate=createForexRequestGate({now:()=>at,sleep:async ms=>{
      at+=ms+(overshoot?5_000:0);
      if(!overshoot)gate.defer('OANDA practice',20_000);
    }});
    gate.defer('OANDA practice',1_000);
    await assert.rejects(gate('OANDA practice',{maxWaitMs:2_000}),{code:'FOREX_COOLDOWN_DEFERRED'});
  }
});

const candles = (count,step) => Array.from({length:count},(_,i)=> {
  const c=1.1+i*0.0001;
  return {complete:true,time:new Date(NOW-(count-i)*step).toISOString(),mid:{o:c-0.00005,h:c+0.0001,l:c-0.0001,c}};
});
function candidateInput() {
  const m15=candles(30,900_000);
  m15.at(-1).mid={o:1.1021,c:1.103,h:1.1031,l:1.102};
  return {instrument:'EUR_GBP',quote:{bid:1.103,ask:1.10302,time:new Date(NOW).toISOString(),quality:'executable'},
    m15,h1:candles(80,3_600_000),now:NOW,sessionDate:'2026-10-06',
    catalystReview:{status:'clear',source:'fixture calendar',summary:'reviewed fixture window',reviewedAt:NOW},
    config:{quoteToUsd:1.26,gainQuoteToUsd:1.25,roundTripFeesPerUnit:0.00001,slippageReservePerUnit:0.00001,
      conversionQuoteTime:new Date(NOW-20_000).toISOString()}};
}

test('conversion time limits pending entry without weakening the completed-history or quote gates', () => {
  const input=candidateInput();
  const result=evaluateForexDayBreakout(input);
  assert.equal(result.status,'candidate',JSON.stringify(result));
  assert.equal(Date.parse(result.candidate.entryExpiresAt),NOW+100_000);
  const stale=evaluateForexDayBreakout({...input,config:{...input.config,conversionQuoteTime:new Date(NOW-121_000).toISOString()}});
  assert.ok(stale.reasons.includes('stale_or_future_conversion_quote'));
  const oldBars=evaluateForexDayBreakout({...input,m15:input.m15.map(row=>({...row,time:new Date(Date.parse(row.time)-3_600_000).toISOString()}))});
  assert.ok(oldBars.reasons.includes('stale_or_incomplete_m15_bar'));
  const usd=evaluateForexDayBreakout({...input,instrument:'EUR_USD',config:{...input.config,quoteToUsd:1,gainQuoteToUsd:1,conversionQuoteTime:null}});
  assert.equal(usd.candidate.entryExpiresAt,'2026-10-06T20:44:00.000Z');
});

test('reservation rejects conversion expiry during ledger acquisition even if primary price remains fresh', async () => {
  const dir=await mkdtemp(join(tmpdir(),'omnimod-fx-conversion-expiry-'));
  try {
    const candidate=evaluateForexDayBreakout(candidateInput()).candidate;
    const decision=evaluatePaperCandidate(candidate,{accountEquity:10_000},{now:NOW,emergencyStop:false,maxGrossExposurePct:200,
      maxTradeRiskPct:0.05,maxQuoteAgeMs:120_000});
    assert.equal(decision.status,'paper-approved',JSON.stringify(decision));
    const statePath=join(dir,'ledger.json');
    const result=await reservePaperCandidate(candidate,decision,{statePath,now:NOW,observationClock:()=>NOW+100_001,emergencyStop:false});
    assert.notEqual(result.status,'reserved');
    assert.match(result.reason,/entry/);
    assert.equal((await readPaperRiskLedger({statePath})).orders.length,0);
  } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));await rm(dir,{recursive:true,force:true});}
});
