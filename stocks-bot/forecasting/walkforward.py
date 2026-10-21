"""Expanding, purged, nested day-based evaluation. Research only; no model promotion.

Final dates never participate in walk-forward fitting or parameter selection.
Costs are supplied by frozen labels; missing executable evidence stays missing.
"""
import argparse
import json
import math
from pathlib import Path
from datetime import datetime, timezone
from engine import canonical, digest, epoch, matrix, metrics, Warehouse


def purge(rows, cutoff, embargo=300):
    return [r for r in rows if r['time'] < cutoff and
            max(r['label']['end'], r['label']['availableAt']) < cutoff - embargo]


def nested_parts(history, test_start, embargo=300):
    history = purge(history, test_start, embargo)
    days = sorted({r['day'] for r in history})
    if len(days) < 8:
        raise ValueError('need eight independent pre-test dates after purging')
    train_end, select_end = int(len(days) * .6), int(len(days) * .8)
    chosen = [set(days[:train_end]), set(days[train_end:select_end]), set(days[select_end:])]
    parts = [[r for r in history if r['day'] in part] for part in chosen]
    for i in [0, 1]:
        if not parts[i + 1]:
            raise ValueError('empty chronological partition')
        parts[i] = purge(parts[i], min(r['time'] for r in parts[i + 1]), embargo)
    if any(len(p) < 10 for p in parts):
        raise ValueError('fewer than ten usable rows in a nested partition')
    return parts


def plan_folds(rows, folds=3, holdout_fraction=.2, embargo=300):
    if folds not in [2, 3, 4] or holdout_fraction != .2 or embargo < 0:
        raise ValueError('unsupported predeclared experiment configuration')
    days = sorted({r['day'] for r in rows})
    if len(days) < 24 or len(rows) < 200:
        raise ValueError('need 200 labeled observations and 24 independent dates')
    cutoff = int(len(days) * (1 - holdout_fraction))
    holdout_days = set(days[cutoff:])
    holdout = [r for r in rows if r['day'] in holdout_days]
    holdout_start = min(r['time'] for r in holdout)
    development = purge([r for r in rows if r['day'] not in holdout_days], holdout_start, embargo)
    dev_days = sorted({r['day'] for r in development})
    initial = max(8, int(len(dev_days) * .5))
    remaining = len(dev_days) - initial
    if remaining < folds:
        raise ValueError('insufficient independent evaluation blocks')
    plan = []
    for index in range(folds):
        start = initial + remaining * index // folds
        end = initial + remaining * (index + 1) // folds
        test_days = set(dev_days[start:end])
        test = [r for r in development if r['day'] in test_days]
        test_start = min(r['time'] for r in test)
        past = [r for r in development if r['time'] < test_start]
        train, selection, calibration = nested_parts(past, test_start, embargo)
        plan.append((train, selection, calibration, test))
    final = (*nested_parts(development, holdout_start, embargo), holdout)
    return plan, final


def fit_fold(parts):
    import lightgbm as lgb
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    training, selection, calibration, testing = parts
    names = sorted(training[0]['observation']['features'])
    if any(set(r['observation']['features']) != set(names) for part in parts for r in part):
        raise ValueError('mixed feature schemas')
    x = lambda part: matrix([r['observation'] for r in part], names)
    y = lambda part, target: np.array([r['label'][target] for r in part])
    predictions, reports, fitted = {}, {}, {}
    for target in ['direction', 'targetBeforeStop']:
        if any(len(set(y(p, target))) < 2 for p in [training, calibration]):
            reports[target] = {'status': 'blocked', 'reason': 'training/calibration class diversity missing'}
            continue
        candidates = []
        for rounds in [30, 60]:
            model = lgb.LGBMClassifier(n_estimators=rounds, num_leaves=7, min_child_samples=20,
                                      random_state=17, n_jobs=2, verbosity=-1).fit(x(training), y(training, target))
            p = model.booster_.predict(x(selection), num_threads=2)
            candidates.append((metrics(y(selection, target), p)['brier'], rounds, model))
        _, rounds, model = min(candidates, key=lambda value: (value[0], value[1]))
        cal_raw = np.clip(model.booster_.predict(x(calibration), num_threads=2), 1e-6, 1-1e-6)
        platt = LogisticRegression().fit(np.log(cal_raw / (1-cal_raw)).reshape(-1, 1), y(calibration, target))
        raw = np.clip(model.booster_.predict(x(testing), num_threads=2), 1e-6, 1-1e-6)
        probabilities = platt.predict_proba(np.log(raw / (1-raw)).reshape(-1, 1))[:, 1]
        prior = float(y(training, target).mean())
        reports[target] = {'model': metrics(y(testing, target), probabilities),
                           'trainingPrior': metrics(y(testing, target), np.full(len(testing), prior)),
                           'noInformation': metrics(y(testing, target), np.full(len(testing), .5)), 'selectedRounds': rounds}
        fitted[target] = {'booster': model.booster_.model_to_string(), 'coefficient': float(platt.coef_[0][0]),
                          'intercept': float(platt.intercept_[0])}
        predictions[target] = probabilities.tolist()
        predictions[target + 'Prior'] = [prior] * len(testing)
    regressor = lgb.LGBMRegressor(n_estimators=30, num_leaves=7, min_child_samples=20,
                                 random_state=17, n_jobs=2, verbosity=-1).fit(x(training), y(training, 'returnPct'))
    return_predictions = regressor.booster_.predict(x(testing), num_threads=2)
    actual = y(testing, 'returnPct')
    reports['return'] = {'maePct': float(np.mean(np.abs(actual-return_predictions))),
                         'noChangeMaePct': float(np.mean(np.abs(actual)))}
    fitted['return'] = regressor.booster_.model_to_string()
    scored = []
    for index, row in enumerate(testing):
        momentum = row['observation']['features'].get('change1h')
        if momentum is None:
            momentum = row['observation']['features'].get('return5mPct')
        scored.append({**row, 'probabilityUp': predictions.get('direction', [None]*len(testing))[index],
                       'targetProbability': predictions.get('targetBeforeStop', [None]*len(testing))[index],
                       'trainingPrior': predictions.get('directionPrior', [None]*len(testing))[index],
                       'expectedReturnPct': float(return_predictions[index]),
                       'momentumBaselineProbability': None if momentum is None else .55 if momentum > 0 else .45 if momentum < 0 else .5})
    boundaries = [{ 'rows':len(part), 'first':min(r['time'] for r in part), 'last':max(r['time'] for r in part),
                    'latestLabelAvailability':max(r['label']['availableAt'] for r in part), 'dates':len({r['day'] for r in part}) } for part in parts]
    return {'metrics':reports, 'partitions':boundaries,
            'fitHash':digest({'features':names,'fitted':fitted}),
            'fitDataHash':digest([[r['observation'],r['label']] for part in parts[:3] for r in part])}, scored


def paper_summary(scored, choose='model'):
    # One global position at a time, no leverage. Fixed research rule, not production risk approval.
    selected = []
    available = -math.inf
    ordered = sorted(scored, key=lambda r:(r['time'], -(r.get('targetProbability') or 0), r['observation']['symbol']))
    for row in ordered:
        label = row['label']
        if label.get('netReturnPct') is None or 'terminalAt' not in label:
            continue
        start = label.get('start', row['time'])
        cost = label.get('costBps', 20) / 100
        if choose == 'model':
            qualifies = row['targetProbability'] is not None and row['targetProbability'] >= .6 and row['probabilityUp'] >= .55 and row['expectedReturnPct'] > cost
        else:
            qualifies = row.get('momentumBaselineProbability') == .55
        if not qualifies or start < available:
            continue
        available = label['terminalAt']
        selected.append(row)
    returns = [r['label']['netReturnPct'] for r in selected]
    wins, losses = sum(max(0,v) for v in returns), -sum(min(0,v) for v in returns)
    equity = peak = 1.0
    drawdown = 0.0
    for value in returns:
        equity *= 1 + value / 100
        peak = max(peak, equity)
        drawdown = max(drawdown, 1 - equity / peak)
    return {'trades':len(selected), 'dates':len({r['day'] for r in selected}),
            'meanNetReturnPct':sum(returns)/len(returns) if returns else None,
            'compoundedReturnPct':(equity-1)*100 if returns else None,
            'profitFactor':wins/losses if losses else 'Infinity' if wins else None,
            'maxDrawdownPct':drawdown*100 if returns else None,
            'expectancyR':sum(r['label']['netReturnPct']/r['label']['stopPct'] for r in selected)/len(selected) if selected else None,
            'executionVerified':False, 'policy':'one global position; pTarget >= .60, pUp >= .55, expected gross return > frozen round-trip cost',
            'productionApproval':False}


def aggregate(scored):
    import numpy as np
    valid = [r for r in scored if r['probabilityUp'] is not None]
    if not valid:
        return {'status':'blocked','reason':'no direction estimates; class diversity or data missing'}
    y = [r['label']['direction'] for r in valid]
    model_metrics = metrics(y, [r['probabilityUp'] for r in valid])
    prior_metrics = metrics(y, [r['trainingPrior'] for r in valid])
    by_day = {}
    for row in valid:
        actual = row['label']['direction']
        by_day.setdefault(row['day'], []).append((row['probabilityUp']-actual)**2 - (row['trainingPrior']-actual)**2)
    daily = np.array([np.mean(values) for _,values in sorted(by_day.items())])
    interval = None
    if len(daily) >= 5:
        boot = np.random.default_rng(17).choice(daily,(1000,len(daily)),replace=True).mean(axis=1)
        interval = [float(v) for v in np.quantile(boot,[.025,.975])]
    groups = {}
    for row in valid:
        regime = row['observation'].get('marketRegime','unknown')
        groups.setdefault(regime,[]).append(row)
    momentum = [r for r in valid if r['momentumBaselineProbability'] is not None]
    return {'status':'descriptive_research_only', 'observations':len(valid), 'independentDates':len(by_day),
            'direction':model_metrics, 'trainingPrior':prior_metrics,
            'noInformation':metrics(y,[.5]*len(valid)),
            'momentumBaseline':metrics([r['label']['direction'] for r in momentum],[r['momentumBaselineProbability'] for r in momentum]) if momentum else None,
            'pairedDayBrierDifference95Interval':interval,
            'dayBootstrapSamples':1000, 'dayWeightedMeanBrierDifference':float(daily.mean()),
            'regimes':{k:metrics([r['label']['direction'] for r in rows],[r['probabilityUp'] for r in rows]) for k,rows in groups.items()},
            'modelPaperPolicy':paper_summary(valid), 'momentumPaperPolicy':paper_summary(valid,'momentum')}


def evaluate(rows, folds=3, embargo=300):
    ordered = sorted(rows,key=lambda r:(r['time'],r['observation']['symbol'],r['observation']['id']))
    report = {'schema':'stocks-walk-forward-v1','datasetHash':digest(ordered), 'productionApproval':False,
              'configuration':{'folds':folds,'embargoSeconds':embargo,'holdoutFraction':.2,'seed':17},
              'auralithComparison':{'status':'unavailable','reason':'Full production replay requires archived market/sector/events/executable quotes and original champion; a technical score is not the full strategy.'},
              'limitations':['Retrospective bars may be corrected or adjusted; no point-in-time news/quote proof.',
                             'No automatic promotion; repeated experiments and small date samples require independent forward validation.']}
    try:
        plan, final = plan_folds(ordered,folds=folds,embargo=embargo)
    except ValueError as exc:
        return {**report,'status':'blocked','reason':str(exc),'observations':len(ordered),'dates':len({r['day'] for r in ordered})}
    reports, scored = [], []
    for index, parts in enumerate(plan):
        result, predictions = fit_fold(parts)
        reports.append({'fold':index+1,**result})
        scored.extend(predictions)
    final_result, final_scored = fit_fold(final)
    report.update(status='evaluated_research_only', folds=reports, walkForward=aggregate(scored),
                  finalHoldout={'fit':final_result,'evaluation':aggregate(final_scored),
                                'firstDate':min(r['day'] for r in final[-1]),'lastDate':max(r['day'] for r in final[-1])})
    return report


def warehouse_rows(store, horizon):
    rows = []
    for observation, label in store.db.execute('SELECT o.payload,l.payload FROM observations o JOIN labels l ON o.id=l.observation_id WHERE l.horizon=?',(str(horizon),)):
        observation, label = json.loads(observation),json.loads(label)
        rows.append({'observation':observation,'label':label,'time':epoch(observation['availableAt']),
                     'day':datetime.fromtimestamp(epoch(observation['availableAt']),timezone.utc).strftime('%Y-%m-%d')})
    return rows


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--db'); source.add_argument('--dataset')
    parser.add_argument('--horizon',type=int,choices=[5,15,30,90,240],required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    output=Path(args.output)
    if output.exists():
        raise ValueError('refusing to overwrite an experiment')
    if args.db:
        # Read-only URI: evaluating must never create/change a production ledger.
        import sqlite3
        class Store: pass
        store=Store(); store.db=sqlite3.connect(Path(args.db).resolve().as_uri()+'?mode=ro',uri=True)
        try: rows=warehouse_rows(store,args.horizon)
        finally: store.db.close()
        provenance={'source':'immutable prospective warehouse','historyAvailability':'actual recorded label availability'}
    else:
        from historical import load_research_dataset
        rows,provenance=load_research_dataset(args.dataset,args.horizon)
    report=evaluate(rows)
    report['horizonMinutes']=args.horizon
    report['provenance']=provenance
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf-8')
    print(canonical({'status':report['status'],'horizon':args.horizon,'observations':len(rows),'productionApproval':False}))


if __name__=='__main__':
    main()
