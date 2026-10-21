"""Isolated Stocks research engine. No broker/order API or production promotion path.

Only accepts immutable point-in-time observations emitted by the Node scanner.
OHLC simulated outcomes are research labels, never executable trade verification.
"""
import argparse
import hashlib
import json
import math
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 'stocks-predictive-v1'
HORIZONS = [5, 15, 30, 90, 240, 'next_session']


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate(observation):
    if observation.get('schema') != SCHEMA or not observation.get('id'):
        raise ValueError('unsupported observation schema')
    if not isinstance(observation.get('features'), dict) or not observation['features']:
        raise ValueError('features required')
    if not isinstance(observation.get('symbol'), str) or len(observation['symbol']) > 16:
        raise ValueError('instrument identity required')
    if not math.isfinite(epoch(observation['availableAt'])):
        raise ValueError('invalid availableAt')
    requests = observation.get('requests')
    if not isinstance(requests, list) or [r.get('horizon') for r in requests] != HORIZONS:
        raise ValueError('complete horizon contract required')
    for request in requests:
        horizon = request['horizon']
        if isinstance(horizon, int) and abs(epoch(request['expiresAt']) - epoch(observation['availableAt']) - horizon * 60) > .001:
            raise ValueError('incorrect horizon deadline')
    for value in observation['features'].values():
        if value is not None and (not isinstance(value, (int, float)) or not math.isfinite(value)):
            raise ValueError('nonfinite feature')
    canonical(observation)
    return observation


class Warehouse:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS forecasts(id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, horizon TEXT NOT NULL,
            version TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(observation_id,horizon,version));
          CREATE TABLE IF NOT EXISTS labels(observation_id TEXT NOT NULL, horizon TEXT NOT NULL,
            payload TEXT NOT NULL, PRIMARY KEY(observation_id,horizon));
          CREATE TABLE IF NOT EXISTS offsets(file TEXT PRIMARY KEY, position INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, payload TEXT NOT NULL);
        ''')

    def observe(self, item):
        validate(item)
        old = self.db.execute('SELECT hash FROM observations WHERE id=?', (item['id'],)).fetchone()
        if old and old[0] != digest(item):
            raise ValueError('immutable observation conflict')
        self.db.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?)', (item['id'], digest(item), canonical(item)))
        if self.db.execute('SELECT hash FROM observations WHERE id=?', (item['id'],)).fetchone()[0] != digest(item):
            raise ValueError('immutable observation conflict')

    def forecasts(self, observation, model=None):
        self.observe(observation)
        version = model['version'] if model else 'no-trained-model'
        output = []
        for horizon in HORIZONS:
            key = digest([observation['id'], horizon, version])
            previous = self.db.execute('SELECT payload FROM forecasts WHERE id=?', (key,)).fetchone()
            if previous:
                output.append(json.loads(previous[0]))
                continue
            request = next((r for r in observation.get('requests', []) if r['horizon'] == horizon), None)
            reason = 'missing_horizon_contract' if not request else request.get('reason')
            inferred_at = time.time()
            if not reason and request.get('expiresAt') and epoch(request['expiresAt']) <= inferred_at:
                reason = 'forecast_expired_at_inference'
            values = None
            if not reason and observation.get('dataIssues'):
                reason = observation['dataIssues'][0]
            if not reason and model and epoch(model['createdAt']) > epoch(observation['availableAt']):
                reason = 'model_not_available_at_observation'
            if not reason and model and str(horizon) in model.get('experts', {}):
                values = predict(model, observation, horizon)
            if not reason and not values:
                reason = 'no_trained_horizon_model'
            row = {'id': key, 'observationId': observation['id'], 'symbol': observation['symbol'],
                   'predictionAt': observation['availableAt'], 'horizon': horizon, 'modelVersion': version,
                   'inferredAt': datetime.fromtimestamp(inferred_at, timezone.utc).isoformat(),
                   'observationToInferenceMs': max(0, (inferred_at - epoch(observation['availableAt'])) * 1000),
                   'status': 'experimental_forecast' if values else 'abstain', 'reason': reason,
                   'productionApproval': False, 'calibratedProbability': None,
                   'expiresAt': request.get('expiresAt') if request else None,
                   'dataQuality': observation.get('dataIssues', []), **(values or {})}
            self.db.execute('INSERT INTO forecasts VALUES(?,?,?,?,?)',
                            (key, observation['id'], str(horizon), version, canonical(row)))
            output.append(row)
        return output

    def ingest(self, files, model=None):
        count = 0
        for file in files:
            name = str(Path(file).resolve())
            saved = self.db.execute('SELECT position FROM offsets WHERE file=?', (name,)).fetchone()
            position = saved[0] if saved else 0
            if Path(file).stat().st_size < position:
                raise ValueError('source file truncated; refusing cursor reset')
            # Commit the cursor in the same transaction as forecasts; torn tails wait for the next run.
            with self.db, open(file, 'rb') as stream:
                stream.seek(position)
                while True:
                    line = stream.readline()
                    if not line or not line.endswith(b'\n'):
                        break
                    if len(line) > 2_000_000:
                        raise ValueError('oversized observation record')
                    row = json.loads(line)
                    observation = row.get('predictiveObservation')
                    if observation:
                        self.forecasts(observation, model)
                        count += 1
                    position = stream.tell()
                self.db.execute('INSERT OR REPLACE INTO offsets VALUES(?,?)', (name, position))
        return count

    def label(self, bars, now=None, cost_bps=20, target_pct=1, stop_pct=0.75):
        now = time.time() if now is None else now
        if not (0 <= cost_bps <= 500 and target_pct > 0 and stop_pct > 0):
            raise ValueError('invalid execution assumptions')
        assumptions = canonical([cost_bps, target_pct, stop_pct, 'stop-first-v1'])
        old = self.db.execute("SELECT payload FROM metadata WHERE key='execution_assumptions'").fetchone()
        if old and old[0] != assumptions:
            raise ValueError('execution assumptions changed; use a separate research database')
        self.db.execute("INSERT OR IGNORE INTO metadata VALUES('execution_assumptions',?)", (assumptions,))
        count, reasons = 0, {}
        by_symbol = {}
        for row in bars:
            # Exact feed and timestamp identity; never synthesize absent minutes or silently overwrite corrections.
            key = (row.get('provider'), row.get('symbol'))
            timestamp = row.get('timestamp')
            if not isinstance(timestamp, (int, float)) or timestamp % 60:
                continue
            if not all(isinstance(row.get(f), (int, float)) and math.isfinite(row[f]) and row[f] > 0 for f in ['open', 'high', 'low', 'close']):
                continue
            if row['low'] > min(row['open'], row['close']) or row['high'] < max(row['open'], row['close']) or row['high'] < row['low']:
                continue
            history = by_symbol.setdefault(key, {})
            if timestamp in history and canonical(history[timestamp]) != canonical(row):
                raise ValueError('conflicting historical bar identity')
            history[timestamp] = row
        for item, in self.db.execute('SELECT payload FROM observations').fetchall():
            observation = json.loads(item)
            start = math.ceil(epoch(observation['availableAt']) / 60) * 60
            provider = observation.get('provider', '').lower().replace(' ', '-')
            history = by_symbol.get((provider, observation['symbol']), {})
            for request in observation['requests']:
                horizon = request['horizon']
                if request.get('reason') or horizon == 'next_session':
                    continue
                if self.db.execute('SELECT 1 FROM labels WHERE observation_id=? AND horizon=?', (observation['id'], str(horizon))).fetchone():
                    continue
                end = math.floor(epoch(request['expiresAt']) / 60) * 60
                times = list(range(start, end, 60))
                if not times or end > now:
                    continue
                if any(t not in history for t in times):
                    reasons['incomplete_minute_path'] = reasons.get('incomplete_minute_path', 0) + 1
                    continue
                path = [history[t] for t in times]
                # A late historical backfill cannot become a label allegedly available months earlier.
                availability = max([end] + [epoch(b['recordedAt']) for b in path if b.get('recordedAt')])
                if availability > now:
                    continue
                entry = path[0]['open'] * (1 + cost_bps / 20000)
                stop, target = entry * (1 - stop_pct / 100), entry * (1 + target_pct / 100)
                exit_price, outcome, terminal = path[-1]['close'], 'expiry', end
                for bar in path:
                    if bar['low'] <= stop:
                        exit_price, outcome, terminal = min(stop, bar['open']), 'stop', bar['timestamp'] + 60
                        break
                    if bar['high'] >= target:
                        exit_price, outcome, terminal = target, 'target', bar['timestamp'] + 60
                        break
                # Excursions cover the whole horizon, clearly distinct from realized position excursions.
                row = {'availableAt': max(now, availability), 'end': end, 'start': start,
                       'direction': int(path[-1]['close'] > path[0]['open']),
                       'returnPct': (path[-1]['close'] / path[0]['open'] - 1) * 100,
                       'netReturnPct': (exit_price * (1 - cost_bps / 20000) / entry - 1) * 100,
                       'targetBeforeStop': int(outcome == 'target'), 'terminal': outcome, 'terminalAt': terminal,
                       'horizonMfePct': (max(b['high'] for b in path) / entry - 1) * 100,
                       'horizonMaePct': (min(b['low'] for b in path) / entry - 1) * 100,
                       'costBps': cost_bps, 'targetPct': target_pct, 'stopPct': stop_pct,
                       'executionVerified': False, 'pathHash': digest(path)}
                self.db.execute('INSERT INTO labels VALUES(?,?,?)', (observation['id'], str(horizon), canonical(row)))
                count += 1
        self.db.commit()
        return {'labelsAdded': count, 'unresolved': reasons}


def matrix(observations, names):
    import numpy as np
    return np.array([[float(o['features'][n]) if o['features'].get(n) is not None else float('nan') for n in names]
                     for o in observations])


def metrics(y, probabilities, returns=None, predictions=None):
    import numpy as np
    from sklearn.metrics import brier_score_loss, log_loss, precision_score, recall_score
    p = np.clip(probabilities, 1e-6, 1 - 1e-6)
    bins = []
    for lo in np.arange(0, 1, .1):
        mask = (p >= lo) & (p < lo + .1)
        if mask.any():
            bins.append({'low': float(lo), 'count': int(mask.sum()), 'meanProbability': float(p[mask].mean()), 'frequency': float(np.array(y)[mask].mean())})
    result = {'n': len(y), 'accuracy': float(np.mean((p >= .5) == y)),
              'precision': float(precision_score(y, p >= .5, zero_division=0)),
              'recall': float(recall_score(y, p >= .5, zero_division=0)),
              'brier': float(brier_score_loss(y, p)), 'logLoss': float(log_loss(y, p, labels=[0, 1])), 'calibration': bins}
    if returns is not None:
        result['returnMaePct'] = float(np.mean(np.abs(np.array(returns) - np.array(predictions))))
        result['noChangeReturnMaePct'] = float(np.mean(np.abs(returns)))
    return result


def chronological_partition(rows, embargo_seconds=300):
    # Split globally by date, never randomly by symbol; purge full label intervals AND actual availability.
    days = sorted({r['day'] for r in rows})
    if len(days) < 24 or len(rows) < 200:
        raise ValueError('need 200 labels across at least 24 independent days')
    boundaries = [0, int(len(days) * .50), int(len(days) * .65), int(len(days) * .80), len(days)]
    parts = []
    for index in range(4):
        chosen = set(days[boundaries[index]:boundaries[index + 1]])
        subset = [r for r in rows if r['day'] in chosen]
        if index < 3:
            next_start = min(r['time'] for r in rows if r['day'] == days[boundaries[index + 1]])
            subset = [r for r in subset if max(r['label']['end'], r['label']['availableAt']) < next_start - embargo_seconds]
        if len(subset) < 10:
            raise ValueError('purging left insufficient independent observations')
        parts.append(subset)
    return parts


def train(warehouse, output):
    import lightgbm as lgb
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    if Path(output).exists():
        raise ValueError('refusing to overwrite an existing experiment')
    model = {'schema': SCHEMA, 'status': 'research_only', 'experts': {}, 'productionApproval': False,
             'createdAt': datetime.now(timezone.utc).isoformat(), 'limitations': ['OHLC costs are assumptions; no NBBO execution proof',
             'No automatic champion promotion', 'No next-session model without verified calendar and corporate actions',
             'Fixed chronological holdout; expanding walk-forward/regime comparison remains required']}
    policy = warehouse.db.execute("SELECT payload FROM metadata WHERE key='execution_assumptions'").fetchone()
    model['researchPolicy'] = json.loads(policy[0]) if policy else None
    report = {}
    query = '''SELECT o.payload,l.horizon,l.payload FROM observations o JOIN labels l ON o.id=l.observation_id'''
    all_rows = warehouse.db.execute(query).fetchall()
    for horizon in HORIZONS:
        rows = []
        for observation_text, h, label_text in all_rows:
            if h != str(horizon):
                continue
            observation, label = json.loads(observation_text), json.loads(label_text)
            rows.append({'observation': observation, 'label': label, 'time': epoch(observation['availableAt']),
                         'day': observation['availableAt'][:10]})
        try:
            training, selection, calibration, holdout = chronological_partition(rows)
        except ValueError as exc:
            report[str(horizon)] = {'status': 'blocked', 'reason': str(exc), 'labels': len(rows)}
            continue
        names = sorted(training[0]['observation']['features'])
        x = lambda part: matrix([r['observation'] for r in part], names)
        y = lambda part, task: np.array([r['label'][task] for r in part])
        if any(len(set(y(part, 'direction'))) < 2 for part in [training, calibration]):
            report[str(horizon)] = {'status': 'blocked', 'reason': 'class diversity missing'}
            continue
        experts, task_reports = {}, {}
        for task in ['direction', 'targetBeforeStop']:
            if any(len(set(y(part, task))) < 2 for part in [training, calibration]):
                continue
            candidates = []
            for rounds in [30, 60]:
                fitted = lgb.LGBMClassifier(n_estimators=rounds, num_leaves=7, min_child_samples=20, n_jobs=2,
                                           verbosity=-1, random_state=17).fit(x(training), y(training, task))
                score = metrics(y(selection, task), fitted.booster_.predict(x(selection), num_threads=2))['brier']
                candidates.append((score, fitted))
            fitted = min(candidates, key=lambda item: item[0])[1]
            raw_cal = np.clip(fitted.booster_.predict(x(calibration), num_threads=2), 1e-6, 1 - 1e-6)
            platt = LogisticRegression().fit(np.log(raw_cal / (1 - raw_cal)).reshape(-1, 1), y(calibration, task))
            raw = np.clip(fitted.booster_.predict(x(holdout), num_threads=2), 1e-6, 1 - 1e-6)
            p = platt.predict_proba(np.log(raw / (1 - raw)).reshape(-1, 1))[:, 1]
            prior = float(y(training, task).mean())
            task_reports[task] = {'holdout': metrics(y(holdout, task), p),
                                 'trainingPrior': metrics(y(holdout, task), np.full(len(holdout), prior)),
                                 'noInformation': metrics(y(holdout, task), np.full(len(holdout), .5))}
            experts[task] = {'booster': fitted.booster_.model_to_string(),
                             'plattCoefficient': float(platt.coef_[0][0]), 'plattIntercept': float(platt.intercept_[0])}
        regressor = lgb.LGBMRegressor(n_estimators=30, num_leaves=7, n_jobs=2, verbosity=-1, random_state=17)
        regressor.fit(x(training), y(training, 'returnPct'))
        errors = np.abs(y(calibration, 'returnPct') - regressor.booster_.predict(x(calibration), num_threads=2))
        experts['return'] = {'booster': regressor.booster_.model_to_string(), 'residual90Pct': float(np.quantile(errors, .9))}
        task_reports['return'] = {'maePct': float(np.mean(np.abs(y(holdout, 'returnPct') - regressor.booster_.predict(x(holdout), num_threads=2)))),
                                  'noChangeMaePct': float(np.mean(np.abs(y(holdout, 'returnPct'))))}
        feature_bounds = {}
        for column, name in enumerate(names):
            observed = x(training)[:, column]
            observed = observed[np.isfinite(observed)]
            if len(observed):
                pad = max(float(observed.std()) * 4, abs(float(observed.mean())) * .1, .001)
                feature_bounds[name] = [float(observed.min()) - pad, float(observed.max()) + pad]
        model['experts'][str(horizon)] = {'features': names, 'tasks': experts, 'featureBounds': feature_bounds}
        report[str(horizon)] = {'status': 'research_only', 'partitionCounts': list(map(len, [training, selection, calibration, holdout])),
                                'metrics': task_reports, 'productionPromotion': False}
    model['version'] = 'stocks-lgbm-' + digest(model)[:16]
    model['integrity'] = digest(model)
    Path(output).write_text(canonical(model), encoding='utf-8')
    Path(str(output) + '.evaluation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return {'modelVersion': model['version'], 'horizonsTrained': len(model['experts']), 'evaluation': report}


def chronos_forecast(bars, horizon, revision):
    """Pretrained challenger on verified complete five-minute SAME-SESSION bars only."""
    if horizon not in [5, 15, 30, 90, 240] or len(revision) != 40 or any(c not in '0123456789abcdef' for c in revision):
        raise ValueError('explicit horizon and pinned model revision required')
    if len(bars) < 32 or len({b.get('sessionDate') for b in bars}) != 1 or not bars[0].get('sessionDate'):
        raise ValueError('at least 32 verified same-session bars required')
    if any(b.get('intervalMinutes') != 5 or not b.get('complete') or b.get('adjustmentStatus') != 'verified'
           or not isinstance(b.get('close'), (int, float)) or not math.isfinite(b['close']) or b['close'] <= 0 for b in bars):
        raise ValueError('unverified, incomplete or invalid bars')
    if any(bars[i]['timestamp'] - bars[i - 1]['timestamp'] != 300 for i in range(1, len(bars))):
        raise ValueError('gapped chronological context')
    if bars[-1]['timestamp'] + 300 + horizon * 60 > epoch(bars[-1]['sessionCloseAt']):
        raise ValueError('forecast crosses session close')
    import torch
    from chronos import ChronosBoltPipeline
    torch.set_num_threads(2)
    # Explicit opt-in CLI only. This never executes in Node or the ordinary service.
    pipeline = ChronosBoltPipeline.from_pretrained('amazon/chronos-bolt-tiny', revision=revision,
                                                  device_map='cpu', dtype=torch.float32)
    with torch.inference_mode():
        values = pipeline.predict(torch.tensor([b['close'] for b in bars[-512:]], dtype=torch.float32), prediction_length=horizon // 5)
    quantiles = values[0, :, -1].cpu().numpy()
    last = bars[-1]['close']
    return {'model': 'amazon/chronos-bolt-tiny', 'revision': revision, 'horizonMinutes': horizon,
            'experimentalReturnPct': (float(quantiles[4]) / last - 1) * 100,
            'rawReturnRangePct': [(float(quantiles[0]) / last - 1) * 100, (float(quantiles[-1]) / last - 1) * 100],
            'calibratedProbability': None, 'rangeCoverageValidated': False, 'productionApproval': False,
            'limitations': ['Pretraining overlap unknown; no evidence of stock forecasting skill or calibrated coverage']}


def load_model(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    integrity = value.pop('integrity', None)
    if integrity != digest(value) or value['schema'] != SCHEMA or value.get('productionApproval') is not False:
        raise ValueError('invalid research artifact')
    value['integrity'] = integrity
    return value


def predict(model, observation, horizon):
    import lightgbm as lgb
    expert = model['experts'].get(str(horizon))
    if not expert:
        return None
    # Unknown/missing schema abstains; genuinely missing features remain NaN for the model.
    if set(expert['features']) != set(observation['features']):
        return None
    values = observation['features']
    if sum(value is None for value in values.values()) / len(values) > .5:
        return None
    outliers = sum(values.get(name) is not None and not bounds[0] <= values[name] <= bounds[1]
                   for name, bounds in expert.get('featureBounds', {}).items())
    if outliers / len(values) >= .2:
        return None
    x = matrix([observation], expert['features'])
    output = {'experimentalProbabilityUp': None, 'experimentalTargetBeforeStopProbability': None}
    output['researchPolicy'] = model.get('researchPolicy')
    output['executionVerified'] = False
    for task, key in [('direction', 'experimentalProbabilityUp'), ('targetBeforeStop', 'experimentalTargetBeforeStopProbability')]:
        fitted = expert['tasks'].get(task)
        if fitted:
            raw = float(lgb.Booster(model_str=fitted['booster']).predict(x, num_threads=2)[0])
            raw = min(1 - 1e-6, max(1e-6, raw))
            z = fitted['plattCoefficient'] * math.log(raw / (1 - raw)) + fitted['plattIntercept']
            output[key] = 1 / (1 + math.exp(-max(-40, min(40, z))))
    regression = expert['tasks']['return']
    expected = float(lgb.Booster(model_str=regression['booster']).predict(x, num_threads=2)[0])
    output.update(expectedReturnPct=expected, residualRange90Pct=[expected - regression['residual90Pct'], expected + regression['residual90Pct']],
                  rangeCoverageValidated=False, expectedDirection='up' if expected > 0 else 'down' if expected < 0 else 'flat')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    ingest = sub.add_parser('ingest'); ingest.add_argument('files', nargs='+'); ingest.add_argument('--model')
    label = sub.add_parser('label'); label.add_argument('files', nargs='+'); label.add_argument('--cost-bps', type=float, default=20)
    training = sub.add_parser('train'); training.add_argument('--output', required=True)
    chronos = sub.add_parser('chronos'); chronos.add_argument('--bars', required=True); chronos.add_argument('--horizon', type=int, required=True); chronos.add_argument('--revision', required=True)
    sub.add_parser('status')
    args = parser.parse_args()
    store = Warehouse(args.db)
    try:
        if args.command == 'ingest':
            result = {'observationsRead': store.ingest(args.files, load_model(args.model) if args.model else None)}
        elif args.command == 'label':
            def bars():
                for file in args.files:
                    with open(file, encoding='utf-8') as stream:
                        for line in stream:
                            yield json.loads(line)
            result = store.label(bars(), cost_bps=args.cost_bps)
        elif args.command == 'train':
            result = train(store, args.output)
        elif args.command == 'chronos':
            result = chronos_forecast(json.loads(Path(args.bars).read_text(encoding='utf-8')), args.horizon, args.revision)
        else:
            result = {table: store.db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in ['observations', 'forecasts', 'labels']}
        store.db.commit()
        print(json.dumps(result, allow_nan=False))
    finally:
        store.db.close()


if __name__ == '__main__':
    main()
