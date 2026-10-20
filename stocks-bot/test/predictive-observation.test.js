import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictiveObservation } from '../src/predictiveObservation.js';
import { requestPredictiveForecast } from '../src/predictiveClient.js';

const now = new Date('2026-10-20T15:00:10Z');
function asset(extra = {}) { return { symbol: 'TEST', price: 10, dataQuality: 90, provider: 'Alpaca IEX',
  lastUpdated: '2026-10-20T15:00:00Z', relativeVolume: 2, relativeStrengthDay: 1, vwapDistancePct: .1, ...extra }; }
test('all screened records retain six horizon contracts, source times and missingness', () => {
  const row = buildPredictiveObservation(asset(), { availableAt: now, scanStartedAt: new Date(now - 20000) });
  assert.equal(row.requests.length, 6);
  assert.equal(row.features.tradeFlow1m, null);
  assert.equal(row.features.spreadBps, null);
  assert.equal(row.feedCoverage, 'single_venue');
  assert.equal(row.sourceAgeSeconds, 10);
  assert.equal(row.alertStage, 'EARLY_WATCH');
  assert.equal(row.earlyPredictionProven, false);
  assert.equal(row.productionApproval, false);
  assert.equal(row.requests.at(-1).reason, 'verified_next_session_calendar_required');
});
test('stale, future, delayed, halted and missing source data abstain', () => {
  for (const extra of [{lastUpdated: '2026-10-20T14:00:00Z'}, {lastUpdated: '2026-10-20T16:00:00Z'},
    {lastUpdated: ''}, {halted: true}, {delayed: true}, {dataQuality: null}]) {
    const row = buildPredictiveObservation(asset(extra), { availableAt: now });
    assert.ok(row.dataIssues.length);
    assert.equal(row.requests[0].status, 'abstain');
  }
});
test('price source timestamps stay separate from older feature timestamps', () => {
  const row = buildPredictiveObservation(asset({ lastUpdated: '2026-10-20T14:55:00Z', livePriceUpdatedAt: '2026-10-20T15:00:00Z' }), { availableAt: now });
  assert.equal(row.sourceAgeSeconds, 10);
  assert.equal(row.featureSourceAt, '2026-10-20T14:55:00Z');
});
test('forecast horizons do not silently truncate at early close or span closed sessions', () => {
  const late = new Date('2026-11-27T17:50:00Z'); // Friday after Thanksgiving, closes 18:00Z.
  const row = buildPredictiveObservation(asset({lastUpdated: late.toISOString()}), { availableAt: late });
  assert.equal(row.requests[1].reason, 'horizon_crosses_session_close');
  const weekend = buildPredictiveObservation(asset(), { availableAt: new Date('2026-10-24T15:00:00Z') });
  assert.equal(weekend.requests[0].reason, 'regular_session_training_only');
});
test('only timestamped publicly available catalysts enter new research inputs', () => {
  const row = buildPredictiveObservation(asset({manualCatalysts: [
    {id:'past', publishedAt:'2026-10-20T14:00:00Z'}, {id:'future',publishedAt:'2026-10-20T16:00:00Z'}, {id:'unknown'}]}), { availableAt: now });
  assert.deepEqual(row.catalysts.map(x => x.id), ['past']);
});
test('service cannot send credentials through insecure external endpoints or redirects', async () => {
  const observation = buildPredictiveObservation(asset(), { availableAt: now });
  for (const endpoint of ['http://example.com/forecast','https://user:pass@example.com/forecast', 'https://example.com/forecast?token=x'])
    await assert.rejects(requestPredictiveForecast(observation, {endpoint, token:'x'.repeat(32)}));
});
test('service failure and invalid production claims fail closed in the isolated client', async () => {
  const observation = buildPredictiveObservation(asset(), { availableAt: now });
  const options = {endpoint:'http://127.0.0.1:8792/forecast',token:'x'.repeat(32)};
  await assert.rejects(requestPredictiveForecast(observation, {...options, fetcher:async()=>new Response('{}',{status:503})}), /503/);
  await assert.rejects(requestPredictiveForecast(observation, {...options, fetcher:async()=>Response.json({forecasts:[]})}), /contract/);
});
