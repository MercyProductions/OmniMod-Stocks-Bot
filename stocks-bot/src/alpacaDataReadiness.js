import { marketSession } from './time.js';
import { waitForAlpacaRequest } from './alpacaRequestGate.js';

const SYMBOLS = Object.freeze(['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ']);
const ROUTES = new Set([
  'https://paper-api.alpaca.markets/v2/account',
  'https://data.alpaca.markets/v2/stocks/quotes/latest',
  'https://data.alpaca.markets/v2/stocks/trades/latest',
  'https://data.alpaca.markets/v2/stocks/bars',
]);

/** A purpose-limited GET transport: no order routes, redirects, URLs with keys or response-body error logging. */
export async function requestReadOnlyAlpaca(url, { keyId, secretKey, fetcher = fetch, gate = waitForAlpacaRequest } = {}) {
  const parsed = new URL(url);
  if (!ROUTES.has(`${parsed.origin}${parsed.pathname}`) || parsed.username || parsed.password || parsed.hash
    || [...parsed.searchParams.keys()].some(key => /key|secret|token/i.test(key) && !(key === 'page_token' && parsed.pathname === '/v2/stocks/bars')))
    throw new Error('Disallowed data-readiness route');
  if (!keyId || !secretKey) return { status: 'credentials_missing', http: null, data: null, latencyMs: null };
  const grant = await gate(keyId);
  const started = Date.now();
  try {
    const response = await fetcher(parsed, { method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
      signal: AbortSignal.timeout(15000) });
    await gate.observe?.(keyId, response.headers, { reservationId: grant?.reservationId, status: response.status });
    const rateLimit = { limit: response.headers.get('x-ratelimit-limit'), remaining: response.headers.get('x-ratelimit-remaining') };
    if (!response.ok) return { status: response.status === 429 ? 'rate_limited' : [401,403].includes(response.status) ? 'not_authorized' : 'http_failure',
      http: response.status, data: null, latencyMs: Date.now()-started, rateLimit };
    let bytes=0;const chunks=[];
    for await (const part of response.body) {
      bytes+=part.byteLength;
      if(bytes>5_000_000) throw new Error('response_too_large');
      chunks.push(Buffer.from(part));
    }
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { status:'ok',http:response.status,data,latencyMs:Date.now()-started,rateLimit };
  } catch {
    return {status:'transport_or_payload_failure',http:null,data:null,latencyMs:Date.now()-started};
  }
}

function summarizeRows(result, symbols, kind, now) {
  if(result.status!=='ok') return {status:result.status,http:result.http,returned:null,missing:null,latencyMs:result.latencyMs,rateLimit:result.rateLimit};
  const source=result.data?.[kind];
  if(!source || typeof source!=='object' || Array.isArray(source)) return {status:'invalid_payload',http:result.http,returned:null};
  const rows=symbols.map(symbol=>{
    const row=source[symbol],time=Date.parse(row?.t);
    return {symbol,available:Boolean(row),sourceAt:Number.isFinite(time)?new Date(time).toISOString():null,
      ageSeconds:Number.isFinite(time)?(now.getTime()-time)/1000:null,
      valid:kind==='quotes'?Number(row?.bp)>0&&Number(row?.ap)>=Number(row?.bp):Number(row?.p)>0};
  });
  return {status:'ok',http:result.http,returned:rows.filter(r=>r.available).length,usable:rows.filter(r=>r.valid&&r.sourceAt&&r.ageSeconds>=0).length,
    missing:rows.filter(r=>!r.available).map(r=>r.symbol),rows,
    latencyMs:result.latencyMs,rateLimit:result.rateLimit};
}

export async function probeAlpacaDataAccess({keyId,secretKey,now=new Date(),fetcher=fetch,gate=waitForAlpacaRequest}={}) {
  const session=marketSession(now);
  const report={capturedAt:now.toISOString(),session,mode:'read_only_data_test',
    liveTradingEnabled:false,brokerOrders:0,paperOrders:0,discordPosts:0};
  if(!keyId||!secretKey) return {...report,status:'credentials_missing',paperAccount:null,iexQuotes:null,iexTrades:null,historical:null};
  const request=url=>requestReadOnlyAlpaca(url,{keyId,secretKey,fetcher,gate});
  const account=await request('https://paper-api.alpaca.markets/v2/account');
  // Never persist account number, ID, contact details, buying power, balances or positions.
  const accountValid=account.status==='ok'&&typeof account.data?.id==='string'&&typeof account.data?.status==='string';
  report.paperAccount={status:account.status==='ok'&&!accountValid?'invalid_payload':account.status,http:account.http,paperHostVerified:accountValid,latencyMs:account.latencyMs};
  if(!accountValid) return {...report,status:'paper_credentials_not_verified',iexQuotes:null,iexTrades:null,historical:null};
  const query=new URLSearchParams({symbols:SYMBOLS.join(','),feed:'iex'});
  report.iexQuotes=summarizeRows(await request(`https://data.alpaca.markets/v2/stocks/quotes/latest?${query}`),SYMBOLS,'quotes',now);
  if(report.iexQuotes.http===429)return {...report,status:'provider_rate_limited',iexTrades:null,historical:null};
  report.iexTrades=summarizeRows(await request(`https://data.alpaca.markets/v2/stocks/trades/latest?${query}`),SYMBOLS,'trades',now);
  if(report.iexTrades.http===429)return {...report,status:'provider_rate_limited',historical:null};
  const end=new Date(now.getTime()-20*60000),start=new Date(end.getTime()-7*24*60*60000);
  report.historical={};
  for(const feed of ['iex','sip']) {
    // One bounded historical entitlement probe per feed. Older SIP may or may not be included in this account.
    const params=new URLSearchParams({symbols:'AAPL',timeframe:'1Min',start:start.toISOString(),end:end.toISOString(),
      feed,adjustment:'raw',sort:'desc',limit:'1000'});
    const result=await request(`https://data.alpaca.markets/v2/stocks/bars?${params}`);
    const bars=result.data?.bars?.AAPL;
    report.historical[feed]={status:result.status==='ok'&&!Array.isArray(bars)?'invalid_payload':result.status,http:result.http,
      bars:Array.isArray(bars)?bars.length:null,latestSourceAt:Array.isArray(bars)?bars[0]?.t||null:null,
      paginated:Boolean(result.data?.next_page_token),latencyMs:result.latencyMs,rateLimit:result.rateLimit};
    if(result.http===429) break;
  }
  report.liveFreshnessAssessment=session.state==='regular'?'evaluate_native_timestamps':'outside_regular_session_not_a_live_breakout_test';
  report.coverage='IEX is single-venue; historical SIP availability does not grant real-time SIP access.';
  return {...report,status:report.iexQuotes.status==='ok'&&report.iexQuotes.usable>0&&report.iexTrades.usable>0
    &&report.historical.iex?.status==='ok'&&report.historical.iex.bars>0?'data_access_verified':'partial_data_access'};
}
