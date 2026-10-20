import test from 'node:test';
import assert from 'node:assert/strict';
import { createFuturesActivityScreen, inspectFuturesActivityDirectory } from '../src/futuresActivityScreen.js';
import { remainingFuturesHistoricalBudget } from '../src/historicalCostBudget.js';
import { summarizeFuturesFunnel } from '../src/diagnostics.js';

import { now, start, end, contract, directory, bar } from './fixtures/activity.mjs';
const make = (contracts, config = {}) => createFuturesActivityScreen({ directory: directory(contracts), dataset: 'GLBX.MDP3', now, start, end, ...config });

test('whole-directory inexpensive activity reaches final non-priority symbol before candidate cap', () => {
  const contracts = Array.from({ length: 601 }, (_, i) => contract(i + 1)), s = make(contracts, { maxCandidates: 2 });
  for (const c of contracts) for (let m = 56; m <= 59; m++) s.add(bar(c, m, c.providerInstrumentId === '601' && m === 59 ? { close: 104, high: 104, volume: 1000 } : {}));
  const result = s.finish();
  assert.equal(result.diagnostics.universe, 601); assert.equal(result.diagnostics.observed, 601);
  assert.equal(result.diagnostics.dataQualified, 601); assert.equal(result.diagnostics.candidates, 2); assert.equal(result.diagnostics.deferred, 599);
  assert.equal(result.candidates[0].providerInstrumentId, '601');
  assert.equal(result.candidates[0].recentVolumeRatio, 10);
  assert.equal(result.candidates[0].brokeWindowHigh, true);
  assert.equal(result.candidates[0].tradeEligible, false);
  assert.equal(result.candidates[0].quoteQuality, 'no_executable_quote');
  assert.equal(result.diagnostics.rejectionReasons.candidate_budget, 599);
});

test('expiry order and observed-volume leader are distinct, with no automatic front/active designation', () => {
  const near = contract(1, 'ES', { expiry: '2026-11-20T00:00:00Z' }), far = contract(2, 'ES', { providerRawSymbol: 'ESH7', expiry: '2027-03-20T00:00:00Z' });
  const s = make([near, far]);
  for (const c of [near, far]) for (const m of [58, 59]) s.add(bar(c, m, { volume: c === near ? 100 : 1000 }));
  const r = s.finish();
  assert.equal(r.candidates[0].providerRawSymbol, 'ESH7'); assert.equal(r.candidates[0].expiryOrderInDirectory, 2);
  assert.equal(r.candidates[0].observedWindowVolumeRank, 1); assert.equal(r.candidates[0].contractRole, 'deferred_expiry_reference');
  assert.equal(r.rows[0].reasons[0], 'per_root_candidate_budget');
  assert.equal(r.candidates[0].openInterest, null);
});

test('sparse intervals remain missing and short/sparse volume ratios are unknown', () => {
  const c = contract(1), s = make([c]);
  for (const m of [53, 55, 57, 59]) s.add(bar(c, m));
  const row = s.finish().candidates[0];
  assert.equal(row.observedBars, 4); assert.equal(row.missingTradeIntervals, 26);
  assert.equal(row.recentVolumeRatio, null); assert.equal(row.accelerationPctPoints, null);
  assert.equal(row.totalContractsTraded, 400);
});

test('negative and zero quotes remain discoverable research; undefined percent acceleration stays unknown', () => {
  const c = contract(1), s = make([c]);
  for (const [index, price] of [-1, 0, 1, 2].entries()) s.add(bar(c, 56 + index, { open: price, high: price + 1, low: price - 1, close: price }));
  const result = s.finish();
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].accelerationPctPoints, null);
  assert.equal(result.candidates[0].tradeEligible, false);
});

test('latest data age is re-evaluated after collection without promoting missing, stale or expired references', () => {
  const c = contract(1), silent = contract(2), expires = contract(3, 'EXP', { expiry: '2026-10-02T16:01:00Z' });
  const s = make([c, silent, expires]);
  for (const row of [c, expires]) for (const m of [58, 59]) s.add(bar(row, m));
  const r = s.finish({ observedNow: now + 4 * 60_000 });
  assert.equal(r.candidates.length, 0); assert.equal(r.diagnostics.rejectionReasons.stale_last_bar, 2);
  assert.equal(r.diagnostics.rejectionReasons.no_recent_trade_bars, 1); assert.equal(r.diagnostics.rejectionReasons.contract_expired, 1);
});

test('wrong publisher/raw identity, invalid price types, cross-date/incomplete bars and wrong schema are explicit', () => {
  const c = contract(1), s = make([c]);
  s.add(bar(c, 59, { hd: { rtype: 33, publisher_id: 2, instrument_id: 1, ts_event: '2026-10-02T15:59:00Z' } }));
  s.add(bar(c, 59, { symbol: 'COLLISION' }));
  s.add(bar(c, 59, { close: true }));
  s.add(bar(c, 59, { ts_event: '2026-10-01T15:59:00Z' }));
  s.add(bar(c, 59, { ts_event: '2026-10-02T16:00:00Z' }));
  s.add(bar(c, 59, { rtype: 34 }));
  const r = s.finish();
  assert.equal(r.diagnostics.barRecordRejections.outside_outright_directory, 1);
  assert.equal(r.diagnostics.barRecordRejections.raw_symbol_mismatch, 1);
  assert.equal(r.diagnostics.barRecordRejections.invalid_ohlcv, 1);
  assert.equal(r.diagnostics.barRecordRejections.invalid_or_incomplete_bar_time, 2);
  assert.equal(r.diagnostics.barRecordRejections.invalid_bar_schema, 1);
  assert.equal(r.recordDispositions.length, 6);
});

test('duplicate bars cannot inflate volume; inconsistent revisions reject the contract', () => {
  const c = contract(1), s = make([c]);
  s.add(bar(c, 58)); s.add(bar(c, 58)); s.add(bar(c, 59)); s.add(bar(c, 59, { volume: 200 }));
  const r = s.finish();
  assert.equal(r.diagnostics.acceptedRecords, 2); assert.equal(r.diagnostics.duplicateRecords, 2);
  assert.equal(r.candidates.length, 0); assert.equal(r.diagnostics.rejectionReasons.conflicting_bar_revision, 1);
});

test('only current-date, full, unambiguous outright directories can be screened', () => {
  const c = contract(1), d = directory([c]);
  assert.equal(inspectFuturesActivityDirectory(d, { dataset: 'GLBX.MDP3', now }), null);
  assert.equal(inspectFuturesActivityDirectory({ ...d, status: 'stale_cache_after_provider_error' }, { dataset: 'GLBX.MDP3', now }), 'directory_not_current');
  assert.equal(inspectFuturesActivityDirectory(d, { dataset: 'OTHER.MDP3', now }), 'directory_dataset_mismatch');
  assert.equal(inspectFuturesActivityDirectory(d, { dataset: 'GLBX.MDP3', now: now + 86_400_000 }), 'directory_date_mismatch');
  assert.equal(inspectFuturesActivityDirectory(directory([c, c]), { dataset: 'GLBX.MDP3', now }), 'directory_identity_invalid');
  assert.throws(() => make([c], { maxCandidates: 101 }), /limits/);
});

test('historical budget reserves accepted directory/activity/H1 downloads and rejects malformed cost evidence', () => {
  assert.equal(remainingFuturesHistoricalBudget(0.3, [{ operation: 'estimated-contract-discovery-cost', estimatedCostUsd: 0.1 }]), 0.2);
  const metrics = [
    { operation: 'estimated-contract-discovery-cost', estimatedCostUsd: 0.1, configuredCapUsd: 1 },
    { operation: 'estimated-activity-discovery-cost', estimatedCostUsd: 0.2, configuredCapUsd: 0.9 },
    { operation: 'estimated-scan-cost', estimatedCostUsd: 2, configuredCapUsd: 0.7 },
    { operation: 'estimated-h1-cost', estimatedCostUsd: 0.3, configuredCapUsd: 0.7 },
    { operation: 'activity-minute-bars', status: 500, error: 'Interrupted paid download', latencyMs: 100 },
  ];
  assert.ok(Math.abs(remainingFuturesHistoricalBudget(1, metrics) - 0.4) < 1e-9);
  const report = summarizeFuturesFunnel([], { providerMetrics: metrics });
  assert.equal(report.provider.requests, 1); assert.equal(report.provider.failures, 1);
  assert.equal(report.provider.estimatedTotalCostUsd, 0.6); assert.equal(report.provider.estimatedH1CostUsd, 0.3);
  assert.equal(report.provider.estimatedActivityDiscoveryCostUsd, 0.2);
  assert.equal(remainingFuturesHistoricalBudget(1, [{ operation: 'estimated-h1-cost', estimatedCostUsd: null }]), 0);
});
