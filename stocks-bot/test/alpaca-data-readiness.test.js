import test from 'node:test';
import assert from 'node:assert/strict';
import {requestReadOnlyAlpaca,probeAlpacaDataAccess} from '../src/alpacaDataReadiness.js';
const now=new Date('2026-10-20T23:00:00Z');
const credentials={keyId:'test-only-paper-key',secretKey:'test-only-paper-secret',gate:async()=>({})};

test('readiness cannot call order routes, redirect credentials or put credentials in URLs',async()=>{
  for(const url of ['https://api.alpaca.markets/v2/orders','https://paper-api.alpaca.markets/v2/orders',
    'https://data.alpaca.markets/v2/stocks/bars?apikey=anything','https://user:pass@data.alpaca.markets/v2/stocks/bars'])
    await assert.rejects(requestReadOnlyAlpaca(url,credentials),/Disallowed/);
});
test('missing credentials do not manufacture zero coverage or trigger any HTTP requests',async()=>{
  const result=await probeAlpacaDataAccess({now,fetcher:async()=>{throw new Error('must not run');}});
  assert.equal(result.status,'credentials_missing');assert.equal(result.iexQuotes,null);assert.equal(result.liveTradingEnabled,false);
});
test('paper authentication failure stops before data probes and never echoes sensitive response bodies',async()=>{
  let requests=0;
  const result=await probeAlpacaDataAccess({...credentials,now,fetcher:async()=>{
    requests++;return new Response('sensitive server body',{status:401});
  }});
  assert.equal(requests,1);assert.equal(result.status,'paper_credentials_not_verified');
  assert.doesNotMatch(JSON.stringify(result),/sensitive server body/);
});
test('real-data readiness distinguishes closed-session stale quotes from no data and redacts account details',async()=>{
  const calls=[];
  const result=await probeAlpacaDataAccess({...credentials,now,fetcher:async(url,options)=>{
    calls.push(String(url));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    if(url.pathname==='/v2/account') return Response.json({id:'private-account',status:'ACTIVE',account_number:'do-not-store',cash:'private-balance'});
    if(url.pathname.includes('/quotes/')) return Response.json({quotes:{AAPL:{bp:100,ap:100.01,t:'2026-10-20T19:59:00Z'}}});
    if(url.pathname.includes('/trades/')) return Response.json({trades:{AAPL:{p:100,t:'2026-10-20T19:59:00Z'}}});
    return url.searchParams.get('feed')==='sip'?new Response('not included',{status:403}):Response.json({bars:{AAPL:[{t:'2026-10-20T19:59:00Z'}]}});
  }});
  assert.equal(calls.length,5);assert.equal(result.status,'data_access_verified');
  assert.equal(result.iexQuotes.returned,1);assert.equal(result.historical.sip.status,'not_authorized');
  assert.equal(result.liveFreshnessAssessment,'outside_regular_session_not_a_live_breakout_test');
  assert.doesNotMatch(JSON.stringify(result),/private-account|do-not-store|private-balance|test-only-paper-secret/);
  assert.equal(result.brokerOrders,0);assert.equal(result.discordPosts,0);
});

test('rate-limited readiness stops immediately instead of continuing provider requests',async()=>{
  let requests=0;
  const result=await probeAlpacaDataAccess({...credentials,now,fetcher:async(url)=>{
    requests++;return url.pathname==='/v2/account'?Response.json({id:'private-test',status:'ACTIVE'}):new Response('rate limit',{status:429});
  }});
  assert.equal(requests,2);assert.equal(result.status,'provider_rate_limited');assert.equal(result.historical,null);
});
