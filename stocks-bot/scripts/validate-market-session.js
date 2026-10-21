import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {probeStockDiscovery} from './probe-discovery.js';
import {dataDir} from '../src/config.js';
import {marketSession} from '../src/time.js';

// Research-only discovery observations; this module never imports order or Discord publishers.
export async function observeSession({expectedSession, samples=55, intervalMs=60000,
  probe=probeStockDiscovery, now=()=>new Date(), sleep=delay, save=async()=>{}}={}) {
  if(!['pre_market','regular'].includes(expectedSession)) throw new Error('Explicit eligible session required');
  if(!Number.isInteger(samples)||samples<1||samples>60||!Number.isFinite(intervalMs)||intervalMs<60000)
    throw new Error('Bounded sample count and minimum one-minute interval required');
  const reports=[];
  let failures=0;
  for(let i=0;i<samples;i++) {
    const at=now();
    if(marketSession(at).state!==expectedSession) break;
    let report;
    try {
      report=await probe({now:at});
      failures=report.error||report.directory?.status!=='screen_complete'?failures+1:0;
    } catch {
      failures++;
      report={capturedAt:at.toISOString(),status:'probe_failed',coverage:'unknown'};
    }
    const record={...report,sample:i+1,expectedSession,liveTradingEnabled:false,paperOrders:0,
      brokerOrders:0,discordPosts:0,productionStrategyInvoked:false};
    await save(record);
    reports.push(record);
    if(failures>=3) break;
    if(i+1<samples) await sleep(intervalMs);
  }
  return {samples:reports.length,consecutiveFailures:failures,
    status:reports.length?'research_observed':'outside_expected_session',
    liveTradingEnabled:false,brokerOrders:0,paperOrders:0,discordPosts:0};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const expectedSession=process.argv.slice(2).find(v=>v.startsWith('--session='))?.slice(10);
  const directory=path.join(dataDir,'research','session-validation');
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}.jsonl`);
  const handle=await fs.open(file,'wx',0o600);
  try {
    const result=await observeSession({expectedSession,save:record=>handle.writeFile(JSON.stringify(record)+'\n')});
    console.log(JSON.stringify(result));
    if(result.status!=='research_observed'||result.consecutiveFailures>=3)process.exitCode=1;
  } finally {await handle.close();}
}
