import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
from engine import Warehouse, SCHEMA, HORIZONS, canonical, train, load_model, predict, chronological_partition, chronos_forecast


def observation(index=0, date='2026-01-05T15:00:00+00:00'):
    return {'id': str(index), 'schema': SCHEMA, 'symbol': 'TEST', 'provider': 'Alpaca IEX',
            'availableAt': date, 'price': 100, 'features': {'rvol': index % 2, 'missing': None},
            'dataIssues': [], 'requests': [{'horizon': h, 'expiresAt': (datetime.fromisoformat(date) + timedelta(minutes=h)).isoformat() if isinstance(h,int) else None,
                                          'reason': None if isinstance(h,int) else 'verified_next_session_calendar_required'} for h in HORIZONS]}


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Warehouse(Path(self.directory.name) / 'research.sqlite')

    def tearDown(self):
        self.store.db.close()
        self.directory.cleanup()

    def test_immutable_observation_and_six_idempotent_forecasts(self):
        row = observation()
        first = self.store.forecasts(row)
        self.assertEqual(first, self.store.forecasts(row))
        self.assertEqual(len(first), 6)
        self.assertTrue(all(f['productionApproval'] is False and f['calibratedProbability'] is None for f in first))
        row['price'] = 101
        with self.assertRaisesRegex(ValueError, 'conflict'):
            self.store.observe(row)

    def test_expired_backlog_cannot_be_represented_as_new_forecast(self):
        results = self.store.forecasts(observation())
        self.assertTrue(all(row['reason'] == 'forecast_expired_at_inference' for row in results[:5]))
        self.assertTrue(all(row['inferredAt'] != row['predictionAt'] for row in results))

    def bars(self):
        start = datetime.fromisoformat(observation()['availableAt']).timestamp()
        return [{'symbol':'TEST', 'provider':'alpaca-iex', 'timestamp':start + i * 60,
                 'open':100, 'high':102, 'low':98, 'close':101, 'recordedAt':datetime.fromtimestamp(start + (i+1)*60, timezone.utc).isoformat()} for i in range(240)]

    def test_conservative_barrier_and_label_availability_and_costs(self):
        self.store.forecasts(observation())
        now = self.bars()[-1]['timestamp'] + 120
        result = self.store.label(self.bars(), now=now)
        self.assertEqual(result['labelsAdded'], 5)
        row = json.loads(self.store.db.execute("SELECT payload FROM labels WHERE horizon='5'").fetchone()[0])
        self.assertEqual(row['terminal'], 'stop')
        self.assertLess(row['netReturnPct'], -.75)
        self.assertEqual(row['availableAt'], now)
        self.assertFalse(row['executionVerified'])
        with self.assertRaisesRegex(ValueError,'assumptions changed'):
            self.store.label(self.bars(), now=now, cost_bps=0)

    def test_gaps_and_wrong_feed_never_become_complete_labels(self):
        self.store.forecasts(observation())
        bars = self.bars()
        self.assertEqual(self.store.label(bars[:2]+bars[3:], now=bars[-1]['timestamp']+120)['labelsAdded'], 0)
        for bar in bars:
            bar['provider']='alpaca-sip'
        self.assertEqual(self.store.label(bars, now=bars[-1]['timestamp']+120)['labelsAdded'], 0)

    def test_ingest_torn_tail_and_transactional_offsets(self):
        path = Path(self.directory.name) / 'features.jsonl'
        line = canonical({'predictiveObservation': observation()}) + '\n'
        path.write_text(line + '{"broken":',encoding='utf-8')
        self.assertEqual(self.store.ingest([path]),1)
        self.assertEqual(self.store.ingest([path]),0)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM forecasts').fetchone()[0],6)

    def test_delayed_label_information_is_purged(self):
        rows = [{'day':f'2026-01-{day:02d}','time':day*86400+i,
                 'label':{'end':day*86400+10,'availableAt':99999999}} for day in range(1,31) for i in range(20)]
        with self.assertRaisesRegex(ValueError,'purging'):
            chronological_partition(rows)

    def test_actual_lightgbm_fit_serialization_and_calibration_on_synthetic_fixture(self):
        # Synthetic fixture tests execution/correctness only; never reported as strategy performance.
        for day in range(30):
            date = datetime(2026,1,5,tzinfo=timezone.utc) + timedelta(days=day)
            for i in range(40):
                at = date + timedelta(hours=15,minutes=i)
                item=observation(day*40+i,at.isoformat())
                self.store.observe(item)
                label={'end':at.timestamp()+300, 'availableAt':at.timestamp()+301,
                       'direction':i%2,'targetBeforeStop':i%2,'returnPct':1 if i%2 else -1}
                self.store.db.execute('INSERT INTO labels VALUES(?,?,?)',(item['id'],'5',canonical(label)))
        output=Path(self.directory.name)/'model.json'
        result=train(self.store,output)
        self.assertEqual(result['horizonsTrained'],1)
        model=load_model(output)
        self.assertTrue(predict(model,observation(1),5)['experimentalProbabilityUp'] > .5)
        with self.assertRaisesRegex(ValueError,'overwrite'):
            train(self.store,output)
        output.write_text(output.read_text().replace('research_only','tampered'),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'invalid'):
            load_model(output)

    def test_chronos_rejects_invalid_context_before_loading_weights(self):
        with self.assertRaisesRegex(ValueError,'same-session'):
            chronos_forecast([],5,'a'*40)

    def test_empty_data_reports_blocked_without_inventing_performance(self):
        result=train(self.store,Path(self.directory.name)/'empty.json')
        self.assertEqual(result['horizonsTrained'],0)
        self.assertTrue(all(r['status']=='blocked' for r in result['evaluation'].values()))


if __name__ == '__main__':
    unittest.main()
