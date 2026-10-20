"""Bounded official demo downloads and isolated retrospective five-minute research.

Never imports reconstructed historical availability into the prospective warehouse.
The documented Alpha Vantage demo is for private individual research only. Raw data
must not be committed, redistributed, or used as a live or paid signal source.
"""
import argparse
import hashlib
import json
import math
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from engine import canonical, digest, epoch

DEMO_URLS = {
    'recent': 'https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=IBM&interval=5min&outputsize=full&apikey=demo',
    '2009-01': 'https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=IBM&interval=5min&month=2009-01&outputsize=full&apikey=demo',
}


def download_demo(which, output):
    url = DEMO_URLS[which]
    path = Path(output)
    manifest = path.with_suffix(path.suffix+'.manifest.json')
    if path.exists():
        metadata = json.loads(manifest.read_text(encoding='utf-8'))
        if metadata['url'] != url or metadata['sha256'] != hashlib.sha256(path.read_bytes()).hexdigest():
            raise ValueError('cached demo checksum or source mismatch')
        return metadata
    # Single explicit public documentation example, bounded response, no entitlement bypass or scraping.
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = response.read(3_000_001)
    if len(payload) > 3_000_000:
        raise ValueError('demo exceeds byte budget')
    data = json.loads(payload)
    series = data.get('Time Series (5min)')
    if not isinstance(series, dict) or not series or data.get('Meta Data', {}).get('2. Symbol') != 'IBM':
        raise ValueError('demo unavailable or provider entitlement/error response; no substitute data was fabricated')
    metadata = {'provider':'Alpha Vantage official IBM demo','url':url,
                'documentation':'https://www.alphavantage.co/documentation/',
                'terms':'https://www.alphavantage.co/terms_of_service/',
                'permittedUse':'private individual research/test; no redistribution/commercial data use',
                'downloadedAt':datetime.now(timezone.utc).isoformat(),
                'sha256':hashlib.sha256(payload).hexdigest(),'bars':len(series),'dates':len({s[:10] for s in series}),
                'adjustmentStatus':'provider default split/dividend adjusted; historical vintages unverified',
                'historicalAvailabilityVerified':False,'prospectiveImportAllowed':False}
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as stream:
        stream.write(payload)
    manifest.write_text(json.dumps(metadata,indent=2),encoding='utf-8')
    return metadata


def session_calendar(dates):
    # Reuse the project's actual US cash calendar, including recurring holidays, early closes and DST.
    # Extraordinary historical closures remain a documented limitation of that calendar.
    script = """import fs from 'node:fs';
import {marketSession,marketCloseTime,marketCloseMinute} from './src/time.js';
const dates=JSON.parse(fs.readFileSync(0,'utf8')); const result={};
for(const date of dates){const d=new Date(date+'T16:00:00Z');
 if(marketSession(d).state==='regular'){const close=marketCloseTime(d).getTime()/1000;
 result[date]={open:close-(marketCloseMinute(d)-570)*60,close};}}
process.stdout.write(JSON.stringify(result));"""
    process=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(sorted(dates)),
                           cwd=Path(__file__).resolve().parent.parent,text=True,capture_output=True,timeout=20)
    if process.returncode:
        raise ValueError('project cash-calendar conversion failed')
    return json.loads(process.stdout)


def normalize_demo(data):
    if data.get('Meta Data',{}).get('2. Symbol') != 'IBM' or data.get('Meta Data',{}).get('6. Time Zone') not in ['US/Eastern','America/New_York']:
        raise ValueError('unexpected demo symbol or source timezone')
    series=data.get('Time Series (5min)',{})
    if not series:
        raise ValueError('five-minute demo data missing')
    bars=[]
    for key,row in series.items():
        at=datetime.strptime(key,'%Y-%m-%d %H:%M:%S').replace(tzinfo=ZoneInfo('America/New_York'))
        values=[float(row[name]) for name in ['1. open','2. high','3. low','4. close','5. volume']]
        o,h,l,c,v=values
        if not all(math.isfinite(x) for x in values) or min(o,h,l,c)<=0 or v<0 or h<max(o,c) or l>min(o,c) or l>h:
            raise ValueError('invalid historical OHLCV')
        bars.append({'timestamp':int(at.timestamp()),'date':key[:10],'open':o,'high':h,'low':l,'close':c,'volume':v})
    return sorted(bars,key=lambda b:b['timestamp'])


def build_rows(bars, horizon, calendar, cost_bps=20, stride=3):
    if horizon not in [5,15,30,90,240] or cost_bps<0 or stride<1:
        raise ValueError('unsupported research policy')
    by_date={}
    for bar in bars:
        session=calendar.get(bar['date'])
        if session and session['open'] <= bar['timestamp'] and bar['timestamp']+300 <= session['close']:
            by_date.setdefault(bar['date'],[]).append(bar)
    rows=[]; missing_paths=0
    previous_sessions=[]
    for date,session_bars in sorted(by_date.items()):
        session_bars=sorted(session_bars,key=lambda b:b['timestamp'])
        indexed={b['timestamp']:b for b in session_bars}
        if len(indexed)!=len(session_bars):
            raise ValueError('duplicate historical bar identity')
        recent_sessions=[s for d,s in previous_sessions[-5:] if (datetime.fromisoformat(date)-datetime.fromisoformat(d)).days<=30]
        for i in range(12,len(session_bars),stride):
            current=session_bars[i]
            available=int(current['timestamp'])+300
            end=available+horizon*60
            if end>calendar[date]['close']:
                continue
            context=session_bars[i-12:i+1]
            if any(context[n]['timestamp']-context[n-1]['timestamp']!=300 for n in range(1,len(context))):
                continue
            future_times=list(range(available,end,300))
            if any(t not in indexed for t in future_times):
                missing_paths+=1
                continue
            future=[indexed[t] for t in future_times]
            close=current['close']
            past=session_bars[:i+1]
            volume=sum(b['volume'] for b in past)
            vwap=sum((b['high']+b['low']+b['close'])/3*b['volume'] for b in past)/volume if volume else close
            offset=current['timestamp']-calendar[date]['open']
            prior_volumes=[s[offset]['volume'] for s in recent_sessions if offset in s]
            relative_volume=current['volume']/(sum(prior_volumes)/len(prior_volumes)) if len(prior_volumes)>=3 and sum(prior_volumes)>0 else None
            # No stale 2009 activity baseline can transfer silently into a recent demo period.
            if relative_volume is None:
                continue
            changes=[context[n]['close']/context[n-1]['close']-1 for n in range(1,len(context))]
            average=sum(changes)/len(changes)
            features={'return5mPct':(close/context[-2]['close']-1)*100,
                      'return15mPct':(close/context[-4]['close']-1)*100,
                      'change1h':(close/context[0]['close']-1)*100,'relativeVolume':relative_volume,
                      'rangePct':(current['high']/current['low']-1)*100,'vwapDistancePct':(close/vwap-1)*100,
                      'sessionHighDistancePct':(max(b['high'] for b in past)/close-1)*100,
                      'volatilityPct':math.sqrt(sum((x-average)**2 for x in changes)/len(changes))*100,
                      'minuteOfSession':offset/60}
            # Full-bar execution latency. At the 5-minute horizon there is no executable path after that delay.
            trade_path=future[1:]
            outcome='not_filled'; net_return=None; terminal=end; start=available+300
            if trade_path:
                entry=trade_path[0]['open']*(1+cost_bps/20000)
                stop,target=entry*.9925,entry*1.01
                exit_price=trade_path[-1]['close'];outcome='expiry'
                for b in trade_path:
                    if b['low']<=stop:
                        exit_price=min(stop,b['open']);outcome='stop';terminal=b['timestamp']+300;break
                    if b['high']>=target:
                        exit_price=target;outcome='target';terminal=b['timestamp']+300;break
                net_return=(exit_price*(1-cost_bps/20000)/entry-1)*100
            original={'id':digest(['alpha-demo',date,current['timestamp'],horizon]),'symbol':'IBM',
                      'availableAt':datetime.fromtimestamp(available,timezone.utc).isoformat(),
                      'features':features,'marketRegime':'unavailable_no_market_context',
                      'dataMode':'retrospective_adjusted_demo','historicalAvailabilityVerified':False}
            label={'end':end,'availableAt':end,'start':start,'terminalAt':terminal,'terminal':outcome,
                   'direction':int(future[-1]['close']>close),'targetBeforeStop':int(outcome=='target'),
                   'returnPct':(future[-1]['close']/close-1)*100,'netReturnPct':net_return,
                   'costBps':cost_bps,'stopPct':.75,'targetPct':1,'executionVerified':False,
                   'latencySeconds':300,'filled':bool(trade_path),'pathHash':digest(future)}
            rows.append({'observation':original,'label':label,'time':available,'day':date})
        previous_sessions.append((date,{b['timestamp']-calendar[date]['open']:b for b in session_bars}))
    return rows,{'missingFuturePaths':missing_paths,'sourceSessionDates':len(by_date),'usableObservationDates':len({r['day'] for r in rows})}


def load_research_dataset(path,horizon):
    description=json.loads(Path(path).read_text(encoding='utf-8'))
    if description.get('schema')!='alpha-official-demo-study-v1':
        raise ValueError('unsupported historical research manifest')
    bars=[];sources=[]
    for name in description['files']:
        source=(Path(path).parent/name).resolve()
        metadata=json.loads(source.with_suffix(source.suffix+'.manifest.json').read_text(encoding='utf-8'))
        if metadata.get('url') not in DEMO_URLS.values() or hashlib.sha256(source.read_bytes()).hexdigest()!=metadata['sha256']:
            raise ValueError('unverified demo source/checksum')
        bars.extend(normalize_demo(json.loads(source.read_text(encoding='utf-8'))))
        sources.append({key:metadata[key] for key in ['provider','sha256','downloadedAt','adjustmentStatus','historicalAvailabilityVerified']})
    if len({b['timestamp'] for b in bars})!=len(bars):
        raise ValueError('overlapping source files; do not double-count observations')
    calendar=session_calendar({b['date'] for b in bars})
    rows,coverage=build_rows(bars,horizon,calendar)
    return rows,{'sources':sources,'coverage':coverage,'scope':'private IBM demo methodology study, not broad-universe or production validation',
                 'limitations':['One surviving stock and two separately published demo periods; long gaps and selection bias.',
                 'Default adjusted/corrected bars, not verified historical data vintages; availability at bar close is an explicit retrospective assumption.',
                 'Five-minute bars; no intraminute path, NBBO, market/sector context, catalysts or actual notification data.',
                 '300-second assumed entry latency and 20-bp assumed round-trip cost; stop-first ambiguity.',
                 'Existing recurring US cash calendar; extraordinary historical closures not independently verified.',
                 'No data, weights or row-level forecasts may be redistributed from this private demo study.'],
                 'prospectiveWarehouseImportAllowed':False,'productionPromotionAllowed':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo',choices=DEMO_URLS,required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    result=download_demo(args.demo,args.output)
    print(canonical({k:result[k] for k in ['provider','bars','dates','sha256']}))
