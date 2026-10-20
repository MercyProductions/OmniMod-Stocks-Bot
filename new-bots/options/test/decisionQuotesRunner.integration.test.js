import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOptionDayTradeCandidate } from '../src/strategies.js';
import { evaluatePaperCandidate, reservePaperCandidate } from '../../shared/paperRisk.js';
import { fixture } from './helpers/optionFillFixture.js';
const NOW = Date.parse('2026-10-02T15:00:00Z');
async function run(t, { delay = 15000, waitInLedger = false, position = false, primaryAge = 0,
  pending = false, pendingReviewBlocked = false, executionWait = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'omnimod-options-decision-'));
  t.after(async () => { const rel = relative(tmpdir(), dir); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..')); await rm(dir, { recursive: true, force: true }); });
  const input = join(dir,'input.json'), ledger = join(dir,'ledger.json'), preload = join(dir,'preload.mjs');
  await writeFile(ledger, JSON.stringify({schemaVersion:1,orders:position?[{
    orderId:'held-spread',owner:'options',assetClass:'option',status:'open',instrumentKey:'SPY261006C00100000+SPY261006C00103000',exposureKey:'SPY',
    option:{underlyingSymbol:'SPY',expiry:'2026-10-06',strategy:'bull-call-debit-vertical',longLeg:{symbol:'SPY261006C00100000',strike:100},shortLeg:{symbol:'SPY261006C00103000',strike:103}},
    entryPrice:1.1,fillPrice:1.1,stopPrice:0.55,targetPrice:2.1,direction:'long',units:1,multiplier:100,riskUsd:55.2,notionalUsd:110,marginRequirementUsd:0,
    roundTripFeesPerUnit:0.1,slippageReservePerUnit:0.1,quoteTime:new Date(NOW-10000).toISOString(),filledAt:new Date(NOW-10000).toISOString(),
    forceExitAt:'2026-10-02T19:55:00.000Z',sessionDate:'2026-10-02',sessionTimeZone:'America/New_York',accountEquityUsd:50000
  }]:[],events:[]}));
  if (pending) {
    const row = fixture(); row.now = NOW - 1000; row.signal.observedAt = new Date(NOW - 1000).toISOString();
    const candidate = buildOptionDayTradeCandidate(row).candidate;
    const decision = evaluatePaperCandidate(candidate, { accountEquity: 50000, openPositions: [], realizedPnlToday: 0 },
      { now: NOW - 1000, maxQuoteAgeMs: 10000, maxSpreadPct: 25, minRewardRisk: 1.5 }, { emergencyStop: false, liveEnabled: false });
    const reserved = await reservePaperCandidate(candidate, decision, { statePath: ledger, now: NOW - 1000, emergencyStop: false });
    assert.equal(reserved.status, 'reserved');
  }
  await writeFile(input, JSON.stringify({signals:[{signal:{underlyingSymbol:'SPY', direction:'long', underlyingPrice:100, underlyingTarget:104,
    sessionDate:'2026-10-02', sessionClose:'2026-10-02T20:00:00.000Z', sessionOpen:true, observedAt:new Date(NOW-primaryAge).toISOString(), entryLow:99,entryHigh:101,
    catalystReview:{status:pendingReviewBlocked?'blocked':'clear',source:'manual-review',summary:'Synthetic catalyst review.',reviewedAt:new Date(NOW).toISOString()},
    optionAssignmentReview:{status:'clear',source:'https://issuer.example/dividends',summary:'Synthetic assignment review.',reviewedAt:new Date(NOW).toISOString(),reviewedThrough:'2026-10-06',nextExDividendDate:null}}}]}));
  await writeFile(preload, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
let offset=0; const started=performance.now();
Date.now=()=>${NOW}+offset+Math.floor(performance.now()-started);
const read=fs.readFile;
fs.readFile=async function(path,...args){
  if (${waitInLedger} && String(path)===${JSON.stringify(ledger)} && new Error().stack.includes('reservePaperCandidate')) offset+=15000;
  if (${executionWait} && String(path)===${JSON.stringify(ledger)} && new Error().stack.includes('processPaperQuote')) offset+=15000;
  return read.call(this,path,...args);
}; syncBuiltinESMExports();
globalThis.fetch=async (target,init={})=>{
 const url=new URL(target); if (url.hostname!=='api.tradier.com' || (init.method || 'GET')!=='GET') throw new Error('Unexpected external request');
 await fs.appendFile(${JSON.stringify(join(dir,'calls.jsonl'))},JSON.stringify({path:url.pathname,symbols:url.searchParams.get('symbols'),at:Date.now()})+'\\n');
 if(url.pathname.endsWith('/chains')) offset+=${delay};
 if (${position} && url.pathname.endsWith('/quotes') && !url.searchParams.get('symbols').split(',').includes('SPY')) offset+=15000;
 const time=Date.now(), iso=new Date(time).toISOString();
 const legs=[{symbol:'SPY261006C00100000',strike:100,bid:2,ask:2.05},{symbol:'SPY261006C00103000',strike:103,bid:1,ask:1.05}].map(v=>({...v,underlying:'SPY',root_symbol:'SPY',expiration_date:'2026-10-06',option_type:'call',contract_size:100,bid_date:time,ask_date:time,volume:100,open_interest:500}));
 let body;
 if(url.pathname.endsWith('/clock')) body={clock:{state:'open',timestamp:iso,next_change:'2026-10-02T20:00:00Z'}};
 else if(url.pathname.endsWith('/quotes')) body={quotes:{quote:url.searchParams.get('symbols').split(',').map(symbol=>symbol==='SPY'?{symbol,bid:99.99,ask:100.01,bid_date:time,ask_date:time}:legs.find(v=>v.symbol===symbol))}};
 else if(url.pathname.endsWith('/expirations')) body={expirations:{date:['2026-10-06']}};
 else if(url.pathname.endsWith('/chains')) body={options:{option:legs}};
 else throw new Error('Unexpected endpoint');
 return {ok:true,status:200,headers:new Headers(),json:async()=>body};
};`);
  const env={...process.env,OPTIONS_SOURCE:'tradier',OPTIONS_SIGNAL_SOURCE:'manual',TRADIER_ENV:'production',TRADIER_TOKEN:'fixture',
    OPTIONS_SESSION_FILE:input,TRADING_RISK_STATE_PATH:ledger,TRADIER_SHARED_RATE_DIR:join(dir,'budget'),
    OPTIONS_CATALYST_SOURCE:'manual',OPTIONS_CATALYST_REVIEW_FILE:'',OPTIONS_ASSIGNMENT_DATA_SOURCE:'manual',OPTIONS_DISCOVERY_SOURCE:'disabled',OPTIONS_CONTRACT_DISCOVERY_SOURCE:'disabled',
    OPTIONS_INTRADAY_RESEARCH_SOURCE:'disabled',OPTIONS_INDEPENDENT_PAPER_SOURCE:'disabled',
    OMNIMOD_FORWARD_SHADOW_STATE_DIR:join(dir,'shadow'),OMNIMOD_SIGNAL_RESEARCH_PATH:join(dir,'signals.jsonl'),
    PAPER_ACCOUNT_EQUITY_USD:'50000',OPTIONS_FEES_PER_CONTRACT_ROUND_TRIP:'0.65',OPTIONS_SLIPPAGE_RESERVE_PER_CONTRACT:'0.25',
    OMNIMOD_EMERGENCY_STOP:waitInLedger||pending?'false':'true',OMNIMOD_LIVE_TRADING_ENABLED:'false',DISCORD_TOKEN:'',DISCORD_WEBHOOK_URL:'',DISCORD_DELIVERY_MODE:'webhook'};
  const child=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('../src/index.js',import.meta.url))],{cwd:dir,env,timeout:30000,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr); return {report:JSON.parse(child.stdout),ledger:JSON.parse(await readFile(ledger,'utf8')),calls:(await readFile(join(dir,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}
test('Options actual runner recovers quotes aged by chain loading without redownloading history',async t=>{
 const {report,calls,ledger}=await run(t);
 assert.equal(report.results[0].status,'risk-blocked',JSON.stringify(report.results));
 assert.ok(report.results[0].decision.reasons.includes('emergency_stop_active'));
 assert.equal(report.scanDiagnostics.decisionQuotes.refreshed,1);
 assert.equal(calls.filter(c=>c.path.endsWith('/chains')).length,1);
 assert.ok(calls.some(c=>c.path.endsWith('/quotes')&&c.symbols.includes('SPY261006C')));
 assert.equal(ledger.orders.length,0);
 assert.equal(report.discordDelivery.posted,false);
});
test('Options actual reservation rejects a quote that expires while reading its locked ledger',async t=>{
 const {report,ledger}=await run(t,{delay:0,waitInLedger:true});
 assert.equal(report.results[0].reservation?.reason,'quote_expired_before_reservation',JSON.stringify(report.results));
 assert.equal(report.scanDiagnostics.funnel.reservationRejected,1);
 assert.equal(report.scanDiagnostics.topRejectionReasons.quote_expired_before_reservation,1);
 assert.equal(ledger.orders.length,0);
});

test('Options actual runner preserves source expiry through acquisition and rechecks it after the ledger lock', async t => {
 const { report, ledger } = await run(t, { delay: 0, waitInLedger: true, primaryAge: 110000 });
 assert.equal(report.results[0].reservation?.reason, 'invalid_or_expired_entry_window', JSON.stringify(report.results));
 assert.equal(report.results[0].candidate.entryExpiresAt, new Date(NOW + 10000).toISOString());
 assert.equal(report.scanDiagnostics.topRejectionReasons.invalid_or_expired_entry_window, 1);
 assert.equal(ledger.orders.length, 0);
 assert.equal(report.discordDelivery.posted, false);
});

test('owned Options positions are monitored before collecting new entry quotes',async t=>{
 const {report,calls}=await run(t,{delay:0,position:true});
 const quotes=calls.filter(c=>c.path.endsWith('/quotes'));
 assert.ok(!quotes[0].symbols.split(',').includes('SPY'));
 assert.ok(quotes[1].symbols.split(',').includes('SPY'));
 assert.ok(quotes[1].at-quotes[0].at>=15000);
 assert.equal(report.positionMarkDiagnostics.quoteAccepted,1);
 assert.equal(report.results[0].status,'risk-blocked',JSON.stringify(report.results));
 assert.ok(report.results[0].decision.reasons.includes('emergency_stop_active'));
});

test('actual Options scanner fills a previously reserved spread using current underlying and review evidence', async t => {
  const { report, ledger, calls } = await run(t, { pending: true, delay: 0 });
  assert.equal(ledger.orders[0].status, 'filled', JSON.stringify(report.markResults));
  assert.equal(ledger.orders[0].optionEntryEvidence.underlyingQuote.symbol, 'SPY');
  assert.equal(report.positionMarkDiagnostics.pendingEntryReady, 1);
  assert.ok(calls.find(call => call.path.endsWith('/quotes')).symbols.split(',').includes('SPY'));
  assert.equal(report.discordDelivery.posted, false);
});

test('actual Options scanner withholds a pending fill after the current review is revoked', async t => {
  const { report, ledger } = await run(t, { pending: true, pendingReviewBlocked: true, delay: 0 });
  assert.equal(ledger.orders[0].status, 'reserved');
  assert.equal(report.positionMarkDiagnostics.pendingEntryRejections.option_entry_catalyst_clearance_required, 1);
  assert.equal(report.discordDelivery.posted, false);
});

test('actual Options scanner cannot fill from a quote that aged while awaiting its execution ledger', async t => {
  const { report, ledger } = await run(t, { pending: true, executionWait: true, delay: 0 });
  assert.equal(ledger.orders[0].status, 'reserved');
  assert.ok(report.markResults.some(result => result.reason === 'quote_not_current_and_executable'), JSON.stringify(report.markResults));
});
