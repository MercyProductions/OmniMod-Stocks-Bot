import copy
import json
import tempfile
import unittest
import sqlite3
import subprocess
import sys
import hashlib
from datetime import datetime,timezone,timedelta
from pathlib import Path
from walkforward import evaluate,plan_folds,paper_summary
from historical import build_rows,normalize_demo,download_demo


def fixture():
    rows=[]
    for day in range(40):
        at=datetime(2026,1,5,15,tzinfo=timezone.utc)+timedelta(days=day)
        for n in range(20):
            timestamp=(at+timedelta(minutes=n*3)).timestamp();y=n%2
            rows.append({'day':at.strftime('%Y-%m-%d'),'time':timestamp,
                'observation':{'id':f'{day}-{n}','symbol':'TEST','features':{'signal':y,'change1h':1 if y else -1},'marketRegime':'synthetic'},
                'label':{'end':timestamp+300,'availableAt':timestamp+301,'direction':y,'targetBeforeStop':y,
                         'returnPct':1 if y else -1,'netReturnPct':.8 if y else -.95,'stopPct':.75,'costBps':20,
                         'start':timestamp+60,'terminalAt':timestamp+300}})
    return rows


class WalkForwardTests(unittest.TestCase):
    def test_global_dates_label_availability_and_horizon_purging(self):
        rows=fixture();plan,final=plan_folds(rows)
        held={r['day'] for r in final[-1]}
        for train,selection,calibration,test in plan:
            self.assertTrue(held.isdisjoint({r['day'] for r in train+selection+calibration+test}))
            for earlier,later in [(train,selection),(selection,calibration),(calibration,test)]:
                self.assertLess(max(max(r['label']['end'],r['label']['availableAt']) for r in earlier),min(r['time'] for r in later)-300)
        bad=copy.deepcopy(rows)
        for row in bad:row['label']['availableAt']=99999999999
        with self.assertRaisesRegex(ValueError,'insufficient|independent|dates'):
            plan_folds(bad)

    def test_real_lightgbm_walkforward_and_final_holdout_do_not_train_on_holdout(self):
        rows=fixture();first=evaluate(rows)
        changed=copy.deepcopy(rows);held={r['day'] for r in plan_folds(rows)[1][-1]}
        for row in changed:
            if row['day'] in held:
                row['label']['direction']=1-row['label']['direction'];row['label']['returnPct']*=10
        second=evaluate(changed)
        self.assertEqual(first['status'],'evaluated_research_only')
        self.assertEqual(len(first['folds']),3)
        self.assertEqual([f['fitHash'] for f in first['folds']],[f['fitHash'] for f in second['folds']])
        self.assertEqual(first['finalHoldout']['fit']['fitHash'],second['finalHoldout']['fit']['fitHash'])
        self.assertNotEqual(first['finalHoldout']['evaluation']['direction']['brier'],second['finalHoldout']['evaluation']['direction']['brier'])
        self.assertFalse(first['productionApproval'])

    def test_small_data_and_all_negative_classes_do_not_manufacture_metrics(self):
        self.assertEqual(evaluate(fixture()[:50])['status'],'blocked')
        rows=fixture()
        for row in rows:row['label']['direction']=0;row['label']['targetBeforeStop']=0
        result=evaluate(rows)
        self.assertEqual(result['walkForward']['status'],'blocked')

    def test_paper_positions_do_not_overlap_or_count_unfilled_returns(self):
        rows=fixture()[:3]
        for row in rows:row.update(probabilityUp=.8,targetProbability=.8,expectedReturnPct=1)
        rows[0]['label']['terminalAt']=rows[2]['label']['terminalAt']+1
        result=paper_summary(rows)
        self.assertEqual(result['trades'],1)
        self.assertFalse(result['executionVerified'])
        rows[0]['label']['netReturnPct']=None
        self.assertEqual(paper_summary(rows)['trades'],1)

    def test_demo_normalization_rejects_wrong_timezone_and_cache_tampering(self):
        with self.assertRaisesRegex(ValueError,'timezone'):
            normalize_demo({'Meta Data':{'2. Symbol':'IBM','6. Time Zone':'UTC'}})
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/'demo.json';file.write_text('{}')
            file.with_suffix('.json.manifest.json').write_text(json.dumps({'url':'invalid','sha256':'wrong'}))
            with self.assertRaisesRegex(ValueError,'checksum'):
                download_demo('recent',file)

    def test_five_minute_history_does_not_invent_minute_paths_or_latency_fills(self):
        bars=[];calendar={}
        for d in range(6):
            at=datetime(2026,1,5,14,30,tzinfo=timezone.utc)+timedelta(days=d)
            date=at.strftime('%Y-%m-%d');calendar[date]={'open':at.timestamp(),'close':at.timestamp()+390*60}
            for n in range(78):
                bars.append({'date':date,'timestamp':at.timestamp()+n*300,'open':100,'high':100.1,'low':99.9,'close':100,'volume':100})
        rows,coverage=build_rows(bars,5,calendar)
        self.assertTrue(rows)
        self.assertTrue(all(r['label']['terminal']=='not_filled' and r['label']['netReturnPct'] is None for r in rows))
        self.assertTrue(all(not r['observation']['historicalAvailabilityVerified'] for r in rows))
        broken=[b for b in bars if b['timestamp']!=bars[-15]['timestamp']]
        _,gaps=build_rows(broken,15,calendar)
        self.assertGreater(gaps['missingFuturePaths'],0)

    def test_evaluation_cli_reads_database_without_modifying_or_creating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            db=Path(directory)/'research.sqlite'
            connection=sqlite3.connect(db)
            connection.executescript('CREATE TABLE observations(id TEXT,payload TEXT); CREATE TABLE labels(observation_id TEXT,horizon TEXT,payload TEXT);')
            for row in fixture()[:50]:
                item={**row['observation'],'availableAt':datetime.fromtimestamp(row['time'],timezone.utc).isoformat()}
                connection.execute('INSERT INTO observations VALUES(?,?)',(item['id'],json.dumps(item)))
                connection.execute('INSERT INTO labels VALUES(?,?,?)',(item['id'],'5',json.dumps(row['label'])))
            connection.commit();connection.close()
            before=hashlib.sha256(db.read_bytes()).hexdigest()
            output=Path(directory)/'report.json'
            script=Path(__file__).with_name('walkforward.py')
            process=subprocess.run([sys.executable,str(script),'--db',str(db),'--horizon','5','--output',str(output)],capture_output=True,text=True,timeout=20)
            self.assertEqual(process.returncode,0,process.stderr)
            self.assertEqual(json.loads(output.read_text())['status'],'blocked')
            self.assertEqual(before,hashlib.sha256(db.read_bytes()).hexdigest())
            missing=Path(directory)/'missing.sqlite'
            process=subprocess.run([sys.executable,str(script),'--db',str(missing),'--horizon','5','--output',str(Path(directory)/'another.json')],capture_output=True,text=True,timeout=20)
            self.assertNotEqual(process.returncode,0)
            self.assertFalse(missing.exists())

    def test_native_one_minute_study_uses_real_minute_paths_and_one_minute_latency(self):
        bars=[];calendar={}
        for day in range(6):
            at=datetime(2026,1,5,14,30,tzinfo=timezone.utc)+timedelta(days=day)
            date=at.strftime('%Y-%m-%d');calendar[date]={'open':at.timestamp(),'close':at.timestamp()+390*60}
            for n in range(390):
                bars.append({'date':date,'timestamp':at.timestamp()+n*60,'open':100,'high':100.1,'low':99.9,'close':100,'volume':100})
        rows,_=build_rows(bars,5,calendar,stride=15,bar_minutes=1,symbol='TEST',source_label='alpaca-iex-raw')
        self.assertTrue(rows)
        self.assertTrue(all(row['label']['latencySeconds']==60 and row['label']['filled'] for row in rows))
        self.assertTrue(all(row['observation']['symbol']=='TEST' and row['label']['executionVerified'] is False for row in rows))


if __name__=='__main__':unittest.main()
