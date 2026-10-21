import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {captureAlpacaResearch,validateHistoricalCapture} from '../src/alpacaResearchCapture.js';

const now=new Date('2026-10-20T23:00:00Z');
const settings={symbols:['AAPL'],feed:'iex',start:'2026-10-19T00:00:00Z',end:'2026-10-20T22:30:00Z',now,
  keyId:'test-only-paper-key',secretKey:'test-only-paper-secret',gate:async()=>({})};
async function folder(t) {
  const directory=await mkdtemp(join(tmpdir(),'stocks-history-capture-test-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true});});
  return directory;
}
const bar=t=>({t,o:100,h:101,l:99,c:100.5,v:1000});
test('historical capture enforces free-history lag, bounded ranges and symbols',()=>{
  assert.throws(()=>validateHistoricalCapture({...settings,end:now.toISOString()}),/bounded/);
  assert.throws(()=>validateHistoricalCapture({...settings,symbols:Array(11).fill('AAPL')}),/unique/);
  assert.throws(()=>validateHistoricalCapture({...settings,start:'2009-01-01T00:00:00Z'}),/bounded/);
});
test('capture preserves native minute timestamps, paginates and excludes credentials from files',async(t)=>{
  const directory=await folder(t),calls=[];
  const result=await captureAlpacaResearch({...settings,directory,fetcher:async(url,options)=>{
    calls.push(String(url));assert.equal(options.method,'GET');assert.equal(url.searchParams.get('adjustment'),'raw');
    return Response.json({bars:{AAPL:[bar(calls.length===1?'2026-10-19T14:30:00Z':'2026-10-19T14:31:00Z')]},next_page_token:calls.length===1?'opaque-page-cursor':null});
  }});
  assert.equal(result.bars,2);assert.equal(result.complete,true);assert.match(calls[1],/page_token=/);
  const contents=await readFile(join(directory,'bars.jsonl'),'utf8');
  assert.equal(contents.trim().split('\n').length,2);
  assert.doesNotMatch(contents+JSON.stringify(result),/test-only-paper-key|test-only-paper-secret|opaque-page-cursor/);
  await assert.rejects(captureAlpacaResearch({...settings,directory}),/EEXIST/);
});
test('a repeated pagination cursor retains partial data without a completed study manifest',async(t)=>{
  const directory=await folder(t);let calls=0;
  await assert.rejects(captureAlpacaResearch({...settings,directory,fetcher:async()=>{
    calls++;return Response.json({bars:{AAPL:[bar(`2026-10-19T14:${calls===1?'30':'31'}:00Z`)]},next_page_token:'repeat'});
  }}),/pagination/);
  await assert.rejects(access(join(directory,'study.json')));
});
