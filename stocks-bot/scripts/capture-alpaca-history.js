import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../src/config.js';
import {captureAlpacaResearch} from '../src/alpacaResearchCapture.js';

const arg=(name,fallback)=>process.argv.slice(2).find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)||fallback;
const now=new Date(),end=arg('end',new Date(now.getTime()-20*60000).toISOString());
const start=arg('start',new Date(Date.parse(end)-90*24*60*60000).toISOString());
const studyName=arg('study',`alpaca-${Date.now()}`);
if(!/^[a-z0-9-]{1,80}$/i.test(studyName))throw new Error('Use a short alphanumeric study name');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../datasets/alpaca');
const directory=path.join(root,studyName);
const result=await captureAlpacaResearch({directory,symbols:arg('symbols','AAPL,MSFT,NVDA').split(','),
  feed:arg('feed','iex'),start,end,now,keyId:config.alpacaKeyId,secretKey:config.alpacaSecretKey,
  progress:status=>console.log(JSON.stringify(status))});
console.log(JSON.stringify({study:studyName,feed:result.feed,bars:result.bars,coverage:result.coverage,
  complete:result.complete,brokerOrders:0,paperOrders:0,liveTradingEnabled:false}));
