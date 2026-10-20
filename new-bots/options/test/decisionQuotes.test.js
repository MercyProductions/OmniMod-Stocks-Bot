import test from 'node:test';
import assert from 'node:assert/strict';
import { createOptionDecisionRefresher } from '../src/decisionQuotes.js';
import { buildOptionDayTradeCandidate } from '../src/strategies.js';
import { summarizeOptionsScan } from '../src/diagnostics.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { appendScanDiagnostic } from '../../shared/scanDiagnosticsJournal.js';
import { collectOperatorReport } from '../../shared/operatorReport.js';
const NOW=Date.parse('2026-10-02T15:00:00Z'), close='2026-10-02T20:00:00.000Z';
const config={feePerContractRoundTrip:0.65,slippageReservePerContract:0.25};
const iso=t=>new Date(t).toISOString();
function input({age=15000, count=2}={}) {
 return {marketDataStatus:'ready',primarySignalObservedAt:iso(NOW-20000),signal:{underlyingSymbol:'SPY',direction:'long',underlyingPrice:100,underlyingTarget:104,
  observedAt:iso(NOW-age),sessionDate:'2026-10-02',sessionClose:close,sessionOpen:true,entryLow:99,entryHigh:101,
  underlyingQuote:{bid:99.99,ask:100.01,time:iso(NOW-age),quality:'executable'},
  catalystReview:{status:'clear',source:'manual-review',summary:'Synthetic catalyst clearance.',reviewedAt:iso(NOW-20000)},
  optionAssignmentReview:{status:'clear',source:'https://issuer.example/dividends',summary:'Synthetic ex dividend review.',reviewedAt:iso(NOW-20000),reviewedThrough:'2026-10-06',nextExDividendDate:null}},
 chain:{expiry:'2026-10-06',source:'Tradier production',quoteQuality:'executable',options:Array.from({length:count},(_,i)=>{
 const strike=i===0?100:102+i;
 return {symbol:`SPY261006C${String(strike*1000).padStart(8,'0')}`,underlying:'SPY',root:'SPY',type:'call',strike,expiry:'2026-10-06',multiplier:100,
  bid:i===0?2:1,ask:i===0?2.05:1.05,time:iso(NOW-age),quoteQuality:'executable',volume:100,openInterest:500};})}};
}
function setup(row=input(), options={}) {
 let current=NOW;const calls=[],metrics=[];
 const fetchImpl=async(target,init)=>{
  const url=new URL(target);assert.equal(url.hostname,'api.tradier.com');assert.equal(init.method??'GET','GET');calls.push(url);
  current+=options.delay??0;
  if(options.error) return {ok:false,status:429,headers:new Headers({'Retry-After':'60'})};
  let body;
  if(url.pathname.endsWith('/clock')) body={clock:{state:'open',timestamp:iso(current),next_change:close}};
  else {assert.equal(url.pathname,'/v1/markets/quotes'); body={quotes:{quote:url.searchParams.get('symbols').split(',').map(symbol=>{
   if(symbol==='SPY')return {symbol,bid:(options.mid??100)-0.01,ask:(options.mid??100)+0.01,bid_date:current,ask_date:current};
   const leg=row.chain.options.find(v=>v.symbol===symbol);
   return {symbol,underlying:leg.underlying,expiration_date:leg.expiry,option_type:leg.type,strike:leg.strike,contract_size:100,root_symbol:'SPY',
    bid:leg.bid,ask:leg.ask,bid_date:current,ask_date:current,volume:100,open_interest:500};})}};
  }
  if(options.mutate)body=options.mutate(body,url,current);
  return {ok:true,status:200,headers:new Headers(),json:async()=>body};
 };
 const pacer=options.pacer??(async()=>({localQueueDelayMs:0}));
 const refresher=createOptionDecisionRefresher({source:'tradier',token:'fixture',environment:'production',config,clock:()=>current,
  fetchImpl,startPacer:pacer,providerMetrics:metrics,...options.settings});
 return {row,calls,metrics,...refresher,advance:ms=>{current+=ms;}, now:()=>current};
}
test('recent synchronized native quotes are reused without any provider read or retimestamp',async()=>{
 const f=setup(input({age:500}));const before=structuredClone(f.row);assert.equal(await f.refresh(f.row),f.row);
 assert.deepEqual(f.row,before);assert.equal(f.calls.length,0);assert.equal(f.diagnostics.reused,1);
});
test('aged prices refresh in one batch with frozen targets, original signal time and no metadata/history re-download',async()=>{
 const f=setup();const before=structuredClone(f.row);const row=await f.refresh(f.row);
 assert.equal(row.signal.underlyingTarget,before.signal.underlyingTarget);assert.equal(row.primarySignalObservedAt,before.primarySignalObservedAt);
 assert.deepEqual(f.row,before);assert.deepEqual(f.calls.map(u=>u.pathname),['/v1/markets/clock','/v1/markets/quotes']);
 assert.equal(buildOptionDayTradeCandidate({...row,now:f.now(),config}).status,'candidate');
 assert.equal(await f.refresh(f.row),row);assert.equal(f.calls.length,2);assert.equal(f.metrics.length,2);
 f.advance(10001);assert.equal((await f.refresh(f.row)).marketDataStatus,'decision_quotes_expired_after_refresh');assert.equal(f.calls.length,2);
});

test('primary hypothesis expiring during the quote request cannot be renewed by its fresh response', async () => {
 const row = input(); row.primarySignalObservedAt = iso(NOW - 119000);
 const f = setup(row, { delay: 600 });
 assert.equal((await f.refresh(row)).marketDataStatus, 'primary_signal_expired_during_quote_refresh');
 assert.equal(f.calls.length, 2);
 assert.equal(f.diagnostics.rows[0].entryExpiresAt, iso(NOW + 1000));
 assert.equal(f.diagnostics.refreshed, 0);
});

test('an earlier source entry deadline prevents refresh requests and cannot be extended by cached quotes', async () => {
 const row = input({ age: 500 }); row.signal.entryExpiresAt = iso(NOW);
 const f = setup(row);
 assert.equal((await f.refresh(row)).marketDataStatus, 'primary_signal_expired_before_quote_refresh');
 assert.equal(f.calls.length, 0);
});
test('all returned relevant contract identities are batched without a hidden contract cap',async()=>{
 const f=setup(input({count:80}));const row=await f.refresh(f.row);
 assert.equal(f.calls.length,4);assert.deepEqual(f.calls.slice(1).map(u=>u.searchParams.get('symbols').split(',').length),[40,40,3]);
 assert.equal(row.chain.options.filter(l=>l.quoteQuality==='executable').length,80);
 assert.equal(f.diagnostics.contractsRequested,80);
});
test('earlier batch quotes expire at final observation time and are not silently renewed',async()=>{
 const f=setup(input({count:80}),{delay:1900,settings:{config:{...config,maxQuoteAgeMs:3000}}});
 const row=await f.refresh(f.row);
 assert.equal(row.marketDataStatus,'ready');assert.equal(row.chain.options[0].quoteQuality,'unusable');
 assert.deepEqual(f.diagnostics.rows[0].contractRejections[row.chain.options[0].symbol],['quote_expired_during_collection']);
 assert.equal(row.chain.options.at(-1).time,iso(f.now()));
});
test('expired scan budget clears executable approval and never starts more quote batches',async()=>{
 const f=setup(input({count:80}),{delay:3000});const row=await f.refresh(f.row);
 assert.equal(row.marketDataStatus,'decision_quote_budget_exhausted');assert.equal(row.chain.quoteQuality,'unusable');assert.equal(f.calls.length,3);
});
test('provider failure and local budget deferral cannot fall back or start retries for each profile',async()=>{
 for(const options of [{error:true},{pacer:async()=>{throw Object.assign(new Error('queue full'),{code:'TRADIER_BUDGET_WAIT_LIMIT'});}}]){
 const f=setup(input(),options);const row=await f.refresh(f.row);assert.notEqual(row.marketDataStatus,'ready');assert.equal(row.signal.underlyingQuote.quality,'unusable');
 const count=f.calls.length;await f.refresh(f.row);assert.equal(f.calls.length,count);
 if(options.pacer){assert.equal(count,0);const d=summarizeOptionsScan({providerMetrics:f.metrics});assert.equal(d.provider.requests,0);assert.equal(d.provider.budgetDeferrals,1);}
 }
});
test('missing, duplicate or contradictory native contract identity cannot inherit old leg eligibility',async()=>{
 for(const mutation of ['missing','duplicate','strike','multiplier']){
 const f=setup(input(),{mutate:(body,url)=>{
 if(!url.pathname.endsWith('/quotes'))return body;
 const legs=body.quotes.quote;
 if(mutation==='missing')legs.pop();else if(mutation==='duplicate')legs.push({...legs.at(-1)});
 else if(mutation==='strike')legs.at(-1).strike+=1;else legs.at(-1).contract_size=10;
 return body;
 }});const row=await f.refresh(f.row);assert.equal(row.chain.options[1].quoteQuality,'unusable',mutation);
 assert.equal(buildOptionDayTradeCandidate({...row,now:f.now(),config}).status,'no-setup',mutation);
 }
});
test('missing current liquidity is not replaced by prior volume or open interest',async()=>{
 const f=setup(input(),{mutate:(body,url)=>{if(url.pathname.endsWith('/quotes'))for(const leg of body.quotes.quote){delete leg.volume;delete leg.open_interest;}return body;}});
 const row=await f.refresh(f.row);assert.equal(row.chain.options[0].volume,null);assert.equal(row.chain.options[0].openInterest,null);
 assert.equal(buildOptionDayTradeCandidate({...row,now:f.now(),config}).status,'no-setup');
});
test('moved price must remain inside the original zone and cannot shift the frozen target',async()=>{
 const f=setup(input(),{mid:102});assert.equal((await f.refresh(f.row)).marketDataStatus,'quote_outside_primary_entry_zone');
 const r=input();r.signal.entryHigh=106;const g=setup(r,{mid:104.5});const row=await g.refresh(r);
 assert.equal(row.signal.underlyingTarget,104);assert.equal(buildOptionDayTradeCandidate({...row,now:g.now(),config}).reasons[0],'underlying_target_conflicts_with_signal');
});
test('expired original signal, catalyst, invalid identity and disabled/delayed modes make no HTTP request',async()=>{
 for(const kind of ['signal','catalyst','identity','sandbox','manual']){
 const r=input();if(kind==='signal')r.primarySignalObservedAt=iso(NOW-120001);if(kind==='catalyst')r.signal.catalystReview.status='blocked';
 if(kind==='identity')for(const leg of r.chain.options)leg.multiplier=10;
 const f=setup(r,{settings:kind==='sandbox'?{environment:'sandbox'}:kind==='manual'?{source:'manual'}:{}});const row=await f.refresh(r);
 if(kind==='manual')assert.equal(row,r);else assert.notEqual(row.marketDataStatus,'ready');assert.equal(f.calls.length,0);
 }
});
test('missing or duplicate underlying quotes and stale bid/ask sides cannot refresh approval',async()=>{
 for(const kind of ['duplicate','missing','stale','skew']){
 const f=setup(input(),{mutate:(body,url,time)=>{if(!url.pathname.endsWith('/quotes'))return body;const rows=body.quotes.quote;
 if(kind==='duplicate')rows.push({...rows[0]});if(kind==='missing')rows.shift();if(kind==='stale')rows[0].bid_date=time-11000;if(kind==='skew')rows[0].ask_date=time-3001;
 return body;}});assert.notEqual((await f.refresh(f.row)).marketDataStatus,'ready');
 }
});
test('invalid/backward observation clocks never refresh quotes',async()=>{
 const f=setup(input(),{settings:{clock:()=>NaN}});assert.equal((await f.refresh(f.row)).marketDataStatus,'decision_observation_clock_invalid');assert.equal(f.calls.length,0);
 const g=setup(input({age:100}));await g.refresh(g.row);g.advance(-1);assert.equal((await g.refresh(g.row)).marketDataStatus,'decision_observation_clock_invalid');
});

test('known required dividend failure skips refresh while preserving the strategy rejection',async()=>{
 const f=setup(input(),{settings:{config:{...config,requireDividendProvider:true}}});
 const row=await f.refresh(f.row);assert.equal(f.calls.length,0);assert.equal(f.diagnostics.skipped,1);
 const result=buildOptionDayTradeCandidate({...row,now:f.now(),config:{...config,requireDividendProvider:true}});
 assert.ok(result.reasons.includes('cash_dividend_screen_unavailable_or_incomplete'));
});

test('Options saved refresh observations reach the top-level operator report',async()=>{
 const f=setup();await f.refresh(f.row);const dir=await mkdtemp(join(tmpdir(),'omnimod-options-refresh-report-'));
 try {
   await appendScanDiagnostic('options',{decisionQuotes:f.diagnostics},{now:NOW,directory:join(dir,'options','data')});
   const report=await collectOperatorReport({rootDir:dir,stocksDataDir:join(dir,'stocks'),cryptoDataDir:join(dir,'crypto'),ledgerPath:join(dir,'ledger.json'),now:NOW});
   assert.deepEqual(report.bots.options.decisionQuotes,f.diagnostics);
 } finally {const rel=relative(tmpdir(),dir);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(dir,{recursive:true,force:true});}
});

test('bearish put refresh retains direction and selects the existing defined-risk put geometry',async()=>{
 const r=input();r.signal.direction='short';r.signal.underlyingTarget=96;
 r.chain.options.forEach((leg,i)=>{leg.type='put';leg.strike=i?97:100;leg.symbol='SPY261006P'+String(leg.strike*1000).padStart(8,'0');});
 const f=setup(r);const row=await f.refresh(r);const result=buildOptionDayTradeCandidate({...row,now:f.now(),config});
 assert.equal(result.status,'candidate',JSON.stringify(result));assert.equal(result.candidate.option.strategy,'bear-put-debit-vertical');
 assert.equal(row.signal.underlyingTarget,96);assert.ok(f.calls[1].searchParams.get('symbols').includes('SPY261006P00097000'));
});
test('a changed provider session cannot renew the old signal session',async()=>{
 const f=setup(input(),{mutate:(body,url)=>{if(url.pathname.endsWith('/clock'))body.clock.next_change='2026-10-02T21:00:00Z';return body;}});
 const row=await f.refresh(f.row);assert.equal(row.marketDataStatus,'decision_session_changed');assert.equal(f.calls.length,1);
 assert.equal(row.signal.sessionClose,close);
});
