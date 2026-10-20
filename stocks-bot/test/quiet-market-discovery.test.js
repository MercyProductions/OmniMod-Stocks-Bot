import test from 'node:test';
import assert from 'node:assert/strict';
import { rankQuietMarketSnapshots, summarizeQuietResearch } from '../src/quietMarketDiscovery.js';
import { fetchAlpacaWideDiscoverySymbols } from '../src/stocksData.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const now = new Date('2026-10-20T15:00:10Z');
const directory = [{symbol:'FLAT',id:'flat-identity'},{symbol:'DOWN',id:'down-identity'}];
test('admin summaries distinguish unavailable coverage from genuine zero results',()=>{
  assert.equal(summarizeQuietResearch(null).qualified,null);
  assert.equal(summarizeQuietResearch(null).status,'unavailable');
  assert.equal(summarizeQuietResearch({diagnostics:{qualified:0,selected:0}}).qualified,0);
  assert.equal(summarizeQuietResearch({deferred:true}).status,'deferred');
  assert.equal(summarizeQuietResearch({}).productionApproval,false);
});
function snapshot(price=10) { return { latestTrade:{p:price,t:'2026-10-20T15:00:00Z'},
  minuteBar:{t:'2026-10-20T14:59:00Z',o:price,h:price*1.001,l:price*.999,c:price,v:1000},
  dailyBar:{t:'2026-10-20T04:00:00Z',h:price*1.001,v:50000},
  prevDailyBar:{t:'2026-10-19T04:00:00Z',c:10,v:100000} }; }

test('quiet shadow discovers flat and modestly negative activity without production approval',()=>{
  const result=rankQuietMarketSnapshots({FLAT:snapshot(),DOWN:snapshot(9.95)},directory,{now});
  assert.equal(result.candidates.length,2);
  assert.equal(result.productionApproval,false);
  assert.ok(result.candidates.every(row=>row.changeDay<=0));
  assert.ok(result.candidates.every(row=>row.coverage==='single_venue'));
  assert.ok(result.candidates.every(row=>row.sampledVolumeRatio===null));
});
test('quiet shadow rejects stale, incomplete, missing, malformed and already expanded observations',()=>{
  const cases=[{...snapshot(),latestTrade:{p:10,t:'2026-10-20T14:00:00Z'}},
    {...snapshot(),minuteBar:{...snapshot().minuteBar,t:'2026-10-20T15:00:00Z'}},
    {...snapshot(),dailyBar:{...snapshot().dailyBar,t:'invalid'}},
    {...snapshot(),minuteBar:{...snapshot().minuteBar,h:9}},snapshot(10.5),
    {...snapshot(),minuteBar:{...snapshot().minuteBar,v:100}}];
  for(const row of cases) {
    const result=rankQuietMarketSnapshots({FLAT:row},directory.slice(0,1),{now});
    assert.equal(result.candidates.length,0);
    assert.equal(result.diagnostics.rejections.length,1);
  }
});
test('sampled volume comparison requires distinct timestamps and same identity, date and feed',()=>{
  const previous=rankQuietMarketSnapshots({FLAT:snapshot()},directory.slice(0,1),{now}).next;
  const repeated=rankQuietMarketSnapshots({FLAT:snapshot()},directory.slice(0,1),{now,previous});
  assert.equal(repeated.candidates[0].sampledVolumeRatio,null);
  const later=snapshot();later.latestTrade.t='2026-10-20T15:01:00Z';later.minuteBar.t='2026-10-20T15:00:00Z';later.minuteBar.v=3000;
  const valid=rankQuietMarketSnapshots({FLAT:later},directory.slice(0,1),{now:new Date('2026-10-20T15:01:10Z'),previous});
  assert.equal(valid.candidates[0].sampledVolumeRatio,3);
  const wrongFeed=rankQuietMarketSnapshots({FLAT:later},directory.slice(0,1),{now:new Date('2026-10-20T15:01:10Z'),previous,feed:'sip'});
  assert.equal(wrongFeed.candidates[0].sampledVolumeRatio,null);
});
test('quiet caps and rejection counts are explicit and unsupported sessions do not qualify',()=>{
  const result=rankQuietMarketSnapshots({FLAT:snapshot(),DOWN:snapshot(9.95)},directory,{now,limit:1});
  assert.equal(result.diagnostics.qualified,2);
  assert.equal(result.diagnostics.capOmissions,1);
  assert.equal(result.candidates.length,1);
  assert.equal(rankQuietMarketSnapshots({FLAT:snapshot()},directory,{now:new Date('2026-10-24T15:00:00Z')}).candidates.length,0);
});

test('wide discovery archives a quiet research candidate without changing production shortlist or making extra requests',async(t)=>{
  const requests=[];
  const archiveDirectory=await mkdtemp(join(tmpdir(),'stocks-quiet-archive-test-'));
  t.after(async()=>{assert.ok(resolve(archiveDirectory).startsWith(resolve(tmpdir())+sep));await rm(archiveDirectory,{recursive:true});});
  const result=await fetchAlpacaWideDiscoverySymbols({
    keys:{alpaca_key_id:'quiet-integration-test-id',alpaca_secret_key:'quiet-integration-test-secret'},
    cacheKey:'quiet-integration-unique',now,feed:'iex',session:'regular',sleepFn:async()=>{},archiveDirectory,
    fetcher:async(url)=>{
      requests.push(String(url));
      if(String(url).includes('/v2/assets?')) return Response.json([{...directory[0],class:'us_equity',exchange:'NASDAQ',status:'active',tradable:true}]);
      return Response.json({FLAT:snapshot()});
    },
  });
  assert.deepEqual(result.symbols,[]);
  assert.deepEqual(result.quietResearch.candidates.map(row=>row.symbol),['FLAT']);
  assert.equal(result.quietResearch.productionApproval,false);
  assert.equal(result.quietResearch.diagnostics.qualified,1);
  assert.equal(requests.length,2);
  const archived=JSON.parse(gunzipSync(await readFile(join(archiveDirectory,result.archive.file))).toString('utf8'));
  assert.equal(archived.quietResearch.candidates[0].symbol,'FLAT');
  assert.equal(archived.quietResearch.productionApproval,false);
});
