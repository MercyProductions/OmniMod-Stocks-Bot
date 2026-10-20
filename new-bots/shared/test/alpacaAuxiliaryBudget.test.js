import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedAlpacaRequestGate } from '../alpacaSharedBudget.js';
import { fetchAlpacaCatalystNews } from '../alpacaCatalystNews.js';
import { fetchAlpacaCallDividendScreen } from '../../options/src/alpacaDividendScreen.js';
import { screenFullEquityMarket } from '../equitySnapshotDiscovery.js';
import { analyzeOptionUnderlyings } from '../../options/src/underlyingIntradayResearch.js';
import { NOW, OPEN, researchInput, researchDiscovery } from '../../options/test/underlyingResearchFixtures.js';

test('final dividend 429 shares cooldown with news and later dividend scans before any HTTP retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'alpaca-auxiliary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = NOW, calls = 0;
  const options = { directory, now: () => now, sleep: async ms => { now += ms; } };
  const requestGate = createSharedAlpacaRequestGate(options), other = createSharedAlpacaRequestGate(options);
  const rows = [{ signal: { underlyingSymbol: 'SPY', direction: 'long', sessionDate: '2026-10-02' }, chain: { expiry: '2026-10-09' } }];
  const fetcher = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '60' }) }; };
  const metrics = [];
  await fetchAlpacaCallDividendScreen(rows, { key: 'fixture', secret: 'fixture', maxAttempts: 1, requestGate, fetcher, metrics, clock: () => now });
  const news = await fetchAlpacaCatalystNews(['SPY'], { key: 'fixture', secret: 'fixture', requestGate: other, fetcher, metrics, now });
  const second = await fetchAlpacaCallDividendScreen(rows, { key: 'fixture', secret: 'fixture', requestGate: other, fetcher, metrics, clock: () => now });
  assert.equal(calls, 1); assert.equal(metrics.filter(row => row.requestAttempted === false).length, 2);
  assert.equal(news.incomplete.has('SPY'), true); assert.equal(second.diagnostics.status, 'provider_error');
});

test('shared discovery stops subsequent batches on a local budget rejection', async () => {
  let requests = 0;
  const result = await screenFullEquityMarket({ assets: [{ symbol: 'AAA' }, { symbol: 'BBB' }], batchSize: 1,
    now: NOW, openTime: OPEN, closeTime: NOW + 3600000,
    requestSnapshots: async () => { requests++; throw Object.assign(new Error('deferred'), { code: 'ALPACA_PACING_DEFERRED' }); } });
  assert.equal(requests, 1); assert.equal(result.diagnostics.unrequestedSymbols, 1);
  assert.equal(result.diagnostics.status, 'local_budget_deferred');
  assert.equal(result.rows.every(row => row.reasons.includes('local_budget_deferred')), true);
});

test('malformed news records one failed HTTP attempt instead of double-counting it', async () => {
  const metrics = [];
  const news = await fetchAlpacaCatalystNews(['SPY'], { key: 'fixture', secret: 'fixture', metrics,
    requestGate: async () => ({}), fetcher: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: [] }) }) });
  assert.equal(metrics.length, 1); assert.match(metrics[0].error, /missing article array/);
  assert.equal(news.incomplete.has('SPY'), true);
});

test('a current observation clock avoids stale scan anchors without accepting future or stale snapshots', async () => {
  const snapshot = { latestQuote: { bp: 102, ap: 102.02, t: new Date(NOW).toISOString() },
    dailyBar: { o: 100, c: 102, h: 103, l: 99, v: 100000, t: '2026-10-02T04:00:00Z' } };
  const options = { assets: [{ symbol: 'FRESH' }], now: NOW - 1000, clock: () => 500,
    openTime: OPEN, closeTime: NOW + 3600000, requestSnapshots: async () => ({ FRESH: snapshot }) };
  assert.equal((await screenFullEquityMarket(options)).rows[0].reasons[0], 'stale_or_future_quote');
  assert.deepEqual((await screenFullEquityMarket({ ...options, observationClock: () => NOW })).shortlist, ['FRESH']);
  for (const at of [NOW - 1, NOW + 15001]) assert.equal((await screenFullEquityMarket({ ...options,
    observationClock: () => at })).rows[0].reasons[0], 'stale_or_future_quote');
});

test('Options deep research uses the current observation clock after a paced request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'options-observation-clock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let elapsed = 0;
  const result = await analyzeOptionUnderlyings({ underlyingDiscovery: researchDiscovery(), now: NOW - 1000,
    clock: () => elapsed, observationClock: () => NOW + elapsed, sleep: async ms => { elapsed += ms; },
    requestGate: async () => ({}), env: { ALPACA_API_KEY_ID: 'fixture', ALPACA_API_SECRET_KEY: 'fixture',
      OPTIONS_INTRADAY_RESEARCH_HISTORY_PATH: directory },
    fetcher: async url => ({ ok: true, status: 200, headers: new Headers(), json: async () => new URL(url).pathname.endsWith('/bars')
      ? { bars: { FRESH: researchInput().bars } } : { quotes: { FRESH: { ...researchInput().quote, t: new Date(NOW + elapsed).toISOString() } } } }) });
  assert.equal(result.diagnostics.technicalWatches, 1, JSON.stringify(result.diagnostics));
  assert.equal(result.rows[0].eligibleForPaper, false);
});
