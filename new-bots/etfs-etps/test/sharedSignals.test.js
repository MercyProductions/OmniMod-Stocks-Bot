import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPrimarySignalContext } from '../src/sharedSignals.js';
import { resolveEtfExposureKey } from '../src/exposure.js';

test('attaches fresh journal rows only as non-executable context for matching canonical exposure', () => {
  const trades = [
    { symbol: 'TQQQ', exposureKey: 'TQQQ' },
    { symbol: 'IBIT', exposureKey: 'BTC' },
  ];
  const signals = [
    { id: 's1', owner: 'stocks', symbol: 'QQQ', direction: 'long', strategyId: 'momentum', status: 'active', observedAt: '2026-09-29T15:00:00Z', executable: false, paperOnly: true,
      catalystContextStatus: 'available', catalystContext: [{ publisher: 'Wire', headline: 'Earnings update', sourceUrl: 'https://news.example/a', activityAt: '2026-09-29T14:00:00Z' }] },
    { id: 'c1', owner: 'crypto', symbol: 'BTC', direction: 'short', strategyId: 'rapid', status: 'active', observedAt: '2026-09-29T15:01:00Z', executable: false, paperOnly: true },
    { id: 'f1', owner: 'futures', symbol: 'NQZ6', exposureKey: 'QQQ', direction: 'long', strategyFamily: 'intraday_day_trade', strategyId: 'futures-nq-v1', status: 'active', executable: false, paperOnly: true },
    { id: 'bad', owner: 'stocks', symbol: 'QQQ', direction: 'long', strategyId: 'momentum', status: 'active', executable: true, paperOnly: true },
    { id: 'closed', owner: 'stocks', symbol: 'QQQ', direction: 'short', strategyId: 'momentum', status: 'target_hit', executable: false, paperOnly: true },
    { id: 'long-hold', owner: 'stocks', symbol: 'QQQ', direction: 'long', strategyId: 'long-hold', status: 'active', executable: false, paperOnly: true },
  ];
  const rows = attachPrimarySignalContext(trades, signals, { resolveExposureKey: resolveEtfExposureKey });
  assert.deepEqual(rows[0].primaryResearch.map((row) => row.id), ['s1', 'f1']);
  assert.deepEqual(rows[1].primaryResearch.map((row) => row.id), ['c1']);
  assert.equal(rows[0].primaryResearch[0].executable, false);
  assert.equal(rows[0].primaryResearch[0].catalystContext[0].headline, 'Earnings update');
  assert.equal(rows[0].primaryResearch[0].catalystContextStatus, 'available');
  assert.equal(rows[0].exposureKey, 'QQQ');
  assert.equal(rows[1].exposureKey, 'BTC');
});

test('does not fabricate a match for unrelated or non-primary symbols', () => {
  const [row] = attachPrimarySignalContext([{ symbol: 'SPY' }], [
    { id: 'x', owner: 'stocks', symbol: 'AAPL', strategyId: 'scalp', status: 'active', executable: false, paperOnly: true },
  ], { resolveExposureKey: resolveEtfExposureKey });
  assert.deepEqual(row.primaryResearch, []);
});
