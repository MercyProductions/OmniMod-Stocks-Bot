import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateFuturesOpeningRange } from '../src/dayStrategy.js';
import { evaluatePaperCandidate, reservePaperCandidate, processPaperQuote, readPaperRiskLedger } from '../../shared/paperRisk.js';

const NOW=Date.parse('2026-10-06T15:00:00Z');
const iso=at=>new Date(at).toISOString();
const contract={symbol:'ES',providerSymbol:'ES.v.0',providerRawSymbol:'ESZ6',contractId:'CME_ESZ6',assetClass:'equity-index-future',
  contractMode:'active-contract',exposureKey:'SPY',expiry:'2026-12-18T14:30:00Z',activeContract:true,contractSpecVerified:true,
  specSource:'https://example.test/spec',specVerifiedAt:iso(NOW-60_000),multiplier:50,tickSize:0.25,tickValueUsd:12.5,
  initialMarginUsd:1_000,maintenanceMarginUsd:900,settlementReview:{settlementType:'cash_settled',source:'https://example.test/settlement',
    reviewedAt:iso(NOW-60_000),lastTradeAt:'2026-12-18T14:30:00Z'}};
const session={marketDate:'2026-10-06',timeZone:'America/Chicago',openTime:iso(NOW-2*3_600_000),closeTime:iso(NOW+4*3_600_000),
  source:'https://example.test/session',reviewedAt:iso(NOW)};
const bars=Array.from({length:24},(_,i)=>({time:iso(NOW-(24-i)*300_000),open:6000,high:6001,low:5999,close:6000,volume:100}));
bars.at(-1).high=6011;bars.at(-1).close=6010;bars.at(-1).volume=250;
const trendBars=Array.from({length:60},(_,i)=>({time:iso(NOW-(60-i)*3_600_000),open:6000+i*.1,high:6001+i*.1,low:5999+i*.1,close:6000+i*.1,volume:100}));
const input={contract,session,bars,trendBars,quote:{bid:6009.75,ask:6010,time:iso(NOW),quality:'executable'},
  catalystReview:{status:'clear',source:'fixture calendar',summary:'No scheduled events in the isolated fixture.',reviewedAt:iso(NOW)},
  config:{roundTripFeesPerContract:2,slippageReservePerContract:1}};

test('Futures candidates retain the existing 30-minute pre-close entry cutoff',()=>{
  const result=evaluateFuturesOpeningRange({...input,now:NOW,accountEquityUsd:200_000});
  assert.equal(result.status,'candidate',JSON.stringify(result));
  assert.equal(result.candidate.entryExpiresAt,iso(Date.parse(session.closeTime)-30*60_000));
});

test('slow position monitoring completes before entry quotes and fresh marks use the receipt clock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'omnimod-futures-decision-timing-'));
  try {
    await writeFile(join(dir,'universe.json'),JSON.stringify([{symbol:'ES',providerSymbol:'ES.v.0',assetClass:'equity-index-future'}]));
    await writeFile(join(dir,'session.json'),JSON.stringify({sessionDate:session.marketDate,dayTrades:[input],marks:[]}));
    const initialLedger={schemaVersion:1,events:[],orders:[{orderId:'held',owner:'futures',assetClass:'future',
      status:'open',instrumentKey:'CME_ESZ6',future:{...contract,entrySession:session},units:1,multiplier:50,entryPrice:6000,fillPrice:6000,
      stopPrice:5990,targetPrice:6020,direction:'long',riskUsd:500,notionalUsd:300000,marginRequirementUsd:1000,
      roundTripFeesPerUnit:2,slippageReservePerUnit:1,quoteTime:iso(NOW-1000),filledAt:iso(NOW-1000),forceExitAt:session.closeTime,
      sessionDate:session.marketDate,sessionTimeZone:'America/Chicago'}]};
    await writeFile(join(dir,'ledger.json'),JSON.stringify(initialLedger));
    const mock=join(dir,'mock.mjs');
    await writeFile(mock,`
import {EventEmitter} from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
let now=${NOW},entryCollected=false,delayed=false;Date.now=()=>now;
const originalRead=fs.readFile;
fs.readFile=async(...args)=>{
  if(process.env.STALL_DECISION_READ==='true'&&entryCollected&&!delayed&&String(args[0]).endsWith('ledger.json')){now+=6_000;delayed=true;}
  return originalRead(...args);
};syncBuiltinESMExports();
globalThis.fetch=async()=>{
  if(process.env.STALL_CALENDAR==='true'){now+=Number(process.env.CALENDAR_DELAY_MS||6000);return new Response(JSON.stringify({economicCalendar:[]}));}
  throw new Error('Unexpected HTTP in isolated test');
};
net.connect=()=>{
  const socket=new EventEmitter();let replay=false;
  socket.setTimeout=()=>{};socket.destroy=()=>{};
  socket.write=value=>{
    if(value.startsWith('auth='))queueMicrotask(()=>socket.emit('data',Buffer.from('success=1\\n')));
    if(value.startsWith('schema=ohlcv-1m'))replay=true;
    if(value==='start_session=0\\n')queueMicrotask(()=>{
      if(!replay)now+=8_000;
      const rows=[{hd:{rtype:22,publisher_id:0,instrument_id:123},stype_in_symbol:'ESZ6',stype_out_symbol:'ESZ6',start_ts:null,end_ts:null}];
      if(replay){
        entryCollected=true;
        const candles=${JSON.stringify(bars)};
        for(const bar of candles)for(let i=0;i<5;i++)rows.push({hd:{rtype:33,publisher_id:1,instrument_id:123,ts_event:new Date(Date.parse(bar.time)+i*60000).toISOString()},
          open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume/5});
        rows.push({rtype:23,code:3,msg:'Replay completed'});
      }
      rows.push({hd:{rtype:1,publisher_id:1,instrument_id:123,ts_event:new Date(now-100).toISOString()},flags:128,
        ts_recv:new Date(now-100).toISOString(),ts_out:new Date(now-50).toISOString(),levels:[{bid_px:6009.75,ask_px:6010,bid_sz:10,ask_sz:10}]});
      socket.emit('data',Buffer.from(rows.map(JSON.stringify).join('\\n')+'\\n'));
    });return true;
  };
  queueMicrotask(()=>socket.emit('data',Buffer.from('cram=test\\n')));return socket;
};`);
    const runWith=overrides=>spawnSync(process.execPath,['--import',pathToFileURL(mock).href,fileURLToPath(new URL('../src/index.js',import.meta.url))],{
      cwd:dir,encoding:'utf8',timeout:15_000,env:{...process.env,FUTURES_SOURCE:'manual',FUTURES_DAY_DATA_SOURCE:'databento-live',
        FUTURES_TREND_DATA_SOURCE:'manual',FUTURES_POSITION_MARK_SOURCE:'databento-live',FUTURES_CATALYST_SOURCE:'manual',
        FUTURES_CONTRACT_DISCOVERY_ENABLED:'false',FUTURES_ACTIVITY_DISCOVERY_ENABLED:'false',FUTURES_ACTIVITY_ANALYSIS_ENABLED:'false',
        DATABENTO_API_KEY:'fixture-key',FUTURES_FILE:join(dir,'universe.json'),FUTURES_DAY_SESSION_FILE:join(dir,'session.json'),
        TRADING_RISK_STATE_PATH:join(dir,'ledger.json'),OMNIMOD_SIGNAL_RESEARCH_PATH:join(dir,'signals.jsonl'),
        OMNIMOD_FORWARD_SHADOW_STATE_DIR:join(dir,'shadow'),PAPER_ACCOUNT_EQUITY_USD:'200000',OMNIMOD_EMERGENCY_STOP:'true',
        OMNIMOD_LIVE_TRADING_ENABLED:'false',DISCORD_TOKEN:'',DISCORD_WEBHOOK_URL:'',DISCORD_DELIVERY_MODE:'webhook',
        OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH:join(dir,'calendar.json'),...overrides}});
    const run=runWith({});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(run.stdout);
    assert.equal(result.positionMarkDiagnostics.quoteAccepted,1,JSON.stringify(result.markResults));
    assert.equal(result.dayResults[0].status,'risk-blocked',JSON.stringify(result.dayResults));
    assert.ok(result.dayResults[0].decision.reasons.includes('emergency_stop_active'));
    assert.ok(result.providerMetrics.findIndex(row=>row.operation==='mbp-1-position-quotes')
      < result.providerMetrics.findIndex(row=>row.operation==='mbp-1-entry-quotes'));
    assert.equal(result.dayResults[0].candidate.quoteTime,iso(NOW+7_900));
    assert.equal(result.funnel.decisionTiming.decisions[0].quoteAgeMs,100);

    // A slow ledger read after strategy evaluation cannot reserve an aged quote,
    // even when the environment has a more permissive source-age setting.
    await writeFile(join(dir,'ledger.json'),JSON.stringify({schemaVersion:1,events:[],orders:[]}));
    const delayed=runWith({STALL_DECISION_READ:'true',FUTURES_POSITION_MARK_SOURCE:'manual',
      FUTURES_MAX_QUOTE_AGE_MS:'15000',OMNIMOD_EMERGENCY_STOP:'false'});
    assert.equal(delayed.status,0,delayed.stderr);
    const late=JSON.parse(delayed.stdout);
    assert.equal(late.dayResults[0].status,'risk-blocked');
    assert.ok(late.dayResults[0].decision.reasons.includes('stale_or_future_quote'));
    assert.equal(late.funnel.decisionTiming.decisions[0].riskQuoteAgeMs,6_100);
    assert.equal(late.counts.reservationsCreated,0);

    // Slow news/calendar work must not anchor the live collector in the past.
    const calendar=runWith({STALL_CALENDAR:'true',FUTURES_CATALYST_SOURCE:'finnhub',FINNHUB_API_KEY:'fixture-key',
      FUTURES_POSITION_MARK_SOURCE:'manual',FUTURES_LIVE_SESSION_TIMEOUT_MS:'100'});
    assert.equal(calendar.status,0,calendar.stderr);
    const afterCalendar=JSON.parse(calendar.stdout);
    assert.equal(afterCalendar.liveSessionDiagnostics.status,'complete',JSON.stringify(afterCalendar.liveSessionDiagnostics));
    assert.equal(afterCalendar.funnel.decisionTiming.entryFeedStartedAt,iso(NOW+6_000));
    assert.equal(afterCalendar.dayResults[0].candidate.quoteTime,iso(NOW+5_900));

    await writeFile(join(dir,'ledger.json'),JSON.stringify(initialLedger));
    const longScan=runWith({STALL_CALENDAR:'true',CALENDAR_DELAY_MS:'360000',FUTURES_CATALYST_SOURCE:'finnhub',FINNHUB_API_KEY:'fixture-key',
      OMNIMOD_EMERGENCY_STOP:'false',OMNIMOD_ECONOMIC_CALENDAR_CACHE_PATH:join(dir,'long-calendar.json')});
    assert.equal(longScan.status,0,longScan.stderr);
    const aged=JSON.parse(longScan.stdout);
    assert.equal(aged.positionMarkDiagnostics.quoteAccepted,1);
    assert.equal(aged.positionMarkDiagnostics.freshPositions,0);
    assert.equal(aged.positionMarkDiagnostics.staleOrUnmarkedPositions,1);
    assert.equal(aged.positionMarkDiagnostics.assessedAt,iso(NOW+368_000));
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));await rm(dir,{recursive:true,force:true});}
});

test('Futures reservation and pending fills honor current time and the strategy entry cutoff',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'omnimod-futures-reservation-clock-'));
  try{
    const candidate=evaluateFuturesOpeningRange({...input,now:NOW,accountEquityUsd:200_000}).candidate;
    const decision=evaluatePaperCandidate(candidate,{accountEquity:250_000},{now:NOW,emergencyStop:false,maxQuoteAgeMs:5_000,maxGrossExposurePct:500});
    assert.equal(decision.status,'paper-approved',JSON.stringify(decision));
    const statePath=join(dir,'ledger.json');
    const late=await reservePaperCandidate(candidate,decision,{statePath,now:NOW,observationClock:()=>NOW+5_001,emergencyStop:false});
    assert.equal(late.reason,'quote_expired_before_reservation');
    assert.equal((await readPaperRiskLedger({statePath})).orders.length,0);
    const ready=await reservePaperCandidate(candidate,decision,{statePath,now:NOW,observationClock:()=>NOW,emergencyStop:false});
    assert.equal(ready.status,'reserved');
    const at=Date.parse(candidate.entryExpiresAt)+1;
    const fill=await processPaperQuote(ready.order.orderId,{...input.quote,time:iso(at)},
      {statePath,now:at,maxQuoteAgeMs:5_000,emergencyStop:false,sessionOpen:true});
    assert.equal(fill.status,'cancelled');
    assert.equal((await readPaperRiskLedger({statePath})).orders[0].status,'cancelled');
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));await rm(dir,{recursive:true,force:true});}
});
