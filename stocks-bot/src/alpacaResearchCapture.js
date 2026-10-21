import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requestReadOnlyAlpaca} from './alpacaDataReadiness.js';

export function validateHistoricalCapture({symbols,feed,start,end,now=new Date(),maxPages=25}) {
  if(!Array.isArray(symbols)||!symbols.length||symbols.length>10||new Set(symbols).size!==symbols.length
    ||symbols.some(symbol=>!/^[A-Z][A-Z0-9.-]{0,10}$/.test(symbol))) throw new Error('Choose 1–10 unique stock symbols');
  const from=Date.parse(start),to=Date.parse(end);
  if(!['iex','sip'].includes(feed)||!Number.isFinite(from)||!Number.isFinite(to)||to<=from
    ||to>now.getTime()-20*60000||to-from>120*24*60*60000||!Number.isInteger(maxPages)||maxPages<1||maxPages>25)
    throw new Error('Historical capture requires a raw entitled feed, a completed <=120-day range and a bounded page count');
}

/** Explicit, bounded historical GET capture. Partial files never become a completed study. */
export async function captureAlpacaResearch({directory,symbols=['AAPL','MSFT','NVDA'],feed='iex',start,end,
  now=new Date(),maxPages=25,keyId,secretKey,fetcher=fetch,gate,progress=()=>{}}={}) {
  validateHistoricalCapture({symbols,feed,start,end,now,maxPages});
  if(!keyId||!secretKey) throw new Error('Local Alpaca paper credentials required');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'bars.jsonl'),handle=await fs.open(file,'wx',0o600);
  const sha=createHash('sha256'),last=new Map(),tokens=new Set();
  const coverage=Object.fromEntries(symbols.map(symbol=>[symbol,{bars:0,first:null,last:null}]));
  let token='',pages=0,count=0,complete=false;
  try {
    do {
      if(pages>=maxPages) throw new Error('Historical page budget exhausted; partial file retained, study incomplete');
      const params=new URLSearchParams({symbols:symbols.join(','),timeframe:'1Min',feed,adjustment:'raw',
        start,end,limit:'10000',sort:'asc'});
      if(token)params.set('page_token',token);
      const result=await requestReadOnlyAlpaca(`https://data.alpaca.markets/v2/stocks/bars?${params}`,{keyId,secretKey,fetcher,gate});
      if(result.status!=='ok') throw new Error(`Historical capture stopped: ${result.status}${result.http?` (HTTP ${result.http})`:''}; no complete study written`);
      if(!result.data?.bars||typeof result.data.bars!=='object'||Array.isArray(result.data.bars)) throw new Error('Invalid historical bars payload');
      const rows=[];
      for(const [symbol,bars] of Object.entries(result.data.bars)) {
        if(!symbols.includes(symbol)||!Array.isArray(bars))throw new Error('Unexpected historical instrument or series');
        for(const bar of bars) {
          const at=Date.parse(bar.t),values=[bar.o,bar.h,bar.l,bar.c,bar.v];
          if(!Number.isFinite(at)||at%60000!==0||at<Date.parse(start)||at>Date.parse(end)
            ||at<=(last.get(symbol)??-Infinity)||!values.every(value=>typeof value==='number'&&Number.isFinite(value))
            ||Math.min(bar.o,bar.h,bar.l,bar.c)<=0||bar.v<0||bar.h<Math.max(bar.o,bar.c)||bar.l>Math.min(bar.o,bar.c)||bar.l>bar.h)
            throw new Error('Malformed, duplicate, reversed or out-of-range historical bar');
          last.set(symbol,at);
          const row={symbol,timestamp:at/1000,open:bar.o,high:bar.h,low:bar.l,close:bar.c,volume:bar.v};
          rows.push(row);coverage[symbol].bars++;coverage[symbol].first??=bar.t;coverage[symbol].last=bar.t;
        }
      }
      const encoded=rows.map(row=>JSON.stringify(row)+'\n').join('');
      await handle.writeFile(encoded);sha.update(encoded);count+=rows.length;pages++;
      token=result.data.next_page_token||'';
      if(typeof token!=='string'||(token&&tokens.has(token)))throw new Error('Invalid or repeated historical pagination cursor');
      if(token)tokens.add(token);
      progress({pages,bars:count,feed,complete:!token});
    } while(token);
    complete=true;
  } finally {await handle.close();}
  const manifest={schema:'alpaca-authorized-historical-study-v1',dataFile:'bars.jsonl',sha256:sha.digest('hex'),
    symbols,feed,adjustment:'raw',barMinutes:1,start,end,downloadedAt:new Date().toISOString(),
    complete,pages,bars:count,coverage,historicalAvailabilityVerified:false,corporateActionsVerified:false,
    permittedUse:'private authorized account research; no market-data redistribution entitlement implied',
    accountCredentialsStored:false,prospectiveWarehouseImportAllowed:false,productionPromotionAllowed:false};
  await fs.writeFile(path.join(directory,'study.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
  return manifest;
}
